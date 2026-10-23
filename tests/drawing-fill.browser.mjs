import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.env.STYK_FILL_ARTIFACTS||'artifacts/drawing-tiled-fill/browser',checks=[],errors=[];await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);await page.locator('[data-workspace-mode="draw"]').click();
  const point=await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs'),{transformPoint}=await import('/src/drawing-model.mjs'),{worldToScreen}=await import('/src/renderer-geometry.mjs');
    const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();styk.state.settings.autosaveSeconds=0;
    const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),store=new TileStore();
    for(let y=176;y<=208;y++)for(let x=240;x<=272;x++)if(x===240||x===272||y===176||y===208)store.writable(Math.floor(x/64),Math.floor(y/64)).pixels.set([25,35,45,255],((y%64)*64+x%64)*4);
    store.set(20000,20000,new Uint8ClampedArray([20,40,60,255]));
    e.commitDrawingPixels(target,[...store].map(t=>({tx:t.tx,ty:t.ty,before:null,after:t.pixels})));await d.barrier();
    d.tool='fill';Object.assign(d.settings,{color:'#dc3020',opacity:1,tolerance:0,expansion:0,gap:0,sampleAll:false});d.onUI();
    const operation=d.pixelOperation.bind(d);d.pixelOperation=(...args)=>{const result=operation(...args);window.lastFillOperation=d.operation;return result;};
    window.fillSurface=d.owner.entry(e.drawingTarget().figure);window.fillOriginal=Array.from(fillSurface.store.readRect(238,174,37,37));window.fillHistory=e._undo.length;
    const p=worldToScreen(transformPoint(d.pixelMatrix(e.drawingTarget()),{x:256,y:192}),{report:e.report,frame:e.evaluatedFrame,view:styk.state.view,cameraEnabled:false}),r=d.viewport.getBoundingClientRect();return {x:r.left+p.x,y:r.top+p.y};
  });
  await page.mouse.click(point.x,point.y);await page.waitForFunction(()=>styk.editor.undoLabel==='Fill drawing'&&!styk.drawing.operation);
  check('a real fill click succeeds despite distant artwork spanning over a trillion pixels',await page.evaluate(()=>fillSurface.store.pixel(256,192).join()==='220,48,32,255'));
  check('the enclosed fill crosses tile boundaries without changing the wall or distant mark',await page.evaluate(()=>[[245,181],[267,181],[245,203],[267,203]].every(([x,y])=>fillSurface.store.pixel(x,y)[0]===220)&&fillSurface.store.pixel(240,192)[0]===25&&fillSurface.store.pixel(274,192)[3]===0&&fillSurface.store.pixel(1280000,1280000).join()==='20,40,60,255'));
  check('the fill commits exactly one undo command and releases its working reservation',await page.evaluate(()=>styk.editor._undo.length===fillHistory+1&&!styk.drawing.owner.working.has(lastFillOperation)));
  await page.screenshot({path:output+'/filled.png'});
  await page.evaluate(()=>styk.drawing.history('undo'));
  check('Undo restores every sampled byte',await page.evaluate(()=>fillSurface.store.readRect(238,174,37,37).every((v,i)=>v===fillOriginal[i])));
  await page.evaluate(()=>styk.drawing.history('redo'));
  check('Redo restores the enclosed fill',await page.evaluate(()=>fillSurface.store.pixel(256,192).join()==='220,48,32,255'));
  await page.evaluate(()=>styk.drawing.history('undo'));
  await page.evaluate(()=>{window.cancelledFillWorker=styk.drawing.owner.worker.worker;});
  await page.mouse.click(point.x+80,point.y);await page.waitForFunction(()=>styk.drawing.operation&&styk.drawing.owner.worker.pending.size>0);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!styk.drawing.operation);
  check('Escape terminates an actively computing open-region fill without changing pixels',await page.evaluate(()=>styk.drawing.owner.worker.worker!==cancelledFillWorker&&fillSurface.store.readRect(238,174,37,37).every((v,i)=>v===fillOriginal[i])&&styk.editor._undo.length===fillHistory&&!styk.drawing.owner.working.has(lastFillOperation)));
  await page.evaluate(()=>{
    const worker=styk.drawing.owner.worker,request=worker.request.bind(worker);window.fillRequest=request;
    worker.request=async(kind,...args)=>{const result=await request(kind,...args);if(kind==='fill'){window.fillHeld=true;await new Promise(resolve=>window.releaseFill=resolve);}return result;};
  });
  await page.mouse.click(point.x,point.y);await page.waitForFunction(()=>window.fillHeld);
  await page.keyboard.press('Escape');await page.evaluate(()=>releaseFill());await page.waitForFunction(()=>!styk.drawing.operation);
  check('Escape rejects a completed but late fill without publishing pixels or history',await page.evaluate(()=>fillSurface.store.readRect(238,174,37,37).every((v,i)=>v===fillOriginal[i])&&styk.editor._undo.length===fillHistory&&!styk.drawing.owner.working.has(lastFillOperation)));
  await page.evaluate(()=>{styk.drawing.owner.worker.request=fillRequest;});
  await page.mouse.click(point.x,point.y);await page.waitForFunction(()=>styk.editor.undoLabel==='Fill drawing'&&!styk.drawing.operation);
  check('a new fill still works after cancellation',await page.evaluate(()=>fillSurface.store.pixel(256,192)[0]===220));
  const composite=await page.evaluate(async()=>{
    const d=styk.drawing;d.settings.sampleAll=true;let message;try{await d.fill(styk.editor.drawingTarget(),fillSurface,{x:256,y:192});}catch(error){message=error.message;}finally{d.settings.sampleAll=false;}
    return {message,held:d.owner.working.has(lastFillOperation),pinned:fillSurface.pinned,pixel:fillSurface.store.pixel(256,192)};
  });
  check('oversized sample-all capture fails before allocation and preserves the drawing',/Sample all layers/.test(composite.message)&&!composite.held&&!composite.pinned&&composite.pixel[0]===220);
  await page.evaluate(()=>styk.drawing.barrier());
  const reopened=await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,report=structuredClone(e.report);e.load(report);d.enter();const target=e.drawingTarget(),surface=await d.owner.surface(target.figure);return {filled:surface.store.pixel(256,192),distant:surface.store.pixel(1280000,1280000)};
  });
  check('published fill pixels survive document replacement and decode',reopened.filled.join()==='220,48,32,255'&&reopened.distant.join()==='20,40,60,255');
  check('no uncaught browser errors',errors.length===0);
  await writeFile(output+'/result.json',JSON.stringify({checks,errors,browser:browser.version()},null,2));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({message:error.message,checks,errors},null,2));await page.screenshot({path:output+'/failure.png'});throw error;}
finally{await browser.close();}
