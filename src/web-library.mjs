import {messageError} from './localized-error.mjs';
/** My library in the browser: saved figures, sets and movieclips, with folders, kept in this browser.
 *
 * The Library panel talks to the desktop's library through a small interface (listLibrary,
 * beginLibrarySave, ...; see desktop/library-store.cjs, which keeps the library in the
 * Documents folder). This is the same interface over browser storage, with the same rules
 * for names, unique names, moves and previews, so the panel is one implementation for both.
 *
 * Storage is IndexedDB, which every current browser has (OPFS lacks a portable writing API).
 * Metadata and the preview live in `items`, the file's bytes in `files`, so listing a folder
 * never touches a file. All logic runs over a small transactional backend: IndexedDB in the
 * browser (IndexedDbBackend) and a Map in tests (MemoryBackend). Like the desktop store,
 * paths are relative to the library root, folders are entries, and a file's preview and kind
 * live in its own entry, so a rename or move can never separate them.
 *
 * Nothing here is shared with a server, and the browser may clear it under storage pressure
 * unless the site is installed (docs/WEB.md); saving to the library never replaces a project.
 */
const EXTENSIONS = new Set(['.stkz', '.stykmov']);
export const CHUNK_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL = 1400000;
const PNG_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const LIBRARY_ROOT = 'This browser';
export const OUT_OF_SPACE = 'This browser has no more room for the library. Remove some saved assets or free up storage, then try again.';

export function validName(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || value.startsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value))
    throw messageError(new Error(''), "errors.webLibrary.useANameOf1120CharactersWithout", {});
  return value.trim();
}
/** A display name made safe for a file name (the panel does the same for Add to library). */
export function safeName(value) {
  let name = String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 110).trim() || 'Untitled asset';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `Asset ${name}`;
  return name;
}

const parentOf = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const baseOf = path => path.slice(path.lastIndexOf('/') + 1);
const join = (folder, name) => folder ? `${folder}/${name}` : name;
const extensionOf = name => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : ''; };
const missing = () => messageError(new Error(''), "errors.webLibrary.enoentThisLibraryItemIsNoLongerHere", {});
const same = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function checkPath(relative) {
  if (typeof relative !== 'string' || relative.length > 2000 || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => part && (part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))))
    throw messageError(new Error(''), "errors.webLibrary.invalidLibraryPath", {});
  return relative.split('/').filter(Boolean).join('/');
}

function checkThumbnail(thumbnail) {
  const match = typeof thumbnail === 'string' && thumbnail.length <= MAX_THUMBNAIL ? PNG_URL.exec(thumbnail) : null;
  if (!match) throw messageError(new Error(''), "errors.webLibrary.aPngThumbnailIsRequired", {});
  let head;
  try { head = atob(match[1].slice(0, 16)); } catch { throw messageError(new Error(''), "errors.webLibrary.invalidPngThumbnail", {}); }
  if (!PNG_MAGIC.every((byte, i) => head.charCodeAt(i) === byte)) throw messageError(new Error(''), "errors.webLibrary.invalidPngThumbnail", {});
  return thumbnail;
}

// --- Storage backends ---------------------------------------------------------------------

/**
 * Both backends give `transaction(work, {write})`: `work` receives a `tx` and runs as one atomic step (a
 * failure inside it changes nothing). A tx has get(path), children(folder), subtree(path) (everything below
 * a folder), put(item), remove(path), blob(path), putBlob(path, data) and removeBlob(path). A file's bytes are an ArrayBuffer:
 * WebKit cannot store a Blob in IndexedDB reliably, and every engine stores an ArrayBuffer.
 */
export class MemoryBackend {
  constructor() { this.items = new Map(); this.files = new Map(); this.chain = Promise.resolve(); }
  transaction(work) {
    const run = async () => {
      const items = new Map(this.items), files = new Map(this.files);
      const tx = {
        get: async path => this.items.get(path),
        children: async folder => [...this.items.values()].filter(item => item.parent === folder),
        subtree: async path => [...this.items.values()].filter(item => item.path.startsWith(`${path}/`)),
        put: async item => { this.items.set(item.path, item); },
        remove: async path => { this.items.delete(path); },
        blob: async path => this.files.get(path),
        putBlob: async (path, blob) => { this.files.set(path, blob); },
        removeBlob: async path => { this.files.delete(path); },
      };
      try { return await work(tx); } catch (error) { this.items = items; this.files = files; throw error; }
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
}

const settle = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

export class IndexedDbBackend {
  constructor({factory = globalThis.indexedDB, name = 'stykanimate-library'} = {}) { this.factory = factory; this.name = name; this.opening = null; }
  open() {
    this.opening ??= new Promise((resolve, reject) => {
      if (!this.factory) { reject(messageError(new Error(''), "errors.webLibrary.thisBrowserDoesNotAllowTheLibraryTo", {})); return; }
      let request;
      try { request = this.factory.open(this.name, 1); } catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('items', {keyPath: 'path'}).createIndex('parent', 'parent');
        db.createObjectStore('files');
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading or the browser closing the connection: reopen on the next use.
        db.onversionchange = () => { db.close(); this.opening = null; };
        db.onclose = () => { this.opening = null; };
        resolve(db);
      };
      request.onerror = () => { this.opening = null; reject(request.error ?? messageError(new Error(''), "errors.webLibrary.theLibraryCouldNotBeOpened", {})); };
      request.onblocked = () => reject(messageError(new Error(''), "errors.webLibrary.closeTheOtherStykanimateTabsToOpenThe", {}));
    });
    return this.opening;
  }
  async transaction(work, {write = false} = {}) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let transaction;
      try { transaction = db.transaction(['items', 'files'], write ? 'readwrite' : 'readonly'); } catch (error) { this.opening = null; reject(error); return; }
      const items = transaction.objectStore('items'), files = transaction.objectStore('files');
      const tx = {
        get: path => settle(items.get(path)),
        children: folder => settle(items.index('parent').getAll(IDBKeyRange.only(folder))),
        subtree: path => settle(items.getAll(IDBKeyRange.bound(`${path}/`, `${path}/￿`))),
        put: item => settle(items.put(item)),
        remove: path => settle(items.delete(path)),
        blob: path => settle(files.get(path)),
        putBlob: (path, blob) => settle(files.put(blob, path)),
        removeBlob: path => settle(files.delete(path)),
      };
      let value, failure;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(failure ?? transaction.error ?? messageError(new Error(''), "errors.webLibrary.theLibraryCouldNotBeWritten", {}));
      transaction.onerror = () => { failure ??= transaction.error; };
      // The work must only wait on the tx's own requests, or the transaction would finish under it.
      Promise.resolve().then(() => work(tx)).then(result => { value = result; }, error => { failure = error; try { transaction.abort(); } catch { /* already finished */ } });
    });
  }
}

/** A storage failure the person can act on; everything else passes through. */
const friendly = error => error?.name === 'QuotaExceededError' ? messageError(new Error(''), 'errors.webLibrary.outOfSpace') : error;

// --- The library ----------------------------------------------------------------------------

export class LocalLibrary {
  constructor({backend = new IndexedDbBackend(), locks = globalThis.navigator?.locks, now = Date.now, randomId = () => crypto.randomUUID()} = {}) {
    this.backend = backend; this.locks = locks; this.now = now; this.randomId = randomId;
    this.transfers = new Map();
  }
  /** One step of storage. Writes take a lock shared by every tab, so two tabs cannot save the same name at once. */
  async run(work, {write = false} = {}) {
    const step = () => this.backend.transaction(work, {write}).catch(error => { throw friendly(error); });
    return write && this.locks?.request ? this.locks.request('stykanimate-library', step) : step();
  }
  async folderExists(tx, folder) {
    if (folder === '') return;
    const item = await tx.get(folder);
    if (item?.type !== 'folder') throw missing();
  }
  /** A path in `folder` that no other entry has. `unique` numbers a clash ("Name (2)") instead of refusing it. */
  async available(tx, folder, stem, suffix = '', unique = false, allow = null) {
    const taken = new Set((await tx.children(folder)).map(item => item.name.toLocaleLowerCase()));
    if (allow) taken.delete(allow.toLocaleLowerCase());
    let candidate = `${stem}${suffix}`, n = 2;
    while (taken.has(candidate.toLocaleLowerCase())) {
      if (!unique) throw messageError(new Error(''), "errors.webLibrary.anItemWithThisNameAlreadyExists", {});
      candidate = `${stem} (${n++})${suffix}`;
    }
    return candidate;
  }
  entry(item) {
    const file = item.type === 'file';
    return {path: item.path, name: file ? item.name.slice(0, -item.extension.length) : item.name, kind: file ? item.kind : 'folder', extension: file ? item.extension : '', size: item.size ?? 0, modified: item.modified};
  }
  async list(folder = '') {
    folder = checkPath(folder);
    return this.run(async tx => {
      await this.folderExists(tx, folder);
      const entries = (await tx.children(folder)).map(item => this.entry(item));
      entries.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, {numeric: true}));
      return {root: LIBRARY_ROOT, path: folder, entries};
    });
  }
  async createFolder({folder = '', name} = {}) {
    folder = checkPath(folder); name = validName(name);
    return this.run(async tx => {
      await this.folderExists(tx, folder);
      const final = await this.available(tx, folder, name);
      await tx.put({path: join(folder, final), parent: folder, name: final, type: 'folder', modified: this.now()});
      return {path: join(folder, final)};
    }, {write: true});
  }
  async thumbnail(path) {
    path = checkPath(path);
    const item = await this.run(tx => tx.get(path));
    if (item?.type !== 'file') throw messageError(new Error(''), "errors.webLibrary.chooseASavedFigureOrMovieclip", {});
    return item.thumbnail ?? null;
  }

  // -- Saving: begin, write chunks, finish (the desktop's streamed transfer, kept so the panel is unchanged).
  async beginSave({folder = '', name, extension, size, thumbnail, kind} = {}) {
    folder = checkPath(folder);
    if (!EXTENSIONS.has(extension)) throw messageError(new Error(''), "errors.webLibrary.unsupportedLibraryFormat", {});
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw messageError(new Error(''), "errors.webLibrary.thisAssetIsTooLargeForTheLibrary", {});
    name = validName(name); checkThumbnail(thumbnail);
    await this.run(tx => this.folderExists(tx, folder));
    const token = this.randomId();
    this.transfers.set(token, {mode: 'save', folder, name, extension, size, thumbnail, kind: kind === 'set' ? 'set' : extension === '.stykmov' ? 'movieclip' : 'figure', parts: [], received: 0});
    return {token, maxChunkBytes: CHUNK_BYTES};
  }
  async write(token, bytes) {
    const transfer = this.transfers.get(token);
    if (transfer?.mode !== 'save') throw messageError(new Error(''), "errors.webLibrary.librarySaveIsNoLongerActive", {});
    const length = bytes?.byteLength;
    if (!Number.isSafeInteger(length) || length < 0 || transfer.received + length > transfer.size) throw messageError(new Error(''), "errors.webLibrary.theLibraryFileIsLargerThanAnnounced", {});
    transfer.parts.push(bytes); transfer.received += length;
    return {written: transfer.received, total: transfer.size};
  }
  async finish(token) {
    const transfer = this.transfers.get(token);
    if (transfer?.mode !== 'save') throw messageError(new Error(''), "errors.webLibrary.librarySaveIsNoLongerActive", {});
    try {
      if (transfer.received !== transfer.size) throw messageError(new Error(''), "errors.webLibrary.theLibraryFileWasNotReceivedCompletely", {});
      return await this.commit({...transfer, data: await new Blob(transfer.parts).arrayBuffer()});
    } finally { this.transfers.delete(token); }
  }
  /** The one place a file becomes a library entry: a unique name, the bytes, the preview and the kind, in one step. */
  commit({folder, name, extension, thumbnail, kind, data}) {
    return this.run(async tx => {
      await this.folderExists(tx, folder);
      const final = await this.available(tx, folder, name, extension, true), path = join(folder, final);
      await tx.put({path, parent: folder, name: final, type: 'file', extension, kind, size: data.byteLength, modified: this.now(), thumbnail});
      await tx.putBlob(path, data);
      return {saved: true, path};
    }, {write: true});
  }
  /** Saves bytes that are already here (a community asset), through the same rules. */
  async saveBytes({folder = '', name, extension, kind, thumbnail, bytes}) {
    folder = checkPath(folder);
    if (!EXTENSIONS.has(extension)) throw messageError(new Error(''), "errors.webLibrary.unsupportedLibraryFormat", {});
    if (bytes.byteLength > MAX_FILE_BYTES) throw messageError(new Error(''), "errors.webLibrary.thisAssetIsTooLargeForTheLibrary", {});
    return this.commit({folder, name: validName(safeName(name)), extension, thumbnail: checkThumbnail(thumbnail),
      kind: kind === 'set' ? 'set' : extension === '.stykmov' ? 'movieclip' : 'figure', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)});
  }

  // -- Reading.
  async beginRead(path) {
    path = checkPath(path);
    const {item, data} = await this.run(async tx => ({item: await tx.get(path), data: await tx.blob(path)}));
    if (item?.type !== 'file' || !data) throw messageError(new Error(''), "errors.webLibrary.chooseASavedFigureOrMovieclip", {});
    const token = this.randomId();
    this.transfers.set(token, {mode: 'read', data, offset: 0});
    return {token, size: data.byteLength, name: baseOf(path)};
  }
  async read(token) {
    const transfer = this.transfers.get(token);
    if (transfer?.mode !== 'read') throw messageError(new Error(''), "errors.webLibrary.libraryReadIsNoLongerActive", {});
    const end = Math.min(transfer.data.byteLength, transfer.offset + CHUNK_BYTES), bytes = transfer.data.slice(transfer.offset, end);
    transfer.offset = end;
    return {bytes, done: end >= transfer.data.byteLength};
  }
  async cancel(token) { this.transfers.delete(token); }

  /** Keeps a preview made for a file that had none, if the file is still the one it was made for. */
  async cacheThumbnail({path, thumbnail, modified, kind} = {}) {
    path = checkPath(path); checkThumbnail(thumbnail);
    return this.run(async tx => {
      const item = await tx.get(path);
      if (item?.type !== 'file') throw messageError(new Error(''), "errors.webLibrary.chooseASavedFigureOrMovieclip", {});
      if (item.modified !== modified) return false;
      await tx.put({...item, thumbnail: item.thumbnail ?? thumbnail, kind: kind === 'set' ? 'set' : item.kind});
      return true;
    }, {write: true});
  }

  // -- Renaming and moving.
  async change({path, name, folder} = {}) {
    path = checkPath(path);
    return this.run(async tx => {
      if (!path) throw messageError(new Error(''), "errors.webLibrary.theLibraryRootCannotBeMovedOrRenamed", {});
      const item = await tx.get(path);
      if (!item) throw missing();
      const target = folder === undefined ? item.parent : checkPath(folder);
      await this.folderExists(tx, target);
      if (item.type === 'folder' && (target === path || target.startsWith(`${path}/`))) throw messageError(new Error(''), "errors.webLibrary.aFolderCannotBeMovedIntoItself", {});
      const file = item.type === 'file', current = file ? item.name.slice(0, -item.extension.length) : item.name;
      const stem = name === undefined ? current : validName(name), suffix = file ? item.extension : '';
      if (target === item.parent && `${stem}${suffix}` === item.name) return {path};
      // A change of letter case alone is the same name, not a clash with itself.
      const final = await this.available(tx, target, stem, suffix, false, target === item.parent ? item.name : null), destination = join(target, final);
      const descendants = file ? [] : await tx.subtree(path), own = file ? await tx.blob(path) : null;
      await tx.remove(path); if (file) await tx.removeBlob(path);
      await tx.put({...item, path: destination, parent: target, name: final});
      if (own) await tx.putBlob(destination, own);
      for (const child of descendants) {
        const moved = `${destination}${child.path.slice(path.length)}`;
        await tx.remove(child.path);
        await tx.put({...child, path: moved, parent: parentOf(moved)});
        if (child.type === 'file') { const blob = await tx.blob(child.path); await tx.removeBlob(child.path); if (blob) await tx.putBlob(moved, blob); }
      }
      return {path: destination};
    }, {write: true});
  }
  /** Removes an entry (a folder with everything in it). The browser has no recycle bin; the panel says so. */
  async trash(path) {
    path = checkPath(path);
    return this.run(async tx => {
      if (!path) throw messageError(new Error(''), "errors.webLibrary.theLibraryRootCannotBeRemoved", {});
      const item = await tx.get(path);
      if (!item) throw missing();
      for (const child of item.type === 'folder' ? await tx.subtree(path) : []) { await tx.remove(child.path); if (child.type === 'file') await tx.removeBlob(child.path); }
      await tx.remove(path);
      if (item.type === 'file') await tx.removeBlob(path);
      return {removed: true};
    }, {write: true});
  }
}

/**
 * The interface the Library panel calls, over the browser's own library and the community library.
 * `page(url)` opens a web page (a new tab in the browser).
 */
export function createBrowserLibraryApi({library, community, page = url => globalThis.open(url, '_blank', 'noopener')}) {
  return {
    // The panel words its removal and folder actions for a place with no recycle bin and no file manager.
    inBrowser: true,
    listLibrary: folder => library.list(folder),
    createLibraryFolder: options => library.createFolder(options),
    getLibraryThumbnail: path => library.thumbnail(path),
    beginLibrarySave: options => library.beginSave(options),
    writeLibraryChunk: (token, bytes) => library.write(token, bytes),
    finishLibrarySave: token => library.finish(token),
    cancelLibraryTransfer: token => library.cancel(token),
    beginLibraryRead: path => library.beginRead(path),
    readLibraryChunk: token => library.read(token),
    changeLibraryItem: options => library.change(options),
    trashLibraryItem: path => library.trash(path),
    cacheLibraryThumbnail: options => library.cacheThumbnail(options),
    listPublicLibrary: refresh => community.catalog({refresh: refresh === true}),
    getPublicLibraryPreview: id => community.preview(id),
    readPublicLibraryAsset: async id => {
      const {name, bytes} = await community.asset(id);
      return {name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
    },
    savePublicLibraryAsset: async ({id, folder = '', thumbnail} = {}) => {
      const {item, extension, bytes} = await community.asset(id);
      return library.saveBytes({folder: typeof folder === 'string' ? folder : '', name: item.name, extension, kind: item.kind, thumbnail, bytes});
    },
    openPublicLibraryPage: async id => { page(community.pageFor(id)); },
  };
}
