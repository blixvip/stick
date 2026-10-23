import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const result=await page.evaluate(async()=>{
  const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const {compilePlaybackPacket}=await import('/src/playback-worker.mjs'),{createRenderer}=await import('/src/renderer.mjs');
  const {ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
  const {drawExportScene}=await import('/src/export-frame-core.mjs');
  const report=emptyDocument();report.canvas_width=320;report.canvas_height=240;report.keyframes=[0,1,2].map(()=>createFrame([createObject(report.figure_types[0],1,160,165)],10));
  const e=new Editor({demo:false}).load(report),clip=e.addVfxClip({kind:'figure',uid:1},'glow',{start:3,duration:15}),fx=e.getVfxClips()[0].effects[0];
  e.setVfxClipParameter(clip,fx.id,'radius',4,{key:true,tick:3});e.setVfxClipParameter(clip,fx.id,'radius',24,{key:true,tick:13});e.addVfxClip({kind:'scene'},'tint');
  const renderer=await createRenderer(document.createElement('canvas')),exporter=new ExportFrameRenderer({width:320,height:240});renderer.resize(320,240,1);await exporter.load(e.report);
  const pixels=canvas=>{const out=new OffscreenCanvas(320,240),ctx=out.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,320,240).data;};
  const diff=(a,b)=>a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0)/a.length,rows=[];
  try{for(const tick of [0,3,8,13,18,20]){
   e.seek(tick);const frame=e.evaluatedFrame,geometry=e.geometry,options={report:e.report,frame,geometry,view:{x:0,y:0,scale:1}};
   renderer.render(options);await renderer.device.queue.onSubmittedWorkDone();const live=pixels(renderer.canvas);
   const packet=await compilePlaybackPacket(e.report,tick,{gpuIsolation:true}),key=renderer.prepareFrame(packet,{report:e.report,view:options.view});
   if(!packet.frame._stykVfx?.figure.length)throw new Error('Persistent scene effects missing from playback');
   renderer.renderPrepared(key,{report:e.report,view:options.view});await renderer.device.queue.onSubmittedWorkDone();const prepared=pixels(renderer.canvas);
   const reference=structuredClone(frame);delete reference._vfxTimelineTick;delete reference._vfxTimelineScene;
   if(tick>=3&&tick<18)reference.objects[0]._stykVfx={figure:e.sampleVfxClip(clip)};
   reference._stykVfx={figure:e.sampleVfxClip(e.getVfxClips()[1].id)};
   const referenceReport={...e.report,_styk:{...e.report._styk,vfxClips:undefined}},expected=new OffscreenCanvas(320,240);
   drawExportScene(expected.getContext('2d'),referenceReport,reference,buildGeometry(referenceReport,reference),{});
   const exported=pixels(await exporter.renderTick(tick));rows.push({tick,livePrepared:diff(live,prepared),exportReference:diff(exported,pixels(expected))});
   for(const item of packet.compatibility)item.bitmap?.close();
  }}finally{renderer.destroy();exporter.dispose();}
  return rows;
 });
 // Unfiltered vectors retain the established Canvas/MSAA edge difference; isolated effects compare exactly.
 console.log(JSON.stringify(result));for(const row of result){assert.ok(row.livePrepared<.5,JSON.stringify(row));assert.ok(row.exportReference<(row.tick>=3&&row.tick<18?.01:.1),JSON.stringify(row));}assert.deepEqual(errors,[]);
}finally{await browser.close();}
