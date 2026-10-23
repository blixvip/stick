import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'), output=path.join(root,'artifacts/playback-integrity/quality-transition');
await mkdir(output,{recursive:true});
const app=await electron.launch({args:[root],cwd:root,env:{...process.env,STYK_USER_DATA_DIR:path.join(output,`profile-${Date.now()}`)}});
try {
  const page=await app.firstWindow(),errors=[];
  page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.styk?.ready);
  if(process.env.STYK_QUALITY_BASELINE){
    const body=await readFile(process.env.STYK_QUALITY_BASELINE);
    await page.context().route('**/src/app.mjs',route=>route.fulfill({contentType:'text/javascript',body}));
    await page.reload();
  }
  await page.waitForFunction(()=>window.styk?.ready);
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.webContents.setBackgroundThrottling(false);window.setIgnoreMouseEvents(true);window.setFocusable(false);window.showInactive();});
  await page.evaluate(async()=>{
    for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {PlaybackMetrics}=await import('/src/playback-metrics.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    const colors=[0xffff4040,0xff40ff40,0xff4040ff];
    report.keyframes=Array.from({length:300},(_,i)=>({...createFrame([createObject(figure,1,300+i%50,230)]),_stykBackgroundColor:colors[i%3]}));
    styk.editor.load(report,'Playback quality integrity');styk.editor.setFPS(60);styk.editor.markSaved();styk.fit();styk.state.loop=true;styk.state.settings.playbackQuality='auto';
    const r=styk.state.renderer,render=r.renderPrepared.bind(r),live=r.render.bind(r),resize=r.resize.bind(r);
    window.probe={ticks:[],live:[],resizes:[],wrongPixels:[],gpuErrors:[],draws:0,forcedFps:60,colors,baseDpr:r.dpr};
    r.device.addEventListener('uncapturederror',event=>probe.gpuErrors.push(event.error.message));
    const snapshot=PlaybackMetrics.prototype.snapshot;
    PlaybackMetrics.prototype.snapshot=function(...args){return {...snapshot.apply(this,args),fps:probe.forcedFps};};
    r.render=(...args)=>{const result=live(...args);if(styk.state.playing)probe.live.push(styk.editor.tick);return result;};
    const copy=new OffscreenCanvas(1,1),ctx=copy.getContext('2d',{willReadFrequently:true});
    r.renderPrepared=(...args)=>{
      const ok=render(...args);if(!ok||!styk.state.playing)return ok;
      probe.draws++;
      const tick=styk.editor.tick;if(probe.ticks.at(-1)!==tick)probe.ticks.push(tick);
      // Read inside the submission task, before swap-chain presentation clears it.
      const view=styk.state.view,x=Math.round((view.x+20*view.scale)*r.dpr),y=Math.round((view.y+20*view.scale)*r.dpr);
      ctx.clearRect(0,0,1,1);ctx.drawImage(r.canvas,x,y,1,1,0,0,1,1);
      const pixel=[...ctx.getImageData(0,0,1,1).data],c=colors[tick%3],expected=[(c>>>16)&255,(c>>>8)&255,c&255,255];
      if(pixel.some((n,i)=>Math.abs(n-expected[i])>1))probe.wrongPixels.push({tick,pixel,expected});
      return ok;
    };
    r.resize=(...args)=>{
      const draws=probe.draws,result=resize(...args);
      if(styk.state.playing)queueMicrotask(()=>probe.resizes.push({tick:styk.editor.tick,repainted:probe.draws>draws}));
      return result;
    };
    styk.actions.play();
  });
  await page.waitForFunction(()=>probe.ticks.length>=12);
  console.log('Initial playback ready');
  for(const index of [1,2,1,0]){
    await page.evaluate(index=>{
      probe.forcedFps=index>styk.state.previewGovernor.index?0:60;
      Object.assign(styk.state.previewGovernor,{lowSince:performance.now()-10000,highSince:performance.now()-10000,changedAt:-10000});
    },index);
    await page.waitForFunction(index=>styk.state.previewGovernor.index===index&&styk.state.renderer.dpr===probe.baseDpr*[1,.75,.5][index]&&styk.state.renderer.msaaCount===(index?1:4),index);
    console.log('Quality level',index);
    // Observe presentations after the quality transaction, not just its flag.
    const count=await page.evaluate(()=>probe.ticks.length);
    await page.waitForFunction(count=>probe.ticks.length>=count+8,count);
  }
  const result=await page.evaluate(()=>{styk.actions.play();return {...probe,history:styk.editor.historySize};});
  await writeFile(path.join(output,'report.json'),JSON.stringify({...result,errors},null,2));
  assert.ok(result.resizes.length>=4);
  assert.ok(result.resizes.every(x=>x.repainted),'Every quality resize must repaint before yielding the task');
  assert.deepEqual(result.live,[],'Quality changes must not synchronously evaluate live artwork');
  assert.deepEqual(result.wrongPixels,[],'Each displayed frame retains its authored background');
  for(let i=1;i<result.ticks.length;i++)assert.equal(result.ticks[i],(result.ticks[i-1]+1)%300);
  assert.deepEqual(result.gpuErrors,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ticks:result.ticks.length,resizes:result.resizes,live:result.live,wrongPixels:result.wrongPixels,errors}));
} finally {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
