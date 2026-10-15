import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, verifyImage, MAX_IMAGE_BYTES } from '../catalog.js';

export async function validateLocalCatalog(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const catalog = validateCatalog(JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8')));
  const seen = new Set();
  const actualRoot = await realpath(root);
  for (const item of catalog.items) {
    const path = resolve(root, item.file), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES || await realpath(path) !== resolve(actualRoot, item.file)) throw new Error(`Invalid regular asset: ${item.file}`);
    const proof = verifyImage(item, await readFile(path));
    if (seen.has(proof.sha256)) throw new Error(`Duplicate image: ${item.file}`);
    seen.add(proof.sha256);
  }
  return catalog;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = await validateLocalCatalog(process.argv[2]);
  console.log(`PASS catalog: ${catalog.items.length} image(s), default ${catalog.defaultId}, all fields, paths and image hashes valid`);
}
