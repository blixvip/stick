import {VFX_REGISTRY,vfxDescriptor} from './vfx.mjs';
import {effectMessages,effectNameMessage,effectParameterMessage} from './vfx-localization.mjs';
import {t} from './localization.mjs';

const sessions=new WeakMap(),catalogs=new WeakMap(),projections=new WeakMap();
const MAX_CHOICES=256;
function session(editor){
 let state=sessions.get(editor);
 if(!state||state.document!==editor._documentToken){state={document:editor._documentToken,choices:new Map(),revision:0};sessions.set(editor,state);}
 return state;
}
/** View preferences contain identities only, never document/key snapshots. */
export const vfxChannelRevision=editor=>session(editor).revision;
export function vfxGroupEffectName(clip,effect){const message=effectNameMessage(clip,effect);return t(message.messageKey,message.messageParams);}
export function vfxChannelGroups(clip){
 const cached=catalogs.get(clip.keys);if(cached?.effects===clip.effects)return cached.groups;
 const duplicateTypes=new Map();for(const effect of clip.effects)duplicateTypes.set(effect.type,(duplicateTypes.get(effect.type)??0)+1);
 const counts=new Map(),groups=clip.effects.map(effect=>{
  const count=(counts.get(effect.type)??0)+1;counts.set(effect.type,count);
  const name=VFX_REGISTRY[effect.type].name+(duplicateTypes.get(effect.type)>1?` ${count}`:'');
  const caption=duplicateTypes.get(effect.type)>1?{messageKey:'vfxChannels.effectIndex',messageParams:{name:{messageKey:effectMessages[effect.type].nameKey},index:count}}:{messageKey:effectMessages[effect.type].nameKey};
  return {id:effect.id,name,type:effect.type,nameKey:caption.messageKey,nameParams:caption.messageParams,channels:[]};
 }),byId=new Map(groups.map(group=>[group.id,group]));
 for(const [property,keys] of Object.entries(clip.keys)){if(!keys.length)continue;const d=vfxDescriptor(property);byId.get(d.id)?.channels.push({property,label:d.label,labelKey:effectParameterMessage(d).messageKey});}
 const result=groups.filter(group=>group.channels.length);catalogs.set(clip.keys,{effects:clip.effects,groups:result});return result;
}
export function vfxVisibleKeys(editor,clip){
 const choice=session(editor).choices.get(clip.id);if(!choice)return clip.keys;
 const cached=projections.get(clip.keys);if(cached?.choice===choice)return cached.keys;
 const keys={};for(const property of choice)if(clip.keys[property]?.length)keys[property]=clip.keys[property];
 projections.set(clip.keys,{choice,keys});return keys;
}
const validProperty=(clip,property)=>{const d=vfxDescriptor(property);return Boolean(clip.keys[property]?.length||d&&clip.effects?.some(e=>e.id===d.id&&e.type===d.effectType));};
export function vfxSelectedChannels(editor,clip){return (session(editor).choices.get(clip.id)??Object.keys(clip.keys)).filter(property=>validProperty(clip,property));}
export function vfxChannelLabel(editor,clip){
 const message=vfxChannelMessage(editor,clip);return t(message.messageKey,message.messageParams);
}
export function vfxChannelMessage(editor,clip){
 if(!session(editor).choices.has(clip.id))return {messageKey:'vfxChannels.allKeys'};
 const selected=vfxSelectedChannels(editor,clip);if(!selected.length)return {messageKey:'vfxChannels.noKeys'};
 const groups=vfxChannelGroups(clip);
 if(selected.length===1){const d=vfxDescriptor(selected[0]),effect=clip.effects.find(e=>e.id===d.id);return clip.effects.length>1?{messageKey:'vfxChannels.effectParameter',messageParams:{name:effectNameMessage(clip,effect),parameter:effectParameterMessage(d)}}:effectParameterMessage(d);}
 const group=groups.find(g=>g.channels.length===selected.length&&g.channels.every(c=>selected.includes(c.property)));
 return group?{messageKey:group.nameKey,messageParams:group.nameParams}:{messageKey:'vfxChannels.values',messageParams:{count:selected.length}};
}
export function setVfxVisibleChannels(editor,clip,properties=null){
 const state=session(editor),before=state.choices.get(clip.id)??null;
 const next=properties===null?null:[...new Set(properties)].filter(key=>validProperty(clip,key)).sort();
 if(next===null&&before===null||next&&before&&next.length===before.length&&next.every((key,i)=>key===before[i]))return false;
 if(next===null)state.choices.delete(clip.id);else{state.choices.delete(clip.id);state.choices.set(clip.id,next);if(state.choices.size>MAX_CHOICES)state.choices.delete(state.choices.keys().next().value);}
 state.revision++;editor._selectedVfxKey=null;editor._emit('vfx-channels',{clipId:clip.id});return true;
}
