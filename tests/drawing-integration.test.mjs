import test from 'node:test';
import assert from 'node:assert/strict';
import {TileStore} from '../src/drawing-tiles.mjs';
import {DrawingStroke,lassoMask,maskValue,rectMask,combineMasks} from '../src/drawing-pixels.mjs';
import {StrokePath} from '../src/drawing-brush.mjs';
import {captureMaskSelection,selectionStores} from '../src/drawing-lasso.mjs';
import {selectionMatrix,transformSelectedPixels} from '../src/drawing-selection.mjs';

test('large polygon selections clip new brush modes without allocating an empty mask',()=>{
  const points=[{x:-100000,y:-100000},{x:100000,y:-100000},{x:100000,y:100000},{x:-100000,y:100000}],mask=lassoMask(points);
  assert.equal(mask.mask,undefined);assert.equal(maskValue(mask,0,0),1);assert.equal(maskValue(mask,100001,0),0);
  const store=new TileStore(),brush=new DrawingStroke(store,{size:8,roundness:.3,angle:45,mask});brush.sample({x:0,y:0});brush.finish();assert.ok(store.size<=4);assert.ok(store.pixel(0,0)[3]);
});
test('combined masks capture exact translucent pixels and flip through the sparse transform',()=>{
  const store=new TileStore();store.writeRect(-2,0,4,1,new Uint8ClampedArray([20,40,60,1,80,90,100,127,5,6,7,255,8,9,10,255]));
  const mask=combineMasks(rectMask({x:-2,y:0,width:2,height:1}),rectMask({x:0,y:0,width:2,height:1}),'add');
  const capture=captureMaskSelection(store,mask),{source}=selectionStores(store,capture.tiles);
  const matrix=selectionMatrix({cx:0,cy:.5,dx:0,dy:0,scale:1,angle:0,fx:-1});
  const changes=transformSelectedPixels(store,{source,matrix,filter:'nearest'});assert.ok(changes.length);
  assert.deepEqual(store.pixel(1,0),[20,40,60,1]);assert.deepEqual(store.pixel(0,0),[80,90,100,127]);
});
test('pressure-aware smoothed paths retain pen tilt through the final dab',()=>{
  const dabs=[],path=new StrokePath({size:100,pressureSize:true,stabilization:.6},p=>dabs.push(p));
  for(let i=0;i<200;i++)path.sample({x:i,y:20,pressure:.05,time:i,ax:.6,ay:.8});path.finish();
  assert.ok(dabs.length>100);assert.ok(dabs.every(p=>Math.abs(p.ax-.6)<1e-8&&Math.abs(p.ay-.8)<1e-8));assert.equal(dabs.at(-1).x,199);
});
