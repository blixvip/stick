import {messageError} from './localized-error.mjs';
import {DrawingStroke} from './drawing-pixels.mjs';
import {TileStore,TILE,tileKey} from './drawing-tiles.mjs';

/** In-process stroke engine shared by the stroke worker and Node tests. Each
 * stroke rasterizes precomputed dab shapes (and its provisional tail) into a private TileStore seeded once per
 * tile by the main thread; `before` is therefore the state the stroke first
 * saw, which is the undo record's before side. The main thread computes dab
 * shapes and their bounds, so a dab reaching a tile that
 * was never seeded is a protocol error: the stroke fails loudly instead of
 * painting over a blank guess (which would erase the real tile on commit).
 * Batches are processed strictly in seq order. */
export class StrokeEngine {
  constructor(){this.strokes=new Map();}
  begin(id,settings){
    this.strokes.delete(id);
    const store=new TileStore(),seeded=new Set();
    const requireTile=(tx,ty)=>{if(!seeded.has(tileKey(tx,ty)))throw messageError(new Error(''), "errors.drawingStrokeEngine.aBrushDabReachedDrawingPixelsThatWere", {});};
    this.strokes.set(id,{store,seeded,brush:new DrawingStroke(store,settings,{requireTile,mask:settings?.mask}),seq:0});
  }
  dabs(id,seq,dabs,tiles,tail){
    const s=this.strokes.get(id);if(!s||seq<=s.seq)return null;
    s.seq=seq;
    if(s.store.bytes+(tiles?.length??0)*TILE*TILE*4>s.brush.workingBytes/2)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
    for(const t of tiles??[]){const key=tileKey(t.tx,t.ty);if(s.seeded.has(key))continue;s.seeded.add(key);if(t.pixels)s.store.set(t.tx,t.ty,new Uint8ClampedArray(t.pixels));}
    s.brush.paint(dabs??[],tail??undefined);
    const changed=[];let dirty=null;
    for(const tile of s.brush.dirtyTiles){
      changed.push({tx:tile.tx,ty:tile.ty,pixels:tile.pixels.slice().buffer});
      const x=tile.tx*TILE,y=tile.ty*TILE;
      dirty=dirty?{x:Math.min(dirty.x,x),y:Math.min(dirty.y,y),width:Math.max(dirty.x+dirty.width,x+TILE)-Math.min(dirty.x,x),height:Math.max(dirty.y+dirty.height,y+TILE)-Math.min(dirty.y,y)}:{x,y,width:TILE,height:TILE};
    }
    s.brush.dirtyTiles.clear();
    return {tiles:changed,dirty};
  }
  end(id){
    const s=this.strokes.get(id);if(!s)return null;
    this.strokes.delete(id);
    return s.brush.finish();
  }
  cancel(id){this.strokes.delete(id);}
}
