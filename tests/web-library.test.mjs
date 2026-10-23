import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalLibrary, MemoryBackend, LIBRARY_ROOT, OUT_OF_SPACE, CHUNK_BYTES, createBrowserLibraryApi, safeName, validName} from '../src/web-library.mjs';
import {saveLibraryFile, readLibraryFile} from '../src/library-files.mjs';

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')}`;
const PNG2 = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]).toString('base64')}`;
let ids = 0, clock = 1000;
const make = () => new LocalLibrary({backend: new MemoryBackend(), locks: null, now: () => ++clock, randomId: () => `token-${++ids}`});
const bytesOf = length => new Uint8Array(Array.from({length}, (_, i) => (i * 31 + 7) % 256));
const save = (library, name, {folder = '', extension = '.stkz', length = 1000, thumbnail = PNG, kind} = {}) =>
  saveLibraryFile(createBrowserLibraryApi({library, community: null}), new Blob([bytesOf(length)]), {folder, name, extension, thumbnail, kind});
const names = async (library, folder = '') => (await library.list(folder)).entries.map(entry => `${entry.kind === 'folder' ? '[' : ''}${entry.name}${entry.kind === 'folder' ? ']' : ''}`);

test('an empty library lists nothing, under its own name', async () => {
  const library = make();
  assert.deepEqual(await library.list(''), {root: LIBRARY_ROOT, path: '', entries: []});
  await assert.rejects(library.list('Nowhere'), /ENOENT/, 'the panel falls back to the top folder on this word');
});

test('a saved file lists with its kind, size, preview and unique name', async () => {
  const library = make();
  const first = await save(library, 'Blue');
  assert.deepEqual(first, {saved: true, path: 'Blue.stkz'});
  assert.equal((await save(library, 'Blue')).path, 'Blue (2).stkz'); assert.equal((await save(library, 'blue')).path, 'blue (3).stkz', 'names clash regardless of letter case');
  await save(library, 'Clip', {extension: '.stykmov', length: 50});
  await save(library, 'Pair', {kind: 'set'});
  const entries = (await library.list('')).entries;
  assert.deepEqual(entries.map(entry => [entry.name, entry.kind, entry.extension, entry.size]),
    [['Blue', 'figure', '.stkz', 1000], ['blue (3)', 'figure', '.stkz', 1000], ['Blue (2)', 'figure', '.stkz', 1000], ['Clip', 'movieclip', '.stykmov', 50], ['Pair', 'set', '.stkz', 1000]]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, {numeric: true})));
  assert.equal(await library.thumbnail('Blue.stkz'), PNG);
  await assert.rejects(library.thumbnail('Nothing.stkz'), /Choose a saved figure or movieclip/);
});

test('bytes come back exactly, in the panel\'s own chunks, and reads are independent', async () => {
  const library = make(), length = CHUNK_BYTES * 2 + 123;
  await save(library, 'Big', {length});
  const api = createBrowserLibraryApi({library, community: null});
  const file = await readLibraryFile(api, 'Big.stkz');
  assert.equal(file.name, 'Big.stkz'); assert.equal(file.size, length);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytesOf(length));
  const transfer = await library.beginRead('Big.stkz'), other = await library.beginRead('Big.stkz');
  assert.deepEqual([(await library.read(transfer.token)).done, (await library.read(other.token)).done], [false, false]);
  await library.cancel(transfer.token);
  await assert.rejects(library.read(transfer.token), /no longer active/);
  assert.equal((await library.read(other.token)).bytes.byteLength, CHUNK_BYTES);
  await assert.rejects(library.beginRead('Missing.stkz'), /Choose a saved figure/);
});

test('a save that is cancelled, short or too long leaves nothing behind', async () => {
  const library = make(), api = createBrowserLibraryApi({library, community: null});
  const cancelled = await library.beginSave({name: 'Cancelled', extension: '.stkz', size: 10, thumbnail: PNG});
  await library.write(cancelled.token, new ArrayBuffer(4)); await library.cancel(cancelled.token);
  await assert.rejects(library.finish(cancelled.token), /no longer active/);
  const short = await library.beginSave({name: 'Short', extension: '.stkz', size: 10, thumbnail: PNG});
  await library.write(short.token, new ArrayBuffer(4));
  await assert.rejects(library.finish(short.token), /not received completely/);
  const long = await library.beginSave({name: 'Long', extension: '.stkz', size: 4, thumbnail: PNG});
  await assert.rejects(library.write(long.token, new ArrayBuffer(5)), /larger than announced/);
  assert.deepEqual(await names(library), []);
  const failing = new Blob([bytesOf(10)]);
  await assert.rejects(saveLibraryFile({...api, finishLibrarySave: async () => { throw new Error('storage failed'); }}, failing, {name: 'Failing', extension: '.stkz', thumbnail: PNG}), /storage failed/);
  assert.deepEqual(await names(library), []);
});

test('names, formats and previews are checked like the desktop library checks them', async () => {
  const library = make();
  const begin = options => library.beginSave({name: 'Ok', extension: '.stkz', size: 1, thumbnail: PNG, ...options});
  for (const name of ['', '  ', 'a/b', 'a\\b', 'a:b', 'CON', 'con.txt', '.hidden', 'ends.', 'ends ', 'x'.repeat(121)]) await assert.rejects(begin({name}), /Use a name of 1–120 characters/, JSON.stringify(name));
  await assert.rejects(begin({extension: '.exe'}), /Unsupported library format/);
  await assert.rejects(begin({size: -1}), /too large/); await assert.rejects(begin({size: 65 * 1024 * 1024}), /too large/);
  for (const thumbnail of [undefined, '', 'data:image/jpeg;base64,AAAA', 'data:image/png;base64,AAAA', `${PNG}!`, `data:image/png;base64,${'A'.repeat(1400001)}`]) await assert.rejects(begin({thumbnail}), /PNG thumbnail/, String(thumbnail).slice(0, 30));
  await assert.rejects(begin({folder: '../up'}), /Invalid library path/); await assert.rejects(begin({folder: 'C:/x'}), /Invalid library path/); await assert.rejects(begin({folder: '/root'}), /Invalid library path/);
  await assert.rejects(begin({folder: 'Missing'}), /ENOENT/);
  assert.equal(validName('Hello'), 'Hello'); assert.equal(validName(' Hello'), 'Hello'); assert.throws(() => validName('Hello '), /Use a name/, 'the desktop refuses a trailing space too'); assert.equal(safeName('a/b:c'), 'a-b-c'); assert.equal(safeName('CON'), 'Asset CON'); assert.equal(safeName(''), 'Untitled asset'); assert.equal(safeName('x'.repeat(200)).length, 110);
});

test('folders nest, list first, and refuse clashing names', async () => {
  const library = make();
  assert.deepEqual(await library.createFolder({name: 'Heroes'}), {path: 'Heroes'});
  await library.createFolder({folder: 'Heroes', name: 'Villains'});
  await save(library, 'Zed'); await save(library, 'Alpha', {folder: 'Heroes'});
  await library.createFolder({name: 'Backgrounds'});
  assert.deepEqual(await names(library), ['[Backgrounds]', '[Heroes]', 'Zed']);
  assert.deepEqual(await names(library, 'Heroes'), ['[Villains]', 'Alpha']);
  await assert.rejects(library.createFolder({name: 'heroes'}), /already exists/);
  await assert.rejects(library.createFolder({name: 'Bad/Name'}), /Use a name/); await assert.rejects(library.createFolder({folder: 'Nope', name: 'X'}), /ENOENT/);
  const numbered = make(); for (const n of [10, 2, 1]) await save(numbered, `Item ${n}`);
  assert.deepEqual(await names(numbered), ['Item 1', 'Item 2', 'Item 10'], 'numbers sort as numbers');
});

test('renaming keeps the kind, the extension, the preview and the bytes', async () => {
  const library = make();
  await save(library, 'Old', {kind: 'set'});
  const before = (await library.list('')).entries[0];
  assert.deepEqual(await library.change({path: 'Old.stkz', name: 'New name'}), {path: 'New name.stkz'});
  const after = (await library.list('')).entries[0];
  assert.deepEqual([after.name, after.kind, after.extension, after.size, after.modified], ['New name', 'set', '.stkz', before.size, before.modified]);
  assert.equal(await library.thumbnail('New name.stkz'), PNG);
  assert.equal((await (await library.beginRead('New name.stkz')).size), 1000);
  await assert.rejects(library.beginRead('Old.stkz'), /Choose a saved/);
  assert.deepEqual(await library.change({path: 'New name.stkz', name: 'New name'}), {path: 'New name.stkz'}, 'the same name is not a clash with itself');
  assert.deepEqual(await library.change({path: 'New name.stkz', name: 'NEW NAME'}), {path: 'NEW NAME.stkz'}, 'a change of letter case is allowed');
  await save(library, 'Other');
  await assert.rejects(library.change({path: 'Other.stkz', name: 'new name'}), /already exists/);
  await assert.rejects(library.change({path: 'Other.stkz', name: 'a/b'}), /Use a name/); await assert.rejects(library.change({path: '', name: 'X'}), /root cannot be moved/); await assert.rejects(library.change({path: 'Gone.stkz', name: 'X'}), /ENOENT/);
});

test('moving a folder takes everything in it, files with their bytes and previews', async () => {
  const library = make();
  await library.createFolder({name: 'A'}); await library.createFolder({folder: 'A', name: 'Inner'}); await library.createFolder({name: 'B'});
  await save(library, 'Top', {folder: 'A', length: 111}); await save(library, 'Deep', {folder: 'A/Inner', length: 222, thumbnail: PNG2});
  assert.deepEqual(await library.change({path: 'A', folder: 'B'}), {path: 'B/A'});
  assert.deepEqual(await names(library), ['[B]']); assert.deepEqual(await names(library, 'B'), ['[A]']); assert.deepEqual(await names(library, 'B/A'), ['[Inner]', 'Top']);
  assert.equal((await library.beginRead('B/A/Inner/Deep.stkz')).size, 222); assert.equal(await library.thumbnail('B/A/Inner/Deep.stkz'), PNG2);
  await assert.rejects(library.beginRead('A/Top.stkz'), /Choose a saved/);
  assert.deepEqual(await library.change({path: 'B/A', name: 'Renamed'}), {path: 'B/Renamed'});
  assert.deepEqual(await names(library, 'B/Renamed'), ['[Inner]', 'Top']); assert.equal((await library.beginRead('B/Renamed/Top.stkz')).size, 111);
  await assert.rejects(library.change({path: 'B', folder: 'B/Renamed'}), /into itself/); await assert.rejects(library.change({path: 'B', folder: 'B'}), /into itself/);
  await save(library, 'Top', {folder: 'B'});
  assert.deepEqual(await library.change({path: 'B/Top.stkz', folder: ''}), {path: 'Top.stkz'}, 'a file moves out to the top');
  await save(library, 'Top', {folder: 'B'});
  await assert.rejects(library.change({path: 'B/Top.stkz', folder: ''}), /already exists/);
  await assert.rejects(library.change({path: 'B/Top.stkz', folder: 'Nowhere'}), /ENOENT/);
});

test('removing a folder removes everything in it and nothing else', async () => {
  const library = make();
  await library.createFolder({name: 'A'}); await library.createFolder({name: 'AB'}); await save(library, 'In A', {folder: 'A'}); await save(library, 'In AB', {folder: 'AB'}); await save(library, 'Top');
  assert.deepEqual(await library.trash('A'), {removed: true});
  assert.deepEqual(await names(library), ['[AB]', 'Top'], 'a folder whose name starts the same is untouched');
  assert.equal((await library.beginRead('AB/In AB.stkz')).size, 1000);
  await library.trash('Top.stkz'); assert.deepEqual(await names(library), ['[AB]']);
  await assert.rejects(library.trash('Top.stkz'), /ENOENT/); await assert.rejects(library.trash(''), /root cannot be removed/);
  assert.equal(library.backend.files.size, 1, 'no orphaned file bytes');
});

test('a preview made later is kept for the same file only, and never replaces one', async () => {
  const library = make();
  await save(library, 'Plain');
  const [entry] = (await library.list('')).entries;
  assert.equal(await library.cacheThumbnail({path: 'Plain.stkz', thumbnail: PNG2, modified: entry.modified + 1}), false, 'the file changed since');
  assert.equal(await library.thumbnail('Plain.stkz'), PNG);
  assert.equal(await library.cacheThumbnail({path: 'Plain.stkz', thumbnail: PNG2, modified: entry.modified, kind: 'set'}), true);
  assert.equal(await library.thumbnail('Plain.stkz'), PNG, 'the first preview stays');
  assert.equal((await library.list('')).entries[0].kind, 'set');
  await assert.rejects(library.cacheThumbnail({path: 'Plain.stkz', thumbnail: 'nope', modified: entry.modified}), /PNG thumbnail/);
});

test('a full browser is reported in words the person can act on, and changes nothing', async () => {
  class Full extends MemoryBackend { transaction(work, options) { return super.transaction(async tx => { const result = await work(tx); if (options?.write) throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'}); return result; }, options); } }
  const library = new LocalLibrary({backend: new Full(), locks: null, now: () => 1, randomId: () => 'token'});
  await assert.rejects(library.createFolder({name: 'X'}), error => error.message === OUT_OF_SPACE);
  assert.deepEqual((await library.list('')).entries, []);
});

test('two writers cannot take the same name at once when the tabs share a lock', async () => {
  const held = []; let tail = Promise.resolve();
  const locks = {request: (name, work) => { held.push(name); const run = tail.then(work); tail = run.catch(() => {}); return run; }};
  const library = new LocalLibrary({backend: new MemoryBackend(), locks, now: () => 1, randomId: () => `t${++ids}`});
  const results = await Promise.all(['Same', 'Same', 'Same'].map(name => save(library, name)));
  assert.deepEqual(results.map(result => result.path).sort(), ['Same (2).stkz', 'Same (3).stkz', 'Same.stkz']);
  assert.ok(held.length >= 3 && held.every(name => name === 'stykanimate-library'));
});

test('the browser interface has every call the panel makes, and the community ones go to the community client', async () => {
  const community = {catalog: async ({refresh}) => ({refresh}), preview: async id => `preview:${id}`, pageFor: id => `https://site.test/?item=${id}`,
    asset: async id => ({item: {name: 'Shared: Figure', kind: 'figure'}, extension: '.stkz', name: 'Shared: Figure.stkz', bytes: bytesOf(64)})};
  const opened = [], api = createBrowserLibraryApi({library: make(), community, page: url => opened.push(url)});
  for (const method of ['listLibrary', 'createLibraryFolder', 'getLibraryThumbnail', 'beginLibrarySave', 'writeLibraryChunk', 'finishLibrarySave', 'cancelLibraryTransfer', 'beginLibraryRead', 'readLibraryChunk',
    'changeLibraryItem', 'trashLibraryItem', 'cacheLibraryThumbnail', 'listPublicLibrary', 'getPublicLibraryPreview', 'readPublicLibraryAsset', 'savePublicLibraryAsset', 'openPublicLibraryPage']) assert.equal(typeof api[method], 'function', method);
  assert.equal(api.revealLibrary, undefined, 'there is no file manager to reveal a folder in'); assert.equal(api.inBrowser, true);
  assert.deepEqual(await api.listPublicLibrary(true), {refresh: true}); assert.deepEqual(await api.listPublicLibrary(), {refresh: false});
  assert.equal(await api.getPublicLibraryPreview('id'), 'preview:id');
  const read = await api.readPublicLibraryAsset('id'); assert.equal(read.name, 'Shared: Figure.stkz'); assert.ok(read.bytes instanceof ArrayBuffer); assert.equal(read.bytes.byteLength, 64);
  const saved = await api.savePublicLibraryAsset({id: 'id', folder: '', thumbnail: PNG});
  assert.deepEqual(saved, {saved: true, path: 'Shared- Figure.stkz'}, 'the site\'s name is made safe as a file name');
  assert.equal((await api.listLibrary('')).entries[0].name, 'Shared- Figure');
  await api.openPublicLibraryPage('id'); assert.deepEqual(opened, ['https://site.test/?item=id']);
});
