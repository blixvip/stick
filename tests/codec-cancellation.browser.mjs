/** Real browser workers and HTTP cancellation, both direct and desktop-proxied. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import backend from '../desktop/backend.cjs';
import host from '../desktop/web-host.cjs';

let browser;
const rows=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const proxied of [false,true]){
    const service=await (proxied?host.startDesktopHost:backend.startBackend)({appRoot:process.cwd()});
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    try{
      await page.goto(service.origin+'/api/health');
      await page.evaluate(async()=>{
        const {DocumentExporter}=await import('/src/document-export.mjs');
        const {ImportClient}=await import('/src/import-client.mjs');
        const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
        window.exporter=new DocumentExporter();window.importer=new ImportClient();
        window.small=emptyDocument();small.keyframes=[createFrame([createObject(small.figure_types[0],1,200,200)])];
        window.original=JSON.stringify(small);
        window.dense={...small,keyframes:Array(50000).fill(small.keyframes[0])};
        window.controller=new AbortController();
        window.result=exporter.export(dense,{format:'piv',signal:controller.signal}).then(()=>({unexpected:true}),error=>({error:error.name}));
      });
      await page.waitForFunction(async()=>{
        const health=await (await fetch('/api/health')).json();return health.jobs.active===1;
      },undefined,{timeout:120000,polling:20});
      const started=Date.now();
      await page.evaluate(()=>controller.abort());
      assert.deepEqual(await page.evaluate(()=>result),{error:'AbortError'});
      await page.waitForFunction(async()=>{
        const health=await (await fetch('/api/health')).json();return health.jobs.active===0&&health.jobs.queued===0;
      },undefined,{timeout:10000,polling:20});
      const idleMs=Date.now()-started;
      const next=await page.evaluate(async()=>{
        if(JSON.stringify(small)!==original||dense.keyframes.length!==50000)throw new Error('Cancelled export mutated its input');
        const blob=await exporter.export(small,{format:'piv'});
        const imported=await importer.importFile(new File([blob],'after-cancel.piv'));
        const exact=await exporter.export(imported.document,{sourceId:imported.sourceId,format:'piv'});
        const bytes=new Uint8Array(await blob.arrayBuffer()),again=new Uint8Array(await exact.arrayBuffer());
        if(bytes.length!==again.length||bytes.some((value,index)=>value!==again[index]))throw new Error('Following import/export changed native bytes');
        const native=await exporter.export(imported.document,{sourceId:imported.sourceId,format:'styk'});
        const reopened=await importer.importFile(new File([native],'after-cancel.styk'));
        exporter.dispose();importer.dispose();
        return {pivBytes:blob.size,nativeBytes:native.size,frames:reopened.document.keyframes.length,objects:reopened.document.keyframes[0].objects.length};
      });
      assert.equal(next.frames,1);assert.equal(next.objects,1);assert.deepEqual(errors,[]);
      rows.push({proxied,cancelToIdleMs:idleMs,next,errors});
    }finally{await page.close();await service.stop();}
  }
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/codec-cancellation-browser.json',JSON.stringify({rows,limitations:['Correctness probe with an attached browser debugger; not a performance comparison.','Synthetic 50,000-frame export cancelled after backend admission.']},null,2));
  console.log(JSON.stringify(rows,null,2));
}finally{await browser?.close();}
