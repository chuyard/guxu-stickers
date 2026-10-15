import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectImage } from '../catalog.js';
export const catalog = JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url)));
export const first = catalog.items[0];
export const photo = readFileSync(new URL(`../${first.file}`, import.meta.url));
export const secondBytes = readFileSync(new URL('./fixtures/inventory-check.png', import.meta.url));
export const secondProof = inspectImage(secondBytes);
export const second = {
  id: secondProof.id, file: `stickers/${secondProof.id}.png`,
  title: '库存动态更新验收图', text: '', tags: ['技术验收', '动态更新'], aliases: ['库存验收'],
  contexts: ['验证库存无需重启即可更新'], tone: [], avoid: [], alt: '蓝黄色棋盘格技术验收图',
};
export const COMMIT_A = 'a'.repeat(40), COMMIT_B = 'b'.repeat(40), COMMIT_C = 'c'.repeat(40);
export const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export class FakeSource {
  constructor() { this.commit = COMMIT_A; this.catalog = structuredClone(catalog); this.images = new Map([[first.file, photo], [second.file, secondBytes]]); this.calls = { head: 0, tree: 0, file: 0 }; this.headEtags = []; }
  async head(etag) { this.calls.head++; this.headEtags.push(etag); if (this.fail) throw new Error('Simulated network outage'); return { commit: this.commit, etag: `"${this.commit}"` }; }
  async tree() {
    this.calls.tree++;
    return [['catalog.json', Buffer.from(JSON.stringify(this.catalog))], ...this.images].map(([path, bytes]) => ({ path, sha: blobSha(bytes), size: bytes.length, type: 'blob', mode: '100644' }));
  }
  async file(commit, file) { this.calls.file++; if (this.fileFail) throw new Error('Simulated file outage'); return file === 'catalog.json' ? Buffer.from(JSON.stringify(this.catalog)) : this.images.get(file); }
}
