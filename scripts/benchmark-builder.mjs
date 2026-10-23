import {ConstructionIndex} from '../src/builder-construction.mjs';
import {Editor} from '../src/editor.mjs';
import {builderFixture} from './builder-benchmark-fixture.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const label=process.argv[2]||'baseline';const results=[];
const stats=a=>{a.sort((x,y)=>x-y);return {medianMs:a[Math.floor(a.length/2)],p95Ms:a[Math.ceil(a.length*.95)-1],maxMs:a.at(-1)};};
for(const [segments,instances] of [[1000,1],[5000,1],[15000,1],[100,500]]){
 const e=new Editor();e.load(builderFixture(segments,instances));e.select(1,0);
 const times={add:[],chain:[],style:[],drag:[],commit:[],snap:[]};
 for(let i=0;i<7;i++){
  e.select(1,0);let t=performance.now();e.addSegment({length:20,angle:.7});times.add.push(performance.now()-t);e.undo();
  e.select(1,0);t=performance.now();e.updateSegmentStyle({thickness:4+i});times.style.push(performance.now()-t);e.undo();
  e.select(1,0);e.beginRigDrag();const g=e.geometry.objects.get(0).segments[0];
  t=performance.now();e.editRigJoint(g.end.x+1,g.end.y+1);times.drag.push(performance.now()-t);t=performance.now();e.commitRigDrag();times.commit.push(performance.now()-t);e.undo();
  t=performance.now();e.addSegments(Array.from({length:32},()=>({length:20,angle:.7})));times.chain.push(performance.now()-t);e.undo();
  const index=new ConstructionIndex(e.geometry.objects.get(0));t=performance.now();for(let j=0;j<1000;j++)index.snap({x:480+(j%101),y:280+(j%59)},{radius:8,origin:{x:480,y:280}});times.snap.push((performance.now()-t)/1000);
 }
 results.push({segments,instances,visibleSegments:segments*instances,timings:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,stats(v)]))});
 console.log(JSON.stringify(results.at(-1)));
}
await mkdir('artifacts/builder-performance',{recursive:true});await writeFile(`artifacts/builder-performance/${label}.json`,JSON.stringify({runtime:process.version,results},null,2));
