import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadShapeLayoutSteps, SHAPE_UPLOAD_RECORDS} from '../src/renderer-upload.mjs';
import {SHAPE, SHAPE_FLOATS, SHAPE_BYTES} from '../src/renderer-geometry.mjs';

function verify(capacities, stagingRecords) {
  let offset = 0;
  const entries = capacities.map(([count, capacity], index) => {
    const data = Float32Array.from({length: count * SHAPE_FLOATS}, (_, i) => (i + index * 100) / 3);
    const result = {offset, data, count, capacity}; offset += capacity; return result;
  });
  const expected = new Float32Array(offset * SHAPE_FLOATS);
  for (const entry of entries) {
    expected.set(entry.data, entry.offset * SHAPE_FLOATS);
    for (let i = entry.count; i < entry.capacity; i++) expected[(entry.offset + i) * SHAPE_FLOATS + 20] = SHAPE.DISABLED;
  }
  const actual = new Float32Array(expected.length), uploads = [];
  const queue = {writeBuffer(buffer, byteOffset, data, start, byteLength) {
    assert.equal(buffer, actual);
    const copy = new Float32Array(data, start, byteLength / 4).slice();
    actual.set(copy, byteOffset / 4); uploads.push({byteOffset, byteLength});
  }};
  // Nonzero view offset and stale data verify padding is explicitly initialized.
  const backing = new Float32Array(stagingRecords * SHAPE_FLOATS + 8).fill(999);
  const staging = backing.subarray(4, backing.length - 4);
  const steps = uploadShapeLayoutSteps(queue, actual, entries, staging);
  let step = steps.next(), previousBytes = 0;
  while (!step.done) {
    assert.ok(step.value.bytes > previousBytes, 'each yield follows an uploaded batch');
    assert.equal(step.value.calls, uploads.length);
    previousBytes = step.value.bytes;
    step = steps.next();
  }
  const stats = step.value;
  assert.deepEqual(actual, expected);
  assert.equal(stats.bytes, expected.byteLength);
  assert.equal(stats.calls, Math.ceil(offset / stagingRecords));
  assert.ok(uploads.every(upload => upload.byteLength <= stagingRecords * SHAPE_BYTES));
  assert.deepEqual(backing.subarray(0, 4), new Float32Array(4).fill(999));
  assert.deepEqual(backing.subarray(backing.length - 4), new Float32Array(4).fill(999));
  return stats;
}

test('batched layout bytes match individual uploads across live data and disabled capacity boundaries', () => {
  for (const stagingRecords of [1, 2, 3, 7, 17]) verify([[3, 4], [0, 1], [7, 8], [1, 2], [19, 32]], stagingRecords);
});
test('large layouts have bounded staging and submission count independent of object count', () => {
  const stats = verify(Array.from({length: 1000}, (_, i) => [i % 15 + 1, 16]), SHAPE_UPLOAD_RECORDS);
  assert.equal(stats.calls, 2, '1,000 objects require two bounded uploads instead of 1,000.');
  assert.ok(SHAPE_UPLOAD_RECORDS * SHAPE_BYTES < 1024 * 1024);
});
test('skipped entries keep their existing buffer bytes while the rest upload exactly', () => {
  let offset = 0;
  const entries = [[3, 4], [5, 8], [1, 1], [2, 2], [6, 8]].map(([count, capacity], index) => {
    const entry = {key: index, offset, count, capacity, data: Float32Array.from({length: count * SHAPE_FLOATS}, (_, i) => i + index * 1000)};
    offset += capacity; return entry;
  });
  const actual = new Float32Array(offset * SHAPE_FLOATS).fill(-7), queue = {writeBuffer(buffer, byteOffset, data, start, byteLength) {
    actual.set(new Float32Array(data, start, byteLength / 4), byteOffset / 4);
  }};
  const skipped = new Set([1, 3]), steps = uploadShapeLayoutSteps(queue, actual, entries, new Float32Array(3 * SHAPE_FLOATS), entry => skipped.has(entry.key));
  let step; do step = steps.next(); while (!step.done);
  for (const entry of entries) {
    const range = actual.subarray(entry.offset * SHAPE_FLOATS, (entry.offset + entry.capacity) * SHAPE_FLOATS);
    if (skipped.has(entry.key)) { assert.ok(range.every(value => value === -7), `entry ${entry.key} was written`); continue; }
    const expected = new Float32Array(entry.capacity * SHAPE_FLOATS); expected.set(entry.data);
    for (let i = entry.count; i < entry.capacity; i++) expected[i * SHAPE_FLOATS + 20] = SHAPE.DISABLED;
    assert.deepEqual(range, expected);
  }
  assert.equal(step.value.bytes, (4 + 1 + 8) * SHAPE_BYTES);
});
test('empty layouts upload nothing and invalid noncontiguous layouts are rejected', () => {
  assert.deepEqual(uploadShapeLayoutSteps({}, {}, [], new Float32Array(SHAPE_FLOATS)).next().value, {bytes: 0, calls: 0});
  assert.throws(() => uploadShapeLayoutSteps({}, {}, [], new Float32Array(0)).next(), /at least one record/);
  assert.throws(() => uploadShapeLayoutSteps({}, {}, [{offset: 1, count: 0, capacity: 1, data: new Float32Array(0)}], new Float32Array(SHAPE_FLOATS)).next(), /contiguous/);
});
