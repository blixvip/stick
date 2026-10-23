import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const result=await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const {createVfx}=await import('/src/vfx.mjs');
  const {evaluatedFrame,buildGeometry}=await import('/src/pivot/geometry.mjs');
  const {drawExportScene,drawExportSceneTiled}=await import('/src/export-frame-core.mjs');
  const {VfxGPU}=await import('/src/vfx-gpu.mjs');
  const {VfxWebGPU}=await import('/src/vfx-webgpu.mjs');
  const {ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
  const {createRenderer}=await import('/src/renderer.mjs');
  const pixels=canvas=>{const c=new OffscreenCanvas(canvas.width,canvas.height),ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
  const diff=(a,b)=>{let max=0,sum=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);sum+=d;}return {max,mean:sum/a.length};};
  const check=(test,message)=>{if(!test)throw new Error(message);};
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),gpuErrors=[];
  device.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));
  const gl=new VfxGPU(),wg=new VfxWebGPU(device),input=new OffscreenCanvas(128,96),ctx=input.getContext('2d');
  ctx.fillStyle='#287abc';ctx.fillRect(28,20,50,45);ctx.fillStyle='#f09529';ctx.fillRect(60,45,24,35);
  const kernels=[];
  for(const type of ['turbulence','tint','glow','outline','blur','shadow','bloom','dissolve']){
   const effect=createVfx(type,'kernel');effect.params.effectStrength=.4;
   if(type==='outline')Object.assign(effect.params,{mode:2,only:1});
   const a=pixels(gl.run(input,[effect])),b=pixels(wg.run(input,[effect]));await device.queue.onSubmittedWorkDone();
   const parity=diff(a,b);check(parity.max<=3,`${type} WebGPU parity ${JSON.stringify(parity)}`);
   const original=pixels(input),full=pixels(gl.run(input,[{...effect,params:{...effect.params,effectStrength:1}}]));let mixError=0;
   for(let i=0;i<a.length;i+=4)for(let channel=0;channel<4;channel++){
    const premul=(data,index)=>channel===3?data[index]:data[index]*data[i+3]/255;
    mixError=Math.max(mixError,Math.abs(premul(a,i+channel)-(.6*premul(original,i+channel)+.4*premul(full,i+channel))));
   }
   check(mixError<=2,`${type} premultiplied strength ${mixError}`);
   const zero={...effect,params:{...effect.params,effectStrength:0}};check(gl.run(input,[zero])===input&&wg.run(input,[zero])===input,`${type} zero strength`);
   kernels.push({type,...parity,mixError});
  }
  check(!gpuErrors.length,gpuErrors.join('\n'));gl.destroy();wg.destroy();device.destroy();
  const fixtures=[],renders=[];
  for(const scenario of ['turbulence','scene-turbulence','movieclip','container']){
   let doc=emptyDocument();doc.canvas_width=480;doc.canvas_height=300;
   const type='turbulence';
   doc.keyframes=[0,1,2].map(i=>{const object=createObject(doc.figure_types[0],1,70+i*150,235);const effect=createVfx(type,'t');
    effect.params.effectStrength=.7;object._stykVfx={figure:[effect]};
    return {...createFrame([object],10),_styk:{easing:{interpolation:'linear'}}};});
   if(scenario==='scene-turbulence')for(const frame of doc.keyframes){frame._stykVfx=frame.objects[0]._stykVfx;delete frame.objects[0]._stykVfx;}
   if(scenario==='movieclip'||scenario==='container'){const {Editor}=await import('/src/editor.mjs');const editor=new Editor({demo:false}).load(doc);editor.select(1);editor.createMovieclip({start:0,end:editor.totalTicks});if(scenario==='container'){editor.addVfx({kind:'figure',uid:editor.selectedUid},'turbulence');}
    doc=editor.report;}
   const frame=evaluatedFrame(doc,0,.8,8),geometry=buildGeometry(doc,frame),canvas=new OffscreenCanvas(480,300),tile=new OffscreenCanvas(480,300);
   canvas.getContext('2d',{willReadFrequently:true});tile.getContext('2d',{willReadFrequently:true});
   drawExportScene(canvas.getContext('2d'),doc,frame,geometry,{});await drawExportSceneTiled(tile.getContext('2d'),doc,frame,geometry,{preload:async()=>{}},96);
   const reference=pixels(canvas),tilePixels=pixels(tile),tiled=diff(reference,tilePixels);check(scenario==='scene-turbulence'?tiled.max<=8&&tiled.mean<.01:tiled.max<=3,`${scenario} tiled ${JSON.stringify(tiled)}`);
   const exporter=new ExportFrameRenderer({width:480,height:300});await exporter.load(doc);const exported=diff(reference,pixels(await exporter.renderTick(8)));const override=diff(reference,pixels(await exporter.renderFrame(frame)));check(override.max<=3,`${scenario} frame override ${JSON.stringify(override)}`);exporter.dispose();check(exported.max<=3,`${scenario} export worker ${JSON.stringify(exported)}`);
   const worker=new Worker('/src/playback-worker.mjs',{type:'module'});
   const packet=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Playback worker timed out')),15000);worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};worker.onmessage=({data})=>{if(data.type==='loaded')worker.postMessage({type:'prepare',revision:1,ticks:[8]});if(data.type==='packet'){clearTimeout(timer);resolve(data.packet);}if(data.type==='error'||data.type==='load-error'){clearTimeout(timer);reject(new Error(data.message));}};worker.postMessage({type:'load',report:doc,revision:1,scale:1,quality:1,baseURL:location.origin});});worker.terminate();
   const renderer=await createRenderer(document.createElement('canvas'));renderer.resize(480,300,1);
   renderer.render({report:doc,frame,geometry,view:{x:0,y:0,scale:1},cameraEnabled:true});const live=pixels(renderer.canvas);
   const key=renderer.prepareFrame(packet,{report:doc,view:{x:0,y:0,scale:1}});renderer.renderPrepared(key,{report:doc,view:{x:0,y:0,scale:1},cameraEnabled:true});const prepared=diff(live,pixels(renderer.canvas));
   check(prepared.mean<.5,`${scenario} prepared ${JSON.stringify(prepared)}`);
   packet.compatibility.forEach(item=>item.bitmap?.close());renderer.destroy();
   const blob=await canvas.convertToBlob();const dataURL=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});
   renders.push({scenario,dataURL});fixtures.push({scenario,tiled,exported,override,prepared});
  }
  const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
  const savedDoc=emptyDocument(),object=createObject(savedDoc.figure_types[0],1,150,200);object._stykVfx={figure:['tint','turbulence'].map(type=>{const effect=createVfx(type,type);effect.params.effectStrength=.37;return effect;})};savedDoc.keyframes=[createFrame([object],10)];
  const writer=new DocumentExporter(),reader=new ImportClient();let native;
  try{const blob=await writer.export(savedDoc,{format:'styk',name:'Strength VFX'}),imported=await reader.importFile(new File([blob],'strength-vfx.styk'));
   native={bytes:blob.size,identical:JSON.stringify(imported.document.keyframes[0].objects[0]._stykVfx)===JSON.stringify(object._stykVfx)};check(native.identical,'Native strength VFX roundtrip');
  }finally{writer.dispose();reader.dispose();}
  window.strengthResults=renders;return {kernels,fixtures,native};
 });
 await fs.mkdir('artifacts/vfx',{recursive:true});
 await page.evaluate(()=>{const grid=document.createElement('div');grid.id='strength-review';grid.style='position:fixed;inset:0;z-index:99999;overflow:auto;background:#e6e9ef;display:grid;grid-template-columns:repeat(2,480px);gap:20px;padding:24px;';for(const {scenario,dataURL} of window.strengthResults){const tile=document.createElement('div');tile.innerHTML=`<h3>${scenario}</h3><img src="${dataURL}">`;grid.append(tile);}document.body.append(grid);});
 await page.screenshot({path:'artifacts/vfx/strength-rendering.png',fullPage:true});for(const render of await page.evaluate(()=>window.strengthResults))await fs.writeFile(`artifacts/vfx/strength-${render.scenario}.png`,Buffer.from(render.dataURL.split(',')[1],'base64'));await page.locator('#strength-review').evaluate(node=>node.remove());
 // Rendering can be checked independently of the legacy pose-effect UI.
 if(!process.argv.includes('--render-only')){
 await page.getByRole('tab',{name:'VFX',exact:true}).click();await page.selectOption('#vfx-scope','figure');
 for(const type of ['tint','turbulence']){await page.locator('[data-vfx-action="add"]').click();assert.equal(await page.locator('[data-choice="motionTrail"], [data-choice="afterimage"]').count(),0);await page.locator(`[data-choice="${type}"]`).click();}
 assert.equal(await page.locator('.vfx-effect').count(),2);
 assert.equal(await page.getByText('Effect strength',{exact:true}).count(),2);
 const strength=page.getByRole('spinbutton',{name:'Turbulent displacement Effect strength',exact:true});await strength.fill('35');await strength.press('Enter');
 assert.equal(await page.evaluate(()=>styk.vfx.selectedEffect().effect.params.effectStrength),.35);
 await page.screenshot({path:'artifacts/vfx/strength-inspector.png'});
 }
 assert.deepEqual(errors,[]);await fs.writeFile('artifacts/vfx/strength-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
