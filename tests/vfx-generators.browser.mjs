// Generated effects in the real app: live WebGPU and Canvas rendering, prepared
// GPU and software playback packets, export, determinism and the editing UI
// (catalogue previews, style suggestions, Shuffle and beam picking).
// Requires `npm run serve` (STYK_TEST_URL overrides http://127.0.0.1:47832).
import {chromium} from './support/playwright.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const out='artifacts/vfx-generators';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready,null,{timeout:60000});
 const report=await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');
  const {compilePlaybackPacket}=await import('/src/playback-worker.mjs'),{createRenderer}=await import('/src/renderer.mjs'),{ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
  const e=styk.editor,doc=emptyDocument(),fig=doc.figure_types[0];doc.canvas_width=640;doc.canvas_height=460;
  doc.keyframes=[0,1,2,3].map(i=>{const f=createFrame([createObject(fig,1,150+i*25,300),createObject(fig,2,470,300)],20);f._stykBackgroundColor=0xff14121c;return f;});
  e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});
  e.addVfxClip({kind:'figure',uid:1},'aura',{start:0,duration:60});
  const beam=e.addVfxClip({kind:'figure',uid:1},'beam',{start:4,duration:36});e.setVfxClipParameters(beam,e.getVfxClips().find(c=>c.id===beam).effects[0].id,{aimUid:2,aimHandle:0,seed:7});
  e.addVfxClip({kind:'figure',uid:2},'explosion',{start:14,duration:30});
  // Cartoon smoke adds outlined sprite draws beneath its puffs.
  const smoke=e.addVfxClip({kind:'figure',uid:2},'smoke',{start:0,duration:60});e.setVfxClipParameters(smoke,e.getVfxClips().find(c=>c.id===smoke).effects[0].id,{style:3,seed:3});
  const size={width:640,height:460},view={x:0,y:0,scale:1};
  const gpu=await createRenderer(document.createElement('canvas')),soft=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true});
  gpu.resize(size.width,size.height,1);soft.resize(size.width,size.height,1);
  const exporter=new ExportFrameRenderer(size);await exporter.load(e.report);
  const pixels=canvas=>{const o=new OffscreenCanvas(size.width,size.height),c=o.getContext('2d');c.drawImage(canvas,0,0,size.width,size.height);return c.getImageData(0,0,size.width,size.height).data;};
  const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i++)n+=Math.abs(a[i]-b[i]);return n/a.length;};
  const png=async(canvas,name)=>{const o=new OffscreenCanvas(size.width,size.height);o.getContext('2d').drawImage(canvas,0,0,size.width,size.height);const blob=await o.convertToBlob({type:'image/png'});window.__shots??={};window.__shots[name]=[...new Uint8Array(await blob.arrayBuffer())];};
  const rows=[];
  try{
   for(const tick of [10,18,30,48]){
    e.seek(tick);const frame=e.evaluatedFrame,geometry=e.geometry,options={report:e.report,frame,geometry,view};
    gpu.render({...options,vfxEnabled:false});await gpu.device.queue.onSubmittedWorkDone();const bare=pixels(gpu.canvas);
    gpu.render(options);await gpu.device.queue.onSubmittedWorkDone();const live=pixels(gpu.canvas);
    const packet=await compilePlaybackPacket(e.report,tick,{gpuIsolation:true}),key=gpu.prepareFrame(packet,{report:e.report,view});
    gpu.renderPrepared(key,{report:e.report,view});await gpu.device.queue.onSubmittedWorkDone();const prepared=pixels(gpu.canvas);
    soft.render(options);const canvasLive=pixels(soft.canvas);
    const software=await compilePlaybackPacket(e.report,tick,{softwareFrames:true}),softKey=soft.prepareFrame(software,{report:e.report});
    soft.renderPrepared(softKey,{report:e.report,view});const softwarePrepared=pixels(soft.canvas);
    const exported=pixels(await exporter.renderTick(tick));
    rows.push({tick,particles:packet.generators?.particles??0,effectVisible:diff(live,bare),livePrepared:diff(live,prepared),gpuCanvas:diff(live,canvasLive),canvasSoftware:diff(canvasLive,softwarePrepared),exportCanvas:diff(exported,canvasLive)});
    if(tick===30){await png(gpu.canvas,'prepared-gpu-30');await png(soft.canvas,'software-30');soft.render(options);await png(soft.canvas,'canvas-30');gpu.render(options);await gpu.device.queue.onSubmittedWorkDone();await png(gpu.canvas,'live-gpu-30');await png(await exporter.renderTick(30),'export-30');}
    for(const item of [...packet.compatibility,...software.compatibility])item.bitmap?.close();
   }
   // SVG has no vector form for particles: the frame is embedded as an image.
   e.seek(30);const {exportSVG}=await import('/src/svg-export.mjs'),svg=await (await exportSVG({report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,width:320,height:230})).text();
   rows.push({tick:'svg',svgEmbedded:svg.includes('embedded image')?1:0});
   // Export is independent of the order in which frames are rendered.
   const first=pixels(await exporter.renderTick(30));await exporter.renderTick(47);await exporter.renderTick(2);
   rows.push({tick:'repeat',exportRepeat:diff(first,pixels(await exporter.renderTick(30)))});
  }finally{gpu.destroy();soft.destroy();exporter.dispose();}
  return rows;
 });
 for(const [name,bytes] of Object.entries(await page.evaluate(()=>window.__shots??{})))await fs.writeFile(`${out}/${name}.png`,Buffer.from(bytes));
 console.table(report);
 assert.equal(report.find(r=>r.tick==='svg').svgEmbedded,1,'SVG export keeps generated effects');
 for(const row of report.filter(r=>typeof r.tick==='number')){
  assert.ok(row.particles>0,`tick ${row.tick} packets carry generated effects`);
  assert.ok(row.effectVisible>.5,`tick ${row.tick} effects change the frame (${row.effectVisible})`);
  assert.ok(row.livePrepared<.25,`tick ${row.tick} prepared playback matches live (${row.livePrepared})`);
  assert.ok(row.canvasSoftware<.25,`tick ${row.tick} software playback matches the Canvas renderer (${row.canvasSoftware})`);
  assert.ok(row.gpuCanvas<3,`tick ${row.tick} Canvas fallback resembles WebGPU (${row.gpuCanvas})`);
  // Two Canvas implementations round additive blending slightly differently.
  assert.ok(row.exportCanvas<1.5,`tick ${row.tick} export matches the Canvas renderer (${row.exportCanvas})`);
 }
 assert.equal(report.find(r=>r.tick==='repeat').exportRepeat,0,'export frames do not depend on render order');

 // Editing UI: catalogue order, playhead timing, beam picking and timeline tails.
 await page.evaluate(async()=>{const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');const e=styk.editor,doc=emptyDocument(),fig=doc.figure_types[0];doc.keyframes=[0,1,2,3,4].map(()=>createFrame([createObject(fig,1,260,300),createObject(fig,2,640,300)],20));e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});e.select(1);e.seek(6);styk.vfx.setVisible(true);styk.vfx.scope='figure';styk.vfx.sync();});
 await page.getByRole('tab',{name:'VFX',exact:true}).click();
 await page.getByRole('button',{name:'Add effect',exact:true}).click();
 assert.equal(await page.locator('.vfx-catalog h3').first().textContent(),'Generate');
 await page.locator('.vfx-catalog [data-choice="explosion"]').click();
 let clip=await page.evaluate(()=>styk.editor.getVfxClips()[0]);assert.deepEqual([clip.start,clip.duration],[6,36]);
 await page.evaluate(()=>styk.editor.deleteVfxClip(styk.editor.getVfxClips()[0].id));
 await page.locator('[data-vfx-action="add"]').click();await page.locator('.vfx-catalog [data-choice="beam"]').click();
 await page.getByRole('button',{name:'Pick',exact:true}).click();
 const node=await page.evaluate(()=>{const g=[...styk.editor.geometry.objects.values()].find(g=>g.obj.unique_id===2),[id,p]=[...g.joints.entries()].sort((a,b)=>a[1].y-b[1].y)[0],r=document.getElementById('overlay').getBoundingClientRect(),v=styk.state.view;return {id,x:r.left+v.x+p.x*v.scale,y:r.top+v.y+p.y*v.scale};});
 await page.mouse.click(node.x,node.y);
 clip=await page.evaluate(()=>styk.editor.getVfxClips()[0]);
 assert.deepEqual([clip.effects[0].params.aimUid,clip.effects[0].params.aimHandle],[2,node.id]);
 assert.match(await page.locator('.vfx-aim-target').textContent(),/node/);
 await page.evaluate(()=>styk.editor.seek(24));await page.waitForTimeout(300);
 await page.screenshot({path:`${out}/editor-beam.png`});
 await page.keyboard.press('Control+z');clip=await page.evaluate(()=>styk.editor.getVfxClips()[0]);assert.equal(clip.effects[0].params.aimUid,0,'picking is one undo step');
 // A style brings its suggested colour and settings in one undo step; Shuffle draws a new pattern.
 const undo=await page.evaluate(()=>styk.editor._undo.length);
 await page.locator('select[data-vfx-choice]').first().selectOption('1');
 clip=await page.evaluate(()=>styk.editor.getVfxClips()[0]);assert.deepEqual([clip.effects[0].params.style,clip.effects[0].params.color,clip.effects[0].params.width],[1,0xff3148,6]);
 assert.equal(await page.evaluate(()=>styk.editor._undo.length),undo+1);
 const seed=clip.effects[0].params.seed;await page.getByRole('button',{name:'Shuffle',exact:true}).click();
 assert.notEqual(await page.evaluate(()=>styk.editor.getVfxClips()[0].effects[0].params.seed),seed);
 // Generated effects show rendered previews in the catalogue; presets hold looks only.
 await page.locator('[data-vfx-action="add"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.vfx-catalog [data-preview]').length>=5&&!document.querySelector('.vfx-catalog [data-preview]:not(.has-preview)'),null,{timeout:30000});
 assert.equal(await page.locator('.vfx-catalog .vfx-catalog-results h3').first().textContent(),'Generate');
 await page.screenshot({path:`${out}/catalogue.png`});await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);
 await fs.writeFile(`${out}/browser.json`,JSON.stringify({date:new Date().toISOString(),rows:report,errors},null,2));
 console.log('vfx-generators.browser: ok');
}finally{await browser.close();}
