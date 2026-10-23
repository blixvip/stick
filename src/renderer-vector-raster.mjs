import {messageError} from './localized-error.mjs';
import {SHAPE_BYTES, SHAPE_FLOATS, requiresCompatibilityTexture} from './renderer-geometry.mjs';
import {hasDrawableVfx} from './vfx-canvas.mjs';

/** Native opaque outlines paint every expanded silhouette before the original
 * primitives. Straight strokes and white-backed/filled circles can express
 * that exact order with the existing vector isolation painter. Other native
 * features retain Canvas; especially hollow rings and translucent outlines. */
export function nativeOutlineVectorItems(items,resolution){
  const style=items[0]?.fig?.segment_decode?.global_style;
  if(!style?.u28||style.u30)return null;
  const width=new Float32Array(new Uint32Array([style.u28]).buffer)[0];
  if(!(width>0&&Number.isFinite(width)))return null;
  for(const item of items){
    if(item.fig?.segment_decode?.global_style!==style||item.opacity!==1||item.alpha!==1||
      item._movieclipOwner||item._movieclipInner||hasDrawableVfx(item)||item.seg?.secondary||item.seg?.paint||
      !(item.thickness>=0)||item.thickness>0&&item.thickness*resolution<2)return null;
    if(item.type==='line'){if(item.points.length!==2)return null;}
    else if(item.type==='circle'){if(!['circle','circleFill'].includes(item.seg.segment_kind)||Math.abs(item.length)*resolution<2)return null;}
    else return null;
  }
  return [...items.map(item=>({...item,rgb:style.rgb,alpha:1,thickness:item.thickness+2*width*Math.abs(item.obj.scale??1),
    ...(item.type==='circle'?{seg:{...item.seg,segment_kind:'circleFill'}}:{})})),...items];
}

/** Subpixel strokes retain native Canvas coverage. Repeated translucent hairlines
 * amplify even small antialiasing differences in a composited effect. */
export function supportsVectorIsolation(items, resolution) {
  return !requiresCompatibilityTexture(items) && isolationStrokeFits(isolationStroke(items), resolution);
}
/** The narrowest stroke or disc that decides supportsVectorIsolation(): every
 * primitive fits at a resolution exactly when this one does. It depends only on
 * the immutable drawables, so callers can compute it once per artwork. */
export function isolationStroke(items) {
  let narrowest = Infinity;
  for (const s of items) {
    if (s.type === 'line') { if (!(s.thickness <= 0)) narrowest = Math.min(narrowest, s.thickness); }
    else if (s.type === 'circle') narrowest = Math.min(narrowest, Math.abs(s.length), s.seg.segment_kind === 'circleFill' ? Infinity : s.thickness);
  }
  return narrowest;
}
export const isolationStrokeFits = (narrowest, resolution) => narrowest === Infinity || narrowest * resolution >= 2;

/** Lines, square-ended lines and circles compute their own antialiased
 * coverage in the fragment shader, and their quads extend past that coverage.
 * Multisampling such a group only allocates and resolves identical samples;
 * triangles, rectangles and textures still need their multisampled edges. */
export function analyticCoverage(data) {
  for (let i = SHAPE_FLOATS - 4; i < data.length; i += SHAPE_FLOATS) {
    const kind = data[i];
    if (kind !== 0 && kind !== 1 && kind !== 2 && kind !== -1) return false;
  }
  return true;
}

/** Composite an opaque vector group before applying its figure opacity. The
 * result has the same lifetime as any other cached compatibility texture. */
export function rasterizeVectorGroup(renderer, spec) {
  const device = renderer.device;
  const encoder = device.createCommandEncoder({label: 'Composite isolated vector artwork'});
  let raster;
  try {
    raster = encodeVectorRaster(renderer, encoder, spec);
    device.queue.submit([encoder.finish()]);
    return raster;
  } catch (error) { raster?.texture.destroy(); throw error; }
  finally {
    // Submitted commands retain their resources until GPU execution completes.
    // No scratch allocation is kept in the editor or packet caches.
    raster?.cleanup();
  }
}

/** Records one isolation raster into a shared command encoder. Callers submit
 * the encoder once for a whole batch, then run every returned cleanup — the
 * submitted commands retain their scratch buffers until GPU execution
 * completes. The texture and bind group outlive the cleanup.
 * `target` reuses an exact-sized texture with its original sampling grid.
 * `msaa` shares one matching attachment across a batch — passes
 * execute in submission order, so serial reuse stays correct. */
export function encodeVectorRaster(renderer, encoder, {data, width, height, pixelScale, bounds, root, target, msaa, viewport, scratch}) {
  const device = renderer.device;
  if (!(data instanceof Float32Array) || data.length % SHAPE_FLOATS ||
    data.byteLength > device.limits.maxStorageBufferBindingSize || !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D ||
    !Number.isFinite(pixelScale) || pixelScale <= 0) throw messageError(new TypeError(''), "errors.rendererVectorRaster.invalidIsolatedVectorArtwork", {});
  const targetWidth = target?.width ?? width, targetHeight = target?.height ?? height;
  const viewportWidth = viewport?.[0] ?? targetWidth, viewportHeight = viewport?.[1] ?? targetHeight;
  const shapeBytes = Math.max(SHAPE_BYTES, data.byteLength);
  // Queued writes execute after earlier submits, so pooled scratch buffers are
  // reusable as soon as their previous batch is submitted.
  const scratchKey = 2 ** Math.ceil(Math.log2(shapeBytes));
  let texture, ownedMsaa, uniform, shapes, transforms;
  try {
    texture = target?.texture ?? device.createTexture({label: 'Isolated vector artwork', size: [targetWidth, targetHeight], format: renderer.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
    const single = Boolean(renderer.isolationSinglePipeline) && analyticCoverage(data);
    const samples = single ? 1 : renderer.isolationSamples;
    if (!msaa && samples > 1) ownedMsaa = device.createTexture({label: 'Isolated vector antialiasing', size: [targetWidth, targetHeight], sampleCount: samples,
      format: renderer.format, usage: GPUTextureUsage.RENDER_ATTACHMENT});
    const antialias = single ? null : msaa || ownedMsaa;
    uniform = scratch?.uniform.pop() ?? device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    shapes = scratch?.shapes.get(scratchKey)?.pop() ?? device.createBuffer({size: scratchKey, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    transforms = scratch?.transforms.pop() ?? device.createBuffer({size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(uniform, 0, new Float32Array([
      pixelScale, 0, -(bounds.x-root.x)*pixelScale, pixelScale,
      0, pixelScale, -(bounds.y-root.y)*pixelScale, 0, viewportWidth, viewportHeight, 1, 1, 0, 0, viewportWidth, viewportHeight]));
    device.queue.writeBuffer(shapes, 0, data);
    device.queue.writeBuffer(transforms, 0, new Float32Array([0, 0, 1, 1]));
    const bindings = device.createBindGroup({layout: renderer.globalLayout, entries: [
      {binding: 0, resource: {buffer: uniform}}, {binding: 1, resource: {buffer: shapes}}, {binding: 2, resource: {buffer: transforms}}]});
    const pass = encoder.beginRenderPass({colorAttachments: [{view: (antialias || texture).createView(),
      ...(antialias ? {resolveTarget: texture.createView()} : {}), clearValue: {r: 0, g: 0, b: 0, a: 0}, loadOp: 'clear', storeOp: antialias ? 'discard' : 'store'}]});
    pass.setPipeline(single ? renderer.isolationSinglePipeline : renderer.isolationPipeline); pass.setBindGroup(0, bindings); pass.setBindGroup(1, renderer.blankBindGroup);
    pass.draw(6, data.length / SHAPE_FLOATS); pass.end();
    const recycle = buffer => { if (buffer) buffer.destroy(); };
    const cleanup = scratch ? () => {
      ownedMsaa?.destroy();
      if (uniform) { scratch.uniform.push(uniform); uniform = null; }
      if (shapes) { let list = scratch.shapes.get(scratchKey); if (!list) scratch.shapes.set(scratchKey, list = []); list.push(shapes); shapes = null; }
      if (transforms) { scratch.transforms.push(transforms); transforms = null; }
    } : () => { ownedMsaa?.destroy(); recycle(uniform); recycle(shapes); recycle(transforms); };
    return {texture, bindGroup: target?.bindGroup ?? renderer.textureBindGroup(texture), width, height, bytes: targetWidth*targetHeight*4, cleanup};
  } catch (error) {
    if (!target?.texture) texture?.destroy(); ownedMsaa?.destroy(); uniform?.destroy(); shapes?.destroy(); transforms?.destroy();
    throw error;
  }
}
