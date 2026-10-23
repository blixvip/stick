/** Representative worst-supported overlap, chunk-size and edit-history checks. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pcmWave,inspectWave,mixAudio} from '../src/audio-pcm.mjs';
import {Editor} from '../src/editor.mjs';
import {audioState} from '../src/audio-model.mjs';
const samples=Float32Array.from({length:48000*8},(_,i)=>Math.sin(i*.037)*.2),blob=pcmWave([samples]),source=await inspectWave(blob);
const sources=new Map([['sound',source]]),clips=Array.from({length:32},(_,i)=>({assetId:'sound',start:0,offset:i*.01,duration:4,gain:.025,fadeIn:.1,fadeOut:.2}));
const times=[];let peakBytes=0;
for(let chunk=0;chunk<16;chunk++){const start=performance.now(),pcm=await mixAudio(clips,sources,chunk*12000,12000);times.push(performance.now()-start);peakBytes=Math.max(peakBytes,pcm.byteLength);}
const editor=new Editor({layerTimeline:true}),encoded=Buffer.alloc(192*1024,0x55).toString('base64'),asset={id:'large-audio',name:'Large recording.wav',size:192*1024*120,duration:60,chunks:Array.from({length:120},()=>({data_base64:encoded})),peaks:Array(4096).fill(.3)};
editor.importAudio(asset,{start:0});const id=audioState(editor.report).tracks[0].clips[0].id,editTimes=[];
for(let i=0;i<100;i++){const start=performance.now();editor.setAudioClip(id,{start:i/24,gain:.5+(i%5)*.1});editTimes.push(performance.now()-start);}
const report={voices:32,mixChunkFrames:12000,mixChunkMs:250,maxOutputBytes:peakBytes,mixMaxMs:Math.max(...times),mixMedianMs:[...times].sort((a,b)=>a-b)[8],assetBytes:asset.size,edits:100,editMaxMs:Math.max(...editTimes),editMedianMs:[...editTimes].sort((a,b)=>a-b)[50],largestMetadataCommand:Math.max(...editor._undo.map(command=>command.bytes)),retainedCommands:editor._undo.length};
assert.equal(peakBytes,96000);assert.ok(report.mixMaxMs<250,JSON.stringify(report));assert.ok(report.editMaxMs<50,JSON.stringify(report));assert.ok(report.largestMetadataCommand<10000,JSON.stringify(report));
const output=process.env.STYK_BENCH_OUT||'artifacts/audio';
await mkdir(output,{recursive:true});await writeFile(`${output}/benchmark.json`,JSON.stringify(report,null,2));console.log(report);
