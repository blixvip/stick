import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,MIN_TILE,MAX_TILE,TileStore,tileKey,assertTileCoordinates} from './drawing-tiles.mjs';
import {drawingPNGBytes,drawingPNGDataURL,decodeDrawingPNGBytes,encodeDrawingPNG} from './drawing-png.mjs';
import {inverseMatrix,TRANSFORM_BYTES} from './drawing-transform.mjs';

const PREFIX='data:image/png;base64,';
export const PIXEL_CLIPBOARD_MAX_TILES=32768;
export const PIXEL_CLIPBOARD_MAX_CHARACTERS=128*1024*1024;
const MAX_TILE_CHARACTERS=PREFIX.length+4*Math.ceil(65536/3),SCRATCH_BYTES=128*1024;
const invalid=()=>{throw messageError(new Error(''), "errors.drawingClipboard.invalidDrawingPixelClipboard", {});};
const memory=()=>{throw messageError(new Error(''), "errors.drawingClipboard.thePixelClipboardExceedsTheDrawingWorkingMemory", {});};

/** Plain records and small PNG strings use the existing bounded clipboard wire
 * protocol. Version two preserves source coordinates and the full affine pose;
 * no dense image or second resampling is needed to copy a transformed lasso. */
export function validatePixelClipboard(data){
  if(!data||![1,2,4].includes(data.pixelsPerUnit))invalid();
  if(!data.world||![data.world.x,data.world.y].every(Number.isFinite))throw messageError(new Error(''), "errors.drawingClipboard.invalidDrawingPixelOrigin", {});
  if(data.matrix)inverseMatrix(data.matrix);
  if(data.version===2){
    if(!data.matrix||!Array.isArray(data.tiles)||data.tiles.length>PIXEL_CLIPBOARD_MAX_TILES)invalid();
    const b=data.bounds;
    if(b===null){if(data.tiles.length)invalid();}
    else if(!b||![b.x,b.y,b.width,b.height,b.x+b.width,b.y+b.height].every(Number.isSafeInteger)||b.width<1||b.height<1||b.x<MIN_TILE*TILE||b.y<MIN_TILE*TILE||b.x+b.width>(MAX_TILE+1)*TILE||b.y+b.height>(MAX_TILE+1)*TILE||!data.tiles.length)invalid();
    let characters=0;const seen=new Set();
    for(const tile of data.tiles){
      if(!tile)invalid();assertTileCoordinates(tile.tx,tile.ty);const key=tileKey(tile.tx,tile.ty);if(seen.has(key))invalid();seen.add(key);
      if(typeof tile.png!=='string'||!tile.png.startsWith(PREFIX)||tile.png.length>MAX_TILE_CHARACTERS)invalid();
      characters+=tile.png.length;if(characters>PIXEL_CLIPBOARD_MAX_CHARACTERS)invalid();
      if(tile.tx*TILE>=b.x+b.width||(tile.tx+1)*TILE<=b.x||tile.ty*TILE>=b.y+b.height||(tile.ty+1)*TILE<=b.y)invalid();
    }
    return {pixelBytes:data.tiles.length*TILE_BYTES,encodedBytes:characters*2};
  }
  if(data.version!==undefined&&data.version!==1)invalid();
  if(![data.width,data.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||data.width*data.height>16*1024*1024||typeof data.dataUrl!=='string'||!data.dataUrl.startsWith(PREFIX)||data.dataUrl.length>96*1024*1024)invalid();
  return {pixelBytes:data.width*data.height*4,encodedBytes:data.dataUrl.length*2};
}

/** Worker inputs are either exact RGBA or an existing trusted tile PNG. Reuse
 * published tiles without re-encoding; partial selections encode only once. */
export async function encodeClipboardTiles(tiles,{maxBytes=TRANSFORM_BYTES}={}){
  if(!Array.isArray(tiles)||tiles.length>PIXEL_CLIPBOARD_MAX_TILES||!Number.isFinite(maxBytes)||maxBytes<0)invalid();
  const inputBytes=tiles.reduce((n,t)=>n+(t.png?.byteLength??t.pixels?.byteLength??0),0),out=[],seen=new Set();let characters=0;
  if(inputBytes+SCRATCH_BYTES>maxBytes)memory();
  for(const t of tiles){
    assertTileCoordinates(t.tx,t.ty);const key=tileKey(t.tx,t.ty);if(seen.has(key))invalid();seen.add(key);
    if(t.png&&t.png.byteLength>65536||!t.png&&t.pixels?.byteLength!==TILE_BYTES)invalid();
    const png=t.png?drawingPNGDataURL(new Uint8Array(t.png)):await encodeDrawingPNG(new Uint8ClampedArray(t.pixels),TILE,TILE);
    characters+=png.length;
    if(characters>PIXEL_CLIPBOARD_MAX_CHARACTERS)invalid();
    // Allow the reply and its structured clone to coexist during transfer.
    if(inputBytes+characters*4+SCRATCH_BYTES>maxBytes)memory();
    out.push({tx:t.tx,ty:t.ty,png});
  }
  return out;
}

/** Validate the index before allocating pixels. A bounded decode queue overlaps
 * small inflations without starting thousands of streams or changing tile order.
 * Old dense PNG packets remain readable with their original limits. */
export async function decodePixelClipboard(data,{maxBytes=TRANSFORM_BYTES}={}){
  const {pixelBytes,encodedBytes}=validatePixelClipboard(data),store=new TileStore();
  const concurrency=data.version===2?Math.min(8,data.tiles.length):1;
  if(!Number.isFinite(maxBytes)||pixelBytes*(data.version===2?1:3)+encodedBytes+SCRATCH_BYTES*Math.max(1,concurrency)>maxBytes)memory();
  if(data.version===2){
    const decoded=new Array(data.tiles.length);let next=0,failure;
    await Promise.all(Array.from({length:concurrency},async()=>{
      while(!failure&&next<data.tiles.length){
        const i=next++,t=data.tiles[i];
        try{const image=await decodeDrawingPNGBytes(drawingPNGBytes(t.png),{width:TILE,height:TILE});decoded[i]={tx:t.tx,ty:t.ty,pixels:image.pixels,frozen:false};}
        catch(error){failure??=error;}
      }
    }));
    // Settle every in-flight stream before the caller releases its reservation.
    if(failure)throw failure;
    for(const tile of decoded)store.tiles.set(tileKey(tile.tx,tile.ty),tile);
  }else{
    const image=await decodeDrawingPNGBytes(drawingPNGBytes(data.dataUrl),{width:data.width,height:data.height});
    store.writeRect(0,0,image.width,image.height,image.pixels);store.prune();
  }
  return {store,encodedBytes};
}
