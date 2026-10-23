import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreparedFrameCache, combinePreparedCommands } from '../src/prepared-frames.mjs';
import { SHAPE, shapeRecord, textureBucket } from '../src/renderer-geometry.mjs';

globalThis.GPUBufferUsage = { STORAGE: 128, COPY_DST: 8 };
globalThis.GPUTextureUsage={TEXTURE_BINDING:4,COPY_DST:2,RENDER_ATTACHMENT:16};
const report = { canvas_width: 640, canvas_height: 480 };
const packet = (key, revision = 1) => ({ key, revision, frame: {}, shapes: new Float32Array(shapeRecord({ a: [0, 0, 10, 10], b: [0, 0, 3, 0], transform: 1 })), transforms: new Float32Array([0, 0, 1, 1, 20, 30, 1, 1]), uids: new Uint32Array([0, 7]), groups: [{ firstInstance: 0, instanceCount: 1, transformIndex: 1, uid: 7 }], compatibility: [], objectCount: 1, compileMs: 2 });
function fakeRenderer() {
  const buffers = [], writes = [];
  const pass = {setPipeline() {}, setBindGroup() {}, draw() {}, end() {}};
  return { generation: 0, uniform: {}, globalLayout: {}, dpr: 1, buffers, writes, stats: {}, width: 640, height: 480,
    msaa: {createView() {}}, context: {getCurrentTexture() {return {createView() {}};}},
    device: { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 },
      createCommandEncoder() {return {beginRenderPass() {return pass;}, finish() {return {};}};},
      createBuffer(spec) { const buffer = { ...spec, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; },
      createBindGroup(spec) { return spec; }, queue: { writeBuffer(...args) { writes.push(args); }, submit() {} } },
    backgroundsReady: () => true,
    background: () => [{ data: new Float32Array(shapeRecord({ mode: SHAPE.RECT })), texture: null }],
  };
}
test('prepared draw commands retain painter order and merge adjacent vector ranges', () => {
  const texture = { bindGroup: {} }, backgrounds = [{ data: new Float32Array(24), texture: null }];
  const { commands, backgroundCount } = combinePreparedCommands(backgrounds, [{ firstInstance: 0, instanceCount: 2 }, { firstInstance: 2, instanceCount: 1, compatibilityIndex: 0 }, { firstInstance: 3, instanceCount: 4 }, { firstInstance: 7, instanceCount: 2 }], [texture]);
  assert.equal(backgroundCount, 1); assert.deepEqual(commands.map(c => [c.firstInstance, c.instanceCount, Boolean(c.texture)]), [[0, 3, false], [3, 1, true], [4, 6, false]]);
});

test('prepared camera mode defaults to the packet and guards inconsistent cropped views', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer), neutral = packet('1:0');
  neutral.cameraEnabled = false; neutral.frame.camera = {x: 100, y: 50, scale: .5, angle_rad: .4};
  let backgroundMode; renderer.background = options => {backgroundMode = options.cameraEnabled; return [];};
  assert.equal(cache.prepare(neutral, {report}), '1:0'); assert.equal(backgroundMode, false);
  assert.equal(cache.render('1:0', {report, view: {scale: 2, x: 3, y: 4}}), true);
  const uniform = renderer.writes.findLast(([buffer]) => buffer === renderer.uniform)[2];
  assert.deepEqual([...uniform.slice(0, 7)], [2, 0, 3, 2, 0, 2, 4]);
  assert.throws(() => cache.prepare(neutral, {report, cameraEnabled: true}), /camera mode/);
  assert.throws(() => cache.render('1:0', {report, cameraEnabled: true}), /camera mode/);
  cache.prepare({...neutral, cameraEnabled: true}, {report});
  assert.equal(cache.frames.get('1:0').cameraEnabled, true);
  assert.throws(() => cache.prepare({...neutral, key: '1:1', cameraEnabled: 'false'}, {report}), /boolean/);
  const legacy = packet('1:2'); cache.prepare(legacy, {report});
  assert.equal(cache.frames.get('1:2').cameraEnabled, true);
});

test('prepared visibility accepts a stable membership provider without a size field', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer), hidden = new Set([7]);
  cache.prepare(packet('1:0'), {report}); const frame = cache.frames.get('1:0');
  const visibility = {has: uid => hidden.has(uid)};
  cache.render('1:0', {report, hiddenUids: visibility});
  assert.equal(frame.liveTransforms[7], 0);
  hidden.clear(); cache.render('1:0', {report, hiddenUids: visibility});
  assert.equal(frame.liveTransforms[7], 1);
  hidden.add(7); cache.render('1:0', {report, hiddenUids: visibility});
  cache.render('1:0', {report}); assert.equal(frame.transformed, false);
  assert.equal(renderer.writes.findLast(([buffer]) => buffer === frame.transformBuffer)[2][7], 1);
});
test('default GPU packet budget matches the worker 128 MiB frame contract', () => {
  const cache = new PreparedFrameCache(fakeRenderer());
  assert.equal(cache.maxBytes, 128 * 1024 * 1024); assert.equal(cache.maxFrames, 120);
});
test('GPU frame LRU releases evicted buffers and never reuploads a cache hit', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer, { maxFrames: 2, maxBytes: 1024 });
  cache.prepare(packet('1:0'), { report }); cache.prepare(packet('1:1'), { report }); const writes = renderer.writes.length;
  cache.prepare(packet('1:0'), { report }); assert.equal(renderer.writes.length, writes);
  cache.prepare(packet('1:2'), { report }); assert.equal(cache.has('1:1'), false); assert.equal(cache.has('1:0'), true);
  assert.ok(renderer.buffers[2].destroyed && renderer.buffers[3].destroyed); assert.equal(cache.stats.evictions, 1);
  assert.ok(cache.bytes <= cache.maxBytes); cache.clear(); assert.equal(cache.bytes, 0); assert.ok(renderer.buffers.every(buffer => buffer.destroyed));
});
test('resource loading and document revisions invalidate stale prepared frames', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer);
  cache.prepare(packet('1:0'), { report }); renderer.generation++; assert.equal(cache.has('1:0'), false);
  cache.prepare(packet('1:0'), { report }); assert.equal(cache.has('1:0'), true);
  cache.prepare(packet('2:0', 2), { report }); assert.equal(cache.has('1:0'), false); assert.equal(cache.stats.frames, 1);
  renderer.backgroundsReady = () => false; assert.equal(cache.prepare(packet('2:1', 2), { report }), null); assert.equal(cache.has('2:1'), false);
});
test('a single frame larger than the GPU budget is rejected before buffer allocation', () => {
  const renderer = fakeRenderer(), cache = new PreparedFrameCache(renderer, { maxBytes: 100 });
  assert.throws(() => cache.prepare(packet('1:0'), { report }), /budget/); assert.equal(renderer.buffers.length, 0); assert.equal(cache.bytes, 0);
  const imagePacket = packet('1:1'); imagePacket.compatibility = [{bitmap: {width: 1000, height: 1000}}];
  let allocatedTexture = false; renderer.device.createTexture = () => { allocatedTexture = true; };
  assert.throws(() => cache.prepare(imagePacket, { report }), /budget/); assert.equal(allocatedTexture, false, 'oversized image packets must be rejected before transient GPU allocation');
});

function textureRenderer(){
  const renderer=fakeRenderer();renderer.textures=[];renderer.copies=[];
  renderer.textureBindGroup=texture=>({texture});
  renderer.device.createTexture=spec=>{const texture={...spec,destroyed:false,destroy(){this.destroyed=true;}};renderer.textures.push(texture);return texture;};
  renderer.device.queue.copyExternalImageToTexture=(...args)=>renderer.copies.push(args);
  return renderer;
}
const imagePacket=(tick,artworkKey='shared')=>{const p=packet(`1:${tick}`);p.compatibility=[{artworkKey,bitmap:{width:10,height:10}}];p.groups[0].compatibilityIndex=0;return p;};

test('cancelling or failing a banded upload never publishes or retains a partial texture',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:64*1024*1024}),options={report};
  cache.prepare(imagePacket(0),options);const priorBytes=cache.bytes;
  const next=imagePacket(1,'large');next.compatibility[0].bitmap={width:2048,height:2048};
  const warm=cache.beginWarm(next,options,new Set(['1:0']));assert.ok(warm);
  cache.stepWarm(warm,0);const partial=renderer.textures.at(-1);
  assert.equal(cache.has(next.key),false);cache.cancelWarm();
  assert.equal(partial.destroyed,true);assert.equal(cache.bytes,priorBytes);assert.equal(cache.texturePoolBytes,0);
  let copies=0;renderer.device.queue.copyExternalImageToTexture=()=>{if(++copies===2)throw new Error('upload failed');};
  assert.throws(()=>cache.prepare(next,options),/upload failed/);
  assert.equal(renderer.textures.at(-1).destroyed,true);assert.equal(cache.bytes,priorBytes);assert.equal(cache.has(next.key),false);
  cache.clear();assert.ok(renderer.textures.every(t=>t.destroyed));
});

test('raster scratch and free texture retention remain bounded across changing dimensions',()=>{
  const renderer=textureRenderer(),create=renderer.device.createTexture;
  renderer.device.createTexture=spec=>Object.assign(create(spec),{createView(){return {};}});
  renderer.device.limits.maxTextureDimension2D=4096;renderer.isolationSamples=4;renderer.format='bgra8unorm';
  const cache=new PreparedFrameCache(renderer,{maxBytes:2*1024*1024,maxFrames:1});
  for(let tick=0;tick<40;tick++){
    const next=imagePacket(tick,`vector:${tick}`),width=65+tick*4,height=65+tick*3;
    next.compatibility=[{artworkKey:`vector:${tick}`,vectorRaster:{data:new Float32Array(24*2000),width,height},
      root:{x:0,y:0},bounds:{x:0,y:0,width,height},pixelScale:1}];
    cache.prepare(next,{report});
    assert.ok(cache.stats.msaaPoolBytes<=cache.maxMsaaPoolBytes);
    assert.ok(cache.stats.scratchBytes<=cache.maxScratchBytes);
    assert.ok(cache.texturePoolBytes<=cache.maxTexturePoolBytes);
  }
  cache.clear();assert.ok(renderer.textures.every(t=>t.destroyed));assert.ok(renderer.buffers.every(b=>b.destroyed));
  assert.equal(cache.stats.msaaPoolBytes,0);assert.equal(cache.stats.scratchBytes,0);assert.equal(cache.texturePoolBytes,0);
});

test('larger pooled targets cannot consume the protected warm-frame reservation',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:1000000,maxFrames:2});
  const big=imagePacket(0,'big');big.compatibility[0].bitmap={width:256,height:256};
  const shown=imagePacket(1,'shown');shown.compatibility[0].bitmap={width:128,height:128};
  cache.maxTexturePoolBytes=1000000;
  cache.prepare(big,{report});cache.prepare(shown,{report});cache._remove(big.key);
  const future=imagePacket(2,'future');future.compatibility[0].bitmap={width:128,height:128};
  cache.maxBytes=cache.bytes+128*128*4+224;
  const warm=cache.beginWarm(future,{report},new Set([shown.key,future.key]));assert.ok(warm);
  while(!cache.stepWarm(warm,0))assert.ok(cache.has(shown.key));
  assert.ok(cache.has(shown.key));assert.ok(cache.bytes<=cache.maxBytes);cache.clear();
});

test('speculative uploads preserve displayed frames, yield between textures and publish atomically',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:4096,maxFrames:2}),options={report};
  cache.prepare(imagePacket(0,'old'),options);cache.prepare(imagePacket(1,'displayed'),options);
  const future=imagePacket(2,'next');future.compatibility.push({artworkKey:'second',bitmap:{width:10,height:10}});
  const warm=cache.beginWarm(future,options,new Set(['1:1','1:2']));
  assert.ok(warm);assert.equal(cache.has('1:0'),false);assert.equal(cache.has('1:1'),true);
  assert.equal(cache.stepWarm(warm,0),false);assert.equal(cache.has('1:2'),false);
  while(!cache.stepWarm(warm,0))assert.equal(cache.has('1:1'),true);
  assert.equal(cache.has('1:2'),true);assert.equal(renderer.copies.length,4);assert.ok(cache.bytes<=4096);
  cache.clear();assert.ok(renderer.textures.every(texture=>texture.destroyed));assert.equal(cache.bytes,0);
});

test('cancelling or adopting an unfinished upload releases exactly its owned resources',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer),options={report};
  cache.prepare(imagePacket(0),options);const residentBytes=cache.bytes,shared=renderer.textures[0];
  const next=imagePacket(1);next.compatibility.push({artworkKey:'new',bitmap:{width:10,height:10}});
  let warm=cache.beginWarm(next,options,new Set(['1:0']));
  for(let i=0;i<2;i++)assert.equal(cache.stepWarm(warm,0),false);
  cache.cancelWarm();assert.equal(cache.bytes,residentBytes);assert.equal(shared.destroyed,false);assert.equal(renderer.textures[1].destroyed,true);
  warm=cache.beginWarm(next,options,new Set(['1:0']));cache.stepWarm(warm,0);
  assert.equal(cache.prepare(next,options),'1:1');assert.equal(cache.stepWarm(warm),true);assert.equal(cache.warming,null);
  cache.clear();assert.equal(cache.bytes,0);assert.ok(renderer.textures.every(t=>t.destroyed));
});

test('speculative admission cannot evict protected frames or mutate an infeasible cache',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:700,maxFrames:2}),options={report};
  cache.prepare(imagePacket(0),options);const bytes=cache.bytes,count=renderer.textures.length;
  assert.equal(cache.beginWarm(imagePacket(1,'new'),options,new Set(['1:0'])),null);
  assert.equal(cache.bytes,bytes);assert.equal(cache.has('1:0'),true);assert.equal(renderer.textures.length,count);
  assert.equal(cache.beginWarm({...imagePacket(1),revision:2},options,new Set()),null);
  cache.clear();
});

test('resource generation changes cancel staged ownership before resuming or foreground adoption',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer),options={report};
  const first=imagePacket(0),next=imagePacket(1,'next');cache.prepare(first,options);
  let warm=cache.beginWarm(next,options,new Set([first.key]));cache.stepWarm(warm,0);
  renderer.generation++;
  assert.equal(cache.stepWarm(warm,0),true);assert.equal(cache.warming,null);assert.equal(cache.has(next.key),false);
  assert.equal(renderer.textures.at(-1).destroyed,true,'obsolete partial texture released');
  cache.prepare(next,options);assert.equal(cache.has(next.key),true);assert.equal(cache.generation,renderer.generation);
  const last=imagePacket(2,'last');warm=cache.beginWarm(last,options,new Set([next.key]));cache.stepWarm(warm,0);
  const partial=renderer.textures.at(-1);renderer.generation++;
  cache.prepare(last,options);assert.equal(partial.destroyed,true,'foreground does not adopt obsolete generation');
  assert.equal(cache.has(last.key),true);assert.equal(cache.generation,renderer.generation);
  cache.clear();assert.equal(cache.bytes,0);assert.ok(renderer.textures.every(texture=>texture.destroyed));
});

test('isolated vector textures share GPU ownership and warmup cannot evict the first frame',()=>{
  const renderer=textureRenderer(),createTexture=renderer.device.createTexture;
  renderer.device.createTexture=spec=>Object.assign(createTexture(spec),{createView(){return {};}});
  renderer.device.limits.maxTextureDimension2D=4096;renderer.isolationSamples=4;renderer.isolationPipeline={};renderer.format='bgra8unorm';
  const vector=tick=>{const p=imagePacket(tick);p.compatibility=[{artworkKey:'vector:shared',vectorRaster:{data:new Float32Array(shapeRecord({})),width:10,height:10},
    root:{x:20,y:30},bounds:{x:20,y:30,width:10,height:10},pixelScale:1}];return p;};
  const cache=new PreparedFrameCache(renderer,{maxBytes:1024,maxFrames:10});
  cache.prepare(vector(0),{report});assert.equal(renderer.copies.length,0);assert.equal(cache.textures.size,1);
  assert.equal(cache.canWarm(vector(1),{report}),true);cache.prepare(vector(1),{report});
  assert.equal(cache.textures.size,1);assert.equal(renderer.textures.length,2,'one retained raster and one released MSAA scratch');
  assert.equal(renderer.textures[1].destroyed,true);assert.equal(cache.canWarm(vector(2),{report}),false);
  assert.equal(cache.has('1:0'),true);cache.clear();assert.equal(cache.bytes,0);
  assert.ok(renderer.textures.every(t=>t.destroyed));assert.ok(renderer.buffers.every(b=>b.destroyed));
});

test('animated artwork reuses bucketed textures and samples only their used region',()=>{
  assert.deepEqual([64,65,100,317,428,910,1201,4096].map(textureBucket),[64,80,112,320,448,1024,1280,4096]);
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:64*1024*1024,maxFrames:1});
  cache.maxTexturePoolBytes=64*1024*1024;
  // Growing artwork, as in an afterimage trail: every tick has a new exact size.
  for(let tick=0;tick<12;tick++){
    const next=imagePacket(tick,`trail:${tick}`);next.compatibility[0].bitmap={width:300+tick,height:400+2*tick};
    next.shapes=new Float32Array(shapeRecord({a:[0,0,300,400],mode:SHAPE.TEXTURE,transform:1}));
    cache.prepare(next,{report});
    const frame=cache.frames.get(next.key),resource=frame.ownedTextures.find(r=>r.key.endsWith(`trail:${tick}`));
    assert.equal(resource.width,300+tick);assert.ok(resource.poolW>=resource.width&&resource.poolH>=resource.height);
    const record=renderer.writes.findLast(([buffer])=>buffer===frame.shapeBuffer)[2].subarray(0,24);
    assert.equal(record[20],SHAPE.TEXTURE);
    assert.deepEqual([...record.subarray(16,20)].map(v=>+v.toFixed(5)),[(resource.width-.5)/resource.poolW,(resource.height-.5)/resource.poolH,
      resource.width/resource.poolW,resource.height/resource.poolH].map(v=>+Math.fround(v).toFixed(5)));
  }
  assert.equal(renderer.textures.length,1,'a trail of new sizes recycles instead of allocating a texture per tick');
  assert.equal(cache.stats.pooledTextures,11);cache.clear();assert.ok(renderer.textures.every(t=>t.destroyed));
});

test('analytic-coverage isolation rasters skip multisampled scratch',()=>{
  const renderer=textureRenderer(),createTexture=renderer.device.createTexture;
  renderer.device.createTexture=spec=>Object.assign(createTexture(spec),{createView(){return {};}});
  Object.assign(renderer,{isolationSamples:4,isolationPipeline:{},isolationSinglePipeline:{},format:'bgra8unorm'});renderer.device.limits.maxTextureDimension2D=4096;
  const vector=(tick,mode)=>{const p=imagePacket(tick,`vector:${tick}`);p.compatibility=[{artworkKey:`vector:${tick}`,vectorRaster:{data:new Float32Array(shapeRecord({mode})),width:100,height:100},
    root:{x:0,y:0},bounds:{x:0,y:0,width:100,height:100},pixelScale:1}];return p;};
  const cache=new PreparedFrameCache(renderer,{maxBytes:8*1024*1024,maxFrames:4});
  cache.prepare(vector(0,SHAPE.LINE),{report});cache.prepare(vector(1,SHAPE.CIRCLE),{report});
  assert.equal(renderer.textures.filter(t=>t.sampleCount>1).length,0);
  cache.prepare(vector(2,SHAPE.TRIANGLE),{report});
  assert.equal(renderer.textures.filter(t=>t.sampleCount===4).length,1,'filled triangles keep multisampled edges');
  cache.clear();assert.ok(renderer.textures.every(t=>t.destroyed));
});

function backgroundDescriptor(renderer, cacheKey = 'background-paint:one', bytes = 400) {
  return {cacheKey, bytes, create() {
    const texture = renderer.device.createTexture({label: cacheKey});
    return {texture, bindGroup: renderer.textureBindGroup(texture), bytes};
  }};
}
function setBackgrounds(renderer, descriptors) {
  renderer.background = (options, resolve) => descriptors.map(descriptor => ({
    data: new Float32Array(shapeRecord({mode: SHAPE.TEXTURE})), texture: resolve(descriptor),
  }));
}

test('prepared backgrounds share immutable variants and outlive sibling frame eviction', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer, {maxBytes: 1600, maxFrames: 3});
  const first = backgroundDescriptor(renderer), camera = backgroundDescriptor(renderer, 'background-paint:camera');
  setBackgrounds(renderer, [first]);
  cache.prepare(packet('1:0'), {report}); cache.prepare(packet('1:1'), {report});
  assert.equal(renderer.textures.length, 1); assert.equal(cache.bytes, 848);
  setBackgrounds(renderer, [camera]); cache.prepare(packet('1:2'), {report});
  assert.equal(renderer.textures.length, 2); assert.equal(cache.bytes, 1472);
  assert.equal(renderer.textures[0].destroyed, false); assert.equal(cache.render('1:0', {report}), true);
  const writes = renderer.writes.length;
  cache.prepare(packet('1:0'), {report});
  assert.equal(renderer.writes.length, writes); assert.equal(renderer.textures.length, 2);
  cache.retainPackets(report, [packet('1:0')]);
  assert.equal(renderer.textures[0].destroyed, false); assert.equal(renderer.textures[1].destroyed, true);
  assert.equal(cache.bytes, 624);
  cache.clear(); assert.equal(cache.bytes, 0); assert.equal(cache.textures.size, 0);
  assert.ok(renderer.textures.every(texture => texture.destroyed));
});

test('background blend references are charged and retained once per unique texture', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer, {maxBytes: 720});
  const descriptor = backgroundDescriptor(renderer);
  setBackgrounds(renderer, [descriptor, descriptor]);
  cache.prepare(packet('1:0'), {report});
  assert.equal(cache.bytes, 720); assert.equal(renderer.textures.length, 1);
  const frame = cache.frames.get('1:0');
  assert.equal(frame.commands[0].texture, frame.commands[1].texture);
  assert.equal(frame.ownedTextures.length, 1); assert.equal(frame.ownedTextures[0].refs, 1);
  cache.clear(); assert.equal(cache.bytes, 0); assert.equal(renderer.textures[0].destroyed, true);
});

test('background admission rejects before allocation and evicts before replacement upload', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer, {maxBytes: 624});
  setBackgrounds(renderer, [backgroundDescriptor(renderer, 'background-paint:large', 401)]);
  assert.throws(() => cache.prepare(packet('1:0'), {report}), /budget/);
  assert.equal(renderer.textures.length, 0); assert.equal(renderer.buffers.length, 0);
  setBackgrounds(renderer, [backgroundDescriptor(renderer)]); cache.prepare(packet('1:0'), {report});
  const next = backgroundDescriptor(renderer, 'background-paint:next'), create = next.create;
  next.create = () => {
    assert.equal(renderer.textures[0].destroyed, true);
    assert.ok(renderer.buffers.every(buffer => buffer.destroyed));
    return create();
  };
  setBackgrounds(renderer, [next]); cache.prepare(packet('1:1'), {report});
  assert.equal(cache.bytes, 624); assert.equal(cache.frames.size, 1); cache.clear();
});

test('failed preparation releases new background references and preserves cached siblings', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer);
  const shared = backgroundDescriptor(renderer), fresh = backgroundDescriptor(renderer, 'background-paint:fresh');
  setBackgrounds(renderer, [shared]); cache.prepare(packet('1:0'), {report});
  const bytes = cache.bytes;
  setBackgrounds(renderer, [shared, fresh]);
  const createBuffer = renderer.device.createBuffer; let count = 0;
  renderer.device.createBuffer = spec => {if (++count === 2) throw new Error('upload failed'); return createBuffer(spec);};
  assert.throws(() => cache.prepare(packet('1:1'), {report}), /upload failed/);
  assert.equal(cache.bytes, bytes); assert.equal(cache.frames.size, 1);
  assert.equal(renderer.textures[0].destroyed, false); assert.equal(renderer.textures[1].destroyed, true);
  assert.equal(cache.render('1:0', {report}), true); cache.clear();
  assert.ok(renderer.buffers.every(buffer => buffer.destroyed));
});

test('a failed background creation unwinds already acquired shared references', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer);
  const shared = backgroundDescriptor(renderer);
  setBackgrounds(renderer, [shared]); cache.prepare(packet('1:0'), {report});
  setBackgrounds(renderer, [shared, {cacheKey: 'background-paint:failure', bytes: 400, create() {throw new Error('copy failed');}}]);
  assert.throws(() => cache.prepare(packet('1:1'), {report}), /copy failed/);
  assert.equal(cache.bytes, 624); assert.equal(cache.textures.get(shared.cacheKey).refs, 1);
  cache.clear(); assert.equal(cache.bytes, 0); assert.equal(renderer.textures[0].destroyed, true);
});

test('GPU frames share textures across packets and retain them until the last frame is evicted',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer,{maxBytes:1200,maxFrames:2});
  cache.prepare(imagePacket(0),{report});cache.prepare(imagePacket(1),{report});
  assert.equal(renderer.copies.length,1);assert.equal(cache.bytes,848);
  cache.prepare(imagePacket(2),{report});assert.equal(renderer.copies.length,1);assert.equal(renderer.textures[0].destroyed,false);
  assert.equal(cache.frames.size,2);assert.equal(cache.bytes,848);
  cache.prepare(imagePacket(3,'different'),{report});assert.equal(renderer.textures[0].destroyed,true);assert.equal(cache.frames.size,1);assert.equal(cache.bytes,624);
  cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.textures.size,0);assert.ok(renderer.textures.every(t=>t.destroyed));
});

test('failed GPU frame allocation releases only newly acquired references and buffers',()=>{
  const renderer=textureRenderer(),cache=new PreparedFrameCache(renderer);
  cache.prepare(imagePacket(0),{report});const bytes=cache.bytes,create=renderer.device.createBuffer;let calls=0;
  renderer.device.createBuffer=spec=>{if(++calls===2)throw new Error('allocation failed');return create(spec);};
  assert.throws(()=>cache.prepare(imagePacket(1),{report}),/allocation failed/);
  assert.equal(cache.bytes,bytes);assert.equal(renderer.textures[0].destroyed,false);assert.equal(renderer.buffers.at(-1).destroyed,true);
  cache.clear();assert.equal(renderer.textures[0].destroyed,true);assert.equal(cache.bytes,0);
});

test('fallback rasters belong to prepared frames, survive sibling eviction, and obey the GPU budget', () => {
  const renderer = textureRenderer(), cache = new PreparedFrameCache(renderer, {maxFrames: 2, maxBytes: 1200});
  const geometry = {root: {x: 0, y: 0}};
  renderer.rasterObject = (g, items, scale, artwork, owner) => {
    assert.equal(owner, cache.fallbackRasters);
    let raster = owner.get(artwork, 1, 0);
    if (!raster) {
      const texture = renderer.device.createTexture({});
      raster = {texture, bindGroup: {}, resolution: 1, generation: 0, bytes: g.bytes || 400, bounds: {x: 0, y: 0, width: 10, height: 10}};
      owner.set(artwork, raster);
    }
    return raster;
  };
  const fallback = (tick, g = geometry) => {
    const value = packet(`1:${tick}`); value.compatibility = [{g, items: []}]; value.groups[0].compatibilityIndex = 0; return value;
  };
  cache.prepare(fallback(0), {report}); cache.prepare(fallback(1), {report});
  assert.equal(cache.bytes, 848); assert.equal(cache.fallbackRasters.bytes, 400);
  cache.prepare(fallback(2), {report});
  assert.equal(renderer.textures.length, 1); assert.equal(renderer.textures[0].destroyed, false);
  assert.equal(cache.render('1:2', {report}), true);
  assert.throws(() => cache.prepare(fallback(3, {root: geometry.root, bytes: 1400}), {report}), /budget/);
  assert.equal(cache.bytes, 0); assert.equal(cache.fallbackRasters.bytes, 0);
  assert.ok(renderer.textures.every(texture => texture.destroyed));
  cache.prepare(fallback(4), {report}); cache.clear();
  assert.equal(cache.bytes, 0); assert.equal(cache.fallbackRasters.lru.size, 0);
});
