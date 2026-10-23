/** Read-only native-painter parity check of a locally imported project. */
import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const source=path.resolve(process.argv[2]||''),tick=Number(process.argv[3]??297),software=process.argv[4]==='software';
if(!process.argv[2])throw Error('Provide a local project path and optional tick.');
const digest=async()=>createHash('sha256').update(await readFile(source)).digest('hex'),before=await digest();
const output=path.resolve(process.env.STYK_COMPAT_ARTIFACTS||'artifacts/compatibility-improvements');
const browser=await chromium.launch({channel:'chromium',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/__compat_probe__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Compatibility pixel comparison</title><input type="file" id="file">'}));
  await page.goto((process.env.STYK_URL||'http://127.0.0.1:47831')+'/__compat_probe__');
  await page.locator('#file').setInputFiles(source);
  await page.exposeFunction('compatibilityProgress',detail=>console.log(JSON.stringify(detail)));
  const result=await page.evaluate(async({tick,software})=>{
    const [{ImportClient},{Editor},diagnostics]=await Promise.all([
      import('/src/import-client.mjs'),import('/src/editor.mjs'),import('/scripts/diagnose-compatibility-pixels.mjs')]);
    const importer=window.pixelImporter=new ImportClient();
    const imported=await importer.importFile(document.getElementById('file').files[0],{project:true});importer.adoptSource?.(imported);
    const report=new Editor({demo:false,layerTimeline:true}).load(imported.document).report;
    return software?diagnostics.diagnoseCompatibilitySoftwarePixels(report,{tick,scale:1.6,quality:1,strict:true,showCanvases:true,onProgress:detail=>window.compatibilityProgress(detail)})
      :diagnostics.diagnoseCompatibilityEditorPixels(report,{tick,showCanvases:true,onProgress:detail=>window.compatibilityProgress(detail)});
  },{tick,software});
  const sourceUnchanged=before===await digest();
  const label=software?'project-software-pixels':'project-editor-pixels';
  await mkdir(output,{recursive:true});await writeFile(path.join(output,label+'.json'),JSON.stringify({result,sourceHash:before,sourceUnchanged,errors},null,2));
  await page.locator('[data-compatibility-pixel-diagnosis], [data-compatibility-software-diagnosis]').screenshot({path:path.join(output,label+'.png')});
  console.log(JSON.stringify({captures:result.captures,comparisons:result.comparisons,sourceUnchanged,errors}));
  if(!sourceUnchanged||errors.length)throw Error('The pixel probe failed its input/error checks.');
}finally{
  await browser.contexts()[0]?.pages()[0]?.evaluate(async()=>{window.pixelImporter?.dispose();await window.pixelImporter?.sourceRelease;}).catch(()=>{});
  await browser.close();
}
