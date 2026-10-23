// Real app regression probe: node scripts/verify-imported-playback.mjs animation.piv layered.styk
// Uses a running local server. Source documents are read without modification.
import {chromium} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const [animation,layers]=process.argv.slice(2);
if(!animation||!layers)throw new Error('Provide an animation and a layered STYK project.');
const output=path.resolve('artifacts/imported-playback');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],result={sources:[path.basename(animation),path.basename(layers)],runs:[]};
try{
  const page=await browser.newPage({viewport:{width:1560,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('input[type=file]').first().setInputFiles(animation);
  await page.waitForFunction(()=>styk.editor.report.keyframes.length>100,null,{timeout:120000});
  const total=await page.evaluate(()=>styk.editor.totalTicks);
  for(const start of [0,Math.min(175,total-1)]){
    await page.evaluate(start=>{
      const {editor,state}=styk;state.loop=false;editor.seek(start);styk.fit();
      const renderer=state.renderer;
      if(!window.probeRender){window.probeRender=renderer.renderPrepared.bind(renderer);renderer.renderPrepared=(...args)=>{
        const rendered=window.probeRender(...args);
        if(rendered&&state.playing&&window.probeFrames.at(-1)?.tick!==editor.tick)window.probeFrames.push({tick:editor.tick,at:performance.now()});
        return rendered;
      };}
      window.probeFrames=[];styk.actions.play();
    },start);
    await page.waitForFunction(()=>!styk.state.playing,null,{timeout:120000});
    const run=await page.evaluate(()=>({frames:window.probeFrames,performance:styk.performance()}));
    assert.equal(run.frames.length,total-start,'Every exact output tick must be presented');
    run.frames.forEach((frame,i)=>assert.equal(frame.tick,start+i));
    result.runs.push({start,...run});
    const {intervalsMs,...presentation}=run.performance.presentation;
    console.log(JSON.stringify({start,frames:run.frames.length,presentation}));
  }
  await page.evaluate(()=>{styk.editor.seek(Math.min(189,styk.editor.totalTicks-1));styk.fit();});
  await page.screenshot({path:path.join(output,'animation.png')});
  await page.locator('input[type=file]').first().setInputFiles(layers);
  await page.waitForFunction(()=>styk.editor.report._styk.layers.order.length>=3,null,{timeout:120000});
  result.insertion=await page.evaluate(async()=>{
    const {Editor}=await import('/src/editor.mjs'),{DocumentExporter}=await import('/src/document-export.mjs'),{ImportClient}=await import('/src/import-client.mjs');
    const e=styk.editor,layer=e.layers.find(layer=>!layer.permanent&&!e.getLayerFigureUids(layer.id).length);
    if(!layer)throw new Error('Expected an empty user layer');
    const figure=e.report.figure_types.find(figure=>figure._styk?.movieclip);if(!figure)throw new Error('Expected a movieclip definition');
    e.seek(5);e.selectSheetLayer(layer.id);const before=e.serialize();e.addFigure(figure.figure_type_id);const uid=e.selectedUid;
    if(e.layerForUid(uid)!==layer.id)throw new Error('Inserted on the wrong layer');
    e.seek(5);if(!e.evaluatedFrame.objects.some(object=>object.unique_id===uid))throw new Error('Inserted figure disappeared after seek');
    e.undo();if(JSON.stringify(e.serialize())!==JSON.stringify(before))throw new Error('Undo did not restore the project');e.redo();
    const exporter=new DocumentExporter(),importer=new ImportClient();
    try{
      const blob=await exporter.export(e.report,{format:'styk',name:'layer-insertion-regression'});
      const imported=await importer.importFile(new File([blob],'layer-insertion-regression.styk'));
      const reopened=new Editor({demo:false,layerTimeline:true}).load(imported.document);reopened.seek(5);
      if(reopened.layerForUid(uid)!==layer.id||!reopened.evaluatedFrame.objects.some(object=>object.unique_id===uid))throw new Error('Binary save/reload lost the insertion');
      e.select(uid);styk.fit();return {layer:layer.id,uid,tick:5,binaryBytes:blob.size,undoRedo:true,binaryReload:true};
    }finally{exporter.dispose();importer.dispose();}
  });
  await page.screenshot({path:path.join(output,'layer-insertion.png')});
  assert.deepEqual(errors,[]);result.errors=errors;
  result.limitation='Browser GPU submissions and exact tick sequence; not physical display latency. Timing depends on hardware and browser scheduling.';
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result.insertion));
}finally{await browser.close();}
