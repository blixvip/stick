import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${process.env.STYK_URL||'http://127.0.0.1:47843'}/api/health`);
  const result=await page.evaluate(async()=>{
    const [{createRenderer},{emptyDocument,createObject,createFrame},{buildGeometry},{createVfx}]=await Promise.all([import('/src/renderer.mjs'),import('/src/demo.mjs'),import('/src/pivot/geometry.mjs'),import('/src/vfx.mjs')]);
    const rows=[];
    for(const forceCanvas2D of [false,true]){
      const diagnostics=[],renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D,onError:error=>diagnostics.push(error.telemetryStage)});
      renderer.resize(320,240,1);
      if(!forceCanvas2D&&!renderer.device)throw new Error('WebGPU unavailable for recovery test.');
      const report=emptyDocument();report.canvas_width=320;report.canvas_height=240;
      const frame=createFrame([createObject(report.figure_types[0],1,160,140,{scale:.5})]);frame._stykVfx={figure:[{...createVfx('grade','test-grade'),params:{exposure:.25,contrast:1,saturation:1,temperature:0}}]};report.keyframes=[frame];
      const options={report,frame,geometry:buildGeometry(report,frame),view:{scale:1}};
      const field=forceCanvas2D?'vfxCamera':'vfxViewport';let attempts=0,destroyed=0;
      renderer[field]={render(){attempts++;throw new TypeError('Injected VFX surface failure');},destroy(){destroyed++;}};
      try {
        renderer.render(options);renderer.render(options);
        if(attempts!==1||destroyed!==1||diagnostics.length!==1||renderer.stats.vfxFailures!==1)throw new Error(`VFX failure retried or escaped the preview boundary: ${JSON.stringify({forceCanvas2D,attempts,destroyed,diagnostics,failures:renderer.stats.vfxFailures})}`);
        const ink=()=>{const c=new OffscreenCanvas(320,240),ctx=c.getContext('2d');ctx.drawImage(renderer.canvas,0,0);const p=ctx.getImageData(0,0,320,240).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i+3]>0&&p[i]<150)n++;return n;};
        await renderer.device?.queue.onSubmittedWorkDone();if(ink()<100)throw new Error('Unfiltered artwork vanished after effect failure.');
        renderer.vfxRetryAt=0;renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();
        if(!renderer[field]||diagnostics.length!==1||ink()<100)throw new Error('Camera effects did not recover.');
        rows.push({backend:renderer.stats.backend,attempts,destroyed,diagnostics,recovered:true});
      }finally{renderer.destroy();}
    }
    return rows;
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify(result));
}finally{await browser.close();}
