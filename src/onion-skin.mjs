import {sheetKeyAt} from './layer-sheet.mjs';
import {drawingMetadata,isDrawingLayer} from './drawing-model.mjs';
import {buildGeometry, evaluatedFrame} from './pivot/geometry.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {easingMode} from './keyframe-easing.mjs';
import {onionRangeLimit,onionRangeSnapshot,sceneKeyTicks} from './onion-range.mjs';
import {RetainedGeometryCache} from './playback-geometry-cache.mjs';

/** The nearest drawings before and after the playhead on each drawing layer,
 * never repeating the drawing on screen. Blank exposures are skipped rather
 * than counted, and past a layer's end its last drawing is the first one
 * before, so a frame without its own ink still shows its neighbours. */
export function drawingOnionSamples(editor,settings){
  if(settings.onionMode==='frames')return [];
  const samples=[];
  for(const layer of editor.layers??[]){if(!layer.drawing||!layer.visible)continue;const track=editor.report._styk?.layerSheet?.tracks[layer.id];if(!track)continue;
    const found=sheetKeyAt(track,editor.tick),current=found.index+(editor.tick>=track.end?1:0),step=Math.max(1,settings.onionStep??1);
    for(const direction of [-1,1]){
      const span=direction<0?settings.onionRangeBefore:settings.onionRangeAfter;
      const wanted=span==null?(direction<0?settings.onionBefore:settings.onionAfter):Infinity;let distance=0,seen=0;
      for(let index=current+direction;index>=0&&index<track.keys.length&&distance<wanted;index+=direction){
        const key=track.keys[index];if(span!=null&&direction*(key.tick-editor.tick)>span)break;if(key.value?.frameId==null)continue;
        if(seen++%step)continue;
        samples.push({tick:key.tick,direction,distance:++distance,drawingLayer:layer.id});
      }
    }
  }
  return samples;
}

/** Independently timed layers must not lose a neighbour to keys on Camera,
 * Scene or another layer. Keep the chosen frame-distance range and spacing. */
export function layerOnionSamples(editor,settings){
  const samples=[],sheet=editor.report._styk?.layerSheet;
  if(!sheet||settings.onionMode==='frames')return samples;
  for(const layer of editor.layers){
    const id=layer.id,track=sheet.tracks[id];if(layer.kind!=='layer'||!layer.visible||layer.drawing||!track)continue;
    const found=sheetKeyAt(track,editor.tick),step=Math.max(1,settings.onionStep??1);
    for(const direction of [-1,1]){
      const span=direction<0?settings.onionRangeBefore:settings.onionRangeAfter;
      const wanted=span==null?(direction<0?settings.onionBefore:settings.onionAfter):Infinity;
      let index=found.index+(direction>0?1:found.key?.tick===editor.tick?-1:0),distance=0,seen=0;
      for(;index>=0&&index<track.keys.length&&distance<wanted;index+=direction){
        const key=track.keys[index];if(span!=null&&direction*(key.tick-editor.tick)>span)break;
        if(key.empty||key.value?.frameId===null)continue;
        if(++seen%step)continue;
        samples.push({tick:key.tick,direction,distance:++distance,sampleLayer:id});
      }
    }
  }
  return samples;
}

/** The cel showing under the playhead plus up to `before`/`after` unique
 * neighbouring cels of the drawing layer `layerId`. Callers surface
 * `neighbors` first and `current` last so a bounded decode queue drops stale
 * prefetches before the cel the playhead actually shows. */
/** Timeline distance of every drawing cel from the playhead, over all
 * drawing layers, measured circularly because playback and scrubbing loop:
 * the first frame is close to the last. Memory eviction keeps near cels. */
export function drawingCelDistances(editor){
  const distances=new Map(),tracks=editor.report._styk?.layerSheet?.tracks??{},tick=editor.tick,total=Math.max(1,editor.totalTicks??1);
  for(const layer of editor.layers??[]){
    if(!isDrawingLayer(layer))continue;const track=tracks[layer.id];if(!track)continue;
    track.keys.forEach((key,i)=>{
      const frame=key?.value?.frameId?editor.getFrameById(key.value.frameId):null;
      for(const object of frame?.objects??[]){
        if(editor.layerForUid(object.unique_id)!==layer.id)continue;
        const figure=editor.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id),id=drawingMetadata(figure)?.celId;if(!id)continue;
        const start=key.tick,end=track.keys[i+1]?.tick??track.end,linear=tick<start?start-tick:tick>=end?tick-end+1:0;
        const d=Math.min(linear,Math.max(0,total-linear));
        if(!(distances.get(id)<=d))distances.set(id,d);
      }
    });
  }
  return distances;
}
export function drawingCelPrefetch(editor,layerId,{before=2,after=2}={}){
  const layer=editor.getLayer(layerId);if(!isDrawingLayer(layer)||!layer.visible)return null;
  const track=editor.report._styk?.layerSheet?.tracks[layerId];if(!track)return null;
  const index=sheetKeyAt(track,editor.tick).index;
  const figureAt=key=>{const frame=key?.value?.frameId?editor.getFrameById(key.value.frameId):null;const object=frame?.objects.find(o=>editor.layerForUid(o.unique_id)===layerId);const figure=object&&editor.report.figure_types.find(f=>f.figure_type_id===object.figure_type_id);return figure&&drawingMetadata(figure)?figure:null;};
  const current=figureAt(track.keys[index]),neighbors=[],seen=new Set([drawingMetadata(current)?.celId]);
  for(const direction of [-1,1]){
    let found=0;
    for(let distance=1;index+direction*distance>=0&&index+direction*distance<track.keys.length&&found<(direction<0?before:after);distance++){
      const figure=figureAt(track.keys[index+direction*distance]);if(!figure||seen.has(drawingMetadata(figure).celId))continue;
      seen.add(drawingMetadata(figure).celId);neighbors.push(figure);found++;
    }
  }
  return{current,neighbors};
}
// native object records have not changed.
function affectedSlots(frame, uids) {
  const slots = new Set(), children = new Map(), queue = [];
  frame.objects.forEach((object, slot) => {
    if (uids.has(object.unique_id)) { slots.add(slot); queue.push(slot); }
    if (object.join) {
      const parent = Number(object.join.target_object_slot);
      let list = children.get(parent); if (!list) children.set(parent, list = []);
      list.push(slot);
    }
  });
  for (let i = 0; i < queue.length; i++) for (const slot of children.get(queue[i]) || [])
    if (!slots.has(slot)) { slots.add(slot); queue.push(slot); }
  return slots;
}

/** Keep sampled geometry independent of opacity, tint, selection and viewport. */
export class OnionSkinCache {
  constructor({evaluate = evaluatedFrame, geometry = buildGeometry, maxEntries = 24} = {}) {
    this.evaluate = evaluate; this.geometry = geometry; this.maxEntries = maxEntries;
    this.samples = new Map(); this.styles = new WeakMap(); this.objectStyles = new WeakMap(); this.stats = {builds:0,hits:0};
    this.retained = new RetainedGeometryCache();
  }
  clear() {
    this.samples.clear(); this.styles = new WeakMap(); this.objectStyles = new WeakMap();
    this.last = null; this.keyTicks = null; this.retained.clear();
  }
  invalidate(detail = {}) {
    if (!['document','edit','history'].includes(detail.kind)) return;
    // Revision changes are explained by the editor's change event. A revision
    // change without an event still clears the cache defensively in get().
    this.revision = this.editor?.revision;
    // Layer pose gestures edit a private working frame. Ghosts sample the
    // committed sheet, which publishes a new state when the gesture commits.
    if (detail.kind === 'edit' && detail.live && this.layerSheet && this.layerSheet === this.editor?.report._styk?.layerSheet &&
      !detail.definition && !detail.structural && !detail.animation && !detail.layers) return;
    if (detail.layerSheet && detail.kind !== 'document' && !detail.definition && this.report === this.editor?.report &&
      this.figures === this.report.figure_types && this.layerSheet) {
      // Re-evaluate published poses, but retain exact object geometry and tint
      // identities. Rebuilding unchanged ghosts also evicts their GPU textures.
      for (const sample of this.samples.values()) sample.stale = true;
      this.layerSheet = this.report._styk.layerSheet;
      this.retained.retainRevision(this.revision);
      this.last = null; this.keyTicks = null;
      return;
    }
    if((detail.changedUids || detail.live || detail.frameIndices) && !detail.animation && !detail.definition && !detail.structural && !detail.timing &&
      !this.editor?.report._styk?.animation?.channels?.length && !this.editor?.report._styk?.layerSheet && detail.kind !== 'document'){
      const indices=new Set(detail.frameIndices||detail.changedFrames||[detail.frameIndex]);
      // Add edits affect only the working copy; stored ghosts stay still.
      const draft=this.editor?.frameDraft;
      if(detail.kind==='edit' && draft?.mode==='add' && !detail.layers) indices.delete(draft.index);
      for(const [id,sample] of this.samples)if(indices.size && (!sample.dependencies || sample.dependencies.some(index=>indices.has(index)))){
        if(detail.changedUids?.length && !detail.layers) {
          sample.dirtyUids ??= new Set();
          for(const uid of detail.changedUids)sample.dirtyUids.add(uid);
        } else this.samples.delete(id);
        this.last=null;
      }
    }else this.clear();
  }
  get(editor, settings, {selected = new Set(), hidden = new Set(), visibilityKey} = {}) {
    if(this.editor !== editor){
      this.editor?.removeEventListener('change',this.listener);
      this.editor=editor;this.listener=event=>this.invalidate(event.detail);
      editor.addEventListener('change',this.listener);
      this.report=null;
    }
    const samplingSettings=settings;
    if(settings.onionRangeBefore!=null||settings.onionRangeAfter!=null){
      const range=onionRangeSnapshot(editor,settings);
      settings={...settings,onionBefore:range.before.count,onionAfter:range.after.count};
    }
    const report = editor.report, layerSheet = report._styk?.layerSheet;
    // Sheet publications replace immutable state, including during history.
    // Check it at the read boundary as well as listening for change events;
    // native frame dependency hints do not describe authored layer exposures.
    if (this.report !== report || this.revision !== editor.revision || this.layerSheet !== layerSheet) {
      this.clear();
      this.report = report; this.revision = editor.revision;
      this.figures = report.figure_types;
      this.layerSheet = layerSheet;
      this.keyTicks = null;
    }
    const hiddenKey=visibilityKey ?? (hidden[Symbol.iterator] ? [...hidden] : []);
    const draft=editor.frameDraft, adding=draft?.mode==='add';
    // Draft mode changes can be metadata-only (no document revision).
    const draftKey=JSON.stringify([draft?.mode,adding?draft.index:null,draft?.empty]);
    const baseline=adding?report._styk?.simpleFrameDraft?.baseline:null;
    if(this.draftKey!==draftKey || this.draftBaseline && this.draftBaseline!==baseline){this.samples.clear();this.last=null;this.draftKey=draftKey;}
    this.draftBaseline=baseline;
    const signature = JSON.stringify([editor.frameIndex,editor.tick,editor.layerRevision,settings.onionBefore,settings.onionAfter,settings.onionStep,
      settings.onionMode,settings.onionScope,settings.onionJoined,settings.onionOpacity,settings.onionFade,settings.onionTint,
      settings.onionBeforeColor,settings.onionAfterColor,settings.onionShowOnTop,samplingSettings.onionRangeBefore,samplingSettings.onionRangeAfter,[...selected],hiddenKey]);
    if (this.last?.signature === signature) return this.last.frames;
    const frames = [], activeSamples = new Set(), rows = editor.timeline;
    // The Add pose is the next, not-yet-stored frame. Its nearest predecessor
    // is the last stored pose, including the checkpoint underneath the draft.
    const sourceReport=adding?storedFrameReport(report,{validate:false}):report;
    const currentIndex=adding?rows.length:editor.frameIndex;
    const currentTick=adding?editor.totalTicks:editor.tick;
    // Layer sheets sample each layer below. Legacy authored channels still
    // use the scene-key timeline shared by both timeline views.
    const authoredKeys=!adding && settings.onionMode!=='frames' && (layerSheet || report._styk?.animation?.channels?.length);
    let keyTicks, previousKey, nextKey;
    if(authoredKeys){
      keyTicks=this.keyTicks??=sceneKeyTicks(editor,rows);
      let low=0,high=keyTicks.length;
      while(low<high){const mid=(low+high)>>>1;if(keyTicks[mid]<currentTick)low=mid+1;else high=mid;}
      previousKey=low-1;nextKey=keyTicks[low]===currentTick?low+1:low;
    }
    // Preferences may span any number of samples. Do not iterate nonexistent
    // frames when a saved range exceeds the current document or playhead bounds.
    const available=direction=>settings.onionMode==='frames'||authoredKeys
      ? onionRangeLimit(keyTicks??[],Math.floor(currentTick),direction,settings,editor.totalTicks)
      : Math.max(0,Math.floor((direction<0?currentIndex+(!adding&&editor.tick>rows[editor.frameIndex]?.start?1:0):rows.length-1-currentIndex)/settings.onionStep));
    const before=Math.min(settings.onionBefore,available(-1)),after=Math.min(settings.onionAfter,available(1));
    const candidates=[];
    const independentLayers=layerSheet&&settings.onionMode!=='frames';
    if(!independentLayers)for (let distance = Math.max(before,after); distance > 0; distance--) {
      for (const direction of [-1,1]) {
        if (distance > (direction < 0 ? before : after)) continue;
        let index = currentIndex + direction * distance * settings.onionStep, tick, ratio = 0;
        if (settings.onionMode === 'frames' || authoredKeys) {
          tick = authoredKeys ? keyTicks[direction<0?previousKey-(distance*settings.onionStep-1):nextKey+(distance*settings.onionStep-1)]
            : Math.floor(currentTick) + direction * distance * settings.onionStep;
          if(tick===undefined)continue;
          if (tick < 0 || tick >= editor.totalTicks) continue;
          let low=0,high=rows.length-1;
          while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}
          index=low; ratio=rows[index].count ? Math.min(1,(tick-rows[index].start)/rows[index].count) : 0;
        } else {
          if(!adding && direction<0 && editor.tick>rows[editor.frameIndex]?.start)index++;
          if(index<0 || index>=rows.length) continue;
          tick=rows[index].start;
        }
        candidates.push({index,tick,ratio,distance,direction});
      }
    }
    for(const candidate of [...(independentLayers?layerOnionSamples(editor,samplingSettings):[]),...drawingOnionSamples(editor,samplingSettings)]){
      let index=0,high=rows.length-1;
      while(index<high){const mid=Math.ceil((index+high)/2);if(rows[mid].start<=candidate.tick)index=mid;else high=mid-1;}
      candidates.push({...candidate,sampleLayer:candidate.sampleLayer??candidate.drawingLayer,index,ratio:rows[index].count?(candidate.tick-rows[index].start)/rows[index].count:0});
    }
    candidates.sort((a,b)=>b.distance-a.distance);
    for(const {index,tick,ratio,distance,direction,sampleLayer} of candidates){
        const id=`${index}:${tick}`;
        activeSamples.add(id);
        let sample=this.samples.get(id);
        if(!sample || sample.dirtyUids || sample.stale){
          let frame=this.evaluate(sourceReport,index,ratio,tick);
          // Before the first Add edit the evaluator can return the mutable
          // working frame itself. Keep its stored pose independent of edits.
          if(adding && !report._styk?.simpleFrameDraft?.baseline && index===draft.index)frame=structuredClone(frame);
          if (layerSheet && sample) this.retained.adopt(sourceReport, sample.frame, editor.revision, sample.geometry);
          const incremental=layerSheet?this.retained.plan(sourceReport,frame,editor.revision):
            sample?.dirtyUids?{previous:sample.geometry,dirtySlots:affectedSlots(frame,sample.dirtyUids)}:null;
          let geometry=this.geometry(sourceReport,frame,incremental);
          if (layerSheet) geometry=this.retained.publish(sourceReport,frame,editor.revision,geometry,incremental);
          sample={frame,geometry,dependencies:layerSheet?null:ratio>0?(report.auto_easing?null:
            easingMode(sourceReport.keyframes[index]?._styk?.easing)==='auto'?[index-1,index,index+1,index+2]:[index,index+1]):[index]};
          this.samples.set(id,sample);this.stats.builds++;
        }
        else {this.samples.delete(id);this.samples.set(id,sample);this.stats.hits++;}
        let included = settings.onionScope === 'selected' ? new Set(selected) : null;
        if (included && settings.onionJoined) {
          const links=new Map(), connect=(a,b)=>{let list=links.get(a);if(!list)links.set(a,list=[]);list.push(b);};
          for(const object of sample.frame.objects)if(object.join){const uid=sample.frame.objects[object.join.target_object_slot]?.unique_id;connect(object.unique_id,uid);connect(uid,object.unique_id);}
          const queue=[...included];for(let i=0;i<queue.length;i++)for(const uid of links.get(queue[i])??[])if(!included.has(uid)){included.add(uid);queue.push(uid);}
        }
        const color = settings.onionTint ? (direction<0?settings.onionBeforeColor:settings.onionAfterColor) : null;
        const styleKey=JSON.stringify([color,included?[...included]:null,hiddenKey,editor.layerRevision,sampleLayer,settings.onionMode]);
        let cache=this.styles.get(sample.geometry);if(!cache)this.styles.set(sample.geometry,cache=new Map());
        let geometry=cache.get(styleKey);
        if(!geometry){
          const rgb=color?.slice(1).match(/../g).map(value=>parseInt(value,16));
          const orderedObjects=sample.geometry.orderedObjects.filter(g=>(!included||included.has(g.obj.unique_id))&&!hidden.has(g.obj.unique_id)&&(settings.onionMode==='frames'||(sampleLayer?editor.layerForUid(g.obj.unique_id)===sampleLayer:!editor.getLayer(editor.layerForUid(g.obj.unique_id))?.drawing))).map(g=>{
            if(!rgb)return g;
            let styles=this.objectStyles.get(g);if(!styles)this.objectStyles.set(g,styles=new Map());
            let styled=styles.get(color);
            if(!styled){styled={...g,drawables:g.drawables.map(item=>({...item,rgb,onionTint:rgb,seg:item.seg?{...item.seg,secondary:null}:item.seg}))};styles.set(color,styled);while(styles.size>4)styles.delete(styles.keys().next().value);}
            return styled;
          });
          let drawables;
          geometry={objects:sample.geometry.objects,orderedObjects,get drawables(){return drawables??=orderedObjects.flatMap(g=>g.drawables);}};
          cache.set(styleKey,geometry);
          // One sampled scene can supply many independently timed layers.
          // Keep their wrappers warm without growing full-scene residency.
          const styleLimit=Math.max(4,report._styk?.layers?.order.length??0);
          while(cache.size>styleLimit)cache.delete(cache.keys().next().value);
        }
        frames.push({frame:sample.frame,geometry,opacity:settings.onionOpacity*(settings.onionFade?1/distance:1),showOnTop:settings.onionShowOnTop});
    }
    // Retain the currently displayed range as well as the small warm cache.
    // Evict after the batch: evicting while walking a range larger than the
    // warm cache repeatedly discarded samples still needed by that same batch.
    const cacheLimit=Math.max(this.maxEntries,activeSamples.size);
    while(this.samples.size>cacheLimit)this.samples.delete(this.samples.keys().next().value);
    this.last={signature,frames};return frames;
  }
}
