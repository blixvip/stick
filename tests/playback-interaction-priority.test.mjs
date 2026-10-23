import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlaybackWorkerEndpoint} from '../src/playback-worker.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {createDemo} from '../src/demo.mjs';
const task=()=>new Promise(resolve=>setTimeout(resolve,10));

test('foreground interaction suspends queued packets and resumes each exact tick',async()=>{
  const messages=[];let receive;
  receive=createPlaybackWorkerEndpoint(message=>{messages.push(message);if(message.type==='packet'&&message.tick===0)receive({type:'interaction',active:true});});
  receive({type:'load',revision:1,report:createDemo()});receive({type:'interaction',active:true});
  receive({type:'prepare',revision:1,ticks:[0,1,2]});await task();
  assert.equal(messages.filter(m=>m.type==='packet').length,0);
  receive({type:'interaction',active:false});
  for(let i=0;i<100&&!messages.some(m=>m.type==='packet');i++)await task();
  await task();assert.deepEqual(messages.filter(m=>m.type==='packet').map(m=>m.tick),[0]);
  receive({type:'interaction',active:false});
  for(let i=0;i<100&&messages.filter(m=>m.type==='packet').length<3;i++)await task();
  assert.deepEqual(messages.filter(m=>m.type==='packet').map(m=>m.tick),[0,1,2]);
  assert.equal(messages.filter(m=>m.type==='error').length,0);
  receive({type:'invalidate',revision:2});
});
test('document invalidation removes suspended work before resuming',async()=>{
  const messages=[],receive=createPlaybackWorkerEndpoint(m=>messages.push(m));
  receive({type:'load',revision:1,report:createDemo()});receive({type:'interaction',active:true});
  receive({type:'prepare',revision:1,ticks:[0,1]});receive({type:'invalidate',revision:2});
  receive({type:'load',revision:3,report:createDemo()});receive({type:'prepare',revision:3,ticks:[2]});receive({type:'interaction',active:false});
  for(let i=0;i<100&&!messages.some(m=>m.type==='packet');i++)await task();
  assert.deepEqual(messages.filter(m=>m.type==='packet').map(m=>[m.revision,m.tick]),[[3,2]]);
  receive({type:'invalidate',revision:4});
});
test('suspended preparation timers stop and resume without redundant worker messages',async()=>{
  const messages=[],cache=new PlaybackCache({timeoutMs:10000,workerFactory:()=>({postMessage:m=>messages.push(m),addEventListener(){},terminate(){}})});
  cache.report=createDemo();cache.totalTicks=3;
  const request=cache.prepareRange([0]).catch(error=>error);
  await Promise.resolve();await Promise.resolve();assert.ok(cache.pending.get(0).timer);
  cache.setInteractionActive(true);assert.equal(cache.pending.get(0).timer,null);
  cache.setInteractionActive(true);assert.equal(messages.filter(m=>m.type==='interaction').length,1);
  cache.setInteractionActive(false);assert.ok(cache.pending.get(0).timer);
  cache.dispose();assert.equal((await request).name,'AbortError');
});

function acknowledgedCache(){
  let receive;
  return new PlaybackCache({workerFactory:()=>({
    postMessage({type,revision,sequence}){
      if(type==='load-chunk'||type==='patch-chunk'||type==='load-complete'||type==='patch-complete')
        queueMicrotask(()=>receive({data:{type:type.endsWith('complete')?'loaded':'load-ack',revision,sequence}}));
    },
    addEventListener(type,handler){if(type==='message')receive=handler;},terminate(){}
  })});
}
async function until(predicate){
  for(let i=0;i<100&&!predicate();i++)await task();
  assert.ok(predicate(),'Expected lifecycle transition did not complete');
}

for(const kind of ['snapshot','patch'])test(`superseded suspended ${kind} streams settle without waiting for foreground interaction to end`,async()=>{
  const cache=acknowledgedCache(),outcomes=[];
  try{
    if(kind==='patch'){cache.load(createDemo());await cache._loadPromise;}
    cache.setInteractionActive(true);
    for(let index=0;index<5;index++){
      if(kind==='snapshot')cache.load(createDemo());
      else{
        cache.report.keyframes[0]={...cache.report.keyframes[0],duration_raw:index+2};
        cache.updateFrame(0,cache.report.keyframes[0],{revision:index+2});
      }
      cache._loadPromise.then(()=>outcomes.push('loaded'),error=>outcomes.push(error.name));
      await until(()=>Boolean(cache._interactionPromise)&&cache.stats.loadChunks>0);
    }
    await until(()=>outcomes.length===4);
    assert.deepEqual(outcomes,['AbortError','AbortError','AbortError','AbortError']);
    assert.equal(cache.interactionActive,true,'Cancelling a generation must not resume current background work');
    assert.equal(cache._mirrorAvailable,kind==='patch');
    cache.setInteractionActive(false);await cache._loadPromise;
    assert.deepEqual(outcomes,['AbortError','AbortError','AbortError','AbortError','loaded']);
    assert.equal(cache._mirrorAvailable,true);assert.equal(cache.failure,undefined);
    assert.equal(Boolean(cache._patchPending),false);
  }finally{cache.dispose();}
});

test('worker failure rejects a snapshot held by foreground interaction',async()=>{
  const cache=acknowledgedCache();cache.setInteractionActive(true);
  try{
    cache.load(createDemo());let outcome;
    const pending=cache._loadPromise.catch(error=>{outcome=error;});
    await until(()=>Boolean(cache._interactionPromise));
    const failure=new Error('Worker lost');cache._fail(failure);
    await until(()=>Boolean(outcome));await pending;
    assert.equal(outcome,failure);assert.equal(cache._interactionPromise,null);
  }finally{cache.dispose();}
});

test('a superseded yield cannot enter the replacement interaction gate',async()=>{
  const cache=acknowledgedCache();cache.setInteractionActive(true);
  try{
    let outcome;const old=cache._yieldLoad(cache.revision).catch(error=>{outcome=error;});
    cache.invalidate();await until(()=>Boolean(outcome));await old;
    assert.equal(outcome.name,'AbortError');assert.equal(cache._interactionPromise,null);
    assert.equal(cache.interactionActive,true);
  }finally{cache.dispose();}
});
