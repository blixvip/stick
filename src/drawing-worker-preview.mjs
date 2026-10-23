import {messageError} from './localized-error.mjs';
import {TILE,tileKey,TileStore} from './drawing-tiles.mjs';
import {levelStore,invalidateLevels} from './drawing-raster.mjs';

// One source cache per preview worker. Interactive preview startup needs only
// tile sampling; PNG codecs and editing operations load on their own paths.
let source=null;
export function drawingWorkerPreview(data){
  const {rect,level}=data;
  if(!rect||![rect.x,rect.y].every(Number.isSafeInteger)||![rect.width,rect.height].every(n=>Number.isInteger(n)&&n>0&&n<=4096)||!Number.isInteger(level)||level<0||level>8)throw messageError(new Error(''), "errors.drawingWorkerPreview.invalidDrawingPreviewBounds", {});
  if(data.reset||!source)source={store:new TileStore()};
  const keep=new Set(data.keep),input=source.store;
  for(const tile of input)if(!keep.has(tileKey(tile.tx,tile.ty))){input.delete(tile.tx,tile.ty);invalidateLevels(source,{x:tile.tx*TILE,y:tile.ty*TILE,width:TILE,height:TILE});}
  for(const tile of data.tiles){input.tiles.set(tileKey(tile.tx,tile.ty),{tx:tile.tx,ty:tile.ty,pixels:new Uint8ClampedArray(tile.pixels)});input._changed();invalidateLevels(source,{x:tile.tx*TILE,y:tile.ty*TILE,width:TILE,height:TILE});}
  const store=levelStore(source,level),canvas=new OffscreenCanvas(rect.width,rect.height),ctx=canvas.getContext('2d',{willReadFrequently:true});
  for(const tile of store)ctx.putImageData(new ImageData(tile.pixels,TILE,TILE),tile.tx*TILE-rect.x,tile.ty*TILE-rect.y);
  return canvas.transferToImageBitmap();
}
