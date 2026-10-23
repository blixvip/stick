import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {startBackend}=createRequire(import.meta.url)('../desktop/backend.cjs');
const backend=await startBackend({appRoot:process.cwd()});let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`${backend.origin}/api/health`);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs');
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {createImageFigure}=await import('/src/media-authoring.mjs');
    const image=document.createElement('canvas');image.width=image.height=32;
    const ink=image.getContext('2d');ink.fillStyle='#e89020';ink.fillRect(0,0,32,32);ink.fillStyle='#285acf';ink.fillRect(4,4,16,23);
    const figure=createImageFigure({dataUrl:image.toDataURL(),width:32,height:32,name:'Upload fixture'});figure.figure_type_id=20;
    const report=emptyDocument();report.canvas_width=320;report.canvas_height=240;report.figure_types.push(figure);
    report.keyframes=Array.from({length:5},(_,tick)=>createFrame(Array.from({length:12},(_,i)=>createObject(figure,i+1,35+i%4*65+tick*2,30+Math.floor(i/4)*65,{scale:1+(i+tick)*.03,field28:30+i*9}))));
    const options={report,view:{scale:1,x:0,y:0},cameraEnabled:true},resources=new PlaybackResources({preview:true}),packets=[];
    const directCanvas=document.createElement('canvas'),stagedCanvas=document.createElement('canvas');
    const direct=await createRenderer(directCanvas),staged=await createRenderer(stagedCanvas,{preparedCache:{maxFrames:2,maxBytes:4*1024*1024}});
    direct.resize(320,240,1);staged.resize(320,240,1);
    const scratch=new OffscreenCanvas(320,240),ctx=scratch.getContext('2d',{willReadFrequently:true});
    const pixels=async renderer=>{await renderer.device.queue.onSubmittedWorkDone();ctx.clearRect(0,0,320,240);ctx.drawImage(renderer===direct?directCanvas:stagedCanvas,0,0);return ctx.getImageData(0,0,320,240).data;};
    const equal=(a,b,label)=>{if(a.some((n,i)=>n!==b[i]))throw new Error(label);};
    let slices=0,cancellations=0;
    try{
      for(let tick=0;tick<5;tick++)packets.push(await compilePlaybackPacket(report,tick,{resources,revision:1,scale:1}));
      await direct.prepareBackgrounds(report,packets[0].frame);await staged.prepareBackgrounds(report,packets[0].frame);
      staged.prepareFrame(packets[0],options);staged.renderPrepared(packets[0].key,options);
      for(let tick=1;tick<5;tick++){
        const packet=packets[tick],previous=packets[tick-1],cache=staged.preparedFrames;
        const before=await pixels(staged),protect=new Set([previous.key,packet.key]);
        let warm=cache.beginWarm(packet,options,protect);if(!warm)throw new Error('Future frame was not admitted');
        cache.stepWarm(warm,0);cache.cancelWarm();cancellations++;
        if(cache.has(packet.key))throw new Error('Cancelled frame was published');
        staged.renderPrepared(previous.key,options);equal(before,await pixels(staged),'Cancellation changed the displayed frame');
        warm=cache.beginWarm(packet,options,protect);
        while(!cache.stepWarm(warm,0)){
          slices++;if(cache.has(packet.key))throw new Error('Partial frame was published');
          if(!staged.renderPrepared(previous.key,options))throw new Error('Displayed frame was evicted');
          equal(before,await pixels(staged),'An upload slice changed the displayed frame');
          if(cache.bytes>cache.maxBytes)throw new Error('Upload exceeded GPU budget');
        }
        direct.prepareFrame(packet,options);direct.renderPrepared(packet.key,options);staged.renderPrepared(packet.key,options);
        equal(await pixels(direct),await pixels(staged),'Staged pixels differ from synchronous rendering');
      }
      return {frames:5,slices,cancellations,pixelDifference:0,stats:{...staged.preparedFrames.stats}};
    }finally{staged.destroy();direct.destroy();resources.dispose();for(const p of packets)for(const entry of p.compatibility)entry.bitmap?.close();}
  });
  assert.deepEqual(errors,[]);await mkdir('artifacts/playback-upload',{recursive:true});await writeFile('artifacts/playback-upload/report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();backend.stop();}
