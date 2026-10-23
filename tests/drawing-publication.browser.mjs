import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const output=process.env.STYK_PUBLICATION_ARTIFACTS||'artifacts/drawing-publication',browser=await chromium.launch({channel:'chrome',headless:true});
await mkdir(output,{recursive:true});
try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  const checks=await page.evaluate(async()=>{
    const {DrawingResources}=await import('/src/drawing-resources.mjs'),{createDrawingFigure}=await import('/src/drawing-model.mjs'),{decodeTileBlob}=await import('/src/drawing-tile-codec.mjs');
    const make=()=>{
      const figure=createDrawingFigure({celId:crypto.randomUUID()}),owner=new DrawingResources({figure_types:[figure]},{history:false});owner.busy=true;
      const entry=owner.install(figure,Array.from({length:130},(_,tx)=>({tx,ty:0,pixels:new Uint8ClampedArray([tx,5,249,tx%2?1:255])})));
      return{figure,owner,entry};
    };
    const exact=async({figure,entry})=>{
      const tiles=await decodeTileBlob(figure.image_assets[0].styk_tiles);
      return tiles.length===entry.store.size&&tiles.every(t=>t.pixels.every((v,i)=>v===entry.store.get(t.tx,t.ty).pixels[i]));
    };
    const result={};
    {
      const f=make(),{owner,entry,figure}=f,controller=new AbortController(),request=owner.worker.request.bind(owner.worker);let calls=0,maxTransfer=0;
      try{
        owner.worker.request=(kind,data,options)=>{calls++;maxTransfer=Math.max(maxTransfer,options.transfer.reduce((n,b)=>n+b.byteLength,0));const job=request(kind,data,options);if(calls===2)controller.abort();return job;};
        const error=await owner.flush({signal:controller.signal}).then(()=>null,e=>e.name);
        result.cancelled=error==='AbortError'&&!figure.image_assets[0].styk_tiles&&owner.workingBytes===0&&entry.store.size===130&&owner.worker.pending.size===0&&!owner.worker.worker;
        const cached=[...entry.store].filter(t=>t.png).length;await owner.flush();result.recovered=await exact(f)&&owner.workingBytes===0&&maxTransfer<=1024*1024;
        result.cacheRecovery=owner.lastEncode.encoded===130-cached&&owner.lastEncode.reused===cached;
      }finally{owner.dispose();}
    }
    {
      const f=make(),{owner,figure}=f,request=owner.worker.request.bind(owner.worker);let first=true;
      try{
        owner.worker.request=async(kind,data,options)=>{const response=await request(kind,data,options);if(first){first=false;owner.apply(figure,[{tx:0,ty:0,after:new Uint8ClampedArray([31,63,95,1])}],'after');}return response;};
        await owner.flush();result.newerRevision=await exact(f)&&f.entry.store.pixel(0,0).join(',')==='31,63,95,1'&&owner.workingBytes===0;
      }finally{owner.dispose();}
    }
    {
      const {owner,figure}=make(),request=owner.worker.request.bind(owner.worker);
      owner.worker.request=(...args)=>{const job=request(...args);owner.dispose();return job;};
      const error=await owner.flush().then(()=>null,e=>e.name);
      result.closed=error==='AbortError'&&owner.workingBytes===0&&owner.entries.size===0&&!figure.image_assets[0].styk_tiles&&owner.worker.pending.size===0;
    }
    return result;
  });
  for(const [name,value] of Object.entries(checks)){assert.equal(value,true,name);console.log('PASS',name);}
  assert.deepEqual(errors,[]);await writeFile(output+'/worker-result.json',JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
