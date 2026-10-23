import {capturePreviewRaster,planPreviewRaster} from '../src/renderer-raster-capture.mjs';
import {sendDrawingComposite} from '../src/drawing-composite-transport.mjs';
import {applyDocumentChunk} from '../src/document-transport.mjs';
import {createVfx} from '../src/vfx.mjs';
import {VfxCPU,releaseVfxCPU} from '../src/vfx-cpu.mjs';
import {releaseVfxSoftwareResources} from '../src/vfx-canvas.mjs';
import {VfxGPU,releaseVfxGPU,withVfxWorkerResources} from '../src/vfx-gpu.mjs';
import {drawGeometry,releaseGeometryResources} from '../src/pivot/geometry.mjs';

const MiB=1024*1024;
const effect=(type,id,params={})=>{const value=createVfx(type,id);Object.assign(value.params,params);return value;};
const bits=value=>new Uint32Array(new Float32Array([value]).buffer)[0];
const line=(obj,fig,i)=>{
  const x=4+(i%9)*7.11,y=4+Math.floor(i/9)*7.37,points=[{x,y},{x:x+16.4,y:y+7.27},{x:x+8.33,y:y+17.83}];
  return {type:'line',slot:0,opacity:1,alpha:.9,rgb:[35,150,230],obj,fig,seg:{segment_id:i+1,segment_kind:i%3?'line':'squareLine'},start:points[0],end:points.at(-1),points,thickness:.6+(i%3)*.37,length:Math.hypot(8.33,17.83),bend:.2};
};
async function snapshot(items){
  let source;
  await sendDrawingComposite({async request(kind,{chunk}){if(kind!=='composite-chunk')throw Error('Unexpected transport');source=applyDocumentChunk(source,structuredClone(chunk));}},items,{maxBytes:8*MiB});
  return source;
}
function read(bitmap){const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;canvas.width=canvas.height=1;return pixels;}
function compare(a,b,width,height,tileWidth,tileHeight,minimumSampleDelta=8){
  let max=0,sum=0,changed=0,alphaMax=0,premultipliedSum=0,premultipliedMax=0,premultipliedChangedPixels=0,seamMax=0,nonSeamMax=0,alphaSeamMax=0,alphaNonSeamMax=0,interiorMax=0;
  const firstDeltas=[],firstAlphaDeltas=[];
  const differingPixelsByMaxAlpha={zero:0,one:0,twoTo31:0,from32To127:0,from128To254:0,opaque:0},alphaDeltaPixels={one:0,moreThanOne:0};
  for(let pixel=0;pixel<width*height;pixel++){
    const index=pixel*4,x=pixel%width,y=Math.floor(pixel/width),seam=x%tileWidth<2||x%tileWidth>=tileWidth-2||y%tileHeight<2||y%tileHeight>=tileHeight-2;
    const opaque=a[index+3]===255&&b[index+3]===255;
    let pixelMax=0,pixelPremultipliedMax=0;
    for(let channel=0;channel<4;channel++){
      const delta=Math.abs(a[index+channel]-b[index+channel]);pixelMax=Math.max(pixelMax,delta);max=Math.max(max,delta);sum+=delta;if(delta)changed++;if(seam)seamMax=Math.max(seamMax,delta);else nonSeamMax=Math.max(nonSeamMax,delta);if(opaque)interiorMax=Math.max(interiorMax,delta);
      if(channel===3){alphaMax=Math.max(alphaMax,delta);if(seam)alphaSeamMax=Math.max(alphaSeamMax,delta);else alphaNonSeamMax=Math.max(alphaNonSeamMax,delta);}
      const premultipliedDelta=channel===3?delta:Math.abs(a[index+channel]*a[index+3]/255-b[index+channel]*b[index+3]/255);
      premultipliedSum+=premultipliedDelta;pixelPremultipliedMax=Math.max(pixelPremultipliedMax,premultipliedDelta);premultipliedMax=Math.max(premultipliedMax,premultipliedDelta);
    }
    if(pixelMax){const alpha=Math.max(a[index+3],b[index+3]);differingPixelsByMaxAlpha[alpha===0?'zero':alpha===1?'one':alpha<=31?'twoTo31':alpha<=127?'from32To127':alpha<=254?'from128To254':'opaque']++;}
    if(pixelPremultipliedMax)premultipliedChangedPixels++;
    const alphaDelta=Math.abs(a[index+3]-b[index+3]);if(alphaDelta)alphaDeltaPixels[alphaDelta===1?'one':'moreThanOne']++;
    if(pixelMax>=minimumSampleDelta&&firstDeltas.length<24||alphaDelta&&firstAlphaDeltas.length<12){
      const edges=[];
      for(let edge=tileWidth;edge<width;edge+=tileWidth)edges.push(Math.abs(x+.5-edge));
      for(let edge=tileHeight;edge<height;edge+=tileHeight)edges.push(Math.abs(y+.5-edge));
      const sample={x,y,expected:Array.from(a.slice(index,index+4)),actual:Array.from(b.slice(index,index+4)),max:pixelMax,distanceToCoreEdge:edges.length?Math.min(...edges):null};
      if(pixelMax>=minimumSampleDelta&&firstDeltas.length<24)firstDeltas.push(sample);
      if(alphaDelta&&firstAlphaDeltas.length<12)firstAlphaDeltas.push(sample);
    }
  }
  return {max,mean:sum/a.length,changed,alphaMax,premultipliedMean:premultipliedSum/a.length,premultipliedMax,premultipliedChangedPixels,differingPixelsByMaxAlpha,alphaDeltaPixels,seamMax,nonSeamMax,alphaSeamMax,alphaNonSeamMax,interiorMax,firstDeltas,firstAlphaDeltas};
}
function nativeCropProbe(items,plan,tileWidth,tileHeight){
  const width=Math.min(plan.width,tileWidth+2),height=Math.min(plan.height,tileHeight+2),rows=[];
  const render=(drawables,cropped,clipped)=>{
    const canvas=new OffscreenCanvas(cropped?width:plan.width,cropped?height:plan.height),context=canvas.getContext('2d',{willReadFrequently:true});
    try{
      if(clipped){context.beginPath();context.rect(0,0,width,height);context.clip();}
      context.setTransform(...plan.matrix);drawGeometry(context,{drawables},{});
      return context.getImageData(0,0,width,height).data;
    }finally{releaseGeometryResources(context);canvas.width=canvas.height=1;}
  };
  for(const [name,drawables] of [['native',items],['opacity-without-outline',items.map(item=>({...item,fig:{figure_type_id:item.fig.figure_type_id}}))],['opaque-without-outline',items.map(item=>({...item,opacity:1,fig:{figure_type_id:item.fig.figure_type_id}}))]]){
    const full=render(drawables,false,false);
    rows.push({name,canvasCrop:compare(full,render(drawables,true,false),width,height,tileWidth,tileHeight),sameCanvasClip:compare(full,render(drawables,false,true),width,height,tileWidth,tileHeight)});
  }
  return rows;
}
function nativeFullProbe(items,plan){
  const canvas=new OffscreenCanvas(plan.width,plan.height),context=canvas.getContext('2d',{willReadFrequently:true});
  try{context.setTransform(...plan.matrix);drawGeometry(context,{drawables:items},{});return context.getImageData(0,0,canvas.width,canvas.height).data;}
  finally{releaseGeometryResources(context);releaseVfxSoftwareResources();releaseVfxCPU();releaseVfxGPU();canvas.width=canvas.height=1;}
}
function nativeVfxSourceProbe(items,plan){
  const run=VfxGPU.prototype.run,frames=[];
  VfxGPU.prototype.run=function(source,stack,options){
    const context=source.getContext('2d');
    frames.push({width:source.width,height:source.height,origin:options.origin,matrix:context.getTransform(),pixels:context.getImageData(0,0,source.width,source.height).data});
    // Record the literal native painter's input before any shader sampling.
    return source;
  };
  const paint=sampling=>{
    const canvas=new OffscreenCanvas(plan.width,plan.height),context=canvas.getContext('2d',{willReadFrequently:true});
    try{context.setTransform(...plan.matrix);if(sampling)withVfxWorkerResources(()=>drawGeometry(context,{drawables:items},{}),{samplingPadding:true});else drawGeometry(context,{drawables:items},{});}
    finally{releaseGeometryResources(context);canvas.width=canvas.height=1;releaseVfxGPU();}
  };
  try{
    paint(false);paint(true);
    if(frames.length!==2)throw Error('Unexpected native VFX source count.');
    const [native,sampled]=frames,dx=sampled.origin.x-native.origin.x,dy=sampled.origin.y-native.origin.y;
    if(Math.abs(dx-Math.round(dx))>1e-7||Math.abs(dy-Math.round(dy))>1e-7)throw Error('Native VFX source grids are not integer-aligned.');
    const nativeX=Math.max(0,Math.round(dx)),nativeY=Math.max(0,Math.round(dy)),sampledX=Math.max(0,-Math.round(dx)),sampledY=Math.max(0,-Math.round(dy));
    const width=Math.min(native.width-nativeX,sampled.width-sampledX),height=Math.min(native.height-nativeY,sampled.height-sampledY);
    const crop=(source,x,y)=>{const pixels=new Uint8ClampedArray(width*height*4);for(let row=0;row<height;row++)pixels.set(source.pixels.subarray(((y+row)*source.width+x)*4,((y+row)*source.width+x+width)*4),row*width*4);return pixels;};
    const metadata=source=>({width:source.width,height:source.height,origin:source.origin,matrix:Array.from(['a','b','c','d','e','f'],key=>source.matrix[key])});
    return {native:metadata(native),sampled:metadata(sampled),originDelta:{x:dx,y:dy},difference:compare(crop(native,nativeX,nativeY),crop(sampled,sampledX,sampledY),width,height,width,height,1)};
  }finally{VfxGPU.prototype.run=run;}
}
/** Native full captures preserve their exact Canvas domain. Filter captures
 * under pressure retain the existing native alpha/mean contract when their
 * source domain changes; literal probes below record that native dependence.
 * Run in-page
 * through the test backend or T3; no project data or app startup is required. */
export async function rasterTileParity({strict=true,onProgress=()=>{},diagnose=false}={}){
  const figure={figure_type_id:1,segment_decode:{global_style:{u28:bits(.65),u30:100,rgb:[12,20,30]}}},object={unique_id:1,scale:1};
  const paths=Array.from({length:18},(_,i)=>({...line(object,figure,i),opacity:.58}));
  const glowing={unique_id:2,scale:1,_stykVfx:{figure:[effect('glow','glow',{radius:1.5,spread:.3,color:0x40b5ff}),effect('bloom','bloom',{radius:1.5,intensity:.6}),effect('blur','blur',{radius:1.2})]}};
  const dense=Array.from({length:225},(_,i)=>line(glowing,{figure_type_id:2},i%90));
  const scoped={unique_id:3,scale:1,_stykVfx:{figure:[effect('pixelate','grid',{size:2.5,offsetX:.3,offsetY:-.7}),effect('noise','grain',{amount:.2,size:2,seed:337})],'3/1':[effect('shadow','shadow',{radius:1,offsetX:2,offsetY:-1})]}};
  const nested=Array.from({length:6},(_,i)=>({...line(scoped,{figure_type_id:3},i),opacity:.7,_movieclipPart:0,_movieclipOwner:{opacity:.8,scale:1,effects:[effect('glow','outer',{radius:1})],domainBounds:{x:0,y:0,width:80,height:70}}}));
  const softwareObject={unique_id:4,scale:1,_stykVfx:{figure:[effect('glow','software-glow',{radius:.7}),effect('blur','software-blur',{radius:1.1})]}};
  // Movieclip owner/effect records are shared in real evaluated groups.
  const owner=nested[0]._movieclipOwner;for(const item of nested)item._movieclipOwner=owner;
  const cases=[
    {name:'opacity-outline-subpixel',items:paths,width:384,height:256,matrix:[3.21,0,0,3.21,.37,-.61],maxBytes:2*MiB},
    {name:'dense-glow-bloom-blur',items:dense,width:1171,height:1152,matrix:[13.454,0,0,13.454,.31,-.27],maxBytes:96*MiB,pressurePixels:true},
    {name:'nested-opacity-segment-shadow-spatial-filters',items:nested,width:512,height:384,matrix:[4.73,0,0,4.73,.29,.71],maxBytes:16*MiB},
    {name:'missing-webgl-software-cleanup-recovery',items:Array.from({length:9},(_,i)=>line(softwareObject,{figure_type_id:4},i)),width:192,height:128,matrix:[2.17,0,0,2.17,.37,-.61],maxBytes:.5*MiB,disableWebGL:true},
  ],rows=[];
  for(const {name,items,disableWebGL=false,pressurePixels=false,...plan} of cases){
    let full,tiled;
    const getContext=OffscreenCanvas.prototype.getContext,runPixels=VfxCPU.prototype.runPixels,drawImage=OffscreenCanvasRenderingContext2D.prototype.drawImage;
    const executors=new Set(),drawnCanvases=new Set();
    if(disableWebGL){
      releaseVfxGPU();
      OffscreenCanvas.prototype.getContext=function(type,...args){return type==='webgl2'?null:getContext.call(this,type,...args);};
      VfxCPU.prototype.runPixels=function(...args){executors.add(this);return runPixels.apply(this,args);};
      OffscreenCanvasRenderingContext2D.prototype.drawImage=function(source,...args){if(source instanceof OffscreenCanvas)drawnCanvases.add(source);return drawImage.call(this,source,...args);};
    }
    try{
      onProgress({name,phase:'before-full',width:plan.width,height:plan.height});
      full=capturePreviewRaster(await snapshot(items),{...plan,maxBytes:2*1024*MiB,nativePadding:true});
      onProgress({name,phase:'after-full',tileCount:full.tileCount,workMs:full.workMs});
      const expected=read(full.bitmap);
      onProgress({name,phase:'before-tiled',maxBytes:plan.maxBytes});
      const source=await snapshot(items),optimized=planPreviewRaster(source,{...plan,maxBytes:2*1024*MiB});
      let pressureRejected=false,maxBytes=plan.maxBytes;
      if(!full.effects){
        try{const unexpected=capturePreviewRaster(optimized.geometry,{...plan,maxBytes:optimized.workingBytes-1});unexpected.bitmap.close();}
        catch(error){if(error.code!=='preview_raster_budget')throw error;pressureRejected=true;}
      }else{
        maxBytes=Math.min(maxBytes,optimized.workingBytes-1);
        const pressured=planPreviewRaster(optimized.geometry,{...plan,maxBytes});
        if(pressured.tileCount===1)maxBytes=pressured.workingBytes-1;
      }
      tiled=capturePreviewRaster(optimized.geometry,{...plan,maxBytes});
      onProgress({name,phase:'after-tiled',tileCount:tiled.tileCount,workMs:tiled.workMs});
      const difference=compare(expected,read(tiled.bitmap),plan.width,plan.height,tiled.tileWidth,tiled.tileHeight);
      let optimizedFullDifference,nativeCropDifference,nativeVfxSourceDifference,nativeFullDifference;
      nativeFullDifference=compare(expected,nativeFullProbe(items,plan),plan.width,plan.height,plan.width,plan.height);
      if(diagnose&&difference.max){
        onProgress({name,phase:'before-optimized-full'});
        const optimizedFull=capturePreviewRaster(await snapshot(items),{...plan,maxBytes:full.workingBytes-1});
        try{optimizedFullDifference=compare(expected,read(optimizedFull.bitmap),plan.width,plan.height,tiled.tileWidth,tiled.tileHeight);}
        finally{optimizedFull.bitmap.close();}
        onProgress({name,phase:'after-optimized-full'});
        if(name==='opacity-outline-subpixel')nativeCropDifference=nativeCropProbe(items,plan,tiled.tileWidth,tiled.tileHeight);
      }
      if(diagnose&&!full.effects)nativeCropDifference=nativeCropProbe(items,plan,Math.ceil(plan.width/2),Math.ceil(plan.height/2));
      if(diagnose&&name==='dense-glow-bloom-blur')nativeVfxSourceDifference=nativeVfxSourceProbe(items,plan);
      let cleanup;
      if(disableWebGL){
        const recovered=capturePreviewRaster(await snapshot(items),{...plan,maxBytes:2*1024*MiB});
        try{
          const recovery=compare(expected,read(recovered.bitmap),plan.width,plan.height,tiled.tileWidth,tiled.tileHeight);
          cleanup={executors:executors.size,executorsReleased:[...executors].every(executor=>!executor.slots.length&&!executor.canvas&&!executor._screen&&!executor._line&&!executor._deque),canvasesReleased:[...drawnCanvases].every(canvas=>canvas.width===1&&canvas.height===1),recovery};
        }finally{recovered.bitmap.close();}
      }
      // Full captures must match the independent native painter byte for byte.
      // Only the measured dense pressure case changes its Canvas/filter domain:
      // it keeps the native scene-sweep alpha/mean contract plus stricter visible
      // premultiplied limits. Pure paths preserve their domain or reject, and
      // nested/CPU pressure cases retain their independently verified exactness.
      const pressurePass=pressurePixels?difference.alphaMax<=1&&difference.mean<.02&&difference.premultipliedMax<=2&&difference.premultipliedMean<.002&&difference.differingPixelsByMaxAlpha.opaque===0:difference.max===0;
      rows.push({name,difference,optimizedFullDifference,nativeFullDifference,nativeCropDifference,nativeVfxSourceDifference,pressureRejected,cleanup,full:{tileCount:full.tileCount,workingBytes:full.workingBytes},tiled:{tileCount:tiled.tileCount,tileWidth:tiled.tileWidth,tileHeight:tiled.tileHeight,workingBytes:tiled.workingBytes,maxBytes},pass:full.tileCount===1&&(full.effects?tiled.tileCount>1:pressureRejected&&tiled.tileCount===1)&&tiled.workingBytes<=maxBytes&&pressurePass&&nativeFullDifference.max===0&&(!cleanup||cleanup.executorsReleased&&cleanup.canvasesReleased&&cleanup.recovery.max===0)});
    }finally{full?.bitmap.close();tiled?.bitmap.close();if(disableWebGL){OffscreenCanvas.prototype.getContext=getContext;VfxCPU.prototype.runPixels=runPixels;OffscreenCanvasRenderingContext2D.prototype.drawImage=drawImage;}}
  }
  if(strict&&rows.some(row=>!row.pass))throw Object.assign(Error('Native tiled preview pixels differ from full capture.'),{details:rows});
  return rows;
}
