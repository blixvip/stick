import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {falloffWeight, planFalloff, normalizeFalloff} from '../src/motion-path-falloff.mjs';

const clone = value => structuredClone(value);
const near = (a, b, tolerance = 1e-3) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const root = {kind: 'node', uid: 1, handleId: 0, joint: -1};
const FALLOFF = {radius: 15, shape: 'smooth'};

/** Five stored poses every 10 frames walking right along y = 200. */
function report() {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [0, 1, 2, 3, 4].map(k => createFrame([createObject(figure, 1, 100 + k * 100, 200)], 10));
  return document;
}
const modes = {
  native: () => new Editor({demo: false}).load(report()),
  channels: () => { const editor = new Editor({demo: false}).load(report()); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); return editor; },
  sheet: () => new Editor({demo: false, propertyChannels: true, layerTimeline: true}).load(report()),
};
function rootAt(source, tick) {
  const rows = timeline(source), index = rows.findLastIndex(row => row.start <= tick), row = rows[index];
  const frame = evaluatedFrame(source, index, row.count ? (tick - row.start) / row.count : 0, tick);
  const object = frame.objects.find(o => o.unique_id === 1);
  return {x: object.root_x, y: object.root_y};
}
const at = (editor, tick) => rootAt(editor.report, tick);

test('falloff weights are 1 at the grab, positive inside the radius and 0 beyond it', () => {
  for (const shape of ['smooth', 'linear', 'sharp', 'flat']) {
    assert.equal(falloffWeight(0, 8, shape), 1);
    for (let d = 1; d <= 8; d++) assert.ok(falloffWeight(d, 8, shape) > 0 && falloffWeight(d, 8, shape) <= 1, `${shape} ${d}`);
    assert.equal(falloffWeight(9, 8, shape), 0);
    assert.equal(falloffWeight(-9, 8, shape), 0);
  }
  assert.ok(falloffWeight(2, 8, 'sharp') < falloffWeight(2, 8, 'linear'));
  assert.ok(falloffWeight(2, 8, 'linear') < falloffWeight(2, 8, 'smooth'));
  assert.equal(normalizeFalloff({radius: 0}), null);
  assert.deepEqual(normalizeFalloff({radius: 9.4, shape: 'nope'}), {radius: 9, shape: 'smooth'});
  assert.equal(normalizeFalloff({radius: 5000}).radius, 240);
});

test('the plan moves keys inside the influence and holds long tweens with edge keys', () => {
  const plan = planFalloff({tick: 20, radius: 15, keys: [0, 10, 20, 30, 40], totalTicks: 41});
  assert.deepEqual(plan.map(w => [w.tick, w.kind]), [[4, 'edge'], [10, 'key'], [20, 'grab'], [30, 'key'], [36, 'edge']]);
  near(plan[1].weight, falloffWeight(10, 15));
  // A key exactly at the edge, or no key beyond it, needs no edge key.
  assert.deepEqual(planFalloff({tick: 20, radius: 9, keys: [0, 10, 20, 30, 40], totalTicks: 41}).map(w => w.kind), ['grab']);
  assert.deepEqual(planFalloff({tick: 20, radius: 15, keys: [20], totalTicks: 41}).map(w => w.kind), ['grab']);
  // A neighbour whose weight is negligible does not justify an edge key.
  assert.deepEqual(planFalloff({tick: 20, radius: 10, keys: [0, 10, 20, 30, 40], totalTicks: 41}).map(w => w.kind), ['key', 'grab', 'key']);
  // An in-between grab in a long tween holds both sides.
  assert.deepEqual(planFalloff({tick: 15, radius: 4, keys: [0, 40], totalTicks: 41}).map(w => [w.tick, w.kind]), [[10, 'edge'], [15, 'grab'], [20, 'edge']]);
});

for (const [mode, make] of Object.entries(modes)) {
  test(`${mode}: a falloff drag reshapes the arc in one undo step and leaves the rest alone`, () => {
    const editor = make();
    editor.seek(0); editor.select(1);
    const before = Object.fromEntries([0, 2, 4, 10, 20, 30, 36, 40].map(t => [t, at(editor, t)]));
    const history = editor._undo.length, stored = clone(editor.report.keyframes);
    assert.ok(editor.beginMotionPathEdit(root, 20, {falloff: FALLOFF}));
    assert.equal(editor._drag.falloff.radius, 15);
    for (let i = 1; i <= 5; i++) editor.updateMotionPathEdit({x: before[20].x, y: 200 - i * 20});
    // Live: the virtual report is reshaped while the document is untouched.
    near(rootAt(editor.motionPathReport(), 20).y, 100);
    near(rootAt(editor.motionPathReport(), 10).y, 200 - 100 * falloffWeight(10, 15));
    if (mode === 'native') assert.deepEqual(editor.report.keyframes, stored);
    const plan = editor.motionPathFalloff();
    assert.deepEqual(plan.writes.map(w => w.tick), [4, 10, 20, 30, 36]);
    assert.deepEqual([...plan.changed].sort((a, b) => a - b), [4, 10, 20, 30, 36]);
    assert.equal(editor.commitMotionPathEdit(), true);
    assert.equal(editor._undo.length, history + 1, 'one undo step');
    assert.equal(editor.tick, 0, 'the playhead stays');
    near(at(editor, 20).y, 100);
    near(at(editor, 20).x, before[20].x);
    near(at(editor, 10).y, 200 - 100 * falloffWeight(10, 15));
    near(at(editor, 30).y, 200 - 100 * falloffWeight(10, 15));
    for (const tick of [0, 2, 4, 36, 40]) { near(at(editor, tick).y, 200); near(at(editor, tick).x, before[tick].x); }
    assert.doesNotThrow(() => editor.serialize());
    editor.undo();
    for (const tick of [4, 10, 20, 30, 36]) { near(at(editor, tick).y, before[tick].y); near(at(editor, tick).x, before[tick].x); }
    if (mode === 'native') assert.deepEqual(editor.report.keyframes, stored);
    editor.redo();
    near(at(editor, 20).y, 100);
  });

  test(`${mode}: an in-between grab lands exactly under the pointer`, () => {
    const editor = make();
    editor.seek(0); editor.select(1);
    const start = at(editor, 15);
    assert.ok(editor.beginMotionPathEdit(root, 15, {falloff: {radius: 6, shape: 'linear'}}));
    editor.updateMotionPathEdit({x: start.x + 12, y: 120});
    assert.equal(editor.commitMotionPathEdit(), true);
    near(at(editor, 15).x, start.x + 12);
    near(at(editor, 15).y, 120);
    near(at(editor, 10).y, 200 - 80 * falloffWeight(5, 6, 'linear'));
    near(at(editor, 30).y, 200);
  });

  test(`${mode}: motionless and cancelled falloff drags change nothing`, () => {
    const editor = make();
    editor.select(1);
    const history = editor._undo.length, serialized = JSON.stringify(editor.serialize?.() ?? null);
    assert.ok(editor.beginMotionPathEdit(root, 20, {falloff: FALLOFF}));
    assert.equal(editor.commitMotionPathEdit(), false);
    assert.ok(editor.beginMotionPathEdit(root, 20, {falloff: FALLOFF}));
    editor.updateMotionPathEdit({x: 300, y: 90});
    assert.equal(editor.cancelMotionPathEdit(), true);
    assert.equal(editor._undo.length, history);
    assert.equal(JSON.stringify(editor.serialize?.() ?? null), serialized);
  });
}

test('holding and releasing falloff mid-drag switches the same gesture', () => {
  const editor = modes.native();
  editor.select(1);
  const history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(root, 20));
  editor.updateMotionPathEdit({x: 300, y: 150});
  assert.ok(editor.setMotionPathFalloff(FALLOFF));
  assert.ok(editor._drag.falloff);
  near(rootAt(editor.motionPathReport(), 20).y, 150);
  near(rootAt(editor.motionPathReport(), 10).y, 200 - 50 * falloffWeight(10, 15));
  assert.ok(editor.setMotionPathFalloff({radius: 25, shape: 'smooth'}));
  near(rootAt(editor.motionPathReport(), 10).y, 200 - 50 * falloffWeight(10, 25));
  assert.ok(editor.setMotionPathFalloff(null));
  assert.equal(editor._drag.falloff, undefined);
  editor.updateMotionPathEdit({x: 300, y: 140});
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor._undo.length, history + 1);
  near(at(editor, 20).y, 140);
  near(at(editor, 10).y, 200);
  assert.equal(editor.report.keyframes.length, 5);
});

test('a camera trail reshapes with falloff too', () => {
  const editor = modes.native();
  const camera = {kind: 'camera'}, centre = {x: editor.report.canvas_width / 2, y: editor.report.canvas_height / 2};
  assert.ok(editor.beginMotionPathEdit(camera, 20, {falloff: FALLOFF}));
  editor.updateMotionPathEdit({x: centre.x + 60, y: centre.y});
  assert.equal(editor.commitMotionPathEdit(), true);
  const cameraAt = tick => { const rows = editor.timeline, i = rows.findLastIndex(r => r.start <= tick); return evaluatedFrame(editor.report, i, rows[i].count ? (tick - rows[i].start) / rows[i].count : 0, tick).camera; };
  near(Number(cameraAt(20).x), 60);
  near(Number(cameraAt(10).x), 60 * falloffWeight(10, 15));
  near(Number(cameraAt(36).x ?? 0), 0);
  // Figures keep their poses.
  near(at(editor, 10).y, 200);
});

test('joint trails rotate neighbouring keys partially toward the moved arc', () => {
  const editor = modes.native(), figure = editor.report.figure_types[0];
  const joint = figure.segments.findIndex(s => !s.is_static && s.parent_id !== 0 && !figure.segments.some(c => c.parent_id === s.segment_id));
  const target = {kind: 'node', uid: 1, handleId: Number(figure.segments[joint].segment_id), joint};
  const angle = tick => { const rows = editor.timeline, i = rows.findLastIndex(r => r.start <= tick); return evaluatedFrame(editor.report, i, 0, tick).objects[0].angles[joint]; };
  const before = [10, 20, 30].map(angle);
  assert.ok(editor.beginMotionPathEdit(target, 20, {falloff: FALLOFF}));
  const origin = editor._drag.grab.origin;
  editor.updateMotionPathEdit({x: origin.x + 25, y: origin.y - 25});
  assert.equal(editor.commitMotionPathEdit(), true);
  const after = [10, 20, 30].map(angle), turn = i => Math.abs(Math.atan2(Math.sin(after[i] - before[i]), Math.cos(after[i] - before[i])));
  assert.ok(turn(1) > 0.05, 'the grabbed key turns');
  assert.ok(turn(0) > 1e-4 && turn(0) < turn(1), 'the neighbour turns less');
  assert.ok(turn(2) > 1e-4 && turn(2) < turn(1));
});

test('sheet holds: writes resolve onto held keys without duplicates or edge keys', () => {
  const editor = modes.sheet();
  const track = () => editor.report._styk.layerSheet.tracks['layer-1'];
  for (const key of track().keys) key.interpolation = 'constant';
  editor._invalidate({timing: true});
  editor.seek(0); editor.select(1);
  const keyTicks = track().keys.map(k => k.tick), before = at(editor, 20);
  assert.ok(editor.beginMotionPathEdit(root, 15, {falloff: FALLOFF}));
  editor.updateMotionPathEdit({x: at(editor, 15).x, y: 120});
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.deepEqual(track().keys.map(k => k.tick), keyTicks, 'holds gain no keys');
  // The grab rewrites its hold; the next hold follows by its own weight.
  near(at(editor, 12).y, 120);
  near(at(editor, 20).y, 200 - 80 * falloffWeight(5, 15));
  near(at(editor, 20).x, before.x);
  near(at(editor, 0).y, 200 - 80 * falloffWeight(15, 15));
});

test('incremental pose captures equal fresh snapshots after the component moves', async () => {
  const {incrementalPoseSnapshot} = await import('../src/editor-motion-path.mjs');
  const {snapshotPoseFrame} = await import('../src/pose-snapshot.mjs');
  const document = emptyDocument(), figure = document.figure_types[0];
  const child = createObject(figure, 3, 0, 0);
  child.join = {target_object_slot: 1, target_handle_id: figure.segments[0].segment_id, target_unique_id: 2};
  const frame = createFrame([createObject(figure, 1, 10, 10), createObject(figure, 2, 50, 50), child, createObject(figure, 4, 90, 90)], 5);
  const capture = incrementalPoseSnapshot(new Set([2, 3]));
  assert.deepEqual(capture(frame, [2, 3, 4]), snapshotPoseFrame(frame, [2, 3, 4]));
  frame.objects[1].root_x = 70; frame.objects[1].angles[0] += 0.5; frame.objects[2].angles[1] -= 0.25;
  const next = capture(frame, [2, 3, 4]);
  assert.deepEqual(next, snapshotPoseFrame(frame, [2, 3, 4]));
  frame.objects[1].angles[0] += 0.5;
  assert.notEqual(capture(frame, [2, 3, 4]).objects[0], next.objects[0], 'changed records are fresh');
  assert.equal(capture(frame, [2, 3, 4]).objects[2], next.objects[2], 'unchanged records are reused');
});
