import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {CommunityLibrary, DownloadLedger, LibraryError, imageType, isPublicId, localStorageLedgerStorage, parseIndex} from '../src/community-library.mjs';
import {handle} from '../web/worker.js';

const require = createRequire(import.meta.url);
const desktop = require('../desktop/public-library.cjs');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FIGURE = new Uint8Array(Array.from({length: 300}, (_, i) => (i * 7) % 251));
const CLIP = new Uint8Array(Array.from({length: 120}, (_, i) => (i * 13) % 251));
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4]);
const entry = (id, over = {}) => ({id, k: 'figure', c: 'characters', t: `Item ${id}`, d: 'A description', g: ['blue', 'stick'], a: 'Ana', s: FIGURE.length, sha256: sha(FIGURE),
  f: `i/${id}/item.stkz`, i: `i/${id}/poster.webp`, ...over});
const INDEX = {v: 1, items: [
  entry('aaaaaaaaaa'),
  entry('bbbbbbbbbb', {k: 'movieclip', c: 'effects', s: CLIP.length, sha256: sha(CLIP), f: 'i/bbbbbbbbbb/clip.stykmov'}),
  entry('cccccccccc', {k: 'project'}),
  entry('dddddddddd', {c: 'weirdcategory1'}),
  entry('eeeeeeeeee', {sha256: 'nothex'}),
  entry('ffffffffff', {f: 'i/other/item.stkz'}),
  entry('gggggggggg', {s: 9 * 1024 * 1024}),
  {id: 'not-an-id', k: 'figure'}, null, 'text',
  entry('aaaaaaaaaa', {t: 'Duplicate'}),
]};

test('the index keeps only what the editor can insert, strictly', () => {
  const {items, categories, objects} = parseIndex(JSON.stringify(INDEX));
  assert.deepEqual(items.map(item => item.id), ['aaaaaaaaaa', 'bbbbbbbbbb', 'dddddddddd']);
  assert.deepEqual(categories, [{id: 'characters', name: 'Characters'}, {id: 'effects', name: 'Effects'}, {id: 'other', name: 'Other'}], 'known categories in the site\'s order, an invalid one becomes Other');
  assert.deepEqual(items[0], {id: 'aaaaaaaaaa', name: 'Item aaaaaaaaaa', kind: 'figure', category: 'characters', description: 'A description', author: 'Ana', tags: ['blue', 'stick'], size: 300, sha256: sha(FIGURE)});
  assert.deepEqual(objects.get('bbbbbbbbbb'), {file: 'i/bbbbbbbbbb/clip.stykmov', poster: 'i/bbbbbbbbbb/poster.webp'});
  assert.throws(() => parseIndex('{'), LibraryError); assert.throws(() => parseIndex('{"items":5}'), /could not be read/);
});

test('the browser client and the desktop client read every index the same way', () => {
  const fixtures = [JSON.stringify(INDEX), JSON.stringify({items: []}), JSON.stringify({items: Array.from({length: 40}, (_, i) => entry(`x${String(i).padStart(9, '0')}`, {c: ['props', 'moves', 'zzz', 'backgrounds'][i % 4], g: ['a'.repeat(33), 'ok', 5]}))}),
    JSON.stringify({items: [entry('aaaaaaaaaa', {t: '   '}), entry('bbbbbbbbbb', {d: 'x'.repeat(601), a: 'y'.repeat(65)}), entry('cccccccccc', {s: 0}), entry('dddddddddd', {i: 'i/dddddddddd/../poster.webp'})]})];
  for (const source of fixtures) {
    const mine = parseIndex(source), theirs = desktop.parseIndex(source);
    assert.deepEqual(mine.items, theirs.items); assert.deepEqual(mine.categories, theirs.categories);
    assert.deepEqual([...mine.objects], [...theirs.objects]);
  }
  for (const bad of ['{', 'null', '{"items":"no"}']) assert.throws(() => parseIndex(bad), error => error.message === 'The community library could not be read.' && (() => { try { desktop.parseIndex(bad); } catch (theirs) { return theirs.message === error.message; } })());
  for (const id of ['aaaaaaaaaa', 'AAAAAAAAAA', 'short', 'aaaaaaaaaaa', 5, null, 'a-a-a-a-a-']) assert.equal(isPublicId(id), desktop.isPublicId(id), String(id));
});

test('a poster is recognised by its bytes, not its name', () => {
  assert.equal(imageType(WEBP), 'image/webp');
  assert.equal(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(imageType(new Uint8Array()), null);
});

/** The site as the proxy sees it: content, immutable index, posters and files, and the counting route. */
function site({version = 1, index = INDEX, files = {}, counted = []} = {}) {
  const bytes = {'i/aaaaaaaaaa/item.stkz': FIGURE, 'i/bbbbbbbbbb/clip.stykmov': CLIP, 'i/aaaaaaaaaa/poster.webp': WEBP, 'i/bbbbbbbbbb/poster.webp': WEBP, ...files};
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const target = new URL(url);
    calls.push(`${target.host}${target.pathname}${target.search}`);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (target.host === 'stykanimate.com' && target.pathname === '/api/v1/content') return Response.json({library: {v: version, count: 3, base: 'https://files.stykanimate.com'}});
    if (target.host === 'files.stykanimate.com' && target.pathname === `/index/${version}.json`) return new Response(JSON.stringify(index), {headers: {'content-type': 'application/json'}});
    if (target.host === 'files.stykanimate.com' && bytes[target.pathname.slice(1)]) {
      const key = target.pathname.slice(1);
      return new Response(bytes[key], {headers: {'content-type': key.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'}});
    }
    const counting = /^\/api\/v1\/library\/get\/([a-z0-9]{10})$/.exec(target.pathname);
    if (target.host === 'stykanimate.com' && counting) {
      counted.push(counting[1]);
      const key = target.searchParams.get('k');
      return bytes[key] ? new Response(null, {status: 302, headers: {location: `https://files.stykanimate.com/${key}`}}) : new Response('gone', {status: 404});
    }
    return new Response('missing', {status: 404});
  };
  return {fetcher, calls, counted};
}
const ORIGIN = 'https://app.example.test';
/** A client whose requests reach the proxy Worker, which reaches the fake site: the same path a browser takes. */
function client(options = {}, {ledger = new DownloadLedger(), origin = site(options)} = {}) {
  const worker = (url, init) => handle(new Request(new URL(url, ORIGIN), {method: 'GET', signal: init?.signal}), {}, {fetcher: origin.fetcher, cache: undefined});
  return {library: new CommunityLibrary({proxy: '/community', fetcher: worker, downloads: ledger}), origin, ledger};
}

test('the catalogue is read through the proxy and reused until the site publishes a new index', async () => {
  const {library, origin} = client();
  const first = await library.catalog();
  assert.deepEqual(first.items.map(item => item.id), ['aaaaaaaaaa', 'bbbbbbbbbb', 'dddddddddd']);
  await library.catalog();
  assert.equal(origin.calls.filter(call => call.includes('/api/v1/content')).length, 1, 'ten minutes of reuse');
  await library.catalog({refresh: true});
  assert.equal(origin.calls.filter(call => call.includes('/index/')).length, 1, 'an unchanged version is not downloaded again');
  assert.ok(origin.calls.every(call => /^(stykanimate\.com\/api\/v1\/content|files\.stykanimate\.com\/index\/1\.json)$/.test(call)), 'only the two upstream addresses were used');
  const empty = client({version: 0}); assert.deepEqual((await empty.library.catalog()).items, []);
});

test('a poster is shown from its bytes and cached', async () => {
  const {library, origin} = client();
  const url = await library.preview('aaaaaaaaaa');
  assert.match(url, /^data:image\/webp;base64,/); assert.equal(Buffer.from(url.split(',')[1], 'base64').length, WEBP.length);
  await library.preview('aaaaaaaaaa');
  assert.equal(origin.calls.filter(call => call.endsWith('poster.webp')).length, 1);
  await assert.rejects(library.preview('zzzzzzzzzz'), /no longer in the community library/);
  await assert.rejects(library.preview('not an id'), /Unknown community library asset/);
  const html = client({files: {'i/aaaaaaaaaa/poster.webp': new TextEncoder().encode('<html>')}});
  await assert.rejects(html.library.preview('aaaaaaaaaa'), /not an image/);
});

test('a file is verified against the index, and one person counts once', async () => {
  const ledger = new DownloadLedger(), {library, origin} = client({}, {ledger});
  const asset = await library.asset('aaaaaaaaaa');
  assert.deepEqual([asset.name, asset.extension, asset.bytes.length], ['Item aaaaaaaaaa.stkz', '.stkz', FIGURE.length]);
  assert.deepEqual([...asset.bytes], [...FIGURE]);
  assert.deepEqual(origin.counted, ['aaaaaaaaaa'], 'the first download goes through the counting route');
  // A second client (a later session) reads the public file directly.
  const later = new CommunityLibrary({proxy: '/community', downloads: ledger, fetcher: (url, init) => handle(new Request(new URL(url, ORIGIN), {signal: init?.signal}), {}, {fetcher: origin.fetcher, cache: undefined})});
  await later.asset('aaaaaaaaaa');
  assert.deepEqual(origin.counted, ['aaaaaaaaaa'], 'not counted again');
  assert.equal((await library.asset('bbbbbbbbbb')).extension, '.stykmov');
  assert.deepEqual(origin.counted, ['aaaaaaaaaa', 'bbbbbbbbbb']);
});

test('a file that does not match its index entry never reaches the editor', async () => {
  const wrong = client({files: {'i/aaaaaaaaaa/item.stkz': new Uint8Array(FIGURE.length).fill(1)}});
  await assert.rejects(wrong.library.asset('aaaaaaaaaa'), /did not match the community library/);
  assert.equal(await wrong.ledger.has('aaaaaaaaaa'), true, 'the site counted the request, so a retry is not counted twice');
  const short = client({files: {'i/aaaaaaaaaa/item.stkz': FIGURE.subarray(0, 10)}});
  await assert.rejects(short.library.asset('aaaaaaaaaa'), /did not match/);
});

test('failures read as plain sentences', async () => {
  const offline = new CommunityLibrary({fetcher: async () => { throw new TypeError('Failed to fetch'); }});
  await assert.rejects(offline.catalog(), /Could not reach the community library/);
  const down = new CommunityLibrary({fetcher: async () => new Response('x', {status: 503})});
  await assert.rejects(down.catalog(), /unavailable right now/);
  const broken = new CommunityLibrary({fetcher: async () => Response.json({content: {}})});
  await assert.rejects(broken.catalog(), /not available right now/);
  const junk = new CommunityLibrary({fetcher: async () => new Response('not json')});
  await assert.rejects(junk.catalog(), /could not be read/);
  const huge = new CommunityLibrary({fetcher: async () => new Response(new Uint8Array(300 * 1024))});
  await assert.rejects(huge.catalog(), /unexpectedly large/);
});

test('the downloads a person has counted are remembered on this device, most recent last, and bounded', async () => {
  const saved = new Map();
  const storage = localStorageLedgerStorage({getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value)});
  const ledger = new DownloadLedger(storage);
  await ledger.add('aaaaaaaaaa'); await ledger.add('bbbbbbbbbb'); await ledger.add('aaaaaaaaaa');
  assert.deepEqual(JSON.parse(saved.get('stykanimate-community-downloads')), {version: 1, ids: ['aaaaaaaaaa', 'bbbbbbbbbb']});
  assert.equal(await new DownloadLedger(storage).has('bbbbbbbbbb'), true, 'a later session knows');
  saved.set('stykanimate-community-downloads', '{"version":1,"ids":["aaaaaaaaaa","not valid",5]}');
  assert.deepEqual([...(await new DownloadLedger(storage).load())], ['aaaaaaaaaa']);
  saved.set('stykanimate-community-downloads', 'garbage');
  assert.equal(await new DownloadLedger(storage).has('aaaaaaaaaa'), false);
  const full = new DownloadLedger();
  for (let i = 0; i < 5003; i++) await full.add(`x${String(i).padStart(9, '0')}`);
  assert.equal((await full.load()).size, 5000); assert.equal(await full.has('x000000000'), false); assert.equal(await full.has('x000005002'), true);
});

// --- The proxy Worker ---------------------------------------------------------------------

const ask = (path, options = {}, origin = site()) => handle(new Request(new URL(path, ORIGIN), options), {}, {fetcher: origin.fetcher, cache: undefined});

test('the proxy passes on exactly the requests the client makes and refuses everything else', async () => {
  const content = await ask('/community/content');
  assert.equal(content.status, 200); assert.equal(content.headers.get('content-type'), 'application/json'); assert.equal((await content.json()).library.v, 1);
  const index = await ask('/community/files/index/1.json'); assert.equal(index.status, 200); assert.equal((await index.json()).items.length, INDEX.items.length);
  const poster = await ask('/community/files/i/aaaaaaaaaa/poster.webp');
  assert.equal(poster.headers.get('content-type'), 'image/webp'); assert.match(poster.headers.get('cache-control'), /immutable/);
  const file = await ask('/community/files/i/aaaaaaaaaa/item.stkz');
  assert.equal(file.headers.get('content-type'), 'application/octet-stream'); assert.equal(new Uint8Array(await file.arrayBuffer()).length, FIGURE.length);
  const counted = await ask('/community/get/aaaaaaaaaa?k=i/aaaaaaaaaa/item.stkz');
  assert.equal(counted.status, 200); assert.equal(counted.headers.get('cache-control'), 'no-store'); assert.equal(new Uint8Array(await counted.arrayBuffer()).length, FIGURE.length, 'the redirect was followed here');
  for (const response of [content, index, poster, file, counted]) {
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy'), /sandbox/);
  }
  const refused = ['/community/files/../secret', '/community/files/index/1.json/extra', '/community/files/i/AAAAAAAAAA/x.stkz', '/community/files/i/aaaaaaaaaa/../x.stkz',
    '/community/files/private/x', '/community/get/aaaaaaaaaa', '/community/get/aaaaaaaaaa?k=i/bbbbbbbbbb/clip.stykmov', '/community/get/aaaaaaaaaa?k=i/aaaaaaaaaa/poster.webp',
    '/community/get/short?k=i/short/x.stkz', '/community/api/v1/admin', '/community/', '/community', '/other'];
  for (const path of refused) assert.equal((await ask(path)).status, 404, path);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await ask('/community/content', {method})).status, 405, method);
});

test('a hostile or broken upstream cannot make the proxy serve anything unexpected', async () => {
  // An image type on a file, and HTML where an image is expected, are served as opaque bytes.
  const disguised = site({files: {'i/aaaaaaaaaa/item.stkz': FIGURE}});
  const html = async () => new Response('<script>1</script>', {headers: {'content-type': 'text/html'}});
  const page = await handle(new Request(new URL('/community/files/i/aaaaaaaaaa/poster.webp', ORIGIN)), {}, {fetcher: html, cache: undefined});
  assert.equal(page.headers.get('content-type'), 'application/octet-stream');
  // The counting route may only lead to the site's own hosts.
  for (const location of ['https://evil.example/x.stkz', 'http://files.stykanimate.com/x.stkz', 'https://user:pw@files.stykanimate.com/x.stkz', 'https://stykanimate.com.evil.example/x']) {
    const redirect = async () => new Response(null, {status: 302, headers: {location}});
    assert.equal((await handle(new Request(new URL('/community/get/aaaaaaaaaa?k=i/aaaaaaaaaa/item.stkz', ORIGIN)), {}, {fetcher: redirect, cache: undefined})).status, 502, location);
  }
  // Oversized answers are stopped, by header and by counting bytes.
  const big = async () => new Response(new Uint8Array(600 * 1024));
  const streamed = await handle(new Request(new URL('/community/files/i/aaaaaaaaaa/poster.webp', ORIGIN)), {}, {fetcher: big, cache: undefined});
  await assert.rejects(streamed.arrayBuffer(), 'a body without a declared length is cut off at the limit');
  const declared = async () => new Response('x', {headers: {'content-length': String(64 * 1024 * 1024)}});
  assert.equal((await handle(new Request(new URL('/community/files/i/aaaaaaaaaa/item.stkz', ORIGIN)), {}, {fetcher: declared, cache: undefined})).status, 502);
  for (const status of [500, 503]) assert.equal((await handle(new Request(new URL('/community/content', ORIGIN)), {}, {fetcher: async () => new Response('x', {status}), cache: undefined})).status, 502);
  assert.equal((await handle(new Request(new URL('/community/content', ORIGIN)), {}, {fetcher: async () => { throw new Error('down'); }, cache: undefined})).status, 502);
  assert.equal((await handle(new Request(new URL('/community/files/i/aaaaaaaaaa/poster.webp', ORIGIN)), {}, {fetcher: async () => new Response('n', {status: 404}), cache: undefined})).status, 404);
  assert.equal(disguised.calls.length, 0);
});

test('the proxy answers repeat requests for immutable files from the edge cache', async () => {
  const stored = new Map(), cache = {match: async request => stored.get(request.url)?.clone(), put: async (request, response) => { stored.set(request.url, response); }};
  const origin = site(), pending = [];
  const options = {fetcher: origin.fetcher, cache, waitUntil: promise => pending.push(promise)};
  const request = () => new Request(new URL('/community/files/i/aaaaaaaaaa/item.stkz', ORIGIN));
  assert.equal((await handle(request(), {}, options)).status, 200); await Promise.all(pending);
  assert.equal((await handle(request(), {}, options)).status, 200);
  assert.equal(origin.calls.filter(call => call.endsWith('item.stkz')).length, 1, 'the second answer came from the cache');
  const custom = {SITE_URL: 'http://127.0.0.1:9', FILES_URL: 'http://127.0.0.1:8/'};
  const seen = []; await handle(new Request(new URL('/community/content', ORIGIN)), custom, {fetcher: async url => { seen.push(url); return Response.json({}); }, cache: undefined});
  assert.deepEqual(seen, ['http://127.0.0.1:9/api/v1/content'], 'the upstream hosts are configuration');
});
