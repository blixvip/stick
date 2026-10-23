/** Cold editable layouts and actual layer-sheet worker updates, with pixel checks. */
import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const {startBackend}=createRequire(import.meta.url)('../desktop/backend.cjs');
const backend=await startBackend({appRoot:process.cwd()}),errors=[],checks=[];let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    styk.settingsUI.commit({timelineMode:'advanced',autosaveSeconds:0});
    const {PlaybackCache}=await import('/src/playback.mjs'),prepare=PlaybackCache.prototype.prepareRange;
    PlaybackCache.prototype.prepareRange=function(...args){window.coldCache=this;return prepare.apply(this,args);};
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),report=emptyDocument();
    report.keyframes=[0,10,20].map(x=>createFrame([createObject(report.figure_types[0],1,200+x,200)],10));
    styk.editor.layerTimeline=true;styk.editor.load(report);styk.actions['close-dialog']();
  });
  await page.waitForFunction(()=>window.coldCache?.report===styk.editor.report);
  async function check(name,action,expectedKind='patch'){
    const result=await page.evaluate(async({action})=>{
      const e=styk.editor,c=coldCache,{compilePlaybackPacket}=await import('/src/playback-worker.mjs');
      if(action==='move'){e.select(1);e.moveSelection(20,5);}
      if(action==='undo')e.undo();if(action==='redo')e.redo();
      if(action==='blank')e.sheetInsertKey(['layer-1'],5,{blank:true});
      if(action==='retime')e.sheetMoveFrames(['layer-1'],10,10,3);
      if(action==='camera')e.setCameraValues({x:17,y:12,scale:1.2});
      if(action==='scene')e.setSceneColor(0xff336699);
      if(action==='definition'){const f=structuredClone(e.report.figure_types[0]);f.segments[0].thickness+=7;e.replaceFigureDefinition(f.figure_type_id,f);}
      const samples=[];
      for(const tick of [0,4,5,9,10,13,20]){
        await c.prepareRange([tick]);const packet=c.get(tick),reference=await compilePlaybackPacket(e.report,tick,{scale:c.scale});
        const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
        samples.push({tick,exact:same([...packet.shapes],[...reference.shapes])&&same([...packet.transforms],[...reference.transforms])&&same(packet.frame,reference.frame)});
      }
      return {samples,loadKind:c.stats.loadKind};
    },{action});
    assert.ok(result.samples.every(s=>s.exact),`${name}: ${JSON.stringify(result)}`);
    assert.equal(result.loadKind,expectedKind,`${name} uses the intended mirror update`);
    checks.push({name,...result});console.log('PASS',name);
  }
  await check('Initial layer sheet','initial','document');
  for(const [name,action] of [['Pose edit','move'],['Undo pose','undo'],['Redo pose','redo'],['Blank cell','blank'],['Undo blank','undo'],['Retime layer key','retime'],['Camera pose','camera'],['Scene pose','scene']])await check(name,action);
  await check('Drawing definition invalidates the mirror','definition','document');
  const pixels=await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs'),{createRenderer}=await import('/src/renderer.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const e=new Editor({layerTimeline:true});e.select(1);e.createMovieclip({start:0,end:15});
    const make=async sharedArtwork=>{const canvas=document.createElement('canvas');document.body.append(canvas);const renderer=await createRenderer(canvas,{sharedArtwork});renderer.resize(320,240,1);return {canvas,renderer};};
    const actual=await make(true),reference=await make(false),readCanvas=new OffscreenCanvas(320,240),ctx=readCanvas.getContext('2d',{willReadFrequently:true}),result=[];
    const read=canvas=>{ctx.clearRect(0,0,320,240);ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,320,240).data;};
    const options=()=>({report:e.report,frame:e.evaluatedFrame,view:{scale:.4,x:0,y:0},geometry:e.geometry,cameraEnabled:false,artworkRevision:e.definitionRevision});
    actual.renderer.render(options());
    try{
      for(const tick of [4,9,14,0,4]){
        e.seek(tick);const geometry=await e.prepareGeometry({sliceMs:0,yieldControl:()=>Promise.resolve()}),o={...options(),geometry};
        const prepared=await actual.renderer.prepareSceneUpdate(o);prepared.activate();actual.renderer.render(o);
        const a=read(actual.canvas);reference.renderer.render({...o,geometry:buildGeometry(e.report,e.evaluatedFrame)});const b=read(reference.canvas);
        let difference=0;for(let i=0;i<a.length;i++)difference=Math.max(difference,Math.abs(a[i]-b[i]));
        result.push({tick,maxPixelDifference:difference});
      }
      await actual.renderer.device.queue.onSubmittedWorkDone();await reference.renderer.device.queue.onSubmittedWorkDone();
      return {samples:result,warnings:[...actual.renderer.stats.warnings,...reference.renderer.stats.warnings]};
    }finally{actual.renderer.destroy();reference.renderer.destroy();actual.canvas.remove();reference.canvas.remove();}
  });
  assert.ok(pixels.samples.every(s=>s.maxPixelDifference<=1),JSON.stringify(pixels));assert.deepEqual(pixels.warnings,[]);assert.deepEqual(errors,[]);
  console.log('PASS nested clip editable layouts match fresh rendered pixels');
  await mkdir('artifacts/performance-improvements',{recursive:true});
  await writeFile(path.resolve('artifacts/performance-improvements/browser-regressions.json'),JSON.stringify({checks,pixels,errors},null,2));
}finally{await browser?.close();backend.stop();}
