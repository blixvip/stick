import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {PublicLibrary, DownloadLedger, parseIndex, siteFrom, isPublicId} = require('../desktop/public-library.cjs');
const {WorkspacePreferences} = require('../desktop/preferences.cjs');
const {LibraryStore} = require('../desktop/library-store.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEl0AAAAASUVORK5CYII=', 'base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const FILE = Buffer.from('native figure bytes');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SITE = 'https://stykanimate.com', FILES = 'https://files.stykanimate.com', VERSION = 1790667011941, ID = 'fanfan1234';
const entry = (id, extra = {}) => ({id, k: 'figure', c: 'props', t: 'Folding fan', d: 'A paper fan.', g: ['fan'], a: 'Kim', s: FILE.length, sha256: sha(FILE),
  f: `i/${id}/folding-fan.stkz`, p: null, i: `i/${id}/poster.webp`, w: 500, h: 500, m: '#478480', dl: 0, lk: 0, ft: 0, at: 1, ...extra});
const index = (items = [entry(ID)]) => ({version: VERSION, downloads: 0, items});
const announce = (library = {v: VERSION, count: 1, downloads: 0, paused: false, base: FILES}) => ({content: {}, library});
const redirectTo = location => new Response(null, {status: 302, headers: {location}});

/** A stand-in website: routes by origin and path, records every request. */
function site(routes) {
  const requests = [];
  const fetcher = async (url, options) => {
    const target = new URL(url);
    requests.push({url: target.href, options});
    const route = routes[`${target.origin}${target.pathname}`];
    if (route === undefined) return new Response('missing', {status: 404});
    const value = typeof route === 'function' ? route(target) : route;
    if (value instanceof Response) return value;
    return new Response(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), {status: 200});
  };
  return {fetcher, requests};
}
/** The routes of a healthy community library announcing a file host. */
const healthy = (extra = {}) => ({
  [`${SITE}/api/v1/content`]: announce(),
  [`${FILES}/index/${VERSION}.json`]: index(),
  [`${SITE}/api/v1/library/get/${ID}`]: redirectTo(`${FILES}/i/${ID}/folding-fan.stkz`),
  [`${FILES}/i/${ID}/folding-fan.stkz`]: FILE,
  [`${FILES}/i/${ID}/poster.webp`]: WEBP,
  ...extra,
});

test('reads the announced index and keeps the items the app can insert', async () => {
  const bad = [entry('Bad Id'), entry('wrongprefx', {f: 'i/other12345/x.stkz'}), entry('traversal1', {f: 'i/traversal1/../x.stkz'}), entry('nohash0001', {sha256: 'x'}),
    entry('huge000001', {s: 9 * 1024 * 1024}), entry('wrongext01', {f: 'i/wrongext01/x.stykmov'}), entry('untitled01', {t: ' '}), entry('project001', {k: 'project', f: 'i/project001/x.styk'}),
    entry('proto00001', {k: '__proto__'}), entry('listkind01', {k: ['figure']}), entry('noposter01', {i: 'i/other12345/poster.webp'}), {id: 'emptyentry'}, null];
  // Each bad entry has a well-formed id, so it is refused for the fault it carries and not for its id alone.
  assert.deepEqual(bad.filter(item => item && !isPublicId(item.id)).map(item => item.id), ['Bad Id']);
  const fan = entry(ID, {c: 'props'}), clip = entry('clipclip12', {k: 'movieclip', c: 'effects', t: 'Lightning', f: 'i/clipclip12/lightning.stykmov', s: 4249}),
    plain = entry('plainplain', {c: undefined, t: 'Plain', f: 'i/plainplain/plain.stkz', g: undefined, a: undefined, d: undefined});
  const {fetcher, requests} = site({[`${SITE}/api/v1/content`]: announce(), [`${FILES}/index/${VERSION}.json`]: index([fan, ...bad, entry(ID, {t: 'Duplicate'}), clip, plain])});
  const library = new PublicLibrary({fetcher});
  const catalog = await library.catalog();
  assert.deepEqual(catalog.items.map(item => item.id), [ID, 'clipclip12', 'plainplain']);
  assert.deepEqual(catalog.items[0], {id: ID, name: 'Folding fan', kind: 'figure', category: 'props', description: 'A paper fan.', author: 'Kim', tags: ['fan'], size: FILE.length, sha256: sha(FILE)});
  assert.equal(catalog.items[2].category, 'other'); assert.equal(catalog.items[2].author, ''); assert.deepEqual(catalog.items[2].tags, []);
  assert.deepEqual(catalog.categories, [{id: 'effects', name: 'Effects'}, {id: 'props', name: 'Props'}, {id: 'other', name: 'Other'}], 'the website\'s category order');
  assert.deepEqual(requests.map(request => request.url), [`${SITE}/api/v1/content`, `${FILES}/index/${VERSION}.json`]);
  assert.ok(requests.every(request => request.options.redirect === 'error'));
  assert.equal('file' in catalog.items[0] || 'poster' in catalog.items[0], false, 'object keys stay in the main process');
});

test('reads through the site when it has no file host, and ignores a host that is not its own', async () => {
  for (const base of [null, 'https://files.example.com', 'http://files.stykanimate.com', 'https://user@files.stykanimate.com']) {
    const {fetcher, requests} = site({
      [`${SITE}/api/v1/content`]: announce({v: VERSION, base}),
      [`${SITE}/api/v1/library/index/${VERSION}`]: index(),
      [`${SITE}/api/v1/library/f/i/${ID}/poster.webp`]: WEBP,
    });
    const library = new PublicLibrary({fetcher});
    assert.equal((await library.catalog()).items.length, 1, String(base));
    assert.match(await library.preview(ID), /^data:image\/webp;base64,/);
    assert.deepEqual(requests.map(request => new URL(request.url).host), Array(3).fill('stykanimate.com'), `only the site is contacted (${base})`);
  }
  const {fetcher, requests} = site({[`${SITE}/api/v1/content`]: announce({v: VERSION, base: 'https://files.stykanimate.com/'}), [`${FILES}/index/${VERSION}.json`]: index()});
  await new PublicLibrary({fetcher}).catalog();
  assert.equal(requests[1].url, `${FILES}/index/${VERSION}.json`, 'a trailing slash on the file host is harmless');
});

test('downloads an index once and rechecks the version after ten minutes', async () => {
  let clock = 0, published = index();
  const {fetcher, requests} = site({[`${SITE}/api/v1/content`]: () => announce({v: published.version, base: FILES}), [`${FILES}/index/${VERSION}.json`]: () => published,
    [`${FILES}/index/${VERSION + 1}.json`]: () => published, [`${SITE}/api/v1/library/get/${ID}`]: redirectTo(`${FILES}/i/${ID}/folding-fan.stkz`), [`${FILES}/i/${ID}/folding-fan.stkz`]: FILE});
  const library = new PublicLibrary({fetcher, now: () => clock});
  const first = await library.catalog();
  assert.equal(await library.catalog(), first); assert.equal(requests.length, 2, 'within ten minutes nothing is asked');
  clock += 10 * 60 * 1000;
  assert.equal(await library.catalog(), first); assert.equal(requests.length, 3, 'the same version costs one small request');
  await library.asset(ID);
  published = {...index([]), version: VERSION + 1};
  assert.deepEqual((await library.catalog({refresh: true})).items, [], 'a new version replaces the catalogue when refreshed');
  await assert.rejects(library.asset(ID), /no longer/);
  assert.equal(library.files.bytes, 0, 'files of items that left the library are released');
});

test('says what is wrong when the library cannot be read', async () => {
  await assert.rejects(new PublicLibrary({fetcher: site({[`${SITE}/api/v1/content`]: {content: {}, library: null}}).fetcher}).catalog(), /not available/);
  await assert.rejects(new PublicLibrary({fetcher: site({[`${SITE}/api/v1/content`]: 'not json'}).fetcher}).catalog(), /could not be read/);
  await assert.rejects(new PublicLibrary({fetcher: site({[`${SITE}/api/v1/content`]: announce({v: 'x'})}).fetcher}).catalog(), /could not be read/);
  await assert.rejects(new PublicLibrary({fetcher: site({[`${SITE}/api/v1/content`]: announce()}).fetcher}).catalog(), /unavailable/, 'a missing index');
  await assert.rejects(new PublicLibrary({fetcher: site({[`${SITE}/api/v1/content`]: announce(), [`${FILES}/index/${VERSION}.json`]: '{"items":5}'}).fetcher}).catalog(), /could not be read/);
  await assert.rejects(new PublicLibrary({fetcher: async () => { throw new TypeError('fetch failed'); }}).catalog(), /Could not reach/);
  await assert.rejects(new PublicLibrary({fetcher: async () => new Response('x'.repeat(300 * 1024))}).catalog(), /unexpectedly large/);
  const empty = new PublicLibrary({fetcher: site({[`${SITE}/api/v1/content`]: announce({v: 0, base: FILES})}).fetcher});
  assert.deepEqual(await empty.catalog(), {categories: [], items: []}, 'a library nobody has published to yet is empty, not broken');
  assert.deepEqual(parseIndex(JSON.stringify(index([]))).items, []);
});

test('downloads through the counting route and verifies the file against the index', async () => {
  const {fetcher, requests} = site(healthy());
  const library = new PublicLibrary({fetcher});
  const asset = await library.asset(ID);
  assert.equal(asset.name, 'Folding fan.stkz'); assert.equal(asset.extension, '.stkz'); assert.deepEqual(asset.bytes, FILE);
  const counted = requests.find(request => request.url.startsWith(`${SITE}/api/v1/library/get/`)), file = requests.find(request => request.url === `${FILES}/i/${ID}/folding-fan.stkz`);
  assert.equal(new URL(counted.url).searchParams.get('k'), `i/${ID}/folding-fan.stkz`);
  assert.equal(counted.options.redirect, 'manual'); assert.equal(file.options.redirect, 'error', 'the file itself is never followed further');
  await library.asset(ID);
  assert.equal(requests.filter(request => request.url.includes('/get/')).length, 1, 'a verified file is reused, so one insert is one download');
  assert.equal(library.pageFor(ID), `${SITE}/library/?item=${ID}`);
  assert.equal(library.pageFor('<bad>'), `${SITE}/library/`);
  await assert.rejects(library.asset('../content'), /Unknown/);
  await assert.rejects(library.asset('notlisted1'), /no longer/);
});

const counting = requests => requests.filter(request => request.url.includes('/api/v1/library/get/')).length;

test('a person\'s first download of an item is counted once, in this session and in later ones', async () => {
  const downloads = new DownloadLedger();
  const first = site(healthy());
  await new PublicLibrary({fetcher: first.fetcher, downloads}).asset(ID);
  assert.equal(counting(first.requests), 1);
  // Another launch, or a cache that let the file go: nothing is cached, and the item is not counted again.
  const later = site(healthy());
  assert.deepEqual((await new PublicLibrary({fetcher: later.fetcher, downloads}).asset(ID)).bytes, FILE);
  assert.equal(counting(later.requests), 0, 'the counting route is not asked again');
  assert.ok(later.requests.some(request => request.url === `${FILES}/i/${ID}/folding-fan.stkz` && request.options.redirect === 'error'), 'the public file is read directly');
  // A direct download is verified exactly like a counted one.
  const tampered = site(healthy({[`${FILES}/i/${ID}/folding-fan.stkz`]: Buffer.from('native figure bytez')}));
  await assert.rejects(new PublicLibrary({fetcher: tampered.fetcher, downloads}).asset(ID), /did not match/);
  const gone = site(healthy({[`${FILES}/i/${ID}/folding-fan.stkz`]: new Response('', {status: 404})}));
  await assert.rejects(new PublicLibrary({fetcher: gone.fetcher, downloads}).asset(ID), /no longer/);
  // Without a file host the site serves the file itself, still without counting.
  const inline = site({[`${SITE}/api/v1/content`]: announce({v: VERSION, base: null}), [`${SITE}/api/v1/library/index/${VERSION}`]: index(), [`${SITE}/api/v1/library/f/i/${ID}/folding-fan.stkz`]: FILE});
  assert.deepEqual((await new PublicLibrary({fetcher: inline.fetcher, downloads}).asset(ID)).bytes, FILE);
  assert.equal(counting(inline.requests), 0);
  // Another item is a first download of its own.
  const other = 'otheritem1', twin = 'twintwin12', OTHER = Buffer.from('another figure');
  const mixed = site(healthy({
    [`${FILES}/index/${VERSION}.json`]: index([entry(ID), entry(other, {f: `i/${other}/other.stkz`, s: OTHER.length, sha256: sha(OTHER)}), entry(twin, {f: `i/${twin}/twin.stkz`})]),
    [`${SITE}/api/v1/library/get/${other}`]: redirectTo(`${FILES}/i/${other}/other.stkz`), [`${FILES}/i/${other}/other.stkz`]: OTHER,
    [`${SITE}/api/v1/library/get/${twin}`]: redirectTo(`${FILES}/i/${twin}/twin.stkz`), [`${FILES}/i/${twin}/twin.stkz`]: FILE}));
  const library = new PublicLibrary({fetcher: mixed.fetcher, downloads});
  await library.asset(ID); await library.asset(other); await library.asset(other);
  assert.equal(counting(mixed.requests), 1, 'only the new item counted');
  await library.asset(twin);
  assert.equal(counting(mixed.requests), 2, 'an upload with the same bytes as another is still its own first download');
});

test('an item is remembered as counted only once the site answered its counting route', async () => {
  const downloads = new DownloadLedger();
  for (const broken of [new Response('{}', {status: 500}), new Response(FILE), redirectTo('https://evil.example.com/x.stkz')]) {
    await assert.rejects(new PublicLibrary({fetcher: site(healthy({[`${SITE}/api/v1/library/get/${ID}`]: broken})).fetcher, downloads}).asset(ID));
    assert.equal(await downloads.has(ID), false);
  }
  await assert.rejects(new PublicLibrary({fetcher: async url => { if (String(url).includes('/get/')) throw new TypeError('fetch failed'); return site(healthy()).fetcher(url); }, downloads}).asset(ID), /Could not reach/);
  assert.equal(await downloads.has(ID), false, 'a failed attempt can still be counted next time');
  const retry = site(healthy());
  await new PublicLibrary({fetcher: retry.fetcher, downloads}).asset(ID);
  assert.equal(counting(retry.requests), 1); assert.equal(await downloads.has(ID), true);
});

test('the download ledger keeps public ids on this device and stays bounded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'styk-ledger-')), open = () => new DownloadLedger(new WorkspacePreferences(dir, {filename: 'community-downloads.json', maxBytes: 128 * 1024}));
  const ledger = open();
  await ledger.add(ID); await ledger.add(ID);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'community-downloads.json'), 'utf8')), {version: 1, ids: [ID]}, 'only the public id is stored');
  const reopened = open();
  assert.equal(await reopened.has(ID), true); assert.equal(await reopened.has('otheritem1'), false);
  await writeFile(path.join(dir, 'community-downloads.json'), JSON.stringify({ids: ['../x', 'Fanfan1234', ID, 5, null]}));
  const hostile = open();
  assert.equal(await hostile.has(ID), true); assert.equal(await hostile.has('../x'), false); assert.equal(await hostile.has('Fanfan1234'), false);
  await writeFile(path.join(dir, 'community-downloads.json'), 'not json');
  assert.equal(await open().has(ID), false, 'a damaged file starts a fresh list');
  const ids = Array.from({length: 5001}, (_, index) => String(index).padStart(10, '0'));
  const bounded = new DownloadLedger({get: async () => ({ids}), set: async () => {}});
  assert.equal(await bounded.has(ids[0]), false, 'the oldest go first when a file holds too many'); assert.equal(await bounded.has(ids[5000]), true);
  await bounded.add('zzzzzzzzzz');
  assert.equal(await bounded.has(ids[1]), false); assert.equal(await bounded.has('zzzzzzzzzz'), true); assert.equal((await bounded.load()).size, 5000);
  const failing = new DownloadLedger({get: async () => { throw new Error('unreadable'); }, set: async () => { throw new Error('disk full'); }});
  await failing.add(ID);
  assert.equal(await failing.has(ID), true, 'not being able to save never stops a download, it is still remembered for this session');
  const session = new DownloadLedger();
  await session.add(ID);
  assert.equal(await session.has(ID), true); assert.equal(await new DownloadLedger().has(ID), false, 'without a file it lasts one session');
});

test('refuses redirects off the site, tampered, oversized and missing files', async () => {
  const route = extra => new PublicLibrary({fetcher: site(healthy(extra)).fetcher});
  await assert.rejects(route({[`${SITE}/api/v1/library/get/${ID}`]: redirectTo('https://evil.example.com/i/x.stkz')}).asset(ID), /unavailable/);
  await assert.rejects(route({[`${SITE}/api/v1/library/get/${ID}`]: redirectTo(`http://files.stykanimate.com/i/${ID}/folding-fan.stkz`)}).asset(ID), /unavailable/);
  await assert.rejects(route({[`${SITE}/api/v1/library/get/${ID}`]: new Response(FILE)}).asset(ID), /unavailable/, 'an answer that is not a redirect');
  await assert.rejects(route({[`${SITE}/api/v1/library/get/${ID}`]: new Response('{}', {status: 404})}).asset(ID), /no longer/);
  await assert.rejects(route({[`${FILES}/i/${ID}/folding-fan.stkz`]: Buffer.from('native figure bytez')}).asset(ID), /did not match/);
  await assert.rejects(route({[`${FILES}/i/${ID}/folding-fan.stkz`]: Buffer.alloc(FILE.length + 1)}).asset(ID), /unexpectedly large/);
  await assert.rejects(route({[`${FILES}/i/${ID}/folding-fan.stkz`]: Buffer.alloc(FILE.length - 1)}).asset(ID), /did not match/);
  const offline = new PublicLibrary({fetcher: async url => { if (String(url).includes('/get/')) throw new TypeError('fetch failed'); return site(healthy()).fetcher(url); }});
  await assert.rejects(offline.asset(ID), /Could not reach/);
});

test('a poster reaches the renderer as a data URL of its real type, once', async () => {
  const {fetcher, requests} = site(healthy({[`${FILES}/i/pngpng1234/poster.png`]: PNG, [`${FILES}/index/${VERSION}.json`]: index([entry(ID), entry('pngpng1234', {i: 'i/pngpng1234/poster.png', f: 'i/pngpng1234/x.stkz'})])}));
  const library = new PublicLibrary({fetcher});
  assert.match(await library.preview(ID), /^data:image\/webp;base64,/);
  assert.match(await library.preview('pngpng1234'), /^data:image\/png;base64,/);
  await library.preview(ID);
  assert.equal(requests.filter(request => request.url.endsWith('poster.webp')).length, 1);
  const html = new PublicLibrary({fetcher: site(healthy({[`${FILES}/i/${ID}/poster.webp`]: '<html>not an image</html>'})).fetcher});
  await assert.rejects(html.preview(ID), /not an image/);
  const large = new PublicLibrary({fetcher: site(healthy({[`${FILES}/i/${ID}/poster.webp`]: Buffer.concat([WEBP, Buffer.alloc(600 * 1024)])})).fetcher});
  await assert.rejects(large.preview(ID), /unexpectedly large/);
});

test('only loopback overrides of the website are accepted', () => {
  assert.throws(() => siteFrom('https://example.com'), /loopback/);
  assert.throws(() => siteFrom('http://example.com'), /loopback/);
  assert.throws(() => siteFrom('http://user:pass@127.0.0.1:4173'), /loopback/);
  assert.equal(siteFrom('http://127.0.0.1:4173/anything'), 'http://127.0.0.1:4173');
  assert.equal(siteFrom(undefined), SITE);
  assert.equal(isPublicId(ID), true);
  for (const value of ['../secret', 'Fanfan1234', 'fanfan123', 'fanfan12345', '', null, undefined, 5]) assert.equal(isPublicId(value), false, String(value));
});

test('works against a real HTTP server: the counted download follows the redirect to the file', async t => {
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/v1/content') return response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(announce({v: VERSION, base: null})));
    if (url.pathname === `/api/v1/library/index/${VERSION}`) return response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(index()));
    if (url.pathname === `/api/v1/library/get/${ID}`) return response.writeHead(302, {location: `/api/v1/library/f/${url.searchParams.get('k')}`}).end();
    if (url.pathname === `/api/v1/library/f/i/${ID}/folding-fan.stkz`) return response.writeHead(200, {'content-length': FILE.length}).end(FILE);
    if (url.pathname === `/api/v1/library/f/i/${ID}/poster.webp`) return response.writeHead(200).end(WEBP);
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`, downloads = new DownloadLedger();
  const library = new PublicLibrary({site: origin, downloads});
  assert.equal((await library.catalog()).items[0].name, 'Folding fan');
  assert.deepEqual((await library.asset(ID)).bytes, FILE);
  assert.match(await library.preview(ID), /^data:image\/webp/);
  assert.deepEqual(seen, ['GET /api/v1/content', `GET /api/v1/library/index/${VERSION}`, `GET /api/v1/library/get/${ID}`, `GET /api/v1/library/f/i/${ID}/folding-fan.stkz`, `GET /api/v1/library/f/i/${ID}/poster.webp`]);
  seen.length = 0;
  assert.deepEqual((await new PublicLibrary({site: origin, downloads}).asset(ID)).bytes, FILE);
  assert.deepEqual(seen, ['GET /api/v1/content', `GET /api/v1/library/index/${VERSION}`, `GET /api/v1/library/f/i/${ID}/folding-fan.stkz`], 'a later session reads the file without the counting route');
});

test('a community asset saves into the library with its preview, never over an existing file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-public-')), store = new LibraryStore(path.join(root, 'library'));
  await store.init(); t.after(() => store.dispose());
  const thumbnail = `data:image/png;base64,${PNG.toString('base64')}`;
  const first = await store.saveBytes({name: 'Bamboo: tall', extension: '.stkz', kind: 'set', thumbnail, bytes: FILE});
  const second = await store.saveBytes({name: 'Bamboo: tall', extension: '.stkz', kind: 'set', thumbnail, bytes: FILE});
  assert.equal(first.path, 'Bamboo- tall.stkz'); assert.equal(second.path, 'Bamboo- tall (2).stkz');
  assert.deepEqual(await readFile(path.join(store.root, first.path)), FILE);
  assert.deepEqual(await readFile(path.join(store.root, `${first.path}.png`)), PNG);
  assert.equal((await store.list()).entries[0].kind, 'set');
  await assert.rejects(store.saveBytes({name: 'Webp', extension: '.stkz', kind: 'figure', thumbnail: `data:image/webp;base64,${WEBP.toString('base64')}`, bytes: FILE}), /PNG thumbnail/);
});
