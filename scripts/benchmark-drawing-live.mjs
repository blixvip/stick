import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import {createHash} from 'node:crypto';

const run=promisify(execFile),baseline=process.env.STYK_LIVE_BASELINE||'2776f60',output=process.env.STYK_LIVE_BENCHMARK||'artifacts/drawing-preview-progress',runs=[];
const files=['src/drawing-preview-cache.mjs','src/drawing-worker-operations.mjs','src/renderer.mjs','tests/drawing-live.browser.mjs'];
const fingerprint=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update((await readFile(file,'utf8')).replaceAll('\r\n','\n')).digest('hex')])));
const sourceSha256NormalizedLF=await fingerprint();
await mkdir(output,{recursive:true});
for(const [software,delay] of [[false,0],[false,30],[true,30]])for(let pass=0;pass<3;pass++)for(const revision of pass%2?['working-tree',baseline]:[baseline,'working-tree']){
 const directory=`${output}/${software?'software':'gpu'}-delay-${delay}-${revision}-${pass}`;
 let failure=null;
 try{await run(process.execPath,['tests/drawing-live.browser.mjs'],{env:{...process.env,STYK_LIVE_ARTIFACTS:directory,STYK_LIVE_BASELINE:revision==='working-tree'?'':revision,STYK_PREVIEW_DELAY_MS:String(delay),STYK_LIVE_SOFTWARE:software?'1':'0'},windowsHide:true,maxBuffer:4*1024*1024});}
 catch(error){
  if(revision==='working-tree')throw error;
  failure=error.stderr?.match(/AssertionError \[ERR_ASSERTION\]: ([^\r\n]+)/)?.[1];
  assert.ok(['recent pointer positions remain visibly painted during the stroke','unchanged completed previews are not uploaded again for newer input'].includes(failure),'Only the expected baseline regression assertions may fail');
 }
 const measured=JSON.parse(await readFile(directory+'/measured.json','utf8'));
 assert.ok(measured.samples>250&&measured.probes>100&&measured.tiles>64);
 runs.push({revision,software,delayMs:delay,pass,failure,measured:{...measured,misses:undefined}});
 assert.deepEqual(await fingerprint(),sourceSha256NormalizedLF,'Measured source changed during the comparison');
 console.log(JSON.stringify({revision,software,delay,pass,visible:measured.visibleFraction,maxMissMs:measured.maxMissMs,duplicateUploads:measured.duplicatePreviewUploads}));
 await writeFile(output+'/benchmark.json',JSON.stringify({date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0]?.model,platform:os.platform(),method:'Three alternating fresh Chrome processes per revision: WebGPU at 0 ms and 30 ms injected preview-reply delay, and Canvas fallback at 30 ms delay. Same 8 px, 2x brush and blank drawing; scripted 125 Hz input for 5.5 seconds. Both revisions disable HTTP caching. Readback probes each rendered frame near a pointer position from 100 ms earlier; costs include canvas readback and diagnostic hooks. This reproduces preview starvation; it is not physical pen latency or a simulation of another GPU. Baseline visibility/upload assertions can fail intentionally; working-tree runs must pass all live browser checks.',sourceSha256NormalizedLF,runs},null,2));
}
