import {chromium} from '../tests/support/playwright.mjs';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const results=[];for(const disableVectorVfx of [true,false]){const result=await page.evaluate(async(disableVectorVfx)=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs'),
   {connectedVfxGeometry}=await import('/src/vfx-connected.mjs'),{createVfx}=await import('/src/vfx.mjs'),{createRenderer}=await import('/src/renderer.mjs');
  const report=emptyDocument(),fig=report.figure_types[0],base=fig.segments[0];report.canvas_width=640;report.canvas_height=480;
  fig.segments=Array.from({length:100},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:30+i,angle_rad:i*Math.PI*2/100,thickness:6,z_order:i+1}));fig.segment_count=100;
  const objects=Array.from({length:105},(_,i)=>createObject(fig,i+1,320,240,{scale:.4+i/175,join:i?{target_object_slot:0,target_unique_id:1,target_handle_id:0}:null}));
  objects[0]._stykVfxScope=1;objects[0]._stykVfx={figure:[createVfx('glow','glow')]};
  const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas);renderer.resize(640,480,1);renderer.disableVectorVfx=disableVectorVfx;const grouping=[],rendering=[];
  try{
   for(let i=0;i<28;i++){
    const frame=createFrame(structuredClone(objects),1);frame.objects[1].angles[1]+=.01*i;report.keyframes=[frame];
    const geometry=buildGeometry(report,frame),start=performance.now(),group=connectedVfxGeometry(geometry,frame,report);const elapsed=performance.now()-start;
    if(group.orderedObjects.length!==1||connectedVfxGeometry(geometry,frame,report)!==group)throw new Error('Assembly grouping/cache mismatch');
    const renderStart=performance.now();renderer.render({report,frame,geometry,view:{x:0,y:0,scale:1}});if(renderer.device)await renderer.device.queue.onSubmittedWorkDone();
    if(i>=4){grouping.push(elapsed);rendering.push(performance.now()-renderStart);}
   }
   const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
   return {disableVectorVfx,vectorVfxObjects:renderer.stats.vectorVfxObjects??0,backend:renderer.stats.backend,figures:105,segments:10500,samples:24,groupingP95Ms:p95(grouping),renderAndGpuCompletionP95Ms:p95(rendering),rasterCacheBytes:renderer.rasterCache?.bytes,warnings:renderer.stats.warnings};
  }finally{renderer.destroy();}
 },disableVectorVfx);results.push(result);}
 await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/vector-performance.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
