import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewImages} from '../src/preview-images.mjs';

const item = url => ({type: 'image', asset: {url}});
const bitmap = () => ({width: 4, height: 2, closed: 0, close() {this.closed++;}});
function setup(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker'), workers = [];
  globalThis.Worker = class {
    constructor() {this.messages = []; workers.push(this);}
    postMessage(message) {this.messages.push(message);}
    terminate() {this.terminated = true;}
  };
  const images = new PreviewImages();
  t.after(() => {images.clear(); if (previous) Object.defineProperty(globalThis, 'Worker', previous); else delete globalThis.Worker;});
  return {images, workers};
}

test('a queued old-worker response cannot replace the next document or leak its bitmap', async t => {
  const {images, workers} = setup(t), first = images.prepare([item('a')]);
  const rejected = assert.rejects(first, {name: 'AbortError'}), old = workers[0];
  images.clear(); await rejected;
  const next = images.prepare([item('b')]), obsolete = bitmap();
  old.onmessage({data: {id: old.messages[0].id, images: [{url: 'a', bitmap: obsolete, width: 8192, height: 4096}]}});
  assert.equal(obsolete.closed, 1); assert.equal(images.size, 0);
  const valid = bitmap(), current = workers[1];
  current.onmessage({data: {id: current.messages[0].id, images: [{url: 'b', bitmap: valid, width: 8192, height: 4096}]}});
  await next; assert.equal(images.get('b'), valid); assert.equal(valid.naturalWidth, 8192); assert.equal(images.bytes, 32);
});

test('image preparation diagnostics retain only the latest response and clear with its owner', async t => {
  const {images, workers} = setup(t), first = images.prepare([item('a')]), worker = workers[0];
  const timings = {moduleReadyMs: 20, preloadMs: 3, bitmapCopyMs: 1, images: 1, decodedBytes: 32};
  worker.onmessage({data: {id: worker.messages[0].id, images: [{url: 'a', bitmap: bitmap(), width: 4, height: 2}], timings}});
  await first;
  assert.equal(images.lastPreparation.preloadMs, 3);
  assert.ok(images.lastPreparation.roundTripMs >= 0);
  images.clear();
  worker.onmessage({data: {id: worker.messages[0].id, images: [], timings}});
  assert.equal(images.lastPreparation, null, 'an obsolete worker cannot republish diagnostics');
});

test('lazy background decode waits for its own pixels across coalesced requests', async t => {
  const {images,workers}=setup(t),a=images.image('a'),b=images.image('b'),worker=workers[0];
  let aReady=false,bReady=false;
  const first=a.decode().then(()=>{aReady=true;}),second=b.decode().then(()=>{bReady=true;});
  // Supersede the queued viewport request while both background URLs are needed.
  const viewport=images.prepare([item('c')]);
  assert.equal(images.image('b'),b,'pending identity survives repeated consumers');
  worker.onmessage({data:{id:worker.messages[0].id,images:[{url:'a',bitmap:bitmap(),width:4,height:2}]}});
  await first;assert.equal(aReady,true);assert.equal(bReady,false);
  assert.equal(images.image('b'),b,'earlier response must not erase a later pending image');
  const next=worker.messages[1];assert.deepEqual(new Set(next.items.map(i=>i.asset.url)),new Set(['a','b','c']));
  worker.onmessage({data:{id:next.id,images:['a','b','c'].map(url=>({url,bitmap:bitmap(),width:4,height:2}))}});
  await Promise.all([second,viewport]);assert.equal(bReady,true);assert.equal(images.pendingImages.size,0);
});

test('clearing or failing the decoder rejects lazy background waits', async t => {
  const {images,workers}=setup(t),pending=images.image('a');
  const cancelled=assert.rejects(pending.decode(),{name:'AbortError'});images.clear();await cancelled;
  const next=images.image('b'),failure=assert.rejects(next.decode(),/invalid image/),worker=workers.at(-1);
  worker.onmessage({data:{id:worker.messages[0].id,error:'invalid image'}});
  await failure;assert.equal(images.has('b'),false);assert.equal(images.pendingImages.size,0);
});

test('lazy background lookahead decodes missing URLs and retains a bounded recent set', async t => {
  const {images,workers}=setup(t);images.maxBytes=128;
  const complete=async url=>{
    const pending=images.image(url),worker=workers[0],request=worker.messages.at(-1),pixels=bitmap();
    assert.deepEqual(request.items.map(i=>i.asset.url),[url],'visited backgrounds must not be sent for decoding again');
    worker.onmessage({data:{id:request.id,images:[{url,bitmap:pixels,width:4,height:2}]}});
    await pending.decode();return pixels;
  };
  const a=await complete('a'),b=await complete('b');assert.equal(images.bytes,64);
  assert.equal(images.image('a'),a,'a cache hit refreshes recency without a new request');
  const c=await complete('c');assert.equal(images.bytes,64);assert.equal(b.closed,1);
  assert.equal(images.get('a'),a);assert.equal(images.get('c'),c);assert.equal(images.has('b'),false);
  const viewport=images.prepare([item('d')]),worker=workers[0];
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'d',bitmap:bitmap(),width:4,height:2}]}});
  await viewport;assert.equal(a.closed,1);assert.equal(c.closed,1);assert.equal(images.size,1);
});

test('managed invalidation distinguishes new background pixels from resized artwork', async t => {
  const {images,workers}=setup(t),notifications=[];images.managedInvalidation=true;images.onReady=info=>notifications.push(info);
  const a=images.image('a'),worker=workers[0];let loads=0;a.addEventListener('load',()=>loads++);
  assert.equal(a.previewInvalidationManaged,true);
  worker.onmessage({data:{id:worker.messages[0].id,images:[{url:'a',bitmap:bitmap(),width:4,height:2}]}});
  await a.decode();assert.equal(loads,1);assert.deepEqual(notifications,[{retained:true,resized:false,changedURLs:['a']}]);
  const viewport=images.prepare([item('a')],{scale:2}),larger={...bitmap(),width:8,height:4};
  worker.onmessage({data:{id:worker.messages[1].id,images:[{url:'a',bitmap:larger,width:4,height:2}]}});
  await viewport;assert.deepEqual(notifications.at(-1),{retained:false,resized:true,changedURLs:['a']});
});

test('upcoming image priority prevents past-frame LRU hits from evicting the next background', async t => {
  const {images,workers}=setup(t);images.maxBytes=128;
  const complete=async url=>{
    const pending=images.image(url),worker=workers[0],pixels=bitmap();
    worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url,bitmap:pixels,width:4,height:2}]}});
    await pending.decode();return pixels;
  };
  const next=await complete('next'),past=await complete('past');
  images.image('past');images.priorityURLs=()=>['next'];
  const future=await complete('future');assert.equal(images.get('next'),next);assert.equal(past.closed,1);
  assert.equal(images.bytes,64);assert.equal(images.get('future'),future);
  images.priorityURLs=()=>['next','future'];await complete('more');
  assert.equal(images.bytes,64,'even an infeasible priority set cannot expand the retention budget');
});

test('rapid viewport requests coalesce and replaced copies release their pixels', async t => {
  const {images, workers} = setup(t), first = images.prepare([item('a')]), middle = images.prepare([item('b')]), latest = images.prepare([item('c')]);
  await middle; const worker = workers[0]; assert.equal(worker.messages.length, 1);
  const a = bitmap(); worker.onmessage({data: {id: worker.messages[0].id, images: [{url: 'a', bitmap: a, width: 4, height: 2}]}});
  await first; assert.equal(worker.messages.length, 2); assert.equal(worker.messages[1].items[0].asset.url, 'c');
  const c = bitmap(); worker.onmessage({data: {id: worker.messages[1].id, images: [{url: 'c', bitmap: c, width: 4, height: 2}]}});
  await latest; assert.equal(a.closed, 1); assert.equal(images.size, 1); assert.equal(images.bytes, 32);
  images.clear(); assert.equal(c.closed, 1); assert.equal(images.bytes, 0);
});

test('an idle decoder worker releases and respawns with the decoded map intact', async t => {
  const {images, workers} = setup(t); images.idleMs = 10;
  const first = images.prepare([item('a')]), worker = workers[0], a = bitmap();
  worker.onmessage({data: {id: worker.messages[0].id, images: [{url: 'a', bitmap: a, width: 4, height: 2}]}});
  await first;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(worker.terminated, true); assert.equal(images.worker, null);
  assert.equal(images.get('a'), a, 'decoded bitmaps survive the worker release');
  const second = images.prepare([item('a'), item('b')]);
  assert.equal(workers.length, 2, 'a fresh worker is spawned for new work');
  const b = bitmap();
  workers[1].onmessage({data: {id: workers[1].messages[0].id, images: [{url: 'a', bitmap: a}, {url: 'b', bitmap: b, width: 4, height: 2}]}});
  await second; assert.equal(images.get('b'), b);
});

test('the same decoded variant preserves its consumer identity and closes the redundant copy', async t => {
  const {images,workers}=setup(t),notifications=[];images.onReady=value=>notifications.push(value);
  const first=images.prepare([item('a')]),original=bitmap(),worker=workers[0];
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:original,width:4,height:2,variant:1}]}});
  await first;
  const next=images.prepare([item('a'),item('a')]),copy=bitmap();
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:copy,width:4,height:2,variant:1}]}});
  await next;
  assert.equal(images.get('a'),original);assert.equal(original.closed,0);assert.equal(copy.closed,1);
  assert.deepEqual(notifications.at(-1),{retained:false,resized:false,changedURLs:[],unchanged:true});
  assert.equal(images.bytes,32);images.clear();assert.equal(original.closed,1);assert.equal(copy.closed,1);
});

test('variant identity is not a dimensions-only substitute for fresh pixels or crop metadata', async t => {
  const {images,workers}=setup(t),notifications=[];images.onReady=value=>notifications.push(value);
  const cases=[{variant:1},{variant:2},{variant:2,srcX:1,srcY:0,srcW:3,srcH:2},
    {variant:2,width:8},{},{variant:0},{variant:1.5}];
  let previous;
  for(const [index,fields] of cases.entries()){
    const pending=images.prepare([item('a')],{scale:index+1}),worker=workers[0],pixels=bitmap();
    worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:pixels,width:4,height:2,...fields}]}});
    await pending;assert.equal(images.get('a'),pixels);assert.notEqual(notifications.at(-1).unchanged,true);
    if(previous)assert.equal(previous.closed,1);previous=pixels;
  }
});

test('removed URLs and externally replaced images cannot claim an unchanged batch', async t => {
  const {images,workers}=setup(t),notifications=[];images.onReady=value=>notifications.push(value);
  let pending=images.prepare([item('a'),item('b')]);const worker=workers[0],a=bitmap(),b=bitmap();
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:a,width:4,height:2,variant:1},{url:'b',bitmap:b,width:4,height:2,variant:2}]}});
  await pending;
  pending=images.prepare([item('a')]);const duplicate=bitmap();
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:duplicate,width:4,height:2,variant:1}]}});
  await pending;assert.equal(images.get('a'),a);assert.equal(duplicate.closed,1);assert.equal(b.closed,1);
  assert.notEqual(notifications.at(-1).unchanged,true,'eviction still invalidates consumers');
  const external={...bitmap(),complete:true,naturalWidth:4,naturalHeight:2};images.set('a',external);
  pending=images.prepare([item('a')],{scale:2});const decoded=bitmap();
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:decoded,width:4,height:2,variant:1}]}});
  await pending;assert.equal(external.closed,1);assert.equal(images.get('a'),decoded);assert.notEqual(notifications.at(-1).unchanged,true);
});

test('variant numbers from a released worker cannot match the next worker', async t => {
  const {images,workers}=setup(t),notifications=[];images.onReady=value=>notifications.push(value);images.idleMs=10;
  let pending=images.prepare([item('a')]);const old=workers[0],a=bitmap();
  old.onmessage({data:{id:old.messages.at(-1).id,images:[{url:'a',bitmap:a,width:4,height:2,variant:1}]}});await pending;
  await new Promise(resolve=>setTimeout(resolve,60));assert.equal(images.worker,null);
  pending=images.prepare([item('a')],{scale:2});const fresh=workers[1],b=bitmap();
  fresh.onmessage({data:{id:fresh.messages.at(-1).id,images:[{url:'a',bitmap:b,width:4,height:2,variant:1}]}});await pending;
  assert.equal(images.get('a'),b);assert.equal(a.closed,1);assert.notEqual(notifications.at(-1).unchanged,true);
  const stale=bitmap();old.onmessage({data:{id:old.messages.at(-1).id,images:[{url:'a',bitmap:stale,width:4,height:2,variant:1}]}});
  assert.equal(stale.closed,1);assert.equal(images.get('a'),b);
});

test('a mixed image batch identifies changed and removed URLs without invalidating identical pixels', async t => {
  const {images,workers}=setup(t),notifications=[];images.onReady=info=>notifications.push(info);
  let pending=images.prepare(['a','b','removed'].map(item));const worker=workers[0];
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:['a','b','removed'].map((url,index)=>({url,bitmap:bitmap(),width:4,height:2,variant:index+1}))}});
  await pending;const originalA=images.get('a');
  pending=images.prepare(['a','b'].map(item));
  worker.onmessage({data:{id:worker.messages.at(-1).id,images:[{url:'a',bitmap:bitmap(),width:4,height:2,variant:1},{url:'b',bitmap:bitmap(),width:4,height:2,variant:4}]}});
  await pending;assert.equal(images.get('a'),originalA);
  assert.deepEqual(new Set(notifications.at(-1).changedURLs),new Set(['removed','b']));
});
