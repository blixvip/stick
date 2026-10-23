import {chromium} from './support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = 'artifacts/camera-image-background';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1100, height: 850}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  const result = await page.evaluate(async () => {
    const {createRenderer, screenToWorld} = await import('/src/renderer.mjs');
    const {emptyDocument, createFrame} = await import('/src/demo.mjs');
    const {ensureLayerState} = await import('/src/layers.mjs');
    const {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const {compilePlaybackPacket} = await import('/src/playback-worker.mjs');
    const {exportSVG} = await import('/src/svg-export.mjs');
    const {drawExportScene} = await import('/src/export-frame-core.mjs');
    const {createCameraMotion, frameWithCameraTime} = await import('/src/camera-motion.mjs');
    const check = (value, message) => {if (!value) throw new Error(message);};
    document.body.innerHTML = '<h2>Image backgrounds: pan, roll, zoom, and camera motion</h2>';
    document.body.style.cssText = 'font:14px system-ui;background:#ddd;display:flex;flex-wrap:wrap;gap:12px';
    const colors = [[200,40,60], [40,160,80], [40,80,200], [220,160,40]];
    const source = document.createElement('canvas'); source.width = 16; source.height = 12;
    const ctx = source.getContext('2d');
    const rows = [];
    for (const transparent of [false, true]) {
      ctx.clearRect(0,0,16,12);
      colors.forEach((color,i) => {ctx.fillStyle = `rgba(${color},${transparent ? .5 : 1})`;ctx.fillRect(i%2*8,Math.floor(i/2)*6,8,6);});
      const image = new Image(); image.src = source.toDataURL(); await image.decode();
      const resources = {url: asset => asset.data_url, image: () => image};
      for (const scenario of ['identity','pan','roll','zoom-out','combined','motion','hidden-camera','crossfade']) {
        const report = emptyDocument();report.canvas_width=160;report.canvas_height=120;
        report.backgrounds=[{background_id:1,kind:1,data_url:image.src,mime_type:'image/png'}, {background_id:2,kind:2,color:0xff141414}];
        const base = createFrame([]);base.background_id=1;report.keyframes=[base];
        const cameras = {pan:{x:70,y:-45},roll:{angle_rad:.6},'zoom-out':{scale:1.8},combined:{x:-55,y:35,scale:1.4,angle_rad:-.4},'hidden-camera':{x:70,y:80,angle_rad:1},crossfade:{x:-40,y:-30,scale:1.3}};
        base.camera={is_default:false,x:0,y:0,angle_rad:0,scale:1,...cameras[scenario]};
        if (scenario==='hidden-camera') ensureLayerState(report).fixed.camera.visible=false;
        if (scenario==='crossfade') {base.background_id_b=2;base.background_mix=100;}
        if (scenario==='motion') {const clip=createCameraMotion('impact','impact',0,24);report._styk={cameraMotion:{version:1,clips:[clip]}};}
        const frame=frameWithCameraTime(report,base,0), geometry=buildGeometry(report,frame), options={report,frame,geometry,view:{scale:1}};
        const gpu=await createRenderer(document.createElement('canvas'),{resources});
        const canvas=await createRenderer(document.createElement('canvas'),{resources,forceCanvas2D:true});
        check(gpu.device,'WebGPU required');gpu.device.addEventListener('uncapturederror',e=>{throw new Error(e.error.message);});
        gpu.resize(160,120,1);canvas.resize(160,120,1);
        const inspect = (surface,label) => {
          const copy=document.createElement('canvas');copy.width=160;copy.height=120;const c=copy.getContext('2d');c.drawImage(surface,0,0);
          const pixels=c.getImageData(0,0,160,120).data;
          const expectedAlpha=(scenario==='crossfade'?100/255+(transparent?128/255:1)*(1-100/255):(transparent?128/255:1))*255;
          for(let i=3;i<pixels.length;i+=4)
            check(Math.abs(pixels[i]-expectedAlpha)<4,`${scenario}/${transparent}/${label}: alpha seam at pixel ${(i-3)/4}: ${pixels[i]}`);
          for(let y=2;y<120;y+=11)for(let x=2;x<160;x+=13){
            const p=screenToWorld({x:x+.5,y:y+.5},options);
            if(Math.abs(p.x-80)<2||Math.abs(p.y-60)<2)continue;
            const color=colors[(p.x>=80?1:0)+(p.y>=60?2:0)], mix=scenario==='crossfade'?100/255:0, alpha=transparent?128/255:1;
            const outAlpha=mix+alpha*(1-mix),expected=[...color.map(v=>(v*alpha*(1-mix)+20*mix)/outAlpha),outAlpha*255];
            const actual=[...pixels.slice((y*160+x)*4,(y*160+x)*4+4)];
            check(actual.every((v,i)=>Math.abs(v-expected[i])<4),`${scenario}/${transparent}/${label} (${x},${y}) ${actual} != ${expected}`);
          }
          if(!transparent && label==='GPU'){const box=document.createElement('section');box.textContent=scenario;box.append(copy);document.body.append(box);}
        };
        try {
          gpu.render(options);await gpu.device.queue.onSubmittedWorkDone();inspect(gpu.canvas,'GPU');
          canvas.render(options);inspect(canvas.canvas,'Canvas');
          const exported=document.createElement('canvas');exported.width=160;exported.height=120;
          drawExportScene(exported.getContext('2d'),report,frame,geometry,resources);inspect(exported,'raster export');
          const svg=new Image();svg.src=URL.createObjectURL(new Blob([await exportSVG({...options,resources})],{type:'image/svg+xml'}));await svg.decode();inspect(svg,'SVG');URL.revokeObjectURL(svg.src);
          for(const softwareFrames of [false,true]){
            const packet=await compilePlaybackPacket(report,0,{revision:1,softwareFrames,scale:1,resources:{...resources,preload:async()=>{}}});
            const renderer=softwareFrames?canvas:gpu;renderer.prepareFrame(packet,{report});
            check(renderer.renderPrepared(packet.key,{report,view:{scale:1}}),'prepared render failed');
            if(renderer.device)await renderer.device.queue.onSubmittedWorkDone();inspect(renderer.canvas,softwareFrames?'software playback':'GPU playback');
            for(const entry of packet.compatibility)entry.bitmap?.close();
          }
          rows.push({scenario,transparent,paths:6});
        } finally {gpu.destroy();canvas.destroy();}
      }
    }
    return rows;
  });
  assert.deepEqual(errors, []);
  await page.screenshot({path:`${output}/pixels.png`,fullPage:true});
  await writeFile(`${output}/report.json`,JSON.stringify(result,null,2));
  console.log(`${result.length*6} rendered checks passed`);
} finally {await browser.close();}

