import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const result=await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{buildGeometry,drawGeometry}=await import('/src/pivot/geometry.mjs'),
   {createVfx}=await import('/src/vfx.mjs'),{withVfx}=await import('/src/vfx-canvas.mjs'),{objectBounds}=await import('/src/renderer-geometry.mjs'),
   {createRenderer}=await import('/src/renderer.mjs'),{drawExportScene,drawExportSceneTiled}=await import('/src/export-frame-core.mjs'),
   {compilePlaybackPacket}=await import('/src/playback-worker.mjs'),{ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
  const report=emptyDocument();report.canvas_width=320;report.canvas_height=300;
  const fig=report.figure_types[0],root=createObject(fig,1,160,235),child=createObject(fig,2,160,235);
  child.join={target_object_slot:0,target_unique_id:1,target_handle_id:1};
  const frame=createFrame([root,child],10);report.keyframes=[frame];
  const stack=[createVfx('tint','tint'),createVfx('outline','outline')];stack[0].params.color=0xff0044;stack[0].params.mix=1;stack[1].params.width=4;
  root._stykVfx={figure:stack};root._stykVfxScope=1;
  const pixels=canvas=>{const c=new OffscreenCanvas(320,300),ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,320,300).data;};
  const difference=(a,b)=>{let max=0,sum=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);sum+=d;}return {max,mean:sum/a.length};};
  const geometry=buildGeometry(report,frame),baseline=structuredClone(report);delete baseline.keyframes[0].objects[0]._stykVfx;
  const raw=buildGeometry(baseline,baseline.keyframes[0]),reference=new OffscreenCanvas(320,300),ctx=reference.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,320,300);
  withVfx(ctx,stack,target=>drawGeometry(target,raw),{bounds:objectBounds(raw.drawables),domainBounds:objectBounds(raw.drawables,{vfxBounds:false})});
  const expected=pixels(reference),rows=[];
  for(const fallback of [false,true]){
   const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas,{forceCanvas2D:fallback});renderer.resize(320,300,1);
   const options={report,frame,geometry,view:{x:0,y:0,scale:1}};renderer.render(options);const live=pixels(canvas);
   const packet=await compilePlaybackPacket(report,0,{softwareFrames:fallback,scale:1}),key=renderer.prepareFrame(packet,{report,view:options.view});
   if(!renderer.renderPrepared(key,{report,view:options.view}))throw new Error('Prepared group did not render');
   const prepared=pixels(canvas);
   if(!fallback&&renderer.renderPrepared(key,{report,view:options.view,hiddenUids:new Set([2])}))throw new Error('A baked connected group accepted stale child visibility');
   renderer.render({...options,hiddenUids:new Set([2])});const hidden=pixels(canvas);
   renderer.render({...options,vfxEnabled:false});const bypass=pixels(canvas);
   rows.push({backend:renderer.stats.backend,live:difference(live,expected),prepared:difference(prepared,expected),hidden:difference(hidden,live),bypass:difference(bypass,live)});
   for(const item of packet.compatibility??[])item.bitmap?.close();packet.softwareBitmap?.close();renderer.destroy();
  }
  const exported=new OffscreenCanvas(320,300);drawExportScene(exported.getContext('2d'),report,frame,geometry,{});
  const direct=difference(pixels(exported),expected);
  const tiled=new OffscreenCanvas(320,300);await drawExportSceneTiled(tiled.getContext('2d'),report,frame,geometry,{preload:async()=>{}},128);
  const tile=difference(pixels(tiled),expected);
  const exporter=new ExportFrameRenderer({width:320,height:300});await exporter.load(report);const worker=difference(pixels(await exporter.renderTick(0)),expected);
  const svg=await exporter.renderSVGTick(0);exporter.dispose();
  // Exercise the real inspector control, clipboard, undo and native tween.
  const e=window.styk.editor;e.load(report);e.select(1);window.styk.vfx.setVisible(true);window.styk.vfx.scope='figure';window.styk.vfx.sync();
  const {ThumbnailRenderer}=await import('/src/thumbnail-renderer.mjs'),{drawCameraMonitor}=await import('/src/camera-monitor.mjs');
  const thumb=document.createElement('canvas');thumb.width=320;thumb.height=300;const thumbnails=new ThumbnailRenderer(e);let thumbnail;
  try{if(!await thumbnails.renderThumbnail(0,thumb))throw new Error('Thumbnail did not render');thumbnail=difference(pixels(thumb),expected);}finally{thumbnails.destroy();}
  const monitor=document.createElement('canvas');monitor.style.cssText='position:fixed;left:0;top:0;width:320px;height:300px';document.body.append(monitor);
  if(!drawCameraMonitor(monitor,{report,frame,geometry,resources:{}}))throw new Error('Camera monitor did not render');const camera=difference(pixels(monitor),expected);monitor.remove();
  const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{Editor}=await import('/src/editor.mjs');
  const saver=new DocumentExporter(),importer=new ImportClient();let roundtrip;
  try{const blob=await saver.export(e.report,{format:'styk',name:'Connected effects'}),imported=await importer.importFile(new File([blob],'connected.styk')),reopened=new Editor({demo:false}).load(imported.document);roundtrip={scope:reopened.animationValue({kind:'figure',uid:1},'vfxScope'),effects:reopened.vfxEffects({kind:'figure',uid:1}).length,joined:Boolean(reopened.evaluatedFrame.objects[1].join)};}finally{saver.dispose();importer.dispose();}
  return {rows,direct,tile,worker,roundtrip,thumbnail,camera,svg:(await svg.text()).includes('data:image/png')};
 });
 console.log(JSON.stringify(result,null,2));
 for(const row of result.rows){assert.ok(row.live.mean<.6,JSON.stringify(row));assert.ok(row.prepared.mean<.6,JSON.stringify(row));assert.ok(row.hidden.mean>.1);assert.ok(row.bypass.mean>.1);}
 assert.ok(result.direct.mean<.1,JSON.stringify(result.direct));assert.ok(result.tile.mean<.1,JSON.stringify(result.tile));assert.ok(result.worker.mean<.6,JSON.stringify(result.worker));assert.ok(result.svg);
 assert.deepEqual(result.roundtrip,{scope:1,effects:2,joined:true});
 assert.ok(result.thumbnail.mean<.1,JSON.stringify(result.thumbnail));assert.ok(result.camera.mean<.1,JSON.stringify(result.camera));
 await page.getByRole('tab',{name:'VFX',exact:true}).click();
 const scope=page.getByLabel('Effect target',{exact:true});await scope.selectOption('figure');assert.equal(await page.evaluate(()=>styk.editor.animationValue({kind:'figure',uid:1},'vfxScope')),0);await scope.selectOption('connected');assert.equal(await page.evaluate(()=>styk.editor.animationValue({kind:'figure',uid:1},'vfxScope')),1);
 await page.mouse.move(100,60);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/connected-inspector.png'});await fs.writeFile('artifacts/vfx/connected.json',JSON.stringify(result,null,2));
 await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');
  const doc=emptyDocument();doc.keyframes=[0,1].map(()=>createFrame([createObject(doc.figure_types[0],1,160,200)],10));
  const e=styk.editor;e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});e.select(1);
  const target={kind:'figure',uid:1};e.sheetSetEasing([e.layerForUid(1)],0,0,{interpolation:'linear'});const [id]=e.addVfx(target,'tint');e.setVfxParameter(target,id,'mix',.2);e.setVfxScope(target,true);
  styk.vfx.setVisible(true);styk.vfx.scope='figure';styk.vfx.sync();
 });
 await page.getByLabel('Tint actions',{exact:true}).click();await page.getByRole('menuitem',{name:'Copy effect',exact:true}).click();
 await page.evaluate(()=>{styk.editor.seek(10);styk.vfx.sync();});await page.getByRole('button',{name:'Paste effect',exact:true}).click();await page.getByRole('button',{name:'Tint',exact:true}).click();
 assert.equal(await page.evaluate(()=>styk.editor.animationValue({kind:'figure',uid:1},'vfxScope')),1);
 const mix=page.getByRole('spinbutton',{name:'Tint Mix',exact:true});await mix.fill('100');await mix.press('Enter');
 assert.ok(Math.abs(await page.evaluate(()=>{styk.editor.seek(5);return styk.editor.vfxEffects({kind:'figure',uid:1})[0].params.mix;})-.6)<1e-12);
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
