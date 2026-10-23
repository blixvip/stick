/** Reconstruct complete comparisons from per-file results, including runs resumed
 * with a filter. Timing passes and input hashes remain available independently. */
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import path from 'node:path';

const base=path.resolve('artifacts/animation-corpus-60'),label=process.argv[2]||'final';
const inventory=JSON.parse(await readFile(path.join(base,'inventory.json'),'utf8'));
const inputs=[...new Map(inventory.files.map(f=>[f.sha256,f])).values()];
const read=filename=>readFile(filename,'utf8').then(JSON.parse,()=>null);
const resultRows=[],sourceRoots=new Set();
for(const file of inputs){
  const id=file.sha256.slice(0,16),before=await read(path.join(base,'exact-baseline',id,'report.json')),after=await read(path.join(base,label,id,'report.json'));
  if(after?.sourceRoot)sourceRoots.add(after.sourceRoot);
  const metrics=async(run,folder)=>{
    if(!run)return null;
    const raw=await read(path.join(base,folder,id,'playback.json'));
    const ticks=run.info?.sampledTicks??run.info?.ticks;
    const frames=raw?.presented?.filter(f=>f.tick<ticks)||[],intervals=frames.slice(1).map((f,i)=>({tick:f.tick,at:f.at,ms:f.at-frames[i].at}));
    const packets=new Map();
    for(const packet of raw?.packets||[]){if(!packets.has(packet.tick))packets.set(packet.tick,[]);packets.get(packet.tick).push(packet);}
    const contents=new Map((run.contents||[]).map(frame=>[frame.tick,frame]));
    return {complete:run.complete,sequential:run.sequential,ticks:run.info?.ticks,sampledTicks:ticks,coverage:run.info?.coverage||'all-ticks',
      fps:run.fps,p95:run.intervalP95,max:run.maxInterval,slow:run.slowIntervals,intervals:intervals.length,
      durationMs:intervals.reduce((n,i)=>n+i.ms,0),startupMs:raw?.performance.presentation?.startupMs,
      bufferingMs:raw?.performance.presentation?.bufferingMs,slowTicks:intervals.filter(i=>i.ms>25).map(interval=>{
        const p=packets.get(interval.tick)?.findLast(packet=>packet.at<=interval.at),c=contents.get(interval.tick);
        return {...interval,packet:p&&{compileMs:p.compileMs,bytes:p.bytes,groups:p.groups,rasters:p.rasters,shapes:p.shapes,timings:p.timings},
          contents:c&&{objects:c.objects,drawables:c.drawables,fadedObjects:c.fadedObjects,types:c.types}};
      }),
      reducedPackets:run.reducedPackets,reducedPresentations:run.reducedPresentations,maxPacketBytes:run.maxPacketBytes,
      errors:[...(run.errors||[]),...(run.error?[run.error]:[]),...(run.gestures?.error?[run.gestures.error]:[])],
      gestures:run.gestures,seeks:run.seeks,contents:run.contents};
  };
  resultRows.push({file:file.relative,sha256:file.sha256,aliases:inventory.files.filter(f=>f.sha256===file.sha256).map(f=>f.relative),
    before:await metrics(before,'exact-baseline'),after:await metrics(after,label)});
}
const eligible=resultRows.filter(r=>r.before?.complete&&r.before?.sequential&&r.after?.complete&&r.after?.sequential&&r.before.intervals&&r.after.intervals);
const sum=(rows,get)=>rows.reduce((n,r)=>n+(get(r)||0),0);
const summarize=key=>({files:eligible.length,intervals:sum(eligible,r=>r[key].intervals),
  weightedFps:sum(eligible,r=>r[key].intervals)*1000/sum(eligible,r=>r[key].durationMs),
  slowIntervals:sum(eligible,r=>r[key].slow),
  zeroStallFiles:eligible.filter(r=>r[key].slow===0).length});
const failed=resultRows.filter(r=>!r.after?.complete||!r.after?.sequential||r.after.errors.length||['pan','pose'].some(k=>r.after.gestures?.[k]?.error));
const sourceHashes={};
async function hashTree(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const filename=path.join(directory,entry.name),relative=prefix+entry.name;
    if(entry.isDirectory())await hashTree(filename,relative+'/');
    else if(entry.isFile())sourceHashes[relative]=createHash('sha256').update(await readFile(filename)).digest('hex');
  }
}
const sourceRoot=[...sourceRoots][0];
if(!sourceRoot||sourceRoots.size!==1)throw new Error('A comparison needs one immutable measured source tree.');
await hashTree(path.join(sourceRoot,'src'),'src/');
sourceHashes['index.html']=createHash('sha256').update(await readFile(path.join(sourceRoot,'index.html'))).digest('hex');
const sourceMismatches=[];
for(const [file,hash] of Object.entries(sourceHashes))if(createHash('sha256').update(await readFile(file)).digest('hex')!==hash)sourceMismatches.push(file);
const inputMismatches=[];
for(const file of inventory.files){
  const hash=createHash('sha256');for await(const chunk of createReadStream(file.path))hash.update(chunk);
  if(hash.digest('hex')!==file.sha256)inputMismatches.push(file.relative);
}
const comparison={at:new Date().toISOString(),label,inputPaths:inventory.files.length,uniqueInputs:inputs.length,
  before:summarize('before'),after:summarize('after'),failed:failed.map(r=>r.file),sourceRoot,sourceMismatches,sourceHashes,inputMismatches,results:resultRows};
await writeFile(path.join(base,'comparison.json'),JSON.stringify(comparison,null,2));
const csv=values=>values.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');
await writeFile(path.join(base,'comparison.csv'),[
  csv(['file','sha256','ticks','measured ticks','baseline FPS','optimized FPS','baseline intervals >25ms','optimized intervals >25ms','optimized max interval ms','baseline startup ms','optimized startup ms','baseline node submit p95 ms','optimized node submit p95 ms','errors']),
  ...resultRows.map(r=>csv([r.file,r.sha256,r.after?.ticks,r.after?.sampledTicks,r.before?.fps,r.after?.fps,r.before?.slow,r.after?.slow,r.after?.max,r.before?.startupMs,r.after?.startupMs,r.before?.gestures?.pose?.submit?.p95,r.after?.gestures?.pose?.submit?.p95,r.after?.errors.join(' | ')]))].join('\n')+'\n');
await writeFile(path.join(base,'slow-ticks.csv'),[csv(['file','run','tick (zero-based)','interval ms','packet preparation ms','packet bytes','packet groups','raster groups','GPU shape commands','geometry ms','inspected figures','inspected drawables','inspected faded figures']),
  ...resultRows.flatMap(r=>['before','after'].flatMap(key=>(r[key]?.slowTicks||[]).map(t=>csv([r.file,key,t.tick,t.ms,t.packet?.compileMs,t.packet?.bytes,t.packet?.groups,t.packet?.rasters,t.packet?.shapes,t.packet?.timings?.geometryMs,t.contents?.objects,t.contents?.drawables,t.contents?.fadedObjects]))))].join('\n')+'\n');
const number=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'—';
const table=resultRows.map(r=>`| ${r.file.replaceAll('\\','/')} | ${r.after?.ticks??'—'} | ${r.before?.complete?number(r.before.fps):'Stopped'} | ${number(r.after?.fps)} | ${r.before?.slow??'—'} → ${r.after?.slow??'—'} | ${number(r.after?.max,1)} | ${number(r.after?.startupMs,0)} |`).join('\n');
await writeFile(path.join(base,'comparison-table.md'),`| Project | Ticks | Before FPS | After FPS | Intervals >25 ms | After max ms | After startup ms |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${table}\n`);
console.log(JSON.stringify({before:comparison.before,after:comparison.after,failed:comparison.failed,sourceMismatches,inputMismatches},null,2));
if(failed.length||sourceMismatches.length||inputMismatches.length)process.exitCode=1;
