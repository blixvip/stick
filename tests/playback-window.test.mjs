import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackWindow,playbackLookaheadSize,playbackStartupWindow,normalizePlaybackRange,playbackRangeFromFrames} from '../src/playback-window.mjs';

test('inclusive playback frames produce exact half-open transport ticks',()=>{
  const range=playbackRangeFromFrames(50,100,200);
  assert.deepEqual(range,{startTick:49,endTick:100});
  assert.deepEqual(playbackRangeFromFrames(100,50,200),range);
  const ticks=playbackWindow(49,100,normalizePlaybackRange(range,200));
  assert.equal(ticks.length,51);
  assert.equal(ticks[0],49);
  assert.equal(ticks.at(-1),99);
  assert.deepEqual(playbackWindow(99,3,normalizePlaybackRange(range,200),{loop:true}),[99,49,50]);
  assert.deepEqual(playbackRangeFromFrames(50,50,200),{startTick:49,endTick:50});
});

test('range input and shortened durations remain valid without losing inclusive endpoints',()=>{
  assert.deepEqual(playbackRangeFromFrames(-5,500,100),{startTick:0,endTick:100});
  assert.deepEqual(playbackRangeFromFrames(500,600,100),{startTick:99,endTick:100});
  assert.deepEqual(normalizePlaybackRange({startTick:49,endTick:100},75),{start:49,end:75});
  assert.deepEqual(normalizePlaybackRange({startTick:49,endTick:100},25),{start:24,end:25});
  assert.deepEqual(normalizePlaybackRange({startTick:-5,endTick:0},10),{start:0,end:1});
  assert.deepEqual(normalizePlaybackRange({startTick:NaN,endTick:10},20),{start:0,end:20});
  assert.deepEqual(normalizePlaybackRange(null,20),{start:0,end:20});
  assert.deepEqual(normalizePlaybackRange({startTick:49,endTick:100},0),{start:0,end:0});
  assert.equal(playbackRangeFromFrames(1,1,0),null);
  assert.equal(playbackRangeFromFrames(NaN,100,200),null);
});

test('expensive startup gets a bounded runway without starving a smaller worker queue',()=>{
  assert.equal(playbackStartupWindow(60,2,8),6);
  assert.equal(playbackStartupWindow(60,20,8),15);
  for(const cores of [1,2,4,8,32])for(const fps of [1,30,60,120,240])for(const cost of [0,10,100])
    assert.ok(playbackStartupWindow(fps,cost,cores)<=playbackLookaheadSize(24,cores));
});

test('non-looping lookahead drains at the exclusive end without requesting the opening',()=>{
  assert.deepEqual(playbackWindow(97,24,{start:10,end:100}),[97,98,99]);
  assert.deepEqual(playbackWindow(100,24,{start:10,end:100}),[]);
  assert.deepEqual(playbackWindow(8,3,{start:10,end:100}),[10,11,12]);
});
test('looping lookahead wraps only within its selected range and never duplicates ticks',()=>{
  assert.deepEqual(playbackWindow(97,6,{start:90,end:100},{loop:true}),[97,98,99,90,91,92]);
  assert.deepEqual(playbackWindow(10,24,{start:10,end:11},{loop:true}),[10]);
  assert.deepEqual(playbackWindow(10,24,{start:10,end:10},{loop:true}),[]);
});
test('editable lookahead preserves nearby reverse seeks and range boundaries',()=>{
  assert.deepEqual(playbackWindow(98,8,{start:10,end:100},{bidirectional:true}),[98,99,97,96]);
  assert.deepEqual(playbackWindow(11,4,{start:10,end:100},{bidirectional:true}),[11,12,13,10]);
});
