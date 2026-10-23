import {messageError} from './localized-error.mjs';
/** Presence clocks are derived from sparse authored spans, never playback state.
 * A missing instance pauses its clock. Frame-only expansion leaves a continuation
 * in the pose so subsequent samples do not move backward. */
const indices = new WeakMap();
export const presencePlayback = (settings = {}) => ({clock:'presence', offset:0, speed:1, mode:'loop', ...settings});
export const usesPresence = object => object?._stykMovieclip?.clock === 'presence';
export const continuations = frame => frame?._styk?.movieclipContinuations ?? [];
export function invalidateMovieclipPresence(report) { indices.delete(report); }
export function cachedPresenceIndex(report) {
  const cached=indices.get(report);
  return cached?.token===(report._styk?.layerSheet??report.keyframes)?cached.instances:undefined;
}

export function setContinuations(frame, values) {
  frame._styk = {...frame._styk};
  if (values.length) frame._styk.movieclipContinuations = values;
  else delete frame._styk.movieclipContinuations;
  return frame;
}

/** `sample` returns authored membership before clip visibility/once filtering.
 * Boundaries include layer ends: the final held pose must not run past its row.
 * The index is rebuilt after edits and shared by all clips and random seeks. */
export function presenceIndex(report, boundaries, sample) {
  const token = report._styk?.layerSheet ?? report.keyframes;
  let cached = indices.get(report);
  if (cached?.token === token) return cached.instances;
  const instances = new Map(), times = [...new Set(boundaries)].sort((a,b)=>a-b);
  for (let i=0;i+1<times.length;i++) {
    const start=times[i], end=times[i+1];
    if (end<=start) continue;
    const frame=sample(start), members=new Map();
    for (const step of continuations(frame)) members.set(step.uid, step.playback);
    for (const object of frame.objects) if (usesPresence(object)) members.set(object.unique_id,object._stykMovieclip);
    for (const [uid,settings] of members) {
      let entry=instances.get(uid);
      if (!entry) {entry={spans:[],elapsed:0};instances.set(uid,entry);}
      const rate=settings.mode==='single'?0:settings.speed??1;
      const previous=entry.spans.at(-1);
      if (previous?.end===start && previous.rate===rate) previous.end=end;
      else entry.spans.push({start,end,elapsed:entry.elapsed,rate});
      entry.elapsed+=(end-start)*rate;
    }
  }
  indices.set(report,{token,instances});
  return instances;
}

export function presenceElapsed(index, uid, tick) {
  const entry=index.get(uid); if (!entry) return 0;
  const spans=entry.spans;let low=0,high=spans.length;
  while(low<high){const mid=(low+high)>>>1;if(spans[mid].start<=tick)low=mid+1;else high=mid;}
  const span=spans[low-1];
  return span ? span.elapsed+Math.max(0,Math.min(tick,span.end)-span.start)*span.rate : 0;
}

export function validateContinuations(frame, types) {
  const values=frame?._styk?.movieclipContinuations;
  if(values===undefined)return;
  if(!Array.isArray(values)||values.length>65535)throw messageError(new Error(''), "errors.movieclipPresence.invalidMovieclipContinuationData", {});
  const seen=new Set();
  for(const value of values){
    if(!value||!Number.isInteger(value.uid)||value.uid<0||value.uid>0x7ffffffe||seen.has(value.uid)||!types.has(value.typeId)||value.playback?.clock!=='presence')throw messageError(new Error(''), "errors.movieclipPresence.invalidMovieclipContinuation", {});
    seen.add(value.uid);
  }
}
