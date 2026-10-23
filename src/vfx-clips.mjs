import {messageError} from './localized-error.mjs';
import {createVfx,validateVfxStack,validateVfxValue,vfxDescriptor,vfxOwnerKey,vfxProperty} from './vfx.mjs';
import {interpolateVfxColor} from './vfx-paint.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {easedProgress,validateKeyEasing} from './keyframe-easing.mjs';

export const VFX_CLIP_LIMIT=4096;
const empty=Object.freeze([]),indices=new WeakMap(),validated=new WeakSet(),rendered=new WeakSet(),frames=new WeakMap();
export const vfxClips=report=>report?._styk?.vfxClips?.clips??empty;
/** Timeline effect clips owned by figures or their nodes, carried by figure clipboards. */
export const figureVfxClips=(report,uids)=>{const set=new Set(uids);return vfxClips(report).filter(c=>c.target.kind!=='scene'&&set.has(c.target.uid));};
export const sameVfxTarget=(a,b)=>a.kind===b.kind&&a.uid===b.uid&&a.handleId===b.handleId&&a.figureTypeId===b.figureTypeId;
export const clipContains=(clip,tick)=>clip.duration===null||tick>=clip.start&&tick<clip.start+clip.duration;
export const clipTime=(clip,tick)=>Math.max(0,tick-clip.start+clip.offset);
export function createVfxClip(target,type,id,effectId,{start=0,duration=null,includeAttached=false}={}){
 return {id,name:'',target:{...target},start,duration,offset:0,enabled:true,strength:1,fadeIn:0,fadeOut:0,includeAttached:target.kind==='figure'&&includeAttached,effects:[createVfx(type,effectId)],keys:{}};
}
export function validateVfxClips(state,{immutable=false}={}){
 if(state===undefined)return;
 if(!state||state.version!==1||!Array.isArray(state.clips)||state.clips.length>VFX_CLIP_LIMIT)throw messageError(new Error(''), "errors.vfxClips.invalidEffectsTimeline", {});
 const ids=new Set(),events=new Map();let count=0;
 for(const c of state.clips){
  if(!c||typeof c.id!=='string'||!/^[\w-]{1,80}$/.test(c.id)||ids.has(c.id))throw messageError(new Error(''), "errors.vfxClips.invalidEffectClipIdentity", {});ids.add(c.id);
  if(!immutable||!validated.has(c)){
   const t=c.target;
   if(!t||!['figure','segment','scene'].includes(t.kind)||t.kind!=='scene'&&(!Number.isInteger(t.uid)||t.uid<0)||t.kind==='segment'&&(!Number.isInteger(t.handleId)||t.handleId<1||t.handleId>65535||t.figureTypeId!==undefined&&(!Number.isSafeInteger(t.figureTypeId)||t.figureTypeId<1)))throw messageError(new Error(''), "errors.vfxClips.invalidEffectClipTarget", {});
   if(typeof c.name!=='string'||c.name.length>120||typeof c.enabled!=='boolean'||typeof c.includeAttached!=='boolean'||![c.start,c.offset,c.fadeIn,c.fadeOut].every(n=>Number.isInteger(n)&&n>=0&&n<=10000000)||c.duration!==null&&(!Number.isInteger(c.duration)||c.duration<1||c.start+c.duration>10000000)||c.duration===null&&(c.start!==0||c.offset!==0)||!Number.isFinite(c.strength)||c.strength<0||c.strength>1)throw messageError(new Error(''), "errors.vfxClips.invalidEffectClipTiming", {});
   validateVfxStack(c.effects);
   if(!c.keys||typeof c.keys!=='object'||Array.isArray(c.keys)||Object.keys(c.keys).length>512)throw messageError(new Error(''), "errors.vfxClips.invalidEffectKeys", {});
   for(const [property,keys] of Object.entries(c.keys)){
    const d=vfxDescriptor(property);if(!d?.id||!c.effects.some(e=>e.id===d.id&&e.type===d.effectType)||!Array.isArray(keys)||keys.length>100000)throw messageError(new Error(''), "errors.vfxClips.invalidEffectKeyChannel", {});
    let previous=-1;for(const k of keys){if(!Number.isInteger(k.tick)||k.tick<0||k.tick<=previous||k.tick>10000000)throw messageError(new Error(''), "errors.vfxClips.effectKeysMustBeOrderedAndUnique", {});previous=k.tick;validateVfxValue(property,k.value);validateKeyEasing(k,property);}
   }
   if(immutable)validated.add(c);
  }
  for(const keys of Object.values(c.keys))count+=keys.length;
  if(count>1000000)throw messageError(new Error(''), "errors.vfxClips.tooManyEffectKeys", {});
  const target=`${c.target.kind}/${c.target.uid??''}/${vfxOwnerKey(c.target)}`,list=events.get(target)??[];
  if(c.enabled){list.push([c.start,c.effects.length]);if(c.duration!==null)list.push([c.start+c.duration,-c.effects.length]);}events.set(target,list);
 }
 for(const list of events.values()){let active=0;list.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);for(const [,change] of list){active+=change;if(active>64)throw messageError(new Error(''), "errors.vfxClips.aTargetSupportsUpTo64SimultaneousEffects", {});}}
}
export function sampleVfxKeys(keys,tick,fallback,property){
 if(!keys?.length)return fallback;
 let low=0,high=keys.length-1;while(low<high){const mid=(low+high+1)>>>1;if(keys[mid].tick<=tick)low=mid;else high=mid-1;}
 const a=keys[low],b=keys[low+1],d=vfxDescriptor(property);
 if(tick<=a.tick||!b||d.discrete)return a.value;
 const t=easedProgress(a,(tick-a.tick)/(b.tick-a.tick));return d.type==='color'?interpolateVfxColor(a.value,b.value,t):a.value+(b.value-a.value)*t;
}
/** Inspector activity uses keyed switches/strength, without evaluating colors,
 * spatial parameters or geometry. Fade endpoints remain part of a timed clip. */
export function vfxClipActiveAt(clip,tick){
 if(!clip.enabled||!clip.strength||!clipContains(clip,tick))return false;
 const time=clipTime(clip,tick);
 return clip.effects.some(effect=>{
  const enabled=vfxProperty(effect.type,effect.id,'enabled'),strength=vfxProperty(effect.type,effect.id,'effectStrength');
  return Boolean(sampleVfxKeys(clip.keys[enabled],time,+effect.enabled,enabled))&&sampleVfxKeys(clip.keys[strength],time,effect.params.effectStrength??1,strength)>0;
 });
}
export const vfxFadeAt=(clip,elapsed)=>clip.duration===null?1:Math.min(clip.fadeIn?Math.max(0,Math.min(1,elapsed/clip.fadeIn)):1,clip.fadeOut?Math.max(0,Math.min(1,(clip.duration-elapsed)/clip.fadeOut)):1);
export function sampleVfxClip(clip,tick,{envelope=false}={}){
 const age=clipTime(clip,tick),elapsed=tick-clip.start;
 const strength=envelope?clip.strength*vfxFadeAt(clip,elapsed):1;
 return clip.effects.map(effect=>{
  let result=effect;
  for(const [property,keys] of Object.entries(clip.keys)){
   const d=vfxDescriptor(property);if(d.id!==effect.id||!keys.length)continue;
   const value=sampleVfxKeys(keys,age,d.param==='enabled'?+effect.enabled:effect.params[d.param],property);
   result=d.param==='enabled'?{...result,enabled:Boolean(value)}:{...result,params:{...result.params,[d.param]:value}};
  }
  return strength===1?result:{...result,params:{...result.params,effectStrength:(result.params.effectStrength??1)*strength}};
 });
}
function indexFor(clips){let index=indices.get(clips);if(!index){index=new Map();for(const c of clips){const id=c.target.kind==='scene'?'scene':c.target.uid,list=index.get(id)??[];list.push(c);index.set(id,list);}indices.set(clips,index);}return index;}
export function renderVfxOwner(owner,clips,tick){
 let result=owner;
 for(const clip of clips??empty){
  if(!clip.enabled||!clipContains(clip,tick)||!clip.strength||clip.target.kind==='segment'&&clip.target.figureTypeId!==undefined&&clip.target.figureTypeId!==owner.figure_type_id)continue;
  // Generators draw their own artwork (vfx-generators.mjs); only filters compose here.
  if(!clip.effects.some(e=>!isGeneratorType(e.type)))continue;
  const effects=sampleVfxClip(clip,tick,{envelope:true}).filter(e=>!isGeneratorType(e.type)),key=vfxOwnerKey(clip.target);
  const connected=result._vfxConnectedEffects??(owner._stykVfxScope===1?owner._stykVfx?.figure??empty:empty);
  result={...result,_stykVfx:{...result._stykVfx,[key]:[...(result._stykVfx?.[key]??empty),...effects]},
   _vfxConnectedEffects:clip.includeAttached&&clip.target.kind==='figure'?[...connected,...effects]:connected};
  if(clip.includeAttached&&clip.target.kind==='figure')result._stykVfxScope=1;
 }
 return result;
}
export function frameWithVfxTime(report,frame,tick){
 const clips=vfxClips(report);if(!clips.length)return frame;
 const scene=renderVfxOwner(frame,indexFor(clips).get('scene'),tick);
 return {...frame,_vfxTimelineTick:tick,_vfxTimelineScene:scene._stykVfx?.figure??empty};
}
/** Only geometry receives composed effects. Pose snapshots retain authored data. */
export function invalidateVfxRenderFrame(frame){if(frame)frames.delete(frame);}
export function vfxRenderFrame(report,frame){
 if(frame._vfxTimelineTick===undefined||rendered.has(frame))return frame;
 if(!vfxClips(report).length&&report._styk?.movieclipSource?.document)return vfxRenderFrame(report._styk.movieclipSource.document,frame);
 const state=report._styk?.vfxClips,prior=frames.get(frame);if(prior?.state===state)return prior.result;
 const index=indexFor(vfxClips(report));if(!index.size)return frame;
 const result={...frame,objects:frame.objects.map(o=>renderVfxOwner(o,index.get(o.unique_id),frame._vfxTimelineTick))};rendered.add(result);frames.set(frame,{state,result});return result;
}
