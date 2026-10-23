import {messageError} from './localized-error.mjs';
export const TILE=64;
export const TILE_BYTES=TILE*TILE*4;
export const MIN_TILE=-0x80000000,MAX_TILE=0x7fffffff;
export function assertTileCoordinates(tx,ty){if(!Number.isInteger(tx)||!Number.isInteger(ty)||tx<MIN_TILE||ty<MIN_TILE||tx>MAX_TILE||ty>MAX_TILE)throw messageError(new Error(''), "errors.drawingTiles.drawingCoordinatesExceedTheFileFormatRange", {});}
export const tileKey=(tx,ty)=>`${tx},${ty}`;
export const parseTileKey=key=>key.split(',').map(Number);
let tileVersion=0;

function alphaBounds(pixels){
  let x0=TILE,y0=0,x1=-1,y1=TILE-1;
  const first=(y,left=0,right=TILE-1)=>{for(let x=left;x<=right;x++)if(pixels[(y*TILE+x)*4+3])return x;return -1;};
  const last=(y,left=0,right=TILE-1)=>{for(let x=right;x>=left;x--)if(pixels[(y*TILE+x)*4+3])return x;return -1;};
  // The outside rows establish vertical bounds. Interior rows only need to
  // extend the horizontal bounds; once both edges are occupied we are done.
  for(;y0<TILE;y0++){x0=first(y0);if(x0>=0)break;}
  if(y0===TILE)return null;
  x1=last(y0,x0);
  for(;y1>y0;y1--){const x=first(y1);if(x<0)continue;x0=Math.min(x0,x);x1=Math.max(x1,last(y1,x));break;}
  for(let y=y0+1;y<y1&&(x0>0||x1<TILE-1);y++){
    const left=first(y,0,x0-1);if(left>=0)x0=left;
    const right=last(y,x1+1);if(right>=0)x1=right;
  }
  return{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1};
}
export function tileTransparent(tile){if(tile.alphaBounds===undefined)tile.alphaBounds=alphaBounds(tile.pixels);return !tile.alphaBounds;}

// Keep ownership notifications at the map boundary: decoders and selection
// assembly also insert already-owned tiles directly, preserving PNG caches.
class TileMap extends Map {
  set(key,tile){
    if(tile?.pixels?.byteLength!==TILE_BYTES)throw messageError(new Error(''), "errors.drawingTiles.tilePixelsMustBeOneFullTile", {});
    const old=super.get(key);super.set(key,tile);
    if(old?.pixels!==tile.pixels)this.onPixels?.(old?.pixels,tile.pixels);
    this.onKey?.(key);
    return this;
  }
  delete(key){const old=super.get(key);if(!super.delete(key))return false;this.onPixels?.(old.pixels,null);this.onKey?.(key);return true;}
  clear(){if(this.onPixels)for(const tile of this.values())this.onPixels(tile.pixels,null);this.onKey?.(null);super.clear();}
}
const CHANGE_LOG_KEYS=8192;

/** Sparse unbounded pixel surface. Tiles are shared by reference until a
 * writable() or fork() call marks them frozen, after which mutation copies. */
export class TileStore {
  constructor(tiles){this.tiles=new TileMap(tiles);this.tiles.onKey=key=>this.logChange(key);this._bounds=undefined;this._tileBounds=undefined;}
  /** Bounded log of changed tile keys for one consumer (GPU residency). An
   * overflow or clear() reports that everything must be treated as changed. */
  changes(consumer){
    this._logs??=new Map();let log=this._logs.get(consumer);
    if(!log){log={keys:new Set(),overflow:false};this._logs.set(consumer,log);}
    return log;
  }
  logChange(key){
    if(!this._logs)return;
    for(const log of this._logs.values()){if(log.overflow)continue;if(key===null||log.keys.size>=CHANGE_LOG_KEYS){log.overflow=true;log.keys.clear();}else log.keys.add(key);}
  }
  get(tx,ty){return this.tiles.get(tileKey(tx,ty));}
  has(tx,ty){return this.tiles.has(tileKey(tx,ty));}
  get size(){return this.tiles.size;}
  get bytes(){return this.tiles.size*TILE_BYTES;}
  observePixels(listener){
    this.pixelListeners??=new Set();this.pixelListeners.add(listener);
    this.tiles.onPixels??=(before,after)=>{for(const notify of this.pixelListeners)notify(before,after);};
    return()=>{this.pixelListeners.delete(listener);if(!this.pixelListeners.size)this.tiles.onPixels=null;};
  }
  keys(){return this.tiles.keys();}
  values(){return this.tiles.values();}
  [Symbol.iterator](){return this.tiles.values();}
  _changed(){this._bounds=undefined;this._tileBounds=undefined;this.revision=(this.revision??0)+1;}
  /** Keep cached bounds current when `old` (or nothing) is replaced by
   * `tile` (or nothing), so painting a large drawing never rescans every tile.
   * Coverage only grows on insert. Alpha bounds merge the new tile's alpha
   * rect, and only rescan lazily when the replaced tile touched their edge. */
  _placed(old,tile){
    const t=this._tileBounds;
    if(!old&&tile&&t!==undefined){const x=tile.tx*TILE,y=tile.ty*TILE;if(t===null)this._tileBounds={x,y,width:TILE,height:TILE};else{const x0=Math.min(t.x,x),y0=Math.min(t.y,y);this._tileBounds={x:x0,y:y0,width:Math.max(t.x+t.width,x+TILE)-x0,height:Math.max(t.y+t.height,y+TILE)-y0};}}
    else if(old&&!tile)this._tileBounds=undefined;
    const b=this._bounds;if(b===undefined)return;
    if(old){old.alphaBounds??=alphaBounds(old.pixels);const a=old.alphaBounds;
      if(a&&b){const x=old.tx*TILE+a.x,y=old.ty*TILE+a.y;if(x<=b.x||y<=b.y||x+a.width>=b.x+b.width||y+a.height>=b.y+b.height){this._bounds=undefined;return;}}}
    if(!tile)return;
    tile.alphaBounds??=alphaBounds(tile.pixels);const a=tile.alphaBounds;if(!a)return;
    const x=tile.tx*TILE+a.x,y=tile.ty*TILE+a.y;
    if(b===null){this._bounds={x,y,width:a.width,height:a.height};return;}
    const x0=Math.min(b.x,x),y0=Math.min(b.y,y);this._bounds={x:x0,y:y0,width:Math.max(b.x+b.width,x+a.width)-x0,height:Math.max(b.y+b.height,y+a.height)-y0};
  }
  writable(tx,ty,{create=true}={}) {
    assertTileCoordinates(tx,ty);
    const key=tileKey(tx,ty);let tile=this.tiles.get(key);
    if(!tile){if(!create)return null;tile={tx,ty,pixels:new Uint8ClampedArray(TILE_BYTES),frozen:false,version:++tileVersion};this.tiles.set(key,tile);this._changed();return tile;}
    if(tile.frozen){tile={tx,ty,pixels:tile.pixels.slice(),frozen:false};this.tiles.set(key,tile);}
    tile.version=++tileVersion;tile.png=undefined;tile.alphaBounds=undefined;this._changed();this.logChange(key);return tile;
  }
  set(tx,ty,pixels) {
    assertTileCoordinates(tx,ty);
    const key=tileKey(tx,ty);
    if(pixels==null){this.delete(tx,ty);return;}
    let full;
    if(pixels.byteLength===4){full=new Uint8ClampedArray(TILE_BYTES);const word=new Uint32Array(Uint8Array.from(pixels).buffer)[0];new Uint32Array(full.buffer).fill(word);}
    else{full=new Uint8ClampedArray(pixels);if(full.byteLength!==TILE_BYTES)throw messageError(new Error(''), "errors.drawingTiles.tilePixelsMustBe4UniformBytesOr", {});}
    this.adopt(tx,ty,full);
  }
  /** Take ownership of a full tile. Callers must stop mutating the buffer;
   * subsequent writes use writable() so forks remain copy-on-write. */
  adopt(tx,ty,pixels,alphaBounds){
    assertTileCoordinates(tx,ty);
    if(!(pixels instanceof Uint8ClampedArray)||pixels.byteLength!==TILE_BYTES)throw messageError(new Error(''), "errors.drawingTiles.ownedTilePixelsMustBeOneFullTile", {});
    const key=tileKey(tx,ty),old=this.tiles.get(key),tile={tx,ty,pixels,alphaBounds,frozen:false,version:++tileVersion};this.tiles.set(key,tile);this._placed(old,tile);this.revision=(this.revision??0)+1;
  }
  delete(tx,ty){const key=tileKey(tx,ty),old=this.tiles.get(key);if(this.tiles.delete(key)){this._placed(old,null);this.revision=(this.revision??0)+1;}}
  fork(){for(const tile of this.tiles.values())tile.frozen=true;return new TileStore(this.tiles);}
  freeze(){for(const tile of this.tiles.values())tile.frozen=true;}
  get bounds() {
    if(this._bounds!==undefined)return this._bounds;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const tile of this.tiles.values()){
      if(tileTransparent(tile))continue;
      const x=tile.tx*TILE+tile.alphaBounds.x,y=tile.ty*TILE+tile.alphaBounds.y;
      x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+tile.alphaBounds.width);y1=Math.max(y1,y+tile.alphaBounds.height);
    }
    return this._bounds=Number.isFinite(x0)?{x:x0,y:y0,width:x1-x0,height:y1-y0}:null;
  }
  /** Tile-aligned coverage: the rect exactly containing every present tile.
   * Unlike `bounds` it is unaffected by alpha and never crops a tile. */
  get tileBounds() {
    if(this._tileBounds!==undefined)return this._tileBounds;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const tile of this.tiles.values()){x0=Math.min(x0,tile.tx);y0=Math.min(y0,tile.ty);x1=Math.max(x1,tile.tx);y1=Math.max(y1,tile.ty);}
    return this._tileBounds=Number.isFinite(x0)?{x:x0*TILE,y:y0*TILE,width:(x1-x0+1)*TILE,height:(y1-y0+1)*TILE}:null;
  }
  readRect(x,y,width,height) {
    const out=new Uint8ClampedArray(width*height*4);
    for(const [tx,ty] of TileStore.tilesInRect(x,y,width,height)){
      const tile=this.get(tx,ty);if(!tile)continue;
      const ox=tx*TILE,oy=ty*TILE,sx=Math.max(0,x-ox),ex=Math.min(TILE,x+width-ox);
      if(sx>=ex)continue;
      for(let py=Math.max(0,y-oy);py<Math.min(TILE,y+height-oy);py++)out.set(tile.pixels.subarray((py*TILE+sx)*4,(py*TILE+ex)*4),((py+oy-y)*width+sx+ox-x)*4);
    }
    return out;
  }
  writeRect(x,y,width,height,pixels) {
    for(const [tx,ty] of TileStore.tilesInRect(x,y,width,height)){
      const tile=this.writable(tx,ty),ox=tx*TILE,oy=ty*TILE,sx=Math.max(0,x-ox),ex=Math.min(TILE,x+width-ox);
      if(sx>=ex)continue;
      for(let py=Math.max(0,y-oy);py<Math.min(TILE,y+height-oy);py++)tile.pixels.set(pixels.subarray(((py+oy-y)*width+sx+ox-x)*4,((py+oy-y)*width+ex+ox-x)*4),(py*TILE+sx)*4);
    }
  }
  pixel(x,y) {
    const tile=this.get(Math.floor(x/TILE),Math.floor(y/TILE));
    if(!tile)return[0,0,0,0];
    const i=((y-tile.ty*TILE)*TILE+(x-tile.tx*TILE))*4;return[tile.pixels[i],tile.pixels[i+1],tile.pixels[i+2],tile.pixels[i+3]];
  }
  prune(){const removed=[];for(const [key,tile] of this.tiles)if(tileTransparent(tile)){this.tiles.delete(key);removed.push(key);}if(removed.length)this._changed();return removed;}
  static tilesInRect(x,y,width,height) {
    if(width<=0||height<=0)return[];
    const out=[],x1=Math.floor((x+width-1)/TILE),y1=Math.floor((y+height-1)/TILE);
    for(let ty=Math.floor(y/TILE);ty<=y1;ty++)for(let tx=Math.floor(x/TILE);tx<=x1;tx++)out.push([tx,ty]);
    return out;
  }
}
