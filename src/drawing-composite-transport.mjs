import {messageError} from './localized-error.mjs';
import {documentChunks} from './document-transport.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const objectKeys=['unique_id','scale','image_text_flags','color_override_raw','color_transition','_stykVfx'];
const references=['obj','fig','asset','seg','_movieclipOwner','_movieclipInner'];
const evaluationOnly=new Set(['handle','spatialFrame','rigSpace','rigChildSpace','rigRotation','attachmentPosition']);
const yieldToInput=()=>globalThis.scheduler?.yield?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0));

/** Transfer evaluated artwork, never the figure library, poses or animation.
 * Intern render definitions once: repeating a dense figure on every primitive
 * otherwise makes structured cloning quadratic. Packet construction and ACKs
 * both yield, including for a single large path or embedded image. */
export async function sendDrawingComposite(worker,drawables,{visible=()=>true,signal,check=()=>{},maxBytes}={}){
  const records=[],items=[],ids=new Map();
  let projectedBytes=0;
  const reserve=record=>{projectedBytes+=128+Object.keys(record).length*32;if(projectedBytes>maxBytes)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});};
  function reference(value,kind){
    if(value==null)return null;
    let id=ids.get(value);if(id!==undefined)return id;
    id=records.length;ids.set(value,id);
    let record=value;
    if(kind==='obj')record=pick(value,objectKeys);
    if(kind==='fig')record={figure_type_id:value.figure_type_id,segment_decode:{global_style:value.segment_decode?.global_style},_styk:{drawing:value._styk?.drawing},image_assets:value._styk?.drawing?.version===2?[{styk_tiles:value.image_assets?.[0]?.styk_tiles}]:undefined};
    // Drawing pixels are carried once by the figure; its sprite still needs
    // the evaluated anchors, but never a second copy of the encoded tile blob.
    if(kind==='asset'&&value.styk_tiles){const {styk_tiles,...asset}=value;record=asset;}
    reserve(record);records.push(record);return id;
  }
  let deadline=performance.now()+2;
  for(const item of drawables){
    check();
    if(visible(item)){
      const copy={};
      for(const key of Object.keys(item))if(!evaluationOnly.has(key))copy[key]=references.includes(key)?reference(item[key],key):item[key];
      reserve(copy);items.push(copy);
    }
    if(performance.now()>=deadline){await yieldToInput();check();deadline=performance.now()+2;}
  }
  let bytes=0;
  for(const chunk of documentChunks({records,items},{maxRecords:128,maxBytes:64*1024,timeBudgetMs:2})){
    check();bytes+=chunk.estimatedBytes??64;
    if(bytes>maxBytes)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
    await worker.request('composite-chunk',{chunk,maxBytes},{signal});
  }
  check();return bytes;
}

export function restoreDrawingComposite({records,items}){
  for(const item of items)for(const key of references)if(item[key]!=null)item[key]=records[item[key]];
  return {drawables:items};
}
