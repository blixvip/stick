import test from 'node:test';
import assert from 'node:assert/strict';
import {orderPoseDrawables} from '../src/pivot/geometry-order.mjs';

const full = g => [...g.polys.filter(s => !s.culled), ...g.segments.filter(s => s.seg.visible !== false)].sort((a,b) => a.z-b.z);
const fixture = () => ({polys:Array.from({length:600},(_,index)=>({type:'poly',index,z:index%13,culled:index%7===0})),
  segments:Array.from({length:20},(_,index)=>({type:'line',index,z:index%13,seg:{visible:index%3!==0}}))});

test('pose ordering matches stable full sorting through crossings, ties and face culling',()=>{
  let old=fixture();old.drawables=full(old);
  for(let pose=0;pose<50;pose++){
    const next={polys:old.polys.map((s,i)=>i%5===pose%5?{...s,z:(i+pose)%13,culled:(i+pose)%7===0}:s),
      segments:old.segments.map((s,i)=>i%3===pose%3?{...s,z:(i+pose)%13,seg:{visible:(i+pose)%4!==0}}:s)};
    const before=[...old.drawables];next.drawables=orderPoseDrawables(next,old);
    assert.deepEqual(next.drawables,full(next));assert.deepEqual(old.drawables,before);old=next;
  }
});

test('compound imported shapes and non-finite orders retain the general builder',()=>{
  const old=fixture();old.drawables=full(old);
  const next=fixture();next.segments[0].seg._sticknodes={kind:'triangle'};
  assert.equal(orderPoseDrawables(next,old),undefined);
  delete next.segments[0].seg._sticknodes;next.polys[0].z=NaN;
  assert.equal(orderPoseDrawables(next,old),undefined);
  next.polys[0].z=0;old.drawables[0]={...old.drawables[0]};
  assert.equal(orderPoseDrawables(next,old),undefined);
});
