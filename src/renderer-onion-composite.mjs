import {OnionSurfaceCache, onionLayerKeys} from './onion-surface-cache.mjs';
import {previewMemoryPlan} from './playback-budget.mjs';

const shader = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<storage, read> opacities: array<f32>;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) opacity: f32 };
@vertex fn vertex(@builtin(vertex_index) i:u32, @builtin(instance_index) frame:u32)->Out {
  let p=vec2f(f32((i<<1u)&2u),f32(i&2u));
  return Out(vec4f(p*2.-1.,0.,1.),vec2f(p.x,1.-p.y),opacities[frame]);
}
@fragment fn fragment(v:Out)->@location(0) vec4f {
  return textureSampleLevel(source,sourceSampler,v.uv,0.)*v.opacity;
}`;

/** Retain completed painter-order layers, not one viewport texture per ghost.
 * One frame scratch + MSAA surface apply opacity to each whole ghost before
 * blending it into the layer. Warm posing only composites the finished layer. */
export class OnionComposite {
  constructor(renderer) {
    this.renderer = renderer; this.revision = 0;
    this.cache = new OnionSurfaceCache({maxBytes: renderer.options.onionCache?.maxBytes ?? previewMemoryPlan().editorOnions,
      maxEntries: renderer.options.onionCache?.maxEntries ?? 24,
      create: (w,h) => this.surface(w,h), dispose: surface => surface.texture.destroy()});
  }
  surface(w, h) {
    const r = this.renderer, texture = r.device.createTexture({label: 'Onion layer', size: [w,h], format: r.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    return {texture, view: texture.createView()};
  }
  bind(surface) {
    if (surface.buffer !== this.opacityBuffer) {
      surface.buffer = this.opacityBuffer;
      surface.bindGroup = this.renderer.device.createBindGroup({layout: this.bindLayout, entries: [
        {binding: 0, resource: surface.view}, {binding: 1, resource: this.renderer.sampler},
        {binding: 2, resource: {buffer: this.opacityBuffer}},
      ]});
    }
    return surface.bindGroup;
  }
  prepare(uniform) {
    const r = this.renderer, d = r.device, w = r.canvas.width, h = r.canvas.height;
    if (this.samples !== r.msaaCount) {
      this.destroy(); this.samples = r.msaaCount;
      const module = d.createShaderModule({code: shader, label: 'Onion frame opacity'});
      this.bindLayout = d.createBindGroupLayout({entries: [
        {binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {}},
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {}},
        {binding: 2, visibility: GPUShaderStage.VERTEX, buffer: {type: 'read-only-storage'}},
      ]});
      const layout = d.createPipelineLayout({bindGroupLayouts: [this.bindLayout]});
      const pipeline = count => d.createRenderPipeline({layout, vertex: {module, entryPoint: 'vertex'},
        fragment: {module, entryPoint: 'fragment', targets: [{format: r.format, blend: {
          color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
          alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'},
        }}]}, multisample: {count}});
      this.pipeline = pipeline(r.msaaCount); this.flatPipeline = r.msaaCount === 1 ? this.pipeline : pipeline(1);
    }
    if (this.width !== w || this.height !== h) {
      this.frameSurface?.texture.destroy(); this.scratch?.texture.destroy(); this.msaa?.destroy();
      this.frameSurface = this.scratch = this.msaa = null;
      this.width = w; this.height = h;
    }
    this.cache.begin(onionLayerKeys(r.layout), w, h);
    const count = r.onionScenes.length + 1;
    if (this.count !== count) {
      this.opacityBuffer?.destroy(); this.count = count;
      this.opacityBuffer = d.createBuffer({size: count*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    }
    const opacities = Float32Array.from([...r.onionScenes.map(frame => frame.opacity ?? .14), 1]);
    if (this.generation !== r.generation || !this.uniform?.every((v,i) => v === uniform[i]) ||
        this.opacities?.length !== count || !this.opacities.every((v,i) => v === opacities[i])) this.revision++;
    this.uniform = uniform; this.opacities = opacities; this.generation = r.generation;
    d.queue.writeBuffer(this.opacityBuffer, 0, opacities);
    r.stats.onionRenderedFrames = r.stats.onionFrameHits = 0;
  }
  draw(encoder, destination, pass, entries, start, end, timestampWrites) {
    const r = this.renderer;
    const cached = this.cache.acquire(entries[start].onionLayerKey ?? entries[start].onionIndex);
    const valid = cached?.revision === this.revision && cached.members?.length === end-start &&
      cached.members.every((m,i) => {
        const e = entries[start+i], at = e.transform*4;
        return m.g === e.g && m.data === e.data && m.texture === e.texture && m.onionIndex === e.onionIndex &&
          m.transform.every((v,j) => v === r.transformData[at+j]);
      });
    const surface = cached?.surface ?? (this.scratch ??= this.surface(this.width, this.height));
    let calls = 0, resumed = false;
    if (!valid) {
      pass.end(); resumed = true;
      this.frameSurface ??= this.surface(this.width, this.height);
      this.msaa ??= r.createMsaaTexture(this.width, this.height);
      const view = this.frameSurface.view;
      for (let from=start; from<end;) {
        const index = entries[from].onionIndex;
        let to=from+1; while(to<end && entries[to].onionIndex===index)to++;
        const ghost = encoder.beginRenderPass({colorAttachments: [{view: this.msaa?.createView() ?? view,
          ...(this.msaa ? {resolveTarget: view} : {}), clearValue: {r:0,g:0,b:0,a:0}, loadOp: 'clear', storeOp: this.msaa ? 'discard' : 'store'}]});
        ghost.setPipeline(r.pipeline); ghost.setBindGroup(0,r.globalBindGroup);
        let begin=-1,count=0;
        const flush=()=>{if(!count)return;ghost.setBindGroup(1,r.blankBindGroup);ghost.draw(6,count,0,begin);calls++;begin=-1;count=0;};
        for (let i=from;i<to;i++) {
          const e=entries[i];
          if(e.texture){flush();ghost.setBindGroup(1,e.texture.bindGroup);ghost.draw(6,e.count,0,e.offset);calls++;}
          else{if(begin<0)begin=e.offset;count+=e.capacity;}
        }
        flush(); ghost.end();
        const layer = encoder.beginRenderPass({colorAttachments: [{view: surface.view,
          clearValue: {r:0,g:0,b:0,a:0}, loadOp: from===start ? 'clear' : 'load', storeOp:'store'}]});
        layer.setPipeline(this.flatPipeline); layer.setBindGroup(0,this.bind(this.frameSurface));
        layer.draw(3,1,0,index); layer.end(); calls++; r.stats.onionRenderedFrames++;
        from=to;
      }
      if (cached) {
        cached.revision = this.revision;
        cached.members = entries.slice(start,end).map(e => ({g:e.g,data:e.data,texture:e.texture,onionIndex:e.onionIndex,
          transform:r.transformData.slice(e.transform*4,e.transform*4+4)}));
      }
    } else {
      for(let i=start;i<end;i++)if(i===start||entries[i].onionIndex!==entries[i-1].onionIndex)r.stats.onionFrameHits++;
    }
    // Timing ends on the final main pass even when all ghost pixels were reused.
    if(timestampWrites && !resumed){pass.end();resumed=true;}
    if(resumed)pass = encoder.beginRenderPass({colorAttachments: [{...r.colorAttachment(destination), loadOp:'load', storeOp:'store'}], ...(timestampWrites?{timestampWrites}:{})});
    pass.setPipeline(this.pipeline); pass.setBindGroup(0,this.bind(surface));
    pass.draw(3,1,0,this.count-1);
    pass.setPipeline(r.pipeline); pass.setBindGroup(0,r.globalBindGroup);
    r.stats.onionCacheBytes = this.cache.bytes;
    r.stats.onionCompositeBytes = this.cache.bytes + this.width*this.height*4 *
      (Number(Boolean(this.frameSurface))+Number(Boolean(this.scratch))+(this.msaa?r.msaaCount:0)) + this.count*4;
    return {pass,calls:calls+1};
  }
  destroy() {
    this.cache.clear(); this.frameSurface?.texture.destroy(); this.scratch?.texture.destroy();
    this.msaa?.destroy(); this.opacityBuffer?.destroy();
    this.frameSurface = this.scratch = this.msaa = this.opacityBuffer = this.pipeline = this.flatPipeline = null;
    this.uniform = this.opacities = null;
    this.width = this.height = this.count = this.samples = 0;
  }
}
