import {chromium} from '../tests/support/playwright.mjs';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {dirname} from 'node:path';

// An optional Git baseline is served into a fresh browser context; the worktree
// stays untouched. Both versions receive identical input and renderer settings.
const baseline=process.env.STYK_SELECTION_BASELINE,output=process.env.STYK_SELECTION_BENCHMARK||'artifacts/drawing-selection/benchmark.json';
const modules=['drawing-controller','drawing-pixels','drawing-resources','drawing-selection','drawing-transform','drawing-worker','drawing-raster'];
const browser=await chromium.launch({channel:'chrome',headless:true}),runs=[];
try{
  for(const revision of [baseline,'working-tree'].filter(Boolean)){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    if(revision!=='working-tree')for(const name of modules){
      const body=execFileSync('git',['show',`${revision}:src/${name}.mjs`],{encoding:'utf8',maxBuffer:8*1024*1024});
      await context.route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));
    }
    const page=await context.newPage();await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
    await page.locator('[data-workspace-mode="draw"]').click();
    const samples=await page.evaluate(async()=>{
      const {emptyDocument}=await import('/src/demo.mjs'),samples=[];
      for(let pass=0;pass<3;pass++){
        const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();d.settings.filter='nearest';
        const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure),tiles=[];
        for(let ty=0;ty<64;ty++)for(let tx=0;tx<64;tx++)tiles.push({tx,ty,before:null,after:new Uint8ClampedArray([127,63,31,255])});
        e.commitDrawingPixels(target,tiles);await d.barrier();await new Promise(resolve=>setTimeout(resolve,100));
        let previous=performance.now(),maxGapMs=0,ticks=0;
        const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-previous);previous=now;ticks++;},5);
        await new Promise(resolve=>setTimeout(resolve,10));const start=performance.now();
        await d.makeSelection({target:e.drawingTarget(),surface,points:[{x:0,y:0},{x:4096,y:0},{x:4096,y:4096},{x:0,y:4096}]});
        const ms=performance.now()-start,s=d.selection;
        // Payload bytes only: exclude derived viewport caches, original cel,
        // JavaScript objects and browser/GPU overhead. This is not process RSS.
        const payloadBytes=s.source?s.source.bytes+s.remainder.bytes:(s.originalPixels.byteLength+s.mask.mask.byteLength+s.cutout.width*s.cutout.height*4+s.maskCanvas.width*s.maskCanvas.height*4);
        let additionalSelectionBytes=payloadBytes;
        if(s.source){const base=new Set([...surface.store].map(t=>t.pixels)),extra=new Set([...s.source,...s.remainder].map(t=>t.pixels).filter(p=>!base.has(p)));additionalSelectionBytes=[...extra].reduce((n,p)=>n+p.byteLength,0);}
        await new Promise(resolve=>setTimeout(resolve,10));clearInterval(timer);samples.push({ms,maxGapMs,ticks,payloadBytes,additionalSelectionBytes});d.cancelSelection();
      }
      return samples;
    });
    runs.push({revision,samples});await context.close();
  }
}finally{await browser.close();}
const result={date:new Date().toISOString(),platform:os.platform(),cpu:os.cpus()[0]?.model,node:process.version,workload:'4096x4096 opaque cel; full rectangular lasso; 1440x1000 Chrome headless; 5ms UI timer; 3 fresh documents per revision',runs};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
