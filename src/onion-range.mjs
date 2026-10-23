import {sheetKeyTimes} from './layer-sheet.mjs';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function lowerBound(keys,tick){
  let low=0,high=keys.length;
  while(low<high){const mid=(low+high)>>>1;if(keys[mid]<tick)low=mid+1;else high=mid;}
  return low;
}

/** Limits are the samples that actually exist, never an arbitrary count cap. */
export function onionRangeLimit(keys,tick,direction,{onionMode='keyframes',onionStep=1}={},totalTicks=Infinity){
  if(onionMode==='frames')return Math.max(0,Math.floor((direction<0?tick:totalTicks-1-tick)/onionStep));
  const first=lowerBound(keys,tick),end=lowerBound(keys,totalTicks);
  return Math.max(0,Math.floor((direction<0?first:end-first-(keys[first]===tick?1:0))/onionStep));
}

export function onionRangeTick(keys,tick,count,direction,settings={},totalTicks=Infinity){
  count=clamp(count,0,onionRangeLimit(keys,tick,direction,settings,totalTicks));
  if(!count)return tick;
  const step=settings.onionStep??1;
  if(settings.onionMode==='frames')return tick+direction*count*step;
  const first=lowerBound(keys,tick);
  return keys[direction<0?first-count*step:first+(keys[first]===tick?1:0)+count*step-1];
}

/** Snap a dragged endpoint to an actual sampled frame in logarithmic time. */
export function onionRangeCountAtTick(keys,tick,target,direction,settings={},totalTicks=Infinity){
  const max=onionRangeLimit(keys,tick,direction,settings,totalTicks);
  let low=0,high=max;
  const distance=n=>direction*(onionRangeTick(keys,tick,n,direction,settings,totalTicks)-tick);
  const wanted=Math.max(0,direction*(target-tick));
  while(low<high){const mid=Math.ceil((low+high)/2);if(distance(mid)<=wanted)low=mid;else high=mid-1;}
  return low<max&&Math.abs(distance(low+1)-wanted)<Math.abs(distance(low)-wanted)?low+1:low;
}

// The only document-to-sample index used by the controls and renderer. Indexes
// are cached by immutable sheet/channel publications, not rebuilt on pointermove.
const indexes=new WeakMap();
export function sceneKeyTicks(editor,rows=editor.timeline){
  if(editor.report._styk?.layerSheet)return sheetKeyTimes(editor.report);
  const channels=editor.report._styk?.animation?.channels??[],ticks=new Set();
  if(!channels.length)return rows.map(row=>row.start);
  const figures=new Set(),layers=new Set();
  for(const channel of channels){
    for(const key of channel.keys)if(!key.hidden)ticks.add(key.tick);
    if(channel.property==='pose'){
      if(channel.target.kind==='figure')figures.add(channel.target.uid);
      if(channel.target.kind==='layer')layers.add(channel.target.id);
    }
  }
  if(editor.layers.some(layer=>!layers.has(layer.id)&&layer.figureUids.some(uid=>!figures.has(uid))))
    for(const row of rows)if(row.count>0)ticks.add(row.start);
  return [...ticks].sort((a,b)=>a-b);
}

/** Preference migration cannot depend on document contents or playhead time. */
export function onionRangeSettings(settings){
  if(settings.onionRangeBefore!=null&&settings.onionRangeAfter!=null)return settings;
  const step=settings.onionStep??1;
  return {...settings,onionRangeBefore:settings.onionRangeBefore??(settings.onionBefore??0)*step,onionRangeAfter:settings.onionRangeAfter??(settings.onionAfter??0)*step};
}

export function onionRangeSnapshot(editor,settings,displayTick){
  settings=onionRangeSettings(settings);
  const report=editor.report,sheet=report._styk?.layerSheet,channels=report._styk?.animation?.channels;
  const adding=editor.frameDraft?.mode==='add';
  let index=indexes.get(editor);
  if(!index||index.report!==report||index.sheet!==sheet||index.channels!==channels||index.revision!==editor.revision||index.adding!==adding){
    index={report,sheet,channels,revision:editor.revision,adding,keys:adding?editor.timeline.map(row=>row.start):sceneKeyTicks(editor)};
    indexes.set(editor,index);
  }
  const tick=Math.floor(displayTick??(adding?editor.totalTicks:editor.tick)),total=editor.totalTicks;
  const direction=sign=>{
    const key=sign<0?'onionRangeBefore':'onionRangeAfter',requested=settings[key];
    // A preference is a fixed distance from the playhead. Only sampling is
    // bounded by available poses; seeking must never shorten the visual range.
    const max=10000000,span=clamp(requested,0,max),endpoint=tick+sign*span;
    let count=onionRangeCountAtTick(index.keys,tick,endpoint,sign,settings,total);
    if(count&&sign*(onionRangeTick(index.keys,tick,count,sign,settings,total)-endpoint)>0)count--;
    return {key,span,requested,max,endpoint,count};
  };
  return {tick,total,keys:index.keys,before:direction(-1),after:direction(1),settings};
}

/** Deliberate scrub sensitivity independent of zoom, key spacing and DOM motion. */
export function onionDragValue(start,dx,max,precision=false){
  return clamp(start+Math.trunc(dx/(precision?32:8)),0,max);
}
