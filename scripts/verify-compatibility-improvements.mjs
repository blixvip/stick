/** Pixel and actual app interaction checks against an isolated local probe. */
import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const origin=process.env.STYK_URL||'http://127.0.0.1:47831';
const candidate=process.env.STYK_COMPAT_CANDIDATE&&path.resolve(process.env.STYK_COMPAT_CANDIDATE);
const mime={'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm'};
const fixtures={
  app:['app-interaction-scheduling-fixture.mjs','verifyAppInteractionScheduling'],
  editor:['renderer-compatibility-performance-fixture.mjs','compatibilityEditorChecks'],
  software:['playback-software-reuse-fixture.mjs','runPlaybackSoftwareReuseChecks'],
  handles:['canvas-handle-overlay-fixture.mjs','verifyCanvasHandleOverlay'],
  background:['background-resources-fixture.mjs','backgroundResourcePixelChecks'],
};
const selected=process.argv.slice(2);
if(!selected.length)selected.push(...Object.keys(fixtures));
const browser=await chromium.launch({channel:'chromium',headless:true});
try{
  for(const name of selected){
    if(!fixtures[name])throw Error(`Unknown fixture: ${name}`);
    const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];
    if(candidate)await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==new URL(origin).origin||!/^\/(src|tests)\//.test(url.pathname)){await route.continue();return;}
      const filename=path.resolve(candidate,decodeURIComponent(url.pathname.slice(1))),relative=path.relative(candidate,filename);
      if(relative.startsWith('..')||path.isAbsolute(relative)){await route.fulfill({status:403,body:''});return;}
      try{const body=await readFile(filename);await route.fulfill({contentType:mime[path.extname(filename)]||'application/octet-stream',body});}
      catch(error){await route.fulfill({status:error.code==='ENOENT'?404:500,body:''});}
    });
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));
    if(name==='app'){
      await page.goto(origin);await page.waitForFunction(()=>window.styk?.ready,null,{timeout:60000});
      await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();styk.editor.markSaved();});
    }else{
      await page.route('**/__compat_probe__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Compatibility checks</title>'}));
      await page.goto(origin+'/__compat_probe__');
    }
    await page.exposeFunction('compatibilityProgress',detail=>console.log(JSON.stringify({name,...(typeof detail==='string'?{phase:detail}:detail)})));
    const result=await page.evaluate(async([file,method])=>(await import('/tests/'+file))[method]({onProgress:detail=>window.compatibilityProgress(detail)}),fixtures[name]);
    if(errors.length)throw Error(`${name}: ${errors.join('\n')}`);
    const output=path.resolve(process.env.STYK_COMPAT_ARTIFACTS||'artifacts/compatibility-improvements');
    await mkdir(output,{recursive:true});await writeFile(path.join(output,`${name}-final.json`),JSON.stringify({result,errors},null,2));
    if(name==='app')await page.screenshot({path:path.join(output,'app-final.png')});
    console.log(JSON.stringify({name,result,errors}));await page.close();
  }
}finally{await browser.close();}
