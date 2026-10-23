/** Container v1/v2 codec tests: lossless round-trips, marker semantics,
 *  corruption rejection, and compatibility with the v1/legacy formats. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContainerV1, buildContainerV2, encodeContainerV2, decodeDocument, liftDocument,
  normalizeDecodedDocument, bytesToBase64, base64ToBytes, inflate, deflate, materializeMarkers,
  encodeContainerV2Parts, createContainerCompressionCache} from '../src/native-container.mjs';

const floats = () => Array.from({length: 64}, (_, i) => Math.sin(i) * 180);

test('sectioned metadata has a separate bound while payload and aggregate limits remain enforced',async()=>{
  const bytes=await buildContainerV2({name:'small'},'styk');
  for(const [version,raw,message] of [[1,300*1024*1024,/uncompressed size/],
    [2,385*1024*1024,/uncompressed size/],[2,300*1024*1024,/invalid payload length/]]) {
    const malformed=bytes.slice(),view=new DataView(malformed.buffer);
    view.setUint8(4,version);view.setBigUint64(8,BigInt(raw),true);
    if(version===1)view.setUint8(5,1);
    await assert.rejects(decodeDocument(malformed,'styk'),message);
  }
  await assert.rejects(encodeContainerV2({skeleton:{},sections:[{bytes:{byteLength:257*1024*1024}}]},'styk'),
    error=>error.code==='document_too_large');
  await assert.rejects(encodeContainerV2({skeleton:{},sections:[{bytes:{byteLength:200*1024*1024}},{bytes:{byteLength:200*1024*1024}}]},'styk'),
    error=>error.code==='document_too_large');
});

test('zlib inflation rejects oversized, incomplete, and concatenated streams', async () => {
  const payload = new TextEncoder().encode('z'.repeat(1024 * 1024));
  const packed = await deflate(payload);
  await assert.rejects(inflate(packed, 8192), /uncompressed size/);
  assert.deepEqual(await inflate(packed, payload.length), payload);
  await assert.rejects(inflate(packed.subarray(0, packed.length - 1), payload.length));
  await assert.rejects(inflate(new Uint8Array([...packed, ...packed]), payload.length));
});

test('v2 rejects reserved fields, section kinds, codecs and unsafe lengths', async () => {
  const bytes = await buildContainerV2({a: floats()}, 'styk');
  const sectionOffset = 60 + Number(new DataView(bytes.buffer).getBigUint64(16, true));
  for (const relative of [2, 4, 56, 63]) {
    const damaged = bytes.slice(); damaged[sectionOffset + relative] = 1;
    await assert.rejects(decodeDocument(damaged, 'styk'), /Unsupported/);
  }
  for (const [relative, value] of [[0, 3], [1, 3]]) {
    const damaged = bytes.slice(); damaged[sectionOffset + relative] = value;
    await assert.rejects(decodeDocument(damaged, 'styk'), /section kind|Unsupported/);
  }
  for (const relative of [8, 16]) {
    const damaged = bytes.slice();
    new DataView(damaged.buffer).setBigUint64(sectionOffset + relative, 2n ** 63n, true);
    await assert.rejects(decodeDocument(damaged, 'styk'), /section table/);
  }
  await assert.rejects(decodeDocument(bytes.subarray(0, 56), 'styk'), /truncated/);
});

test('materialization admits repeated references before changing the skeleton', () => {
  const bytes = new Uint8Array(60), marker = 'S2S:0:0:60';
  const document = {a: marker, b: marker};
  assert.throws(() => materializeMarkers(document, [{kind: 2, bytes}], {maxMaterializedBytes: 200}), /uncompressed size/);
  assert.deepEqual(document, {a: marker, b: marker});
  assert.equal(materializeMarkers({a: marker}, [{kind: 2, bytes}], {maxMaterializedBytes: 200}).a, bytesToBase64(bytes));
  const numeric = {a: 'S2B:u8:0:0:32'};
  assert.throws(() => materializeMarkers(numeric, [{kind: 1, bytes: new Uint8Array(32)}], {maxMaterializedBytes: 1000}), /uncompressed size/);
  for (const marker of ['S2B:u8:0:0:9007199254740993', 'S2B:u8:9007199254740993:0:0', 'S2S:0:9007199254740993:0'])
    assert.throws(() => materializeMarkers({a: marker}, [{kind: 1, bytes}]), /section reference/);
});

test('unaligned stored numeric ranges restore exact values and existing aliases', () => {
  const bytes = new Uint8Array(1 + 16), view = new DataView(bytes.buffer);
  view.setFloat64(1, .125, true); view.setFloat64(9, -1e300, true);
  const marker = 'S2B:f64:0:0:2';
  const out = materializeMarkers({a: marker, b: marker}, [{kind: 1, bytes: bytes.subarray(1)}]);
  assert.deepEqual(out.a, [.125, -1e300]); assert.equal(out.a, out.b);
});

test('drawing payloads, literal markers and unknown metadata remain lossless', async () => {
  const document = {styk_tiles: 'data:application/x-styk-tiles;base64,' + bytesToBase64(new Uint8Array(80000)),
    literal: 'S2B:f64:0:0:3', escaped: 'S2E:a', future: JSON.parse('{"__proto__":{"retained":true}}')};
  assert.match(liftDocument(document).skeleton.styk_tiles, /^S2D:/);
  assert.deepEqual((await decodeDocument(await buildContainerV2(document, 'styk'), 'styk')).document, document);
});

test('writer rejects excess lifted data before allocating its sections', () => {
  assert.throws(() => liftDocument({a: floats()}, {maxBytes: 100}), error => error.code === 'document_too_large');
  assert.throws(() => liftDocument({}, {preBlobs: [new Uint8Array(101)], maxBytes: 100}), error => error.code === 'document_too_large');
  const encoded = bytesToBase64(new Uint8Array(50000));
  assert.throws(() => liftDocument({data_base64: encoded}, {maxBytes: 100}), error => error.code === 'document_too_large');
  // Noncanonical opaque fields remain inline; they are not decoded as blobs.
  assert.equal(liftDocument({data_base64: '=' + encoded.slice(1)}, {maxBytes: 20000}).skeleton.data_base64[0], '=');
});

test('numeric admission falls back to exact JSON costs near its limit', () => {
  // The finite-number bound exceeds 16 bytes, but the actual document fits.
  assert.doesNotThrow(() => liftDocument({x: 1.25}, {maxBytes: 4}));
  assert.throws(() => liftDocument({x: 1.1234567891234567}, {maxBytes: 4}),
    error => error.code === 'document_too_large');
  const numbers = [Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    1e-7, -1e-7, 1e-6, -1e-6, 1e20, -1e20, 1e21, -1e21, Number.EPSILON, -0];
  for (const x of numbers) {
    const document = {x}, bytes = new TextEncoder().encode(JSON.stringify(document)).length;
    assert.doesNotThrow(() => liftDocument(document, {maxBytes: Math.ceil(bytes / 4)}));
    assert.throws(() => liftDocument(document, {maxBytes: Math.ceil(bytes / 4) - 1}),
      error => error.code === 'document_too_large');
  }
});

test('exact numeric fallback counts shared references and keeps allocation limits', () => {
  const shared = Array(32).fill(0);
  const document = {arr: Array(20).fill(shared)};
  assert.ok(JSON.stringify(document).length < 1600);
  const lifted = liftDocument(document, {maxBytes: 400});
  assert.equal(lifted.sections[0].bytes.length, 32);
  assert.equal(lifted.skeleton.arr[0], lifted.skeleton.arr[19]);
  assert.equal(document.arr[0], shared); assert.equal(shared[0], 0);
  const tooMany = {arr: Array(25).fill(shared)};
  assert.ok(JSON.stringify(tooMany).length > 1600);
  assert.throws(() => liftDocument(tooMany, {maxBytes: 400}), error => error.code === 'document_too_large');
  // The serialized text fits, while 48 bytes per numeric element plus the
  // unique raw section cannot fit. The estimate must not waive that limit.
  assert.throws(() => liftDocument({arr: shared}, {maxBytes: 391}), error => error.code === 'document_too_large');
});

test('numeric admission retains inline JSON null and negative-zero behavior', async () => {
  const document = {x: NaN, y: 1};
  assert.equal(JSON.stringify(document).length, 16);
  assert.doesNotThrow(() => liftDocument(document, {maxBytes: 4}));
  assert.throws(() => liftDocument(document, {maxBytes: 3}), error => error.code === 'document_too_large');
  const nonfinite = {values: Array(40).fill(Infinity), x: NaN, y: -Infinity, z: -0};
  const lifted = liftDocument(nonfinite);
  assert.ok(Array.isArray(lifted.skeleton.values));
  assert.deepEqual((await decodeDocument(await encodeContainerV2(lifted, 'styk'), 'styk')).document,
    JSON.parse(JSON.stringify(nonfinite)));
});

test('reserved binary source fields admit every reference and preserve foreign typed arrays', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const document = {_stykSource: {source_base64: bytes}, media: {data_base64: bytes}, foreign: bytes,
    literal: 'S2E:literal', zero: {source_base64: new Uint8Array()}};
  const empty = document.zero.source_base64;
  const lifted = liftDocument(document, {preBlobs: [bytes, empty]});
  assert.equal(lifted.skeleton._stykSource.source_base64, 'S2S:1:0:4');
  assert.equal(lifted.skeleton.media.data_base64, 'S2S:1:0:4');
  assert.equal(lifted.skeleton.zero.source_base64, 'S2S:1:4:0');
  assert.deepEqual(lifted.skeleton.foreign, {'0': 0, '1': 1, '2': 2, '3': 255});
  assert.deepEqual(liftDocument({source_base64: bytes}).skeleton, {source_base64: {'0': 0, '1': 1, '2': 2, '3': 255}});
  const cache = createContainerCompressionCache();
  const first = (await decodeDocument(await encodeContainerV2(lifted, 'styk', {cache}), 'styk')).document;
  assert.equal(first._stykSource.source_base64, bytesToBase64(bytes));
  assert.equal(first.media.data_base64, first._stykSource.source_base64);
  assert.equal(first.zero.source_base64, ''); assert.equal(first.literal, document.literal);
  bytes[0] = 77;
  const stats = {}, updated = await encodeContainerV2(liftDocument(document, {preBlobs: [bytes, empty]}), 'styk', {cache, stats});
  assert.equal((await decodeDocument(updated, 'styk')).document._stykSource.source_base64, bytesToBase64(bytes));
  assert.ok(stats.misses > 0);
  const many = new Uint8Array(100), repeated = {a: {source_base64: many}, b: {source_base64: many},
    c: {source_base64: many}, d: {source_base64: many}};
  assert.throws(() => liftDocument(repeated, {preBlobs: [many], maxBytes: 150}), error => error.code === 'document_too_large');
  assert.doesNotThrow(() => liftDocument({a: {source_base64: many}}, {preBlobs: [many], maxBytes: 150}));
});

test('multipart output and bounded compression reuse preserve bytes and edit independence', async () => {
  const a = floats(), document = {a, alias: a, independent: a.slice(), data_base64: bytesToBase64(new Uint8Array(80000))};
  const cache = createContainerCompressionCache({maxBytes: 1024 * 1024, maxEntries: 8});
  const firstStats = {}, first = await encodeContainerV2Parts(liftDocument(document), 'styk', {cache, stats: firstStats});
  const firstBytes = new Uint8Array(await new Blob(first.parts).arrayBuffer());
  assert.equal(first.byteLength, firstBytes.length); assert.equal(firstStats.misses, 3);
  const rawLifted = liftDocument(document);
  assert.equal(firstStats.container_raw_bytes, new TextEncoder().encode(JSON.stringify(rawLifted.skeleton)).length +
    rawLifted.sections.reduce((sum, section) => sum + section.bytes.length, 0));
  // A caller owns miss-result arrays; changing one cannot corrupt the cache.
  first.parts[1].fill(0);
  const secondStats = {}, second = await encodeContainerV2Parts(liftDocument(document), 'styk', {cache, stats: secondStats});
  assert.equal(secondStats.hits, 3);
  assert.deepEqual(new Uint8Array(await new Blob(second.parts).arrayBuffer()), firstBytes);
  assert.deepEqual(await encodeContainerV2(liftDocument(document), 'styk', {cache}), firstBytes);
  const restored = createContainerCompressionCache({maxBytes: 1024 * 1024, maxEntries: 8});
  const snapshot = cache.snapshot(); restored.restore(structuredClone(snapshot));
  snapshot.length = 0; // Caller-owned metadata cannot alter retained blocks.
  const restoredStats = {};
  assert.deepEqual(await encodeContainerV2(liftDocument(document), 'styk', {cache: restored, stats: restoredStats}), firstBytes);
  assert.equal(restoredStats.hits, 3); assert.equal(restored.byteLength, cache.byteLength);
  const decoded = (await decodeDocument(firstBytes, 'styk')).document;
  assert.equal(decoded.a, decoded.alias); assert.notEqual(decoded.a, decoded.independent);
  decoded.a[0] = 999; assert.notEqual(decoded.independent[0], 999);
  document.a[0] = 1.25;
  const changedStats = {}, changed = await encodeContainerV2Parts(liftDocument(document), 'styk', {cache, stats: changedStats});
  assert.equal(changedStats.hits, 2); assert.equal(changedStats.misses, 1);
  assert.deepEqual((await decodeDocument(new Uint8Array(await new Blob(changed.parts).arrayBuffer()), 'styk')).document, document);
  // Mutating emitted bytes cannot corrupt the cache's immutable retained block.
  for (const part of first.parts) if (part instanceof Uint8Array) part.fill(0);
  assert.deepEqual(await encodeContainerV2(liftDocument({...document, a, alias: a}), 'styk', {cache}),
    await encodeContainerV2(liftDocument(document), 'styk'));
  cache.clear(); assert.equal(cache.byteLength, 0); assert.equal(cache.size, 0);
  const tiny = createContainerCompressionCache({maxBytes: 20, maxEntries: 1});
  await encodeContainerV2Parts(liftDocument(document), 'styk', {cache: tiny});
  assert.ok(tiny.byteLength <= 20); assert.ok(tiny.size <= 1);
  const bounded = createContainerCompressionCache({maxBytes: 20, maxEntries: 2});
  bounded.put('a', new Uint8Array(8)); bounded.put('b', new Uint8Array(8));
  bounded.get('a'); bounded.put('c', new Uint8Array(8));
  assert.equal(bounded.get('b'), undefined); assert.ok(bounded.get('a')); assert.ok(bounded.get('c'));
  bounded.put('oversized', new Uint8Array(21)); assert.equal(bounded.get('oversized'), undefined);
  assert.equal(bounded.byteLength, 16); assert.equal(bounded.size, 2);
  const key = length => `1:default:${length}:${'0'.repeat(64)}`;
  bounded.restore([{key: key(3), blob: new Blob([new Uint8Array(8)])},
    {key: key(4), blob: new Blob([new Uint8Array(8)])}, {key: key(5), blob: new Blob([new Uint8Array(8)])}]);
  assert.equal(bounded.size, 2); assert.equal(bounded.byteLength, 16); assert.equal(bounded.get(key(3)), undefined);
  for (const invalid of [null, {}, {key: 'wrong', blob: new Blob()}, {key: key(1), blob: new Uint8Array()},
    {key: key(500000000), blob: new Blob()}, {key: 'x'.repeat(200), blob: new Blob()},
    {key: key(1), blob: new Blob([new Uint8Array(21)])}]) {
    bounded.restore([invalid]); assert.equal(bounded.size, 0); assert.equal(bounded.byteLength, 0);
  }
  bounded.restore({}); assert.equal(bounded.size, 0);
});

test('v2 round-trips a document losslessly', async () => {
  const shared = floats();
  const doc = {
    version: 5, fps: 12, canvas: {width: 640, height: 480},
    keyframes: [{duration_raw: 2, objects: [
      {figure_type_id: 1, angles: shared, lengths: Array(64).fill(12.5),
        bends: Array.from({length: 40}, (_, i) => i - 20), uids: [0, 255, 65536, 4294967295],
        neg: [-5, -3, 7, -2147483648], join: {target_object_slot: 1}},
      {figure_type_id: 2, angles: shared},
    ]}],
    figure_types: [{figure_type_id: 1, segments: [{kind: 'line'}]}],
    _stykSource: {kind: 'piv', version: 5,
      source_base64: bytesToBase64(new TextEncoder().encode('source bytes '.repeat(6000)))},
    media: [{name: 'a.png', data_url: 'data:image/png;base64,' + bytesToBase64(new TextEncoder().encode('PNG'.repeat(50000)))}],
    title: 'S2B:looks like a marker', alt: 'S2E:also escaped',
  };
  const container = await buildContainerV2(doc, 'styk');
  assert.equal(new TextDecoder().decode(container.subarray(0, 4)), 'STYK');
  assert.equal(container[4], 2);
  const {document: out} = await decodeDocument(container, 'styk');
  assert.deepEqual(out.keyframes[0].objects[0], doc.keyframes[0].objects[0]);
  assert.deepEqual(out.keyframes[0].objects[1], doc.keyframes[0].objects[1]);
  assert.equal(out._stykSource.source_base64, doc._stykSource.source_base64);
  assert.equal(out.media[0].data_url, doc.media[0].data_url);
  assert.equal(out.title, doc.title);
  assert.equal(out.alt, doc.alt);
  // Lifted shared arrays keep one identity through the cycle.
  assert.equal(out.keyframes[0].objects[0].angles, out.keyframes[0].objects[1].angles);
});

test('v2 integer arrays pick exact-width encodings', async () => {
  const doc = {a: Array(40).fill(200), b: Array(40).fill(70000),
    c: Array(40).fill(-7), d: Array(40).fill(5e9), e: Array(40).fill(1.5)};
  const {skeleton, sections} = liftDocument(doc);
  assert.match(skeleton.a, /^S2B:u8:/);
  assert.match(skeleton.b, /^S2B:u32:/);
  assert.match(skeleton.c, /^S2B:i32:/);
  assert.match(skeleton.d, /^S2B:f64:/);  // 5e9 exceeds u32 but stays exact
  assert.match(skeleton.e, /^S2B:f32:/);  // 1.5 round-trips through f32
  const out = await decodeDocument(await buildContainerV2(doc, 'styk'), 'styk');
  assert.deepEqual(out.document.d, doc.d);
  assert.deepEqual(out.document.e, doc.e);
});

test('v2 keeps non-liftable values inline', async () => {
  const doc = {mixed: [1, 'two', 3].concat(Array(40).fill(0)).slice(0, 43),
    small: [1, 2, 3], nested: {list: [[1.5, 2.5], [3.5]]},
    bools: Array(40).fill(true), objects: Array(40).fill({x: 1}),
    // Integers at/above 2^53 are not all f64-exact; they must stay inline.
    huge: Array(40).fill(2 ** 53 + 1), proto: JSON.parse('{"__proto__":{"x":7}}')};
  const {skeleton} = liftDocument(doc);
  assert.ok(Array.isArray(skeleton.huge));
  const out = await decodeDocument(await buildContainerV2(doc, 'styk'), 'styk');
  assert.deepEqual(out.document, doc);
  assert.equal(Object.hasOwn(out.document.proto, '__proto__'), true);
});

test('v2 rejects non-finite values embedded in binary sections', async () => {
  const {encodeContainerV2} = await import('../src/native-container.mjs');
  const bytes = new Uint8Array(new Float64Array([NaN, NaN, NaN, NaN]).buffer);
  const crafted = await encodeContainerV2({skeleton: {a: 'S2B:f64:0:0:4'},
    sections: [{kind: 1, bytes}, {kind: 2, bytes: new Uint8Array()}]}, 'styk');
  await assert.rejects(() => decodeDocument(crafted, 'styk'), /non-finite/);
});

test('v1 and legacy JSON stay readable', async () => {
  const doc = {version: 5, keyframes: [{objects: []}], marker: 'S2B:0:0:0:5'};
  const v1 = await buildContainerV1(JSON.stringify(doc), 'styk');
  const out = await decodeDocument(v1, 'styk');
  assert.equal(out.version, 1);
  assert.equal(out.document.marker, 'S2B:0:0:0:5'); // v1 never scans markers
  const legacy = new TextEncoder().encode('  {"version":5,"keyframes":[]}');
  const legacyOut = await decodeDocument(legacy, 'styk');
  assert.equal(legacyOut.document.version, 5);
});

test('v2 rejects corruption, truncation, and wrong kind', async () => {
  const doc = {version: 5, keyframes: [{objects: [{angles: floats()}]}]};
  const container = await buildContainerV2(doc, 'styk');
  for (const mutate of [
    c => { const b = c.slice(); b[b.length - 3] ^= 0xff; return b; },   // payload bit
    c => { const b = c.slice(); b[30] ^= 0xff; return b; },             // skeleton digest
    c => c.subarray(0, c.length - 2),                                   // truncation
    c => new Uint8Array([...c, 0, 0]),                                  // trailing data
    c => { const b = c.slice(); b[4] = 9; return b; },                  // future version
  ]) await assert.rejects(() => decodeDocument(mutate(container), 'styk'));
  await assert.rejects(() => decodeDocument(container, 'stkz'));
  // A crafted marker pointing outside a section is rejected.
  const bad = {a: 'S2B:f64:0:0:999999'};
  const forged = await buildContainerV2({wrap: bad}, 'styk');
  const {skeleton, sections} = liftDocument(bad);
  skeleton.a = 'S2B:f64:0:8:64'; // beyond the empty arrays section
  const {encodeContainerV2} = await import('../src/native-container.mjs');
  const crafted = await encodeContainerV2({skeleton, sections}, 'styk');
  await assert.rejects(() => decodeDocument(crafted, 'styk'), /section reference|damaged/);
});

test('normalizeDecodedDocument unwraps and validates like the service', async () => {
  const inner = {version: 5, keyframes: [], editable_paths: {}, _codec: {}, _stykWeb: {}};
  const unwrapped = normalizeDecodedDocument({format: 'stykanimate', version: 1, document: inner}, 'styk');
  assert.deepEqual(unwrapped, {version: 5, keyframes: []});
  assert.throws(() => normalizeDecodedDocument({format: 'stykanimate', version: 2, document: {}}, 'styk'), /project version/);
  assert.throws(() => normalizeDecodedDocument([1, 2], 'styk'), /JSON object/);
  const figure = {figure_types: [{figure_type_id: 1}],
    keyframes: [{objects: [{figure_type_id: 1, join: {target_object_slot: 0}}]}]};
  assert.ok(normalizeDecodedDocument(figure, 'stkz').figure_types.length === 1);
  assert.throws(() => normalizeDecodedDocument({figure_types: [], keyframes: []}, 'stkz'), /reusable figures/);
  assert.throws(() => normalizeDecodedDocument({...figure, keyframes: [{objects: [{figure_type_id: 9}]}]}, 'stkz'), /self-contained/);
  assert.throws(() => normalizeDecodedDocument(figure, 'stykmov'), /one movieclip/);
});
