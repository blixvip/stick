import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {figureJoinAction, joinTargetUids} from '../src/figure-join-action.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1].map(() => createFrame([101, 707, 909].map((uid, slot) => createObject(figure, uid, 200 + slot * 180, 260))));
  const editor = new Editor({demo: false}); editor.load(report); editor.select(707, 2); return editor;
}
test('node/branch selections resolve the figure, while genuine multi-selection is disabled', () => {
  const editor = fixture();
  assert.deepEqual(figureJoinAction(editor), {uid: 707, kind: 'join'});
  editor.joinTo(101, 3);
  assert.deepEqual(figureJoinAction(editor), {uid: 707, kind: 'unjoin'});
  editor.select(909, -1, {add: true}); assert.equal(figureJoinAction(editor), null);
  editor.selectBranch(101, 2);
  assert.equal(editor.selectedUids.size, 2);
  assert.deepEqual(figureJoinAction(editor), {uid: 101, kind: 'join'});
  editor.select(null); assert.equal(figureJoinAction(editor), null);
});
test('joining excludes self and descendants by slots with sparse UIDs and bounded cycle traversal', () => {
  const objects = [101, 707, 909, 4].map(unique_id => ({unique_id}));
  objects[0].join = {target_object_slot: 2}; objects[1].join = {target_object_slot: 0};
  assert.deepEqual([...joinTargetUids({objects}, 101)], [909, 4]);
  objects[2].join = {target_object_slot: 1};
  assert.deepEqual([...joinTargetUids({objects}, 101)], [4]);
  assert.equal(joinTargetUids({objects}, 999).size, 0);
});
test('UI join route edits only the owning figure, preserves selection, and detaches without a jump', () => {
  const editor = fixture(), original = editor.geometry.objects.get(1).root;
  editor.joinFiguresInFrames(101, 3, undefined, {uids: [707], atPlayhead: true});
  const joined = {...editor.geometry.objects.get(1).root};
  assert.notDeepEqual(joined, original);
  assert.equal(editor.selectedJoint, 2);
  assert.equal(editor.object.join.target_handle_id, 3);
  editor.detachFiguresInFrames(undefined, {uids: [707], atPlayhead: true});
  assert.deepEqual(editor.geometry.objects.get(1).root, joined);
  assert.equal(editor.object.join, null);
  editor.undo(); assert.equal(editor.object.join.target_unique_id, 101);
  editor.undo(); assert.equal(editor.object.join, null); assert.deepEqual(editor.geometry.objects.get(1).root, original);
  editor.redo(); editor.redo(); assert.deepEqual(editor.geometry.objects.get(1).root, joined);
});
test('range joins are atomic, undoable, and history excludes unrelated pose payloads', () => {
  const editor = fixture();
  for (const frame of editor.report.keyframes) frame.objects[2]._unrelated = 'x'.repeat(500000);
  editor.joinFiguresInFrames(101, 3, [0, 1], {uids: [707]});
  assert.ok(editor.report.keyframes.every(frame => frame.objects[1].join?.target_unique_id === 101));
  assert.ok(editor._undo.at(-1).bytes < 12000);
  editor.undo(); assert.ok(editor.report.keyframes.every(frame => !frame.objects[1].join));
  editor.report.keyframes[1].objects[0].join = {target_object_slot: 1, target_unique_id: 707, target_handle_id: 3};
  const before = JSON.stringify(editor.report);
  assert.throws(() => editor.joinFiguresInFrames(101, 3, [0, 1], {uids: [707]}), /cycle|cyclic/i);
  assert.equal(JSON.stringify(editor.report), before);
});
