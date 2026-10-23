import test from 'node:test';
import assert from 'node:assert/strict';
import {drawGeometry} from '../src/pivot/geometry.mjs';

test('painting a dense figure without effects never serializes its pose', () => {
  let serialized=0, strokes=0;
  const obj={scale:1,unique_id:1,toJSON(){serialized++;return {angles:Array(1000).fill(0)};}};
  const ctx={beginPath(){},moveTo(){},lineTo(){},stroke(){strokes++;},save(){},restore(){}};
  const points=[{x:0,y:0},{x:10,y:0}];
  const drawables=Array.from({length:1000},(_,index)=>({type:'line',slot:0,opacity:1,obj,
    fig:{figure_type_id:1},seg:{segment_id:index+1},points,start:points[0],end:points[1],
    thickness:2,rgb:[0,0,0],alpha:1,bend:0}));
  drawGeometry(ctx,{drawables});
  assert.equal(strokes,1000);
  assert.equal(serialized,0);
});
