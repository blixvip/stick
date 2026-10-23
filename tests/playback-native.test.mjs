import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {emptyDocument} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';
import {materializeNativeFrames} from '../src/import-wire.mjs';
import {documentChunks, applyDocumentChunk} from '../src/document-transport.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {createPlaybackWorkerEndpoint} from '../src/playback-worker.mjs';
import {nativePlaybackSnapshot, nativePlaybackChunks, materializePlaybackSnapshot,
  MAX_NATIVE_PLAYBACK_BYTES, NATIVE_PLAYBACK_CHUNK_BYTES} from '../src/playback-native.mjs';

async function fixture(count=3, prefix=17, layerTimeline=true) {
  const buffer=new ArrayBuffer(prefix+4+count*8),view=new DataView(buffer,prefix);
  view.setUint32(0,count,true);
  for(let index=0;index<count;index++){view.setUint16(4+index*8,1,true);view.setUint8(11+index*8,1);}
  const meta={version:1,sourceOffset:100,byteLength:buffer.byteLength-prefix};
  const document={...emptyDocument(),figure_types:[],keyframes:[]};
  await materializeNativeFrames({document,nativeFrames:meta},buffer,prefix);
  const snapshot=nativePlaybackSnapshot(document,buffer,prefix,meta);
  const editor=new Editor({demo:false,propertyChannels:true,layerTimeline});editor.load(document);
  return {editor,report:editor.report,snapshot,buffer,meta,prefix};
}

const mirrorHeader=report=>{
  let mirror;
  for(const chunk of documentChunks({...report,keyframes:report.keyframes.map(frame=>({_styk:frame._styk}))},{sharedFigures:true}))
    mirror=applyDocumentChunk(mirror,structuredClone(chunk));
  return mirror;
};
const nodeWorkerFactory=()=>{
  const worker=new Worker(new URL('./playback-node-worker.mjs',import.meta.url));
  return {postMessage:message=>worker.postMessage(message),terminate:()=>worker.terminate(),
    addEventListener:(name,callback)=>worker.on(name,value=>callback(name==='message'?{data:value}:value))};
};

test('native snapshot bounds source retention and excludes the zero-frame normalization',async()=>{
  const {report,buffer,prefix,meta}=await fixture();
  assert.ok(nativePlaybackSnapshot(report,buffer,prefix,meta));
  assert.equal(nativePlaybackSnapshot(report,buffer,prefix,{...meta,byteLength:1}),null);
  assert.equal(nativePlaybackSnapshot(report,new ArrayBuffer(MAX_NATIVE_PLAYBACK_BYTES+1),0,meta),null);
  const empty=await fixture(0);assert.equal(empty.snapshot,null);assert.equal(empty.report.keyframes.length,1);
});

test('native chunks exclude the header, bound copies and preserve frame metadata and values',async()=>{
  const {snapshot}=await fixture();
  snapshot.buffer=new ArrayBuffer(NATIVE_PLAYBACK_CHUNK_BYTES+123+snapshot.offset);
  snapshot.meta.byteLength=snapshot.buffer.byteLength-snapshot.offset;
  new Uint8Array(snapshot.buffer).fill(37);
  const chunks=[...nativePlaybackChunks(snapshot)];
  assert.ok(chunks.length>1);assert.ok(chunks.every(chunk=>chunk.buffer.byteLength<=NATIVE_PLAYBACK_CHUNK_BYTES));
  const bytes=new Uint8Array(snapshot.meta.byteLength);
  for(const chunk of chunks)bytes.set(new Uint8Array(chunk.buffer),chunk.position);
  assert.deepEqual(bytes,new Uint8Array(snapshot.buffer,snapshot.offset));
  // Materialization parity uses a smaller valid editor document below. The
  // chunk bound itself does not depend on scene validation or allocation size.
});

test('native reconstruction keeps exact editor frame identities and canonical values',async()=>{
  const {report,snapshot}=await fixture();
  const mirror=mirrorHeader(report),bytes=new Uint8Array(snapshot.buffer.slice(snapshot.offset));
  await materializePlaybackSnapshot(mirror,{bytes,meta:snapshot.meta,position:bytes.length});
  assert.deepEqual(mirror,report);assert.equal(JSON.stringify(mirror),JSON.stringify(report));
  const old=mirror.keyframes;
  await assert.rejects(materializePlaybackSnapshot(mirror,{bytes,meta:snapshot.meta,position:1}),/Incomplete/);
  assert.equal(mirror.keyframes,old);
});

test('real worker handoff is one-use and an edited reload uses the ordinary document',async t=>{
  const {report,snapshot,editor}=await fixture(3,17,false);
  const cache=new PlaybackCache({workerFactory:nodeWorkerFactory,maxBytes:256*1024*1024});t.after(()=>cache.dispose());
  assert.equal(cache.stageNativeSnapshot(report,snapshot,{revision:editor.revision,isCurrent:()=>true}),true);
  cache.load(report,{revision:editor.revision});await cache.prepareRange([0]);
  assert.equal(cache.stats.loadTransport,'native-frames');assert.equal(cache.stats.nativeTransferBytes,snapshot.meta.byteLength);
  assert.equal(cache._nativeSnapshot,null);assert.equal(cache.stats.nativeSourceBytes,0);
  editor.setFramesDuration([0],2);
  cache.load(report,{revision:editor.revision});await cache.prepareRange([0,1]);
  assert.equal(cache.stats.loadTransport,'document');assert.equal(cache.totalTicks,4);
  editor.undo();cache.load(editor.report,{revision:editor.revision});await cache.prepareRange([0]);
  assert.equal(cache.totalTicks,3);assert.equal(cache.stats.loadTransport,'document');
});

for(const reason of ['revision','draft','frames','budget','dispose'])test(`native staging rejects ${reason} changes`,async t=>{
  const {report,snapshot,editor}=await fixture();let current=true;
  const cache=new PlaybackCache({workerFactory:nodeWorkerFactory,maxBytes:reason==='budget'?1:256*1024*1024});t.after(()=>cache.dispose());
  if(reason==='dispose')cache.dispose();
  const accepted=cache.stageNativeSnapshot(report,snapshot,{revision:editor.revision,isCurrent:()=>current});
  if(reason==='budget'||reason==='dispose'){assert.equal(accepted,false);return;}
  assert.equal(accepted,true);
  if(reason==='draft')current=false;
  if(reason==='frames')report.keyframes=[...report.keyframes];
  cache.load(report,{revision:editor.revision+(reason==='revision'?1:0)});await cache.prepareRange([0]);
  assert.equal(cache.stats.loadTransport,'document');assert.equal(cache.stats.nativeSourceBytes,0);
});

test('a controller replacement during native transfer rejects old work and loads the new document',async t=>{
  const {report,snapshot,editor}=await fixture();let cache,replaced=false;
  const replacement=emptyDocument();
  const workerFactory=()=>{
    const worker=nodeWorkerFactory(),post=worker.postMessage;
    worker.postMessage=message=>{
      post(message);
      if(message.type==='load-native-chunk'&&!replaced){
        replaced=true;queueMicrotask(()=>cache.load(replacement,{revision:editor.revision+1}));
      }
    };
    return worker;
  };
  cache=new PlaybackCache({workerFactory,maxBytes:256*1024*1024});t.after(()=>cache.dispose());
  cache.stageNativeSnapshot(report,snapshot,{revision:editor.revision,isCurrent:()=>true});
  cache.load(report,{revision:editor.revision});
  await assert.rejects(cache.prepareRange([0]),{name:'AbortError'});
  await cache.prepareRange([0]);
  assert.equal(cache.report,replacement);assert.equal(cache.stats.loadTransport,'document');
  assert.equal(cache.stats.nativeSourceBytes,0);assert.equal(cache.pending.size,0);
});

test('disposing during native transfer rejects waiters and clears byte ownership',async()=>{
  const {report,snapshot,editor}=await fixture();let cache;
  const workerFactory=()=>{
    const worker=nodeWorkerFactory(),post=worker.postMessage;
    worker.postMessage=message=>{
      post(message);
      if(message.type==='load-native-chunk')queueMicrotask(()=>cache.dispose());
    };
    return worker;
  };
  cache=new PlaybackCache({workerFactory,maxBytes:256*1024*1024});
  try {
    cache.stageNativeSnapshot(report,snapshot,{revision:editor.revision,isCurrent:()=>true});
    cache.load(report,{revision:editor.revision});
    await assert.rejects(cache.prepareRange([0]),{name:'AbortError'});
    assert.equal(cache.stats.nativeSourceBytes,0);assert.equal(cache.stats.nativeStagedBytes,0);
    assert.equal(cache.report,null);assert.equal(cache._nativeSnapshot,null);
  }finally{cache.dispose();}
});

test('worker rejects incomplete/out-of-order/oversized native chunks without publishing',async()=>{
  for(const failure of ['incomplete','order','extent','chunk']){
    const {report,snapshot}=await fixture(),messages=[];
    const receive=createPlaybackWorkerEndpoint(message=>messages.push(message));
    let sequence=0;
    for(const chunk of documentChunks(mirrorHeader(report)))receive({type:'load-chunk',revision:1,sequence:sequence++,chunk,options:{}});
    const chunk=[...nativePlaybackChunks(snapshot)][0];
    if(failure==='order')chunk.position=1;
    if(failure==='extent')chunk.meta={...chunk.meta,byteLength:MAX_NATIVE_PLAYBACK_BYTES+1};
    if(failure==='chunk')chunk.buffer=new ArrayBuffer(NATIVE_PLAYBACK_CHUNK_BYTES+1);
    if(failure==='incomplete')chunk.buffer=chunk.buffer.slice(0,-1);
    receive({type:'load-native-chunk',revision:1,sequence:sequence++,...chunk});
    receive({type:'load-complete',revision:1,sequence});await delay(5);
    assert.ok(messages.some(message=>message.type==='load-error'),failure);
    assert.ok(!messages.some(message=>message.type==='loaded'),failure);
    receive({type:'invalidate',revision:2});
  }
});

for(const replacement of ['invalidate','load','load-chunk'])test(`${replacement} cancels native reconstruction before publication`,async()=>{
  const {report,snapshot}=await fixture(30000),messages=[];
  const receive=createPlaybackWorkerEndpoint(message=>messages.push(message));
  let sequence=0;
  for(const chunk of documentChunks(mirrorHeader(report)))receive({type:'load-chunk',revision:1,sequence:sequence++,chunk,options:{}});
  for(const chunk of nativePlaybackChunks(snapshot))receive({type:'load-native-chunk',revision:1,sequence:sequence++,...chunk});
  receive({type:'load-complete',revision:1,sequence});
  assert.ok(!messages.some(message=>message.type==='loaded'),'large decode must yield before publishing');
  if(replacement==='load')receive({type:'load',revision:2,report:emptyDocument()});
  else if(replacement==='load-chunk'){
    for(const chunk of documentChunks(emptyDocument()))receive({type:'load-chunk',revision:2,chunk,options:{}});
    receive({type:'load-complete',revision:2});
  }else receive({type:'invalidate',revision:2});
  await delay(30);
  assert.ok(!messages.some(message=>message.revision===1&&['loaded','load-error'].includes(message.type)));
  if(replacement!=='invalidate')assert.ok(messages.some(message=>message.revision===2&&message.type==='loaded'));
  receive({type:'invalidate',revision:3});
});
