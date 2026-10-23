import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePreviewRaster,planPreviewRaster} from '../src/renderer-raster-capture.mjs';
import {RasterSurfacePool} from '../src/raster-surfaces.mjs';
import {createVfx} from '../src/vfx.mjs';
import {VfxGPU,releaseVfxGPU} from '../src/vfx-gpu.mjs';

function graphics(){
  return new Proxy({getParameter(){return 4096;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){}};}},{get(target,key){return target[key]??(()=>({}));}});
}

function fixture(run){
  const previous=globalThis.OffscreenCanvas,gpuRun=VfxGPU.prototype.run;
  const canvases=[],bitmaps=[];
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;canvases.push(this);}
    getContext(kind,options){
      if(kind==='webgl2')return this.gl??=graphics();
      if(this.context)return this.context;
      this.options=options;let matrix=[1,0,0,1,0,0];
      return this.context=new Proxy({canvas:this,isContextLost(){return false;},getContextAttributes(){return {willReadFrequently:options?.willReadFrequently===true};},
        setTransform(...values){matrix=values.length===1?[values[0].a,values[0].b,values[0].c,values[0].d,values[0].e,values[0].f]:values;},
        getTransform(){return Object.fromEntries(['a','b','c','d','e','f'].map((key,index)=>[key,matrix[index]]));},
      },{get(target,key){return target[key]??(()=>{});}});
    }
    transferToImageBitmap(){const bitmap={width:this.width,height:this.height,closed:0,close(){this.closed++;}};bitmaps.push(bitmap);return bitmap;}
  };
  VfxGPU.prototype.run=function(source){this.canvas.width=source.width;this.canvas.height=source.height;return this.canvas;};
  try{releaseVfxGPU();run({canvases,bitmaps});}
  finally{releaseVfxGPU();VfxGPU.prototype.run=gpuRun;globalThis.OffscreenCanvas=previous;}
}

const options={width:16,height:16,matrix:[1,0,0,1,.37,.61],maxBytes:1024*1024,nativePadding:true};
function drawing(owner){
  const effect=createVfx('blur','drawing');effect.params.mode=1;
  const fig={_styk:{drawing:{version:2,celId:'cel',revision:3}}};
  return {geometry:{drawables:[{type:'image',slot:0,opacity:1,alpha:1,rgb:[0,0,0],obj:{scale:1,_stykVfx:{figure:[effect]}},seg:{},fig}]},
    resources:{drawing(){return {id:'cel',revision:3,store:{}};},rasterSurface(width,height,policy){assert.equal(width,16);assert.equal(height,16);assert.deepEqual(policy,{hasImages:true});return owner;}}};
}

test('single filtered drawings reuse their prepared accelerated pool and release its pixels',()=>fixture(({bitmaps})=>{
  const owner=new RasterSurfacePool(),{geometry,resources}=drawing(owner);
  try{
    const result=capturePreviewRaster(geometry,{...options,resources});
    assert.equal(result.tileCount,1);assert.equal(owner.context.getContextAttributes().willReadFrequently,false);
    assert.equal(owner.surface.width,1);assert.equal(owner.surface.height,1);assert.equal(owner.busy,false);
    owner.dispose();assert.equal(result.bitmap.closed,0,'Provider disposal preserves transferred pixels.');
    result.bitmap.close();assert.equal(bitmaps[0].closed,1);
    let requests=0;
    const path=capturePreviewRaster({drawables:[]},{...options,resources:{rasterSurface(){requests++;throw Error('Unexpected drawing pool');}}});
    path.bitmap.close();assert.equal(requests,0,'Native paths keep the software capture owner.');
  }finally{owner.dispose();}
}));

test('drawing capture releases a failed lease and can recover without publishing pixels',()=>fixture(({bitmaps})=>{
  const owner=new RasterSurfacePool(),{geometry,resources}=drawing(owner),acquire=owner.acquire;
  let releases=0,disposals=0;
  const release=owner.release,dispose=owner.dispose;
  owner.acquire=()=>{throw Error('Drawing lease failed');};
  owner.release=function(){releases++;return release.call(this);};
  owner.dispose=function(){disposals++;return dispose.call(this);};
  assert.throws(()=>capturePreviewRaster(geometry,{...options,resources}),/Drawing lease failed/);
  assert.equal(releases,1);assert.equal(disposals,1);assert.equal(bitmaps.length,0);
  owner.acquire=acquire;
  const recovered=capturePreviewRaster(geometry,{...options,resources});
  owner.dispose();recovered.bitmap.close();assert.equal(bitmaps[0].closed,1);
}));

test('drawing capture closes a completed bitmap exactly once when lease cleanup fails',()=>fixture(({bitmaps})=>{
  const owner=new RasterSurfacePool(),{geometry,resources}=drawing(owner),release=owner.release;
  owner.release=function(){release.call(this);throw Error('Drawing lease cleanup failed');};
  assert.throws(()=>capturePreviewRaster(geometry,{...options,resources}),/Drawing lease cleanup failed/);
  assert.equal(bitmaps.length,1);assert.equal(bitmaps[0].closed,1);
  owner.release=release;
  const recovered=capturePreviewRaster(geometry,{...options,resources});
  owner.dispose();recovered.bitmap.close();assert.equal(bitmaps[1].closed,1);
}));

test('drawing viewport pressure rejects before GPU pixels, preparation or a pool lease',()=>{
  const previous=globalThis.OffscreenCanvas;
  let allocations=0,leases=0;
  globalThis.OffscreenCanvas=class {constructor(){allocations++;throw Error('Unexpected allocation');}};
  try{
    const {geometry,resources}=drawing({acquire(){leases++;throw Error('Unexpected lease');}});
    const admitted=planPreviewRaster(geometry,{...options,allowDrawings:true});
    assert.equal(admitted.tileCount,1);assert.equal(admitted.nativePadding,true);
    const pressure={...options,maxBytes:admitted.workingBytes-1};
    assert.throws(()=>planPreviewRaster(geometry,{...pressure,allowDrawings:true}),error=>error.code==='preview_raster_budget');
    assert.throws(()=>capturePreviewRaster(geometry,{...pressure,resources}),error=>error.code==='preview_raster_budget');
    const ordinary=planPreviewRaster(geometry,{...pressure,allowDrawings:true,nativePadding:false});
    assert.ok(ordinary.workingBytes<=pressure.maxBytes,'Generic/onion drawing captures keep bounded pressure admission.');
    assert.equal(allocations,0);assert.equal(leases,0);
  }finally{globalThis.OffscreenCanvas=previous;}
});
