import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackUploadWarmup,PlaybackUploadAhead} from '../src/playback-upload.mjs';

function fixture(capacity=3) {
  const resident=new Set(),submitted=[],fences=[];
  const renderer={preparedFrames:{canWarm:()=>resident.size<capacity},
    device:{queue:{onSubmittedWorkDone:()=>new Promise(resolve=>fences.push(resolve))}},
    hasPreparedFrame:key=>resident.has(key),backgroundsReady:()=>true,
    prepareFrame:packet=>{resident.add(packet.key);submitted.push(packet.key);}};
  return {renderer,resident,submitted,fences,packets:[0,1,2].map(key=>({key:String(key),frame:{}}))};
}
test('startup uploads one packet per turn then waits for GPU completion',async()=>{
  const f=fixture();let ready=0;const warmup=new PlaybackUploadWarmup(()=>ready++),options={report:{}};
  for(let i=0;i<3;i++){assert.equal(warmup.step(f.renderer,f.packets,options),false);assert.equal(f.submitted.length,i+1);}
  assert.equal(warmup.step(f.renderer,f.packets,options),false);assert.equal(f.fences.length,1);
  assert.equal(warmup.step(f.renderer,f.packets,options),false);assert.equal(f.fences.length,1,'one queue fence');
  f.fences[0]();await Promise.resolve();assert.equal(ready,1);assert.equal(warmup.step(f.renderer,f.packets,options),true);
});
test('limited residency, pending backgrounds and cancellation cannot evict or deadlock startup',async()=>{
  const f=fixture(1),warmup=new PlaybackUploadWarmup(),options={report:{}};
  f.renderer.backgroundsReady=()=>false;assert.equal(warmup.step(f.renderer,f.packets,options),false);assert.equal(f.submitted.length,0);
  f.renderer.backgroundsReady=()=>true;warmup.step(f.renderer,f.packets,options);warmup.step(f.renderer,f.packets,options);
  assert.deepEqual(f.submitted,['0']);f.fences[0]();await Promise.resolve();assert.equal(warmup.step(f.renderer,f.packets,options),true);
  warmup.reset();assert.equal(warmup.step(f.renderer,f.packets,options),false);
  warmup.reset();f.fences[1]();await Promise.resolve();assert.equal(warmup.fence,null,'obsolete completion cannot restart playback');
  assert.equal(warmup.step({},f.packets,options),true,'software playback keeps its established path');
});

test('upload ahead stops stale work and protects the complete requested window',async()=>{
  const yields=[],prepared=[],protectedWindows=[],resident=new Set(['0']);let cancelled=0,current=true;
  const cache={warming:null,has:key=>resident.has(key),cancelWarm(){if(this.warming)cancelled++;this.warming=null;},
    beginWarm(packet,options,protectedKeys){protectedWindows.push([...protectedKeys]);return this.warming={packet,steps:0};},
    stepWarm(warm){if(++warm.steps===2){resident.add(warm.packet.key);prepared.push(warm.packet.key);this.warming=null;return true;}return false;}};
  const upload=new PlaybackUploadAhead({yieldControl:()=>new Promise(resolve=>yields.push(resolve))});
  const packets=[0,1,2].map(n=>({key:String(n)}));
  upload.update({preparedFrames:cache},packets,{},()=>current);
  assert.equal(cache.warming,null,'presentation returns before uploads start');
  yields.shift()();await Promise.resolve();assert.equal(cache.warming.packet.key,'1');
  current=false;yields.shift()();await Promise.resolve();assert.equal(cancelled,1);assert.deepEqual(prepared,[]);
  current=true;upload.update({preparedFrames:cache},packets,{},()=>true);
  for(let i=0;i<5;i++){yields.shift()();await Promise.resolve();}
  assert.deepEqual(prepared,['1','2']);assert.ok(protectedWindows.every(keys=>keys.join(',')==='0,1,2'));
  upload.reset();assert.equal(cache.warming,null);
});

test('upload ahead reports allocation errors and cancels without replacing the displayed frame',async()=>{
  const errors=[],cache={has:()=>false,cancelWarm(){this.warming=null;},beginWarm(){throw new Error('allocation failed');}};
  const upload=new PlaybackUploadAhead({yieldControl:async()=>{},onError:error=>errors.push(error.message)});
  upload.update({preparedFrames:cache},[{key:'next'}],{},()=>true);
  await Promise.resolve();await Promise.resolve();assert.deepEqual(errors,['allocation failed']);assert.equal(upload.running,false);
  upload.reset();
});
