import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const output='artifacts/connector-properties';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1100,height:760}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {rigExampleDocument}=await import('/src/rig-examples.mjs');styk.editor.load(rigExampleDocument('sliding-carriage'));styk.editor.select(1,2);styk.fit();});await settle();
  const before=await page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
  assert.equal(await page.locator('#segment-color').count(),0);
  await page.locator('#rig-position').fill('27');await page.locator('#rig-position').press('Tab');await settle();
  assert.equal(await page.evaluate(()=>styk.editor.object.lengths[2]),.27);
  await page.evaluate(()=>styk.editor.undo());await settle();
  assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.serialize())),before);
  await page.locator('[data-connector-part="segment"]').click();assert.equal(await page.locator('#segment-color').count(),1);
  await page.locator('[data-connector-part="slider"]').click();assert.equal(await page.locator('#segment-color').count(),0);
  for(const builder of [false,true]){
    if(builder)await page.evaluate(()=>{styk.builder.enter();styk.editor.select(1,2);styk.fit();});await settle();
    for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await settle();await page.screenshot({path:`${output}/${builder?'builder':'animate'}-${theme}.png`});}
  }
  // Verify the retained GPU pipeline renders diamonds without changing upload behavior.
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const canvas=document.createElement('canvas');canvas.style.cssText='position:fixed;width:120px;height:80px';document.body.append(canvas);
    const renderer=await createRenderer(canvas);if(!renderer.handleRenderer)throw Error('GPU handles unavailable');renderer.resize(120,80,1);
    const handles=[{uid:1,point:{x:30,y:30},screenRadius:10,color:'#ff0000',connector:true},{uid:2,point:{x:80,y:30},screenRadius:10,color:'#ff0000'}];
    const options={report:{...styk.editor.report,canvas_width:120,canvas_height:80},frame:{objects:[],background_id:0},canvasHandles:handles,outlineHandles:false,view:{scale:1,x:0,y:0},cameraEnabled:false,editorBackgroundColor:0xffffffff};
    renderer.render(options);await renderer.device.queue.onSubmittedWorkDone();
    const surface=document.createElement('canvas');surface.width=120;surface.height=80;const c=surface.getContext('2d');c.drawImage(canvas,0,0);
    const pixel=(x,y)=>Array.from(c.getImageData(x,y,1,1).data);
    renderer.render(options);const result={diamondCenter:pixel(30,30),diamondCorner:pixel(36,36),circleCorner:pixel(86,36),uploads:renderer.stats.handleUploadBytes,warnings:renderer.stats.warnings};renderer.destroy();canvas.remove();return result;
  });
  assert.deepEqual(result.diamondCenter,[255,0,0,255]);assert.deepEqual(result.diamondCorner,[255,255,255,255]);assert.deepEqual(result.circleCorner,[255,0,0,255]);assert.equal(result.uploads,0);assert.deepEqual(result.warnings,[]);
  assert.deepEqual(errors,[]);console.log('Connector properties, undo, compact themes and retained GPU diamond pixels passed.');
}finally{await browser.close();}
