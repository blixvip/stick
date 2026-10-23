import assert from 'node:assert/strict';
import {chromium} from '../tests/support/playwright.mjs';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';

const baseline=process.env.STYK_PUBLICATION_BASELINE,output=process.env.STYK_PUBLICATION_ARTIFACTS||'artifacts/drawing-publication';
const revisions=[baseline,'working-tree'].filter(Boolean),runs=[];await mkdir(output,{recursive:true});
const sources=new Map();if(baseline)for(const name of ['drawing-tiles','drawing-resources','drawing-tile-codec','drawing-worker','drawing-history','drawing-controller','editor-drawing','editor'])sources.set(name,execFileSync('git',['show',`${baseline}:src/${name}.mjs`],{encoding:'utf8'}));
if(baseline&&execFileSync('git',['ls-tree','--name-only',baseline,'src/drawing-preparation.mjs'],{encoding:'utf8'}).trim())sources.set('drawing-preparation',execFileSync('git',['show',`${baseline}:src/drawing-preparation.mjs`],{encoding:'utf8'}));
for(const kind of ['opaque8k','textured4k'])for(let pass=0;pass<3;pass++)for(const revision of pass%2?[...revisions].reverse():revisions){
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
    // Routing disables HTTP caching; apply it equally to both revisions.
    await context.route('**/*',route=>route.continue());
    if(revision!=='working-tree')for(const [name,body] of sources)await context.route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);await page.locator('[data-workspace-mode="draw"]').click();
    const sample=await page.evaluate(async kind=>{
      const {emptyDocument}=await import('/src/demo.mjs'),{drawingMetadata}=await import('/src/drawing-model.mjs');
      const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();styk.state.settings.autosaveSeconds=0;
      const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),owner=d.owner,surface=await owner.surface(target.figure);
      const columns=kind==='opaque8k'?120:60,rows=kind==='opaque8k'?68:34,patterns=[],changes=[];
      for(let p=0;p<32;p++){
        let seed=p+42;const pixels=new Uint8ClampedArray(kind==='opaque8k'?4:16384);
        for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[i]=kind==='opaque8k'?[p*7,p*3,127,255][i%4]:seed>>>24;}
        patterns.push(pixels);
      }
      for(let ty=0;ty<rows;ty++)for(let tx=0;tx<columns;tx++)changes.push({tx,ty,before:null,after:patterns[(ty*columns+tx)%32]});
      let maxTransferBytes=0,encodeRequests=0,peakWorkingBytes=0,maxPreparationInputBytes=0,prepareRequests=0;
      const request=owner.worker.request.bind(owner.worker),hold=owner.hold.bind(owner);
      owner.worker.request=(kind,payload,options)=>{const bytes=(options?.transfer??[]).reduce((n,b)=>n+b.byteLength,0);if(kind==='encode-tiles'){encodeRequests++;maxTransferBytes=Math.max(maxTransferBytes,bytes);}if(kind==='prepare-tiles'){prepareRequests++;maxPreparationInputBytes=Math.max(maxPreparationInputBytes,bytes);}return request(kind,payload,options);};
      owner.hold=(...args)=>{const result=hold(...args);peakWorkingBytes=Math.max(peakWorkingBytes,owner.workingBytes);return result;};
      const measure=async operation=>{
        const tasks=[],since=performance.now();let last=since,maxGapMs=0,applyMs=0,commitMs=0;
        const collect=entries=>tasks.push(...entries.filter(e=>e.startTime>=since).map(e=>e.duration));
        const observer=new PerformanceObserver(list=>collect(list.getEntries()));observer.observe({type:'longtask'});
        const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;},4);
        const apply=owner.apply.bind(owner),commit=e.commitDrawingPixels.bind(e);
        owner.apply=(...args)=>{const start=performance.now();try{return apply(...args);}finally{applyMs+=performance.now()-start;}};
        e.commitDrawingPixels=(...args)=>{const start=performance.now();try{return commit(...args);}finally{commitMs+=performance.now()-start;}};
        let elapsedMs;
        try{await new Promise(resolve=>setTimeout(resolve,0));const start=performance.now();await operation();elapsedMs=performance.now()-start;await new Promise(resolve=>setTimeout(resolve,25));}
        finally{clearInterval(timer);collect(observer.takeRecords());observer.disconnect();owner.apply=apply;e.commitDrawingPixels=commit;}
        return{elapsedMs,commitMs,applyMs,maxGapMs,maxLongTaskMs:Math.max(0,...tasks),longTasks:tasks.length};
      };
      let editMs;
      const publish=await measure(async()=>{
        const start=performance.now();
        await d.pixelOperation('Applying drawing',async op=>{op.received(changes);if(d.commitPixels)await d.commitPixels(target,changes,'Publication benchmark',op);else e.commitDrawingPixels(target,changes,'Publication benchmark');});
        editMs=performance.now()-start;await owner.flush();
      });publish.editMs=editMs;
      const exact=()=>surface.store.size===changes.length&&[...surface.store].every(tile=>{const expected=patterns[(tile.ty*columns+tile.tx)%32];return tile.pixels.every((value,i)=>value===expected[i%expected.length]);});
      const firstExact=exact(),firstBounds={...drawingMetadata(e.drawingTarget().figure).bounds};
      await owner.history?.pumping;
      const undo=await measure(async()=>{await e.undo();await owner.flush();}),undoEmpty=surface.store.size===0;
      const redo=await measure(async()=>{await e.redo();await owner.flush();}),redoExact=exact();
      const result={kind,publish,undo,redo,tiles:changes.length,pixelBytes:changes.length*16384,firstExact,undoEmpty,redoExact,firstBounds,maxTransferBytes,encodeRequests,prepareRequests,maxPreparationInputBytes,peakWorkingBytes,remainingWorkingBytes:owner.workingBytes};
      styk.fit();return result;
    },kind);
    assert.ok(sample.firstExact&&sample.undoEmpty&&sample.redoExact);assert.deepEqual(errors,[]);
    if(revision==='working-tree')assert.ok(sample.maxTransferBytes<=1024*1024&&sample.maxPreparationInputBytes<=1024*1024);
    if(revision==='working-tree'&&kind==='opaque8k'&&pass===2){await page.waitForTimeout(300);await page.screenshot({path:output+'/workspace.png'});}
    runs.push({revision,pass,browser:browser.version(),...sample});console.log(revision,kind,pass,JSON.stringify({publish:sample.publish,undo:sample.undo,redo:sample.redo,maxTransferBytes:sample.maxTransferBytes}));
  }finally{await browser.close();}
}
const result={date:new Date().toISOString(),platform:os.platform(),cpu:os.cpus()[0]?.model,node:process.version,workload:'Fresh Chrome process per sample; 3 alternating passes per revision; controller pixel transaction, complete PNG publication, undo and redo; 32 exact tile patterns, opaque 7680x4352 and noisy/translucent 3840x2176. Setup and byte validation excluded. Includes timer tail observation; synthetic UI stalls, not physical pen latency. Edit time includes preparation; undo/redo elapsed includes any disk-history loading and preparation.',runs};
await writeFile(output+'/benchmark.json',JSON.stringify(result,null,2));
