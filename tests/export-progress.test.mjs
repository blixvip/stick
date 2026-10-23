import test from 'node:test';
import assert from 'node:assert/strict';
import {ExportProgress, exportTime} from '../src/export-progress.mjs';

test('progress distinguishes rendering from completion and reserves finalization and saving', () => {
  let time = 0;
  const progress = new ExportProgress({frames: 4, start: 10, now: () => time});
  assert.equal(progress.snapshot().phase, 'preparing');
  progress.frameStarted(10);
  assert.equal(progress.snapshot().sourceFrame, 11);
  assert.equal(progress.snapshot().rendered, 0);
  progress.frameRendered();
  assert.equal(progress.snapshot().rendered, 1);
  assert.equal(progress.snapshot().remaining, 3);
  assert.equal(progress.snapshot().percent, 0);
  progress.update({completed: 1}); time = 10000;
  const percent = progress.snapshot().percent; time = 60000;
  assert.equal(progress.snapshot().percent, percent, 'Time must not manufacture completed frames');
  progress.update({completed: 4});
  assert.equal(progress.snapshot().percent, 95);
  assert.equal(progress.snapshot().phase, 'encoding');
  progress.update({phase: 'saving'});
  assert.equal(progress.snapshot().percent, 98);
  assert.equal(progress.snapshot().eta, null);
});

test('GIF passes show real output frame counts instead of twice the animation length', () => {
  const progress = new ExportProgress({frames: 3, passes: 2, start: 6, now: () => 0});
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 3; i++) {
      progress.frameStarted(6 + i);
      let state = progress.snapshot();
      assert.equal(state.pass, pass + 1); assert.equal(state.frame, i + 1); assert.equal(state.sourceFrame, 7 + i);
      assert.equal(state.rendered, i); assert.equal(state.remaining, 3 - i);
      progress.frameRendered(); progress.update({completed: pass * 3 + i + 1, phase: pass ? 'encode' : 'palette'});
      state = progress.snapshot(); assert.equal(state.rendered, i + 1); assert.equal(state.remaining, 2 - i);
      assert.equal(state.frames, 3);
    }
  }
  assert.equal(progress.snapshot().percent, 95);
  assert.equal(progress.snapshot().phase, 'encoding');
});

test('duration formatting handles unavailable estimates and long exports', () => {
  assert.equal(exportTime(null), '—'); assert.equal(exportTime(8), '8s');
  assert.equal(exportTime(90), '1m 30s'); assert.equal(exportTime(3660), '1h 1m');
});
