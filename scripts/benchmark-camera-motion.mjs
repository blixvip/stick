import {performance} from 'node:perf_hooks';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,defaultFigure,createFrame,createObject} from '../src/demo.mjs';
import {compilePlaybackPacket,PlaybackResources} from '../src/playback-worker.mjs';
import {RetainedGeometryCache} from '../src/playback-geometry-cache.mjs';
import {createCameraMotion,sampleCameraMotion} from '../src/camera-motion.mjs';
import {cameraSamplingReport} from '../src/camera-motion-bake.mjs';

const count=1500,report=emptyDocument(),figure=defaultFigure(1);
report.figure_types=[figure];const pose=createFrame(Array.from({length:count},(_,i)=>createObject(figure,i,i%50*32,Math.floor(i/50)*32)),119);pose._styk={easing:{interpolation:'constant'}};report.keyframes=[pose,{...structuredClone(pose),duration_raw:1}];
const e=new Editor({demo:false,layerTimeline:true}).load(report),far=e.createLayer('Far'),near=e.createLayer('Near');
e.assignFiguresToLayer(Array.from({length:500},(_,i)=>i),far.id);e.assignFiguresToLayer(Array.from({length:500},(_,i)=>i+500),near.id);
e.setCameraValues({x:300,y:200,scale:2});
const summarize=values=>{const sorted=values.toSorted((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1)};};
async function measure(){
  const resources=new PlaybackResources(),geometryCache=new RetainedGeometryCache(),times=[];let minReuse=count,shapes=0,bytes=0;
  try{for(let tick=0;tick<90;tick++){
    const start=performance.now(),packet=await compilePlaybackPacket(e.report,tick,{resources,geometryCache,revision:1});
    if(tick>=10){times.push(performance.now()-start);minReuse=Math.min(minReuse,packet.reusedGeometryObjects);}
    shapes=packet.shapeCount;bytes=Math.max(bytes,packet.byteLength);for(const item of packet.compatibility)item.bitmap?.close();
  }}finally{resources.dispose();geometryCache.clear();}
  assert.equal(minReuse,count);return {...summarize(times),minReusedObjects:minReuse,shapes,maxPacketBytes:bytes};
}
const baseline=await measure();e.setLayerParallax(far.id,{enabled:true,x:.2});e.setLayerParallax(near.id,{enabled:true,x:1.4});
e.addCameraMotion('shake',{duration:120});e.addCameraMotion('impact',{start:30,duration:24});e.addCameraMotion('wobble',{duration:120});
const effects=await measure(),clips=Array.from({length:256},(_,i)=>createCameraMotion('shake',`bench-${i}`,0,120)),times=[];
for(let batch=0;batch<110;batch++){const start=performance.now();for(let n=0;n<100;n++)sampleCameraMotion({clips},n,24);if(batch>=10)times.push((performance.now()-start)/100);}
const sampler256=summarize(times),projectionBytes=Buffer.byteLength(JSON.stringify(cameraSamplingReport(e.report)));
const sha256={};for(const file of ['src/camera-motion.mjs','src/layer-parallax.mjs','src/playback-worker.mjs','src/camera-motion-bake.mjs','src/editor-camera-motion.mjs'])sha256[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const result={date:new Date().toISOString(),runtime:process.version,cpu:os.cpus()[0].model,scene:{figures:count,segmentsPerFigure:figure.segments.length,layers:3,sampledFrames:80},baseline,effects,sampler256,projectionBytes,sha256};
await mkdir('artifacts/camera-motion',{recursive:true});await writeFile('artifacts/camera-motion/performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
