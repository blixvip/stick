import {sameData,sameRecord} from './structural-equality.mjs';
const wireOnly=new Set(['record_offset','record_end']),skipWire=key=>wireOnly.has(key);
function equal(a,b,top=false){
  if(!top||Object.is(a,b)||!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a))return sameData(a,b);
  return !Array.isArray(b)&&sameRecord(a,b,skipWire);
}
/** Optional worker-only cache for immutable native snapshots. With linear
 * interpolation and exactly equal endpoint objects, the computed tween is
 * constant for 0<t<1. Store that computed result, never substitute the raw key:
 * native parent-angle reconstruction must retain its original float rounding. */
export class PlaybackTweenCache {
  constructor({maxEntries=1024}={}){this.maxEntries=maxEntries;this.clear();}
  lookup(object,next,figure){
    let entry=this.entries.get(object);
    if(entry?.next===next&&entry.figure===figure)return entry.constant?entry:null;
    entry={next,figure,constant:equal(object,next,true),value:null};
    this.entries.delete(object);this.entries.set(object,entry);
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    return entry.constant?entry:null;
  }
  clear(){this.entries=new Map();}
}
