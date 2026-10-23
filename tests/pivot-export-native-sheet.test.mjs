import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {materializePivotDocument, needsPivotMaterialization} from '../src/pivot-export-materialize.mjs';

function fixture() {
  const document = emptyDocument(); document.auto_easing = false;
  document.keyframes = [3, 0, 4, 2].map((duration, index) => ({
    ...createFrame([createObject(document.figure_types[0], 1, 40 + index * 30, 80)], duration),
    opaque: {index, exact: '01'},
  }));
  return new Editor({demo: false, layerTimeline: true}).load(document);
}
function sample(report, tick) {
  const rows = timeline(report); let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  return evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
}

test('an imported layer sheet retains native exposures, hidden keys and unknown fields without baking', () => {
  const editor = fixture(), before = structuredClone(editor.report);
  assert.equal(needsPivotMaterialization(editor.report), false);
  const output = materializePivotDocument(editor.report);
  assert.equal(output._styk.layerSheet, undefined);
  assert.equal(output.keyframes, editor.report.keyframes, 'the native pose inventory is reused');
  assert.deepEqual(output.keyframes.map(frame => frame.duration_raw), [3, 0, 4, 2]);
  assert.deepEqual(output.keyframes.map(frame => frame.opaque.index), [0, 1, 2, 3]);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    const a = sample(editor.report, tick), b = sample(output, tick);
    assert.deepEqual(a.objects, b.objects); assert.deepEqual(a.camera, b.camera);
  }
  assert.deepEqual(editor.report, before, 'export must not modify the editable timeline');
});

test('retimed, authored, shortened and overlaid layer sheets retain the baking path', () => {
  const changes = [
    sheet => {sheet.tracks['layer-1'].keys[1].sourceTick += .5;},
    sheet => {sheet.tracks['layer-1'].keys[1].tick++;},
    sheet => {sheet.tracks['layer-1'].end--;},
    sheet => {sheet.duration++;},
    sheet => {const key = sheet.tracks['layer-1'].keys[1]; delete key.sourceTick; key.value = {frameId: null};},
    sheet => {sheet.tracks.camera.keys[0].movieclipPatches = [];},
    sheet => {sheet.legacyAnimation = {channels: []};},
    sheet => {sheet.tracks.scene.keys.pop();},
    sheet => {sheet.tracks.scene.keys[0].futureBehavior = true;},
  ];
  for (const change of changes) {
    const editor = fixture(); change(editor.report._styk.layerSheet);
    assert.equal(needsPivotMaterialization(editor.report), true, change.toString());
  }
});

test('native export eligibility follows edits, undo, redo and saved timeline contents', () => {
  const editor = fixture(), before = structuredClone(editor.report);
  editor.sheetInsertKey(['layer-1'], 1);
  assert.equal(needsPivotMaterialization(editor.report), true);
  const edited = materializePivotDocument(editor.report);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    const a = sample(editor.report, tick), b = sample(edited, tick);
    assert.equal(a.objects[0].root_x, b.objects[0].root_x);
  }
  editor.undo();
  assert.deepEqual(editor.report, before);
  assert.equal(needsPivotMaterialization(editor.report), false);
  const reopened = new Editor({demo: false, layerTimeline: true}).load(editor.serialize());
  assert.equal(needsPivotMaterialization(reopened.report), false);
  editor.redo();
  assert.equal(needsPivotMaterialization(editor.report), true);
});

test('a saved sheet with separate legacy animation metadata stays on the established evaluator', () => {
  const editor = fixture();
  editor.report._styk.animation = {version: 1, channels: []};
  assert.equal(needsPivotMaterialization(editor.report), true);
});
