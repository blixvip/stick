import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {connectedVfxGeometry} from '../src/vfx-connected.mjs';
import {createVfx} from '../src/vfx.mjs';

// Same dense assembly, with and without fifteen foreign painter entries.
// Timings isolate grouping from native evaluation and asynchronous GPU work.
const results=[];
for(const interleaved of [false,true]){
 const report=emptyDocument(),fig=report.figure_types[0],base=fig.segments[0];
 fig.segments=Array.from({length:100},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:30+i,angle_rad:i*Math.PI*2/100,thickness:6,z_order:i+1}));fig.segment_count=100;
 const objects=Array.from({length:105},(_,i)=>createObject(fig,i+1,320,240,{scale:.4+i/175,join:i?{target_object_slot:0,target_unique_id:1,target_handle_id:0}:null}));
 objects[0]._stykVfxScope=1;objects[0]._stykVfx={figure:[createVfx('glow','glow')]};
 if(interleaved)for(let i=0;i<15;i++)objects.push(createObject(fig,106+i,500+i,240));
 const cold=[],cached=[];let runs;
 for(let sample=0;sample<35;sample++){
  const frame=createFrame(structuredClone(objects),1);frame.objects[1].angles[1]+=.01*sample;
  if(interleaved){frame.object_draw_order=[];for(let slot=0;slot<105;slot++){frame.object_draw_order.push(slot);if(slot%7===3)frame.object_draw_order.push(105+Math.floor(slot/7));}}
  report.keyframes=[frame];const raw=buildGeometry(report,frame),start=performance.now(),view=connectedVfxGeometry(raw,frame,report),elapsed=performance.now()-start;
  runs=view.orderedObjects.length;assert.equal(runs,interleaved?31:1);assert.equal(view.warnings.length,0);
  const warm=performance.now();for(let i=0;i<100;i++)assert.equal(connectedVfxGeometry(raw,frame,report),view);
  if(sample>=5){cold.push(elapsed);cached.push((performance.now()-warm)/100);}
 }
 const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
 results.push({interleaved,assemblyFigures:105,assemblySegments:10500,foreignFigures:interleaved?15:0,renderGroups:runs,samples:30,coldGroupingP95Ms:p95(cold),cachedGroupingP95Ms:p95(cached)});
}
await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/interleaved-performance.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
