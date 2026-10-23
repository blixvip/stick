import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const results=await page.evaluate(async()=>{
  const {createRenderer}=await import('/src/renderer.mjs'),{Editor}=await import('/src/editor.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const pixels=canvas=>{const out=new OffscreenCanvas(canvas.width,canvas.height),ctx=out.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,out.width,out.height).data;};
  const diff=(a,b)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;};
  const results=[];
  for(const forceCanvas2D of [false,true])for(const scope of ['figure','connected','scene'])for(const type of ['wave','turbulence']){
   const report=emptyDocument();report.canvas_width=500;report.canvas_height=400;report.keyframes=[createFrame([createObject(report.figure_types[0],1,200,280)],20)];
   const e=new Editor({demo:false}).load(report);e.select(1);e.addVfxClip(scope==='scene'?{kind:'scene'}:{kind:'figure',uid:1},type,{includeAttached:scope==='connected'});
   const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas,{forceCanvas2D});renderer.resize(500,400,1);
   const options=()=>({report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,view:{x:0,y:0,scale:1},cameraEnabled:false});
   renderer.render(options());const initial=pixels(canvas),undo=e._undo.length;e.beginTranslationDrag();
   renderer.render({...options(),dragTranslations:new Map([[1,{x:65,y:-20}]])});const preview=pixels(canvas);
   e.moveSelection(65,-20,{fromStart:true});e.commitDrag();renderer.render(options());const committed=pixels(canvas);
   const other=document.createElement('canvas'),fresh=await createRenderer(other,{forceCanvas2D});fresh.resize(500,400,1);fresh.render(options());
   const freshDiff=diff(committed,pixels(other));e.undo();renderer.render(options());const undoDiff=diff(initial,pixels(canvas));e.redo();renderer.render(options());
   results.push({backend:renderer.stats.backend,scope,type,previewCommit:diff(preview,committed),fresh:freshDiff,undo:undoDiff,redo:diff(committed,pixels(canvas)),history:e._undo.length-undo});
   fresh.destroy();renderer.destroy();
  }
  return results;
 });
 for(const type of ['wave','turbulence']){
  await page.evaluate(async type=>{const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');const doc=emptyDocument();doc.keyframes=[createFrame([createObject(doc.figure_types[0],1,300,320)],20)];const e=styk.editor;e.load(doc);const {initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');initializeLayerSheet(e.report);e._invalidate({timing:true});e.select(1);const id=e.addVfxClip({kind:'figure',uid:1},type);e._selectedVfxClip=id;e._emit('vfx-selection');styk.vfx.setVisible(true);styk.vfx.sync();},type);
  await page.getByRole('tab',{name:'VFX',exact:true}).click();
  const point=await page.evaluate(async()=>{await new Promise(requestAnimationFrame);const {worldToScreen}=await import('/src/renderer-geometry.mjs'),g=styk.vfxGizmos,control=g.control(),p=worldToScreen(styk.editor.geometry.objects.get(0).root,control.options),r=g.canvas.getBoundingClientRect();return {x:r.left+p.x,y:r.top+p.y,scale:control.options.view.scale};});
  const clips=await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips));
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+50*point.scale,point.y+20*point.scale,{steps:8});await page.mouse.up();
  const root=await page.evaluate(()=>styk.editor.geometry.objects.get(0).root);assert.ok(Math.abs(root.x-350)<.001&&Math.abs(root.y-340)<.001,type);
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.vfxClips)),clips);
 }
 console.log(JSON.stringify({errors,results}));assert.deepEqual(errors,[]);for(const result of results){for(const key of ['previewCommit','fresh','undo','redo'])assert.ok(result[key]<.1,JSON.stringify(result));assert.equal(result.history,1);}
}finally{await browser.close();}
