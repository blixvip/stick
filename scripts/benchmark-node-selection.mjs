/** Deterministic dense static rig: measure descriptor preparation and indexed
 * hit testing, with correctness checks and no document/history mutation. */
import {performance} from 'node:perf_hooks';
import {mkdir, writeFile} from 'node:fs/promises';
import {getPivotHandles, pickCanvasHandle} from '../src/canvas-interactions.mjs';
import assert from 'node:assert/strict';

const count = 30000, definitions = Array.from({length: count}, (_, index) => ({segment_id: index + 1, parent_id: 0, length: 20, thickness: 2}));
const g = {slot: 0, obj: {unique_id: 101, scale: 1}, fig: {segments: definitions}, root: {x: -100, y: -100},
  segments: definitions.map((seg, index) => ({seg, index, static: index % 30 !== 0, length: 20, end: {x: (index % 300) * 20, y: Math.floor(index / 300) * 20}}))};
const geometry = {objects: new Map([[0, g]]), orderedObjects: [g]};
const descriptorCache = {}, options = {selectStatic: true, descriptorCache};
let start = performance.now(); const visible = getPivotHandles(geometry); const visibleMs = performance.now() - start;
start = performance.now(); const handles = getPivotHandles(geometry, options); const coldMs = performance.now() - start;
start = performance.now(); const retained = getPivotHandles(geometry, options); const retainedMs = performance.now() - start;
assert.equal(retained[20001], handles[20001]); assert.equal(visible.length, 1001);
const samples = [], coldPickStart = performance.now();
pickCanvasHandle(geometry, g.segments[20000].end, {handles, spatial: true, minRadius: 8, nearest: true});
const indexMs = performance.now() - coldPickStart;
for (let i = 0; i < 1000; i++) {
  const index = (i * 31) % count, point = g.segments[index].end;
  start = performance.now(); const hit = pickCanvasHandle(geometry, point, {handles, spatial: true, minRadius: 8, nearest: true});
  samples.push(performance.now() - start);
  assert.equal(hit.id, index + 1); assert.equal(hit.action, index % 30 ? 'select' : 'pose');
}
samples.sort((a, b) => a - b);
const report = {node: process.version, segments: count, hiddenStatic: 29000, visibleMs, coldSelectionDescriptorsMs: coldMs,
  retainedDescriptorsMs: retainedMs, coldSpatialIndexMs: indexMs, warmPickMedianMs: samples[500], warmPickP95Ms: samples[950], picks: samples.length};
await mkdir('artifacts/join-selection', {recursive: true});
await writeFile('artifacts/join-selection/benchmark.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
