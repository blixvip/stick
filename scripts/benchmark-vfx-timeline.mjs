import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {visibleVfxKeys} from '../src/vfx-clip-timeline.mjs';
import {vfxVisibleKeys,setVfxVisibleChannels} from '../src/vfx-key-channels.mjs';

// Twenty effects with two dense channels each: the document's one-million-key
// limit. Compare key visits and projection cost while panning a 1440 px viewport.
const clips=Array.from({length:20},(_,i)=>({id:String(i),keys:{a:Array.from({length:25000},(_,tick)=>({tick})),b:Array.from({length:25000},(_,tick)=>({tick}))}}));
const editor={_documentToken:{},_emit(){}};
for(const clip of clips)setVfxVisibleChannels(editor,clip,['a']);
function naive(keys,first,last,step){const stride=Math.max(1,Math.ceil(8/step)),begin=Math.max(0,Math.floor(first/stride)*stride),buckets=new Map();for(const channel of Object.values(keys))for(const {tick} of channel){if(tick<begin||tick>Math.ceil(last))continue;const bucket=Math.floor(tick/stride),previous=buckets.get(bucket);if(previous===undefined||tick<previous)buckets.set(bucket,tick);}return [...buckets.values()].sort((a,b)=>a-b);}
for(const step of [1,4,14]){
 const keys=clips[0].keys,first=1234,last=1234+1440/step;
 assert.deepEqual(visibleVfxKeys(keys,first,last,step),naive(keys,first,last,step));
 assert.deepEqual(visibleVfxKeys(vfxVisibleKeys(editor,clips[0]),first,last,step),naive({a:keys.a},first,last,step));
}
const run=fn=>{const samples=[];let markers=0;for(let frame=0;frame<70;frame++){const first=1000+frame*7,step=[1,4,14][frame%3],begin=performance.now();for(const clip of clips)markers+=fn(clip,first,first+1440/step,step).length;if(frame>=10)samples.push(performance.now()-begin);}samples.sort((a,b)=>a-b);return {medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.floor(samples.length*.95)],markers};};
const result={effects:20,channels:40,keys:1000000,viewportPixels:1440,samples:60,fullScan:run((clip,...args)=>naive(clip.keys,...args)),viewportProjection:run((clip,...args)=>visibleVfxKeys(clip.keys,...args)),filteredProjection:{visibleChannels:20,...run((clip,...args)=>visibleVfxKeys(vfxVisibleKeys(editor,clip),...args))}};
assert.equal(result.fullScan.markers,result.viewportProjection.markers);
assert.equal(result.viewportProjection.markers,result.filteredProjection.markers);
await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/timeline-performance.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
