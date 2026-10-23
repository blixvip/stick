import {chromium} from './support/playwright.mjs';
import backend from '../desktop/backend.cjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const output=path.resolve(process.env.STYK_ZOOM_OUTPUT??'artifacts/zoom-detail');
const baseline=process.env.STYK_ZOOM_BASELINE;
const sourceFiles=['src/renderer.mjs','src/renderer-geometry.mjs','src/renderer-raster-cache.mjs','src/renderer-vector-raster.mjs','src/raster-view.mjs','src/playback-worker.mjs','src/drawing-render-dependencies.mjs','tests/renderer-zoom-detail-fixture.mjs','tests/renderer-zoom-detail.browser.mjs'];
const fingerprints=async root=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>{
  try{return [file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')];}
  catch(error){if(error.code==='ENOENT')return [file,null];throw error;}
})));
const sources={current:await fingerprints(process.cwd()),...(baseline?{baseline:await fingerprints(baseline)}:{})};
const service=await backend.startBackend({appRoot:process.cwd()});let browser;
await mkdir(output,{recursive:true});
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  if(baseline)await page.route('**/__zoom_baseline/**',async route=>{
    const file=new URL(route.request().url()).pathname.split('/__zoom_baseline/')[1];
    await route.fulfill({body:await readFile(path.join(baseline,file)),contentType:'text/javascript'});
  });
  await page.goto(service.origin+'/api/health');
  const result=await page.evaluate(async({baseline,benchmark})=>{
    const {zoomDetailQuality,zoomDetailBenchmark,zoomDetailState}=await import('/tests/renderer-zoom-detail-fixture.mjs');
    const results=[];
    for(const forceCanvas2D of [false,true]){
      if(benchmark){
        for(const settings of [{scale:1,outlined:false},{scale:1,outlined:true},{scale:32,outlined:true},{scale:32,outlined:true,interaction:'pan'},{scale:32,outlined:true,interaction:'zoom'},{scale:32,outlined:true,interaction:'zoom-sweep'}])
          results.push(await zoomDetailBenchmark({...settings,baseline,forceCanvas2D,iterations:80,rounds:3}));
      }else {results.push(await zoomDetailQuality({baseline,forceCanvas2D}));results.push(await zoomDetailState({forceCanvas2D}));}
    }
    return results;
  },{baseline:baseline?'/__zoom_baseline':null,benchmark:process.argv.includes('--benchmark')});
  assert.deepEqual(errors,[]);
  assert.deepEqual(await fingerprints(process.cwd()),sources.current,'Measured source files changed during the run; repeat with stable bytes.');
  const reports=[];
  for(const resultEntry of result){
    const {images,...report}=resultEntry;reports.push(report);
    for(const image of images??[])await writeFile(path.join(output,`${report.rows[0].backend==='WebGPU'?'gpu':'canvas'}-${image.name}.png`),Buffer.from(image.url.split(',')[1],'base64'));
  }
  const report={measuredAt:new Date().toISOString(),browser:browser.version(),node:process.version,sources,reports,errors};
  await writeFile(path.join(output,process.argv.includes('--benchmark')?'performance.json':'quality.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,checks:reports.reduce((n,r)=>n+(r.checks?.length??0),0),cases:reports.reduce((n,r)=>n+r.rows.length,0),errors}));
}finally{await browser?.close();service.stop();}
