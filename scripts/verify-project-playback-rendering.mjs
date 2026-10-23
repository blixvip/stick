/** Compare selected real-project GPU frames against a saved pre-change worker. */
import {chromium} from '../tests/support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [source,referencePath]=process.argv.slice(2);
if(!source||!referencePath)throw new Error('Provide the input project and saved reference playback-worker.mjs.');
const {startBackend}=createRequire(import.meta.url)('../desktop/backend.cjs');
const backend=await startBackend({appRoot:process.cwd()}),output=path.resolve('artifacts/project-playback',process.env.STYK_COMPARE_LABEL||'pixel-comparison');let browser;
await mkdir(output,{recursive:true});
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const referenceRoot=path.dirname(path.resolve(referencePath));
  await page.route('**/baseline-src/**',async route=>{const name=new URL(route.request().url()).pathname.slice('/baseline-src/'.length);await route.fulfill({contentType:'text/javascript',body:await readFile(path.join(referenceRoot,name))});});
  if(process.env.STYK_CANDIDATE_SOURCES)await page.route('**/src/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice('/src/'.length);await route.fulfill({contentType:'text/javascript',body:await readFile(path.join(process.env.STYK_CANDIDATE_SOURCES,name))});
  });
  await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,path.extname(source)),{timeout:180000});
  const result=await page.evaluate(async()=>{
    const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs');
    const {compilePlaybackPacket:before,PlaybackResources:ReferenceResources}=await import('/baseline-src/playback-worker.mjs');
    const {createRenderer}=await import('/src/renderer.mjs');
    const {storedFrameReport}=await import('/src/pivot-frame-draft.mjs');
    const report=storedFrameReport(styk.editor.report),width=1400,height=800,canvas=document.createElement('canvas');
    const renderer=await createRenderer(canvas);renderer.resize(width,height,1);
    const out=new OffscreenCanvas(width,height),ctx=out.getContext('2d',{willReadFrequently:true});
    const aResources=new ReferenceResources({preview:true}),bResources=new PlaybackResources({preview:true}),checks=[],images=[];
    const render=async(packet)=>{await renderer.prepareBackgrounds(report,packet.frame);renderer.prepareFrame(packet,{report,cameraEnabled:true});renderer.renderPrepared(packet.key,{report,view:{scale:2,x:0,y:0},cameraEnabled:true});await renderer.device.queue.onSubmittedWorkDone();ctx.clearRect(0,0,width,height);ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,width,height).data;};
    try{
      for(const tick of[0,54,75,129,169,196,207,211,240,300,480,574,582]){
        const expected=await before(report,tick,{resources:aResources,revision:1,scale:2,gpuIsolation:true,maxPacketBytes:1024*1024*1024});
        const actual=await compilePlaybackPacket(report,tick,{resources:bResources,revision:2,scale:2,gpuIsolation:true,maxPacketBytes:1024*1024*1024});
        try{
          const a=await render(expected);if(tick===75||tick===480)images.push({name:`${tick}-before`,data:canvas.toDataURL()});
          const b=await render(actual);if(tick===75||tick===480)images.push({name:`${tick}-after`,data:canvas.toDataURL()});
          let total=0,max=0,changed=0,interiorMismatch=0;
          for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);total+=d;max=Math.max(max,d);if(d)changed++;}
          for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
            const i=(y*width+x)*4;if(![0,1,2,3].some(c=>Math.abs(a[i+c]-b[i+c])>4))continue;
            let edge=false;for(let c=0;c<4&&!edge;c++)for(let dy=-2;dy<=2&&!edge;dy++)for(let dx=-2;dx<=2;dx++)if(Math.abs(a[((y+dy)*width+x+dx)*4+c]-a[i+c])>4){edge=true;break;}
            if(!edge)interiorMismatch++;
          }
          checks.push({tick,mean:total/a.length,max,changed,interiorMismatch,beforeBytes:expected.byteLength,afterBytes:actual.byteLength,beforeQuality:expected.previewQuality,afterQuality:actual.previewQuality});
        }finally{for(const p of[expected,actual])for(const c of p.compatibility)c.bitmap?.close();renderer.clearPreparedFrames();}
      }
      return {checks,images,adapter:renderer.stats.adapter};
    }finally{aResources.dispose();bResources.dispose();renderer.destroy();}
  });
  for(const image of result.images)await writeFile(path.join(output,`${image.name}.png`),Buffer.from(image.data.split(',')[1],'base64'));delete result.images;
  await writeFile(path.join(output,'report.json'),JSON.stringify({...result,errors},null,2));console.log(JSON.stringify(result));assert.deepEqual(errors,[]);
  for(const check of result.checks){assert.ok(!check.beforeQuality.reduced&&!check.afterQuality.reduced);assert.ok(check.mean<.03&&check.interiorMismatch===0,JSON.stringify(check));}
}finally{await browser?.close();backend.stop();}
