'use strict';
// Test entry point: delaying/failing only the existing codec launcher requires
// no production flags or debugger attachment. The ordinary main module runs.
const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const backendModule = require('../desktop/backend.cjs');
const launch = backendModule.startBackend;
const output = process.env.STYK_SHELL_OUTPUT, mode = process.env.STYK_SHELL_MODE || 'delayed';
assert.ok(output && process.env.STYK_USER_DATA_DIR);
const started = performance.now();
let codecStartedMs, codecReadyMs, codecSignal, codecAborted=false, report, running=false;
backendModule.startBackend = async options => {
  codecStartedMs = performance.now()-started; codecSignal=options.signal;
  if (mode==='failed') throw new Error('Simulated unavailable file conversion service');
  if(mode!=='normal')await new Promise((resolve,reject)=>{
    const onAbort=()=>{codecAborted=true;clearTimeout(timer);reject(options.signal.reason);};
    const timer=setTimeout(()=>{options.signal?.removeEventListener('abort',onAbort);resolve();},mode==='close'?60000:6000);
    options.signal?.addEventListener('abort',onAbort,{once:true});
    if(options.signal?.aborted)onAbort();
  });
  const value=await launch(options);codecReadyMs=performance.now()-started;return value;
};
process.stdin.on('data',()=>app.exit(1));
const fail=error=>{console.error(error.stack||error);app.exit(1);};
app.on('browser-window-created',(_event,window)=>{
  if(running)return;running=true;
  window.setIgnoreMouseEvents(true);window.setFocusable(false);window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load',()=>run(window).catch(fail));
});
app.on('quit',()=>{
  if(!report)return;
  report.codecAborted=codecAborted||Boolean(codecSignal?.aborted);
  report.codecReadyMs=codecReadyMs??null;
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
});
async function run(window){
  const execute=code=>window.webContents.executeJavaScript(code),deadline=performance.now()+45000;
  while(!await execute('Boolean(window.styk?.ready)')){
    if(performance.now()>deadline)throw new Error('Editor readiness timed out');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const readyMs=performance.now()-started,readyBeforeCodec=codecReadyMs===undefined;
  const loading=await execute(`({navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON()),
    slowResources:performance.getEntriesByType('resource').sort((a,b)=>b.duration-a.duration).slice(0,20).map(e=>e.toJSON()),
    resourceCount:performance.getEntriesByType('resource').length})`);
  const behavior=await execute(`(async()=>{
    for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
    const editor=styk.editor,fps=editor.report.fps;
    editor.setFPS(fps+1);editor.undo();if(editor.report.fps!==fps)throw new Error('Undo failed before codec readiness');
    editor.redo();if(editor.report.fps!==fps+1)throw new Error('Redo failed before codec readiness');
    const {DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
    const exporter=new DocumentExporter(),importer=new ImportClient();
    let native;
    try{
      native=await exporter.export(editor.report,{format:'styk',name:'Before file conversion'});
      const reopened=await importer.importFile(new File([native],'before-codec.styk'));
      if(reopened.document.fps!==fps+1)throw new Error('Native save/reopen lost the edit');
    }finally{exporter.dispose();importer.dispose();}
    editor.markSaved();
    return {renderer:styk.state.renderer.stats.backend,secureContext:isSecureContext,nodeExposed:typeof window.require!=='undefined',
      bridge:await stykDesktop.getWindowState(),nativeBytes:native.size,nativeSaveReopen:true,undoRedo:true,
      fatalErrorHidden:document.querySelector('#renderer-error').hidden};
  })()`);
  const operationsBeforeCodec=codecReadyMs===undefined;
  assert.equal(behavior.renderer,'WebGPU');assert.equal(behavior.secureContext,true);assert.equal(behavior.nodeExposed,false);
  assert.equal(behavior.fatalErrorHidden,true);
  await fs.promises.writeFile(path.join(output,'ready.png'),(await window.webContents.capturePage()).toPNG());
  report={mode,readyMs,readyBeforeCodec,operationsMs:performance.now()-started,operationsBeforeCodec,codecStartedMs,
    codecReadyMs:codecReadyMs??null,behavior,loading,versions:process.versions,metrics:app.getAppMetrics()};
  if(mode==='delayed'||mode==='normal'){
    const health=await execute("fetch('/api/health').then(async r=>({status:r.status,data:await r.json()}))");
    assert.equal(health.status,200);assert.equal(health.data.ok,true);report.health=health;
  }else if(mode==='failed'){
    const status=await execute("fetch('/api/health').then(r=>r.status)");assert.equal(status,503);report.failedApiStatus=status;
  }
  app.quit();
}
require('../desktop/main.cjs');
