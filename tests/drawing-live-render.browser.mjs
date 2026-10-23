import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output='artifacts/drawing-zoom';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
if(process.env.STYK_BASELINE)await page.route('**/src/renderer.mjs',route=>route.fulfill({contentType:'text/javascript',body:execFileSync('git',['show',`${process.env.STYK_BASELINE_REF||'HEAD'}:src/renderer.mjs`],{encoding:'utf8'})}));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>styk?.ready);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs'),{createDrawingFigure,drawingPixelMatrix}=await import('/src/drawing-model.mjs');
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const {DrawingResources}=await import('/src/drawing-resources.mjs'),{drawCameraOutline}=await import('/src/camera-overlay.mjs');
    const results=[];
    for(const [forceCanvas2D,vfxEnabled] of [[false,true],[false,false],[true,true]]){
      const figure=createDrawingFigure(),report=emptyDocument();report.figure_types=[figure];
      const frame=createFrame([createObject(figure,1,0,0)]);report.keyframes=[frame];
      const owner=new DrawingResources(report),surface=await owner.surface(figure);
      const c=document.createElement('canvas'),r=await createRenderer(c,{forceCanvas2D,resources:{drawing:f=>owner.presenter(f)}});await r.gpuDrawingReady;r.resize(320,240,1);
      const geometry=buildGeometry(report,frame),matrix=drawingPixelMatrix(geometry.drawables[0]);
      const view={x:80-matrix[4],y:60-matrix[5],scale:1};
      const options={report,frame,geometry,view,cameraEnabled:false,clipToCanvas:false,vfxEnabled};
      const preparation=[];
      const read=async()=>{r.render(options);preparation.push(r.stats.preparation);await r.device?.queue.onSubmittedWorkDone();const im=new Image();im.src=c.toDataURL();await im.decode();const out=new OffscreenCanvas(320,240),ctx=out.getContext('2d');ctx.drawImage(im,0,0);return Array.from(ctx.getImageData(100,80,1,1).data);};
      try{
        await read();surface.store.set(0,0,new Uint8ClampedArray([30,60,220,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
        const live=await read();
        surface.store.set(20,0,new Uint8ClampedArray([220,30,60,255]));owner.present(surface,{x:1280,y:0,width:64,height:64});
        view.x-=1280;const pan=await read();
        surface.store.delete(20,0);owner.present(surface,{x:1280,y:0,width:64,height:64});const erased=await read();
        view.x+=1280;const back=await read();
        results.push({backend:r.stats.backend,vfxEnabled,live,pan,erased,back,preparation});
      }finally{r.destroy();owner.dispose();}
    }
    const outline=[];
    const old=(ctx,points)=>{ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([0,6]);ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();for(const [color,width] of [['rgba(255,255,255,.8)',3],['#dc4545',1.5]]){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}ctx.restore();};
    for(const points of [
      [{x:20,y:20},{x:250,y:20},{x:250,y:180},{x:20,y:180}],
      [{x:-10001,y:20},{x:30000,y:20},{x:30000,y:18000},{x:-10001,y:18000}],
      [{x:140,y:-100},{x:420,y:140},{x:140,y:380},{x:-140,y:140}],
    ]){
      const canvases=[new OffscreenCanvas(320,240),new OffscreenCanvas(320,240)];
      old(canvases[0].getContext('2d'),points);drawCameraOutline(canvases[1].getContext('2d'),{corners:points},p=>p);
      const pixels=canvases.map(c=>c.getContext('2d').getImageData(0,0,320,240).data);let different=0,max=0;
      for(let i=0;i<pixels[0].length;i++){const delta=Math.abs(pixels[0][i]-pixels[1][i]);if(delta>2)different++;max=Math.max(max,delta);}
      let covered=0,alphaError=0,missingCore=0;
      for(let i=3;i<pixels[0].length;i+=4){const a=pixels[0][i],b=pixels[1][i];if(a||b){covered++;alphaError+=Math.abs(a-b);}if((a>180&&b<80)||(b>180&&a<80))missingCore++;}
      outline.push({different,max,covered,meanAlphaError:alphaError/Math.max(1,covered),missingCore});
    }
    return {results,outline};
  });
  await writeFile(`${output}/live-render${process.env.STYK_BASELINE?'-baseline':''}.json`,JSON.stringify({result,errors},null,2));
  console.log(JSON.stringify({result,errors},null,2));
  assert.deepEqual(errors,[]);
  for(const r of result.results){assert.deepEqual(r.live,[30,60,220,255],`${r.backend} live pixels with retained geometry`);assert.deepEqual(r.pan,[220,30,60,255],`${r.backend} pan to previously offscreen ink`);assert.notDeepEqual(r.erased,r.pan);assert.deepEqual(r.back,r.live);if(r.backend==='WebGPU')assert.ok(r.preparation.slice(1).every(p=>p==='retained'||p==='drawing'),'pixel edits and pan retain scene layout');}
  for(const r of result.outline){assert.equal(r.missingCore,0,'visible dot centers and gaps remain aligned');assert.ok(r.meanAlphaError<16,'outline alpha differs only within edge antialiasing tolerance');}
}finally{await browser.close();}
