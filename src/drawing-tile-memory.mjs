/** Exact resident pixel ownership for one drawing resource owner. Stores are
 * enrolled once; subsequent tile changes update buffer reference counts in
 * constant time. Multiple cels can share a store or individual pixel arrays.
 * Cache/history/worker memory remains in its existing, separate budgets. */
export class DrawingTileMemory {
  constructor(){this.stores=new Map();this.references=new Map();this.bytes=0;}
  retain(pixels){if(!pixels)return;const count=this.references.get(pixels)??0;if(!count)this.bytes+=pixels.byteLength;this.references.set(pixels,count+1);}
  release(pixels){if(!pixels)return;const count=this.references.get(pixels);if(count>1)this.references.set(pixels,count-1);else if(count){this.references.delete(pixels);this.bytes-=pixels.byteLength;}}
  sync(surfaces){
    const active=new Set();for(const entry of surfaces)if(entry.store)active.add(entry.store);
    for(const [store,unsubscribe] of this.stores)if(!active.has(store)){
      unsubscribe();for(const tile of store)this.release(tile.pixels);this.stores.delete(store);
    }
    for(const store of active)if(!this.stores.has(store)){
      for(const tile of store)this.retain(tile.pixels);
      this.stores.set(store,store.observePixels((before,after)=>{this.release(before);this.retain(after);}));
    }
    return this;
  }
  dispose(){for(const unsubscribe of this.stores.values())unsubscribe();this.stores.clear();this.references.clear();this.bytes=0;}
}
