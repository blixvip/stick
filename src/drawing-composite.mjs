import {messageError} from './localized-error.mjs';
import {drawGeometry,releaseGeometryResources} from './pivot/geometry.mjs';
import {PlaybackResources} from './playback-resources.mjs';
import {exportDrawGroups,exportGroupOutside} from './export-frame-core.mjs';
import {FILL_SOURCE_MAX_PIXELS} from './drawing-fill.mjs';
import {restoreDrawingComposite} from './drawing-composite-transport.mjs';

/** Full-quality, transparent capture in drawing pixel coordinates. Keep the
 * original canvas domain: splitting native paths across canvases changes
 * antialiased coverage and can change zero-tolerance fill boundaries. The
 * owning worker is terminated after capture, including its device caches. */
export async function captureDrawingComposite(snapshot,{bounds,matrix,maxBytes,snapshotBytes=0,baseURL,token}={}){
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isSafeInteger)||bounds.width<1||bounds.height<1||bounds.width*bounds.height>FILL_SOURCE_MAX_PIXELS||matrix?.length!==6||!matrix.every(Number.isFinite))throw messageError(new Error(''), "errors.drawingComposite.invalidDrawingCompositeBounds", {});
  const geometry=restoreDrawingComposite(snapshot),sourceBytes=bounds.width*bounds.height*4;
  // Canvas + readback coexist. Each nested opacity group and outline can own
  // one more full-size isolation surface. Decode allowances are additional.
  let isolation=0;
  for(const item of geometry.drawables){
    let depth=item.opacity<1?1:0;
    if(item.fig?.segment_decode?.global_style?.u30>0)depth++;
    if(item._movieclipOwner?.opacity<1)depth++;
    for(let inner=item._movieclipInner;inner;inner=inner.inner)if(inner.owner?.opacity<1)depth++;
    isolation=Math.max(isolation,depth);
  }
  const available=maxBytes-sourceBytes*(2+isolation)-snapshotBytes;
  if(!Number.isFinite(available)||available<0)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
  // Allow for eviction overlap and derived drawing mips/scratch in addition
  // to required decoded originals. Renderer effects keep their own limits.
  const budget=Math.floor(available/4),resources=new PlaybackResources({baseURL,token,maxBytes:budget,hardMaxBytes:budget,absoluteMaxBytes:budget});
  resources.drawingProvider.budgetBytes=budget;resources.drawingProvider.hardBytes=budget;
  const groups=exportDrawGroups(geometry,resources),canvas=new OffscreenCanvas(bounds.width,bounds.height),ctx=canvas.getContext('2d');
  try{
    if(!ctx)throw messageError(new Error(''), "errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable", {});
    const plan={width:bounds.width,height:bounds.height,matrix:[...matrix.slice(0,4),matrix[4]-bounds.x,matrix[5]-bounds.y]},strokeState={width:1};
    ctx.setTransform(...plan.matrix);
    for(const {items,bounds:groupBounds} of groups){
      const skipPaint=exportGroupOutside(groupBounds,plan);
      // Fill compares exact source colours. Export's density-based image
      // downsampling changes nearest-neighbour sprite pixels when minified.
      if(!skipPaint)await resources.preload(items);
      drawGeometry(ctx,{drawables:items,strokeState,skipPaint},resources);
    }
    if(ctx.isContextLost?.())throw messageError(new Error(''), "errors.drawingComposite.theDrawingCompositeCanvasBecameUnavailable", {});
    return ctx.getImageData(0,0,bounds.width,bounds.height).data;
  }finally{if(ctx)releaseGeometryResources(ctx);canvas.width=canvas.height=1;resources.dispose();}
}
