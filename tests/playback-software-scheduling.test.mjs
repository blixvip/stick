import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {PlaybackCache} from '../src/playback.mjs';
import {softwareFrameSize} from '../src/playback-software-size.mjs';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {createDemo} from '../src/demo.mjs';

function controlled({workerCount=3,frames=3}={}){
  const report=createDemo(),size=softwareFrameSize(report),sent=Array.from({length:workerCount},()=>[]);let created=0;
  const cache=new PlaybackCache({workerCount,maxBytes:size.byteLength*frames,workerFactory:()=>{
    const own=sent[created++];return {postMessage:message=>own.push(message),addEventListener(){},terminate(){}};
  }});
  cache.report=report;cache.totalTicks=64;cache.softwareFrames=true;
  const deliver=(tick,index,extra={})=>cache._receive({type:'packet',revision:cache.revision,tick,deliveryId:tick+1,
    packet:{tick,byteLength:size.byteLength,compileMs:1,compatibility:[],softwareFrames:true,...extra}},cache.workers[index]);
  return {cache,sent,deliver,size};
}

test('cold software admission starts only resident ticks and uses the admitted workers',async()=>{
  const {cache,sent,deliver}=controlled();
  try{
    const prepared=cache.prepareRange(Array.from({length:24},(_,i)=>i),{replacePending:true});await Promise.resolve();
    assert.deepEqual([...cache.pending.keys()],[0,1,2]);assert.equal(cache.stats.suppressedPrefetchFrames,21);
    assert.deepEqual(sent.map(messages=>messages.find(message=>message.type==='prepare')?.ticks),[[0],[1],[2]]);
    for(let tick=0;tick<3;tick++)deliver(tick,tick);
    await prepared;
    for(let tick=0;tick<3;tick++)assert.ok(cache.has(tick));
  }finally{cache.dispose();}
});

test('measured reduced software packets expand lookahead and retain their estimate through view retention',async()=>{
  const {cache,sent,deliver,size}=controlled({frames:1.1}),reduced=softwareFrameSize(cache.report,{quality:.5}).byteLength;
  try{
    const cold=cache.prepareRange([0,1,2,3],{replacePending:true});await Promise.resolve();
    assert.deepEqual([...cache.pending.keys()],[0],'Cold preparation follows the full-quality footprint.');
    deliver(0,0,{byteLength:reduced});await cold;
    const warm=cache.prepareRange([0,1,2,3],{replacePending:true});await Promise.resolve();
    assert.deepEqual([...cache.pending.keys()],[1,2,3],'Measured quality pressure must admit the smaller working set.');
    assert.deepEqual(sent.map(messages=>messages.filter(message=>message.type==='prepare').at(-1).ticks),[[3],[1],[2]]);
    for(const tick of [1,2,3])deliver(tick,tick%3,{byteLength:reduced});await warm;
    assert.ok(cache.bufferedAhead(0,4));assert.ok(cache.stats.bytes<=size.byteLength*1.1);
    cache.invalidate({retainDocument:true,retainTicks:new Set([0])});
    const retained=cache.prepareRange([4,5,6,7],{replacePending:true});await Promise.resolve();
    assert.deepEqual([...cache.pending.keys()],[4,5,6,7]);
    for(const tick of [4,5,6,7])deliver(tick,tick%3,{byteLength:reduced});await retained;
  }finally{cache.dispose();}
});

test('backend switches cannot reuse the other packet format for lookahead admission',async()=>{
  const {cache,deliver}=controlled();cache.softwareFrames=false;
  try{
    const vector=cache.prepareRange([0]);await Promise.resolve();deliver(0,0,{softwareFrames:false,byteLength:64,
      compatibility:[{artworkKey:'vector',bitmap:{width:1,height:1,close(){}}}]});await vector;
    cache._mirrorAvailable=true;cache.updateView({softwareFrames:true});
    const software=cache.prepareRange(Array.from({length:24},(_,i)=>i),{replacePending:true});await Promise.resolve();
    assert.deepEqual([...cache.pending.keys()],[0,1,2],'Small retained vectors cannot overfill a cold software queue.');
    for(let tick=0;tick<3;tick++)deliver(tick,tick);await software;
    cache.updateView({softwareFrames:false});
    const vectors=cache.prepareRange(Array.from({length:24},(_,i)=>i),{replacePending:true});await Promise.resolve();
    assert.equal(cache.pending.size,24,'Large retained software frames cannot throttle unknown vector packets.');
    for(let tick=0;tick<24;tick++)deliver(tick,Math.floor(tick/8)%3,{softwareFrames:false,byteLength:64});await vectors;
    assert.equal(cache.cache.size,24);
  }finally{cache.dispose();}
});

test('rolling software windows retain pending owners when shorter runs are selected',async()=>{
  const {cache,sent,deliver}=controlled({frames:9});
  try{
    const first=cache.prepareRange(Array.from({length:9},(_,i)=>i),{replacePending:true});
    const cancelled=assert.rejects(first,{name:'AbortError'});await Promise.resolve();
    assert.deepEqual(sent.map(messages=>messages.find(message=>message.type==='prepare')?.ticks),[[0,1,2],[3,4,5],[6,7,8]]);
    sent.forEach(messages=>{messages.length=0;});
    const second=cache.prepareRange([3,4,9],{replacePending:true});await Promise.resolve();await cancelled;
    assert.deepEqual(sent.map(messages=>messages.find(message=>message.type==='retain')?.ticks),[[],[3,4],[]]);
    assert.deepEqual(sent[0].find(message=>message.type==='prepare').ticks,[9]);
    assert.equal(cache.pending.get(3).workerIndex,1);assert.equal(cache.pending.get(4).workerIndex,1);
    deliver(3,1);deliver(4,1);deliver(9,0);await second;
    assert.deepEqual([...cache.cache.keys()],[3,4,9]);
  }finally{cache.dispose();}
});

test('late cancelled software delivery cannot settle a tick rerouted to another worker',async()=>{
  const {cache,sent,deliver}=controlled({frames:9});let closed=0;
  try{
    const first=cache.prepareRange(Array.from({length:9},(_,i)=>i),{replacePending:true});
    const cancelled=assert.rejects(first,{name:'AbortError'});await Promise.resolve();
    const away=cache.prepareRange([20],{replacePending:true});const awayCancelled=assert.rejects(away,{name:'AbortError'});
    await Promise.resolve();await cancelled;
    const current=cache.prepareRange([3],{replacePending:true});await Promise.resolve();await awayCancelled;
    assert.equal(cache.pending.get(3).workerIndex,0);
    sent.forEach(messages=>{messages.length=0;});
    deliver(3,1,{compatibility:[{bitmap:{width:1,height:1,close(){closed++;}}}]});
    assert.equal(closed,1);assert.equal(cache.has(3),false);assert.ok(cache.pending.has(3));
    assert.equal(sent[1].at(-1).type,'packet-ack','An abandoned producer must still release its delivery slot.');
    deliver(3,0);await current;assert.ok(cache.has(3));
  }finally{cache.dispose();}
});

test('software footprint matches packet density across scale and texture limits',async()=>{
  for(const scale of [.25,1,1.49,3]){
    const report=createDemo();report.keyframes[0].camera={x:200,y:100,scale:.7,angle_rad:.25};
    const size=softwareFrameSize(report,{scale});
    for(const cameraEnabled of [true,false]){
      const packet=await compilePlaybackPacket(report,0,{scale,softwareFrames:true,cameraEnabled});
      assert.equal(packet.byteLength,size.byteLength);
    }
  }
  const large=softwareFrameSize({canvas_width:20000,canvas_height:10000},{scale:2});
  assert.equal(large.pixelWidth,8192);assert.equal(large.pixelHeight,4096);
});

test('actual software workers preserve exact packets across small and wrapped windows',async()=>{
  const report=createDemo(),size=softwareFrameSize(report),preparedBy=new Set();let created=0;
  const workerFactory=()=>{
    const worker=new Worker(new URL('./playback-node-worker.mjs',import.meta.url)),index=created++;
    return {postMessage(message){if(message.type==='prepare')preparedBy.add(index);worker.postMessage(message);},terminate:()=>worker.terminate(),
      addEventListener:(type,handler)=>worker.on(type,data=>handler(type==='message'?{data}:data))};
  };
  const cache=new PlaybackCache({workerCount:3,maxBytes:size.byteLength*3,workerFactory});
  try{
    cache.load(report,{softwareFrames:true});
    for(const ticks of [[0,1,2],[1,2,3],[23,0,1]]){
      await cache.prepareRange(ticks,{replacePending:true});
      for(const tick of ticks){
        const actual=cache.get(tick),expected=await compilePlaybackPacket(report,tick,{softwareFrames:true});
        assert.ok(actual,`Missing tick ${tick}`);
        for(const key of ['frame','uids','transforms','byteLength'])assert.deepEqual(actual[key],expected[key],`${key} at ${tick}`);
      }
    }
    assert.equal(preparedBy.size,3);assert.equal(cache.pending.size,0);assert.ok(cache.stats.bytes<=cache.maxBytes);
  }finally{cache.dispose();}
});
