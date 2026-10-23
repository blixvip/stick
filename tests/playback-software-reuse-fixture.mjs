import {emptyDocument,defaultFigure,createObject,createFrame} from '../src/demo.mjs';
import {compilePlaybackPacket,playbackLocation} from '../src/playback-worker.mjs';
import {PlaybackResources} from '../src/playback-resources.mjs';
import {ArtworkRegistry} from '../src/render-artwork.mjs';
import {PlaybackGeometryCache} from '../src/playback-geometry-cache.mjs';
import {buildGeometry,evaluatedFrame,timeline,releaseGeometryResources} from '../src/pivot/geometry.mjs';
import {drawBackground,backgroundBounds} from '../src/pivot/background.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {drawParallaxGeometry} from '../src/parallax-draw.mjs';
import {parallaxResolver} from '../src/layer-parallax.mjs';
import {drawSoftwarePlaybackGeometry} from '../src/playback-software-painter.mjs';
import {CameraVfx} from '../src/vfx-camera.mjs';
import {activeVfx,vfxStack} from '../src/vfx.mjs';
import {layerVisible,ensureLayerState} from '../src/layers.mjs';

const check=(value,message)=>{if(!value)throw new Error(message);};
const close=packet=>{for(const entry of packet.compatibility)entry.bitmap?.close();};
function denseReport(){
  const report=emptyDocument(),figure=defaultFigure(1),base=figure.segments[0];
  figure.segments=Array.from({length:48},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:70+i%12,
    angle_rad:i*Math.PI/24,thickness:1.234+(i%7)*.2,color_rgb:[20+i*3,60,180],z_order:i+1}));
  figure.segment_count=figure.segments.length;report.figure_types=[figure];report.canvas_width=320;report.canvas_height=240;
  const objects=[createObject(figure,1,95.25,100.75),createObject(figure,2,220,155,{field28:95}),
    createObject(figure,3,1800,900)];
  report.keyframes=[createFrame(objects,8)];return report;
}
function pixels(bitmap){
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(bitmap,0,0);const result=context.getImageData(0,0,canvas.width,canvas.height).data;
  canvas.width=canvas.height=1;return result;
}
function compare(a,b,label,{exact=false}={}){
  check(a.length===b.length,`${label}: size mismatch`);let maximum=0,different=0;
  for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);if(delta)different++;maximum=Math.max(maximum,delta);}
  // Software caching composites premultiplied artwork over the background. Its
  // integer Canvas conversion can differ by one channel level at path edges.
  check(maximum<=(exact?0:2),`${label}: pixel error ${maximum} in ${different} channels`);
  return {label,maximum,different};
}
async function referencePacket(report,tick,{scale=1,cameraEnabled=true,hiddenUids=[]}={}){
  const resources=new PlaybackResources({preview:true}),location=playbackLocation(timeline(report),tick),
    frame=evaluatedFrame(report,location.index,location.t,tick),geometry=buildGeometry(report,frame),hidden=new Set(hiddenUids);
  const drawables=geometry.drawables.filter(item=>!hidden.has(item.obj.unique_id)&&layerVisible(report,item.obj.unique_id));
  const canvas=new OffscreenCanvas(Math.ceil(report.canvas_width*scale),Math.ceil(report.canvas_height*scale)),context=canvas.getContext('2d',{willReadFrequently:true});
  let camera;
  try {
    await resources.preload(drawables);
    context.setTransform(...cameraMatrix({report,frame,cameraEnabled,view:{scale}}));
    drawBackground(context,report,frame,report.canvas_width,report.canvas_height,{...resources,bounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,cameraEnabled,report)});
    drawParallaxGeometry(context,{drawables},resources,parallaxResolver(report,frame,cameraEnabled));
    if(activeVfx(vfxStack(frame)).length){camera=new CameraVfx();camera.render(context,{report,frame,view:{x:0,y:0,scale:1},geometry:{...geometry,drawables},cameraEnabled,playing:true},scale,resources);}
    return canvas.transferToImageBitmap();
  }finally{camera?.destroy();releaseGeometryResources(context);canvas.width=canvas.height=1;resources.dispose();}
}

/** Callable from the shared browser. No browser process or application edits. */
export async function runPlaybackSoftwareReuseChecks({sharedArtwork=true,onProgress=()=>{}}={}){
  onProgress('start');
  const report=denseReport(),checks=[],resources=new PlaybackResources({preview:true,maxRasterBytes:4*1024*1024}),
    registry=new ArtworkRegistry(),geometryCache=new PlaybackGeometryCache();
  const options={softwareFrames:true,resources,artworkRegistry:registry,geometryCache,revision:1,vfxEnabled:false,sharedArtwork};
  try {
    onProgress('dense reference');const reference=await referencePacket(report,0);
    onProgress('dense cold compile');const cold=await compilePlaybackPacket(report,0,options);
    const coldSignatureBytes=registry.bytes,coldSignatureMisses=registry.stats.misses;
    onProgress('dense repeat capture');const warm=await compilePlaybackPacket(report,1,options);
    onProgress('dense warm reuse');const reused=await compilePlaybackPacket(report,2,options);
    try {
      checks.push(compare(pixels(reference),pixels(cold.compatibility[0].bitmap),'dense opaque and isolated opacity'));
      checks.push(compare(pixels(cold.compatibility[0].bitmap),pixels(warm.compatibility[0].bitmap),'held artwork warm reuse',{exact:true}));
      checks.push(compare(pixels(warm.compatibility[0].bitmap),pixels(reused.compatibility[0].bitmap),'held artwork borrowed pixels',{exact:true}));
      if(sharedArtwork){check(cold.sharing.cachedObjects===0&&cold.sharing.rasterCacheMisses===0,'First-use artwork allocated a speculative capture');
        check(coldSignatureBytes===0&&coldSignatureMisses===0,'First-use artwork computed a speculative content signature');
        check(warm.sharing.cachedObjects>=1&&warm.sharing.rasterCacheMisses>=1,'Repeated isolated artwork did not become reusable');
        check(reused.sharing.rasterCacheHits>=1,'Held isolated software artwork was repainted');}
      check(cold.clipping.culledObjects===0,'First-use artwork performed speculative bounds work');
      check(warm.clipping.culledObjects>=1,'Repeated off-camera artwork was submitted for painting');
      check(warm.uids.includes(3),'Pixel culling changed native visibility metadata');
      check(resources.artworkBitmaps.bytes<=resources.artworkBitmaps.maxBytes,'Software raster budget overflowed');
    } finally {reference.close();close(cold);close(warm);close(reused);}
    for(const [scale,cameraEnabled,hiddenUids] of [[.625,true,[2]],[1.5,false,[]]]){
      const cameraReport=structuredClone(report);cameraReport.keyframes[0].camera={x:17.25,y:-9.5,scale:1.2,angle_rad:.23};
      onProgress(`camera reference ${scale} ${cameraEnabled}`);
      const reference=await referencePacket(cameraReport,0,{scale,cameraEnabled,hiddenUids});
      onProgress(`camera compile ${scale} ${cameraEnabled}`);
      const packet=await compilePlaybackPacket(cameraReport,0,{...options,revision:2,scale,cameraEnabled,hiddenUids});
      onProgress(`camera repeated compile ${scale} ${cameraEnabled}`);
      const repeated=await compilePlaybackPacket(cameraReport,1,{...options,revision:2,scale,cameraEnabled,hiddenUids});
      try{
        checks.push(compare(pixels(reference),pixels(packet.compatibility[0].bitmap),`fractional rotated camera ${scale} ${cameraEnabled}`));
        checks.push(compare(pixels(reference),pixels(repeated.compatibility[0].bitmap),`repeated fractional camera ${scale} ${cameraEnabled}`,{exact:true}));
      } finally {reference.close();close(packet);close(repeated);}
    }
    onProgress('capped reference');const cappedReference=await referencePacket(report,0,{scale:.4});
    onProgress('capped compile');const capped=await compilePlaybackPacket(report,0,{...options,revision:2,scale:5,maxTextureDimension:128});
    try {
      check(capped.compatibility[0].bitmap.width===128&&capped.compatibility[0].bitmap.height===96,'Software dimension cap did not bound the complete artboard');
      check(capped.previewQuality.reduced,'A capped software raster lost its reduced-preview indication');
      checks.push(compare(pixels(cappedReference),pixels(capped.compatibility[0].bitmap),'capped dimensions retain the complete artboard'));
    } finally {cappedReference.close();close(capped);}
    // Native brush tolerance survives both invisible objects and reused rasters.
    const brushReport=denseReport(),figure=brushReport.figure_types[0];
    figure.segments[47].thickness=2;brushReport.keyframes[0].objects[1].field28=0;
    const tiny=defaultFigure(2);tiny.segments=[{...tiny.segments[0],segment_id:1,parent_id:0,length:80,angle_rad:0,thickness:2.00005}];tiny.segment_count=1;
    brushReport.figure_types.push(tiny);brushReport.keyframes[0].objects.splice(1,0,createObject(tiny,9,20,200));
    brushReport.keyframes[0]=createFrame(brushReport.keyframes[0].objects,8);
    for(let tick=0;tick<2;tick++){
      onProgress(`brush reference ${tick}`);const reference=await referencePacket(brushReport,tick);
      onProgress(`brush compile ${tick}`);const packet=await compilePlaybackPacket(brushReport,tick,{...options,revision:3});
      try{checks.push(compare(pixels(reference),pixels(packet.compatibility[0].bitmap),`shared native brush ${tick}`));}finally{reference.close();close(packet);}
    }
    const layered=denseReport();ensureLayerState(layered);for(const layer of Object.values(layered._styk.layers.byId))layer.visible=false;
    onProgress('hidden layer compile');const packet=await compilePlaybackPacket(layered,0,{...options,revision:4});
    check(packet.uids.length===0,'Layer-hidden artwork remained in software playback');close(packet);
    // A connected painter run can contain several native owners. An offscreen
    // first owner must not hide a later visible one, including after filtering.
    const mixedGeometry=buildGeometry(report,report.keyframes[0]),first=mixedGeometry.orderedObjects[2],second=mixedGeometry.orderedObjects[0];
    const mixed={...first,drawables:[...first.drawables,...second.drawables]};
    for(const hidden of [new Set(),new Set([first.obj.unique_id])]){
      onProgress(`mixed owner ${hidden.size?'filtered':'visible'}`);
      const images=[];
      for(const optimized of [false,true]){
        const canvas=new OffscreenCanvas(320,240),context=canvas.getContext('2d',{willReadFrequently:true});
        context.fillStyle='#8899aa';context.fillRect(0,0,320,240);
        if(optimized)await drawSoftwarePlaybackGeometry(context,{orderedObjects:[mixed]},resources,{report,hiddenSet:hidden,offsetFor:()=>({x:0,y:0}),revision:4,artworkRegistry:registry,sharedArtwork});
        else drawParallaxGeometry(context,{drawables:mixed.drawables.filter(item=>!hidden.has(item.obj.unique_id))},resources,()=>({x:0,y:0}));
        images.push(context.getImageData(0,0,320,240).data);releaseGeometryResources(context);canvas.width=canvas.height=1;
      }
      checks.push(compare(images[0],images[1],`mixed native owner ${hidden.size?'filtered':'visible'}`,{exact:true}));
    }
    // A rebound retains object-local source points while its current root moves.
    const source=buildGeometry(report,report.keyframes[0]).orderedObjects[1],delta={x:12,y:-7};
    let sourcePointReads=0;const sourcePoints=source.drawables[0].points;
    Object.defineProperty(source.drawables[0],'points',{enumerable:true,get(){sourcePointReads++;return sourcePoints;}});
    const obj={...source.obj,root_x:source.root.x+delta.x,root_y:source.root.y+delta.y};
    const point=value=>value&&({x:value.x+delta.x,y:value.y+delta.y});
    const rebound={...source,obj,root:point(source.root),renderSource:source,drawables:source.drawables.map(item=>({...item,obj,
      start:point(item.start),end:point(item.end),points:item.points?.map(point)}))};
    sourcePointReads=0;
    const reboundPixels=[];
    for(const [pass,optimized] of [false,true,true,true].entries()){
      onProgress(`rebound ${optimized?`optimized ${pass}`:'reference'}`);
      const canvas=new OffscreenCanvas(320,240),context=canvas.getContext('2d',{willReadFrequently:true});
      context.fillStyle='#8899aa';context.fillRect(0,0,320,240);
      if(optimized)await drawSoftwarePlaybackGeometry(context,{orderedObjects:[rebound]},resources,{report,offsetFor:()=>({x:0,y:0}),revision:5,artworkRegistry:registry,sharedArtwork});
      else drawParallaxGeometry(context,{drawables:rebound.drawables},resources,()=>({x:0,y:0}));
      if(pass===1)check(sourcePointReads===0,'First-use artwork inspected canonical source points before native painting');
      reboundPixels.push(context.getImageData(0,0,320,240).data);releaseGeometryResources(context);canvas.width=canvas.height=1;
    }
    for(let pass=1;pass<reboundPixels.length;pass++)checks.push(compare(reboundPixels[0],reboundPixels[pass],`translated immutable artwork source ${pass}`));
    check(sourcePointReads>0,'Repeated artwork never classified its reusable source');
    for(const [x,revision] of [[.375,5],[.75,5],[.75,6]]){
      const label=`moving source phase ${x} revision ${revision}`;
      onProgress(label);const before=sourcePointReads,images=[],offset={x,y:-.25};
      for(const optimized of [false,true]){
        const canvas=new OffscreenCanvas(320,240),context=canvas.getContext('2d',{willReadFrequently:true});
        context.fillStyle='#8899aa';context.fillRect(0,0,320,240);
        if(optimized)await drawSoftwarePlaybackGeometry(context,{orderedObjects:[rebound]},resources,{report,offsetFor:()=>offset,revision,artworkRegistry:registry,sharedArtwork});
        else drawParallaxGeometry(context,{drawables:rebound.drawables},resources,()=>offset);
        images.push(context.getImageData(0,0,320,240).data);releaseGeometryResources(context);canvas.width=canvas.height=1;
      }
      check(sourcePointReads===before,'A changed destination phase inspected canonical source points');
      checks.push(compare(images[0],images[1],label,{exact:true}));
    }
    const changing=denseReport(),template=changing.keyframes[0];
    changing.keyframes=Array.from({length:4},(_,tick)=>{
      const frame=structuredClone(template);frame.duration_raw=1;frame.objects[1].angles[0]+=.07*(tick+1);return frame;
    });
    const priorSignatureBytes=registry.bytes,heldEntry=resources.artworkBitmaps.entries.entries().next().value;
    for(let tick=0;tick<4;tick++){
      onProgress(`changing pose compile ${tick}`);
      const packet=await compilePlaybackPacket(changing,tick,{...options,revision:7});
      try {check(packet.sharing.cachedObjects===0&&packet.sharing.rasterCacheMisses===0,'A constantly changing pose captured unreusable artwork');}
      finally {close(packet);}
    }
    check(registry.bytes===priorSignatureBytes,'Changing first-use poses generated content signatures');
    if(heldEntry)check(resources.artworkBitmaps.entries.get(heldEntry[0])===heldEntry[1],'Unreusable pose churn evicted held artwork');
    // A real yield can stop mid-frame without publishing or leaking a bitmap.
    const canvas=new OffscreenCanvas(320,240),context=canvas.getContext('2d',{willReadFrequently:true}),geometry=buildGeometry(report,report.keyframes[0]);
    let cancelled=false,yields=0,error;
    onProgress('cancellation');
    try{await drawSoftwarePlaybackGeometry(context,geometry,resources,{report,offsetFor:()=>({x:0,y:0}),revision:1,
      artworkRegistry:registry,cancelled:()=>cancelled,yieldWork:async()=>{if(++yields===2)cancelled=true;}});}catch(cause){error=cause;}
    check(error?.name==='AbortError','Software frame ignored cooperative cancellation');
    releaseGeometryResources(context);canvas.width=canvas.height=1;
    return {checks,rasterBytes:resources.artworkBitmaps.bytes,cacheEntries:resources.artworkBitmaps.entries.size,cancellationYields:yields};
  } finally {onProgress('dispose');resources.dispose();check(resources.artworkBitmaps.bytes===0,'Disposed software pixels remained retained');onProgress('disposed');}
}
