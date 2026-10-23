import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'artifacts/settings-scale');await mkdir(out,{recursive:true});
const profile=path.join(out,`profile-${Date.now()}`),checks=[],errors=[];
const check=(name,result)=>{assert.ok(result,name);checks.push(name);console.log('PASS',name);};
const launch=()=>electron.launch({args:[root],cwd:root,timeout:60000,env:{...process.env,STYK_USER_DATA_DIR:profile}});
let app;
const screenshot=async name=>{ await new Promise(resolve=>setTimeout(resolve,180)); return writeFile(path.join(out,name),Buffer.from(await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')),'base64')); };
try{
 app=await launch();app.process().stderr.on('data',data=>process.stderr.write(data));let page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:60000});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));
 await page.evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());styk.settingsUI.open();});
 await screenshot('light.png');
 const original=await page.evaluate(()=>({revision:styk.editor.revision,dirty:styk.editor.dirty,zoom:styk.state.view.scale,dpr:devicePixelRatio}));
 // A new profile follows the screen (Automatic); the slider shows the scale in use and moving it makes it Custom.
 const slider=page.locator('[data-setting="uiScale"]'),start=Number(await slider.inputValue());
 check('A new profile scales automatically',await page.evaluate(()=>styk.state.settings.uiScaleMode==='auto'));
 original.dpr/=start/100;
 await slider.focus();await slider.press('ArrowRight');
 check('Keyboard slider applies five percent step and a Custom scale',await page.evaluate(s=>styk.state.settings.uiScale===s+5&&styk.state.settings.uiScaleMode==='manual',start));
 for(const percent of [75,125,150,200]){
  await slider.fill(String(percent));
  await page.waitForFunction(p=>Math.abs(devicePixelRatio/p.percent-p.original)<.001,{percent:percent/100,original:original.dpr});
  check(`Native page scale ${percent}%`,true);
  check(`Dialog fits at ${percent}%`,await page.locator('.styk-settings').evaluate(e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}));
 }
 await screenshot('large.png');
 await page.locator('[data-scale-reset]').click();
 check('Reset returns to the automatic scale',await page.evaluate(()=>styk.state.settings.uiScaleMode==='auto'));
 await page.waitForFunction(p=>Math.abs(devicePixelRatio/p.percent-p.original)<.001,{percent:start/100,original:original.dpr});
 await page.getByRole('tab',{name:'Canvas',exact:true}).click();await page.locator('[data-setting="outlineHandles"]').uncheck();check('Canvas switches still work',await page.evaluate(()=>!styk.state.settings.outlineHandles));
 await screenshot('canvas.png');
 await page.getByRole('tab',{name:'Interface',exact:true}).click();await page.locator('[data-setting="theme"][value="dark"]').check();await slider.fill('150');
 await screenshot('dark.png');
 const after=await page.evaluate(()=>({revision:styk.editor.revision,dirty:styk.editor.dirty,zoom:styk.state.view.scale}));
 check('Scaling does not modify the document or scene zoom',after.revision===original.revision&&after.dirty===original.dirty&&after.zoom===original.zoom);
 await page.keyboard.press('Escape');check('Escape closes settings',await page.locator('.styk-settings').evaluate(e=>!e.open));
 await page.evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());});
 const beforePan=await page.evaluate(()=>({...styk.state.view}));
 const viewport=await page.locator('#viewport').boundingBox();
 await page.mouse.move(viewport.x+viewport.width/2,viewport.y+viewport.height/2);await page.mouse.down({button:'middle'});await page.mouse.move(viewport.x+viewport.width/2+30,viewport.y+viewport.height/2+20,{steps:4});await page.mouse.up({button:'middle'});
 check('Canvas pointer coordinates stay aligned at 150%',await page.evaluate(v=>Math.abs(styk.state.view.x-v.x-30)<1&&Math.abs(styk.state.view.y-v.y-20)<1,beforePan));
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(600,400);w.setSize(900,700);});
 await page.evaluate(()=>styk.settingsUI.open());await screenshot('compact.png');
 check('Compact settings remain in viewport',await page.locator('.styk-settings').evaluate(e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}));
 await page.evaluate(()=>styk.settingsUI.flush());
 check('Scale written to desktop preferences',await page.evaluate(async()=>{const s=await stykDesktop.getEditorSettings();return s.uiScale===150&&s.uiScaleMode==='manual';}));
 await app.evaluate(({app})=>app.exit(0));app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:60000});
 check('Scale restored after process restart',await page.evaluate(()=>styk.state.settings.uiScale===150));
 check('Native zoom restored',Math.abs(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())-1.5)<.001);
 check('No renderer errors',errors.length===0);
 await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors},null,2));
}finally{if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
