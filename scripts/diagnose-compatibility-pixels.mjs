/** Read-only, browser-callable editor pixel diagnosis. All variants consume one
 * already-normalized document. The direct oracle retains the editor's exact
 * group order and renderer pipeline, replacing only its object raster cache
 * with the shared native Canvas painter on a diagnostic renderer instance. */
const prefixesDefault=['/__compat_baseline__/src','/src'];
const hash=pixels=>{let value=2166136261;for(const byte of pixels)value=Math.imul(value^byte,16777619);return (value>>>0).toString(16).padStart(8,'0');};
const read=canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;

function geometryHash(geometry){
  let value=2166136261;
  for(const item of geometry.drawables){
    const text=JSON.stringify([item.type,item.slot,item.obj?.unique_id,item.thickness,item.bend,item.length,item.angle,item.opacity,item.alpha,item.rgb,
      item.start&&[item.start.x,item.start.y],item.end&&[item.end.x,item.end.y],item.points?.map(p=>[p.x,p.y]),item.depthValues,item.culled]);
    for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);
  }
  return (value>>>0).toString(16).padStart(8,'0');
}

/** Flat opaque interiors are separated from a two-pixel neighborhood around
 * every color/coverage transition. This diagnoses missing filled artwork as
 * well as ordinary cached-versus-direct antialiasing differences. */
function interiorMask(pixels,width,height){
  const mask=new Uint8Array(width*height);
  for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
    const index=(y*width+x)*4;if(pixels[index+3]!==255)continue;
    let flat=true;
    for(let dy=-2;dy<=2&&flat;dy++)for(let dx=-2;dx<=2;dx++){
      const other=((y+dy)*width+x+dx)*4;
      if(pixels[other+3]!==255||pixels[other]!==pixels[index]||pixels[other+1]!==pixels[index+1]||pixels[other+2]!==pixels[index+2]){flat=false;break;}
    }
    if(flat)mask[y*width+x]=1;
  }
  return mask;
}

export function compareCompatibilityPixels(reference,candidate,width,height,mask=interiorMask(reference,width,height)){
  const histogram=[0,0,0,0,0,0,0,0],interiorHistogram=[0,0,0,0,0,0,0,0];
  const thresholds=[0,2,8,16,32,64,128,255],blocks=new Map();
  let max=0,absolute=0,premultiplied=0,changed=0,over2=0,over16=0,over32=0,alphaMax=0,interiorPixels=0,interiorMax=0,interiorAbsolute=0,interiorChanged=0;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(let pixel=0;pixel<width*height;pixel++){
    const index=pixel*4;let pixelMax=0,pixelAbsolute=0;
    for(let channel=0;channel<4;channel++){
      const delta=Math.abs(reference[index+channel]-candidate[index+channel]);
      max=Math.max(max,delta);pixelMax=Math.max(pixelMax,delta);absolute+=delta;pixelAbsolute+=delta;
      if(channel===3){alphaMax=Math.max(alphaMax,delta);premultiplied+=delta;}
      else premultiplied+=Math.abs(reference[index+channel]*reference[index+3]/255-candidate[index+channel]*candidate[index+3]/255);
    }
    let bin=0;while(pixelMax>thresholds[bin])bin++;histogram[bin]++;
    if(mask[pixel]){interiorPixels++;interiorHistogram[bin]++;interiorMax=Math.max(interiorMax,pixelMax);interiorAbsolute+=pixelAbsolute;if(pixelMax>2)interiorChanged++;}
    if(pixelMax){
      changed++;if(pixelMax>2)over2++;if(pixelMax>16)over16++;if(pixelMax>32)over32++;
      const x=pixel%width,y=Math.floor(pixel/width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
      const key=`${Math.floor(x/64)},${Math.floor(y/64)}`;let block=blocks.get(key);
      if(!block)blocks.set(key,block={x:Math.floor(x/64)*64,y:Math.floor(y/64)*64,changedPixels:0,max:0,totalAbsolute:0});
      block.changedPixels++;block.max=Math.max(block.max,pixelMax);block.totalAbsolute+=pixelAbsolute;
    }
  }
  return {max,meanAbsolute:absolute/reference.length,premultipliedMean:premultiplied/reference.length,alphaMax,changedPixels:changed,
    changedPercent:changed/(width*height)*100,over2Pixels:over2,over16Pixels:over16,over32Pixels:over32,
    deltaBins:thresholds,histogram,interior:{pixels:interiorPixels,max:interiorMax,meanAbsolute:interiorPixels?interiorAbsolute/(4*interiorPixels):0,
      changedOver2:interiorChanged,histogram:interiorHistogram},changedBounds:changed?{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1}:null,
    largestDifferenceBlocks:[...blocks.values()].sort((a,b)=>b.totalAbsolute-a.totalAbsolute).slice(0,16)};
}

function showCapture(name,pixels,width,height){
  const box=document.createElement('figure'),label=document.createElement('figcaption'),canvas=document.createElement('canvas');
  label.textContent=name;canvas.width=width;canvas.height=height;canvas.style.cssText='width:100%;height:auto;display:block';
  canvas.getContext('2d').putImageData(new ImageData(pixels,width,height),0,0);box.style.cssText='margin:0;min-width:0';box.append(label,canvas);return box;
}

export async function diagnoseCompatibilityEditorPixels(report,{tick=297,width=1280,height=720,scale=1,prefixes=prefixesDefault,showCanvases=false,onProgress=()=>{}}={}){
  if(!(report?.canvas_width>0&&report?.canvas_height>0))throw Error('Supply the same normalized report used by the paired benchmark.');
  const rasterScale=Math.min(width/report.canvas_width,height/report.canvas_height)*scale;
  const view={scale:rasterScale,x:(width-report.canvas_width*rasterScale)/2,y:(height-report.canvas_height*rasterScale)/2};
  const captures=[],metadata=[],snapshots=[];
  for(const rawPrefix of prefixes){
    const prefix=rawPrefix.replace(/\/+$/,'');
    const [{createRenderer},geometryModule,{PlaybackResources},{playbackLocation},{frameImageDrawables,backgroundImageAssets},{previewMemoryPlan}]=await Promise.all([
      import(`${prefix}/renderer.mjs`),import(`${prefix}/pivot/geometry.mjs`),import(`${prefix}/playback-resources.mjs`),
      import(`${prefix}/playback-worker.mjs`),import(`${prefix}/scene-preparation.mjs`),import(`${prefix}/playback-budget.mjs`)]);
    const {timeline,evaluatedFrame,buildGeometry,drawGeometry,invalidateEvaluationCaches}=geometryModule;
    const entries=timeline(report),location=playbackLocation(entries,tick),frame=evaluatedFrame(report,location.index,location.t,tick),geometry=buildGeometry(report,frame);
    const plan=previewMemoryPlan(),options={report,frame,geometry,view,cameraEnabled:false,vfxEnabled:true,clipToCanvas:false,
      artworkRevision:1,selectedUid:null,showHandles:false,onionFrames:[]};
    const input={sourcePrefix:prefix,tick,objects:geometry.objects.size,drawables:geometry.drawables.length,geometryHash:geometryHash(geometry)};
    for(const native of [false,true]){
      const canvas=new OffscreenCanvas(width,height),resources=new PlaybackResources({preview:true,maxBytes:plan.editorImages,hardMaxBytes:plan.editorImages});
      let renderer;
      try{
        await onProgress({phase:'pixel capture',sourcePrefix:prefix,native});
        await resources.preload([...frameImageDrawables(geometry),...backgroundImageAssets(report,frame).map(asset=>({type:'image',asset}))],
          {scale:Math.max(1/64,2**Math.ceil(Math.log2(rasterScale))),maxDimension:4096});
        renderer=await createRenderer(canvas,{forceCanvas2D:true,asyncArtwork:false,resources,onInvalidate(){}});renderer.resize(width,height,1);
        if(native)renderer.drawObject=(context,group)=>drawGeometry(context,{drawables:group.items},renderer.resources);
        renderer.render(options);
        const pixels=read(canvas),name=`${prefix}: ${native?'direct native painter':'normal editor'}`;
        snapshots.push(pixels);captures.push({name,hash:hash(pixels),native,...input});
        metadata.push({name,artworkBytes:renderer.artworkBytes,artworkEntries:renderer.artwork?.size,culledObjects:renderer.stats.culledObjects??0,
          rasters:[...(renderer.artwork??[])].map(([g,entry])=>({uid:g.obj?.unique_id,primitives:g.drawables?.length,bytes:entry.bytes,resolution:entry.resolution,
            bounds:entry.bounds,crop:entry.raster?{x:entry.raster.x,y:entry.raster.y,width:entry.raster.width,height:entry.raster.height,pixelScale:entry.raster.pixelScale}:null}))});
      }finally{renderer?.destroy();renderer?.resources?.clear();resources.dispose();canvas.width=canvas.height=1;}
    }
    invalidateEvaluationCaches?.(report);
  }
  const comparisons=[];
  for(let index=0;index<captures.length;index+=2){
    const oracle=snapshots[index+1],mask=interiorMask(oracle,width,height);
    comparisons.push({reference:captures[index+1].name,candidate:captures[index].name,...compareCompatibilityPixels(oracle,snapshots[index],width,height,mask)});
  }
  if(captures.length===4){
    comparisons.push({reference:captures[0].name,candidate:captures[2].name,...compareCompatibilityPixels(snapshots[0],snapshots[2],width,height)});
    comparisons.push({reference:captures[1].name,candidate:captures[3].name,...compareCompatibilityPixels(snapshots[1],snapshots[3],width,height)});
  }
  if(showCanvases){
    for(const previous of document.querySelectorAll('[data-compatibility-pixel-diagnosis]')){for(const canvas of previous.querySelectorAll('canvas'))canvas.width=canvas.height=1;previous.remove();}
    const container=document.createElement('section');container.dataset.compatibilityPixelDiagnosis='true';container.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;font:13px sans-serif;background:white;color:black;padding:12px';
    for(let index=0;index<captures.length;index++)container.append(showCapture(captures[index].name,snapshots[index],width,height));
    document.body.append(container);
  }
  return {settings:{tick,width,height,dpr:1,rasterScale,view,cameraEnabled:false,vfxEnabled:true,asyncArtwork:false},captures,comparisons,metadata};
}

function cropPixels(pixels,sourceWidth,width,height){
  const cropped=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)cropped.set(pixels.subarray(y*sourceWidth*4,(y*sourceWidth+width)*4),y*width*4);
  return cropped;
}

function pixelEdges(pixels,width,height){
  const bottom=pixels.slice((height-1)*width*4),right=new Uint8ClampedArray(height*4);
  let transparentBottom=0,transparentRight=0;
  for(let y=0;y<height;y++)right.set(pixels.subarray((y*width+width-1)*4,(y*width+width)*4),y*4);
  for(let i=3;i<bottom.length;i+=4)transparentBottom+=Number(bottom[i]===0);
  for(let i=3;i<right.length;i+=4)transparentRight+=Number(right[i]===0);
  return {bottomHash:hash(bottom),rightHash:hash(right),transparentBottomPixels:transparentBottom,transparentRightPixels:transparentRight};
}

/** Compare native packet pixels without rescaling. A floating-point ceil can
 * append an extra row/column to an older packet; the common rectangle samples
 * the same native artboard coordinates and exposes painting differences rather
 * than introducing a new filtering difference during measurement. */
export async function diagnoseCompatibilitySoftwarePixels(report,{tick=66,scale=1.6,quality=1,prefixes=prefixesDefault,
  showCanvases=false,onProgress=()=>{},strict=false}={}){
  if(!(report?.canvas_width>0&&report?.canvas_height>0))throw Error('Supply the same normalized report used by the paired benchmark.');
  const snapshots=[],captures=[];
  const variants=prefixes.map(prefix=>({prefix:prefix.replace(/\/+$/,''),sharedArtwork:true}));
  if(variants.length)variants.push({prefix:variants.at(-1).prefix,sharedArtwork:false});
  for(const {prefix,sharedArtwork} of variants){
    const [{compilePlaybackPacket},{PlaybackResources},{ArtworkRegistry},{PlaybackGeometryCache},{PlaybackTweenCache},
      {timeline,invalidateEvaluationCaches},{previewMemoryPlan}]=await Promise.all([
      import(`${prefix}/playback-worker.mjs`),import(`${prefix}/playback-resources.mjs`),import(`${prefix}/render-artwork.mjs`),
      import(`${prefix}/playback-geometry-cache.mjs`),import(`${prefix}/playback-tween-cache.mjs`),
      import(`${prefix}/pivot/geometry.mjs`),import(`${prefix}/playback-budget.mjs`)]);
    const plan=previewMemoryPlan(),entries=timeline(report),registry=new ArtworkRegistry(),geometryCache=new PlaybackGeometryCache(),tweenCache=new PlaybackTweenCache();
    const resources=new PlaybackResources({preview:true,maxBytes:plan.workerImages,hardMaxBytes:plan.workerImages,maxRasterBytes:plan.workerRasters,
      maxVectorBytes:plan.workerVectors,maxSoftwareFilterBytes:plan.workerSoftwareFilters,maxBackgroundBytes:plan.workerBackgrounds,maxPacketBytes:128*1024*1024});
    let packet,canvas;
    try{
      await onProgress({phase:'software pixel capture',sourcePrefix:prefix,sharedArtwork,tick,scale,quality});
      packet=await compilePlaybackPacket(report,tick,{revision:1,entries,scale,quality,softwareFrames:true,cameraEnabled:true,vfxEnabled:true,
        sharedArtwork,resources,artworkRegistry:registry,geometryCache,tweenCache,maxPacketBytes:128*1024*1024});
      const bitmap=packet.compatibility?.[0]?.bitmap;
      if(!bitmap)throw Error('The compiler did not produce a software frame bitmap.');
      canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);
      const pixels=read(canvas),width=canvas.width,height=canvas.height,name=`${prefix}: ${sharedArtwork?'prepared software':'direct software (sharedArtwork:false)'}`;
      snapshots.push(pixels);captures.push({name,sourcePrefix:prefix,sharedArtwork,width,height,pixelBytes:width*height*4,packetBytes:packet.byteLength,
        hash:hash(pixels),edges:pixelEdges(pixels,width,height),packetScale:packet.scale,packetResolution:packet.resolution,
        reduced:Boolean(packet.previewQuality?.reduced),sharing:packet.sharing,clipping:packet.clipping});
    }finally{
      const closed=new Set();for(const entry of packet?.compatibility??[])if(entry.bitmap&&!closed.has(entry.bitmap)){closed.add(entry.bitmap);entry.bitmap.close();}
      resources.dispose();registry.clear();geometryCache.clear();tweenCache.clear();if(canvas)canvas.width=canvas.height=1;invalidateEvaluationCaches?.(report);
    }
  }
  const width=Math.min(...captures.map(capture=>capture.width)),height=Math.min(...captures.map(capture=>capture.height));
  const common=snapshots.map((pixels,index)=>cropPixels(pixels,captures[index].width,width,height));
  const comparisons=[];
  for(let index=1;index<captures.length;index++){
    const comparison=compareCompatibilityPixels(common[0],common[index],width,height);
    comparisons.push({reference:captures[0].name,candidate:captures[index].name,pass:comparison.max<=1,...comparison});
  }
  if(captures.length>=3){
    const referenceIndex=captures.length-1,candidateIndex=referenceIndex-1,comparison=compareCompatibilityPixels(common[referenceIndex],common[candidateIndex],width,height);
    comparisons.push({reference:captures[referenceIndex].name,candidate:captures[candidateIndex].name,pass:comparison.max<=1,...comparison});
  }
  if(showCanvases){
    for(const previous of document.querySelectorAll('[data-compatibility-pixel-diagnosis]')){for(const canvas of previous.querySelectorAll('canvas'))canvas.width=canvas.height=1;previous.remove();}
    const container=document.createElement('section');container.dataset.compatibilityPixelDiagnosis='true';container.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;font:13px sans-serif;background:white;color:black;padding:12px';
    for(let index=0;index<captures.length;index++)container.append(showCapture(`${captures[index].name} (${captures[index].width}x${captures[index].height}; common crop shown)`,common[index],width,height));
    document.body.append(container);
  }
  const requestedWidth=report.canvas_width*scale*quality,requestedHeight=report.canvas_height*scale*quality;
  const result={settings:{tick,scale,quality,cameraEnabled:true,vfxEnabled:true},
    requestedArtboard:{width:requestedWidth,height:requestedHeight,ceilWidth:Math.ceil(requestedWidth),ceilHeight:Math.ceil(requestedHeight)},
    commonCrop:{x:0,y:0,width,height,rescaled:false,hashes:common.map(hash),coversRequestedArtboard:width>=Math.ceil(requestedWidth)&&height>=Math.ceil(requestedHeight)},
    captures,comparisons,pass:comparisons.every(comparison=>comparison.pass)};
  if(strict&&(!result.pass||!result.commonCrop.coversRequestedArtboard))throw Object.assign(Error('Software packet pixels differ beyond one level or do not cover the requested artboard.'),{details:result});
  return result;
}
