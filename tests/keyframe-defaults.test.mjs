import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings} from '../src/settings.mjs';
import {inheritedKeyEasing, easingMode} from '../src/keyframe-easing.mjs';

test('advanced timeline is the default', () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.timelineMode, 'advanced');
  assert.equal(normalizeEditorSettings().timelineMode, 'advanced');
});

test('new documents hold; inserted and blank layer keys inherit the previous curve', () => {
  const e = new Editor({demo: false, layerTimeline: true});
  e.newDocument();
  const id = e.activeLayerId;
  assert.equal(easingMode(e.layerFrameKeys(id)[0]), 'constant');
  e.sheetSetDuration(6,id,0);
  e.sheetInsertKey([id], 5);
  assert.equal(easingMode(e.layerFrameKeys(id)[1]), 'constant');
  e.sheetSetEasing([id], 0, 0, {interpolation: 'bezier', bezier: [.1,.2,.8,.9]});
  const before = e.serialize();
  e.sheetInsertKey([id], 3, {blank: true});
  const inserted = e.layerFrameKeys(id).find(key => key.tick === 3);
  assert.equal(inserted.interpolation, 'bezier');
  assert.deepEqual(inserted.bezier, [.1,.2,.8,.9]);
  e.undo(); assert.deepEqual(e.serialize(), before);
  e.redo(); assert.equal(e.layerFrameKeys(id).find(key => key.tick === 3).interpolation, 'bezier');
});

test('property key insertion inherits the earlier key rather than the later key', () => {
  const e = new Editor({demo: false});
  // Exercise legacy property channels without the new document's layer sheet.
  e.addFigure();
  const target = {kind:'figure', uid:e.selectedUid};
  e.addAnimationKey(target, 'x', 0, 10);
  let channel = e.animationChannels.find(channel => channel.property === 'x');
  assert.equal(easingMode(channel.keys[0]), 'constant');
  e.setAnimationKeysEasing([{channelId:channel.id,keyIds:[channel.keys[0].id]}], {interpolation:'bezier',bezier:[.2,.3,.7,.8]});
  e.addAnimationKeys([{target, property:'x', tick:10, value:30, interpolation:'linear'}]);
  e.addAnimationKey(target, 'x', 5, 20);
  channel = e.animationChannels.find(channel => channel.property === 'x');
  const key = channel.keys.find(key => key.tick === 5);
  assert.equal(key.interpolation, 'bezier');
  assert.deepEqual(key.bezier, [.2,.3,.7,.8]);
});

test('inheritance ignores hidden and future keys and copies Bezier controls', () => {
  const keys = [{tick:8,interpolation:'linear'}, {tick:2,interpolation:'bezier',bezier:[.1,.2,.8,.9]}, {tick:4,hidden:true,interpolation:'linear'}];
  const inherited = inheritedKeyEasing(keys, 5);
  assert.equal(inherited.interpolation, 'bezier');
  assert.notEqual(inherited.bezier, keys[1].bezier);
  assert.equal(inheritedKeyEasing(keys, 0).interpolation, 'constant');
  assert.equal(inheritedKeyEasing(keys, 5, {property:'backgroundId'}).interpolation, 'constant');
});
