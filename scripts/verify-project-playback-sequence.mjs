/** Compare retained, evicted and staged GPU frames from real parallel workers
 * with independently evaluated frames and the pre-pooling renderer. Read only. */
import {chromium} from '../tests/support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const [source,referenceRoot]=process.argv.slice(2);
if(!source||!referenceRoot)throw new Error('Provide project file and reference source directory.');
const {startBackend}=createRequire(import.meta.url)('../desktop/backend.cjs');
const backend=await startBackend({appRoot:process.cwd()}),output=path.resolve('artifacts/playback-integrity',process.env.STYK_SEQUENCE_LABEL||'sequence');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceHash=hash(await readFile(source));
const sourceRoot=path.resolve(process.env.STYK_SEQUENCE_SOURCES||'src'),captured=new Map(),sourceHashes={};
for(const name of (await readdir(sourceRoot,{recursive:true})).filter(name=>name.endsWith('.mjs'))){
  const bytes=await readFile(path.join(sourceRoot,name)),key=name.replaceAll('\\','/');captured.set(key,bytes);sourceHashes[key]=hash(bytes);
}
await mkdir(output,{recursive:true});let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('sequenceProgress',value=>console.log(JSON.stringify(value)));
  await page.exposeFunction('sequenceImage',async({name,data})=>writeFile(path.join(output,`${name}.png`),Buffer.from(data.split(',')[1],'base64')));
  await page.context().route('**/src/**',async route=>{const name=new URL(route.request().url()).pathname.slice('/src/'.length),body=captured.get(name);if(body)await route.fulfill({contentType:'text/javascript',body});else await route.continue();});
  await page.route('**/baseline-src/**',async route=>{const name=new URL(route.request().url()).pathname.slice('/baseline-src/'.length);await route.fulfill({contentType:'text/javascript',body:await readFile(path.join(referenceRoot,name))});});
  await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,path.extname(source)),{timeout:180000});
  const result=await page.evaluate(async({start,end,scale,msaa,runtimeMsaa})=>{
    const {PlaybackCache}=await import('/src/playback.mjs');
    const {createRenderer}=await import('/src/renderer.mjs');
    const {createRenderer:referenceRenderer}=await import('/baseline-src/renderer.mjs');
    const {compilePlaybackPacket,PlaybackResources}=await import('/baseline-src/playback-worker.mjs');
    const {storedFrameReport}=await import('/src/pivot-frame-draft.mjs');
    const report=storedFrameReport(styk.editor.report),width=Math.round(700*scale),height=Math.round(400*scale);
    const subject=await createRenderer(document.createElement('canvas'),{msaa:runtimeMsaa?4:msaa,preparedCache:{maxFrames:5,maxBytes:512*1024*1024}});
    const reference=await referenceRenderer(document.createElement('canvas'),{msaa:runtimeMsaa?4:msaa});
    const cache=new PlaybackCache({workerCount:3,gpuIsolation:true,maxBytes:1024*1024*1024,maxFrames:12});
    const resources=new PlaybackResources({preview:true}),checks=[],gpuErrors=[],heldFailures=[];
    const out=new OffscreenCanvas(width,height),ctx=out.getContext('2d',{willReadFrequently:true});
    const options={report,view:{scale,x:0,y:0},cameraEnabled:true};
    for(const [name,renderer] of [['subject',subject],['reference',reference]]){
      if(!renderer.device)throw new Error(`${name} did not initialize WebGPU: ${JSON.stringify(renderer.stats)}`);
      renderer.resize(width,height,1);if(runtimeMsaa)await renderer.setMsaa(msaa);renderer.device.addEventListener('uncapturederror',e=>gpuErrors.push({name,message:e.error.message}));
    }
    // Snapshot the canvas in the submission task: a WebGPU swap-chain texture
    // may be cleared after presentation if we yield before taking this copy.
    const pixels=async(renderer,label)=>{
      ctx.clearRect(0,0,width,height);ctx.drawImage(renderer.canvas,0,0);const data=ctx.getImageData(0,0,width,height).data;
      if(label){const blob=await out.convertToBlob();const image=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});await sequenceImage({name:label,data:image});}
      await renderer.device.queue.onSubmittedWorkDone();return data;
    };
    const difference=(a,b)=>{let total=0,max=0,changed=0,interiorMismatch=0;
      for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);total+=d;max=Math.max(max,d);if(d)changed++;}
      if(changed)for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
        const i=(y*width+x)*4;if(![0,1,2,3].some(c=>Math.abs(a[i+c]-b[i+c])>4))continue;
        let edge=false;for(let c=0;c<4&&!edge;c++)for(let dy=-2;dy<=2&&!edge;dy++)for(let dx=-2;dx<=2;dx++)if(Math.abs(a[((y+dy)*width+x+dx)*4+c]-a[i+c])>4){edge=true;break;}
        if(!edge)interiorMismatch++;
      }
      return {mean:total/a.length,max,changed,interiorMismatch};
    };
    let previous=null,previousPixels=null,cancellations=0,slices=0;
    try {
      cache.load(report,{scale});end=Math.min(end<0?cache.totalTicks-1:end,cache.totalTicks-1);
      for(let tick=start;tick<=end;tick++){
        await cache.prepareRange(Array.from({length:Math.min(3,end-tick+1)},(_,i)=>tick+i));
        const actual=cache.get(tick);if(!actual)throw new Error(`Requested tick ${tick} was evicted before use.`);
        await subject.prepareBackgrounds(report,actual.frame);
        const expected=await compilePlaybackPacket(report,tick,{resources,revision:1,scale,gpuIsolation:true,maxPacketBytes:1024*1024*1024});
        try {
          await reference.prepareBackgrounds(report,expected.frame);
          reference.prepareFrame(expected,options);reference.renderPrepared(expected.key,options);const a=await pixels(reference);
          const protectedKeys=new Set([String(actual.key),String(previous?.key)]);
          let warm=previous&&subject.preparedFrames.beginWarm(actual,options,protectedKeys);
          if(warm&&tick%23===0){subject.preparedFrames.stepWarm(warm,0);subject.preparedFrames.cancelWarm();cancellations++;warm=subject.preparedFrames.beginWarm(actual,options,protectedKeys);}
          if(warm)while(!subject.preparedFrames.stepWarm(warm,0)){
            slices++;
            if(tick%23===0){const rendered=subject.renderPrepared(previous.key,options);const held=await pixels(subject);if(held.some((n,i)=>n!==previousPixels[i])){
              const failure={tick,rendered,...difference(previousPixels,held),frames:[...subject.preparedFrames.frames.keys()],gpuErrors:gpuErrors.length};
              heldFailures.push(failure);await sequenceProgress({heldFailure:failure});
              if(heldFailures.length<=3){await sequenceImage({name:`${tick}-held-actual`,data:subject.canvas.toDataURL()});ctx.putImageData(new ImageData(previousPixels,width,height),0,0);const blob=await out.convertToBlob();const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});await sequenceImage({name:`${tick}-held-expected`,data});}
              break;
            }}
          }
          else subject.prepareFrame(actual,options);
          if(!subject.hasPreparedFrame(actual.key))subject.prepareFrame(actual,options);
          subject.renderPrepared(actual.key,options);const b=await pixels(subject,[48,129,162,175,180,202,480,482].includes(tick)?`${tick}-snapshot`:null),diff=difference(a,b);
          const check={tick,...diff,quality:actual.previewQuality};checks.push(check);
          if(diff.mean>=.03||diff.interiorMismatch||tick===75||tick===480){await sequenceImage({name:`${tick}-reference`,data:reference.canvas.toDataURL()});await sequenceImage({name:`${tick}-actual`,data:subject.canvas.toDataURL()});}
          if(tick%25===0||diff.mean>=.03||diff.interiorMismatch)await sequenceProgress({...check,gpuErrors:gpuErrors.length});
          previous=actual;previousPixels=b;
        }finally{for(const e of expected.compatibility)e.bitmap?.close();reference.clearPreparedFrames();}
      }
      return {checks,gpuErrors,heldFailures,cancellations,slices,stats:{...subject.preparedFrames.stats},workerCount:cache.workers.length};
    }finally{cache.dispose();resources.dispose();subject.destroy();reference.destroy();}
  },{start:Number(process.env.STYK_SEQUENCE_START||0),end:Number(process.env.STYK_SEQUENCE_END??-1),scale:Number(process.env.STYK_SEQUENCE_SCALE||2),msaa:Number(process.env.STYK_SEQUENCE_MSAA||4),runtimeMsaa:process.env.STYK_SEQUENCE_RUNTIME_MSAA==='1'});
  const unchanged=hash(await readFile(source))===sourceHash;
  const changedDuringRun=[];for(const [name,bytes]of captured)if(hash(await readFile(path.join(sourceRoot,name)))!==hash(bytes))changedDuringRun.push(name);
  await writeFile(path.join(output,'report.json'),JSON.stringify({...result,sourceRoot,sourceHash,sourceHashes,changedDuringRun,unchanged,errors},null,2));
  console.log(JSON.stringify({frames:result.checks.length,failures:result.checks.filter(c=>c.mean>=.03||c.interiorMismatch),gpuErrors:result.gpuErrors,slices:result.slices,cancellations:result.cancellations}));
  assert.ok(unchanged);assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[]);
  assert.deepEqual(result.heldFailures,[]);
  assert.ok(result.checks.every(c=>c.mean<.03&&c.interiorMismatch===0&&!c.quality.reduced));
} finally {await browser?.close();backend.stop();}
