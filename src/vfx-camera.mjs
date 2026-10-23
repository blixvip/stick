import {messageError} from './localized-error.mjs';
import {drawExportScene} from './export-frame-core.mjs';
import {effectiveCamera,sceneBackgroundColor} from './pivot/background.mjs';
import {layerVisible,layerIdForUid} from './layers.mjs';
import {releaseGeometryResources} from './pivot/geometry.mjs';
import {applySceneVfx} from './vfx-canvas.mjs';
import {activeVfx,vfxStack,vfxPadding} from './vfx.mjs';
import {fitsVfxSurface,vfxSurfaceError,VFX_MAX_DIMENSION} from './vfx-surface.mjs';
import {vfxSurfaceDimension} from './vfx-gpu.mjs';
import {sceneVfxPlan,checkSceneVfxPlan} from './vfx-scene.mjs';
import {frameImageDrawables,backgroundImageAssets} from './scene-preparation.mjs';
import {assetURL} from './image-resources.mjs';
import {drawingRasterInputs,publishedDrawingRasterInputs,sameDrawingRaster} from './drawing-render-dependencies.mjs';
import {canRefineDrawingItems} from './renderer-preview-drawings.mjs';
import {cameraSceneDrawables,cameraRefinementScene} from './renderer-camera-scene.mjs';

/** Viewport placement of the processed camera image, in device pixels. */
export function cameraSceneAffine({report,frame,view={},cameraEnabled},dpr=1){
 const camera=effectiveCamera(report,frame)??{},scale=camera.scale??1,angle=camera.angle_rad??0,cx=report.canvas_width/2,cy=report.canvas_height/2,zoom=(view.scale??1)*dpr;
 if(cameraEnabled!==false)return [zoom,0,0,zoom,(view.x??0)*dpr,(view.y??0)*dpr];
 const c=Math.cos(angle)*scale,s=Math.sin(angle)*scale,x=cx+(camera.x??0)-c*cx+s*cy,y=cy+(camera.y??0)-s*cx-c*cy;
 return [c*zoom,s*zoom,-s*zoom,c*zoom,(view.x??0)*dpr+x*zoom,(view.y??0)*dpr+y*zoom];
}
/** Whether the camera image replaces every pixel of a width x height canvas.
 * `render` clears its projected artboard before drawing, so artwork painted
 * underneath a covering image is never presented. */
export function cameraSceneCovers(options,dpr,width,height){
 const [a,b,c,d,e,f]=cameraSceneAffine(options,dpr),det=a*d-b*c,{canvas_width,canvas_height}=options.report;
 if(!Number.isFinite(det)||Math.abs(det)<1e-12||!(width>0&&height>0))return false;
 // Keep one device pixel inside the projected edge, away from its antialiasing.
 const margin=1/Math.sqrt(Math.abs(det));
 for(const [px,py] of [[0,0],[width,0],[width,height],[0,height]]){
  const x=(d*(px-e)-c*(py-f))/det,y=(a*(py-f)-b*(px-e))/det;
  if(!(x>=margin&&y>=margin&&x<=canvas_width-margin&&y<=canvas_height-margin))return false;
 }
 return true;
}

/** Process the camera and its sampling neighborhood before projecting the
 * cropped result into the viewport. Panning never changes effect coordinates. */
export class CameraVfx {
 /** `paint` supplies the scene from a renderer; with `texturePaint` it returns
  * a GPU texture and this owner allocates no Canvas pixels for it. */
 constructor({paint,texturePaint=false,getPaintRevision,getSource,releaseSource,retainSource,refine}={}){Object.assign(this,{paint,texturePaint:Boolean(paint&&texturePaint),getPaintRevision,getSource,releaseSource,retainSource,refine});this.sourceOwned=true;this.canvas=new OffscreenCanvas(1,1);this.context=this.canvas.getContext('2d');}
 matchesSource(source){
  const current=this.targetSource;
  return Boolean(current&&!this.viewChanging&&!this.liveEditing&&!this.playing&&this.frame===source.frame&&
    current.signature===source.signature&&current.report===source.report&&current.frame===source.frame&&current.geometry===source.geometry&&
    current.preparedFrame===source.preparedFrame&&current.resources===source.resources&&sameDrawingRaster(current.drawingInputs,source.drawingInputs)&&
    (!source.drawingItems||canRefineDrawingItems(source.drawingItems,source.resources)));
 }
 #prepare(options,dpr,resources){
  if(!this.context||this.context.isContextLost?.())throw Object.assign(messageError(new Error(''), "errors.vfxCamera.theCameraEffectsCanvasIsUnavailable", {}),{telemetryCode:'device_lost',telemetryStage:'prepare'});
  const {report,frame,view={},geometry,preparedFrame,hiddenUids,dragTranslations}=options;
  const camera=effectiveCamera(report,frame)??{},scale=camera.scale??1;
  // The software path re-rasterizes the camera image on every change; halve
  // its cap while the scene is live so drags and playback stay responsive.
  const padding=vfxPadding(vfxStack(frame),1,Math.max(report.canvas_width,report.canvas_height));
  // Missing GPU effects use the existing bounded software surface contract.
  const effectEdge=(vfxSurfaceDimension()||VFX_MAX_DIMENSION)-128;
  const world=options.cameraEnabled===false,zoom=(view.scale??1)*dpr,requested=Math.max(.01,zoom*(world?scale:1)),
    cap=this.paint||!(options.liveEditing||options.playing)?2048:1024,
    resolution=Math.min(requested,cap/Math.max(report.canvas_width,report.canvas_height),effectEdge/(report.canvas_width+2*padding),effectEdge/(report.canvas_height+2*padding));
  let width=Math.max(1,Math.ceil(report.canvas_width*resolution)),height=Math.max(1,Math.ceil(report.canvas_height*resolution));
  const objectUids=this.paint?undefined:[...(geometry?.objects?.values()??geometry?.orderedObjects??[])].map(g=>g.obj.unique_id);
  const hidden=preparedFrame?preparedFrame.uids.filter(uid=>hiddenUids?.has(uid)):this.paint?
    geometry?.orderedObjects?.filter(g=>hiddenUids?.has(g.obj.unique_id)).map(g=>g.obj.unique_id)??[]:objectUids.filter(uid=>hiddenUids?.has(uid));
  const imageItems=preparedFrame?[]:frameImageDrawables(geometry);
  const visibleImages=preparedFrame?imageItems:imageItems.filter(item=>!hiddenUids?.has(item.obj.unique_id)&&layerVisible(report,item.obj.unique_id));
  const liveDrawingInputs=preparedFrame?null:drawingRasterInputs(visibleImages,resources);
  const publishedImages=!this.paint&&Boolean(this.refine)&&visibleImages.length>0&&canRefineDrawingItems(visibleImages,resources);
  const drawingInputs=publishedImages?publishedDrawingRasterInputs(liveDrawingInputs):liveDrawingInputs;
  const retainedMedia=!this.paint&&(!visibleImages.length||publishedImages)&&!backgroundImageAssets(report,frame).some(asset=>resources.url?.(asset)||assetURL(asset));
  const layerBindings=this.paint?undefined:(preparedFrame?.uids??objectUids).map(uid=>[uid,layerIdForUid(report,uid)]);
  const backgroundIds=retainedMedia?new Set([Number(frame.background_id),...(frame.background_mix?[Number(frame.background_id_b)]:[])]):null;
  const backgrounds=retainedMedia&&sceneBackgroundColor(report,frame)===undefined?report.backgrounds?.filter(bg=>backgroundIds.has(Number(bg.background_id))).map(bg=>({
    kind:bg.kind,color:bg.color,color_a:bg.color_a,color_b:bg.color_b,x1:bg.x1,y1:bg.y1,x2:bg.x2,y2:bg.y2,paint:bg.paint})):undefined;
  // The complete native camera image already covers every projected view.
  // Keep its completed density during navigation. Published drawing pixels
  // have an independent authority; other image decodes remain immediate.
  const contentSignature=this.paint?undefined:JSON.stringify([options.resourceRevision,options.artworkRevision,report.canvas_width,report.canvas_height,
    report._styk?.layers?.order.map(id=>[id,report._styk.layers.byId[id].visible,report._styk.layers.byId[id].parallax]),
    layerBindings,report._styk?.layers?.fixed,camera,world,vfxStack(frame),frame.background_id,frame.background_id_b,frame.background_mix,frame._stykBackgroundColor,backgrounds,
    hidden,dragTranslations instanceof Map?[...dragTranslations]:dragTranslations]);
  const entry=!this.paint?this.getSource?.():null,borrowed=entry&&!entry.destroyed&&(entry.bitmap??entry.canvas),record=borrowed?entry.cameraSource:this.sourceOwned?this:null;
  const sourceValid=Boolean(record&&record.signature!==undefined&&(!borrowed||borrowed.width===record.width&&borrowed.height===record.height));
  const sameSource=sourceValid&&record.geometry===geometry&&record.preparedFrame===preparedFrame&&record.frame===frame&&this.frame===frame&&record.resources===resources&&
    (!borrowed||Boolean(record.drawingItems)===Boolean(publishedImages));
  const samePublication=publishedImages&&sameSource&&sameDrawingRaster(publishedDrawingRasterInputs(record.drawingInputs),drawingInputs);
  const unchanged=sameSource&&sameDrawingRaster(record.drawingInputs,record.drawingInputs?.some(input=>input.published)?drawingInputs:liveDrawingInputs)&&(!publishedImages||samePublication);
  const target=this.paint?null:{report,frame,geometry,preparedFrame,resources,drawingInputs,contentSignature,
    signature:JSON.stringify([contentSignature,width,height]),width,height,plan:null,...(publishedImages?{drawingItems:visibleImages}:{})};
  if(!this.paint){this.targetSource=target;this.viewChanging=Boolean(options.viewChanging);this.liveEditing=Boolean(options.liveEditing);this.playing=Boolean(options.playing);}
  let retained=false;
  if(!this.paint&&options.viewChanging&&!options.playing&&!options.liveEditing&&(unchanged||samePublication)&&this.report===report&&
    record.contentSignature===contentSignature&&retainedMedia){
    if(entry)entry.deferDensity=true;
    retained=true;
    width=borrowed?record.width:this.canvas.width;height=borrowed?record.height:this.canvas.height;
  }else if(!this.paint&&!options.viewChanging&&!options.playing&&!options.liveEditing&&entry&&(entry.deferDensity||samePublication&&!unchanged)&&(unchanged||samePublication)&&record.report===report&&
    record.contentSignature===contentSignature&&retainedMedia&&(record.width!==width||record.height!==height||!unchanged)&&this.refine){
    // A derived drawing preview completing under unchanged published tiles
    // cannot obsolete the displayed scene. Hold it, as navigation does, while
    // the worker captures the published pixels instead of repainting here.
    entry.deferDensity=true;
    const items=cameraSceneDrawables(options),scene=cameraRefinementScene(options,items,resources);
    if(scene&&this.refine({entry,target,scene,items,valid:()=>this.matchesSource(target)})){
      retained=true;
      width=record.width;height=record.height;
    }
  }
  // The GPU camera image is repainted whenever its density changes, and below
  // its size cap that is every step of a zoom. Hold the painted density while
  // an unchanged scene is navigated; the settled paint restores it.
  if(this.paint&&options.viewChanging&&!options.playing&&!options.liveEditing&&unchanged&&this.report===report&&this.paintedWidth){
    width=this.paintedWidth;height=this.paintedHeight;
  }
  const plan=this.paint?checkSceneVfxPlan(sceneVfxPlan(frame,width,height,undefined,width/report.canvas_width),vfxSurfaceDimension()):null;
  // A capped GPU camera can keep its size while the viewport's compatibility
  // artwork sharpens. Sample that published density only after navigation;
  // prepared packets and ordinary vector-only sources need no extra key.
  const paintRevision=this.paint&&!preparedFrame?(options.viewChanging?this.paintRevision:this.getPaintRevision?.()):undefined;
  let signature=this.paint?JSON.stringify([options.resourceRevision,report._styk?.layers?.order.map(id=>report._styk.layers.byId[id].parallax),camera,width,height,plan?.pad,frame.background_id,frame.background_id_b,frame.background_mix,frame._stykBackgroundColor,hidden,dragTranslations instanceof Map?[...dragTranslations]:dragTranslations]):JSON.stringify([contentSignature,width,height]);
  if(paintRevision!==undefined)signature+='|'+paintRevision;
  const stale=!retained&&(!unchanged||record.signature!==signature||(!this.paint&&(record.report!==report||record.contentSignature!==contentSignature)));
  let surface=borrowed||this.canvas;
  if(stale){
   if(!this.paint)this.releaseSource?.({repaint:true});
   this.sourceOwned=true;
   const sourceWidth=plan?.width??width,sourceHeight=plan?.height??height;
   if(this.texturePaint)this.sourceTexture=this.paint(null,options,sourceWidth,sourceHeight,plan);
   else{
    if(this.canvas.width!==sourceWidth)this.canvas.width=sourceWidth;if(this.canvas.height!==sourceHeight)this.canvas.height=sourceHeight;
    if(this.paint)this.paint(this.context,options,sourceWidth,sourceHeight,plan);
    else {const drawables=cameraSceneDrawables(options);
    drawExportScene(this.context,report,frame,{...geometry,drawables},resources);}
   }
   this.geometry=geometry;this.preparedFrame=preparedFrame;this.frame=frame;this.signature=signature;this.resources=resources;this.drawingInputs=liveDrawingInputs;
   if(this.paint){this.paintRevision=paintRevision;this.report=report;this.paintedWidth=width;this.paintedHeight=height;}
   if(!this.paint){this.report=report;this.contentSignature=contentSignature;
    if(this.retainSource){
      // A native cold source may precede an asynchronous drawing preview.
      // Promote publication authority only with the worker's complete bitmap.
      const retained=this.retainSource({...target,drawingInputs:liveDrawingInputs,signature,canvas:this.canvas});this.sourceOwned=!retained;
    }
   }
   surface=this.canvas;
  }
  const affine=cameraSceneAffine(options,dpr);
  return {report,frame,width,height,affine,stale,plan,surface};
 }
 render(context,options,dpr,resources){
  const prepared=this.#prepare(options,dpr,resources),{report}=prepared;
  if(prepared.stale&&this.paint)applySceneVfx(this.context,prepared.frame,{scale:prepared.width/report.canvas_width,origin:prepared.plan.viewport,outputSize:{width:prepared.width,height:prepared.height},padding:0});
  context.save();try {context.setTransform(...prepared.affine);
  context.beginPath();context.rect(0,0,report.canvas_width,report.canvas_height);context.clip();context.clearRect(0,0,report.canvas_width,report.canvas_height);context.drawImage(prepared.surface,prepared.plan?.pad??0,prepared.plan?.pad??0,prepared.width,prepared.height,0,0,report.canvas_width,report.canvas_height);}finally{context.restore();}
 }
 // WebGPU path: the filtered camera image stays a texture, projected by the
 // viewport composite instead of being drawn through a 2D canvas.
 renderTexture(options,dpr,resources,exec){
  const prepared=this.#prepare(options,dpr,resources),{report}=prepared;
  if(prepared.stale){
   const stack=this.paint?activeVfx(vfxStack(prepared.frame)):[],pad=prepared.plan?.pad??0;
   const width=prepared.width+2*pad,height=prepared.height+2*pad;
   if(!fitsVfxSurface(width,height,exec.device.limits.maxTextureDimension2D))throw vfxSurfaceError();
   if(this.filteredWidth!==width||this.filteredHeight!==height){this.filtered?.destroy();this.filteredWidth=width;this.filteredHeight=height;this.filtered=exec.device.createTexture({label:'VFX filtered camera',size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});}
   const source=this.texturePaint?{texture:this.sourceTexture,width,height}:this.canvas;
   const out=stack.length?exec.run(source,stack,{scale:prepared.width/report.canvas_width,origin:{x:-pad,y:-pad},outputSize:{width:prepared.width,height:prepared.height},texture:true}):null;
   const encoder=exec.device.createCommandEncoder();
   if(out)encoder.copyTextureToTexture({texture:out.texture},{texture:this.filtered},[width,height]);
   else if(!this.texturePaint)exec.device.queue.copyExternalImageToTexture({source:this.canvas},{texture:this.filtered,premultipliedAlpha:true},[prepared.width,prepared.height]);
   exec.device.queue.submit([encoder.finish()]);
   this.filterPad=pad;
  }
  return {texture:this.filtered,pad:this.filterPad??0,surface:{width:prepared.width,height:prepared.height},affine:prepared.affine,report};
 }
 destroy(){if(!this.paint)this.releaseSource?.();releaseGeometryResources(this.context);this.filtered?.destroy();this.sourceTexture=null;this.canvas.width=this.canvas.height=1;this.geometry=this.preparedFrame=this.frame=this.resources=this.drawingInputs=this.report=null;this.contentSignature=this.signature=this.targetSource=undefined;}
}
