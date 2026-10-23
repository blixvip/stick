import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47851');await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs'),{compilePlaybackPacket}=await import('/src/playback-worker.mjs'),{rigExampleDocument,RIG_EXAMPLES}=await import('/src/rig-examples.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs'),{exportSVG}=await import('/src/svg-export.mjs');
    const canvas=document.createElement('canvas');document.body.append(canvas);const renderer=await createRenderer(canvas);renderer.resize(640,460,1);const results=[];
    const raster=document.createElement('canvas');raster.width=640;raster.height=460;const ctx=raster.getContext('2d',{willReadFrequently:true});
    const pixels=async src=>{const img=new Image();img.src=src;await img.decode();ctx.clearRect(0,0,640,460);ctx.drawImage(img,0,0);return ctx.getImageData(0,0,640,460).data;};
    const read=async()=>{await renderer.device?.queue.onSubmittedWorkDone();return pixels(canvas.toDataURL());};
    const diff=(a,b)=>{let total=0,bad=0;for(let i=0;i<a.length;i+=4){let pixel=0;for(let k=0;k<3;k++){const d=Math.abs(a[i+k]-b[i+k]);total+=d;pixel=Math.max(pixel,d);}if(pixel>30)bad++;}return {mean:total/(a.length/4*3),badFraction:bad/(a.length/4)};};
    const examples=[...RIG_EXAMPLES,{id:'signed-reset-stretch',base:'telescoping-panels',control:1},{id:'relative-angle-lock',base:'articulated-piston',control:2},{id:'connector-slide-stretch',base:'flexing-muscle',control:3}];
    try{for(const [i,r] of examples.entries()){
      const report=rigExampleDocument(r.base??r.id),frame=report.keyframes[0],o=frame.objects[0],fig=report.figure_types[0];
      if(r.id==='signed-reset-stretch'){
        fig.segments[0]._stykRig.stretch.branch=true;o.len_flag=1;o.lengths=fig.segments.map(s=>s.length);o.lengths[0]=50;
        for(const s of fig.segments.slice(1)){const mode=s._stykRig.follow.mode;s._stykRig={response:{mode,multiplier:3,reset:s.segment_id===4}};}
      }
      if(r.id==='relative-angle-lock'){
        fig.segments[3]._stykRig={angleLock:{mode:'parent',reference:2,restAngle:-.7,figureRestAngle:0,angle:-.35,multiplier:-1}};
        o.angles=o.angles.map(a=>a+.25);
      }
      if(r.id==='connector-slide-stretch')Object.assign(fig.segments[2]._stykRig.stretch,{branch:true,source:'combined',restPosition:.5});
      if(fig.segments[r.control-1]._stykRig?.connector){o.len_flag=1;o.lengths=fig.segments.map(s=>s.length);o.lengths[r.control-1]=.7;}else o.angles[r.control-1]+=.9;
      const geometry=buildGeometry(report,frame),view={x:0,y:0,scale:1};renderer.useReport(report);renderer.render({report,frame,geometry,view});const edit=await read();
      const packet=await compilePlaybackPacket(report,0,{revision:i+1});const key=renderer.prepareFrame(packet,{report,view});if(!renderer.renderPrepared(key,{report,view}))throw new Error('Prepared rig frame missing');const playback=await read();
      const svg=await exportSVG({report,frame,geometry,width:640,height:460}),url=URL.createObjectURL(svg);let exported;try{exported=await pixels(url);}finally{URL.revokeObjectURL(url);}
      for(const c of packet.compatibility??[])c.bitmap?.close();
      results.push({rig:r.id,playback:diff(edit,playback),svg:diff(edit,exported)});
    }return {backend:renderer.stats.backend,results};}finally{renderer.destroy?.();canvas.remove();}
  });
  assert.equal(result.backend,'WebGPU');for(const r of result.results){assert.ok(r.playback.mean<.2,`${r.rig} playback ${r.playback.mean}`);assert.ok(r.svg.mean<2&&r.svg.badFraction<.02,`${r.rig} SVG ${JSON.stringify(r.svg)}`);}
  assert.deepEqual(errors,[]);await mkdir('artifacts/rig-constraints',{recursive:true});await writeFile('artifacts/rig-constraints/render-report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
