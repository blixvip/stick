import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackResources } from '../src/playback-resources.mjs';
import { previewPNG } from './preview-png-fixture.mjs';
import {vfxSoftwareResourceStats} from '../src/vfx-canvas.mjs';

test('preview path fills rasterize on worker CPUs at every size; images and exports stay accelerated',()=>{
  const preview=new PlaybackResources({preview:true}),original=new PlaybackResources();
  try {
    assert.notEqual(preview.pathRasterSurfaces,preview.rasterSurfaces);
    assert.equal(preview.rasterSurface(512,512),preview.pathRasterSurfaces);
    assert.equal(preview.rasterSurface(4096,2048),preview.pathRasterSurfaces,'size never changes the antialiasing route');
    assert.equal(preview.rasterSurface(20,20,{hasImages:true}),preview.rasterSurfaces);
    assert.equal(original.rasterSurface(20,20),original.rasterSurfaces);
  }finally{preview.dispose();original.dispose();}
});

test('playback packets keep image artwork and its drawing scratch in memory; other owners stay accelerated',()=>{
  const packets=new PlaybackResources({preview:true,softwareImages:true}),thumbnails=new PlaybackResources({preview:true}),exported=new PlaybackResources({softwareImages:true});
  try {
    assert.equal(packets.rasterSurface(20,20,{hasImages:true}),packets.pathRasterSurfaces,'An accelerated packet bitmap is read back when a WebGPU renderer copies it.');
    assert.equal(packets.rasterSurface(20,20),packets.pathRasterSurfaces);
    assert.equal(packets.drawingProvider.softwareScratch,true,'An accelerated drawing scratch would be read back into the software surface.');
    assert.equal(thumbnails.rasterSurface(20,20,{hasImages:true}),thumbnails.rasterSurfaces);
    assert.equal(thumbnails.drawingProvider.softwareScratch,false);
    assert.equal(exported.rasterSurface(20,20,{hasImages:true}),exported.rasterSurfaces,'Original-resolution export has no software surface to select.');
    assert.equal(exported.drawingProvider.softwareScratch,false);
  }finally{packets.dispose();thumbnails.dispose();exported.dispose();}
});

test('software frame and camera scratch share the worker resource lifetime and filter allowance',t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'OffscreenCanvas');
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;this.context={canvas:this,reset(){}};}
    getContext(){return this.context;}
  };
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'OffscreenCanvas',prior);else delete globalThis.OffscreenCanvas;});
  const resources=new PlaybackResources({preview:true,maxSoftwareFilterBytes:65536,maxBackgroundBytes:16384});
  const frame=resources.softwareFrame(64,32),camera=resources.softwareCamera();
  camera.geometry={objects:new Map()};camera.frame={objects:[]};
  assert.equal(resources.softwareCamera(),camera,'A worker should reuse one camera scratch owner');
  assert.equal(vfxSoftwareResourceStats(frame.context).maxBytes,65536);
  assert.equal(vfxSoftwareResourceStats(camera.context).maxBytes,65536);
  assert.equal(resources.backgroundBytes,16384);
  resources.softwareFrameSurfaces.release();
  assert.equal(frame.surface.width,1);assert.equal(frame.surface.height,1);
  resources.dispose();
  assert.equal(camera.geometry,null);assert.equal(camera.frame,null);
  assert.equal(camera.canvas.width,1);assert.equal(camera.canvas.height,1);
  assert.equal(resources.softwareFrameSurfaces.context,null);
});

function setup(t, sizes, maxBytes = 32) {
  const decoded = [];
  t.mock.method(globalThis, 'fetch', async url => ({
    ok: true, blob: async () => sizes[new URL(url).pathname.slice(1)],
  }));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  globalThis.createImageBitmap = async ([width, height]) => {
    const bitmap = { width, height, closed: 0, close() { this.closed++; } };
    decoded.push(bitmap);
    return bitmap;
  };
  const resources = new PlaybackResources({ baseURL: 'https://example.test/', maxBytes });
  t.after(() => {
    resources.dispose();
    if (previous) Object.defineProperty(globalThis, 'createImageBitmap', previous);
    else delete globalThis.createImageBitmap;
  });
  const preload = (...urls) => resources.preload(urls.map(url => ({ type: 'image', asset: { url } })));
  return { resources, decoded, preload };
}

test('an oversized image loads at original resolution and is released when no longer needed', async t => {
  const { resources, decoded, preload } = setup(t, { large: [8192, 8192], small: [2, 2] });
  await preload('large');
  assert.equal(resources.bytes, 8192 * 8192 * 4);
  assert.equal(resources.image('large').naturalWidth, 8192);
  assert.equal(resources.image('large').naturalHeight, 8192);
  assert.equal(decoded[0].closed, 0);
  await preload('small');
  assert.equal(decoded[0].closed, 1);
  assert.equal(resources.bytes, 16);
});

test('combined required assets may exceed the target, with duplicate URLs decoded once', async t => {
  const { resources, decoded, preload } = setup(t, { a: [3, 2], b: [3, 2] });
  await preload('a', 'b', 'a');
  assert.equal(resources.bytes, 48);
  assert.equal(decoded.length, 2);
  assert.ok(decoded.every(bitmap => bitmap.closed === 0));
  await preload('b');
  assert.equal(resources.bytes, 24);
  assert.equal(decoded[0].closed, 1);
  assert.equal(decoded[1].closed, 0);
  assert.equal(decoded.length, 2);
});

test('ordinary cache eviction and disposal still release bitmap memory', async t => {
  const { resources, decoded, preload } = setup(t, { a: [2, 2], b: [2, 2], c: [2, 2] });
  await preload('a', 'b');
  resources.image('a');
  await preload('c');
  assert.equal(decoded[1].closed, 1);
  assert.equal(decoded[0].closed, 0);
  assert.equal(resources.bytes, 32);
  resources.dispose();
  assert.equal(resources.bytes, 0);
  assert.ok(decoded.every(bitmap => bitmap.closed === 1));
  await assert.rejects(preload('a'), { name: 'AbortError' });
});

test('retained export images need neither another fetch nor another decode', async t => {
  const {resources,decoded,preload}=setup(t,{a:[2,2]},32);
  await preload('a');
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unnecessary source fetch');});
  for(let frame=0;frame<20;frame++)await preload('a');
  assert.equal(decoded.length,1);assert.equal(resources.bytes,16);
});

async function imageFixture(t, maxBytes, width = 1024, height = 512) {
  const png = await previewPNG(width, height), url = 'data:image/png;base64,' + png.toString('base64');
  const decoded = [], previousBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap'),
    previousImageData = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
  globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.createImageBitmap = async (source, sx, sy, sw, sh, options) => {
    const bitmap = { width: options?.resizeWidth ?? sw ?? source.width, height: options?.resizeHeight ?? sh ?? source.height, closed: 0, close() { this.closed++; } };
    decoded.push(bitmap); return bitmap;
  };
  const resources = new PlaybackResources({ maxBytes, hardMaxBytes: maxBytes });
  t.after(() => {
    resources.dispose();
    if (previousBitmap) Object.defineProperty(globalThis, 'createImageBitmap', previousBitmap); else delete globalThis.createImageBitmap;
    if (previousImageData) Object.defineProperty(globalThis, 'ImageData', previousImageData); else delete globalThis.ImageData;
  });
  // The full 2 MiB image exceeds the allowance; only its visible source crop
  // is needed. Anchored 1:1 at the document origin like a placed bitmap figure.
  const asset = { data_url: url, width, height, display_width: width, display_height: height,
    anchor_start: { x: 0, y: 0 }, anchor_length: width, anchor_angle_rad: 0 };
  const item = { type: 'image', asset, start: { x: 0, y: 0 }, end: { x: width, y: 0 }, angle: 0, seg: {}, obj: {} };
  return { resources, decoded, url, item };
}

test('export preloads decode only the needed source crop inside the allowance', async t => {
  const { resources, decoded, url, item } = await imageFixture(t, 1024 * 1024);
  await resources.preload([item], { plan: { matrix: [1, 0, 0, 1, 0, 0], width: 64, height: 64 } });
  const image = resources.image(url);
  assert.equal(image.naturalWidth, 1024);
  assert.ok(image.width <= 68 && image.height <= 68, `expected a bounded crop, decoded ${image.width}x${image.height}`);
  assert.equal(image.srcX, 0); assert.equal(image.srcY, 0);
  assert.ok(resources.bytes <= 1024 * 1024);
  // A shifted view grows coverage into one union variant instead of restarting.
  await resources.preload([item], { plan: { matrix: [1, 0, 0, 1, -32, -32], width: 64, height: 64 } });
  const shifted = resources.image(url);
  assert.ok(shifted.srcX <= 32 && shifted.srcX + shifted.srcW >= 96 && shifted.srcY <= 32 && shifted.srcY + shifted.srcH >= 96);
  assert.ok(decoded.every(bitmap => bitmap.width * bitmap.height * 4 <= 1024 * 1024));
  // Views that cannot show the image keep the variant without decoding.
  const count = decoded.length;
  await resources.preload([item], { plan: { matrix: [1, 0, 0, 1, -4096, 0], width: 64, height: 64 } });
  assert.equal(decoded.length, count);
});

test('preview variants cover unchanged and contained draws without redecoding', async t => {
  const { resources, decoded, url, item } = await imageFixture(t, 4 * 1024 * 1024);
  resources.preview = true;
  const visible = { x: 0, y: 0, width: 64, height: 64 };
  await resources.preload([item], { scale: 1, visible });
  const first = resources.image(url);
  assert.ok(first.srcW <= 68);
  await resources.preload([item], { scale: 1, visible });
  assert.equal(resources.image(url), first);
  await resources.preload([item], { scale: 1, visible: { x: 8, y: 8, width: 32, height: 32 } });
  assert.equal(resources.image(url), first, 'a contained view must not shrink the retained variant');
  assert.equal(decoded.length, 1);
  // A partially moved view grows coverage into one union variant.
  await resources.preload([item], { scale: 1, visible: { x: 48, y: 0, width: 64, height: 64 } });
  const grown = resources.image(url);
  assert.equal(decoded.length, 2);
  assert.ok(grown.srcX + grown.srcW >= 112 && grown.srcY + grown.srcH >= 66, 'the union variant must cover both views');
  assert.equal(first.closed, 1, 'the replaced variant releases its pixels');
});

test('covered preview images avoid reconstructing large encoded sources', async t => {
  const {resources, item, url} = await imageFixture(t, 4 * 1024 * 1024);
  resources.preview = true;
  const visible = {x: 0, y: 0, width: 64, height: 64};
  await resources.preload([item], {scale: 1, visible});
  const image = resources.image(url);
  // Oversized compressed/native sources are intentionally not retained.
  resources.sources.clear(); resources.sourceBytes = 0;
  t.mock.method(resources, 'source', () => {throw new Error('Covered pixels must not reload their encoded source.');});
  await resources.preload([item], {scale: 1, visible});
  assert.equal(resources.image(url), image);
});

test('simultaneous preview crop growth shares one image allowance', async t => {
  const {resources, item} = await imageFixture(t, 60000 * 4);
  resources.preview = true;
  const other = {...item, asset: {...item.asset, data_url: item.asset.data_url.replace('image/png;', 'image/x-png;')}};
  const items = [item, other];
  await resources.preload(items, {scale: 1, visible: {x: 0, y: 0, width: 96, height: 96}});
  await resources.preload(items, {scale: 1, visible: {x: 400, y: 0, width: 96, height: 96}});
  assert.ok(resources.bytes <= resources.maxBytes, `Both unions exceeded the shared allowance: ${resources.bytes}`);
  for (const image of resources.images.values()) {
    assert.ok(image.srcX <= 400 && image.srcX + image.srcW >= 496);
    assert.equal(image.width, image.srcW, 'Budgeted coverage growth must preserve visible pixel density.');
  }
  assert.equal(resources.pressureReduced, false);
});

test('one preview batch retains images from distinct projections and the background under pressure',async t=>{
  const {resources,item,url}=await imageFixture(t,8192*4,128,128);
  resources.preview=true;
  const other={...item,obj:{unique_id:2},asset:{...item.asset,data_url:item.asset.data_url.replace('image/png;','image/x-png;')}};
  const background={type:'image',asset:{...item.asset,data_url:item.asset.data_url.replace('image/png;','image/octet-stream;')}};
  const projection=new Map([[item,{visible:{x:0,y:0,width:32,height:32},scale:1}],
    [other,{visible:{x:80,y:64,width:32,height:32},scale:1}],[background,null]]);
  await resources.preload([item,other,background],{viewFor:value=>projection.get(value)});
  assert.equal(resources.images.size,3,'A later frame requirement evicted an earlier image');
  assert.ok(resources.image(url));assert.ok(resources.image(resources.url(other.asset)));assert.ok(resources.image(resources.url(background.asset)));
  const crop=resources.image(resources.url(other.asset));
  assert.ok(crop.srcX<=80&&crop.srcX+crop.srcW>=112&&crop.srcY<=64&&crop.srcY+crop.srcH>=96);
  assert.ok(crop.srcX>=78&&crop.srcY>=62,'The per-item projection was ignored and decoded the whole source');
  assert.ok(resources.bytes<=resources.maxBytes,'Simultaneous sources exceeded their shared preview allowance');
  assert.equal(resources.pressureReduced,true);
});

test('one source merges every projection before choosing a bounded decoded variant',async t=>{
  const {resources,item,url,decoded}=await imageFixture(t,4*1024*1024);
  resources.preview=true;const second={...item,obj:{unique_id:2}};
  await resources.preload([item,second],{viewFor:value=>({visible:{x:value===item?0:400,y:0,width:64,height:64},scale:value===item ? .5 : 1})});
  const image=resources.image(url);
  assert.equal(decoded.length,1);
  assert.ok(image.srcX<=0&&image.srcX+image.srcW>=464,'Only one of the source projections was retained');
  assert.ok(image.srcW<600,'The per-item source union was ignored');
  assert.equal(image.width,image.srcW,'The highest requested density must serve both projections');
});

test('export crop replacement releases obsolete pixels before checking the new allocation', async t => {
  const {resources, item, url} = await imageFixture(t, 11000 * 4);
  const plan = x => ({matrix:[1,0,0,1,-x,0],width:96,height:96});
  await resources.preload([item], {plan:plan(0)});
  const first = resources.image(url);
  await resources.preload([item], {plan:plan(400)});
  const next = resources.image(url);
  assert.equal(first.closed, 1);
  assert.notEqual(next, first);
  assert.equal(next.width, next.srcW);
  assert.ok(next.srcX <= 400 && next.srcX + next.srcW >= 496);
  assert.ok(resources.bytes <= resources.hardMaxBytes);
});

test('disposal during a preview decode closes its late bitmap without retaining stale pixels', async t => {
  const {resources, item, decoded} = await imageFixture(t, 1024 * 1024);
  resources.preview = true;
  const original = globalThis.createImageBitmap;
  let entered, release;
  const ready = new Promise(resolve => {entered=resolve;}), gate = new Promise(resolve => {release=resolve;});
  globalThis.createImageBitmap = async (...args) => {
    const bitmap = await original(...args); entered(); await gate; return bitmap;
  };
  const pending = resources.preload([item], {scale:1, visible:{x:0,y:0,width:64,height:64}});
  const cancelled = assert.rejects(pending, {name:'AbortError'});
  await ready; resources.dispose(); release(); await cancelled;
  assert.equal(resources.bytes,0); assert.equal(resources.images.size,0);
  assert.ok(decoded.every(bitmap => bitmap.closed===1));
});

test('thin previews stay bounded, remain reusable and regain detail on both axes', async t => {
  const {resources, item, url, decoded} = await imageFixture(t, 128 * 4, 1, 4096);
  resources.preview = true;
  await resources.preload([item]);
  const first = resources.image(url);
  assert.equal(first.width,1); assert.equal(first.height,128);
  await resources.preload([item]); assert.equal(decoded.length,1);
  resources.maxBytes = resources.hardMaxBytes = 4096 * 4;
  await resources.preload([item]);
  assert.equal(resources.image(url).height,4096);
  assert.equal(first.closed,1); assert.equal(decoded.length,2);
  await resources.preload([item]); assert.equal(decoded.length,2);
});

test('unchanged odd-size preview dimensions do not cause repeated decode work', async t => {
  const {resources, item, decoded} = await imageFixture(t, 10000 * 4, 101, 53);
  resources.preview = true;
  for (let i=0;i<5;i++) await resources.preload([item],{scale:.4});
  assert.equal(decoded.length,1);
});
