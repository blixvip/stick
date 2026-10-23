import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackRasterCache} from '../src/playback-raster-cache.mjs';
const bitmap=()=>({width:2,height:2,closed:0,close(){this.closed++;}});
test('worker raster reuse gives packets independent owners and evicts within budget',async()=>{
  const cache=new PlaybackRasterCache({maxBytes:32,clone:async()=>bitmap()}),originals=[];
  const rasterize=()=>{const b=bitmap();originals.push(b);return b;};
  const a=await cache.packetBitmap('a',rasterize),b=await cache.packetBitmap('a',rasterize);
  assert.notEqual(a,b);a.close();assert.equal(b.closed,0);assert.equal(originals.length,1);
  await cache.packetBitmap('b',rasterize);await cache.packetBitmap('a',rasterize);await cache.packetBitmap('c',rasterize);
  assert.equal(originals[1].closed,1);assert.equal(originals[0].closed,0);assert.equal(cache.bytes,32);
  assert.equal(cache.hits,2);cache.dispose();cache.dispose();assert.equal(originals[0].closed,1);assert.equal(b.closed,0);
  await assert.rejects(cache.packetBitmap('a',rasterize),{name:'AbortError'});
});
test('oversized and unidentified rasters pass ownership directly without cache growth',async()=>{
  const cache=new PlaybackRasterCache({maxBytes:8,clone:()=>{throw Error('Should not clone');}}),a=bitmap();
  assert.equal(await cache.packetBitmap('a',()=>a),a);assert.equal(cache.bytes,0);cache.dispose();assert.equal(a.closed,0);
});
test('invalidation during an asynchronous clone closes both owners',async()=>{
  let resolve;const original=bitmap(),packet=bitmap(),cache=new PlaybackRasterCache({clone:()=>new Promise(r=>resolve=r)});
  const pending=cache.packetBitmap('a',()=>original);cache.dispose();resolve(packet);
  await assert.rejects(pending,{name:'AbortError'});assert.equal(original.closed,1);assert.equal(packet.closed,1);assert.equal(cache.bytes,0);
});

test('a repeated frame larger than the cache retains hits instead of cycling every raster',async()=>{
  const cache=new PlaybackRasterCache({maxBytes:32,clone:async()=>bitmap()}),counts=new Map();
  const render=key=>()=>{counts.set(key,(counts.get(key)||0)+1);return bitmap();};
  for(let frame=0;frame<5;frame++){
    cache.beginFrame();
    for(const key of ['a','b','c']){const packet=await cache.packetBitmap(key,render(key));packet.close();assert.ok(cache.bytes<=32);}
  }
  assert.equal(counts.get('a'),1);assert.equal(counts.get('b'),1);assert.equal(counts.get('c'),5);assert.equal(cache.hits,8);
  // A different scene can replace old entries after one frame of non-use.
  for(let frame=0;frame<2;frame++){cache.beginFrame();for(const key of ['d','e'])(await cache.packetBitmap(key,render(key))).close();}
  assert.deepEqual([...cache.entries.keys()],['d','e']);cache.dispose();assert.equal(cache.bytes,0);
});

test('frame admission bypasses oversized incoming artwork without evicting later hits',async()=>{
  const cache=new PlaybackRasterCache({maxBytes:32,clone:async()=>bitmap()});
  cache.beginFrame();await cache.packetBitmap('keep',bitmap);
  const kept=cache.entries.get('keep');cache.beginFrame();
  const incoming={...bitmap(),width:4};assert.equal(await cache.packetBitmap('incoming',()=>incoming),incoming);
  await cache.packetBitmap('keep',()=>{throw new Error('Lost a later frame hit');});
  assert.equal(kept.closed,0);assert.equal(cache.bytes,16);cache.clear();assert.equal(kept.closed,1);
  cache.beginFrame();await cache.packetBitmap('replacement',bitmap);assert.equal(cache.bytes,16);cache.dispose();incoming.close();
});

test('software composition borrows retained originals without cloning or transferring them',()=>{
  const cache=new PlaybackRasterCache({maxBytes:32,clone:()=>{throw new Error('A software draw must not clone artwork');}}),original=bitmap();
  cache.beginFrame();
  assert.equal(cache.consumeBitmap('a',()=>original,source=>source),original);
  cache.beginFrame();
  assert.equal(cache.consumeBitmap('a',()=>{throw new Error('Repainted retained artwork');},source=>source.closed),0);
  assert.equal(cache.hits,1);assert.equal(cache.misses,1);assert.equal(original.closed,0);
  cache.dispose();assert.equal(original.closed,1);
});

test('software composition closes temporary originals after successful and failed draws',()=>{
  const cache=new PlaybackRasterCache({maxBytes:8}),a=bitmap(),b=bitmap();
  cache.consumeBitmap('a',()=>a,source=>assert.equal(source.closed,0));
  assert.equal(a.closed,1);assert.equal(cache.bytes,0);
  assert.throws(()=>cache.consumeBitmap('b',()=>b,()=>{throw new Error('Draw failed');}),/Draw failed/);
  assert.equal(b.closed,1);cache.dispose();
  assert.throws(()=>cache.consumeBitmap('a',bitmap,()=>{}),{name:'AbortError'});
});

test('software admission reserves retained hits before allocating another capture',()=>{
  const cache=new PlaybackRasterCache({maxBytes:32});cache.beginFrame();
  assert.equal(cache.canRetain('held',16),true);
  cache.consumeBitmap('held',bitmap,()=>{});
  const held=cache.entries.get('held');cache.beginFrame();
  assert.equal(cache.canRetain('held',64),true,'An existing bitmap needs no new allocation');
  assert.equal(cache.canRetain('new',32),false,'A new capture would consume protected artwork headroom');
  assert.equal(cache.canRetain('new',16),true);
  cache.consumeBitmap('new',bitmap,()=>{});
  assert.equal(cache.canRetain('churn',16),false);
  assert.equal(held.closed,0);assert.equal(cache.bytes,32);
  cache.dispose();assert.equal(held.closed,1);
});
