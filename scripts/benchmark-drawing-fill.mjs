import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import os from 'node:os';
import {TileStore} from '../src/drawing-tiles.mjs';

if(process.argv[2]==='--sample'){
  const {floodTiles}=await import(process.argv[3]),kind=process.argv[4],store=new TileStore();
  const width=kind==='uniform67mp'?8192:kind==='uniform4k'?3840:2048,height=kind==='uniform67mp'?8193:kind==='uniform4k'?2160:2048;
  let bounds={x:0,y:0,width,height},x=10,y=10;
  if(kind==='enclosed'||kind==='distant'){
    for(let py=0;py<64;py++)for(let px=0;px<64;px++)if(px===0||py===0||px===63||py===63)store.writable(0,0).pixels.set([20,40,60,255],(py*64+px)*4);
    if(kind==='distant'){store.set(20000,20000,new Uint8ClampedArray([20,40,60,255]));bounds={x:0,y:0,width:1280064,height:1280064};}
  }
  global.gc?.();const start=performance.now();let error,changes;
  try{changes=floodTiles(store,{x,y,bounds,color:[180,40,60,255],tolerance:0,expansion:kind==='enclosed'||kind==='distant'?1:0});}
  catch(e){error=e.message;}
  const elapsedMs=performance.now()-start;
  if(!error){
    assert.deepEqual(store.pixel(10,10),[180,40,60,255]);if(kind==='distant')assert.deepEqual(store.pixel(1280000,1280000),[20,40,60,255]);
    if(kind.startsWith('uniform')){assert.deepEqual(store.pixel(width-1,height-1),[180,40,60,255]);assert.deepEqual(store.pixel(width,height-1),[0,0,0,0]);assert.deepEqual(store.pixel(width-1,height),[0,0,0,0]);assert.equal(changes.length,Math.ceil(width/64)*Math.ceil(height/64));}
  }
  console.log(JSON.stringify({kind,elapsedMs,error,tiles:store.size,changes:changes?.length,maxRssBytes:process.resourceUsage().maxRSS*1024,outputBytes:store.bytes}));
}else{
  const baseline=process.env.STYK_FILL_BASELINE||'ab71603',output=process.env.STYK_FILL_BENCHMARK||'artifacts/drawing-tiled-fill';mkdirSync(output,{recursive:true});
  mkdirSync('tmp/drawing-audit-20260921',{recursive:true});const temporary=mkdtempSync(resolve('tmp/drawing-audit-20260921/fill-baseline-')),file=resolve(temporary,'pixels.mjs');
  const body=execFileSync('git',['show',`${baseline}:src/drawing-pixels.mjs`],{encoding:'utf8'}).replace(/from '\.\/([^']+)'/g,(_,p)=>`from '${pathToFileURL(resolve('src',p)).href}'`);
  writeFileSync(file,body);const results=[];
  try{
    for(const kind of ['enclosed','distant','uniform4k','uniform67mp'])for(let pass=0;pass<3;pass++)for(const revision of pass%2?['working-tree',baseline]:[baseline,'working-tree']){
      const entry=pathToFileURL(revision===baseline?file:resolve('src/drawing-fill.mjs')).href;
      const sample=JSON.parse(execFileSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--sample',entry,kind],{encoding:'utf8',maxBuffer:1024*1024}));
      if(revision==='working-tree')assert.equal(sample.error,undefined);
      results.push({revision,pass,...sample});console.log(revision,pass,kind,sample.error??`${sample.elapsedMs.toFixed(1)} ms / ${(sample.maxRssBytes/1048576).toFixed(1)} MiB peak RSS`);
    }
    const sourceSha256=Object.fromEntries(['src/drawing-fill.mjs','src/drawing-pixels.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p,'utf8').replace(/\r\n/g,'\n')).digest('hex')]));
    writeFileSync(`${output}/benchmark.json`,JSON.stringify({date:new Date().toISOString(),node:process.version,cpu:os.cpus()[0]?.model,platform:process.platform,arch:process.arch,baseline,scope:'Fresh Node process per sample, alternating revisions on the same machine. CPU kernel time and process peak RSS; not physical input latency or whole-application memory.',sourceSha256,results},null,2)+'\n');
  }finally{unlinkSync(file);rmdirSync(temporary);}
}
