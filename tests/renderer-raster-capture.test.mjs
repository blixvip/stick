import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePreviewRaster,planPreviewRaster} from '../src/renderer-raster-capture.mjs';
import {createVfx} from '../src/vfx.mjs';
import {sendDrawingComposite} from '../src/drawing-composite-transport.mjs';
import {applyDocumentChunk} from '../src/document-transport.mjs';

const plan={width:64,height:64,matrix:[1,0,0,1,0,0],maxBytes:128*1024*1024};
const empty=()=>({records:[],items:[]});
async function snapshot(items){
  let result;
  await sendDrawingComposite({async request(kind,{chunk}){assert.equal(kind,'composite-chunk');result=applyDocumentChunk(result,structuredClone(chunk));}},items,{maxBytes:1024*1024});
  return result;
}
function beforePixels(run){
  const previous=globalThis.OffscreenCanvas;let allocations=0;
  globalThis.OffscreenCanvas=class {constructor(){allocations++;throw Error('Unexpected pixel allocation');}};
  try{run();assert.equal(allocations,0);}finally{globalThis.OffscreenCanvas=previous;}
}

test('preview capture rejects invalid dimensions, transforms and clipping before allocating pixels',()=>beforePixels(()=>{
  for(const patch of [{width:4097},{height:0},{width:1.5},{matrix:[1,1,0,1,0,0]},{matrix:[0,0,0,0,0,0]},{matrix:[1,0,0,2,0,0]},{clipBounds:{x:0,y:0,width:NaN,height:1}},{maxBytes:NaN},{snapshotBytes:-1}]){
    assert.throws(()=>capturePreviewRaster(empty(),{...plan,...patch}),/Invalid drawing composite bounds/);
  }
}));

test('preview capture reserves both source and transferred pixels plus its streamed snapshot',()=>beforePixels(()=>{
  const bytes=plan.width*plan.height*4;
  assert.throws(()=>capturePreviewRaster(empty(),{...plan,maxBytes:bytes*2-1}),/working memory/);
  assert.throws(()=>capturePreviewRaster(empty(),{...plan,maxBytes:bytes*2,snapshotBytes:1}),/working memory/);
}));

test('preview capture excludes images, drawing cels, meshes and depth-composited surfaces',async()=>{
  const sources=await Promise.all([
    snapshot([{type:'image',opacity:1}]),
    snapshot([{type:'mesh',opacity:1,count:1}]),
    snapshot([{type:'circle',opacity:1,fig:{_styk:{drawing:{version:2}}}}]),
    snapshot([{type:'poly',opacity:1,alpha:1,points:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],depthValues:[0,0,0],poly:{_stykSurface:{depthTest:true}}}]),
  ]);
  beforePixels(()=>{for(const source of sources)assert.throws(()=>capturePreviewRaster(source,plan),/Invalid drawing composite bounds/);});
});

test('native diamond brushes are rejected before allocating unreserved pattern pixels',async()=>{
  const source=await snapshot([{type:'text',obj:{scale:1},seg:{paint:{type:'diamond'}}}]);
  beforePixels(()=>assert.throws(()=>capturePreviewRaster(source,plan),/Invalid drawing composite bounds/));
});

test('an untileable preview effect halo is rejected before entering the oversized software-region cache',async()=>{
  const effect=createVfx('blur','wide-blur');effect.params.radius=20;
  const source=await snapshot([{type:'line',opacity:1,obj:{scale:1,_stykVfx:{figure:[effect]}}}]);
  beforePixels(()=>assert.throws(()=>capturePreviewRaster(source,{...plan,width:4090,matrix:[100,0,0,100,0,0],maxBytes:2*1024*1024*1024}),/sampling region exceeds/));
});

test('preview capture admits opacity scratch only within its reserved working memory',async()=>{
  const source=await snapshot([{type:'circle',opacity:.5,obj:{scale:1}}]),bytes=plan.width*plan.height*4;
  beforePixels(()=>assert.throws(()=>capturePreviewRaster(source,{...plan,maxBytes:bytes*2}),/working memory/));
});

test('path captures preserve their complete native canvas domain or reject before allocating pixels',()=>beforePixels(()=>{
  const geometry={drawables:[{type:'line',slot:0,opacity:.5,obj:{scale:1}}]};
  const admitted=planPreviewRaster(geometry,plan);
  assert.equal(admitted.tileCount,1);assert.equal(admitted.nativePadding,true);
  assert.throws(()=>planPreviewRaster(geometry,{...plan,maxBytes:admitted.workingBytes-1}),/working memory/);
}));

test('effect capture admission prefers full native filter halos before bounded sampling cores',()=>beforePixels(()=>{
  const blur=createVfx('blur','native-halo');blur.params.radius=2;
  const geometry={drawables:[{type:'line',slot:0,opacity:1,obj:{scale:1,_stykVfx:{figure:[blur]}}}]};
  const admitted=planPreviewRaster(geometry,{...plan,matrix:[13.454,0,0,13.454,0,0]});
  const native=planPreviewRaster(geometry,{...plan,matrix:[13.454,0,0,13.454,0,0],nativePadding:true});
  assert.equal(admitted.tileCount,1);assert.equal(admitted.nativePadding,true);assert.equal(admitted.workingBytes,native.workingBytes);
  const pressured=planPreviewRaster(geometry,{...plan,matrix:[13.454,0,0,13.454,0,0],maxBytes:admitted.workingBytes-1});
  assert.equal(pressured.nativePadding,false);assert.ok(pressured.workingBytes<admitted.workingBytes);
  const tiled=planPreviewRaster(geometry,{...plan,matrix:[13.454,0,0,13.454,0,0],maxBytes:pressured.workingBytes-1});
  assert.ok(tiled.tileCount>1);assert.equal(tiled.tileGuard,2);
  const guarded=(tiled.tileWidth+4)*(tiled.tileHeight+4)*4;
  assert.ok(tiled.workingBytes>=plan.width*plan.height*8+guarded*2);
}));

test('capture admission bounds repeated core work before allocating any pixels',()=>beforePixels(()=>{
  const blur=createVfx('blur','bounded-work');blur.params.radius=.1;
  const geometry={drawables:[{type:'line',slot:0,opacity:1,obj:{scale:1,_stykVfx:{figure:[blur]}}}]},options={width:256,height:256,matrix:[1,0,0,1,0,0]};
  const admitted=planPreviewRaster(geometry,{...options,maxBytes:598000});
  assert.equal(admitted.tileCount,64);assert.ok(admitted.workingBytes<=598000);
  assert.throws(()=>capturePreviewRaster(geometry,{...options,maxBytes:560000}),error=>error.code==='preview_raster_budget');
}));

test('preview capture preserves outline and nested effect scratch in its allocation admission',async()=>{
  const outlineBits=new Uint32Array(new Float32Array([2]).buffer)[0];
  const outlineSource=await snapshot([{type:'circle',opacity:1,obj:{scale:1},fig:{segment_decode:{global_style:{u28:outlineBits,u30:100}}}}]);
  const effect=createVfx('blur','small-blur');effect.params.radius=1;
  const effectSource=await snapshot([{type:'line',opacity:1,obj:{scale:1,_stykVfx:{figure:[effect]}},_movieclipOwner:{opacity:.5,scale:1,effects:[effect]}}]);
  const bytes=plan.width*plan.height*4;
  beforePixels(()=>{
    assert.throws(()=>capturePreviewRaster(outlineSource,{...plan,maxBytes:bytes*2}),/working memory/);
    assert.throws(()=>capturePreviewRaster(effectSource,{...plan,maxBytes:bytes*2.5}),/working memory/);
  });
});

test('single directional filters reserve their actual executor slots and fit bounded native cores',async()=>{
  const effect=createVfx('blur','directional');effect.params.radius=14.678;effect.params.mode=1;effect.params.angle=52.296;
  const source=await snapshot([{type:'poly',slot:0,opacity:1,obj:{scale:1},_movieclipOwner:{opacity:1,scale:1.248915885,effects:[effect]},points:[]}]);
  beforePixels(()=>{
    const admitted=planPreviewRaster(source,{width:1152,height:1408,matrix:[13.4543426,0,0,13.4543426,0,0],maxBytes:70.99*1024*1024,snapshotBytes:3694});
    assert.equal(admitted.tileCount,1,'Borrowed private CPU pixels let this native full-domain capture fit without repeated core work.');assert.ok(admitted.workingBytes<=70.99*1024*1024);
    assert.equal(admitted.effects,true);
    assert.throws(()=>planPreviewRaster(admitted.geometry,{width:1152,height:1408,matrix:[13.4543426,0,0,13.4543426,0,0],maxBytes:16*1024*1024,snapshotBytes:3694}),/working memory/);
  });
});

test('Gaussian sampling support bounds nested-opacity captures without microscopic cores',()=>beforePixels(()=>{
  const glow=createVfx('glow','glow'),bloom=createVfx('bloom','bloom');
  Object.assign(glow.params,{radius:6,intensity:.9});Object.assign(bloom.params,{radius:8,intensity:1.34});
  const geometry={drawables:[{type:'line',slot:0,opacity:.79215686,obj:{scale:.44336299},
    _movieclipOwner:{opacity:1,scale:.99848164,effects:[glow,bloom]},_movieclipPart:0,
    _movieclipInner:{owner:{opacity:.56862745,scale:.99848164,effects:[]},part:0}}]};
  const admitted=planPreviewRaster(geometry,{width:1302,height:2048,matrix:[13.4543426,0,0,13.4543426,0,0],snapshotBytes:807698,maxBytes:74261508});
  assert.ok(admitted.tileCount<=64);assert.ok(admitted.workingBytes<=74261508);
}));

test('drawing resource admission precedes preparation and validates prepared revisions',async()=>{
  const fig={_styk:{drawing:{version:2,celId:'cel',revision:3}}},source=await snapshot([{type:'image',slot:0,opacity:1,obj:{scale:1},fig}]);
  beforePixels(()=>{
    assert.throws(()=>planPreviewRaster(source,{...plan,allowDrawings:true,resourceBytes:plan.maxBytes}),/working memory/);
    const prepared=planPreviewRaster({drawables:[{type:'image',slot:0,opacity:1,obj:{scale:1},fig}]},{...plan,allowDrawings:true,resourceBytes:1024});
    assert.ok(prepared.workingBytes>=1024+plan.width*plan.height*8);
    assert.throws(()=>capturePreviewRaster(prepared.geometry,{...plan,resourceBytes:1024,resources:{drawing(){return {id:'cel',revision:2,store:{}};}}}),/Invalid drawing composite bounds/);
  });
});

test('preview captures transfer independent bitmaps without RGBA readback and recover lost scratch contexts',()=>{
  const previous=globalThis.OffscreenCanvas,created=[],policies=[];let resets=0,closed=0;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;created.push(this);this.context={canvas:this,lost:false,setTransform(){},reset(){resets++;},isContextLost(){return this.lost;},getImageData(){throw Error('Unexpected RGBA readback');}};}
    getContext(type,options){assert.equal(type,'2d');policies.push(options);return this.context;}
    transferToImageBitmap(){return {width:this.width,height:this.height,close(){closed++;}};}
  };
  try{
    const first=capturePreviewRaster(empty(),plan),second=capturePreviewRaster(empty(),{...plan,width:32});
    assert.equal(first.bitmap.width,64);assert.equal(second.bitmap.width,32);
    assert.equal(first.bytes,64*64*4);assert.equal(first.workingBytes,first.bytes*2);assert.equal(first.effects,false);assert.equal(first.tileCount,1);
    assert.equal(created.length,1);assert.equal(created[0].width,1);assert.equal(created[0].height,1);
    created[0].context.lost=true;
    assert.throws(()=>capturePreviewRaster(empty(),plan),/canvas became unavailable/);
    const recovered=capturePreviewRaster(empty(),plan);
    assert.equal(created.length,2);assert.equal(recovered.bitmap.width,64);assert.equal(resets,2);
    assert.deepEqual(policies,[{willReadFrequently:true},{willReadFrequently:true}]);
    for(const result of [first,second,recovered])result.bitmap.close();assert.equal(closed,3);
  }finally{globalThis.OffscreenCanvas=previous;}
});
