import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
await mkdir('artifacts/onion-scene-opacity',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async rendererModule=>{
    const {createRenderer}=await import(rendererModule),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {createVfx}=await import('/src/vfx.mjs');
    const report=emptyDocument(),f=report.figure_types[0];report.canvas_width=240;report.canvas_height=180;
    f.segments=[{...f.segments[0],segment_id:1,parent_id:0,segment_kind:'squareLine',segment_type:'line',length:100,thickness:80,angle_rad:0,color_rgb:[255,0,0]}];f.segment_count=1;
    const blue=structuredClone(f);blue.figure_type_id=2;blue.segments[0].color_rgb=[0,0,255];report.figure_types.push(blue);
    const frame=createFrame([]),prior=createFrame([createObject(f,1,40,80),createObject(blue,2,80,80)]);
    report.keyframes=[frame];const geometry=buildGeometry(report,frame),ghost=buildGeometry(report,prior),rows=[],gpuErrors=[];
    for(const fallback of [false,true]){
      const canvas=document.createElement('canvas');if(fallback)canvas.getContext('2d');
      const renderer=await createRenderer(canvas);if(!fallback&&renderer.stats.backend!=='WebGPU')throw Error('WebGPU unavailable');
      renderer.device?.addEventListener('uncapturederror',e=>gpuErrors.push(e.error.message));
      const read=async()=>{await renderer.device?.queue.onSubmittedWorkDone();const bitmap=await createImageBitmap(canvas),surface=new OffscreenCanvas(canvas.width,canvas.height),ctx=surface.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();return[...ctx.getImageData(110,80,1,1).data].slice(0,3);};
      const options={report,frame,geometry,view:{x:0,y:0,scale:1},cameraEnabled:false};
      try{
        renderer.resize(240,180,1);
        for(const [name,onions,hidden,expected] of [
          ['opaque-overlap',[{frame:prior,geometry:ghost,opacity:.5}],[],[128,128,255]],
          ['on-top',[{frame:prior,geometry:ghost,opacity:.5,showOnTop:true}],[],[128,128,255]],
          ['hidden-front',[{frame:prior,geometry:ghost,opacity:.5}],[2],[255,128,128]],
          ['two-frames',[{frame:prior,geometry:ghost,opacity:.5},{frame:prior,geometry:ghost,opacity:.25}],[],[96,96,255]],
        ]){
          renderer.render({...options,onionFrames:onions,hiddenUids:new Set(hidden)});
          const actual=await read();
          if(!actual.every((v,i)=>Math.abs(v-expected[i])<=2))throw Error(JSON.stringify({backend:renderer.stats.backend,name,actual,expected}));
          rows.push({backend:renderer.stats.backend,name,actual,expected});
        }
        // Figure transparency still belongs to the individual artwork.
        const transparent=createFrame([createObject(f,1,40,80),createObject(blue,2,80,80,{field28:128})]);
        renderer.render({...options,onionFrames:[{frame:transparent,geometry:buildGeometry(report,transparent),opacity:.5}]});
        rows.push({backend:renderer.stats.backend,name:'intrinsic-opacity',actual:await read(),expected:[192,128,191]});
        renderer.render({...options,view:{x:0,y:70,scale:1},onionFrames:[{frame:prior,geometry:ghost,opacity:.5}]});
        rows.push({backend:renderer.stats.backend,name:'pan-invalidates-cache',actual:await read(),expected:[255,255,255]});
        // Camera effects repaint onions through the same completed-frame path.
        const filtered={...frame,_stykVfx:{figure:[createVfx('blur','scene-blur')]}};
        renderer.render({...options,frame:filtered,geometry:buildGeometry(report,filtered),onionFrames:[{frame:prior,geometry:ghost,opacity:.5}]});
        rows.push({backend:renderer.stats.backend,name:'scene-effects',actual:await read(),expected:[128,128,255]});
        for(const msaa of fallback?[1]:[1,4]){
          if(!fallback)await renderer.setMsaa(msaa);
          renderer.resize(320,200,1);renderer.render({...options,onionFrames:[{frame:prior,geometry:ghost,opacity:.5}]});
          rows.push({backend:renderer.stats.backend,name:`resize-${msaa}`,actual:await read(),expected:[128,128,255]});
        }
        renderer.render({...options,onionFrames:[{frame:prior,geometry:ghost,opacity:.5}]});
        rows.push({backend:renderer.stats.backend,name:'visual',png:canvas.toDataURL()});
        if(fallback){
          renderer.resize(2048,2048,1);
          for(let i=0;i<6;i++){
            renderer.render({...options,onionFrames:[{frame:prior,geometry:buildGeometry(report,prior),opacity:.5}]});
            if(renderer.onionArtworkBytes>64*1024*1024)throw Error('Canvas onion cache exceeded its shared budget');
          }
        }
        renderer.render({...options,onionFrames:[]});await renderer.device?.queue.onSubmittedWorkDone();
        if((renderer.stats.onionCompositeBytes??renderer.onionArtworkBytes)!==0)throw Error('Onion surface retained after disabling');
        if(renderer.onionComposite||renderer.onionSurface)throw Error('Onion compositor not released');
      }finally{renderer.destroy();}
    }
    return {rows,gpuErrors};
  },process.env.STYK_ONION_RENDERER??'/src/renderer.mjs');
  for(const row of result.rows){
    if(row.png){await writeFile(`artifacts/onion-scene-opacity/${row.backend}.png`,Buffer.from(row.png.split(',')[1],'base64'));delete row.png;continue;}
    assert.ok(row.actual.every((v,i)=>Math.abs(v-row.expected[i])<=2),JSON.stringify(row));
  }
  assert.deepEqual(result.gpuErrors,[]);assert.deepEqual(errors,[]);
  await writeFile('artifacts/onion-scene-opacity/report.json',JSON.stringify(result,null,2));
  console.log('PASS complete-frame onion opacity, original figure opacity, hidden figures, multiple ghosts, scene VFX, resize/MSAA and disposal on WebGPU and Canvas');
}finally{await browser.close();}
