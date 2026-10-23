import test from 'node:test';
import assert from 'node:assert/strict';
import {sameData, sameRecord} from '../src/structural-equality.mjs';

// The recursive Object.keys/every comparison the retained playback caches used.
function reference(a, b, skip) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => reference(value, b[index]));
  const keys = Object.keys(a).filter(key => !skip?.(key, a)), other = Object.keys(b).filter(key => !skip?.(key, b));
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) && reference(a[key], b[key]));
}

test('structural equality matches the recursive comparison it replaces', () => {
  const sparse = [1, , 3], filled = [1, 9, 3], typed = new Float32Array([1, 2]);
  const values = [0, -0, NaN, 1, '1', null, undefined, true, [], [1, 2], [1, 2, 3], sparse, filled, [1, undefined, 3], [[1], {a: 1}],
    {}, {a: 1}, {a: 1, b: undefined}, {b: undefined, a: 1}, {a: [0, -0]}, {a: [0, 0]}, {a: {b: [NaN]}}, typed, new Float32Array([1, 2]), new Map([[1, 2]]), new Map()];
  for (const a of values) for (const b of values) assert.equal(sameData(a, b), reference(a, b), `${String(a)} vs ${String(b)}`);
  // Holes in the first array are skipped, as Array.prototype.every does.
  assert.equal(sameData(sparse, filled), true);
  assert.equal(sameData(filled, sparse), false);
});

test('skipped top-level keys are ignored on both sides but nested values compare fully', () => {
  const skip = key => key === 'record_offset' || key === 'field28';
  const cases = [
    [{angles: [1, 2], record_offset: 1}, {angles: [1, 2], record_offset: 2}],
    [{angles: [1, 2], record_offset: 1}, {angles: [1, 2]}],
    [{angles: [1, 2]}, {angles: [1, 2], field28: 4}],
    [{angles: [1, 2], nested: {record_offset: 1}}, {angles: [1, 2], nested: {record_offset: 2}}],
    [{angles: [1, 2], extra: 1}, {angles: [1, 2]}],
    [{angles: [1, 2]}, {angles: [1, 3]}],
  ];
  for (const [a, b] of cases) {
    assert.equal(sameRecord(a, b, skip), reference(a, b, skip));
    assert.equal(sameRecord(b, a, skip), reference(b, a, skip));
  }
});
