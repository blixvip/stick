import {samplingFixture} from './export-sampling-fixture.mjs';
import {createFrame,createObject,emptyDocument} from '../src/demo.mjs';
import {buildGeometry,drawGeometry,releaseGeometryResources} from '../src/pivot/geometry.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {yieldSceneTask} from '../src/scene-preparation.mjs';
import {GESTURE_STAND_IN_PIXELS} from '../src/raster-view.mjs';

const MiB=1024*1024;
const check=(condition,message,details)=>{if(!condition)throw Object.assign(Error(message),{details});};
const read=canvas=>{
  const copy=new OffscreenCanvas(canvas.width,canvas.height),ctx=copy.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,copy.width,copy.height).data;
};
function difference(actual,expected){
  check(actual.length===expected.length,'Pixel references must have identical dimensions',{actualBytes:actual.length,expectedBytes:expected.length});
  let sum=0,max=0,visible=0,alphaSum=0,alphaMax=0,premultipliedSum=0;
  for(let i=0;i<actual.length;i++){
    const d=Math.abs(actual[i]-expected[i]);sum+=d;max=Math.max(max,d);
    if(i%4===3){if(actual[i]>0)visible++;alphaSum+=d;alphaMax=Math.max(alphaMax,d);premultipliedSum+=d;}
    else {const alpha=i-i%4+3;premultipliedSum+=Math.abs(actual[i]*actual[alpha]/255-expected[i]*expected[alpha]/255);}
  }
  return {mean:sum/actual.length,max,visible,alphaMean:alphaSum/(actual.length/4),alphaMax,premultipliedMean:premultipliedSum/actual.length};
}
function resources(renderer){
  return renderer.device?[...new Set(renderer.layout?.map(entry=>entry.texture).filter(Boolean))]:[...renderer.artwork.values()];
}
const rasterCount=renderer=>renderer.stats.rasterizedObjects??0;
const newRasters=(renderer,before)=>renderer.device?rasterCount(renderer):rasterCount(renderer)-before;
const sceneView=(scale,target,width,height)=>({scale,x:width/2-target.x*scale+.31,y:height/2-target.y*scale+.27});

function scene({opaque=false}={}){
  const report=samplingFixture({kind:'outline'}),figure=report.figure_types[0],base=figure.segments[0];
  figure.segment_decode.global_style.u30=opaque?0:80;
  figure.segments=Array.from({length:8},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:180,angle_rad:i*Math.PI/4+.413}));
  figure.segment_count=figure.segments.length;
  const frame=createFrame([createObject(figure,1,200,200)]);report.keyframes=[frame];
  const geometry=buildGeometry(report,frame),item=geometry.drawables[0];
  const target={x:item.start.x+(item.end.x-item.start.x)*.45,y:item.start.y+(item.end.y-item.start.y)*.45};
  if(opaque){
    const dx=item.end.x-item.start.x,dy=item.end.y-item.start.y,length=Math.hypot(dx,dy);
    target.x-=dy/length*item.thickness*.5;target.y+=dx/length*item.thickness*.5;
  }
  return {report,frame,geometry,target};
}

export function drawingOverlapScene(cel,effects){
  const report=emptyDocument(),under=samplingFixture({opacity:.58}).figure_types[0],over=samplingFixture({opacity:.43}).figure_types[0];
  under.figure_type_id=4;over.figure_type_id=5;
  Object.assign(under.segments[0],{length:100,thickness:13.3,angle_rad:.09,color_rgb:[210,80,30]});
  Object.assign(over.segments[0],{length:90,thickness:9.7,angle_rad:Math.PI/2+.03,color_rgb:[30,190,90]});
  report.figure_types=[under,cel,over];
  const frame=createFrame([createObject(under,1,188,226),createObject(cel,2,200,200),createObject(over,3,255,197)]);
  frame.objects[1]._stykVfx=effects;report.keyframes=[frame];
  return {report,frame,geometry:buildGeometry(report,frame),target:{x:264,y:232}};
}

/** In-page regression runner, also usable directly by the collaborative preview.
 * No attached user project is needed or embedded in this fixture. */
export async function zoomGestureState({forceCanvas2D=false,rendererURL='../src/renderer.mjs',onProgress=()=>{}}={}){
  const {createRenderer}=await import(rendererURL);
  const width=384,height=256,budget=16*MiB,checks=[],rows=[],errors=[],renderers=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const make=async extra=>{
    const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D,gpuDrawing:false,sharedArtwork:false,editorRasterCache:{maxBytes:budget},...extra});
    renderer.resize(width,height,1);renderer.artworkBudget=budget;
    renderer.device?.addEventListener('uncapturederror',event=>errors.push(event.error.message));
    renderers.push(renderer);return renderer;
  };
  const dispose=owned=>{owned.destroy();renderers.splice(renderers.indexOf(owned),1);};
  const renderer=await make();
  const optionsFor=(s,scale)=>({report:s.report,frame:s.frame,geometry:s.geometry,view:sceneView(scale,s.target,width,height),cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff});
  const submit=async options=>{
    renderer.render(options);
    if(!options.viewChanging&&!options.playing&&renderer.whenArtworkReady){
      await renderer.whenArtworkReady();renderer.render(options);
    }
    await renderer.device?.queue.onSubmittedWorkDone();return read(renderer.canvas);
  };
  const bounded=()=>{
    if(renderer.device){
      verify(renderer.rasterCache.stats.activeBytes<=budget,'Visible gesture artwork stays within its raster allocation');
      verify(renderer.rasterCache.bytes<=budget&&renderer.rasterCache.recycledBytes<=renderer.rasterCache.maxRecycledBytes,'Retained and recycled gesture artwork stay within their existing budgets');
      verify(renderer.rasterCache.leases.size===0,'Synchronous gesture updates retain no preparation leases');
    }else verify(renderer.artworkBytes<=budget,'Canvas gesture artwork stays within its raster allocation');
  };
  const compareFresh=async(options,label,{mean=.02,alphaMax=1}={})=>{
    const fresh=await make({asyncArtwork:false});fresh.render({...options,viewChanging:false});await fresh.device?.queue.onSubmittedWorkDone();
    const diff=difference(read(renderer.canvas),read(fresh.canvas));
    const plan=items=>items.map(resource=>({resolution:resource.resolution,raster:resource.raster,bounds:resource.bounds}));
    verify(diff.visible>100&&diff.mean<mean&&diff.alphaMax<=alphaMax,`${label}: settled pixels match an independently prepared scene (${diff.mean.toFixed(4)})`,{diff,actual:plan(resources(renderer)),fresh:plan(resources(fresh)),
      actualOnions:plan([...renderer.onionArtwork?.values()??[]]),freshOnions:plan([...fresh.onionArtwork?.values()??[]]),
      refinement:renderer.stats.artworkRefinement&&{...renderer.stats.artworkRefinement},lastRefinementError:renderer.stats.lastRefinementError});
    rows.push({name:label,backend:renderer.stats.backend,diff});dispose(fresh);
  };
  try{
    const native=scene();
    let options=optionsFor(native,2);await submit(options);
    const whole=resources(renderer),initialRasterCount=rasterCount(renderer);
    verify(whole.length===1&&!whole[0].raster,'Ordinary zoom starts with one complete native artwork raster');
    let changed=0;
    for(const scale of [2.2,2.8,3.4,4.1,5.3,8,12,16]){
      options={...optionsFor(native,scale),viewChanging:true};const before=rasterCount(renderer);await submit(options);
      changed+=newRasters(renderer,before);
      const active=resources(renderer);
      verify(active.length===whole.length&&active.every(resource=>whole.includes(resource)),`${scale}x: covered wheel zoom retains the original artwork`);
    }
    verify(changed===0,'Crossing density buckets during covered zoom performs no new artwork rasterization');
    rows.push({name:'covered zoom',backend:renderer.stats.backend,initialRasterCount,gestureRasters:changed});
    await submit({...options,viewChanging:false});
    await compareFresh(options,'ordinary-to-high zoom');bounded();

    options=optionsFor(native,32);await submit(options);
    const cropped=resources(renderer);
    verify(cropped.length===1&&cropped[0].raster?.cropped,'High zoom starts with bounded, cropped native artwork');
    options={...optionsFor(native,64),viewChanging:true};const beforeIn=rasterCount(renderer);await submit(options);
    verify(newRasters(renderer,beforeIn)===0&&resources(renderer)[0]===cropped[0],'Zooming farther into a covered crop retains its pixels');
    // Leaving a held crop must not paint the newly exposed region at the
    // crop's density: that cost grows with every zoom-out step. The whole
    // artwork is shown from a retained raster or one bounded proxy instead.
    options={...optionsFor(native,16),viewChanging:true};const beforeOut=rasterCount(renderer);await submit(options);
    const proxy=resources(renderer)[0];
    verify(proxy!==cropped[0]&&!proxy.raster&&proxy.resolution<=16,'Zooming out of retained coverage presents the whole artwork at or below the view density',{resolution:proxy.resolution,raster:proxy.raster});
    verify(newRasters(renderer,beforeOut)<=1,'Leaving retained coverage paints at most one bounded proxy');
    options={...options,view:{...options.view,x:options.view.x-220}};const beforeMove=rasterCount(renderer);await submit(options);
    verify(resources(renderer)[0]===proxy&&newRasters(renderer,beforeMove)===0,'A complete proxy covers further navigation without painting');
    options={...optionsFor(native,32),view:options.view,viewChanging:true};const beforeReturn=rasterCount(renderer);await submit(options);
    verify(resources(renderer)[0]===proxy&&newRasters(renderer,beforeReturn)===0,'Returning to the starting density keeps the proxy until the gesture settles');
    await submit({...options,viewChanging:false});
    verify(resources(renderer)[0]!==proxy&&resources(renderer)[0].raster?.cropped,'Settling at the starting density replaces the proxy with requested detail');
    await compareFresh(options,'proxy at the starting density',{mean:.1,alphaMax:16});bounded();
    await submit(optionsFor(native,32));
    options={...optionsFor(native,16),viewChanging:true};await submit(options);
    options={...options,view:{...options.view,x:options.view.x-220}};await submit(options);
    await submit({...options,viewChanging:false});
    // Retaining a legally covered crop can shift native edge antialiasing
    // slightly versus a newly quantized crop. The no-gesture baseline has the
    // same variance (GPU mean .0793 / alpha max 16; Canvas .0746 / 15).
    await compareFresh(options,'exposed crop',{mean:.1,alphaMax:16});bounded();

    // Panning a close-up past its held crop paints one bounded crop of the
    // widened view: the whole artwork would be far softer at this density.
    // The crop covers further panning; settling restores the requested detail.
    options=optionsFor(native,64);await submit(options);
    const held=resources(renderer)[0];
    options={...options,view:{...options.view,x:options.view.x-300},viewChanging:true};const beforePan=rasterCount(renderer);await submit(options);
    const standIn=resources(renderer)[0];
    verify(standIn!==held&&standIn.raster?.cropped&&standIn.resolution<=held.resolution&&
      standIn.raster.pixelWidth*standIn.raster.pixelHeight<=GESTURE_STAND_IN_PIXELS,'Panning past a held crop paints a bounded crop of the widened view',
      {held:held.raster,standIn:standIn.raster,resolution:standIn.resolution});
    verify(newRasters(renderer,beforePan)<=1,'Leaving held coverage by panning paints at most one stand-in');
    options={...options,view:{...options.view,x:options.view.x-150,y:options.view.y+100}};const beforeMore=rasterCount(renderer);await submit(options);
    verify(resources(renderer)[0]===standIn&&newRasters(renderer,beforeMore)===0,'The pan stand-in covers further panning without painting');
    await submit({...options,viewChanging:false});
    verify(resources(renderer)[0].resolution===held.resolution,'Settling after a pan restores the requested density');
    await compareFresh(options,'pan stand-in',{mean:.1,alphaMax:16});bounded();

    const onionFrame=createFrame([createObject(native.report.figure_types[0],1,203,202)]);
    const onionFrames=[{frame:onionFrame,geometry:buildGeometry(native.report,onionFrame),opacity:.35}];
    options={...optionsFor(native,2),onionFrames};await submit(options);
    const onionRasters=renderer.device?resources(renderer):[...renderer.onionArtwork.values()];
    verify(onionRasters.length>0,'Onion-skin setup retains visible artwork');
    for(const scale of [2.4,3.2,4.8,7]){
      options={...optionsFor(native,scale),onionFrames,viewChanging:true};await submit(options);
      const current=renderer.device?resources(renderer):[...renderer.onionArtwork.values()];
      verify(current.length===onionRasters.length&&current.every(resource=>onionRasters.includes(resource)),`${scale}x: onion skins retain their covered artwork during zoom`);
      if(!renderer.device)verify(renderer.stats.onionRasterizedObjects===0,'Covered Canvas onion skins perform no new rasterization');
    }
    await submit({...options,viewChanging:false});
    await compareFresh(options,'onion-skin zoom');bounded();

    // Geometry revisions must override the transient density hold immediately.
    const revised=scene();revised.frame.objects[0].angles[0]+=.18;
    revised.geometry=buildGeometry(revised.report,revised.frame);
    options={...optionsFor(revised,4),viewChanging:true};await submit(options);
    await compareFresh(options,'scene revision during zoom');bounded();
    const beforePlayback=resources(renderer)[0];
    options={...optionsFor(revised,2),viewChanging:true,playing:true};await submit(options);
    verify(resources(renderer)[0]!==beforePlayback,'Playback selects its requested density even when a view gesture is marked active');
    await compareFresh(options,'playback density');bounded();

    if(renderer.device){
      const outline=scene({opaque:true});
      options=optionsFor(outline,16);await submit(options);
      verify(renderer.stats.outlinedVectorObjects===1&&renderer.stats.textureObjects===0,'Supported high-zoom outlines start as sharp vectors');
      await submit({...optionsFor(outline,2),viewChanging:true});
      verify(renderer.stats.outlinedVectorObjects===1&&renderer.stats.textureObjects===0,'A covered gesture keeps high-zoom outline vectors until it settles');
      options=optionsFor(outline,2);await submit(options);
      verify(renderer.stats.outlinedVectorObjects===0&&renderer.stats.textureObjects===1,'Settling at ordinary zoom restores its established native artwork');
      await compareFresh(options,'high-to-ordinary outline transition');
      await submit({...optionsFor(outline,32),viewChanging:true});
      verify(renderer.stats.outlinedVectorObjects===0&&renderer.stats.textureObjects===1,'An ordinary-to-high gesture retains its existing painter');
      options=optionsFor(outline,32);await submit(options);
      verify(renderer.stats.outlinedVectorObjects===1&&renderer.stats.textureObjects===0,'Settling at high zoom restores sharp outline vectors');
      await compareFresh(options,'ordinary-to-high outline transition');bounded();

      const priorGeneration=renderer.generation;
      renderer.invalidateImages(['/zoom-gesture-resource-not-present.png']);
      verify(renderer.generation!==priorGeneration,'A resource lifetime change advances the scene generation');
      await submit({...optionsFor(outline,2),viewChanging:true});
      verify(renderer.stats.outlinedVectorObjects===0&&renderer.stats.textureObjects===1,'A changed resource generation immediately replaces an obsolete held painter');
      await compareFresh(optionsFor(outline,2),'resource generation during zoom');bounded();
    }
    verify(!errors.length,'Gesture reuse and density restoration produce no GPU validation errors');
    const retained=resources(renderer);dispose(renderer);
    verify(renderer.device?renderer.rasterCache.bytes===0&&renderer.rasterCache.leases.size===0:renderer.artworkBytes===0&&renderer.artwork.size===0,'Disposal releases retained gesture artwork');
    verify(retained.every(resource=>resource.destroyed||resource.bitmap?.closed||resource.canvas?.width===1),'Disposed retained artwork cannot be reused');
    return {checks,rows,errors,backend:renderer.stats.backend,adapter:renderer.stats.adapter};
  }finally{for(const owned of renderers)owned.destroy();}
}

/** Live drawing pixels keep their own invalidation contract while zoom is held. */
export async function zoomGestureDrawing({forceCanvas2D=false,rendererURL='../src/renderer.mjs',onProgress=()=>{}}={}){
  const {createRenderer}=await import(rendererURL);
  const {createDrawingFigure}=await import('../src/drawing-model.mjs');
  const {DrawingResources}=await import('../src/drawing-resources.mjs');
  const figure=createDrawingFigure(),report=emptyDocument();report.figure_types=[figure];
  const frame=createFrame([createObject(figure,1,0,0)]);report.keyframes=[frame];
  const owner=new DrawingResources(report,{history:false});owner.busy=true;
  onProgress({stage:'drawing surface'});
  const surface=await owner.surface(figure),geometry=buildGeometry(report,frame);
  onProgress({stage:'drawing renderer'});
  const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D,gpuDrawing:false,resources:{drawing:f=>owner.presenter(f)}});
  renderer.resize(320,240,1);
  const options={report,frame,geometry,view:{x:80,y:60,scale:1},cameraEnabled:false,clipToCanvas:false,vfxEnabled:false,editorBackgroundColor:0x00ffffff};
  const paint=async()=>{renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();return read(renderer.canvas);};
  const countColor=(pixels,r,g,b)=>{let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===r&&pixels[i+1]===g&&pixels[i+2]===b&&pixels[i+3]===255)count++;return count;};
  const checks=[];
  const verify=(condition,message)=>{check(condition,message);checks.push(message);onProgress({checks:checks.length,message});};
  try{
    surface.store.set(0,0,new Uint8ClampedArray([30,60,220,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
    const original=await paint();verify(countColor(original,30,60,220)>100,'Live drawing setup paints visible editable pixels');
    options.viewChanging=true;options.view={x:80,y:60,scale:1.2};
    const held=await paint();verify(countColor(held,30,60,220)>100,'The drawing remains visible during zoom');
    surface.store.set(0,0,new Uint8ClampedArray([220,30,60,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
    const changed=await paint();
    verify(countColor(changed,220,30,60)>100&&countColor(changed,30,60,220)===0,'Live drawing revisions appear immediately during zoom');
    surface.store.delete(0,0);owner.present(surface,{x:0,y:0,width:64,height:64});
    const erased=await paint();verify(countColor(erased,220,30,60)===0,'Erasing during zoom clears the displayed drawing');
    options.viewChanging=false;await paint();
    return {checks,backend:renderer.stats.backend,adapter:renderer.stats.adapter};
  }finally{renderer.destroy();owner.dispose();}
}

/** Canvas density restoration must not move the gesture's pause to release.
 * Real worker captures are held at their delivery boundary to exercise edits,
 * cancellation and ownership without replacing the native worker painter. */
export async function zoomArtworkRefinement({rendererURL='../src/renderer.mjs',drawingReferenceURL,heavyPrimitives=10000,includePressure=true,includeDense=true,onProgress=()=>{}}={}){
  const {createRenderer}=await import(rendererURL),{DrawingWorker}=await import('../src/drawing-worker-client.mjs');
  const {createVfx}=await import('../src/vfx.mjs');
  const checks=[],rows=[],renderers=[],held=[],invalidations=new WeakMap(),width=320,height=240,budget=64*MiB;
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const originalRequest=DrawingWorker.prototype.request;
  let hold=false,faults=0,faultOwner=null;
  const faultAttempts=new Map();
  DrawingWorker.prototype.request=function(...args){
    if(args[0]==='preview-raster'&&faults>0){
      if(faultOwner){const key=faultOwner.refinement.running.key;faultAttempts.set(key,(faultAttempts.get(key)??0)+1);}
      faults--;return Promise.reject(Error('Injected artwork worker failure'));
    }
    return originalRequest.apply(this,args).then(result=>{
      if(!hold||args[0]!=='preview-raster'||!result?.bitmap)return result;
      return new Promise(resolve=>held.push({result,request:args[1],release:()=>resolve(result)}));
    });
  };
  const release=()=>{hold=false;for(const item of held.splice(0))item.release();};
  const nextHeld=async renderer=>{
    const deadline=performance.now()+45000;
    while(!held.length&&performance.now()<deadline&&!(renderer?.stats.artworkRefinement.failed>0&&!renderer.artworkRefining))await new Promise(resolve=>setTimeout(resolve,25));
    check(held.length,'The real worker delivers a refinement bitmap before the test deadline',{stats:renderer&&{...renderer.stats.artworkRefinement},lastError:renderer?.stats.lastRefinementError});
    return held[0];
  };
  const closed=async bitmap=>{
    const deadline=performance.now()+5000;
    while(bitmap.width!==0&&!bitmap.closed&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    return bitmap.width===0||Boolean(bitmap.closed);
  };
  const make=async extra=>{
    const updates={count:0};
    const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true,gpuDrawing:false,sharedArtwork:false,onInvalidate:()=>updates.count++,...extra});
    invalidations.set(renderer,updates);
    renderer.resize(width,height,1);renderer.artworkBudget=budget;renderers.push(renderer);return renderer;
  };
  const dispose=renderer=>{renderer.destroy();renderers.splice(renderers.indexOf(renderer),1);};
  const optionsFor=(s,scale,extra={})=>({report:s.report,frame:s.frame,geometry:s.geometry,view:sceneView(scale,s.target,width,height),cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff,...extra});
  const ready=async(renderer,options)=>{await renderer.whenArtworkReady();renderer.render(options);};
  const freshPixels=async(options,extra={})=>{
    const renderer=await make({asyncArtwork:false,...extra});renderer.render({...options,viewChanging:false});
    const pixels=read(renderer.canvas),plan=resources(renderer).map(({resolution,bounds,raster})=>({resolution,bounds,raster}));dispose(renderer);return {pixels,plan};
  };
  const frozenPixels=async(options,extra,history=[])=>{
    const {createRenderer:makeReference}=await import(drawingReferenceURL),reference=await makeReference(document.createElement('canvas'),{forceCanvas2D:true,gpuDrawing:false,sharedArtwork:false,asyncArtwork:false,...extra});
    try{reference.resize(width,height,1);for(const prior of history)reference.render(prior);reference.render(options);return read(reference.canvas);}
    finally{
      reference.destroy();
      const effects=await import(new URL('vfx-canvas.mjs',new URL(drawingReferenceURL,import.meta.url)).href);
      effects.releaseVerificationVfxState?.();
    }
  };
  const exact=async(renderer,options,label,extra)=>{
    const fresh=await freshPixels(options,extra),diff=difference(read(renderer.canvas),fresh.pixels);
    const plan=resources(renderer).map(({resolution,bounds,raster})=>({resolution,bounds,raster}));
    verify(diff.visible>100&&diff.max===0,`${label}: final pixels exactly match fresh native artwork`,{diff,actual:plan,fresh:fresh.plan,stats:{...renderer.stats.artworkRefinement}});
    rows.push({name:label,diff});
  };
  const bounded=(renderer,label)=>{
    const stats=renderer.stats.artworkRefinement;
    verify(renderer.artworkBytes<=budget&&stats?.bytes>=0&&stats.bytes<=budget,`${label}: published and incoming artwork stay within their budgets`,{artworkBytes:renderer.artworkBytes,stats,budget});
    verify(renderer.artworkBytes+stats.bytes<=renderer.artworkBudget,`${label}: published pixels and the running reservation fit the same artwork budget`,{artworkBytes:renderer.artworkBytes,stats,budget:renderer.artworkBudget});
    verify(stats.pending>=0&&stats.pending<=renderer.artwork.size+renderer.onionArtwork.size,`${label}: the queue contains only the current artwork batch`,stats);
  };
  const startHeld=async(s=scene(),extra={})=>{
    const renderer=await make(extra),initial=optionsFor(s,2);renderer.render(initial);
    const cached=resources(renderer),before=rasterCount(renderer);
    const gesture=optionsFor(s,16,{viewChanging:true});renderer.render(gesture);
    hold=true;const settled={...gesture,viewChanging:false},start=performance.now();renderer.render(settled);
    const renderMs=performance.now()-start;
    verify(renderer.artworkRefining,'A settled covered zoom starts asynchronous native artwork refinement');
    verify(resources(renderer).every(record=>cached.includes(record))&&rasterCount(renderer)===before,'Release retains displayed artwork without main-thread native rasterization');
    const pending=await nextHeld(renderer);
    verify(renderer.artworkRefining&&resources(renderer).every(record=>cached.includes(record)),'A held worker completion leaves the currently displayed artwork usable');
    verify(renderer.stats.artworkRefinement.pending===1&&renderer.stats.artworkRefinement.bytes>0,'The held single-object capture reserves one reported working allowance');
    bounded(renderer,'held refinement');
    rows.push({name:'settled render',renderMs,stats:{...renderer.stats.artworkRefinement},capture:{tileCount:pending.result.tileCount,workingBytes:pending.result.workingBytes}});
    return {renderer,s,initial,gesture,settled,pending,cached,before};
  };
  try{
    let job=await startHeld();
    const beforeTasks=job.renderer.stats.artworkRefinement.completed;
    const beforeInvalidation=invalidations.get(job.renderer).count;
    for(let i=0;i<8;i++)job.renderer.render(job.settled);
    verify(held.length===1&&job.renderer.stats.artworkRefinement.completed===beforeTasks,'Repeated settled renders do not enqueue duplicate captures');
    release();await ready(job.renderer,job.settled);await exact(job.renderer,job.settled,'worker refinement');
    verify(job.renderer.stats.artworkRefinement.completed===beforeTasks+1,'Draining repeated settled renders completes exactly one worker capture');
    verify(job.renderer.stats.artworkRefinement.failed===0,'Healthy native refinement completes without falling back after a worker failure');
    verify(invalidations.get(job.renderer).count===beforeInvalidation+1,'Published worker artwork requests its own visible repaint');
    verify(!job.renderer.artworkRefining&&job.renderer.stats.artworkRefinement.pending===0&&job.renderer.stats.artworkRefinement.bytes===0,'A completed batch releases all pending ownership');
    verify(rasterCount(job.renderer)===job.before,'Completed covered refinement performs no native rasterization on the UI thread');
    const completed=job.renderer.stats.artworkRefinement.completed;
    for(let i=0;i<8;i++)job.renderer.render(job.settled);
    verify(job.renderer.stats.artworkRefinement.completed===completed&&!job.renderer.artworkRefining,'Unchanged settled artwork creates no additional worker jobs');
    bounded(job.renderer,'completed refinement');dispose(job.renderer);

    for(const change of ['view','revision','playback','editing','resize','context','dispose']){
      job=await startHeld();const oldBitmap=job.pending.result.bitmap;
      const cancelled=job.renderer.stats.artworkRefinement.cancelled;
      let options;
      if(change==='view')options=optionsFor(job.s,8,{viewChanging:true});
      if(change==='revision'){
        job.s.frame.objects[0].angles[0]+=.2;job.s.geometry=buildGeometry(job.s.report,job.s.frame);
        options=optionsFor(job.s,4,{viewChanging:true});
      }
      if(change==='playback')options=optionsFor(job.s,4,{playing:true});
      if(change==='editing')options={...job.settled,liveEditing:true};
      if(change==='resize'){job.renderer.resize(width,height,1.5);options=job.settled;}
      if(change==='context'){job.renderer.canvas.dispatchEvent(new Event('contextlost'));options=job.settled;}
      if(change==='dispose')dispose(job.renderer);else job.renderer.render(options);
      if(change==='view')verify(resources(job.renderer).every(record=>job.cached.includes(record)),'A new covered gesture remains responsive while obsolete refinement is cancelled');
      if(change==='editing'){
        verify(resources(job.renderer).every(record=>job.cached.includes(record))&&rasterCount(job.renderer)===job.before,'The first editing frame retains unchanged covered artwork without synchronous density backfill');
        job.s.frame.objects[0].angles[0]+=.2;job.s.geometry=buildGeometry(job.s.report,job.s.frame);
        options={...options,geometry:job.s.geometry};job.renderer.render(options);
        verify(rasterCount(job.renderer)>job.before,'Editing geometry while refinement is pending paints the changed figure immediately');
        await exact(job.renderer,options,'geometry edit during cancelled refinement');
      }
      if(change==='revision'||change==='playback'){
        verify(rasterCount(job.renderer)>job.before,`${change}: replacement artwork is painted immediately`);
        await exact(job.renderer,options,`${change} while refinement is pending`);
      }
      release();await job.renderer.whenArtworkReady();
      verify(await closed(oldBitmap),`${change}: a late obsolete bitmap is closed before it can be published`);
      verify(job.renderer.stats.artworkRefinement.cancelled>cancelled,`${change}: the obsolete batch records cancellation`);
      if(change==='context'){
        job.renderer.canvas.dispatchEvent(new Event('contextrestored'));job.renderer.render(options);
        await exact(job.renderer,options,'context restoration after cancelled refinement');
      }
      if(change==='dispose')verify(job.renderer.artworkBytes===0&&job.renderer.artwork.size===0,'Disposal while a capture is held releases the published owner');
      else {bounded(job.renderer,`${change} cancellation`);dispose(job.renderer);}
    }

    job=await startHeld();
    const obsoletePrepared=job.pending.result.bitmap,packetSurface=new OffscreenCanvas(8,8),packetContext=packetSurface.getContext('2d');
    packetContext.fillStyle='rgb(60,90,140)';packetContext.fillRect(0,0,8,8);
    const packetBitmap=packetSurface.transferToImageBitmap(),preparedKey='zoom-refinement-prepared',preparedOptions={report:job.s.report,cameraEnabled:false,view:{x:0,y:0,scale:1}};
    try{
      verify(job.renderer.prepareFrame({key:preparedKey,softwareFrames:true,cameraEnabled:false,hiddenKey:'',uids:Uint32Array.of(1),compatibility:[{bitmap:packetBitmap}]},{report:job.s.report})===preparedKey,'A real prepared playback bitmap is admitted while editor refinement is held');
      const monitor=new OffscreenCanvas(width,height),monitorContext=monitor.getContext('2d');
      verify(job.renderer.renderPreparedInto(preparedKey,{...preparedOptions,target:{context:monitorContext}})&&job.renderer.artworkRefining,'Borrowing a prepared frame for a monitor preserves the editor refinement');
      monitor.width=monitor.height=1;
      const beforePreparedInvalidation=invalidations.get(job.renderer).count;
      verify(job.renderer.renderPrepared(preparedKey,preparedOptions)&&!job.renderer.artworkRefining,'Presenting a prepared playback frame cancels obsolete editor refinement');
      const preparedPixels=read(job.renderer.canvas);
      verify(preparedPixels[0]===60&&preparedPixels[1]===90&&preparedPixels[2]===140&&preparedPixels[3]===255,'The admitted prepared packet presents its own pixels');
      release();await job.renderer.whenArtworkReady();
      verify(await closed(obsoletePrepared)&&difference(read(job.renderer.canvas),preparedPixels).max===0,'A late editor bitmap cannot overwrite prepared playback pixels');
      verify(invalidations.get(job.renderer).count===beforePreparedInvalidation,'Discarding editor work during prepared playback requests no editor repaint');
      const preparedOwner=job.renderer.prepared.get(preparedKey);job.renderer.clearPreparedFrames();
      verify(preparedOwner.canvas.width===1&&packetBitmap.width===8,'Prepared disposal releases its copy without closing the packet owner');
      bounded(job.renderer,'prepared playback cancellation');dispose(job.renderer);
    }finally{packetBitmap.close();packetSurface.width=packetSurface.height=1;}

    const limited=scene(),limitedRenderer=await make(),limitedStart=optionsFor(limited,2),limitedEnd=optionsFor(limited,16);
    limitedRenderer.render(limitedStart);
    const sized=await make({asyncArtwork:false});sized.render(limitedEnd);const replacementBytes=sized.artworkBytes;dispose(sized);
    limitedRenderer.artworkBudget=limitedRenderer.artworkBytes+replacementBytes-1;
    limitedRenderer.render({...limitedEnd,viewChanging:true});const beforeLimited=rasterCount(limitedRenderer);limitedRenderer.render(limitedEnd);
    await ready(limitedRenderer,limitedEnd);
    verify(!limitedRenderer.artworkRefining&&limitedRenderer.stats.artworkRefinement.bytes===0,'An insufficient spare allowance prevents overlapping published and incoming pixels');
    verify(rasterCount(limitedRenderer)>beforeLimited&&limitedRenderer.artworkBytes<=limitedRenderer.artworkBudget,'The established immediate route remains within the artwork budget when refinement cannot be admitted');
    await exact(limitedRenderer,limitedEnd,'bounded admission fallback');dispose(limitedRenderer);

    const faultyOnion=scene(),faultyOnionFrame=createFrame([createObject(faultyOnion.report.figure_types[0],1,203,202)]);
    const faultyOnionFrames=[{frame:faultyOnionFrame,geometry:buildGeometry(faultyOnion.report,faultyOnionFrame),opacity:.35}];
    const faultyOnionRenderer=await make(),onionInitial=optionsFor(faultyOnion,2,{onionFrames:faultyOnionFrames}),onionEnd=optionsFor(faultyOnion,16,{onionFrames:faultyOnionFrames});
    faultyOnionRenderer.render(onionInitial);faultyOnionRenderer.render({...onionEnd,viewChanging:true});
    const beforeOnionInvalidations=invalidations.get(faultyOnionRenderer).count;
    faults=4;faultOwner=faultyOnionRenderer;faultyOnionRenderer.render(onionEnd);await ready(faultyOnionRenderer,onionEnd);faultOwner=null;
    verify(faultyOnionRenderer.stats.artworkRefinement.failed===2&&faults===0,'Main and onion worker failures each consume only one retry before requesting fallback');
    verify(faultAttempts.size===2&&[...faultAttempts.values()].every(attempts=>attempts===2),'Each failed main and onion job makes exactly two worker attempts');
    verify(invalidations.get(faultyOnionRenderer).count===beforeOnionInvalidations+2,'Each exhausted main and onion job requests a fallback repaint');
    verify(faultyOnionRenderer.onionArtwork.size===1&&[...faultyOnionRenderer.onionArtwork.values()].every(record=>record.resolution===16),'A failed onion refinement replaces the retained coarse compositor at the requested density');
    await exact(faultyOnionRenderer,onionEnd,'failed onion compositor recovery');bounded(faultyOnionRenderer,'failed onion recovery');dispose(faultyOnionRenderer);

    for(const transient of [true,false]){
      const s=scene(),renderer=await make(),initial=optionsFor(s,2),settled=optionsFor(s,16);renderer.render(initial);
      renderer.render({...settled,viewChanging:true});const before=rasterCount(renderer);faults=transient?1:2;renderer.render(settled);
      await ready(renderer,settled);await exact(renderer,settled,transient?'transient worker recovery':'permanent worker fallback');
      verify(faults===0,'Worker recovery consumes only its bounded retry allowance');
      if(transient)verify(renderer.stats.artworkRefinement.completed===1&&renderer.stats.artworkRefinement.failed===0&&rasterCount(renderer)===before,'A transient worker failure restores exact density without a UI-thread capture');
      else verify(renderer.stats.artworkRefinement.failed===1&&rasterCount(renderer)>before&&invalidations.get(renderer).count>0,'Exhausted worker failures request an exact immediate fallback instead of retaining coarse pixels');
      bounded(renderer,transient?'transient recovery':'permanent fallback');dispose(renderer);
    }

    const effectScene=scene(),effect=createVfx('shadow','worker-zoom-shadow');
    Object.assign(effect.params,{radius:.4,offsetX:1,offsetY:.5,opacity:.7});
    effectScene.frame.objects[0]._stykVfx={figure:[effect]};effectScene.geometry=buildGeometry(effectScene.report,effectScene.frame);
    job=await startHeld(effectScene);release();await ready(job.renderer,job.settled);
    await exact(job.renderer,job.settled,'path artwork with native effects');dispose(job.renderer);

    const textReport=samplingFixture({kind:'text'}),textFigure=textReport.figure_types[0],textBase=textFigure.segments[0];
    textFigure.segments=Array.from({length:4},(_,i)=>({...textBase,segment_id:i+1,parent_id:0,angle_rad:.413+i*Math.PI/2}));
    textFigure.segment_count=4;const textFrame=createFrame([createObject(textFigure,1,200,200)]);textFrame.objects[0].field28=36;
    textReport.keyframes=[textFrame];const textGeometry=buildGeometry(textReport,textFrame),textScene={report:textReport,frame:textFrame,geometry:textGeometry,target:textGeometry.drawables[0].start};
    job=await startHeld(textScene);release();await ready(job.renderer,job.settled);
    await exact(job.renderer,job.settled,'embedded native glyphs with figure opacity');dispose(job.renderer);

    const {createDrawingFigure}=await import('../src/drawing-model.mjs'),{DrawingResources}=await import('../src/drawing-resources.mjs');
    const mixed=scene(),drawing=createDrawingFigure();drawing.figure_type_id=2;mixed.report.figure_types.push(drawing);
    mixed.frame=createFrame([...mixed.frame.objects,createObject(drawing,2,mixed.target.x-8,mixed.target.y-8)]);mixed.report.keyframes=[mixed.frame];
    mixed.geometry=buildGeometry(mixed.report,mixed.frame);
    const owner=new DrawingResources(mixed.report,{history:false});owner.busy=true;
    try{
      const surface=await owner.surface(drawing),extra={resources:{drawing:figure=>figure===drawing?owner.presenter(figure):undefined}};
      const colorCount=(pixels,r,g,b)=>{let n=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===r&&pixels[i+1]===g&&pixels[i+2]===b&&pixels[i+3]===255)n++;return n;};
      surface.store.set(0,0,new Uint8ClampedArray([30,60,220,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
      mixed.geometry=buildGeometry(mixed.report,mixed.frame);
      job=await startHeld(mixed,extra);
      surface.store.set(0,0,new Uint8ClampedArray([220,30,60,255]));owner.present(surface,{x:0,y:0,width:64,height:64});job.renderer.render(job.settled);
      verify(colorCount(read(job.renderer.canvas),220,30,60)>100,'A live drawing edit appears while unrelated path artwork is still sharpening');
      surface.store.delete(0,0);owner.present(surface,{x:0,y:0,width:64,height:64});job.renderer.render(job.settled);
      verify(colorCount(read(job.renderer.canvas),220,30,60)===0,'Erasing a live drawing remains immediate while path refinement is pending');
      release();await ready(job.renderer,job.settled);
      const actual=read(job.renderer.canvas),fresh=await freshPixels(job.settled,extra),coldDifference=difference(actual,fresh.pixels);
      const historical=await make({asyncArtwork:false,...extra});
      surface.store.set(0,0,new Uint8ClampedArray([30,60,220,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
      historical.render(job.initial);historical.render(job.gesture);historical.render(job.settled);
      surface.store.set(0,0,new Uint8ClampedArray([220,30,60,255]));owner.present(surface,{x:0,y:0,width:64,height:64});historical.render(job.settled);
      surface.store.delete(0,0);owner.present(surface,{x:0,y:0,width:64,height:64});historical.render(job.settled);
      const historyDifference=difference(actual,read(historical.canvas));
      verify(historyDifference.max===0,'Drawing edit during path refinement exactly matches independent synchronous drawing history',historyDifference);
      // Existing native painting retains an alpha-edge history variance after
      // image painting (alpha max 3 here); direct Canvas→ImageBitmap transfer
      // changes no pixels. Keep the fresh difference explicit, never use it as
      // a tolerance for the worker-versus-history regression check.
      rows.push({name:'drawing edit during path refinement',diff:historyDifference,coldFreshDifference:coldDifference});
      dispose(historical);dispose(job.renderer);
    }finally{owner.dispose();}

    const cel=createDrawingFigure({figureTypeId:3}),celReport=emptyDocument();celReport.figure_types=[cel];
    const celFrame=createFrame([createObject(cel,1,200,200)]),celEffect=createVfx('shadow','published-cel-shadow');
    Object.assign(celEffect.params,{radius:.4,offsetX:1,offsetY:.5,opacity:.7});celFrame.objects[0]._stykVfx={figure:[celEffect]};celReport.keyframes=[celFrame];
    const celOwner=new DrawingResources(celReport,{history:false});celOwner.busy=true;
    try{
      const surface=await celOwner.surface(cel),pixels=new Uint8ClampedArray(64*64*4);
      for(let i=0;i<pixels.length;i+=4)pixels.set([30,60,220,255],i);
      celOwner.apply(cel,[{tx:0,ty:0,after:pixels}],'after');await celOwner.flush();
      verify(Boolean(cel.image_assets[0].styk_tiles)&&surface.published?.revision===surface.revision&&surface.revision===cel._styk.drawing.revision&&surface.published.url===cel.image_assets[0].styk_tiles,'The drawing refinement fixture starts with a published cel at its semantic revision');
      const celScene={report:celReport,frame:celFrame,geometry:buildGeometry(celReport,celFrame),target:{x:264,y:232}};
      const extra={resources:{drawing:figure=>figure===cel?celOwner.presenter(figure):undefined}};
      job=await startHeld(celScene,extra);release();await ready(job.renderer,job.settled);
      await exact(job.renderer,job.settled,'published drawing cel with native effects',extra);
      verify(rasterCount(job.renderer)===job.before,'Published drawing pixels and native effects sharpen without a UI-thread native capture');
      bounded(job.renderer,'published drawing refinement');dispose(job.renderer);

      const authoritativeExtra={resources:{drawing:figure=>figure===cel?celOwner.rasterPresenter(surface):undefined}};
      const completeDerivedPreview=async level=>{
        const stamp=surface.stamp,pixelStamp=surface.pixelStamp;
        celOwner.previews.scratch(surface,{x:0,y:0,width:64,height:64},{level});
        const deadline=performance.now()+30000;
        while((surface.stamp===stamp||celOwner.previews.active||celOwner.previews.queue.size)&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
        verify(surface.stamp>stamp&&surface.pixelStamp===pixelStamp&&!celOwner.previews.active&&celOwner.previews.queue.size===0,'A real derived drawing preview completes with only its broad presentation stamp changed',{stamp,currentStamp:surface.stamp,pixelStamp:surface.pixelStamp});
      };
      job=await startHeld(celScene,authoritativeExtra);
      const previewCached=resources(job.renderer)[0],previewBitmap=job.pending.result.bitmap,previewCancelled=job.renderer.stats.artworkRefinement.cancelled;
      await completeDerivedPreview(0);job.renderer.render(job.settled);
      verify(job.renderer.artworkRefining&&resources(job.renderer).includes(previewCached)&&rasterCount(job.renderer)===job.before&&job.renderer.stats.artworkRefinement.cancelled===previewCancelled,'A derived preview completion preserves the held native capture and displayed artwork without UI rasterization');
      release();await ready(job.renderer,job.settled);
      verify(resources(job.renderer).some(record=>record.bitmap===previewBitmap)&&job.renderer.stats.artworkRefinement.completed===1&&job.renderer.stats.artworkRefinement.failed===0,'A native drawing capture remains current and is adopted after a derived preview stamp change');
      const adopted=resources(job.renderer)[0],adoptedPixels=read(job.renderer.canvas);
      await completeDerivedPreview(1);job.renderer.render(job.settled);
      verify(resources(job.renderer).includes(adopted)&&adopted.bitmap===previewBitmap&&rasterCount(job.renderer)===job.before&&difference(read(job.renderer.canvas),adoptedPixels).max===0,'A later derived preview preserves the exact adopted native bitmap');
      await exact(job.renderer,job.settled,'derived preview during and after native drawing refinement',authoritativeExtra);
      bounded(job.renderer,'derived preview native capture');dispose(job.renderer);

      const synchronous=await make({asyncArtwork:false,...authoritativeExtra}),synchronousEnd=optionsFor(celScene,16);synchronous.render(synchronousEnd);
      const synchronousRecord=resources(synchronous)[0],synchronousBefore=rasterCount(synchronous);
      await completeDerivedPreview(2);synchronous.render(synchronousEnd);
      verify(!resources(synchronous).includes(synchronousRecord)&&rasterCount(synchronous)>synchronousBefore,'Synchronous cold drawing artwork retains broad derived-preview invalidation');dispose(synchronous);

      for(const field of ['pixelStamp','revision','publishedRevision','publishedUrl','store','owner','dispose']){
        job=await startHeld(celScene,authoritativeExtra);const nativeBitmap=job.pending.result.bitmap,cached=resources(job.renderer)[0],oldStore=surface.store;
        let restore;
        if(field==='publishedRevision'){const value=surface.published.revision;surface.published.revision++;restore=()=>{surface.published.revision=value;};}
        else if(field==='publishedUrl'){const value=surface.published.url;surface.published.url=null;restore=()=>{surface.published.url=value;};}
        else if(field==='store'){surface.store=oldStore.fork();restore=()=>{surface.store=oldStore;};}
        else if(field==='owner'){const value=surface.owner;surface.owner=Object.create(value);restore=()=>{surface.owner=value;};}
        else if(field==='dispose'){const value=surface.disposed;surface.disposed=true;surface.store=null;restore=()=>{surface.disposed=value;surface.store=oldStore;};}
        else {const value=surface[field];surface[field]=(value??0)+1;restore=()=>{surface[field]=value;};}
        try{
          job.renderer.render(job.settled);
          verify(!job.renderer.artworkRefining&&!resources(job.renderer).includes(cached)&&cached.destroyed,`${field}: authoritative drawing changes invalidate pending native artwork immediately`);
          const expected=await freshPixels(job.settled,authoritativeExtra),diff=difference(read(job.renderer.canvas),expected.pixels);
          verify(diff.max===0,`${field}: immediate drawing pixels exactly match the fresh authoritative resource`,diff);
          release();await job.renderer.whenArtworkReady();
          verify(await closed(nativeBitmap)&&job.renderer.stats.artworkRefinement.cancelled>0,`${field}: a late native bitmap cannot publish over changed authoritative drawing state`);
          verify(difference(read(job.renderer.canvas),expected.pixels).max===0,`${field}: late completion preserves the correct immediate pixels`);
          bounded(job.renderer,`${field} drawing authority`);
        }finally{restore();dispose(job.renderer);}
      }

      const fractionalRenderer=await make(extra),fractionalInitial=optionsFor(celScene,2),fractionalEnd=optionsFor(celScene,11.464);
      fractionalEnd.view.x+=.37;fractionalEnd.view.y-=.61;
      fractionalRenderer.render(fractionalInitial);const fractionalBefore=rasterCount(fractionalRenderer);
      fractionalRenderer.render({...fractionalEnd,viewChanging:true});hold=true;fractionalRenderer.render(fractionalEnd);
      verify(fractionalRenderer.artworkRefining&&rasterCount(fractionalRenderer)===fractionalBefore,'A nonbucket filtered drawing zoom restores its exact viewport through the worker');
      await nextHeld(fractionalRenderer);release();await ready(fractionalRenderer,fractionalEnd);
      const actual=read(fractionalRenderer.canvas),direct=new OffscreenCanvas(width,height),directContext=direct.getContext('2d',{willReadFrequently:true});
      let directPixels;
      try{directContext.setTransform(...cameraMatrix(fractionalEnd));drawGeometry(directContext,celScene.geometry,extra.resources);directPixels=read(direct);}
      finally{releaseGeometryResources(directContext);direct.width=direct.height=1;}
      const directDifference=difference(actual,directPixels);
      verify(directDifference.visible>100&&directDifference.max===0,'Nonbucket filtered drawing pixels exactly match the independent direct native painter',directDifference);
      rows.push({name:'nonbucket filtered drawing direct native',scale:11.464,diff:directDifference});
      if(drawingReferenceURL){
        const {createRenderer:makeReference}=await import(drawingReferenceURL),reference=await makeReference(document.createElement('canvas'),{forceCanvas2D:true,gpuDrawing:false,sharedArtwork:false,asyncArtwork:false,...extra});
        let referencePixels;
        try{reference.resize(width,height,1);reference.render(fractionalEnd);referencePixels=read(reference.canvas);}
        finally{
          reference.destroy();
          const referenceEffects=await import(new URL('vfx-canvas.mjs',new URL(drawingReferenceURL,import.meta.url)).href);
          referenceEffects.releaseVerificationVfxState?.();
        }
        const controlDifference=difference(actual,referencePixels);
        verify(controlDifference.visible>100&&controlDifference.max===0,'Nonbucket filtered drawing pixels exactly match the independent frozen Gaussian control',controlDifference);
        rows.push({name:'nonbucket filtered drawing frozen Gaussian control',reference:drawingReferenceURL,scale:11.464,diff:controlDifference});
      }
      verify(rasterCount(fractionalRenderer)===fractionalBefore,'Nonbucket drawing refinement performs no UI-thread native captures');bounded(fractionalRenderer,'nonbucket drawing refinement');
      const translatedFrame=createFrame([createObject(cel,1,201.25,199.5)]);translatedFrame.objects[0]._stykVfx=celFrame.objects[0]._stykVfx;
      const translatedGeometry=buildGeometry(celReport,translatedFrame);
      Object.defineProperty(translatedGeometry.orderedObjects[0],'renderSource',{value:celScene.geometry.orderedObjects[0]});
      const translatedOptions={...fractionalEnd,frame:translatedFrame,geometry:translatedGeometry};fractionalRenderer.render(translatedOptions);await ready(fractionalRenderer,translatedOptions);
      const translatedPixels=read(fractionalRenderer.canvas),translatedNative=new OffscreenCanvas(width,height),translatedContext=translatedNative.getContext('2d',{willReadFrequently:true});
      let translatedExpected;
      try{translatedContext.setTransform(...cameraMatrix(translatedOptions));drawGeometry(translatedContext,translatedGeometry,extra.resources);translatedExpected=read(translatedNative);}
      finally{releaseGeometryResources(translatedContext);translatedNative.width=translatedNative.height=1;}
      const translatedDifference=difference(translatedPixels,translatedExpected);
      verify(translatedDifference.visible>100&&translatedDifference.max===0,'A translation-only drawing pose with retained canonical geometry exactly matches native pixels',translatedDifference);
      rows.push({name:'translated nonbucket drawing direct native',scale:11.464,diff:translatedDifference});dispose(fractionalRenderer);

      const overlap=drawingOverlapScene(cel,celFrame.objects[0]._stykVfx),softwareOverlapDifferences=[];
      for(const scale of [1.04,11.464])for(const [background,editorBackgroundColor]of [['transparent',0x00ffffff],['opaque',0xfff4f4f4],['colored',0xff496787]]){
        const label=`filtered drawing overlap ${background} ${scale}x`,renderer=await make(extra);
        const end=optionsFor(overlap,scale,{editorBackgroundColor});end.view.x+=.37;end.view.y-=.61;
        renderer.render(end);await exact(renderer,end,`${label} cold`,extra);
        const coldPixels=read(renderer.canvas),coldCel=resources(renderer).find(record=>record.drawingViewport);
        verify(coldCel?.canvas?.width===width,`${label}: the cold native cel has its original full viewport`);
        const coldCelPixels=read(coldCel.canvas);
        if(drawingReferenceURL){
          const control=await frozenPixels(end,extra),diff=difference(read(renderer.canvas),control);
          verify(diff.visible>100&&diff.max===0,`${label}: cold complete overlaps exactly match the independent frozen native control`,diff);
          rows.push({name:`${label} cold frozen control`,diff});
          if(scale===1.04){
            const software=await make({asyncArtwork:false,...extra}),nativeDrawing=software.drawDrawingArtwork;
            software.drawDrawingArtwork=function(...args){
              const context=this.softwareRasterContext;
              this.softwareRasterContext=(canvas,options)=>context.call(this,canvas,{...options,willReadFrequently:true});
              try{return nativeDrawing.apply(this,args);}finally{this.softwareRasterContext=context;}
            };
            try{software.render(end);const oldDifference=difference(read(software.canvas),control);softwareOverlapDifferences.push(oldDifference);rows.push({name:`${label} prior software drawing storage`,diff:oldDifference});}
            finally{dispose(software);}
          }
        }
        dispose(renderer);
        const sharpening=await make(extra),initial=optionsFor(overlap,.5,{editorBackgroundColor});
        sharpening.render(initial);const before=rasterCount(sharpening),cached=resources(sharpening);
        sharpening.render({...end,viewChanging:true});hold=true;sharpening.render(end);
        verify(sharpening.artworkRefining&&rasterCount(sharpening)===before,`${label}: covered settlement starts worker refinement with zero UI-thread captures`);
        const pending=await nextHeld(sharpening);
        verify(resources(sharpening).every(record=>cached.includes(record))&&pending.result.bitmap.width>0,`${label}: displayed overlap pixels remain usable while a completion is held`);
        const viewportSignature=[width,height,...pending.request.matrix].join('|');
        verify(pending.result.tileCount===1&&pending.request.nativePadding===true&&pending.request.width===width&&pending.request.height===height&&cached.some(record=>record.latestViewportSignature===viewportSignature),`${label}: worker capture preserves the original full native viewport and canonical matrix`,{request:pending.request,tileCount:pending.result.tileCount,expected:cached.map(record=>record.latestViewportSignature)});
        bounded(sharpening,`${label} held`);release();await ready(sharpening,end);
        const actual=read(sharpening.canvas),historical=await make({asyncArtwork:false,...extra});
        let historyPixels;
        try{historical.render(initial);historical.render({...end,viewChanging:true});historical.render(end);historyPixels=read(historical.canvas);}
        finally{dispose(historical);}
        const historyDifference=difference(actual,historyPixels),celDifference=difference(read(pending.result.bitmap),coldCelPixels);
        verify(historyDifference.visible>100&&historyDifference.max===0,`${label}: settled whole-scene pixels exactly match independent synchronous native history`,historyDifference);
        verify(celDifference.visible>100&&celDifference.max===0,`${label}: the adopted worker cel exactly matches the cold full-domain native cel`,celDifference);
        // Native path painting has an existing context-history variance: the
        // frozen control reproduces119changed pixels and alpha max32 here at
        // fitted1.04. Preserve exact whole-scene history and exact cel pixels;
        // record the cold difference separately instead of loosening either.
        rows.push({name:`${label} settled native history`,diff:historyDifference,celDifference,coldHistoryDifference:difference(actual,coldPixels)});
        if(drawingReferenceURL){
          const controlHistory=await frozenPixels(end,extra,[initial,{...end,viewChanging:true}]),diff=difference(actual,controlHistory);
          verify(diff.visible>100&&diff.max===0,`${label}: completed overlap pixels exactly match the independent frozen native control`,diff);
          rows.push({name:`${label} settled frozen control`,diff,nativeControlColdHistoryDifference:difference(controlHistory,coldPixels)});
        }
        verify(sharpening.stats.artworkRefinement.completed>0&&sharpening.stats.artworkRefinement.failed===0&&rasterCount(sharpening)===before,`${label}: healthy worker captures complete without synchronous fallback`);
        const owners=resources(sharpening);
        verify(owners.some(record=>record.bitmap===pending.result.bitmap),`${label}: the held worker bitmap becomes published artwork`);
        bounded(sharpening,`${label} completed`);dispose(sharpening);
        verify(pending.result.bitmap.width===0&&owners.every(record=>record.destroyed&&(!record.bitmap||record.bitmap.width===0)),`${label}: disposal closes all adopted overlap artwork`);
      }
      if(drawingReferenceURL)verify(softwareOverlapDifferences.some(diff=>diff.max>0),'The complete-overlap fixture exposes the prior software drawing-storage pixel defect',softwareOverlapDifferences);

      job=await startHeld(celScene,extra);const obsolete=job.pending.result.bitmap;
      const editedPixels=pixels.slice();for(let i=0;i<editedPixels.length;i+=4)editedPixels.set([220,30,60,255],i);
      celOwner.apply(cel,[{tx:0,ty:0,before:pixels,after:editedPixels}],'after');job.renderer.render(job.settled);
      verify(surface.published.revision!==surface.revision&&cel._styk.drawing.revision===surface.revision,'The drawing edit advances its semantic revision before publication');
      const changedDrawing=read(job.renderer.canvas);let red=0,blue=0;
      for(let i=0;i<changedDrawing.length;i+=4)if(changedDrawing[i+3]===255){if(changedDrawing[i]===220&&changedDrawing[i+1]===30&&changedDrawing[i+2]===60)red++;if(changedDrawing[i]===30&&changedDrawing[i+1]===60&&changedDrawing[i+2]===220)blue++;}
      verify(red>100&&blue===0,'An unpublished drawing edit replaces its held filtered artwork immediately',{red,blue});
      await exact(job.renderer,job.settled,'live drawing revision during drawing refinement',extra);
      release();await job.renderer.whenArtworkReady();
      verify(await closed(obsolete)&&job.renderer.stats.artworkRefinement.cancelled>0,'A late filtered bitmap cannot overwrite a newer unpublished drawing revision');
      await exact(job.renderer,job.settled,'drawing revision after obsolete worker completion',extra);
      bounded(job.renderer,'drawing revision cancellation');dispose(job.renderer);
    }finally{celOwner.dispose();}

    if(includePressure){
    const pressure=scene(),pressured=await make();
    for(let i=0;i<128&&pressured.artworkBytes<budget*.95;i++){
      const frame=createFrame([createObject(pressure.report.figure_types[0],100+i,200,200)]);frame.objects[0].angles[0]+=(i+1)*.001;
      pressured.render({...optionsFor(pressure,2),frame,geometry:buildGeometry(pressure.report,frame)});
      await yieldSceneTask();
    }
    verify(pressured.artworkBytes>budget*.9,'Pressure setup retains prior, unused native artwork near the existing cache limit');
    const obsolete=resources(pressured),pressureInitial=optionsFor(pressure,2);pressured.render(pressureInitial);
    const current=resources(pressured).at(-1),pressureBefore=rasterCount(pressured),pressureEnd=optionsFor(pressure,16);
    pressured.render({...pressureEnd,viewChanging:true});hold=true;pressured.render(pressureEnd);
    verify(pressured.artworkRefining&&rasterCount(pressured)===pressureBefore,'Old unused artwork pressure does not force synchronous density backfill');
    await nextHeld(pressured);
    verify(resources(pressured).includes(current)&&!current.destroyed,'Preparing under cache pressure protects the currently displayed pixels');
    verify(obsolete.some(record=>record.destroyed||record.canvas?.width===1||record.bitmap?.width===0),'Working admission releases unused earlier-frame artwork');
    bounded(pressured,'pressure admission');release();await ready(pressured,pressureEnd);await exact(pressured,pressureEnd,'retained-cache pressure');
    verify(rasterCount(pressured)===pressureBefore,'Retained-cache pressure sharpens through the worker with zero UI-thread native captures');
    bounded(pressured,'pressure completion');dispose(pressured);
    }

    if(includeDense){
    const dense=scene(),figure=dense.report.figure_types[0],base=figure.segments[0];
    figure.segments=Array.from({length:heavyPrimitives},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:20,thickness:.08,angle_rad:i*Math.PI*2/heavyPrimitives+.413}));
    figure.segment_count=heavyPrimitives;dense.frame=createFrame([createObject(figure,1,200,200)]);
    dense.report.keyframes=[dense.frame];dense.geometry=buildGeometry(dense.report,dense.frame);dense.target={x:200,y:200};
    job=await startHeld(dense);verify(dense.geometry.drawables.length===heavyPrimitives,'The dense fixture exercises one indivisible object with all requested primitives');
    release();await ready(job.renderer,job.settled);await exact(job.renderer,job.settled,'single dense object');
    verify(rasterCount(job.renderer)===job.before,'A single dense object finishes sharpening without UI-thread native rasterization');
    bounded(job.renderer,'single dense object');dispose(job.renderer);
    }
    return {checks,rows,backend:'Canvas 2D fallback'};
  }catch(error){
    error.partialChecks=checks;error.partialRows=rows;throw error;
  }finally{
    release();DrawingWorker.prototype.request=originalRequest;
    for(const renderer of renderers)renderer.destroy();
  }
}

/** Run in a fresh Canvas-only realm: worker resource scopes cannot borrow a
 * registered WebGPU presenter. This exercises real published tile decoding,
 * the accelerated drawing pool, native CPU effects, and final bitmap ownership. */
export async function zoomDrawingCaptureNative({onProgress=()=>{},disableWebGL=false}={}){
  const [{createDrawingFigure},{DrawingResources},{createVfx},{capturePreviewRaster},{drawingPreviewPlan,preparePreviewDrawings},
    {VfxCPU,releaseVfxCPU},{releaseVfxGPU,vfxGPUStats},{releaseVfxSoftwareResources,vfxSoftwareResourceStats}]=await Promise.all([
    import('../src/drawing-model.mjs'),import('../src/drawing-resources.mjs'),import('../src/vfx.mjs'),import('../src/renderer-raster-capture.mjs'),
    import('../src/renderer-preview-drawing-resources.mjs'),import('../src/vfx-cpu.mjs'),import('../src/vfx-gpu.mjs'),import('../src/vfx-canvas.mjs')]);
  const checks=[],rows=[],width=320,height=240;
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const cel=createDrawingFigure({figureTypeId:3}),report=emptyDocument();report.figure_types=[cel];
  const owner=new DrawingResources(report,{history:false});owner.busy=true;
  const getContext=OffscreenCanvas.prototype.getContext,runPixels=VfxCPU.prototype.runPixels;
  let cpuRuns=0;
  try{
    await owner.surface(cel);const pixels=new Uint8ClampedArray(64*64*4);
    for(let i=0;i<pixels.length;i+=4)pixels.set([30,60,220,255],i);
    owner.apply(cel,[{tx:0,ty:0,after:pixels}],'after');await owner.flush();
    const shadow=createVfx('shadow','cpu-published-cel-shadow');Object.assign(shadow.params,{radius:.4,offsetX:1,offsetY:.5,opacity:.7});
    const overlap=drawingOverlapScene(cel,{figure:[shadow]}),celItems=overlap.geometry.drawables.filter(item=>item.fig===cel);
    verify(celItems.length===1&&celItems[0].type==='image','CPU capture receives one published drawing drawable');
    releaseVfxGPU();
    if(disableWebGL)OffscreenCanvas.prototype.getContext=function(type,...args){return type==='webgl2'?null:getContext.call(this,type,...args);};
    VfxCPU.prototype.runPixels=function(...args){cpuRuns++;return runPixels.apply(this,args);};
    for(const scale of [1.04,11.464])for(const [background,color]of [['transparent',null],['opaque','#f4f4f4'],['colored','#496787']]){
      const label=`${disableWebGL?'CPU':'GPU'} filtered drawing overlap ${background} ${scale}x`,view=sceneView(scale,overlap.target,width,height);view.x+=.37;view.y-=.61;
      const matrix=cameraMatrix({report:overlap.report,frame:overlap.frame,view,cameraEnabled:false}),plan=drawingPreviewPlan(celItems);
      let provider,bitmap,actualCanvas,expectedCanvas;
      const beforeCPU=cpuRuns,gpuBefore=vfxGPUStats();
      try{
        provider=await preparePreviewDrawings(plan);const pool=provider.rasterSurfaces,drawingProvider=provider.drawingProvider;
        const decodedStore=provider.drawing(cel).store,liveStore=owner.presenter(cel).store,decodedTiles=[...decodedStore],liveTiles=[...liveStore];
        verify(decodedStore.bytes===liveStore.bytes&&decodedTiles.length===liveTiles.length&&decodedTiles.every((tile,index)=>tile.tx===liveTiles[index].tx&&tile.ty===liveTiles[index].ty&&tile.pixels.every((value,i)=>value===liveTiles[index].pixels[i])),`${label}: published preparation preserves every authoritative tile pixel`);
        const captured=capturePreviewRaster({drawables:celItems},{width,height,matrix,maxBytes:64*MiB,resourceBytes:plan.bytes,resources:provider,nativePadding:true});bitmap=captured.bitmap;
        const captureCPURuns=cpuRuns-beforeCPU,gpuAfterCapture=vfxGPUStats();
        verify(disableWebGL?captureCPURuns>0:captureCPURuns===0&&gpuAfterCapture.cpuFallbacks===gpuBefore.cpuFallbacks&&gpuAfterCapture.calls>gpuBefore.calls,`${label}: capture executes its required native ${disableWebGL?'CPU':'GPU'} route`,{captureCPURuns,gpuBefore,gpuAfterCapture});
        verify(vfxSoftwareResourceStats().bytes===0,`${label}: capture releases retained software effects before publishing its bitmap`);
        const attributes=pool.context.getContextAttributes();
        verify(attributes.willReadFrequently===false&&(attributes.colorType===undefined||attributes.colorType==='unorm8'),`${label}: the prepared drawing uses its accelerated UNORM8 pool`,attributes);
        verify(captured.bytes===width*height*4&&captured.tileCount===1&&captured.workingBytes<=64*MiB,`${label}: native viewport storage is admitted at four bytes per pixel`,captured);
        verify(!pool.busy&&pool.surface.width===1&&pool.surface.height===1,`${label}: capture releases its scratch pixels before publication`);
        const decoded=[...drawingProvider.entries.values()];provider.dispose();provider=null;
        verify(pool.surface===null&&bitmap.width===width&&bitmap.height===height,`${label}: disposing the decoded provider preserves the transferred pixels`);
        verify(drawingProvider.entries.size===0&&drawingProvider.bytes===0&&decoded.every(entry=>entry.levels===null&&entry._scratches===null),`${label}: disposal releases decoded drawing and mip/scratch ownership`);
        const initialize=canvas=>{const context=canvas.getContext('2d',{willReadFrequently:true});if(color){context.fillStyle=color;context.fillRect(0,0,width,height);}return context;};
        actualCanvas=new OffscreenCanvas(width,height);const actual=initialize(actualCanvas);
        actual.setTransform(...matrix);drawGeometry(actual,{drawables:overlap.geometry.drawables.filter(item=>item.fig===overlap.report.figure_types[0])});
        actual.setTransform(1,0,0,1,0,0);actual.drawImage(bitmap,0,0);
        actual.setTransform(...matrix);drawGeometry(actual,{drawables:overlap.geometry.drawables.filter(item=>item.fig===overlap.report.figure_types[2])});
        expectedCanvas=new OffscreenCanvas(width,height);const expected=initialize(expectedCanvas);expected.setTransform(...matrix);
        drawGeometry(expected,overlap.geometry,{drawing:figure=>figure===cel?owner.presenter(figure):undefined});
        const diff=difference(read(actualCanvas),read(expectedCanvas));
        verify(diff.visible>100&&diff.max===0,`${label}: transferred drawing pixels compose exactly like the independent native CPU painter`,diff);
        verify(disableWebGL?cpuRuns>beforeCPU:cpuRuns===beforeCPU&&vfxGPUStats().calls>gpuAfterCapture.calls&&vfxGPUStats().cpuFallbacks===gpuBefore.cpuFallbacks,`${label}: the independent reference uses the same native effect backend`);
        const software=vfxSoftwareResourceStats();
        rows.push({name:label,diff,attributes,bytes:captured.bytes,captureCPURuns,referenceCPURuns:cpuRuns-beforeCPU-captureCPURuns,gpuBefore,gpuAfterCapture});
        releaseVfxCPU();releaseVfxGPU();releaseVfxSoftwareResources();
        verify(vfxSoftwareResourceStats().bytes===0,`${label}: completion releases retained software effect pixels`,software);
      }finally{
        provider?.dispose();bitmap?.close();
        if(actualCanvas){releaseGeometryResources(actualCanvas.getContext('2d'));actualCanvas.width=actualCanvas.height=1;}
        if(expectedCanvas){releaseGeometryResources(expectedCanvas.getContext('2d'));expectedCanvas.width=expectedCanvas.height=1;}
      }
    }
    return {checks,rows,backend:disableWebGL?'Canvas 2D native CPU fallback':'Canvas 2D native GPU capture'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{OffscreenCanvas.prototype.getContext=getContext;VfxCPU.prototype.runPixels=runPixels;owner.dispose();releaseVfxCPU();releaseVfxGPU();releaseVfxSoftwareResources();}
}

export const zoomDrawingCaptureCPU=options=>zoomDrawingCaptureNative({...options,disableWebGL:true});

/** Compare the streamed scene recipe with the independent full native painter
 * in a Canvas-only realm, including its genuine missing-WebGL route. */
export async function zoomSceneCaptureNative({onProgress=()=>{},disableWebGL=false}={}){
  const [{createVfx,setVfxStack},{capturePreviewRaster},{cameraSceneDrawables,cameraRefinementScene},{connectedVfxGeometry},
    {sendDrawingComposite},{applyDocumentChunk},{PlaybackResources},{drawExportScene},
    {VfxCPU,releaseVfxCPU},{releaseVfxGPU,vfxGPUStats},{releaseVfxSoftwareResources,vfxSoftwareResourceStats}]=await Promise.all([
    import('../src/vfx.mjs'),import('../src/renderer-raster-capture.mjs'),import('../src/renderer-camera-scene.mjs'),import('../src/vfx-connected.mjs'),
    import('../src/drawing-composite-transport.mjs'),import('../src/document-transport.mjs'),import('../src/playback-resources.mjs'),import('../src/export-frame-core.mjs'),
    import('../src/vfx-cpu.mjs'),import('../src/vfx-gpu.mjs'),import('../src/vfx-canvas.mjs')]);
  const checks=[],rows=[],width=193,height=145,maxBytes=64*MiB;
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const report=samplingFixture({kind:'outline',opacity:.67}),figure=report.figure_types[0];
  report.canvas_width=160;report.canvas_height=120;report._styk.layers.fixed.scene.visible=true;
  const parent=createObject(figure,1,55.37,48.61),child=createObject(figure,2,0,0,{scale:.7,join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}});
  parent._stykVfxScope=child._stykVfxScope=1;
  const glow=createVfx('glow','scene-native-owner');glow.params.radius=.6;
  const shadow=createVfx('shadow','scene-native-inner');Object.assign(shadow.params,{radius:.4,offsetX:.3,offsetY:.1,opacity:.5});
  const tint=createVfx('tint','scene-native-segment');tint.params.mix=.37;
  setVfxStack(parent,{kind:'figure'},[glow]);setVfxStack(child,{kind:'figure'},[shadow]);
  setVfxStack(child,{kind:'segment',figureTypeId:figure.figure_type_id,handleId:1},[tint]);
  const frame=createFrame([parent,child]);frame.camera={x:.37,y:-.61,scale:1.09,angle_rad:.13,is_default:false};report.keyframes=[frame];
  const blur=createVfx('blur','scene-native-directional');Object.assign(blur.params,{radius:.75,mode:1,angle:23});frame._stykVfx={figure:[blur]};
  const geometry=connectedVfxGeometry(buildGeometry(report,frame),frame,report);
  const nestedOwner=geometry.drawables.find(item=>item._movieclipInner)?._movieclipInner.owner;
  if(nestedOwner)nestedOwner.opacity=.73;
  const getContext=OffscreenCanvas.prototype.getContext,runPixels=VfxCPU.prototype.runPixels;let cpuRuns=0;
  releaseVfxGPU();
  if(disableWebGL)OffscreenCanvas.prototype.getContext=function(type,...args){return type==='webgl2'?null:getContext.call(this,type,...args);};
  VfxCPU.prototype.runPixels=function(...args){cpuRuns++;return runPixels.apply(this,args);};
  const resources=()=>new PlaybackResources({maxBytes,maxPacketBytes:0,maxRasterBytes:0,maxVectorBytes:0,maxSoftwareFilterBytes:maxBytes});
  try{
    verify(geometry.drawables.some(item=>item._movieclipInner&&item._movieclipOwner)&&geometry.drawables.some(item=>item.obj._stykVfx?.[`${figure.figure_type_id}/1`]),'The scene fixture contains nested connected owners and a segment effect');
    for(const background of ['transparent','colored','linear mix']){
      if(background==='linear mix'){
        delete frame._stykBackgroundColor;
        report.backgrounds=[{background_id:1,kind:3,color_a:0xff234567,color_b:0xffbbaacc,x1:.13,y1:.07,x2:.91,y2:.82},
          {background_id:2,kind:2,color:0xff6a397b}];frame.background_id=1;frame.background_id_b=2;frame.background_mix=93;
      }else {frame._stykBackgroundColor=background==='transparent'?0:0xff496787;report.backgrounds=[];frame.background_mix=0;}
      const label=`${disableWebGL?'CPU':'GPU'} native scene ${background}`,options={report,frame,geometry,generatorBatch:null},items=cameraSceneDrawables(options),scene=cameraRefinementScene(options,items);
      verify(scene&&scene.frame.objects===undefined&&!scene.report.figure_types&&!scene.report.keyframes,`${label}: the worker recipe contains resolved scene metadata without an editable document`);
      let snapshot,snapshotBytes=0;
      await sendDrawingComposite({async request(kind,{chunk}){check(kind==='composite-chunk','Scene capture transports evaluated artwork only');snapshot=applyDocumentChunk(snapshot,chunk);snapshotBytes+=chunk.estimatedBytes??64;return {}; }},items,{maxBytes});
      let provider=resources(),referenceProvider=resources(),bitmap,expectedCanvas;
      const beforeCPU=cpuRuns,gpuBefore=vfxGPUStats();
      try{
        const captured=capturePreviewRaster(snapshot,{width,height,maxBytes,snapshotBytes,scene,resources:provider});bitmap=captured.bitmap;
        const captureCPURuns=cpuRuns-beforeCPU,gpuAfterCapture=vfxGPUStats(),pool=provider.rasterSurfaces;
        verify(disableWebGL?captureCPURuns>0:captureCPURuns===0&&gpuAfterCapture.calls>gpuBefore.calls&&gpuAfterCapture.cpuFallbacks===gpuBefore.cpuFallbacks,`${label}: capture uses the genuine native ${disableWebGL?'CPU':'GPU'} backend`,{captureCPURuns,gpuBefore,gpuAfterCapture});
        verify(captured.tileCount===1&&captured.nativePadding===true&&captured.bytes===width*height*4&&captured.workingBytes<=maxBytes,`${label}: the complete native domain and four-byte output remain bounded`,captured);
        verify(pool.context.getContextAttributes().willReadFrequently===false&&!pool.busy&&pool.surface.width===1&&pool.surface.height===1&&vfxSoftwareResourceStats().bytes===0,`${label}: capture releases scene scratch before bitmap publication`);
        provider.dispose();provider=null;
        verify(pool.surface===null&&bitmap.width===width&&bitmap.height===height,`${label}: disposing worker resources preserves its independently transferred scene pixels`);
        expectedCanvas=new OffscreenCanvas(width,height);const context=expectedCanvas.getContext('2d');
        drawExportScene(context,report,frame,geometry,referenceProvider);
        const diff=difference(read(bitmap),read(expectedCanvas));
        verify(diff.visible>100&&diff.max===0,`${label}: streamed scene pixels exactly match the independent full native painter`,diff);
        verify(disableWebGL?cpuRuns>beforeCPU+captureCPURuns:cpuRuns===beforeCPU&&vfxGPUStats().calls>gpuAfterCapture.calls&&vfxGPUStats().cpuFallbacks===gpuBefore.cpuFallbacks,`${label}: the reference independently executes the same native backend`);
        rows.push({name:label,diff,captureCPURuns,referenceCPURuns:cpuRuns-beforeCPU-captureCPURuns,gpuBefore,gpuAfterCapture,capture:{width,height,sceneWidth:captured.sceneWidth,sceneHeight:captured.sceneHeight,tileCount:captured.tileCount,workingBytes:captured.workingBytes,snapshotBytes}});
        referenceProvider.dispose();referenceProvider=null;releaseGeometryResources(context);expectedCanvas.width=expectedCanvas.height=1;
        bitmap.close();verify(bitmap.width===0,`${label}: disposal closes the adopted native scene bitmap`);
      }finally{
        provider?.dispose();referenceProvider?.dispose();bitmap?.close();
        if(expectedCanvas){releaseGeometryResources(expectedCanvas.getContext('2d'));expectedCanvas.width=expectedCanvas.height=1;}
        releaseVfxCPU();releaseVfxGPU();releaseVfxSoftwareResources();
      }
    }
    return {checks,rows,backend:disableWebGL?'Canvas 2D scene CPU fallback':'Canvas 2D scene GPU capture'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{OffscreenCanvas.prototype.getContext=getContext;VfxCPU.prototype.runPixels=runPixels;releaseVfxCPU();releaseVfxGPU();releaseVfxSoftwareResources();}
}

/** A capped GPU Camera must repaint when settled generic artwork gains detail,
 * even though its camera dimensions remain unchanged throughout the gesture. */
/** Compatibility onion skins with effects must keep their rasters through
 * navigation and settled repaints when together they exceed the onion
 * allowance at the requested density: each eviction re-rasterizes a ghost
 * with its effects, and evictions cascaded on every zoom step. */
export async function zoomCanvasOnionBudget({rendererURL='../src/renderer.mjs',onProgress=()=>{}}={}){
  const [{createRenderer},{createVfx}]=await Promise.all([import(rendererURL),import('../src/vfx.mjs')]);
  const width=384,height=256,onionBytes=8*MiB,checks=[],rows=[],renderers=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const make=async()=>{
    const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true,asyncArtwork:false,gpuDrawing:false,sharedArtwork:false,onionCache:{maxBytes:onionBytes}});
    renderer.resize(width,height,1);renderers.push(renderer);return renderer;
  };
  try{
    const s=scene({opaque:true}),figure=s.report.figure_types[0];
    const glowing=(x,y)=>{const object=createObject(figure,1,x,y),glow=createVfx('glow','ghost-glow');glow.params.radius=4;object._stykVfx={figure:[glow]};return object;};
    s.frame=createFrame([glowing(200,200)]);s.report.keyframes=[s.frame];s.geometry=buildGeometry(s.report,s.frame);
    const onionFrames=[-24,-12,12,24].map(dx=>{const frame=createFrame([glowing(200+dx,200+dx/3)]);return {frame,geometry:buildGeometry(s.report,frame),opacity:.35};});
    const options=(scale,{dx=0,...extra}={})=>{const view=sceneView(scale,s.target,width,height);return {report:s.report,frame:s.frame,geometry:s.geometry,view:{...view,x:view.x+dx},
      cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff,onionFrames,...extra};};
    const renderer=await make(),rasters=()=>renderer.stats.onionRasterizedObjects;
    renderer.render(options(1.5));
    verify(renderer.onionArtwork.size===4&&rasters()===4,'Four onion skins with effects are rasterized once at the fitted view',{entries:renderer.onionArtwork.size,rasters:rasters()});
    for(const scale of [2,4,8,16,32]){renderer.render({...options(scale),viewChanging:true});verify(rasters()===0,`${scale}x: zooming into held onion skins rasterizes none`);}
    renderer.render(options(32));
    verify(rasters()===4&&renderer.onionArtworkBytes<=onionBytes/2,'Settling at high zoom rasterizes each onion skin once, within the onion allowance',
      {rasters:rasters(),bytes:renderer.onionArtworkBytes,allowance:onionBytes/2});
    const fresh=await make();fresh.render(options(32));
    const diff=difference(read(renderer.canvas),read(fresh.canvas));
    verify(diff.visible>100&&diff.max===0,'Onion skins fitted to the allowance match an independently prepared view',diff);
    for(const dx of [3,6,9]){
      renderer.render(options(32,{dx}));
      verify(rasters()===0,`A ${dx}px pan recomposites onion skins from their retained rasters`,{rasters:rasters(),entries:renderer.onionArtwork.size,bytes:renderer.onionArtworkBytes});
    }
    let gesture=0;
    for(const scale of [24,16,10,6,3,1.5]){renderer.render({...options(scale),viewChanging:true});gesture+=rasters();
      verify(renderer.onionArtworkBytes<=onionBytes/2,`${scale}x: zoom-out stand-ins fit the onion allowance together`);}
    verify(gesture<=4,'Zooming out replaces each onion skin at most once',{gesture});
    renderer.render(options(1.5));
    renderer.invalidateImages(['/zoom-onion-resource-not-present.png']);
    renderer.render(options(1.5,{dx:2}));
    verify(rasters()===0&&renderer.onionArtwork.size===4,'An unrelated image decode keeps every onion raster');
    rows.push({name:'Canvas onion allowance',gestureRasters:gesture,diff});
    return {checks,rows,backend:'Canvas onion allowance'};
  }catch(error){error.partialChecks=checks;throw error;}
  finally{for(const renderer of renderers)renderer.destroy();}
}

/** Below its size cap the GPU Camera image follows the view density, so an
 * unheld zoom repaints and re-uploads it on every step. Navigation holds the
 * painted density and the settled paint restores the requested one. */
export async function zoomCameraHeldGPU({onProgress=()=>{},rendererURL='../src/renderer.mjs'}={}){
  const gpuSourceURL=new URL('./vfx-camera-gpu.mjs',new URL(rendererURL,import.meta.url)).href;
  const [{createRenderer},{createVfx},{CameraGpuSource}]=await Promise.all([
    import(rendererURL),import('../src/vfx.mjs'),import(gpuSourceURL)]);
  const width=384,height=256,checks=[],rows=[],errors=[],renderers=[],paints=new Map();
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const originalPaint=CameraGpuSource.prototype.paint;
  CameraGpuSource.prototype.paint=function(...args){paints.set(this,(paints.get(this)??0)+1);return originalPaint.apply(this,args);};
  const make=async()=>{
    const renderer=await createRenderer(document.createElement('canvas'),{gpuDrawing:false,sharedArtwork:false});
    renderer.resize(width,height,1);renderers.push(renderer);
    verify(renderer.device&&renderer.stats.backend==='WebGPU','The held Camera regression executes the real WebGPU renderer');
    renderer.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));return renderer;
  };
  try{
    const s=scene({opaque:true}),figure=s.report.figure_types[0];s.report.canvas_width=800;s.report.canvas_height=400;
    s.report._styk.layers.fixed.scene.visible=true;figure.segment_decode.global_style.u28=0;
    for(const segment of figure.segments)Object.assign(segment,{length:52,thickness:6.3,color_rgb:[40,170,220]});
    s.frame=createFrame([createObject(figure,1,400,200)]);s.report.keyframes=[s.frame];s.frame._stykBackgroundColor=0xff496787;
    const blur=createVfx('blur','held-camera-scene');blur.params.radius=.75;s.frame._stykVfx={figure:[blur]};
    s.geometry=buildGeometry(s.report,s.frame);s.target={x:400,y:200};
    const options=scale=>({report:s.report,frame:s.frame,geometry:s.geometry,view:sceneView(scale,s.target,width,height),cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0});
    const renderer=await make();renderer.render(options(.4));await renderer.device.queue.onSubmittedWorkDone();
    const camera=renderer.vfxViewport.camera,source=renderer.vfxViewport.cameraSource,initialPaints=paints.get(source);
    const contentWidth=()=>camera.filteredWidth-2*(camera.filterPad??0),initialWidth=contentWidth();
    verify(initialPaints===1&&initialWidth===320,'The fitted view paints its Camera image below the density cap',{initialPaints,initialWidth});
    for(let step=1;step<=16;step++){
      renderer.render({...options(.4*Math.pow(1.6/.4,step/16)),viewChanging:true});
      verify(paints.get(source)===initialPaints&&contentWidth()===initialWidth,`Held Camera gesture ${step}: navigation neither repaints nor resizes the Camera image`,{paints:paints.get(source),width:contentWidth()});
    }
    const final=options(1.6);renderer.render(final);await renderer.device.queue.onSubmittedWorkDone();
    verify(paints.get(source)===initialPaints+1&&contentWidth()===1280,'Settlement repaints the Camera image once at the requested density',{paints:paints.get(source),width:contentWidth()});
    const pixels=read(renderer.canvas);
    const reference=await make();reference.render(final);await reference.device.queue.onSubmittedWorkDone();
    const diff=difference(pixels,read(reference.canvas));
    verify(diff.visible>100&&diff.max===0,'Settled held Camera pixels exactly match an independently prepared view',diff);
    renderer.render({...options(.8),viewChanging:true});renderer.render(options(.8));await renderer.device.queue.onSubmittedWorkDone();
    verify(paints.get(source)===initialPaints+2&&contentWidth()===640,'Zooming back out settles at its lower requested density',{paints:paints.get(source),width:contentWidth()});
    const revised=createFrame([createObject(figure,1,430,210)]);revised._stykBackgroundColor=s.frame._stykBackgroundColor;revised._stykVfx=s.frame._stykVfx;
    const moved={...options(1.2),frame:revised,geometry:buildGeometry(s.report,revised),viewChanging:true};
    renderer.render(moved);await renderer.device.queue.onSubmittedWorkDone();
    verify(paints.get(source)===initialPaints+3&&contentWidth()===960,'A scene change during navigation repaints the Camera image at the view density',{paints:paints.get(source),width:contentWidth()});
    verify(errors.length===0,'Held Camera navigation produces no WebGPU validation errors',errors);
    rows.push({name:'held GPU Camera',diff,movingPaints:0,settledPaints:1});
    return {checks,rows,backend:'WebGPU held Camera density'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{CameraGpuSource.prototype.paint=originalPaint;for(const renderer of renderers)renderer.destroy();}
}
export async function zoomCameraCappedGPU({onProgress=()=>{},rendererURL='../src/renderer.mjs'}={}){
  const gpuSourceURL=new URL('./vfx-camera-gpu.mjs',new URL(rendererURL,import.meta.url)).href;
  const [{createRenderer},{createVfx},{CameraGpuSource}]=await Promise.all([
    import(rendererURL),import('../src/vfx.mjs'),import(gpuSourceURL)]);
  const width=384,height=256,budget=64*MiB,checks=[],rows=[],errors=[],renderers=[],paints=new Map();
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const originalPaint=CameraGpuSource.prototype.paint;let previousPixels;
  CameraGpuSource.prototype.paint=function(...args){paints.set(this,(paints.get(this)??0)+1);return originalPaint.apply(this,args);};
  const make=async()=>{
    const renderer=await createRenderer(document.createElement('canvas'),{gpuDrawing:false,sharedArtwork:false,editorRasterCache:{maxBytes:budget}});
    renderer.resize(width,height,1);renderers.push(renderer);
    verify(renderer.device&&renderer.stats.backend==='WebGPU','The capped Camera regression executes the real WebGPU renderer');
    renderer.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));return renderer;
  };
  const dispose=renderer=>{renderer.destroy();renderers.splice(renderers.indexOf(renderer),1);};
  try{
    for(const backgroundColor of [0,0xff496787]){
      const s=scene({opaque:true}),figure=s.report.figure_types[0];s.report.canvas_width=800;s.report.canvas_height=400;
      s.report._styk.layers.fixed.scene.visible=true;
      figure.segment_decode.global_style.u28=0;
      for(const segment of figure.segments)Object.assign(segment,{length:52,thickness:6.3,color_rgb:[40,170,220]});
      const object=createObject(figure,1,400,200),glow=createVfx('glow','capped-camera-path');glow.params.radius=.6;
      object._stykVfx={figure:[glow]};s.frame=createFrame([object]);s.report.keyframes=[s.frame];
      s.frame.camera={x:.37,y:-.61,scale:3,angle_rad:.083,is_default:false};s.frame._stykBackgroundColor=backgroundColor;
      const blur=createVfx('blur','capped-camera-scene');blur.params.radius=.75;s.frame._stykVfx={figure:[blur]};
      s.geometry=buildGeometry(s.report,s.frame);s.target={x:400,y:200};
      const options=scale=>({report:s.report,frame:s.frame,geometry:s.geometry,view:sceneView(scale,s.target,width,height),cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0});
      const renderer=await make(),initial=options(1.04),final=options(6);renderer.render(initial);await renderer.device.queue.onSubmittedWorkDone();
      const viewport=renderer.vfxViewport,source=viewport.cameraSource,camera=viewport.camera,initialPaints=paints.get(source),initialResolution=renderer.lastRasterResolution;
      const textureEntries=renderer.layout.filter(entry=>entry.texture&&!entry.drawing&&!entry.gpuDrawing&&!entry.isOnion);
      const contentSize=()=>[camera.filteredWidth-2*(camera.filterPad??0),camera.filteredHeight-2*(camera.filterPad??0)];
      verify(textureEntries.length>0&&s.geometry.drawables.length===8&&s.geometry.drawables.every(item=>item.type!=='image'),'Eight native effect-bearing paths require generic textures without drawing cels');
      verify(contentSize()[0]===2048&&contentSize()[1]===1024&&initialPaints===1,'The initial fitted view already reaches the native Camera density cap',{contentSize:contentSize(),initialPaints,initialResolution});
      const sourceSize=[source.width,source.height],initialTextures=textureEntries.map(entry=>entry.texture);
      for(let step=1;step<=32;step++){
        const scale=1.04*Math.pow(6/1.04,step/32);renderer.render({...options(scale),viewChanging:true});
        verify(paints.get(source)===initialPaints&&renderer.lastRasterResolution===initialResolution&&source.width===sourceSize[0]&&source.height===sourceSize[1],`Capped Camera gesture ${step}: native source painting and artwork density remain unchanged`);
      }
      renderer.render(final);await renderer.device.queue.onSubmittedWorkDone();
      const finalPaints=paints.get(source),finalResolution=renderer.lastRasterResolution,pixels=read(renderer.canvas);
      verify(finalResolution>initialResolution&&renderer.layout.some(entry=>entry.texture&&!initialTextures.includes(entry.texture)),'Settlement upgrades the retained generic path texture density',{initialResolution,finalResolution});
      verify(finalPaints===initialPaints+1&&source.width===sourceSize[0]&&source.height===sourceSize[1]&&contentSize()[0]===2048&&contentSize()[1]===1024,'A layout density change repaints the capped Camera exactly once without enlarging its native source',{initialPaints,finalPaints,sourceSize});
      for(let repeat=0;repeat<4;repeat++)renderer.render(final);await renderer.device.queue.onSubmittedWorkDone();
      verify(paints.get(source)===finalPaints&&difference(read(renderer.canvas),pixels).max===0,'Warm settled capped Camera paints reuse their exact completed source');
      const reference=await make();reference.render(final);await reference.device.queue.onSubmittedWorkDone();const diff=difference(pixels,read(reference.canvas));
      verify(diff.visible>100&&diff.max===0,'Settled capped Camera pixels exactly match an independently prepared native cold view',diff);
      const backgroundDifference=previousPixels&&difference(pixels,previousPixels);
      if(backgroundDifference)verify(backgroundDifference.max>0,'Transparent and colored backgrounds produce distinct native Camera pixels',backgroundDifference);
      previousPixels=pixels;
      verify(renderer.rasterCache.bytes<=budget&&renderer.rasterCache.leases.size===0,'Generic path texture ownership remains bounded after capped Camera settlement');
      rows.push({name:`capped GPU Camera ${backgroundColor.toString(16)}`,diff,backgroundDifference,movingPaints:0,settledPaints:finalPaints-initialPaints,sourceSize,contentSize:contentSize(),initialResolution,finalResolution});
      dispose(reference);dispose(renderer);
    }
    verify(errors.length===0,'Capped Camera preparation and projection produce no WebGPU validation errors',errors);
    return {checks,rows,backend:'WebGPU capped Camera density'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{CameraGpuSource.prototype.paint=originalPaint;for(const renderer of renderers)renderer.destroy();}
}

/** Scene effects share the same serial owner as ordinary covered artwork. */
export async function zoomCameraArtworkRefinement({rendererURL='../src/renderer.mjs',cameraReferenceURL,onProgress=()=>{}}={}){
  const [{createRenderer},{DrawingWorker},{createVfx},{vfxGPUStats}]=await Promise.all([
    import(rendererURL),import('../src/drawing-worker-client.mjs'),import('../src/vfx.mjs'),import('../src/vfx-gpu.mjs')]);
  const width=320,height=240,budget=64*MiB,checks=[],rows=[],renderers=[],held=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const originalRequest=DrawingWorker.prototype.request;let hold=false;
  DrawingWorker.prototype.request=function(...args){return originalRequest.apply(this,args).then(result=>{
    if(!hold||args[0]!=='preview-raster'||!args[1]?.scene||!result?.bitmap)return result;
    return new Promise(resolve=>held.push({result,request:args[1],release:()=>resolve(result)}));
  });};
  const release=()=>{hold=false;for(const completion of held.splice(0))completion.release();};
  const make=async(extra,url)=>{const factory=url?(await import(url)).createRenderer:createRenderer,renderer=await factory(document.createElement('canvas'),{forceCanvas2D:true,gpuDrawing:false,sharedArtwork:false,...extra});renderer.resize(width,height,1);renderer.artworkBudget=budget;renderers.push(renderer);return renderer;};
  const dispose=renderer=>{renderer.destroy();renderers.splice(renderers.indexOf(renderer),1);};
  const cameraScene=()=>{
    const value=scene(),figure=value.report.figure_types[0];figure.segment_decode.global_style.u30=0;
    value.report.canvas_width=320;value.report.canvas_height=240;
    const parent=createObject(figure,1,150,120),child=createObject(figure,2,0,0,{scale:.35,join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}});
    const glow=createVfx('glow','camera-object-glow');glow.params.radius=.6;parent._stykVfx={figure:[glow]};
    value.frame=createFrame([parent,child]);value.report.keyframes=[value.frame];
    value.frame.camera={x:1.25,y:-.61,scale:1.13,angle_rad:.083,is_default:false};
    const blur=createVfx('blur','camera-native-zoom');blur.params.radius=.75;value.frame._stykVfx={figure:[blur]};
    value.geometry=buildGeometry(value.report,value.frame);value.target={x:150,y:120};return value;
  };
  const optionsFor=(s,scale,extra={})=>({report:s.report,frame:s.frame,geometry:s.geometry,view:sceneView(scale,s.target,width,height),cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0,...extra});
  const entry=renderer=>renderer.artwork.get(renderer.vfxCamera);
  const bounded=(renderer,label)=>{const stats=renderer.stats.artworkRefinement;verify(renderer.artworkBytes+stats.bytes<=renderer.artworkBudget&&stats.pending<=renderer.artwork.size+renderer.onionArtwork.size,`${label}: camera pixels and serial working reservation share the bounded artwork owner`,{artworkBytes:renderer.artworkBytes,budget:renderer.artworkBudget,stats});};
  const nextHeld=async renderer=>{const deadline=performance.now()+45000;while(!held.length&&performance.now()<deadline&&!(renderer.stats.artworkRefinement.failed&&!renderer.artworkRefining))await new Promise(resolve=>setTimeout(resolve,25));check(held.length,'A real scene-effect worker returns its bitmap before the test deadline',{stats:renderer.stats.artworkRefinement,lastError:renderer.stats.lastRefinementError});return held[0];};
  const compare=async(renderer,options,label,{history=[],dpr=1,diagnostic=false,visibleRequired=false,url}={})=>{
    const reference=await make({asyncArtwork:false},url);let expected;
    try{reference.resize(width,height,dpr);for(const prior of history)reference.render(prior);reference.render(options);expected=read(reference.canvas);}
    finally{dispose(reference);if(url)(await import(new URL('./vfx-canvas.mjs',new URL(url,import.meta.url)).href)).releaseVerificationVfxState?.();}
    const diff=difference(read(renderer.canvas),expected);rows.push({name:label,diff,diagnostic});if(!diagnostic)verify(diff.max===0&&(!visibleRequired||diff.visible>100),`${label}: scene-effect pixels exactly match independent native history`,diff);return expected;
  };
  const start=async({backgroundColor=0}={})=>{
    const s=cameraScene();s.frame._stykBackgroundColor=backgroundColor;
    const renderer=await make(),initial=optionsFor(s,.5),settled=optionsFor(s,1.83);renderer.render(initial);
    const cached=entry(renderer);verify(cached?.cameraSource&&cached.canvas?.width>1,'A native scene effect starts with an owned full-camera source');
    const before=rasterCount(renderer),gpuBefore=vfxGPUStats();
    const gestures=[.65,.9,1.2,1.6,1.83].map(scale=>optionsFor(s,scale,{viewChanging:true}));
    for(const gesture of gestures)renderer.render(gesture);
    verify(entry(renderer)===cached&&rasterCount(renderer)===before&&vfxGPUStats().calls===gpuBefore.calls&&vfxGPUStats().cpuFallbacks===gpuBefore.cpuFallbacks,'Covered camera gestures reuse the completed scene with zero UI scene-effect execution');
    hold=true;const started=performance.now();renderer.render(settled);const renderMs=performance.now()-started;
    verify(renderer.artworkRefining&&entry(renderer)===cached&&rasterCount(renderer)===before&&vfxGPUStats().calls===gpuBefore.calls&&vfxGPUStats().cpuFallbacks===gpuBefore.cpuFallbacks,'Camera settlement retains its source and performs zero native scene-effect work on the UI thread');
    const pending=await nextHeld(renderer);
    verify(pending.request.scene.report&&pending.request.scene.frame&&pending.result.bitmap.width===pending.request.width&&pending.result.bitmap.height===pending.request.height,'Scene refinement transfers native scene metadata and returns the admitted camera domain');
    bounded(renderer,'held camera refinement');rows.push({name:'camera settled render',renderMs,request:{width:pending.request.width,height:pending.request.height},capture:{tileCount:pending.result.tileCount,workingBytes:pending.result.workingBytes}});
    return {s,renderer,initial,gestures,settled,cached,pending,before,gpuBefore};
  };
  try{
    let job;
    for(const backgroundColor of [0,0xff496787]){
    job=await start({backgroundColor});for(let i=0;i<4;i++)job.renderer.render(job.settled);
    verify(held.length===1&&job.renderer.stats.artworkRefinement.completed===0,'Repeated settled camera paints deduplicate the held scene job');
    release();await job.renderer.whenArtworkReady();job.renderer.render(job.settled);
    verify(entry(job.renderer)?.bitmap===job.pending.result.bitmap&&job.renderer.stats.artworkRefinement.completed>0&&job.renderer.stats.artworkRefinement.failed===0,'A healthy scene worker adopts its exact camera bitmap without fallback');
    await compare(job.renderer,job.settled,`camera density refinement (${backgroundColor.toString(16)})`,{history:[job.initial,...job.gestures],visibleRequired:true});
    const completed=job.renderer.stats.artworkRefinement.completed,bitmap=entry(job.renderer).bitmap,gpu=vfxGPUStats();
    for(let i=0;i<4;i++)job.renderer.render(job.settled);
    verify(entry(job.renderer).bitmap===bitmap&&!job.renderer.artworkRefining&&job.renderer.stats.artworkRefinement.completed===completed&&vfxGPUStats().calls===gpu.calls&&vfxGPUStats().cpuFallbacks===gpu.cpuFallbacks,'Warm exact camera paints retain their bitmap without new jobs or native UI effects');
    bounded(job.renderer,'adopted camera refinement');dispose(job.renderer);verify(bitmap.width===0,'Camera disposal closes its adopted bitmap');
    }

    job=await start();
    const preparedObsolete=job.pending.result.bitmap,packetCanvas=new OffscreenCanvas(8,8),packetContext=packetCanvas.getContext('2d');
    packetContext.fillStyle='rgb(60,90,140)';packetContext.fillRect(0,0,8,8);const packetBitmap=packetCanvas.transferToImageBitmap();
    try{
      const key='camera-prepared-cancel',packet={key,softwareFrames:true,compatibility:[{bitmap:packetBitmap}],uids:Uint32Array.of(1,2),hiddenKey:'',cameraEnabled:false};
      verify(job.renderer.prepareFrame(packet,{report:job.s.report})===key,'A real prepared packet is admitted while scene refinement is held');
      const options={report:job.s.report,cameraEnabled:false,view:{x:0,y:0,scale:1},onionFrames:[]},monitor=new OffscreenCanvas(width,height);
      verify(job.renderer.renderPreparedInto(key,{...options,target:{context:monitor.getContext('2d')}})&&job.renderer.artworkRefining,'Borrowing prepared playback for a monitor preserves pending camera refinement');monitor.width=monitor.height=1;
      verify(job.renderer.renderPrepared(key,options)&&!job.renderer.artworkRefining,'Presenting prepared playback cancels pending scene-effect refinement');
      const pixels=read(job.renderer.canvas);release();await job.renderer.whenArtworkReady();
      verify(preparedObsolete.width===0&&difference(read(job.renderer.canvas),pixels).max===0,'An obsolete camera bitmap cannot overwrite prepared playback pixels');
      bounded(job.renderer,'prepared camera cancellation');dispose(job.renderer);
    }finally{packetBitmap.close();packetCanvas.width=packetCanvas.height=1;}

    for(const change of ['view','geometry','child','background','layer','hidden','drag','revision','effects','editing','playback','resize','context','clearArtwork','dispose']){
      job=await start();const obsolete=job.pending.result.bitmap,cancelled=job.renderer.stats.artworkRefinement.cancelled,priorFrame={...job.s.frame};let options={...job.settled},dpr=1,history=[];
      if(change==='view')options={...options,view:{...options.view,x:options.view.x+7.5},viewChanging:true};
      if(change==='geometry'||change==='child'){job.s.frame.objects[change==='child'?1:0].angles[0]+=.17;job.s.geometry=buildGeometry(job.s.report,job.s.frame);options.geometry=job.s.geometry;}
      if(change==='background')job.s.frame._stykBackgroundColor=0xff345678;
      if(change==='layer')job.s.report._styk.layers.byId['layer-1'].visible=false;
      if(change==='hidden')options.hiddenUids=new Set([2]);
      if(change==='drag')options.dragTranslations=new Map([[2,{x:3.25,y:-2.5}]]);
      if(change==='revision')options.resourceRevision=1;
      if(change==='effects')job.s.frame._stykVfx={figure:[]};
      if(change==='editing')options.liveEditing=true;
      if(change==='playback')options.playing=true;
      if(change==='resize'){dpr=1.5;job.renderer.resize(width,height,dpr);}
      if(change==='context')job.renderer.canvas.dispatchEvent(new Event('contextlost'));
      if(change==='clearArtwork')job.renderer.clearArtwork();
      if(change==='dispose')dispose(job.renderer);else job.renderer.render(options);
      if(change==='effects'){
        verify(!job.renderer.refinement.jobs.has(job.cached),'Removing scene effects immediately cancels their pending camera owner');
        verify(!entry(job.renderer)&&job.cached.destroyed&&job.cached.canvas.width===1&&job.cached.canvas.height===1,'Removing scene effects releases their counted native camera source');
        const diagnostics=()=>({stats:{...job.renderer.stats.artworkRefinement},artwork:[...job.renderer.artwork].map(([key,item])=>({camera:key===job.renderer.vfxCamera,bitmap:Boolean(item.bitmap),width:(item.bitmap??item.canvas)?.width,height:(item.bitmap??item.canvas)?.height,resolution:item.resolution,deferDensity:item.deferDensity,destroyed:item.destroyed}))});
        const immediate=read(job.renderer.canvas),before=diagnostics();
        release();await job.renderer.whenArtworkReady();job.renderer.render(options);
        rows.push({name:'scene removal immediate and settled ownership',before,after:diagnostics(),settlingDifference:difference(immediate,read(job.renderer.canvas))});
        verify(!job.renderer.artwork.has(job.renderer.vfxCamera)&&job.cached.destroyed,'Removing scene effects releases their obsolete Camera source from artwork ownership');
        history=[job.initial,...job.gestures,job.settled].map(prior=>({...prior,frame:priorFrame}));
        await compare(job.renderer,options,'scene removal cold native comparison',{diagnostic:true});
        if(cameraReferenceURL)await compare(job.renderer,options,'scene removal frozen native history',{history,url:cameraReferenceURL});
      }
      if(!['view','resize','context','dispose'].includes(change))await compare(job.renderer,options,`${change} during camera refinement`,{dpr,history});
      release();await job.renderer.whenArtworkReady();
      if(change==='resize')job.renderer.render(options);
      verify(obsolete.width===0&&job.renderer.stats.artworkRefinement.cancelled>cancelled,`${change}: a late scene bitmap is closed and cannot supersede current camera state`);
      if(change==='context'){job.renderer.canvas.dispatchEvent(new Event('contextrestored'));job.renderer.render(options);await compare(job.renderer,options,'camera context recovery');}
      else if(change==='view'){job.renderer.render({...options,viewChanging:false});await job.renderer.whenArtworkReady();job.renderer.render({...options,viewChanging:false});await compare(job.renderer,{...options,viewChanging:false},'camera view after obsolete scene completion',{history:[job.initial]});}
      else if(change!=='dispose')await compare(job.renderer,options,`${change} after obsolete camera completion`,{dpr,history});
      if(change==='dispose')verify(job.renderer.artworkBytes===0&&job.renderer.artwork.size===0,'Disposal releases every native camera and ordinary artwork owner');
      else {bounded(job.renderer,`${change} camera cancellation`);dispose(job.renderer);}
    }
    return {checks,rows,backend:'Canvas 2D scene refinement'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{release();DrawingWorker.prototype.request=originalRequest;for(const renderer of renderers)renderer.destroy();}
}

/** Published cels inside scene effects use the same native queue and drawing
 * authority as standalone drawing captures. A cold source stays live until
 * the worker publishes its complete pixels. */
export async function zoomCameraDrawingArtworkRefinement({rendererURL='../src/renderer.mjs',onProgress=()=>{}}={}){
  const [{createRenderer},{createDrawingFigure},{DrawingResources},{DrawingWorker},{createVfx},{vfxGPUStats}]=await Promise.all([
    import(rendererURL),import('../src/drawing-model.mjs'),import('../src/drawing-resources.mjs'),import('../src/drawing-worker-client.mjs'),import('../src/vfx.mjs'),import('../src/vfx-gpu.mjs')]);
  const width=320,height=240,budget=64*MiB,checks=[],rows=[],renderers=[],owners=[],held=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const originalRequest=DrawingWorker.prototype.request;let hold=false;
  DrawingWorker.prototype.request=function(...args){return originalRequest.apply(this,args).then(result=>{
    if(!hold||args[0]!=='preview-raster'||!args[1]?.scene||!result?.bitmap)return result;
    return new Promise(resolve=>held.push({result,request:args[1],release:()=>resolve(result)}));
  });};
  const release=()=>{hold=false;for(const completion of held.splice(0))completion.release();};
  const dispose=renderer=>{renderer.destroy();renderers.splice(renderers.indexOf(renderer),1);};
  const make=async(scene,extra={})=>{const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true,gpuDrawing:false,sharedArtwork:false,resources:scene.resources,...extra});renderer.resize(width,height,1);renderer.artworkBudget=budget;renderers.push(renderer);return renderer;};
  const fixture=async(tileCount=1)=>{
    const cel=createDrawingFigure({figureTypeId:3}),s=scene();s.report.figure_types.push(cel);s.report.canvas_width=640;s.report.canvas_height=480;
    s.frame=createFrame([createObject(s.report.figure_types[0],1,180,180),createObject(cel,2,0,0)]);s.report.keyframes=[s.frame];
    s.report._styk.layers.fixed.scene.visible=true;s.frame._stykBackgroundColor=0;
    const blur=createVfx('blur','published-camera-cel');Object.assign(blur.params,{radius:.75,mode:1,angle:23});s.frame._stykVfx={figure:[blur]};
    const owner=new DrawingResources(s.report,{history:false});owner.busy=true;owners.push(owner);const surface=await owner.surface(cel),pixels=new Uint8ClampedArray(64*64*4);
    for(let i=0;i<pixels.length;i+=4)pixels.set([30,60,220,255],i);
    owner.apply(cel,Array.from({length:tileCount},(_,i)=>({tx:i%9,ty:Math.floor(i/9),after:pixels.slice()})),'after');await owner.flush();
    s.geometry=buildGeometry(s.report,s.frame);s.target=tileCount===1?{x:32,y:32}:{x:320,y:240};s.cel=cel;s.owner=owner;s.surface=surface;
    s.resources={drawing:figure=>figure===cel?owner.rasterPresenter(surface):undefined};return s;
  };
  const options=(s,scale,extra={})=>({report:s.report,frame:s.frame,geometry:s.geometry,view:sceneView(scale,s.target,width,height),cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0,...extra});
  const entry=renderer=>renderer.artwork.get(renderer.vfxCamera);
  const bounded=(renderer,label)=>verify(renderer.artworkBytes+renderer.stats.artworkRefinement.bytes<=budget,`${label}: scene, cel and running capture share the existing bounded owner`,{artworkBytes:renderer.artworkBytes,stats:{...renderer.stats.artworkRefinement}});
  const nextHeld=async renderer=>{const deadline=performance.now()+45000;while(!held.length&&performance.now()<deadline&&!(renderer.stats.artworkRefinement.failed&&!renderer.artworkRefining))await new Promise(resolve=>setTimeout(resolve,25));check(held.length,'A published-cel scene worker returns its native bitmap',{stats:{...renderer.stats.artworkRefinement}});return held[0];};
  const previewReady=async(s,{level=0,request=true}={})=>{
    const stamp=s.surface.stamp,pixelStamp=s.surface.pixelStamp;
    if(request)s.owner.previews.scratch(s.surface,{x:0,y:0,width:64*9,height:64*8},{level});
    const deadline=performance.now()+30000;
    while((s.surface.stamp===stamp||s.owner.previews.active||s.owner.previews.queue.size)&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    verify(s.surface.stamp>stamp&&s.surface.pixelStamp===pixelStamp&&!s.owner.previews.active&&!s.owner.previews.queue.size,'A real derived cel preview changes its presentation stamp without changing native pixels',{stamp,currentStamp:s.surface.stamp,pixelStamp});
  };
  const exact=async(renderer,s,final,label,history=[])=>{
    const reference=await make(s,{asyncArtwork:false});let expected;
    try{for(const prior of history)reference.render(prior);reference.render(final);expected=read(reference.canvas);}finally{dispose(reference);}
    const diff=difference(read(renderer.canvas),expected);verify(diff.visible>100&&diff.max===0,`${label}: published-cel scene pixels exactly match independent native history`,diff);rows.push({name:label,diff});
  };
  const start=async s=>{
    const renderer=await make(s),initial=options(s,.5),final=options(s,1.83);renderer.render(initial);
    const cached=entry(renderer),before=rasterCount(renderer),gpu=vfxGPUStats();renderer.render({...final,viewChanging:true});hold=true;renderer.render(final);
    verify(renderer.artworkRefining&&entry(renderer)===cached&&rasterCount(renderer)===before&&vfxGPUStats().calls===gpu.calls&&vfxGPUStats().cpuFallbacks===gpu.cpuFallbacks,'Covered published cels retain their scene source through worker settlement without UI native captures');
    const pending=await nextHeld(renderer);bounded(renderer,'held published-cel scene');return {renderer,initial,final,cached,pending,before};
  };
  try{
    const small=await fixture();let job=await start(small);
    const cancelled=job.renderer.stats.artworkRefinement.cancelled;
    await previewReady(small);job.renderer.render(job.final);
    verify(entry(job.renderer)===job.cached&&job.renderer.artworkRefining&&job.renderer.stats.artworkRefinement.cancelled===cancelled&&rasterCount(job.renderer)===job.before,'Derived preview completion preserves the pending native scene and its held source');
    release();await job.renderer.whenArtworkReady();job.renderer.render(job.final);
    const adopted=entry(job.renderer),bitmap=job.pending.result.bitmap,pixels=read(job.renderer.canvas);
    verify(adopted?.bitmap===bitmap&&job.renderer.stats.artworkRefinement.failed===0,'The published scene worker adopts its complete cel pixels without fallback');
    await previewReady(small,{level:1});job.renderer.render(job.final);
    verify(entry(job.renderer)===adopted&&difference(read(job.renderer.canvas),pixels).max===0&&!job.renderer.artworkRefining,'Derived previews preserve an adopted native cel scene without recapture');
    await exact(job.renderer,small,job.final,'pending and adopted cel preview',[job.initial,{...job.final,viewChanging:true}]);bounded(job.renderer,'adopted published-cel scene');dispose(job.renderer);verify(bitmap.width===0,'Scene disposal closes its published-cel bitmap');

    for(const field of ['pixelStamp','revision','publishedRevision','publishedUrl','store','owner','pin','loading','deferred','transient','dispose']){
      job=await start(small);const obsolete=job.pending.result.bitmap,oldStore=small.surface.store;let restore;
      if(field==='publishedRevision'){const value=small.surface.published.revision;small.surface.published.revision++;restore=()=>{small.surface.published.revision=value;};}
      else if(field==='publishedUrl'){const value=small.surface.published.url;small.surface.published.url=null;restore=()=>{small.surface.published.url=value;};}
      else if(field==='store'){small.surface.store=oldStore.fork();restore=()=>{small.surface.store=oldStore;};}
      else if(field==='owner'){const value=small.surface.owner;small.surface.owner=Object.create(value);restore=()=>{small.surface.owner=value;};}
      else if(field==='dispose'){const value=small.surface.disposed;small.surface.disposed=true;small.surface.store=null;restore=()=>{small.surface.disposed=value;small.surface.store=oldStore;};}
      else if(['pin','loading','deferred','transient'].includes(field)){const key=field==='pin'?'pinned':field,value=small.surface[key];small.surface[key]=field==='loading'?Promise.resolve():field==='deferred'?[{}]:true;restore=()=>{small.surface[key]=value;};}
      else {const value=small.surface[field];small.surface[field]=(value??0)+1;restore=()=>{small.surface[field]=value;};}
      try{
        job.renderer.render(job.final);verify(!job.renderer.refinement.jobs.has(job.cached),`${field}: changing native cel authority cancels the pending scene capture`);
        release();await job.renderer.whenArtworkReady();job.renderer.render(job.final);
        verify(obsolete.width===0&&job.renderer.stats.artworkRefinement.cancelled>0,`${field}: obsolete cel-scene pixels are closed before they can publish`);
        await exact(job.renderer,small,job.final,`${field} cel scene recovery`);bounded(job.renderer,`${field} scene cancellation`);
      }finally{restore();dispose(job.renderer);}
    }

    job=await start(small);const oldPixels=job.pending.result.bitmap,red=new Uint8ClampedArray(64*64*4);
    for(let i=0;i<red.length;i+=4)red.set([240,40,10,255],i);
    small.owner.apply(small.cel,[{tx:0,ty:0,after:red}],'after');const edited={...job.final,liveEditing:true};job.renderer.render(edited);
    const editedPixels=read(job.renderer.canvas);let redPixels=0;
    for(let i=0;i<editedPixels.length;i+=4)if(editedPixels[i]>230&&editedPixels[i+1]<80&&editedPixels[i+2]<30&&editedPixels[i+3]>200)redPixels++;
    verify(redPixels>100&&!job.renderer.refinement.jobs.has(job.cached),'An unpublished live cel edit cancels its native scene job and paints changed pixels immediately');
    release();await job.renderer.whenArtworkReady();
    verify(oldPixels.width===0&&difference(read(job.renderer.canvas),editedPixels).max===0,'Late published scene pixels cannot overwrite an unpublished live cel edit');
    await exact(job.renderer,small,edited,'unpublished live cel scene');dispose(job.renderer);

    const large=await fixture(65),renderer=await make(large),same=options(large,.5);renderer.render(same);
    const blueCount=pixels=>{let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+2]>200&&pixels[i]<100&&pixels[i+1]<120&&pixels[i+3]>200)count++;return count;};
    const cold=entry(renderer),stamp=large.surface.stamp,before=rasterCount(renderer),gpu=vfxGPUStats(),coldBlue=blueCount(read(renderer.canvas));
    verify(cold?.cameraSource.drawingInputs?.length>0&&cold.cameraSource.drawingInputs.every(input=>!input.published),'A potentially incomplete cold cel scene keeps live presentation authority');
    renderer.render({...same,viewChanging:true});
    await previewReady(large,{level:1});renderer.render({...same,viewChanging:true});
    verify(large.surface.store.size===65&&large.surface.stamp>stamp&&entry(renderer)===cold&&rasterCount(renderer)===before&&vfxGPUStats().calls===gpu.calls&&vfxGPUStats().cpuFallbacks===gpu.cpuFallbacks,'A 65-tile cold scene temporarily holds its source while navigation receives a derived preview');
    hold=true;renderer.render(same);verify(renderer.artworkRefining&&entry(renderer)===cold,'Same-density settlement replaces a live-stamp-stale cold scene through the worker');
    const largePending=await nextHeld(renderer);release();await renderer.whenArtworkReady();renderer.render(same);
    const adoptedLarge=entry(renderer),adoptedBlue=blueCount(read(renderer.canvas));
    const adoptedInputs=adoptedLarge?.cameraSource.drawingInputs;
    verify(adoptedLarge?.bitmap===largePending.result.bitmap&&renderer.stats.artworkRefinement.failed===0&&adoptedInputs?.length===cold.cameraSource.drawingInputs.length&&adoptedInputs.length>0&&adoptedInputs.every(input=>input.published),'The 65-tile scene becomes native-published only after complete worker adoption');
    verify(adoptedBlue>100,'Same-density worker replacement publishes visible complete cel pixels',{coldBlue,adoptedBlue});
    await exact(renderer,large,same,'65-tile same-density refinement',[same,{...same,viewChanging:true}]);
    Object.assign(rows.at(-1),{tiles:large.surface.store.size,coldBlue,adoptedBlue,coldStamp:stamp,readyStamp:large.surface.stamp,
      coldPublished:cold.cameraSource.drawingInputs.some(input=>input.published),adoptedPublished:adoptedInputs.length>0&&adoptedInputs.every(input=>input.published),publishedInputs:adoptedInputs.length});
    bounded(renderer,'65-tile camera refinement');dispose(renderer);verify(largePending.result.bitmap.width===0,'The large cel scene releases its adopted bitmap');
    return {checks,rows,backend:'Canvas 2D published-cel scene refinement'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{release();DrawingWorker.prototype.request=originalRequest;for(const renderer of renderers)renderer.destroy();for(const owner of owners)owner.dispose();}
}

/** The Camera worker decodes the same published native tiles as a live owner,
 * retaining the complete scene domain and accelerated drawing composition. */
export async function zoomSceneDrawingCaptureNative({onProgress=()=>{},disableWebGL=false}={}){
  const [{createDrawingFigure},{DrawingResources},{createVfx},{capturePreviewRaster},{cameraSceneDrawables,cameraRefinementScene},
    {sendDrawingComposite},{applyDocumentChunk},{drawingPreviewPlan,preparePreviewDrawings},{drawExportScene},
    {VfxCPU,releaseVfxCPU},{VfxGPU,releaseVfxGPU,vfxGPUStats},{releaseVfxSoftwareResources,vfxSoftwareResourceStats},{DrawingTileProvider}]=await Promise.all([
    import('../src/drawing-model.mjs'),import('../src/drawing-resources.mjs'),import('../src/vfx.mjs'),import('../src/renderer-raster-capture.mjs'),import('../src/renderer-camera-scene.mjs'),
    import('../src/drawing-composite-transport.mjs'),import('../src/document-transport.mjs'),import('../src/renderer-preview-drawing-resources.mjs'),import('../src/export-frame-core.mjs'),
    import('../src/vfx-cpu.mjs'),import('../src/vfx-gpu.mjs'),import('../src/vfx-canvas.mjs'),import('../src/drawing-provider.mjs')]);
  const width=193,height=145,maxBytes=64*MiB,checks=[],rows=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const report=samplingFixture({kind:'outline',opacity:.67}),cel=createDrawingFigure({figureTypeId:3}),figure=report.figure_types[0];
  report.figure_types.push(cel);report.canvas_width=160;report.canvas_height=120;report._styk.layers.fixed.scene.visible=true;
  const frame=createFrame([createObject(figure,1,44.37,38.61),createObject(cel,2,60.37,40.61),createObject(figure,3,90.61,75.37,{scale:.7})]);
  frame.camera={x:.37,y:-.61,scale:1.09,angle_rad:.13,is_default:false};report.keyframes=[frame];
  const blur=createVfx('blur','native-cel-camera-blur');Object.assign(blur.params,{radius:.75,mode:1,angle:23});frame._stykVfx={figure:[blur]};
  const tint=createVfx('tint','native-cel-camera-tint');tint.params.mix=.13;frame.objects[1]._stykVfx={figure:[tint]};
  const owner=new DrawingResources(report,{history:false});owner.busy=true;
  const getContext=OffscreenCanvas.prototype.getContext,runPixels=VfxCPU.prototype.runPixels,gpuRun=VfxGPU.prototype.run,drop=DrawingTileProvider.prototype.drop;
  let cpuRuns=0,capturePhase;
  const observeSceneFilter=stack=>{
    if(!capturePhase||!stack.some(effect=>effect.id===blur.id))return;
    const {provider,decoded,scratches}=capturePhase,pool=provider.rasterSurfaces;
    capturePhase.filters.push({decodedReleased:provider.drawingProvider.entries.size===0&&provider.drawingProvider.bytes===0,
      scratchCount:scratches.length,scratchesReleased:scratches.every(canvas=>canvas.width===1&&canvas.height===1),
      derivedReleased:decoded.every(entry=>entry._scratches===null&&entry.levels===null),tintsReleased:provider.tintCanvases.size===0,
      rootAlive:pool.busy&&pool.surface.width===width&&pool.surface.height===height});
  };
  try{
    const surface=await owner.surface(cel),pixels=new Uint8ClampedArray(64*64*4);for(let i=0;i<pixels.length;i+=4)pixels.set([30,60,220,255],i);
    owner.apply(cel,[{tx:0,ty:0,after:pixels}],'after');await owner.flush();
    const geometry=buildGeometry(report,frame),resources={drawing:fig=>fig===cel?owner.rasterPresenter(surface):undefined};
    releaseVfxGPU();if(disableWebGL)OffscreenCanvas.prototype.getContext=function(type,...args){return type==='webgl2'?null:getContext.call(this,type,...args);};
    VfxCPU.prototype.runPixels=function(...args){cpuRuns++;observeSceneFilter(args[3]);return runPixels.apply(this,args);};
    VfxGPU.prototype.run=function(...args){observeSceneFilter(args[1]);return gpuRun.apply(this,args);};
    DrawingTileProvider.prototype.drop=function(entry){if(capturePhase?.provider.drawingProvider===this)for(const scratch of entry._scratches?.values()??[])if(scratch.canvas)capturePhase.scratches.push(scratch.canvas);return drop.call(this,entry);};
    for(const background of ['transparent','colored','linear mix']){
      if(background==='linear mix'){
        delete frame._stykBackgroundColor;report.backgrounds=[{background_id:1,kind:3,color_a:0xff234567,color_b:0xffbbaacc,x1:.13,y1:.07,x2:.91,y2:.82},{background_id:2,kind:2,color:0xff6a397b}];
        frame.background_id=1;frame.background_id_b=2;frame.background_mix=93;
      }else{frame._stykBackgroundColor=background==='transparent'?0:0xff496787;report.backgrounds=[];frame.background_mix=0;}
      const label=`${disableWebGL?'CPU':'GPU'} published cel scene ${background}`,options={report,frame,geometry,generatorBatch:null},items=cameraSceneDrawables(options),scene=cameraRefinementScene(options,items,resources),drawingPlan=drawingPreviewPlan(items);
      verify(scene&&drawingPlan.figures.length===1&&drawingPlan.bytes>0,`${label}: scene admission identifies one published native cel before decoding`);
      let snapshot,snapshotBytes=0;await sendDrawingComposite({async request(kind,{chunk}){check(kind==='composite-chunk','Only evaluated scene artwork is transferred');snapshot=applyDocumentChunk(snapshot,chunk);snapshotBytes+=chunk.estimatedBytes??64;return {}; }},items,{maxBytes});
      let provider,bitmap,expectedCanvas;const beforeCPU=cpuRuns,gpuBefore=vfxGPUStats();
      try{
        provider=await preparePreviewDrawings(drawingPlan);const decodedStore=provider.drawing(cel).store,decodedTiles=[...decodedStore],liveTiles=[...surface.store];
        verify(decodedStore.bytes===surface.store.bytes&&decodedTiles.length===liveTiles.length&&decodedTiles.every((tile,index)=>tile.tx===liveTiles[index].tx&&tile.ty===liveTiles[index].ty&&tile.pixels.every((value,i)=>value===liveTiles[index].pixels[i])),`${label}: worker preparation preserves the authoritative native tile pixels`);
        capturePhase={provider,decoded:[...provider.drawingProvider.entries.values()],scratches:[],filters:[]};
        const captured=capturePreviewRaster(snapshot,{width,height,maxBytes,snapshotBytes,resourceBytes:drawingPlan.bytes,scene,resources:provider});bitmap=captured.bitmap;
        const phase=capturePhase;capturePhase=null;
        verify(phase.filters.length===1&&phase.filters.every(state=>state.decodedReleased&&state.scratchCount>0&&state.scratchesReleased&&state.derivedReleased&&state.tintsReleased&&state.rootAlive),`${label}: decoded tiles and derived scratch end before the final scene filter while its native root remains alive`,phase.filters);
        const captureCPURuns=cpuRuns-beforeCPU,gpuAfterCapture=vfxGPUStats(),pool=provider.rasterSurfaces;
        verify(disableWebGL?captureCPURuns>0:captureCPURuns===0&&gpuAfterCapture.calls>gpuBefore.calls&&gpuAfterCapture.cpuFallbacks===gpuBefore.cpuFallbacks,`${label}: capture executes the genuine native ${disableWebGL?'CPU':'GPU'} effects`,{captureCPURuns,gpuBefore,gpuAfterCapture});
        verify(captured.tileCount===1&&captured.nativePadding===true&&captured.bytes===width*height*4&&captured.workingBytes<=maxBytes,`${label}: cel and full native scene pixels stay within their admitted memory`,captured);
        verify(pool.context.getContextAttributes().willReadFrequently===false&&!pool.busy&&pool.surface.width===1&&pool.surface.height===1&&vfxSoftwareResourceStats().bytes===0,`${label}: the accelerated native pool releases its scratch before publication`);
        provider.dispose();provider=null;verify(pool.surface===null&&bitmap.width===width&&bitmap.height===height,`${label}: decoded cel disposal preserves the transferred scene bitmap`);
        expectedCanvas=new OffscreenCanvas(width,height);const context=expectedCanvas.getContext('2d');drawExportScene(context,report,frame,geometry,resources);
        const actual=read(bitmap),diff=difference(actual,read(expectedCanvas));let blue=0;
        for(let i=0;i<actual.length;i+=4)if(actual[i+2]>200&&actual[i]<100&&actual[i+1]<120&&actual[i+3]>200)blue++;
        verify(blue>100&&diff.max===0,`${label}: native cel overlap pixels exactly match the independent full scene painter`,{diff,blue});
        verify(disableWebGL?cpuRuns>beforeCPU+captureCPURuns:cpuRuns===beforeCPU&&vfxGPUStats().calls>gpuAfterCapture.calls&&vfxGPUStats().cpuFallbacks===gpuBefore.cpuFallbacks,`${label}: the independent reference executes the same native effect backend`);
        rows.push({name:label,diff,blue,captureCPURuns,referenceCPURuns:cpuRuns-beforeCPU-captureCPURuns,phase:phase.filters,capture:{tileCount:captured.tileCount,workingBytes:captured.workingBytes,resourceBytes:drawingPlan.bytes}});
        bitmap.close();verify(bitmap.width===0,`${label}: native scene disposal closes the cel bitmap`);
      }finally{capturePhase=null;provider?.dispose();bitmap?.close();if(expectedCanvas){releaseGeometryResources(expectedCanvas.getContext('2d'));expectedCanvas.width=expectedCanvas.height=1;}releaseVfxCPU();releaseVfxGPU();releaseVfxSoftwareResources();}
    }
    return {checks,rows,backend:disableWebGL?'Canvas 2D published scene CPU fallback':'Canvas 2D published scene GPU capture'};
  }catch(error){error.partialChecks=checks;error.partialRows=rows;throw error;}
  finally{OffscreenCanvas.prototype.getContext=getContext;VfxCPU.prototype.runPixels=runPixels;VfxGPU.prototype.run=gpuRun;DrawingTileProvider.prototype.drop=drop;owner.dispose();releaseVfxCPU();releaseVfxGPU();releaseVfxSoftwareResources();}
}
