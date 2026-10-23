/** Compare native-import snapshot boundaries in fresh Node worker threads.
 * Includes rejected binary/numeric packing experiments; see the report limits.
 * Actual Electron playback is measured by benchmark-performance-desktop.mjs.
 */
import {Worker, isMainThread, parentPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {setImmediate as yieldTask} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {documentChunks, applyDocumentChunk} from '../src/document-transport.mjs';
import {clipboardWireChunks, createClipboardWireDecoder} from '../src/clipboard-wire.mjs';
import {packNumbers,unpackNumbers} from './playback-transfer-numbers.mjs';
import {materializeNativeFrames} from '../src/import-wire.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Identity graph is separate from JSON values: lost sharing can invalidate
// geometry caches even when all numeric values remain unchanged.
function referenceDigest(value) {
  const hash=createHash('sha256'), seen=new WeakMap();let count=0,arrays=0;
  const visit=value=>{
    if(value===null||typeof value!=='object')return;
    if(seen.has(value)){hash.update(`R${seen.get(value)};`);return;}
    seen.set(value,++count);hash.update(`${Array.isArray(value)?'A':'O'}${count};`);
    if(Array.isArray(value)){
      hash.update(`L${value.length};`);arrays++;
      if(value.every(item=>typeof item==='number')&&Object.keys(value).length===value.length)return;
    }
    for(const key of Object.keys(value)){hash.update(`${key.length}:${key};`);visit(value[key]);}
  };
  visit(value);return {sha256:hash.digest('hex'),objects:count,arrays};
}

if(!isMainThread){
  let report,decoder,workMs=0,decodeMs=0,applyMs=0;
  parentPort.on('message',async message=>{
    try{
      if(message.type==='chunk'){
        const start=performance.now();report=applyDocumentChunk(report,message.chunk);
        const ms=performance.now()-start;applyMs+=ms;workMs+=ms;
      }else if(message.type==='native'){
        const start=performance.now();
        await materializeNativeFrames({document:report,nativeFrames:message.meta},message.buffer,message.offset);
        for(let index=0;index<report.keyframes.length;index++)if(message.frameMetadata[index]!==undefined)
          report.keyframes[index]._styk=message.frameMetadata[index];
        const elapsed=performance.now()-start;decodeMs+=elapsed;workMs+=elapsed;
      }else if(message.type==='numbers'){
        const start=performance.now(),chunk=unpackNumbers(message.packed);decodeMs+=performance.now()-start;
        const at=performance.now();report=applyDocumentChunk(report,chunk);applyMs+=performance.now()-at;workMs+=performance.now()-start;
      }else if(message.type==='binary'){
        const start=performance.now();
        if(message.start)decoder=createClipboardWireDecoder({maxBytes:8*1024*1024,maxResidentBytes:64*1024*1024});
        await decoder.push(message.buffer);decodeMs+=performance.now()-start;
        if(message.complete){
          const at=performance.now();report=applyDocumentChunk(report,decoder.finish());applyMs+=performance.now()-at;
          decoder.dispose();decoder=null;
        }
        workMs+=performance.now()-start;
      }else if(message.type==='finish'){
        parentPort.postMessage({id:message.id,workMs,decodeMs,applyMs,heap:process.memoryUsage().heapUsed});return;
      }else if(message.type==='verify'){
        parentPort.postMessage({id:message.id,digest:sha(JSON.stringify(report)),references:referenceDigest(report)});return;
      }else if(message.type==='collect'){
        globalThis.gc?.();parentPort.postMessage({id:message.id,heapAfterGC:process.memoryUsage().heapUsed,gcAvailable:typeof globalThis.gc==='function'});return;
      }
      parentPort.postMessage({id:message.id});
    }catch(error){parentPort.postMessage({id:message.id,error:error.stack});}
  });
  parentPort.postMessage({ready:true});
}else{
  const source=process.argv[2],output=process.argv[3]||'artifacts/playback-transfer.json';
  assert.ok(source,'Provide a read-only Pivot fixture');
  const {default:backend}=await import('../desktop/backend.cjs');
  const {unpackNativeFrameResponse,NATIVE_FRAME_CONTENT_TYPE}=await import('../src/import-wire.mjs');
  const {Editor}=await import('../src/editor.mjs');
  const {performanceSourceHashes}=await import('./performance-source-hashes.mjs');
  const sourceHashes=await performanceSourceHashes(),bytes=await readFile(source),sourceSha256=sha(bytes);
  const service=await backend.startBackend({appRoot:process.cwd()});let document,native;
  try{
    const response=await fetch(`${service.origin}/api/import?filename=${encodeURIComponent(path.basename(source))}`,
      {method:'POST',headers:{Accept:NATIVE_FRAME_CONTENT_TYPE,'Content-Type':'application/octet-stream'},body:bytes});
    assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),NATIVE_FRAME_CONTENT_TYPE);
    const buffer=await response.arrayBuffer(),{result,offset}=unpackNativeFrameResponse(buffer);
    native={buffer,offset,meta:{...result.nativeFrames}};
    await materializeNativeFrames(result,buffer,offset);document=result.document;
  }finally{service.stop();}
  const editor=new Editor({demo:false,propertyChannels:true,layerTimeline:true});editor.load(document);
  const {_stykSource,...report}=editor.report;
  if(report._styk?.audio){const {audio,...metadata}=report._styk;report._styk=metadata;}
  const sourceDocumentDigest=sha(JSON.stringify(report)),sourceReferences=referenceDigest(report),rows=[];
  const fieldSizes=value=>Object.fromEntries(Object.entries(value||{}).map(([key,value])=>[key,{jsonCharacters:JSON.stringify(value)?.length||0,
    kind:Array.isArray(value)?'array':typeof value,...(Array.isArray(value)?{length:value.length}:{})}]));
  const inventory={fields:fieldSizes(report),metadata:fieldSizes(report._styk),frames:report.keyframes.length,objects:0,runtimeSegments:0,poseNumbers:0,largePoseNumbers:0};
  for(const frame of report.keyframes)for(const object of frame.objects){inventory.objects++;inventory.runtimeSegments+=object.runtime_segments?.length||0;
    for(const key of ['angles','lengths','bends']){const count=object[key]?.length||0;inventory.poseNumbers+=count;if(count>=32)inventory.largePoseNumbers+=count;}}
  let expected;
  const modes=(process.env.STYK_TRANSFER_MODES||'clone,native,native,clone').split(',');
  assert.ok(modes.every(mode=>['clone','binary','numbers','native'].includes(mode)));
  for(const mode of modes){
    globalThis.gc?.();const workers=[],startup=performance.now();let sequence=0;
    const workerCount=3;
    try{
      for(let index=0;index<workerCount;index++){
        const worker=new Worker(new URL(import.meta.url)),client={worker,pending:new Map()};workers.push(client);
        await new Promise((resolve,reject)=>{
          worker.on('error',reject);
          worker.on('message',message=>{
            if(message.ready){resolve();return;}
            const waiter=client.pending.get(message.id);if(!waiter)return;
            client.pending.delete(message.id);message.error?waiter.reject(new Error(message.error)):waiter.resolve(message);
          });
        });
      }
      const startupMs=performance.now()-startup,post=[];
      const broadcast=async message=>{
        const id=++sequence;
        return Promise.all(workers.map(client=>new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{client.pending.delete(id);reject(new Error('Snapshot worker response timed out'));},60000);
          client.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
          try{const at=performance.now();client.worker.postMessage({...message,id});post.push(performance.now()-at);}
          catch(error){clearTimeout(timer);client.pending.delete(id);reject(error);}
        })));
      };
      const memoryBefore=process.memoryUsage(),began=performance.now(),cpuBefore=process.cpuUsage();
      let chunks=0,messages=0,estimatedBytes=0,encodedBytes=0,packMs=0,packMaxMs=0,enumerateMs=0;
      const iterator=documentChunks(mode==='native'?{...report,keyframes:[]}:report,{maxBytes:1024*1024,timeBudgetMs:2,sharedFigures:true});
      for(;;){
        const at=performance.now(),step=iterator.next();enumerateMs+=performance.now()-at;if(step.done)break;
        const chunk=step.value;chunks++;estimatedBytes+=chunk.estimatedBytes||0;
        if(mode==='clone'||mode==='native'){await broadcast({type:'chunk',chunk});messages++;}
        else if(mode==='numbers'){
          const at=performance.now(),packed=packNumbers(chunk),elapsed=performance.now()-at;
          packMs+=elapsed;packMaxMs=Math.max(packMaxMs,elapsed);encodedBytes+=packed.numericBytes;
          await broadcast({type:'numbers',packed});messages++;
        }
        else{
          const encoded=clipboardWireChunks(chunk,{timeBudgetMs:2,onTimings:stats=>{packMs+=stats.workMs;packMaxMs=Math.max(packMaxMs,stats.maxSliceMs);}});
          let item=await encoded.next(),first=true;
          while(!item.done){
            const next=await encoded.next();encodedBytes+=item.value.byteLength;
            await broadcast({type:'binary',buffer:item.value,start:first,complete:next.done});
            messages++;first=false;item=next;
          }
        }
        await yieldTask();
      }
      if(mode==='native'){
        await broadcast({type:'native',...native,frameMetadata:report.keyframes.map(frame=>frame._styk)});
        encodedBytes+=native.buffer.byteLength;messages++;
      }
      const workerStats=await broadcast({type:'finish'}),totalMs=performance.now()-began,cpu=process.cpuUsage(cpuBefore),memoryAfter=process.memoryUsage();
      const verification=await broadcast({type:'verify'});
      const collected=await broadcast({type:'collect'});
      expected??=verification[0];
      const valueParity=verification.every(row=>row.digest===sourceDocumentDigest);
      const referenceParity=verification.every(row=>row.references.sha256===expected.references.sha256);
      const row={mode,workers:workerCount,startupMs,totalMs,cpuMs:(cpu.user+cpu.system)/1000,chunks,messages,
        estimatedCloneBytes:estimatedBytes*workerCount,encodedBytes:encodedBytes*workerCount,
        postMs:post.reduce((a,b)=>a+b,0),maxPostMs:Math.max(...post),enumerateMs,packMs,packMaxMs,
        workerStats,collected,verification,valueParity,referenceParity,memoryBefore,memoryAfter};
      rows.push(row);console.log(JSON.stringify({mode,totalMs,postMs:row.postMs,packMs,referenceParity}));
    }finally{await Promise.all(workers.map(client=>client.worker.terminate()));}
  }
  const finalHashes=await performanceSourceHashes();assert.deepEqual(finalHashes,sourceHashes);assert.equal(sha(await readFile(source)),sourceSha256);
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify({at:new Date().toISOString(),environment:{node:process.version,versions:process.versions,cpu:os.cpus()[0].model,ramBytes:os.totalmem()},
    source:{bytes:bytes.length,sha256:sourceSha256,documentDigest:sourceDocumentDigest,references:sourceReferences,inventory,nativeWireBytes:native.buffer.byteLength},sourceHashes,rows,
    benchmarkSources:{main:sha(await readFile(new URL(import.meta.url))),numbers:sha(await readFile(new URL('./playback-transfer-numbers.mjs',import.meta.url)))},
    limitations:['Node worker threads, not an Electron UI or GPU playback measurement.','Packing, ACKs, receiver reconstruction and worker startup recorded; verification hashing excluded from transfer timing.',
      'Three fresh workers per condition; explicit GC outside timing when available. CPU and RSS cover all workers in this process; heap snapshots cover their own isolates.',
      'Binary mode uses the existing clipboard codec; numbers mode only lifts dense numeric arrays into Float64Array and restores plain arrays. No production code is replaced; value and reference parity are correctness gates.',
      'encodedBytes counts complete wire bytes for binary mode but only packed numeric payload bytes for numbers mode; ordinary structured-clone metadata is not measured.',
      'Native mode is an unchanged-import-only prototype: ordinary metadata chunks plus retained import bytes and generated frame IDs. It does not implement production revision, edit or cache-admission gates.',
      'The native buffer is retained in every condition for matched inputs; its additional cache cost is nativeWireBytes and must be included in any production memory policy.',
      'OS caches and other workstation activity uncontrolled; snapshot estimates are not physical structured-clone bytes.']},null,2));
  assert.ok(rows.every(row=>row.valueParity&&row.referenceParity),'Candidate snapshot value/reference parity failed; see the retained report');
}
