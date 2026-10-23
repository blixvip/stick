import {chromium} from '../tests/support/playwright.mjs';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import os from 'node:os';

const baseline=process.env.STYK_DECODE_BASELINE,output=process.env.STYK_DECODE_BENCHMARK||'artifacts/drawing-decode/benchmark.json';
const browser=await chromium.launch({channel:'chrome',headless:true}),runs=[],targets=[];
try{
  for(const revision of [baseline,'working-tree'].filter(Boolean)){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    if(revision!=='working-tree')for(const name of ['drawing-png','drawing-tile-codec']){
      const body=execFileSync('git',['show',`${revision}:src/${name}.mjs`],{encoding:'utf8'});
      await context.route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));
    }
    const page=await context.newPage();await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
    const run={revision,samples:[]};runs.push(run);targets.push({page,run});
  }
  // Alternate revisions per case, reversing order in the middle pass so time
  // drift cannot systematically favor whichever implementation runs last.
  for(const kind of ['opaque8k','textured4k'])for(const mode of ['clipboard','cel'])for(let pass=0;pass<3;pass++)for(const {page,run} of pass%2?[...targets].reverse():targets){
    await page.bringToFront();
    const sample=await page.evaluate(async({kind,mode})=>{
      const code=`
        import {encodeDrawingPNG,drawingPNGBytes} from '${location.origin}/src/drawing-png.mjs';
        import {decodePixelClipboard} from '${location.origin}/src/drawing-clipboard.mjs';
        import {decodeTileBlob,assembleTileBlobBytes,TILE_BLOB_PREFIX} from '${location.origin}/src/drawing-tile-codec.mjs';
        self.onmessage=async({data:{kind,mode}})=>{try{
          const columns=kind==='opaque8k'?120:60,rows=kind==='opaque8k'?68:34,patterns=[],pngs=[];
          for(let p=0;p<32;p++){
            let seed=p+42;const pixels=new Uint8ClampedArray(16384);
            for(let i=0;i<pixels.length;i++){
              seed=(Math.imul(seed,1664525)+1013904223)>>>0;
              pixels[i]=kind==='opaque8k'?[p*7,p*3,127,255][i%4]:seed>>>24;
            }
            patterns.push(pixels);pngs.push(await encodeDrawingPNG(pixels,64,64));
          }
          const tiles=[];for(let ty=0;ty<rows;ty++)for(let tx=0;tx<columns;tx++)tiles.push({tx,ty,png:pngs[(ty*columns+tx)%32]});
          const clip={version:2,pixelsPerUnit:1,world:{x:0,y:0},matrix:[1,0,0,1,0,0],bounds:{x:0,y:0,width:columns*64,height:rows*64},tiles};
          let blob;
          if(mode==='cel'){
            const bytes=assembleTileBlobBytes(tiles.map(t=>({...t,png:drawingPNGBytes(t.png)})));let text='';
            for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));blob=TILE_BLOB_PREFIX+btoa(text);
          }
          const start=performance.now(),decoded=mode==='cel'?await decodeTileBlob(blob):[...(await decodePixelClipboard(clip)).store],ms=performance.now()-start;
          const exact=decoded.every((tile,index)=>tile.tx===index%columns&&tile.ty===Math.floor(index/columns)&&tile.pixels.every((value,i)=>value===patterns[index%32][i]));
          postMessage({kind,mode,ms,exact,tiles:decoded.length,pixelBytes:tiles.length*16384,pngCharacters:tiles.reduce((n,t)=>n+t.png.length,0)});
        }catch(error){postMessage({error:error.stack});}};
      `;
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(url,{type:'module'});
      try{return await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data);worker.onerror=e=>reject(Error(e.message));worker.postMessage({kind,mode});});}
      finally{worker.terminate();URL.revokeObjectURL(url);}
    },{kind,mode});
    if(!sample.exact||sample.tiles!==(kind==='opaque8k'?8160:2040))throw Error('Decode benchmark changed pixels or tile order.');
    run.samples.push({...sample,pass});console.log(run.revision,kind,mode,pass,Math.round(sample.ms)+'ms');
  }
}finally{await browser.close();}
const result={date:new Date().toISOString(),platform:os.platform(),cpu:os.cpus()[0]?.model,node:process.version,workload:'Worker PNG decode; 32 exact RGBA tile patterns; opaque 7680x4352 and deterministic noisy/translucent 3840x2176; sparse clipboard (8 streams) and cold cel blob (serial); 3 fresh workers per case with alternating revisions; excludes fixture setup, commit and rendering',runs};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
