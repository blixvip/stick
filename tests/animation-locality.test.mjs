import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerformanceEditor} from './animation-mode-performance-fixture.mjs';
import {planAuthoredClipboard} from '../src/frame-clipboard-authored.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';

const target = {kind:'figure',uid:1};
const fixture = () => createPerformanceEditor({frames:30,figures:3,channels:3,keys:200});

test('scalar previews retain untouched keys and immutable previously published poses', () => {
  const editor = fixture(), before = editor.report._styk.animation, original = structuredClone(before);
  editor.beginAnimationEdit(target,'x'); editor.previewAnimationEdit(700);
  const first = editor.report._styk.animation, captured = structuredClone(first), keys = first.channels[0].keys;
  assert.equal(keys[0],before.channels[0].keys[0]);
  editor.previewAnimationEdit(800);
  assert.deepEqual(first,captured,'a later preview cannot mutate an in-flight snapshot');
  assert.deepEqual(before,original,'the gesture baseline stays immutable');
  assert.equal(editor.report._styk.animation.channels[0].keys[0],keys[0]);
  assert.equal(editor.evaluatedFrame.objects[0].root_x,800);
  editor.commitAnimationEdit();
  editor.undo(); assert.deepEqual(editor.report._styk.animation,original);
  editor.redo(); assert.equal(editor.evaluatedFrame.objects[0].root_x,800);
  validateAnimationDocument(editor.report);
});

test('warm scalar previews do not inspect unrelated key payloads or rebuild native timing', () => {
  const editor = fixture(), timeline = editor.timeline;
  editor.beginAnimationEdit(target,'x'); editor.previewAnimationEdit(700);
  const key = editor.animationChannels[0].keys[100], value = key.value;
  Object.defineProperty(key,'value',{enumerable:true,configurable:true,get(){throw new Error('unrelated payload read');}});
  editor.previewAnimationEdit(800); editor.previewAnimationEdit(900);
  assert.equal(editor.timeline,timeline);
  Object.defineProperty(key,'value',{enumerable:true,configurable:true,writable:true,value});
  editor.commitAnimationEdit(); editor.undo(); assert.equal(editor.timeline,timeline);
  editor.redo(); assert.equal(editor.timeline,timeline);
});

test('preview cancellation, no-op release and duration-changing history stay exact', () => {
  const editor = fixture(), before = editor.report._styk.animation, ticks = editor.totalTicks;
  const value = editor.animationValue(target,'x',editor.tick);
  editor.beginAnimationEdit(target,'x'); editor.previewAnimationEdit(700); editor.previewAnimationEdit(value);
  assert.equal(editor.commitAnimationEdit(),false); assert.equal(editor.report._styk.animation,before);
  editor.beginAnimationEdit(target,'x'); editor.previewAnimationEdit(800); editor.cancelAnimationEdit();
  assert.equal(editor.report._styk.animation,before);
  editor.addAnimationKey(target,'x',ticks+100,999); assert.equal(editor.totalTicks,ticks+101);
  editor.undo(); assert.equal(editor.totalTicks,ticks); editor.redo(); assert.equal(editor.totalTicks,ticks+101);
});

test('a repeated preview keeps native-curve removal and canonical easing identical to a single write', () => {
  const single=fixture(), repeated=fixture();
  for(const editor of [single,repeated]) {
    const key=editor.animationChannels[0].keys.find(key=>key.tick===editor.tick);
    Object.assign(key,{interpolation:'hold',nativeCurve:'pchip',nativeValueMode:'angle',nativeRotation:true});
    editor.beginAnimationEdit(target,'x');
  }
  single.previewAnimationEdit(900); single.commitAnimationEdit();
  repeated.previewAnimationEdit(700); repeated.previewAnimationEdit(900); repeated.commitAnimationEdit();
  assert.deepEqual(repeated.report._styk.animation,single.report._styk.animation);
});

test('loading another document resets retained timing before shortening its authored tail', () => {
  const editor=createPerformanceEditor({frames:30,figures:3,channels:0,keys:0});
  assert.equal(editor.totalTicks,59);
  editor.load(fixture().serialize());assert.equal(editor.totalTicks,200);
  editor.deleteAnimationKeys(editor.animationChannels.map(channel=>({channelId:channel.id,keyIds:channel.keys.map(key=>key.id)})));
  assert.equal(editor.totalTicks,59);editor.undo();assert.equal(editor.totalTicks,200);
});

test('frame insertion retains untouched keys without modifying shared history records', () => {
  for (const append of [false,true]) {
    const editor = createPerformanceEditor({frames:30,figures:3,channels:3,keys:append?20:200});
    const before = structuredClone(editor.report._styk.animation);
    for (const channel of editor.animationChannels) for (const key of channel.keys) Object.freeze(key);
    const frame = structuredClone(editor.evaluatedFrame); editor._assignFrameId(frame);
    const plan = planAuthoredClipboard(editor,{frames:[frame],assets:{layers:{additions:[]}},index:editor.report.keyframes.length,
      nextFrameIdentity:editor._nextFrameIdentity,append,trustedSource:true});
    assert.equal(plan.after.channels[0].keys[0],editor.animationChannels[0].keys[0]);
    assert.deepEqual(editor.report._styk.animation,before);
    editor.enableFrameDrafts({mode:'add'}); editor.addDraftFrame();
    const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.report._styk.animation,before);
    editor.redo(); assert.deepEqual(editor.serialize(),after); validateAnimationDocument(editor.report);
  }
});
