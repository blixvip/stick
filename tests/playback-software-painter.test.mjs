import test from 'node:test';
import assert from 'node:assert/strict';
import {softwareRasterRegion,softwareVisibleBounds,softwareBoundsState} from '../src/playback-software-painter.mjs';

test('software captures retain the exact destination grid and conservative output crop',()=>{
  assert.deepEqual(softwareRasterRegion({x:10,y:20,width:30,height:40},[1,0,0,1,.25,.75],100,100),
    {x:0,y:0,width:64,height:64});
  assert.deepEqual(softwareRasterRegion({x:-100,y:-100,width:300,height:300},[1,0,0,1,0,0],80,60),
    {x:0,y:0,width:80,height:60});
  assert.equal(softwareRasterRegion({x:1000,y:1000,width:20,height:20},[1,0,0,1,0,0],80,60),null);
  assert.equal(softwareRasterRegion(null,[1,0,0,1,0,0],80,60),null);
});

test('software primitive clips conservatively invert all camera and parallax corners',()=>{
  const matrix=[1.2,.8,-.8,1.2,35,-20],bounds=softwareVisibleBounds(matrix,320,240);
  for(const [px,py] of [[-2,-2],[322,-2],[-2,242],[322,242]]){
    const [a,b,c,d,e,f]=matrix,determinant=a*d-b*c;
    const x=(d*(px-e)-c*(py-f))/determinant,y=(-b*(px-e)+a*(py-f))/determinant;
    assert.ok(x>=bounds.x-1e-10&&x<=bounds.x+bounds.width+1e-10);
    assert.ok(y>=bounds.y-1e-10&&y<=bounds.y+bounds.height+1e-10);
  }
  assert.equal(softwareVisibleBounds([0,0,0,0,0,0],320,240),null);
});

test('fully contained software objects skip primitive clips only with conservative output guards',()=>{
  assert.equal(softwareBoundsState({x:10,y:20,width:30,height:40},[1,0,0,1,0,0],100,100),1);
  assert.equal(softwareBoundsState({x:0,y:20,width:30,height:40},[1,0,0,1,0,0],100,100),0);
  assert.equal(softwareBoundsState({x:-100,y:20,width:30,height:40},[1,0,0,1,0,0],100,100),-1);
  assert.equal(softwareBoundsState({x:10,y:20,width:30,height:40},[.8,.6,-.6,.8,50,10],100,100),1);
  assert.equal(softwareBoundsState(null,[1,0,0,1,0,0],100,100),0);
  assert.equal(softwareBoundsState({x:NaN,y:20,width:30,height:40},[1,0,0,1,0,0],100,100),0);
});
