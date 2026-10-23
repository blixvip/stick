/** Isolated layer-sheet before/current comparison in one process. Run on an idle
 * machine with --expose-gc; fixture setup, GC and assertions are never timed.
 * node --expose-gc scripts/benchmark-layer-sheet-comparison.mjs <output.json> [35ebad9b]
 * Add --cases=commands to run only the five command cases.
 * node scripts/benchmark-layer-sheet-comparison.mjs --verify-existing <partial.json> <verified.json>
 * Both module graphs share captured current dependencies; only the two sheet
 * owner modules are replaced by Git bytes in the control. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const verificationOnly=process.argv[2]==='--verify-existing';
const existing=verificationOnly?JSON.parse(await readFile(path.resolve(process.argv[3]),'utf8')):null;
const output=path.resolve(verificationOnly?process.argv[4]:process.argv[2]??'artifacts/performance-improvements/layer-sheet-comparison.json');
const ref=verificationOnly?existing.control.ref:process.argv[3]??'35ebad9b';
const selection=verificationOnly?'verify':process.argv[4]?.replace(/^--cases=/,'')??'all';
if(!verificationOnly&&!['all','sampling','commands','dense-pose','unrelated-keys','affected-keys'].includes(selection))throw new Error('Choose --cases=all, sampling, commands, dense-pose, unrelated-keys or affected-keys.');
if(!/^[a-f0-9]{7,40}$/i.test(ref))throw new Error('The frozen control reference must be a commit hash.');
if(!verificationOnly&&!globalThis.gc)throw new Error('Run this benchmark with node --expose-gc.');
const root=process.cwd(),snapshotRoot=verificationOnly?path.dirname(path.resolve(existing.production.directory)):
  path.resolve('artifacts/performance-improvements/control-sheets',ref,`${Date.now()}-${randomUUID()}`);
const production=verificationOnly?path.resolve(existing.production.directory):path.join(snapshotRoot,'production');
const control=verificationOnly?path.resolve(existing.control.directory):path.join(snapshotRoot,'control');
const frozenOwners=['src/editor-layer-sheet.mjs','src/layer-sheet.mjs'];
const warmupPairs=3,measuredPairs=7,batch=3;
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
const controlCommit=git(['rev-parse',`${ref}^{commit}`]),objectFormat=git(['rev-parse','--show-object-format']);
const gitBlob=bytes=>createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
async function treeHashes(directory){
  const result={};
  async function visit(relative){
    for(const entry of (await readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(relative,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()){
        const bytes=await readFile(path.join(directory,file));
        result[file.replaceAll('\\','/')]={sha256:hash(bytes),gitBlob:gitBlob(bytes),bytes:bytes.length};
      }
    }
  }
  await visit('src');await visit('vendor');return result;
}
const sourceChanges=(before,after)=>[...new Set([...Object.keys(before),...Object.keys(after)])].filter(file=>before[file]?.sha256!==after[file]?.sha256);
async function prepareSnapshots(live){
  for(const file of Object.keys(live)){
    const source=path.join(root,file),captured=path.join(production,file),frozen=path.join(control,file);
    await mkdir(path.dirname(captured),{recursive:true});await copyFile(source,captured);
    await mkdir(path.dirname(frozen),{recursive:true});await copyFile(captured,frozen);
  }
  for(const file of frozenOwners){
    const bytes=execFileSync('git',['show',`${controlCommit}:${file}`]);
    assert.equal(gitBlob(bytes),git(['rev-parse',`${controlCommit}:${file}`]),`Git returned different bytes for ${file}.`);
    await writeFile(path.join(control,file),bytes);
  }
  const snapshots={control:await treeHashes(control),production:await treeHashes(production)};
  const liveAfter=await treeHashes(root);
  for(const file of frozenOwners){
    assert.deepEqual(snapshots.production[file],live[file],`Sheet source changed while capturing the snapshot: ${file}`);
    assert.deepEqual(liveAfter[file],live[file],`Live sheet source changed while preparing the snapshots: ${file}`);
  }
  assert.equal(Object.keys(snapshots.control).length,Object.keys(live).length);
  for(const [file,source] of Object.entries(snapshots.control)){
    if(frozenOwners.includes(file))assert.equal(source.gitBlob,git(['rev-parse',`${controlCommit}:${file}`]),`Frozen owner differs from Git: ${file}`);
    else assert.deepEqual(source,snapshots.production[file],`Shared dependency differs between isolated graphs: ${file}`);
  }
  return {...snapshots,preparationLiveSourceChanges:sourceChanges(live,liveAfter),capturedDependencyDifferences:sourceChanges(live,snapshots.production),
    verification:{gitObjectFormat:objectFormat,frozenOwnersMatchGit:true,
      sharedFilesByteIdentical:Object.keys(live).length-frozenOwners.length,productionOwnersMatchCapturedLiveBytes:true}};
}
async function modules(directory){
  const [editor,demo,layers,sheet,geometry]=await Promise.all(['editor.mjs','demo.mjs','layers.mjs','layer-sheet.mjs','pivot/geometry.mjs'].map(file=>import(pathToFileURL(path.join(directory,'src',file)).href)));
  return {...editor,...demo,...layers,...sheet,...geometry};
}
function fixture(api,{layers,figures,editedKeys=2,otherKeys=editedKeys,fixedKeys=otherKeys}){
  assert.ok(figures>=layers,'Each tested layer must own at least one figure.');
  const report=api.emptyDocument(),figure=report.figure_types[0],state=api.createLayerState();
  state.order=Array.from({length:layers},(_,i)=>`layer-${i+1}`);
  state.byId=Object.fromEntries(state.order.map((id,i)=>[id,{name:`Layer ${i+1}`,visible:true,locked:false}]));
  state.nextId=layers+1;
  for(let uid=1;uid<=figures;uid++)state.assignments[uid]=state.order[(uid-1)%layers];
  const count=Math.max(editedKeys,otherKeys,fixedKeys),duration=count*2+1;
  const objects=()=>Array.from({length:figures},(_,slot)=>api.createObject(figure,slot+1,100+(slot%64)*5,100+Math.floor(slot/64)*5));
  report.keyframes=[api.createFrame(objects(),count*2),api.createFrame(objects(),1)];
  let serial=1;
  const track=keys=>({end:duration,keys:Array.from({length:keys},(_,i)=>({id:`cell-${serial++}`,tick:i*2,sourceTick:i*2,interpolation:'linear'}))});
  report._styk={...report._styk,layers:state,layerSheet:{version:1,duration,nextId:1,tracks:Object.fromEntries([
    ['scene',track(fixedKeys)],['camera',track(fixedKeys)],...state.order.map((id,i)=>[id,track(i?otherKeys:editedKeys)]),
  ])}};
  report._styk.layerSheet.nextId=serial;
  const editor=new api.Editor({demo:false,propertyChannels:true,layerTimeline:true,historyLimit:80}).load(report);
  editor.seek(1);editor.select(1);return editor;
}
const documentHash=editor=>hash(editor.serialize());
const nativeHash=editor=>hash(editor.report.keyframes);
const baselineState=editor=>({document:documentHash(editor),native:nativeHash(editor),sheet:hash(editor.report._styk.layerSheet),
  layers:hash(editor.report._styk.layers),sources:hash(editor.report._styk.frameSources??null)});
function assertPose(frame,figures,shift=0){
  assert.equal(frame.objects.length,figures);const found=new Set();
  for(const object of frame.objects){
    assert.equal(found.has(object.unique_id),false,'Sampling must retain unique figure identities.');found.add(object.unique_id);
    const slot=object.unique_id-1;
    assert.equal(object.root_x,100+(slot%64)*5+(object.unique_id===1?shift:0));
    assert.equal(object.root_y,100+Math.floor(slot/64)*5);
  }
}
const sample=(api,editor,tick)=>api.evaluatedFrame(editor.report,0,tick/(editor.timeline[0]?.count??1),tick);
const timed=action=>{const start=performance.now(),value=action();return {ms:performance.now()-start,value};};
const yieldControl=()=>new Promise(resolve=>setImmediate(resolve));
const order=pair=>pair%2?['production','control']:['control','production'];
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
function stats(rawMs,operationsPerSample=1){
  const sorted=rawMs.map(ms=>ms/operationsPerSample).toSorted((a,b)=>a-b);
  return {rawMs,operationsPerSample,p50Ms:median(sorted),p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};
}
function comparison(rows,field='ms',operationsPerSample=1){
  const result=Object.fromEntries(['control','production'].map(mode=>[mode,stats(rows.filter(row=>row.mode===mode).map(row=>row[field]),operationsPerSample)]));
  const ratios=Array.from({length:measuredPairs},(_,pair)=>{
    const a=rows.find(row=>row.pair===pair&&row.mode==='control'),b=rows.find(row=>row.pair===pair&&row.mode==='production');
    return a[field]/b[field];
  });
  return {...result,ratioOfMedians:result.control.p50Ms/result.production.p50Ms,rawPairedSpeedups:ratios,medianPairedSpeedup:median(ratios)};
}
const compact=value=>({controlP50Ms:value.control.p50Ms,productionP50Ms:value.production.p50Ms,
  ratioOfMedians:value.ratioOfMedians,medianPairedSpeedup:value.medianPairedSpeedup});
async function verifyExistingReport(record){
  assert.equal(record.control.commit,controlCommit,'The recorded control commit must resolve to the same Git commit.');
  assert.equal(record.errors?.length??0,0,'A report with recorded validation failures cannot be salvaged.');
  assert.equal(record.settings.measuredPairs,measuredPairs);assert.equal(record.settings.warmupPairs,warmupPairs);
  const after={control:await treeHashes(control),production:await treeHashes(production),live:await treeHashes(root)};
  assert.deepEqual(after.control,record.sourceHashes.control,'Control snapshot bytes changed after the recorded run.');
  assert.deepEqual(after.production,record.sourceHashes.production,'Production snapshot bytes changed after the recorded run.');
  for(const file of frozenOwners){
    assert.deepEqual(after.live[file],record.sourceHashes.liveBefore[file],`Live sheet owner changed after the recorded run: ${file}`);
    assert.equal(after.control[file].gitBlob,git(['rev-parse',`${controlCommit}:${file}`]),`Frozen sheet owner differs from Git: ${file}`);
  }
  assert.equal(Object.keys(after.control).length,Object.keys(after.production).length);
  for(const file of Object.keys(after.control))if(!frozenOwners.includes(file))assert.deepEqual(after.control[file],after.production[file],`Shared snapshot dependency differs: ${file}`);
  const benchmarkSnapshot=record.benchmarkSourceSnapshot??path.relative(root,path.join(snapshotRoot,'benchmark-runtime.mjs')).replaceAll('\\','/');
  assert.equal(hash(await readFile(path.resolve(benchmarkSnapshot))),record.sourceHashes.benchmark,'The preserved original benchmark source must match its recorded hash.');
  const checkRows=rows=>{
    assert.equal(rows.length,measuredPairs*2);
    for(let pair=0;pair<measuredPairs;pair++)for(const mode of ['control','production'])assert.equal(rows.filter(row=>row.pair===pair&&row.mode===mode).length,1);
  };
  for(const result of record.sampling){
    assert.ok(Object.values(result.invariants).every(value=>value===true),'Only completed behavioral checks can be salvaged.');
    for(const phase of ['imported','partial']){
      const rows=result.rows.filter(row=>row.phase===phase);checkRows(rows);
      assert.ok(rows.every(row=>Number.isFinite(row.ms)&&row.ms>=0));
      assert.deepEqual(result.summary[phase],comparison(rows,'ms',record.settings.batch),'Recorded sampling statistics must match their raw rows.');
    }
  }
  for(const result of record.commands){
    assert.ok(Object.values(result.invariants).every(value=>value===true));checkRows(result.rows);
    for(const [field,value] of Object.entries(result.summary)){
      assert.ok(result.rows.every(row=>Number.isFinite(row[field])&&row[field]>=0));
      assert.deepEqual(value,comparison(result.rows,field),'Recorded command statistics must match their raw rows.');
    }
  }
  const proofHarnessHash=hash(await readFile(new URL(import.meta.url)));
  const proof={...record,sourceHashes:{...record.sourceHashes,postHocAfter:after},
    otherLiveSourceChanges:sourceChanges(record.sourceHashes.liveBefore,after.live).filter(file=>!frozenOwners.includes(file)),
    executionStatus:record.completedAt?'completed':'interrupted',
    terminationNote:record.completedAt?'The original process recorded completion.':
      'The original process did not record completion or an assertion failure; its termination cause is unestablished. Only completed checkpointed cases are verified here.',
    sourceGuards:{postHoc:true,allControlAndProductionSnapshotTreeBytesUnchanged:true,liveSheetOwnersUnchanged:true,
      originalBenchmarkSourcePreserved:true,sharedDependenciesByteIdentical:true,otherLiveChangesDoNotAffectCapturedRuntimeGraphs:true},
    postHocVerification:{verifiedAt:new Date().toISOString(),input:path.relative(root,path.resolve(process.argv[3])).replaceAll('\\','/'),
      completedSamplingCases:record.sampling.length,completedCommandCases:record.commands.length,
      originalBenchmarkHash:record.sourceHashes.benchmark,preservedBenchmarkSource:benchmarkSnapshot,proofHarnessHash,
      benchmarkFileChangedSinceOriginalRun:proofHarnessHash!==record.sourceHashes.benchmark,
      scope:'Source/invariant/raw-statistic proof of completed cases only; no timed work or animation commands were rerun.'}};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({verified:output,...proof.postHocVerification}));
}
async function dispose(editors){for(const editor of Object.values(editors))await editor.drawingResources.dispose();}
function verifyCommand(api,editor,config,kind,baseline,{measure=true,complete=false}={}){
  editor.seek(1);editor.select(1);
  const previous=editor.report._styk.layerSheet,unrelated=previous.tracks['layer-2'],changed=previous.tracks['layer-1'];
  const result={};
  const run=(field,action)=>{const measured=measure?timed(action):{value:action()};if(measure)result[field]=measured.ms;return measured.value;};
  if(kind==='pose'){
    assert.equal(run('beginMs',()=>editor.beginTranslationDrag()),true);
    run('previewMs',()=>editor.moveSelection(1,0));
  }
  assert.equal(run('commitMs',()=>kind==='pose'?editor.commitDrag():editor.sheetInsertKey(['layer-1'],1)),true);
  const after=editor.report._styk.layerSheet;
  assert.notEqual(after.tracks['layer-1'],changed);assert.ok(after.tracks['layer-1'].keys.some(key=>key.tick===1));
  if(unrelated)assert.equal(after.tracks['layer-2'],unrelated);
  assert.equal(hash(previous),baseline.sheet,'The command must not mutate its retained history endpoint.');
  assert.equal(nativeHash(editor),baseline.native,'Authoring must not replace native poses.');
  assertPose(sample(api,editor,1),config.figures,kind==='pose'?1:0);
  const saved={sheet:hash(after),layers:hash(editor.report._styk.layers),sources:hash(editor.report._styk.frameSources??null),
    ...(complete?{document:documentHash(editor)}:{})},command=editor._undo.at(-1);
  result.commandBytes=command.bytes;result.historyBytes=editor.historySize;
  assert.equal(run('undoMs',()=>editor.undo()),true);
  assert.equal(editor.report._styk.layerSheet,previous);
  assert.equal(hash(previous),baseline.sheet);assert.equal(hash(editor.report._styk.layers),baseline.layers);
  assert.equal(hash(editor.report._styk.frameSources??null),baseline.sources);
  if(complete)assert.equal(documentHash(editor),baseline.document,'Undo must restore the exact editable document.');
  assertPose(sample(api,editor,1),config.figures);
  assert.equal(run('redoMs',()=>editor.redo()),true);
  assert.equal(editor.report._styk.layerSheet,after);assert.equal(hash(after),saved.sheet);
  assert.equal(hash(editor.report._styk.layers),saved.layers);assert.equal(hash(editor.report._styk.frameSources??null),saved.sources);
  if(complete)assert.equal(documentHash(editor),saved.document,'Redo must restore the exact published document.');
  assertPose(sample(api,editor,1),config.figures,kind==='pose'?1:0);
  editor.undo();assert.equal(hash(editor.report._styk.layerSheet),baseline.sheet);assert.equal(nativeHash(editor),baseline.native);
  if(complete)assert.equal(documentHash(editor),baseline.document);
  return result;
}
async function samplingCase(apis,config,checkpoint){
  const editors=Object.fromEntries(Object.entries(apis).map(([mode,api])=>[mode,fixture(api,config)]));
  try{
    const before=Object.fromEntries(Object.entries(editors).map(([mode,editor])=>[mode,baselineState(editor)]));
    assert.equal(before.control.document,before.production.document,'Both conditions must start with identical document bytes.');
    const rows=[],warmups=[],hashes={before},ticks=[.25,.5,.75,1.25,1.5,1.75,2.25,2.5,2.75,3.25];
    for(const phase of ['imported','partial']){
      if(phase==='partial'){
        hashes.partial={};
        for(const mode of ['control','production']){
          const editor=editors[mode];verifyCommand(apis[mode],editor,config,'key',before[mode],{measure:false,complete:true});
          editor.sheetInsertKey(['layer-1'],1);hashes.partial[mode]=documentHash(editor);
        }
      }
      const starts=Object.fromEntries(Object.entries(editors).map(([mode,editor])=>[mode,{document:documentHash(editor),history:editor._undo.length}]));
      for(let round=0;round<warmupPairs+measuredPairs;round++)for(const mode of order(round)){
        await yieldControl();globalThis.gc();
        const evaluate=()=>{let frame;for(let i=0;i<batch;i++)frame=sample(apis[mode],editors[mode],ticks[(round+i)%ticks.length]);return frame;};
        const measured=round<warmupPairs?{value:evaluate()}:timed(evaluate);
        assertPose(measured.value,config.figures);
        (round<warmupPairs?warmups:rows).push({phase,pair:round<warmupPairs?round:round-warmupPairs,mode,order:order(round),ms:measured.ms});
      }
      for(const mode of ['control','production']){
        assert.equal(editors[mode]._undo.length,starts[mode].history,'Sampling must not add history.');
        assert.equal(documentHash(editors[mode]),starts[mode].document,'Sampling must not author document state.');
        assert.equal(nativeHash(editors[mode]),before[mode].native);apis[mode].validateLayerSheet(editors[mode].report);
      }
      await checkpoint({completedPhase:phase,phaseInvariantsPassed:true,rows,warmups});
    }
    return {config,hashes,warmups,rows,summary:Object.fromEntries(['imported','partial'].map(phase=>[phase,comparison(rows.filter(row=>row.phase===phase),'ms',batch)])),
      invariants:{identicalInitialDocuments:true,expectedVisiblePoses:true,samplingDoesNotAuthor:true,nativePosesUnchanged:true,exactAuthoringUndoRedo:true,unrelatedTracksPreserved:true}};
  }finally{await dispose(editors);}
}
async function commandCase(apis,config,kind,checkpoint){
  const editors=Object.fromEntries(Object.entries(apis).map(([mode,api])=>[mode,fixture(api,config)]));
  try{
    const before=Object.fromEntries(Object.entries(editors).map(([mode,editor])=>[mode,baselineState(editor)]));
    assert.equal(before.control.document,before.production.document);
    const rows=[],warmups=[];
    for(const mode of ['control','production'])verifyCommand(apis[mode],editors[mode],config,kind,before[mode],{measure:false,complete:true});
    for(let round=0;round<warmupPairs+measuredPairs;round++)for(const mode of order(round)){
      await yieldControl();globalThis.gc();
      const measured=verifyCommand(apis[mode],editors[mode],config,kind,before[mode],{measure:round>=warmupPairs});
      (round<warmupPairs?warmups:rows).push({pair:round<warmupPairs?round:round-warmupPairs,mode,order:order(round),...measured});
      if(mode===order(round).at(-1))await checkpoint({completedRounds:round+1,rows,warmups});
    }
    for(const mode of ['control','production']){
      verifyCommand(apis[mode],editors[mode],config,kind,before[mode],{measure:false,complete:true});
      apis[mode].validateLayerSheet(editors[mode].report);
    }
    const fields=kind==='pose'?['beginMs','previewMs','commitMs','undoMs','redoMs']:['commitMs','undoMs','redoMs'];
    const totalKeys=Object.values(editors.control.report._styk.layerSheet.tracks).reduce((total,track)=>total+track.keys.length,0);
    assert.equal(totalKeys,config.editedKeys+(config.layers-1)*config.otherKeys+2*config.fixedKeys);
    return {config,kind,totalKeys,
      before,warmups,rows,summary:Object.fromEntries(fields.map(field=>[field,comparison(rows,field)])),
      invariants:{identicalInitialDocuments:true,exactUndoRedo:true,unrelatedTrackIdentityPreserved:true,nativePosesUnchanged:true,expectedVisiblePoses:true,insertedBoundaryAtRequestedTick:true}};
  }finally{await dispose(editors);}
}

if(verificationOnly){
  await verifyExistingReport(existing);
}else{
const benchmarkBytes=await readFile(new URL(import.meta.url));
const liveBefore=await treeHashes(root),snapshots=await prepareSnapshots(liveBefore);
const benchmarkSourceSnapshot=path.join(snapshotRoot,'benchmark-runtime.mjs');
await writeFile(benchmarkSourceSnapshot,benchmarkBytes,{flag:'wx'});
const report={measuredAt:new Date().toISOString(),environment:{node:process.version,versions:process.versions,cpu:os.cpus()[0]?.model,
  logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),platform:process.platform,arch:process.arch},
  git:{head:git(['rev-parse','HEAD']),status:git(['status','--short'])},control:{ref,commit:controlCommit,directory:path.relative(root,control).replaceAll('\\','/'),
    method:'Capture current src/vendor in two fresh immutable module graphs; replace only the two sheet owner modules with Git bytes in the control.',
    frozenOwners,verification:snapshots.verification},production:{directory:path.relative(root,production).replaceAll('\\','/')},
  settings:{warmupPairs,measuredPairs,batch,gcOutsideTiming:true,counterbalanced:true,sameProcess:true,caseSelection:selection},
  sourceHashes:{liveBefore,control:snapshots.control,production:snapshots.production},
  benchmarkSourceSnapshot:path.relative(root,benchmarkSourceSnapshot).replaceAll('\\','/'),
  preparationLiveSourceChanges:snapshots.preparationLiveSourceChanges,capturedDependencyDifferences:snapshots.capturedDependencyDifferences,
  sampling:[],commands:[],errors:[],
  limitations:['Static ten-segment figures reproduce the existing sweep; no raster assets, movieclips, IK, DOM listeners, GPU work or presentation.',
    'Module imports, snapshot preparation, fixture construction, GC, serialization and behavioral assertions are outside timed intervals.',
    'Complete serialized document/undo/redo checks run in untimed cycles before and after command measurements; each measured cycle checks sheet/source hashes, identities and visible poses.',
    'Control and production modules coexist in one Node process; this controls run variance but does not reproduce browser memory or JIT isolation.',
    'Sampling p95/max describe batches of three evaluations, divided by three, rather than individual interactive stalls.',
    'Seven measured alternating pairs follow three untimed warmup pairs; workstation activity, thermal state and GC during an operation remain uncontrolled.',
    'Both runtime graphs use byte-identical captured current dependencies; only editor-layer-sheet.mjs and layer-sheet.mjs differ. Unrelated live edits are recorded but cannot change the immutable runtime graphs.',
    'These measurements describe the tested interactions on captured source bytes, not universal FPS or total-app speedups.']};
report.sourceHashes.benchmark=hash(benchmarkBytes);
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n');
try{
  const apis={control:await modules(control),production:await modules(production)};
  if(['all','sampling'].includes(selection))for(const layers of [1,32,128]){
    const config={layers,figures:4000,editedKeys:2,otherKeys:2,fixedKeys:2};
    report.inProgress={kind:'sampling',config,startedAt:new Date().toISOString()};await save();
    const result=await samplingCase(apis,config,async progress=>{Object.assign(report.inProgress,progress);await save();});
    report.sampling.push(result);delete report.inProgress;await save();
    console.log(JSON.stringify({kind:'sampling',config:result.config,summary:Object.fromEntries(Object.entries(result.summary).map(([phase,value])=>[phase,compact(value)]))}));
  }
  const configs=[
    {family:'dense-pose',layers:128,figures:2000,editedKeys:2,otherKeys:2,fixedKeys:2,kinds:['pose']},
    {family:'unrelated-keys',layers:16,figures:100,editedKeys:100,otherKeys:10000,fixedKeys:2,kinds:['key','pose']},
    {family:'affected-keys',layers:10,figures:100,editedKeys:10000,otherKeys:10000,fixedKeys:2,kinds:['key','pose']},
  ];
  for(const {kinds,...config} of configs.filter(config=>['all','commands',config.family].includes(selection)))for(const kind of kinds){
    report.inProgress={kind,config,startedAt:new Date().toISOString()};await save();
    const result=await commandCase(apis,config,kind,async progress=>{Object.assign(report.inProgress,progress);await save();});
    report.commands.push(result);delete report.inProgress;await save();
    console.log(JSON.stringify({kind,config,totalKeys:result.totalKeys,commit:compact(result.summary.commitMs)}));
  }
}catch(error){report.errors.push(error.stack??String(error));process.exitCode=1;console.error(error);}
try{
  const after={control:await treeHashes(control),production:await treeHashes(production),live:await treeHashes(root)};
  report.sourceHashes.after=after;
  assert.deepEqual(after.control,report.sourceHashes.control,'Frozen source bytes changed during the comparison.');
  assert.deepEqual(after.production,report.sourceHashes.production,'Isolated production source bytes changed during the comparison.');
  for(const file of frozenOwners)assert.deepEqual(after.live[file],liveBefore[file],`Live sheet source changed during the comparison: ${file}`);
  report.otherLiveSourceChanges=sourceChanges(liveBefore,after.live).filter(file=>!frozenOwners.includes(file));
  assert.equal(hash(await readFile(new URL(import.meta.url))),report.sourceHashes.benchmark,'Benchmark bytes changed during the comparison.');
  report.sourceGuards={allControlAndProductionSnapshotTreeBytesUnchanged:true,liveSheetOwnersUnchanged:true,benchmarkUnchanged:true,
    otherLiveChangesDoNotAffectCapturedRuntimeGraphs:true};
}catch(error){report.errors.push(error.stack??String(error));process.exitCode=1;console.error(error);}
report.completedAt=new Date().toISOString();await save();console.log(`Report: ${output}`);
}
