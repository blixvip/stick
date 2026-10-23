import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'artifacts/settings-tabs');await mkdir(out,{recursive:true});
const checks=[],errors=[],profile=path.join(out,`profile-${Date.now()}`);
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const app=await electron.launch({args:[root],cwd:root,timeout:60000,env:{...process.env,STYK_USER_DATA_DIR:profile}});
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:60000});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));
 await page.evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());styk.settingsUI.open('shortcuts');});
 const screenshot=async name=>{await page.waitForTimeout(180);await writeFile(path.join(out,name+'.png'),Buffer.from(await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')),'base64'));};
 check('Shortcut stylesheet loads as grid',await page.locator('.hotkey-row').first().evaluate(e=>getComputedStyle(e).display==='grid'));
 check('Shortcuts do not overflow horizontally',await page.locator('.styk-settings-content').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await screenshot('shortcuts');
 const search=page.locator('[data-hotkey-search]'),row=page.locator('[data-hotkey-id="add-frame"]');
 await search.fill('no_matching_command_123');check('Search has a visible empty state',await page.locator('[data-hotkey-empty]').isVisible());
 await search.fill('Add Frame');check('Search finds commands',await row.isVisible());
 await row.locator('[data-hotkey-record="0"]').click();await page.keyboard.press('Control+Alt+q');
 check('Shortcut can be rebound',await page.evaluate(()=>styk.settingsUI.value.hotkeys['add-frame'].includes('Mod+Alt+KeyQ')));
 await row.locator('[data-hotkey-record="0"]').click();await page.keyboard.press('Escape');check('Escape cancels recording without closing settings',await page.locator('.styk-settings').evaluate(e=>e.open)&&await row.locator('[data-hotkey-record="0"]').getAttribute('aria-pressed')==='false');
 await row.locator('[data-hotkey-record="0"]').click();await page.keyboard.press('v');check('Conflicting bindings show an actionable conflict',await page.locator('[data-hotkey-cancel]').isVisible());
 await page.locator('[data-hotkey-cancel]').click();await row.locator('[data-hotkey-reset]').click();check('Per-command reset restores defaults',await page.evaluate(()=>styk.settingsUI.value.hotkeys['add-frame'][0]==='KeyA'));
 await row.locator('[data-hotkey-remove]').click();check('Remove unassigns the shortcut',await page.evaluate(()=>styk.settingsUI.value.hotkeys['add-frame'].length===0));
 await page.locator('[data-hotkey-reset-all]').click();check('Reset all restores bindings',await page.evaluate(()=>styk.settingsUI.value.hotkeys['add-frame'][0]==='KeyA'));
 await search.fill('');
 await page.getByRole('tab',{name:'Canvas',exact:true}).click();
 check('Canvas groups separate handles, overlays, builder and renderer',await page.locator('.styk-settings-group > h4').evaluateAll(titles=>['Navigation','Joint handles','Canvas overlays','Figure builder','Graphics'].every(title=>titles.some(node=>node.textContent===title))));
 await page.locator('[data-setting="outlineHandles"]').uncheck();await page.locator('[data-setting="showCamera"]').check();await page.locator('[data-setting="handleSize"]').fill('8');
 check('Canvas controls update settings and preview',await page.evaluate(()=>!styk.state.settings.outlineHandles&&styk.state.settings.showCamera&&styk.state.settings.handleSize===8)&&await page.locator('[data-handle-value]').textContent()==='8px');
 await screenshot('canvas');
 await page.getByRole('tab',{name:'Feedback',exact:true}).click();check('Feedback offers a tile per report type and the private inbox',await page.locator('.settings-feedback-tile[data-settings-feedback]').count()===3&&await page.locator('[data-settings-feedback="inbox"]').isVisible());
 await screenshot('feedback');
 for(const category of ['bug','idea','other']){
  await page.locator(`[data-settings-feedback="${category}"]`).click();
  check(`Feedback opens ${category} category`,await page.locator('.styk-feedback select[name="category"]').inputValue()===category);
  await page.getByRole('button',{name:'Close feedback',exact:true}).click();await page.evaluate(()=>styk.settingsUI.open('feedback'));
 }
 await page.locator('[data-settings-feedback="inbox"]').click();
 check('My reports opens the private inbox list',await page.locator('.styk-feedback[open] .support-center[data-view="inbox"]').isVisible());
 await page.getByRole('button',{name:'Close feedback',exact:true}).click();await page.evaluate(()=>styk.settingsUI.open('feedback'));
 check('Donate action is available outside the tablist',await page.locator('.styk-settings-actions [data-settings-donate]').isVisible()&&await page.locator('[role="tablist"] [data-settings-donate]').count()===0);
 await page.evaluate(()=>{window.donationCalls=0;styk.settingsUI.onDonate=()=>{donationCalls++};});await page.locator('[data-settings-donate]').click();check('Donate invokes its callback once',await page.evaluate(()=>donationCalls===1));
 await page.evaluate(()=>{styk.settingsUI.commit({theme:'dark',uiScale:150});});
 for(const tab of ['shortcuts','canvas','feedback']){
  await page.evaluate(tab=>styk.settingsUI.open(tab),tab);await screenshot(tab+'-150-dark');
  check(`${tab} fits at 150%`,await page.locator('.styk-settings-content').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 }
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(600,400);w.setSize(900,700);});
 for(const tab of ['shortcuts','canvas','feedback']){await page.evaluate(tab=>styk.settingsUI.open(tab),tab);await screenshot(tab+'-compact');check(`${tab} fits in compact window`,await page.locator('.styk-settings-content').evaluate(e=>e.scrollWidth<=e.clientWidth+1));}
 await page.evaluate(()=>styk.settingsUI.flush());check('No renderer errors',errors.length===0);await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors},null,2));
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
