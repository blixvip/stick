import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const result=await page.evaluate(async()=>{
  const {createRenderer}=await import('/src/renderer.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{createVfx}=await import('/src/vfx.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs'),{drawExportScene}=await import('/src/export-frame-core.mjs'),{ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs'),{vfxPreviewGeometry,vfxPreviewFrame}=await import('/src/vfx-preview.mjs');
  const pixels=canvas=>{const out=new OffscreenCanvas(canvas.width,canvas.height),c=out.getContext('2d');c.drawImage(canvas,0,0);return c.getImageData(0,0,out.width,out.height).data;};
  const diff=(a,b)=>{let max=0,sum=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);sum+=d;}return {max,mean:sum/a.length};};
  const coverage=data=>{let count=0;for(let i=3;i<data.length;i+=4)if(data[i]>16)count++;return count;};
  const cropDifference=(full,panned,width,height,dx,dy)=>{let max=0,sum=0,n=0;for(let y=0;y<height-dy;y++)for(let x=0;x<width-dx;x++)for(let c=0;c<4;c++){const d=Math.abs(full[((y+dy)*width+x+dx)*4+c]-panned[(y*width+x)*4+c]);max=Math.max(max,d);sum+=d;n++;}return {max,mean:sum/n};};
  const result=[];
  for(const kind of ['figure','scene','combined','movieclip']){
   let report=emptyDocument();report.canvas_width=320;report.canvas_height=240;const object=createObject(report.figure_types[0],1,160,180);let frame=createFrame([object],20);report.keyframes=[frame];
   if(kind!=='scene')object._stykVfx={figure:[createVfx('tint','tint'),createVfx('glow','glow')]};
   if(kind!=='figure')frame._stykVfx={figure:[{...createVfx('grade','grade'),params:{exposure:.25,contrast:.9,saturation:.7,temperature:.2}},createVfx('noise','noise')]};
   if(kind==='scene'){frame.camera={x:14,y:-8,scale:.9,angle_rad:.2};frame._stykVfx.figure.push({...createVfx('blur','pan-blur'),params:{radius:8}},{...createVfx('pixelate','pan-pixelate'),params:{size:13}});}
   if(kind==='movieclip'){const {Editor}=await import('/src/editor.mjs');const e=new Editor({demo:false}).load(report);e.select(1);e.createMovieclip({start:0,end:e.totalTicks});e.addVfx({kind:'figure',uid:e.selectedUid},'outline');report=e.report;frame=e.evaluatedFrame;}
   const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas);renderer.resize(320,240,1);
   const geometry=buildGeometry(report,frame),options={report,frame,geometry,view:{x:0,y:0,scale:1}};
   renderer.render(options);const live=pixels(canvas);
   const unfiltered=new OffscreenCanvas(320,240);drawExportScene(unfiltered.getContext('2d'),report,vfxPreviewFrame(frame),vfxPreviewGeometry(geometry),{});renderer.render({...options,vfxEnabled:false});const snapshot=pixels(canvas);const bypass=diff(snapshot,pixels(unfiltered));if(bypass.mean>.5)throw new Error(`Bypass still contains filters: ${JSON.stringify({kind,bypass})}`);renderer.render(options);if(diff(live,pixels(canvas)).max)throw new Error('Re-enabling effects changed the rendered result');
   const reference=new OffscreenCanvas(320,240);drawExportScene(reference.getContext('2d'),report,frame,geometry,{});const ref=pixels(reference);
   // The viewport composites the filtered camera surface over the rendered
   // workspace; raw export pixels keep translucent artboard edges instead.
   const composited=new OffscreenCanvas(320,240),cc=composited.getContext('2d');cc.putImageData(new ImageData(Uint8ClampedArray.from(snapshot),320,240),0,0);cc.drawImage(reference,0,0);const refComp=pixels(composited);
   const worker=new Worker('/src/playback-worker.mjs',{type:'module'});
   const packet=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Playback worker timed out')),15000);worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};worker.onmessage=({data})=>{if(data.type==='loaded')worker.postMessage({type:'prepare',revision:1,ticks:[0]});if(data.type==='packet'){clearTimeout(timer);resolve(data.packet);}if(data.type==='error'||data.type==='load-error'){clearTimeout(timer);reject(new Error(data.message));}};worker.postMessage({type:'load',report,revision:1,scale:1,gpuIsolation:true,baseURL:location.origin});});
   const hasScene=Boolean(packet.frame._stykVfx),key=renderer.prepareFrame(packet,{report,view:options.view});if(!renderer.renderPrepared(key,{report,view:options.view}))throw new Error('Prepared VFX frame did not render');const prepared=pixels(canvas);
   if(hasScene){const view={x:-120,y:-80,scale:1};renderer.renderPrepared(key,{report,view});const preparedPan=cropDifference(prepared,pixels(canvas),320,240,120,80);renderer.render({...options,view});const livePan=cropDifference(live,pixels(canvas),320,240,120,80);if(livePan.max||preparedPan.max)throw new Error(`Panning changed camera VFX: ${JSON.stringify({kind,preparedPan,livePan})}`);}
   for(const item of packet.compatibility)item.bitmap?.close();
   const bypassPacket=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Bypass worker timed out')),15000);worker.onmessage=({data})=>{if(data.type==='packet'){clearTimeout(timer);resolve(data.packet);}if(data.type==='error'){clearTimeout(timer);reject(new Error(data.message));}};worker.postMessage({type:'invalidate',revision:2,retainDocument:true,options:{vfxEnabled:false}});worker.postMessage({type:'prepare',revision:2,ticks:[0]});});
   const bypassKey=renderer.prepareFrame(bypassPacket,{report,view:options.view});renderer.renderPrepared(bypassKey,{report,view:options.view});const preparedBypass=diff(pixels(canvas),pixels(unfiltered));if(bypassPacket.frame._stykVfx||preparedBypass.mean>.5)throw new Error(`Prepared bypass differs: ${JSON.stringify({kind,preparedBypass})}`);for(const item of bypassPacket.compatibility)item.bitmap?.close();worker.terminate();
   const exporter=new ExportFrameRenderer({width:320,height:240});await exporter.load(report);const exported=pixels(await exporter.renderTick(0)),svg=await exporter.renderSVGTick(0);const svgText=await svg.text();exporter.dispose();
   result.push({kind,backend:renderer.stats.backend,hasScene,live:diff(live,refComp),prepared:diff(prepared,refComp),livePrepared:diff(live,prepared),coverage:{live:coverage(live),prepared:coverage(prepared)},exported:diff(exported,ref),svg:svg.type==='image/svg+xml'&&svgText.includes('data:image/png'),warnings:renderer.stats.warnings});renderer.destroy();
  }
  for(const fallback of [false,true]){
   const report=emptyDocument();report.canvas_width=160;report.canvas_height=120;
   const frame=createFrame([],10);frame.camera={x:150,y:20,scale:.7,angle_rad:.3};report.keyframes=[frame];
   const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D:fallback});renderer.resize(480,320,1);
   const geometry=buildGeometry(report,frame),options={report,frame,geometry,view:{x:20,y:20,scale:1},cameraEnabled:false,clipToCanvas:false};renderer.render(options);const before=pixels(renderer.canvas);
   frame._stykVfx={figure:[{...createVfx('tint','camera'),params:{color:0xff0000,mix:1}}]};renderer.render(options);const after=pixels(renderer.canvas);
   const sample=(data,x,y)=>Array.from(data.slice((y*480+x)*4,(y*480+x)*4+4));
   const outside=sample(after,50,50),original=sample(before,50,50),inside=sample(after,250,100);
   if(JSON.stringify(outside)!==JSON.stringify(original)||inside[0]!==255||inside[1]!==0||inside[2]!==0||inside[3]!==255)throw new Error(`Camera VFX region is wrong: ${JSON.stringify({fallback,outside,original,inside})}`);
   renderer.destroy();
   const effectFrame=createFrame([createObject(report.figure_types[0],1,90,110)],10);effectFrame._stykVfx={figure:[{...createVfx('blur','pan-blur'),params:{radius:7}},{...createVfx('pixelate','pan-pixelate'),params:{size:13}}]};report.keyframes=[effectFrame];
   const panRenderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D:fallback});panRenderer.resize(160,120,1);const panOptions={report,frame:effectFrame,geometry:buildGeometry(report,effectFrame),view:{x:0,y:0,scale:1}};panRenderer.render(panOptions);const full=pixels(panRenderer.canvas);panRenderer.render({...panOptions,view:{x:-40,y:-30,scale:1}});const panDifference=cropDifference(full,pixels(panRenderer.canvas),160,120,40,30);if(panDifference.max)throw new Error(`Camera crop differs in ${fallback?'Canvas':'WebGPU'}: ${JSON.stringify(panDifference)}`);panRenderer.destroy();
   for(const cameraEnabled of [false,true]){
    const blank=createFrame([],10);blank._stykVfx={figure:[{...createVfx('tint','overlay'),params:{color:0xff0000,mix:1}}]};report.keyframes=[blank];
    const overlayRenderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D:fallback});overlayRenderer.resize(160,120,1);const overlayOptions={report,frame:blank,geometry:buildGeometry(report,blank),view:{x:0,y:0,scale:1},cameraEnabled};overlayRenderer.render(overlayOptions);const without=pixels(overlayRenderer.canvas);overlayRenderer.render({...overlayOptions,onionFrames:[{frame:effectFrame,opacity:.5}]});const overlayDiff=diff(without,pixels(overlayRenderer.canvas));if(overlayDiff.mean<.1)throw new Error(`Scene VFX hid onion skins: ${JSON.stringify({fallback,cameraEnabled,overlayDiff})}`);overlayRenderer.destroy();
   }
  }return result;
 });
 console.log(JSON.stringify(result,null,2));
 // Existing vector MSAA and Canvas edges differ; filtered compatibility artwork
 // is exact. Live and prepared playback now share the same full-resolution WGSL
 // path, so their outputs are identical apart from retained-artwork AA.
 for(const row of result){assert.equal(row.backend,'WebGPU');assert.equal(row.hasScene,row.kind!=='figure');assert.ok(row.live.mean<.5,JSON.stringify(row));assert.ok(row.kind==='figure'?row.livePrepared.max===0:row.livePrepared.max<=8&&row.livePrepared.mean<.5&&row.prepared.mean<.5&&row.coverage.prepared>=row.coverage.live*.9,JSON.stringify(row));assert.ok(row.kind==='scene'?row.exported.mean<.5:row.exported.max<=1,JSON.stringify(row));assert.ok(row.svg);assert.ok(!row.warnings?.length);}
 await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/rendering.json',JSON.stringify(result,null,2));
}finally{await browser.close();}

