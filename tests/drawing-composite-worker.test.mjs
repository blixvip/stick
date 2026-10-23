import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDrawingComposite} from '../src/drawing-composite-transport.mjs';
import {assembleTileBlobBytes,TILE_BLOB_PREFIX} from '../src/drawing-tile-codec.mjs';
import {DrawingTileProvider} from '../src/drawing-provider.mjs';

test('native drawing preflight retains one restored snapshot until capture and preserves ordinary fill',async()=>{
  const previousSelf=globalThis.self,previousCanvas=globalThis.OffscreenCanvas,prepare=DrawingTileProvider.prototype.prepare;
  const messages=[];let prepared=0,allocations=0,bitmaps=0,id=0;
  globalThis.self={postMessage(message){messages.push(message);}};
  globalThis.OffscreenCanvas=class {
    constructor(width,height){allocations++;this.width=width;this.height=height;this.context={canvas:this,setTransform(){},isContextLost(){return false;},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};}};}
    getContext(){return this.context;}
    transferToImageBitmap(){bitmaps++;return {width:this.width,height:this.height,close(){}};}
  };
  DrawingTileProvider.prototype.prepare=function(...args){prepared++;return prepare.apply(this,args);};
  try{
    await import('../src/drawing-composite-worker.mjs');
    const request=async(kind,payload={})=>{
      const current=++id;await self.onmessage({data:{id:current,kind,...payload}});
      const reply=messages.find(message=>message.id===current);assert.ok(reply);
      if(reply.error)throw Object.assign(new Error(reply.error),{code:reply.code});
      return reply;
    };
    await request('preview-warm');
    assert.equal(allocations,0);assert.equal(prepared,0,'Warming loads capture modules without a snapshot, surface or drawing owner.');
    await assert.rejects(request('preview-raster',{width:16,height:16,matrix:[1,0,0,1,0,0],maxBytes:1024*1024}),/Missing drawing composite snapshot/);
    const fig={figure_type_id:1,_styk:{drawing:{version:2,celId:'cel',revision:3}},image_assets:[{styk_tiles:TILE_BLOB_PREFIX+Buffer.from(assembleTileBlobBytes([])).toString('base64')}]};
    const items=[{type:'image',slot:0,opacity:1,obj:{unique_id:1,scale:1},fig}];
    await sendDrawingComposite({request},items,{maxBytes:1024*1024});
    const options={width:16,height:16,matrix:[1,0,0,1,0,0],maxBytes:1024*1024,nativePadding:true};
    const plan=await request('preview-raster-plan',options);
    const repeatedPlan=await request('preview-raster-plan',options);
    assert.equal(repeatedPlan.requiredBytes,plan.requiredBytes,'Repeated preflight reuses already-restored references.');
    assert.ok(Number.isSafeInteger(plan.requiredBytes));assert.ok(plan.requiredBytes>16*16*8);
    assert.equal(prepared,0);assert.equal(allocations,0,'Preflight with no active filters allocates no graphics resources.');
    const result=await request('preview-raster',{...options,maxBytes:plan.requiredBytes});
    assert.equal(result.bitmap.width,16);assert.equal(result.bitmap.height,16);assert.equal(result.workingBytes,plan.requiredBytes);
    assert.equal(prepared,1);assert.equal(bitmaps,1,'The same restored image/figure references survive preflight.');
    result.bitmap.close();
    await assert.rejects(request('preview-raster',options),/Missing drawing composite snapshot/);
    await sendDrawingComposite({request},[],{maxBytes:1024*1024});
    const fill=await request('composite',{bounds:{x:0,y:0,width:1,height:1},matrix:options.matrix,maxBytes:1024*1024});
    assert.equal(fill.source.byteLength,4,'Existing fill protocol still consumes its original compact snapshot.');
  }finally{DrawingTileProvider.prototype.prepare=prepare;globalThis.self=previousSelf;globalThis.OffscreenCanvas=previousCanvas;}
});
