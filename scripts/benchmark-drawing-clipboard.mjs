import {chromium} from '../tests/support/playwright.mjs';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {dirname} from 'node:path';

// Isolate the affine kernel from PNG inflation and UI publication. Both versions
// use identical source bytes, budgets, filters and three fresh worker runs.
const baseline=process.env.STYK_CLIPBOARD_BASELINE,output=process.env.STYK_CLIPBOARD_BENCHMARK||'artifacts/drawing-clipboard/benchmark.json';
const browser=await chromium.launch({channel:'chrome',headless:true}),runs=[];
try{
  for(const revision of [baseline,'working-tree'].filter(Boolean)){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const body=revision==='working-tree'?await readFile('src/drawing-transform.mjs','utf8'):execFileSync('git',['show',`${revision}:src/drawing-transform.mjs`],{encoding:'utf8'});
    await context.route('**/src/drawing-transform-benchmark.mjs',route=>route.fulfill({contentType:'text/javascript',body}));
    const page=await context.newPage();await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');
    const samples=await page.evaluate(async()=>{
      const code=`
        import {TileStore} from '${location.origin}/src/drawing-tiles.mjs';
        import {transformTiles} from '${location.origin}/src/drawing-transform-benchmark.mjs';
        const source=new TileStore();for(let ty=0;ty<68;ty++)for(let tx=0;tx<120;tx++)source.set(tx,ty,new Uint8ClampedArray([tx,ty,127,255]));
        const before=new Map(),start=performance.now(),out=transformTiles(source,[1,0,0,1,64,-64],{before,filter:'nearest'}),ms=performance.now()-start;
        const exact=[...source].every(tile=>out.get(tile.tx+1,tile.ty-1)?.pixels.every((value,i)=>value===tile.pixels[i]));
        postMessage({ms,exact,tiles:out.size,beforeNull:[...before.values()].every(value=>value===null)});
      `;
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),samples=[];
      try{for(let pass=0;pass<3;pass++){
        const worker=new Worker(url,{type:'module'});
        try{samples.push(await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(Error(e.message));}));}finally{worker.terminate();}
      }}finally{URL.revokeObjectURL(url);}
      return samples;
    });
    if(samples.some(s=>!s.exact||!s.beforeNull||s.tiles!==8160))throw Error('Affine benchmark changed pixels or undo.');
    runs.push({revision,samples});await context.close();
  }
}finally{await browser.close();}
const result={date:new Date().toISOString(),platform:os.platform(),cpu:os.cpus()[0]?.model,node:process.version,workload:'7680x4352 opaque uniform-color tiles; worker translation (64,-64) into empty destination; nearest filter; 384MiB job ceiling; source setup, PNG decode and commit excluded',runs};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
