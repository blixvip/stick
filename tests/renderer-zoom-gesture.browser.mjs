import {chromium} from './support/playwright.mjs';
import backend from '../desktop/backend.cjs';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const output=path.resolve(process.env.STYK_ZOOM_GESTURE_OUTPUT??'artifacts/zoom-gesture');
const stateOnly=process.argv.includes('--state-only');
const refinementSmall=process.argv.includes('--refinement-small');
const drawingCPUOnly=process.argv.includes('--drawing-cpu-only');
const cameraOnly=process.argv.includes('--camera-only');
const cameraDrawingOnly=process.argv.includes('--camera-drawing-only');
const cameraGPUOnly=process.argv.includes('--camera-gpu-only');
const sceneCPUOnly=process.argv.includes('--scene-cpu-only');
const sceneDrawingCaptureOnly=process.argv.includes('--scene-drawing-capture-only');
const sceneCaptureOnly=sceneCPUOnly||sceneDrawingCaptureOnly||process.argv.includes('--scene-capture-only');
const drawingReferenceURL=process.env.STYK_ZOOM_GESTURE_REFERENCE_URL;
const withDeadline=async(promise,milliseconds)=>{
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser fixture exceeded its bounded deadline.')),milliseconds);})]);}
  finally{clearTimeout(timer);}
};
const browserGraphics=page=>page.evaluate(()=>{
  const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2');
  if(!gl)return {webgl2:false};
  try{
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    return {webgl2:true,vendor:gl.getParameter(info?.UNMASKED_VENDOR_WEBGL??gl.VENDOR),renderer:gl.getParameter(info?.UNMASKED_RENDERER_WEBGL??gl.RENDERER),version:gl.getParameter(gl.VERSION)};
  }finally{gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.width=canvas.height=1;}
});
const files=['src/renderer.mjs','src/renderer-geometry.mjs','src/renderer-raster-cache.mjs','src/renderer-raster-capture.mjs','src/renderer-canvas-plan.mjs','src/renderer-preview-drawings.mjs','src/renderer-preview-drawing-resources.mjs','src/raster-surfaces.mjs','src/surface-raster.mjs','src/raster-view.mjs','src/canvas-raster-refinement.mjs','src/drawing-worker-client.mjs','src/drawing-composite-worker.mjs','src/drawing-composite-transport.mjs','src/drawing-composite.mjs','src/drawing-resources.mjs','src/drawing-render-dependencies.mjs','src/drawing-preview-cache.mjs','src/drawing-raster.mjs','src/drawing-tiles.mjs','src/pivot/geometry.mjs','src/vfx.mjs','src/vfx-surface.mjs','src/vfx-canvas.mjs','src/vfx-gpu.mjs','src/vfx-webgpu.mjs','src/vfx-cpu.mjs','src/playback-resources.mjs','src/drawing-provider.mjs','src/drawing-model.mjs','tests/renderer-zoom-gesture-fixture.mjs','tests/renderer-zoom-gesture.browser.mjs'];
files.push('src/vfx-camera.mjs','src/vfx-scene.mjs','src/renderer-camera-scene.mjs');
files.push('src/vfx-camera-gpu.mjs','src/vfx-viewport.mjs');
files.push('src/export-frame-core.mjs','src/vfx-connected.mjs');
if(drawingReferenceURL){
  const referencePath=decodeURIComponent(new URL(drawingReferenceURL,'http://localhost').pathname).replace(/^\//,'');
  const referenceRoot=path.dirname(referencePath);
  files.push(...['renderer.mjs','pivot/geometry.mjs','vfx.mjs','vfx-canvas.mjs','vfx-gpu.mjs','vfx-webgpu.mjs','vfx-cpu.mjs'].map(file=>path.join(referenceRoot,file)));
}
const fingerprints=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const sources=await fingerprints(),service=process.env.STYK_ZOOM_GESTURE_ORIGIN
  ?{origin:process.env.STYK_ZOOM_GESTURE_ORIGIN,stop(){}}
  :await backend.startBackend({appRoot:process.cwd()});
let browser;
const errors=[],networkFailures=[],progress=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('requestfailed',request=>networkFailures.push({url:request.url(),error:request.failure()?.errorText}));
  await page.exposeFunction('zoomCheckProgress',update=>{progress.push(update);console.log(JSON.stringify(update));});
  await page.goto(service.origin+'/api/health');
  const result=await withDeadline(page.evaluate(async({stateOnly,refinementSmall,drawingCPUOnly,cameraOnly,cameraDrawingOnly,cameraGPUOnly,sceneCaptureOnly,drawingReferenceURL})=>{
    const reports=[];
    try{
      if(drawingCPUOnly||sceneCaptureOnly)return {reports};
      const {zoomGestureState,zoomGestureDrawing,zoomArtworkRefinement,zoomCameraArtworkRefinement,zoomCameraDrawingArtworkRefinement,zoomCameraCappedGPU,zoomCameraHeldGPU,zoomCanvasOnionBudget}=await import('/tests/renderer-zoom-gesture-fixture.mjs');
      if(!refinementSmall&&!cameraOnly&&!cameraDrawingOnly&&!cameraGPUOnly)for(const forceCanvas2D of [false,true]){
        await window.zoomCheckProgress({phase:'state',forceCanvas2D});
        reports.push(await zoomGestureState({forceCanvas2D}));
        await window.zoomCheckProgress({phase:'drawing',forceCanvas2D});
        reports.push(await zoomGestureDrawing({forceCanvas2D}));
      }
      if(!refinementSmall&&!cameraOnly&&!cameraDrawingOnly&&!cameraGPUOnly){
        await window.zoomCheckProgress({phase:'Canvas onion allowance'});
        reports.push(await zoomCanvasOnionBudget());
      }
      if(!stateOnly&&!cameraOnly&&!cameraDrawingOnly){
        await window.zoomCheckProgress({phase:'capped GPU camera'});
        reports.push(await zoomCameraCappedGPU({onProgress:update=>{
          if(update.checks%10===0)void window.zoomCheckProgress({phase:'capped GPU camera',...update});
        }}));
        await window.zoomCheckProgress({phase:'held GPU camera'});
        reports.push(await zoomCameraHeldGPU());
      }
      if(!stateOnly&&!cameraOnly&&!cameraDrawingOnly&&!cameraGPUOnly){
        await window.zoomCheckProgress({phase:'async refinement'});
        reports.push(await zoomArtworkRefinement({drawingReferenceURL,includePressure:!refinementSmall,includeDense:!refinementSmall,onProgress:update=>{
          if(update.checks%20===0)void window.zoomCheckProgress({phase:'async refinement',...update});
        }}));
      }
      if(!stateOnly&&!cameraDrawingOnly&&!cameraGPUOnly){
        await window.zoomCheckProgress({phase:'scene refinement'});
        reports.push(await zoomCameraArtworkRefinement({cameraReferenceURL:drawingReferenceURL,onProgress:update=>{
          if(update.checks%5===0)void window.zoomCheckProgress({phase:'scene refinement',...update});
        }}));
      }
      if(!stateOnly&&!cameraOnly&&!cameraGPUOnly){
        await window.zoomCheckProgress({phase:'published scene refinement'});
        reports.push(await zoomCameraDrawingArtworkRefinement({onProgress:update=>{
          if(update.checks%5===0)void window.zoomCheckProgress({phase:'published scene refinement',...update});
        }}));
      }
      return {reports};
    }catch(error){
      return {reports,failure:{message:error.message,stack:error.stack,details:error.details,partialChecks:error.partialChecks,partialRows:error.partialRows}};
    }
  },{stateOnly,refinementSmall,drawingCPUOnly,cameraOnly,cameraDrawingOnly,cameraGPUOnly,sceneCaptureOnly,drawingReferenceURL}),refinementSmall||cameraOnly||cameraDrawingOnly||cameraGPUOnly?240000:420000);
  result.graphics=await browserGraphics(page);await page.close();
  if(!stateOnly&&!cameraOnly&&!cameraDrawingOnly&&!cameraGPUOnly&&!result.failure){
    const cpuPage=await browser.newPage();
    cpuPage.on('pageerror',error=>errors.push(error.message));
    cpuPage.on('requestfailed',request=>networkFailures.push({url:request.url(),error:request.failure()?.errorText}));
    await cpuPage.exposeFunction('zoomCheckProgress',update=>{progress.push(update);console.log(JSON.stringify(update));});
    await cpuPage.goto(service.origin+'/api/health');
    const cpuResult=await withDeadline(cpuPage.evaluate(async({drawingCPUOnly,sceneCaptureOnly,sceneCPUOnly,sceneDrawingCaptureOnly})=>{
      try{
        const {zoomDrawingCaptureNative,zoomSceneCaptureNative,zoomSceneDrawingCaptureNative}=await import('/tests/renderer-zoom-gesture-fixture.mjs'),reports=[];
        if(!sceneCaptureOnly)for(const disableWebGL of drawingCPUOnly?[true]:[false,true])reports.push(await zoomDrawingCaptureNative({disableWebGL,onProgress:update=>{if(update.checks%10===0)void window.zoomCheckProgress({phase:disableWebGL?'drawing CPU fallback':'drawing GPU capture',...update});}}));
        if(!drawingCPUOnly&&!sceneDrawingCaptureOnly)for(const disableWebGL of sceneCPUOnly?[true]:[false,true])reports.push(await zoomSceneCaptureNative({disableWebGL,onProgress:update=>{if(update.checks%5===0)void window.zoomCheckProgress({phase:disableWebGL?'scene CPU fallback':'scene GPU capture',...update});}}));
        if(!drawingCPUOnly)for(const disableWebGL of sceneCPUOnly?[true]:[false,true])reports.push(await zoomSceneDrawingCaptureNative({disableWebGL,onProgress:update=>{if(update.checks%5===0)void window.zoomCheckProgress({phase:disableWebGL?'published scene CPU fallback':'published scene GPU capture',...update});}}));
        return {reports};
      }catch(error){return {failure:{message:error.message,stack:error.stack,details:error.details,partialChecks:error.partialChecks,partialRows:error.partialRows}};}
    },{drawingCPUOnly,sceneCaptureOnly,sceneCPUOnly,sceneDrawingCaptureOnly}),120000);
    if(cpuResult.failure)result.failure=cpuResult.failure;else result.reports.push(...cpuResult.reports);
    await cpuPage.close();
  }
  const {reports,failure,graphics}=result,sourcesAfter=await fingerprints();
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'quality.json'),JSON.stringify({measuredAt:new Date().toISOString(),node:process.version,browser:browser.version(),graphics,stateOnly,refinementSmall,drawingCPUOnly,cameraOnly,cameraDrawingOnly,cameraGPUOnly,sceneCaptureOnly,sceneCPUOnly,sceneDrawingCaptureOnly,sources,sourcesAfter,reports,progress,errors,networkFailures,failure},null,2));
  console.log(JSON.stringify({output,checks:reports.reduce((count,report)=>count+report.checks.length,0),backends:[...new Set(reports.map(report=>report.backend))],errors,failure:failure&&{message:failure.message,partialChecks:failure.partialChecks?.length}}));
  assert.deepEqual(errors,[]);
  assert.ifError(failure?Error(failure.message):undefined);
  assert.ok(reports.length>0&&reports.every(report=>report.checks.length>0),'No verification scenario completed; check fixture flags.');
  assert.deepEqual(sourcesAfter,sources,'Measured production, reference, or fixture sources changed during the run.');
}catch(error){
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'browser-failure.json'),JSON.stringify({measuredAt:new Date().toISOString(),node:process.version,browser:browser?.version(),sources,progress,errors,networkFailures,failure:{message:error.message,stack:error.stack}},null,2));
  throw error;
}finally{await browser?.close();service.stop();}
