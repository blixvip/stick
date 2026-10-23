import {drawingMetadata} from './drawing-model.mjs';
import {depthSurface} from './surface-raster.mjs';

const paths=new Set(['line','circle','poly','text']);
// Native Canvas diamond brushes create per-call pattern canvases outside the
// raster scratch owners. Keep those active brushes on their existing path;
// shader effect colours do not allocate CanvasPattern sources.
export function hasNativeDiamondPaint(item){return !item.outline&&item.seg?.paint?.type==='diamond'&&(Number(item.obj?.color_override_raw)>>>24)!==255;}

/** The live owner is authoritative. A published tile blob is usable only
 * after its revision catches up with that owner's pixels; selections and
 * pending edits keep using the existing immediate painter. No pixels or
 * encoded blobs are copied, decoded or hashed on the interactive path. */
export function canRefineDrawingItems(items,resources={}){
  for(const item of items){
    if(depthSurface(item)||hasNativeDiamondPaint(item))return false;
    const drawing=drawingMetadata(item.fig);
    if(item.type!=='image'){
      if(!paths.has(item.type)||drawing)return false;
      continue;
    }
    if(drawing?.version!==2)return false;
    const entry=resources.drawing?.(item.fig);
    if(!entry?.store||entry.id!==drawing.celId||entry.revision!==drawing.revision||
      entry.transient||entry.pinned||entry.loading||entry.deferred?.length)return false;
    // DrawingResources owns unpublished edits; DrawingTileProvider entries
    // are immutable published snapshots and have no publication field.
    if(Object.hasOwn(entry,'published')&&(entry.published?.revision!==entry.revision||
      (entry.published.url??null)!==(item.fig.image_assets?.[0]?.styk_tiles??null)))return false;
  }
  return true;
}
