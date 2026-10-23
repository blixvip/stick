import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import {rigExampleDocument,RIG_EXAMPLES} from '../src/rig-examples.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {rigConstraintPlan} from '../src/rig-constraints.mjs';
const results=[];
for(const count of [1000,5000,20000])for(const constrained of [false,true]){
  const doc=rigExampleDocument('sliding-carriage'),fig=doc.figure_types[0],o=doc.keyframes[0].objects[0],base=fig.segments[0];
  fig.segments=Array.from({length:count},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:constrained&&i>1?.5:100,angle_rad:i*.017,thickness:3,
    ...(constrained&&i>1?{_stykRig:{connector:{start:i===2?1:i,end:2,restLength:100}}}:{})}));
  fig.segment_count=count;o.angles=fig.segments.map(s=>s.angle_rad);o.len_flag=0;o.lengths=[];
  const compile=performance.now();if(constrained)rigConstraintPlan(fig);const compileMs=performance.now()-compile;
  for(let i=0;i<5;i++)buildGeometry(doc,doc.keyframes[0]);
  global.gc?.();const memoryBefore=process.memoryUsage().heapUsed,times=[];
  for(let i=0;i<30;i++){o.angles[1]=i*.01;const start=performance.now();const geometry=buildGeometry(doc,doc.keyframes[0]);times.push(performance.now()-start);if(geometry.objects.get(0).segments.length!==count)throw new Error('Incomplete dense geometry');}
  global.gc?.();times.sort((a,b)=>a-b);results.push({segments:count,constrained,compileMs,medianMs:times[15],p95Ms:times[28],retainedHeapDeltaBytes:process.memoryUsage().heapUsed-memoryBefore});
}
const examples=RIG_EXAMPLES.map(r=>{
  const report=rigExampleDocument(r.id),frame=report.keyframes[0],o=frame.objects[0],times=[];
  for(let i=0;i<200;i++){o.angles[r.control-1]=i*.03;const start=performance.now();buildGeometry(report,frame);if(i>=20)times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);return {id:r.id,segments:report.figure_types[0].segments.length,medianMs:times[90],p95Ms:times[171]};
});
const solids=[];
for(const culling of [false,true]){
  const ids=RIG_EXAMPLES.filter(r=>r.id.startsWith('solid-')).map(r=>r.id),parts=ids.map(rigExampleDocument),doc=structuredClone(parts[0]);
  doc.figure_types=parts.map((d,i)=>({...d.figure_types[0],figure_type_id:i+1}));
  if(!culling)for(const f of doc.figure_types)for(const p of f.polyfills)delete p._stykSurface;
  const frame=doc.keyframes[0];frame.objects=Array.from({length:100},(_,i)=>({...structuredClone(parts[i%parts.length].keyframes[0].objects[0]),unique_id:i+1,object_slot:i,figure_type_id:i%parts.length+1,root_x:(i%10)*300,root_y:Math.floor(i/10)*300}));
  frame.object_draw_order=frame.objects.map((_,i)=>i);const times=[];let count=0;
  for(let i=0;i<45;i++){for(const o of frame.objects)o.angles[0]=i*.05;const start=performance.now(),g=buildGeometry(doc,frame);if(i>=10)times.push(performance.now()-start);count=g.drawables.length;}
  times.sort((a,b)=>a-b);solids.push({objects:100,culling,visibleFaces:count,medianMs:times[17],p95Ms:times[33]});
}
await mkdir('artifacts/rig-constraints',{recursive:true});await writeFile('artifacts/rig-constraints/benchmark.json',JSON.stringify({node:process.version,platform:process.platform,results,examples,solids},null,2));console.table(results);console.table(examples);console.table(solids);
