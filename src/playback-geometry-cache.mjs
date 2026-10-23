import {messageError} from './localized-error.mjs';
import {vfxRenderFrame} from './vfx-clips.mjs';
import {buildGeometry, buildGeometryAsync} from './pivot/geometry.mjs';
import {sameData,sameRecord} from './structural-equality.mjs';

const wireOnly=new Set(['record_offset','record_end','object_slot','join']);
// Native tween evaluation explicitly clears this optional override. An absent
// field and an undefined override both use the figure's normal geometry.
const skipWire=(key,owner)=>wireOnly.has(key)||(key==='runtime_segments'&&owner[key]===undefined);
const skipOpacity=key=>key==='field28'||key==='transparency';
const skipWireAndOpacity=(key,owner)=>skipOpacity(key)||skipWire(key,owner);
function equal(a,b,ignoreWire=false,ignoreOpacity=false){
  if(!ignoreWire&&!ignoreOpacity)return sameData(a,b);
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a))return sameData(a,b);
  return sameRecord(a,b,ignoreWire&&ignoreOpacity?skipWireAndOpacity:ignoreWire?skipWire:skipOpacity);
}

const joinTarget = key => key === 'target_object_slot' || key === 'target_unique_id';
const parentUid = (object, frame) => object.join ? frame.objects[Number(object.join.target_object_slot)]?.unique_id : null;
function sameJoin(a, b, aParent, bParent) {
  if (Boolean(a) !== Boolean(b) || aParent !== bParent) return false;
  if (!a) return true;
  return sameRecord(a, b, joinTarget);
}
/** Rebind slot metadata without recalculating points or tessellation. The old
 * object-local artwork remains valid and can be adopted by the renderer. */
function rebind(g, object, slot, appearance = false) {
  if (!appearance && g.slot === slot && g.obj.join?.target_object_slot === object.join?.target_object_slot) return g;
  const records = new Map(), children = new Map();
  const item = value => {
    if (!records.has(value)) {
      let owner = object;
      if (value.obj !== g.obj) {
        owner = children.get(value.obj);
        if (!owner) { owner = {...value.obj, object_slot: slot}; children.set(value.obj, owner); }
      }
      records.set(value, {...value, obj: owner, slot, ...(appearance ? {opacity:1-Number(object.field28??object.transparency??0)/255} : {})});
    }
    return records.get(value);
  };
  const result = {...g, obj: object, slot, segments: g.segments.map(item), polys: g.polys.map(item), drawables: g.drawables?.map(item)};
  if (appearance) {
    const source=g.renderSource||g;
    Object.defineProperty(result, 'opacitySource', {value:source.opacitySource || source});
  }
  else Object.defineProperty(result, 'renderSource', {value: g.renderSource || g});
  return result;
}
const drawableCount = g => g.drawables?.length ?? g.segments.length + g.polys.length;

/** One scene plus a bounded alternate pose per persistent figure. Native keys
 * and exact tween poses can differ through floating-point reconstruction; keep
 * both representations rather than rounding coordinates or rebuilding all keys. */
export class RetainedGeometryCache {
  constructor({maxAlternateDrawables=250000,maxAlternates=1024}={}){
    Object.assign(this,{maxAlternateDrawables,maxAlternates});this.clear();
  }
  retainRevision(revision){this.revision=revision;}
  /** A document patch replaces figure definitions in place; retained drawables
   * would keep referencing the superseded figure objects and rasterize stale
   * artwork. Rebuild slots bound to a replaced figure until a scene publishes —
   * by then no reachable record can still hold an outdated reference. */
  markFiguresDirty(ids){
    if(!this.dirtyFigures)this.dirtyFigures=new Set();
    for(const id of ids)this.dirtyFigures.add(String(id));
    for(const [uid,entry] of this.alternates)
      if(this.dirtyFigures.has(String(entry.g.obj.figure_type_id))){this.alternates.delete(uid);this.alternateDrawables-=drawableCount(entry.g);}
    this.dirtyVersion++;
  }
  adopt(report,frame,revision,geometry){
    frame=vfxRenderFrame(report,frame);
    if(this.report!==report||this.revision!==revision||this.version!==report.version)this.clear();
    Object.assign(this,{report,frame,revision,geometry,version:report.version,reusedObjects:0});
  }
  get(report,frame,revision){
    frame=vfxRenderFrame(report,frame);
    const incremental=this.plan(report,frame,revision);
    return this.publish(report,frame,revision,buildGeometry(report,frame,incremental),incremental);
  }
  async getAsync(report,frame,revision,options={}){
    frame=vfxRenderFrame(report,frame);
    const baseline=this.geometry, baselineRevision=this.revision, baselineReport=this.report, baselineDirty=this.dirtyVersion;
    const incremental=this.plan(report,frame,revision);
    const geometry=await buildGeometryAsync(report,frame,incremental,options);
    if(this.geometry!==baseline||this.revision!==baselineRevision||this.report!==baselineReport||this.dirtyVersion!==baselineDirty||options.checkCurrent?.()===false)
      throw messageError(new DOMException('', 'AbortError'), "errors.playbackGeometryCache.geometryPreparationWasSuperseded", {});
    return this.publish(report,frame,revision,geometry,incremental);
  }
  plan(report,frame,revision){
    if(this.report!==report||this.version!==report.version||this.revision!==revision||!this.geometry||this.geometry.warnings.length)return null;
    const dirtySlots=new Set(),children=new Map(),objects=new Map(),ready=[],seen=new Set();
    const prior=new Map([...this.geometry.objects.values()].filter(Boolean).map(g=>[g.obj.unique_id,{g,parent:parentUid(g.obj,this.frame)}]));
    for(let slot=0;slot<frame.objects.length;slot++){
      const object=frame.objects[slot];if(!object)continue;
      if(seen.has(object.unique_id))return null;seen.add(object.unique_id);
      const parent=object.join?.target_object_slot;
      if(parent===undefined)ready.push(slot);
      else {const list=children.get(Number(parent))??[];list.push(slot);children.set(Number(parent),list);}
    }
    for(let i=0;i<ready.length;i++){
      const slot=ready[i],object=frame.objects[slot],parent=parentUid(object,frame);
      const root=object.join?objects.get(Number(object.join.target_object_slot))?.joints.get(Number(object.join.target_handle_id??0)):null;
      let matched;
      if(!this.dirtyFigures?.has(String(object.figure_type_id)))
      for(const entry of [prior.get(object.unique_id),this.alternates.get(object.unique_id)]){
        if(!entry||!sameJoin(object.join,entry.g.obj.join,parent,entry.parent))continue;
        const appearance = !equal(object,entry.g.obj,true);
        // Opacity does not affect native joint evaluation. Rebind drawing
        // metadata while retaining exact points; expanded clips own nested
        // opacity and therefore keep the general evaluator.
        if(appearance && (!equal(object,entry.g.obj,true,true) || entry.g.drawables.some(item=>item.obj!==entry.g.obj||item._movieclipOwner)))continue;
        if(object.join&&(!root||!Object.is(root.x,entry.g.root.x)||!Object.is(root.y,entry.g.root.y)))continue;
        matched=rebind(entry.g,object,slot,appearance);break;
      }
      if(matched)objects.set(slot,matched);else dirtySlots.add(slot);
      for(const child of children.get(slot)??[])ready.push(child);
    }
    // Let the native builder report invalid/cyclic attachments exactly as before.
    if(ready.length!==seen.size)return null;
    // The native builder needs the object map and invalidation token only.
    // Spreading the scene invokes its lazy drawables getter, flattening every
    // primitive even though retained playback consumes ordered object groups.
    return {previous:{objects,token:this.geometry.token},dirtySlots};
  }
  publish(report,frame,revision,geometry,incremental){
    if(!incremental){this.alternates.clear();this.alternateDrawables=0;}
    // Alternate geometry avoids rebuilding the pose, but its GPU instance still
    // changed relative to the last displayed scene. Notify incremental renderers
    // even when the native builder reused that alternate object successfully.
    if(incremental)for(const [slot,g] of geometry.objects)if(g!==this.geometry.objects.get(slot))geometry.changedSlots.add(slot);
    this.reusedObjects=incremental?[...geometry.objects].filter(([slot,g])=>g===incremental.previous.objects.get(slot)).length:0;
    const current=incremental?new Map([...geometry.objects.values()].filter(Boolean).map(g=>[g.obj.unique_id,g])):null;
    if(incremental)for(const old of this.geometry.objects.values()){
      if(!old||old===current.get(old.obj.unique_id))continue;
      const uid=old.obj.unique_id,prior=this.alternates.get(uid);if(prior){this.alternates.delete(uid);this.alternateDrawables-=drawableCount(prior.g);}
      if(drawableCount(old)>this.maxAlternateDrawables)continue;
      if(this.dirtyFigures?.has(String(old.obj.figure_type_id)))continue;
      this.alternates.set(uid,{g:old,parent:parentUid(old.obj,this.frame)});this.alternateDrawables+=drawableCount(old);
      while(this.alternateDrawables>this.maxAlternateDrawables||this.alternates.size>this.maxAlternates){
        const [key,value]=this.alternates.entries().next().value;this.alternates.delete(key);this.alternateDrawables-=drawableCount(value.g);
      }
    }
    this.report=report;this.version=report.version;this.revision=revision;this.frame=frame;this.geometry=geometry;
    this.dirtyFigures=null;this.dirtyVersion++;
    return geometry;
  }
  clear(){this.report=null;this.frame=null;this.geometry=null;this.revision=null;this.reusedObjects=0;this.alternates=new Map();this.alternateDrawables=0;this.dirtyFigures=null;this.dirtyVersion=0;}
}
export {RetainedGeometryCache as PlaybackGeometryCache};
