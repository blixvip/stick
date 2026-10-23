/** Real worker-count changes must preserve GPU inputs and rendered pixels. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
import {performanceSourceHashes} from '../scripts/performance-source-hashes.mjs';

const sources=process.argv.slice(2);assert.ok(sources.length,'Provide native-v5 PIV fixtures.');
const hashes=await performanceSourceHashes(),service=await backend.startBackend({appRoot:process.cwd()});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),results=[];let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${service.origin}/api/health`);await page.setContent('<input id="source" type="file">');
  for(const source of sources){
    const filename=path.resolve(source),before=sha(await readFile(filename));
    await page.locator('#source').setInputFiles(filename);
    const result=await page.evaluate(async()=>{
      const {ImportClient}=await import('/src/import-client.mjs'),{Editor}=await import('/src/editor.mjs');
      const {PlaybackCache}=await import('/src/playback.mjs'),{createRenderer}=await import('/src/renderer.mjs');
      const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const check=(value,message)=>{if(!value)throw new Error(message);};
      const importer=new ImportClient(),rows=[];
      try{
        const imported=await importer.importFile(document.querySelector('#source').files[0]);
        check(imported.playbackFrames,'Fixture must fit the native-v5 handoff.');
        const editor=new Editor({demo:false,propertyChannels:true,layerTimeline:true}).load(imported.document),report=editor.report;
        const digest=await hash(new TextEncoder().encode(JSON.stringify(report)));
        for(const storedFrames of [false,true])for(const native of [false,true])for(const limited of [false,true]){
          const cache=new PlaybackCache({workerCount:3,maxBytes:1024**3,maxFrames:4,...(limited?{maxWorkerBytes:4*1024**3}:{})});
          const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas);
          check(renderer.device,'The regression requires actual WebGPU.');
          renderer.resize(report.canvas_width,report.canvas_height,1);
          const copy=new OffscreenCanvas(canvas.width,canvas.height),ctx=copy.getContext('2d',{willReadFrequently:true});
          const options={report,view:{x:0,y:0,scale:1},cameraEnabled:true},packets=[];
          try{
            if(native)check(cache.stageNativeSnapshot(report,imported.playbackFrames,{revision:editor.revision,isCurrent:()=>true}),'Native staging rejected');
            cache.load(report,{revision:editor.revision,storedFrames,scale:1});
            const end=cache.totalTicks-1,mid=Math.floor(end/2),ticks=[...new Set([0,Math.min(1,end),mid,Math.min(mid+1,end),Math.max(0,end-1),end])];
            for(const tick of ticks){
              await cache.prepareRange([tick]);const packet=cache.get(tick);
              await renderer.prepareBackgrounds(report,packet.frame);renderer.prepareFrame(packet,options);
              check(renderer.renderPrepared(packet.key,options),'Prepared frame did not render');
              await renderer.device.queue.onSubmittedWorkDone();ctx.clearRect(0,0,copy.width,copy.height);ctx.drawImage(canvas,0,0);
              packets.push({tick,shapes:await hash(packet.shapes),transforms:await hash(packet.transforms),uids:await hash(packet.uids),
                pixels:await hash(ctx.getImageData(0,0,copy.width,copy.height).data),reduced:packet.previewQuality?.reduced});
            }
            check(cache.workers.length===(limited?2:3),'Expected worker-count transition did not occur');
            rows.push({storedFrames,native,limited,workers:cache.workers.length,admission:cache.stats.workerAdmission,packets});
          }finally{renderer.destroy();cache.dispose();}
        }
        for(let i=0;i<rows.length;i+=2)check(JSON.stringify(rows[i].packets)===JSON.stringify(rows[i+1].packets),
          `Worker-count change altered GPU input/pixels: stored=${rows[i].storedFrames}, native=${rows[i].native}`);
        const held=new PlaybackCache({workerCount:3,maxBytes:1024**3,maxWorkerBytes:4*1024**3}),settled=[];
        try{
          held.setInteractionActive(true);
          for(let generation=0;generation<4;generation++){
            check(held.stageNativeSnapshot(report,imported.playbackFrames,{revision:editor.revision,isCurrent:()=>true}),
              'Replacement native source could not be staged');
            held.load(report,{revision:editor.revision});
            held._loadPromise.then(()=>settled.push('loaded'),error=>settled.push(error.name));
            const deadline=performance.now()+10000;
            while(!held._interactionPromise||!held.stats.loadChunks){
              check(performance.now()<deadline,'Real worker snapshot never reached interaction suspension');
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            if(generation<3)held.invalidate();
          }
          check(settled.length===3&&settled.every(value=>value==='AbortError'),'Superseded suspended native snapshots remained pending');
          check(held.interactionActive&&!held._mirrorAvailable,'Cancellation resumed or published current background work');
          held.setInteractionActive(false);await held.prepareRange([0]);
          check(held.get(0)&&held.stats.nativeSourceBytes===0,'Resumed native snapshot failed to publish/release its source');
        }finally{held.dispose();}
        check(await hash(new TextEncoder().encode(JSON.stringify(report)))===digest,'Admission mutated the editable document');
        return {frames:report.keyframes.length,digest,rows,suspendedNativeResults:settled};
      }finally{importer.dispose();}
    });
    assert.equal(sha(await readFile(filename)),before);results.push({name:path.basename(filename),sha256:before,...result});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(await performanceSourceHashes(),hashes);
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/playback-admission-browser.json',JSON.stringify({results,hashes,errors,
    limitations:['Chrome on this Windows/GPU host only; debugger-attached correctness evidence, not a timing comparison.']},null,2));
  console.log(JSON.stringify({fixtures:results.length,comparisons:results.map(row=>({name:row.name,variants:row.rows.length,ticks:row.rows[0].packets.length}))}));
}finally{await browser?.close();service.stop();}
