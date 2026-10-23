/** Compare compression speed, size and decoded quality against lossless Akane frames. */
import {spawn} from 'node:child_process';
import {mkdir,writeFile,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
const input=path.resolve('artifacts/export-akane/before-dense'),output=path.resolve('artifacts/export-akane/codecs');
await mkdir(output,{recursive:true});
const ffmpeg=path.resolve('build/video-encoder/ffmpeg.exe');
const run=args=>new Promise((resolve,reject)=>{
  const start=performance.now(),child=spawn(ffmpeg,['-hide_banner','-y',...args],{windowsHide:true});let stderr='';
  child.stdout.resume();child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
  child.on('close',code=>code===0?resolve({ms:performance.now()-start,stderr}):reject(new Error(stderr)));
});
const report=JSON.parse(await readFile(path.join(input,'report.json'),'utf8')),source=report.runs[0],frames=report.ticks.length;
const master=path.join(output,'reference.mkv');
await run(['-threads','1','-f','lavfi','-i',`color=c=black:s=${source.width}x${source.height}:r=16`,
  '-threads','1','-framerate','16','-start_number',String(report.ticks[0]),'-i',path.join(input,'2160-edges-%d.png'),
  '-filter_complex_threads','1','-filter_complex','[0:v][1:v]overlay=shortest=1:format=rgb,format=bgr0',
  '-frames:v',String(frames),'-c:v','ffv1','-threads','2',master]);
const rows=[];
for(const [preset,crf] of [['veryfast',22],['fast',22],['medium',22],['fast',23],['medium',23],['medium',24]]){
  const name=`${preset}-crf${crf}`,file=path.join(output,name+'.mp4');
  const encoded=await run(['-threads','1','-i',master,'-filter_threads','1','-c:v','libx264','-threads','2',
    '-preset',preset,'-tune','zerolatency','-crf',String(crf),'-pix_fmt','yuv420p','-movflags','+faststart',file]);
  const measured=await run(['-threads','1','-i',file,'-threads','1','-i',master,'-filter_complex_threads','1',
    '-lavfi','[0:v]settb=1/16,setpts=N,split[a][b];[1:v]format=yuv420p,settb=1/16,setpts=N,split[c][d];[a][c]ssim;[b][d]psnr','-f','null','-']);
  const row={name,preset,crf,encodeMs:encoded.ms,bytes:(await stat(file)).size,
    ssim:Number(measured.stderr.match(/All:([\d.]+)/)?.[1]),psnr:Number(measured.stderr.match(/average:([\d.]+)/)?.[1])};
  rows.push(row);console.log(JSON.stringify(row));
  await writeFile(path.join(output,'report.json'),JSON.stringify({sourceHash:report.sourceHash,frames,width:source.width,height:source.height,rows},null,2));
}
