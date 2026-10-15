import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateCatalog, selectSticker, verifyImage, imageUrl } from '../catalog.js';
import { CatalogStore, GitHubSource } from '../catalog-store.js';
import { validateLocalCatalog } from '../scripts/validate-catalog.js';
import { catalog, first, photo, second, secondBytes, FakeSource, COMMIT_A, COMMIT_B, COMMIT_C, blobSha } from './helpers.js';

test('supplied default metadata, stable content hash, valid local image and deduplication helper', async () => {
  assert.equal((await validateLocalCatalog()).defaultId, 'stk-c043f61536d6');
  assert.equal(verifyImage(first, photo).id, first.id);
  assert.throws(() => verifyImage(first, secondBytes), /mismatch/);
  assert.match(imageUrl(COMMIT_A, first.file), new RegExp(`@${COMMIT_A}/stickers/`));
  assert.throws(() => imageUrl('main', first.file));
  assert.throws(() => imageUrl(COMMIT_A, 'incoming/x.png'));
  const run = await promisify(execFile)(process.execPath, ['scripts/prepare-asset.js', first.file, '--write'], { cwd: new URL('..', import.meta.url) });
  assert.equal(JSON.parse(run.stdout).duplicate, true);
  assert.equal(JSON.parse(run.stdout).written, false);
});

test('all fields are validated; duplicate ID/path, unsafe paths, bad default and missing fields rejected', () => {
  const invalid = [];
  let c = structuredClone(catalog); c.items.push(c.items[0]); invalid.push(c);
  c = structuredClone(catalog); c.items[0].file = '../private.jpeg'; invalid.push(c);
  c = structuredClone(catalog); c.items[0].file = 'incoming/one.jpeg'; invalid.push(c);
  c = structuredClone(catalog); c.items[0].file = `stickers/${first.id}.svg`; invalid.push(c);
  c = structuredClone(catalog); c.items[0].file = `stickers/${second.id}.jpeg`; invalid.push(c);
  c = structuredClone(catalog); c.defaultId = second.id; invalid.push(c);
  c = structuredClone(catalog); c.schemaVersion = 2; invalid.push(c);
  for (const field of Object.keys(first)) { c = structuredClone(catalog); delete c.items[0][field]; invalid.push(c); }
  for (const field of ['tags','aliases','contexts','tone','avoid']) { c = structuredClone(catalog); c.items[0][field] = 'invalid'; invalid.push(c); }
  for (const value of invalid) assert.throws(() => validateCatalog(value));
});

test('exact/default/query/no match/avoid/id priority and reproducible tie ordering', () => {
  assert.equal(selectSticker(catalog, {}).item.id, first.id);
  assert.equal(selectSticker(catalog, { id: first.id, query: '严肃冲突' }).item.id, first.id);
  assert.equal(selectSticker(catalog, { id: second.id }).code, 'ID_NOT_FOUND');
  for (const query of ['猫猫 装凶 调侃','坏东西猫猫','坏东西！你是个坏东西！','坏蛋','轻微斗嘴','亲近','嘴硬地表达不满']) assert.equal(selectSticker(catalog, { query }).item?.id, first.id, query);
  for (const query of ['','abcdef91642','严肃冲突 猫猫','夏初真的难过 装凶','夏初正在认真表达不满 猫猫','夏初现在真的很难过 猫猫']) assert.equal(selectSticker(catalog, { query }).status, 'no_match', query);
  const tie = { ...catalog, items: [first, { ...first, id: second.id, file: second.file }] };
  const a = selectSticker(tie, { query: '猫猫' }); tie.items.reverse();
  assert.equal(selectSticker(tie, { query: '猫猫' }).item.id, a.item.id);
  // Isolate each semantic field so a title/tag match cannot conceal a broken contexts or tone implementation.
  for (const field of ['title','text','tags','aliases','contexts','tone']) {
    const item = { ...first, title: '基础名称', text: '', tags: [], aliases: [], contexts: [], tone: [], avoid: [] };
    item[field] = ['title','text'].includes(field) ? '专属语境' : ['专属语境'];
    const match = selectSticker({ ...catalog, items: [item] }, { query: '专属语境' });
    assert.equal(match.status, 'ok', field); assert.ok(match.selection.matchedFields.includes(field));
  }
});

test('atomic snapshots, two-minute cache, shared refresh, add/update/remove and same-commit image URLs', async () => {
  const source = new FakeSource(); let clock = Date.parse('2026-10-15T08:00:00Z');
  const store = new CatalogStore({ source, cacheFile: null, now: () => clock });
  const initial = await store.initialize(); assert.equal(initial.commit, COMMIT_A);
  await Promise.all([store.getSnapshot(), store.getSnapshot()]); assert.equal(source.calls.head, 1);
  source.commit = COMMIT_B; source.catalog.items.push(structuredClone(second));
  assert.equal((await store.getSnapshot()).catalog.items.length, 1);
  clock += 120001;
  const results = await Promise.all(Array.from({ length: 5 }, () => store.getSnapshot()));
  assert.ok(results.every(x => x.commit === COMMIT_B && x.catalog.items.length === 2));
  assert.equal(source.calls.head, 2);
  assert.throws(()=>results[0].catalog.items.push(second), /not extensible/);
  assert.equal(source.calls.file, 4, 'Initial catalog+image, changed catalog+new image; old image proof reused');
  assert.ok(imageUrl(COMMIT_B, second.file).includes(`@${COMMIT_B}/`));
  source.commit = COMMIT_C; source.catalog.items[0].tags.push('元数据更新'); source.catalog.items.pop();
  clock += 120001; const removed = await store.getSnapshot();
  assert.equal(removed.catalog.items.length, 1); assert.ok(removed.catalog.items[0].tags.includes('元数据更新'));
  assert.equal(selectSticker(removed.catalog, { id: second.id }).code, 'ID_NOT_FOUND');
  assert.equal(source.images.size, 2, 'Delisting does not delete historical image bytes');
});

test('every invalid refresh leaves the last valid snapshot and ETag untouched; network failure recovers', async () => {
  const source = new FakeSource(); let clock = Date.now();
  const store = new CatalogStore({ source, cacheFile: null, now: () => clock });
  const initial = await store.initialize();
  const invalid = [];
  let c = structuredClone(catalog); c.items.push(c.items[0]); invalid.push(c);
  c = structuredClone(catalog); delete c.items[0].contexts; invalid.push(c);
  c = structuredClone(catalog); c.defaultId = second.id; invalid.push(c);
  c = structuredClone(catalog); c.items[0].file = '../x.png'; invalid.push(c);
  source.commit = COMMIT_B;
  for (const value of invalid) {
    source.catalog = value; clock += 120001;
    assert.equal(await store.getSnapshot(), initial);
    assert.equal(store.health().status, 'degraded'); assert.equal(store.etag, `"${COMMIT_A}"`);
  }
  source.catalog = structuredClone(catalog);
  source.images.set(first.file, secondBytes); clock += 120001;
  assert.equal(await store.getSnapshot(), initial); assert.match(store.health().lastError, /mismatch/);
  source.images.set(first.file, photo); source.fail = true; clock += 120001;
  assert.equal(await store.getSnapshot(), initial); assert.equal(store.health().stale, true);
  source.fail = false; clock += 120001;
  assert.equal((await store.getSnapshot()).commit, COMMIT_B); assert.equal(store.health().status, 'ok');
});

test('disk cache survives process replacement while offline; corrupt cache without repository fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guxu-catalog-')), cacheFile = join(dir, 'cache.json');
  const source = new FakeSource(), store = new CatalogStore({ source, cacheFile });
  await store.initialize(); assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).commit, COMMIT_A);
  source.fail = true;
  const restored = new CatalogStore({ source, cacheFile });
  assert.equal((await restored.initialize()).commit, COMMIT_A); assert.equal(restored.health().status, 'degraded');
  await writeFile(cacheFile, '{"bad":true}');
  await assert.rejects(new CatalogStore({ source, cacheFile }).initialize(), /No valid catalog/);
  await assert.rejects(new CatalogStore({ source, cacheFile: null }).initialize(), /No valid catalog/);
});

test('GitHub source uses conditional HEAD and commit-pinned catalog/assets, rejecting oversized and truncated responses', async () => {
  const urls = [], headers = [];
  const source = new GitHubSource({ fetchImpl: async (url, options) => {
    urls.push(url); headers.push(options.headers);
    if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: COMMIT_A }), { headers: { etag: 'test-etag' } });
    if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [], truncated: false }));
    return new Response(photo);
  } });
  assert.equal((await source.head('old-etag')).etag, 'test-etag');
  assert.equal(headers[0]['If-None-Match'], 'old-etag');
  await source.tree(COMMIT_A); await source.file(COMMIT_A, first.file);
  assert.ok(urls[2].includes(`/${COMMIT_A}/${first.file}`)); assert.ok(!urls[2].includes('/main/'));
  await assert.rejects(source.file(COMMIT_A, '../secret'));
  const truncated = new GitHubSource({ fetchImpl: async () => new Response(JSON.stringify({ tree: [], truncated: true })) });
  await assert.rejects(truncated.tree(COMMIT_A), /Incomplete/);
  const huge = new GitHubSource({ fetchImpl: async () => new Response(photo, { headers: { 'content-length': '99999999' } }) });
  await assert.rejects(huge.file(COMMIT_A, first.file), /large/);
  const conditional = new GitHubSource({ fetchImpl: async () => new Response(null, { status: 304 }) });
  assert.equal((await conditional.head('x')).notModified, true);
});


test('304 reuses cache without tree/files, missing file and symlink fail closed, no write endpoint is added', async () => {
  const source = new FakeSource(); let clock=0;
  const store = new CatalogStore({source,cacheFile:null,now:()=>clock});
  const initial=await store.initialize();
  source.head=async()=>({notModified:true});clock+=120001;
  assert.equal(await store.getSnapshot(),initial);assert.equal(source.calls.tree,1);
  assert.equal(store.health().status,'ok');
  source.head=async()=>({commit:COMMIT_B});
  const originalTree=source.tree.bind(source);
  source.tree=async()=> (await originalTree()).filter(entry=>entry.path!==first.file);
  clock+=120001;assert.equal(await store.getSnapshot(),initial);assert.match(store.health().lastError,/Missing regular/);
  source.tree=async()=> (await originalTree()).map(entry=>entry.path===first.file?{...entry,mode:'120000'}:entry);
  clock+=120001;assert.equal(await store.getSnapshot(),initial);assert.match(store.health().lastError,/Missing regular/);
});
