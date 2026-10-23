import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer} from '../src/renderer.mjs';
import {createFrame, createObject, defaultFigure} from '../src/demo.mjs';
import {backgroundImageAssets, createSceneImages, frameImageAssets} from '../src/scene-preparation.mjs';
import {RetainedGeometryCache} from '../src/playback-geometry-cache.mjs';
import {SHAPE, SHAPE_BYTES, SHAPE_FLOATS} from '../src/renderer-geometry.mjs';

function fixture(count = 1, image = false) {
  const figure = defaultFigure(), frame = createFrame(Array.from({length: count}, (_, i) => createObject(figure, i + 1, 20 + i, 40)));
  if (image) frame.background_id = 1;
  return {version: 5, canvas_width: 100, canvas_height: 80, figure_types: [figure], keyframes: [frame],
    backgrounds: image ? [{background_id: 1, kind: 1, asset_url: 'memory:background', mime_type: 'image/png'}] : []};
}
async function graphics() {
  const buffers = [], textures = [], context = {configure() {}, unconfigure() {}, getCurrentTexture: () => ({createView: () => ({})})};
  const resource = () => ({destroyed: false, destroy() {this.destroyed = true;}, createView() {return {};}});
  const queue = {submissions: 0, writeTexture() {}, copyExternalImageToTexture() {}, onSubmittedWorkDone: () => Promise.resolve(),
    submit(commands) {this.submissions++; for (const command of commands) command.run?.();}, writeBuffer(buffer, offset, data, start = 0, size) {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data, start, size);
      buffer.bytes.set(bytes, offset);
    }};
  const device = {queue, limits: {maxTextureDimension2D: 4096}, lost: new Promise(() => {}), addEventListener() {}, destroy() {},
    createShaderModule: () => ({getCompilationInfo: async () => ({messages: []})}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createRenderPipelineAsync: async () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
    createBuffer({size}) {const buffer = {...resource(), size, bytes: new Uint8Array(size)}; buffers.push(buffer); return buffer;},
    createTexture() {const texture = resource(); textures.push(texture); return texture;},
    createCommandEncoder: () => {
      const copies = [];
      return {finish: () => ({run: () => copies.forEach(copy => copy())}), beginRenderPass: () => ({setPipeline() {}, setBindGroup() {}, draw() {}, end() {}}),
        copyBufferToBuffer(source, from, target, to, size) {copies.push(() => target.bytes.set(source.bytes.subarray(from, from + size), to));}};
    },
  };
  const originals = new Map(['navigator', 'GPUShaderStage', 'GPUBufferUsage', 'GPUTextureUsage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {gpu: {requestAdapter: async () => ({requestDevice: async () => device, info: {}}), getPreferredCanvasFormat: () => 'bgra8unorm'}}});
  globalThis.GPUShaderStage = {VERTEX: 1, FRAGMENT: 2}; globalThis.GPUBufferUsage = {UNIFORM: 1, COPY_DST: 2, STORAGE: 4};
  globalThis.GPUTextureUsage = {TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4};
  const images = new Map(), canvas = {clientWidth: 100, clientHeight: 80, width: 0, height: 0, getContext: () => context};
  const renderer = await createRenderer(canvas, {resources: {url: asset => asset.asset_url, image: url => images.get(url)}});
  return {renderer, images, buffers, textures, queue,
    close() {renderer.destroy(); for (const [key, descriptor] of originals) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}},
  };
}
const imageFactory = () => ({complete: false, naturalWidth: 0, naturalHeight: 0,
  async decode() {this.complete = true; this.naturalWidth = this.naturalHeight = 4;}});

test('initial scene stages complete media and GPU data without changing or submitting the live scene', async () => {
  const app = await graphics();
  try {
    const old = fixture(), incoming = fixture(80, true), renderer = app.renderer;
    renderer.render({report: old, frame: old.keyframes[0], cameraEnabled: false});
    const oldBuffer = renderer.shapeBuffer, oldGeometry = renderer.lastGeometry, oldBytes = oldBuffer.bytes.slice(), submissions = app.queue.submissions;
    await assert.rejects(renderer.prepareInitialScene({report: old, frame: old.keyframes[0]}), /separate incoming/);
    const prepared = await renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], view: {x: 3, y: 7, scale: 1}, cameraEnabled: false, imageFactory});
    assert.equal(renderer.activeReport, old); assert.equal(renderer.lastGeometry, oldGeometry); assert.equal(renderer.shapeBuffer, oldBuffer);
    assert.deepEqual(oldBuffer.bytes, oldBytes); assert.equal(oldBuffer.destroyed, false); assert.equal(app.queue.submissions, submissions);
    assert.equal(app.images.size, 0); assert.equal(prepared.images.get('memory:background').naturalWidth, 4);
    assert.equal(prepared.stage.layout.filter(entry => !entry.g && entry.texture).length, 1);
    assert.throws(() => renderer.activatePreparedScene(prepared, {frame: old.keyframes[0]}), /no longer matches/);
    assert.equal(renderer.shapeBuffer, oldBuffer); assert.equal(oldBuffer.destroyed, false);
    for (const [url, image] of prepared.images) app.images.set(url, image);
    renderer.activatePreparedScene(prepared);
    assert.equal(prepared.activated, true); assert.equal(oldBuffer.destroyed, true); assert.equal(renderer.lastGeometry, prepared.geometry);
    const stagedBuffer = renderer.shapeBuffer, stagedBytes = stagedBuffer.bytes.slice();
    prepared.dispose(); assert.equal(stagedBuffer.destroyed, false, 'Transferred resources belong to the live renderer.');
    renderer.render({report: incoming, frame: incoming.keyframes[0], geometry: prepared.geometry, view: prepared.view, cameraEnabled: false});
    assert.equal(renderer.stats.preparation, 'retained'); assert.equal(renderer.stats.uploadBytes, 0); assert.equal(renderer.stats.compiledObjects, 0);
    assert.deepEqual(stagedBuffer.bytes, stagedBytes); assert.equal(renderer.backgroundsReady(incoming, incoming.keyframes[0]), true);
  } finally {app.close();}
});

// Every published entry's range holds its data followed by disabled records.
function assertPublishedLayout(renderer) {
  const shapes = new Float32Array(renderer.shapeBuffer.bytes.buffer);
  for (const entry of renderer.layout) {
    const expected = new Float32Array(entry.capacity * SHAPE_FLOATS); expected.set(entry.data);
    for (let i = entry.count; i < entry.capacity; i++) expected[i * SHAPE_FLOATS + 20] = SHAPE.DISABLED;
    assert.deepEqual(shapes.subarray(entry.offset * SHAPE_FLOATS, (entry.offset + entry.capacity) * SHAPE_FLOATS), expected, entry.key);
  }
}

test('a staged editor update copies unchanged primitives on the GPU and uploads only changed objects', async () => {
  for (const changedMeanwhile of [false, true]) {
    const app = await graphics();
    try {
      const {renderer} = app, report = fixture(6), cache = new RetainedGeometryCache(), frame = report.keyframes[0];
      const moved = structuredClone(frame); moved.objects[2].angles = moved.objects[2].angles.map(angle => angle + .4);
      report.keyframes.push(moved);
      const geometry = cache.get(report, frame, 1);
      renderer.render({report, frame, geometry, cameraEnabled: false});
      const live = new Map(renderer.layout.map(entry => [entry.key, entry.data]));
      const next = cache.get(report, moved, 1), prepared = await renderer.prepareSceneUpdate({report, frame: moved, geometry: next, view: {}, cameraEnabled: false});
      const changed = [...next.objects.values()].filter(g => g !== geometry.objects.get(g.slot)).map(g => g.obj.unique_id);
      assert.deepEqual(changed, [3]);
      // A live-only update between preparation and publication must not be copied.
      const other = renderer.layout.find(entry => entry.key === 5);
      if (changedMeanwhile) {other.data = other.data.slice(); renderer.uploadEntry(other);}
      const uploads = [], writeBuffer = app.queue.writeBuffer;
      app.queue.writeBuffer = function (buffer, offset, data, start, size) {uploads.push(offset); return writeBuffer.call(this, buffer, offset, data, start, size);};
      prepared.activate();
      assert.equal(renderer.lastGeometry, next);
      for (const entry of renderer.layout.filter(entry => entry.g)) assert.equal(entry.data === live.get(entry.key), entry.key !== 3, entry.key);
      assertPublishedLayout(renderer);
      const unchanged = renderer.layout.filter(entry => entry.g && entry.key !== 3 && !(changedMeanwhile && entry.key === 5));
      assert.equal(renderer.stats.copiedBytes, unchanged.reduce((bytes, entry) => bytes + entry.capacity * SHAPE_BYTES, 0));
      assert.deepEqual(uploads, changedMeanwhile ? [renderer.layout.find(entry => entry.key === 5).offset * SHAPE_BYTES] : []);
    } finally {app.close();}
  }
});

test('a failed background upload destroys its allocation without replacing the live texture', async () => {
  const app = await graphics();
  try {
    const {renderer, queue, textures} = app, scene = fixture(1, true), frame = scene.keyframes[0];
    app.images.set('memory:background', {complete: true, naturalWidth: 4, naturalHeight: 4});
    renderer.render({report: scene, frame, cameraEnabled: false});
    const liveTexture = renderer.layout.find(entry => entry.texture).texture.texture;
    const oldGeometry = renderer.lastGeometry;
    queue.copyExternalImageToTexture = () => {throw new Error('Background upload failed');};
    await assert.rejects(renderer.prepareSceneUpdate({report: scene, frame, geometry: oldGeometry,
      view: {scale: 1}, cameraEnabled: false}), /Background upload failed/);
    assert.equal(liveTexture.destroyed, false);
    assert.equal(textures.at(-1).destroyed, true);
    assert.equal(renderer.lastGeometry, oldGeometry);
  } finally {app.close();}
});

test('abort during staged GPU upload destroys only incoming buffers and textures', async () => {
  const app = await graphics();
  try {
    const old = fixture(), incoming = fixture(900, true), renderer = app.renderer, controller = new AbortController();
    renderer.render({report: old, frame: old.keyframes[0], cameraEnabled: false});
    const oldBuffers = new Set(app.buffers), oldTextures = new Set(app.textures), oldBuffer = renderer.shapeBuffer;
    await assert.rejects(renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], cameraEnabled: false,
      signal: controller.signal, imageFactory, sliceMs: .001, yieldControl: async () => {},
      onProgress(progress) {if (progress.phase === 'GPU upload') controller.abort();}}), {name: 'AbortError'});
    assert.equal(renderer.activeReport, old); assert.equal(renderer.shapeBuffer, oldBuffer); assert.equal(oldBuffer.destroyed, false);
    assert.ok(app.buffers.some(buffer => !oldBuffers.has(buffer)), 'Cancellation occurred after actual staging allocation.');
    assert.ok(app.buffers.filter(buffer => !oldBuffers.has(buffer)).every(buffer => buffer.destroyed));
    assert.ok(app.textures.filter(texture => !oldTextures.has(texture)).every(texture => texture.destroyed));
  } finally {app.close();}
});

test('initial image preparation deduplicates URLs, excludes other frames, and fails on undecodable images', async () => {
  const report = fixture(1, true), current = report.keyframes[0];
  report.backgrounds.push({background_id: 9, kind: 1, asset_url: 'memory:unused'});
  assert.deepEqual(backgroundImageAssets(report, current).map(asset => asset.background_id), [1]);
  const asset = {asset_url: 'memory:sprite'}, geometry = {orderedObjects: [{drawables: [{type: 'image', asset}, {type: 'image', asset}, {type: 'text', asset: {}}]}]};
  assert.deepEqual(frameImageAssets(geometry), [asset]);
  let created = 0;
  const images = createSceneImages({url: asset => asset.asset_url, imageFactory: () => {created++; return imageFactory();}});
  await images.load([asset, {...asset}, ...backgroundImageAssets(report, current)]);
  assert.equal(created, 2); assert.equal(images.images.size, 2); images.dispose(); assert.equal(images.images.size, 0);
  const failed = createSceneImages({url: asset => asset.asset_url, imageFactory: () => ({complete: true, naturalWidth: 0, naturalHeight: 0})});
  await assert.rejects(failed.load([asset]), /could not be decoded/); failed.dispose();
});

test('cancelling an unfinished image decode releases private images without waiting for its network result', async () => {
  const controller = new AbortController(), image = {complete: false, naturalWidth: 0, decode: () => new Promise(() => {})};
  const images = createSceneImages({url: asset => asset.asset_url, signal: controller.signal, imageFactory: () => image});
  const pending = images.load([{asset_url: 'memory:pending'}]);
  controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  images.dispose(); assert.equal(image.src, ''); assert.equal(images.images.size, 0);
});

test('a stale model revision cancels stalled incoming media without an AbortSignal', async () => {
  const app = await graphics();
  try {
    const old = fixture(), incoming = fixture(1, true), renderer = app.renderer;
    renderer.render({report: old, frame: old.keyframes[0], cameraEnabled: false});
    const oldBuffer = renderer.shapeBuffer; let stale = false;
    const image = {complete: false, naturalWidth: 0, decode: () => new Promise(() => {})};
    const pending = renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], cameraEnabled: false,
      imageFactory: () => image, checkCurrent() {if (stale) throw new DOMException('The document changed.', 'AbortError');}});
    await new Promise(resolve => setTimeout(resolve, 5)); stale = true;
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(image.src, ''); assert.equal(renderer.activeReport, old);
    assert.equal(renderer.shapeBuffer, oldBuffer); assert.equal(oldBuffer.destroyed, false);
  } finally {app.close();}
});

test('disposing private image resources rejects pending decode waiters directly', async () => {
  const image = {complete: false, naturalWidth: 0, decode: () => new Promise(() => {})};
  const images = createSceneImages({url: asset => asset.asset_url, imageFactory: () => image});
  const pending = images.load([{asset_url: 'memory:pending'}]);
  images.dispose(); await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(image.src, ''); assert.equal(images.images.size, 0);
});

test('a failing compatibility raster degrades its object without aborting the scene build', async () => {
  const app = await graphics();
  try {
    const { renderer } = app, report = fixture(2);
    const poly = { color_rgb: [240, 40, 20], alpha_raw: 0 }, fig = { figure_type_id: 1, segments: [], polyfills: [poly] };
    const object = (uid, slot, x, y) => {
      const obj = { unique_id: uid, object_slot: slot, figure_type_id: 1, root_x: x, root_y: y, scale: 1 }, root = { x, y };
      // A self-crossing outline beyond the vector budget needs a compatibility texture.
      const outline = Array.from({ length: 260 }, (_, i) => ({ x: x + (i % 2 ? 24 : 0), y: y + i * 24 / 260 }));
      return { obj, fig, slot, root, segments: [], polys: [], drawables: [{ type: 'poly', obj, fig, slot, index: 0, poly, points: outline, z: 0, rgb: [240, 40, 20], alpha: 1, opacity: 1 }] };
    };
    const scene = (items, previous, changed) => ({ objects: new Map(items.map(g => [g.slot, g])), orderedObjects: items, token: {}, previousToken: previous?.token, changedSlots: new Set(changed ?? items.map(g => g.slot)), warnings: [] });
    const frame = items => ({ objects: items.map(g => g.obj), background_id: 0 });
    // Canvas rasterization is unavailable under Node; stub the seam this test exercises.
    let failRaster = false;
    renderer.rasterObject = (source, items, scale, artwork = source, cache = renderer.rasterCache) => {
      const hit = cache.get(artwork, 1, renderer.generation);
      if (hit) return hit;
      if (failRaster) throw new Error('probe raster failure');
      const result = { bounds: { x: source.root.x, y: source.root.y, width: 24, height: 24 }, origin: { ...source.root }, texture: renderer.device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 5 }), bindGroup: {}, generation: renderer.generation, resolution: 1, bytes: 256 };
      cache.set(artwork, result); return result;
    };
    let geometry = scene([object(1, 0, 20, 20), object(2, 1, 80, 20)]);
    const draw = () => renderer.render({ report, frame: frame(geometry.orderedObjects), geometry, view: { scale: 1, x: 0, y: 0 }, cameraEnabled: false });
    draw();
    assert.equal(renderer.stats.textureObjects, 2, 'Fixture needs compatibility textures.');
    const kept = renderer.entries.get(1).texture;
    failRaster = true;
    const changed = { ...geometry.orderedObjects[0], drawables: geometry.orderedObjects[0].drawables.map(item => ({ ...item, rgb: [20, 220, 40] })) };
    geometry = scene([changed, geometry.orderedObjects[1]], geometry, [0]);
    draw();
    assert.equal(renderer.stats.rasterFailures, 1);
    assert.equal(renderer.entries.get(1).texture, kept, 'A failed raster must keep the previous texture.');
    assert.notEqual(renderer.stats.preparation, 'failed');
    // Without a surviving texture the object degrades to vector shapes.
    renderer.rasterCache.clear();
    geometry = scene([{ ...changed, drawables: changed.drawables.map(item => ({ ...item, rgb: [40, 40, 220] })) }, object(3, 2, 140, 20)], geometry, [0, 2]);
    draw();
    const degraded = renderer.entries.get(1);
    assert.ok(degraded); assert.ok(!degraded.texture);
    assert.ok(degraded.count > 0, 'Degraded object must still draw its vector shapes.');
    // A whole-build failure draws the stale layout and does not retry per frame.
    const originalPrepare = renderer.prepare;
    let attempts = 0;
    renderer.prepare = () => { attempts++; throw new Error('probe prepare failure'); };
    renderer.generation++;
    draw();
    assert.equal(renderer.stats.prepareFailures, 1); assert.equal(renderer.stats.preparation, 'failed');
    draw();
    assert.equal(attempts, 1, 'Identical inputs must not retry the doomed build.');
    geometry = scene([geometry.orderedObjects[0], object(4, 3, 200, 20)], geometry);
    draw();
    assert.equal(attempts, 2, 'Changed inputs must retry the build.');
    renderer.prepare = originalPrepare;
    geometry = scene(geometry.orderedObjects, geometry);
    draw();
    assert.equal(renderer.stats.preparation, 'layout');
  } finally { app.close(); }
});

test('preparation samples the final viewport and activation cannot adopt a mismatched geometry', async () => {
  const app = await graphics();
  try {
    const incoming = fixture(); let views = 0;
    const prepared = await app.renderer.prepareInitialScene({report: incoming, frame: incoming.keyframes[0], cameraEnabled: false,
      getView: () => ({scale: ++views === 1 ? 1 : 2, x: 17, y: 23})});
    assert.equal(prepared.view.scale, 2); assert.equal(prepared.view.x, 17); assert.equal(prepared.view.y, 23);
    assert.throws(() => app.renderer.activatePreparedScene(prepared, {geometry: {...prepared.geometry}}), /no longer matches/);
    const owned = prepared.stage.shapeBuffer; prepared.dispose();
    assert.equal(owned.destroyed, true); assert.throws(() => app.renderer.activatePreparedScene(prepared), /no longer matches/);
  } finally {app.close();}
});
