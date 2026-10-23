import {drawingMetadata} from './drawing-model.mjs';
import {decodeTileBlob,tileStoreFromList} from './drawing-tile-codec.mjs';
import {presenterScratch,levelStore} from './drawing-raster.mjs';

/** Worker/main-thread tile decoder for published v2 drawing cels. Decoded
 * stores are immutable snapshots keyed by celId+revision, kept in a bounded
 * LRU so playback, export, thumbnail and preview paths all read the same
 * authoritative tiles through `paintDrawingTiles`. */
export class DrawingTileProvider {
  constructor({budgetBytes=96*1024*1024,hardBytes=Math.max(budgetBytes*4,64*1024*1024),softwareScratch=false}={}) {
    Object.assign(this,{budgetBytes,hardBytes,softwareScratch,entries:new Map(),clock:0});
  }
  /** Sync presenter lookup: {id,store,stamp,dirty:null,scratch,level} or null.
   * A superseded entry is never authoritative — bounds and paint callers must
   * fall back to the figure's published metadata until prepare() re-decodes. */
  presenter(figure) {
    const d=drawingMetadata(figure),e=this.entries.get(d?.celId);
    return e?.store&&e.revision===d?.revision?e:null;
  }
  /** Decode styk_tiles blobs into tile stores. v1 cels keep the PNG path. */
  async prepare(figures) {
    // Collect every cel this draw needs before evicting: the budget is a
    // retention target and must never remove what the current draw reads.
    const needed=new Set();
    for(const figure of figures??[]){const d=drawingMetadata(figure);if(d?.version===2)needed.add(d.celId);}
    for(const figure of figures??[]){
      const d=drawingMetadata(figure);
      if(!d||d.version!==2)continue;
      let e=this.entries.get(d.celId);
      if(e&&e.revision===d.revision){this.entries.delete(d.celId);this.entries.set(d.celId,e);continue;}
      const url=figure.image_assets?.[0]?.styk_tiles;
      const protectedBytes=[...this.entries].reduce((n,[id,old])=>n+(needed.has(id)&&id!==d.celId?old.store.bytes:0),0);
      const store=tileStoreFromList(url?await decodeTileBlob(url,{maxBytes:Math.max(0,this.hardBytes-protectedBytes)}):[]);
      if(e)this.drop(e);
      e={id:d.celId,revision:d.revision,store,bytes:store.bytes,stamp:1,dirty:null,levels:null,levelsUsed:0,owner:this,softwareScratch:this.softwareScratch};
      e.scratch=(rect,options)=>presenterScratch(e,rect,options);
      e.level=(k,rect)=>{e.levelsUsed=++this.clock;return levelStore(e,k,rect);};
      this.entries.set(d.celId,e);
    }
    for(const [id,old] of this.entries){if(this.bytes<=this.budgetBytes)break;if(needed.has(id))continue;this.drop(old);this.entries.delete(id);}
  }
  get bytes(){let bytes=0;for(const e of this.entries.values()){bytes+=e.store.bytes;for(const l of e.levels??[])bytes+=l?.bytes??0;for(const s of e._scratches?.values()??[])bytes+=(s.canvas?.width??0)*(s.canvas?.height??0)*4;}return bytes;}
  drop(e){for(const s of e._scratches?.values()??[])if(s.canvas)s.canvas.width=s.canvas.height=1;e._scratches=null;e.levels=null;e.levelKnown=null;}
  levelsReserved(entry){
    let bytes=0;for(const e of this.entries.values())for(const level of e.levels??[])bytes+=level?.bytes??0;
    const limit=Math.min(32*1024*1024,this.budgetBytes/3);
    for(const e of [...this.entries.values()].sort((a,b)=>a.levelsUsed-b.levelsUsed)){if(bytes<=limit)break;if(e===entry)continue;for(const level of e.levels??[])bytes-=level?.bytes??0;e.levels=null;e.levelKnown=null;}
    if(bytes>limit){entry.levels=null;entry.levelKnown=null;}
  }
  scratchReserved(entry,requested=0,keep=null){
    const candidates=[];let bytes=0;for(const e of this.entries.values())for(const [key,s] of e._scratches??[]){bytes+=(s.canvas?.width??0)*(s.canvas?.height??0)*4;if(s!==keep&&s.canvas)candidates.push({e,key,s});}
    const limit=Math.min(32*1024*1024,this.budgetBytes/3);
    for(const {e,key,s} of candidates){if(bytes+requested<=limit)break;bytes-=s.canvas.width*s.canvas.height*4;s.canvas.width=s.canvas.height=1;e._scratches.delete(key);}
    return bytes+requested<=limit;
  }
  dispose(){for(const e of this.entries.values())this.drop(e);this.entries.clear();}
}
