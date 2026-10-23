import {hasDrawableVfx} from './vfx-canvas.mjs';
import {drawingMetadata} from './drawing-model.mjs';
import {rasterBounds,gestureProxyResolution,gestureStandIn,GESTURE_STAND_IN_PIXELS} from './raster-view.mjs';

/** Ordinary paths and verified media have bounded coverage. Effect domains,
 * nested clips and unverified media retain their complete painter path. */
export function canvasCoverageBounds(items, bounds) {
  let pad=0;
  for(const item of items){
    if(hasDrawableVfx(item)||item._movieclipOwner||item.type==='mesh'||item.poly?._stykSurface?.depthTest)return null;
    if(item.type==='image'&&!drawingMetadata(item.fig)&&(!(item.asset?.display_width>0)||!(item.asset?.display_height>0)))return null;
    if(item.type==='text'&&!item.asset?.bounds)return null;
    if(!['line','circle','poly','image','text'].includes(item.type))return null;
    if(item.seg?.segment_kind==='squareLine'){
      const bits=item.fig?.segment_decode?.global_style?.u28;
      const outline=bits?Math.abs(new Float32Array(new Uint32Array([bits]).buffer)[0]*Number(item.obj?.scale??1)):0;
      pad=Math.max(pad,Math.abs(item.thickness||0)+(Number.isFinite(outline)?2*outline:0));
    }
  }
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite))return null;
  return {x:bounds.x-pad,y:bounds.y-pad,width:bounds.width+2*pad,height:bounds.height+2*pad};
}

export function canvasBoundsOutside(bounds, visible, guard=0) {
  return Boolean(bounds&&visible&&(bounds.x+bounds.width<visible.x-guard||bounds.y+bounds.height<visible.y-guard||
    bounds.x>visible.x+visible.width+guard||bounds.y>visible.y+visible.height+guard));
}

/** Moving a Canvas path or glyph into a smaller source changes native edge
 * coverage even on the original integer grid. Only verified image artwork
 * opts into an ordinary crop; conservative bounds still support path culling. */
export function canvasArtworkCropSafe(items) {
  return Boolean(items.length)&&items.every(item=>item.type==='image'&&
    (drawingMetadata(item.fig)||(item.asset?.display_width>0&&item.asset?.display_height>0)));
}

/** Ordinary verified image crops save a substantial allocation. Required
 * high-density/oversized crops retain the established bounded painter policy. */
export function canvasArtworkPlan(bounds, visible, resolution, {safe=false,padding=0,maxDimension=4096}={}) {
  const required=resolution>8||bounds.width*resolution>maxDimension||bounds.height*resolution>maxDimension;
  if(!required&&(!safe||!visible||bounds.width*bounds.height*resolution*resolution<256*1024))return undefined;
  const plan=rasterBounds(bounds,visible,resolution,maxDimension,128,padding);
  if(required||!plan)return plan;
  return plan.cropped&&plan.pixelWidth*plan.pixelHeight<=plan.fullPixels*.6?plan:undefined;
}

/** canvasArtworkPlan, or when that raster exceeds `maxPixels`, a crop to the
 * view at the highest density that fits. A reduced raster crops even where
 * ordinary detail would paint the whole artwork, which would need a far lower
 * density. Returns the plan (undefined for the whole artwork, null when
 * nothing is visible) and the density to paint it at. */
export function canvasArtworkPlanWithin(bounds, visible, resolution, {maxPixels=Infinity,...options}={}) {
  const maxDimension=options.maxDimension??4096;
  const area=(plan,density)=>plan?plan.pixelWidth*plan.pixelHeight:
    Math.ceil(bounds.width*Math.min(density,maxDimension/bounds.width,maxDimension/bounds.height))*Math.ceil(bounds.height*Math.min(density,maxDimension/bounds.width,maxDimension/bounds.height));
  let density=resolution,plan=canvasArtworkPlan(bounds,visible,density,options);
  if(plan===null||area(plan,density)<=maxPixels)return {plan,density};
  // Crops grow in coverage steps, so the area can jump: always reduce enough
  // to make progress past a step.
  for(let attempt=0;attempt<8;attempt++){
    // Dimension limits can already hold the crop below the requested density.
    const effective=plan?plan.pixelScale:Math.min(density,maxDimension/bounds.width,maxDimension/bounds.height);
    density=effective*Math.min(.95,Math.sqrt(maxPixels/area(plan,density))*.98);
    plan=visible?rasterBounds(bounds,visible,density,maxDimension,128,options.padding??0):undefined;
    if(plan===null||area(plan,density)<=maxPixels)break;
  }
  return {plan,density};
}

/** The stand-in Canvas paints for artwork a navigating view's held raster no
 * longer covers. Zooming out shows the whole artwork within `maxPixels`, as
 * does a density whose settled raster is the whole artwork: a full-density
 * crop would stay in its place with different native edges. Otherwise a pan
 * gets gestureStandIn's crop. */
export function canvasGestureStandIn(bounds, visible, resolution, zoomingOut, maxPixels, padding=0, maxDimension=4096) {
  const required=resolution>8||bounds.width*resolution>maxDimension||bounds.height*resolution>maxDimension;
  if(zoomingOut||!required)return {plan:undefined,density:gestureProxyResolution(resolution,bounds,maxDimension,maxPixels)};
  return gestureStandIn(bounds,visible,resolution,{maxDimension,maxPixels:Math.min(GESTURE_STAND_IN_PIXELS,maxPixels),padding});
}

/** Device-pixel union, clipped to an admitted viewport plus its pan margin.
 * Exact editing keeps the destination origin: translating cached image draws
 * changes Canvas edge sampling even under a whole-pixel offset. Null coverage
 * requests the complete surface instead of guessing its edges. */
export function canvasLayerBounds(bounds, matrix, width, height, margin=0, preserveOrigin=false) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const b of bounds){
    if(!b)return {x:-margin,y:-margin,width:width+2*margin,height:height+2*margin};
    for(const [x,y] of [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]){
      const px=matrix[0]*x+matrix[2]*y+matrix[4],py=matrix[1]*x+matrix[3]*y+matrix[5];
      x0=Math.min(x0,px);y0=Math.min(y0,py);x1=Math.max(x1,px);y1=Math.max(y1,py);
    }
  }
  if(!Number.isFinite(x0+y0+x1+y1))return {x:0,y:0,width:1,height:1};
  x0=Math.max(-margin,Math.floor(x0)-2);y0=Math.max(-margin,Math.floor(y0)-2);
  x1=Math.min(width+margin,Math.ceil(x1)+2);y1=Math.min(height+margin,Math.ceil(y1)+2);
  if(x1<=x0||y1<=y0)return {x:0,y:0,width:1,height:1};
  if(preserveOrigin){x0=0;y0=0;}
  return {x:x0,y:y0,width:x1-x0,height:y1-y0};
}
