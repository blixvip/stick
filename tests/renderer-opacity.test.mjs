import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {RetainedGeometryCache} from '../src/playback-geometry-cache.mjs';
import {opacityArtwork} from '../src/renderer-opacity.mjs';
import {compileVectorObject,requiresCompatibilityTexture,SHAPE_FLOATS} from '../src/renderer-geometry.mjs';
import {createVfx} from '../src/vfx.mjs';

test('one straight primitive folds figure opacity into both gradient endpoints',()=>{
  const report=createDemo(),frame=report.keyframes[0];frame.objects[0].field28=128;
  const item=buildGeometry(report,frame).objects.get(0).drawables.find(s=>s.type==='line');
  item.seg={...item.seg,secondary:{rgb:[50,200,80],a:64}};
  const items=[item],data=compileVectorObject(items);
  assert.equal(requiresCompatibilityTexture(items),false);
  assert.equal(data.length,SHAPE_FLOATS);
  assert.equal(data[11],Math.fround(item.alpha*item.opacity));
  assert.equal(data[15],Math.fround((1-64/255)*item.opacity));
  assert.equal(requiresCompatibilityTexture([item,{...item}]),true,'overlap retains group isolation');
  assert.equal(requiresCompatibilityTexture([{...item,bend:.5,points:[item.start,item.start,item.end]}]),true);
});

test('fading artwork stays opaque and immutable while the figure carries final isolation alpha',()=>{
  const report=createDemo(),cache=new RetainedGeometryCache(),frame=structuredClone(report.keyframes[0]);
  frame.objects[0].field28=64;
  const first=cache.get(report,frame,1).objects.get(0),a=opacityArtwork(first),before=JSON.stringify(first);
  assert.ok(a.isolated);assert.equal(a.opacity,1-64/255);assert.ok(a.items.every(item=>item.opacity===1));
  for(const alpha of [128,200,255]){
    const next=structuredClone(frame);next.objects[0].field28=alpha;
    const g=cache.get(report,next,1).objects.get(0),b=opacityArtwork(g);
    assert.strictEqual(b.source,a.source);assert.equal(b.opacity,1-alpha/255);
    assert.strictEqual(g.joints,first.joints);
  }
  assert.equal(JSON.stringify(first),before);
  const next=structuredClone(frame);next.objects[0].root_x+=1e-8;
  assert.notStrictEqual(opacityArtwork(cache.get(report,next,1).objects.get(0)).source,a.source);
});

test('nested movieclip ownership and effects retain their established compositing path',()=>{
  const report=createDemo();report.keyframes[0].objects[0].field28=128;
  const g=buildGeometry(report,report.keyframes[0]).objects.get(0);
  const items=g.drawables.map(s=>({...s,_movieclipOwner:{opacity:.5}}));
  assert.equal(opacityArtwork({...g,drawables:items}).isolated,false);
  const obj={...g.obj,_stykVfx:{figure:[createVfx('blur','blur')]}};
  assert.equal(opacityArtwork({...g,obj,drawables:g.drawables.map(s=>({...s,obj}))}).isolated,false);
  // A child object must never inherit its parent's isolated opacity.
  assert.equal(opacityArtwork({...g,drawables:g.drawables.map(s=>({...s,obj}))}).isolated,false);
});
