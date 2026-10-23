import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryPreviewMatte, libraryPreviewTimeline} from '../src/library-preview-core.mjs';
import {canMoveLibraryItem} from '../src/library-drag.mjs';
import {librarySnapshot, readLibraryFile} from '../src/library-files.mjs';
import {Editor} from '../src/editor.mjs';

test('automatic matte reveals white, black and mixed artwork, ignoring transparent pixels', () => {
  assert.equal(libraryPreviewMatte([255,255,255,255]), 'dark');
  assert.equal(libraryPreviewMatte([0,0,0,255]), 'light');
  assert.equal(libraryPreviewMatte([255,255,255,255, 0,0,0,255]), 'neutral');
  assert.equal(libraryPreviewMatte([255,255,255,255, 0,0,0,0, 0,0,0,0]), 'dark');
  assert.equal(libraryPreviewMatte([0,0,0,0]), 'neutral');
});

test('library previews evaluate full movieclip timing beyond their one-frame file wrapper and loop', () => {
  const editor = new Editor(); editor.select(1); editor.createMovieclip({start:0, end:24});
  const report = librarySnapshot(editor), before = JSON.stringify(report), preview = libraryPreviewTimeline(report);
  const points = tick => preview.geometry(tick).drawables.map(item => item.points);
  assert.equal(report.keyframes.length, 1); assert.equal(preview.duration, 24); assert.equal(preview.fps, 24);
  assert.notDeepEqual(points(0), points(9)); assert.deepEqual(points(0), points(24));
  const expected = points(9);
  report.fps = 48; const faster = libraryPreviewTimeline(report);
  assert.equal(faster.duration, 48); assert.deepEqual(faster.geometry(18).drawables.map(item => item.points), expected);
  report.fps = 24; assert.equal(JSON.stringify(report), before);
});

test('folder targets exclude the same location and descendants without blocking similarly named folders', () => {
  const folder = {path:'People', kind:'folder'};
  for (const path of ['', 'People', 'People/Heroes']) assert.equal(canMoveLibraryItem(folder, path), false);
  assert.equal(canMoveLibraryItem(folder, 'People 2'), true);
  assert.equal(canMoveLibraryItem({path:'People/Hero.stkz', kind:'figure'}, ''), true);
  assert.equal(canMoveLibraryItem({path:'People/Hero.stkz', kind:'figure'}, 'People'), false);
});

test('leaving a hover during native file reading releases the transfer and stops requesting chunks', async () => {
  const controller = new AbortController(); let reads = 0, cancelled;
  const desktop = {
    beginLibraryRead: async () => ({token:'test-transfer', name:'clip.stykmov', size:16}),
    readLibraryChunk: async () => { reads++; controller.abort(); return {bytes: new Uint8Array(8), done:false}; },
    cancelLibraryTransfer: async token => { cancelled = token; },
  };
  await assert.rejects(readLibraryFile(desktop, 'clip.stykmov', {signal:controller.signal}), {name:'AbortError'});
  assert.equal(reads, 1); assert.equal(cancelled, 'test-transfer');
});
