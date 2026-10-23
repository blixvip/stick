import {messageError} from './localized-error.mjs';
import {TILE_BYTES,assertTileCoordinates} from './drawing-tiles.mjs';

export const HISTORY_CHUNK_BYTES=1024*1024;
const MAGIC=0x31485944,HEADER=12,RECORD=16;
const size=side=>side?.byteLength??0;
const validLength=n=>n===0||n===4||n===TILE_BYTES;
export const historyPixelBytes=tiles=>tiles.reduce((n,t)=>n+size(t.before)+size(t.after),0);

/** Bounded binary chunks keep exact null/uniform/full tile sides. Offsets and
 * coordinates are validated before allocating decoded pixel buffers. */
export function encodeHistoryChunk(tiles){
  const length=HEADER+tiles.reduce((n,t)=>n+RECORD+size(t.before)+size(t.after),0);
  if(length>HISTORY_CHUNK_BYTES||!tiles.length)throw messageError(new Error(''), "errors.drawingHistoryCodec.invalidDrawingHistoryChunkSize", {});
  const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);
  view.setUint32(0,MAGIC,true);view.setUint32(4,tiles.length,true);view.setUint32(8,length,true);
  let offset=HEADER;
  for(const tile of tiles){
    assertTileCoordinates(tile.tx,tile.ty);
    const before=size(tile.before),after=size(tile.after);
    if(!validLength(before)||!validLength(after))throw messageError(new Error(''), "errors.drawingHistoryCodec.invalidDrawingHistoryTile", {});
    view.setInt32(offset,tile.tx,true);view.setInt32(offset+4,tile.ty,true);view.setUint32(offset+8,before,true);view.setUint32(offset+12,after,true);offset+=RECORD;
    if(before){bytes.set(tile.before,offset);offset+=before;}if(after){bytes.set(tile.after,offset);offset+=after;}
  }
  return bytes;
}
export function decodeHistoryChunk(input){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<HEADER||bytes.length>HISTORY_CHUNK_BYTES||view.getUint32(0,true)!==MAGIC||view.getUint32(8,true)!==bytes.length)throw messageError(new Error(''), "errors.drawingHistoryCodec.drawingUndoDataIsDamaged", {});
  const count=view.getUint32(4,true);if(!count||count>(bytes.length-HEADER)/RECORD)throw messageError(new Error(''), "errors.drawingHistoryCodec.drawingUndoDataIsDamaged", {});
  const records=[];let offset=HEADER;
  for(let n=0;n<count;n++){
    if(offset+RECORD>bytes.length)throw messageError(new Error(''), "errors.drawingHistoryCodec.drawingUndoDataIsTruncated", {});
    const tx=view.getInt32(offset,true),ty=view.getInt32(offset+4,true),before=view.getUint32(offset+8,true),after=view.getUint32(offset+12,true);offset+=RECORD;
    if(!validLength(before)||!validLength(after)||offset+before+after>bytes.length)throw messageError(new Error(''), "errors.drawingHistoryCodec.drawingUndoDataIsDamaged", {});
    records.push({tx,ty,before,after,offset});offset+=before+after;
  }
  if(offset!==bytes.length)throw messageError(new Error(''), "errors.drawingHistoryCodec.drawingUndoDataHasTrailingBytes", {});
  return records.map(r=>({tx:r.tx,ty:r.ty,before:r.before?new Uint8ClampedArray(bytes.slice(r.offset,r.offset+r.before).buffer):null,after:r.after?new Uint8ClampedArray(bytes.slice(r.offset+r.before,r.offset+r.before+r.after).buffer):null}));
}
export function* historyChunks(tiles){
  let chunk=[],bytes=HEADER;
  for(const tile of tiles){const length=RECORD+size(tile.before)+size(tile.after);if(bytes+length>HISTORY_CHUNK_BYTES&&chunk.length){yield chunk;chunk=[];bytes=HEADER;}chunk.push(tile);bytes+=length;}
  if(chunk.length)yield chunk;
}
