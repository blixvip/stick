import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${process.env.STYK_URL||'http://127.0.0.1:47843'}/api/health`);
  const results=await page.evaluate(async()=>{
    const {withVfx,releaseVfxSurface}=await import('/src/vfx-canvas.mjs'),{createVfx}=await import('/src/vfx.mjs');
    const {createRenderer}=await import('/src/renderer.mjs'),{emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const results=[];
    for(const types of [['blur'],['pixelate','noise'],['glow','blur']]){
      const stack=types.map(type=>createVfx(type,type)),bounds={x:0,y:0,width:5000,height:160};
      const paint=ctx=>{ctx.fillStyle='#08aaff';ctx.fillRect(0,50,5000,60);ctx.fillStyle='#ff3070';for(let x=1000;x<5000;x+=1024)ctx.fillRect(x,10,40,140);};
      const full=new OffscreenCanvas(5000,160),ctx=full.getContext('2d');withVfx(ctx,stack,paint,{bounds});
      const data=ctx.getImageData(0,0,5000,160).data;let max=0,sum=0,count=0;
      for(const seam of [1024,2048,3072,4096]){
        const crop=new OffscreenCanvas(700,160),c=crop.getContext('2d'),left=seam-350;c.translate(-left,0);withVfx(c,stack,paint,{bounds});
        const ref=c.getImageData(0,0,700,160).data;
        for(let y=20;y<140;y++)for(let x=250;x<450;x++)for(let channel=0;channel<4;channel++){
          const delta=Math.abs(ref[(y*700+x)*4+channel]-data[(y*5000+x+left)*4+channel]);max=Math.max(max,delta);sum+=delta;count++;
        }
        releaseVfxSurface(c);
      }
      if(max>3||sum/count>.2)throw new Error(`Effect tile seam: ${JSON.stringify({types,max,mean:sum/count})}`);
      results.push({types,max,mean:sum/count});releaseVfxSurface(ctx);
    }
    for(const forceCanvas2D of [false,true]){
      const report=emptyDocument(),fig=report.figure_types[0];fig.segments=[{...fig.segments[0],segment_id:1,parent_id:0,length:8000,angle_rad:Math.PI/2,thickness:30}];fig.segment_count=1;
      const object=createObject(fig,1,120,120);object._stykVfx={figure:[createVfx('glow','wide')]};const frame=createFrame([object],8);report.keyframes=[frame];
      const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D});renderer.resize(640,480,1);
      try{renderer.render({report,frame,geometry:buildGeometry(report,frame),view:{x:0,y:0,scale:1}});await renderer.device?.queue.onSubmittedWorkDone();
        if(renderer.stats.warnings?.length)throw new Error(JSON.stringify(renderer.stats.warnings));
        const out=new OffscreenCanvas(640,480),c=out.getContext('2d');c.drawImage(renderer.canvas,0,0);const data=c.getImageData(0,0,640,480).data;let ink=0;for(let i=0;i<data.length;i+=4)if(data[i+3]&&Math.min(data[i],data[i+1],data[i+2])<180)ink++;
        if(ink<100)throw new Error('Oversized filtered artwork vanished');results.push({backend:renderer.stats.backend,ink});
      }finally{renderer.destroy();}
    }
    return results;
  });
  assert.deepEqual(errors,[]);await fs.mkdir('artifacts/reliability-fixes',{recursive:true});await fs.writeFile('artifacts/reliability-fixes/vfx-surfaces.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
