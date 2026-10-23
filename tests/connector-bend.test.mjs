import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {rigExampleDocument} from '../src/rig-examples.mjs';

// Sliding carriage: segment index 2 is a connector from (200, 230) to (440, 230) sliding at 50%.
function fixture() {
  const editor = new Editor({demo: false}).load(rigExampleDocument('sliding-carriage'));
  editor.select(1, 2); return editor;
}
const rail = editor => [...editor.geometry.objects.values()][0].segments[2];
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('a connector bends toward the pointer without runaway feedback', () => {
  const editor = fixture(), before = rail(editor);
  assert.ok(before.connector);
  assert.deepEqual([before.start.x, before.start.y, before.handle.x, before.handle.y], [200, 230, 320, 230]);
  editor.beginDrag('Pose joint');
  // Each step moves the pointer up; the midpoint handle follows it exactly.
  for (let y = 229; y >= 200; y--) {
    editor.bendJoint(320, y);
    const shape = rail(editor);
    near(shape.handle.x, 320, 1e-6); near(shape.handle.y, y, 1e-6);
    assert.ok(shape.bend > 0, 'an upward pointer bulges the connector upward');
  }
  const settled = rail(editor).bend;
  for (let i = 0; i < 5; i++) editor.bendJoint(320, 200);
  near(rail(editor).bend, settled, 1e-12);
  editor.bendJoint(320, 230);
  near(rail(editor).bend, 0, 1e-9);
  editor.bendJoint(320, 250);
  assert.ok(rail(editor).bend < 0);
  editor.commitDrag();
  const shape = rail(editor);
  assert.deepEqual([shape.start.x, shape.start.y], [200, 230], 'anchors stay fixed');
  near(shape.attachmentPosition, .5);
});

test('bending a connector keeps the slide position and does not rotate attached parts twice', () => {
  const editor = fixture(), object = structuredClone(editor.object);
  const carriage = e => [...e.geometry.objects.values()][0].segments.find(s => s.seg.parent_id === e.figure.segments[2].segment_id);
  const restAngle = carriage(editor).angle, restRail = rail(editor).angle;
  editor.beginDrag('Pose joint');
  editor.bendJoint(320, 210, {stretch: true});
  editor.commitDrag();
  const after = editor.object;
  assert.deepEqual(after.angles, object.angles, 'no joint angle is rewritten');
  assert.equal(after.len_flag ? after.lengths[2] : editor.figure.segments[2].length, .5);
  // Attached parts inherit the connector's rotation once, as when sliding along a curved rail.
  near(carriage(editor).angle - restAngle, rail(editor).angle - restRail, 1e-9);
  near(carriage(editor).start.x, rail(editor).handle.x, 1e-9);
  near(carriage(editor).start.y, rail(editor).handle.y, 1e-9);
});

test('Build rig bend on a connector publishes one reusable definition edit', () => {
  const editor = fixture(), history = editor._undo.length;
  assert.ok(editor.beginRigDrag({bend: true}));
  editor.bendJoint(320, 215);
  editor.commitRigDrag?.() ?? editor.commitDrag();
  assert.equal(editor._undo.length, history + 1);
  assert.ok(editor.figure.segments[2].bend_rad > 0);
  near(rail(editor).handle.y, 215, 1e-6);
  editor.undo();
  assert.equal(editor.figure.segments[2].bend_rad ?? 0, 0);
});
