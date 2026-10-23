import {vfxRenderFrame} from './vfx-clips.mjs';
import {activeVfx,vfxStack,setVfxStack} from './vfx.mjs';
import {layerVisible} from './layers.mjs';
import {objectBounds} from './renderer-geometry.mjs';

const views=new WeakMap(),plans=new WeakMap();
const MAX_DEPTH=16;
const connectedStack=owner=>owner?._vfxConnectedEffects??vfxStack(owner);
function descendants(frame,slot,children){
 const members=new Set([slot]),queue=[slot];
 for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])??[])if(!members.has(child)){members.add(child);queue.push(child);}
 return members;
}
function childIndex(frame){const children=new Map();frame.objects.forEach((o,slot)=>{if(o.join){const p=o.join.target_object_slot,list=children.get(p)??[];list.push(slot);children.set(p,list);}});return children;}
function scopeDepths(frame,children,forceUid){
 const depths=new Map(),queue=frame.objects.flatMap((o,slot)=>!o.join?[slot]:[]);
 for(let i=0;i<queue.length;i++){const slot=queue[i],o=frame.objects[slot];if(depths.has(slot))continue;
  depths.set(slot,(depths.get(o.join?.target_object_slot)??0)+Number(o._stykVfxScope===1||o.unique_id===forceUid));for(const child of children.get(slot)??[])queue.push(child);}
 return depths;
}
export function connectedVfxConflict(frame,uid){
 const root=frame.objects.findIndex(o=>o.unique_id===uid);if(root<0)return 'The effect owner is missing.';
 const children=childIndex(frame),members=descendants(frame,root,children),depths=scopeDepths(frame,children,uid);
 for(const slot of members)if(depths.get(slot)>MAX_DEPTH)return `Connected VFX support at most ${MAX_DEPTH} nested groups.`;
 return null;
}

/** Render-only containers reuse the movieclip isolation contract. Native geometry,
 * identities, joins and cached editable poses are never replaced or mutated. */
export function connectedVfxGeometry(geometry,frame,report,hiddenUids){
 if(!geometry||!frame?.objects)return geometry;
 const source=geometry.connectedVfxSource??geometry;
 frame=vfxRenderFrame(report,frame);
 let plan=plans.get(source);
 if(!plan||plan.frame!==frame){
  const roots=frame.objects.flatMap((_,slot)=>{const o=source.objects.get(slot)?.obj;return o?._stykVfxScope===1&&activeVfx(connectedStack(o)).length?[slot]:[];});
  const children=roots.length?childIndex(frame):null,depths=roots.length?scopeDepths(frame,children):null;
  const members=new Map(roots.map(slot=>[slot,depths.get(slot)>MAX_DEPTH?new Set([slot]):descendants(frame,slot,children)]));
  roots.sort((a,b)=>members.get(a).size-members.get(b).size);
  plan={frame,roots,members,depths};plans.set(source,plan);
 }
 const {roots,members,depths}=plan;
 if(!roots.length)return source;
 const visibility=frame.objects.map(o=>!hiddenUids?.has(o.unique_id)&&layerVisible(report,o.unique_id));
 const key=visibility.map(Number).join('');let cached=views.get(source);
 if(cached?.key===key&&cached.frame===frame)return cached.geometry;
 let ordered=source.orderedObjects;const objects=new Map(source.objects),warnings=[...(source.warnings??[])],grouped=new Set(),assemblies=new Map();
 for(const slot of roots){
  const object=frame.objects[slot],own=objects.get(slot),set=members.get(slot);
  if(!own||!visibility[slot])continue;
  const conflict=depths.get(slot)>MAX_DEPTH?`Connected VFX support at most ${MAX_DEPTH} nested groups.`:null;
  if(conflict){warnings.push(`Connected VFX (${object.unique_id}): ${conflict}`);continue;}
  const parts=ordered.filter(g=>set.has(g.slot)&&visibility[g.slot]);
  if(!parts.length)continue;
  // Split only at foreign painter entries. Each run keeps a unique native slot
  // for retained textures, transforms and worker packets; no synthetic document
  // objects or duplicated effect stacks are needed. All runs share one domain.
  const effects=connectedStack(own.obj),ids=new Set(effects.map(e=>e.id)),owner={opacity:1,effects,scale:Math.abs(object.scale??1)},items=[],localObjects=new Map();
  const next=[];let run=[],runCount=0;
  const flush=()=>{
   if(!run.length)return;
   const anchor=run.find(part=>part.slot===slot)??run[0],runItems=[];
   for(const part of run)for(let item of part.drawables){
   if(part.slot===slot){
    if(item._movieclipOwner){item={...item,_movieclipOwner:{...item._movieclipOwner,effects:item._movieclipOwner.effects?.filter(e=>!ids.has(e.id))}};}
    else{let obj=localObjects.get(item.obj);if(!obj){obj={...item.obj};setVfxStack(obj,{kind:'figure'},vfxStack(obj).filter(e=>!ids.has(e.id)));localObjects.set(item.obj,obj);}item={...item,obj};}
   }
   runItems.push({...item,slot:anchor.slot,_movieclipOwner:owner,_movieclipPart:item.slot,
    _movieclipInner:item._movieclipOwner?{owner:item._movieclipOwner,part:item._movieclipPart,inner:item._movieclipInner}:undefined});
   }
   const group={...anchor,renderSource:undefined,drawables:runItems};objects.set(anchor.slot,group);next.push(group);runCount++;
   for(const item of runItems)items.push(item);run=[];
  };
  for(const part of ordered){if(set.has(part.slot)){if(visibility[part.slot])run.push(part);}else{flush();next.push(part);}}
  flush();if(runCount>1)owner.domainBounds=objectBounds(items,{vfxBounds:false});assemblies.set(slot,items);
  ordered=next;for(const member of set)grouped.add(frame.objects[member].unique_id);
 }
 const result={...source,objects,orderedObjects:ordered,drawables:ordered.flatMap(g=>g.drawables),warnings,
  token:{},previousToken:undefined,changedSlots:null,connectedVfxSource:source,connectedVfxUids:[...grouped],connectedVfxAssemblies:assemblies};
 views.set(source,{key,frame,geometry:result});return result;
}
