/** Per-frame entry point shared by every renderer: the editor viewport, camera
 * surfaces, playback workers, thumbnails and export. One batch is built per
 * evaluated frame and document state, however many passes draw it. */
import {buildGeneratorBatch,generatorSchedule,scheduleWalker,RECORD_FLOATS} from './vfx-generators.mjs';
import {GeneratorAnchors} from './vfx-generator-anchors.mjs';
import {evaluationGeneration} from './pivot/geometry.mjs';
import {drawGeneratorDraws} from './vfx-generator-canvas.mjs';
import {layerVisible} from './layers.mjs';

const anchors=new GeneratorAnchors(),batches=new WeakMap();
export const generatorAnchorStats=()=>({...anchors.stats,entries:anchors.entries.size});

const nestedIndex=new WeakMap();
/** Movieclip containers whose documents carry generated effects. */
function hasNestedGenerators(geometry){
 const objects=geometry.objects;if(!objects)return false;let known=nestedIndex.get(objects);
 if(known===undefined){known=false;for(const g of objects.values())if(g?.nestedGenerators){known=true;break;}nestedIndex.set(objects,known);}
 return known;
}
/** The generator batch for an evaluated frame, or null. `density` thins
 * particles for preview budgets; the result is always a subset of density 1. */
export function generatorBatchFor(report,frame,geometry,{density=1,enabled=true,budgetMs=Infinity}={}){
 if(!enabled||!report||!frame||!geometry)return null;
 const clips=report._styk?.vfxClips;
 if(!(clips?.clips?.length&&frame._vfxTimelineTick!==undefined)&&!hasNestedGenerators(geometry))return null;
 const generation=evaluationGeneration(report),objects=geometry.objects;
 let entry=batches.get(frame);
 if(!entry||entry.objects!==objects||entry.clips!==clips||entry.generation!==generation){entry={objects,clips,generation,byDensity:new Map()};batches.set(frame,entry);}
 if(entry.byDensity.has(density))return entry.byDensity.get(density);
 // An interactive budget may leave trail samples for later frames; such a
 // batch is drawn once and rebuilt until it is complete.
 anchors.begin(budgetMs);
 let batch;try{batch=buildGeneratorBatch(report,frame,geometry,{sampler:anchors,density});}finally{anchors.begin();}
 if(!batch?.incomplete)entry.byDensity.set(density,batch);
 return batch;
}
/** Uncached sampling allowed per interactive frame, in milliseconds. */
export const INTERACTIVE_SAMPLING_MS=6;
/** Software preview keeps at most `budget` particles, always a subset of the
 * full effect. Export and GPU rendering never pass a budget. */
export const SOFTWARE_PARTICLE_BUDGET=4000;
export function budgetedGeneratorBatch(report,frame,geometry,{enabled=true,budget=Infinity,budgetMs=Infinity}={}){
 const full=generatorBatchFor(report,frame,geometry,{enabled,budgetMs});
 if(!full||full.particles<=budget)return full;
 const thin=generatorBatchFor(report,frame,geometry,{enabled,budgetMs,density:Math.max(.05,Math.round(budget/full.particles*20)/20)});
 return thin&&full.incomplete&&!thin.incomplete?{...thin,incomplete:true}:thin;
}
/** A copy whose draws move by per-target offsets (layer parallax, live drags),
 * added to any offsets already applied. Returns the same batch when all are zero. */
export function offsetGeneratorBatch(batch,offsetFor){
 if(!batch||!offsetFor)return batch;
 let records=null;
 for(const draw of batch.draws){
  if(draw.uid===null)continue;
  const d=offsetFor(draw.uid);if(!d||!d.x&&!d.y)continue;
  records??=batch.records.slice();const o=draw.record*RECORD_FLOATS;records[o+48]+=d.x;records[o+49]+=d.y;
 }
 return records?{...batch,records}:batch;
}
/** Canvas paths receive drawables already filtered for visibility. A target
 * with artwork of which none was passed is hidden, and so are its effects. */
export function canvasGenerators(report,frame,geometry,offsetFor,{hidden,budget=Infinity}={}){
 const base=budgetedGeneratorBatch(report,frame,geometry,{budget});if(!base)return null;
 if(!hidden){
  const drawn=new Set(),art=new Set();
  for(const item of geometry.drawables)drawn.add(item.obj.unique_id);
  for(const g of geometry.orderedObjects??[])if(g.drawables?.length)art.add(g.obj.unique_id);
  hidden={has:uid=>!layerVisible(report,uid)||art.has(uid)&&!drawn.has(uid)};
 }
 return {batch:offsetGeneratorBatch(base,offsetFor),hidden};
}
/** A walker that draws generator effects between figure runs on `ctx`. */
export function canvasGeneratorWalker(generators,ctx){
 if(!generators)return null;const plan=generatorSchedule(generators.batch,generators.hidden);if(plan.empty)return null;
 return scheduleWalker(plan,draws=>drawGeneratorDraws(ctx,generators.batch,draws));
}
export {generatorSchedule,scheduleWalker};
