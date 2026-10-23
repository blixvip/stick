/** Export boundary experiment. No application endpoint or file format changes. */
import {Worker as NodeWorker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {serialize,deserialize} from 'node:v8';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';
import {liftDocument} from '../src/native-container.mjs';
import {performanceSourceHashes} from './performance-source-hashes.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

if(!isMainThread){
  // Capture the production export worker's exact normalized request once.
  // The dummy response is consumed only by this setup, never saved as a file.
  const stringify=JSON.stringify;
  JSON.stringify=function(value,...options){
    if(value?.document&&value.format==='piv')writeFileSync(workerData.snapshot,serialize(value),{flag:'wx'});
    return stringify.call(this,value,...options);
  };
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/api/export');
    await writeFile(workerData.capture,options.body,{flag:'wx'});
    return new Response(new Uint8Array(1),{headers:{'Content-Type':'application/octet-stream'}});
  };
  globalThis.self={postMessage:value=>parentPort.postMessage(value),addEventListener(type,listener){
    if(type==='message')parentPort.on('message',data=>listener({data}));}};
  await import('../src/document-export-worker.mjs');
}else if(process.argv[2]==='--measure'){
  assert.ok(globalThis.gc,'Run with --expose-gc');
  const filename=path.resolve(process.argv[3]),mode=process.argv[4];assert.ok(['json','sections'].includes(mode));
  // Preserve the actual normalized worker graph, including shared references
  // and array shapes. A JSON roundtrip would bias the candidate's allocation.
  const request=deserialize(await readFile(filename+'.v8'));
  const candidate=backend.pythonCandidates()[0],started=performance.now();
  const child=spawn(candidate.command,[...candidate.args,'scripts/benchmark-export-transport.py',filename,mode],
    {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(errors||`Receiver exit ${code}`)));});
  ended.catch(()=>{});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const nextLine=()=>Promise.race([lines.next().then(row=>{assert.ok(!row.done,errors);return JSON.parse(row.value);}),ended.then(()=>{throw new Error('Receiver exited before reporting');})]);
  const timer=setTimeout(()=>child.kill(),180000);
  try{
    const {origin}=await nextLine(),startupMs=performance.now()-started;
    globalThis.gc();const memoryBefore=process.memoryUsage(),cpu=process.cpuUsage(),at=performance.now();
    let body,sectionBytes=null;
    if(mode==='json')body=JSON.stringify(request);
    else{
      const lifted=liftDocument(request),header=new TextEncoder().encode(JSON.stringify({skeleton:lifted.skeleton,
        sections:lifted.sections.map(s=>({kind:s.kind,bytes:s.bytes.length}))}));
      const prefix=new Uint8Array(12);prefix.set(new TextEncoder().encode('STYKXPR1'));new DataView(prefix.buffer).setUint32(8,header.length,true);
      body=new Blob([prefix,header,...lifted.sections.map(s=>s.bytes)]);
      sectionBytes=lifted.sections.map(s=>s.bytes.length);
    }
    const packMs=performance.now()-at,memoryPacked=process.memoryUsage();
    const response=await fetch(`${origin}/api/export`,{method:'POST',body,headers:{'Content-Type':mode==='json'?'application/json':'application/x-styk-benchmark-sections'}});
    assert.equal(response.status,200,await response.clone().text());
    const received=await response.json(),totalMs=performance.now()-at,usage=process.cpuUsage(cpu),memoryAfter=process.memoryUsage();
    const verification=await nextLine();await ended;
    console.log(JSON.stringify({mode,startupMs,packMs,totalMs,cpuMs:(usage.user+usage.system)/1000,sectionBytes,
      memoryBefore,memoryPacked,memoryAfter,peakRssKiB:process.resourceUsage().maxRSS,received,verification}));
  }finally{clearTimeout(timer);child.kill();}
}else{
  const source=path.resolve(process.argv[2]),label=process.argv[3]||'export-transport';assert.match(label,/^[a-zA-Z0-9_-]+$/);
  const output=path.resolve('artifacts',label);await mkdir(output,{recursive:true});
  const capture=path.join(output,'request.json'),raw=await readFile(source),hashes=await performanceSourceHashes();
  const service=await backend.startBackend({appRoot:process.cwd()});
  try{
    const {materializeNativeFrames,unpackNativeFrameResponse,NATIVE_FRAME_CONTENT_TYPE}=await import('../src/import-wire.mjs');
    const {Editor}=await import('../src/editor.mjs'),{DocumentExporter}=await import('../src/document-export.mjs');
    const response=await fetch(`${service.origin}/api/import?filename=${encodeURIComponent(path.basename(source))}`,
      {method:'POST',body:raw,headers:{Accept:NATIVE_FRAME_CONTENT_TYPE}});assert.equal(response.status,200);
    const buffer=await response.arrayBuffer();let result;
    if(response.headers.get('Content-Type')===NATIVE_FRAME_CONTENT_TYPE){
      const decoded=unpackNativeFrameResponse(buffer);result=await materializeNativeFrames(decoded.result,buffer,decoded.offset);
    }else result=JSON.parse(new TextDecoder().decode(buffer));
    const editor=new Editor({demo:false,propertyChannels:true,layerTimeline:true}).load(result.document);
    globalThis.Worker=class {
      constructor(){this.worker=new NodeWorker(new URL(import.meta.url),{workerData:{capture,snapshot:capture+'.v8'}});}
      postMessage(value){this.worker.postMessage(value);}
      terminate(){void this.worker.terminate();}
      addEventListener(type,listener){this.worker.on(type,value=>listener(type==='message'?{data:value}:value));}
    };
    const exporter=new DocumentExporter({baseURL:service.origin});
    try{await exporter.export(editor.report,{sourceId:result.sourceId,format:'piv',name:'Benchmark'});}
    finally{exporter.dispose();delete globalThis.Worker;}
  }finally{service.stop();}
  const rows=[];
  for(const mode of ['json','sections','sections','json']){
    const row=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--measure',capture,mode],
        {windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr||`Measurement exit ${code}`)));
    });
    rows.push(row);await writeFile(path.join(output,'rows.json'),JSON.stringify(rows,null,2));
    console.log(JSON.stringify({mode,packMs:row.packMs,totalMs:row.totalMs,bytes:row.received.requestBytes,parity:row.verification.valueParity}));
  }
  assert.deepEqual(await performanceSourceHashes(),hashes);assert.equal(sha(await readFile(source)),sha(raw));
  await writeFile(path.join(output,'report.json'),JSON.stringify({source:{name:path.basename(source),bytes:raw.length,sha256:sha(raw)},
    request:{bytes:(await readFile(capture)).length,sha256:sha(await readFile(capture)),snapshotSha256:sha(await readFile(capture+'.v8'))},hashes,rows,
    environment:{node:process.version,cpu:os.cpus()[0].model,ramBytes:os.totalmem()},
    limitations:['Node boundary experiment, not end-to-end Electron saving or UI latency.',
      'Fresh Node sender and Python receiver per condition. Common snapshot, normalization and Python startup are outside boundary timing.',
      'The production worker request is captured with V8 serialization before JSON encoding; value and reference identity are preserved for both senders.',
      'Time includes JS packing, Blob/string upload, actual bounded HTTP receipt and Python reconstruction; validation and exhaustive value/type parity run after the reply.',
      'Memory counters precede verification except Node peak RSS; process high-water marks include initial modules/input parsing.',
      'Uncompressed sections reuse the native saver representation; benchmark framing is not a production protocol and has no cancellation/malformed-input certification.',
      'No writing to source projects or production export changes. Workstation load and OS caches uncontrolled.']},null,2));
}
