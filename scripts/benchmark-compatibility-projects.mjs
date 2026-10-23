/** Read-only paired browser probe. The server must expose both frozen and
 * candidate source trees and the local sample API; see the performance report. */
import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const origin=process.env.STYK_URL||'http://127.0.0.1:47831';
const output=path.resolve(process.env.STYK_COMPAT_OUTPUT||'artifacts/compatibility-improvements/paired.json');
const baseline=process.env.STYK_COMPAT_BASELINE||'/__compat_baseline__/src';
const samples=await Promise.all(process.argv.slice(2).map(async argument=>{
  const [sample,tick]=argument.split('::'),local=(await stat(sample).catch(()=>null))?.isFile();
  return {sample,tick:Number(tick)||0,local,sha256:local?digest(await readFile(sample)):undefined};
}));
if(!samples.length)throw Error('Provide sample-relative paths followed by ::tick.');
const files=['renderer.mjs','renderer-canvas-plan.mjs','playback-worker.mjs','playback-software-painter.mjs','playback.mjs','playback-budget.mjs','playback-resources.mjs','playback-raster-cache.mjs','image-resources.mjs','pivot/background.mjs','pivot/geometry.mjs','vfx-canvas.mjs','vfx-camera.mjs','drawing-render-dependencies.mjs'];
function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
const fingerprints=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,digest(await readFile(path.join('src',file)))])));
const result={measuredAt:new Date().toISOString(),environment:{cpu:os.cpus()[0].model,memoryBytes:os.totalmem(),node:process.version},sources:await fingerprints(),runs:[],errors:[]};
let browser;
try{
  browser=await chromium.launch({channel:'chromium',headless:true});result.environment.browser=browser.version();
  const page=await browser.newPage();page.on('pageerror',error=>result.errors.push(error.message));
  await page.route('**/__compat_probe__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Compatibility benchmark</title>'}));
  await page.goto(origin+'/__compat_probe__');
  await page.exposeFunction('compatibilityProgress',detail=>{
    if(!detail.phase.startsWith('software compile')||detail.completed%4===0)console.log(JSON.stringify(detail));
  });
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input type="file" id="compatibility-file">'));
  for(const {sample,tick,local,sha256} of samples){
    console.log(JSON.stringify({sample,phase:'import'}));
    if(local)await page.locator('#compatibility-file').setInputFiles(path.resolve(sample));
    await page.evaluate(async({sample,local})=>{
      const [{ImportClient},{Editor}]=await Promise.all([import('/src/import-client.mjs'),import('/src/editor.mjs')]);
      const importer=window.compatibilityImporter=new ImportClient();
      try{
        const imported=local?await importer.importFile(document.getElementById('compatibility-file').files[0],{project:true})
          :await importer.openSample(sample,{project:true});
        importer.adoptSource?.(imported);
        // Normalize once through the same authored layer-sheet import used by
        // the app. Both source trees then evaluate this identical document.
        window.compatibilityReport=new Editor({demo:false,layerTimeline:true}).load(imported.document).report;
      }catch(error){importer.dispose();throw error;}
    },{sample,local});
    for(const sourcePrefix of [baseline,'/src','/src',baseline]){
      const run=await page.evaluate(async({sourcePrefix,tick})=>{
        const {benchmarkCompatibility}=await import('/scripts/benchmark-compatibility.mjs');
        return benchmarkCompatibility(window.compatibilityReport,{sourcePrefix,tick,frameCount:16,
          onProgress:detail=>window.compatibilityProgress({sourcePrefix,...detail})});
      },{sourcePrefix,tick});
      result.runs.push({sample,...run});
      console.log(JSON.stringify({sample,sourcePrefix,editorWarmMs:run.editor.warm.medianMs,dragMs:run.editor.drag.medianMs,
        panMs:run.editor.pan.medianMs,softwareFirstMs:run.software.first.medianMs,softwareRepeatedMs:run.software.repeated.medianMs}));
      await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));
    }
    await page.evaluate(async()=>{
      const importer=window.compatibilityImporter;importer.dispose();await importer.sourceRelease;
      window.compatibilityImporter=null;window.compatibilityReport=null;document.getElementById('compatibility-file').value='';
    });
    if(local&&digest(await readFile(sample))!==sha256)throw Error('The input project changed during the probe.');
  }
  result.sourcesAfter=await fingerprints();
  result.sourcesStable=JSON.stringify(result.sourcesAfter)===JSON.stringify(result.sources);
  if(!result.sourcesStable)throw Error('Measured source files changed during the probe. Repeat after edits settle.');
  if(result.errors.length)throw Error('The probe emitted browser errors.');
}catch(error){result.failure=error.stack;throw error;}
finally{
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));
  await browser?.contexts()[0]?.pages()[0]?.evaluate(()=>window.compatibilityImporter?.dispose()).catch(()=>{});
  await browser?.close();
}
