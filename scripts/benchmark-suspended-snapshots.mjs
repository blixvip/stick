/** Controller-only retained-heap test; no GPU or worker heap is measured. */
import assert from 'node:assert/strict';
import {setTimeout as delay,setImmediate as turn} from 'node:timers/promises';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {PlaybackCache} from '../src/playback.mjs';
import {createDemo} from '../src/demo.mjs';
assert.ok(globalThis.gc,'Use --expose-gc');
const output=process.argv[2];assert.ok(output,'Provide an unused evidence path');
const sources=['src/playback.mjs','src/document-transport.mjs'];
const hashes=Object.fromEntries(await Promise.all(sources.map(async name=>[name,createHash('sha256').update(await readFile(name)).digest('hex')])));
let receive;
const cache=new PlaybackCache({workerFactory:()=>({
  postMessage({type,revision,sequence}){
    if(type==='load-chunk'||type==='load-complete')
      queueMicrotask(()=>receive({data:{type:type==='load-complete'?'loaded':'load-ack',revision,sequence}}));
  },addEventListener(type,handler){if(type==='message')receive=handler;},terminate(){}
})});
const refs=[],outcomes=[],samples=[];
const sample=async label=>{
  await turn();globalThis.gc();await turn();globalThis.gc();
  return {label,heapUsed:process.memoryUsage().heapUsed,retainedPayloads:refs.filter(ref=>ref.deref()).length,
    settled:outcomes.filter(Boolean).length,interactionActive:cache.interactionActive};
};
const before=await sample('before');
try{
  cache.setInteractionActive(true);
  const replace=async generation=>{
    const document=createDemo();document._styk.retentionProbe=Array.from({length:500000},(_,i)=>generation+i/10000);
    refs.push(new WeakRef(document._styk.retentionProbe));cache.load(document);
    cache._loadPromise.then(()=>outcomes[generation]='loaded',error=>outcomes[generation]=error.name);
    for(let i=0;i<200&&(!cache._interactionPromise||!cache.stats.loadChunks);i++)await delay(5);
    assert.ok(cache._interactionPromise&&cache.stats.loadChunks,'Snapshot did not reach the interaction gate');
  };
  for(let generation=0;generation<12;generation++){
    await replace(generation);
    samples.push(await sample(`replacement-${generation+1}`));
  }
  const suspended=await sample('suspended');
  cache.setInteractionActive(false);await cache._loadPromise;
  const resumed=await sample('resumed');
  assert.equal(outcomes.length,12);assert.ok(outcomes.slice(0,-1).every(value=>value==='AbortError'));assert.equal(outcomes.at(-1),'loaded');
  cache.dispose();const disposed=await sample('disposed');
  for(const name of sources)assert.equal(createHash('sha256').update(await readFile(name)).digest('hex'),hashes[name],'Source changed during measurement');
  const report={config:{replacements:12,numbersPerDocument:500000},node:process.version,hashes,before,samples,suspended,resumed,disposed,outcomes,
    limitations:['Synthetic graph and ACK-only endpoint isolate sender retention; not a desktop/GPU/real-worker memory measurement.',
      'Explicit GC outside measured samples; absolute heaps depend on V8. Weak references are observed only after task turns and collection.',
      'No source document is changed; foreground interaction stays active until the final resume.']};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({suspended,resumed,disposed,retainedGrowthBytes:suspended.heapUsed-before.heapUsed}));
}finally{cache.dispose();}
