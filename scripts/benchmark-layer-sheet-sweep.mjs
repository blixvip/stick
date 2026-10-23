/** Current layer-sheet costs, including partial authoring and unrelated keys.
 * Model-only timings exclude fixture construction, assertions and serialization.
 * Run sequentially on an idle machine; this does not measure presentation or FPS.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {createLayerState} from '../src/layers.mjs';
import {sampleLayerSheet,validateLayerSheet} from '../src/layer-sheet.mjs';
import {buildGeometry,evaluatedFrame,evaluatedNativeFrame} from '../src/pivot/geometry.mjs';

const label=process.argv[2]??'current';
if(!/^[a-z0-9-]+$/i.test(label))throw new Error('Use an alphanumeric run label.');
const repeats=Number(process.env.STYK_SWEEP_SAMPLES??11),batch=Number(process.env.STYK_SWEEP_SAMPLE_BATCH??10);
if(!Number.isInteger(repeats)||repeats<3||repeats>100||!Number.isInteger(batch)||batch<1||batch>100)
  throw new Error('Choose 3–100 samples and a sampling batch of 1–100 operations.');
const output=path.resolve('artifacts/performance-sweep/layer-sheet',`${label}.json`);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const yieldControl=()=>new Promise(resolve=>setImmediate(resolve));
function summary(rawMs,operationsPerSample=1){
  const ordered=rawMs.map(ms=>ms/operationsPerSample).sort((a,b)=>a-b),at=q=>ordered[Math.min(ordered.length-1,Math.ceil(ordered.length*q)-1)];
  return {samples:rawMs.length,operationsPerSample,rawMs,p50Ms:at(.5),p95Ms:at(.95),maxMs:ordered.at(-1)};
}
async function sourceHashes(directory='src'){
  const result={};
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const name=path.join(directory,entry.name);
    if(entry.isDirectory())Object.assign(result,await sourceHashes(name));
    else if(entry.name.endsWith('.mjs')||entry.name.endsWith('.js'))result[name.replaceAll('\\','/')]=hash(await readFile(name,'utf8'));
  }
  return result;
}
function git(args){try{return execFileSync('git',args,{encoding:'utf8'}).trim();}catch{return null;}}
function fixture({layers,figures,editedKeys=2,otherKeys=editedKeys,fixedKeys=otherKeys}){
  assert.ok(figures>=layers,'Every tested layer must own at least one figure.');
  const report=emptyDocument(),figure=report.figure_types[0],state=createLayerState();
  state.order=Array.from({length:layers},(_,i)=>`layer-${i+1}`);
  state.byId=Object.fromEntries(state.order.map((id,i)=>[id,{name:`Layer ${i+1}`,visible:true,locked:false}]));
  state.nextId=layers+1;
  for(let uid=1;uid<=figures;uid++)state.assignments[uid]=state.order[(uid-1)%layers];
  const count=Math.max(editedKeys,otherKeys,fixedKeys),duration=count*2+1;
  // A static native pose isolates composition and publication from interpolation
  // complexity. Each frame owns its vectors; no authoring aliases are introduced.
  const makeObjects=()=>Array.from({length:figures},(_,slot)=>createObject(figure,slot+1,100+(slot%64)*5,100+Math.floor(slot/64)*5));
  report.keyframes=[createFrame(makeObjects(),count*2),createFrame(makeObjects(),1)];
  let serial=1;
  const track=keys=>({end:duration,keys:Array.from({length:keys},(_,i)=>({id:`cell-${serial++}`,tick:i*2,sourceTick:i*2,interpolation:'linear'}))});
  report._styk={...report._styk,layers:state,layerSheet:{version:1,duration,nextId:1,tracks:Object.fromEntries([
    ['scene',track(fixedKeys)],['camera',track(fixedKeys)],...state.order.map((id,i)=>[id,track(i?otherKeys:editedKeys)]),
  ])}};
  report._styk.layerSheet.nextId=serial;
  const editor=new Editor({demo:false,propertyChannels:true,layerTimeline:true,historyLimit:80}).load(report);
  editor.seek(1);editor.select(1);
  return editor;
}
function pose(frame){return frame.objects.map(object=>({uid:object.unique_id,x:object.root_x,y:object.root_y})).sort((a,b)=>a.uid-b.uid);}
function assertPose(frame,figures,shift=0){
  const records=pose(frame);assert.equal(records.length,figures);assert.equal(new Set(records.map(record=>record.uid)).size,figures);
  for(const record of records){const slot=record.uid-1;assert.equal(record.x,100+(slot%64)*5+(record.uid===1?shift:0));assert.equal(record.y,100+Math.floor(slot/64)*5);}
}
function currentDocumentHash(editor){return hash(editor.serialize());}
function measure(action){const started=performance.now(),value=action();return {ms:performance.now()-started,value};}
function sample(editor,tick){return evaluatedFrame(editor.report,0,tick/(editor.timeline[0]?.count??1),tick);}
async function sampleTimings(editor,config){
  const ticks=[.25,.5,.75,1.25,1.5,1.75,2.25,2.5,2.75,3.25],raw=[],history=editor._undo.length;
  const first=measure(()=>sample(editor,.125));assertPose(first.value,config.figures);
  for(let i=0;i<repeats;i++){
    await yieldControl();
    const result=measure(()=>{let frame;for(let j=0;j<batch;j++)frame=sample(editor,ticks[(i+j)%ticks.length]);return frame;});
    raw.push(result.ms);assertPose(result.value,config.figures);
  }
  assert.equal(editor._undo.length,history,'Evaluation must not author animation or history.');
  return {coldMs:first.ms,warm:summary(raw,batch)};
}
function accessProbe(config,partiallyAuthored){
  const editor=fixture(config);if(partiallyAuthored)editor.sheetInsertKey(['layer-1'],1);
  let identityReads=0;
  const native=editor.report.keyframes[0],instrumented={...native,objects:native.objects.map(object=>new Proxy(object,{
    get(target,key,receiver){if(key==='unique_id')identityReads++;return Reflect.get(target,key,receiver);},
  }))};
  // Count accesses separately from timing. Returning one shared static source
  // deliberately isolates the native-source composition loop, not interpolation.
  const frame=sampleLayerSheet(editor.report,.5,{sampleLegacy:()=>instrumented,sampleNative:evaluatedNativeFrame,resolveGeometry:buildGeometry});
  const accesses=identityReads;assertPose(frame,config.figures);
  editor.drawingResources.dispose();
  return {nativeObjectIdentityReads:accesses,partiallyAuthored,scope:'composition only; instrumentation is excluded from latency samples'};
}
async function samplingCase(config){
  globalThis.gc?.();const editor=fixture(config),nativeHash=hash(editor.report.keyframes),before=currentDocumentHash(editor),unrelated=editor.report._styk.layerSheet.tracks['layer-2'];
  const memoryBefore=process.memoryUsage(),imported=await sampleTimings(editor,config);
  editor.sheetInsertKey(['layer-1'],1);
  if(unrelated)assert.equal(editor.report._styk.layerSheet.tracks['layer-2'],unrelated,'An unchanged track must keep its identity.');
  assert.equal(hash(editor.report.keyframes),nativeHash,'Authoring must preserve native source poses.');
  const after=currentDocumentHash(editor),partial=await sampleTimings(editor,config);
  editor.undo();assert.equal(currentDocumentHash(editor),before);editor.redo();assert.equal(currentDocumentHash(editor),after);
  validateLayerSheet(editor.report);globalThis.gc?.();const memoryAfter=process.memoryUsage();
  const result={config,documentHashes:{before,after},timings:{imported,partial},accessProbes:{imported:accessProbe(config,false),partial:accessProbe(config,true)},
    memory:{before:memoryBefore,after:memoryAfter,retainedHeapDeltaBytes:memoryAfter.heapUsed-memoryBefore.heapUsed},
    invariants:{sameVisibleRoots:true,nativePosesUnchanged:true,unrelatedTrackIdentityPreserved:true,exactUndoRedo:true,evaluationDoesNotAuthor:true}};
  editor.drawingResources.dispose();return result;
}
async function commandCase(config,kind){
  globalThis.gc?.();const editor=fixture(config),before=currentDocumentHash(editor),nativeHash=hash(editor.report.keyframes),raw={begin:[],preview:[],commit:[],undo:[],redo:[]},historyBytes=[],commandBytes=[],memoryBefore=process.memoryUsage();
  for(let i=0;i<repeats;i++){
    await yieldControl();editor.seek(1);editor.select(1);
    const previous=editor.report._styk.layerSheet,unrelated=previous.tracks['layer-2'],changedTrack=previous.tracks['layer-1'];
    if(kind==='pose'){
      const begin=measure(()=>editor.beginTranslationDrag());assert.equal(begin.value,true);raw.begin.push(begin.ms);
      const preview=measure(()=>editor.moveSelection(1,0));raw.preview.push(preview.ms);
    }
    const committed=measure(()=>kind==='pose'?editor.commitDrag():editor.sheetInsertKey(['layer-1'],1));
    assert.equal(committed.value,true);raw.commit.push(committed.ms);
    const next=editor.report._styk.layerSheet.tracks['layer-1'];
    assert.notEqual(next,changedTrack);assert.ok(next.keys.some(key=>key.tick===1));
    if(unrelated)assert.equal(editor.report._styk.layerSheet.tracks['layer-2'],unrelated);
    const after=currentDocumentHash(editor);
    assertPose(sample(editor,1),config.figures,kind==='pose'?1:0);
    assert.equal(hash(editor.report.keyframes),nativeHash);
    commandBytes.push(editor._undo.at(-1).bytes);historyBytes.push(editor.historySize);
    raw.undo.push(measure(()=>editor.undo()).ms);assert.equal(currentDocumentHash(editor),before);
    assertPose(sample(editor,1),config.figures);
    raw.redo.push(measure(()=>editor.redo()).ms);assert.equal(currentDocumentHash(editor),after);
    assertPose(sample(editor,1),config.figures,kind==='pose'?1:0);
    editor.undo();assert.equal(currentDocumentHash(editor),before);
  }
  validateLayerSheet(editor.report);globalThis.gc?.();const memoryAfter=process.memoryUsage();
  const result={config,kind,baselineDocumentHash:before,totalKeys:Object.values(editor.report._styk.layerSheet.tracks).reduce((count,track)=>count+track.keys.length,0),
    figuresInEditedLayer:Math.ceil(config.figures/config.layers),timings:Object.fromEntries(Object.entries(raw).filter(([,values])=>values.length).map(([name,values])=>[name,summary(values)])),
    rawCommandBytes:commandBytes,rawHistoryBytes:historyBytes,memory:{before:memoryBefore,after:memoryAfter,retainedHeapDeltaBytes:memoryAfter.heapUsed-memoryBefore.heapUsed},
    invariants:{exactUndoRedo:true,unrelatedTracksPreserved:true,nativePosesUnchanged:true,expectedVisiblePose:true,insertedBoundaryAtRequestedTick:true}};
  editor.drawingResources.dispose();return result;
}

const report={label,measuredAt:new Date().toISOString(),environment:{node:process.version,versions:process.versions,cpu:os.cpus()[0]?.model,
  logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),platform:process.platform,arch:process.arch,gcAvailable:Boolean(globalThis.gc)},
  git:{head:git(['rev-parse','HEAD']),status:git(['status','--short'])},settings:{repeats,batch},sourceHashes:await sourceHashes(),sampling:[],commands:[],errors:[],
  limitations:['Synthetic static ten-segment figures; no raster assets, movieclips, IK or GPU work.',
    'Model-only durations include synchronous editor work but exclude DOM listeners and presentation.',
    'Sampling batches reduce clock noise; p95 is across batches, not individual input events.',
    'Heap deltas include retained history/caches and GC effects; they are not peak whole-app memory.']};
report.sourceHashes['scripts/benchmark-layer-sheet-sweep.mjs']=hash(await readFile('scripts/benchmark-layer-sheet-sweep.mjs','utf8'));
await mkdir(path.dirname(output),{recursive:true});
const save=()=>writeFile(output,JSON.stringify(report,null,2));
try{
  for(const figures of [1000,4000])for(const layers of [1,8,32,128]){
    const config={layers,figures,editedKeys:2,otherKeys:2,fixedKeys:2};
    console.log(`sample: ${figures} figures / ${layers} layers`);
    const result=await samplingCase(config);report.sampling.push(result);await save();
    console.log(JSON.stringify({config,importedMs:result.timings.imported.warm.p50Ms,partialMs:result.timings.partial.warm.p50Ms,accessProbes:result.accessProbes}));
  }
  const commandConfigs=[
    ...[100,1000,10000].map(keys=>({family:'all-key-count',layers:10,figures:100,editedKeys:keys,otherKeys:keys,fixedKeys:2})),
    ...[100,1000,10000].map(keys=>({family:'unrelated-key-count',layers:16,figures:100,editedKeys:100,otherKeys:keys,fixedKeys:2})),
    ...[1,8,32,128].map(layers=>({family:'layer-count',layers,figures:2000,editedKeys:2,otherKeys:2,fixedKeys:2})),
  ];
  for(const config of commandConfigs)for(const kind of ['key','pose']){
    console.log(`${kind}: ${config.family} / ${JSON.stringify(config)}`);
    const result=await commandCase(config,kind);report.commands.push(result);await save();
    console.log(JSON.stringify({kind,config,totalKeys:result.totalKeys,timings:Object.fromEntries(Object.entries(result.timings).map(([name,value])=>[name,{p50Ms:value.p50Ms,p95Ms:value.p95Ms}]))}));
  }
}catch(error){report.errors.push(error.stack??String(error));process.exitCode=1;console.error(error);}
report.completedAt=new Date().toISOString();await save();console.log(`Report: ${output}`);
