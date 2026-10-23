import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {snapshotPoseObject} from '../src/pose-snapshot.mjs';

function fixture(mode = 'native', joined = false) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1].map(i => createFrame([
    createObject(figure, 1, 180 + i * 20, 200),
    createObject(figure, 2, 400, 200, joined ? {join: {target_object_slot: 0, target_handle_id: 1, target_unique_id: 1}} : {}),
  ], 10));
  const editor = new Editor({demo: false, layerTimeline: mode === 'sheet'}).load(report);
  if (mode === 'authored') editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  if (mode === 'simple') { editor.enableFrameDrafts(); editor.beginFrameDraft({mode: 'add', index: 0}); }
  if (mode === 'sheet' || mode === 'authored') editor.seek(4);
  editor.select(1); editor.markSaved();
  return editor;
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function withoutHistorySources(report) {
  const copy = structuredClone(report);
  // Legacy authored history retains generated source poses for redo. The
  // active channels determine which of them belong to the document's pose.
  delete copy._styk.frameSources;
  return copy;
}

test('Alt-drag preference defaults to linked instances and only accepts supported modes', () => {
  for (const input of [null, {}, {altDragDuplicate: 'invalid'}]) assert.equal(normalizeEditorSettings(input).altDragDuplicate, 'instance');
  const settings = normalizeEditorSettings({altDragDuplicate: 'unique'});
  assert.equal(normalizeEditorSettings(JSON.parse(JSON.stringify(settings))).altDragDuplicate, 'unique');
});

for (const mode of ['native', 'sheet', 'authored', 'simple']) for (const pasteMode of ['instance', 'unique']) {
  test(`${mode}: ${pasteMode} duplicate moves only the copy and undoes/redoes as one edit`, () => {
    const e = fixture(mode), before = e.serialize(), history = e._undo.length;
    const original = snapshotPoseObject(e.object), typeCount = e.report.figure_types.length;
    e.copySelection(); const clipboard = e._selectionClipboard;
    assert.equal(e.beginDuplicateDrag({pasteMode}), true);
    const uid = e.selectedUid;
    assert.notEqual(uid, original.unique_id);
    assert.equal(e._undo.length, history, 'An unfinished gesture does not publish history');
    near(e.object.root_x, original.root_x); near(e.object.root_y, original.root_y);
    assert.equal(e.object.figure_type_id === original.figure_type_id, pasteMode === 'instance');
    e.moveSelection(37, -19, {fromStart: true});
    e.moveSelection(60, 25, {fromStart: true});
    e.commitDrag();
    assert.equal(e._undo.length, history + 1);
    assert.equal(e._selectionClipboard, clipboard);
    assert.equal(clipboard.pastes, 0);
    near(e.object.root_x, original.root_x + 60); near(e.object.root_y, original.root_y + 25);
    assert.deepEqual(snapshotPoseObject(e.selectionFrame.objects.find(o => o.unique_id === 1)), original);
    assert.equal(e.report.figure_types.length, typeCount + (pasteMode === 'unique' ? 1 : 0));
    const after = e.serialize();
    e.undo();
    assert.deepEqual(mode === 'authored' ? withoutHistorySources(e.serialize()) : e.serialize(), before);
    assert.equal(e.selectedUid, 1); assert.equal(e.dirty, false);
    e.redo(); assert.deepEqual(e.serialize(), after); assert.equal(e.selectedUid, uid);
    const reopened = new Editor({demo: false, layerTimeline: mode === 'sheet'}).load(after);
    reopened.seek(e.tick); reopened.select(uid); near(reopened.object.root_x, original.root_x + 60);
  });

  test(`${mode}: cancelling ${pasteMode} duplication restores document, selection, dirty state and redo`, () => {
    const e = fixture(mode);
    e.moveSelection(8, 0); e.undo(); e.markSaved();
    const before = e.serialize(), undo = e._undo.slice(), redo = e._redo.slice(), size = e.historySize;
    e.beginDuplicateDrag({pasteMode}); e.moveSelection(50, 30, {fromStart: true}); e.cancelDrag();
    assert.deepEqual(e.serialize(), before);
    assert.deepEqual(e._undo, undo); assert.deepEqual(e._redo, redo); assert.equal(e.historySize, size);
    assert.equal(e.selectedUid, 1); assert.equal(e.dirty, false); assert.equal(e.dragging, false);
    assert.equal(e.redo(), true);
  });
}

test('Duplicating a root copies its connected figures with internal joins and fresh identities', () => {
  const e = fixture('sheet', true), before = e.serialize(), original = e.selectionFrame.objects.map(o => snapshotPoseObject(o));
  e.beginDuplicateDrag(); const ids = [...e.selectedUids];
  assert.equal(ids.length, 2); assert.ok(ids.every(id => id > 2));
  e.moveSelection(70, 20, {fromStart: true}); e.commitDrag();
  const copies = e.selectedObjects, child = copies.find(o => o.join);
  assert.equal(e.selectionFrame.objects[child.join.target_object_slot].unique_id, copies.find(o => !o.join).unique_id);
  for (const object of original) assert.deepEqual(snapshotPoseObject(e.selectionFrame.objects.find(o => o.unique_id === object.unique_id)), object);
  e.undo(); assert.deepEqual(e.serialize(), before);
});

test('Rejected insertion or invalid translation does not leave copies or history behind', () => {
  const e = fixture('sheet'), before = e.serialize(), history = e._undo.length;
  assert.throws(() => e.beginDuplicateDrag({pasteMode: 'invalid'}), /paste mode/);
  assert.deepEqual(e.serialize(), before); assert.equal(e._undo.length, history);
  e.beginDuplicateDrag({pasteMode: 'unique'}); e.object.root_x = NaN;
  assert.throws(() => e.commitDrag());
  assert.deepEqual(e.serialize(), before); assert.equal(e._undo.length, history);
  assert.equal(e.dragging, false); assert.equal(e.dirty, false);
});

test('A locked destination rejects duplication without changing the document', () => {
  const e = fixture('sheet'); e.setLayerLocked(e.layerForUid(1), true);
  const before = e.serialize(), history = e._undo.length;
  assert.throws(() => e.beginDuplicateDrag(), /lock/i);
  assert.deepEqual(e.serialize(), before); assert.equal(e._undo.length, history); assert.equal(e.dragging, false);
});

test('Repeated cancelled copies release their generated sources and keep unrelated media out of history', () => {
  const e = fixture('sheet');
  e.report.figure_types.push({...structuredClone(e.figure), figure_type_id: 9, name: 'Unrelated', privatePayload: 'x'.repeat(500000)});
  const before = e.serialize(), sourceCount = Object.keys(e.report._styk.frameSources ?? {}).length;
  for (let i = 0; i < 20; i++) {
    e.beginDuplicateDrag({pasteMode: 'unique'}); e.moveSelection(i + 10, 15); e.cancelDrag();
  }
  assert.deepEqual(e.serialize(), before);
  assert.equal(Object.keys(e.report._styk.frameSources ?? {}).length, sourceCount);
  e.beginDuplicateDrag(); e.moveSelection(20, 15); e.commitDrag();
  assert.ok(e._undo.at(-1).bytes < 20000, 'History scales with copied poses, not unrelated media');
  assert.equal(JSON.stringify(e._undo.at(-1)).includes('privatePayload'), false);
});
