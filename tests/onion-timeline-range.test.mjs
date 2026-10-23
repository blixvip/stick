import test from 'node:test';
import assert from 'node:assert/strict';
import {onionRangeTick,onionDragValue,onionRangeSnapshot} from '../src/onion-range.mjs';
import {onionRangeLimit,onionRangeCountAtTick} from '../src/onion-range.mjs';
import {layerAppearance,thumbnailVisualChange} from '../src/thumbnail-validity.mjs';

test('sample endpoints follow authored keys, between-key playheads and sample spacing',()=>{
  const keys=[0,3,8,12,20,30,50];
  assert.equal(onionRangeTick(keys,12,2,-1,{}),3);
  assert.equal(onionRangeTick(keys,12,2,1,{}),30);
  assert.equal(onionRangeTick(keys,10,1,-1,{}),8);
  assert.equal(onionRangeTick(keys,10,1,1,{}),12);
  assert.equal(onionRangeTick(keys,12,1,1,{onionStep:2}),30);
  assert.equal(onionRangeTick(keys,12,2,-1,{onionMode:'frames',onionStep:3}),6);
  assert.equal(onionRangeTick(keys,12,0,-1,{}),12);
});
test('thumbnail validity excludes labels, colors, locks and audio but includes rendered changes',()=>{
  const state={order:['layer-1'],byId:{'layer-1':{name:'A',color:'blue',locked:false,visible:true}}};
  const old=layerAppearance(state);state.byId['layer-1'].name='B';state.byId['layer-1'].color='rose';state.byId['layer-1'].locked=true;
  const next=layerAppearance(state);assert.equal(old,next);
  assert.equal(thumbnailVisualChange({kind:'edit',layerMetadata:true},old,next),false);
  assert.equal(thumbnailVisualChange({kind:'history',layers:true},old,next),false);
  assert.equal(thumbnailVisualChange({kind:'edit',audio:true},old,next),false);
  state.byId['layer-1'].visible=false;
  assert.equal(thumbnailVisualChange({kind:'edit',layerMetadata:true},old,layerAppearance(state)),true);
  assert.equal(thumbnailVisualChange({kind:'edit',changedUids:[1]},old,next),true);
  assert.equal(thumbnailVisualChange({kind:'document'},old,next),true);
});

test('range endpoints never invent a frame or clamp to an unsampled key',()=>{
  assert.equal(onionRangeTick([0,3,8,12],8,10,-1,{onionStep:2}),0);
  assert.equal(onionRangeTick([0,3,8,12],8,10,1,{onionStep:2}),8);
  assert.equal(onionRangeTick([],8,10,1,{onionMode:'frames',onionStep:3},15),14);
});

test('deliberate frame scrubbing ignores sub-step jitter and clamps to bounds',()=>{
  assert.equal(onionDragValue(20,3,100),20);
  assert.equal(onionDragValue(20,8,100),21);
  assert.equal(onionDragValue(20,-8,100),19);
  assert.equal(onionDragValue(20,24,100,true),20);
  assert.equal(onionDragValue(20,32,100,true),21);
  assert.equal(onionDragValue(20,-800,100),0);
});

test('ranges follow actual sample counts and coordinates beyond ten',()=>{
  const keys=Array.from({length:100},(_,i)=>i*3);
  assert.equal(onionRangeLimit(keys,60,1,{},300),79);
  assert.equal(onionRangeLimit(keys,60,-1,{},300),20);
  assert.equal(onionRangeCountAtTick(keys,60,120,1,{},300),20);
  assert.equal(onionRangeCountAtTick(keys,60,9999,1,{},300),79);
  assert.equal(onionRangeTick(keys,60,10000,1,{},300),297);
  assert.equal(onionRangeCountAtTick(keys,60,5,-1,{onionMode:'frames',onionStep:1},300),55);
  assert.equal(onionRangeLimit(keys,0,-1,{},300),0);
});
