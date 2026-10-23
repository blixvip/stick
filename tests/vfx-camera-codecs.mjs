// Run vfx-camera-sampling.browser.mjs first to produce the real worker PNG.
import {VideoExportService,MAX_CHUNK_BYTES} from '../desktop/video-export-service.cjs';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const output=path.resolve('artifacts/vfx/camera-sampling'),encoderPath=path.resolve('build/video-encoder/ffmpeg.exe');
const source=path.join(output,'native.png'),bytes=await readFile(source);
const decode=file=>execFileSync(encoderPath,['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,maxBuffer:8*1024*1024});
const reference=decode(source),service=new VideoExportService({encoderPath,tempRoot:path.join(output,'codec-jobs')}),rows=[];
try{
 for(const [format,codec] of [['mp4','h264'],['avi','mpeg4'],['avi','ffv1']]){
  const session=await service.begin({format,codec,width:320,height:240,fps:24,totalFrames:4,quality:1,maxBytes:8*1024*1024});
  for(let index=0;index<4;index++){
   await service.beginFrame(session.token,{index,size:bytes.length});
   for(let start=0;start<bytes.length;start+=MAX_CHUNK_BYTES)await service.writeFrameChunk(session.token,bytes.subarray(start,start+MAX_CHUNK_BYTES));
   await service.endFrame(session.token);
  }
  await service.finish(session.token);const chunks=[];
  for(;;){const part=await service.read(session.token);chunks.push(Buffer.from(part.bytes));if(part.done)break;}
  const file=path.join(output,`shockwave-${codec}.${format}`);await writeFile(file,Buffer.concat(chunks));
  const actual=decode(file);assert.equal(actual.length,reference.length*4);let max=0,sum=0,blackPixels=0;
  for(let i=0;i<actual.length;i++){const difference=Math.abs(actual[i]-reference[i%reference.length]);max=Math.max(max,difference);sum+=difference;}
  for(let i=0;i<actual.length;i+=3)if(Math.max(...actual.subarray(i,i+3))<40&&Math.max(...reference.subarray(i%reference.length,i%reference.length+3))>100)blackPixels++;
  assert.equal(blackPixels,0);assert.ok(sum/actual.length<6);if(codec==='ffv1')assert.equal(max,0);
  rows.push({format,codec,frames:4,max,mean:sum/actual.length,blackPixels});
 }
 await writeFile(path.join(output,'codecs.json'),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));
}finally{await service.dispose();}
