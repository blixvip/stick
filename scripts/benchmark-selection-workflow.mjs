/** Compare identical dense selection work with the pre-change canvas algorithms.
 * Run before committing, or pass an explicit baseline Git ref as the first arg.
 * This measures CPU hit testing, not GPU throughput or complete frame latency.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {figureIntersectsMarquee,getPivotHandles,pickCanvasHandle} from '../src/canvas-interactions.mjs';
const baselineRef=process.argv[2]??'HEAD';
const baseline=await import('data:text/javascript;base64,'+execFileSync('git',['show',baselineRef+':src/canvas-interactions.mjs']).toString('base64'));
const baselineCommit=execFileSync('git',['rev-parse',baselineRef],{encoding:'utf8'}).trim();
const objects=Array.from({length:5000},(_,i)=>{
  const root={x:(i%100)*30,y:Math.floor(i/100)*30};
  return {root,box:{minX:root.x-5,minY:root.y-5,maxX:root.x+60,maxY:root.y+90}};
});
const rect={left:800,right:1600,top:200,bottom:850},project=p=>({x:p.x*.8+10,y:p.y*.8+20}),boundsOf=g=>g.box;
function oldBounds(g) {
  const box=boundsOf(g),points=[project({x:box.minX,y:box.minY}),project({x:box.maxX,y:box.minY}),project({x:box.maxX,y:box.maxY}),project({x:box.minX,y:box.maxY})];
  return Math.max(...points.map(p=>p.x))>=rect.left&&Math.min(...points.map(p=>p.x))<=rect.right&&Math.max(...points.map(p=>p.y))>=rect.top&&Math.min(...points.map(p=>p.y))<=rect.bottom;
}
const boundsOptions={project,boundsOf},originOptions={mode:'origins',project,boundsOf};
const modes={before:g=>oldBounds(g),bounds:g=>figureIntersectsMarquee(g,rect,boundsOptions),origins:g=>figureIntersectsMarquee(g,rect,originOptions)};
for(const g of objects)assert.equal(modes.before(g),modes.bounds(g));
const samples=Object.fromEntries(Object.keys(modes).map(k=>[k,[]]));
for(let round=0;round<120;round++)for(const name of (round%2?Object.keys(modes).reverse():Object.keys(modes))) {
  const start=performance.now();let count=0;for(const g of objects)count+=Number(modes[name](g));
  if(round>=20)samples[name].push(performance.now()-start);
  assert.ok(count>0);
}
const summarize=values=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length*.5)],p95Ms:values[Math.floor(values.length*.95)]};};
const count=30000,g={slot:0,obj:{unique_id:101,scale:1},root:{x:-100,y:-100}};
g.segments=Array.from({length:count},(_,i)=>({index:i,static:i%30!==0,seg:{segment_id:i+1,parent_id:0,length:20,thickness:2},end:{x:(i%300)*20,y:Math.floor(i/300)*20}}));
g.fig={segments:g.segments.map(s=>s.seg)};
const geometry={objects:new Map([[0,g]]),orderedObjects:[g]},handles=getPivotHandles(geometry,{selectStatic:true});
const picks={before:baseline.pickCanvasHandle,after:pickCanvasHandle},pickSamples={before:[],after:[]};
for(let i=0;i<1500;i++)for(const name of Object.keys(picks)){
  const index=(i*31)%count,start=performance.now();
  const hit=picks[name](geometry,g.segments[index].end,{handles,spatial:true,minRadius:8,nearest:true});
  if(i>=100)pickSamples[name].push(performance.now()-start);
  assert.equal(hit.id,index+1);
}
const report={node:process.version,baselineCommit,figures:objects.length,marquee:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,summarize(v)])),handleCount:count,handlePicking:Object.fromEntries(Object.entries(pickSamples).map(([k,v])=>[k,summarize(v)]))};
await mkdir('artifacts/selection-workflow',{recursive:true});await writeFile('artifacts/selection-workflow/performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
