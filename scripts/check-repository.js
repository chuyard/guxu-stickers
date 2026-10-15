import { CatalogStore } from '../catalog-store.js';
const store = new CatalogStore({ cacheFile: null });
await store.initialize();
const status = store.health();
if (status.status !== 'ok') throw new Error(status.lastError);
console.log(`PASS live GitHub catalog and image hashes: ${status.commit}, ${status.itemCount} image(s)`);
