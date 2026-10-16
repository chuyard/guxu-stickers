// Local maintenance helper only. No HTTP or MCP write interface, no semantic auto-tagging.
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImage, MAX_IMAGE_BYTES, SEQUENTIAL_ID_PATTERN } from '../catalog.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), input = args.shift();
let requestedId, write = false;
while (args.length) {
  const arg = args.shift();
  if (arg === '--write') write = true;
  else if (arg === '--id' && args.length) requestedId = args.shift();
  else throw new Error('Usage: node scripts/prepare-asset.js <image-file> [--id stk-001] [--write]');
}
if (!input) throw new Error('Usage: node scripts/prepare-asset.js <image-file> [--id stk-001] [--write]');
const stat = await lstat(input);
if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Input must be an image file up to 10 MiB');
const bytes = await readFile(input), proof = inspectImage(bytes);
const stem = basename(input).replace(/\.[^.]+$/, '');
const id = requestedId ?? (SEQUENTIAL_ID_PATTERN.test(stem) ? stem : proof.id);
if (id !== proof.id && !SEQUENTIAL_ID_PATTERN.test(id)) throw new Error('Explicit asset ID must match stk-001 style');
const assets = await readdir(resolve(root, 'stickers'));
const existing = assets.find(file => file.startsWith(`${id}.`));
const duplicate = [];
for (const asset of assets.filter(file => /\.(?:jpe?g|png|webp)$/.test(file))) {
  const prior = inspectImage(await readFile(resolve(root, 'stickers', asset)));
  if (prior.sha256 === proof.sha256) duplicate.push(asset);
}
const file = `stickers/${id}.${proof.extension}`;
if (existing) {
  const prior = inspectImage(await readFile(resolve(root, 'stickers', existing)));
  if (prior.sha256 !== proof.sha256) throw new Error('Existing asset ID cannot be overwritten');
  console.log(JSON.stringify({ id, file: `stickers/${existing}`, sha256: proof.sha256, duplicate: true, written: false }));
} else {
  if (duplicate.length) throw new Error(`Duplicate image contents already exist: stickers/${duplicate[0]}`);
  if (write) await writeFile(resolve(root, file), bytes, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify({ id, file, sha256: proof.sha256, duplicate: false, written: write }));
}
// A sequential asset may be uploaded first. It becomes visible only after verified bytes and sha256 are added to catalog.json.
