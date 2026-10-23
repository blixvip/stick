import {messageError, errorMessageData} from './localized-error.mjs';
import {vectorVfxSource,rasterizeVectorVfx,canvasVfxSource,filterArtworkVfx} from './renderer-vfx-vector.mjs';
import {connectedVfxGeometry} from './vfx-connected.mjs';
import {parallaxResolver} from './layer-parallax.mjs';
import {rasterBounds,rasterCovers,rasterViewport,gestureProxyResolution,gestureStandIn} from './raster-view.mjs';
import {canvasCoverageBounds,canvasBoundsOutside,canvasArtworkCropSafe,canvasArtworkPlan,canvasArtworkPlanWithin,canvasGestureStandIn,canvasLayerBounds} from './renderer-canvas-plan.mjs';
import {canvasPaint} from './paint.mjs';
import {GpuTiming,requestInstrumentedDevice} from './gpu-timing.mjs';
import {gpuStartupBudget} from './gpu-startup.mjs';
import {normalizeMsaaCount, viewportBackingSize} from './preview-quality.mjs';
import {ViewportVfx,hasSceneVfx} from './vfx-viewport.mjs';
import {CameraVfx,cameraSceneCovers} from './vfx-camera.mjs';
import {initVfxDevice,releaseVfxDevice} from './vfx-gpu.mjs';
import {hasDrawableVfx,vfxRasterScale,drawableVfxPadding,configureVfxSoftwareResources} from './vfx-canvas.mjs';
import {fitsVfxSurface} from './vfx-surface.mjs';
import {vfxPreviewOptions,vfxPreviewGeometry} from './vfx-preview.mjs';
import { buildGeometry, buildGeometrySteps, drawGeometry, releaseGeometryResources } from './pivot/geometry.mjs';
import { drawBackground, backgroundBounds, sceneBackgroundColor, effectiveCamera,releaseBackgroundResources } from './pivot/background.mjs';
import { SHAPE, SHAPE_BYTES, SHAPE_FLOATS, shapeRecord, compileVectorObject, compileVectorObjectSteps, requiresCompatibilityTexture, adoptPreparedVectors, objectBounds, cameraMatrix, argbFloats, textureBucket, textureRegion, rasterResolution } from './renderer-geometry.mjs';
import { PreparedFrameCache } from './prepared-frames.mjs';
import { RasterSurfacePool } from './raster-surfaces.mjs';
import { EditorRasterCache } from './renderer-raster-cache.mjs';
import {previewMemoryPlan} from './playback-budget.mjs';
import { composeSceneGroups } from './scene-order.mjs';
import {OnionComposite} from './renderer-onion-composite.mjs';
import {OnionSurfaceCache, onionLayerEnd, onionLayerKeys} from './onion-surface-cache.mjs';
import {CanvasRasterRefinement} from './canvas-raster-refinement.mjs';
import {canRefineDrawingItems} from './renderer-preview-drawings.mjs';
import { HandleRenderer } from './renderer-handles.mjs';
import {opacityArtwork} from './renderer-opacity.mjs';
import {rasterizeVectorGroup, supportsVectorIsolation,nativeOutlineVectorItems} from './renderer-vector-raster.mjs';
import {meshOnlyItems, meshRasterSource, rasterizeMeshGroup} from './renderer-mesh-raster.mjs';
import { ArtworkRegistry } from './render-artwork.mjs';
import {glyphTextureDescriptor,drawGlyphMask,glyphTextureShape} from './renderer-glyphs.mjs';
import { uploadShapeLayoutSteps, SHAPE_UPLOAD_RECORDS } from './renderer-upload.mjs';
import { backgroundImageAssets, frameImageAssets, createSceneImages, consumeSceneSteps } from './scene-preparation.mjs';
import {drawingMatrix,drawingPixelMatrix,drawingMetadata} from './drawing-model.mjs';
import {drawingRasterInputs,drawingRasterKey,changedDrawingRaster,sameDrawingRaster,publishedDrawingRasterInputs} from './drawing-render-dependencies.mjs';
import {DrawingGpu,gpuDrawingEligible} from './drawing-gpu.mjs';
import {GeneratorGpu} from './vfx-generator-gpu.mjs';
import {prewarmAtlas} from './vfx-generator-atlas.mjs';
import {drawGeneratorDraws} from './vfx-generator-canvas.mjs';
import {generatorBatchFor,budgetedGeneratorBatch,offsetGeneratorBatch,generatorSchedule,scheduleWalker,SOFTWARE_PARTICLE_BUDGET,INTERACTIVE_SAMPLING_MS} from './vfx-generator-frame.mjs';
export { cameraMatrix, worldToScreen, screenToWorld } from './renderer-geometry.mjs';
// Compatibility rasters can contain several drawing cels or drawing effects.
// Track decoded/preview inputs, never hash tile blobs or invalidate unrelated artwork.
function drawingAlpha(item){
  let alpha=item.alpha*(item.opacity??1)*(item._movieclipOwner?.opacity??1);
  for(let inner=item._movieclipInner;inner;inner=inner.inner)alpha*=inner.owner.opacity;
  return alpha;
}
function renderPreviewVfx(renderer,field,create,render) {
  if(performance.now()<renderer.vfxRetryAt)return false;
  try {
    const started=renderer.measureFrame?performance.now():0;
    renderer[field]??=create();render(renderer[field]);
    if(renderer.measureFrame)(renderer.telemetryStages??={}).vfx=performance.now()-started;
    if(renderer.vfxRetryAt){renderer.options.onRecovery?.('vfx','recovered');renderer.options.onStatus?.({backend:renderer.stats.backend,message:'Camera effects preview restored.',messageKey:'rendererStatus.effectsRestored'});}
    renderer.vfxRetryAt=0;return true;
  }
  catch(error){
    // The unfiltered scene is already visible. Release failed effect surfaces
    // and leave editing available while a later frame retries the preview.
    renderer.vfxRetryAt=performance.now()+1500;
    renderer.options.onRecovery?.('vfx','started');
    try {renderer[field]?.destroy();} catch { /* A lost device may already be released. */ }
    renderer[field]=null;renderer.stats.vfxFailures=(renderer.stats.vfxFailures||0)+1;
    const failure=error instanceof Error?error:messageError(new Error(''), "errors.renderer.theCameraEffectsPreviewFailed", {});
    failure.telemetryStage??='prepare';
    renderer.options.onStatus?.({backend:renderer.stats.backend,message:'Camera effects preview unavailable. Showing the scene without camera effects while retrying.',messageKey:'rendererStatus.effectsUnavailable'});
    if(renderer.options.onError)renderer.options.onError(failure);else globalThis.reportError?.(failure);
    return false;
  }
}
function editorBackgroundColor(options) {
  const color=options.editorBackgroundColor;
  if(color===undefined||color===null)return undefined;
  if(!Number.isInteger(color)||color<0||color>0xffffffff)throw messageError(new Error(''), "errors.renderer.editorBackgroundMustBeAnArgbColor", {});
  return color;
}

const SHADER = /* wgsl */ `
struct Globals { row0: vec4f, row1: vec4f, viewport: vec4f, clip: vec4f }
struct Shape { a: vec4f, b: vec4f, color: vec4f, color2: vec4f, gradient: vec4f, info: vec4f }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var<storage, read> transforms: array<vec4f>;
@group(1) @binding(0) var imageSampler: sampler;
@group(1) @binding(1) var imageTexture: texture_2d<f32>;
// Everything constant across a shape travels as flat varyings: fragments read
// no storage buffers, and the artboard clip point is rotated per vertex (an
// affine map, so interpolation reproduces the per-pixel rotation).
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) localUv: vec4f,
  @location(1) clipPoint: vec2f,
  @location(2) @interpolate(flat) a: vec4f,
  @location(3) @interpolate(flat) color: vec4f,
  @location(4) @interpolate(flat) color2: vec4f,
  @location(5) @interpolate(flat) gradient: vec4f,
  // radius, inner radius, figure opacity, clip-to-artboard flag
  @location(6) @interpolate(flat) params: vec4f,
  @location(7) @interpolate(flat) kind: i32,
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let shape = shapes[instance];
  let transform = transforms[u32(shape.info.y)];
  var corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let uv = corners[vertex];
  let kind = i32(shape.info.x);
  var output: VertexOut;
  // Disabled records and hidden figures rasterize nothing.
  if (kind < 0 || transform.w < 0.5) { output.position = vec4f(2, 2, 0, 1); output.kind = -1; return output; }
  var p = vec2f(0);
  let aa = 1.1 / max(globals.row0.w * globals.viewport.z, 0.0001);
  if (kind == 0 || kind == 2) {
    let delta = shape.a.zw - shape.a.xy;
    let len = length(delta);
    let direction = select(vec2f(1,0), delta / max(len, 0.0001), len > 0.0001);
    let normal = vec2f(-direction.y, direction.x);
    let radius = shape.b.z + aa;
    p = shape.a.xy + direction * (uv.x * (len + 2.0 * radius) - radius) + normal * ((uv.y * 2.0 - 1.0) * radius);
  } else if (kind == 1) {
    p = shape.a.xy + (uv * 2.0 - 1.0) * (shape.b.z + aa);
  } else if (kind == 3) {
    p = shape.b.xy;
    if (vertex == 0u) { p = shape.a.xy; }
    if (vertex == 1u) { p = shape.a.zw; }
  } else if (kind == 7 || kind == 9) {
    p = shape.a.xy + shape.b.xy * uv.x + shape.b.zw * uv.y;
  } else {
    p = mix(shape.a.xy, shape.a.zw, uv);
  }
  let world = p + transform.xy;
  let screen = vec2f(dot(globals.row0.xyz, vec3f(world,1)), dot(globals.row1.xyz, vec3f(world,1)));
  output.position = vec4f(screen.x / globals.viewport.x * 2.0 - 1.0, 1.0 - screen.y / globals.viewport.y * 2.0, 0, 1);
  let center = (globals.clip.xy + globals.clip.zw) * 0.5;
  let angle = globals.row1.w;
  let delta = screen - center;
  output.clipPoint = center + vec2f(cos(angle)*delta.x+sin(angle)*delta.y,-sin(angle)*delta.x+cos(angle)*delta.y);
  output.localUv = vec4f(p, uv);
  output.a = shape.a;
  output.color = shape.color;
  output.color2 = shape.color2;
  output.gradient = shape.gradient;
  output.params = vec4f(shape.b.z, shape.b.w, transform.z, select(0.0, 1.0, globals.viewport.w > 0.5 || shape.info.w > 0.5));
  output.kind = kind;
  return output;
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4f {
  let kind = input.kind;
  let local = input.localUv.xy;
  let screen = input.clipPoint;
  let outsideCanvas = screen.x < globals.clip.x || screen.y < globals.clip.y || screen.x > globals.clip.z || screen.y > globals.clip.w;
  // Backgrounds stay on the artboard; editor figures can extend into the workspace.
  if (kind < 0 || (outsideCanvas && input.params.w > 0.5)) { discard; }
  let radiusB = input.params.x;
  let opacity = input.params.z;
  var coverage = 1.0;
  var distance = -1.0;
  if (kind == 0) {
    let delta = input.a.zw - input.a.xy;
    let norm = dot(delta, delta);
    let t = clamp(dot(local - input.a.xy, delta) / max(norm, 0.000001), 0.0, 1.0);
    distance = length(local - input.a.xy - delta * t) - radiusB;
  } else if (kind == 2) {
    let delta = input.a.zw - input.a.xy;
    let len = length(delta);
    let direction = select(vec2f(1,0), delta / max(len, 0.0001), len > 0.0001);
    let p = local - (input.a.xy + input.a.zw) * 0.5;
    let q = abs(vec2f(dot(p, direction), dot(p, vec2f(-direction.y, direction.x)))) - vec2f(len * 0.5 + radiusB, radiusB);
    distance = length(max(q, vec2f(0))) + min(max(q.x,q.y),0.0);
  } else if (kind == 1) {
    let radius = length(local - input.a.xy);
    distance = radius - radiusB;
    if (input.params.y > 0.0) { distance = max(distance, input.params.y - radius); }
  }
  let edge = max(fwidth(distance), 0.00001);
  if (kind <= 2) { coverage = clamp(0.5 - distance / edge, 0.0, 1.0); }
  var t = clamp(dot(local - input.gradient.xy, input.gradient.zw), 0.0, 1.0);
  if (kind == 6) { t = clamp((length(local - input.gradient.xy) - input.gradient.z) / max(input.gradient.w - input.gradient.z, 0.0001), 0.0, 1.0); }
  var color = mix(input.color, input.color2, t);
  if (kind == 7) {
    let alpha = textureSampleLevel(imageTexture, imageSampler, input.localUv.zw, 0.0).a * color.a * opacity;
    return vec4f(color.rgb * alpha, alpha);
  }
  if (kind == 4 || kind == 8 || kind == 9) {
    var uv = input.localUv.zw;
    if (kind == 8) { uv = (local - input.gradient.xy) * input.gradient.zw; }
    // Pooled artwork uses the top-left of a larger texture: scale, then clamp
    // to the last used texel centre so unused texels never filter in.
    if (kind == 4 && input.gradient.z > 0.0) { uv = min(uv * input.gradient.zw, input.gradient.xy); }
    let texel = textureSampleLevel(imageTexture, imageSampler, clamp(uv, vec2f(0), vec2f(1)), 0.0);
    // copyExternalImageToTexture uses premultiplied textures; preserve that convention.
    return texel * (color.a * opacity);
  }
  let alpha = color.a * coverage * opacity;
  return vec4f(color.rgb * alpha, alpha);
}`;

const pow2 = n => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const uidOf = g => g?.obj?.unique_id ?? g?.slot;
function createResources(options, invalidate) {
  const images = new Map(), watched = new WeakSet(),tints=new Map();let tintBytes=0;
  const watch = image => {
    if (image && !image.complete && !image.previewInvalidationManaged && !watched.has(image)) {
      watched.add(image); image.addEventListener('load', invalidate, { once: true }); image.addEventListener('error', invalidate, { once: true });
    }
    return image;
  };
  const resources = {
    drawing: options.resources?.drawing,
    backgroundBytes:options.resources?.backgroundBytes??options.maxBackgroundBytes??previewMemoryPlan().editorBackgrounds,
    tint(image,rgb,stamp=0){
      const key=rgb.join(',')+':'+stamp;let hit=tints.get(image);
      if(hit?.key===key)return hit.canvas;
      if(hit){tintBytes-=hit.bytes;tints.delete(image);hit.canvas.width=hit.canvas.height=1;}
      const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height,bytes=width*height*4;
      while(tints.size&&tintBytes+bytes>32*1024*1024){const [source,old]=tints.entries().next().value;tintBytes-=old.bytes;old.canvas.width=old.canvas.height=1;tints.delete(source);}
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);ctx.globalCompositeOperation='source-in';ctx.fillStyle=`rgb(${rgb.join(',')})`;ctx.fillRect(0,0,width,height);
      canvas.complete=true;canvas.naturalWidth=width;canvas.naturalHeight=height;tints.set(image,{key,canvas,bytes});tintBytes+=bytes;return canvas;
    },
    url: options.resources?.url ?? (asset => asset?.asset_url || asset?.data_url || asset?.asset_path_relative || asset?.asset_path || null),
    image: options.resources?.image ? (url => watch(options.resources.image(url))) : (url => {
      if (!url) return null;
      if (images.has(url)) return images.get(url);
      const image = new Image(); image.decoding = 'async';
      images.set(url, image); image.src = url; return watch(image);
    }),
    clear: () => {images.clear();for(const t of tints.values())t.canvas.width=t.canvas.height=1;tints.clear();tintBytes=0;},
  };
  return resources;
}

function canvasRasterViewport(ctx,dx=0,dy=0){
  const m=ctx.getTransform(),view=rasterViewport([m.a,m.b,m.c,m.d,m.e,m.f],ctx.canvas.width,ctx.canvas.height);
  return view&&{...view,x:view.x-dx,y:view.y-dy};
}
function cachedArtworkBounds(renderer,g,items){
  renderer.boundsCache??=new WeakMap();
  let entry=renderer.boundsCache.get(g);
  if(!entry||entry.items!==items||entry.generation!==renderer.generation||changedDrawingRaster(entry.drawingInputs)){
    const bounds=objectBounds(items,renderer.resources);
    entry={items,generation:renderer.generation,bounds,drawingInputs:drawingRasterInputs(items,renderer.resources)};
    renderer.boundsCache.set(g,entry);
  }
  return entry.bounds;
}
function cachedCanvasCoverage(renderer,g,items){
  cachedArtworkBounds(renderer,g,items);
  const entry=renderer.boundsCache.get(g);
  if(!('coverage' in entry))entry.coverage=canvasCoverageBounds(items,entry.bounds);
  return entry.coverage;
}
function releaseCanvasArtwork(item,{retainScratch=false}={}){
  if(!item)return;
  if(!retainScratch)item.release?.();
  item.bitmap?.close();if(item.canvas&&!retainScratch)item.canvas.width=item.canvas.height=1;item.destroyed=true;
}
/** A Canvas fallback is explicit and never advertised as hardware WebGPU rendering. */
class CanvasFallback {
  constructor(canvas, options, reason) {
    // Keep the compatibility surface independent of the failed GPU backend.
    this.canvas = canvas; this.context = canvas.getContext('2d', {willReadFrequently: true}); this.options = options;
    if (!this.context) throw messageError(new Error(''), "errors.renderer.theCompatibilityCanvasIsUnavailable", {});
    configureVfxSoftwareResources(this.context,{maxBytes:options.maxSoftwareFilterBytes??previewMemoryPlan().editorSoftwareFilters});
    this.stats = { backend: 'Canvas 2D fallback', reason, drawCalls: 0, primitives: 0, frameMs: 0, objects: 0, textureObjects: 0 };
    this.onionArtwork = new Map(); this.onionArtworkBytes = 0;
    this.onionBudget = options.onionCache?.maxBytes ?? previewMemoryPlan().editorOnions;
    this.onionLayers = new OnionSurfaceCache({maxBytes: this.onionBudget / 2,
      maxEntries: options.onionCache?.maxEntries ?? 24,
      create: (w,h) => new OffscreenCanvas(w,h), dispose: canvas => {canvas.width=canvas.height=1;}});
    // Unchanged live objects rasterize once into a bounded bitmap cache instead
    // of re-stroking every primitive on each repaint, like the onion path.
    this.artwork = new Map(); this.artworkBytes = 0;
    if(options.asyncArtwork!==false&&typeof Worker!=='undefined'){
      this.refinement=new CanvasRasterRefinement({worker:options.rasterWorker,
        onInvalidate:()=>options.onInvalidate?options.onInvalidate():this.last&&this.render(this.last),
        onError:error=>{this.stats.lastRefinementError=error.message;
          if(options.onInvalidate)options.onInvalidate();else if(this.last)this.render(this.last);}});
      this.stats.artworkRefinement=this.refinement.stats;
    }
    // Software playback packets arrive as composited artboard bitmaps; copies
    // outlive CPU packet eviction so presentation is one drawImage per tick.
    this.softwarePlayback = true;
    this.prepared = new Map(); this.preparedBytes = 0;
    this.resources = createResources(options, () => { this.clearOnionArtwork(); this.clearArtwork(); releaseBackgroundResources(this.context);if(this.vfxCamera)this.vfxCamera.frame=null; if (this.last) this.render(this.last); options.onInvalidate?.(); });
    this.onContextLost = () => { this.contextLost = true; this.clearOnionArtwork(); this.clearArtwork(); this.clearPreparedFrames(); releaseGeometryResources(this.context); };
    this.onContextRestored = () => {
      if (this.destroyed) return;
      this.contextLost = false;
      // Restoration clears the backing pixels. An idle editor has no pending
      // animation frame, so explicitly repaint the latest document and view.
      if (this.last) this.render(this.last);
      options.onInvalidate?.();
    };
    canvas.addEventListener?.('contextlost', this.onContextLost);
    canvas.addEventListener?.('contextrestored', this.onContextRestored);
    this.resize(canvas.clientWidth || 1, canvas.clientHeight || 1, globalThis.devicePixelRatio || 1);
  }
  resize(width, height, dpr = 1) { this.refinement?.cancel();this.refinementContext=null;this.clearSceneLayers();releaseGeometryResources(this.context);this.width = Math.max(1, width); this.height = Math.max(1, height); this.dpr = dpr; this.canvas.width = Math.max(1, Math.round(this.width * dpr)); this.canvas.height = Math.max(1, Math.round(this.height * dpr)); }
  get artworkRefining(){return Boolean(this.refinement?.pending);}
  whenArtworkReady(){return this.refinement?.whenReady()??Promise.resolve();}
  cancelArtworkRefinement(){this.refinement?.cancel();this.refinementContext=null;}
  prepareInitialScene(options) { return prepareInitialScene(this, options); }
  activatePreparedScene(prepared, options) { return activatePreparedScene(this, prepared, options); }
  /** A decoded image batch replaces only artwork that paints one of its URLs.
   * Clearing every raster instead re-rasterized all figures and onion skins,
   * with their effects, each time zooming crossed an image decode scale. */
  invalidateImages(changedURLs) {
    const urls = new Set(changedURLs);
    // Keys are the geometry that painted each raster; anything else (the
    // camera scene) can contain images and is replaced conservatively.
    const affected = key => !Array.isArray(key?.drawables) ||
      key.drawables.some(item => item.type === 'image' && item.asset && urls.has(this.resources.url(item.asset)));
    for (const [map, total] of [[this.artwork, 'artworkBytes'], [this.onionArtwork, 'onionArtworkBytes']])
      for (const [key, item] of map) if (affected(key)) {map.delete(key); this[total] -= item.bytes; this.refinement?.cancel(item); releaseCanvasArtwork(item);}
    // Composites, bounds and backgrounds can contain the changed pixels.
    this.boundsCache = new WeakMap(); this.lastSceneGroups = null; this.clearSceneLayers(); this.onionLayers.clear();
    releaseBackgroundResources(this.context); if (this.vfxCamera) this.vfxCamera.frame = null;
    this.clearPreparedFrames();
  }
  /** Pixels for one whole-artwork stand-in during navigation: a share of its
   * cache's allowance. Stand-ins for every visible figure or onion skin must
   * fit together, or each new one evicts another on every zoom step. */
  gestureProxyPixels(onion) {
    const budget = onion ? this.onionBudget / 2 : this.artworkBudget ?? previewMemoryPlan().editorRasters;
    return Math.max(4096, Math.min(4 * 1024 * 1024, Math.floor(budget * .75 / 4 / Math.max(1, onion ? this.onionGroupCount : this.artworkGroupCount))));
  }
  clearOnionArtwork() {
    for (const item of this.onionArtwork.values()) {this.refinement?.cancel(item);releaseCanvasArtwork(item);}
    this.onionArtwork.clear(); this.onionArtworkBytes = 0;
    this.onionLayers.clear();
    for (const key of ['onionSurface','onionLayerScratch']) {
      if(this[key])this[key].width=this[key].height=1;
      this[key]=null;
    }
    this.stats.onionCacheBytes = this.stats.onionCompositeBytes = 0;
  }
  clearArtwork() {
    this.refinement?.cancel();this.refinementContext=null;
    for (const item of this.artwork.values()) releaseCanvasArtwork(item);
    this.artwork.clear(); this.artworkBytes = 0;
    this.boundsCache=new WeakMap();
    this.lastSceneGroups=null;
    this.clearSceneLayers();
  }
  clearSceneLayers() {
    for (const surface of [this.sceneLayers?.below, this.sceneLayers?.above]) if (surface) {
      releaseGeometryResources(surface.canvas.getContext('2d'));surface.canvas.width = surface.canvas.height = 1;
    }
    this.sceneLayers = null;
    this.stats.sceneLayerBytes=0;
  }
  // The bitmap inside a software packet belongs to the CPU packet pool; the
  // prepared entry owns a same-size copy so LRU eviction cannot close pixels
  // that a later tick still presents.
  prepareFrame(packet, { report } = {}) {
    if (this.destroyed || this.contextLost || this.context.isContextLost?.()) return null;
    const source = packet?.compatibility?.[0]?.bitmap;
    if (!packet?.softwareFrames || !source) return null;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(source.width, source.height) : this.canvas.ownerDocument.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    const entry = { canvas, report, cameraEnabled: packet.cameraEnabled !== false,
      hiddenKey: packet.hiddenKey || '', uids: packet.uids, bytes: source.width * source.height * 4 };
    const old = this.prepared.get(packet.key);
    if (old) { this.prepared.delete(packet.key); this.preparedBytes -= old.bytes; old.canvas.width = 1; old.canvas.height = 1; }
    this.prepared.set(packet.key, entry); this.preparedBytes += entry.bytes;
    while (this.prepared.size > 120 || this.preparedBytes > previewMemoryPlan().gpuFrames) {
      const key = this.prepared.keys().next().value, item = this.prepared.get(key);
      this.prepared.delete(key); this.preparedBytes -= item.bytes; item.canvas.width = 1; item.canvas.height = 1;
    }
    Object.assign(this.stats, { preparedFrames: this.prepared.size, preparedBytes: this.preparedBytes });
    return packet.key;
  }
  hasPreparedFrame(key) { return this.prepared.has(String(key)); }
  preparedEntry(key, {report,hiddenUids,dragTranslations,cameraEnabled=true,hiddenKey=''}={}) {
    const entry = this.prepared.get(String(key));
    if (!entry || this.destroyed || this.contextLost || entry.report !== report) return null;
    if (entry.cameraEnabled !== (cameraEnabled !== false)) return null;
    // The bitmap baked a visibility signature. Any difference re-renders live.
    if (entry.hiddenKey !== (hiddenKey || '')) return null;
    if (hiddenUids?.has && entry.uids) for (const uid of entry.uids) if (hiddenUids.has(uid)) return null;
    if (dragTranslations?.size || (dragTranslations && Object.keys(dragTranslations).length)) return null;
    return entry;
  }
  /** Borrow an admitted software frame into a caller-owned 2D presentation
   * surface. No packet copy or geometry evaluation is needed for the monitor. */
  renderPreparedInto(key, {report,view={},target,...options}={}) {
    const entry=this.preparedEntry(key,{report,...options}),ctx=target?.context;
    if(!entry||!ctx||ctx.isContextLost?.())return false;
    const dpr=target.dpr??1;
    ctx.save();
    try{
    if(target.clear!==false){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,target.width??ctx.canvas.width,target.height??ctx.canvas.height);}
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.drawImage(entry.canvas, view.x || 0, view.y || 0,
      report.canvas_width * (view.scale || 1), report.canvas_height * (view.scale || 1));
    }finally{ctx.restore();}
    this.prepared.delete(String(key)); this.prepared.set(String(key), entry);
    return true;
  }
  renderPrepared(key,options={}) {
    if(!this.renderPreparedInto(key,{...options,target:{context:this.context,dpr:this.dpr}}))return false;
    this.cancelArtworkRefinement();
    Object.assign(this.stats, { mode: 'prepared playback', frameMs: 0, drawCalls: 1, objects: 0, primitives: 0 });
    return true;
  }
  clearPreparedFrames() {
    for (const item of this.prepared.values()) { item.canvas.width = 1; item.canvas.height = 1; }
    this.prepared.clear(); this.preparedBytes = 0;
  }
  retainPreparedFrames(report, packets) {
    const keys = new Set();
    for (const packet of packets || []) keys.add(String(packet.key));
    for (const [key, item] of this.prepared) if (item.report !== report || !keys.has(key)) {
      this.prepared.delete(key); this.preparedBytes -= item.bytes; item.canvas.width = 1; item.canvas.height = 1;
    }
  }
  backgroundsReady() { return true; }
  async prepareBackgrounds() {}
  softwareRasterContext(canvas,{willReadFrequently=true}={}) {
    const context=canvas.getContext('2d',{willReadFrequently});
    if(context&&!context.isContextLost?.()){configureVfxSoftwareResources(context,{owner:this.context});return context;}
    canvas.width=canvas.height=1;this.rasterRetryAt=performance.now()+1500;
    const error=Object.assign(messageError(new Error(''), "errors.renderer.aPreviewRasterCanvasIsUnavailableDrawingDirectly", {}),{telemetryCode:'device_lost',telemetryStage:'prepare'});
    this.options.onError?.(error);
    if(!this.options.onError)globalThis.reportError?.(error);
    return null;
  }
  refinementAllowance(map,cached,bytes,budget,requiredBytes=0,onion=false){
    const target=Math.min(budget,Math.max(budget/2,bytes*2,requiredBytes));
    let used=onion?this.onionArtworkBytes:this.artworkBytes;
    for(const [oldKey,item] of map){
      if(budget-used>=target)break;
      if(item===cached||item.frame===this.artworkFrame)continue;
      map.delete(oldKey);used-=item.bytes;this.refinement.cancel(item);releaseCanvasArtwork(item);
    }
    if(onion)this.onionArtworkBytes=used;else this.artworkBytes=used;
    return Math.max(0,budget-used);
  }
  releaseCameraArtwork(camera,{repaint=false}={}){
    const entry=this.artwork.get(camera);
    if(!entry)return;
    this.refinement?.cancel(entry);this.artwork.delete(camera);this.artworkBytes-=entry.bytes;releaseCanvasArtwork(entry,{retainScratch:repaint});
  }
  createCameraVfx(){
    if(!this.refinement){const camera=new CameraVfx();configureVfxSoftwareResources(camera.context,{owner:this.context});return camera;}
    let camera;
    camera=new CameraVfx({
      getSource:()=>{const entry=this.artwork.get(camera);if(entry&&!entry.destroyed){entry.frame=this.artworkFrame;return entry;}return null;},
      releaseSource:options=>{this.refinement.cancel();this.releaseCameraArtwork(camera,options);},
      retainSource:cameraSource=>{
        const bytes=cameraSource.width*cameraSource.height*4;
        if(!this.admitArtwork(bytes))return null;
        const entry={canvas:cameraSource.canvas,bytes,frame:this.artworkFrame,cameraSource,release:()=>releaseGeometryResources(camera.context)};
        this.artwork.set(camera,entry);this.artworkBytes+=bytes;return entry;
      },
      refine:spec=>this.refineCameraArtwork(camera,spec),
    });
    configureVfxSoftwareResources(camera.context,{owner:this.context});return camera;
  }
  refineCameraArtwork(camera,{entry,target,scene,items,valid:sourceValid}){
    if(!this.refinement||!entry.deferDensity||this.last?.playing||this.last?.liveEditing)return false;
    const {width,height,signature}=target,bytes=width*height*4,budget=this.artworkBudget??previewMemoryPlan().editorRasters;
    if(bytes>budget||entry.refinementFailure===signature)return false;
    const context=this.refinementContext;
    const valid=()=>!this.destroyed&&!this.contextLost&&this.refinementContext===context&&this.vfxCamera===camera&&
      this.artwork.get(camera)===entry&&!entry.destroyed&&!this.last?.playing&&!this.last?.viewChanging&&!this.last?.liveEditing&&
      hasSceneVfx(this.last?.frame)&&sourceValid();
    return this.refinement.request(entry,{signature,items,bytes,priority:true,preflightBudget:budget,retries:1,valid,
      allowance:requiredBytes=>{
        // Native edit/play paints keep their warm scratch. End that pixel
        // lifetime only after this valid background job starts, before its
        // worker reservation can overlap it; completed source pixels stay live.
        releaseGeometryResources(camera.context,{retainCanvases:true});
        return this.refinementAllowance(this.artwork,entry,bytes,budget,requiredBytes);
      },
      capture:{width,height,scene},
      failed:()=>{entry.refinementFailure=signature;},
      install:bitmap=>{
        if(!valid()||bytes>budget-this.artworkBytes)return false;
        const {canvas,...cameraSource}=target;
        const replacement={bitmap,bytes,frame:entry.frame,cameraSource,release:entry.release};
        this.artwork.set(camera,replacement);this.artworkBytes+=bytes-entry.bytes;releaseCanvasArtwork(entry);return true;
      }});
  }
  refineArtwork(map,key,cached,items,resolution,visible,onion=false,drawingViewport=null){
    const drawingInputs=drawingViewport?publishedDrawingRasterInputs(cached.drawingInputs):cached.drawingInputs;
    if(!this.refinement||!cached.deferDensity||this.last.playing||changedDrawingRaster(drawingInputs)||
      !canRefineDrawingItems(items,this.resources))return false;
    // Unchanged covered artwork must not repay a cancelled density batch on
    // the first editing frame. Revised artwork follows the immediate path.
    if(this.last.liveEditing)return true;
    const originalBounds=cached.originalBounds??cachedArtworkBounds(this,key,items);
    const padding=items.reduce((n,item)=>Math.max(n,drawableVfxPadding(item)),0);
    const {plan,density}=drawingViewport?{plan:undefined,density:resolution}:canvasArtworkPlanWithin(originalBounds,visible,resolution,
      {safe:Boolean(cachedCanvasCoverage(this,key,items))&&canvasArtworkCropSafe(items),padding,...(onion?{maxPixels:this.gestureProxyPixels(true)}:{})});
    if(plan===null)return false;
    const bounds=plan??originalBounds;
    const pixelScale=drawingViewport?resolution:vfxRasterScale(items,bounds,Math.min(density,4096/bounds.width,4096/bounds.height));
    const width=drawingViewport?.width??Math.max(1,Math.ceil(bounds.width*pixelScale)),height=drawingViewport?.height??Math.max(1,Math.ceil(bounds.height*pixelScale)),bytes=width*height*4;
    const context=this.refinementContext,signature=drawingViewport?.signature??[resolution,bounds.x,bounds.y,width,height,pixelScale].join('|');
    if(cached.refinementFailure===signature)return false;
    const budget=onion?this.onionBudget/2:this.artworkBudget??previewMemoryPlan().editorRasters;
    if(bytes>budget)return false;
    // Dispatch happens after presentation, when every visible owner has its
    // current frame stamp. Reclaim old LRU entries before reserving scratch;
    // previous frames must not force ordinary refinement back onto the UI.
    const allowance=requiredBytes=>this.refinementAllowance(map,cached,bytes,budget,requiredBytes,onion);
    const valid=()=>!this.destroyed&&!this.contextLost&&this.refinementContext===context&&!this.last?.playing&&!this.last?.viewChanging&&
      !this.last?.liveEditing&&map.get(key)===cached&&!changedDrawingRaster(drawingInputs)&&
      (!drawingViewport||cached.latestViewportSignature===signature&&canRefineDrawingItems(items,this.resources));
    const accepted=this.refinement.request(cached,{signature,items,bytes,allowance,valid,retries:1,...(drawingViewport?{preflightBudget:budget}:{}),
      capture:{width,height,matrix:drawingViewport?.matrix??[pixelScale,0,0,pixelScale,-bounds.x*pixelScale,-bounds.y*pixelScale],
        ...(drawingViewport?{nativePadding:true}:{}),
        ...(!onion&&plan?.cropped&&items.length>=64?{clipBounds:{...bounds,guard:2/pixelScale}}:{})},
      failed:()=>{cached.refinementFailure=signature;this.clearSceneLayers();this.onionLayers.clear();},
      install:bitmap=>{
        if(!valid()||bytes>budget-(onion?this.onionArtworkBytes:this.artworkBytes))return false;
        const replacement={bitmap,resolution,bounds,drawingInputs,width:width/pixelScale,height:height/pixelScale,bytes,frame:cached.frame,
          ...(plan?.cropped?{raster:{...plan,pixelScale},originalBounds}:{}),...(drawingViewport?{drawingViewport}:{})};
        map.set(key,replacement);if(onion)this.onionArtworkBytes+=bytes-cached.bytes;else this.artworkBytes+=bytes-cached.bytes;
        releaseCanvasArtwork(cached);this.clearSceneLayers();this.onionLayers.clear();return true;
      }});
    if(accepted)cached.drawingInputs=drawingInputs;
    return accepted;
  }
  drawOnion(ctx, group, scale) {
    const viewport=canvasRasterViewport(ctx),coverage=cachedCanvasCoverage(this,group.g,group.items);
    if(canvasBoundsOutside(coverage,viewport,2/Math.max(scale,.0001))){this.stats.culledObjects++;return;}
    if(performance.now()<this.rasterRetryAt){drawGeometry(ctx,{drawables:group.items},this.resources);return;}
    let cached = this.onionArtwork.get(group.g);
    const moving=this.last?.viewChanging&&!this.last.playing,requested=rasterResolution(scale);
    if(moving&&cached)cached.deferDensity=true;
    let resolution=moving&&cached?cached.resolution:requested;
    const visible=viewport;
    const covered=!cached?.raster||rasterCovers(cached.raster,cached.originalBounds,visible);
    // Navigation shows a bounded stand-in: see drawObject.
    const proxy=moving&&(!cached||!covered),zoomingOut=Boolean(cached)&&requested<cached.resolution;
    if(!moving&&cached&&covered&&cached.resolution!==requested&&this.refineArtwork(this.onionArtwork,group.g,cached,group.items,requested,visible??canvasRasterViewport(ctx),true))resolution=cached.resolution;
    if (proxy || cached?.resolution !== resolution || changedDrawingRaster(cached?.drawingInputs) || cached?.raster&&!rasterCovers(cached.raster,cached.originalBounds,visible)) {
      this.refinement?.releaseWorkingMemory();
      if (cached) { this.refinement?.cancel(cached);this.onionArtwork.delete(group.g); this.onionArtworkBytes -= cached.bytes; releaseCanvasArtwork(cached); }
      const originalBounds = cachedArtworkBounds(this,group.g,group.items);
      const padding=group.items.reduce((n,item)=>Math.max(n,drawableVfxPadding(item)),0);
      const standIn=proxy&&canvasGestureStandIn(originalBounds,visible,requested,zoomingOut,this.gestureProxyPixels(true),padding);
      if(standIn)resolution=standIn.density;
      // Every onion skin in view must fit the onion allowance together, or
      // each repaint evicts and re-rasterizes them. Faded ghosts take the
      // density that fits; `resolution` still names the requested detail.
      const {plan,density}=standIn||canvasArtworkPlanWithin(originalBounds,visible,resolution,
        {safe:Boolean(coverage)&&canvasArtworkCropSafe(group.items),padding,maxPixels:this.gestureProxyPixels(true)});
      if(plan===null)return;
      const bounds=plan??originalBounds;
      const pixelScale = vfxRasterScale(group.items,bounds,Math.min(density, 4096 / bounds.width, 4096 / bounds.height));
      const width = Math.max(1, Math.ceil(bounds.width * pixelScale)), height = Math.max(1, Math.ceil(bounds.height * pixelScale));
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : this.canvas.ownerDocument.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const temp = this.softwareRasterContext(canvas);
      if(!temp){drawGeometry(ctx,{drawables:group.items},this.resources);return;}
      temp.setTransform(pixelScale, 0, 0, pixelScale, -bounds.x * pixelScale, -bounds.y * pixelScale);
      const drawingInputs=drawingRasterInputs(group.items,this.resources);
      drawGeometry(temp, {drawables: group.items}, this.resources);
      releaseGeometryResources(temp);
      cached = {canvas, resolution, bounds, drawingInputs, width: width / pixelScale, height: height / pixelScale, bytes: width * height * 4,
        ...(plan?.cropped?{raster:{...plan,pixelScale},originalBounds}:{}),...(proxy?{deferDensity:true}:{})};
      this.onionArtworkBytes += cached.bytes;
      this.stats.onionRasterizedObjects++;
    }
    cached.frame=this.artworkFrame;
    this.onionArtwork.delete(group.g); this.onionArtwork.set(group.g, cached);
    ctx.drawImage(cached.bitmap??cached.canvas, cached.bounds.x, cached.bounds.y, cached.width, cached.height);
    this.trimOnionArtwork();
  }
  trimOnionArtwork() {
    // Bound raster memory independently of animation length and viewport size.
    while (this.onionArtwork.size > 4096 || this.onionArtworkBytes > this.onionBudget / 2) {
      const key = this.onionArtwork.keys().next().value, item = this.onionArtwork.get(key);
      this.onionArtwork.delete(key); this.onionArtworkBytes -= item.bytes;
      this.refinement?.cancel(item);
      releaseCanvasArtwork(item);
    }
  }
  onionScratch(key) {
    const {width,height}=this.canvas;
    if(this[key]?.width!==width||this[key]?.height!==height){
      if(this[key])this[key].width=this[key].height=1;
      this[key]=new OffscreenCanvas(width,height);
    }
    return this[key];
  }
  drawOnionScene(ctx, groups, start, scale, hiddenUids, parallax) {
    const first = groups[start], matrix = ctx.getTransform();
    const end = onionLayerEnd(groups,start), cached = this.onionLayers.acquire(first.onionLayerKey ?? first.onionIndex);
    const viewChanging=Boolean(this.last?.viewChanging&&!this.last.playing);
    const valid=cached?.members?.length===end-start&&(!cached.viewChanging||viewChanging)&&
      ['a','b','c','d','e','f'].every(k=>cached.matrix[k]===matrix[k])&&!changedDrawingRaster(cached.drawingInputs)&&
      cached.members.every((member,index)=>{const group=groups[start+index],uid=group.g.obj.unique_id,depth=parallax(uid);
        return member.g===group.g&&member.opacity===group.opacity&&member.onionIndex===group.onionIndex&&
          member.hidden===Boolean(hiddenUids?.has(uid))&&member.x===depth.x&&member.y===depth.y;});
    const canvas=cached?.surface??this.onionScratch('onionLayerScratch');
    if(!valid){
      const layer=this.softwareRasterContext(canvas), scratch=this.onionScratch('onionSurface'),temp=this.softwareRasterContext(scratch);
      if(!layer||!temp)return end;
      layer.resetTransform();layer.clearRect(0,0,canvas.width,canvas.height);
      const members=[],drawingInputs=[];
      for(let from=start;from<end;){
        let to=from+1;while(to<end&&groups[to].onionIndex===groups[from].onionIndex)to++;
        temp.resetTransform();temp.clearRect(0,0,scratch.width,scratch.height);temp.setTransform(matrix);
        for(let i=from;i<to;i++){
          const group=groups[i],uid=group.g.obj.unique_id,depth=parallax(uid),hidden=Boolean(hiddenUids?.has(uid));
          members.push({g:group.g,opacity:group.opacity,onionIndex:group.onionIndex,hidden,x:depth.x,y:depth.y});if(hidden)continue;
          const inputs=drawingRasterInputs(group.items,this.resources);if(inputs)drawingInputs.push(...inputs);
          temp.save();temp.translate(depth.x,depth.y);this.drawOnion(temp,group,scale);temp.restore();
        }
        layer.globalAlpha=groups[from].opacity;layer.drawImage(scratch,0,0);this.stats.onionRenderedFrames++;from=to;
      }
      layer.globalAlpha=1;
      if(cached)Object.assign(cached,{matrix,members,drawingInputs,viewChanging});
    } else {
      for(let i=start;i<end;i++)if(i===start||groups[i].onionIndex!==groups[i-1].onionIndex)this.stats.onionFrameHits++;
    }
    ctx.save();ctx.resetTransform();ctx.globalAlpha=1;ctx.drawImage(canvas,0,0);ctx.restore();
    this.stats.onionCacheBytes=this.onionArtworkBytes+this.onionLayers.bytes;
    this.stats.onionCompositeBytes=this.onionLayers.bytes+this.canvas.width*this.canvas.height*4*
      (Number(Boolean(this.onionSurface))+Number(Boolean(this.onionLayerScratch)));
    return end;
  }
  // Live objects reuse the same bounded raster strategy as onion skins. The
  // renderSource identity survives seeks and translation-only edits, so an
  // unchanged figure is one drawImage instead of re-stroking every primitive.
  drawDrawingArtwork(ctx,group){
    const artworkView=opacityArtwork(group.g,group.items),source=artworkView.source;
    const items=source===group.g?artworkView.items:source.drawables;
    let cached=this.artwork.get(source);
    const discard=()=>{
      if(!cached)return;
      this.refinement?.cancel(cached);this.artwork.delete(source);this.artworkBytes-=cached.bytes;
      releaseCanvasArtwork(cached);cached=null;
    };
    const transform=ctx.getTransform(),{width,height}=ctx.canvas;
    // A filtered cel's native painter uses the destination's physical scale
    // and pixel origin. Bucket rasters change filter radii before resampling.
    // Keep the original painter for live edits and unsupported projections.
    if(this.last?.playing||this.last?.liveEditing||typeof OffscreenCanvas==='undefined'||performance.now()<this.rasterRetryAt||
      !items||!canRefineDrawingItems(items,this.resources)||source!==group.g&&!canRefineDrawingItems(group.items,this.resources)||width>4096||height>4096||transform.a<=0||
      transform.b!==0||transform.c!==0||transform.a!==transform.d||
      ![transform.a,transform.b,transform.c,transform.d,transform.e,transform.f].every(Number.isFinite)){
      discard();return false;
    }
    const dx=group.g.root.x-source.root.x,dy=group.g.root.y-source.root.y;
    const matrix=[transform.a,0,0,transform.d,transform.e+transform.a*dx,transform.f+transform.d*dy];
    if(!matrix.every(Number.isFinite)){discard();return false;}
    const visible=rasterViewport(matrix,width,height),signature=[width,height,...matrix].join('|');
    const drawingViewport={matrix,width,height,visible,signature};
    if(cached&&!cached.drawingViewport)discard();
    if(cached&&changedDrawingRaster(cached.drawingInputs)){
      // A derived presenter preview cannot obsolete published native pixels.
      // Keep the coarse viewport while its independent capture replaces it,
      // including preview readiness at an otherwise unchanged fitted view.
      if(this.refinement&&!changedDrawingRaster(publishedDrawingRasterInputs(cached.drawingInputs)))cached.deferDensity=true;
      else discard();
    }
    const previous=cached?.drawingViewport?.visible,epsilon=1e-7;
    const covered=previous&&visible.x+epsilon>=previous.x&&visible.y+epsilon>=previous.y&&
      visible.x+visible.width-epsilon<=previous.x+previous.width&&visible.y+visible.height-epsilon<=previous.y+previous.height;
    const moving=Boolean(this.last?.viewChanging);
    if(cached){cached.latestViewportSignature=signature;if(moving)cached.deferDensity=true;}
    if(!cached||!covered||!moving&&(cached.drawingViewport.signature!==signature||cached.deferDensity)&&
      !this.refineArtwork(this.artwork,source,cached,items,matrix[0],visible,false,drawingViewport)){
      this.refinement?.releaseWorkingMemory();discard();
      const bytes=width*height*4;
      // Reuse the existing artwork owner and admission policy. Under pressure
      // the cel keeps its ordinary direct painter without an extra surface.
      if(!this.admitArtwork(bytes))return false;
      // Keep the native image blend precision when this filtered cel later
      // overlaps other artwork; a software intermediate changes alpha rounding.
      const canvas=new OffscreenCanvas(width,height),temp=this.softwareRasterContext(canvas,{willReadFrequently:false});
      if(!temp)return false;
      const drawingInputs=drawingRasterInputs(items,this.resources),bounds=cachedArtworkBounds(this,source,items);
      try{temp.setTransform(...matrix);drawGeometry(temp,{drawables:items},this.resources);}
      catch(error){canvas.width=canvas.height=1;throw error;}
      finally{releaseGeometryResources(temp);}
      cached={canvas,resolution:matrix[0],bounds,drawingInputs,width:width/matrix[0],height:height/matrix[0],bytes,
        drawingViewport,latestViewportSignature:signature,deferDensity:moving};
      this.artworkBytes+=bytes;
      this.stats.rasterizedObjects=(this.stats.rasterizedObjects||0)+1;
    }
    cached.frame=this.artworkFrame;this.artwork.delete(source);this.artwork.set(source,cached);
    const previousMatrix=cached.drawingViewport.matrix,ratio=matrix[0]/previousMatrix[0];
    ctx.save();
    // Exact settled captures copy on the device pixel grid. Covered gestures
    // reproject those same pixels until the existing worker publishes a pose.
    ctx.setTransform(ratio,0,0,ratio,matrix[4]-ratio*previousMatrix[4],matrix[5]-ratio*previousMatrix[5]);
    ctx.drawImage(cached.bitmap??cached.canvas,0,0);ctx.restore();
    return true;
  }
  drawObject(ctx, group, scale, viewport, offsetX=0, offsetY=0) {
    const actualCoverage=cachedCanvasCoverage(this,group.g,group.items);
    const actualVisible=viewport&&{...viewport,x:viewport.x-offsetX,y:viewport.y-offsetY};
    if(canvasBoundsOutside(actualCoverage,actualVisible,2/Math.max(scale,.0001))){this.stats.culledObjects++;return;}
    const directGeometry={drawables:group.items,...(actualVisible&&group.items.length>=64?{clipBounds:{...actualVisible,guard:2/Math.max(scale,.0001)}}:{})};
    // Projected meshes change each pose. Reuse this renderer's depth surface
    // instead of creating and destroying a graphics context for every raster.
    if(group.items.some(item=>item.poly?._stykSurface?.depthTest)){drawGeometry(ctx,directGeometry,this.resources);return;}
    if(group.items.length===1&&this.resources.drawing?.(group.items[0].fig)?.store){
      if(hasDrawableVfx(group.items[0])&&this.drawDrawingArtwork(ctx,group))return;
      drawGeometry(ctx,directGeometry,this.resources);return;
    }
    const artworkView=opacityArtwork(group.g,group.items),{source,items}=artworkView;
    if (group.items.length < 4 && !group.items.some(hasDrawableVfx) || typeof OffscreenCanvas === 'undefined' || performance.now()<this.rasterRetryAt) {
      drawGeometry(ctx, directGeometry, this.resources); return;
    }
    let cached = this.artwork.get(source), retained = true;
    const moving=this.last?.viewChanging&&!this.last.playing,requested=rasterResolution(scale);
    if(moving&&cached)cached.deferDensity=true;
    let resolution=moving&&cached?cached.resolution:requested;
    let visible;
    if(viewport){
      const dx=group.g.root.x-source.root.x+offsetX,dy=group.g.root.y-source.root.y+offsetY;
      visible={...viewport,x:viewport.x-dx,y:viewport.y-dy};
    }else if(cached?.raster)visible=canvasRasterViewport(ctx,group.g.root.x-source.root.x,group.g.root.y-source.root.y);
    const covered=!cached?.raster||rasterCovers(cached.raster,cached.originalBounds,visible);
    // Navigation reached artwork its held raster does not cover. A new crop
    // at the held density grows with every zoom-out step, so show a bounded
    // stand-in until the settled view refines it (see gestureStandIn).
    const proxy=moving&&(!cached||!covered),zoomingOut=Boolean(cached)&&requested<cached.resolution;
    if(!moving&&cached&&covered&&cached.resolution!==requested&&this.refineArtwork(this.artwork,source,cached,items,requested,visible??canvasRasterViewport(ctx,group.g.root.x-source.root.x,group.g.root.y-source.root.y)))resolution=cached.resolution;
    if (proxy || cached?.resolution !== resolution || changedDrawingRaster(cached?.drawingInputs) || cached?.raster&&!rasterCovers(cached.raster,cached.originalBounds,visible)) {
      this.refinement?.releaseWorkingMemory();
      if (cached) { this.refinement?.cancel(cached);this.artwork.delete(source); this.artworkBytes -= cached.bytes; releaseCanvasArtwork(cached); }
      const originalBounds = cachedArtworkBounds(this,source,items);
      if (!(originalBounds.width > 0 && originalBounds.height > 0)) { drawGeometry(ctx, directGeometry, this.resources); return; }
      const padding=items.reduce((n,item)=>Math.max(n,drawableVfxPadding(item)),0);
      const view=visible??canvasRasterViewport(ctx,group.g.root.x-source.root.x,group.g.root.y-source.root.y);
      const standIn=proxy&&canvasGestureStandIn(originalBounds,view,requested,zoomingOut,this.gestureProxyPixels(false),padding);
      if(standIn)resolution=standIn.density;
      const plan=standIn?standIn.plan:canvasArtworkPlan(originalBounds,view,resolution,
        {safe:Boolean(cachedCanvasCoverage(this,source,items))&&canvasArtworkCropSafe(items),padding});
      if(plan===null)return;
      const bounds=plan??originalBounds;
      const pixelScale = vfxRasterScale(items,bounds,Math.min(resolution, 4096 / bounds.width, 4096 / bounds.height));
      const width = Math.max(1, Math.ceil(bounds.width * pixelScale)), height = Math.max(1, Math.ceil(bounds.height * pixelScale));
      // A scene larger than the budget must not evict rasters this frame
      // already drew: cycling through every figure made each repaint
      // rasterize the whole scene again. Opaque figures draw directly instead;
      // group opacity and effects still need an (uncached) isolated raster.
      retained = this.admitArtwork(width * height * 4);
      if (!retained && artworkView.opacity >= 1 && !group.items.some(hasDrawableVfx)) { drawGeometry(ctx, directGeometry, this.resources); return; }
      const canvas = new OffscreenCanvas(width, height);
      const temp = this.softwareRasterContext(canvas);
      if(!temp){drawGeometry(ctx,directGeometry,this.resources);return;}
      temp.setTransform(pixelScale, 0, 0, pixelScale, -bounds.x * pixelScale, -bounds.y * pixelScale);
      const drawingInputs=drawingRasterInputs(items,this.resources);
      drawGeometry(temp, { drawables: items,...(plan?.cropped&&items.length>=64?{clipBounds:{...bounds,guard:2/pixelScale}}:{}) }, this.resources);
      releaseGeometryResources(temp);
      cached = { canvas, resolution, bounds, drawingInputs, width: width / pixelScale, height: height / pixelScale, bytes: width * height * 4,
        ...(plan?.cropped?{raster:{...plan,pixelScale},originalBounds}:{}),...(proxy?{deferDensity:true}:{}) };
      if (retained) this.artworkBytes += cached.bytes;
      this.stats.rasterizedObjects = (this.stats.rasterizedObjects || 0) + 1;
    }
    if (retained) { cached.frame = this.artworkFrame; this.artwork.delete(source); this.artwork.set(source, cached); }
    ctx.save();ctx.globalAlpha*=artworkView.opacity;
    // Cached artwork remains at its source pose; compose it at the current
    // root after a translation without rasterizing the effects again.
    ctx.drawImage(cached.bitmap??cached.canvas, cached.bounds.x+group.g.root.x-source.root.x, cached.bounds.y+group.g.root.y-source.root.y, cached.width, cached.height);ctx.restore();
    if (!retained) releaseCanvasArtwork(cached);
  }
  /** Paint groups [from, to) in painter order; onion runs are never split. */
  paintGroups(ctx, groups, from, to, {scale, hiddenUids, parallax, dragTranslations, walker, frame}) {
    const visible=canvasRasterViewport(ctx);
    let primitives = 0;
    for (let i = from; i < to; i++) {
      const group = groups[i];
      if (group.isOnion) {
        if (!hasSceneVfx(frame)) {
          const end = this.drawOnionScene(ctx, groups, i, scale, hiddenUids, parallax);
          for (let j = i; j < end; j++) if (!hiddenUids?.has(groups[j].g.obj.unique_id)) primitives += groups[j].items.length;
          i = end - 1;
        }
        continue;
      }
      const uid = group.g.obj.unique_id; if (hiddenUids?.has(uid)) continue;
      walker?.object(uid);
      const move = dragTranslations?.get(uid);
      ctx.save(); ctx.globalAlpha = group.opacity; if (move) ctx.translate(move.x, move.y);
      const depth = parallax(uid); ctx.translate(depth.x, depth.y);
      this.drawObject(ctx, group, scale,visible,(move?.x||0)+depth.x,(move?.y||0)+depth.y);
      ctx.restore(); primitives += group.items.length;
    }
    return primitives;
  }
  /** During a gesture, figures whose geometry changed since the previous
   * frame or that are being translated form a live painter range; the rest
   * are composited once into a layer below and a layer above it. Layers are
   * reused while every figure outside the range is identical and the view
   * differs at most by a translation within the layer margin (panning).
   * Drawing presenter stamps identify pixel changes without new geometry. */
  sceneLayerPlan(groups, options, matrix, paint, clipArtboard) {
    const previous = this.lastSceneGroups, {hiddenUids, parallax, dragTranslations} = paint;
    if (previous?.length !== groups.length) return null;
    let first = groups.length, last = -1;
    const members = groups.map((group, i) => {
      const uid = group.g.obj.unique_id, depth = group.isOnion ? null : parallax(uid), move = group.isOnion ? null : dragTranslations?.get?.(uid);
      const hidden=Boolean(hiddenUids?.has(uid)),drawingInputs=hidden?null:drawingRasterInputs(group.items,this.resources);
      if (!group.isOnion && (group.g !== previous[i].g || move || !sameDrawingRaster(previous[i].drawingInputs,drawingInputs))) { first = Math.min(first, i); last = i; }
      return {g: group.g, opacity: group.opacity, onionIndex: group.onionIndex, hidden, x: depth?.x ?? 0, y: depth?.y ?? 0, move: move ? move.x + ',' + move.y : '',drawingInputs};
    });
    const {width, height} = this.canvas, onions = groups.some(group => group.isOnion);
    const layer = this.sceneLayers, same = (a, b) => a.g === b.g && a.opacity === b.opacity && a.onionIndex === b.onionIndex && a.hidden === b.hidden && a.x === b.x && a.y === b.y && a.move === b.move&&sameDrawingRaster(b.drawingInputs,a.drawingInputs);
    if (layer && layer.members.length===members.length && layer.report === options.report && layer.width === width && layer.height === height && layer.dpr === this.dpr &&
      layer.clip === (options.clipToCanvas !== false) && [0, 1, 2, 3].every(k => layer.matrix[k] === matrix[k]) &&
      (last < 0 || (first >= layer.first && last <= layer.last))) {
      // Whole device pixels keep a panned layer sharp; the release frame repaints exactly.
      const x = Math.round((matrix[4] - layer.matrix[4]) * this.dpr), y = Math.round((matrix[5] - layer.matrix[5]) * this.dpr);
      const inside = Math.abs(x) <= layer.margin && Math.abs(y) <= layer.margin;
      if (inside && members.every((member, i) => (i >= layer.first && i <= layer.last) || same(member, layer.members[i]))) {
        this.stats.sceneLayerReuses = (this.stats.sceneLayerReuses || 0) + 1; return {...layer, x, y};
      }
    }
    // Only a layer with nothing live (a pan) gets a margin: Canvas resamples
    // cached figures slightly differently under the offset (edges within
    // 16/255), which is invisible while the whole view moves. Layers around
    // edited figures stay pixel-exact. Onion composites are viewport-sized.
    let margin = onions || last >= 0 ? 0 : Math.min(512, Math.round(Math.max(width, height) / 4));
    const live = last >= 0 ? {first, last} : {first: groups.length, last: groups.length - 1};
    const deviceMatrix=matrix.map(value=>value*this.dpr);
    const rangeBounds=(from,to)=>{
      const bounds=[];
      for(let i=from;i<to;i++){
        const member=members[i];if(member.hidden)continue;
        if(groups[i].isOnion){bounds.push(null);continue;}
        const b=cachedCanvasCoverage(this,groups[i].g,groups[i].items);
        bounds.push(b&&{...b,x:b.x+member.x,y:b.y+member.y});
      }
      return bounds;
    };
    const belowBounds=rangeBounds(0,live.first),aboveBounds=last>=0?rangeBounds(live.last+1,groups.length):null;
    let belowRect,aboveRect,bytes;
    const budget=96*1024*1024;
    // Editing layers retain the destination origin for identical Canvas edge
    // sampling, and trim only their far extents. Pan-only layers can crop both
    // axes. Margin yields first under pressure; an oversized set paints directly.
    for(;;){
      belowRect=canvasLayerBounds(belowBounds,deviceMatrix,width,height,margin,last>=0);
      aboveRect=aboveBounds&&canvasLayerBounds(aboveBounds,deviceMatrix,width,height,margin,last>=0);
      bytes=4*(belowRect.width*belowRect.height+(aboveRect?aboveRect.width*aboveRect.height:0));
      if(bytes<=budget)break;
      if(!margin)return null;
      margin=Math.floor(margin/2);
    }
    // Reclaim obsolete allocations before growing the replacement range, so
    // moving artwork between the two ranges does not double the layer quota.
    for(const [existing,rect] of [[layer?.below,belowRect],[layer?.above,aboveRect]]){
      if(existing&&(!rect||existing.canvas.width!==rect.width||existing.canvas.height!==rect.height)){
        releaseGeometryResources(existing.canvas.getContext('2d'));existing.canvas.width=existing.canvas.height=1;
      }
    }
    let primitives = 0;
    const surface = (existing, rect, from, to) => {
      const canvas = existing?.canvas ?? new OffscreenCanvas(1, 1);
      if (canvas.width !== rect.width || canvas.height !== rect.height) { canvas.width = rect.width; canvas.height = rect.height; }
      const target = this.softwareRasterContext(canvas);
      if(!target)return null;
      target.setTransform(1, 0, 0, 1, 0, 0); target.clearRect(0, 0, canvas.width, canvas.height);
      target.translate(-rect.x, -rect.y); target.scale(this.dpr, this.dpr);
      if (options.clipToCanvas !== false) clipArtboard(target);
      target.transform(...matrix);
      primitives += this.paintGroups(target, groups, from, to, paint);
      return {canvas,bounds:rect};
    };
    const below = surface(layer?.below, belowRect, 0, live.first), above = last >= 0 ? surface(layer?.above, aboveRect, live.last + 1, groups.length) : null;
    if(!below||last>=0&&!above){for(const item of [below,above])if(item)item.canvas.width=item.canvas.height=1;return null;}
    if (!above && layer?.above) layer.above.canvas.width = layer.above.canvas.height = 1;
    this.stats.sceneLayerBuilds = (this.stats.sceneLayerBuilds || 0) + 1;
    this.stats.sceneLayerBytes=bytes;
    this.sceneLayers = {report: options.report, width, height, dpr: this.dpr, clip: options.clipToCanvas !== false, matrix: [...matrix], margin,
      members, ...live, below, above, primitives};
    return {...this.sceneLayers, x: 0, y: 0};
  }
  /** Make room for one raster by evicting only artwork not drawn this frame. */
  admitArtwork(bytes) {
    const budget = this.artworkBudget ??= previewMemoryPlan().editorRasters;
    if (bytes > budget) return false;
    for(const [key,item] of this.artwork){
      if(this.artwork.size<4096&&this.artworkBytes+bytes<=budget)break;
      if(item.frame===this.artworkFrame)continue;
      this.artwork.delete(key); this.artworkBytes -= item.bytes;
      this.refinement?.cancel(item);
      releaseCanvasArtwork(item);
    }
    return this.artwork.size<4096&&this.artworkBytes+bytes<=budget;
  }
  /** Admit against the whole visible working set, rather than evicting a
   * retained figure merely because a new figure appears earlier in painter
   * order. The existing raster map remains the only pixel owner. */
  protectVisibleArtwork(groups,{hiddenUids,parallax,dragTranslations,scale},matrix,sceneCovers=false){
    const visible=rasterViewport(matrix.map(value=>value*this.dpr),this.canvas.width,this.canvas.height),protectedItems=new Set();
    const camera=hasSceneVfx(this.last?.frame)&&this.artwork.get(this.vfxCamera);
    if(camera&&!camera.destroyed){camera.frame=this.artworkFrame;protectedItems.add(camera);}
    // Object rasters under a covering camera image are not presented: they
    // age normally, yielding their allowance to the scene capture.
    for(const group of sceneCovers?[]:groups){
      const uid=group.g.obj.unique_id;
      if(group.isOnion||hiddenUids?.has(uid))continue;
      const {source,items}=opacityArtwork(group.g,group.items),cached=this.artwork.get(source);
      if(!cached||changedDrawingRaster(cached.drawingInputs)&&
        !(cached.drawingViewport&&this.refinement&&!this.last?.playing&&!this.last?.liveEditing&&
          !changedDrawingRaster(publishedDrawingRasterInputs(cached.drawingInputs))&&canRefineDrawingItems(items,this.resources)))continue;
      const depth=parallax(uid),move=dragTranslations?.get?.(uid),dx=group.g.root.x-source.root.x+depth.x+(move?.x||0),dy=group.g.root.y-source.root.y+depth.y+(move?.y||0);
      const local=visible&&{...visible,x:visible.x-dx,y:visible.y-dy};
      if(canvasBoundsOutside(cachedCanvasCoverage(this,source,items),local,2/Math.max(scale,.0001))||
        cached.raster&&!rasterCovers(cached.raster,cached.originalBounds,local))continue;
      cached.frame=this.artworkFrame;protectedItems.add(cached);
    }
    this.stats.activeArtworkBytes=[...protectedItems].reduce((bytes,item)=>bytes+item.bytes,0);
  }
  render(options) {
    options=vfxPreviewOptions(options);
    if(options.vfxEnabled!==false&&options.frame&&options.report)options={...options,geometry:connectedVfxGeometry(options.geometry||buildGeometry(options.report,options.frame),options.frame,options.report,options.hiddenUids)};
    const projection=[...(options.frame&&options.report?cameraMatrix(options):[]),this.width,this.height,this.dpr].join('|'),previous=this.last;
    if(options.viewChanging||options.playing||options.liveEditing||previous?.geometry!==options.geometry||previous?.report!==options.report||
      this.refinementContext?.projection!==projection||previous?.artworkRevision!==options.artworkRevision){
      this.refinement?.cancel();this.refinementContext={projection};
    }
    // Editing paints keep the capture worker loaded, including after a
    // cancellation above closed it; playback never starts one.
    if(!options.playing)this.refinement?.warm();
    this.last = options; const start = performance.now(), ctx = this.context;
    if(this.vfxCamera&&!hasSceneVfx(options.frame))this.releaseCameraArtwork(this.vfxCamera);
    if (this.destroyed || this.contextLost || !ctx || ctx.isContextLost?.()) return;
    this.artworkFrame = (this.artworkFrame || 0) + 1;
    const { report, frame, view = {}, geometry = frame && (options.vfxEnabled===false?vfxPreviewGeometry(buildGeometry(report,frame)):buildGeometry(report,frame)), hiddenUids, dragTranslations } = options;
    if (this.onionReport !== report) { this.clearOnionArtwork(); this.clearArtwork(); this.clearPreparedFrames(); this.onionReport = report; }
    this.stats.onionRasterizedObjects = 0;
    this.stats.culledObjects=0;
    this.stats.onionRenderedFrames = this.stats.onionFrameHits = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!frame || !report) return;
    ctx.save(); ctx.scale(this.dpr, this.dpr);
    const clipArtboard = (target = ctx) => {const [a,b,c,d,e,f]=cameraMatrix({report,frame,view,cameraEnabled:false});target.beginPath();for(const [i,p] of [[0,0],[report.canvas_width,0],[report.canvas_width,report.canvas_height],[0,report.canvas_height]].entries()){const x=a*p[0]+c*p[1]+e,y=b*p[0]+d*p[1]+f;i?target.lineTo(x,y):target.moveTo(x,y);}target.closePath();target.clip();};
    ctx.save(); clipArtboard(); ctx.transform(...cameraMatrix(options));
    const bounds=backgroundBounds(frame, report.canvas_width, report.canvas_height, options.cameraEnabled !== false, report),editorColor=editorBackgroundColor(options);
    if(editorColor===undefined)drawBackground(ctx, report, frame, report.canvas_width, report.canvas_height, { ...this.resources, bounds });
    else {const [r,g,b,a]=argbFloats(editorColor);ctx.fillStyle=`rgba(${r*255},${g*255},${b*255},${a})`;ctx.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);}
    ctx.restore();
    if (options.clipToCanvas !== false) clipArtboard();
    ctx.transform(...cameraMatrix(options));
    const onions = (options.onionFrames || []).map(onion => ({geometry: options.vfxEnabled===false?vfxPreviewGeometry(onion.geometry||buildGeometry(report,onion.frame||onion)):connectedVfxGeometry(onion.geometry||buildGeometry(report,onion.frame||onion),onion.frame||onion,report,hiddenUids), opacity: onion.opacity, beforeUid: onion.beforeUid, showOnTop: onion.showOnTop}));
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr;
    let primitives = 0; const parallax=parallaxResolver(report,frame,options.cameraEnabled!==false);
    // Software drawing thins dense effects to a preview budget; export does not.
    const generatorBatch=offsetGeneratorBatch(budgetedGeneratorBatch(report,frame,geometry,{enabled:options.vfxEnabled!==false,budget:SOFTWARE_PARTICLE_BUDGET,budgetMs:INTERACTIVE_SAMPLING_MS}),uid=>{const depth=parallax(uid),move=dragTranslations?.get?.(uid);return {x:depth.x+(move?.x||0),y:depth.y+(move?.y||0)};});
    const generatorPlan=generatorBatch&&generatorSchedule(generatorBatch,hiddenUids);
    const walker=generatorPlan&&!generatorPlan.empty?scheduleWalker(generatorPlan,draws=>{drawGeneratorDraws(ctx,generatorBatch,draws);}):null;
    const groups = composeSceneGroups(geometry, onions, frame, report);
    this.onionGroupCount = groups.reduce((count, group) => count + Number(Boolean(group.isOnion)), 0);
    this.artworkGroupCount = groups.length - this.onionGroupCount;
    if (!onions.length) this.clearOnionArtwork();
    else this.onionLayers.begin(onionLayerKeys(groups),this.canvas.width,this.canvas.height);
    const paint = {scale, hiddenUids, parallax, dragTranslations, walker, frame};
    // The camera image clears and replaces its projected artboard. When that
    // covers the whole viewport, object artwork and generators painted here
    // would be erased unseen, so neither rasterize nor refine them. A failed
    // or backed-off camera preview paints them below as the visible fallback.
    const sceneCovers=hasSceneVfx(frame)&&performance.now()>=(this.vfxRetryAt||0)&&cameraSceneCovers({report,frame,view,cameraEnabled:options.cameraEnabled},this.dpr,this.canvas.width,this.canvas.height);
    const paintObjects=()=>{walker?.begin();const count=this.paintGroups(ctx, groups, 0, groups.length, paint);walker?.end();return count;};
    this.protectVisibleArtwork(groups,paint,matrix,sceneCovers);
    const layers = options.liveEditing && !walker && !hasSceneVfx(frame) ? this.sceneLayerPlan(groups, options, matrix, paint, clipArtboard) : null;
    if (!layers) this.clearSceneLayers();
    this.lastSceneGroups = groups.map(group => {const hidden=Boolean(hiddenUids?.has(group.g.obj.unique_id));return {g:group.g,hidden,drawingInputs:hidden?null:drawingRasterInputs(group.items,this.resources)};});
    if (layers) {
      // Unchanged figures below and above the edited ones are two cached
      // composites; a gesture repaints only its own figures.
      const blit = surface => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(surface.canvas, layers.x+surface.bounds.x, layers.y+surface.bounds.y); ctx.restore(); };
      blit(layers.below);
      primitives = layers.primitives + this.paintGroups(ctx, groups, layers.first, layers.last + 1, paint);
      if (layers.above) blit(layers.above);
    } else if(sceneCovers) for(const group of groups) {if(!group.isOnion&&!hiddenUids?.has(group.g.obj.unique_id))primitives+=group.items.length;}
    else primitives = paintObjects();
    if(generatorBatch?.incomplete)queueMicrotask(()=>this.options.onInvalidate?.());
    ctx.restore();
    if(hasSceneVfx(frame)){
      const presented=renderPreviewVfx(this,'vfxCamera',()=>this.createCameraVfx(),camera=>camera.render(ctx,{...options,geometry,generatorBatch},this.dpr,this.resources));
      ctx.save();ctx.scale(this.dpr,this.dpr);if(options.clipToCanvas!==false)clipArtboard();ctx.transform(...matrix);
      if(sceneCovers&&!presented)paintObjects();
      for(let i=0;i<groups.length;i++)if(groups[i].isOnion)i=this.drawOnionScene(ctx,groups,i,scale,hiddenUids,parallax)-1;
      ctx.restore();
    }
    Object.assign(this.stats, { objects: geometry.objects.size, primitives, drawCalls: primitives, frameMs: performance.now() - start });
    return geometry;
  }
  destroy() {
    this.destroyed = true; this.last = null;
    this.refinement?.dispose();
    this.vfxCamera?.destroy();
    this.canvas.removeEventListener?.('contextlost', this.onContextLost);
    this.canvas.removeEventListener?.('contextrestored', this.onContextRestored);
    this.clearOnionArtwork(); this.clearArtwork(); this.clearPreparedFrames(); releaseGeometryResources(this.context);
  }
}

class WebGPURenderer {
  constructor(canvas, device, context, format, options) {
    Object.assign(this, { canvas, device, context, format, options });
    this.stats = { backend: 'WebGPU', adapter: options.adapterName || 'Hardware accelerated', drawCalls: 0, primitives: 0, objects: 0, textureObjects: 0, frameMs: 0, uploadBytes: 0, cachedObjects: 0, gpuBytes: 0, warnings: [] };
    this.entries = new Map(); this.rasterCache = new EditorRasterCache(options.editorRasterCache); this.vectorCache = new WeakMap(); this.compatibilityCache = new WeakMap(); this.generation = 0; this.lastGeometry = null; this.backgroundKey = ''; this.last = null;
    this.artworks = new ArtworkRegistry();
    this.artworkAliases = new WeakMap();
    this.preparedFrames = new PreparedFrameCache(this, options.preparedCache);
    this.rasterSurfaces = new RasterSurfacePool();
    // Live drawing scratch textures persist across layout changes; the LRU
    // budget evicts the oldest only when the cap is exceeded.
    this.drawingTextureBudget = options.drawingTextureBudget ?? 96 * 1024 * 1024;
    // Weak adapters lower MSAA through setMsaa; every render pass, pipeline and
    // offscreen target reads this.msaaCount so attachments always agree.
    this.msaaCount = normalizeMsaaCount(options.msaa);
    this.stats.preparedCache = this.preparedFrames.stats;
    this.resources = createResources(options, () => { this.generation++; this.lastGeometry = null; if (this.last) this.render(this.last); options.onInvalidate?.(); });
  }
  async initialize(startup) {
    const d = this.device;
    const module = d.createShaderModule({ code: SHADER, label: 'StykAnimate signed-distance vector shader' });
    const info = await startup.wait(module.getCompilationInfo());
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) throw new Error(errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    this.globalLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ] });
    this.textureLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ] });
    this.vectorModule = module;
    this.pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.globalLayout, this.textureLayout] });
    this.pipeline = await startup.wait(this.createVectorPipeline());
    // Raster artwork keeps its original antialiasing when the viewport changes
    // MSAA level; the pipeline and sample count are an immutable pair.
    this.isolationPipeline = this.pipeline; this.isolationSamples = this.msaaCount;
    // Analytic-coverage groups need no multisampled scratch; see analyticCoverage().
    this.isolationSinglePipeline = this.msaaCount > 1 ? await startup.wait(this.createVectorPipeline(1)) : this.pipeline;
    this.uniform = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    await startup.wait(this.generatorGpu().initialize());
    this.handleRenderer = new HandleRenderer(d,this.uniform);
    await startup.wait(this.handleRenderer.initialize(this.format, this.msaaCount));
    this.sampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.nearestSampler = d.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    this.blankTexture = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.blankTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.blankBindGroup = this.textureBindGroup(this.blankTexture);
    this.ensureBuffers(1, 1);
    // Claim the canvas only after asynchronous initialization succeeds, so
    // failures/timeouts can still acquire a 2D context on the same surface.
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw messageError(new Error(''), "errors.renderer.theCanvasCouldNotCreateAWebgpuContext", {});
    this.resize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1, globalThis.devicePixelRatio || 1);
    this.device.lost.then(info => { if (!this.destroyed) { this.deviceLost = true; this.last = null; this.stats.reason = info.reason; this.stats.message = `Graphics device disconnected: ${info.message || info.reason}. Reinitialize the renderer to continue.`; this.stats.messageKey = 'rendererStatus.deviceDisconnected'; this.stats.messageParams = {detail:info.message || info.reason}; this.stats.backend = 'WebGPU device lost'; this.options.onStatus?.(this.stats); } });
    this.device.addEventListener('uncapturederror', event => { if (this.destroyed || this.deviceLost) return; this.stats.warnings.push(event.error.message); this.options.onStatus?.(this.stats); });
    initVfxDevice(this.device);
    // Drawing cels display from GPU-resident tiles. Failure keeps the canvas
    // scratch path, which remains the Canvas 2D and fallback presenter.
    if (this.options.gpuDrawing !== false) this.enableGpuDrawing();
  }
  /** GPU drawing compiles in the background; until it is ready, cels use the
   * scratch presenter and the stroke worker. `gpuDrawingReady` settles with
   * whether it became active. */
  enableGpuDrawing() {
    if (this.drawingGpu || this.gpuDrawingPending) return this.gpuDrawingReady;
    const pending = this.gpuDrawingPending = DrawingGpu.create(this);
    this.gpuDrawingReady = pending.then(gpu => {
      if (this.gpuDrawingPending !== pending || this.destroyed || this.deviceLost) { gpu.destroy(); return false; }
      this.gpuDrawingPending = null; this.drawingGpu = gpu; this.lastGeometry = null; this.options.onInvalidate?.(); return true;
    }, error => {
      if (this.gpuDrawingPending === pending) this.gpuDrawingPending = null;
      this.stats.warnings.push(`GPU drawing unavailable: ${error.message}`); return false;
    });
    return this.gpuDrawingReady;
  }
  createVectorPipeline(count = this.msaaCount) {
    return this.device.createRenderPipelineAsync({ label: 'StykAnimate vector + asset compositor', layout: this.pipelineLayout,
      vertex: { module: this.vectorModule, entryPoint: 'vs' }, fragment: { module: this.vectorModule, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
      primitive: { topology: 'triangle-list' }, multisample: { count },
    });
  }
  /** Lower or restore MSAA at runtime. Pipelines, handle passes, VFX targets
   * and the antialias texture all derive from msaaCount, so one rebuild keeps
   * every attachment consistent. */
  async setMsaa(count) {
    count = normalizeMsaaCount(count);
    const request = this.msaaRequest = (this.msaaRequest || 0) + 1;
    // Even a return to the active count cancels a pending quality change.
    if (this.destroyed || this.deviceLost || count === this.msaaCount) return false;
    const stale = () => this.destroyed || this.deviceLost || request !== this.msaaRequest;
    let pipeline, handles;
    try {
      [pipeline, handles] = await Promise.all([
        this.createVectorPipeline(count), this.handleRenderer.createPipeline(this.format, count),
      ]);
    } catch (error) { if (stale()) return false; throw error; }
    if (stale()) return false;
    // Compile privately, then replace every viewport pass together. Resize and
    // rendering may continue with the old resources while compilation is pending.
    const msaa = this.createMsaaTexture(this.canvas.width, this.canvas.height, count);
    this.pipeline = pipeline;
    this.handleRenderer.setPipeline(handles);
    this.msaaCount = count;
    this.msaa?.destroy(); this.msaa = msaa;
    // The VFX compositor pipeline bakes its own sample count; rebuild lazily.
    this.vfxViewport?.destroy(); this.vfxViewport = null;
    this.drawingGpu?.compileDisplay(count).then(() => this.options.onInvalidate?.(), () => {});
    this.options.onInvalidate?.();
    return true;
  }
  createMsaaTexture(width, height, count = this.msaaCount) {
    return count > 1 ? this.device.createTexture({label: `${count}× antialias canvas`, size: [width, height],
      sampleCount: count, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT}) : null;
  }
  colorAttachment(view) {
    return this.msaa
      ? { view: this.msaa.createView(), resolveTarget: view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }
      : { view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' };
  }
  textureBindGroup(texture, sampler = this.sampler) { return this.device.createBindGroup({ layout: this.textureLayout, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView() }] }); }
  prepareInitialScene(options) { return prepareInitialScene(this, options); }
  activatePreparedScene(prepared, options) { return activatePreparedScene(this, prepared, options); }
  useReport(report) {
    if (this.activeReport === report) return;
    if (this.activeReport) {
      this.onionComposite?.destroy(); this.onionComposite=null;
      this.stats.onionCompositeBytes=this.stats.onionCacheBytes=0;
      for (const entry of this.backgroundImages?.values() || []) entry.texture.destroy();
      for (const texture of this.drawingTextures?.values() ?? []) texture.texture.destroy();
      this.drawingTextures?.clear();
      this.backgroundImages?.clear(); this.resources.clear(); this.preparedFrames.clear();
      this.rasterCache.clear();
      this.layout = []; this.entries.clear(); this.vectorCache = new WeakMap(); this.compatibilityCache = new WeakMap();
      this.artworks.clear();
      this.artworkAliases=new WeakMap();
      this.lastGeometry = null; this.lastReport = null; this.onionScenes = [];
    }
    this.activeReport = report;
  }
  hasPreparedFrame(key) { return this.preparedFrames.has(key); }
  prepareSceneUpdate(options) { return prepareSceneUpdate(this, options); }
  backgroundAssets(report, frame) {
    return backgroundImageAssets(report, frame);
  }
  backgroundsReady(report, frame) {
    return this.backgroundAssets(report, frame).every(asset => {
      const image = this.resources.image(this.resources.url(asset));
      if (image?.complete && !image.naturalWidth) throw messageError(new Error(''), "errors.renderer.anAnimationBackgroundImageCouldNotBeDecoded", {});
      return Boolean(image?.complete && image.naturalWidth);
    });
  }
  async prepareBackgrounds(report, frame) {
    await Promise.all(this.backgroundAssets(report, frame).map(async asset => {
      let image = this.resources.image(this.resources.url(asset));
      if (!image) throw messageError(new Error(''), "errors.renderer.anAnimationBackgroundImageHasNoReadableAsset", {});
      if (!image.complete) { await image.decode(); image = this.resources.image(this.resources.url(asset)); }
      if (!image.naturalWidth) throw messageError(new Error(''), "errors.renderer.anAnimationBackgroundImageCouldNotBeDecoded", {});
    }));
  }
  prepareFrame(packet, options) { if (this.destroyed || this.deviceLost) return null; this.useReport(options.report); return this.preparedFrames.prepare(packet, options); }
  renderPrepared(key, options) {
    if (this.destroyed || this.deviceLost) return false;
    const rendered = this.preparedFrames.render(key, options);
    if (rendered) { this.last = null; this.stats.primitiveUploadCalls = 0; }
    return rendered;
  }
  renderPreparedInto(key, options) {
    if (this.destroyed || this.deviceLost) return false;
    return this.preparedFrames.renderInto(key, options);
  }
  clearPreparedFrames() { this.preparedFrames.clear(); }
  invalidateImages(changedURLs) {
    const previous = this.generation, urls = new Set(changedURLs);
    this.generation++; this.lastGeometry = null;
    this.rasterCache.invalidateImages(urls, previous, this.generation);
    // Prepared packets own worker pixels but may use decoded editor backgrounds.
    // Keep their established conservative reset until those dependencies are tracked.
    this.clearPreparedFrames();
    for (const [key, entry] of this.backgroundImages ?? []) if (entry.imageURL && urls.has(entry.imageURL)) {
      entry.texture.destroy(); this.backgroundImages.delete(key);
    }
    this.backgroundKey = '';
  }
  retainPreparedFrames(report, packets) { this.preparedFrames.retainPackets(report, packets); }
  ensureBuffers(shapeCount, transformCount) {
    const shapeSize = pow2(shapeCount) * SHAPE_BYTES, transformSize = pow2(transformCount) * 16;
    let changed = false;
    if (!this.shapeBuffer || this.shapeBuffer.size < shapeSize) { this.shapeBuffer?.destroy(); this.shapeBuffer = this.device.createBuffer({ label: 'Retained figure primitives', size: shapeSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }); changed = true; }
    if (!this.transformBuffer || this.transformBuffer.size < transformSize) { this.transformBuffer?.destroy(); this.transformBuffer = this.device.createBuffer({ label: 'Figure translations + visibility', size: transformSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); changed = true; }
    if (changed) this.globalBindGroup = this.device.createBindGroup({ layout: this.globalLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.shapeBuffer } }, { binding: 2, resource: { buffer: this.transformBuffer } }] });
    return changed;
  }
  resize(width, height, dpr = 1) {
    if (this.destroyed || this.deviceLost) return;
    const backing = viewportBackingSize(width, height, dpr, this.device.limits.maxTextureDimension2D);
    ({width, height, dpr} = backing);
    const {pw, ph} = backing;
    if (this.contextConfigured && this.canvas.width === pw && this.canvas.height === ph && (this.msaa || this.msaaCount <= 1)) { this.width = width; this.height = height; this.dpr = dpr; return; }
    this.width = width; this.height = height; this.dpr = dpr; this.canvas.width = pw; this.canvas.height = ph;
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.contextConfigured = true;
    this.msaa?.destroy();
    this.msaa = this.createMsaaTexture(pw, ph);
  }
  rasterVisible(g,source=g,isOnion=false) {
    const view=this.rasterView;
    if(!view)return null;
    const uid=uidOf(g),depth=this.rasterParallax?.(uid),move=isOnion?null:this.rasterDrag?.get?.(uid)||this.rasterDrag?.[uid];
    return {x:view.x-g.root.x+source.root.x-(depth?.x||0)-(move?.x||0),
      y:view.y-g.root.y+source.root.y-(depth?.y||0)-(move?.y||0),width:view.width,height:view.height};
  }
  setRasterView(options,matrix,parallax) {
    this.rasterView=rasterViewport(matrix,this.width,this.height);
    this.rasterParallax=parallax??parallaxResolver(options.report,options.frame,options.cameraEnabled!==false);
    this.rasterDrag=options.dragTranslations;
  }
  disposeRasterSurfaces(){
    this.rasterSurfaces.dispose();this.pathRasterSurfaces?.dispose();this.pathRasterSurfaces=null;
  }
  rasterEntryCovered(entry){
    const original=this.geometryBounds(entry.source,opacityArtwork(entry.g,entry.rasterItems).items),view=this.rasterVisible(entry.g,entry.source,entry.isOnion),root=entry.source.root;
    const bounds={...original,x:original.x-root.x,y:original.y-root.y},visible=view&&{...view,x:view.x-root.x,y:view.y-root.y};
    if(entry.texture)return rasterCovers(entry.texture.raster,bounds,visible);
    return !visible||visible.x+visible.width<=bounds.x||visible.y+visible.height<=bounds.y||visible.x>=bounds.x+bounds.width||visible.y>=bounds.y+bounds.height;
  }
  /** Zoomed view changes keep the existing painter layout and buffers. Only
   * visible compatibility slots need a new density; far-away objects remain
   * disabled without artwork hashing or raster allocations. */
  refreshRasterResolution(options,scale,parallax){
    if(this.layout.some(entry=>entry.drawing))return false;
    const matrix=cameraMatrix(options);this.activeCamera=matrix;this.setRasterView(options,matrix,parallax);
    const updates=[],replacement=new Map();
    this.stats.rasterizedObjects=this.stats.compiledObjects=0;
    for(const previous of this.layout){
      if(!previous.g || previous.drawing || previous.gpuDrawing || !previous.rasterCropped&&!previous.texture)continue;
      if(!previous.texture&&this.rasterEntryCovered(previous))continue;
      const entry=this.objectEntry(previous.g,previous.rasterItems??previous.g.drawables,previous.opacity,previous.key,previous.transform,scale,previous.isOnion);
      if(entry.count>previous.capacity)return false;
      entry.capacity=previous.capacity;entry.offset=previous.offset;
      updates.push([previous,entry]);replacement.set(previous,entry);
    }
    const active=new Set(this.layout.filter(entry=>entry.g).map(entry=>(replacement.get(entry)??entry).texture).filter(Boolean));
    if([...active].reduce((n,resource)=>n+(resource.bytes??0),0)>(this.rasterCache.maxBytes||previewMemoryPlan().editorRasters))return false;
    let uploadBytes=0;
    for(const [previous,entry] of updates){
      if(entry.data!==previous.data)uploadBytes+=this.uploadEntry(entry);
      this.stats.textureObjects+=Number(Boolean(entry.texture))-Number(Boolean(previous.texture));
      Object.assign(previous,entry);
    }
    this.drawingViewKey=`${this.activeCamera.join()}|${this.width}|${this.height}|${this.dpr}`;
    this.stats.uploadBytes=uploadBytes;this.stats.updatedObjects=updates.length;this.stats.preparation='view';
    this.artworkStats();return true;
  }
  rasterObject(g, items, scale, artwork = g, cache = this.rasterCache, vector = false, visible) {
    const originalBounds = this.geometryBounds(g,items), max = Math.min(8192, this.device.limits.maxTextureDimension2D);
    let bounds=originalBounds;
    let desired = rasterResolution(scale),standIn;
    const workingBudget = cache.maxBytes > 0 ? cache.maxBytes : previewMemoryPlan().editorRasters;
    const drawingInputs=drawingRasterInputs(items,this.resources),contentKey=drawingRasterKey(drawingInputs);
    const relative=rect=>rect&&({...rect,x:rect.x-g.root.x,y:rect.y-g.root.y});
    if(this.gestureScale && cache===this.rasterCache){
      // Navigation reached artwork its held raster does not cover; the
      // settled paint restores the requested detail. Zooming out shows the
      // whole artwork from a retained raster or one bounded proxy: a crop at
      // the held density costs more with every step. Panning or zooming in
      // paints one bounded crop of the widened view instead, unless a
      // retained raster that covers the view is as sharp.
      this.rasterProxies=true;
      const view=rasterResolution(this.gestureScale),zoomingOut=view<desired;
      const retained=zoomingOut?cache.sharpest(artwork,this.generation,contentKey):
        cache.sharpest(artwork,this.generation,contentKey,relative(originalBounds),relative(visible));
      if(!zoomingOut){
        standIn=gestureStandIn(bounds,visible,view*(this.previewRasterScale||1),{maxDimension:max,padding:this.rasterPadding(g,items)});
        if(standIn.plan===null)return null;
      }
      if(retained&&sameDrawingRaster(retained.drawingInputs,drawingInputs)&&(zoomingOut||retained.resolution>=standIn.density))return retained;
      if(zoomingOut){desired=gestureProxyResolution(view,bounds,max);visible=null;}
    }
    const detail=desired>8 || bounds.width*desired>max || bounds.height*desired>max;
    let resolution = desired * (this.previewRasterScale || 1),plan;
    if(standIn){
      resolution=standIn.density;
      if(standIn.plan)plan=bounds=standIn.plan;
    }else if(detail && visible){
      const padding=this.rasterPadding(g,items);
      plan=rasterBounds(bounds,visible,resolution,max,128,padding);
      if(!plan)return null;
      if(plan.pixelWidth*plan.pixelHeight*4>workingBudget){
        resolution*=Math.sqrt(workingBudget/(4*plan.pixelWidth*plan.pixelHeight));
        plan=rasterBounds(bounds,visible,resolution,max,0,padding);
      }
      bounds=plan;
    }else resolution=Math.min(resolution,Math.sqrt(workingBudget / 4 / Math.max(1,bounds.width*bounds.height)));
    const regionKey=plan?.cropped?`${plan.x-g.root.x},${plan.y-g.root.y},${plan.pixelWidth},${plan.pixelHeight},${plan.pixelScale}`:'';
    const cached = cache.get(artwork, resolution, this.generation,contentKey,regionKey) ||
      (plan?.cropped && cache.covered(artwork,resolution,this.generation,contentKey,relative(originalBounds),relative(visible)));
    if (cached&&sameDrawingRaster(cached.drawingInputs,drawingInputs)) return cached;
    if (cached) cache.delete(cached);
    const previous = cache.previous(artwork);
    const imageURLs = [...new Set(items.filter(item => item.type === 'image' && item.asset).map(item => this.resources.url(item.asset)))];
    const reason=!previous?'uncached':previous.destroyed?'released':previous.generation!==this.generation?'generation':'resolution';
    const misses=this.stats.rasterCacheMisses??={};misses[reason]=(misses[reason]||0)+1;
    const samples=this.stats.rasterCacheMissSamples??=[];
    if(samples.length<4)samples.push({reason,resolution,previousResolution:previous?.resolution,scale});
    this.stats.rasterizedObjects = (this.stats.rasterizedObjects || 0) + 1;
    const pixelScale = vfxRasterScale(items,bounds,Math.min(resolution, max / bounds.width, max / bounds.height),max);
    const width = Math.max(1, Math.ceil(bounds.width * pixelScale)), height = Math.max(1, Math.ceil(bounds.height * pixelScale));
    const crop=plan?.cropped?{regionKey,raster:{...relative(bounds),pixelScale},contentKey}:{};
    const gpuVfx=this.disableVectorVfx?null:vectorVfxSource(items,pixelScale);
    if(gpuVfx&&width*height<=16777216){
      const result={...rasterizeVectorVfx(this,gpuVfx,{width,height,pixelScale,bounds,root:g.root}),bounds:{...bounds,width:width/pixelScale,height:height/pixelScale},origin:{...g.root},generation:this.generation,resolution,imageURLs,...crop};
      this.stats.vectorVfxObjects=(this.stats.vectorVfxObjects??0)+1;cache.set(artwork,result);return result;
    }
    const outlined=detail&&this.options.gpuIsolation!==false&&nativeOutlineVectorItems(items,pixelScale);
    if (vector && supportsVectorIsolation(items, pixelScale) || outlined) {
      let data=outlined&&this.vectorCache.get(items);
      if(!data){data=compileVectorObject(outlined||items,g.root,0);if(outlined)this.vectorCache.set(items,data);}
      const poolClass = `vector:${this.format}`;
      // Draw into the top-left of a recycled or bucketed allocation; the pass
      // clears the whole target, so no earlier artwork remains.
      const allocation = cache.take?.(poolClass, textureBucket(width), textureBucket(height));
      const allocatedWidth = allocation?.width ?? textureBucket(width), allocatedHeight = allocation?.height ?? textureBucket(height);
      let raster;
      try { raster = rasterizeVectorGroup(this, {data, width, height, pixelScale, bounds, root: g.root, viewport: [allocatedWidth, allocatedHeight],
        target: {texture: allocation?.texture, bindGroup: allocation?.bindGroup, width: allocatedWidth, height: allocatedHeight}}); }
      catch (error) { allocation?.texture.destroy(); throw error; }
      const result = {...raster, poolClass, allocatedWidth, allocatedHeight, region: textureRegion(width, height, allocatedWidth, allocatedHeight),
        bounds: {...bounds, width: width / pixelScale, height: height / pixelScale}, origin: {...g.root}, generation: this.generation, resolution,imageURLs,...crop};
      cache.set(artwork, result); return result;
    }
    if (meshOnlyItems(items) && !items.some(hasDrawableVfx)) {
      const {cleanup, ...raster} = rasterizeMeshGroup(this, {source: meshRasterSource(items), width, height, pixelScale, bounds, label: `Mesh object ${uidOf(g)}`});
      const result = {...raster, bounds: {...bounds, width: width / pixelScale, height: height / pixelScale}, origin: {...g.root}, generation: this.generation, resolution, contentKey, drawingInputs,imageURLs,...crop};
      this.stats.meshObjects = (this.stats.meshObjects ?? 0) + 1; cache.set(artwork, result); return result;
    }
    // The outermost effects of Canvas artwork run on this device from the
    // uploaded pixels; only nested effects stay inside the Canvas painter.
    const artworkVfx=this.disableVectorVfx||!fitsVfxSurface(width,height,this.device.limits.maxTextureDimension2D)?null:canvasVfxSource(items);
    // Fresh high-detail paths must not flush an accelerated Canvas on the GPU
    // service thread that presents the viewport. Reuse the worker's software
    // scratch policy here; images and Canvas filters retain their established route.
    const software=!imageURLs.length&&!drawingInputs&&(artworkVfx?true:detail&&!items.some(hasDrawableVfx));
    const pool=software?(this.pathRasterSurfaces??=new RasterSurfacePool({contextOptions:{willReadFrequently:true}})):this.rasterSurfaces;
    const {surface, context: ctx} = pool.acquire(width, height); let texture, source;
    try {
      ctx.setTransform(pixelScale, 0, 0, pixelScale, -bounds.x * pixelScale, -bounds.y * pixelScale);
      drawGeometry(ctx, { drawables: artworkVfx?.items??items,...(plan?.cropped && items.length>=64 ? {clipBounds:{...bounds,guard:2/pixelScale}} : {}) }, this.resources);
      // A detached software bitmap uploads from memory. Copying the canvas
      // itself snapshots it through the graphics process first.
      source=software&&surface.transferToImageBitmap?surface.transferToImageBitmap():surface;
      if(artworkVfx){
        const result={...filterArtworkVfx(this,artworkVfx,source,{width,height,pixelScale,bounds}),bounds:{...bounds,width:width/pixelScale,height:height/pixelScale},origin:{...g.root},
          generation:this.generation,resolution,contentKey,drawingInputs,imageURLs,...crop};
        this.stats.artworkVfxObjects=(this.stats.artworkVfxObjects??0)+1;cache.set(artwork,result);return result;
      }
      // Unused texels of a recycled allocation keep old pixels; the record's
      // region clamps sampling inside the copied rectangle.
      const poolClass = 'bitmap:rgba8unorm', allocation = cache.take?.(poolClass, textureBucket(width), textureBucket(height));
      const allocatedWidth = allocation?.width ?? textureBucket(width), allocatedHeight = allocation?.height ?? textureBucket(height);
      texture = allocation?.texture ?? this.device.createTexture({ label: `Compatibility object ${uidOf(g)}`, size: [allocatedWidth, allocatedHeight], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: true }, [width, height]);
      // Include the final partially used pixel rather than squeezing its raster.
      const rasterBounds = { ...bounds, width: width / pixelScale, height: height / pixelScale };
      const result = { bounds: rasterBounds, origin: {...g.root}, texture, bindGroup: allocation?.bindGroup ?? this.textureBindGroup(texture), generation: this.generation, resolution, contentKey, drawingInputs,imageURLs,
        poolClass, allocatedWidth, allocatedHeight, region: textureRegion(width, height, allocatedWidth, allocatedHeight), bytes: allocatedWidth * allocatedHeight * 4,...crop };
      cache.set(artwork, result); return result;
    } catch (error) { texture?.destroy(); throw error; }
    finally { if(source!==surface)source?.close(); pool.release(); }
  }
  geometryBounds(g,items) {
    return cachedArtworkBounds(this,g,items);
  }
  rasterPadding(g,items){
    this.geometryBounds(g,items);
    const entry=this.boundsCache.get(g);
    return entry.padding??=(items.reduce((n,item)=>Math.max(n,drawableVfxPadding(item)),0));
  }
  // A failed raster must not abort the whole scene build: reuse the slot's or
  // the artwork's previous texture, else the caller degrades to vector shapes.
  // The error still reaches telemetry through the microtask, deduped there.
  rasterFallback(error, artwork, prior) {
    if (error?.name === 'AbortError') throw error;
    this.stats.rasterFailures = (this.stats.rasterFailures || 0) + 1;
    this.stats.lastRasterError = error?.message || String(error);
    if (typeof window !== 'undefined') queueMicrotask(() => { throw error; });
    const candidates = [prior?.texture, this.rasterCache.previous(artwork)];
    return candidates.find(record => record && !record.destroyed) || null;
  }
  glyphTexture(glyph) {
    const cached=this.rasterCache.get(glyph.mask,glyph.variant,this.generation);
    if(cached)return cached;
    const {surface,context}=this.rasterSurfaces.acquire(glyph.width,glyph.height);let texture;
    try {
      drawGlyphMask(context,glyph);
      texture=this.device.createTexture({label:'Shared glyph mask',size:[glyph.width,glyph.height],format:'rgba8unorm',
        usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
      this.device.queue.copyExternalImageToTexture({source:surface},{texture,premultipliedAlpha:true},[glyph.width,glyph.height]);
      const result={texture,bindGroup:this.textureBindGroup(texture),generation:this.generation,resolution:glyph.variant,bytes:glyph.bytes,imageURLs:[]};
      this.rasterCache.set(glyph.mask,result);this.stats.rasterizedObjects=(this.stats.rasterizedObjects||0)+1;return result;
    } catch(error){texture?.destroy();throw error;} finally {this.rasterSurfaces.release();}
  }
  // Descriptors defer GPU allocation so prepared frames can admit backgrounds
  // into their own bounded cache. Editable/staged layouts own separate textures.
  backgroundTexture(descriptor) {
    this.backgroundImages ??= new Map();
    const prior = this.backgroundImages.get(descriptor.key);
    if (prior && prior.signature === descriptor.signature) return prior;
    const resource = {...descriptor.create(), signature: descriptor.signature, imageURL:descriptor.imageURL};
    this.backgroundImages.set(descriptor.key, resource);
    prior?.texture.destroy();
    return resource;
  }
  uploadBackground(source, width, height, label) {
    const texture = this.device.createTexture({label, size: [width, height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
    try {
      this.device.queue.copyExternalImageToTexture({source}, {texture, premultipliedAlpha: true}, [width, height]);
      return {texture, bindGroup: this.textureBindGroup(texture, this.nearestSampler), bytes: width * height * 4};
    } catch (error) {texture.destroy(); throw error;}
  }
  background(options, resolveTexture = descriptor => this.backgroundTexture(descriptor)) {
    const { report, frame } = options, w = report.canvas_width, h = report.canvas_height;
    // `backgroundViewport` widens the camera view the background covers.
    const bounds = backgroundBounds(frame, w, h, options.cameraEnabled !== false, report, options.backgroundViewport), output = [];
    const override = editorBackgroundColor(options) ?? sceneBackgroundColor(report, frame);
    if (override !== undefined) return [{data: new Float32Array(shapeRecord({
      a: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height],
      color: argbFloats(override), mode: SHAPE.RECT, clipToCanvas: true,
    })), texture: null}];
    const layer = (id, alpha = 1) => {
      const bg = report.backgrounds?.find(b => Number(b.background_id) === Number(id));
      const a = [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height];
      let color = argbFloats(bg?.color ?? 0xffffffff), color2 = color, gradient = [0, 0, 0, 0], mode = SHAPE.RECT;
      if (bg?.paint) {
        const signature = JSON.stringify([bg.paint, bounds, w, h]);
        const scale = Math.min(2, 2048 / Math.max(bounds.width, bounds.height));
        const cw = Math.max(1, Math.ceil(bounds.width * scale)), ch = Math.max(1, Math.ceil(bounds.height * scale));
        const cached = resolveTexture({key: bg, cacheKey: `background-paint:${signature}`, signature, bytes: cw * ch * 4,
          create: () => {
            const canvas = new OffscreenCanvas(cw, ch), ctx = canvas.getContext('2d');
            ctx.scale(scale, scale); ctx.translate(-bounds.x, -bounds.y);
            ctx.fillStyle = canvasPaint(ctx, bg.paint, {x: 0, y: h / 2}, {x: w, y: h / 2}, c => c, bounds);
            ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
            return this.uploadBackground(canvas, cw, ch, 'Background paint');
          }});
        output.push({data:new Float32Array(shapeRecord({a,mode:SHAPE.TEXTURE,color:[1,1,1,alpha],clipToCanvas:true})),texture:cached});return;
      }
      if (bg?.kind === 3) {
        color = argbFloats(bg.color_a); color2 = argbFloats(bg.color_b);
        const dx = (bg.x2 - bg.x1) * w, dy = (bg.y2 - bg.y1) * h, norm = dx * dx + dy * dy || 1;
        gradient = [bg.x1 * w, bg.y1 * h, dx / norm, dy / norm];
      } else if (bg?.kind === 4) {
        color = argbFloats(bg.color_b); color2 = argbFloats(bg.color_a); mode = SHAPE.RADIAL_RECT;
        const outer = bg.y2 * h; gradient = [bg.x1 * w, bg.y1 * h, Math.min(Math.max(0, bg.x2 * h), .99 * outer), Math.max(.0001, outer)];
        if (outer <= 0) { color = color2; mode = SHAPE.RECT; }
      } else if (bg && bg.kind !== 2 && bg.color === undefined) {
        const image = this.resources.image(this.resources.url(bg));
        if (!image?.complete || !image.naturalWidth) return;
        const width = image.width || image.naturalWidth, height = image.height || image.naturalHeight;
        const cached = resolveTexture({key: image, cacheKey: image, imageURL:this.resources.url(bg), bytes: width * height * 4,
          create: () => this.uploadBackground(image, width, height, 'Imported background asset')});
        const ratio = Math.max(w / image.naturalWidth, h / image.naturalHeight);
        output.push({ data: new Float32Array(shapeRecord({ a, mode: SHAPE.BACKGROUND_IMAGE,
          gradient: [0, 0, 1 / (image.naturalWidth * ratio), 1 / (image.naturalHeight * ratio)],
          color: [1, 1, 1, alpha], clipToCanvas: true })), texture: cached }); return;
      }
      color = [...color]; color2 = [...color2]; color[3] *= alpha; color2[3] *= alpha;
      output.push({ data: new Float32Array(shapeRecord({ a, mode, color, color2, gradient, clipToCanvas: true })), texture: null });
    };
    layer(frame.background_id); if (frame.background_mix) layer(frame.background_id_b, frame.background_mix / 255);
    return output;
  }
  objectEntry(g, items, opacity, key, index, scale, isOnion = false) {
    const steps=this.objectEntrySteps(g,items,opacity,key,index,scale,isOnion);
    for(;;){const step=steps.next();if(step.done)return step.value;}
  }
  *objectEntrySteps(g, items, opacity, key, index, scale, isOnion = false) {
    const artworkView = opacityArtwork(g,items);
    const {source,items:sourceItems} = artworkView;
    const uid = uidOf(g), prior = this.entries.get(key); let data, texture;
    const drawingMeta=sourceItems.length===1&&!isOnion?drawingMetadata(sourceItems[0].fig):null;
    const drawing=drawingMeta&&this.resources.drawing?.(sourceItems[0].fig);
    const drawingState=drawing?{drawing,drawingItems:items,drawingStamp:drawing.stamp,drawingCamera:this.activeCamera,drawingWidth:this.width,drawingHeight:this.height}:{};
    if(drawing&&this.drawingGpu&&!this.drawingGpu.destroyed&&(drawing.store||drawingMeta.version===2)&&gpuDrawingEligible(drawing,sourceItems[0])){
      // Tiles are resolved per frame in render(); the retained shape slot stays disabled.
      const item=sourceItems[0],matrix=drawingPixelMatrix(item),data=prior?.gpuDrawing&&prior.transform===index?prior.data:new Float32Array(shapeRecord({mode:SHAPE.DISABLED,transform:index}));
      return {...drawingState,key,uid,g,source,opacity,artworkOpacity:artworkView.opacity,isOnion,root:g.root,transform:index,data,count:data.length/SHAPE_FLOATS,texture:null,
        gpuDrawing:{absolute:matrix,matrix:[matrix[0],matrix[1],matrix[2],matrix[3],matrix[4]-source.root.x,matrix[5]-source.root.y],alpha:drawingAlpha(item)}};
    }
    if(drawing&&!drawing.store&&drawingMeta.version===2&&!hasDrawableVfx(sourceItems[0])){
      // An evicted v2 store re-decodes via the presenter; keep the last
      // retained texture until then and never fall back to the stale
      // published placeholder. v1 keeps the generic path below: its data URL
      // is the real PNG.
      const retained=prior?.texture?.drawing===drawing?prior:null;
      const data=retained?retained.data:new Float32Array(shapeRecord({mode:SHAPE.DISABLED,transform:index}));
      return {...drawingState,key,uid,g,source,opacity,artworkOpacity:artworkView.opacity,isOnion,root:g.root,transform:index,data,count:data.length/SHAPE_FLOATS,texture:retained?.texture??null};
    }
    if(drawing?.store&&!hasDrawableVfx(sourceItems[0])) {
      // Tile coverage widens in O(1) while painting; alpha bounds would rescan.
      const item=sourceItems[0],matrix=drawingPixelMatrix(item),bounds=drawing.store.tileBounds;
      // Visible pixel rect: viewport → world → cel pixel space.
      let rect=bounds?{...bounds}:null,cam=this.activeCamera;
      if(cam&&rect){
        const cd=cam[0]*cam[3]-cam[1]*cam[2],md=matrix[0]*matrix[3]-matrix[1]*matrix[2];
        if(Math.abs(cd)>1e-12&&Math.abs(md)>1e-12){
          const toWorld=p=>({x:(cam[3]*(p.x-cam[4])-cam[2]*(p.y-cam[5]))/cd,y:(cam[0]*(p.y-cam[5])-cam[1]*(p.x-cam[4]))/cd});
          const toPixel=p=>({x:(matrix[3]*(p.x-matrix[4])-matrix[2]*(p.y-matrix[5]))/md,y:(matrix[0]*(p.y-matrix[5])-matrix[1]*(p.x-matrix[4]))/md});
          const ps=[[0,0],[this.width,0],[this.width,this.height],[0,this.height]].map(([x,y])=>toPixel(toWorld({x,y})));
          const vx=Math.min(...ps.map(p=>p.x)),vy=Math.min(...ps.map(p=>p.y)),vx1=Math.max(...ps.map(p=>p.x)),vy1=Math.max(...ps.map(p=>p.y));
          rect={x:Math.max(rect.x,vx),y:Math.max(rect.y,vy),width:Math.min(rect.x+rect.width,vx1)-Math.max(rect.x,vx),height:Math.min(rect.y+rect.height,vy1)-Math.max(rect.y,vy)};
          if(rect.width<=0||rect.height<=0)rect=null;
        }
      }
      // Mip level from screen pixels per source pixel: at deviceScale < 1 a
      // downsampled level keeps the scratch inside the texture-size limit.
      // Levels escalate to 8 (256x) so even a drawing spanning megapixels of
      // coverage fits; `clamp` then guarantees a scratch by trimming the
      // painted band to the texture limit around the visible span. A drawing
      // is never rejected for size — rejection would blank the whole frame.
      const maxSide=this.device.limits.maxTextureDimension2D;
      const deviceScale=Math.max(1e-9,scale*Math.hypot(matrix[0],matrix[1]));
      let scratch=null,level=Math.max(0,Math.min(8,Math.floor(-Math.log2(deviceScale))));
      for(;rect&&level<=8;level++){
        const result=drawing.scratch?.(rect,{level,maxSide});
        if(result){scratch=result;break;}
      }
      if(rect&&!scratch){level=8;scratch=drawing.scratch?.(rect,{level,maxSide,clamp:true});}
      if(!scratch){
        // Only a visible, nonempty cover can be waiting for its next preview.
        // An empty or offscreen store must stop displaying the prior texture.
        if(rect&&drawing.owner?.previews&&prior?.drawing===drawing&&prior.texture)return {...prior,...drawingState};
        const data=new Float32Array(shapeRecord({mode:SHAPE.DISABLED,transform:index}));
        return {...drawingState,key,uid,g,source,opacity,artworkOpacity:artworkView.opacity,isOnion,root:g.root,transform:index,data,count:data.length/SHAPE_FLOATS,texture:null};
      }
      if(scratch){
        // Textures key to the scratch anchor, not just the cel: alternating
        // anchors keep independent canvases AND textures, so a deferred
        // upload can never read a canvas repainted for another anchor.
        this.drawingTextures??=new Map();
        const textureKey=`${drawing.id}|${scratch.anchorKey}`;texture=this.drawingTextures.get(textureKey);
        const w=scratch.canvas.width,h=scratch.canvas.height,rectKey=`${level}:${scratch.x},${scratch.y},${w},${h}`;
        if(!texture||texture.width!==w||texture.height!==h){
          texture?.texture.destroy();
          const gpu=this.device.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
          texture={texture:gpu,bindGroup:this.textureBindGroup(gpu),width:w,height:h,stamp:-1,rectKey:null,bytes:w*h*4};
        }
        // Most-recently-used ordering: the render loop evicts from the front.
        this.drawingTextures.delete(textureKey);this.drawingTextures.set(textureKey,texture);
        texture.drawing=drawing;texture.canvas=scratch.canvas;texture.dirty=scratch.dirty;texture.nextStamp=scratch.stamp;texture.nextRectKey=rectKey;
        const q=scratch.scale,ox=matrix[0]*scratch.x*q+matrix[2]*scratch.y*q+matrix[4],oy=matrix[1]*scratch.x*q+matrix[3]*scratch.y*q+matrix[5];
        data=new Float32Array(shapeRecord({a:[ox-source.root.x,oy-source.root.y,0,0],b:[matrix[0]*scratch.width*q,matrix[1]*scratch.width*q,matrix[2]*scratch.height*q,matrix[3]*scratch.height*q],mode:9,color:[1,1,1,drawingAlpha(sourceItems[0])],transform:index}));
        return {...drawingState,key,uid,g,source,opacity,artworkOpacity:artworkView.opacity,isOnion,root:g.root,transform:index,data,count:1,texture};
      }
    }
    let compatibility = this.compatibilityCache.get(source);
    if (compatibility === undefined) { compatibility = artworkView.isolated || requiresCompatibilityTexture(sourceItems); this.compatibilityCache.set(source, compatibility); }
    const desired=rasterResolution(scale)*(this.previewRasterScale||1);
    // Admit against the entire high-zoom range so zooming back toward 8x
    // cannot retain a vector route that becomes a native hairline or tiny ring.
    const outlined=!artworkView.isolated&&rasterResolution(scale)>8&&this.options.gpuIsolation!==false&&nativeOutlineVectorItems(sourceItems,8);
    if(outlined)compatibility=false;
    const glyph=this.options.sharedArtwork!==false && rasterResolution(scale)<=8 && glyphTextureDescriptor(sourceItems,desired);
    if (glyph) {
      try { texture=this.glyphTexture(glyph); } catch (error) { texture=this.rasterFallback(error, glyph.mask, prior); }
      if (texture) { this.rasterLease?.add(texture); data=glyphTextureShape(glyph,source.root,index); }
    } else if (compatibility) {
      const artwork=this.artworkAliases.get(source) ?? (this.options.sharedArtwork===false||this.liveEditing?source:yield* this.artworks.getSteps(source,sourceItems));
      this.artworkAliases.set(g,artwork);
      try { texture = this.rasterObject(source, sourceItems, scale, artwork, this.rasterCache,
        this.options.gpuIsolation !== false && artworkView.isolated && supportsVectorIsolation(sourceItems, desired),this.rasterVisible(g,source,isOnion));
        if(!texture){
          const data=prior?.rasterCropped&&!prior.texture?prior.data:new Float32Array(shapeRecord({mode:SHAPE.DISABLED,transform:index}));
          const depth=this.rasterParallax?.(uid),move=isOnion?null:this.rasterDrag?.get?.(uid)||this.rasterDrag?.[uid];
          return {key,uid,g,source,opacity,artworkOpacity:artworkView.opacity,isOnion,root:g.root,transform:index,data,count:1,texture:null,rasterCropped:true,rasterItems:items,
            rasterTranslated:Boolean(depth?.x||depth?.y||move?.x||move?.y)};
        }
      }
      catch (error) { texture = this.rasterFallback(error, artwork, prior); }
      if (texture) this.rasterLease?.add(texture);
      if (prior?.transform === index && prior.texture === texture) data = prior.data;
      else if (texture) { const b = texture.bounds, origin=texture.origin; data = new Float32Array(shapeRecord({ a: [b.x - origin.x, b.y - origin.y, b.x + b.width - origin.x, b.y + b.height - origin.y], gradient: texture.region, color: [1, 1, 1, 1], mode: SHAPE.TEXTURE, transform: index })); }
    }
    if (!data) {
      const vectorKey=outlined?sourceItems:source;
      let compiled = this.vectorCache.get(vectorKey);
      if (!compiled) { compiled = yield* compileVectorObjectSteps(outlined||sourceItems, source.root); this.vectorCache.set(vectorKey, compiled); this.stats.compiledObjects++; }
      // A textured prior's data is a TEXTURE shape; it is only reusable while the
      // entry still presents that texture. A staged layout also shares the data
      // of the layout it will replace; publication copies it on the GPU.
      const reusable = prior ?? this.predecessor?.entries.get(key);
      if (reusable?.source === source && reusable.transform === index && Boolean(reusable.outlinedVectors)===Boolean(outlined) && !reusable.drawing && !reusable.gpuDrawing && (!reusable.texture || reusable.texture === texture)) data = reusable.data;
      else { data = compiled.slice(); for (let j = 21; j < data.length; j += SHAPE_FLOATS) data[j] = index; }
    }
    return { key, uid, g, source, opacity, artworkOpacity:artworkView.opacity, isOnion, root: g.root, transform: index, data, count: data.length / SHAPE_FLOATS, texture,
      outlinedVectors:Boolean(outlined),rasterCropped:Boolean(texture?.raster),...(texture?.raster?{rasterItems:items}:{}) };
  }
  /** Fill the entries a staged layout shares with `from`, the layout it
   * replaces: a GPU copy of the published primitives, or an upload when that
   * entry has changed since. Runs before `from` releases its buffer. */
  copySharedEntries(from) {
    const shared = this.sharedEntries; this.sharedEntries = null; this.stats.copiedBytes = 0;
    if (!shared) return;
    const published = new Map(from.layout?.map(entry => [entry.data, entry])); let encoder = null;
    for (const entry of shared) {
      const source = published.get(entry.data);
      if (from.shapeBuffer && source?.capacity >= entry.capacity) {
        // The published range holds the same data padded with disabled records.
        (encoder ??= this.device.createCommandEncoder()).copyBufferToBuffer(from.shapeBuffer, source.offset * SHAPE_BYTES, this.shapeBuffer, entry.offset * SHAPE_BYTES, entry.capacity * SHAPE_BYTES);
        this.stats.copiedBytes += entry.capacity * SHAPE_BYTES;
      } else { this.stats.uploadBytes += this.uploadEntry(entry); this.stats.primitiveUploadCalls++; }
    }
    if (encoder) this.device.queue.submit([encoder.finish()]);
  }
  uploadEntry(entry) {
    const padded = new Float32Array(entry.capacity * SHAPE_FLOATS); padded.set(entry.data);
    for (let j = entry.count; j < entry.capacity; j++) padded[j * SHAPE_FLOATS + 20] = SHAPE.DISABLED;
    this.device.queue.writeBuffer(this.shapeBuffer, entry.offset * SHAPE_BYTES, padded);
    return padded.byteLength;
  }
  updateGeometry(options, geometry, parallax) {
    const old = this.lastGeometry;
    if (!geometry.changedSlots || !old?.token || geometry.previousToken !== old.token || !this.entriesBySlot) return false;
    const ordered = geometry.orderedObjects, before = old.orderedObjects;
    if (!ordered || ordered.length !== before?.length || ordered.some((g, i) => g.slot !== before[i].slot || uidOf(g) !== uidOf(before[i]))) return false;
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr, updates = [];
    this.activeCamera = matrix;
    this.setRasterView(options,matrix,parallax);
    this.artworks.begin(options.artworkRevision);
    this.stats.compiledObjects = 0; this.stats.rasterizedObjects = 0;
    for (const slot of geometry.changedSlots) {
      const g = geometry.objects.get(slot), previous = this.entriesBySlot.get(slot);
      if (!g?.drawables?.length && !previous) continue;
      if (!g || !previous) return false;
      const entry = this.objectEntry(g, g.drawables, previous.opacity, previous.key, previous.transform, scale);
      if (entry.count > previous.capacity) return false;
      entry.capacity = previous.capacity; entry.offset = previous.offset;
      updates.push({ previous, entry });
    }
    const replacements = new Map(updates.map(({previous, entry}) => [previous, entry]));
    const textures = new Set(this.layout.map(entry => (replacements.get(entry) || entry).texture).filter(Boolean));
    if ([...textures].reduce((sum, texture) => sum + (texture.bytes || 0), 0) > (this.rasterCache.maxBytes || previewMemoryPlan().editorRasters)) return false;
    let uploadBytes = 0, primitiveUploadCalls = 0;
    for (const { previous, entry } of updates) {
      if (entry.data !== previous.data) { uploadBytes += this.uploadEntry(entry); primitiveUploadCalls++; }
      this.stats.primitives += entry.count - previous.count;
      this.stats.textureObjects += Number(!!entry.texture) - Number(!!previous.texture);
      this.stats.gpuBytes += (entry.texture?.bytes || 0) - (previous.texture?.bytes || 0);
      // Retain layout/command references, replacing only the changed object's fields.
      Object.assign(previous, entry);
    }
    this.lastGeometry = geometry;
    this.artworkStats();
    Object.assign(this.stats, { uploadBytes, primitiveUploadCalls, updatedObjects: updates.length, cachedObjects: ordered.length - updates.length,
      preparation: 'incremental', warnings: geometry.warnings || [] });
    return true;
  }
  /** Drawing pixels change without a geometry change (a stroke in progress, a
   * decode landing) and panning moves which of their tiles are visible: re-run
   * just those drawing entries, so their scratch canvases repaint the changed
   * tiles and their textures upload only the dirty region, instead of
   * rebuilding the scene. Returns false when an entry outgrew its slot. */
  refreshDrawings(options,parallax,rasterScale) {
    if (!this.layout) return true;
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr;
    const viewKey = `${matrix.join()}|${this.width}|${this.height}|${this.dpr}`, moved = viewKey !== this.drawingViewKey;
    this.drawingViewKey = viewKey;
    if(this.stats.croppedTextureObjects||this.stats.outlinedVectorObjects)this.setRasterView(options,matrix,parallax);
    let refreshed = 0, uploadBytes = 0;
    for (const previous of this.layout) {
      if(changedDrawingRaster(previous.texture?.drawingInputs))return false;
      const drawing = previous.drawing;
      let cropChanged=false;
      if(previous.rasterCropped && moved)cropChanged=!this.rasterEntryCovered(previous);
      if (!cropChanged && (!drawing || !previous.g || (!moved && previous.drawingStamp === drawing.stamp))) continue;
      this.activeCamera = matrix;
      const entry = this.objectEntry(previous.g, previous.rasterItems??previous.drawingItems, previous.opacity, previous.key, previous.transform, drawing ? scale : rasterScale ?? scale, previous.isOnion);
      if (entry.count > previous.capacity) return false;
      entry.capacity = previous.capacity; entry.offset = previous.offset;
      if (entry.data !== previous.data) uploadBytes += this.uploadEntry(entry);
      this.stats.textureObjects+=Number(Boolean(entry.texture))-Number(Boolean(previous.texture));
      Object.assign(previous, entry); refreshed++;
    }
    if (refreshed) { this.stats.updatedObjects = refreshed; this.stats.uploadBytes += uploadBytes; this.stats.preparation = 'drawing';
      if(this.stats.croppedTextureObjects){
        this.artworkStats();
        if(this.rasterCache.stats.activeBytes>(this.rasterCache.maxBytes||previewMemoryPlan().editorRasters))return false;
      } }
    return true;
  }
  prepare(options, geometry, parallax) {
    const steps = this.prepareSteps(options, geometry, parallax);
    for (;;) { const step = steps.next(); if (step.done) return step.value; }
  }
  *prepareSteps(options, geometry, parallax) {
    geometry=options.vfxEnabled===false?vfxPreviewGeometry(geometry):connectedVfxGeometry(geometry,options.frame,options.report,options.hiddenUids);
    this.artworks.begin(options.artworkRevision);
    const matrix = cameraMatrix(options), scale = Math.hypot(matrix[0], matrix[1]) * this.dpr, next = [];
    this.activeCamera = matrix;
    this.setRasterView(options,matrix,parallax);
    this.stats.compiledObjects = 0; this.stats.rasterizedObjects = 0;
    const reuseOnions = this.lastGeneration === this.generation && (this.lastGeometry === geometry || geometry.previousToken === this.lastGeometry?.token);
    const previousOnions = reuseOnions ? this.onionScenes || [] : [], onionScenes = [];
    for (const [i, onion] of (options.onionFrames || []).entries()) {
      const frame = onion.frame || onion;
      const scene = onion.geometry || previousOnions.find(cached => cached.frame === frame)?.geometry || (yield* buildGeometrySteps(options.report, frame));
      onionScenes.push({frame, geometry: options.vfxEnabled===false?vfxPreviewGeometry(scene):connectedVfxGeometry(scene,frame,options.report,options.hiddenUids), opacity: onion.opacity, beforeUid: onion.beforeUid, showOnTop: onion.showOnTop});
    }
    this.onionScenes = onionScenes;
    const groups = composeSceneGroups(geometry, onionScenes, options.frame, options.report);
    // Plan the complete next set before allocating it. Aliases count repeated
    // artwork once; lower raster detail leaves editable vector geometry intact.
    const uniqueArtwork = new Set(), texturePlans = [];
    const desiredResolution = rasterResolution(scale);
    for (const {g, items, isOnion} of groups) {
      const artworkView = opacityArtwork(g,items), {source,items:sourceItems} = artworkView;
      if(!artworkView.isolated&&desiredResolution>8&&this.options.gpuIsolation!==false&&nativeOutlineVectorItems(sourceItems,8))continue;
      let compatibility = this.compatibilityCache.get(source);
      if (compatibility === undefined) {compatibility = artworkView.isolated || requiresCompatibilityTexture(sourceItems); this.compatibilityCache.set(source, compatibility);}
      if (!compatibility) continue;
      // Live drawing cels present through their tile presenter. Hashing their
      // published tile blob as shared artwork would stall every relayout.
      if (this.liveDrawing(sourceItems, isOnion)) continue;
      const glyph=this.options.sharedArtwork!==false && desiredResolution<=8 && glyphTextureDescriptor(sourceItems,desiredResolution);
      if(glyph){texturePlans.push({items:sourceItems});yield {phase:'Preview memory',completed:texturePlans.length,total:groups.length};continue;}
      const artwork = this.artworkAliases.get(source) ?? (this.options.sharedArtwork === false || this.liveEditing ? source : yield* this.artworks.getSteps(source, sourceItems));
      this.artworkAliases.set(source, artwork);
      const bounds=this.geometryBounds(source,sourceItems),max=Math.min(8192,this.device.limits.maxTextureDimension2D);
      const detail=desiredResolution>8||bounds.width*desiredResolution>max||bounds.height*desiredResolution>max;
      if (uniqueArtwork.has(artwork)&&!detail) continue; uniqueArtwork.add(artwork);
      texturePlans.push({items:sourceItems,bounds,artwork,root:source.root,visible:detail?this.rasterVisible(g,source,isOnion):null,padding:detail?this.rasterPadding(source,sourceItems):0});
      yield {phase: 'Preview memory', completed: uniqueArtwork.size, total: groups.length};
    }
    const bytesAt = scale => {
      const masks=new Set(),crops=new Map();let bytes=0;
      for(const {items,bounds,visible,artwork,root,padding} of texturePlans){
        const glyph=this.options.sharedArtwork!==false&&desiredResolution<=8&&glyphTextureDescriptor(items,desiredResolution*scale);
        if(glyph){
          const key=`${glyph.mask.id}:${glyph.variant}`;
          if(!masks.has(key)){masks.add(key);bytes+=glyph.bytes;}
        } else {
          const max=Math.min(8192,this.device.limits.maxTextureDimension2D);
          if(visible&&(desiredResolution>8||bounds.width*desiredResolution>max||bounds.height*desiredResolution>max)){
            const plan=rasterBounds(bounds,visible,desiredResolution*scale,max,128,padding);
            if(plan){
              const key=`${plan.x-root.x},${plan.y-root.y},${plan.pixelWidth},${plan.pixelHeight},${plan.pixelScale}`;
              let variants=crops.get(artwork);if(!variants)crops.set(artwork,variants=new Set());
              if(!variants.has(key)){variants.add(key);bytes+=textureBucket(plan.pixelWidth)*textureBucket(plan.pixelHeight)*4;}
            }
          }else{
            const ratio=Math.min(desiredResolution*scale,4096/bounds.width,4096/bounds.height);
            bytes+=Math.max(1,Math.ceil(bounds.width*ratio))*Math.max(1,Math.ceil(bounds.height*ratio))*4;
          }
        }
      }
      return bytes;
    };
    this.previewRasterScale = 1;
    const workingBudget = this.rasterCache.maxBytes || previewMemoryPlan().editorRasters;
    while (bytesAt(this.previewRasterScale) > workingBudget * .95 && this.previewRasterScale > 1 / 65536) this.previewRasterScale /= 2;
    this.stats.previewReduced = this.previewRasterScale < 1;
    let index = 1, shapeCount = 0, compatibilityCount = 0, cached = 0;
    for (const bg of this.background(options)) { next.push({ key: `background-${next.length}`, transform: 0, root: { x: 0, y: 0 }, count: bg.data.length / SHAPE_FLOATS, data: bg.data, texture: bg.texture }); }
    for (const { g, items, opacity, key, isOnion, onionIndex, onionLayerKey } of groups) {
      if (this.vectorCache.has(g)) cached++;
      const entry = yield* this.objectEntrySteps(g, items, isOnion ? 1 : opacity, key, index++, scale, isOnion);
      if(isOnion){entry.onionIndex=onionIndex;entry.onionLayerKey=onionLayerKey;}
      if (entry.texture) compatibilityCount++;
      next.push(entry);
      yield {phase: 'GPU primitives', completed: index - 1, total: groups.length};
    }
    let relayout = this.layout?.length !== next.length;
    for (let i = 0; i < next.length; i++) {
      const entry = next[i], previous = this.layout?.[i];
      entry.capacity = previous?.key === entry.key && previous.capacity >= entry.count ? previous.capacity : pow2(entry.count);
      entry.offset = shapeCount; shapeCount += entry.capacity;
      if (previous?.key !== entry.key || previous.capacity !== entry.capacity || previous.offset !== entry.offset) relayout = true;
    }
    if (this.ensureBuffers(shapeCount, index)) relayout = true;
    let uploadBytes = 0, primitiveUploadCalls = 0;
    // Entries unchanged from the predecessor's layout are copied from its
    // buffer when this stage is published instead of uploaded again.
    const shared = new Set(), predecessor = this.predecessor;
    if (relayout) {
      this.uploadStaging ??= new Float32Array(SHAPE_UPLOAD_RECORDS * SHAPE_FLOATS);
      const skip = predecessor && (entry => predecessor.entries.get(entry.key)?.data === entry.data && Boolean(shared.add(entry)));
      const uploaded = yield* uploadShapeLayoutSteps(this.device.queue, this.shapeBuffer, next, this.uploadStaging, skip);
      uploadBytes = uploaded.bytes; primitiveUploadCalls = uploaded.calls;
    } else {
      for (let i = 0; i < next.length; i++) {
        const entry = next[i], previous = this.layout?.[i];
        if (previous?.data !== entry.data) { uploadBytes += this.uploadEntry(entry); primitiveUploadCalls++; yield {phase: 'GPU upload', completed: i + 1, total: next.length}; }
        else if (this.sharedEntries?.has(previous)) shared.add(entry);
      }
    }
    this.sharedEntries = shared.size ? shared : null;
    this.layout = next; this.entries = new Map(next.filter(e => e.g).map(e => [e.key, e])); this.transformData = new Float32Array(index * 4);
    this.entriesBySlot = new Map(next.filter(e => e.g && e.key === e.uid).map(e => [e.g.slot, e]));
    this.transformData.set([0, 0, 1, 1]);
    this.shapeCount = shapeCount; this.lastGeometry = geometry; this.lastGeneration = this.generation;
    this.drawingViewKey = `${matrix.join()}|${this.width}|${this.height}|${this.dpr}`;
    this.stats.uploadBytes = uploadBytes; this.stats.primitiveUploadCalls = primitiveUploadCalls; this.stats.primitives = next.reduce((n, e) => n + e.count, 0); this.stats.objects = geometry.objects.size; this.stats.textureObjects = compatibilityCount; this.stats.cachedObjects = cached;
    this.artworkStats();
    this.stats.warnings = geometry.warnings || [];
    this.stats.preparation = 'layout'; this.stats.updatedObjects = groups.length;
  }
  artworkStats(){
    this.stats.outlinedVectorObjects=this.layout?.reduce((n,entry)=>n+Number(Boolean(entry.outlinedVectors)),0)??0;
    this.stats.croppedTextureObjects=this.layout?.reduce((n,entry)=>n+Number(Boolean(entry.rasterCropped)),0)??0;
    this.rasterCache.retain(new Set(this.layout?.filter(entry=>entry.g).map(entry=>entry.texture).filter(Boolean)), this.generation);
    this.stats.editorRasterCache={...this.rasterCache.stats};
    const textures=new Set(this.layout?.map(entry=>entry.texture).filter(Boolean));
    this.stats.gpuBytes=(this.shapeBuffer?.size||0)+(this.transformBuffer?.size||0)+this.rasterCache.bytes+[...(this.drawingTextures?.values()??[])].reduce((n,t)=>n+t.bytes,0);
    this.stats.uniqueTextures=textures.size;
    this.stats.sharedArtwork={...this.artworks.stats,entries:this.artworks.lru.size,bytes:this.artworks.bytes,definitionBytes:this.artworks.definitionBytes};
  }
  render(options) {
    if (this.destroyed || this.deviceLost) return;
    options=vfxPreviewOptions(options);
    if(options.vfxEnabled!==false&&options.frame&&options.report)options={...options,geometry:connectedVfxGeometry(options.geometry||buildGeometry(options.report,options.frame),options.frame,options.report,options.hiddenUids)};
    this.stats.rasterCacheMisses={};this.stats.rasterCacheMissSamples=[];
    this.liveEditing=Boolean(options.liveEditing);
    this.last = options.preparedPacket ? {...options, preparedPacket: undefined} : options; const start = performance.now();
    const { report, frame, view = {}, hiddenUids, dragTranslations } = options;
    if (!report || !frame) return;
    this.useReport(report);
    let measureAt=this.measureFrame?performance.now():0;
    const geometry = options.geometry || (options.vfxEnabled===false?vfxPreviewGeometry(buildGeometry(report,frame)):buildGeometry(report, frame));
    if(this.measureFrame){this.telemetryStages={geometry:performance.now()-measureAt};measureAt=performance.now();}
    this.stats.adoptedObjects = 0; this.stats.adoptedVectorBytes = 0;
    if (options.preparedPacket && (this.lastAdoptionToken !== geometry.token || this.lastAdoptionKey !== options.preparedPacket.key)) {
      const adopted = adoptPreparedVectors(options.preparedPacket, geometry, this.vectorCache, this.compatibilityCache);
      this.stats.adoptedObjects = adopted.objects; this.stats.adoptedVectorBytes = adopted.bytes;
      this.lastAdoptionToken = geometry.token; this.lastAdoptionKey = options.preparedPacket.key;
    }
    // Geometry identity is stable during view changes and direct object translation.
    const backgroundKey = JSON.stringify([frame.background_id, frame.background_id_b, frame.background_mix, editorBackgroundColor(options) ?? sceneBackgroundColor(report, frame), effectiveCamera(report, frame, options.cameraEnabled !== false)]);
    const onionFrames = options.onionFrames || [], onionChanged = this.onionFrameRefs?.length !== onionFrames.length || onionFrames.some((frame, i) => frame !== this.onionFrameRefs?.[i]);
    const camera = cameraMatrix(options), requestedResolution = rasterResolution(Math.hypot(camera[0], camera[1]) * this.dpr),parallax=parallaxResolver(report,frame,options.cameraEnabled!==false);
    // Navigation changes the projection immediately, but covered artwork can
    // keep its density until input settles. Never publish the requested bucket
    // as prepared before its pixels exist: the final paint must refine it.
    const viewChanging=options.viewChanging&&!options.playing&&this.lastGeometry===geometry&&this.lastReport===report&&this.lastGeneration===this.generation&&this.backgroundKey===backgroundKey&&!onionChanged;
    this.gestureScale=viewChanging?Math.hypot(camera[0], camera[1]) * this.dpr:0;
    // Proxies shown during navigation are not the requested detail, even when
    // the gesture returns to the density it started from.
    if(this.rasterProxies&&!viewChanging){this.rasterProxies=false;this.lastRasterResolution=-1;}
    let viewResolution=viewChanging ? this.lastRasterResolution : requestedResolution;
    const textured=this.stats.textureObjects||this.stats.croppedTextureObjects;
    const outlineTransition=this.stats.outlinedVectorObjects&&viewResolution<=8;
    if (this.lastGeometry !== geometry || this.lastReport !== report || this.lastGeneration !== this.generation || this.backgroundKey !== backgroundKey || onionChanged || outlineTransition || (textured && this.lastRasterResolution !== viewResolution)) {
      const canUpdate = this.lastReport === report && this.lastGeneration === this.generation && this.backgroundKey === backgroundKey && !onionChanged && !outlineTransition && (!textured || this.lastRasterResolution === viewResolution);
      // A failed build leaves the previous layout intact; drawing it beats
      // retrying the same doomed work every frame. Retry when the inputs
      // change, or after a pause for transient failures.
      const failed = this.prepareFailure;
      if (failed?.geometry === geometry && failed.generation === this.generation && failed.backgroundKey === backgroundKey && failed.rasterResolution === viewResolution && performance.now() - failed.at < 1500) this.stats.preparation = 'failed';
      else {
        try {
          const viewUpdate=this.lastGeometry===geometry&&this.lastReport===report&&this.lastGeneration===this.generation&&this.backgroundKey===backgroundKey&&!onionChanged&&viewResolution>8&&this.lastRasterResolution>8;
          if(viewUpdate){if(!this.refreshRasterResolution(options,viewResolution,parallax)){this.prepare(options,geometry,parallax);viewResolution=requestedResolution;}}
          else if (!canUpdate || !this.updateGeometry(options, geometry,parallax)){this.prepare(options, geometry,parallax);viewResolution=requestedResolution;}
          this.prepareFailure = null;
          this.lastReport = report; this.backgroundKey = backgroundKey; this.onionFrameRefs = [...onionFrames]; this.lastRasterResolution = viewResolution;
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          this.prepareFailure = { geometry, generation: this.generation, backgroundKey, rasterResolution: viewResolution, at: performance.now() };
          this.stats.prepareFailures = (this.stats.prepareFailures || 0) + 1;
          this.stats.lastPrepareError = error?.message || String(error);
          this.stats.preparation = 'failed';
          if (typeof window !== 'undefined') queueMicrotask(() => { throw error; });
        }
      }
    } else {
      this.stats.uploadBytes = 0; this.stats.primitiveUploadCalls = 0; this.stats.updatedObjects = 0; this.stats.compiledObjects = 0; this.stats.rasterizedObjects = 0; this.stats.preparation = 'retained';
      try { if (!this.refreshDrawings(options,parallax,viewResolution)) {this.prepare(options, geometry,parallax);this.lastRasterResolution=requestedResolution;} }
      catch (error) {
        if (error?.name === 'AbortError') throw error;
        this.stats.lastPrepareError = error?.message || String(error);
        if (typeof window !== 'undefined') queueMicrotask(() => { throw error; });
      }
    }
    if (!this.layout) return geometry; // No build has ever succeeded; the canvas keeps its last frame.
    const liveTextures=new Set(this.layout.map(entry=>entry.texture));
    let drawingGpuBytes=0;
    for(const [id,texture] of this.drawingTextures??[]){
      const drawing=texture.drawing;
      drawingGpuBytes+=texture.bytes;
      if(!liveTextures.has(texture)||!drawing)continue;
      if(texture.stamp===texture.nextStamp&&texture.rectKey===texture.nextRectKey)continue;
      const canvas=texture.canvas;if(!canvas?.width||!canvas.height)continue;
      // A re-anchored scratch was repainted wholesale; only same-rect updates
      // can ship the dirty subregion.
      const dirty=texture.stamp<0||texture.rectKey!==texture.nextRectKey?null:texture.dirty;
      const r=dirty?{x:dirty.x,y:dirty.y,width:dirty.width,height:dirty.height}:{x:0,y:0,width:canvas.width,height:canvas.height};
      if(r.width>0&&r.height>0)this.device.queue.copyExternalImageToTexture({source:canvas,origin:[r.x,r.y]},{texture:texture.texture,origin:[r.x,r.y],premultipliedAlpha:true},[r.width,r.height]);
      texture.stamp=texture.nextStamp;texture.rectKey=texture.nextRectKey;
      drawing.presentedStamp=Math.max(drawing.presentedStamp??-1,texture.stamp);
    }
    // Retain textures past their layout slot; evict least-recently-used only
    // when the drawing texture budget is exceeded (Map order is MRU-last).
    if(drawingGpuBytes>this.drawingTextureBudget){
      for(const [id,texture] of this.drawingTextures){
        if(drawingGpuBytes<=this.drawingTextureBudget)break;
        if(liveTextures.has(texture))continue;
        texture.texture.destroy();this.drawingTextures.delete(id);drawingGpuBytes-=texture.bytes;
      }
    }
    const drawingGpu=this.drawingGpu;
    if(drawingGpu&&!drawingGpu.destroyed){
      drawingGpu.beginFrame();
      for(const entry of this.layout)entry.gpuDraw=entry.gpuDrawing?drawingGpu.prepare(entry.drawing,this.gpuDrawingView(entry,camera)):null;
      drawingGpuBytes+=drawingGpu.bytes;this.stats.drawingGpu={...drawingGpu.stats};
    }
    this.stats.drawingGpuBytes=drawingGpuBytes;
    if(this.measureFrame){this.telemetryStages.prepare=performance.now()-measureAt;measureAt=performance.now();}
    const matrix = cameraMatrix(options), zoom = Number(view.scale ?? 1), x = Number(view.x ?? 0), y = Number(view.y ?? 0);
    const uniform = new Float32Array([matrix[0], matrix[2], matrix[4], Math.hypot(matrix[0], matrix[1]), matrix[1], matrix[3], matrix[5], (view.flip ? -1 : 1) * (view.rotation??0), this.width, this.height, this.dpr, options.clipToCanvas === false ? 0 : 1, x, y, x + report.canvas_width * zoom, y + report.canvas_height * zoom]);
    this.device.queue.writeBuffer(this.uniform, 0, uniform);
    // A large drag can reveal more artwork than the current layout admitted.
    // Replan before submission, then fill the replacement layout's transforms.
    for(let transformPass=0;transformPass<2;transformPass++){
      let refreshedCrops=false;
      for (const entry of this.layout) {
        if (!entry.g) continue;
        const depth=parallax(entry.uid);
        const delta = entry.isOnion ? null : dragTranslations?.get?.(entry.uid) || dragTranslations?.[entry.uid];
        // Disabled off-screen records never read a transform. View changes check
        // admission above; a live external translation still checks its crop.
        if(entry.rasterCropped&&!entry.texture&&!delta&&!entry.rasterTranslated&&!depth.x&&!depth.y)continue;
        const tx=entry.root.x+(delta?.x||0)+depth.x,ty=entry.root.y+(delta?.y||0)+depth.y,offset=entry.transform*4;
        if(entry.rasterCropped && (this.transformData[offset]!==Math.fround(tx)||this.transformData[offset+1]!==Math.fround(ty)) && !this.rasterEntryCovered(entry)){
          const next=this.objectEntry(entry.g,entry.rasterItems,entry.opacity,entry.key,entry.transform,viewResolution,entry.isOnion);
          next.capacity=entry.capacity;next.offset=entry.offset;
          this.stats.uploadBytes+=this.uploadEntry(next);
          this.stats.textureObjects+=Number(Boolean(next.texture))-Number(Boolean(entry.texture));
          Object.assign(entry,next);refreshedCrops=true;
        }
        this.transformData.set([tx,ty,entry.opacity*(entry.artworkOpacity??1),hiddenUids?.has(entry.uid)?0:1],offset);
      }
      if(refreshedCrops){
        this.artworkStats();
        if(this.rasterCache.stats.activeBytes>(this.rasterCache.maxBytes||previewMemoryPlan().editorRasters)){
          this.prepare(options,geometry,parallax);this.lastRasterResolution=viewResolution=requestedResolution;continue;
        }
      }
      break;
    }
    this.device.queue.writeBuffer(this.transformBuffer, 0, this.transformData);
    // Generated effects follow their target's parallax and live drag offsets.
    const generatorBatch=offsetGeneratorBatch(generatorBatchFor(report,frame,geometry,{enabled:options.vfxEnabled!==false,budgetMs:INTERACTIVE_SAMPLING_MS}),uid=>{const depth=parallax(uid),delta=dragTranslations?.get?.(uid)||dragTranslations?.[uid];return {x:depth.x+(delta?.x||0),y:depth.y+(delta?.y||0)};});
    this.lastGeneratorBatch=generatorBatch;
    const generatorPlan=generatorBatch&&generatorSchedule(generatorBatch,hiddenUids);
    if(generatorPlan&&!generatorPlan.empty)this.generatorGpu().upload(generatorBatch);
    const encoder = this.device.createCommandEncoder({ label: 'StykAnimate viewport frame' });
    if(drawingGpu&&!drawingGpu.destroyed)drawingGpu.encode(encoder);
    const timestampWrites=this.gpuTiming?.begin(this.measureFrame);
    this.stats.onionRenderedFrames=this.stats.onionFrameHits=0;
    const hasOnions=this.layout.some(entry=>entry.isOnion);
    const lastOnion=hasOnions&&!hasSceneVfx(frame)?this.layout.findLastIndex(entry=>entry.isOnion):-1;
    if(hasOnions){this.onionComposite??=new OnionComposite(this);this.onionComposite.prepare(uniform);}
    else if(this.onionComposite){this.onionComposite.destroy();this.onionComposite=null;this.stats.onionCompositeBytes=this.stats.onionCacheBytes=0;}
    const destination=this.context.getCurrentTexture().createView();
    const firstTimestamps=timestampWrites&&lastOnion>=0?{querySet:timestampWrites.querySet,beginningOfPassWriteIndex:timestampWrites.beginningOfPassWriteIndex}:timestampWrites;
    let pass = encoder.beginRenderPass({ colorAttachments: [{...this.colorAttachment(destination), ...(hasOnions?{storeOp:'store'}:{})}], ...(firstTimestamps?{timestampWrites:firstTimestamps}:{}) });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.globalBindGroup);
    let calls = 0, begin = -1, count = 0;
    const flush = () => { if (!count) return; pass.setBindGroup(1, this.blankBindGroup); pass.draw(6, count, 0, begin); calls++; begin = -1; count = 0; };
    const walker=generatorPlan&&!generatorPlan.empty?scheduleWalker(generatorPlan,draws=>{flush();this.generators.draw(pass,draws,this.msaaCount,p=>{p.setPipeline(this.pipeline);p.setBindGroup(0,this.globalBindGroup);});calls+=draws.length;}):null;
    let generatorsBegun=false;
    for (let i=0;i<this.layout.length;i++) {
      const entry=this.layout[i];
      if(entry.isOnion&&hasSceneVfx(frame)){flush();continue;}
      if(entry.isOnion){
        flush();const end=onionLayerEnd(this.layout,i);
        const finalTimestamps=timestampWrites&&end-1===lastOnion?{querySet:timestampWrites.querySet,endOfPassWriteIndex:timestampWrites.endOfPassWriteIndex}:undefined;
        const composite=this.onionComposite.draw(encoder,destination,pass,this.layout,i,end,finalTimestamps);pass=composite.pass;calls+=composite.calls;i=end-1;continue;
      }
      if(walker&&entry.g&&!entry.isOnion){if(!generatorsBegun){walker.begin();generatorsBegun=true;}walker.object(entry.uid);}
      if(entry.outlinedVectors&&this.rasterView){
        // Keep the compiled layout independent of the viewport. Skip its draw
        // range when wholly outside; panning needs no geometry rebuild/upload.
        const offset=entry.transform*4,bounds=this.geometryBounds(entry.source,entry.source.drawables),view=this.rasterView;
        const dx=this.transformData[offset]-entry.source.root.x,dy=this.transformData[offset+1]-entry.source.root.y;
        if(!this.transformData[offset+3]||bounds.x+dx+bounds.width<view.x||bounds.y+dy+bounds.height<view.y||bounds.x+dx>view.x+view.width||bounds.y+dy>view.y+view.height){flush();continue;}
      }
      if (entry.gpuDraw) { flush(); drawingGpu.draw(pass, entry.gpuDraw); pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.globalBindGroup); calls++; }
      else if (entry.texture) { flush(); pass.setBindGroup(1, entry.texture.bindGroup); pass.draw(6, entry.count, 0, entry.offset); calls++; }
      else { if (begin < 0) begin = entry.offset; count += entry.capacity; }
    }
    flush();
    if(walker){if(!generatorsBegun)walker.begin();walker.end();}
    // Trails still being sampled refine on the next frame.
    if(generatorBatch?.incomplete)queueMicrotask(()=>this.options.onInvalidate?.());
    this.stats.generatedParticles=generatorBatch?.particles??0;
    this.stats.handleCount=options.canvasHandles?.length||0;
    this.stats.handleUploadBytes=options.canvasHandles ? this.handleRenderer.update(options.canvasHandles,dragTranslations,options.outlineHandles) : 0;
    this.stats.handleDrawCalls=options.canvasHandles&&!hasSceneVfx(frame) ? this.handleRenderer.draw(pass) : 0;
    calls+=this.stats.handleDrawCalls;
    pass.end(); this.gpuTiming?.resolveInto(encoder,timestampWrites);this.device.queue.submit([encoder.finish()]);this.gpuTiming?.submitted(timestampWrites);
    if(this.measureFrame)this.telemetryStages.submit=performance.now()-measureAt;
    if(hasSceneVfx(frame))this.finishSceneVfx({...options,geometry,viewportUniforms:uniform});
    Object.assign(this.stats, { frameMs: performance.now() - start, drawCalls: calls, mode: 'retained editor', transformUploadBytes: this.transformData.byteLength,
      preparedBytes: this.preparedFrames.bytes, preparedFrames: this.preparedFrames.frames.size, workerCompileMs: null, packetUploadMs: null });
    return geometry;
  }
  finishSceneVfx(options){return renderPreviewVfx(this,'vfxViewport',()=>new ViewportVfx(this),viewport=>viewport.render(options));}
  /** Generated-effect pipelines share this device and the viewport globals. */
  generatorGpu(){return this.generators??=new GeneratorGpu(this.device,this.format,this.uniform);}
  /** Drawing cels that objectEntry presents from their tile presenter rather
   * than from a compatibility raster of the published image. */
  liveDrawing(items, isOnion) {
    const figure = items.length === 1 && !isOnion ? items[0].fig : null, meta = figure && drawingMetadata(figure);
    if (!meta || hasDrawableVfx(items[0])) return false;
    const drawing = this.resources.drawing?.(figure);
    return Boolean(drawing && (drawing.store || meta.version === 2));
  }
  /** Switch drawing cels between GPU-resident tiles and the canvas scratch
   * presenter (the Canvas 2D path). Used by diagnostics and fallback tests. */
  setGpuDrawing(enabled) {
    if (!enabled) { this.gpuDrawingPending = null; this.drawingGpu?.destroy(); this.drawingGpu = null; this.gpuDrawingReady = Promise.resolve(false); }
    else if (!this.destroyed && !this.deviceLost) this.enableGpuDrawing();
    this.lastGeometry = null; this.options.onInvalidate?.();
    return this.gpuDrawingReady;
  }
  /** Visible level-0 pixel rect and display level for a GPU drawing entry,
   * matching the scratch path's mip choice. */
  gpuDrawingView(entry,camera,{width=this.width,height=this.height,dpr=this.dpr,translation}={}){
    const {absolute:m,matrix,alpha}=entry.gpuDrawing,cd=camera[0]*camera[3]-camera[1]*camera[2],md=m[0]*m[3]-m[1]*m[2];
    let rect=null;
    if(Math.abs(cd)>1e-12&&Math.abs(md)>1e-12){
      const toWorld=p=>({x:(camera[3]*(p.x-camera[4])-camera[2]*(p.y-camera[5]))/cd,y:(camera[0]*(p.y-camera[5])-camera[1]*(p.x-camera[4]))/cd});
      const depth=this.rasterParallax?.(entry.uid),move=this.rasterDrag?.get?.(entry.uid)||this.rasterDrag?.[entry.uid];
      const shift=translation??{x:(depth?.x||0)+(move?.x||0),y:(depth?.y||0)+(move?.y||0)},mx=m[4]+shift.x,my=m[5]+shift.y;
      const toPixel=p=>({x:(m[3]*(p.x-mx)-m[2]*(p.y-my))/md,y:(m[0]*(p.y-my)-m[1]*(p.x-mx))/md});
      const ps=[[0,0],[width,0],[width,height],[0,height]].map(([x,y])=>toPixel(toWorld({x,y})));
      const x=Math.min(...ps.map(p=>p.x)),y=Math.min(...ps.map(p=>p.y));
      rect={x,y,width:Math.max(...ps.map(p=>p.x))-x,height:Math.max(...ps.map(p=>p.y))-y};
    }
    const deviceScale=Math.max(1e-9,Math.hypot(camera[0],camera[1])*dpr*Math.hypot(m[0],m[1]));
    return {matrix,alpha,rect,transform:entry.transform,level:Math.max(0,Math.min(8,Math.floor(-Math.log2(deviceScale))))};
  }
  destroy() {
    this.gpuTiming?.destroy();
    this.drawingGpu?.destroy();
    for(const texture of this.drawingTextures?.values()??[])texture.texture.destroy();this.drawingTextures?.clear();
    this.vfxViewport?.destroy();
    this.generators?.destroy(); this.generators = null;
    this.artworks.clear();
    this.destroyed = true; this.last = null; this.uploadStaging = null; this.onionScenes = []; this.onionComposite?.destroy(); this.preparedFrames.clear(); this.handleRenderer?.destroy(); this.msaa?.destroy(); this.shapeBuffer?.destroy(); this.transformBuffer?.destroy(); this.uniform?.destroy(); this.blankTexture?.destroy();
    this.rasterCache.clear();
    for (const entry of this.backgroundImages?.values() || []) entry.texture.destroy();
    this.disposeRasterSurfaces(); releaseVfxDevice(this.device); this.context.unconfigure(); this.device.destroy();
  }
}

function preparedSceneKeys(options, dpr, width, height) {
  const {report, frame} = options, camera = cameraMatrix(options);
  return {
    backgroundKey: JSON.stringify([frame.background_id, frame.background_id_b, frame.background_mix, editorBackgroundColor(options) ?? sceneBackgroundColor(report, frame), effectiveCamera(report, frame, options.cameraEnabled !== false)]),
    rasterResolution: rasterResolution(Math.hypot(camera[0], camera[1]) * dpr),
    viewKey: `${camera.join()}|${width}|${height}|${dpr}`,
  };
}

/** Build a replacement editor layout without changing live buffers. Existing
 * artwork stays owned by the renderer; leases protect both layouts until the
 * caller atomically publishes or cancels this preparation. */
async function prepareSceneUpdate(renderer, request) {
  const {report, frame, geometry, signal, sliceMs=4, yieldControl, getView}=request;
  if(renderer.activeReport!==report||!geometry)throw messageError(new Error(''), "errors.renderer.anEditableSceneUpdateRequiresTheActiveDocument", {});
  const generation=renderer.generation, liveGeometry=renderer.lastGeometry, started=performance.now();
  let stage, disposed=false, activated=false;
  const lease=renderer.rasterCache.lease(renderer.layout?.map(entry=>entry.texture).filter(Boolean));
  const check=()=>{
    if(disposed||signal?.aborted||renderer.destroyed||renderer.deviceLost||renderer.activeReport!==report||renderer.generation!==generation||renderer.lastGeometry!==liveGeometry||request.checkCurrent?.()===false)
      throw messageError(new DOMException('', 'AbortError'), "errors.renderer.editableScenePreparationWasSuperseded", {});
  };
  const dispose=()=>{
    if(disposed||activated)return;disposed=true;
    stage?.shapeBuffer?.destroy();stage?.transformBuffer?.destroy();stage?.disposeRasterSurfaces();
    for(const entry of stage?.backgroundImages?.values()||[])entry.texture.destroy();
    stage?.backgroundImages?.clear();for(const texture of stage?.drawingTextures?.values()??[])texture.texture.destroy();
    lease.release();
    if(!renderer.destroyed)renderer.artworkStats();
  };
  try {
    check();
    stage=new WebGPURenderer(renderer.canvas,renderer.device,renderer.context,renderer.format,{...renderer.options,onInvalidate:undefined,onStatus:undefined});
    for(const key of ['pipeline','isolationPipeline','isolationSamples','isolationSinglePipeline','globalLayout','textureLayout','uniform','sampler','nearestSampler','blankBindGroup','resources','rasterCache','vectorCache','compatibilityCache','artworks','artworkAliases','boundsCache'])stage[key]=renderer[key];
    // Planning records drawing transforms but does not upload or own GPU tiles.
    // Keep the live tile backend and viewport so held cels never prepare an
    // empty scratch against an undefined viewport.
    stage.drawingGpu=renderer.drawingGpu;
    stage.activeReport=report;stage.generation=generation;stage.rasterLease=lease;stage.predecessor=renderer;
    const timings={};let view={...(getView?.()||request.view||{})}, keys;
    for(;;){
      check();stage.dpr=renderer.dpr;stage.width=renderer.width;stage.height=renderer.height;
      const options={...request,report,frame,geometry,view};
      const built=await consumeSceneSteps(stage.prepareSteps(options,geometry),{signal,sliceMs,yieldControl,checkCurrent:check,onProgress:request.onProgress});
      timings.gpu=built.timings;check();
      // Uploads and the next draw use the same ordered GPU queue. Publication
      // needs no CPU readback, so a queue-wide fence only delays the playhead.
      check();
      keys=preparedSceneKeys(options,stage.dpr,stage.width,stage.height);
      view={...(getView?.()||view)};
      const fresh=preparedSceneKeys({...options,view},renderer.dpr,renderer.width,renderer.height);
      if(stage.stats.textureObjects&&keys.rasterResolution!==fresh.rasterResolution || stage.stats.outlinedVectorObjects&&fresh.rasterResolution<=8 || stage.stats.croppedTextureObjects&&keys.viewKey!==fresh.viewKey)continue;
      stage.lastReport=report;stage.backgroundKey=keys.backgroundKey;stage.onionFrameRefs=[...(request.onionFrames||[])];
      stage.lastRasterResolution=fresh.rasterResolution;break;
    }
    timings.elapsedMs=performance.now()-started;
    return {report,frame,geometry,view,timings,dispose,
      activate(){
        check();if(activated)throw messageError(new Error(''), "errors.renderer.theEditableSceneWasAlreadyPublished", {});
        const fresh=preparedSceneKeys({...request,view:getView?.()||view},renderer.dpr,renderer.width,renderer.height);
        if(fresh.backgroundKey!==keys.backgroundKey||(stage.stats.textureObjects&&fresh.rasterResolution!==stage.lastRasterResolution)||stage.stats.outlinedVectorObjects&&fresh.rasterResolution<=8||stage.stats.croppedTextureObjects&&fresh.viewKey!==stage.drawingViewKey)
          throw messageError(new DOMException('', 'AbortError'), "errors.renderer.theEditableSceneViewChangedBeforePublication", {});
        stage.copySharedEntries(renderer);
        renderer.shapeBuffer?.destroy();renderer.transformBuffer?.destroy();renderer.disposeRasterSurfaces();
        for(const entry of renderer.backgroundImages?.values()||[])entry.texture.destroy();
        for(const texture of renderer.drawingTextures?.values()??[])texture.texture.destroy();
        for(const key of ['drawingTextures','entries','layout','lastGeometry','lastGeneration','lastReport','backgroundKey','backgroundImages','onionScenes','onionFrameRefs','lastRasterResolution','drawingViewKey','rasterView','rasterParallax','rasterDrag','shapeBuffer','transformBuffer','globalBindGroup','transformData','shapeCount','entriesBySlot','uploadStaging','rasterSurfaces','pathRasterSurfaces'])renderer[key]=stage[key];
        renderer.previewRasterScale = stage.previewRasterScale;
        Object.assign(renderer.stats,stage.stats,{preparedCache:renderer.preparedFrames.stats,editablePreparation:timings});
        activated=true;lease.release();renderer.artworkStats();
        renderer.last=null;return geometry;
      }};
  }catch(error){dispose();throw error;}
}

/** Build an incoming scene without touching the live canvas, caches or buffers. */
async function prepareInitialScene(renderer, request) {
  const {report, frame, signal, sliceMs = 4, yieldControl, onProgress, getView} = request;
  const constructionColor = editorBackgroundColor(request);
  if (!report || !frame) throw messageError(new Error(''), "errors.renderer.anInitialSceneRequiresItsReportAndEvaluated", {});
  if (renderer.activeReport === report || renderer.last?.report === report) throw messageError(new Error(''), "errors.renderer.initialScenePreparationRequiresASeparateIncomingDocument", {});
  const started = performance.now(); let stage, transferred = false, imageFailure;
  const checkCurrent = () => {
    if (renderer.destroyed || signal?.aborted) throw messageError(new DOMException('', 'AbortError'), "errors.renderer.scenePreparationCancelled", {});
    if (renderer.device && renderer.stats.backend !== 'WebGPU') throw messageError(new Error(''), "errors.renderer.theGraphicsDeviceIsUnavailable", {});
    request.checkCurrent?.(); if (imageFailure) throw imageFailure;
  };
  const media = createSceneImages({url: renderer.resources.url, signal, checkCurrent, imageFactory: request.imageFactory});
  const discard = () => {
    if (transferred) return;
    if (stage) {
      stage.destroyed = true; stage.shapeBuffer?.destroy(); stage.transformBuffer?.destroy();
      for (const entry of stage.backgroundImages?.values() || []) entry.texture.destroy();
      stage.backgroundImages?.clear(); stage.rasterCache.clear(); stage.disposeRasterSurfaces(); stage.layout = []; stage.entries.clear();
    }
    media.dispose();
  };
  const backgroundLoad = media.load(backgroundImageAssets(report, frame)).catch(error => {imageFailure = error;});
  try {
    checkCurrent();
    const timings = {}, geometry = request.geometry || await (await import('./pivot/geometry.mjs')).buildGeometryAsync(report, frame, null, {
      signal, sliceMs, yieldControl, checkCurrent, onProgress, onTiming: value => {timings.geometry = value;},
    });
    await backgroundLoad; checkCurrent();
    timings.backgroundImages = media.images.lastPreparation;
    const imageStart = performance.now();
    await media.load(frameImageAssets(geometry)); checkCurrent();
    timings.figureImages = media.images.lastPreparation === timings.backgroundImages
      ? {reused: true} : media.images.lastPreparation;
    timings.figureImagesMs = performance.now() - imageStart;
    timings.mediaReadyMs = performance.now() - started;
    let view = {...(getView?.() || request.view || {})};
    if (renderer instanceof WebGPURenderer) {
      stage = new WebGPURenderer(renderer.canvas, renderer.device, renderer.context, renderer.format, {
        ...renderer.options, resources: media.resources, onInvalidate: undefined, onStatus: undefined,
      });
      for (const key of ['pipeline', 'isolationPipeline', 'isolationSamples', 'isolationSinglePipeline', 'globalLayout', 'textureLayout', 'uniform', 'sampler', 'nearestSampler', 'blankBindGroup']) stage[key] = renderer[key];
      stage.activeReport = report;
      for (;;) {
        stage.dpr = renderer.dpr;stage.width = renderer.width;stage.height = renderer.height;
        const options = {report, frame, geometry, view, cameraEnabled: request.cameraEnabled !== false, editorBackgroundColor: constructionColor, onionFrames: []};
        const prepared = await consumeSceneSteps(stage.prepareSteps(options, geometry), {signal, sliceMs, yieldControl, checkCurrent, onProgress});
        timings.gpu = prepared.timings; checkCurrent();
        const queueStart = performance.now(); await renderer.device.queue.onSubmittedWorkDone();
        timings.gpuReadyMs = (timings.gpuReadyMs || 0) + performance.now() - queueStart; checkCurrent();
        const freshView = {...(getView?.() || view)}, keys = preparedSceneKeys(options, stage.dpr,stage.width,stage.height);
        const freshKeys = preparedSceneKeys({...options, view: freshView}, renderer.dpr,renderer.width,renderer.height);
        view = freshView;
        if (stage.stats.textureObjects && keys.rasterResolution !== freshKeys.rasterResolution || stage.stats.outlinedVectorObjects&&freshKeys.rasterResolution<=8 || stage.stats.croppedTextureObjects&&keys.viewKey!==freshKeys.viewKey) continue;
        stage.lastReport = report; stage.backgroundKey = keys.backgroundKey; stage.onionFrameRefs = [];
        stage.lastRasterResolution = freshKeys.rasterResolution; break;
      }
    }
    checkCurrent(); timings.elapsedMs = performance.now() - started;
    const prepared = {report, frame, geometry, images: media.images, view, timings, cameraEnabled: request.cameraEnabled !== false, editorBackgroundColor: constructionColor,
      renderer, stage, activated: false, disposed: false,
      dispose() {if (!this.activated && !this.disposed) {this.disposed = true; discard();}},
      transfer() {transferred = true; this.activated = true; media.detach?.();},
    };
    return prepared;
  } catch (error) {discard(); throw error;}
}

/** Publication is synchronous: all decoding, geometry and GPU allocation is done. */
function activatePreparedScene(renderer, prepared, options = {}) {
  const {report = prepared?.report, frame = prepared?.frame, geometry = prepared?.geometry, view = prepared?.view} = options;
  const constructionColor = Object.hasOwn(options, 'editorBackgroundColor') ? options.editorBackgroundColor : prepared?.editorBackgroundColor;
  if (!prepared || prepared.renderer !== renderer || prepared.activated || prepared.disposed || renderer.destroyed ||
      prepared.report !== report || prepared.frame !== frame || prepared.geometry !== geometry)
    throw messageError(new Error(''), "errors.renderer.thePreparedInitialSceneNoLongerMatchesThis", {});
  const stage = prepared.stage;
  if (stage) {
    const keys = preparedSceneKeys({report, frame, view, cameraEnabled: prepared.cameraEnabled, editorBackgroundColor: constructionColor}, renderer.dpr,renderer.width,renderer.height);
    if (keys.backgroundKey !== stage.backgroundKey)
      throw messageError(new Error(''), "errors.renderer.theConstructionBackgroundChangedAfterScenePreparationPrepare", {});
    if (stage.stats.textureObjects && keys.rasterResolution !== stage.lastRasterResolution || stage.stats.outlinedVectorObjects&&keys.rasterResolution<=8 || stage.stats.croppedTextureObjects&&keys.viewKey!==stage.drawingViewKey)
      throw messageError(new Error(''), "errors.renderer.theViewportChangedAfterScenePreparationPrepareIts", {});
    renderer.useReport(report);
    renderer.shapeBuffer?.destroy(); renderer.transformBuffer?.destroy(); renderer.disposeRasterSurfaces();
    for (const key of ['entries', 'layout', 'rasterCache', 'vectorCache', 'compatibilityCache', 'artworks', 'artworkAliases', 'generation', 'lastGeometry', 'lastGeneration',
      'lastReport', 'backgroundKey', 'backgroundImages', 'onionScenes', 'onionFrameRefs', 'lastRasterResolution', 'drawingViewKey','rasterView','rasterParallax','rasterDrag','shapeBuffer', 'transformBuffer',
      'globalBindGroup', 'transformData', 'shapeCount', 'entriesBySlot', 'uploadStaging', 'rasterSurfaces','pathRasterSurfaces']) renderer[key] = stage[key];
    renderer.previewRasterScale = stage.previewRasterScale;
    Object.assign(renderer.stats, stage.stats, {preparedCache: renderer.preparedFrames.stats, initialPreparation: prepared.timings});
    prepared.stage = null;
  }
  renderer.last = null; prepared.view = {...view}; prepared.transfer(); return geometry;
}

/** A WebGPU adapter that rasterizes on the CPU. SwiftShader, llvmpipe and
 * WARP-style drivers are slower than the Canvas compatibility path for this
 * workload, so they route there unless explicitly allowed. */
async function softwareAdapter(adapter) {
  if (adapter?.isFallbackAdapter) return true;
  let info = adapter?.info;
  if (!info) { try { info = await adapter?.requestAdapterInfo?.(); } catch { info = null; } }
  if (!info) return false;
  const signature = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
  return /swiftshader|llvmpipe|lavapipe|basic render|software|\bwarp\b/i.test(signature);
}

/** WebGPU is preferred. Unsupported systems get a clearly labeled compatibility renderer. */
export async function createRenderer(canvas, options = {}) {
  const materialsReady = prewarmAtlas();
  let reason = options.fallbackReason || 'WebGPU is unavailable in this browser or graphics driver.';
  let reasonKey = options.fallbackReasonKey || (!options.fallbackReason ? 'rendererStatus.unavailable' : undefined), reasonParams = options.fallbackReasonParams;
  if (!options.forceCanvas2D && globalThis.navigator?.gpu) {
    let device, renderer;
    const startup = gpuStartupBudget();
    try {
      const adapter = await startup.wait(navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
      if (!adapter) throw messageError(new Error(''), "errors.renderer.noCompatibleWebgpuAdapterWasFound", {});
      if (await startup.wait(softwareAdapter(adapter)) && !options.allowSoftwareAdapter)
        throw messageError(new Error(''), "errors.renderer.webgpuResolvedToASoftwareAdapterTheCompatibility", {});
      device = await startup.wait(requestInstrumentedDevice(adapter), lateDevice => lateDevice.destroy());
      const info = adapter.info;
      renderer = new WebGPURenderer(canvas, device, null, navigator.gpu.getPreferredCanvasFormat(), { ...options, adapterName: [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' · ') });
      renderer.gpuTiming=new GpuTiming(device,{enabled:options.diagnosticsEnabled,onTiming:options.onGpuTiming,onSupport:options.onGpuTimingSupport,getContext:options.measurementContext});
      await renderer.initialize(startup); await materialsReady; options.onStatus?.(renderer.stats); return renderer;
    } catch (error) {
      reason = error.message;
      const metadata = errorMessageData(error);
      reasonKey = metadata.messageKey; reasonParams = metadata.messageParams;
      if (renderer) { renderer.destroyed = true; renderer.generators?.destroy(); renderer.gpuTiming?.destroy(); }
      device?.destroy();
      // A canvas cannot change its context type after WebGPU has been acquired.
      if (renderer?.context) { renderer.context.unconfigure(); throw messageError(new Error(''), "errors.renderer.webgpuInitializationFailed", {reason: reason}); }
    }
  }
  await materialsReady;
  const fallback = new CanvasFallback(canvas, options, reason);
  if (reasonKey) Object.assign(fallback.stats, {reasonKey, reasonParams});
  options.onStatus?.(fallback.stats); return fallback;
}
