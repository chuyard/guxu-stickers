import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { REPOSITORY, BRANCH, COMMIT_PATTERN, MAX_IMAGE_BYTES, HASH_ID_PATTERN, SEQUENTIAL_ID_PATTERN, validateCatalog, imageUrl, verifyImage } from './catalog.js';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
async function readLimited(response, limit) {
  if (!response.ok) throw new Error(`Repository request failed: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Repository response too large');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error('Repository response too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

// Only fixed, public, read-only repository URLs are requested. No tokens or repository-write endpoint.
export class GitHubSource {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(url, { etag, limit = MAX_JSON_BYTES, api = false } = {}) {
    const headers = { 'User-Agent': 'guxu-stickers/0.4.0' };
    if (api) { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2022-11-28'; }
    if (etag) headers['If-None-Match'] = etag;
    const response = await this.fetch(url, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (response.status === 304) return { notModified: true };
    const bytes = await readLimited(response, limit);
    return { bytes, etag: response.headers.get('etag') ?? undefined };
  }
  async head(etag) {
    const response = await this.request(`https://api.github.com/repos/${REPOSITORY}/commits/${BRANCH}`, { etag, api: true });
    if (response.notModified) return response;
    const data = JSON.parse(response.bytes.toString('utf8'));
    if (!COMMIT_PATTERN.test(data.sha)) throw new Error('Invalid repository commit');
    return { commit: data.sha, etag: response.etag };
  }
  async tree(commit) {
    if (!COMMIT_PATTERN.test(commit)) throw new Error('Invalid commit');
    const response = await this.request(`https://api.github.com/repos/${REPOSITORY}/git/trees/${commit}?recursive=1`, { api: true });
    const data = JSON.parse(response.bytes.toString('utf8'));
    if (data.truncated || !Array.isArray(data.tree)) throw new Error('Incomplete repository tree');
    return data.tree;
  }
  async file(commit, file, limit = MAX_JSON_BYTES) {
    if (!COMMIT_PATTERN.test(commit) || !(file === 'catalog.json' || /^stickers\/stk-(?:[a-f0-9]{12}|\d{3,9})\.(jpeg|jpg|png|webp)$/.test(file))) throw new Error('Invalid repository file path');
    const response = await this.request(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file}`, { limit });
    return response.bytes;
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep); Object.freeze(value);
  }
  return value;
}
function validateSaved(value) {
  if (value?.formatVersion !== 1 || !COMMIT_PATTERN.test(value.commit) || !Array.isArray(value.proofs)
      || !Number.isFinite(Date.parse(value.lastSuccessfulSyncAt))) throw new Error('Invalid saved catalog snapshot');
  const catalog = validateCatalog(value.catalog);
  const proofByFile = new Map(value.proofs.map(proof => [proof.file, proof]));
  if (proofByFile.size !== catalog.items.length || value.proofs.length !== catalog.items.length) throw new Error('Invalid saved proof count');
  for (const item of catalog.items) {
    const proof = proofByFile.get(item.file);
    const identityMatches = SEQUENTIAL_ID_PATTERN.test(item.id)
      ? item.sha256 === proof?.sha256
      : HASH_ID_PATTERN.test(item.id) && item.id === `stk-${proof?.sha256?.slice(0, 12)}` && (!item.sha256 || item.sha256 === proof.sha256);
    if (!proof || proof.id !== item.id || !identityMatches || !['jpeg','png','webp'].includes(proof.extension) || !/^[a-f0-9]{64}$/.test(proof.sha256) || !COMMIT_PATTERN.test(proof.blobSha)
        || !Number.isInteger(proof.size)
        || proof.size < 12 || proof.size > MAX_IMAGE_BYTES) throw new Error(`Invalid saved proof: ${item.file}`);
    imageUrl(value.commit, item.file);
  }
  return { formatVersion: 1, commit: value.commit, catalog, proofs: value.proofs, lastSuccessfulSyncAt: value.lastSuccessfulSyncAt };
}

export class CatalogStore {
  constructor({ source = new GitHubSource(), cacheFile = process.env.CATALOG_CACHE_FILE ?? '.cache/catalog-cache.json', now = Date.now, ttlMs = 120000 } = {}) {
    this.source = source; this.cacheFile = cacheFile; this.now = now; this.ttlMs = ttlMs;
    this.snapshot = null; this.lastAttemptMs = null; this.lastAttemptAt = null;
    this.lastSuccessfulSyncAt = null; this.lastChangedAt = null; this.lastError = null;
    this.syncStatus = 'starting'; this.etag = undefined; this.inFlight = null; this.initializing = null;
  }
  initialize() {
    if (!this.initializing) this.initializing = (async () => {
      if (this.cacheFile) {
        try {
          const bytes = await readFile(this.cacheFile);
          if (bytes.length > MAX_CACHE_BYTES) throw new Error('Saved catalog too large');
          const saved = validateSaved(JSON.parse(bytes));
          this.snapshot = freezeDeep(saved); this.lastSuccessfulSyncAt = saved.lastSuccessfulSyncAt;
          this.syncStatus = 'cached';
        } catch (error) {
          if (error.code !== 'ENOENT') this.lastError = `Saved cache rejected: ${error.message}`;
        }
      }
      await this.refresh();
      if (!this.snapshot) throw new Error(`No valid catalog available: ${this.lastError ?? 'unknown error'}`);
      return this.snapshot;
    })();
    return this.initializing;
  }
  health() {
    return {
      available: Boolean(this.snapshot), repository: REPOSITORY, branch: BRANCH,
      commit: this.snapshot?.commit ?? null, itemCount: this.snapshot?.catalog.items.length ?? 0,
      lastAttemptAt: this.lastAttemptAt, lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      lastChangedAt: this.lastChangedAt, status: this.syncStatus,
      stale: this.syncStatus === 'degraded' || this.syncStatus === 'cached',
      lastError: this.lastError, cachePersistenceError: this.cachePersistenceError ?? null,
      refreshIntervalSeconds: this.ttlMs / 1000,
    };
  }
  async getSnapshot() {
    await this.initialize();
    if (this.inFlight) await this.inFlight;
    if (this.lastAttemptMs === null || this.now() - this.lastAttemptMs >= this.ttlMs) await this.refresh();
    if (!this.snapshot) throw new Error('No valid catalog available');
    return this.snapshot;
  }
  refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sync().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async persist() {
    if (!this.cacheFile || !this.snapshot) return;
    const temp = `${this.cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(temp, JSON.stringify({ ...this.snapshot, lastSuccessfulSyncAt: this.lastSuccessfulSyncAt }), { mode: 0o600 });
      await rename(temp, this.cacheFile);
      this.cachePersistenceError = null;
    } catch (error) {
      this.cachePersistenceError = error.message;
      await unlink(temp).catch(() => {});
    }
  }
  async sync() {
    this.lastAttemptMs = this.now(); this.lastAttemptAt = new Date(this.lastAttemptMs).toISOString();
    this.syncStatus = 'syncing';
    try {
      const head = await this.source.head(this.etag);
      if (head.notModified && !this.snapshot) throw new Error('304 without valid snapshot');
      if (!head.notModified && head.commit !== this.snapshot?.commit) {
        if (!COMMIT_PATTERN.test(head.commit)) throw new Error('Invalid commit');
        const tree = await this.source.tree(head.commit);
        const byFile = new Map(tree.map(entry => [entry.path, entry]));
        const requireBlob = file => {
          const entry = byFile.get(file);
          if (!entry || entry.type !== 'blob' || !['100644','100755'].includes(entry.mode) || !COMMIT_PATTERN.test(entry.sha)) throw new Error(`Missing regular repository file: ${file}`);
          return entry;
        };
        const catalogBlob = requireBlob('catalog.json');
        const catalogBytes = await this.source.file(head.commit, 'catalog.json');
        const catalogHash = createHash('sha1').update(`blob ${catalogBytes.length}\0`).update(catalogBytes).digest('hex');
        if (catalogHash !== catalogBlob.sha) throw new Error('Catalog Git blob mismatch');
        const catalog = validateCatalog(JSON.parse(catalogBytes.toString('utf8')));
        const oldProofs = new Map((this.snapshot?.proofs ?? []).map(proof => [`${proof.file}:${proof.blobSha}`, proof]));
        const proofs = [];
        const existingDigests = new Set();
        // Sequential reads bound network/memory and API usage; unchanged image blobs reuse verified proofs.
        for (const item of catalog.items) {
          const blob = requireBlob(item.file);
          if (!Number.isInteger(blob.size) || blob.size < 12 || blob.size > MAX_IMAGE_BYTES) throw new Error(`Invalid image size: ${item.file}`);
          const proof = oldProofs.get(`${item.file}:${blob.sha}`)
            ?? verifyImage(item, await this.source.file(head.commit, item.file, MAX_IMAGE_BYTES), blob.sha);
          if (proof.id !== item.id || (item.sha256 && item.sha256 !== proof.sha256)) throw new Error(`Image digest mismatch: ${item.file}`);
          const previousProof = this.snapshot?.proofs.find(previous => previous.id === item.id);
          if (previousProof && previousProof.sha256 !== proof.sha256) throw new Error(`Existing image ID cannot be overwritten: ${item.id}`);
          if (proof.size !== blob.size) throw new Error(`Image size mismatch: ${item.file}`);
          if (existingDigests.has(proof.sha256)) throw new Error(`Duplicate image contents: ${item.file}`);
          existingDigests.add(proof.sha256); imageUrl(head.commit, item.file); proofs.push(proof);
        }
        const changedAt = new Date(this.now()).toISOString();
        const next = freezeDeep({ formatVersion: 1, commit: head.commit, catalog, proofs, lastSuccessfulSyncAt: changedAt });
        // No mutation of the active catalog before every entry and image has passed validation.
        this.snapshot = next; this.lastChangedAt = changedAt;
      }
      if (head.etag) this.etag = head.etag;
      this.lastSuccessfulSyncAt = new Date(this.now()).toISOString();
      this.lastError = null; this.syncStatus = 'ok';
      await this.persist();
    } catch (error) {
      this.lastError = String(error.message).slice(0, 1000);
      this.syncStatus = this.snapshot ? 'degraded' : 'unavailable';
    }
    return this.snapshot;
  }
}
