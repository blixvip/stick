export async function verifyDrawingOnionLayering(){
  const {Editor}=await import('/src/editor.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const {OnionSkinCache}=await import('/src/onion-skin.mjs'),{normalizeEditorSettings}=await import('/src/settings.mjs'),{drawingMetadata}=await import('/src/drawing-model.mjs');
  const {createRenderer}=await import('/src/renderer.mjs'),{DrawingController}=await import('/src/drawing-controller.mjs');
  const report=emptyDocument(),floor=report.figure_types[0];report.canvas_width=320;report.canvas_height=200;
  floor.segments=[{...floor.segments[0],angle_rad:0,segment_kind:'squareLine',segment_type:'line',length:320,thickness:200,color_rgb:[90,70,50]}];floor.segment_count=1;
  report.keyframes=[createFrame([createObject(floor,1,0,100)])];
  const e=new Editor({demo:false,layerTimeline:true}).load(report);
  e.sheetInsertFrames(['scene','camera','layer-1'],1,9);
  const layer=e.createDrawingLayer('Ink'),owner=e.drawingResources;e.extendDrawing([layer.id],9);
  const previewFor=target=>Object.getOwnPropertyDescriptor(DrawingController.prototype,'renderPreview').get.call({editor:e,gesture:{target}});
  const previewOrders=[],observations=[],gpuErrors=[];
  e.setLayerVisible('scene',false);e.setLayerVisible('layer-1',false);
  for(const [tick,x] of [[0,20],[4,100],[8,180]]){
    e.seek(tick);if(tick)e.drawingKey([layer.id],tick,{blank:true});
    const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x,y:50}});
    previewOrders.push(previewFor(target).geometry.orderedObjects.map(g=>g.obj.unique_id));
    await owner.surface(target.figure);
    e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:new Uint8ClampedArray([255,0,0,255])}]);
  }
  await owner.flush();e.setLayerVisible('scene',true);e.setLayerVisible('layer-1',true);
  for(const tick of [3,5])e.sheetInsertKey(['camera'],tick);
  e.seek(4);
  const settings=normalizeEditorSettings({onionBefore:1,onionAfter:1,onionRangeBefore:4,onionRangeAfter:4,onionOpacity:.4,onionFade:false,onionTint:false});
  const cache=new OnionSkinCache(),canvases=[];
  const read=async renderer=>{
    await renderer.device?.queue.onSubmittedWorkDone();const image=new Image();image.src=renderer.canvas.toDataURL();await image.decode();
    const surface=new OffscreenCanvas(320,200),ctx=surface.getContext('2d');ctx.drawImage(image,0,0);
    return [30,110,190].map(x=>[...ctx.getImageData(x,60,1,1).data]);
  };
  try{
    for(const forceCanvas2D of [false,true]){
      const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas,{forceCanvas2D,resources:{drawing:f=>drawingMetadata(f)?owner.presenter(f):null}});
      await renderer.gpuDrawingReady;renderer.resize(320,200,1);renderer.device?.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));
      const paint=()=>({report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,view:{x:0,y:0,scale:1},cameraEnabled:false});
      try{
        renderer.render({...paint(),onionFrames:cache.get(e,settings)});
        observations.push({backend:renderer.stats.backend,name:'layer-neighbours',pixels:await read(renderer),expected:[[156,42,30,255],[255,0,0,255],[156,42,30,255]]});
        renderer.render({...paint(),onionFrames:cache.get(e,{...settings,onionMode:'frames',onionStep:4})});
        observations.push({backend:renderer.stats.backend,name:'frame-neighbours-across-layers',pixels:await read(renderer),expected:[[156,42,30,255],[255,0,0,255],[156,42,30,255]]});
        renderer.render({...paint(),onionFrames:cache.get(e,{...settings,onionMode:'frames',onionStep:4})});
        observations.push({backend:renderer.stats.backend,name:'warm-frame-neighbours',pixels:await read(renderer),expected:[[156,42,30,255],[255,0,0,255],[156,42,30,255]]});
        e.drawingKey([layer.id],4,{blank:true});renderer.render({...paint(),onionFrames:cache.get(e,settings)});
        observations.push({backend:renderer.stats.backend,name:'blank-current',pixels:await read(renderer),expected:[[156,42,30,255],[90,70,50,255],[156,42,30,255]]});
        await e.undo();renderer.render({...paint(),onionFrames:cache.get(e,settings)});
        observations.push({backend:renderer.stats.backend,name:'undo-blank',pixels:await read(renderer),expected:[[156,42,30,255],[255,0,0,255],[156,42,30,255]]});
        for(const tick of [0,8,4]){e.seek(tick);renderer.render(paint());const pixels=await read(renderer);observations.push({backend:renderer.stats.backend,name:`seek-${tick}`,current:pixels[tick===0?0:tick===8?2:1],expected:[255,0,0,255]});}
        e.setLayerVisible('scene',false);e.setLayerVisible('layer-1',false);renderer.render(paint());
        observations.push({backend:renderer.stats.backend,name:'hidden-surroundings',current:(await read(renderer))[1],expected:[255,0,0,255]});
        e.setLayerVisible('scene',true);e.setLayerVisible('layer-1',true);renderer.render(paint());
        observations.push({backend:renderer.stats.backend,name:'restored-surroundings',current:(await read(renderer))[1],expected:[255,0,0,255]});
        renderer.render({...paint(),onionFrames:cache.get(e,settings)});await read(renderer);canvases.push({backend:renderer.stats.backend,png:canvas.toDataURL()});
      }finally{renderer.destroy();}
    }
    e.drawingKey([layer.id],6,{blank:true});e.seek(6);e.reorderLayers([layer.id,'layer-1']);
    const target=e.prepareDrawingCel();previewOrders.push(previewFor(target).geometry.orderedObjects.map(g=>g.obj.unique_id));
    return {observations,previewOrders,gpuErrors,canvases};
  }finally{await owner.dispose();}
}

if(typeof window==='undefined'){
  const {chromium}=await import('./support/playwright.mjs'),{mkdir,writeFile}=await import('node:fs/promises'),assert=(await import('node:assert/strict')).default;
  const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>styk.ready);
    const result=await page.evaluate(async()=>{const {verifyDrawingOnionLayering}=await import('/tests/drawing-onion-layering.browser.mjs');return verifyDrawingOnionLayering();});
    const output='artifacts/drawing-onion-fix';await mkdir(output,{recursive:true});
    for(const canvas of result.canvases){await writeFile(`${output}/${canvas.backend}.png`,Buffer.from(canvas.png.split(',')[1],'base64'));delete canvas.png;}
    await writeFile(`${output}/layering-report.json`,JSON.stringify({...result,errors},null,2));
    assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[]);
    for(const row of result.observations){const actual=row.pixels?.flat()??row.current,expected=row.pixels?row.expected.flat():row.expected;assert.ok(actual.every((value,i)=>Math.abs(value-expected[i])<=1),JSON.stringify(row));}
    assert.ok(result.previewOrders.slice(0,3).every(order=>order[0]===1&&order[1]===2));assert.deepEqual(result.previewOrders.at(-1),[2,1]);
    console.log('PASS drawing layer order, hidden surroundings, before/after ghosts over an opaque floor, blank keys, undo and seeks on WebGPU and Canvas');
  }finally{await browser.close();}
}
