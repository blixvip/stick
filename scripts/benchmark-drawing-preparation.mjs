import {chromium} from '../tests/support/playwright.mjs';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';

const baseline=process.env.STYK_PREPARATION_BASELINE||'58a3291',output=process.env.STYK_PREPARATION_BENCHMARK||'artifacts/drawing-preparation-reuse';
const sources=new Map(['drawing-resources','drawing-preparation','drawing-worker'].map(name=>[name,execFileSync('git',['show',`${baseline}:src/${name}.mjs`],{encoding:'utf8'})])),runs=[];
await mkdir(output,{recursive:true});
for(const kind of ['opaque8k','textured4k'])for(let pass=0;pass<3;pass++)for(const revision of pass%2?['working-tree',baseline]:[baseline,'working-tree']){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext(),errors=[];
  // Route both revisions so HTTP caching is disabled equally by Playwright.
  await context.route('**/*',route=>route.continue());
  if(revision===baseline)for(const [name,body] of sources)await context.route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  const samples=await page.evaluate(async kind=>{
   const {DrawingResources}=await import('/src/drawing-resources.mjs'),{createDrawingFigure}=await import('/src/drawing-model.mjs');
   const figure=createDrawingFigure(),owner=new DrawingResources({figure_types:[figure]},{history:false});owner.busy=true;await owner.surface(figure);
   const columns=kind==='opaque8k'?120:60,rows=kind==='opaque8k'?68:34,tiles=[];
   for(let ty=0;ty<rows;ty++)for(let tx=0;tx<columns;tx++){
    const after=new Uint8ClampedArray(kind==='opaque8k'?4:16384);let seed=42+(ty*columns+tx)%32;
    for(let i=0;i<after.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;after[i]=kind==='opaque8k'?[tx%256,ty%256,127,255][i%4]:seed>>>24;}
    tiles.push({tx,ty,before:null,after});
   }
   const command={kind:'drawing-pixels',celId:figure._styk.drawing.celId,tiles},request=owner.worker.request.bind(owner.worker),samples=[];
   try{
    for(let iteration=0;iteration<3;iteration++){
     const trips=[];let maxInputBytes=0,last=performance.now(),maxGapMs=0;
     owner.worker.request=async(kind,data,options)=>{maxInputBytes=Math.max(maxInputBytes,options.transfer.reduce((n,b)=>n+b.byteLength,0));const start=performance.now();try{return await request(kind,data,options);}finally{trips.push(performance.now()-start);}};
     const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;},4);
     const start=performance.now(),lease=await owner.prepareChanges(command,'after'),elapsedMs=performance.now()-start;
     await new Promise(resolve=>setTimeout(resolve,10));clearInterval(timer);
     const output=lease.plans[0].tiles,exact=output.length===tiles.length&&output.every((t,n)=>t.tx===tiles[n].tx&&t.ty===tiles[n].ty&&t.pixels.every((v,i)=>v===tiles[n].after[i%tiles[n].after.length]));
     samples.push({iteration,cold:iteration===0,elapsedMs,firstRequestMs:trips[0],requestMs:trips.reduce((a,b)=>a+b,0),requests:trips.length,maxInputBytes,maxGapMs,exact,sourceIntact:tiles.every(t=>t.after.byteLength===(kind==='opaque8k'?4:16384)),preparedBytes:owner.workingBytes});
     lease.release();if(owner.workingBytes)throw Error('Preparation reservation leaked');
    }
    return samples;
   }finally{owner.dispose();}
  },kind);
  assert.deepEqual(errors,[]);assert.ok(samples.every(s=>s.exact&&s.sourceIntact&&s.maxInputBytes<=1024*1024));
  runs.push({revision,kind,pass,browser:browser.version(),samples});console.log(revision,kind,pass,JSON.stringify(samples.map(s=>({cold:s.cold,ms:s.elapsedMs,first:s.firstRequestMs,gap:s.maxGapMs}))));
 }finally{await browser.close();}
}
await writeFile(output+'/benchmark.json',JSON.stringify({date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0]?.model,platform:os.platform(),workload:'Three alternating fresh Chrome processes per revision/case. Each process measures one cold and two warm detached preparations, with an empty live cel and the same source buffers. Exact RGBA and history source lengths are checked outside measurement. Opaque 7680x4352 compact uniform tiles and deterministic noisy/translucent 3840x2176 full tiles. No document commit, PNG publication, rendering or physical input latency is measured.',runs},null,2));
