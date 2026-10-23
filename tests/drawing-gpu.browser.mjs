// GPU drawing parity and lifecycle checks. The CPU TileStore remains the
// authority; these checks establish that the GPU brush, reduced display
// levels and tile display reproduce it, and that cancellation, fallback,
// undo/redo and saving keep their existing contracts.
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const output=process.env.STYK_GPU_ARTIFACTS||'artifacts/drawing-gpu',checks=[],errors=[];
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));
const check=(name,value,detail)=>{assert.ok(value,`${name}${detail?` ${JSON.stringify(detail)}`:''}`);checks.push(name);console.log('PASS',name);};
const settle=()=>page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation,null,{timeout:30000});
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(()=>styk.state.renderer.gpuDrawingReady);
  check('the WebGPU renderer owns GPU drawing residency',await page.evaluate(()=>Boolean(styk.state.renderer.drawingGpu)));

  // 1. Brush parity: identical samples through DrawingStroke and the GPU brush.
  const parity=await page.evaluate(async()=>{
    const {DrawingStroke}=await import('/src/drawing-pixels.mjs'),{BrushStroke,normalizeBrush}=await import('/src/drawing-brush.mjs'),{TileStore,TILE}=await import('/src/drawing-tiles.mjs'),{createGpuStroke}=await import('/src/drawing-gpu.mjs');
    const gpu=styk.state.renderer.drawingGpu,device=gpu.device;
    let seed=12345;const random=()=>((seed=Math.imul(seed^seed>>>15,2246822519)+0x6D2B79F5>>>0)/4294967296);
    const base=()=>{const store=new TileStore();for(let ty=-2;ty<3;ty++)for(let tx=-2;tx<3;tx++){if((tx+ty)%2)continue;const pixels=new Uint8ClampedArray(64*64*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=(tx*40+i)&255;pixels[i+1]=(ty*70+(i>>6))&255;pixels[i+2]=90;pixels[i+3]=(i>>2)%7?255:(i>>4)&255;}store.set(tx,ty,pixels);}return store;};
    const cases=[
      {name:'ink',size:16,hardness:1,flow:1,opacity:1},
      {name:'soft',size:64,hardness:0,flow:.25,opacity:1},
      {name:'pencil',size:3,hardness:.85,flow:.7,opacity:1,pressureOpacity:true,texture:.6},
      {name:'marker',size:24,hardness:.95,flow:1,opacity:.35,pressureSize:false},
      {name:'eraser',size:20,hardness:.8,flow:1,opacity:1,erase:true},
      {name:'hairline',size:.8,hardness:1,flow:1,opacity:1},
      {name:'fine',size:1.6,hardness:1,flow:1,opacity:1,sizeCurve:2},
      {name:'stabilized',size:10,hardness:.6,flow:.8,opacity:.9,stabilization:.6,pixelsPerUnit:1},
      // Tip shape, jitter, dynamics, blend modes, alpha lock and selection clipping.
      {name:'nib',size:16,hardness:1,flow:1,opacity:1,roundness:.2,angle:40},
      {name:'charcoal',size:20,hardness:.7,flow:.55,opacity:.9,pressureOpacity:true,texture:.85,scatter:.08,roundness:.6,angleMode:'direction'},
      {name:'airbrush',size:72,hardness:0,flow:.06,opacity:1,pressureSize:false,pressureFlow:true,spacingRatio:.05},
      {name:'multiply',size:30,hardness:.8,flow:1,opacity:.8,blend:'multiply'},
      {name:'screen',size:30,hardness:.8,flow:1,opacity:.8,blend:'screen'},
      {name:'overlay',size:30,hardness:.8,flow:1,opacity:.8,blend:'overlay'},
      {name:'color',size:30,hardness:.8,flow:1,opacity:.8,blend:'color'},
      {name:'behind',size:30,hardness:.8,flow:1,opacity:.8,blend:'behind'},
      {name:'alpha lock',size:30,hardness:.6,flow:1,opacity:1,alphaLock:true},
      {name:'selection clip',size:36,hardness:.5,flow:1,opacity:1,masked:true},
      // Tapers repaint a provisional tail every frame; the final stroke must not keep any of it.
      {name:'tapered ink',size:14,hardness:1,flow:1,opacity:1,taperIn:40,taperOut:80},
      {name:'tapered eraser',size:24,hardness:.8,flow:1,opacity:1,erase:true,taperOut:60},
      {name:'string stabilizer',size:10,hardness:.9,flow:1,opacity:1,stabilization:.5,stabilizerMode:'string',pixelsPerUnit:1,pressureCurve:[.1,.6,.4,.95]},
      // Image tips and paper grains sample the shared texture atlas.
      {name:'chalk on paper',size:28,hardness:.8,flow:.8,opacity:1,tip:'chalk',texture:.7,grain:'paper',grainScale:1.5,sizeJitter:.2},
      {name:'bristle on canvas',size:34,hardness:.9,flow:.9,opacity:1,tip:'bristle',angleMode:'direction',texture:.4,grain:'canvas',angleJitter:.05,roundness:.7},
      {name:'sponge jitter',size:40,hardness:.6,flow:.5,opacity:.9,tip:'sponge',opacityJitter:.5,angleJitter:1,scatter:.3},
      // Smudge runs dab by dab and carries colour, so rounding can compound.
      {name:'blender',start:[0,0],size:36,hardness:.4,flow:1,opacity:.8,pressureOpacity:true,blend:'smudge',smudgeLength:.85,colorRate:0,spacingRatio:.06,tolerance:{maxDiff:4,share:.03,tiles:'faint smudged pixels round to zero alpha differently'}},
      {name:'oil',size:28,hardness:.75,flow:1,opacity:1,blend:'smudge',smudgeLength:.6,colorRate:.35,spacingRatio:.05,texture:.2,tolerance:{maxDiff:4,share:.03,tiles:'faint smudged pixels round to zero alpha differently'}},
      {name:'large smudge',size:180,hardness:.5,flow:1,opacity:1,blend:'smudge',smudgeLength:.8,colorRate:.1,spacingRatio:.1,tolerance:{maxDiff:4,share:.03,tiles:'faint smudged pixels round to zero alpha differently'}},
    ];
    const results=[];
    for(const c of cases){
      const {name,masked,tolerance,start,...tip}=c,mask=masked?(()=>{const m={x:-120,y:-90,width:150,height:120,mask:new Uint8Array(150*120)};for(let y=0;y<120;y++)for(let x=0;x<150;x++)m.mask[y*150+x]=(x-75)**2/75**2+(y-60)**2/60**2<1?1:0;return m;})():null;
      const settings={pressureSize:true,pressureOpacity:false,sizeCurve:1,opacityCurve:1,stabilization:0,spacingRatio:.08,texture:0,seed:7,color:[210,40,120],...tip,mask};
      const samples=[];let x=(c.start?.[0]??-90)+random()*20,y=(c.start?.[1]??-60)+random()*20,angle=random()*6;
      for(let i=0;i<220;i++){angle+=(random()-.5)*.6;x+=Math.cos(angle)*(2+random()*5);y+=Math.sin(angle)*(2+random()*5);samples.push({x,y,pressure:.15+.85*Math.abs(Math.sin(i/17)),time:i*4});}
      const cpuStore=base(),cpu=new DrawingStroke(cpuStore,settings);for(const s of samples)cpu.sample(s);const cpuChanges=cpu.finish();
      const presenter={store:base(),owner:{},stamp:0};
      const brush=normalizeBrush(settings),session=createGpuStroke(gpu,presenter,brush,{mask});
      const pipeline=new BrushStroke(brush,shape=>session.add(shape));
      if(pipeline.hasTail)session.tail=()=>pipeline.tailShapes();
      for(let i=0;i<samples.length;i++){
        pipeline.sample(samples[i]);
        // Several frames per stroke: batches must preserve cross-batch coverage.
        if(i%23===22){session.plan();const encoder=device.createCommandEncoder();session.encode(encoder);device.queue.submit([encoder.finish()]);}
      }
      pipeline.finish();
      const {changes:gpuChanges}=await session.finish();session.release();
      const expand=side=>{if(!side)return new Uint8ClampedArray(64*64*4);if(side.length===4){const full=new Uint8ClampedArray(64*64*4);for(let i=0;i<full.length;i+=4)full.set(side,i);return full;}return side;};
      const cpuMap=new Map(cpuChanges.map(t=>[`${t.tx},${t.ty}`,t])),gpuMap=new Map(gpuChanges.map(t=>[`${t.tx},${t.ty}`,t]));
      let pixels=0,different=0,maxDiff=0,alphaMismatch=0;
      for(const key of new Set([...cpuMap.keys(),...gpuMap.keys()])){
        const a=cpuMap.get(key),b=gpuMap.get(key);
        const before=expand(a?.before??b?.before),after0=a?expand(a.after):before,after1=b?expand(b.after):before;
        for(let i=0;i<after0.length;i+=4){pixels++;let d=0;for(let k=0;k<4;k++)d=Math.max(d,Math.abs(after0[i+k]-after1[i+k]));
          // Hidden colour under zero alpha carries no visible information.
          if(after0[i+3]===0&&after1[i+3]===0)d=0;
          if(d){different++;maxDiff=Math.max(maxDiff,d);}if(after0[i+3]!==after1[i+3])alphaMismatch++;}
      }
      results.push({name:c.name,tiles:cpuChanges.length,gpuTiles:gpuChanges.length,pixels,different,maxDiff,alphaMismatch,tolerance:tolerance??{maxDiff:1,share:.01}});
    }
    return results;
  });
  console.log(JSON.stringify(parity));
  for(const r of parity)check(`GPU brush matches the CPU brush within ${r.tolerance.maxDiff} 8-bit step${r.tolerance.maxDiff>1?'s':''} (${r.name})`,r.maxDiff<=r.tolerance.maxDiff&&r.different/r.pixels<r.tolerance.share&&(r.tiles===r.gpuTiles||r.tolerance.tiles),r);

  // 2. Reduced levels are byte-identical to CPU mips.
  const levels=await page.evaluate(async()=>{
    const {TileStore}=await import('/src/drawing-tiles.mjs'),{levelStore}=await import('/src/drawing-raster.mjs');
    const gpu=styk.state.renderer.drawingGpu,device=gpu.device,store=new TileStore();let seed=99;const random=()=>((seed=Math.imul(seed^seed>>>15,2246822519)+0x6D2B79F5>>>0)/4294967296);
    for(let ty=-5;ty<6;ty++)for(let tx=-7;tx<5;tx++){if(random()<.3)continue;const pixels=new Uint8ClampedArray(64*64*4);for(let i=0;i<pixels.length;i++)pixels[i]=random()*256;for(let i=3;i<pixels.length;i+=4)if(random()<.2)pixels[i]=0;store.set(tx,ty,pixels);}
    const presenter={store,owner:{}},state=gpu.state(presenter),mismatches=[];let compared=0;
    for(const k of [1,2,3]){
      const cpu=levelStore({store},k),wanted=[...cpu];
      gpu.beginFrame();const memo=new Map(),slots=wanted.map(t=>gpu.resolve(state,k,t.tx,t.ty,memo));
      const encoder=device.createCommandEncoder();gpu.encode(encoder);
      const readback=device.createBuffer({size:wanted.length*16384,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      slots.forEach((slot,i)=>encoder.copyBufferToBuffer(gpu.pool.buffer,slot*16384,readback,i*16384,16384));device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(readback.getMappedRange());
      wanted.forEach((tile,i)=>{compared++;const g=bytes.subarray(i*16384,(i+1)*16384);for(let j=0;j<16384;j++)if(g[j]!==tile.pixels[j]){mismatches.push({k,tx:tile.tx,ty:tile.ty,j,cpu:tile.pixels[j],gpu:g[j]});break;}});
      readback.unmap();readback.destroy();
    }
    return {compared,mismatches:mismatches.slice(0,5),count:mismatches.length};
  });
  check('GPU reduced levels are byte-identical to CPU mip tiles',levels.count===0&&levels.compared>20,levels);

  // 3. Live painting through the application: undo/redo, cancel and save.
  await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');styk.editor.load(emptyDocument());styk.drawing.bind();styk.editor.createDrawingLayer();styk.state.settings.autosaveSeconds=0;Object.assign(styk.drawing.settings,{size:10,color:'#1040e0',stabilization:0,texture:0});});
  const box=await page.locator('#viewport').boundingBox(),stroke=async(x,y,{release=true}={})=>{await page.mouse.move(box.x+x,box.y+y);await page.mouse.down();for(let i=1;i<=40;i++)await page.mouse.move(box.x+x+i*6,box.y+y+Math.sin(i/5)*30);if(release){await page.mouse.up();await settle();}};
  await stroke(300,300);
  const first=await page.evaluate(()=>{const d=styk.drawing,t=styk.editor.drawingTarget(),e=d.owner.entry(t.figure);return{undo:styk.editor.undoLabel,tiles:e.store.size,hash:[...e.store].reduce((h,t)=>{for(let i=0;i<t.pixels.length;i+=97)h=Math.imul(h^t.pixels[i],16777619)>>>0;return h;},2166136261),gpuStrokes:styk.state.renderer.stats.drawingGpu?.strokeDispatches,fallbacks:d.strokeStats.gpuFallbacks??0};});
  check('a live GPU stroke commits as one brush command without CPU fallback',first.undo==='Brush stroke'&&first.tiles>0&&first.gpuStrokes>0&&first.fallbacks===0,first);
  const bounds=await page.evaluate(async()=>{const {tileTransparent}=await import('/src/drawing-tiles.mjs'),t=styk.editor.drawingTarget(),store=styk.drawing.owner.entry(t.figure).store,bad=[];let compared=0;
    for(const tile of store){const probe={pixels:tile.pixels};tileTransparent(probe);compared++;if(JSON.stringify(probe.alphaBounds)!==JSON.stringify(tile.alphaBounds))bad.push({tx:tile.tx,ty:tile.ty,gpu:tile.alphaBounds,cpu:probe.alphaBounds});}return{compared,bad:bad.slice(0,3)};});
  check('GPU alpha bounds on committed tiles equal a CPU scan',bounds.compared>0&&!bounds.bad.length,bounds);
  // Read the canvas right after the application's next render of either kind:
  // a presented WebGPU canvas is only readable within its render task.
  const pixelAt=async(x,y)=>page.evaluate(({x,y})=>new Promise(resolve=>{
    const renderer=styk.state.renderer,scene=document.querySelector('#scene'),names=['render','renderPrepared'],original={};
    const read=()=>{const r=scene.getBoundingClientRect(),c=new OffscreenCanvas(1,1),ctx=c.getContext('2d');ctx.drawImage(scene,Math.round((x-r.left)*scene.width/r.width),Math.round((y-r.top)*scene.height/r.height),1,1,0,0,1,1);return[...ctx.getImageData(0,0,1,1).data];};
    for(const name of names){original[name]=renderer[name];renderer[name]=function(...args){const value=original[name].apply(this,args);for(const other of names)renderer[other]=original[other];resolve(read());return value;};}
    styk.drawing.onRender();
  }),{x:box.x+x,y:box.y+y});
  const painted=await pixelAt(300,300);
  check('the committed stroke is displayed from GPU tiles',painted[2]>150&&painted[0]<120,painted);
  await page.evaluate(()=>styk.drawing.history('undo'));await settle();await page.waitForTimeout(100);
  const undone=await pixelAt(300,300);
  check('undo removes the stroke from the display',undone[0]>200&&undone[1]>200&&undone[2]>200,undone);
  await page.evaluate(()=>styk.drawing.history('redo'));await settle();await page.waitForTimeout(100);
  const redone=await page.evaluate(()=>{const t=styk.editor.drawingTarget(),e=styk.drawing.owner.entry(t.figure);return [...e.store].reduce((h,t)=>{for(let i=0;i<t.pixels.length;i+=97)h=Math.imul(h^t.pixels[i],16777619)>>>0;return h;},2166136261);});
  check('redo restores the exact committed pixels',redone===first.hash,{redone,expected:first.hash});
  // Committed GPU tiles share their history buffer, adopted frozen: a later
  // CPU edit over them must copy first, so undoing it restores exact bytes.
  const shared=await page.evaluate(()=>{const t=styk.editor.drawingTarget(),store=styk.drawing.owner.entry(t.figure).store;return [...store].every(tile=>tile.frozen);});
  check('committed GPU tiles are adopted copy-on-write',shared);
  await page.evaluate(()=>{styk.drawing.gpuBrushDisabled=true;});await stroke(300,300);await page.evaluate(()=>{styk.drawing.gpuBrushDisabled=false;});
  const overpainted=await page.evaluate(()=>styk.editor.undoLabel);
  await page.evaluate(()=>styk.drawing.history('undo'));await settle();
  const undoneOver=await page.evaluate(()=>{const t=styk.editor.drawingTarget(),e=styk.drawing.owner.entry(t.figure);return [...e.store].reduce((h,t)=>{for(let i=0;i<t.pixels.length;i+=97)h=Math.imul(h^t.pixels[i],16777619)>>>0;return h;},2166136261);});
  check('a worker stroke over shared tiles undoes to the exact GPU stroke',overpainted==='Brush stroke'&&undoneOver===first.hash,{undoneOver,expected:first.hash});
  // Escape during a stroke discards it and restores the display.
  await stroke(300,500,{release:false});
  const during=await pixelAt(300,500);
  await page.keyboard.press('Escape');await page.mouse.up();await settle();await page.waitForTimeout(100);
  const cancelled=await pixelAt(300,500);
  check('a GPU stroke is visible before release',during[2]>150&&during[0]<120,during);
  check('Escape cancels a GPU stroke without history or pixels',cancelled[0]>200&&cancelled[1]>200&&(await page.evaluate(()=>styk.editor.undoLabel))==='Brush stroke',cancelled);
  // Forced GPU failure replays the recorded samples on the CPU worker.
  const replay=await page.evaluate(async()=>{
    const d=styk.drawing,before=d.strokeStats.gpuFallbacks??0,{GpuStroke}=await import('/src/drawing-gpu.mjs'),finish=GpuStroke.prototype.finish;
    GpuStroke.prototype.finish=async function(){throw new Error('Simulated device loss');};
    window.restoreFinish=()=>{GpuStroke.prototype.finish=finish;};return before;
  });
  await stroke(650,420);await page.evaluate(()=>window.restoreFinish());
  const replayed=await page.evaluate(()=>({fallbacks:styk.drawing.strokeStats.gpuFallbacks,undo:styk.editor.undoLabel,count:styk.editor._undo.length}));
  check('a failed GPU stroke replays on the CPU worker and commits',replayed.fallbacks===replay+1&&replayed.undo==='Brush stroke',replayed);
  const replayedPixel=await pixelAt(650,420);
  check('the replayed stroke is displayed',replayedPixel[2]>150&&replayedPixel[0]<120,replayedPixel);
  // Save and reopen preserves GPU-painted pixels exactly.
  const saved=await page.evaluate(async()=>{
    const {serializeNativeDocument,parseNativeDocument}=await import('/src/document-transport.mjs').catch(()=>({}));
    await styk.drawing.barrier();const t=styk.editor.drawingTarget(),e=styk.drawing.owner.entry(t.figure);
    const hash=[...e.store].sort((a,b)=>a.ty-b.ty||a.tx-b.tx).reduce((h,t)=>{for(let i=0;i<t.pixels.length;i++)h=Math.imul(h^t.pixels[i],16777619)>>>0;return h;},2166136261);
    const report=structuredClone(styk.editor.report);styk.editor.load(report);styk.drawing.bind();
    const figure=styk.editor.report.figure_types.find(f=>f._styk?.drawing?.celId===t.figure._styk.drawing.celId),entry=await styk.drawing.owner.surface(figure);
    const reopened=[...entry.store].sort((a,b)=>a.ty-b.ty||a.tx-b.tx).reduce((h,t)=>{for(let i=0;i<t.pixels.length;i++)h=Math.imul(h^t.pixels[i],16777619)>>>0;return h;},2166136261);
    return {hash,reopened};
  });
  check('published GPU strokes reopen with identical pixels',saved.hash===saved.reopened,saved);
  // 4. Lifecycle: a held eraser clears the display before release, reduced
  // levels follow a live stroke when zoomed out, and an evicted store keeps
  // its last image until its decode completes.
  await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');styk.editor.load(emptyDocument());styk.drawing.bind();styk.editor.createDrawingLayer();Object.assign(styk.drawing.settings,{size:10,color:'#1040e0',stabilization:0,texture:0});});
  await stroke(300,300);
  await page.evaluate(()=>{styk.drawing.setTool('eraser');Object.assign(styk.drawing.settings,{size:120,hardness:1,opacity:1,flow:1,pressureSize:false});});
  await stroke(290,300,{release:false});
  const heldErase=await pixelAt(420,277);
  await page.mouse.up();await settle();
  const erased=await page.evaluate(()=>{const t=styk.editor.drawingTarget();return styk.drawing.owner.entry(t.figure).store.bounds;});
  check('a held GPU eraser clears the display before release',heldErase[0]>200&&heldErase[1]>200&&heldErase[2]>200,heldErase);
  check('erasing every pixel commits an empty cel',erased===null,erased);
  await page.evaluate(()=>{styk.drawing.setTool('brush');Object.assign(styk.drawing.settings,{size:10,pressureSize:true});Object.assign(styk.state.view,{scale:.2});styk.drawing.onRender();});
  const zoomBox=await page.evaluate(()=>{const v=styk.state.view,r=document.querySelector('#viewport').getBoundingClientRect();return{x:r.left+v.x+200*v.scale,y:r.top+v.y+200*v.scale};});
  await page.mouse.move(zoomBox.x,zoomBox.y);await page.mouse.down();for(let i=1;i<=30;i++)await page.mouse.move(zoomBox.x+i*4,zoomBox.y+i*2);
  const zoomedLevel=await page.evaluate(()=>styk.state.renderer.stats.drawingGpu.reductions);
  const zoomedLive=await pixelAt(zoomBox.x-box.x+60,zoomBox.y-box.y+30);
  await page.mouse.up();await settle();
  check('reduced levels show a live stroke when zoomed out',zoomedLevel>0&&zoomedLive[2]>150&&zoomedLive[0]<170,{zoomedLevel,zoomedLive});
  const evicted=await page.evaluate(async()=>{
    const d=styk.drawing,t=styk.editor.drawingTarget(),e=d.owner.entry(t.figure);await d.owner.flush();
    const request=d.owner.decodeWorker.request.bind(d.owner.decodeWorker);let release;const held=new Promise(resolve=>release=resolve);
    d.owner.decodeWorker.request=async(...args)=>{await held;return request(...args);};
    e.store=null;e.levels=null;d.owner.surfaceVersion++;d.onRender();
    window.releaseDecode=()=>{d.owner.decodeWorker.request=request;release();};
    return true;
  });
  const whileEvicted=await pixelAt(zoomBox.x-box.x+60,zoomBox.y-box.y+30);
  await page.evaluate(()=>window.releaseDecode());await page.waitForFunction(()=>{const t=styk.editor.drawingTarget();return Boolean(styk.drawing.owner.entry(t.figure).store);});
  const afterDecode=await pixelAt(zoomBox.x-box.x+60,zoomBox.y-box.y+30);
  check('an evicted cel keeps its last GPU image until the decode completes',evicted&&whileEvicted[2]>150&&whileEvicted[0]<170,whileEvicted);
  check('the decoded cel is displayed again',afterDecode[2]>150&&afterDecode[0]<170,afterDecode);
  // A click released while its cel still loads must still act once the load
  // completes; pointer capture loss after release is not a cancellation.
  await page.evaluate(async()=>{
    const d=styk.drawing,t=styk.editor.drawingTarget(),e=d.owner.entry(t.figure);await d.owner.flush();
    const request=d.owner.decodeWorker.request.bind(d.owner.decodeWorker);let release;const held=new Promise(resolve=>release=resolve);
    d.owner.decodeWorker.request=async(...args)=>{await held;return request(...args);};
    e.store=null;e.levels=null;d.owner.surfaceVersion++;d.setTool('fill');Object.assign(d.settings,{color:'#20c040',tolerance:16,gap:0,expansion:0,sampleAll:false});
    window.releaseDecode=()=>{d.owner.decodeWorker.request=request;release();};window.undoCount=styk.editor._undo.length;
  });
  await page.mouse.click(zoomBox.x+40,zoomBox.y+40);
  await page.evaluate(()=>window.releaseDecode());
  const filled=await page.waitForFunction(()=>styk.editor._undo.length===undoCount+1&&styk.editor.undoLabel?.toLowerCase().includes('fill'),null,{timeout:10000}).then(()=>true,()=>false);
  await page.evaluate(()=>styk.drawing.setTool('brush'));
  check('a click released while its cel loads still fills after the load',filled);
  // Memory pressure evicts the published store; reopening it for editing
  // reads the exact tiles back from GPU slots instead of decoding PNGs.
  await settle();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const restored=await page.evaluate(async()=>{
    const d=styk.drawing,t=styk.editor.drawingTarget(),e=d.owner.entry(t.figure),gpu=styk.state.renderer.drawingGpu;await d.owner.flush();
    const hash=store=>[...store].sort((a,b)=>a.ty-b.ty||a.tx-b.tx).reduce((h,tile)=>{h=Math.imul(h^tile.tx,16777619)^tile.ty;for(let i=0;i<tile.pixels.length;i++)h=Math.imul(h^tile.pixels[i],16777619)>>>0;return h;},2166136261);
    const before=hash(e.store),tiles=e.store.size,restores=gpu.stats.restores??0;let decodes=0;
    const request=d.owner.decodeWorker.request.bind(d.owner.decodeWorker);d.owner.decodeWorker.request=(...args)=>{decodes++;return request(...args);};
    d.owner.reserve(d.owner.tileBudget);const evicted=!e.store;
    const started=performance.now(),surface=await d.owner.surface(t.figure),ms=performance.now()-started;d.owner.decodeWorker.request=request;
    return {evicted,tiles,decodes,restored:(gpu.stats.restores??0)-restores,exact:hash(surface.store)===before,pngs:[...surface.store].every(tile=>tile.png),ms:Math.round(ms)};
  });
  check('an evicted cel restores its exact tiles from GPU memory without decoding',restored.evicted&&restored.tiles>0&&restored.restored===1&&restored.decodes===0&&restored.exact&&restored.pngs,restored);
  // 5. A closing GPU stroke: its read-back keeps the stroke visible, saving
  // waits for it, and Escape or replacing the document discards it cleanly.
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{GpuStroke}=await import('/src/drawing-gpu.mjs');
    styk.editor.load(emptyDocument());styk.drawing.bind();styk.editor.createDrawingLayer();Object.assign(styk.drawing.settings,{size:10,color:'#1040e0',stabilization:0,texture:0});styk.fit();
    const finish=window.gpuFinishOriginal??=GpuStroke.prototype.finish;
    window.holdFinish=()=>{window.finishHeld=false;GpuStroke.prototype.finish=async function(){const result=await finish.call(this);window.finishHeld=true;await new Promise(resolve=>window.releaseFinish=resolve);return result;};};
    window.restoreFinishHold=()=>{GpuStroke.prototype.finish=finish;};
    window.fixtureRevision=styk.editor.revision;window.fixtureUndo=styk.editor._undo.length;
  });
  await page.evaluate(()=>holdFinish());await stroke(300,300,{release:false});await page.mouse.up();await page.waitForFunction(()=>window.finishHeld);
  const closing=await page.evaluate(()=>({ended:Boolean(styk.drawing.gesture?.session?.ended),unchanged:styk.editor.revision===fixtureRevision&&styk.editor._undo.length===fixtureUndo}));
  const closingPixel=await pixelAt(300,300);
  await page.evaluate(()=>{window.barrierSettled=false;window.barrierDone=styk.drawing.barrier().then(()=>window.barrierSettled=true);});
  const barrierWaited=await page.evaluate(()=>!window.barrierSettled);
  await page.evaluate(async()=>{releaseFinish();await barrierDone;});
  const closed=await page.evaluate(()=>({undo:styk.editor._undo.length===fixtureUndo+1&&styk.editor.undoLabel==='Brush stroke',idle:!styk.drawing.gesture&&!styk.drawing.operation&&[...styk.drawing.owner.entries.values()].every(e=>!e.preparing)}));
  check('a closing GPU stroke stays visible and uncommitted during read-back',closing.ended&&closing.unchanged&&closingPixel[2]>150&&closingPixel[0]<120,{closing,closingPixel});
  check('saving waits for the closing GPU stroke',barrierWaited);
  check('the closing GPU stroke commits once and releases its preparation',closed.undo&&closed.idle,closed);
  await page.evaluate(()=>{window.fixtureRevision=styk.editor.revision;window.fixtureUndo=styk.editor._undo.length;holdFinish();});
  await stroke(300,450,{release:false});await page.mouse.up();await page.waitForFunction(()=>window.finishHeld);
  await page.keyboard.press('Escape');await page.evaluate(()=>releaseFinish());await settle();
  const escaped=await page.evaluate(()=>styk.editor.revision===fixtureRevision&&styk.editor._undo.length===fixtureUndo&&[...styk.drawing.owner.entries.values()].every(e=>!e.preparing));
  const escapedPixel=await pixelAt(300,450);
  check('Escape during GPU read-back leaves no history or pixels',escaped&&!(escapedPixel[2]>150&&escapedPixel[0]<120),escapedPixel);
  await page.evaluate(()=>holdFinish());await stroke(650,420,{release:false});await page.mouse.up();await page.waitForFunction(()=>window.finishHeld);
  await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');window.closedOwner=styk.drawing.owner;styk.editor.load(emptyDocument());styk.drawing.bind();releaseFinish();});
  await settle();
  const replaced=await page.evaluate(()=>({disposed:closedOwner.disposed&&closedOwner.workingBytes===0,clean:styk.editor.report.figure_types.every(f=>!f._styk?.drawing)}));
  await page.evaluate(()=>restoreFinishHold());
  check('replacing the document during GPU read-back discards the stroke',replaced.disposed&&replaced.clean,replaced);
  await page.screenshot({path:`${output}/workspace.png`});
  // Unchanged frames reuse the cel's tile instances; an instance whose slot was
  // evicted and handed to another tile is never drawn again.
  const reuse=await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs'),e=styk.editor,d=styk.drawing,gpu=styk.state.renderer.drawingGpu;
    e.load(emptyDocument());d.bind();e.createDrawingLayer();const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}});await d.owner.surface(target.figure);
    const tiles=[];for(let ty=0;ty<6;ty++)for(let tx=0;tx<8;tx++)tiles.push({tx,ty,before:null,after:new Uint8ClampedArray(64*64*4).fill(200)});
    e.commitDrawingPixels(target,tiles,'Fixture');styk.fit();
    const frame=()=>new Promise(resolve=>{const r=styk.state.renderer,render=r.render;r.render=function(...a){const v=render.apply(this,a);r.render=render;resolve();return v;};d.onRender();});
    await frame();await frame();const before=gpu.stats.reusedInstances??0;await frame();await frame();
    const reused=(gpu.stats.reusedInstances??0)-before;
    const presenter=d.owner.entry(e.drawingTarget().figure),state=gpu.states.get(presenter),retained=state.retained,record=retained.records[0];
    const intactBefore=gpu.intact(retained);gpu.evict(record);const other={slot:-1,kind:'tile'};gpu.allocate(other);record.slot=other.slot===retained.slots[0]?other.slot+1:other.slot;
    const intactAfter=gpu.intact(retained);gpu.evict(other);return {reused,intactBefore,intactAfter};
  });
  check('unchanged frames reuse the cel tile instances',reuse.reused>=2,reuse);
  check('instances whose slot was evicted and reassigned are rebuilt',reuse.intactBefore&&!reuse.intactAfter,reuse);
  check('no uncaught browser errors',errors.length===0,errors);
  await writeFile(`${output}/result.json`,JSON.stringify({checks,parity,levels,browser:browser.version(),date:new Date().toISOString()},null,2));
}catch(error){await page.screenshot({path:`${output}/failure.png`});console.error(errors);throw error;}finally{await browser.close();}
