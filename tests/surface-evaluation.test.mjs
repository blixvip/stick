import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceEvaluation,surfaceCulled,surfaceOrder,surfaceDepthValues} from '../src/pivot/surfaces.mjs';
test('shared surface evaluation matches individual projections across mirrors, bases and collapsed spans',()=>{
 for(const sign of [-1,0,1])for(const angle of [0,.5,2]){
  const transform=([x,y])=>({x:10+x*Math.cos(angle)-y*Math.sin(angle)*sign,y:20+x*Math.sin(angle)+y*Math.cos(angle)*sign});
  const joints=new Map([[0,transform([0,0])],[1,transform([30,0])],[2,transform([0,30])],[3,transform([20,0])],[4,transform([0,20])],[5,transform([10,15])],[6,{...transform([12,18]),depthOffset:transform([3,2])}]]);
  const evaluate=createSurfaceEvaluation(joints),points=[[0,0],[20,0],[5,10]].map(transform);
  for(const basis of [[0,1,2],[0,1,2],[0,3,4],[0,2,1]])for(const side of ['front','back'])for(const flipped of [false,true]){
   const p={z_order:7,_stykSurface:{basis,side,flipped,depthTest:true,depth:[5,6,5]}};
   const result=evaluate(p,points);assert.equal(result.culled,surfaceCulled(p,points,joints));assert.equal(result.z,surfaceOrder(p,joints));assert.deepEqual(result.depthValues,surfaceDepthValues(p,joints));
  }
 }
});
