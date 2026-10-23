import test from 'node:test';
import assert from 'node:assert/strict';
import {createCameraMotion,sampleCameraMotion} from '../src/camera-motion.mjs';
import {motionGraphValues,motionGraphScale,motionGraphValueLabel,sampleMotionGraph} from '../src/camera-motion-graph.mjs';

test('motion plots keep opposing axes separate and use actual degrees and zoom percentages',()=>{
  const clip=createCameraMotion('impact','impact',7,24);
  Object.assign(clip.params,{direction:-45,moveX:18,moveY:18,roll:3,zoom:.2,strength:1.5});
  const plot=sampleMotionGraph(clip,24);
  assert.ok(plot.channels.x[0]>0&&plot.channels.y[0]<0);
  assert.ok(Math.abs(plot.channels.x[0]+plot.channels.y[0])<1e-10);
  assert.equal(plot.channels.roll[0],4.5);
  assert.ok(Math.abs(plot.channels.zoom[0]-(1.2**1.5-1)*100)<1e-10);
  for(const i of [0,25,plot.count]){
    const expected=motionGraphValues(sampleCameraMotion({clips:[clip]},clip.start+(clip.duration-1)*i/plot.count,24));
    for(const key of Object.keys(expected))assert.equal(plot.channels[key][i],expected[key]);
  }
});
test('plots reflect strength, fades and mute rather than normalizing amplitude away',()=>{
  const clip=createCameraMotion('wobble','wobble',0,48),before=sampleMotionGraph(clip,24);
  clip.params={...clip.params,strength:.5};const after=sampleMotionGraph(clip,24);
  assert.equal(after.peaks.x,before.peaks.x/2);
  assert.equal(after.channels.x[0],0);
  clip.enabled=false;const muted=sampleMotionGraph(clip,24);
  assert.deepEqual(muted.peaks,{x:0,y:0,roll:0,zoom:0});
});
test('graph work stays bounded for long clips and handles single-frame clips',()=>{
  const clip=createCameraMotion('shake','long',0,10000000);
  const graph=sampleMotionGraph(clip,1);
  assert.equal(graph.count,2048);
  assert.equal(graph.channels.x.length,2049);
  const single=sampleMotionGraph({...clip,duration:1},24);
  assert.equal(single.span,0);
  assert.ok(single.channels.x.every(n=>n===single.channels.x[0]));
  for(const peak of [0,.004,.1,1,2.4,12,105,300000])assert.ok(Number.isFinite(motionGraphScale(peak))&&motionGraphScale(peak)>=peak);
  assert.equal(motionGraphValueLabel(.00042),'0.00042');
});
