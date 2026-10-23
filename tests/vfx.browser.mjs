import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');
 await page.waitForFunction(()=>window.styk?.ready,{timeout:60000});
 const result=await page.evaluate(async()=>{
  const {createVfx,VFX_REGISTRY}=await import('/src/vfx.mjs');
  const {VfxGPU}=await import('/src/vfx-gpu.mjs');
  const gpu=new VfxGPU(),source=new OffscreenCanvas(96,80),c=source.getContext('2d');
  c.fillStyle='#ff0000';c.fillRect(28,12,32,20);c.fillStyle='#0000ff';c.fillRect(28,48,32,20);
  const read=canvas=>{const out=new OffscreenCanvas(96,80),ctx=out.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,96,80).data;};
  const sample=(data,x,y)=>Array.from(data.slice((y*96+x)*4,(y*96+x)*4+4));
  const effects={};
  for(const type of Object.keys(VFX_REGISTRY)){
   const effect=createVfx(type,'test'),data=read(gpu.run(source,[effect]));
   effects[type]={top:sample(data,40,20),bottom:sample(data,40,60),edge:sample(data,26,20),corner:sample(data,0,0),error:gpu.gl.getError()};
  }
  gpu.destroy();return effects;
 });
 for(const [type,data] of Object.entries(result)){assert.equal(data.error,0,`${type} GL error`);assert.equal(data.corner[3],0,`${type} must preserve transparent corners`);}
 assert.equal(result.tint.top[3],255);assert.ok(result.tint.top[0]>result.tint.bottom[0],'top/bottom must keep source orientation');
 assert.ok(result.glow.edge[3]>0,'glow expands alpha');assert.ok(result.outline.edge[3]>0,'outline expands alpha');assert.ok(result.blur.edge[3]>0,'blur expands alpha');
 console.log('GPU output',JSON.stringify(result));
 // Cross-executor parity: the WGSL port must match the WebGL 2 executor on
 // every registered effect before it can replace it on the viewport path.
 const wgsl=await page.evaluate(async()=>{
  const {createVfx,VFX_REGISTRY}=await import('/src/vfx.mjs'),{VfxGPU}=await import('/src/vfx-gpu.mjs'),{VfxWebGPU}=await import('/src/vfx-webgpu.mjs');
  const adapter=await navigator.gpu?.requestAdapter(),device=await adapter?.requestDevice();if(!device)return null;
  const gl=new VfxGPU(),wg=new VfxWebGPU(device),source=new OffscreenCanvas(96,80),c=source.getContext('2d');
  c.fillStyle='#ff0000';c.fillRect(28,12,32,20);c.fillStyle='#0000ff';c.fillRect(28,48,32,20);
  const read=canvas=>{const out=new OffscreenCanvas(96,80),ctx=out.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,96,80).data;};
  const results={};
  // Each effect at defaults, plus a large-radius variant for the blur family so
  // the downsampled ops 11/12 (and their mid-run slot resizes) are exercised.
  for(const type of Object.keys(VFX_REGISTRY))for(const radius of['blur','glow','shadow','bloom'].includes(type)?[0,45]:[0]){
   const effect=createVfx(type,'test');if(radius)effect.params.radius=radius;
   const a=read(gl.run(source,[effect]));
   const out=wg.run(source,[effect],{});await device.queue.onSubmittedWorkDone();const b=read(out);
   let max=0,sum=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);sum+=d;}results[radius?`${type}-r${radius}`:type]={max,mean:sum/a.length};
  }
  gl.destroy();wg.destroy();device.destroy();return results;
 });
 if(wgsl){console.log('WGSL parity',JSON.stringify(wgsl));for(const [type,r] of Object.entries(wgsl))assert.ok(r.max<=24&&r.mean<.5,`${type}: WGSL executor diverged ${JSON.stringify(r)}`);}
 const parity=await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{createVfx}=await import('/src/vfx.mjs');
  const {exportFrameGeometry,drawExportScene,drawExportSceneTiled}=await import('/src/export-frame-core.mjs');
  const doc=emptyDocument();doc.canvas_width=320;doc.canvas_height=240;
  const obj=createObject(doc.figure_types[0],1,160,180,{scale:2}),frame=createFrame([obj],10);doc.keyframes=[frame];
  const resources={preload:async()=>{}},results={};
  for(const [scope,type,radius] of [['figure','glow',12],['figure','noise',0],['figure','pixelate',0],['scene','blur',40],['scene','pixelate',0],['scene','noise',0],['scene','vignette',0]]){
   delete obj._stykVfx;delete frame._stykVfx;const effect=createVfx(type,'test');if(radius)effect.params.radius=radius;(scope==='scene'?frame:obj)._stykVfx={figure:[effect]};
   const geometry=exportFrameGeometry(doc,frame),full=new OffscreenCanvas(320,240),tile=new OffscreenCanvas(320,240);
   drawExportScene(full.getContext('2d'),doc,frame,geometry,resources);await drawExportSceneTiled(tile.getContext('2d'),doc,frame,geometry,resources,96);
   const a=full.getContext('2d').getImageData(0,0,320,240).data,b=tile.getContext('2d').getImageData(0,0,320,240).data;
   let max=0,sum=0,count=0;for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);max=Math.max(max,delta);sum+=delta;if(delta>2)count++;}results[scope+'-'+type]={max,mean:sum/a.length,count};
  }return results;
 });
 console.log('Export parity',JSON.stringify(parity));
 for(const [name,result] of Object.entries(parity))assert.ok(result.max<=2,`${name}: tiled export differs ${JSON.stringify(result)}`);
 const saved=await page.evaluate(async()=>{
  const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');
  const doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,200,200)],20)];const e=new Editor({demo:false}).load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});
  e.select(1);const figure={kind:'figure',uid:1},node={kind:'segment',uid:1,figureTypeId:e.object.figure_type_id,handleId:e.figure.segments[0].segment_id},scene={kind:'scene'};
  e.addVfx(figure,'glow');e.addVfx(node,'outline');e.addVfx(scene,'noise');e.sheetInsertKey([e.layerForUid(1)],10);e.seek(10);const id=e.vfxEffects(figure)[0].id;e.setVfxParameter(figure,id,'radius',30);
  e.setVfxParameter(figure,id,'color',{type:'radial',angle:30,stops:[{offset:0,color:[255,80,40],opacity:.4},{offset:1,color:[40,100,255],opacity:1}]});
  const exporter=new DocumentExporter(),importer=new ImportClient();const sample=editor=>[0,5,10,19].map(t=>{editor.seek(t);return [editor.vfxEffects(figure),editor.vfxEffects(node),editor.vfxEffects(scene)];});
  try{const expected=JSON.stringify(sample(e)),blob=await exporter.export(e.report,{format:'styk',name:'VFX roundtrip'}),imported=await importer.importFile(new File([blob],'vfx.styk')),reopened=new Editor({demo:false}).load(imported.document);let blocked=false;try{await exporter.export(e.report,{format:'piv'});}catch(error){blocked=/cannot preserve VFX/.test(error.message);}
   return {bytes:blob.size,identical:expected===JSON.stringify(sample(reopened)),blocked};
  }finally{exporter.dispose();importer.dispose();}
 });
 assert.ok(saved.identical,'binary project roundtrip must preserve all sampled VFX');assert.ok(saved.blocked,'lossy Pivot export must fail explicitly');console.log('Native roundtrip',saved);
 await page.locator('[data-vfx-tab="vfx"]').click();
 await page.selectOption('#vfx-scope','scene');
 
 await page.locator('[data-vfx-action="add"]').click();
 await page.locator('.vfx-catalog [data-choice="noise"]').click();
 await page.getByRole('spinbutton',{name:'Noise Amount'}).fill('25');
 await page.getByRole('spinbutton',{name:'Noise Amount'}).press('Enter');
 assert.equal(await page.evaluate(()=>window.styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0]?.params.amount),.25);
 const beforeDrag=await page.evaluate(()=>({history:styk.editor._undo.length,keys:styk.editor.report._styk.layerSheet.tracks.scene.keys.length}));
 // The drag's value rounds with the slider's width (its 8px thumb): one splitter step widens the
 // inspector past the wide tier's 288px so the slider maps the middle half of its track steadily.
 await page.getByRole('separator',{name:'Resize properties panel'}).focus();await page.keyboard.press('ArrowLeft');
 const slider=page.getByRole('slider',{name:'Noise Amount slider'}),box=await slider.boundingBox();
 await page.mouse.move(box.x+box.width*.25,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height/2,{steps:12});await page.mouse.up();
 const dragged=await page.evaluate(()=>({amount:styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0].params.amount,history:styk.editor._undo.length,keys:styk.editor.report._styk.layerSheet.tracks.scene.keys.length}));
 assert.ok(dragged.amount>.7&&dragged.amount<.8);assert.equal(dragged.history,beforeDrag.history+1);assert.equal(dragged.keys,beforeDrag.keys);
 await page.evaluate(()=>styk.editor.undo());
 const label=page.locator('#vfx-panel [data-property-scrub]').filter({hasText:/^Amount$/}),labelBox=await label.boundingBox();
 await page.mouse.move(labelBox.x+10,labelBox.y+labelBox.height/2);await page.mouse.down();await page.mouse.move(labelBox.x+35,labelBox.y+labelBox.height/2,{steps:8});await page.mouse.up();
 assert.equal(await page.evaluate(()=>styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0].params.amount),.5);
 assert.equal(await page.locator('#vfx-panel [data-property-key]').count(),0);
 await page.getByRole('tab',{name:'Library',exact:true}).click();assert.equal(await page.locator('#vfx-panel').isVisible(),false);
 await page.getByRole('tab',{name:'VFX',exact:true}).click();assert.equal(await page.locator('#inspector').isVisible(),false);
 await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/inspector.png'});
 await page.evaluate(()=>{const e=styk.editor;e.select(e.evaluatedFrame.objects[0].unique_id,1);});
 await page.waitForFunction(()=>styk.vfx.targets()[0]?.kind==='segment');
 await page.locator('[data-vfx-action="add"]').click();await page.locator('.vfx-catalog [data-choice="glow"]').click();
 assert.equal(await page.evaluate(()=>styk.editor.sampleVfxClip(styk.vfx.selectedClip)[0].type),'glow');
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await page.screenshot({path:'artifacts/vfx/inspector-dark.png'});
 assert.deepEqual(errors,[]);console.log('VFX browser checks passed');
}finally{await browser.close();}
