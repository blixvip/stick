import assert from 'node:assert/strict';
import test from 'node:test';
import {primitiveOutsideRasterClip as outside} from '../src/pivot/raster-clip.mjs';
const clip = {x:0, y:0, width:100, height:100, guard:2};
const points = coordinates => coordinates.map(([x,y]) => ({x,y}));

test('raster clipping retains crossing strokes, square caps, curve excursions and filtering guards', () => {
  const line = coordinates => ({type:'line', points:points(coordinates)});
  assert.equal(outside(line([[-40,50],[140,50]]),clip,1),false);
  assert.equal(outside(line([[108,20],[140,50]]),clip,10),false);
  assert.equal(outside(line([[110,20],[140,50]]),clip,10),true);
  assert.equal(outside(line([[200,0],[50,50],[200,100]]),clip,1),false);
  assert.equal(outside(line([[102,20],[102,50]]),clip,0),false);
  assert.equal(outside(line([[103,20],[103,50]]),clip,0),true);
});

test('raster clipping preserves surrounding polygons and complete stroked or filled circles', () => {
  assert.equal(outside({type:'poly', points:points([[-50,-50],[150,-50],[150,150],[-50,150]])},clip,0),false);
  assert.equal(outside({type:'poly', points:points([[200,0],[250,0],[250,100]])},clip,0),true);
  const circle = {type:'circle', start:{x:105,y:50}, end:{x:125,y:50}, length:20};
  assert.equal(outside(circle,clip,8),false);
  assert.equal(outside(circle,clip,0),true);
  assert.equal(outside({...circle,length:-20},clip,20),false);
});

test('unsupported, empty and non-finite geometry remains on the established painter path', () => {
  assert.equal(outside({type:'image'},clip,1),false);
  assert.equal(outside({type:'text'},clip,1),false);
  assert.equal(outside({type:'line',points:[]},clip,1),false);
  assert.equal(outside({type:'line',points:points([[NaN,0],[200,0]])},clip,1),false);
  assert.equal(outside({type:'line',points:points([[200,0],[300,0]])},clip,NaN),false);
});
