import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {MAX_ALLOCATED_UID, nextUidAfter} from '../src/object-identity.mjs';

const editorWith = (...uids) => {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [createFrame(uids.map((uid, index) => createObject(figure, uid, 90 + index * 20, 120)), 3)];
  return new Editor({demo: false}).load(document);
};
const uidsOf = editor => editor.report.keyframes[editor.frameIndex].objects.map(object => object.unique_id).sort((a, b) => a - b);

test('a file with identities above the allocation bound still accepts new figures', () => {
  for (const large of [MAX_ALLOCATED_UID + 1, 0x80000000, 0xffffffff]) {
    const editor = editorWith(large, 0x80000000 + 41);
    editor.addFigure();
    const uids = uidsOf(editor);
    assert.equal(new Set(uids).size, uids.length, 'every identity stays unique');
    assert.deepEqual(uids.filter(uid => uid <= MAX_ALLOCATED_UID), [1], 'the new figure takes the first free identity');
    assert.ok(uids.includes(large), 'existing identities are untouched');
  }
});

test('new identities continue after the largest allocatable identity in the file', () => {
  const editor = editorWith(7, 0xfffffff0);
  editor.addFigure();
  assert.deepEqual(uidsOf(editor).filter(uid => uid <= MAX_ALLOCATED_UID), [7, 8]);
  editor.undo();
  assert.deepEqual(uidsOf(editor).filter(uid => uid <= MAX_ALLOCATED_UID), [7]);
  editor.redo();
  assert.deepEqual(uidsOf(editor).filter(uid => uid <= MAX_ALLOCATED_UID), [7, 8]);
});

test('allocation still stops when the allocatable range is really used up', () => {
  const editor = editorWith(MAX_ALLOCATED_UID);
  assert.throws(() => editor.addFigure(), /identity capacity/);
});

test('nextUidAfter ignores identities that cannot collide with allocations', () => {
  assert.equal(nextUidAfter(1, 5), 6);
  assert.equal(nextUidAfter(9, 5), 9);
  assert.equal(nextUidAfter(1, MAX_ALLOCATED_UID), MAX_ALLOCATED_UID + 1);
  assert.equal(nextUidAfter(3, MAX_ALLOCATED_UID + 1), 3);
  assert.equal(nextUidAfter(3, 0xffffffff), 3);
});
