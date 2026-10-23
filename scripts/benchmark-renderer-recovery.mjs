/** Read-only source-file probe; measures the real app before/after a GPU reset. */
import {chromium, _electron as electron} from '../tests/support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const source = process.argv[2];
if (!source) throw new Error('Provide a PIV project path.');
const output = path.resolve('artifacts/renderer-recovery', process.env.STYK_PROBE_LABEL || 'current');
await mkdir(output, {recursive: true});
const desktop = process.env.STYK_PROBE_DESKTOP === '1';
const host = desktop ? await electron.launch({args:[process.cwd()], env:{...process.env, STYK_USER_DATA_DIR:path.join(output,'profile')}})
  : await chromium.launch({channel:'chrome',headless:true});
const page = desktop ? await host.firstWindow() : await host.newPage({viewport:{width:1400,height:950}});
const errors=[], runs=[];
page.on('pageerror', error=>errors.push(error.message));
try {
  if (!desktop) await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing && styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  for (const reset of [false,true]) {
    if(reset){
      await page.evaluate(()=>{window.probeOldRenderer=styk.state.renderer;styk.state.renderer.device.destroy();});
      await page.waitForFunction(()=>styk.state.renderer!==window.probeOldRenderer&&document.querySelector('#renderer-error').hidden);
    }
    const result=await page.evaluate(async()=>{
      const {editor:e,state:s}=styk, r=s.renderer;
      e.selectFrame(e.report.keyframes.length-1);styk.fit();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const geometry=e.geometry,frame=e.evaluatedFrame,view={...s.view};
      const samples=[],sorted=values=>{const v=values.slice().sort((a,b)=>a-b);return {p50:v[Math.floor(v.length*.5)],p95:v[Math.floor(v.length*.95)],max:v.at(-1)};};
      for(let i=0;i<30;i++){
        const start=performance.now();r.render({report:e.report,frame,geometry,view:{...view,x:view.x+i},cameraEnabled:false,clipToCanvas:false});
        samples.push(performance.now()-start);await new Promise(requestAnimationFrame);
      }
      return {backend:r.stats.backend,reason:r.stats.reason,adapter:r.stats.adapter,objects:geometry.objects.size,panMs:sorted(samples)};
    });
    console.log(JSON.stringify({reset,...result}));
    await page.evaluate(()=>{
      const {editor:e,state:s}=styk;s.loop=false;e.seek(e.totalTicks-48);
      window.probePresent=[];
      const r=s.renderer, method=r.renderPrepared?'renderPrepared':'render',original=r[method].bind(r);
      r[method]=(...args)=>{const start=performance.now(),value=original(...args);if(s.playing && value!==false)probePresent.push({tick:e.tick,at:performance.now(),ms:performance.now()-start});return value;};
      styk.actions.play();
    });
    await page.waitForFunction(()=>!styk.state.playing,null,{timeout:90000});
    Object.assign(result,await page.evaluate(()=>({presentation:styk.performance().presentation,frames:probePresent})));
    await page.screenshot({path:path.join(output,reset?'reset.png':'initial.png')});
    runs.push({reset,...result});
    await writeFile(path.join(output,'report.json'),JSON.stringify({source,desktop,runs,errors},null,2));
    console.log(JSON.stringify({reset,presentation:result.presentation}));
  }
} finally {await host.close();}
