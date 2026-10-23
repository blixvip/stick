import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySink, openExportSink } from '../src/export-sink.mjs';

test('memory sink assembles identical bytes and reports blob + size', async () => {
  const sink = new MemorySink('video/webm');
  assert.equal(sink.streamed, false);
  await sink.write(new Uint8Array([1, 2, 3]));
  await sink.write(new Blob([new Uint8Array([4, 5])]));
  const result = await sink.finish();
  assert.equal(result.size, 5);
  assert.equal(result.blob.type, 'video/webm');
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [1, 2, 3, 4, 5]);
});

test('memory sink patch rewrites bytes inside a single stored part', async () => {
  const sink = new MemorySink('video/webm');
  const header = new Uint8Array([10, 11]);
  const reserved = new Uint8Array(8);
  await sink.write(header);
  await sink.write(reserved);
  await sink.write(new Uint8Array([12]));
  await sink.patch(2, new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]));
  const result = await sink.finish();
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())],
    [10, 11, 7, 7, 7, 7, 7, 7, 7, 7, 12]);
  await assert.rejects(() => sink.write(new Uint8Array([1])), /closed/);
});

test('memory sink rejects patches spanning parts and aborts cleanly', async () => {
  const sink = new MemorySink('application/zip');
  await sink.write(new Uint8Array([1, 2]));
  await sink.write(new Uint8Array([3, 4]));
  await assert.rejects(() => sink.patch(1, new Uint8Array([9, 9, 9])), /patched in memory|cannot/);
  await sink.abort();
  await assert.rejects(() => sink.write(new Uint8Array([1])), /closed/);
  await assert.rejects(() => sink.finish(), /cancelled/);
});

test('desktop sink splits writes at the negotiated chunk size and forwards patches', async t => {
  const calls = [];
  const desktop = {
    streamingFileWrite: true,
    beginFileWrite: async options => { calls.push(['begin', options]); return { token: 'tok', size: null, maxChunkBytes: 4 }; },
    writeFileChunk: async (token, bytes) => { calls.push(['chunk', [...bytes]]); return { written: 0 }; },
    patchFileWrite: async (token, offset, bytes) => { calls.push(['patch', offset, [...bytes]]); return {}; },
    finishFileWrite: async token => { calls.push(['finish']); return { saved: true, path: '/out/animation.webm', size: 9 }; },
    cancelFileWrite: async token => { calls.push(['cancel']); return { cancelled: true }; },
  };
  const sink = await openExportSink({ filename: 'animation.webm', mimeType: 'video/webm', desktop });
  assert.equal(sink.streamed, true);
  assert.equal(calls[0][1].stream, true);
  await sink.write(new Uint8Array([1, 2, 3, 4, 5, 6]));
  await sink.write(new Blob([new Uint8Array([7, 8, 9])]));
  await sink.patch(4, new Uint8Array([0, 0]));
  const result = await sink.finish();
  assert.deepEqual(result, { saved: true, path: '/out/animation.webm', size: 9 });
  assert.deepEqual(calls.slice(1).map(call => call[0]), ['chunk', 'chunk', 'chunk', 'patch', 'finish']);
  assert.deepEqual(calls.filter(call => call[0] === 'chunk').map(call => call[1]),
    [[1, 2, 3, 4], [5, 6], [7, 8, 9]]);
  assert.deepEqual(calls.find(call => call[0] === 'patch').slice(1), [4, [0, 0]]);
});

test('desktop sink abort cancels the transfer and cancelled pickers return null', async () => {
  const calls = [];
  const desktop = {
    streamingFileWrite: true,
    beginFileWrite: async () => ({ token: 'tok', size: null, maxChunkBytes: 4 }),
    writeFileChunk: async () => ({}),
    cancelFileWrite: async token => { calls.push(token); return { cancelled: true }; },
  };
  const sink = await openExportSink({ filename: 'a.zip', desktop });
  await sink.write(new Uint8Array([1]));
  await sink.abort();
  await sink.abort();
  assert.deepEqual(calls, ['tok']);
  const cancelledDesktop = { ...desktop, beginFileWrite: async () => null };
  assert.equal(await openExportSink({ filename: 'a.zip', desktop: cancelledDesktop }), null);
});

test('file system sink writes through the writable and patches by seeking', async t => {
  const operations = [];
  const writable = {
    async write(value) { operations.push(value); },
    async close() { operations.push('close'); },
    async abort() { operations.push('abort'); },
  };
  const handle = { name: 'out.webm', createWritable: async () => writable };
  const picker = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
  globalThis.showSaveFilePicker = async () => handle;
  t.after(() => { if (picker) Object.defineProperty(globalThis, 'showSaveFilePicker', picker); else delete globalThis.showSaveFilePicker; });
  const sink = await openExportSink({ filename: 'out.webm', mimeType: 'video/webm', desktop: undefined });
  assert.equal(sink.streamed, true);
  await sink.write(new Uint8Array([1, 2]));
  await sink.patch(0, new Uint8Array([9]));
  const result = await sink.finish();
  assert.deepEqual(result, { saved: true, path: 'out.webm', size: 2 });
  assert.deepEqual(operations[0], new Uint8Array([1, 2]));
  assert.deepEqual(operations[1], { type: 'write', position: 0, data: new Uint8Array([9]) });
  assert.deepEqual(operations[2], { type: 'seek', position: 2 });
  assert.equal(operations[3], 'close');
});

test('picker cancellation returns null and unsupported environments fall back to memory', async t => {
  const picker = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
  globalThis.showSaveFilePicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
  assert.equal(await openExportSink({ filename: 'a.gif', desktop: undefined }), null);
  delete globalThis.showSaveFilePicker;
  const sink = await openExportSink({ filename: 'a.gif', mimeType: 'image/gif', desktop: undefined });
  assert.equal(sink.streamed, false);
  t.after(() => { if (picker) Object.defineProperty(globalThis, 'showSaveFilePicker', picker); });
});

test('a save without user activation can explicitly use the download fallback', async t => {
  const picker = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
  globalThis.showSaveFilePicker = () => { throw new Error('A background save must not open a picker.'); };
  t.after(() => { if (picker) Object.defineProperty(globalThis, 'showSaveFilePicker', picker); else delete globalThis.showSaveFilePicker; });
  const sink = await openExportSink({filename:'project.styk',desktop:null,fileSystem:false});
  assert.equal(sink.streamed,false);
  await sink.abort();
});
