import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {PlaybackCache} from '../src/playback.mjs';
import {playbackWorkerAdmission,playbackWorkerAdmissionBudget,playbackMemoryBudget} from '../src/playback-budget.mjs';
import {createDemo} from '../src/demo.mjs';

const mib=1024*1024;
// Admit three cache/work reservations plus a small document; the extra 1 MiB
// UTF-16 fixture then pushes the same pool below the three-worker boundary.
const fixturePoolBytes=Math.ceil(3*playbackWorkerAdmission({maxWorkers:3,maxBytes:Infinity,frameBytes:16*mib}).perWorkerEstimate)+mib;
const workerFactory=()=>{
  const worker=new Worker(new URL('./playback-node-worker.mjs',import.meta.url));
  return {postMessage:message=>worker.postMessage(message),terminate:()=>worker.terminate(),
    addEventListener:(type,handler)=>worker.on(type,data=>handler(type==='message'?{data}:data))};
};
test('pool admission charges document copies as well as caches and active work',()=>{
  const options={maxWorkers:3,maxBytes:playbackWorkerAdmissionBudget(16),frameBytes:playbackMemoryBudget(16)};
  assert.equal(playbackWorkerAdmission(options).workers,3);
  assert.equal(playbackWorkerAdmission({...options,documentBytes:450*mib}).workers,2);
  const large=playbackWorkerAdmission({...options,documentBytes:8*1024*mib});
  assert.equal(large.workers,1);assert.equal(large.minimumExceedsTarget,true,'One exact lane remains even when the target cannot hold a document');
  assert.equal(playbackWorkerAdmission({...options,maxBytes:Infinity,documentBytes:8*1024*mib}).workers,3);
});

test('real workers shrink during snapshot transfer and preserve every packet; a small replacement restores lanes',async t=>{
  // Keep the fixture small while crossing the same admission threshold.
  const cache=new PlaybackCache({maxBytes:16*mib,workerCount:3,maxWorkerBytes:fixturePoolBytes,workerFactory});
  const control=new PlaybackCache({maxBytes:16*mib,workerCount:3,workerFactory});
  t.after(()=>{cache.dispose();control.dispose();});
  const report=createDemo();report._styk.admissionFixture='x'.repeat(mib);
  const primary=cache.worker;cache.load(report);control.load(report);
  const ticks=[0,1,2,3,4,5,6,7];await Promise.all([cache.prepareRange(ticks),control.prepareRange(ticks)]);
  assert.equal(cache.workers.length,2);assert.equal(control.workers.length,3);
  assert.ok(cache.stats.workerAdmission.reduced);assert.ok(cache.stats.workerAdmission.documentBytesEstimate>2*mib);
  for(const tick of ticks)for(const key of ['shapes','transforms','uids','groups'])
    assert.deepEqual(cache.get(tick)[key],control.get(tick)[key],`Tick ${tick}: ${key}`);
  const admission=cache.stats.workerAdmission;cache.updateView({scale:2});await cache.prepareRange(ticks);
  assert.equal(cache.stats.workerAdmission,admission,'A view change must not resize a published mirror');
  cache.load(createDemo());await cache.prepareRange(ticks);
  assert.equal(cache.workers.length,3);assert.equal(cache.worker,primary,'The planning endpoint must remain stable');
  assert.equal(cache.stats.workerAdmission.reduced,false);
  cache.invalidate();assert.equal(cache.stats.workerAdmission,null);
});

test('retired workers cannot fail a replacement lane or resurrect packet/cache ownership',async()=>{
  const all=[],factory=()=>{
    const handlers={};const worker={messages:[],terminated:false,postMessage(message){this.messages.push(message);},
      addEventListener(type,handler){handlers[type]=handler;},terminate(){this.terminated=true;},
      emit(type,data){handlers[type]?.(type==='message'?{data}:data);}};
    all.push(worker);return worker;
  };
  const cache=new PlaybackCache({workerCount:3,workerFactory:factory,maxBytes:16*mib,maxWorkerBytes:fixturePoolBytes});
  cache._sendLoad=async()=>{};cache._yieldLoad=async()=>{};
  try{
    const report=createDemo();report._styk.admissionFixture='x'.repeat(mib);
    cache.load(report);await cache._loadPromise;const retired=all[2];assert.ok(retired.terminated);
    cache.load(createDemo());await cache._loadPromise;assert.notEqual(cache.workers[2].worker,retired);
    retired.emit('error',{message:'late error',preventDefault(){}});retired.emit('messageerror',{});
    let closed=0;const before=retired.messages.length;
    retired.emit('message',{type:'packet',revision:cache.revision,deliveryId:1,packet:{compatibility:[{bitmap:{close(){closed++;}}}],workerCache:{rasterBytes:900}}});
    assert.equal(cache.failure,undefined);assert.equal(closed,1);assert.equal(retired.messages.length,before);
    assert.deepEqual(cache.stats.workerCacheTotals,{});
  }finally{cache.dispose();}
});

test('replacement while a shrunken snapshot awaits delivery cannot resize or charge the new document',async()=>{
  const cache=new PlaybackCache({maxBytes:16*mib,workerCount:3,maxWorkerBytes:fixturePoolBytes,workerFactory});
  let entered,release;
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const send=cache._broadcastLoad.bind(cache);let firstRevision;
  cache._broadcastLoad=async (message,responseType)=>{
    firstRevision??=message.revision;
    if(message.revision===firstRevision&&cache.workers.length===2){entered();await gate;}
    return send(message,responseType);
  };
  try{
    const report=createDemo();report._styk.admissionFixture='x'.repeat(mib);cache.load(report);
    const old=cache._loadPromise;await ready;
    cache.load(createDemo());await cache.prepareRange([0,1,2]);
    const current={...cache.stats.workerAdmission};release();await assert.rejects(old,{name:'AbortError'});
    assert.equal(cache.workers.length,3);assert.deepEqual(cache.stats.workerAdmission,current);
    assert.equal(cache.failure,undefined);assert.equal(cache.pending.size,0);
    assert.ok(cache.get(2));
  }finally{release();cache.dispose();}
});
