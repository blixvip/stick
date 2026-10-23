import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackCache, PLAYBACK_LANE_TICKS} from '../src/playback.mjs';
import {previewMemoryPlan, playbackWorkerMemoryPlan} from '../src/playback-budget.mjs';
import {PlaybackResources} from '../src/playback-resources.mjs';
import {Worker} from 'node:worker_threads';
import {createDemo} from '../src/demo.mjs';

test('pixel packet admission follows cache capacity instead of the vector buffer limit',async()=>{
  const mib=1024*1024;
  for(const maxBytes of [32,128,512].map(n=>n*mib)){
    const cache=new PlaybackCache({maxBytes,workerFactory:()=>({postMessage(){},addEventListener(){},terminate(){}})});
    let admission;
    cache._sendLoad=async(client,message)=>{admission??=message.options;};
    try {
      cache.load(createDemo());await cache._loadPromise;
      assert.ok(admission.maxPacketBytes<maxBytes,'Background upload headroom must remain');
      if(maxBytes>=128*mib)assert.ok(admission.maxPacketBytes>64*mib,'Separate texture allocations must not inherit a storage-buffer cap');
      else assert.ok(admission.maxPacketBytes<32*mib,'Low-memory budgets remain bounded');
    }finally{cache.dispose();}
  }
});

test('raster retention scales with available memory without exceeding its partition',()=>{
  for(const memory of [.5,1,2,4,8,16,undefined]){
    const plan=previewMemoryPlan(memory);
    assert.ok(plan.workerRasters<=128*1024*1024);
    assert.ok(plan.workerRasters<=plan.cpuFrames/4);
    assert.ok(plan.workerVectors<=32*1024*1024);
    assert.ok(plan.workerVectors<=plan.cpuFrames/8);
    assert.ok(plan.editorOnions<=64*1024*1024);
    assert.equal(plan.editorOnions,Math.min(64*1024*1024,plan.cpuFrames/8));
    assert.equal(plan.editorSoftwareFilters,Math.min(64*1024*1024,plan.cpuFrames/4));
    assert.equal(plan.workerSoftwareFilters,Math.min(64*1024*1024,plan.cpuFrames/8));
    assert.equal(plan.editorBackgrounds,Math.min(16*1024*1024,plan.cpuFrames/16));
    assert.equal(plan.workerBackgrounds,plan.editorBackgrounds);
  }
  assert.equal(previewMemoryPlan(8).workerRasters,128*1024*1024);
});

test('aggregate retention includes every worker and its encoded sources and drawing caches',()=>{
  for(const memory of [.5,2,8,32,undefined]){
    const single=previewMemoryPlan(memory,1), triple=previewMemoryPlan(memory,3);
    const perWorker=single.workerImages+single.workerSources+single.workerRasters+single.workerVectors+single.workerDrawings+single.workerTints+single.workerSoftwareFilters+single.workerBackgrounds;
    assert.equal(single.workerRetainedBytes,perWorker);
    assert.equal(triple.workerPoolBytes,perWorker*3);
    assert.equal(triple.retainedBytes-single.retainedBytes,perWorker*2);
  }
});

test('controller cache limits reach actual worker resource owners and retain exact packets',async t=>{
  const workerFactory=()=>{
    const worker=new Worker(new URL('./playback-node-worker.mjs',import.meta.url));
    return {postMessage:m=>worker.postMessage(m),terminate:()=>worker.terminate(),
      addEventListener:(type,handler)=>worker.on(type,data=>handler(type==='message'?{data}:data))};
  };
  const bytes=64*1024, cache=new PlaybackCache({maxBytes:bytes,workerCount:2,workerFactory});
  t.after(()=>cache.dispose());
  // One tick from each worker's lane of consecutive ticks.
  const ticks=[0,PLAYBACK_LANE_TICKS];
  cache.load(createDemo());await cache.prepareRange(ticks);
  const plan=playbackWorkerMemoryPlan(bytes);
  assert.equal(cache.stats.workerMemoryPlan.poolRetainedBytes,plan.retainedBytes*2);
  for(const snapshot of cache.stats.workerCaches){
    assert.ok(snapshot.vectorBytes>0);
    assert.ok(snapshot.vectorBytes<=plan.vectors);
  }
  assert.equal(cache.stats.workerCacheTotals.vectorBytes,cache.stats.workerCaches.reduce((n,s)=>n+s.vectorBytes,0));
  assert.ok(cache.stats.documentTransferEstimate>0);
  const generous=new PlaybackCache({maxBytes:32*1024*1024,workerFactory});t.after(()=>generous.dispose());
  generous.load(createDemo());await generous.prepareRange(ticks);
  for(const tick of ticks){
    assert.deepEqual(cache.get(tick).shapes,generous.get(tick).shapes);
    assert.deepEqual(cache.get(tick).transforms,generous.get(tick).transforms);
  }
});

test('explicit raster retention bounds allocations and releases evicted originals',async()=>{
  const resources=new PlaybackResources({maxBytes:4096,maxPacketBytes:4096,maxRasterBytes:16,maxVectorBytes:16});
  const bitmaps=[];
  const bitmap=()=>{const b={width:2,height:2,closed:false,close(){this.closed=true;}};bitmaps.push(b);return b;};
  resources.artworkBitmaps.clone=async()=>bitmap();
  try{
    const first=await resources.artworkBitmaps.packetBitmap('first',bitmap);first.close();
    const second=await resources.artworkBitmaps.packetBitmap('second',bitmap);second.close();
    assert.ok(bitmaps[0].closed,'Prior retained original must be evicted');
    assert.equal(resources.cacheSnapshot().rasterBytes,16);
    assert.equal(resources.vectors.maxBytes,16);
  }finally{resources.dispose();}
  assert.ok(bitmaps.every(b=>b.closed));
  assert.equal(resources.cacheSnapshot().rasterBytes,0);
});

test('worker totals replace per-owner snapshots, reject stale results and follow resource lifetime',()=>{
  const cache=new PlaybackCache({workerCount:2,workerFactory:()=>({postMessage(){},addEventListener(){},terminate(){}})});
  const deliver=(index,bytes,revision=cache.revision)=>cache._receive({type:'packet',tick:99,revision,
    packet:{compatibility:[],workerCache:{rasterBytes:bytes,vectorBytes:10}}},cache.workers[index]);
  try{
    deliver(0,100);deliver(1,200);deliver(0,120);
    assert.equal(cache.stats.workerCacheTotals.rasterBytes,320,'Unrequested packets still report retained worker memory');
    const revision=cache.revision;cache.invalidate({retainDocument:true});
    assert.equal(cache.stats.workerCacheTotals.rasterBytes,320);
    deliver(1,900,revision);assert.equal(cache.stats.workerCacheTotals.rasterBytes,320);
    deliver(1,0);assert.equal(cache.stats.workerCacheTotals.rasterBytes,120);
    cache.invalidate();assert.deepEqual(cache.stats.workerCacheTotals,{});
    deliver(0,10);cache._fail(new Error('Simulated worker failure'));
    assert.deepEqual(cache.stats.workerCacheTotals,{});
    deliver(1,100);assert.deepEqual(cache.stats.workerCacheTotals,{},'Late failed-worker messages cannot resurrect released caches');
  }finally{cache.dispose();}
});

test('a superseded snapshot cannot charge transfers to the next revision',async()=>{
  const cache=new PlaybackCache({workerFactory:()=>({postMessage(){},addEventListener(){},terminate(){}})});
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),acknowledgment=new Promise(resolve=>release=resolve);
  cache._broadcastLoad=message=>{if(message.chunk?.estimatedBytes){entered();return acknowledgment;}return Promise.resolve();};
  cache._yieldLoad=async()=>{};
  try{
    cache.load(createDemo());const loading=cache._loadPromise;await waiting;
    cache.invalidate({retainDocument:true});cache.stats.documentTransferEstimate=17;
    release();await loading.catch(error=>assert.equal(error.name,'AbortError'));
    assert.equal(cache.stats.documentTransferEstimate,17);
    assert.equal(cache._mirrorAvailable,false);
  }finally{release();cache.dispose();}
});

test('startup buffering respects short ranges, known memory limits, and shared footprints',()=>{
  const cache=new PlaybackCache({maxBytes:100,maxFrames:12,workerFactory:()=>({postMessage(){},addEventListener(){},terminate(){}})});
  try {
    cache.totalTicks=20;cache.cache.set(0,{});cache._recentPacketBytes=60;
    cache._packetFootprints.set(0,{base:60,resources:[]});cache._packetFootprints.set(1,{base:60,resources:[]});
    assert.ok(cache.bufferedAhead(0,12),'Two known non-fitting frames must not deadlock startup');
    cache._packetFootprints.set(0,{base:5,resources:[['shared',60]]});cache._packetFootprints.set(1,{base:5,resources:[['shared',60]]});
    assert.equal(cache.bufferedAhead(0,2),false);cache.cache.set(1,{});assert.ok(cache.bufferedAhead(0,2));
    assert.ok(cache.bufferedAhead(0,12,2),'Short playback ranges need only their own frames');
    assert.equal(cache.bufferedAhead(2,12),false);
  }finally{cache.cache.clear();cache.dispose();}
});
