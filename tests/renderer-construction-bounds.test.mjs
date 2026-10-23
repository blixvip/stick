import test from 'node:test';
import assert from 'node:assert/strict';
import {objectBounds} from '../src/renderer-geometry.mjs';

const line = (thickness, length=100) => ({type:'line',thickness,length,
  points:[{x:20,y:30},{x:20+length,y:30+length}],seg:{segment_kind:'squareLine'},obj:{scale:1}});

test('invisible construction endpoints do not enlarge artwork rasters',()=>{
  const visible=line(10), control=line(0,1e6), before=structuredClone(control);
  assert.deepEqual(objectBounds([visible,control]),objectBounds([visible]));
  assert.deepEqual(control,before,'bounds must preserve editable topology and pose');
  assert.deepEqual(objectBounds([control]),{x:0,y:0,width:1,height:1});
});

test('visible strokes and figure/branch outlines still include distant endpoints',()=>{
  for(const control of [line(.01,1e6),{...line(0,1e6),outline:2},
    {...line(0,1e6),fig:{segment_decode:{global_style:{u28:0x40000000}}}}])
    assert.ok(objectBounds([line(10),control]).width>1e6);
});

test('zero-width filled artwork retains its area',()=>{
  const circle={...line(0),type:'circle',start:{x:0,y:0},end:{x:100,y:0},length:100,
    seg:{segment_kind:'circleFill'}};
  const polygon={type:'poly',points:[{x:0,y:0},{x:100,y:0},{x:0,y:100}]};
  assert.ok(objectBounds([circle]).width>=100);
  assert.ok(objectBounds([polygon]).height>=100);
});
