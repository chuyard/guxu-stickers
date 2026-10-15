// Local maintenance helper only. No HTTP or MCP write interface, no semantic auto-tagging.
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImage, MAX_IMAGE_BYTES } from '../catalog.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [input, flag] = process.argv.slice(2);
if (!input || (flag && flag !== '--write')) throw new Error('Usage: node scripts/prepare-asset.js <image-file> [--write]');
const stat = await lstat(input);
if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Input must be an image file up to 10 MiB');
const bytes = await readFile(input), proof = inspectImage(bytes);
const existing = (await readdir(resolve(root, 'stickers'))).find(file => file.startsWith(`${proof.id}.`));
const file = `stickers/${proof.id}.${proof.extension}`;
if (existing) {
  const prior = inspectImage(await readFile(resolve(root, 'stickers', existing)));
  if (prior.sha256 !== proof.sha256) throw new Error('Hash prefix collision; existing asset will never be overwritten');
  console.log(JSON.stringify({ id: proof.id, file: `stickers/${existing}`, duplicate: true, written: false }));
} else {
  if (flag === '--write') await writeFile(resolve(root, file), bytes, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify({ id: proof.id, file, duplicate: false, written: flag === '--write' }));
}
// Caller supplies title/text/tags/aliases/contexts/tone/avoid/alt separately and publishes catalog+image in one commit.
