/** Paused drawing pixels across holds, nested scopes and cooperative scene preparation. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {decodeDrawingPNGBytes} from '../src/drawing-png.mjs';
const output=process.env.STYK_DRAWING_SCRUB_ARTIFACTS||'artifacts/drawing-scrub';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}}),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.stack));
if(process.env.STYK_DRAWING_BASELINE)for(const file of ['drawing-controller.mjs','renderer.mjs'])
 await page.route('**/src/'+file,route=>route.fulfill({contentType:'text/javascript',body:execFileSync('git',['show',process.env.STYK_DRAWING_BASELINE+':src/'+file],{encoding:'utf8'})}));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
async function colors(){
 const {pixels}=await decodeDrawingPNGBytes(await page.locator('#scene').screenshot());let red=0,blue=0;
 for(let i=0;i<pixels.length;i+=4){if(pixels[i]>180&&pixels[i+1]<70&&pixels[i+2]<90)red++;if(pixels[i]<90&&pixels[i+1]<100&&pixels[i+2]>180)blue++;}
 return {red,blue};
}
async function center(){
 const point=await page.evaluate(async()=>{const {worldToScreen}=await import('/src/renderer.mjs');return worldToScreen({x:132,y:112},{report:styk.editor.report,frame:styk.editor.evaluatedFrame,view:styk.state.view,cameraEnabled:false});});
 const {pixels,width}=await decodeDrawingPNGBytes(await page.locator('#scene').screenshot()),at=(Math.round(point.y)*width+Math.round(point.x))*4;return [...pixels.slice(at,at+4)];
}
async function settled(){
 await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
}
async function seek(tick){await page.evaluate(t=>styk.editor.seek(t),tick);await settled();}
async function visible(name,color){
 let found;for(let tries=0;tries<25;tries++){await settled();found=await colors();if(color?found[color]>500:found.red<10&&found.blue<10)break;await page.waitForTimeout(100);}
 check(name+' '+JSON.stringify(found),color?found[color]>500&&found[color==='red'?'blue':'red']<10:found.red<10&&found.blue<10);
}
try{
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk?.ready);
 await page.evaluate(async()=>{
  styk.settingsUI.commit({autosaveSeconds:0,onionCount:0});
  const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{movieclipFigure}=await import('/src/movieclips.mjs');
  const e=new Editor({demo:false,layerTimeline:true});e.report.canvas_width=320;e.report.canvas_height=240;
  e.createDrawingLayer();e.extendDrawing(undefined,11);
  for(const tick of [4,6,10])e.drawingKey(undefined,tick,{blank:true});
  for(const [tick,color] of [[0,[230,20,40,255]],[6,[20,45,230,255]]]){
   e.seek(tick);const target=e.prepareDrawingCel({world:{x:100,y:80}});await e.drawingResources.surface(target.figure);
   e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:new Uint8ClampedArray(color)}]);
  }
  await e.drawingResources.flush();e.seek(0);window.drawingFixtures={plain:structuredClone(e.serialize())};
  function wrap(document){const report=emptyDocument(),clip=movieclipFigure(2,'Drawing clip',document,{duration:12,pivot:{x:0,y:0}});report.canvas_width=320;report.canvas_height=240;report.figure_types=[clip];report.keyframes=[createFrame([createObject(clip,1,0,0)],12),createFrame()];return report;}
  drawingFixtures.clip=wrap(structuredClone(drawingFixtures.plain));
  drawingFixtures.nested=wrap(structuredClone(drawingFixtures.clip));
  e.setActiveLayer('layer-1');e.addFigure(1);e.moveSelection(1000,1000);e.sheetInsertFrames(['layer-1'],1,11);
  drawingFixtures.composite=wrap(structuredClone(e.serialize()));
  const f=e.report.figure_types[0],base=f.segments[0];
  f.segments=Array.from({length:2000},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:1,thickness:1,angle_rad:0}));f.segment_count=2000;
  drawingFixtures.dense=structuredClone(e.serialize());
  for(const frame of [...drawingFixtures.dense.keyframes,...Object.values(drawingFixtures.dense._styk.frameSources??{})])for(const o of frame.objects)if(o.figure_type_id===f.figure_type_id){o.angles=f.segments.map(s=>s.angle_rad);o.len_flag=0;o.lengths=[];o.bend_flag=0;o.bends=[];}
  e.drawingResources.dispose();
 });
 for(const mode of ['gpu','scratch','canvas']){
  await page.evaluate(async mode=>{styk.settingsUI.commit({rendererMode:mode==='canvas'?'canvas':'gpu'});},mode);
  await page.waitForFunction(mode=>styk.state.renderer?.stats.backend===(mode==='canvas'?'Canvas 2D fallback':'WebGPU'),mode);
  await page.evaluate(async mode=>{if(mode==='scratch')await styk.state.renderer.setGpuDrawing(false);else await styk.state.renderer.gpuDrawingReady;},mode);
  for(const fixture of ['plain','dense','clip','nested','composite']){
   await page.evaluate(name=>{styk.editor.load(structuredClone(drawingFixtures[name]),name);styk.state.handles=false;styk.fit();},fixture);
   for(const tick of [0,3,4,6,9,11,2]){await seek(tick);await visible(mode+' '+fixture+' frame '+tick,tick<4?'red':tick>=6&&tick<10?'blue':null);}
   check(mode+' '+fixture+' reuses held cel decodes',await page.evaluate(()=>styk.drawing.owner.decodes<=2));
  }
  // The parent keeps its resource owner while a clip is edited in a child scope.
  await page.evaluate(()=>{styk.editor.load(structuredClone(drawingFixtures.clip));styk.fit();});await seek(0);await visible(mode+' clip before editing','red');
  await page.evaluate(()=>{styk.editor.select(1);styk.editor.updateObject({field28:128});});await settled();
  const faded=await center();check(mode+' movieclip drawing opacity '+faded,[243,138,148,255].every((v,i)=>Math.abs(faded[i]-v)<=2));
  await page.evaluate(()=>styk.editor.undo());await visible(mode+' undo drawing opacity','red');
  await page.evaluate(async()=>{
   const e=styk.editor;e.enterMovieclip(2);e.selectSheetLayer(e.layers.find(l=>l.drawing).id);e.seek(0);
   const t=e.drawingTarget(),surface=await e.drawingResources.surface(t.figure);
   e.commitDrawingPixels(t,[{tx:0,ty:0,before:surface.store.get(0,0).pixels.slice(),after:new Uint8ClampedArray([20,45,230,255])}]);
   await e.drawingResources.flush();e.leaveMovieclip();
  });await visible(mode+' parent updates after editing a clip','blue');
  await page.evaluate(()=>styk.editor.undo());await visible(mode+' undo clip edit restores its pixels','red');
  await page.evaluate(()=>styk.editor.redo());await visible(mode+' redo clip edit restores its pixels','blue');
  const exported=await page.evaluate(async()=>{
   const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs'),{ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
   const exporter=new DocumentExporter(),renderer=new ExportFrameRenderer({width:320,height:240}),report=structuredClone(drawingFixtures.nested);
   try{
    await renderer.load(report);const samples=[];
    for(const tick of [0,3,4,6,9,11]){await renderer.renderTick(tick);samples.push([...renderer.context.getImageData(132,112,1,1).data]);}
    const blob=await exporter.export(report,{format:'styk'}),read=await new ImportClient().importFile(new File([blob],'held-drawings.styk'));
    styk.editor.markSaved();await styk.acceptImport(read,'held-drawings.styk');return samples;
   }finally{exporter.dispose();renderer.dispose();}
  });
  check(mode+' exported held, blank and nested frames retain exact colors',JSON.stringify(exported)===JSON.stringify([[230,20,40,255],[230,20,40,255],[255,255,255,255],[20,45,230,255],[20,45,230,255],[255,255,255,255]]));
  await visible(mode+' actual native import paints its initial drawing without seeking','red');
 }
 await page.screenshot({path:output+'/paused-drawing.png'});check('no uncaught browser errors',errors.length===0);
 await writeFile(output+'/result.json',JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:output+'/failure.png'});await writeFile(output+'/failure.json',JSON.stringify({message:error.message,checks,errors},null,2));throw error;}
finally{await browser.close();}
