'use strict';
const { messageError } = require('./localization.cjs');


const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {FileStreams} = require('./file-streams.cjs');
const EXTENSIONS = new Set(['.stkz', '.stykmov']);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function validName(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || value.startsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value))
    throw messageError(new Error(''), 'desktop.libraryStore.errors.useANameOf1120CharactersWithoutReservedFilenameCharacters', {});
  return value.trim();
}
/** A display name made safe for a file name (the renderer does the same for Add to library). */
function safeName(value) {
  let name = String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 110).trim() || 'Untitled asset';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `Asset ${name}`;
  return name;
}

/** Every renderer path is relative to one fixed Documents library. Never follow links. */
class LibraryStore {
  constructor(root) { this.root = path.resolve(root); this.streams = new FileStreams(); this.pending = new Map(); this.chain = Promise.resolve(); }
  serial(operation) { const result = this.chain.then(() => { for (const token of this.pending.keys()) if (!this.streams.jobs.has(token)) this.pending.delete(token); return operation(); }); this.chain = result.catch(() => {}); return result; }
  async init() {
    await fs.mkdir(this.root, {recursive: true});
    await this.resolve('');
    return this.root;
  }
  async resolve(relative = '') {
    if (typeof relative !== 'string' || relative.length > 2000 || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => p && (p === '.' || p === '..' || /[:\x00-\x1f]/.test(p)))) throw messageError(new Error(''), 'desktop.libraryStore.errors.invalidLibraryPath', {});
    let current = this.root;
    for (const part of ['', ...relative.split('/').filter(Boolean)]) {
      if (part) { validName(part, 255); current = path.join(current, part); }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw messageError(new Error(''), 'desktop.libraryStore.errors.linkedFoldersAndFilesAreNotSupportedInTheLibrary', {});
    }
    return current;
  }
  async folder(relative = '') { const target = await this.resolve(relative); if (!(await fs.stat(target)).isDirectory()) throw messageError(new Error(''), 'desktop.libraryStore.errors.chooseALibraryFolder', {}); return target; }
  async available(folder, name, suffix = '', unique = false) {
    const names = new Set((await fs.readdir(folder)).map(n => n.toLocaleLowerCase()));
    for (const item of this.pending.values()) if (path.dirname(item.destination) === folder) names.add(path.basename(item.destination).toLocaleLowerCase());
    let candidate = name + suffix, i = 2;
    while (names.has(candidate.toLocaleLowerCase()) || suffix && ['.png','.json'].some(ext => names.has((candidate + ext).toLocaleLowerCase()))) {
      if (!unique) throw messageError(new Error(''), 'desktop.libraryStore.errors.anItemWithThisNameAlreadyExists', {});
      candidate = `${name} (${i++})${suffix}`;
    }
    return path.join(folder, candidate);
  }
  relative(target) { return path.relative(this.root, target).split(path.sep).join('/'); }
  async list(relative = '') {
    await this.init();
    const folder = await this.folder(relative), entries = [];
    for (const item of await fs.readdir(folder, {withFileTypes: true})) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const extension = path.extname(item.name).toLowerCase();
      if (!item.isDirectory() && (!item.isFile() || !EXTENSIONS.has(extension))) continue;
      const target = path.join(folder, item.name), stat = await fs.stat(target).catch(() => null);
      if (!stat) continue;
      let kind = item.isDirectory() ? 'folder' : extension === '.stykmov' ? 'movieclip' : 'figure';
      if (kind === 'figure') {
        try { const meta = await this.resolve(`${this.relative(target)}.json`); if ((await fs.stat(meta)).size < 4096 && JSON.parse(await fs.readFile(meta,'utf8')).kind === 'set') kind = 'set'; } catch { /* Optional metadata from older or external assets. */ }
      }
      entries.push({path: this.relative(target), name: item.isDirectory() ? item.name : item.name.slice(0, -extension.length),
        kind, extension, size: stat.size, modified: stat.mtimeMs});
    }
    entries.sort((a,b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, {numeric: true}));
    return {root: this.root, path: relative, entries};
  }
  createFolder({folder = '', name}) { return this.serial(async () => { const parent = await this.folder(folder); const target = await this.available(parent, validName(name)); await fs.mkdir(target); return {path: this.relative(target)}; }); }
  async thumbnail(relative) {
    const target = await this.asset(relative), thumb = `${target}.png`;
    try { await this.resolve(this.relative(thumb)); const stat = await fs.stat(thumb); if (stat.size > 1024 * 1024) return null; const bytes = await fs.readFile(thumb); return bytes.subarray(0,8).equals(PNG) ? `data:image/png;base64,${bytes.toString('base64')}` : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async asset(relative) { const target = await this.resolve(relative); if (!EXTENSIONS.has(path.extname(target).toLowerCase()) || !(await fs.stat(target)).isFile()) throw messageError(new Error(''), 'desktop.libraryStore.errors.chooseASavedFigureOrMovieclip', {}); return target; }
  beginSave({folder = '', name, extension, size, thumbnail, kind}) { return this.serial(async () => {
    if (!EXTENSIONS.has(extension)) throw messageError(new Error(''), 'desktop.libraryStore.errors.unsupportedLibraryFormat', {});
    if (typeof thumbnail !== 'string' || thumbnail.length > 1400000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(thumbnail)) throw messageError(new Error(''), 'desktop.libraryStore.errors.aPNGThumbnailIsRequired', {});
    const png = Buffer.from(thumbnail.split(',')[1], 'base64');
    if (!png.subarray(0,8).equals(PNG)) throw messageError(new Error(''), 'desktop.libraryStore.errors.invalidPNGThumbnail', {});
    const parent = await this.folder(folder), destination = await this.available(parent, validName(name), extension, true);
    const transfer = await this.streams.beginWrite({destination, size, exclusive:true});
    this.pending.set(transfer.token, {destination, png, kind: kind === 'set' ? 'set' : extension === '.stykmov' ? 'movieclip' : 'figure'});
    return {...transfer, path: this.relative(destination)};
  }); }
  /** Saves bytes already in the main process (a public library asset) through the same exclusive, staged commit. */
  async saveBytes({folder = '', name, extension, kind, thumbnail, bytes}) {
    const transfer = await this.beginSave({folder, name: safeName(name), extension, kind, thumbnail, size: bytes.length});
    try {
      for (let offset = 0; offset < bytes.length; offset += transfer.maxChunkBytes) await this.write(transfer.token, bytes.subarray(offset, offset + transfer.maxChunkBytes));
      return await this.finish(transfer.token);
    } catch (error) { await this.cancel(transfer.token).catch(() => {}); throw error; }
  }
  write(token, bytes) { return this.streams.write(token, bytes); }
  finish(token) { return this.serial(async () => {
    const item = this.pending.get(token); if (!item) throw messageError(new Error(''), 'desktop.libraryStore.errors.librarySaveIsNoLongerActive', {});
    const thumb = `${item.destination}.png`, temporary = `${thumb}.${randomUUID()}.tmp`;
    try {
      await this.folder(this.relative(path.dirname(item.destination)));
      // Refuse overwriting a file created externally during a transfer.
      try { await fs.lstat(item.destination); throw messageError(new Error(''), 'desktop.libraryStore.errors.thisNameWasTakenWhileSavingTryAgain', {}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.writeFile(temporary, item.png, {flag: 'wx'});
      await fs.link(temporary, thumb);
      let metadataCreated = false;
      try { await fs.writeFile(`${item.destination}.json`, JSON.stringify({version:1,kind:item.kind}), {flag:'wx'}); metadataCreated = true; await this.streams.finish(token); }
      catch (error) { await fs.unlink(thumb).catch(() => {}); if (metadataCreated) await fs.unlink(`${item.destination}.json`).catch(() => {}); throw error; }
      return {saved: true, path: this.relative(item.destination)};
    } finally { this.pending.delete(token); await fs.unlink(temporary).catch(() => {}); await this.streams.cancel(token); }
  }); }
  async cancel(token) { this.pending.delete(token); return this.streams.cancel(token); }
  async beginRead(relative) { const target = await this.asset(relative); return {...await this.streams.beginRead(target), name: path.basename(target)}; }
  async cacheThumbnail({path:relative, thumbnail, modified, kind}) {
    const target = await this.asset(relative);
    if ((await fs.stat(target)).mtimeMs !== modified) return false;
    if (typeof thumbnail !== 'string' || thumbnail.length > 1400000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(thumbnail)) throw messageError(new Error(''), 'desktop.libraryStore.errors.aPNGThumbnailIsRequired', {});
    const png = Buffer.from(thumbnail.split(',')[1],'base64'); if (!png.subarray(0,8).equals(PNG)) throw messageError(new Error(''), 'desktop.libraryStore.errors.invalidPNGThumbnail', {});
    try { await fs.writeFile(`${target}.png`,png,{flag:'wx'}); } catch(error) { if (error.code !== 'EEXIST') throw error; }
    if (kind === 'set') try { await fs.writeFile(`${target}.json`,JSON.stringify({version:1,kind}),{flag:'wx'}); } catch(error) { if (error.code !== 'EEXIST') throw error; }
    return true;
  }
  read(token) { return this.streams.read(token); }
  change({path: relative, name, folder}) { return this.serial(async () => {
    if (!relative) throw messageError(new Error(''), 'desktop.libraryStore.errors.theLibraryRootCannotBeMovedOrRenamed', {});
    const source = await this.resolve(relative), stat = await fs.stat(source);
    if (!stat.isDirectory()) await this.asset(relative);
    for (const item of this.pending.values()) if (item.destination === source || item.destination.startsWith(source + path.sep)) throw messageError(new Error(''), 'desktop.libraryStore.errors.waitForTheCurrentSaveToFinish', {});
    const parent = folder === undefined ? path.dirname(source) : await this.folder(folder);
    if (stat.isDirectory() && (parent === source || parent.startsWith(source + path.sep))) throw messageError(new Error(''), 'desktop.libraryStore.errors.aFolderCannotBeMovedIntoItself', {});
    const ext = stat.isDirectory() ? '' : path.extname(source), stem = name === undefined ? path.basename(source, ext) : validName(name);
    if (parent === path.dirname(source) && stem + ext === path.basename(source)) return {path: relative};
    const desired = path.join(parent, stem + ext);
    const destination = process.platform === 'win32' && desired.toLowerCase() === source.toLowerCase() ? desired : await this.available(parent, stem, ext);
    await fs.rename(source, destination);
    if (!stat.isDirectory()) {
      const moved = [];
      try { for (const ext of ['.png','.json']) {
        try { await this.resolve(`${relative}${ext}`); await fs.rename(`${source}${ext}`, `${destination}${ext}`); moved.push(ext); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      } } catch (error) { for (const ext of moved) await fs.rename(`${destination}${ext}`,`${source}${ext}`); await fs.rename(destination, source); throw error; }
    }
    return {path: this.relative(destination)};
  }); }
  trash(relative, trashItem) { return this.serial(async () => {
    if (!relative) throw messageError(new Error(''), 'desktop.libraryStore.errors.theLibraryRootCannotBeRemoved', {});
    const target = await this.resolve(relative), stat = await fs.stat(target);
    if (!stat.isDirectory()) await this.asset(relative);
    for (const item of this.pending.values()) if (item.destination === target || item.destination.startsWith(target + path.sep)) throw messageError(new Error(''), 'desktop.libraryStore.errors.waitForTheCurrentSaveToFinish', {});
    await trashItem(target);
    if (!stat.isDirectory()) for (const ext of ['.png','.json']) {
      try { await this.resolve(`${relative}${ext}`); await trashItem(`${target}${ext}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return {removed:true};
  }); }
  async dispose() { await this.streams.dispose(); this.pending.clear(); }
}
module.exports = {LibraryStore, validName, safeName};
