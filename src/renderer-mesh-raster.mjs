import {messageError} from './localized-error.mjs';
/** WebGPU depth raster for evaluated figure meshes. The result is an ordinary
 * object texture, composited in painter order like any other artwork; only the
 * triangles inside it are depth tested. Depth follows surface-raster.mjs:
 * larger depth values are nearer and ties keep the later triangle. */

const SHADER = /* wgsl */ `
struct Uniforms { box: vec4f, depth: vec4f }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> positions: array<vec2f>;
@group(0) @binding(2) var<storage, read> depths: array<f32>;
@group(0) @binding(3) var<storage, read> triangles: array<u32>;
@group(0) @binding(4) var<storage, read> materials: array<u32>;
@group(0) @binding(5) var<storage, read> palette: array<vec4f>;
struct VertexOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) color: vec4f }
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  let vertex = triangles[index];
  let triangle = index / 3u;
  let word = materials[triangle >> 1u];
  let material = select(word & 0xffffu, word >> 16u, (triangle & 1u) == 1u);
  let p = (positions[vertex] - u.box.xy) / u.box.zw;
  var out: VertexOut;
  out.position = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.9995 - 0.999 * (depths[vertex] - u.depth.x) / u.depth.y, 1.0);
  out.color = palette[material];
  return out;
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4f { return input.color; }`;

const pipelines = new WeakMap();
function meshPipeline(device, format, samples) {
  let cache = pipelines.get(device);
  if (!cache) {
    const module = device.createShaderModule({code: SHADER, label: 'Figure mesh depth raster'});
    const storage = binding => ({binding, visibility: GPUShaderStage.VERTEX, buffer: {type: 'read-only-storage'}});
    const layout = device.createBindGroupLayout({entries: [{binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: 'uniform'}}, storage(1), storage(2), storage(3), storage(4), storage(5)]});
    cache = {module, layout, pipelines: new Map()}; pipelines.set(device, cache);
  }
  const key = `${format}:${samples}`;
  let pipeline = cache.pipelines.get(key);
  if (!pipeline) {
    pipeline = device.createRenderPipeline({label: 'Figure mesh depth raster', layout: device.createPipelineLayout({bindGroupLayouts: [cache.layout]}),
      vertex: {module: cache.module, entryPoint: 'vs'}, fragment: {module: cache.module, entryPoint: 'fs', targets: [{format}]},
      primitive: {topology: 'triangle-list'}, depthStencil: {format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal'},
      multisample: {count: samples}});
    cache.pipelines.set(key, pipeline);
  }
  return {pipeline, layout: cache.layout};
}

/** An object whose drawables are only opaque mesh faces can use the GPU raster.
 * Nested clips and per-item opacity keep the Canvas painter's isolation. */
export const meshOnlyItems = items => items.length > 0 && items.every(s => s.type === 'mesh' && !s.outline && s.count > 0 && !s._movieclipOwner && !(s.opacity < .999999)) &&
  items.every(s => s.spatialMesh === items[0].spatialMesh);

/** Compact, transferable GPU input for mesh drawables of one evaluated mesh.
 * Arrays are copies: evaluated meshes stay owned by their geometry. */
export function meshRasterSource(items) {
  const mesh = items[0].spatialMesh, count = items.reduce((sum, s) => sum + s.count, 0);
  const triangles = new Uint32Array(count * 3), materials = new Uint16Array(count + (count & 1));
  let at = 0;
  for (const s of items) { triangles.set(s.triangles.subarray(0, s.count * 3), at * 3); materials.set(s.materials.subarray(0, s.count), at); at += s.count; }
  const palette = new Float32Array(mesh.colors.length * 4);
  // Onion skins tint every face with one colour.
  mesh.colors.forEach((c, i) => { c = items[0].onionTint ?? c; palette.set([c[0] / 255, c[1] / 255, c[2] / 255, 1], i * 4); });
  return {positions: mesh.positions.slice(0, mesh.vertexCount * 2), depth: mesh.depth.slice(0, mesh.vertexCount), triangles,
    materials: new Uint32Array(materials.buffer), palette, count, zMin: mesh.zMin, zMax: mesh.zMax};
}
export const meshRasterBuffers = source => [source.positions.buffer, source.depth.buffer, source.triangles.buffer, source.materials.buffer, source.palette.buffer];
export const meshRasterBytes = source => source.positions.byteLength + source.depth.byteLength + source.triangles.byteLength + source.materials.byteLength + source.palette.byteLength;

/** Record one mesh raster into `encoder`. Callers submit, then run cleanup;
 * the texture and bind group outlive it. `target` reuses an exact texture. */
export function encodeMeshRaster(renderer, encoder, {source, width, height, pixelScale, bounds, target, label = 'Figure mesh artwork'}) {
  const device = renderer.device, samples = renderer.isolationSamples ?? renderer.msaaCount ?? 1;
  if (!source?.count || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D || !(pixelScale > 0)) throw messageError(new TypeError(''), "errors.rendererMeshRaster.invalidMeshArtwork", {});
  const {pipeline, layout} = meshPipeline(device, renderer.format, samples), owned = [];
  const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
    // Every source array has four-byte elements, as writeBuffer requires.
    const b = device.createBuffer({size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST});
    owned.push(b); if (data.byteLength) device.queue.writeBuffer(b, 0, data); return b;
  };
  let texture;
  try {
    texture = target?.texture ?? device.createTexture({label, size: [width, height], format: renderer.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
    const range = Math.max(1e-8, source.zMax - source.zMin);
    const uniforms = buffer(new Float32Array([bounds.x, bounds.y, width / pixelScale, height / pixelScale, source.zMin, range, 0, 0]), GPUBufferUsage.UNIFORM);
    const bindGroup = device.createBindGroup({layout, entries: [uniforms, buffer(source.positions), buffer(source.depth), buffer(source.triangles), buffer(source.materials), buffer(source.palette)]
      .map((b, binding) => ({binding, resource: {buffer: b}}))});
    const antialias = samples > 1 ? device.createTexture({label: `${label} antialiasing`, size: [width, height], sampleCount: samples, format: renderer.format, usage: GPUTextureUsage.RENDER_ATTACHMENT}) : null;
    const depth = device.createTexture({label: `${label} depth`, size: [width, height], sampleCount: samples, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT});
    if (antialias) owned.push(antialias); owned.push(depth);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{view: (antialias ?? texture).createView(), ...(antialias ? {resolveTarget: texture.createView()} : {}), clearValue: {r: 0, g: 0, b: 0, a: 0}, loadOp: 'clear', storeOp: antialias ? 'discard' : 'store'}],
      depthStencilAttachment: {view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard'}});
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(source.count * 3); pass.end();
    return {texture, bindGroup: target?.bindGroup ?? renderer.textureBindGroup(texture), width, height, bytes: width * height * 4,
      cleanup: () => { for (const resource of owned.splice(0)) resource.destroy(); }};
  } catch (error) {
    if (!target?.texture) texture?.destroy();
    for (const resource of owned) resource.destroy();
    throw error;
  }
}

export function rasterizeMeshGroup(renderer, spec) {
  const encoder = renderer.device.createCommandEncoder({label: 'Figure mesh artwork'});
  const raster = encodeMeshRaster(renderer, encoder, spec);
  try { renderer.device.queue.submit([encoder.finish()]); return raster; }
  catch (error) { raster.texture.destroy(); throw error; }
  finally { raster.cleanup(); }
}
