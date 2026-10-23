import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),profile=path.join(root,'artifacts',`renderer-recovery-${Date.now()}`);
await mkdir(profile,{recursive:true});
const env={...process.env,STYK_USER_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const executablePath=process.env.STYK_PACKAGED_EXECUTABLE;
const app=await electron.launch({executablePath,args:executablePath?[]:[root],cwd:root,env,timeout:60000});
try{
  const page=await app.firstWindow();await page.waitForFunction(()=>window.styk?.ready);
  const expected=await page.evaluate(async()=>{
    for(const d of document.querySelectorAll('dialog[open]'))d.close();
    const {buildContainerV2}=await import('/src/native-container.mjs');
    const bytes=await buildContainerV2(styk.editor.serialize(),'styk');
    const data=btoa(String.fromCharCode(...new Uint8Array(bytes)));
    await stykDesktop.saveRecovery({data,name:'Crash recovery fixture'});
    await stykDesktop.setDocumentState({name:'Unsaved fixture',dirty:true});return data;
  });
  await app.evaluate(({dialog,BrowserWindow})=>{
    globalThis.crashDialogs=[];globalThis.crashAnswers=[1,0,2];
    dialog.showMessageBox=async(_window,options)=>{crashDialogs.push(options);return {response:crashAnswers.shift(),checkboxChecked:false};};
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
  });
  // Main-process polling works while the renderer is dead.
  const until=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Recovery action timed out');};
  await until(()=>app.evaluate(()=>globalThis.crashDialogs.length===1));
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.isCrashed()),true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await until(()=>app.evaluate(()=>globalThis.crashDialogs.length===2));
  await until(()=>app.evaluate(async({BrowserWindow})=>{
    const contents=BrowserWindow.getAllWindows()[0].webContents;
    return !contents.isCrashed()&&!contents.isLoading()&&await contents.executeJavaScript('Boolean(window.styk?.ready)').catch(()=>false);
  }));
  // Playwright marks the original Page permanently crashed. Verify the new
  // renderer through Electron's existing WebContents after its normal reload.
  const evaluate=code=>app.evaluate(({BrowserWindow},code)=>BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code),code);
  await until(()=>evaluate("Boolean(document.querySelector('#restore-recovery'))"));
  assert.equal(await evaluate('(async()=> (await stykDesktop.getRecovery()).data)()'),expected);
  await evaluate("document.querySelector('#restore-recovery').click()");
  await until(()=>evaluate("!document.querySelector('#restore-recovery')"));
  const log=JSON.parse(await readFile(path.join(profile,'last-renderer-crash.json'),'utf8'));
  assert.equal(typeof log.reason,'string');assert.equal(typeof log.exitCode,'number');
  assert.deepEqual(Object.keys(log).sort(),['exitCode','occurredAt','reason','version']);
  const dialogs=await app.evaluate(()=>globalThis.crashDialogs);
  assert.ok(dialogs.every(d=>d.buttons[0]==='Reopen editor'&&!d.buttons.includes('Save')));
  // A second failure can close directly without hanging on a dead Save action.
  const closed=app.waitForEvent('close');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()).catch(()=>{});
  await closed;
  assert.equal((await readFile(path.join(profile,'recovery.styk'))).toString('base64'),expected);
  const evidence={passed:true,packaged:Boolean(executablePath),keptFailedWindow:true,reopened:true,restoredRecovery:true,closedFailedWindow:true,recoveryUnchanged:true,diagnostic:log};
  await writeFile(path.join(profile,'verification.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
