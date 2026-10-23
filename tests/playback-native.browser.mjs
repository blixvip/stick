/** Real browser workers: compare GPU input arrays and raster pixels, not timings. */
import {chromium} from './support/playwright.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';
import {performanceSourceHashes} from '../scripts/performance-source-hashes.mjs';

const root=process.cwd(),sources=process.argv.slice(2);
if(!sources.length)sources.push('../Pivot Animator v5/Animations/tween_camera.piv');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHashes=await performanceSourceHashes(),service=await backend.startBackend({appRoot:root});
const results=[];let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${service.origin}/api/health`);
  await page.setContent('<input id="source" type="file">');
  for(const source of sources){
    const filename=path.resolve(source),before=sha(await readFile(filename));
    await page.locator('#source').setInputFiles(filename);
    const result=await page.evaluate(async()=>{
      const {ImportClient}=await import('/src/import-client.mjs');
      const {Editor}=await import('/src/editor.mjs');
      const {PlaybackCache}=await import('/src/playback.mjs');
      const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      const check=(condition,message)=>{if(!condition)throw new Error(message);};
      const importer=new ImportClient(),rows=[];
      try {
        const imported=await importer.importFile(document.querySelector('#source').files[0]);
        check(imported.playbackFrames,'Choose a native-v5 source within the byte allowance.');
        const editor=new Editor({demo:false,propertyChannels:true,layerTimeline:true});editor.load(imported.document);
        const digest=await hash(new TextEncoder().encode(JSON.stringify(editor.report)));
        for(const storedFrames of [false,true])for(const mode of ['document','native']){
          const cache=new PlaybackCache({workerCount:1,maxBytes:256*1024*1024,maxFrames:4});
          try {
            if(mode==='native')check(cache.stageNativeSnapshot(editor.report,imported.playbackFrames,
              {revision:editor.revision,isCurrent:()=>true}),'Native snapshot was not admitted.');
            cache.load(editor.report,{revision:editor.revision,storedFrames,scale:1});
            const ticks=[...new Set([0,Math.floor(cache.totalTicks/2),cache.totalTicks-1])],packets=[];
            for(const tick of ticks){
              await cache.prepareRange([tick]);const packet=cache.get(tick),textures=[];
              for(const entry of packet.compatibility){
                const {bitmap,vectorRaster,...metadata}=entry;let pixels=null,vector=null;
                if(bitmap){
                  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true});
                  ctx.drawImage(bitmap,0,0);pixels={width:bitmap.width,height:bitmap.height,
                    sha256:await hash(ctx.getImageData(0,0,bitmap.width,bitmap.height).data)};
                }
                if(vectorRaster){const {data,...properties}=vectorRaster;vector={...properties,sha256:await hash(data)};}
                textures.push({metadata,pixels,vector});
              }
              const values={tick,frame:packet.frame,groups:packet.groups,textures,scale:packet.scale,resolution:packet.resolution,
                cameraEnabled:packet.cameraEnabled,background:packet.background};
              packets.push({tick,shapes:await hash(packet.shapes),transforms:await hash(packet.transforms),uids:await hash(packet.uids),
                content:await hash(new TextEncoder().encode(JSON.stringify(values)))});
            }
            check(cache.stats.loadTransport===(mode==='native'?'native-frames':'document'),'Unexpected snapshot transport.');
            check(cache.stats.nativeSourceBytes===0&&cache.stats.nativeStagedBytes===0,'Source bytes survived mirror completion.');
            rows.push({storedFrames,mode,packets});
          }finally{cache.dispose();}
        }
        check(JSON.stringify(rows[0].packets)===JSON.stringify(rows[1].packets),'Advanced packet or raster pixels differ.');
        check(JSON.stringify(rows[2].packets)===JSON.stringify(rows[3].packets),'Stored-frame packet or raster pixels differ.');
        check(await hash(new TextEncoder().encode(JSON.stringify(editor.report)))===digest,'Playback changed the editable document.');
        return {frames:editor.report.keyframes.length,rows,digest};
      }finally{importer.dispose();}
    });
    assert.equal(sha(await readFile(filename)),before);
    results.push({name:path.basename(filename),sha256:before,...result});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(await performanceSourceHashes(),sourceHashes);
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/playback-native-browser.json',JSON.stringify({at:new Date().toISOString(),results,sourceHashes,
    limitation:'Debugger-attached correctness checks; no timing claim. Exact GPU input and raster pixels, not display scanout.'},null,2));
  console.log(JSON.stringify({fixtures:results.length,checks:results.map(row=>({name:row.name,frames:row.frames,ticks:row.rows[0].packets.length}))}));
}finally{await browser?.close();service.stop();}
