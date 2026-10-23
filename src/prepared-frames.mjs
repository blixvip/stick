import {messageError} from './localized-error.mjs';
import { cameraMatrix, SHAPE_BYTES, SHAPE_FLOATS, SHAPE, shapeRecord, textureBucket, textureRegion } from './renderer-geometry.mjs';
import {bitmapKey,bitmapBytes,entryImage} from './playback-bitmap-pool.mjs';
import {playbackMemoryBudget,playbackReuseMemoryPlan} from './playback-budget.mjs';
import {EditorRasterCache} from './renderer-raster-cache.mjs';
import {hasSceneVfx} from './vfx-viewport.mjs';
import {rasterizeVectorVfx,filterArtworkVfx} from './renderer-vfx-vector.mjs';
import {encodeVectorRaster,analyticCoverage} from './renderer-vector-raster.mjs';
import {encodeMeshRaster,meshRasterBytes} from './renderer-mesh-raster.mjs';
import {offsetGeneratorBatch,generatorSchedule,scheduleWalker} from './vfx-generator-frame.mjs';

export function preparedCameraMode(packet, requested) {
  const mode = packet.cameraEnabled === undefined ? true : packet.cameraEnabled;
  if (typeof mode !== 'boolean' || (requested !== undefined && typeof requested !== 'boolean'))
    throw messageError(new TypeError(''), "errors.preparedFrames.preparedFrameCameraModeMustBeABoolean", {});
  if (requested !== undefined && requested !== mode)
    throw messageError(new Error(''), "errors.preparedFrames.preparedFrameCameraModeDiffersFromItsCropped", {});
  return mode;
}

/** One render-attachment descriptor honoring the active MSAA level. At 1× the
 * pass draws straight into the resolve target instead of discarding samples. */
const colorAttachment = (msaa, resolveView) => msaa
  ? { view: msaa.createView(), resolveTarget: resolveView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }
  : { view: resolveView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' };

/** Commands tagged for generated effects: backgrounds, one run per effect
 * target, and merged runs of everything else between them. */
export const PREPARED_BACKGROUND = -1, PREPARED_OTHER = -2;
export function combinePreparedCommands(backgrounds, groups, textures, uids = null, targets = null) {
  const commands = []; let base = 0;
  const append = (firstInstance, instanceCount, texture = null, uid = null) => {
    if (!instanceCount) return;
    const previous = commands.at(-1);
    if (!texture && previous && !previous.texture && previous.firstInstance + previous.instanceCount === firstInstance && previous.uid === uid) previous.instanceCount += instanceCount;
    else commands.push({ firstInstance, instanceCount, texture, uid });
  };
  const tag = group => targets ? (targets.has(uids?.[group.transformIndex]) ? uids[group.transformIndex] : PREPARED_OTHER) : null;
  for (const background of backgrounds) { const count = background.data.length / SHAPE_FLOATS; append(base, count, background.texture, targets ? PREPARED_BACKGROUND : null); base += count; }
  for (const group of groups) append(base + group.firstInstance, group.instanceCount, group.compatibilityIndex === undefined ? null : textures[group.compatibilityIndex], tag(group));
  return { commands, backgroundCount: base };
}
/** Encode prepared artwork, drawing generated effects beside their targets. */
export function encodePreparedCommands(renderer, pass, frame, {hiddenUids, dragTranslations, skipBackground = false} = {}) {
  const batch = frame.generators && offsetGeneratorBatch(frame.generators, uid => dragTranslations?.get?.(uid));
  const plan = batch && generatorSchedule(batch, hiddenUids), gpu = plan && !plan.empty ? renderer.generatorGpu?.() : null;
  if (gpu) gpu.upload(batch);
  const walker = gpu ? scheduleWalker(plan, draws => gpu.draw(pass, draws, renderer.msaaCount, p => { p.setPipeline(renderer.pipeline); p.setBindGroup(0, frame.bindGroup); })) : null;
  let begun = false;
  for (const command of frame.commands) {
    if (walker && command.uid !== null && command.uid !== PREPARED_BACKGROUND) { if (!begun) { walker.begin(); begun = true; } walker.object(command.uid); }
    let first = command.firstInstance, count = command.instanceCount;
    if (skipBackground) { first = Math.max(first, frame.backgroundCount); count = command.firstInstance + command.instanceCount - first; if (count <= 0) continue; }
    pass.setBindGroup(1, command.texture?.bindGroup || renderer.blankBindGroup); pass.draw(6, count, 0, first);
  }
  if (walker) { if (!begun) walker.begin(); walker.end(); }
}

/** Animated artwork changes size every tick, so exact-size recycling almost
 * never hits and each frame allocated fresh textures on the shared GPU process.
 * Poolable artwork occupies the top-left of a bucketed allocation (at most a
 * quarter larger per axis); its record samples only that region, clamped to
 * the last texel centre, so filtering and coverage match an exact texture.
 * Glyph masks and filtered VFX keep exact allocations; meshes recycle exact sizes. */
const poolableEntry = entry => { const image = entryImage(entry);
  return Boolean(image?.width) && !entry.glyphMask && !entry.vfx && Math.max(image.width, image.height) >= 64; };
const allocationSize = entry => { const image = entryImage(entry);
  return poolableEntry(entry) && !entry.meshRaster ? [textureBucket(image.width), textureBucket(image.height)] : [image.width, image.height]; };
const preparedEntryBytes = entry => { if (!entryImage(entry)) return 0; const [width, height] = allocationSize(entry); return width * height * 4; };
function scaleTextureRecord(data, offset, resource) {
  data.set(textureRegion(resource.width, resource.height, resource.poolW, resource.poolH), offset + 16);
}

/** Owns only uploaded GPU resources. The playback controller owns packet/bitmap lifetime. */
export class PreparedFrameCache {
  constructor(renderer, { maxBytes = playbackMemoryBudget(), maxFrames = 120 } = {}) {
    this.renderer = renderer; this.maxBytes = maxBytes; this.maxFrames = maxFrames;
    this.frames = new Map(); this.bytes = 0; this.report = null; this.revision = null;
    this.textures=new Map();this.generation=null;
    // Texture alloc/destroy churn stalls the shared GPU process; recycled
    // exact-sized textures reuse matching allocations during playback. One
    // antialias target per size is enough: raster passes serialize on the
    // queue, so they can share an attachment within and across submissions.
    const reuse=playbackReuseMemoryPlan(maxBytes);
    this.texturePool=new Map();this.poolQueue=[];this.texturePoolBytes=0;this.maxTexturePoolBytes=reuse.gpuRecycled;
    this.msaaPool=new Map();this.scratch={uniform:[],transforms:[],shapes:new Map()};
    this.maxMsaaPoolBytes=reuse.gpuMsaa;
    this.maxScratchBytes=reuse.gpuScratch;
    // The no-OffscreenCanvas path has the same owner and budget as uploaded
    // bitmaps. Editable layout eviction must never destroy a prepared texture.
    this.fallbackRasters = new EditorRasterCache();
    this.stats = { frames: 0, bytes: 0, maxBytes, maxFrames, hits: 0, misses: 0, evictions: 0, uploads: 0,textureUploads:0,reusedTextures:0,uniqueTextures:0,pooledTextures:0,
      warmFrames:0,warmSlices:0,warmCpuMs:0,warmMaxSliceMs:0,warmFailures:0 };
  }
  has(key) {
    const frame = this.frames.get(String(key));
    return Boolean(frame && frame.generation === this.renderer.generation);
  }
  _remove(key, eviction = false) {
    const frame = this.frames.get(key); if (!frame) return;
    this.frames.delete(key); this.bytes -= frame.bufferBytes;
    frame.shapeBuffer.destroy(); frame.transformBuffer.destroy();
    this._releaseTextures(frame.ownedTextures);
    if (eviction) this.stats.evictions++;
    this.stats.frames = this.frames.size; this.stats.bytes = this.bytes;this.stats.uniqueTextures=this.textures.size;
    if (this.renderer.stats) Object.assign(this.renderer.stats, { preparedBytes: this.bytes, preparedFrames: this.frames.size });
  }
  _releaseTextures(resources){
    for(const resource of resources)if(!--resource.refs){
      if (resource.raster) this.fallbackRasters.delete(resource.raster);
      else if (resource.poolable && resource.poolKey) {
        // Adjacent frames need similar bucket sizes; trimming the oldest pooled
        // textures keeps room for fresh releases instead of refusing them.
        while (this.poolQueue.length && this.texturePoolBytes + resource.bytes > this.maxTexturePoolBytes) {
          const oldest = this.poolQueue.shift(), list = this.texturePool.get(oldest.poolKey), at = list?.indexOf(oldest) ?? -1;
          if (at >= 0) list.splice(at, 1);
          if (!list?.length) this.texturePool.delete(oldest.poolKey);
          this.texturePoolBytes -= oldest.bytes; oldest.texture.destroy();
        }
        if (this.texturePoolBytes + resource.bytes <= this.maxTexturePoolBytes) {
          let bucket = this.texturePool.get(resource.poolKey);
          if (!bucket) { bucket = []; this.texturePool.set(resource.poolKey, bucket); }
          bucket.push(resource); this.poolQueue.push(resource); this.texturePoolBytes += resource.bytes;
        } else resource.texture.destroy();
      } else resource.texture.destroy();
      this.textures.delete(resource.key);this.bytes-=resource.bytes;
    }
  }
  clear() { this.cancelWarm(); for (const key of this.frames.keys()) this._remove(key); this.report = null; this.revision = null;
    for (const bucket of this.texturePool.values()) for (const resource of bucket) resource.texture.destroy();
    this.texturePool.clear(); this.poolQueue.length = 0; this.texturePoolBytes = 0;
    for (const entry of this.msaaPool.values()) entry.destroy(); this.msaaPool.clear();
    for (const buffer of this.scratch.uniform) buffer.destroy(); this.scratch.uniform.length = 0;
    for (const buffer of this.scratch.transforms) buffer.destroy(); this.scratch.transforms.length = 0;
    for (const list of this.scratch.shapes.values()) for (const buffer of list) buffer.destroy(); this.scratch.shapes.clear();
    Object.assign(this.stats,{msaaPoolBytes:0,scratchBytes:0,texturePoolBytes:0}); }
  /** Exact-size classes (meshes) match their key. Bucketed artwork takes the
   * smallest free allocation of its class that fits within twice the area. */
  _pooledTexture(poolKey, poolClass, width, height, bucketed) {
    let key = poolKey;
    if (bucketed && !this.texturePool.get(key)?.length) {
      let best = Infinity; key = null;
      for (const [candidate, bucket] of this.texturePool) {
        const resource = bucket.at(-1), area = resource ? resource.poolW * resource.poolH : Infinity;
        if (resource?.poolClass === poolClass && resource.poolW >= width && resource.poolH >= height && area <= width * height * 2 && area < best) {best = area; key = candidate;}
      }
    }
    const bucket = key === null ? null : this.texturePool.get(key);
    const resource = bucket?.pop();
    if (resource) this._unpool(key, bucket, resource);
    return resource;
  }
  _unpool(poolKey, bucket, resource) {
    this.texturePoolBytes -= resource.bytes;
    if (!bucket?.length) this.texturePool.delete(poolKey);
    const at = this.poolQueue.indexOf(resource); if (at >= 0) this.poolQueue.splice(at, 1);
  }
  _isolationMsaa(poolKey, width, height) {
    const samples = this.renderer.isolationSamples;
    if (samples <= 1) return null;
    const key = `${poolKey}x${samples}`; let entry = this.msaaPool.get(key);
    if (!entry) { const texture = this.renderer.device.createTexture({ label: 'Pooled isolation antialiasing', size: [width, height], sampleCount: samples,
      format: this.renderer.format, usage: GPUTextureUsage.RENDER_ATTACHMENT }); entry={texture,bytes:width*height*4*samples,destroy:()=>texture.destroy()}; }
    this.msaaPool.delete(key);this.msaaPool.set(key,entry);
    return entry.texture;
  }
  /** Trim only after submitting or discarding the batch. Destroying an MSAA
   * attachment or recycling a buffer referenced by an unsubmitted encoder
   * would invalidate that entire batch. Active work retains its own leases. */
  _trimRasterScratch() {
    let msaaBytes=0;for(const entry of this.msaaPool.values())msaaBytes+=entry.bytes;
    for(const [key,entry] of this.msaaPool){if(msaaBytes<=this.maxMsaaPoolBytes)break;entry.destroy();this.msaaPool.delete(key);msaaBytes-=entry.bytes;}
    let scratchBytes=0;
    for(const list of [this.scratch.uniform,this.scratch.transforms,...this.scratch.shapes.values()]){
      for(let i=list.length-1;i>=0;i--){const buffer=list[i];if(scratchBytes+buffer.size>this.maxScratchBytes){list.splice(i,1);buffer.destroy();}else scratchBytes+=buffer.size;}
    }
    for(const [key,list] of this.scratch.shapes)if(!list.length)this.scratch.shapes.delete(key);
    Object.assign(this.stats,{msaaPoolBytes:msaaBytes,scratchBytes,texturePoolBytes:this.texturePoolBytes});
  }
  retainPackets(report, packets) {
    this.cancelWarm();
    if (report !== this.report || this.generation !== this.renderer.generation) {this.clear(); return;}
    const keep = new Set(Array.from(packets, packet => String(packet.key)));
    for (const key of this.frames.keys()) if (!keep.has(key)) this._remove(key);
    this.stats.retainedFrames = this.frames.size;
  }
  /** Exact residency check for speculative uploads. This never evicts a frame
   * or allocates GPU objects; actual admission still happens in prepare(). */
  canWarm(packet, {report, view = {scale:1}, cameraEnabled} = {}) {
    if(this.has(packet.key))return true;
    if(this.report!==report||this.generation!==this.renderer.generation||this.frames.size>=this.maxFrames)return false;
    if(!this.renderer.backgroundsReady(report,packet.frame))return false;
    cameraEnabled=preparedCameraMode(packet,cameraEnabled);
    const backgrounds=this.renderer.background({report,frame:packet.frame,view,cameraEnabled},descriptor=>descriptor);
    let bytes=Math.max(SHAPE_BYTES,packet.shapes.byteLength+backgrounds.reduce((n,b)=>n+b.data.byteLength,0))+packet.transforms.byteLength;
    const seen=new Set();
    for(const b of backgrounds)if(b.texture&&!seen.has(b.texture.cacheKey)){
      seen.add(b.texture.cacheKey);if(!this.textures.has(b.texture.cacheKey))bytes+=b.texture.bytes;
    }
    for(const entry of packet.compatibility||[]){
      // Legacy fallback dimensions are unknown until Canvas rasterization.
      if(!entryImage(entry))return false;
      const key=bitmapKey(packet,entry);
      if(!seen.has(key)){seen.add(key);if(!this.textures.has(key))bytes+=preparedEntryBytes(entry);}
    }
    return this.bytes+bytes<=this.maxBytes;
  }
  prepare(packet, { report, view = { scale: 1 }, cameraEnabled } = {}) {
    const options={report,view,cameraEnabled};
    let steps;
    if(this.warming?.packet===packet&&this.generation===this.renderer.generation&&this.warming.options.report===report&&this.warming.options.cameraEnabled===cameraEnabled){
      steps=this.warming.steps;this.warming=null;
    }else{this.cancelWarm();steps=this.prepareSteps(packet,options);}
    for(;;){const step=steps.next();if(step.done)return step.value;}
  }
  cancelWarm() {const warm=this.warming;this.warming=null;warm?.steps.return();}
  /** Reserve only unprotected LRU entries for one speculative upload. The
   * displayed frame and every requested successor keep their GPU resources. */
  beginWarm(packet, options, protectedKeys) {
    if(this.warming||this.renderer.destroyed||this.renderer.deviceLost||this.has(packet.key)||this.report!==options.report||this.generation!==this.renderer.generation||
      this.revision!==(packet.cacheEpoch??packet.revision)||!this.renderer.backgroundsReady(options.report,packet.frame))return null;
    const cameraEnabled=preparedCameraMode(packet,options.cameraEnabled);
    const backgrounds=this.renderer.background({...options,frame:packet.frame,cameraEnabled},descriptor=>descriptor);
    const required=new Map();
    for(const b of backgrounds)if(b.texture)required.set(b.texture.cacheKey,b.texture.bytes);
    for(const entry of packet.compatibility||[]){
      if(!entryImage(entry))return null;
      required.set(bitmapKey(packet,entry),preparedEntryBytes(entry));
    }
    const buffers=Math.max(SHAPE_BYTES,packet.shapes.byteLength+backgrounds.reduce((n,b)=>n+b.data.byteLength,0))+packet.transforms.byteLength;
    // Most speculative uploads fit without eviction; simulate reference counts
    // only when a frame actually has to be released.
    let missing=0;for(const [key,size] of required)if(!this.textures.has(key))missing+=size;
    if(this.frames.size<this.maxFrames&&this.bytes+buffers+missing<=this.maxBytes){
      const warm={packet,options,steps:this.prepareSteps(packet,options)};this.warming=warm;return warm;
    }
    const refs=new Map([...this.textures].map(([key,resource])=>[key,resource.refs]));
    let bytes=this.bytes,count=this.frames.size;const evict=[];
    const fits=()=>count<this.maxFrames&&bytes+buffers+[...required].reduce((n,[key,size])=>n+(refs.has(key)?0:size),0)<=this.maxBytes;
    for(const [key,frame] of this.frames){
      if(fits())break;
      if(protectedKeys.has(key))continue;
      evict.push(key);count--;bytes-=frame.bufferBytes;
      for(const resource of frame.ownedTextures){const next=refs.get(resource.key)-1;if(next)refs.set(resource.key,next);else{refs.delete(resource.key);bytes-=resource.bytes;}}
    }
    if(!fits())return null;
    for(const key of evict)this._remove(key,true);
    const warm={packet,options,steps:this.prepareSteps(packet,options)};this.warming=warm;return warm;
  }
  stepWarm(warm, sliceMs=2) {
    if(this.warming!==warm)return true;
    if(this.generation!==this.renderer.generation||this.renderer.destroyed||this.renderer.deviceLost){this.cancelWarm();return true;}
    const started=performance.now();
    let sliceBytes = 0;
    try{do{const step=warm.steps.next();if(step.done){this.warming=null;this.stats.warmFrames++;return true;}sliceBytes+=step.value||0;}while(performance.now()-started<sliceMs&&sliceBytes<6*1024*1024);}
    catch(error){this.cancelWarm();throw error;}
    finally{const elapsed=performance.now()-started;warm.sliceBytes=sliceBytes;this.stats.warmSlices++;this.stats.warmCpuMs+=elapsed;this.stats.warmMaxSliceMs=Math.max(this.stats.warmMaxSliceMs,elapsed);}
    return false;
  }
  *prepareSteps(packet, { report, view = { scale: 1 }, cameraEnabled } = {}) {
    const start = performance.now(), renderer = this.renderer, device = renderer.device, key = String(packet.key);
    cameraEnabled = preparedCameraMode(packet, cameraEnabled);
    if (!report) throw messageError(new TypeError(''), "errors.preparedFrames.preparingAFrameRequiresItsReport", {});
    const epoch = packet.cacheEpoch ?? packet.revision;
    if (this.report !== report || this.generation!==renderer.generation || (this.revision !== null && this.revision !== epoch)) this.clear();
    this.report = report; this.revision = epoch;this.generation=renderer.generation;
    if (!renderer.backgroundsReady(report, packet.frame)) return null;
    const prior = this.frames.get(key);
    // A key's mode is fixed while cached; a packet compiled for the other
    // camera view replaces the retained entry instead of coexisting with it.
    if (prior?.generation === renderer.generation && prior.cameraEnabled === cameraEnabled) { this.frames.delete(key); this.frames.set(key, prior); this.stats.hits++; return key; }
    if (prior) this._remove(key);
    if (!(packet.shapes instanceof Float32Array) || packet.shapes.length % SHAPE_FLOATS || !(packet.transforms instanceof Float32Array) || packet.transforms.length < 4 || packet.transforms.length % 4) throw messageError(new TypeError(''), "errors.preparedFrames.invalidPreparedFrameBuffers", {});
    const backgrounds = renderer.background({ report, frame: packet.frame, view, cameraEnabled }, descriptor => descriptor);
    const textures = [], ownedTextures = [];
    const backgroundTextures = new Map(backgrounds.filter(entry => entry.texture).map(entry => [entry.texture.cacheKey, entry.texture]));
    const backgroundBytes = [...backgroundTextures.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const backgroundCountEstimate = backgrounds.reduce((sum, entry) => sum + entry.data.length / SHAPE_FLOATS, 0);
    const shapeBytesEstimate = Math.max(SHAPE_BYTES, packet.shapes.byteLength + backgroundCountEstimate * SHAPE_BYTES);
    const textureBytesEstimate = (packet.compatibility || []).reduce((sum, entry) => sum + preparedEntryBytes(entry), 0);
    const reservedBytes = shapeBytesEstimate + packet.transforms.byteLength + textureBytesEstimate + backgroundBytes;
    if (reservedBytes > this.maxBytes || this.maxFrames < 1) throw messageError(new Error(''), "errors.preparedFrames.preparedFrameExceedsTheMbGpuCacheBudget", {value: Math.round(this.maxBytes / 1024 / 1024)});
    if (shapeBytesEstimate > device.limits.maxStorageBufferBindingSize || packet.transforms.byteLength > device.limits.maxStorageBufferBindingSize) throw messageError(new Error(''), "errors.preparedFrames.preparedFrameExceedsThisGpuSStorageBuffer", {});
    // Evict before allocating textures so an upload does not temporarily double
    // the cache's GPU residency while an old frame is still retained.
    const incrementalBytes=()=>shapeBytesEstimate+packet.transforms.byteLength+
      [...backgroundTextures].reduce((sum,[key,entry])=>sum+(this.textures.has(key)?0:entry.bytes),0)+
      (packet.compatibility||[]).reduce((sum,entry)=>sum+(this.textures.has(bitmapKey(packet,entry))?0:preparedEntryBytes(entry)),0);
    while (this.frames.size && (this.frames.size >= this.maxFrames || this.bytes + incrementalBytes() > this.maxBytes)) this._remove(this.frames.keys().next().value, true);
    let shapeData = packet.shapes, textureBytes = 0,shapeBuffer,transformBuffer,committed=false;
    // Every isolated vector raster in one frame records into a single command
    // buffer: thousands of separate submits would starve the GPU process.
    const rasterBatch={encoder:null,cleanups:[],pending:new Set(),bytes:0};
    const flushRasterBatch=()=>{if(!rasterBatch.encoder)return;
      device.queue.submit([rasterBatch.encoder.finish()]);rasterBatch.encoder=null;
      const cleanups=rasterBatch.cleanups.splice(0);for(const cleanup of cleanups)cleanup();
      rasterBatch.bytes=0;this._trimRasterScratch();};
    try {
      // Own background textures just like artwork. Never borrow the editable
      // scene's mutable cache: pause, staging, and camera changes can replace it.
      for (const [key, descriptor] of backgroundTextures) {
        let resource = this.textures.get(key);const uploaded=!resource;
        if (!resource) {
          resource = {...descriptor.create(), key, refs: 0};
          this.textures.set(key, resource); this.bytes += resource.bytes; this.stats.textureUploads++;
        } else this.stats.reusedTextures++;
        resource.refs++; ownedTextures.push(resource); textureBytes += resource.bytes;
        yield uploaded ? resource.bytes : 0;
      }
      for (const entry of backgrounds) if (entry.texture) entry.texture = this.textures.get(entry.texture.cacheKey);
      for (const [i,compatibility] of (packet.compatibility || []).entries()) {
        if (entryImage(compatibility)) {
          const uploadMark=this.stats.textureUploads;
          const source = entryImage(compatibility);
          const resourceKey=bitmapKey(packet,compatibility);
          let resource=this.textures.get(resourceKey);
          if(!resource){
            if (!source.width || !source.height) throw messageError(new Error(''), "errors.preparedFrames.preparedFrameImageWasReleasedBeforeGpuUpload", {});
            // Filtered VFX and glyph masks retain their established ownership;
            // regular artwork may borrow an unused matching allocation.
            const poolable=poolableEntry(compatibility);
            this.stats[poolable?'poolableUploads':'unpooledUploads']=(this.stats[poolable?'poolableUploads':'unpooledUploads']||0)+1;
            // Dimensions alone do not establish texture compatibility. Vector
            // targets use the renderer format; external uploads require COPY_DST
            // and RGBA. Keep both allocation contracts distinct during reuse.
            const poolClass=compatibility.vectorRaster||compatibility.meshRaster?`vector:${renderer.format}`:'bitmap:rgba8unorm';
            let [poolW,poolH]=allocationSize(compatibility),poolKey=`${poolClass}:${poolW}x${poolH}`;
            const pooled=poolable?this._pooledTexture(poolKey,poolClass,poolW,poolH,!compatibility.meshRaster):null;
            if(pooled){this.stats.pooledTextures++;({poolW,poolH,poolKey}=pooled);}
            if (compatibility.meshRaster) {this.stats.meshRasters=(this.stats.meshRasters||0)+1;
              rasterBatch.encoder??=device.createCommandEncoder({label:`Prepared ${key} vector rasters`});
              let raster;
              try{raster=encodeMeshRaster(renderer,rasterBatch.encoder,{...compatibility,source,width:poolW,height:poolH,target:pooled?{texture:pooled.texture,bindGroup:pooled.bindGroup}:undefined,label:`Prepared ${key} mesh ${compatibility.uid}`});}
              catch(error){pooled?.texture.destroy();throw error;}
              rasterBatch.cleanups.push(raster.cleanup);rasterBatch.bytes+=poolW*poolH*4*Math.max(1,renderer.isolationSamples)+meshRasterBytes(source);
              resource={key:resourceKey,refs:0,texture:raster.texture,bindGroup:raster.bindGroup,width:raster.width,height:raster.height,bytes:raster.bytes,poolable,poolClass,poolKey,poolW,poolH};}
            else if (compatibility.vectorRaster) {this.stats[compatibility.vfx?'vfxRasters':'vectorRasters']=(this.stats[compatibility.vfx?'vfxRasters':'vectorRasters']||0)+1;
              if(compatibility.vfx)resource={...rasterizeVectorVfx(renderer,{...compatibility.vfx,data:source.data},{...compatibility,...source}),key:resourceKey,refs:0};
              else{rasterBatch.encoder??=device.createCommandEncoder({label:`Prepared ${key} vector rasters`});
                let raster;
                try{raster=encodeVectorRaster(renderer,rasterBatch.encoder,{...compatibility,...source,
                  target:{texture:pooled?.texture,bindGroup:pooled?.bindGroup,width:poolW,height:poolH},
                  msaa:poolable&&!(renderer.isolationSinglePipeline&&analyticCoverage(source.data))?this._isolationMsaa(poolKey,poolW,poolH):undefined,viewport:[poolW,poolH],scratch:poolable?this.scratch:undefined});}
                catch(error){pooled?.texture.destroy();throw error;}
                rasterBatch.cleanups.push(raster.cleanup);
                rasterBatch.bytes+=poolW*poolH*4*(renderer.isolationSinglePipeline&&analyticCoverage(source.data)?1:Math.max(1,renderer.isolationSamples))+source.data.byteLength;
                resource={key:resourceKey,refs:0,texture:raster.texture,bindGroup:raster.bindGroup,width:raster.width,height:raster.height,bytes:raster.bytes,poolable,poolClass,poolKey,poolW,poolH};}}
            else if (compatibility.vfx) {this.stats.vfxArtwork=(this.stats.vfxArtwork||0)+1;
              // Unfiltered Canvas artwork: upload it and run its figure stack here.
              resource={...filterArtworkVfx(renderer,compatibility.vfx,source,{width:source.width,height:source.height,pixelScale:compatibility.pixelScale,bounds:compatibility.bounds,
                label:`Prepared ${key} filtered object ${compatibility.uid}`}),key:resourceKey,refs:0};}
            else {this.stats.bitmapUploads=(this.stats.bitmapUploads||0)+1;
            const texture = pooled?.texture ?? device.createTexture({ label: `Prepared ${key} object ${compatibility.uid}`, size: [poolW, poolH], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
            resource = { key:resourceKey,refs:0,width:source.width,height:source.height,texture, bindGroup: pooled?.bindGroup ?? renderer.textureBindGroup(texture), bytes: poolW * poolH * 4, poolable, poolClass, poolKey, poolW, poolH };
            rasterBatch.pending.add(resource);
            try{
              // Band large copies so a single texture cannot monopolize the GPU
              // queue; the generator yields between bands for warm pacing.
              const bandRows=Math.max(1,Math.floor((8*1024*1024)/(source.width*4)));
              for(let y=0;y<source.height;y+=bandRows){
                const rows=Math.min(bandRows,source.height-y);
                device.queue.copyExternalImageToTexture({ source, origin: [0, y] }, { texture, origin: [0, y], premultipliedAlpha: true }, [source.width, rows]);
                if(y+bandRows<source.height)yield source.width*rows*4;
              }
            }catch(error){
              texture.destroy();
              rasterBatch.pending.delete(resource);resource=null;
              throw error;
            }
            rasterBatch.pending.delete(resource);
            }
            this.textures.set(resourceKey,resource);this.bytes+=resource.bytes;this.stats.textureUploads++;
          }else{
            if(source.width&&(resource.width!==source.width||resource.height!==source.height))throw messageError(new Error(''), "errors.preparedFrames.sharedGpuArtworkHasInconsistentDimensions", {});
            this.stats.reusedTextures++;
          }
          resource.refs++;
          textures.push(resource); ownedTextures.push(resource); textureBytes += resource.bytes;
          // Bound transient attachments/buffers as well as retained scratch.
          // Publication still waits for the complete frame; queue order keeps
          // earlier passes ahead of subsequent writes into recycled scratch.
          if(rasterBatch.bytes>=8*1024*1024||rasterBatch.cleanups.length>=32)flushRasterBatch();
          yield this.stats.textureUploads > uploadMark ? resource.bytes : 0;
        } else {
          // Runtimes without worker OffscreenCanvas use the established object-level renderer.
          const matrix = cameraMatrix({ report, frame: packet.frame, view, cameraEnabled });
          const raster = renderer.rasterObject(compatibility.g, compatibility.items, Math.hypot(matrix[0], matrix[1]) * renderer.dpr, compatibility.g, this.fallbackRasters);
          let resource = this.textures.get(raster);
          if (!resource) {
            resource = {...raster, raster, key: raster, refs: 0};
            this.textures.set(raster, resource); this.bytes += resource.bytes; this.stats.textureUploads++;
          } else this.stats.reusedTextures++;
          resource.refs++; textures.push(resource); ownedTextures.push(resource); textureBytes += resource.bytes;
          if (shapeData === packet.shapes) shapeData = packet.shapes.slice();
          const group = packet.groups.find(group => group.compatibilityIndex === i), b = resource.bounds, root = compatibility.root || compatibility.g.root;
          shapeData.set(shapeRecord({ mode: SHAPE.TEXTURE, gradient: resource.region, color: [1, 1, 1, 1], transform: group.transformIndex, a: [b.x - root.x, b.y - root.y, b.x + b.width - root.x, b.y + b.height - root.y] }), group.firstInstance * SHAPE_FLOATS);
        }
      }
      flushRasterBatch();
      for (const group of packet.groups) {
        const resource = group.compatibilityIndex === undefined ? null : textures[group.compatibilityIndex];
        if (!resource?.poolW || (resource.poolW === resource.width && resource.poolH === resource.height)) continue;
        if (shapeData === packet.shapes) shapeData = packet.shapes.slice();
        scaleTextureRecord(shapeData, group.firstInstance * SHAPE_FLOATS, resource);
      }
      const generatorTargets = packet.generators ? new Set(packet.generators.draws.filter(draw => draw.uid !== null).map(draw => draw.uid)) : null;
      const { commands, backgroundCount } = combinePreparedCommands(backgrounds, packet.groups, textures, packet.uids, generatorTargets);
      const shapeBytes = Math.max(SHAPE_BYTES, shapeData.byteLength + backgroundCount * SHAPE_BYTES), transformBytes = packet.transforms.byteLength, bytes = shapeBytes + transformBytes + textureBytes;
      // Fallback raster dimensions are known only after object rasterization.
      // References acquired above protect shared textures during this eviction.
      while (this.frames.size && this.bytes + shapeBytes + transformBytes > this.maxBytes) this._remove(this.frames.keys().next().value, true);
      if (this.bytes + shapeBytes + transformBytes > this.maxBytes) throw messageError(new Error(''), "errors.preparedFrames.preparedFrameExceedsTheGpuCacheBudget", {});
      shapeBuffer = device.createBuffer({ label: `Prepared shape packet ${key}`, size: shapeBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      transformBuffer = device.createBuffer({ label: `Prepared transforms ${key}`, size: transformBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      let offset = 0;
      for (const background of backgrounds) { device.queue.writeBuffer(shapeBuffer, offset, background.data); offset += background.data.byteLength; }
      if (shapeData.byteLength) device.queue.writeBuffer(shapeBuffer, offset, shapeData);
      device.queue.writeBuffer(transformBuffer, 0, packet.transforms);
      const bindGroup = device.createBindGroup({ layout: renderer.globalLayout, entries: [{ binding: 0, resource: { buffer: renderer.uniform } }, { binding: 1, resource: { buffer: shapeBuffer } }, { binding: 2, resource: { buffer: transformBuffer } }] });
      const frame = { key, cameraEnabled, nativeFrame: packet.frame, connectedVfxUids:packet.connectedVfxUids, shapeBuffer, transformBuffer, bindGroup, commands, backgroundCount, ownedTextures, generators: packet.generators ?? null,
        transforms: packet.transforms.slice(), liveTransforms: null, transformed: false, uids: packet.uids.slice(), bytes,bufferBytes:shapeBytes+transformBytes,
        objectCount: packet.objectCount, shapeCount: shapeData.length / SHAPE_FLOATS + backgroundCount,
        textureObjects: packet.compatibility?.length || 0, warnings: packet.warnings || [], generation: renderer.generation,
        compileMs: packet.compileMs, prepareMs: performance.now() - start, uploadedBytes: shapeBytes + transformBytes, scale: packet.scale };
      this.frames.set(key, frame); this.bytes += frame.bufferBytes; this.stats.uploads++;
      Object.assign(this.stats, { frames: this.frames.size, bytes: this.bytes,uniqueTextures:this.textures.size });
      Object.assign(renderer.stats || {}, { preparedBytes: this.bytes, preparedFrames: this.frames.size });
      committed=true;
      return key;
    } finally {for(const pending of rasterBatch.pending)pending.texture.destroy();for(const cleanup of rasterBatch.cleanups.splice(0))cleanup();if(!committed){this._releaseTextures(ownedTextures);shapeBuffer?.destroy();transformBuffer?.destroy();}this._trimRasterScratch();}
  }
  render(key, { report = this.report, view = {}, hiddenUids, dragTranslations, cameraEnabled } = {}) {
    const start = performance.now(), frame = this.frames.get(String(key)), renderer = this.renderer;
    if (!frame || frame.generation !== renderer.generation || report !== this.report) { this.stats.misses++; return false; }
    if(frame.connectedVfxUids?.some(uid=>hiddenUids?.has(uid)))return false;
    cameraEnabled = preparedCameraMode(frame, cameraEnabled);
    this.frames.delete(frame.key); this.frames.set(frame.key, frame); this.stats.hits++;
    const matrix = cameraMatrix({ report, frame: frame.nativeFrame, view, cameraEnabled }), zoom = Number(view.scale ?? 1), x = Number(view.x ?? 0), y = Number(view.y ?? 0);
    const uniform = new Float32Array([matrix[0], matrix[2], matrix[4], Math.hypot(matrix[0], matrix[1]), matrix[1], matrix[3], matrix[5], 0,
      renderer.width, renderer.height, renderer.dpr, 1, x, y, x + report.canvas_width * zoom, y + report.canvas_height * zoom]);
    renderer.device.queue.writeBuffer(renderer.uniform, 0, uniform);
    const transformBytes = this._writeTransforms(frame, hiddenUids, dragTranslations);
    const encoder = renderer.device.createCommandEncoder({ label: `Prepared playback ${frame.key}` });
    const timestampWrites=renderer.gpuTiming?.begin(renderer.measureFrame);
    const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment(renderer.msaa, renderer.context.getCurrentTexture().createView())],...(timestampWrites?{timestampWrites}:{}) });
    pass.setPipeline(renderer.pipeline); pass.setBindGroup(0, frame.bindGroup);
    encodePreparedCommands(renderer, pass, frame, {hiddenUids, dragTranslations});
    pass.end();renderer.gpuTiming?.resolveInto(encoder,timestampWrites);renderer.device.queue.submit([encoder.finish()]);renderer.gpuTiming?.submitted(timestampWrites);
    if(hasSceneVfx(frame.nativeFrame))renderer.finishSceneVfx({report,frame:frame.nativeFrame,view,cameraEnabled,preparedFrame:frame,viewportUniforms:uniform,hiddenUids,dragTranslations});
    Object.assign(renderer.stats, { mode: 'prepared playback', preparation: 'prepared', compiledObjects: 0, rasterizedObjects: 0, updatedObjects: 0, frameMs: performance.now() - start, drawCalls: frame.commands.length, primitives: frame.shapeCount, objects: frame.objectCount,
      textureObjects: frame.textureObjects, uploadBytes: 0, transformUploadBytes: transformBytes, gpuBytes: frame.bytes, preparedBytes: this.bytes, preparedFrames: this.frames.size,
      workerCompileMs: frame.compileMs, packetUploadMs: frame.prepareMs, warnings: frame.warnings });
    return true;
  }
  _writeTransforms(frame, hiddenUids, dragTranslations) {
    const renderer = this.renderer;
    if ((typeof hiddenUids?.has === 'function' && hiddenUids.size !== 0) || dragTranslations?.size) {
      frame.liveTransforms ??= new Float32Array(frame.transforms.length); frame.liveTransforms.set(frame.transforms);
      for (let i = 1; i < frame.uids.length; i++) { const uid = frame.uids[i], delta = dragTranslations?.get(uid), offset = i * 4;
        if (delta) { frame.liveTransforms[offset] += delta.x; frame.liveTransforms[offset + 1] += delta.y; }
        if (hiddenUids?.has(uid)) frame.liveTransforms[offset + 3] = 0;
      }
      renderer.device.queue.writeBuffer(frame.transformBuffer, 0, frame.liveTransforms); frame.transformed = true;
      return frame.liveTransforms.byteLength;
    }
    if (frame.transformed) { renderer.device.queue.writeBuffer(frame.transformBuffer, 0, frame.transforms); frame.transformed = false; return frame.transforms.byteLength; }
    return 0;
  }
  /** Draw one prepared frame into a caller-owned surface such as the inspector
   * camera monitor. The view scale is target pixels per scene pixel and the
   * clip is the full target, matching the prepared camera crop. */
  renderInto(key, { report = this.report, view = {}, target, hiddenUids, dragTranslations } = {}) {
    const frame = this.frames.get(String(key)), renderer = this.renderer;
    if (!frame || frame.generation !== renderer.generation || report !== this.report || !target?.context || (renderer.msaaCount > 1 && !target?.msaa)) { this.stats.misses++; return false; }
    if(frame.connectedVfxUids?.some(uid=>hiddenUids?.has(uid)))return false;
    const width = Math.max(1, Math.round(target.width ?? 0)), height = Math.max(1, Math.round(target.height ?? 0));
    const matrix = cameraMatrix({ report, frame: frame.nativeFrame, view, cameraEnabled: frame.cameraEnabled });
    renderer.device.queue.writeBuffer(renderer.uniform, 0, new Float32Array([
      matrix[0], matrix[2], matrix[4], Math.hypot(matrix[0], matrix[1]), matrix[1], matrix[3], matrix[5], 0,
      width, height, 1, 1, 0, 0, width, height]));
    this._writeTransforms(frame, hiddenUids, dragTranslations);
    const encoder = renderer.device.createCommandEncoder({ label: `Prepared surface ${frame.key}` });
    const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment(target.msaa, target.context.getCurrentTexture().createView())] });
    pass.setPipeline(renderer.pipeline); pass.setBindGroup(0, frame.bindGroup);
    encodePreparedCommands(renderer, pass, frame, {hiddenUids, dragTranslations});
    pass.end(); renderer.device.queue.submit([encoder.finish()]);
    this.frames.delete(frame.key); this.frames.set(frame.key, frame); this.stats.hits++;
    return true;
  }
}
