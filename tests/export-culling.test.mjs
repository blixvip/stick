import test from 'node:test';
import assert from 'node:assert/strict';
import {drawGeometry} from '../src/pivot/geometry.mjs';
import {exportGroupOutside,exportDrawGroups} from '../src/export-frame-core.mjs';

test('off-tile brush advancement preserves native tolerance without touching Canvas',()=>{
  const item=(type,thickness,slot)=>({type,thickness,slot,opacity:1,alpha:1,rgb:[0,0,0],obj:{scale:1},fig:{},
    seg:{segment_kind:type==='circle'?'circleFill':'line'},start:{x:0,y:0},end:{x:10,y:0},length:10,points:[{x:0,y:0},{x:10,y:0},{x:5,y:5}]});
  const shapes=[item('line',.20005,1),item('line',.2,2),item('poly',0,3),item('circle',1.00005,4),item('line',1,5)];
  const reference={width:1},culled={width:1};
  const context=new Proxy({}, {get:()=>()=>{}});
  const forbidden=new Proxy({}, {get(){throw new Error('Culled primitive accessed Canvas');},set(){throw new Error('Culled primitive painted Canvas');}});
  drawGeometry(context,{drawables:shapes,strokeState:reference});
  drawGeometry(forbidden,{drawables:shapes,strokeState:culled,skipPaint:true});
  assert.equal(culled.width,reference.width);assert.equal(culled.width,Math.fround(1.00005));
  const transparent={...shapes[0],opacity:.5};
  drawGeometry(forbidden,{drawables:[transparent],strokeState:culled,skipPaint:true});
  assert.equal(culled.width,reference.width,'Isolated brushes do not alter shared state');
});

test('tile exclusion handles rotation, translation, coverage guards and unknown bounds',()=>{
  const plan={matrix:[0,2,-2,0,100,0],width:100,height:100};
  assert.equal(exportGroupOutside({x:0,y:0,width:10,height:10},plan),false);
  assert.equal(exportGroupOutside({x:60,y:0,width:10,height:10},plan),true);
  assert.equal(exportGroupOutside({x:50,y:0,width:1,height:1},plan),false);
  assert.equal(exportGroupOutside(null,plan),false);
});

test('unverified image extents retain full drawing and square outline caps expand bounds',()=>{
  const groups=exportDrawGroups({drawables:[
    {slot:1,type:'image',asset:{width:1,height:1},obj:{},seg:{}},
    {slot:2,type:'line',obj:{scale:1},thickness:4,points:[{x:0,y:0},{x:10,y:10}],seg:{segment_kind:'squareLine'},
      fig:{segment_decode:{global_style:{u28:new Uint32Array(new Float32Array([100]).buffer)[0]}}}},
  ]},{});
  assert.equal(groups.length,2);assert.equal(groups[0].bounds,null);
  assert.ok(groups[1].bounds.x < -200 && groups[1].bounds.y < -200);
});
