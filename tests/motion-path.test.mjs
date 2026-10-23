import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {MotionPathCache, motionPathTarget, motionPathTargets, motionPathTicks, sampleMotionPath, pathPoints, pickMotionPathPoint} from '../src/motion-path.mjs';

const clone = value => structuredClone(value);
const near = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (a, b, tolerance = 1e-4) => { near(a.x, b.x, tolerance); near(a.y, b.y, tolerance); };

/** Three stored keys, x=100 → 300 → 500. Rows: 0..9, 10..19, then the v5
 * end-key row at tick 20 (nativeTimeline clamps the last row to one tick). */
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200)], 10),
    createFrame([createObject(figure, 1, 300, 200)], 10),
    createFrame([createObject(figure, 1, 500, 200)], 10),
  ];
  return new Editor({demo: false}).load(report);
}

function ikFixture() {
  const document = emptyDocument(), figure = document.figure_types[0], base = figure.segments[0];
  figure.segments = [
    {...base, segment_id: 11, parent_id: 0, length: 90, angle_rad: .8, aux_code: 0, is_static: false},
    {...base, segment_id: 22, parent_id: 11, length: 90, angle_rad: 2, aux_code: 0, is_static: false},
    {...base, segment_id: 33, parent_id: 22, length: 35, angle_rad: 0, aux_code: 0, is_static: false},
  ];
  figure.segment_count = figure.segments.length;
  document.keyframes = [
    createFrame([createObject(figure, 1, 300, 150)], 8),
    createFrame([createObject(figure, 1, 340, 150)], 8),
    createFrame([createObject(figure, 1, 380, 150)], 8),
  ];
  return new Editor({demo: false}).load(document);
}

const rootTarget = {kind: 'node', uid: 1, handleId: 0, joint: -1};
test('origin path edits carry pins at remote keys and inbetweens in every timeline store', () => {
  for (const mode of ['native', 'channels', 'sheet']) for (const tick of [0, 4]) for (const falloff of [undefined, {radius: 6, shape: 'smooth'}]) {
    let editor = ikFixture(); editor.select(1, 1); editor.setNodeIK({enabled: true}); editor.poseJoint(420, 190);
    const report = editor.serialize();
    // Keep the same posed limb across all keys, changing only its placement.
    for (let i = 1; i < report.keyframes.length; i++) {
      const object = clone(report.keyframes[0].objects[0]); object.root_x += i * 40;
      object._stykIK[22].target.x += i * 40; report.keyframes[i].objects[0] = object;
    }
    editor = new Editor({demo: false, layerTimeline: mode === 'sheet', propertyChannels: mode === 'channels'}).load(report);
    if (mode === 'channels') editor.addAnimationKeys([{target: {kind:'figure', uid:1}, property:'x', tick:0, value:300}, {target:{kind:'figure',uid:1},property:'x',tick:8,value:340}]);
    editor.seek(8); editor.select(1);
    const history = editor._undo.length, saved = clone(editor.report);
    assert.ok(editor.beginMotionPathEdit(rootTarget, tick, {falloff}));
    const session = editor._drag, sub = session.grab ?? session;
    const before = buildGeometry(editor.report, sub.working).objects.get(0);
    const goal = {x: before.root.x + 20, y: before.root.y - 12};
    for (const movePins of [true, false, true]) {
      editor.updateMotionPathEdit(goal, {movePins});
      const after = buildGeometry(editor.report, sub.working).objects.get(0);
      const foot = before.joints.get(22);
      point(after.joints.get(22), {x: foot.x + (movePins ? 20 : 0), y: foot.y - (movePins ? 12 : 0)});
      if (movePins) for (const [id, p] of before.joints) point(after.joints.get(id), {x:p.x+20,y:p.y-12});
      assert.equal(sub.working.objects[0]._stykIK[22].pinned, true);
    }
    assert.equal(editor.tick, 8); assert.deepEqual(editor.report, saved);
    assert.ok(editor.commitMotionPathEdit()); assert.equal(editor._undo.length, history + 1);
    editor.seek(tick); point(editor.geometry.objects.get(0).joints.get(22), {x:before.joints.get(22).x+20,y:before.joints.get(22).y-12});
    editor.undo(); editor.seek(tick); point(editor.geometry.objects.get(0).joints.get(22), before.joints.get(22));
    editor.redo(); editor.seek(tick); point(editor.geometry.objects.get(0).joints.get(22), {x:before.joints.get(22).x+20,y:before.joints.get(22).y-12});
    const committed = clone(editor.report);
    assert.ok(editor.beginMotionPathEdit(rootTarget, tick, {falloff}));
    editor.updateMotionPathEdit({x:goal.x+50,y:goal.y+30}, {movePins:true}); editor.cancelMotionPathEdit();
    assert.deepEqual(editor.report, committed);
    assert.equal(editor._undo.length, history + 1);
    assert.ok(editor.beginMotionPathEdit(rootTarget, tick, {falloff}));
    editor.updateMotionPathEdit({x:goal.x+50,y:goal.y+30}, {movePins:true});
    editor.updateMotionPathEdit(goal, {movePins:true});
    assert.equal(editor.commitMotionPathEdit(), false); assert.deepEqual(editor.report, committed);
  }
});
const rootAt = (editor, tick) => {
  const rows = editor.timeline;
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const frame = evaluatedFrame(editor.report, low, rows[low].count ? (tick - rows[low].start) / rows[low].count : 0, tick);
  return frame.objects.find(o => o.unique_id === 1);
};
// Infinity keeps test sampling synchronous: production budgets the work per
// frame, but assertions here must not depend on wall-clock timing.
const pathEntry = (editor, target, session) => new MotionPathCache({budgetMs: Infinity}).get(editor, target, {session});

test('path sampling returns one point per display tick with keyframe emphasis', () => {
  const editor = fixture();
  const plan = motionPathTicks(editor);
  assert.equal(plan.ticks[0], 0); assert.equal(plan.ticks.at(-1), 20);
  editor.select(null);
  assert.equal(motionPathTarget(editor), null);
  editor.select(1);
  const selected = motionPathTarget(editor);
  assert.deepEqual(selected, {kind: 'node', uid: 1, handleId: 0, joint: -1});
  const path = sampleMotionPath(editor.report, editor, selected);
  assert.equal(path.points.length, plan.ticks.length);
  near(path.points[0].x, 100); near(path.points.at(-1).x, 500);
  near(path.points[5].x, 200); near(path.points[10].x, 300);
  assert.ok(path.points[0].key && path.points[10].key);
  const hit = pickMotionPathPoint(pathEntry(editor, selected), {x: 200, y: 200}, {project: p => p, radius: 9});
  assert.equal(hit.tick, 5);
  assert.equal(pickMotionPathPoint(pathEntry(editor, selected), {x: -500, y: -500}, {project: p => p, radius: 9}), null);
});

test('camera target samples canvas-centred camera position', () => {
  const editor = fixture();
  const report = editor.report;
  report.keyframes[1].camera = {x: 50, y: -20, scale: 1, angle_rad: 0, is_default: false};
  editor._invalidate({timing: true});
  const path = sampleMotionPath(report, editor, {kind: 'camera'});
  near(path.points[0].x, report.canvas_width / 2);
  // The moved key's camera holds at its own tick and interpolates back to the
  // default end key.
  near(path.points.find(p => p.tick === 10).x, report.canvas_width / 2 + 50);
  near(path.points.find(p => p.tick === 10).y, report.canvas_height / 2 - 20);
  near(path.points.at(-1).x, report.canvas_width / 2);
});

test('a keyframe-boundary path edit writes that frame without splitting', () => {
  const editor = fixture();
  editor.seek(10); editor.select(1);
  const history = editor._undo.length, frames = editor.report.keyframes.length;
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  editor.updateMotionPathEdit({x: 250, y: 260});
  assert.equal(editor.tick, 10);
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.report.keyframes.length, frames);
  near(editor.report.keyframes[1].objects[0].root_x, 250);
  near(editor.report.keyframes[1].objects[0].root_y, 260);
  near(rootAt(editor, 15).root_x, 250 * 0.5 + 500 * 0.5);
  assert.equal(editor._undo.length, history + 1);
  editor.undo(); near(rootAt(editor, 15).root_x, 400);
  editor.redo(); near(rootAt(editor, 15).root_x, 375);
  assert.equal(editor.tick, 10);
});

test('a mid-span path edit splits the native frame and keeps the playhead put', () => {
  const editor = fixture();
  editor.seek(3); editor.select(1);
  const history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  const session = editor._drag;
  assert.equal(session.mode, 'split');
  for (let i = 0; i <= 5; i++) editor.updateMotionPathEdit({x: 240 + i, y: 260 - i * 2});
  assert.equal(editor._undo.length, history);
  // The playhead is outside the edit window: the displayed pose is unchanged.
  near(editor.evaluatedFrame.objects[0].root_x, 160);
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.tick, 3); assert.equal(editor.frameIndex, 0);
  assert.equal(editor.report.keyframes.length, 4);
  assert.equal(editor.report.keyframes[1].duration_raw, 5);
  assert.equal(editor.report.keyframes[2].duration_raw, 5);
  near(editor.report.keyframes[2].objects[0].root_x, 245);
  near(editor.report.keyframes[2].objects[0].root_y, 250);
  near(rootAt(editor, 15).root_x, 245);
  // Tick 12 interpolates from the original key pose toward the inserted pose.
  near(rootAt(editor, 12).root_x, 300 * 0.6 + 245 * 0.4);
  assert.equal(editor._undo.length, history + 1);
  editor.undo();
  assert.equal(editor.report.keyframes.length, 3); assert.equal(editor.tick, 3); assert.equal(editor.frameIndex, 0);
  near(rootAt(editor, 15).root_x, 400);
  editor.redo();
  assert.equal(editor.report.keyframes.length, 4);
  near(rootAt(editor, 15).root_x, 245);
});

test('an in-window path edit previews the moved pose at the playhead', () => {
  const editor = fixture();
  editor.seek(4); editor.select(1);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 4));
  editor.updateMotionPathEdit({x: 500, y: 400});
  const display = editor._drag.display;
  assert.ok(display?.frame);
  near(display.frame.objects[0].root_x, 500);
  near(display.frame.objects[0].root_y, 400);
  editor.cancelMotionPathEdit();
  near(editor.evaluatedFrame.objects[0].root_x, 180);
});

test('motionless and cancelled path gestures leave no history or document change', () => {
  const editor = fixture();
  editor.select(1);
  const before = clone(editor.report), history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  assert.equal(editor.commitMotionPathEdit(), false);
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  editor.updateMotionPathEdit({x: 222, y: 199});
  assert.ok(editor.cancelMotionPathEdit());
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history);
  // Dragging back to the original point commits nothing.
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  editor.updateMotionPathEdit({x: 350, y: 300});
  editor.updateMotionPathEdit({x: 300, y: 200});
  assert.equal(editor.commitMotionPathEdit(), false);
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history);
});

test('camera path points edit the native camera at the remote tick', () => {
  const editor = fixture();
  const history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit({kind: 'camera'}, 10));
  editor.updateMotionPathEdit({x: editor.report.canvas_width / 2 + 40, y: editor.report.canvas_height / 2 - 30});
  assert.equal(editor.commitMotionPathEdit(), true);
  near(editor.report.keyframes[1].camera.x, 40);
  near(editor.report.keyframes[1].camera.y, -30);
  assert.equal(editor._undo.length, history + 1);
  editor.undo();
  assert.ok(editor.report.keyframes[1].camera.is_default || editor.report.keyframes[1].camera.x === 0);
});

test('mid-span camera path edits split the frame and re-time the camera pose', () => {
  const editor = fixture();
  editor.seek(2);
  assert.ok(editor.beginMotionPathEdit({kind: 'camera'}, 15));
  editor.updateMotionPathEdit({x: editor.report.canvas_width / 2 + 24, y: editor.report.canvas_height / 2 + 8});
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.report.keyframes.length, 4);
  near(editor.report.keyframes[2].camera.x, 24);
  assert.equal(editor.tick, 2);
  editor.undo();
  assert.equal(editor.report.keyframes.length, 3);
});

test('pinned IK endpoints move through the solver on a remote tick', () => {
  const editor = ikFixture();
  editor.select(1, 1); editor.setNodeIK({enabled: true, pinned: true});
  editor.seek(0);
  const history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit({kind: 'node', uid: 1, handleId: 22, joint: 1}, 4));
  const goal = {x: 420, y: 190};
  editor.updateMotionPathEdit(goal);
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor._undo.length, history + 1);
  assert.equal(editor.tick, 0);
  // Frame 0 split at tick 4: the tail stores the moved pinned target.
  assert.equal(editor.report.keyframes.length, 4);
  near(editor.report.keyframes[1].objects[0]._stykIK[22].target.x, goal.x);
  editor.seek(4);
  const geometry = buildGeometry(editor.report, editor.evaluatedFrame);
  point(geometry.objects.get(0).joints.get(22), goal, 1);
  editor.undo();
  assert.equal(editor.report.keyframes.length, 3);
});

test('unpinned IK path edits bake a solved pose like an ordinary pose drag', () => {
  const editor = ikFixture();
  editor.select(1, 1); editor.setNodeIK({enabled: true, pinned: false});
  editor.seek(0);
  const goal = {x: 410, y: 180};
  assert.ok(editor.beginMotionPathEdit({kind: 'node', uid: 1, handleId: 22, joint: 1}, 4));
  editor.updateMotionPathEdit(goal);
  assert.equal(editor.commitMotionPathEdit(), true);
  editor.seek(4);
  const end = buildGeometry(editor.report, editor.evaluatedFrame).objects.get(0).joints.get(22);
  point(end, goal, 3);
  editor.undo();
});

test('authored channels write one pose key at the remote tick without touching native frames', () => {
  const editor = fixture();
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  editor.seek(4); editor.select(1);
  const native = clone(editor.report.keyframes), history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  assert.equal(editor._drag.mode, 'channels');
  for (let i = 0; i <= 4; i++) editor.updateMotionPathEdit({x: 260 + i * 3, y: 240});
  assert.deepEqual(editor.report.keyframes, native);
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.tick, 4);
  assert.equal(editor._undo.length, history + 1);
  assert.deepEqual(editor.report.keyframes, native);
  const channel = editor.animationChannels.find(c => c.property === 'pose');
  const key = channel.keys.find(k => k.tick === 15);
  assert.ok(key?.value?.frameId);
  const source = editor.getFrameById(key.value.frameId);
  near(source.objects.find(o => o.unique_id === 1).root_x, 272);
  editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 272);
  editor.undo(); editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 400);
  editor.redo(); editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 272);
});

test('layer-sheet path edits publish one key at the remote tick', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 10, 20].map(x => createFrame([createObject(figure, 1, x, 200), createObject(figure, 2, 100 + x, 200)], 10));
  const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: true}).load(report);
  editor.seek(3); editor.select(1);
  const history = editor._undo.length, sheetBefore = clone(editor.report._styk.layerSheet);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  assert.equal(editor._drag.mode, 'sheet');
  editor.updateMotionPathEdit({x: 77, y: 210});
  assert.deepEqual(editor.report._styk.layerSheet, sheetBefore);
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.tick, 3);
  assert.equal(editor._undo.length, history + 1);
  assert.doesNotThrow(() => editor.serialize());
  const track = editor.report._styk.layerSheet.tracks['layer-1'];
  const key = track.keys.find(k => k.tick === 15);
  assert.ok(key?.value?.frameId);
  editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 77);
  editor.undo(); editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 15);
});

test('joined children follow their parent through a remote root edit', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  const make = () => {
    const child = createObject(figure, 2, 0, 0);
    child.join = {target_object_slot: 0, target_handle_id: figure.segments[0].segment_id, target_unique_id: 1};
    return child;
  };
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200), make()], 10),
    createFrame([createObject(figure, 1, 300, 200), make()], 10),
    createFrame([createObject(figure, 1, 500, 200), make()], 10),
  ];
  const editor = new Editor({demo: false}).load(report);
  editor.seek(0); editor.select(1);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  editor.updateMotionPathEdit({x: 250, y: 260});
  assert.equal(editor.commitMotionPathEdit(), true);
  const stored = editor.report.keyframes[1];
  assert.ok(stored.objects[1].join, 'join link survives the remote edit');
  near(stored.objects[0].root_x, 250);
  editor.seek(10);
  const geometry = buildGeometry(editor.report, editor.evaluatedFrame);
  const joinedRoot = geometry.objects.get(1).root;
  const parentEnd = geometry.objects.get(0).joints.get(figure.segments[0].segment_id);
  point(joinedRoot, parentEnd, 1e-3);
});

test('path sampling stays inside its per-call budget and completes over calls', () => {
  const editor = fixture();
  editor.select(1);
  const target = motionPathTarget(editor);
  const cache = new MotionPathCache({budgetMs: 0});
  const entry = cache.get(editor, target);
  assert.equal(entry.complete, false);
  assert.ok(entry.points.size > 0 && entry.points.size < entry.ticks.length);
  for (let calls = 0; !entry.complete && calls < 100; calls++) cache.get(editor, target);
  assert.ok(entry.complete);
  assert.equal(entry.points.size, entry.ticks.length);
  near(entry.points.get(10).x, 300);
});

test('a committed edit keeps the old trail while it resamples under budget', () => {
  const editor = fixture();
  editor.select(1);
  const target = motionPathTarget(editor);
  const cache = new MotionPathCache({budgetMs: 0});
  let entry = cache.get(editor, target);
  while (!entry.complete) entry = cache.get(editor, target);
  near(entry.points.get(10).x, 300);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  editor.updateMotionPathEdit({x: 500, y: 400});
  editor.commitMotionPathEdit();
  entry = cache.get(editor, target);
  assert.equal(entry.complete, false);
  assert.ok(entry.points.size > 0, 'previous points remain during resampling');
  while (!entry.complete) entry = cache.get(editor, target);
  near(entry.points.get(10).x, 500);
  near(entry.points.get(0).x, 100);
});

test('the path cache resamples only the live window while a session runs', () => {
  const editor = fixture();
  editor.select(1);
  const target = motionPathTarget(editor);
  const cache = new MotionPathCache({budgetMs: Infinity});
  const entry = cache.get(editor, target);
  assert.equal(entry.points.size, entry.ticks.length);
  const revision = editor.revision;
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  editor.updateMotionPathEdit({x: 500, y: 400});
  const live = cache.get(editor, target, {session: editor._drag});
  near(live.points.get(10).x, 500);
  near(live.points.get(15).x, 500);
  near(live.points.get(0).x, 100);
  near(live.points.get(9).x, 100 * 0.1 + 500 * 0.9);
  editor.cancelMotionPathEdit();
  const reverted = cache.get(editor, target);
  near(reverted.points.get(10).x, 300);
  assert.equal(editor.revision, revision);
});

test('path edits survive serialize and reload', () => {
  const editor = fixture();
  editor.seek(0); editor.select(1);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  editor.updateMotionPathEdit({x: 245, y: 250});
  assert.equal(editor.commitMotionPathEdit(), true);
  const saved = editor.serialize();
  const reopened = new Editor({demo: false}).load(saved);
  assert.equal(reopened.report.keyframes.length, 4);
  near(rootAt(reopened, 15).root_x, 245);
  near(rootAt(reopened, 15).root_y, 250);
});

/** Parent + joined child: the child attaches at the parent's first segment end. */
function joinedFixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  const make = () => {
    const child = createObject(figure, 2, 0, 0);
    child.join = {target_object_slot: 0, target_handle_id: figure.segments[0].segment_id, target_unique_id: 1};
    return child;
  };
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200), make()], 10),
    createFrame([createObject(figure, 1, 300, 200), make()], 10),
    createFrame([createObject(figure, 1, 500, 200), make()], 10),
  ];
  return new Editor({demo: false}).load(report);
}

test('a joined figure\'s origin trail edits the parent attach joint, not the component root', () => {
  const editor = joinedFixture(), figure = editor.report.figure_types[0];
  editor.seek(10); editor.select(2);
  // The child's root trail rides on the parent's attach handle: dragging it
  // rotates that parent joint instead of translating the whole component.
  assert.ok(editor.beginMotionPathEdit({kind: 'node', uid: 2, handleId: 0, joint: -1}, 10));
  assert.equal(editor._drag.target.uid, 1);
  assert.equal(editor._drag.target.handleId, figure.segments[0].segment_id);
  const geometry = buildGeometry(editor.report, editor.evaluatedFrame);
  const attach = geometry.objects.get(0).joints.get(figure.segments[0].segment_id);
  editor.updateMotionPathEdit({x: attach.x + 40, y: attach.y});
  assert.equal(editor.commitMotionPathEdit(), true);
  const stored = editor.report.keyframes[1];
  near(stored.objects[0].root_x, 300);
  assert.ok(Math.abs(stored.objects[0].angles[0] - (-Math.PI / 2)) > 0.01, 'parent joint rotated');
  assert.ok(stored.objects[1].join, 'child stays attached');
  editor.seek(10);
  const after = buildGeometry(editor.report, editor.evaluatedFrame);
  assert.ok(after.objects.get(0).joints.get(figure.segments[0].segment_id).x > attach.x + 10);
  editor.undo();
});

test('multi-target overlay lists every selected figure', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200), createObject(figure, 2, 400, 100)], 10),
    createFrame([createObject(figure, 1, 300, 200), createObject(figure, 2, 200, 300)], 10),
    createFrame([createObject(figure, 1, 500, 200), createObject(figure, 2, 400, 300)], 10),
  ];
  const editor = new Editor({demo: false}).load(report);
  editor.selectMany([1, 2]);
  const targets = motionPathTargets(editor);
  assert.deepEqual(targets.map(t => t.uid).sort(), [1, 2]);
  // The primary selection keeps its joint target; the rest get root trails.
  editor.select(2, 1);
  const withJoint = motionPathTargets(editor, {all: true});
  assert.ok(withJoint.some(t => t.uid === 2 && t.joint === 1));
  assert.ok(withJoint.some(t => t.uid === 1 && t.joint === -1));
});

test('the range window keeps ticks around the playhead', () => {
  const editor = fixture();
  editor.seek(10);
  const plan = motionPathTicks(editor, {range: 4});
  assert.equal(plan.ticks[0], 6);
  assert.equal(plan.ticks.at(-1), 14);
  assert.ok(plan.ticks.includes(10));
  editor.seek(0);
  assert.equal(motionPathTicks(editor, {range: 4}).ticks[0], 0);
});


test('range cache follows seeks, reuses overlapping samples and evicts old ticks', () => {
  const editor = fixture(), cache = new MotionPathCache({budgetMs: Infinity});
  editor.select(1); editor.seek(10);
  const before = cache.get(editor, rootTarget, {range: 4}), shared = before.points.get(10);
  editor.seek(12);
  const after = cache.get(editor, rootTarget, {range: 4});
  assert.equal(after.ticks[0], 8); assert.equal(after.ticks.at(-1), 16);
  assert.equal(after.points.get(10), shared);
  assert.equal(after.points.has(6), false);
  assert.equal(pathPoints(after), pathPoints(after), 'ordered points are reused');
});

test('live sampling and cancelled windows finish with one sample per call', () => {
  const editor = fixture(), cache = new MotionPathCache({budgetMs: Infinity});
  editor.select(1); cache.get(editor, rootTarget);
  editor.beginMotionPathEdit(rootTarget, 10); editor.updateMotionPathEdit({x: 550, y: 300});
  cache.budgetMs = 0;
  let entry, calls = 0;
  do {entry = cache.get(editor, rootTarget, {session: editor._drag}); assert.ok(++calls < 100);} while (!entry.complete);
  near(entry.points.get(10).x, 550); near(entry.points.get(15).x, 525);
  editor.cancelMotionPathEdit(); calls = 0;
  do {entry = cache.get(editor, rootTarget); assert.ok(++calls < 100);} while (!entry.complete);
  near(entry.points.get(10).x, 300); near(entry.points.get(15).x, 400);
});

test('shared expired deadlines and pointer reads do not evaluate samples', () => {
  const editor = fixture(), cache = new MotionPathCache();
  editor.select(1);
  const entry = cache.get(editor, rootTarget, {deadline: -Infinity});
  assert.equal(entry.points.size, 0);
  assert.equal(cache.peek(editor, rootTarget), entry);
  assert.equal(entry.points.size, 0);
  editor.updateObject({root_x: 120});
  assert.equal(cache.peek(editor, rootTarget), null);
});

test('key-heavy plans remain bounded and preserve endpoints and playhead', () => {
  const report = emptyDocument();
  report.keyframes = Array.from({length: 5000}, () => createFrame([createObject(report.figure_types[0], 1, 100, 200)], 10));
  const loaded = new Editor({demo:false}).load(report); loaded.seek(2345);
  const plan = motionPathTicks(loaded, {maxPoints: 100});
  assert.ok(plan.ticks.length <= 100);
  assert.equal(plan.ticks[0], 0); assert.equal(plan.ticks.at(-1), loaded.totalTicks - 1);
  assert.ok(plan.ticks.includes(2345));
});

test('overlapping points pick the nearest time instead of the last frame', () => {
  const entry = {ticks:[0,1,2],points:new Map([0,1,2].map(t => [t,{tick:t,x:0,y:0}]))};
  assert.equal(pickMotionPathPoint(entry, {x:0,y:0}, {project:p=>p,tick:1}).tick,1);
});

test('dense labels do not overlap and held markers collapse around the current frame', async () => {
  const {layoutMotionPath} = await import('../src/motion-path.mjs');
  const points = Array.from({length:1600}, (_,tick)=>({tick,x:tick%400,y:Math.floor(tick/400)*10,key:true}));
  const entry = {ticks:points.map(p=>p.tick), points:new Map(points.map(p=>[p.tick,p]))};
  const layout = layoutMotionPath(entry,p=>p,{tick:800,labels:true});
  assert.ok(layout.badges.length<=48);
  for (const [i,a] of layout.badges.entries()) for (const b of layout.badges.slice(i+1))
    assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
  const held = layoutMotionPath(entry,()=>({x:10,y:10}),{tick:800});
  assert.equal(held.markers.length,1); assert.equal(held.markers[0].tick,800);
  assert.equal(held.badges.length,0);
});

test('short plans retain every tick and a beyond-end playhead does not restart sampling', () => {
  const editor = fixture();
  assert.equal(motionPathTicks(editor, {maxPoints:21}).ticks.length,21);
  editor.seek(30,{allowBeyondEnd:true});
  const cache = new MotionPathCache({budgetMs:Infinity});
  const entry = cache.get(editor,rootTarget,{range:4});
  assert.equal(entry.ticks.at(-1),20);
  assert.equal(cache.get(editor,rootTarget,{range:4}),entry);
});

/** Two figures whose limbs swing while the bodies travel. */
function swingFixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: 4}, (_, k) => createFrame([1, 2].map(uid => {
    const object = createObject(figure, uid, 100 + k * 80 + uid * 300, 200);
    object.angles = object.angles.map((a, j) => j ? a + Math.sin(k + j) * .6 : a);
    return object;
  }), 6));
  return new Editor({demo: false}).load(report);
}

test('limb-tip targets follow every branch end and the origin of each figure', async () => {
  const {figureTipJoints} = await import('../src/motion-path.mjs');
  const editor = swingFixture(), figure = editor.report.figure_types[0];
  const tips = figureTipJoints(figure), parents = new Set(figure.segments.map(s => Number(s.parent_id)));
  assert.ok(tips.length >= 4, 'a stick figure has hands, feet and a head');
  for (const index of tips) assert.equal(parents.has(Number(figure.segments[index].segment_id)), false);
  editor.select(1, tips[1]);
  const targets = motionPathTargets(editor, {joints: 'tips'});
  assert.deepEqual(targets[0], {kind: 'node', uid: 1, handleId: Number(figure.segments[tips[1]].segment_id), joint: tips[1]}, 'the selected joint leads');
  assert.equal(targets.length, tips.length + 1);
  assert.equal(new Set(targets.map(t => `${t.uid}:${t.handleId}`)).size, targets.length);
  assert.equal(motionPathTargets(editor, {joints: 'tips', all: true}).length, 2 * (tips.length + 1));
  assert.equal(motionPathTargets(editor, {joints: 'tips', all: true, maxTargets: 5}).length, 5);
});

test('batched sampling matches per-target sampling and evaluates each tick once', async () => {
  const geometry = await import('../src/pivot/geometry.mjs');
  const editor = swingFixture();
  const targets = motionPathTargets(editor, {joints: 'tips', all: true});
  const batched = new MotionPathCache({budgetMs: Infinity}).sample(editor, targets);
  for (const [i, target] of targets.entries()) {
    const single = new MotionPathCache({budgetMs: Infinity}).get(editor, target);
    assert.equal(batched[i].complete, true);
    for (const tick of single.ticks) point(batched[i].points.get(tick), single.points.get(tick));
  }
  // Every trail agrees with a full-scene geometry build at an in-between tick.
  const rows = editor.timeline, frame = geometry.evaluatedFrame(editor.report, 1, 0.5, 9);
  const full = buildGeometry(editor.report, frame);
  for (const [i, target] of targets.entries()) {
    const slot = frame.objects.findIndex(o => o.unique_id === target.uid);
    point(batched[i].points.get(9), full.objects.get(slot).joints.get(target.handleId));
  }
  assert.ok(rows.length > 1);
});

test('trail samples carry their body reference except the origin itself', () => {
  const editor = swingFixture(), figure = editor.report.figure_types[0];
  const hand = {kind: 'node', uid: 1, handleId: Number(figure.segments.at(-1).segment_id), joint: figure.segments.length - 1};
  const [origin, tip] = new MotionPathCache({budgetMs: Infinity}).sample(editor, [rootTarget, hand]);
  for (const tick of origin.ticks) {
    assert.equal(origin.points.get(tick).rx, undefined);
    near(tip.points.get(tick).rx, origin.points.get(tick).x);
    near(tip.points.get(tick).ry, origin.points.get(tick).y);
  }
});

test('relative projection keeps the body in place and hit tests use the same positions', async () => {
  const {projectMotionPath} = await import('../src/motion-path.mjs');
  const editor = swingFixture(), figure = editor.report.figure_types[0];
  editor.seek(6);
  const hand = {kind: 'node', uid: 1, handleId: Number(figure.segments.at(-1).segment_id), joint: figure.segments.length - 1};
  const entry = new MotionPathCache({budgetMs: Infinity}).get(editor, hand);
  const world = projectMotionPath(entry, p => p, {tick: 6});
  const relative = projectMotionPath(entry, p => p, {tick: 6, relative: true});
  assert.notEqual(world, relative, 'switching the anchor re-projects');
  assert.equal(projectMotionPath(entry, p => p, {tick: 6, relative: true}), relative, 'an unchanged projection is reused');
  const anchor = entry.points.get(6);
  relative.samples.forEach((sample, i) => {
    near(relative.xs[i] - (sample.x - sample.rx), anchor.rx);
    near(relative.ys[i] - (sample.y - sample.ry), anchor.ry);
  });
  const at = relative.samples.findIndex(s => s.tick === 18);
  const hit = pickMotionPathPoint(entry, {x: relative.xs[at], y: relative.ys[at]}, {project: p => p, tick: 6, relative: true});
  assert.equal(hit.tick, 18);
  near(hit.x, entry.points.get(18).x, 1e-9);
  // A scaled, translated view is recovered exactly from the projection function.
  const scaled = projectMotionPath(entry, p => ({x: p.x * 2 + 5, y: p.y * 2 - 3}), {tick: 6});
  near(scaled.xs[at], entry.points.get(18).x * 2 + 5);
});

test('ghost poses cover the target component at the requested time', () => {
  const editor = joinedFixture(), cache = new MotionPathCache();
  const ghost = cache.ghost(editor.report, {kind: 'node', uid: 2, handleId: 0, joint: -1}, 15);
  assert.equal(ghost.objects.length, 2, 'the joined parent and child');
  const frame = evaluatedFrame(editor.report, 1, 0.5, 15), full = buildGeometry(editor.report, frame);
  point(ghost.objects.find(g => g.obj.unique_id === 1).root, full.objects.get(0).root);
  assert.equal(cache.ghost(editor.report, {kind: 'node', uid: 2, handleId: 0, joint: -1}, 15), ghost, 'repeated requests reuse one evaluation');
  // Unrelated figures are never built for a trail sample or a ghost.
  const scene = swingFixture();
  assert.deepEqual(cache.ghost(scene.report, rootTarget, 3).objects.map(g => g.obj.unique_id), [1]);
});

test('speed colours rank faster segments warmer and draw without errors', async () => {
  const {drawMotionPath, MOTION_PATH_SPEED_COLORS} = await import('../src/motion-path.mjs');
  const points = [0, 1, 2, 3, 4, 5].map(tick => ({tick, x: tick < 3 ? tick : 2 + (tick - 2) * 20, y: 0, key: false}));
  const entry = {ticks: points.map(p => p.tick), points: new Map(points.map(p => [p.tick, p])), version: 0};
  const strokes = [];
  const context = new Proxy({}, {get: (target, name) => name in target ? target[name] : (name === 'stroke' ? () => strokes.push(target.strokeStyle) : () => {}),
    set: (target, name, value) => { target[name] = value; return true; }});
  drawMotionPath(context, entry, p => p, {tick: 0, speed: true});
  assert.ok(strokes.includes(MOTION_PATH_SPEED_COLORS[0]) && strokes.includes(MOTION_PATH_SPEED_COLORS.at(-1)));
  assert.equal(entry.screen.speed[0] < entry.screen.speed.at(-1), true);
});

test('a shared cache follows in-place retiming and pose edits', () => {
  const editor = fixture(), cache = new MotionPathCache({budgetMs: Infinity});
  editor.select(1);
  cache.get(editor, rootTarget);
  const version = () => `${editor.revision}:${editor.layerRevision}`;
  const ghostBefore = cache.ghost(editor.report, rootTarget, 15, version());
  // A split at tick 15 splices the stored keyframes of the same report object.
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  editor.updateMotionPathEdit({x: 250, y: 330});
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.report.keyframes.length, 4);
  const entry = cache.get(editor, rootTarget);
  point(entry.points.get(15), {x: 250, y: 330});
  point(entry.points.get(12), {x: 300 + (250 - 300) * 2 / 5, y: 200 + 130 * 2 / 5});
  const ghostAfter = cache.ghost(editor.report, rootTarget, 15, version());
  assert.notEqual(ghostAfter, ghostBefore);
  point(ghostAfter.objects[0].root, {x: 250, y: 330});
});
