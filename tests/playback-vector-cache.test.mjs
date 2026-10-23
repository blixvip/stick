import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackVectorCache} from '../src/playback-vector-cache.mjs';
import {SHAPE_FLOATS,shapeRecord} from '../src/renderer-geometry.mjs';
import {compilePlaybackPacket,PlaybackResources} from '../src/playback-worker.mjs';
import {PlaybackGeometryCache} from '../src/playback-geometry-cache.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';

test('retained vector packets remap painter positions without modifying earlier arrays',()=>{
  const cache=new PlaybackVectorCache({maxBytes:192}),g={},compile=()=>new Float32Array(shapeRecord({transform:1}));
  const first=cache.get(g,1,compile),same=cache.get(g,1,()=>assert.fail('unchanged pose compiled'));
  assert.equal(first,same);
  const moved=cache.get(g,2,()=>assert.fail('reordered pose compiled'));
  assert.equal(first[21],1);assert.equal(moved[21],2);assert.notEqual(first,moved);
  assert.equal(cache.bytes,96);assert.equal(cache.hits,2);
});
test('vector arrays have bounded bytes/entries and release on resource disposal',()=>{
  const cache=new PlaybackVectorCache({maxBytes:192,maxEntries:2}),keys=[{},{},{}];let compiles=0;
  const compile=()=>{compiles++;return new Float32Array(SHAPE_FLOATS);};
  keys.forEach(g=>cache.get(g,1,compile));assert.equal(cache.bytes,192);assert.equal(cache.lru.size,2);
  cache.get(keys[0],1,compile);assert.equal(compiles,4);
  cache.get({},1,()=>new Float32Array(1000));assert.equal(cache.bytes,192);
  cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.lru.size,0);
  const resources=new PlaybackResources();resources.vectors.get({},1,compile);resources.dispose();assert.equal(resources.vectors.bytes,0);
});
test('cached full packets match fresh compilation through pose, order, and revision changes',async()=>{
  const report=emptyDocument(),figure=report.figure_types[0],a=createObject(figure,1,100,200),b=createObject(figure,2,200,250);
  report.keyframes=[createFrame([a,b]),createFrame([a,b]),createFrame([a,b]),createFrame([{...a,angles:a.angles.map(n=>n+.1)},b])];
  report.keyframes[2].object_draw_order=[1,0];
  const resources=new PlaybackResources(),geometryCache=new PlaybackGeometryCache();
  try {
    for(let tick=0;tick<4;tick++){
      const cached=await compilePlaybackPacket(report,tick,{resources,geometryCache}),fresh=await compilePlaybackPacket(report,tick);
      assert.deepEqual(cached.shapes,fresh.shapes);assert.deepEqual(cached.transforms,fresh.transforms);assert.deepEqual(cached.groups,fresh.groups);
      if(tick===1)assert.equal(cached.sharing.reusedVectorObjects,2);
    }
    report.figure_types[0]={...figure,segments:figure.segments.map(s=>({...s,thickness:s.thickness+3}))};
    const revised=await compilePlaybackPacket(report,0,{revision:2,resources,geometryCache}),fresh=await compilePlaybackPacket(report,0,{revision:2});
    assert.deepEqual(revised.shapes,fresh.shapes);
  }finally{resources.dispose();}
});
