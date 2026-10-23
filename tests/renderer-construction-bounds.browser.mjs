/** Real GPU/Canvas/playback regression for distant invisible rig controls. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from './support/playwright.mjs';
import backendTools from '../desktop/backend.cjs';

const out=path.resolve('artifacts/renderer-construction-bounds');
await mkdir(out,{recursive:true});
const backend=await backendTools.startBackend({appRoot:process.cwd()});let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(backend.origin);await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const {buildGeometry}=await import('/src/pivot/geometry.mjs');
    const {compilePlaybackPacket}=await import('/src/playback-worker.mjs');
    const {emptyDocument,defaultFigure,createObject,createFrame}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=defaultFigure(1),base=figure.segments[0];
    figure.segments=[{...base,segment_id:1,parent_id:0,length:160,angle_rad:0,thickness:12},
      {...base,segment_id:2,parent_id:0,length:80,angle_rad:1.1,thickness:16},
      {...base,segment_id:3,parent_id:0,length:1e6,angle_rad:1.5,thickness:0,
        segment_type:'line',segment_kind:'squareLine',primitive_code:6,visible:true}];
    figure.segment_count=3;report.figure_types=[figure];report.canvas_width=320;report.canvas_height=240;
    report.keyframes=[createFrame([createObject(figure,1,50,90,{field28:100})])];
    const compact=structuredClone(report);compact.figure_types[0].segments[2].length=0;
    const scratch=new OffscreenCanvas(640,480),ctx=scratch.getContext('2d',{willReadFrequently:true});
    const checks=[],screens=[];
    for(const scale of [1,2]) for(const mode of ['editor','prepared','canvas']) {
      const pixels=[],stats=[];
      for(const [i,document] of [report,compact].entries()) {
        const canvas=window.document.createElement('canvas');
        const renderer=await createRenderer(canvas,{forceCanvas2D:mode==='canvas'});
        renderer.resize(640,480,1);
        const options={report:document,frame:document.keyframes[0],view:{x:0,y:0,scale},cameraEnabled:false};
        let packet;
        try {
          if(mode==='prepared') {
            packet=await compilePlaybackPacket(document,0,{revision:i+1,scale,gpuIsolation:true,cameraEnabled:false});
            renderer.prepareFrame(packet,options);
            if(!renderer.renderPrepared(packet.key,options))throw new Error('Missing prepared frame');
          } else renderer.render({...options,geometry:buildGeometry(document,document.keyframes[0])});
          await renderer.device?.queue.onSubmittedWorkDone();
          ctx.clearRect(0,0,640,480);ctx.drawImage(canvas,0,0);
          pixels.push(ctx.getImageData(0,0,640,480).data);
          const rasters=mode==='prepared'?packet.compatibility: [...(renderer.rasterCache?.lru.keys()||[])];
          stats.push({rasters:rasters.length,bytes:rasters.reduce((sum,r)=>sum+(r.bytes||r.width*r.height*4||0),0)});
          if(mode==='editor'&&i===0&&scale===2)screens.push(canvas.toDataURL());
        } finally {for(const item of packet?.compatibility||[])item.bitmap?.close();renderer.destroy();}
      }
      let different=0;for(let i=0;i<pixels[0].length;i++)if(pixels[0][i]!==pixels[1][i])different++;
      if(different)throw new Error(`${mode} at ${scale}x: invisible control changed ${different} pixel channels`);
      if(stats[0].bytes>2*1024*1024)throw new Error('Invisible control consumed the raster budget');
      checks.push({mode,scale,different,stats});
    }
    return {checks,screens};
  });
  await writeFile(path.join(out,'sharp.png'),Buffer.from(result.screens[0].split(',')[1],'base64'));
  delete result.screens;
  await writeFile(path.join(out,'report.json'),JSON.stringify({...result,errors},null,2));
  assert.deepEqual(errors,[]);console.log(JSON.stringify(result));
} finally {await browser?.close();backend.stop();}
