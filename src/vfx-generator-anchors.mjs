/** Where generator targets were on earlier frames.
 *
 * Trails and bursts keep the position their target had when each particle was
 * born. This cache evaluates only the target's joined assembly on those ticks,
 * shares one evaluated frame per tick between targets, and discards a
 * document's entries when its evaluation generation changes, so it never
 * serves poses from before an edit. Movieclip documents keep their own entries.
 *
 * Interactive rendering can give each frame a time budget: samples that do not
 * fit return PENDING and the caller refines on later frames. Workers and export
 * use no budget, so their results are always exact. One instance per realm;
 * memory is bounded by entry count across all documents. */
import {evaluatedFrame,timeline,buildGeometry,evaluationGeneration} from './pivot/geometry.mjs';
import {ikComponents} from './ik-joined.mjs';
import {anchorFromGeometry} from './vfx-generators.mjs';

export const PENDING=Symbol('pending anchor');
const EMPTY_SCENE={objects:new Map()};
/** Evaluated frames kept per document: a lifetime window of births. */
const FRAME_CACHE=48;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

export class GeneratorAnchors{
 constructor({maxEntries=4096}={}){this.max=maxEntries;this.stores=new WeakMap();this.size=0;this.documents=0;this.order=new Map();this.deadline=Infinity;this.pending=0;this.frame=0;this.stats={samples:0,hits:0,ms:0};}
 reset(){this.stores=new WeakMap();this.order.clear();this.size=0;}
 /** Limit uncached sampling for one frame; Infinity samples everything. */
 begin(budgetMs=Infinity){this.deadline=budgetMs===Infinity?Infinity:performance.now()+budgetMs;this.pending=0;this.frame++;}
 get entries(){return {size:this.size};}
 #store(report){
  const generation=evaluationGeneration(report),prior=this.stores.get(report);
  if(prior?.generation===generation)return prior;
  if(prior){this.size-=prior.entries.size;for(const key of prior.entries.keys())this.order.delete(prior.prefix+key);}
  const store={generation,entries:new Map(),frames:new Map(),rows:null,prefix:prior?.prefix??`${++this.documents}:`};
  this.stores.set(report,store);return store;
 }
 /** Anchor data (point, outline, bounds) for a target on an earlier tick, null
  * when the target is absent, or PENDING when this frame's budget is spent. */
 sample(report,target,tick,{includeAttached=false}={}){
  const store=this.#store(report);tick=Math.round(tick);
  const key=`${target.kind}:${target.uid}:${target.handleId??''}:${target.figureTypeId??''}:${tick}:${includeAttached?1:0}`;
  const hit=store.entries.get(key);
  // Recency moves at most once per frame, keeping repeated hits cheap.
  if(hit){this.stats.hits++;if(hit.frame!==this.frame){hit.frame=this.frame;const id=store.prefix+key;this.order.delete(id);this.order.set(id,store);}return hit.value;}
  if(performance.now()>this.deadline){this.pending++;return PENDING;}
  const started=performance.now(),value=this.#evaluate(report,store,target,tick,includeAttached);
  this.stats.ms+=performance.now()-started;this.stats.samples++;
  store.entries.set(key,{value,frame:this.frame});this.order.set(store.prefix+key,store);this.size++;
  // Evict least recently used entries across every document.
  while(this.size>this.max){const [id,owner]=this.order.entries().next().value;this.order.delete(id);if(owner.entries.delete(id.slice(owner.prefix.length)))this.size--;}
  return value;
 }
 #evaluate(report,store,target,tick,includeAttached){
  // Every target sampled on this tick shares one evaluated frame.
  let frame=store.frames.get(tick);
  if(frame===undefined){
   const rows=store.rows??=timeline(report);if(!rows.length)return null;
   let low=0,high=rows.length-1;while(low<high){const mid=(low+high+1)>>>1;if(rows[mid].start<=tick)low=mid;else high=mid-1;}
   const row=rows[low],t=row?.count>0?clamp((tick-row.start)/row.count,0,1):0;
   frame=evaluatedFrame(report,low,t,tick)??null;store.frames.set(tick,frame);
   if(store.frames.size>FRAME_CACHE)store.frames.delete(store.frames.keys().next().value);
  }
  if(!frame?.objects)return null;
  const slot=frame.objects.findIndex(o=>o?.unique_id===target.uid);if(slot<0)return null;
  // Only the connected assembly: other slots stay holes the builder skips.
  let component=[slot];for(const group of ikComponents(frame))if(group.includes(slot)){component=group;break;}
  const objects=new Array(frame.objects.length);for(const i of component)objects[i]=frame.objects[i];
  const {_vfxTimelineTick,_vfxTimelineScene,...plain}=frame;
  const partial={...plain,objects};
  const scene=buildGeometry(report,partial,{previous:EMPTY_SCENE,dirtySlots:new Set(component)});
  return anchorFromGeometry(scene,partial,target,{body:true,includeAttached});
 }
}
