import { createHash } from 'node:crypto';
import { z } from 'zod';

export const REPOSITORY = 'chuyard/guxu-stickers';
export const BRANCH = 'main';
export const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
export const ID_PATTERN = /^stk-[a-f0-9]{12}$/;
export const FILE_PATTERN = /^stickers\/(stk-[a-f0-9]{12})\.(jpeg|jpg|png|webp)$/;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const nonempty = z.string().trim().min(1).max(500);
const phrases = z.array(nonempty).max(80);
export const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  defaultId: z.string().regex(ID_PATTERN),
  items: z.array(z.object({
    id: z.string().regex(ID_PATTERN), file: z.string().regex(FILE_PATTERN),
    title: nonempty, text: z.string().max(2000), tags: phrases, aliases: phrases,
    contexts: phrases, tone: phrases, avoid: phrases, alt: nonempty,
  }).strict()).min(1).max(2000),
}).strict();

export function validateCatalog(value) {
  const catalog = catalogSchema.parse(value);
  const ids = new Set(), files = new Set();
  for (const item of catalog.items) {
    if (ids.has(item.id)) throw new Error(`Duplicate ID: ${item.id}`);
    if (files.has(item.file)) throw new Error(`Duplicate file: ${item.file}`);
    if (FILE_PATTERN.exec(item.file)[1] !== item.id) throw new Error(`ID/file mismatch: ${item.id}`);
    ids.add(item.id); files.add(item.file);
  }
  if (!ids.has(catalog.defaultId)) throw new Error('defaultId is not in items');
  return catalog;
}

export function imageUrl(commit, file) {
  if (!COMMIT_PATTERN.test(commit) || !FILE_PATTERN.test(file)) throw new Error('Invalid pinned image path');
  return `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${commit}/${file}`;
}

export function inspectImage(bytes) {
  if (bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid image size');
  let extension;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = 'jpeg';
  else if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = 'png';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  else throw new Error('Only JPEG, PNG and WebP image bytes are supported');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { id: `stk-${sha256.slice(0, 12)}`, extension, sha256, blobSha, size: bytes.length };
}

export function verifyImage(item, bytes, expectedBlobSha) {
  const proof = inspectImage(bytes);
  const ext = item.file.split('.').at(-1);
  if (proof.id !== item.id || !(proof.extension === ext || (proof.extension === 'jpeg' && ext === 'jpg'))) {
    throw new Error(`Image content/ID/extension mismatch: ${item.file}`);
  }
  if (expectedBlobSha && proof.blobSha !== expectedBlobSha) throw new Error(`Git blob mismatch: ${item.file}`);
  return { file: item.file, ...proof };
}

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const STOP = new Set(['夏初','顾叙','现在','今天','一个','这个','那个','我们','你们','他们','自己','图片','表情包','想要','显示','看看','一下','正在','真的','不是','没有','可以','还是','就是','因为','所以','但是']);
export const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function terms(text) {
  const parts = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(parts.flatMap(part => {
    const words = [...segmenter.segment(part)].filter(x => x.isWordLike).map(x => normalize(x.segment))
      .filter(x => x.length >= 2 && !STOP.has(x));
    // ICU can split expressive Chinese words such as 猫猫/装凶/调侃 into single characters.
    return words.length ? words : part.length >= 2 && !STOP.has(part) ? [part] : [];
  }))];
}
function negatedAt(query, offset) {
  return /(?:不是|并非|没有|避免|不处于|不适合|非)(?:在|发生|出现)?$/.test(query.slice(Math.max(0, offset - 8), offset));
}
function explicitlyAvoided(item, query) {
  const normalized = normalize(query);
  for (const phrase of item.avoid) {
    const exact = normalized.indexOf(normalize(phrase));
    if (exact >= 0 && !negatedAt(normalized, exact)) return true;
    const keys = terms(phrase);
    // Names and filler words cannot alone exclude an image. Distinctive words must all be present.
    if (keys.length && keys.every(key => {
      const at = normalized.indexOf(key);
      return at >= 0 && !negatedAt(normalized, at);
    })) return true;
  }
  return false;
}
const WEIGHTS = { title: 8, text: 7, tags: 7, aliases: 7, contexts: 6, tone: 5 };
export function selectSticker(catalog, { id, query } = {}) {
  if (id !== undefined) {
    const item = catalog.items.find(item => item.id === id);
    return item ? { status: 'ok', item, selection: { mode: 'id' } }
      : { status: 'error', code: 'ID_NOT_FOUND', message: `未找到指定表情包：${id}` };
  }
  if (query === undefined) return { status: 'ok', item: catalog.items.find(item => item.id === catalog.defaultId), selection: { mode: 'default' } };
  const normalized = normalize(query), queryTerms = terms(query);
  if (!normalized) return { status: 'no_match' };
  const ranked = [];
  for (const item of catalog.items) {
    if (explicitlyAvoided(item, query)) continue;
    let score = 0;
    const matchedFields = [], covered = new Set(), coveredCharacters = new Set();
    for (const [field, weight] of Object.entries(WEIGHTS)) {
      const values = Array.isArray(item[field]) ? item[field] : [item[field]];
      let fieldScore = 0;
      for (const value of values) {
        const phrase = normalize(value);
        if (!phrase) continue;
        const exact = phrase.length >= 2 && (normalized.includes(phrase) || phrase === normalized);
        const overlap = queryTerms.filter(term => phrase.includes(term));
        overlap.forEach(term => covered.add(term));
        if (exact) {
          const start = normalized.indexOf(phrase);
          for (let i = start; i >= 0 && i < start + phrase.length; i++) coveredCharacters.add(i);
          fieldScore = Math.max(fieldScore, weight * 2);
        }
        else if (overlap.length) fieldScore = Math.max(fieldScore, weight * Math.min(overlap.length, 3));
      }
      if (fieldScore) { score += fieldScore; matchedFields.push(field); }
    }
    const coverage = queryTerms.length ? covered.size / queryTerms.length : 0;
    const fullPhrase = Object.keys(WEIGHTS).some(field => [item[field]].flat().some(value => normalize(value) === normalized));
    if (score >= 5 && (coverage >= 0.35 || coveredCharacters.size / normalized.length >= 0.35 || fullPhrase)) ranked.push({ item, score, matchedFields });
  }
  ranked.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  const best = ranked[0];
  return best ? { status: 'ok', item: best.item, selection: { mode: 'query', score: best.score, matchedFields: best.matchedFields } }
    : { status: 'no_match' };
}
