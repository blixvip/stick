import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=process.env.STYK_SCHEDULING_ARTIFACTS||'artifacts/drawing-scheduling',checks=[],errors=[];
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>errors.push(e.message));
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});console.log(ok?'PASS':'FAIL',name);};
try{
  if(process.env.STYK_SCHEDULING_BASELINE)for(const file of ['app.mjs','drawing-controller.mjs','renderer-geometry.mjs']){
    const body=execFileSync('git',['show',`${process.env.STYK_SCHEDULING_BASELINE}:src/${file}`],{encoding:'utf8',maxBuffer:4*1024*1024});
    await page.route(`**/src/${file}`,route=>route.fulfill({body,contentType:'text/javascript'}));
  }
  if(process.env.STYK_SCHEDULING_CANVAS)await page.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{PreviewImages}=await import('/src/preview-images.mjs'),{EMPTY_PNG}=await import('/src/drawing-model.mjs');
    const {PlaybackCache}=await import('/src/playback.mjs'),{ThumbnailRenderer}=await import('/src/thumbnail-renderer.mjs');
    const probe=window.probe={carriers:0,renders:0,overlays:0,paused:{}};
    for(const [Class,method,key] of [[PlaybackCache,'setInteractionActive','playback'],[ThumbnailRenderer,'setPaused','thumbnails']]){
      const original=Class.prototype[method];Class.prototype[method]=function(value){probe.paused[key]=Boolean(value);return original.call(this,value);};
    }
    const image=PreviewImages.prototype.image;PreviewImages.prototype.image=function(url){if(url===EMPTY_PNG)probe.carriers++;return image.call(this,url);};
    const r=styk.state.renderer,render=r.render;r.render=function(...args){probe.renders++;return render.apply(this,args);};
    const d=styk.drawing,overlay=d.overlayDraw;d.overlayDraw=function(...args){probe.overlays++;return overlay.apply(this,args);};
    styk.editor.load(emptyDocument());styk.editor.createDrawingLayer();styk.state.settings.autosaveSeconds=0;
    Object.assign(d.settings,{size:8,resolution:2,stabilization:0,color:'#203ed8'});
  });
  const box=await page.locator('#viewport').boundingBox(),start={x:box.x+140,y:box.y+170};
  for(let i=0;i<50;i++){
    if(i)await page.evaluate(()=>styk.editor.nextDrawing([styk.editor.activeLayerId],{blank:true}));
    await page.mouse.click(start.x+i*8,start.y+Math.sin(i/5)*40);
    await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.loading&&!styk.drawing.operation);
  }
  await page.mouse.move(2,2);await page.evaluate(()=>styk.drawing.barrier());await page.waitForTimeout(1200);
  const before=await page.evaluate(()=>({...probe}));await page.waitForTimeout(800);
  const idle=await page.evaluate(()=>({...probe}));
  check('50 dot cels settle without a continuous scene redraw loop',idle.renders-before.renders<=2);
  check('drawing carriers never enter the image decoder',idle.carriers===0);
  for(const onion of [false,true]){
    await page.evaluate(onion=>{styk.state.onion=onion;styk.drawing.onRender();},onion);await page.waitForTimeout(1000);
    const initial=await page.evaluate(()=>({...probe,scene:document.querySelector('#scene').toDataURL()}));
    await page.mouse.move(start.x,start.y+90);await page.mouse.move(start.x+300,start.y+150,{steps:60});
    await page.waitForTimeout(80);
    const hover=await page.evaluate(()=>({...probe,scene:document.querySelector('#scene').toDataURL()}));
    check(`cursor feedback updates without scene rendering (onion ${onion})`,hover.overlays>initial.overlays+3&&hover.renders-initial.renders<=2);
    check(`cursor movement preserves artwork pixels (onion ${onion})`,hover.scene===initial.scene);
  }
  await page.screenshot({path:output+'/cursor.png'});
  await page.mouse.move(start.x,start.y+180);await page.mouse.down();await page.waitForFunction(()=>styk.drawing.gesture?.session);
  await page.waitForTimeout(80);
  const active=await page.evaluate(()=>({...probe.paused}));
  check('stroke pauses playback preparation and timeline thumbnail jobs',active.playback&&active.thumbnails);
  const initial=await page.evaluate(()=>document.querySelector('#scene').toDataURL());
  await page.mouse.move(start.x+340,start.y+260,{steps:70});await page.waitForTimeout(100);
  check('stroke ink appears before pointer release',initial!==await page.evaluate(()=>document.querySelector('#scene').toDataURL()));
  await page.screenshot({path:output+'/stroke.png'});await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);
  await page.waitForTimeout(100);const settled=await page.evaluate(()=>({...probe.paused}));
  check('background preparation resumes after the stroke',!settled.playback&&!settled.thumbnails);
  // A cold cel can hold pointer-down before a stroke exists. Cancelling that
  // wait must release the same scheduler gate, without needing another move.
  await page.evaluate(()=>{const owner=styk.drawing.owner,original=owner.surface;probe.restoreSurface=()=>{owner.surface=original;};owner.surface=async function(...args){const result=await original.apply(this,args);await new Promise(resolve=>{probe.releaseSurface=resolve;});return result;};});
  await page.mouse.down();await page.waitForFunction(()=>Boolean(probe.releaseSurface));await page.waitForTimeout(80);
  check('loading a cel pauses speculative work before a stroke exists',await page.evaluate(()=>probe.paused.playback&&probe.paused.thumbnails));
  await page.evaluate(()=>{styk.drawing.cancel();probe.restoreSurface();probe.releaseSurface();});await page.mouse.up();await page.waitForTimeout(80);
  check('cancelling a pending cel load releases background work',await page.evaluate(()=>!probe.paused.playback&&!probe.paused.thumbnails&&!styk.drawing.interacting));
  await page.mouse.move(2,2);await page.waitForTimeout(80);
  check('leaving the viewport clears the brush cursor',await page.evaluate(()=>styk.drawing.cursor===null));
  check('no browser errors',errors.length===0);
  await writeFile(output+'/result.json',JSON.stringify({checks,errors,before,idle,active,settled,backend:await page.evaluate(()=>styk.state.renderer.stats.backend)},null,2));
  assert.ok(checks.every(c=>c.ok),'drawing scheduling regression');
}finally{await browser.close();}
