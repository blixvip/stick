import test from 'node:test';
import assert from 'node:assert/strict';
import {OnionSurfaceCache, onionLayerEnd, onionLayerKeys} from '../src/onion-surface-cache.mjs';

function fixture(maxBytes=800) {
  const made=[],released=[];
  const cache=new OnionSurfaceCache({maxBytes,create:(w,h)=>{const surface={w,h};made.push(surface);return surface;},dispose:s=>released.push(s)});
  return {cache,made,released};
}
test('onion runs combine complete neighboring frames without crossing live artwork',()=>{
  const ghost=index=>({isOnion:true,onionIndex:index}), live={isOnion:false};
  const entries=[live,ghost(0),ghost(0),ghost(1),live,ghost(2),ghost(3)];
  assert.deepEqual(onionLayerKeys(entries),[0,2]);
  assert.equal(onionLayerEnd(entries,1),4);assert.equal(onionLayerEnd(entries,5),7);
});
test('over-budget ranges have stable admission and never evict a surface during drawing',()=>{
  const {cache,made,released}=fixture();
  for(let render=0;render<20;render++){
    cache.begin([1,2,3,4,5],10,10);
    assert.ok(cache.acquire(1));assert.ok(cache.acquire(2));
    for(const key of [3,4,5])assert.equal(cache.acquire(key),null);
    assert.equal(cache.bytes,800);
  }
  assert.equal(made.length,2);assert.equal(released.length,0);
});
test('scrubbing recycles surfaces but never transfers old validity metadata',()=>{
  const {cache,made,released}=fixture();cache.begin([1,2],10,10);
  const a=cache.acquire(1),b=cache.acquire(2);a.members=['old pose'];
  cache.begin([2,3],10,10);
  assert.equal(cache.acquire(2),b);
  const c=cache.acquire(3);assert.equal(c.surface,a.surface);assert.equal(c.members,undefined);
  assert.equal(made.length,2);assert.equal(released.length,0);
  cache.begin([3],10,10);assert.equal(cache.bytes,400);assert.deepEqual(released,[b.surface]);
});
test('resize, empty ranges, and disposal release every owned surface exactly once',()=>{
  const {cache,made,released}=fixture();cache.begin([1,2],10,10);cache.acquire(1);cache.acquire(2);
  cache.begin([1],20,10);assert.equal(released.length,2);cache.acquire(1);assert.equal(cache.bytes,800);
  cache.begin([],20,10);assert.equal(cache.bytes,0);assert.equal(released.length,3);
  cache.clear();cache.clear();assert.deepEqual(new Set(released),new Set(made));assert.equal(released.length,made.length);
});
test('a single oversized viewport or disabled budget is not silently retained',()=>{
  for(const maxBytes of [0,399]){
    const {cache,made}=fixture(maxBytes);cache.begin([1],10,10);
    assert.equal(cache.acquire(1),null);assert.equal(cache.bytes,0);assert.equal(made.length,0);
  }
});
