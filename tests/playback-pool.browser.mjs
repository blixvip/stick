import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {startBackend}=createRequire(import.meta.url)('../desktop/backend.cjs');
const backend=await startBackend({appRoot:process.cwd()});let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${backend.origin}/api/health`);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const {SHAPE,shapeRecord}=await import('/src/renderer-geometry.mjs');
    const report={canvas_width:320,canvas_height:240,backgrounds:[]};
    const options={report,view:{scale:1,x:0,y:0},cameraEnabled:false};
    const subject=await createRenderer(document.createElement('canvas'),{preparedCache:{maxFrames:2,maxBytes:8*1024*1024}});
    const reference=await createRenderer(document.createElement('canvas'),{preparedCache:{maxFrames:2,maxBytes:8*1024*1024}});
    const output=new OffscreenCanvas(320,240),ctx=output.getContext('2d',{willReadFrequently:true});
    for(const renderer of [subject,reference])renderer.resize(320,240,1);
    const packets=[],checks=[],validation=[];
    const pixels=async(renderer)=>{await renderer.device.queue.onSubmittedWorkDone();ctx.clearRect(0,0,320,240);ctx.drawImage(renderer.canvas,0,0);return ctx.getImageData(0,0,320,240).data;};
    try {
      for(let tick=0;tick<12;tick++){
        const width=tick%3===0?128:101,height=tick%3===0?128:95;
        const vector=tick%4<2;
        const color=tick%2?[.1,.7,.2,1]:[.9,.1,.2,1];
        const entry={artworkKey:`pool-${tick}`,uid:1,root:{x:0,y:0},bounds:{x:0,y:0,width,height},pixelScale:1};
        if(vector)entry.vectorRaster={width,height,data:new Float32Array(shapeRecord({mode:SHAPE.RECT,a:[0,0,width,height],color}))};
        else {const source=new OffscreenCanvas(width,height),ink=source.getContext('2d');ink.fillStyle=`rgb(${color.slice(0,3).map(n=>n*255).join(',')})`;ink.fillRect(0,0,width,height);entry.bitmap=source.transferToImageBitmap();}
        const packet={key:`pool:${tick}`,revision:1,frame:{},cameraEnabled:false,
          shapes:new Float32Array(shapeRecord({mode:SHAPE.TEXTURE,a:[0,0,width,height],color:[1,1,1,1],transform:1})),
          transforms:new Float32Array([0,0,1,1,40+tick+.35,40.7,1,1]),uids:new Uint32Array([0,1]),
          groups:[{firstInstance:0,instanceCount:1,compatibilityIndex:0,transformIndex:1}],compatibility:[entry],objectCount:1};
        packets.push(packet);
        for(const renderer of [reference,subject]){
          renderer.device.pushErrorScope('validation');
          await renderer.prepareBackgrounds(report,packet.frame);
          // Glyph-mask allocation is exact and cannot enter the texture pool.
          // Keep the TEXTURE draw record unchanged to compare the same painter
          // against a fresh, exact-sized allocation without a second shader.
          const input=renderer===reference?{...packet,compatibility:[{...entry,glyphMask:true}]}:packet;
          renderer.prepareFrame(input,options);renderer.renderPrepared(packet.key,options);
          const error=await renderer.device.popErrorScope();if(error)validation.push({tick,subject:renderer===subject,message:error.message});
        }
        const a=await pixels(reference),b=await pixels(subject);let changed=0,max=0;
        for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d)changed++;max=Math.max(max,d);}
        checks.push({tick,vector,width,height,changed,max});
      }
      return {checks,validation,stats:{...subject.preparedFrames.stats}};
    }finally{subject.destroy();reference.destroy();for(const p of packets)p.compatibility[0].bitmap?.close();}
  });
  await mkdir('artifacts/playback-integrity',{recursive:true});
  await writeFile('artifacts/playback-integrity/pool-report.json',JSON.stringify({...result,errors},null,2));
  console.log(JSON.stringify(result));assert.deepEqual(errors,[]);assert.deepEqual(result.validation,[]);
  assert.ok(result.checks.every(c=>c.changed===0),'Recycled textures must exactly match fresh textures.');
} finally {await browser?.close();backend.stop();}
