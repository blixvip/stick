import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasVfxSource} from '../src/renderer-vfx-vector.mjs';
import {createVfx,activeVfx} from '../src/vfx.mjs';
import {hasDrawableVfx} from '../src/vfx-canvas.mjs';

const glow=id=>createVfx('glow',id);
const line=(obj,extra={})=>({type:'line',slot:0,opacity:1,alpha:1,thickness:4,points:[{x:0,y:0},{x:10,y:0}],start:{x:0,y:0},end:{x:10,y:0},obj,...extra});

test('a figure stack separates from artwork that paints without effects',()=>{
  const obj={unique_id:7,scale:-1.5,_stykVfx:{figure:[glow('a')]}},items=[line(obj),line(obj)];
  const source=canvasVfxSource(items);
  assert.deepEqual(source.stack.map(effect=>effect.id),['a']);
  assert.equal(source.scale,1.5);assert.equal(source.domain,undefined);
  assert.equal(source.items.length,2);
  assert.ok(source.items.every(item=>!hasDrawableVfx(item)),'The separated artwork carries no effects.');
  assert.equal(source.items[0].obj,source.items[1].obj,'Parts keep one shared object, as the painter groups by it.');
  assert.equal(source.items[0].obj.unique_id,7);
  assert.ok(hasDrawableVfx(items[0])&&obj._stykVfx.figure.length===1,'The published geometry is not modified.');
});

test('artwork whose effects cannot be separated keeps the complete painter',()=>{
  const figure={figure:[glow('a')]};
  assert.equal(canvasVfxSource([line({unique_id:1})]),null,'No effects.');
  const disabled={...glow('off'),enabled:false};
  assert.equal(canvasVfxSource([line({unique_id:1,_stykVfx:{figure:[disabled]}})]),null,'Only inactive effects.');
  const translucent={unique_id:1,_stykVfx:figure};
  assert.equal(canvasVfxSource([line(translucent,{opacity:.5})]),null,'Figure opacity composites after its effects.');
  const node={unique_id:1,_stykVfx:{...figure,'*/3':[glow('node')]}};
  assert.equal(canvasVfxSource([line(node)]),null,'A node stack paints inside the figure stack.');
  assert.equal(canvasVfxSource([line({unique_id:1,_stykVfx:figure}),line({unique_id:2,_stykVfx:figure})]),null,'Two objects are two painter groups.');
});

test('a movieclip owner stack separates while its content keeps nested opacity and clips',()=>{
  const owner={opacity:1,effects:[glow('clip')],scale:2,domainBounds:{x:1,y:2,width:30,height:40}};
  const nested={owner:{opacity:.4,effects:[],scale:1},part:3,inner:null};
  const items=[line({unique_id:1},{_movieclipOwner:owner,_movieclipPart:0,opacity:.5}),
    line({unique_id:1},{_movieclipOwner:owner,_movieclipPart:1,_movieclipInner:nested})];
  const source=canvasVfxSource(items);
  assert.deepEqual(source.stack.map(effect=>effect.id),['clip']);
  assert.equal(source.scale,2);assert.equal(source.domain,owner.domainBounds);
  assert.equal(source.items[0]._movieclipOwner,source.items[1]._movieclipOwner,'One owner still isolates the clip once.');
  assert.equal(activeVfx(source.items[0]._movieclipOwner.effects).length,0);
  assert.equal(source.items[0]._movieclipOwner.opacity,1);
  assert.equal(source.items[0].opacity,.5);assert.equal(source.items[1]._movieclipInner,nested);
  assert.equal(owner.effects.length,1,'The published owner is not modified.');
});

test('translucent owners and nested clip effects keep the complete painter',()=>{
  const effects=[glow('clip')];
  assert.equal(canvasVfxSource([line({unique_id:1},{_movieclipOwner:{opacity:.5,effects,scale:1}})]),null);
  assert.equal(canvasVfxSource([line({unique_id:1},{_movieclipOwner:{opacity:1,effects,sceneEffects:[glow('scene')],scale:1}})]),null);
  assert.equal(canvasVfxSource([line({unique_id:1},{_movieclipOwner:{opacity:1,effects:[],scale:1}})]),null,'An owner without effects has nothing to separate.');
  const owner={opacity:1,effects,scale:1};
  assert.equal(canvasVfxSource([line({unique_id:1,_stykVfx:{figure:[glow('child')]}},{_movieclipOwner:owner})]),null,'A child figure stack paints inside the clip.');
  const nested={owner:{opacity:1,effects:[glow('inner')],scale:1},part:0,inner:null};
  assert.equal(canvasVfxSource([line({unique_id:1},{_movieclipOwner:owner,_movieclipInner:nested})]),null);
  const deeper={owner:{opacity:1,effects:[],scale:1},part:0,inner:nested};
  assert.equal(canvasVfxSource([line({unique_id:1},{_movieclipOwner:owner,_movieclipInner:deeper})]),null);
  assert.equal(canvasVfxSource([line({unique_id:1},{_movieclipOwner:owner}),line({unique_id:1},{_movieclipOwner:{...owner}})]),null,'Two owners are two isolation groups.');
});
