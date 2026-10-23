import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitsVfxSurface,vfxSurfaceTiles} from '../src/vfx-surface.mjs';

test('effect tiles cover visible output exactly once with bounded neighboring samples',()=>{
  const rect={x:-100,y:-100,width:9200,height:7200},canvas={width:9000,height:7000};
  let area=0,previous=null;
  for(const tile of vfxSurfaceTiles(rect,canvas,100)){
    assert.ok(fitsVfxSurface(tile.width,tile.height));
    const out=tile.output;area+=out.width*out.height;
    assert.equal(tile.x,out.x-100);assert.equal(tile.y,out.y-100);
    assert.equal(tile.width,out.width+200);assert.equal(tile.height,out.height+200);
    if(previous&&out.y===previous.y)assert.equal(out.x,previous.x+previous.width);
    previous=out;
  }
  assert.equal(area,canvas.width*canvas.height);
  assert.equal(fitsVfxSurface(4096,4096),true);assert.equal(fitsVfxSurface(4097,1),false);
  assert.equal(fitsVfxSurface(4096,4096,2048),false);
});

test('impossible halos fail explicitly before yielding an allocation',()=>{
  for(const pad of [2048,NaN,-1,2.5])assert.throws(()=>vfxSurfaceTiles({x:0,y:0,width:9000,height:10},{width:9000,height:10},pad).next(),{code:'vfx_surface_budget'});
});
