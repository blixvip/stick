import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePreviewRaster,planPreviewRaster,planPreviewRasterResources} from '../src/renderer-raster-capture.mjs';
import {drawExportScene} from '../src/export-frame-core.mjs';
import {RasterSurfacePool} from '../src/raster-surfaces.mjs';
import {PlaybackResources} from '../src/playback-resources.mjs';
import {createVfx} from '../src/vfx.mjs';
import {VfxGPU,releaseVfxGPU} from '../src/vfx-gpu.mjs';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {releaseGeometryResources} from '../src/pivot/geometry.mjs';
import {vfxSourcePlan,vfxSoftwareSourcePlan,releaseVfxSoftwareResources,vfxSoftwareResourceStats} from '../src/vfx-canvas.mjs';
import {sendDrawingComposite} from '../src/drawing-composite-transport.mjs';
import {drawingPreviewPlan,preparePreviewDrawings} from '../src/renderer-preview-drawing-resources.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {encodeTileBlob} from '../src/drawing-tile-codec.mjs';
import {DrawingTileProvider} from '../src/drawing-provider.mjs';

const options={width:48,height:32,maxBytes:4*1024*1024,snapshotBytes:128};
function scene(){
  const blur=createVfx('blur','camera');Object.assign(blur.params,{mode:1,radius:1.3,angle:34});
  return {report:{canvas_width:48,canvas_height:32,backgrounds:[{background_id:1,kind:2,color:0xffd0e1f2}]},
    frame:{camera:{x:.37,y:-.63,scale:.9,angle_rad:.13},background_id:1,_stykVfx:{figure:[blur]}}};
}
function geometry(){
  const glow=createVfx('glow','object');Object.assign(glow.params,{radius:1.7,intensity:.6});
  const obj={unique_id:1,scale:1,_stykVfx:{figure:[glow]}};
  return {connectedVfxSource:true,drawables:[{type:'line',slot:0,opacity:.6,alpha:1,rgb:[20,60,90],obj,
    start:{x:4.2,y:3.7},end:{x:21.6,y:15.9},points:[{x:4.2,y:3.7},{x:21.6,y:15.9}],thickness:3,bend:0,seg:{segment_kind:'line'}}]};
}
async function publishedDrawing(){
  const figure=createDrawingFigure({celId:'cel-camera-source',figureTypeId:8}),store=new TileStore();store.set(4,6,new Uint8ClampedArray([71,129,203,192]));
  figure._styk.drawing.bounds=store.bounds;figure.image_assets[0].styk_tiles=await encodeTileBlob(store);
  const item={type:'image',slot:1,opacity:.73,alpha:.86,rgb:[0,0,0],obj:{unique_id:8,scale:1},fig:figure,seg:figure.segments[0],asset:figure.image_assets[0],
    start:{x:3.7,y:4.1},end:{x:259.7,y:4.1},points:[{x:3.7,y:4.1},{x:259.7,y:4.1}],angle:0};
  return {figure,store,item,geometry:{...geometry(),drawables:[...geometry().drawables,item]}};
}
function beforePixels(run){
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {constructor(){throw Error('Unexpected graphics allocation');}};
  try{run();}finally{globalThis.OffscreenCanvas=previous;}
}
function graphics(limit=4096){
  return new Proxy({getParameter(){return limit;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){}};}},
    {get(target,key){return target[key]??(()=>({}));}});
}
function canvasFixture(run,{gpu=true}={}){
  const previousCanvas=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData,gpuRun=VfxGPU.prototype.run;
  const canvases=[],bitmaps=[],filtered=[];let limit=4096;
  globalThis.ImageData=class {constructor(data,width,height){assert.equal(data.length,width*height*4);Object.assign(this,{data,width,height});}};
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;canvases.push(this);}
    getContext(kind,policy){
      if(kind==='webgl2')return gpu?(this.gl??=graphics(limit)):null;
      if(this.context)return this.context;
      let matrix=[1,0,0,1,0,0],saved=[];
      const transform=(a,b,c,d,e,f)=>{const m=matrix;matrix=[m[0]*a+m[2]*b,m[1]*a+m[3]*b,m[0]*c+m[2]*d,m[1]*c+m[3]*d,m[0]*e+m[2]*f+m[4],m[1]*e+m[3]*f+m[5]];};
      return this.context=new Proxy({canvas:this,globalAlpha:1,isContextLost(){return false;},getContextAttributes(){return {willReadFrequently:policy?.willReadFrequently===true};},
        setTransform(...values){matrix=values.length===1?[values[0].a,values[0].b,values[0].c,values[0].d,values[0].e,values[0].f]:values;},
        getTransform(){const m=Object.fromEntries(['a','b','c','d','e','f'].map((key,index)=>[key,matrix[index]]));m.inverse=()=>{const det=m.a*m.d-m.b*m.c;return {a:m.d/det,b:-m.b/det,c:-m.c/det,d:m.a/det,e:(m.c*m.f-m.d*m.e)/det,f:(m.b*m.e-m.a*m.f)/det};};return m;},
        save(){saved.push({matrix:matrix.slice(),alpha:this.globalAlpha});},restore(){const s=saved.pop();matrix=s.matrix;this.globalAlpha=s.alpha;},
        translate(x,y){transform(1,0,0,1,x,y);},scale(x,y){transform(x,0,0,y,0,0);},rotate(angle){transform(Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0);},transform,
        getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};},createLinearGradient(){return {addColorStop(){}};},
      },{get(target,key){return target[key]??(()=>{});}});
    }
    transferToImageBitmap(){const bitmap={width:this.width,height:this.height,closed:0,close(){this.closed++;}};bitmaps.push(bitmap);return bitmap;}
  };
  VfxGPU.prototype.run=function(source,stack){filtered.push({id:stack[0].id,source,objectPixels:filtered.filter(f=>f.id==='object').map(f=>f.source.width*f.source.height)});this.canvas.width=source.width;this.canvas.height=source.height;return this.canvas;};
  const cleanup=()=>{releaseVfxGPU();releaseVfxSoftwareResources();VfxGPU.prototype.run=gpuRun;globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousImageData;};
  let result;try{releaseVfxGPU();result=run({canvases,bitmaps,filtered,setLimit(value){limit=value;releaseVfxGPU();}});}catch(error){cleanup();throw error;}
  if(result?.then)return result.finally(cleanup);cleanup();return result;
}

test('native source planning preserves clamped rectangles and full owner filter coordinates',()=>{
  const blur=createVfx('blur','bounds');blur.params.mode=1;blur.params.radius=2;
  const plan=vfxSourcePlan({width:30,height:20,matrix:{a:2,b:0,c:0,d:2,e:.37,f:.61},stack:[blur],bounds:{x:-10,y:-2,width:40,height:30},domainBounds:{x:1,y:2,width:3,height:4},padding:5});
  assert.deepEqual(plan.rect,{x:-5,y:-5,width:40,height:30});
  assert.equal(plan.pixelScale,2);assert.equal(plan.anchorX,2.37);assert.equal(plan.anchorY,4.61);assert.ok(Math.abs(plan.outputSize.width-6)<1e-12);assert.ok(Math.abs(plan.outputSize.height-8)<1e-12);
  const software=vfxSoftwareSourcePlan(plan,{width:30,height:20});
  assert.deepEqual(software.rout,{x:0,y:0,width:30,height:20});assert.deepEqual(software.rin,plan.rect);
  assert.equal(vfxSourcePlan({width:30,height:20,matrix:{a:1,b:0,c:0,d:1,e:0,f:0},stack:[blur],bounds:{x:100,y:100,width:2,height:2},padding:5}),null);
});

test('native camera admission includes its metadata, exact source clamps and every live phase',()=>beforePixels(()=>{
  const g=geometry(),s=scene(),plan=planPreviewRaster(g,{...options,scene:s});
  assert.equal(plan.tileCount,1);assert.equal(plan.nativePadding,true);assert.equal(plan.sceneWidth,options.width+2*plan.scenePad);
  assert.equal(plan.sceneHeight,options.height+2*plan.scenePad);
  assert.equal(plan.workingBytes,Math.max(plan.objectPaintBytes,plan.sceneFilterBytes,plan.transferBytes));
  const output=options.width*options.height*4;
  assert.equal(plan.transferBytes-plan.sceneFilterBytes,output);
  assert.equal(planPreviewRaster(g,{...options,scene:s,snapshotBytes:options.snapshotBytes+99}).workingBytes-plan.workingBytes,99);
  const region=planPreviewRaster(g,{...options,scene:s,regionCaches:true});assert.ok(region.regionCacheBytes>0);
  assert.equal(region.workingBytes,Math.max(region.objectPaintBytes,region.sceneFilterBytes,region.transferBytes));
  assert.throws(()=>capturePreviewRaster(g,{...options,scene:s,maxBytes:plan.workingBytes-1}),e=>e.code==='preview_raster_budget');
  assert.throws(()=>planPreviewRaster(g,{...options,scene:s,effectLimit:32}),/sampling region exceeds/);
}));

test('scene admission follows existing native internal effect tiles and the one-filter software readback lifetime',()=>{
  const s=scene();s.report.canvas_width=1600;s.report.canvas_height=800;s.frame.camera={x:0,y:0,scale:1,angle_rad:0};
  const blur=createVfx('blur','object');Object.assign(blur.params,{mode:1,radius:112.5,angle:34});
  const g=geometry(),item=g.drawables[0];item.opacity=1;item.obj.scale=4;item.obj._stykVfx.figure=[blur];item.start={x:0,y:0};item.end={x:1600,y:800};item.points=[item.start,item.end];
  const request={width:1600,height:800,maxBytes:1024*1024*1024,scene:s};
  let native,software;beforePixels(()=>{native=planPreviewRaster(g,request);software=planPreviewRaster(g,{...request,regionCaches:true});});
  assert.equal(native.tileCount,1,'The scene destination preserves its native full canvas domain.');
  assert.ok(software.regionCacheBytes>4096*800*4,'The genuine software source may exceed a GPU edge while preserving native coverage.');
  assert.equal(software.workingBytes,Math.max(software.objectPaintBytes,software.sceneFilterBytes,software.transferBytes));
  beforePixels(()=>assert.throws(()=>capturePreviewRaster(g,{...request,maxBytes:native.workingBytes-1}),error=>error.code==='preview_raster_budget'));
  canvasFixture(({filtered})=>{
    const resources=new PlaybackResources({maxBytes:request.maxBytes}),captured=capturePreviewRaster(g,{...request,resources});
    try{
      const object=filtered.filter(row=>row.id==='object');assert.ok(object.length>1,'The existing object filter partitions its native source internally.');
      assert.ok(object.every(row=>row.source.width<=4096&&row.source.height<=4096));
      assert.equal(captured.workingBytes,native.workingBytes);
    }finally{resources.dispose();captured.bitmap.close();}
  });
});

test('camera recipes reject document state, media, depth, diamond patterns and generators before graphics allocation',()=>beforePixels(()=>{
  const s=scene();
  for(const bad of [{...s,report:{...s.report,_styk:{layers:{}}}},{...s,report:{...s.report,figure_types:[]}},{...s,frame:{...s.frame,objects:[]}},
    {...s,frame:{...s.frame,camera:{scale:0}}},{...s,report:{...s.report,backgrounds:[{data_url:'data:image/png;base64,'}]}},
    {...s,report:{...s.report,backgrounds:[{kind:2,paint:{type:'diamond',stops:[]}}]}}]){
    assert.throws(()=>capturePreviewRaster(geometry(),{...options,scene:bad}),/Invalid drawing composite bounds/);
  }
  for(const patch of [{type:'image'},{type:'mesh'},{poly:{_stykSurface:{depthTest:true}},depthValues:[0,0]},{seg:{paint:{type:'diamond'}}}]){
    const g=geometry();Object.assign(g.drawables[0],patch);assert.throws(()=>capturePreviewRaster(g,{...options,scene:s}),/Invalid drawing composite bounds/);
  }
  const generator={type:'particles',enabled:true};
  assert.throws(()=>capturePreviewRaster(geometry(),{...options,scene:{...s,frame:{...s.frame,_stykVfx:{figure:[...s.frame._stykVfx.figure,generator]}}}}),/Invalid drawing composite bounds/);
  const g=geometry();g.drawables[0]._movieclipOwner={opacity:1,scale:1,effects:[generator]};assert.throws(()=>capturePreviewRaster(g,{...options,scene:s}),/Invalid drawing composite bounds/);
}));

test('only one-shot native camera capture releases object scratch before the final scene filter',()=>canvasFixture(({filtered})=>{
  const resources=new PlaybackResources({maxBytes:options.maxBytes});
  try{
    const result=capturePreviewRaster(geometry(),{...options,scene:scene(),resources});
    const final=filtered.find(f=>f.id==='camera');assert.ok(final);assert.deepEqual(final.objectPixels,[1]);
    assert.equal(result.effects,true);assert.equal(result.tileCount,1);assert.equal(resources.rasterSurfaces.surface.width,1);assert.equal(resources.rasterSurfaces.busy,false);
    assert.equal(resources.rasterSurfaces.context.getContextAttributes().willReadFrequently,false);
    resources.dispose();assert.equal(result.bitmap.closed,0);result.bitmap.close();assert.equal(result.bitmap.closed,1);
    filtered.length=0;
    const direct=new OffscreenCanvas(options.width,options.height);
    drawExportScene(direct.getContext('2d'),scene().report,scene().frame,geometry(),resources);
    assert.ok(filtered.find(f=>f.id==='camera').objectPixels.every(p=>p>1),'Default export retains its existing object-scratch reuse.');
    releaseGeometryResources(direct.getContext('2d'));
  }finally{resources.dispose();}
}));

test('scene preflight discovers only tiny capability resources and rejects actual limited devices before capture pixels',()=>canvasFixture(({canvases,setLimit})=>{
  const s=scene(),g=geometry(),p=planPreviewRasterResources(g,{...options,scene:s});
  assert.ok(p.workingBytes>options.width*options.height*8);assert.ok(canvases.every(c=>c.width===1&&c.height===1));
  setLimit(32);let leases=0;
  assert.throws(()=>capturePreviewRaster(g,{...options,scene:s,resources:{rasterSurface(){leases++;throw Error('Unexpected lease');}}}),/sampling region exceeds/);
  assert.equal(leases,0);assert.ok(canvases.every(c=>c.width===1&&c.height===1));
}));

test('camera capture closes its completed bitmap once on either pool or executor cleanup failure',()=>canvasFixture(({bitmaps})=>{
  const owner=new RasterSurfacePool(),resources={rasterSurface(){return owner;},image(){return null;}},release=owner.release,releasePixels=VfxGPU.prototype.releasePixels;
  try{
    owner.release=function(){release.call(this);throw Error('Scene lease cleanup failed');};
    assert.throws(()=>capturePreviewRaster(geometry(),{...options,scene:scene(),resources}),/Scene lease cleanup failed/);assert.equal(bitmaps[0].closed,1);
    owner.release=release;VfxGPU.prototype.releasePixels=function(){releasePixels.call(this);throw Error('Scene executor cleanup failed');};
    assert.throws(()=>capturePreviewRaster(geometry(),{...options,scene:scene(),resources}),/Scene executor cleanup failed/);assert.equal(bitmaps[1].closed,1);
    VfxGPU.prototype.releasePixels=releasePixels;
    const recovered=capturePreviewRaster(geometry(),{...options,scene:scene(),resources});recovered.bitmap.close();assert.equal(bitmaps[2].closed,1);assert.equal(owner.busy,false);
  }finally{VfxGPU.prototype.releasePixels=releasePixels;owner.release=release;owner.dispose();}
}));

test('missing-GPU scene capture frees recursive local source scratch before final filtering and publication',()=>canvasFixture(({canvases})=>{
  const runPixels=VfxCPU.prototype.runPixels,events=[],owners=[];
  VfxCPU.prototype.runPixels=function(...args){events.push(args[3][0].id);if(!owners.includes(this))owners.push(this);return runPixels.apply(this,args);};
  const resources=new PlaybackResources({maxBytes:options.maxBytes});
  try{
    const g=geometry(),ownerBlur=createVfx('blur','outer');ownerBlur.params.mode=1;ownerBlur.params.radius=.7;
    Object.assign(g.drawables[0],{_movieclipOwner:{opacity:.8,scale:1,effects:[ownerBlur]},_movieclipPart:0});
    const plan=planPreviewRasterResources(g,{...options,scene:scene()});assert.ok(plan.regionCacheBytes>0);
    const result=capturePreviewRaster(g,{...options,scene:scene(),resources});
    assert.equal(events.at(-1),'camera');assert.ok(events.includes('outer'));assert.ok(events.includes('object'));
    assert.equal(vfxSoftwareResourceStats().bytes,0);assert.ok(owners.every(owner=>!owner.slots.length));
    assert.ok(canvases.every(c=>c.width===1&&c.height===1),'Transient software source contexts and all nested scratch are released.');
    resources.dispose();assert.equal(result.bitmap.closed,0);result.bitmap.close();
  }finally{VfxCPU.prototype.runPixels=runPixels;resources.dispose();}
},{gpu:false}));

test('generic missing-GPU artwork captures also release every transient local source and nested scratch',()=>canvasFixture(({canvases})=>{
  const g=geometry(),outer=createVfx('blur','ordinary-outer');outer.params.mode=1;outer.params.radius=.7;
  Object.assign(g.drawables[0],{_movieclipOwner:{opacity:.8,scale:1,effects:[outer]},_movieclipPart:0});
  const result=capturePreviewRaster(g,{...options,matrix:[1,0,0,1,.37,.61]});
  assert.ok(canvases.length>3,'Nested software sources were painted.');
  assert.ok(canvases.every(c=>c.width===1&&c.height===1),'Both local source contexts and recursive opacity/effect scratch end at capture completion.');
  assert.equal(vfxSoftwareResourceStats().bytes,0);assert.equal(result.bitmap.closed,0);result.bitmap.close();
},{gpu:false}));

test('the existing chunked worker protocol preflights and consumes one scene snapshot, releasing its owner before transfer',async()=>canvasFixture(async({canvases,bitmaps})=>{
  const previousSelf=globalThis.self,dispose=PlaybackResources.prototype.dispose,messages=[];let id=0,disposed=0,failPost=false;
  globalThis.self={postMessage(message){
    if(message.bitmap){assert.equal(disposed,bitmaps.length,'Each prepared scene owner is disposed before publication.');assert.ok(canvases.every(c=>c.width===1&&c.height===1));if(failPost)throw Error('Bitmap publication failed');}
    messages.push(message);
  }};
  PlaybackResources.prototype.dispose=function(){disposed++;return dispose.call(this);};
  try{
    await import('../src/drawing-composite-worker.mjs?native-scene-test');
    const request=async(kind,payload={})=>{
      const current=++id;await self.onmessage({data:{id:current,kind,...payload}});const reply=messages.find(m=>m.id===current);assert.ok(reply);
      if(reply.error)throw Object.assign(new Error(reply.error),{code:reply.code});return reply;
    };
    const data={...options,scene:scene()},items=geometry().drawables;
    await sendDrawingComposite({request},items,{maxBytes:options.maxBytes});
    const plan=await request('preview-raster-plan',data),repeat=await request('preview-raster-plan',data);
    assert.equal(plan.requiredBytes,repeat.requiredBytes);assert.ok(Number.isSafeInteger(plan.requiredBytes));assert.ok(canvases.every(c=>c.width===1&&c.height===1));
    // Preview-raster consumes the same already-restored acknowledged snapshot.
    const result=await request('preview-raster',{...data,maxBytes:plan.requiredBytes});
    assert.equal(result.workingBytes,plan.requiredBytes);assert.equal(result.bitmap.width,options.width);assert.equal(result.bitmap.closed,0);result.bitmap.close();
    await assert.rejects(request('preview-raster',data),/Missing drawing composite snapshot/);
    await sendDrawingComposite({request},items,{maxBytes:options.maxBytes});
    failPost=true;await assert.rejects(request('preview-raster',data),/Bitmap publication failed/);assert.equal(bitmaps.at(-1).closed,1);
    await sendDrawingComposite({request},items,{maxBytes:options.maxBytes});
    const rejected=await request('preview-raster-plan',data);
    await assert.rejects(request('preview-raster',{...data,maxBytes:rejected.requiredBytes-1}),e=>e.code==='preview_raster_budget');
    assert.equal(bitmaps.length,2,'A pressured scene rejects without allocating or transferring another bitmap.');
  }finally{PlaybackResources.prototype.dispose=dispose;globalThis.self=previousSelf;}
}));

test('published drawing scene admission reserves tile resources through native painting and rejects stale owners before allocation',async()=>{
  const drawing=await publishedDrawing(),resourcePlan=drawingPreviewPlan(drawing.geometry.drawables),resources=await preparePreviewDrawings(resourcePlan),entry=resources.drawing(drawing.figure);
  try{beforePixels(()=>{
    const cheap=planPreviewRaster(drawing.geometry,{...options,scene:scene(),allowDrawings:true});
    const reserved=planPreviewRaster(drawing.geometry,{...options,scene:scene(),allowDrawings:true,resourceBytes:resourcePlan.bytes});
    assert.equal(reserved.objectPaintBytes-cheap.objectPaintBytes,resourcePlan.bytes);
    for(const phase of ['sceneFilterBytes','transferBytes'])assert.equal(reserved[phase],cheap[phase],'Completed scene pixels outlive their released drawing preparation.');
    assert.throws(()=>capturePreviewRaster(drawing.geometry,{...options,scene:scene(),resources,resourceBytes:resourcePlan.bytes,maxBytes:reserved.workingBytes-1}),e=>e.code==='preview_raster_budget');
    for(const patch of [{revision:entry.revision+1},{id:'selection'},{store:null},{pinned:true},{loading:Promise.resolve()},{transient:true},{deferred:[{}]},
      {published:{revision:entry.revision-1,url:drawing.figure.image_assets[0].styk_tiles}},{published:{revision:entry.revision,url:'changed'}}]){
      const wrong={...resources,drawing:()=>({...entry,...patch})};
      assert.throws(()=>capturePreviewRaster(drawing.geometry,{...options,scene:scene(),resources:wrong,resourceBytes:resourcePlan.bytes}),/Invalid drawing composite bounds/);
    }
  });}finally{resources.dispose();}
});

for(const gpu of [true,false])test(`published drawing scenes reuse the decoded provider's accelerated native pool and dispose derived pixels (${gpu?'GPU':'CPU'})`,async()=>canvasFixture(async()=>{
  const drawing=await publishedDrawing(),resourcePlan=drawingPreviewPlan(drawing.geometry.drawables),resources=await preparePreviewDrawings(resourcePlan),entry=resources.drawing(drawing.figure);
  const drop=DrawingTileProvider.prototype.drop,gpuRun=VfxGPU.prototype.run,cpuRun=VfxCPU.prototype.runPixels,scratches=[];let finalFilter=0;
  const verifyFinal=stack=>{if(stack[0].id==='camera'){finalFilter++;assert.equal(resources.drawingProvider.entries.size,0);assert.equal(entry._scratches,null);assert.ok(scratches.length>0);assert.ok(scratches.every(canvas=>canvas.width===1&&canvas.height===1));assert.equal(resources.rasterSurfaces.surface.width,options.width,'The native root pool survives until final filtering.');}};
  DrawingTileProvider.prototype.drop=function(current){if(current===entry)for(const s of current._scratches?.values()??[])if(s.canvas)scratches.push(s.canvas);return drop.call(this,current);};
  VfxGPU.prototype.run=function(source,stack,...rest){verifyFinal(stack);return gpuRun.call(this,source,stack,...rest);};
  VfxCPU.prototype.runPixels=function(data,width,height,stack,...rest){verifyFinal(stack);return cpuRun.call(this,data,width,height,stack,...rest);};
  try{
    assert.deepEqual(entry.store.pixel(4,6),drawing.store.pixel(4,6));assert.equal(entry.store.bytes,TILE_BYTES);
    const result=capturePreviewRaster(drawing.geometry,{...options,scene:scene(),resources,resourceBytes:resourcePlan.bytes});
    assert.equal(result.tileCount,1);assert.equal(resources.rasterSurfaces.surface.width,1);assert.equal(resources.rasterSurfaces.busy,false);
    assert.equal(resources.rasterSurfaces.context.getContextAttributes().willReadFrequently,false);assert.equal(finalFilter,1);
    assert.ok(entry.presentedStamp>=entry.stamp);assert.ok(scratches.length>0,'Native tile painting used the same provider before phase release.');
    resources.dispose();assert.equal(resources.drawingProvider.entries.size,0);assert.ok(scratches.every(scratch=>scratch.width===1&&scratch.height===1));assert.equal(result.bitmap.closed,0);
    result.bitmap.close();assert.equal(result.bitmap.closed,1);assert.equal(vfxSoftwareResourceStats().bytes,0);
  }finally{DrawingTileProvider.prototype.drop=drop;VfxGPU.prototype.run=gpuRun;VfxCPU.prototype.runPixels=cpuRun;resources.dispose();}
},{gpu}));

test('default native scene painting retains drawing preparation, while failed worker phase release publishes nothing and recovers',async()=>canvasFixture(async({filtered,bitmaps})=>{
  const drawing=await publishedDrawing(),resourcePlan=drawingPreviewPlan(drawing.geometry.drawables),resources=await preparePreviewDrawings(resourcePlan),provider=resources.drawingProvider,dispose=provider.dispose;
  try{
    const direct=new OffscreenCanvas(options.width,options.height);
    drawExportScene(direct.getContext('2d'),scene().report,scene().frame,drawing.geometry,resources);
    assert.equal(provider.entries.size,1,'Ordinary export retains its decoded drawing owner for subsequent painting.');
    assert.ok(provider.presenter(drawing.figure)._scratches.size>0);releaseGeometryResources(direct.getContext('2d'));filtered.length=0;
    provider.dispose=function(){dispose.call(this);throw Error('Drawing phase cleanup failed');};
    assert.throws(()=>capturePreviewRaster(drawing.geometry,{...options,scene:scene(),resources,resourceBytes:resourcePlan.bytes}),/Drawing phase cleanup failed/);
    assert.equal(bitmaps.length,0);assert.equal(filtered.filter(row=>row.id==='camera').length,0,'Final filtering never runs after failed drawing cleanup.');
    assert.equal(provider.entries.size,0);assert.equal(resources.rasterSurfaces.surface,null);assert.equal(resources.rasterSurfaces.busy,false);
    provider.dispose=dispose;await provider.prepare(resourcePlan.figures);
    const recovered=capturePreviewRaster(drawing.geometry,{...options,scene:scene(),resources,resourceBytes:resourcePlan.bytes});
    assert.equal(provider.entries.size,0);assert.equal(recovered.bitmap.closed,0);recovered.bitmap.close();assert.equal(recovered.bitmap.closed,1);
  }finally{provider.dispose=dispose;resources.dispose();}
}));

test('scene worker decodes published tiles only after admission and publishes from exactly one disposed prepared owner',async()=>canvasFixture(async({bitmaps})=>{
  const previousSelf=globalThis.self,prepare=DrawingTileProvider.prototype.prepare,dispose=PlaybackResources.prototype.dispose,messages=[],owners=[];let id=0,decodes=0;
  globalThis.self={postMessage(message){if(message.bitmap){assert.equal(owners.length,1);assert.equal(owners[0].drawingProvider.entries.size,0);assert.equal(owners[0].rasterSurfaces.surface,null);}messages.push(message);}};
  DrawingTileProvider.prototype.prepare=function(...args){decodes++;return prepare.apply(this,args);};
  PlaybackResources.prototype.dispose=function(){owners.push(this);return dispose.call(this);};
  try{
    await import('../src/drawing-composite-worker.mjs?native-scene-published-test');
    const request=async(kind,payload={})=>{const current=++id;await self.onmessage({data:{id:current,kind,...payload}});const reply=messages.find(m=>m.id===current);assert.ok(reply);if(reply.error)throw Object.assign(new Error(reply.error),{code:reply.code});return reply;};
    const drawing=await publishedDrawing(),data={...options,scene:scene()};await sendDrawingComposite({request},drawing.geometry.drawables,{maxBytes:options.maxBytes});
    const plan=await request('preview-raster-plan',data);assert.equal(decodes,0);assert.equal(owners.length,0);assert.equal(bitmaps.length,0);
    await assert.rejects(request('preview-raster',{...data,maxBytes:plan.requiredBytes-1}),e=>e.code==='preview_raster_budget');assert.equal(decodes,0);
    await sendDrawingComposite({request},drawing.geometry.drawables,{maxBytes:options.maxBytes});
    const result=await request('preview-raster',{...data,maxBytes:plan.requiredBytes});assert.equal(decodes,1);assert.equal(owners.length,1);assert.equal(result.workingBytes,plan.requiredBytes);
    assert.equal(result.bitmap.closed,0);result.bitmap.close();assert.equal(bitmaps[0].closed,1);
  }finally{DrawingTileProvider.prototype.prepare=prepare;PlaybackResources.prototype.dispose=dispose;globalThis.self=previousSelf;}
}));
