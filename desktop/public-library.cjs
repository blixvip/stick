'use strict';
const { messageError } = require('./localization.cjs');


const {createHash} = require('node:crypto');

// The community library is a service of the website (worker/library.js in the
// site's repository). /api/v1/content says which index is current and where the
// public files live, the index lists every approved item, and the index, the
// posters and the files are immutable objects. Only stykanimate.com (and the
// file host the site names, when that is a subdomain of it) is contacted,
// every response is size-bounded, and a file reaches the app only after its
// size and SHA-256 match the index. Nothing about the user or their projects
// is sent.
const SITE = 'https://stykanimate.com';
const MB = 1024 * 1024;
const LIMITS = Object.freeze({content: 256 * 1024, index: 4 * MB, poster: 512 * 1024});
// Figures and movieclips are what the app can insert. Full projects stay on the website.
const KINDS = Object.freeze({figure: {extension: 'stkz', maxBytes: 8 * MB}, movieclip: {extension: 'stykmov', maxBytes: 12 * MB}});
// The order the website lists its categories in; a category it adds later follows these.
const CATEGORY_ORDER = ['characters', 'effects', 'moves', 'props', 'backgrounds', 'animations', 'other'];
const MAX_ITEMS = 5000;
const MAX_COUNTED = 5000;
const REFRESH_AFTER = 10 * 60 * 1000;
const MAX_FILE_CACHE_BYTES = 32 * MB;
const MAX_POSTER_CACHE_BYTES = 16 * MB;
const ID = /^[a-z0-9]{10}$/;
const OBJECT_KEY = /^i\/[a-z0-9]{10}\/[\w.-]{1,120}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORY = /^[a-z]{2,24}$/;

/** A failure with a message the Library panel can show as it is. */
class LibraryError extends Error {}

const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isPublicId = value => typeof value === 'string' && ID.test(value);
const categoryName = id => id.charAt(0).toUpperCase() + id.slice(1);
const objectKey = (id, value) => typeof value === 'string' && OBJECT_KEY.test(value) && value.startsWith(`i/${id}/`) ? value : null;

/** Tests and local previews may point at a loopback server; the product only talks to the website. */
function siteFrom(value) {
  if (!value) return SITE;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw messageError(new Error(''), 'desktop.publicLibrary.errors.theCommunityLibraryAddressCanOnlyBeOverriddenWithALoopbackServer', {});
  return url.origin;
}

/** Whether a URL belongs to the site: its own host or a subdomain of it, over the same protocol. */
function belongsToSite(site, target) {
  const home = new URL(site);
  return target.protocol === home.protocol && !target.username && !target.password
    && (target.hostname === home.hostname || target.hostname.endsWith(`.${home.hostname}`));
}

/** The public file host the site announces, or null when it serves files itself. */
function fileHost(site, value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return belongsToSite(site, url) && !url.search && !url.hash ? `${url.origin}${url.pathname.replace(/\/+$/, '')}` : null;
  } catch { return null; }
}

/** Validates the index strictly and keeps only what the app can insert. */
function parseIndex(source) {
  let value;
  try { value = JSON.parse(source); } catch { throw new LibraryError('The community library could not be read.'); }
  if (!Array.isArray(value?.items)) throw new LibraryError('The community library could not be read.');
  const items = [], objects = new Map();
  for (const entry of value.items.slice(0, MAX_ITEMS)) {
    const id = entry?.id, name = text(entry?.t, 120);
    if (!isPublicId(id) || objects.has(id) || !name || typeof entry.k !== 'string' || !Object.hasOwn(KINDS, entry.k)) continue;
    const kind = KINDS[entry.k];
    if (!Number.isSafeInteger(entry.s) || entry.s <= 0 || entry.s > kind.maxBytes || !SHA256.test(entry.sha256 ?? '')) continue;
    const file = objectKey(id, entry.f), poster = objectKey(id, entry.i);
    if (!file?.endsWith(`.${kind.extension}`) || !poster) continue;
    objects.set(id, {file, poster});
    items.push({
      id, name, kind: entry.k, category: typeof entry.c === 'string' && CATEGORY.test(entry.c) ? entry.c : 'other', description: text(entry.d, 600) ?? '',
      author: text(entry.a, 64) ?? '', tags: Array.isArray(entry.g) ? entry.g.filter(tag => typeof tag === 'string' && tag.length <= 32).slice(0, 12) : [],
      size: entry.s, sha256: entry.sha256,
    });
  }
  const present = [...new Set(items.map(item => item.category))];
  const rank = id => CATEGORY_ORDER.indexOf(id) < 0 ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(id);
  present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return {categories: present.map(id => ({id, name: categoryName(id)})), items, objects};
}

/** The image type a poster really is, from its first bytes. */
function imageType(bytes) {
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

const UNAVAILABLE = 'The community library is unavailable right now.';
const GONE = 'This asset is no longer in the community library.';

async function readBounded(response, limit, missing) {
  if (!response.ok || !response.body) throw new LibraryError(response.status === 404 ? missing : UNAVAILABLE);
  if (Number(response.headers.get('content-length')) > limit) throw new LibraryError('The community library sent an unexpectedly large file.');
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new LibraryError('The community library sent an unexpectedly large file.');
      parts.push(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts, size);
}

/**
 * The items this person has already downloaded once. The site counts a download when a
 * file is requested through its counting route, so the app asks that route only the first
 * time; every later download of the same item reads the public file directly. Only public
 * ids are kept, on this device (`preferences` is a WorkspacePreferences, or nothing to keep
 * them for the session only). The oldest ids go first past MAX_COUNTED.
 */
class DownloadLedger {
  constructor(preferences = null) { this.preferences = preferences; this.loading = null; }
  load() {
    this.loading ??= (async () => {
      const stored = await this.preferences?.get().catch(() => null);
      return new Set(Array.isArray(stored?.ids) ? stored.ids.filter(isPublicId).slice(-MAX_COUNTED) : []);
    })();
    return this.loading;
  }
  async has(id) { return (await this.load()).has(id); }
  async add(id) {
    const ids = await this.load();
    if (ids.has(id)) return;
    ids.add(id);
    while (ids.size > MAX_COUNTED) ids.delete(ids.values().next().value);
    // Best effort: if this cannot be written the next session counts the item once more, and nothing else is lost.
    await this.preferences?.set({version: 1, ids: [...ids]}).catch(() => {});
  }
}

/** Least recently used values under a byte budget; one oversized value is still kept alone. */
class ByteCache {
  constructor(limit) { this.limit = limit; this.bytes = 0; this.entries = new Map(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, size) {
    this.delete(key);
    this.entries.set(key, {value, size}); this.bytes += size;
    while (this.bytes > this.limit && this.entries.size > 1) this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.bytes -= entry.size; }
  }
  retain(keep) { for (const key of [...this.entries.keys()]) if (!keep(key)) this.delete(key); }
}

class PublicLibrary {
  constructor({site, fetcher = globalThis.fetch, now = Date.now, downloads = new DownloadLedger()} = {}) {
    this.site = siteFrom(site);
    this.fetcher = fetcher; this.now = now; this.downloads = downloads;
    this.snapshot = null; this.checkedAt = 0; this.pending = null; this.inflight = new Map();
    this.posters = new ByteCache(MAX_POSTER_CACHE_BYTES); this.files = new ByteCache(MAX_FILE_CACHE_BYTES);
  }
  /** One bounded GET of a URL on the site, redirects refused. `missing` is what a 404 means to the person. */
  async request(url, limit, {timeout = 15000, missing = UNAVAILABLE} = {}) {
    try { return await readBounded(await this.fetcher(url, {signal: AbortSignal.timeout(timeout), redirect: 'error'}), limit, missing); }
    catch (error) {
      if (error instanceof LibraryError) throw error;
      throw new LibraryError('Could not reach the community library. Check your connection and try again.');
    }
  }
  /** The catalogue is checked against the website at most every ten minutes unless refreshed. */
  async catalog({refresh = false} = {}) {
    if (!refresh && this.snapshot && this.now() < this.checkedAt + REFRESH_AFTER) return this.snapshot.catalog;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async load() {
    let content;
    try { content = JSON.parse((await this.request(`${this.site}/api/v1/content`, LIMITS.content)).toString('utf8')); }
    catch (error) { throw error instanceof SyntaxError ? new LibraryError('The community library could not be read.') : error; }
    const library = content?.library, version = library?.v;
    if (!library) throw new LibraryError('The community library is not available right now.');
    if (!Number.isSafeInteger(version) || version < 0) throw new LibraryError('The community library could not be read.');
    const base = fileHost(this.site, library.base);
    // An index never changes once published, so an unchanged version needs no second download.
    if (this.snapshot?.version === version && this.snapshot.base === base) { this.checkedAt = this.now(); return this.snapshot.catalog; }
    const parsed = version === 0 ? {categories: [], items: [], objects: new Map()}
      : parseIndex((await this.request(base ? `${base}/index/${version}.json` : `${this.site}/api/v1/library/index/${version}`, LIMITS.index)).toString('utf8'));
    const {objects, ...catalog} = parsed;
    this.snapshot = {version, base, catalog, records: new Map(catalog.items.map(item => [item.id, {item, ...objects.get(item.id)}]))};
    this.checkedAt = this.now();
    // Posters and files of items that changed or left the library are released.
    const current = new Set(catalog.items.map(item => `${item.id}:${item.sha256}`));
    this.posters.retain(key => current.has(key));
    this.files.retain(key => current.has(key));
    return catalog;
  }
  async record(id) {
    if (!isPublicId(id)) throw new LibraryError('Unknown community library asset.');
    await this.catalog();
    const record = this.snapshot.records.get(id);
    if (!record) throw new LibraryError(GONE);
    return {...record, base: this.snapshot.base};
  }
  once(key, operation) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const result = operation().finally(() => this.inflight.delete(key));
    this.inflight.set(key, result);
    return result;
  }
  /** Where a public object (a poster or a file) is served: the site's file host, or the site itself when it has none. */
  objectUrl(base, key) { return `${base ?? `${this.site}/api/v1/library/f`}/${key}`; }
  /** The asset's poster as a data URL (the renderer's CSP allows no remote images). */
  async preview(id) {
    const {item, poster, base} = await this.record(id), key = `${id}:${item.sha256}`;
    return this.posters.get(key) ?? this.once(`poster:${key}`, async () => {
      const bytes = await this.request(this.objectUrl(base, poster), LIMITS.poster, {missing: GONE}), type = imageType(bytes);
      if (!type) throw new LibraryError('The asset preview is not an image.');
      const url = `data:${type};base64,${bytes.toString('base64')}`;
      this.posters.set(key, url, url.length);
      return url;
    });
  }
  /**
   * The file's bytes. An item's first download goes through the site's counting route,
   * which answers with a redirect to the public file (the redirect may only lead to the
   * site). Once counted, the item is remembered and later downloads, in this session or
   * another, read the public file directly, so one person adds one download however often
   * the asset is inserted.
   */
  async download({item, file, base}) {
    if (await this.downloads.has(item.id)) return this.request(this.objectUrl(base, file), item.size, {timeout: 60000, missing: GONE});
    const route = new URL(`${this.site}/api/v1/library/get/${item.id}?k=${encodeURIComponent(file)}`);
    let redirect;
    try { redirect = await this.fetcher(route, {signal: AbortSignal.timeout(15000), redirect: 'manual'}); }
    catch { throw new LibraryError('Could not reach the community library. Check your connection and try again.'); }
    await redirect.body?.cancel().catch(() => {});
    if (redirect.status === 404) throw new LibraryError(GONE);
    let target = null;
    try { if (redirect.status >= 300 && redirect.status < 400) target = new URL(redirect.headers.get('location') ?? '', route); } catch { /* refused below */ }
    if (!target || !belongsToSite(this.site, target)) throw new LibraryError(UNAVAILABLE);
    await this.downloads.add(item.id);
    return this.request(target, item.size, {timeout: 60000, missing: GONE});
  }
  /** The verified native file: {item, name, extension, bytes}. */
  async asset(id) {
    const record = await this.record(id), {item} = record, {extension} = KINDS[item.kind];
    // Per item, not per checksum: two uploads with identical bytes are still two downloads.
    const key = `${item.id}:${item.sha256}`;
    const bytes = this.files.get(key) ?? await this.once(`file:${key}`, async () => {
      const downloaded = await this.download(record);
      if (downloaded.length !== item.size || sha256(downloaded) !== item.sha256) throw new LibraryError('The downloaded asset did not match the community library. Try again later.');
      this.files.set(key, downloaded, downloaded.length);
      return downloaded;
    });
    return {item, name: `${item.name}.${extension}`, extension: `.${extension}`, bytes};
  }
  /** The website's page for the library, or for one asset. */
  pageFor(id) { return isPublicId(id) ? `${this.site}/library/?item=${id}` : `${this.site}/library/`; }
}

module.exports = {PublicLibrary, DownloadLedger, parseIndex, isPublicId, siteFrom, LIMITS};
