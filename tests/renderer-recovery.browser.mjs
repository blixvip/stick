import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const output=path.resolve('artifacts/renderer-recovery-tests');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try {
  for(const failure of ['transient','requestDevice','initialize']) {
    const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
    await page.waitForFunction(()=>window.styk?.ready);
    await page.evaluate(async()=>{
      for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
      const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
      const report=emptyDocument();report.fps=24;
      report.keyframes=Array.from({length:8},(_,i)=>{
        const frame=createFrame(Array.from({length:80},(_,j)=>createObject(report.figure_types[0],j+1,80+j%16*40+i*2,80+Math.floor(j/16)*70,{scale:.25})),2);
        frame.camera={x:i*2,y:i,scale:1+i*.01,angle_rad:i*.01,is_default:false};
        return frame;
      });
      styk.editor.markSaved();await styk.acceptImport({document:report,kind:'piv'},'GPU recovery.piv');
      styk.editor.seek(0);styk.editor.select(1);styk.editor.updateObject({root_x:100});
      styk.state.onion=true;
      window.probe={report:styk.editor.report,revision:styk.editor.revision,history:styk.editor.historySize,old:styk.state.renderer};
    });
    await page.waitForFunction(()=>!styk.state.dirtyRender&&!styk.state.editablePreparing);
    const before=await page.evaluate(()=>({backend:styk.state.renderer.stats.backend,pixels:document.querySelector('#scene').toDataURL()}));
    assert.equal(before.backend,'WebGPU');
    await page.evaluate(failure=>{
      if(failure==='requestDevice')Object.defineProperty(navigator,'gpu',{value:{requestAdapter:async()=>({requestDevice:async()=>{throw new Error('simulated unavailable GPU');}})},configurable:true});
      if(failure==='initialize'){
        const original=GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule=function(...args){GPUDevice.prototype.createShaderModule=original;throw new Error('simulated pipeline initialization failure');};
      }
      probe.old.device.destroy();
    },failure);
    await page.waitForFunction(()=>styk.state.renderer!==probe.old&&document.querySelector('#renderer-error').hidden&&!styk.state.dirtyRender);
    const restored=await page.evaluate(()=>({backend:styk.state.renderer.stats.backend,sameDocument:styk.editor.report===probe.report,revision:styk.editor.revision,history:styk.editor.historySize,expectedRevision:probe.revision,expectedHistory:probe.history,pixels:document.querySelector('#scene').toDataURL()}));
    assert.equal(restored.backend,failure==='transient'?'WebGPU':'Canvas 2D fallback');
    assert.ok(restored.sameDocument);assert.equal(restored.revision,restored.expectedRevision);assert.equal(restored.history,restored.expectedHistory);
    if(failure==='transient')assert.equal(restored.pixels,before.pixels,'GPU reconnect must preserve the rendered artwork and handles');
    assert.deepEqual(await page.evaluate(()=>{const e=styk.editor;e.undo();const undone=e.object.root_x;e.redo();return {undone,redone:e.object.root_x};}),{undone:80,redone:100});
    if(failure==='transient') {
      await page.evaluate(()=>{
        const e=styk.editor,s=styk.state, getter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'evaluatedFrame').get;
        probe.evaluations=0;probe.presented=[];
        Object.defineProperty(e,'evaluatedFrame',{configurable:true,get(){if(s.playing&&s.playbackPacket?.tick===e.tick)probe.evaluations++;return getter.call(e);}});
        const original=s.renderer.renderPrepared.bind(s.renderer);
        s.renderer.renderPrepared=(...args)=>{const value=original(...args);if(value&&s.playing&&probe.presented.at(-1)!==e.tick)probe.presented.push(e.tick);return value;};
        s.loop=false;e.seek(0);styk.actions.play();
      });
      await page.waitForFunction(()=>!styk.state.playing);
      const playback=await page.evaluate(()=>{delete styk.editor.evaluatedFrame;return {evaluations:probe.evaluations,ticks:probe.presented,total:styk.editor.totalTicks};});
      assert.equal(playback.evaluations,0,'Camera/VFX overlays must not evaluate prepared playback frames on the UI thread');
      assert.deepEqual(playback.ticks,Array.from({length:playback.total},(_,i)=>i));
      await page.waitForFunction(()=>!styk.state.editablePreparing);
      // Consecutive losses retry acceleration with backoff until the recovery
      // budget empties; only then does recovery settle on the software path.
      let settled;
      for(let loss=0;loss<6;loss++){
        await page.evaluate(()=>{probe.old=styk.state.renderer;probe.old.device.destroy();});
        await page.waitForFunction(()=>styk.state.renderer!==probe.old&&document.querySelector('#renderer-error').hidden&&!styk.state.dirtyRender,undefined,{timeout:60000});
        settled=await page.evaluate(()=>styk.state.renderer.stats.backend);
        if(settled==='Canvas 2D fallback')break;
      }
      assert.equal(settled,'Canvas 2D fallback','Repeated losses must settle on the software fallback once the GPU retry budget is exhausted');
      results.push({failure,...playback,identicalPixels:true});
    } else results.push({failure,backend:restored.backend,undoRedo:true});
    await page.screenshot({path:path.join(output,`${failure}.png`)});
    assert.deepEqual(errors,[]);await page.close();
  }
  await writeFile(path.join(output,'report.json'),JSON.stringify(results,null,2));
  console.log('GPU recovery: transient reconnect, bounded retries, both initialization failures, pixels, undo/redo and prepared playback passed.');
} finally {await browser.close();}
