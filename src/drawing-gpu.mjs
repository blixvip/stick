import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,tileKey} from './drawing-tiles.mjs';
import {hasDrawableVfx} from './vfx-canvas.mjs';
import {compactTile} from './drawing-pixels.mjs';
import {smudgeStride} from './drawing-brush.mjs';
import {ATLAS_BYTES,TIP_SIZE,GRAIN_SIZE,brushAtlas,ensureTexture,tipBase} from './drawing-brush-textures.mjs';

/** WebGPU residency for sparse drawing cels and the GPU brush.
 *
 * The CPU TileStore stays the only authoritative raster. This module mirrors
 * the tiles a frame needs into one GPU storage pool of 64×64 straight-alpha
 * RGBA8 slots and draws them directly: no scratch canvas, preview worker or
 * image upload sits between an edit and the screen. Reduced levels are exact
 * GPU box reductions of the level below, computed the way drawing-raster.mjs
 * computes CPU mips. Slots are an LRU cache bounded by the pool size; a slot
 * used by the frame being encoded or pinned by a stroke is never reused.
 *
 * A GPU stroke rasterizes dab shapes from the shared brush model into private
 * overlay slots, which the display reads instead of the committed tiles until
 * the stroke's read-back pixels are committed through the normal editor
 * transaction. */
export const GPU_NONE=0xffffffff;
let presentationOwner=0;
const UNRESOLVED=0xfffffffe;
const TEXELS=TILE*TILE,WORDS=24,MAX_LEVEL=8,UPLOADS_PER_FRAME=2048,MAX_DISPATCH=65535;

const DISPLAY_SHADER=/* wgsl */`
struct Globals { row0: vec4f, row1: vec4f, viewport: vec4f, clip: vec4f }
struct Tile { m0: vec4f, m1: vec4f, coord: vec4i, s0: vec4u, s1: vec4u, s2: vec4u }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> transforms: array<vec4f>;
@group(1) @binding(0) var<storage, read> pool: array<u32>;
@group(1) @binding(1) var<storage, read> tiles: array<Tile>;
struct Out { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) @interpolate(flat) index: u32 }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> Out {
  let tile = tiles[index];
  var corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let uv = corners[vertex];
  // Shared corners come from the same integer inputs, so neighbours are watertight.
  let q = (vec2f(tile.coord.xy) + uv) * tile.m1.z;
  let transform = transforms[u32(tile.coord.z)];
  let world = vec2f(tile.m0.x * q.x + tile.m0.z * q.y + tile.m1.x, tile.m0.y * q.x + tile.m0.w * q.y + tile.m1.y) + transform.xy;
  let screen = vec2f(dot(globals.row0.xyz, vec3f(world, 1)), dot(globals.row1.xyz, vec3f(world, 1)));
  var out: Out;
  out.position = vec4f(screen.x / globals.viewport.x * 2.0 - 1.0, 1.0 - screen.y / globals.viewport.y * 2.0, 0, 1);
  out.local = uv * 64.0;
  out.index = index;
  return out;
}
fn slotAt(tile: Tile, n: i32) -> u32 {
  if (n < 4) { return tile.s0[n]; }
  if (n < 8) { return tile.s1[n - 4]; }
  return tile.s2.x;
}
fn texel(tile: Tile, x: i32, y: i32) -> vec4f {
  let nx = select(select(1, 2, x >= 64), 0, x < 0);
  let ny = select(select(1, 2, y >= 64), 0, y < 0);
  let slot = slotAt(tile, ny * 3 + nx);
  if (slot == 0xffffffffu) { return vec4f(0); }
  let lx = u32(x - (nx - 1) * 64);
  let ly = u32(y - (ny - 1) * 64);
  let c = unpack4x8unorm(pool[slot * 4096u + ly * 64u + lx]);
  return vec4f(c.rgb * c.a, c.a);
}
@fragment fn fs(input: Out) -> @location(0) vec4f {
  let tile = tiles[input.index];
  let transform = transforms[u32(tile.coord.z)];
  let point = input.position.xy / globals.viewport.z;
  let center = (globals.clip.xy + globals.clip.zw) * 0.5;
  let angle = globals.row1.w;
  let delta = point - center;
  let screen = center + vec2f(cos(angle) * delta.x + sin(angle) * delta.y, -sin(angle) * delta.x + cos(angle) * delta.y);
  let outside = screen.x < globals.clip.x || screen.y < globals.clip.y || screen.x > globals.clip.z || screen.y > globals.clip.w;
  if (transform.w < 0.5 || (outside && globals.viewport.w > 0.5)) { discard; }
  // Premultiplied bilinear filtering across tile borders through the 3×3
  // neighbourhood, so tile seams never show at any zoom or rotation.
  let t = input.local - 0.5;
  let base = floor(t);
  let f = t - base;
  let i = vec2i(base);
  let c = mix(mix(texel(tile, i.x, i.y), texel(tile, i.x + 1, i.y), f.x), mix(texel(tile, i.x, i.y + 1), texel(tile, i.x + 1, i.y + 1), f.x), f.y);
  let alpha = tile.m1.w * transform.z;
  if (c.a * alpha <= 0.0) { discard; }
  return c * alpha;
}`;

// Exact integer form of drawing-raster.mjs downTile(): premultiplied 2×2 box,
// unpremultiplied with round-half-up.
const REDUCE_SHADER=/* wgsl */`
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read_write> pool: array<u32>;
@group(0) @binding(1) var<storage, read> jobs: array<vec4u>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(256) fn reduce(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let index = wg.x + wg.y * ${MAX_DISPATCH}u;
  if (index >= params.count) { return; }
  let a = jobs[index * 2u];
  let b = jobs[index * 2u + 1u];
  var children = array<u32, 4>(a.y, a.z, a.w, b.x);
  for (var k = 0u; k < 16u; k++) {
    let q = li + k * 256u;
    let px = q % 64u;
    let py = q / 64u;
    let child = children[(py >> 5u) * 2u + (px >> 5u)];
    var out = 0u;
    if (child != 0xffffffffu) {
      var pa = 0u; var pr = 0u; var pg = 0u; var pb = 0u;
      for (var v = 0u; v < 2u; v++) {
        for (var u = 0u; u < 2u; u++) {
          let s = pool[child * 4096u + (2u * (py & 31u) + v) * 64u + 2u * (px & 31u) + u];
          let al = s >> 24u;
          pa += al; pr += (s & 255u) * al; pg += ((s >> 8u) & 255u) * al; pb += ((s >> 16u) & 255u) * al;
        }
      }
      if (pa > 0u) {
        out = ((2u * pr + pa) / (2u * pa)) | (((2u * pg + pa) / (2u * pa)) << 8u) | (((2u * pb + pa) / (2u * pa)) << 16u) | (((pa + 2u) / 4u) << 24u);
      }
    }
    pool[a.x * 4096u + q] = out;
  }
}`;

// Nonzero-alpha bounds per slot, matching drawing-tiles.mjs alphaBounds().
const BOUNDS_SHADER=/* wgsl */`
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> pool: array<u32>;
@group(0) @binding(1) var<storage, read> slots: array<u32>;
@group(0) @binding(2) var<storage, read_write> bounds: array<vec4u>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> low: array<atomic<u32>, 2>;
var<workgroup> high: array<atomic<u32>, 2>;
var<workgroup> found: atomic<u32>;
@compute @workgroup_size(256) fn alpha(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let index = wg.x + wg.y * ${MAX_DISPATCH}u;
  if (index >= params.count) { return; }
  if (li == 0u) { atomicStore(&low[0], 64u); atomicStore(&low[1], 64u); atomicStore(&high[0], 0u); atomicStore(&high[1], 0u); atomicStore(&found, 0u); }
  workgroupBarrier();
  let slot = slots[index];
  var lx = 64u; var ly = 64u; var hx = 0u; var hy = 0u; var any = false;
  for (var k = 0u; k < 16u; k++) {
    let q = li + k * 256u;
    if ((pool[slot * 4096u + q] >> 24u) != 0u) { let x = q % 64u; let y = q / 64u; lx = min(lx, x); ly = min(ly, y); hx = max(hx, x); hy = max(hy, y); any = true; }
  }
  if (any) { atomicMin(&low[0], lx); atomicMin(&low[1], ly); atomicMax(&high[0], hx); atomicMax(&high[1], hy); atomicStore(&found, 1u); }
  workgroupBarrier();
  if (li == 0u) {
    if (atomicLoad(&found) == 0u) { bounds[index] = vec4u(0xffffffffu); }
    else { bounds[index] = vec4u(atomicLoad(&low[0]), atomicLoad(&low[1]), atomicLoad(&high[0]), atomicLoad(&high[1])); }
  }
}`;

// The per-pixel brush of drawing-pixels.mjs DrawingStroke.addDab() and
// composite(), evaluated per pixel over the ordered dabs touching each tile.
// Coverage accumulates in dab order exactly as the CPU loop does; the colour
// is then composited from final coverage and the pixels the stroke first saw,
// with the same blend modes, alpha lock, image tips and grain. Only floating
// point width and the CPU's soft-falloff lookup table differ. An ephemeral
// pass paints a stroke's provisional tail over its final coverage without
// storing it, and recomposites every tile the previous tail covered.
const STROKE_SHADER=/* wgsl */`
struct Params {
  color: vec4f,
  hardness: f32, texture: f32, invRound: f32, mode: u32,
  seed: u32, originX: i32, originY: i32, count: u32,
  lock: u32, maskX: i32, maskY: i32, maskW: u32,
  maskH: u32, maskMax: f32, hasMask: u32, round: u32,
  ephemeral: u32, tip: i32, grain: i32, grainScale: f32,
}
struct Job { tx: i32, ty: i32, before: u32, after: u32, coverage: u32, start: u32, count: u32, init: u32 }
@group(0) @binding(0) var<storage, read_write> pool: array<u32>;
@group(0) @binding(1) var<storage, read_write> coverage: array<f32>;
@group(0) @binding(2) var<storage, read> dabs: array<vec4f>;
@group(0) @binding(3) var<storage, read> jobs: array<Job>;
@group(0) @binding(4) var<storage, read> order: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var<storage, read> mask: array<u32>;
@group(0) @binding(7) var<storage, read> textures: array<u32>;
fn atlasByte(i: u32) -> f32 { return f32((textures[i >> 2u] >> ((i & 3u) * 8u)) & 255u); }
fn bilinear(a: f32, b: f32, c: f32, d: f32, fx: f32, fy: f32) -> f32 {
  let top = a + (b - a) * fx;
  return (top + ((c + (d - c) * fx) - top) * fy) / 255.0;
}
// drawing-brush-textures.mjs sampleTip and sampleGrain.
fn tipAt(u: f32, v: f32) -> f32 {
  let n = ${TIP_SIZE}.0;
  let px = clamp((u * 0.5 + 0.5) * n - 0.5, 0.0, n - 1.0);
  let py = clamp((v * 0.5 + 0.5) * n - 0.5, 0.0, n - 1.0);
  let x0 = u32(floor(px));
  let y0 = u32(floor(py));
  let x1 = min(x0 + 1u, ${TIP_SIZE-1}u);
  let y1 = min(y0 + 1u, ${TIP_SIZE-1}u);
  let base = u32(params.tip);
  return bilinear(atlasByte(base + y0 * ${TIP_SIZE}u + x0), atlasByte(base + y0 * ${TIP_SIZE}u + x1), atlasByte(base + y1 * ${TIP_SIZE}u + x0), atlasByte(base + y1 * ${TIP_SIZE}u + x1), px - floor(px), py - floor(py));
}
fn grainAt(ax: i32, ay: i32) -> f32 {
  let px = (f32(ax) + 0.5) / params.grainScale - 0.5;
  let py = (f32(ay) + 0.5) / params.grainScale - 0.5;
  let ix = i32(floor(px));
  let iy = i32(floor(py));
  let m = ${GRAIN_SIZE-1};
  let x0 = u32(ix & m);
  let x1 = u32((ix + 1) & m);
  let y0 = u32(iy & m);
  let y1 = u32((iy + 1) & m);
  let base = u32(params.grain);
  return bilinear(atlasByte(base + y0 * ${GRAIN_SIZE}u + x0), atlasByte(base + y0 * ${GRAIN_SIZE}u + x1), atlasByte(base + y1 * ${GRAIN_SIZE}u + x0), atlasByte(base + y1 * ${GRAIN_SIZE}u + x1), px - floor(px), py - floor(py));
}
fn hashPixel(x: i32, y: i32, seed: u32) -> f32 {
  var h = (bitcast<u32>(x) * 374761393u) ^ (bitcast<u32>(y) * 668265263u) ^ (seed * 974711u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}
fn maskAt(x: i32, y: i32) -> f32 {
  let lx = x - params.maskX;
  let ly = y - params.maskY;
  if (lx < 0 || ly < 0 || u32(lx) >= params.maskW || u32(ly) >= params.maskH) { return 0.0; }
  let i = u32(ly) * params.maskW + u32(lx);
  return f32((mask[i >> 2u] >> ((i & 3u) * 8u)) & 255u) / params.maskMax;
}
fn lum(c: vec3f) -> f32 { return 0.3 * c.x + 0.59 * c.y + 0.11 * c.z; }
// W3C SetLum/ClipColor exactly as drawing-pixels.mjs orders it.
fn setLum(c: vec3f, l: f32) -> vec3f {
  var r = c + vec3f(l - lum(c));
  let L = lum(r);
  let n = min(r.x, min(r.y, r.z));
  let x = max(r.x, max(r.y, r.z));
  if (n < 0.0) { r = vec3f(L) + (r - vec3f(L)) * L / (L - n); }
  if (x > 255.0) { r = vec3f(L) + (r - vec3f(L)) * (255.0 - L) / (x - L); }
  return r;
}
fn blendChannel(b: f32, s: f32) -> f32 {
  if (params.mode == 3u) { return b * s / 255.0; }
  if (params.mode == 4u) { return b + s - b * s / 255.0; }
  if (b <= 127.5) { return 2.0 * b * s / 255.0; }
  return 255.0 - 2.0 * (255.0 - b) * (255.0 - s) / 255.0;
}
fn channel(v: f32) -> u32 { return u32(clamp(floor(v + 0.5), 0.0, 255.0)); }
fn pack(c: vec3f, a: f32) -> u32 { return channel(c.x) | (channel(c.y) << 8u) | (channel(c.z) << 16u) | (channel(a * 255.0) << 24u); }
@compute @workgroup_size(256) fn paint(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let index = wg.x + wg.y * ${MAX_DISPATCH}u;
  if (index >= params.count) { return; }
  let job = jobs[index];
  let soft = 1.0 / max(1e-6, 1.0 - params.hardness);
  let hard = params.hardness >= 0.999;
  for (var k = 0u; k < 16u; k++) {
    let q = li + k * 256u;
    let ax = job.tx * 64 + i32(q % 64u);
    let ay = job.ty * 64 + i32(q / 64u);
    let fx = f32(ax - params.originX) + 0.5;
    let fy = f32(ay - params.originY) + 0.5;
    let ci = job.coverage * 4096u + q;
    var cov = 0.0;
    if (job.init == 0u) { cov = coverage[ci]; }
    var grain = 1.0;
    if (params.texture > 0.0) {
      var g = 0.0;
      if (params.grain >= 0) { g = grainAt(ax, ay); } else { g = hashPixel(ax, ay, params.seed); }
      grain = 1.0 - params.texture * (1.0 - g);
    }
    var clip = 1.0;
    if (params.hasMask == 1u) { clip = maskAt(ax, ay); }
    var touched = false;
    for (var n = job.start; n < job.start + job.count; n++) {
      let d = order[n] * 2u;
      let dab = dabs[d];
      let tip = dabs[d + 1u];
      // Saturated coverage cannot change. Grain caps the coverage a pixel
      // can reach, so paper pits stay lighter however many dabs overlap.
      let cap = dab.w * grain;
      if (cov >= cap) { continue; }
      var dx = fx - dab.x;
      var dy = fy - dab.y;
      if (params.round == 1u) { let u = dx * tip.y + dy * tip.z; dy = (dy * tip.y - dx * tip.z) * params.invRound; dx = u; }
      let r = dab.z;
      let d2 = dx * dx + dy * dy;
      if (d2 >= r * r) { continue; }
      var e = 0.0;
      if (hard) {
        if (r >= 1.0 && d2 <= (r - 1.0) * (r - 1.0)) { e = 1.0; } else { e = clamp(r - sqrt(d2), 0.0, 1.0); }
      } else {
        let t = clamp((1.0 - sqrt(d2) / r) * soft, 0.0, 1.0);
        e = t * t * (3.0 - 2.0 * t);
      }
      if (params.tip >= 0) { e = e * tipAt(dx / r, dy / r); }
      e = e * tip.x * clip;
      if (e <= 0.0) { continue; }
      touched = true;
      cov = cov + (cap - cov) * e;
    }
    // A tail pass recomposites whole tiles and never stores its coverage.
    if (params.ephemeral == 0u) {
      if (!touched && job.init == 0u) { continue; }
      coverage[ci] = cov;
    }
    var before = 0u;
    if (job.before != 0xffffffffu) { before = pool[job.before * 4096u + q]; }
    let dst = job.after * 4096u + q;
    if (cov <= 0.0) { pool[dst] = before; continue; }
    let ba = f32(before >> 24u) / 255.0;
    let b = vec3f(f32(before & 255u), f32((before >> 8u) & 255u), f32((before >> 16u) & 255u));
    let s = params.color.rgb;
    if (params.mode == 1u) { pool[dst] = (before & 0x00ffffffu) | (channel(ba * (1.0 - cov) * 255.0) << 24u); continue; }
    if (params.mode == 2u) {
      let out = ba + cov * (1.0 - ba);
      let w = cov * (1.0 - ba);
      pool[dst] = pack((b * ba + s * w) / out, out);
      continue;
    }
    // Separable and colour blends against the backdrop, weighted by backdrop
    // alpha (W3C compositing): Cs' = (1-ab)·Cs + ab·B(Cb,Cs).
    var c = s;
    if (params.mode >= 3u && ba > 0.0) {
      var m = vec3f(0);
      if (params.mode == 6u) { m = setLum(s, lum(b)); } else { m = vec3f(blendChannel(b.x, s.x), blendChannel(b.y, s.y), blendChannel(b.z, s.z)); }
      c = (1.0 - ba) * s + ba * m;
    }
    if (params.lock == 1u) { pool[dst] = (before & 0xff000000u) | (pack(b + (c - b) * cov, 0.0) & 0x00ffffffu); continue; }
    let out = cov + ba * (1.0 - cov);
    let w = ba * (1.0 - cov);
    pool[dst] = pack((c * cov + b * w) / out, out);
  }
}`;

/** Presenter entries the GPU path can display and paint: resident owner cels
 * without drawable effects. Transient selection previews keep their canvas
 * compositor. The renderer and the brush share this test. */
export function gpuDrawingEligible(presenter,item){
  return Boolean(presenter&&!presenter.transient&&presenter.owner&&(presenter.store||presenter.loading)&&item&&!hasDrawableVfx(item));
}
const workgroups=count=>[Math.min(count,MAX_DISPATCH),Math.ceil(count/MAX_DISPATCH)];
const levelKey=(k,tx,ty)=>`${k}|${tx},${ty}`;

/** Growable GPU buffer whose contents survive growth. */
class GrowableBuffer {
  constructor(device,label,usage){Object.assign(this,{device,label,usage,buffer:null,size:0,generation:0});}
  ensure(bytes,{preserve=false}={}){
    if(this.buffer&&this.size>=bytes)return false;
    let size=Math.max(256,this.size||256);while(size<bytes)size*=2;
    const next=this.device.createBuffer({label:this.label,size,usage:this.usage|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
    if(preserve&&this.buffer){const encoder=this.device.createCommandEncoder({label:`${this.label} growth`});encoder.copyBufferToBuffer(this.buffer,0,next,0,this.size);this.device.queue.submit([encoder.finish()]);}
    this.buffer?.destroy();this.buffer=next;this.size=size;this.generation++;return true;
  }
  destroy(){this.buffer?.destroy();this.buffer=null;this.size=0;}
}

export class DrawingGpu {
  constructor(renderer,{maxBytes=512*1024*1024,initialSlots=1024}={}){
    const device=renderer.device,limit=Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize);
    Object.assign(this,{renderer,device,token:{},presentationOwner:++presentationOwner,frame:0,capacity:0,free:[],lru:new Map(),tiles:new WeakMap(),states:new WeakMap(),sessions:new Set(),
      maxSlots:Math.max(64,Math.floor(Math.min(maxBytes,limit)/TILE_BYTES)),uploads:0,incomplete:false,reduce:Array.from({length:MAX_LEVEL+1},()=>[]),
      words:new Uint32Array(WORDS*256),instanceCount:0,stats:{slots:0,capacity:0,uploads:0,reductions:0,strokeDispatches:0,evictions:0}});
    this.floats=new Float32Array(this.words.buffer);this.ints=new Int32Array(this.words.buffer);
    this.pool=new GrowableBuffer(device,'Drawing tile pool',GPUBufferUsage.STORAGE);
    this.instances=new GrowableBuffer(device,'Drawing tile instances',GPUBufferUsage.STORAGE);
    this.jobBuffers=Array.from({length:MAX_LEVEL+1},(_,k)=>new GrowableBuffer(device,`Drawing level ${k} jobs`,GPUBufferUsage.STORAGE));
    this.reduceParams=Array.from({length:MAX_LEVEL+1},()=>device.createBuffer({label:'Drawing reduction parameters',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));
    this.grow(Math.min(initialSlots,this.maxSlots));
    const display=device.createShaderModule({code:DISPLAY_SHADER,label:'Drawing tile display'});
    this.displayGlobals=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}}]});
    this.displayTiles=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}},{binding:1,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}}]});
    this.displayModule=display;this.displayLayout=device.createPipelineLayout({bindGroupLayouts:[this.displayGlobals,this.displayTiles]});this.displayPipelines=new Map();
  }
  /** Construct and compile every pipeline off the frame path; drivers can
   * take tens of milliseconds per pipeline, which would otherwise stall the
   * first stroke and the first drawn cel. */
  static async create(renderer,options){
    const gpu=new DrawingGpu(renderer,options),device=gpu.device;
    try{
      const compute=(label,code,entryPoint)=>device.createComputePipelineAsync({label,layout:'auto',compute:{module:device.createShaderModule({code,label}),entryPoint}});
      const C=GPUShaderStage.COMPUTE,storage=(binding,type='read-only-storage')=>({binding,visibility:C,buffer:{type}});
      gpu.smudgeLayout=device.createBindGroupLayout({label:'Drawing smudge',entries:[storage(0,'storage'),storage(1),storage(2),{binding:3,visibility:C,buffer:{type:'uniform'}},storage(4),storage(5,'storage')]});
      const smudge=device.createShaderModule({code:SMUDGE_SHADER,label:'Drawing smudge'}),layout=device.createPipelineLayout({bindGroupLayouts:[gpu.smudgeLayout]});
      [gpu.reducePipeline,gpu.boundsPipeline,gpu.strokePipeline,gpu.smudgeSample,gpu.smudgeApply]=await Promise.all([compute('Drawing level reduction',REDUCE_SHADER,'reduce'),compute('Drawing alpha bounds',BOUNDS_SHADER,'alpha'),compute('Drawing brush',STROKE_SHADER,'paint'),
        device.createComputePipelineAsync({label:'Drawing smudge pickup',layout,compute:{module:smudge,entryPoint:'sample'}}),device.createComputePipelineAsync({label:'Drawing smudge apply',layout,compute:{module:smudge,entryPoint:'apply'}}),gpu.compileDisplay(renderer.msaaCount)]);
      return gpu;
    }catch(error){gpu.destroy();throw error;}
  }
  displayDescriptor(count){
    const blend={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}};
    return {label:'Drawing tiles',layout:this.displayLayout,vertex:{module:this.displayModule,entryPoint:'vs'},fragment:{module:this.displayModule,entryPoint:'fs',targets:[{format:this.renderer.format,blend}]},primitive:{topology:'triangle-list'},multisample:{count}};
  }
  /** Compile the display pipeline for an antialiasing level ahead of use. */
  async compileDisplay(count){
    if(!this.displayPipelines.has(count))this.displayPipelines.set(count,await this.device.createRenderPipelineAsync(this.displayDescriptor(count)));
  }
  get enabled(){return !this.destroyed;}
  // Camera pixels can refine or show a provisional stroke before CPU pixels
  // publish. Stable complete tile residency leaves this key unchanged.
  get presentationKey(){return `${this.presentationOwner}:${this.stats.uploads}:${this.stats.reductions}:${this.stats.strokeDispatches}:${this.stats.evictions}:${this.sessions.size}`;}
  grow(slots){
    slots=Math.min(this.maxSlots,slots);if(slots<=this.capacity)return false;
    this.pool.ensure(slots*TILE_BYTES,{preserve:true});
    // Growth rounds the buffer up; every byte of it is usable.
    const usable=Math.min(this.maxSlots,Math.floor(this.pool.size/TILE_BYTES));
    for(let slot=usable-1;slot>=this.capacity;slot--)this.free.push(slot);
    this.capacity=usable;this.stats.capacity=usable;return true;
  }
  displayPipeline(count){
    // An antialiasing change not yet compiled asynchronously compiles here once.
    let pipeline=this.displayPipelines.get(count);
    if(!pipeline){pipeline=this.device.createRenderPipeline(this.displayDescriptor(count));this.displayPipelines.set(count,pipeline);}
    return pipeline;
  }
  /** Take a slot for `record`, reusing the least recently used slot that no
   * current frame or stroke depends on. Returns false when none is free. */
  allocate(record){
    let slot=this.free.pop();
    if(slot===undefined&&this.grow(this.capacity*2))slot=this.free.pop();
    if(slot===undefined)for(const owner of this.lru.values()){if(owner.used===this.frame)continue;this.evict(owner);slot=this.free.pop();break;}
    if(slot===undefined)return false;
    record.slot=slot;record.used=this.frame;if(!record.pinned)this.lru.set(slot,record);this.stats.slots=this.capacity-this.free.length;return true;
  }
  evict(record){if(record.slot==null||record.slot<0)return;this.lru.delete(record.slot);this.free.push(record.slot);record.slot=-1;record.onEvict?.();this.stats.evictions++;this.stats.slots=this.capacity-this.free.length;}
  touch(record){record.used=this.frame;if(record.pinned)return;this.lru.delete(record.slot);this.lru.set(record.slot,record);}
  pin(record){record.pinned=(record.pinned??0)+1;if(record.slot>=0)this.lru.delete(record.slot);}
  unpin(record){if(!record.pinned)return;record.pinned--;if(!record.pinned&&record.slot>=0)this.lru.set(record.slot,record);}
  /** Level-0 slot for a committed tile, uploaded when its version changed.
   * Copy-on-write forks share tile objects and therefore share slots. */
  tileSlot(tile,{force=false}={}){
    let record=this.tiles.get(tile);
    if(record?.slot>=0&&record.version===tile.version){this.touch(record);return record.slot;}
    if(!force&&this.uploads>=UPLOADS_PER_FRAME){this.incomplete=true;this.missing++;if(record?.slot>=0){this.touch(record);return record.slot;}return GPU_NONE;}
    if(!record){record={slot:-1,version:-1,kind:'tile'};this.tiles.set(tile,record);}
    if(record.slot<0&&!this.allocate(record)){this.incomplete=true;this.missing++;return GPU_NONE;}
    this.touch(record);this.device.queue.writeBuffer(this.pool.buffer,record.slot*TILE_BYTES,tile.pixels);
    record.version=tile.version;this.uploads++;this.stats.uploads++;return record.slot;
  }
  tileRecord(tile){return this.tiles.get(tile);}
  state(presenter){
    let state=this.states.get(presenter);
    if(!state){state={store:undefined,levels:new Map(),occupancy:[],overlay:null,overlayOccupancy:[],lastFrame:-1,retained:null,version:0,levelVersions:new Uint32Array(MAX_LEVEL+1),stale:new Set()};this.states.set(presenter,state);}
    const store=presenter.store;
    if(state.store!==store&&store){this.clearLevels(state);state.store=store;state.occupancy=[];store.changes(this.token).keys.clear();}
    else if(store){
      // Only reduced levels above tiles that actually changed go stale.
      const log=store.changes(this.token);
      if(log.overflow){this.clearLevels(state);log.overflow=false;}
      else if(log.keys.size){this.invalidateKeys(state,log.keys);log.keys.clear();}
    }
    return state;
  }
  clearLevels(state){if(state.levels.size)state.version++;state.stale.clear();for(const record of state.levels.values()){record.onEvict=null;if(record.slot>=0)this.evict(record);}state.levels.clear();}
  /** Mark the reduced ancestors of changed level-0 tile keys as stale. */
  invalidateKeys(state,keys){
    if(!state.levels.size)return;
    // Walk unique ancestors level by level; siblings share their parents.
    let parents=new Set();for(const key of keys){const [tx,ty]=key.split(',').map(Number);parents.add(tileKey(tx>>1,ty>>1));}
    for(let k=1;k<=MAX_LEVEL&&parents.size;k++){
      const next=new Set();
      // A stale reduction keeps its slot; prepare() re-reduces the stale ones
      // it displays without rebuilding the cel's other instances.
      for(const key of parents){const record=state.levels.get(`${k}|${key}`);if(record?.valid){record.valid=false;state.stale.add(`${k}|${key}`);}const [tx,ty]=key.split(',').map(Number);next.add(tileKey(tx>>1,ty>>1));}
      parents=next;
    }
  }
  /** Occupied tile keys at level k: committed tiles plus stroke overlay. */
  occupied(state,k){
    const store=state.store,revision=store?.revision??0;
    let entry=state.occupancy[k];
    if(!entry||entry.revision!==revision||entry.store!==store){
      let keys;
      if(k===0)keys=null;
      else{const below=k===1?null:this.occupied(state,k-1).keys;keys=new Set();
        if(below)for(const key of below){const [tx,ty]=key.split(',').map(Number);keys.add(tileKey(tx>>1,ty>>1));}
        else for(const tile of store??[])keys.add(tileKey(tile.tx>>1,tile.ty>>1));}
      entry=state.occupancy[k]={revision,store,keys};
    }
    return entry;
  }
  hasTile(state,k,tx,ty){
    if(k===0)return Boolean(state.store?.has(tx,ty)||state.overlay?.has(tileKey(tx,ty)));
    if(this.occupied(state,k).keys.has(tileKey(tx,ty)))return true;
    return Boolean(state.overlayOccupancy[k]?.has(tileKey(tx,ty)));
  }
  /** Slot holding level-k tile (tx,ty) for this frame, or GPU_NONE. Stale
   * content is drawn when the per-frame upload budget runs out. */
  resolve(state,k,tx,ty,memo){
    const key=levelKey(k,tx,ty);if(memo.has(key))return memo.get(key);
    let slot=GPU_NONE;
    if(k===0){
      const overlay=state.overlay?.get(tileKey(tx,ty));
      if(overlay){this.touch(overlay);slot=overlay.slot;}
      else{const tile=state.store?.get(tx,ty);if(tile)slot=this.tileSlot(tile);}
    }else if(this.hasTile(state,k,tx,ty)){
      let record=state.levels.get(key);
      if(record?.slot>=0&&record.valid)this.touch(record);
      else{
        const missing=this.missing;
        const children=[this.resolve(state,k-1,2*tx,2*ty,memo),this.resolve(state,k-1,2*tx+1,2*ty,memo),this.resolve(state,k-1,2*tx,2*ty+1,memo),this.resolve(state,k-1,2*tx+1,2*ty+1,memo)];
        const complete=this.missing===missing;
        if(!record){record={slot:-1,valid:false,kind:'level'};record.onEvict=()=>state.levels.delete(key);state.levels.set(key,record);}
        // Incomplete children leave an older reduction on screen and retry
        // next frame; a first reduction still shows what is available.
        if(!complete&&record.slot>=0){this.touch(record);this.missing++;memo.set(key,record.slot);return record.slot;}
        if(record.slot<0&&!this.allocate(record)){this.incomplete=true;this.missing++;memo.set(key,GPU_NONE);return GPU_NONE;}
        this.touch(record);this.reduce[k].push(record.slot,...children);record.valid=complete;if(!complete)this.missing++;this.stats.reductions++;
      }
      slot=record.slot;
    }
    memo.set(key,slot);return slot;
  }
  beginFrame(){
    this.frame++;this.uploads=0;this.missing=0;this.incomplete=false;this.instanceCount=0;for(const jobs of this.reduce)jobs.length=0;
    for(const session of this.sessions)session.plan();
  }
  /** Build tile instances for one displayed cel. `view` carries the cel's
   * pixel→world matrix relative to its root, transform slot, alpha, visible
   * level-0 pixel rect and display level. */
  prepare(presenter,view){
    const state=this.state(presenter);state.lastFrame=this.frame;
    if(!presenter.store){
      // An evicted store re-decodes; keep drawing its last resident tiles
      // unless history has changed the cel since they were drawn.
      const retained=state.retained;if(!retained||retained.revision!==presenter.revision||!this.intact(retained))return null;
      for(const record of retained.records)this.touch(record);
      return this.appendInstances(retained.words);
    }
    const {matrix,level,transform,alpha}=view,rect=intersect(view.rect,unionRect(presenter.store.bounds,state.overlay?state.overlayRect:null));
    if(!rect){state.retained=null;return null;}
    const span=TILE<<level,tx0=Math.floor(rect.x/span)-1,ty0=Math.floor(rect.y/span)-1,tx1=Math.floor((rect.x+rect.width-1)/span)+1,ty1=Math.floor((rect.y+rect.height-1)/span)+1;
    // A frame that changes nothing about this cel — same pixels, stroke
    // overlay, levels, view and tile window — reuses last frame's instances
    // instead of resolving every visible tile again.
    const cached=state.retained;
    if(cached?.complete&&cached.store===presenter.store&&cached.storeRevision===presenter.store.revision&&cached.version===state.version&&cached.levelVersion===state.levelVersions[level]&&cached.level===level&&cached.tx0===tx0&&cached.ty0===ty0&&cached.tx1===tx1&&cached.ty1===ty1&&cached.alpha===alpha&&cached.transform===transform&&cached.matrix.every((v,i)=>v===matrix[i])&&this.intact(cached)&&this.refreshStale(state,level,tx0,ty0,tx1,ty1)){
      for(const record of cached.records)this.touch(record);
      this.stats.reusedInstances=(this.stats.reusedInstances??0)+1;
      return this.appendInstances(cached.words);
    }
    const missing=this.missing;
    // Tile coordinates relative to the first visible tile keep f32 small.
    const baseX=tx0*span,baseY=ty0*span,m=[matrix[0],matrix[1],matrix[2],matrix[3],matrix[4]+matrix[0]*baseX+matrix[2]*baseY,matrix[5]+matrix[1]*baseX+matrix[3]*baseY];
    const candidates=[],width=tx1-tx0+1,height=ty1-ty0+1;
    if(level===0&&!state.overlay&&state.store.size<width*height){for(const tile of state.store)if(tile.tx>=tx0&&tile.tx<=tx1&&tile.ty>=ty0&&tile.ty<=ty1)candidates.push([tile.tx,tile.ty]);}
    else for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++)if(this.hasTile(state,level,tx,ty))candidates.push([tx,ty]);
    // Include transparent neighbours so bilinear filtering fades past the
    // artwork's last tile instead of stopping at a tile edge.
    const gw=width+2,gh=height+2,grid=gw*gh<=262144?new Uint32Array(gw*gh).fill(UNRESOLVED):null,memo=new Map();
    const slotAt=(x,y)=>{
      if(!grid)return this.resolve(state,level,x,y,memo);
      const i=(y-ty0+1)*gw+(x-tx0+1);let slot=grid[i];
      if(slot===UNRESOLVED)slot=grid[i]=this.resolve(state,level,x,y,memo);
      return slot;
    };
    // Every occupied tile and its transparent neighbours inside the window.
    const drawn=grid?new Uint8Array(gw*gh):new Set();
    for(const [tx,ty] of candidates)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const x=tx+dx,y=ty+dy;if(x<tx0||x>tx1||y<ty0||y>ty1)continue;if(grid)drawn[(y-ty0+1)*gw+(x-tx0+1)]=1;else drawn.add(tileKey(x,y));}
    const cells=[];
    if(grid){for(let y=ty0;y<=ty1;y++)for(let x=tx0;x<=tx1;x++)if(drawn[(y-ty0+1)*gw+(x-tx0+1)])cells.push(x,y);}
    else for(const key of drawn){const [x,y]=key.split(',').map(Number);cells.push(x,y);}
    const words=new Uint32Array(cells.length/2*WORDS),floats=new Float32Array(words.buffer),ints=new Int32Array(words.buffer),records=new Set(),slots=new Uint32Array(9);let n=0;
    for(let c=0;c<cells.length;c+=2){
      const tx=cells[c],ty=cells[c+1];let any=false;
      for(let dy=-1,s=0;dy<=1;dy++)for(let dx=-1;dx<=1;dx++,s++){const slot=slotAt(tx+dx,ty+dy);slots[s]=slot;if(slot!==GPU_NONE)any=true;}
      if(!any)continue;
      const o=n*WORDS;n++;
      floats[o]=m[0];floats[o+1]=m[1];floats[o+2]=m[2];floats[o+3]=m[3];floats[o+4]=m[4];floats[o+5]=m[5];floats[o+6]=span;floats[o+7]=alpha;
      ints[o+8]=tx-tx0;ints[o+9]=ty-ty0;ints[o+10]=transform;ints[o+11]=0;
      words.set(slots,o+12);words[o+21]=words[o+22]=words[o+23]=0;
      for(const slot of slots)if(slot!==GPU_NONE){const record=this.lru.get(slot);if(record)records.add(record);}
    }
    // Reductions this rebuild resolved (or that no longer exist) are not stale.
    for(const key of state.stale){const record=state.levels.get(key);if(!record||record.valid)state.stale.delete(key);}
    const used=words.subarray(0,n*WORDS),kept=[...records];
    state.retained={words:used,records:kept,slots:kept.map(record=>record.slot),revision:presenter.revision,complete:this.missing===missing,
      store:presenter.store,storeRevision:presenter.store.revision,version:state.version,levelVersion:state.levelVersions[level],level,tx0,ty0,tx1,ty1,alpha,transform,matrix:[...matrix]};
    return this.appendInstances(used);
  }
  /** Re-reduce the stale level-`level` tiles inside the window into the slots
   * they already own. Returns false when one could not keep its slot, so the
   * caller rebuilds the cel's instances. */
  refreshStale(state,level,tx0,ty0,tx1,ty1){
    if(!state.stale.size)return true;
    const memo=new Map();
    for(const key of state.stale){
      const bar=key.indexOf('|'),k=Number(key.slice(0,bar));if(k!==level)continue;
      const [tx,ty]=key.slice(bar+1).split(',').map(Number);if(tx<tx0||tx>tx1||ty<ty0||ty>ty1)continue;
      const record=state.levels.get(key),slot=record?.slot;
      if(!(slot>=0)||this.resolve(state,k,tx,ty,memo)!==slot)return false;
      if(record.valid)state.stale.delete(key);
    }
    return true;
  }
  /** Whether every slot retained instances reference still holds the tile it
   * held: an evicted record gets -1, and a re-allocated one a different slot. */
  intact(retained){const {records,slots}=retained;for(let i=0;i<records.length;i++)if(records[i].slot!==slots[i])return false;return true;}
  appendInstances(words){
    if(!words.length)return null;
    const first=this.instanceCount,count=words.length/WORDS;
    if((first+count)*WORDS>this.words.length){const next=new Uint32Array(Math.max((first+count)*WORDS,this.words.length*2));next.set(this.words);this.words=next;this.floats=new Float32Array(next.buffer);this.ints=new Int32Array(next.buffer);}
    this.words.set(words,first*WORDS);this.instanceCount+=count;return {first,count};
  }
  displayed(presenter){return this.states.get(presenter)?.lastFrame>=this.frame-1;}
  /** Before a published store is evicted, note which slots hold its exact
   * tiles. Only a complete set is kept; a partial one could not restore. */
  remember(presenter,store){
    const state=this.states.get(presenter);if(!state||!store)return;
    state.backup=null;const tiles=[];
    for(const tile of store){const record=this.tiles.get(tile);if(!(record?.slot>=0)||record.version!==tile.version)return;tiles.push({tx:tile.tx,ty:tile.ty,record,slot:record.slot,png:tile.png});}
    state.backup={revision:presenter.revision,tiles};
  }
  /** Read an evicted cel's published tiles back from their slots. Resolves in
   * the decode result format, or returns null when any slot was reused. */
  restore(presenter,revision){
    const state=this.states.get(presenter),backup=state?.backup;
    if(this.destroyed||!backup||backup.revision!==revision||backup.tiles.some(t=>t.record.slot!==t.slot))return null;
    const count=backup.tiles.length;if(!count)return Promise.resolve({tiles:[]});
    const device=this.device,readback=device.createBuffer({label:'Drawing restore read-back',size:count*TILE_BYTES,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=device.createCommandEncoder({label:'Drawing restore'});
    backup.tiles.forEach((t,i)=>encoder.copyBufferToBuffer(this.pool.buffer,t.slot*TILE_BYTES,readback,i*TILE_BYTES,TILE_BYTES));
    device.queue.submit([encoder.finish()]);this.stats.restores=(this.stats.restores??0)+1;
    return readback.mapAsync(GPUMapMode.READ).then(()=>{
      const mapped=readback.getMappedRange();
      return {tiles:backup.tiles.map((t,i)=>({tx:t.tx,ty:t.ty,pixels:mapped.slice(i*TILE_BYTES,(i+1)*TILE_BYTES),png:t.png}))};
    }).finally(()=>readback.destroy());
  }
  /** Restored tiles adopt the slots they were read from; no re-upload. */
  adoptRestored(presenter,store,revision){
    const state=this.states.get(presenter),backup=state?.backup;if(state)state.backup=null;
    if(!backup||!store||backup.revision!==revision)return;
    for(const t of backup.tiles){const tile=store.get(t.tx,t.ty);if(tile&&t.record.slot===t.slot&&!this.tiles.has(tile)){t.record.version=tile.version;this.tiles.set(tile,t.record);}}
  }
  /** Record all GPU work that must precede this frame's render pass. */
  /** The brush texture atlas buffer, created on first use. */
  textureBuffer(){
    this.textures??=this.device.createBuffer({label:'Drawing brush textures',size:ATLAS_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    return this.textures;
  }
  /** Upload one tip or grain to the atlas on first use; returns its offset. */
  brushTexture(name){
    const offset=ensureTexture(name);if(offset<0)return -1;
    this.uploadedTextures??=new Set();
    if(!this.uploadedTextures.has(name)){const size=tipBase(name)>=0?TIP_SIZE*TIP_SIZE:GRAIN_SIZE*GRAIN_SIZE;this.device.queue.writeBuffer(this.textureBuffer(),offset,brushAtlas(),offset,size);this.uploadedTextures.add(name);}
    return offset;
  }
  encode(encoder){
    for(const session of this.sessions)session.encode(encoder);
    const levels=[];for(let k=1;k<=MAX_LEVEL;k++)if(this.reduce[k].length)levels.push(k);
    if(levels.length){
      const pass=encoder.beginComputePass({label:'Drawing level reductions'});pass.setPipeline(this.reducePipeline);
      for(const k of levels){
        const jobs=this.reduce[k],count=jobs.length/5,data=new Uint32Array(count*8);
        for(let i=0;i<count;i++)data.set(jobs.slice(i*5,i*5+5),i*8);
        const buffer=this.jobBuffers[k];buffer.ensure(data.byteLength);this.device.queue.writeBuffer(buffer.buffer,0,data);
        this.device.queue.writeBuffer(this.reduceParams[k],0,new Uint32Array([count,0,0,0]));
        pass.setBindGroup(0,this.device.createBindGroup({layout:this.reducePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.pool.buffer}},{binding:1,resource:{buffer:buffer.buffer,size:data.byteLength}},{binding:2,resource:{buffer:this.reduceParams[k]}}]}));
        pass.dispatchWorkgroups(...workgroups(count));
      }
      pass.end();
    }
    if(this.instanceCount){
      const bytes=this.instanceCount*WORDS*4;
      if(this.instances.ensure(bytes))this.tileBindGroup=null;
      this.device.queue.writeBuffer(this.instances.buffer,0,this.words,0,this.instanceCount*WORDS);
    }
    if(this.incomplete)queueMicrotask(()=>this.renderer.options.onInvalidate?.());
  }
  draw(pass,{first,count}){
    const r=this.renderer;
    if(this.globalsKey!==r.transformBuffer){this.globalsKey=r.transformBuffer;this.globalsBindGroup=this.device.createBindGroup({layout:this.displayGlobals,entries:[{binding:0,resource:{buffer:r.uniform}},{binding:1,resource:{buffer:r.transformBuffer}}]});}
    if(!this.tileBindGroup||this.tileBindGroupPool!==this.pool.buffer){this.tileBindGroupPool=this.pool.buffer;this.tileBindGroup=this.device.createBindGroup({layout:this.displayTiles,entries:[{binding:0,resource:{buffer:this.pool.buffer}},{binding:1,resource:{buffer:this.instances.buffer}}]});}
    pass.setPipeline(this.displayPipeline(r.msaaCount));pass.setBindGroup(0,this.globalsBindGroup);pass.setBindGroup(1,this.tileBindGroup);pass.draw(6,count,0,first);
  }
  get bytes(){return this.pool.size+this.instances.size;}
  destroy(){
    this.destroyed=true;for(const session of this.sessions)session.fail(messageError(new Error(''), "errors.drawingGpu.theGraphicsDeviceClosedDuringTheStroke", {}));this.sessions.clear();
    this.pool.destroy();this.instances.destroy();for(const buffer of this.jobBuffers)buffer.destroy();for(const buffer of this.reduceParams)buffer.destroy();this.textures?.destroy();this.textures=null;this.uploadedTextures=null;
    this.lru.clear();this.free=[];
  }
}

const BLEND_MODES={normal:0,erase:1,behind:2,multiply:3,screen:4,overlay:5,color:6};
/** Whether the GPU brush can paint these normalized brush settings. Polygon
 * selections (larger than a pixel mask allows) keep the stroke worker. */
export function gpuBrushSupports(brush,mask){return !(mask?.points)&&(brush.erase||brush.blend==='smudge'||brush.blend in BLEND_MODES);}
const PARAM_BYTES=96;
/** The dab, job, order and parameter buffers of one brush dispatch. */
class BrushPass {
  constructor(device,label){Object.assign(this,{device,dabs:new GrowableBuffer(device,label+' dabs',GPUBufferUsage.STORAGE),jobs:new GrowableBuffer(device,label+' jobs',GPUBufferUsage.STORAGE),order:new GrowableBuffer(device,label+' order',GPUBufferUsage.STORAGE),params:device.createBuffer({label:label+' parameters',size:PARAM_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),bindGroup:null,key:null});}
  destroy(){this.dabs.destroy();this.jobs.destroy();this.order.destroy();this.params.destroy();}
}
/** The GPU stroke for a brush: smudge runs dab by dab, everything else in parallel. */
export function createGpuStroke(gpu,presenter,brush,options){return brush.blend==='smudge'&&!brush.erase?new GpuSmudgeStroke(gpu,presenter,brush,options):new GpuStroke(gpu,presenter,brush,options);}

/** Paints one stroke on the GPU. Dab shapes come from the shared brush model
 * (drawing-brush.mjs), so spacing, smoothing, pressure, tapers, jitter,
 * scatter and tip angle match the worker brush. */
export class GpuStroke {
  constructor(gpu,presenter,brush,{mask=null,workingBytes=768*1024*1024,coverage=true}={}){
    const mode=brush.erase?'erase':brush.blend;
    Object.assign(this,{gpu,presenter,device:gpu.device,state:gpu.state(presenter),brush,mask,workingBytes,usesCoverage:coverage,
      mode:BLEND_MODES[mode]??0,lock:brush.alphaLock&&mode!=='erase'&&mode!=='behind',
      // Nothing to erase or recolour where the stroke found no pixels.
      skipEmpty:mode==='erase'||(brush.alphaLock&&mode!=='behind'),
      tiles:new Map(),pending:[],origin:null,coverageCount:0,closed:false,failed:null,planned:null,
      // tail() returns the provisional tail's shapes; a new array means it moved.
      tail:null,tailShapes:null,tailKeys:new Set(),
      tipOffset:brush.tip==='round'?-1:gpu.brushTexture(brush.tip),grainOffset:brush.texture>0?gpu.brushTexture(brush.grain):-1});
    this.state.overlay=new Map();this.state.overlayOccupancy=[];this.state.overlayRect=null;
    this.coverage=new GrowableBuffer(this.device,'Drawing brush coverage',GPUBufferUsage.STORAGE);
    this.dabBuffer=new GrowableBuffer(this.device,'Drawing brush dabs',GPUBufferUsage.STORAGE);
    this.paramBuffer=this.device.createBuffer({label:'Drawing brush parameters',size:PARAM_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.passes=coverage?{main:new BrushPass(this.device,'Drawing brush'),tail:new BrushPass(this.device,'Drawing brush tail')}:null;
    // The selection clip, packed four mask bytes per word.
    const bytes=mask?.mask,padded=new Uint8Array(Math.max(4,Math.ceil((bytes?.length??0)/4)*4));if(bytes)padded.set(bytes);
    this.maskBuffer=this.device.createBuffer({label:'Drawing brush selection',size:padded.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.device.queue.writeBuffer(this.maskBuffer,0,padded);
    gpu.sessions.add(this);
  }
  /** Queue one dabShape() result in cel pixel space. */
  add(shape){if(this.closed)throw messageError(new Error(''), "errors.drawingBrush.theStrokeHasAlreadyEnded", {});if(this.failed)throw this.failed;this.pending.push(shape);}
  /** Whether planning would produce work: queued dabs or a moved tail. */
  get dirty(){return this.pending.length>0||Boolean(this.tail&&this.tail()!==this.tailShapes);}
  /** Convert queued dabs, and a moved provisional tail, into per-tile jobs
   * and claim their slots. Runs on the UI thread per frame; the work is
   * proportional to touched tiles. */
  plan(){
    if(this.failed||this.planned)return;
    const shapes=this.tail?.(),tailMoved=shapes&&shapes!==this.tailShapes;
    if(!this.pending.length&&!tailMoved)return;
    const first=this.pending[0]??shapes?.[0];if(first)this.origin??={x:Math.floor(first.x),y:Math.floor(first.y)};
    try{
      const main=this.pending.length?this.planDabs(this.pending,false):null;this.pending=[];
      const tail=tailMoved?this.planDabs(shapes,true):null;
      if(tailMoved)this.tailShapes=shapes;
      if(main||tail)this.planned={main,tail};
    }catch(error){this.fail(error);}
  }
  /** Per-tile jobs for final dabs, or for the ephemeral tail pass, which also
   * restores every tile the previous tail covered. */
  planDabs(dabs,ephemeral){
    const lists=new Map(),order=[],store=this.presenter.store;
    dabs.forEach((dab,index)=>{
      for(let ty=Math.floor(dab.top/TILE);ty*TILE<dab.bottom;ty++)for(let tx=Math.floor(dab.left/TILE);tx*TILE<dab.right;tx++){
        const key=tileKey(tx,ty);let list=lists.get(key);
        if(!list){if(this.skipEmpty&&!this.tiles.has(key)&&!store?.has(tx,ty))continue;list=[];lists.set(key,list);this.tile(tx,ty,key);}
        list.push(index);
      }
    });
    if(ephemeral){const covered=new Set(lists.keys());for(const key of this.tailKeys)if(!lists.has(key))lists.set(key,[]);this.tailKeys=covered;}
    if(!lists.size)return null;
    const jobs=new Int32Array(lists.size*8),words=new Uint32Array(jobs.buffer);let i=0;
    for(const [key,list] of lists){
      const tile=this.tiles.get(key),o=i*8;
      jobs[o]=tile.tx;jobs[o+1]=tile.ty;words[o+2]=tile.before?.slot>=0?tile.before.slot:GPU_NONE;words[o+3]=tile.after.slot;words[o+4]=tile.coverage;
      words[o+5]=order.length;words[o+6]=list.length;words[o+7]=tile.initialized?0:1;if(!ephemeral)tile.initialized=true;
      for(const index of list)order.push(index);i++;
    }
    const dabData=new Float32Array(Math.max(1,dabs.length)*8),ox=this.origin.x,oy=this.origin.y;
    dabs.forEach((dab,index)=>{const o=index*8;dabData[o]=dab.x-ox;dabData[o+1]=dab.y-oy;dabData[o+2]=dab.radius;dabData[o+3]=dab.opacity;dabData[o+4]=dab.flow;dabData[o+5]=dab.cos;dabData[o+6]=dab.sin;});
    // Reduced display levels over the touched tiles are now stale.
    this.gpu.invalidateKeys(this.state,lists.keys());
    return {count:lists.size,jobs,dabData,order:new Uint32Array(order)};
  }
  tile(tx,ty,key){
    let tile=this.tiles.get(key);if(tile)return tile;
    if((this.tiles.size+1)*TILE_BYTES*5>this.workingBytes)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
    const source=this.presenter.store?.get(tx,ty)??null,gpu=this.gpu;
    let before=null;
    if(source){gpu.tileSlot(source,{force:true});before=gpu.tileRecord(source);if(!(before?.slot>=0))throw messageError(new Error(''), "errors.drawingGpu.drawingGraphicsMemoryIsFullFinishTheStroke", {});gpu.pin(before);}
    const after={slot:-1,kind:'stroke'};gpu.pin(after);
    if(!gpu.allocate(after)){if(before)gpu.unpin(before);throw messageError(new Error(''), "errors.drawingGpu.drawingGraphicsMemoryIsFullFinishTheStroke", {});}
    tile={tx,ty,before,after,source,coverage:this.usesCoverage?this.coverageCount++:-1,initialized:false};this.tiles.set(key,tile);
    if(this.usesCoverage)this.coverage.ensure(this.coverageCount*TILE_BYTES,{preserve:true});
    const state=this.state,levels=state.levelVersions;
    // The overlay slot replaces the committed tile at level 0; a reduced level
    // only shows a new instance where neither the store nor the overlay
    // occupied that tile before.
    state.overlay.set(key,after);levels[0]++;state.overlayRect=unionRect(state.overlayRect,{x:tx*TILE,y:ty*TILE,width:TILE,height:TILE});
    for(let k=1;k<=MAX_LEVEL;k++){const set=state.overlayOccupancy[k]??=new Set(),parent=tileKey(tx>>k,ty>>k);if(set.has(parent))continue;set.add(parent);if(!this.gpu.occupied(state,k).keys.has(parent))levels[k]++;}
    return tile;
  }
  encode(encoder){
    const planned=this.planned;if(!planned)return;this.planned=null;
    if(planned.main)this.dispatch(encoder,this.passes.main,planned.main,false);
    if(planned.tail)this.dispatch(encoder,this.passes.tail,planned.tail,true);
  }
  dispatch(encoder,pass,{count,jobs,dabData,order},ephemeral){
    const queue=this.device.queue;
    pass.dabs.ensure(dabData.byteLength);pass.jobs.ensure(jobs.byteLength);pass.order.ensure(Math.max(4,order.byteLength));
    queue.writeBuffer(pass.dabs.buffer,0,dabData);queue.writeBuffer(pass.jobs.buffer,0,jobs);if(order.length)queue.writeBuffer(pass.order.buffer,0,order);
    const b=this.brush,m=this.mask,params=new ArrayBuffer(PARAM_BYTES),f=new Float32Array(params),u=new Uint32Array(params),s=new Int32Array(params);
    f[0]=b.color[0];f[1]=b.color[1];f[2]=b.color[2];f[4]=b.hardness;f[5]=b.texture;f[6]=1/b.roundness;u[7]=this.mode;
    u[8]=b.seed>>>0;s[9]=this.origin.x;s[10]=this.origin.y;u[11]=count;
    u[12]=this.lock?1:0;s[13]=m?.x??0;s[14]=m?.y??0;u[15]=m?.width??0;u[16]=m?.height??0;f[17]=m?.max??1;u[18]=m?1:0;
    // Image tips sample in the tip's rotated frame even when it is round.
    u[19]=b.roundness<.999||this.tipOffset>=0?1:0;
    u[20]=ephemeral?1:0;s[21]=this.tipOffset;s[22]=this.grainOffset;f[23]=b.grainScale;
    queue.writeBuffer(pass.params,0,params);
    const gpu=this.gpu,key=`${gpu.pool.generation}|${this.coverage.generation}|${pass.dabs.generation}|${pass.jobs.generation}|${pass.order.generation}`;
    if(pass.key!==key){pass.key=key;pass.bindGroup=this.device.createBindGroup({layout:gpu.strokePipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:gpu.pool.buffer}},{binding:1,resource:{buffer:this.coverage.buffer}},{binding:2,resource:{buffer:pass.dabs.buffer}},
      {binding:3,resource:{buffer:pass.jobs.buffer}},{binding:4,resource:{buffer:pass.order.buffer}},{binding:5,resource:{buffer:pass.params}},{binding:6,resource:{buffer:this.maskBuffer}},{binding:7,resource:{buffer:gpu.textureBuffer()}}]});}
    const compute=encoder.beginComputePass({label:ephemeral?'Drawing brush tail':'Drawing brush dabs'});compute.setPipeline(gpu.strokePipeline);compute.setBindGroup(0,pass.bindGroup);compute.dispatchWorkgroups(...workgroups(count));compute.end();
    gpu.stats.strokeDispatches++;
  }
  /** Flush remaining dabs and read back every touched tile. Resolves to
   * tile-change records in the DrawingStroke.finish() format. */
  async finish(){
    if(this.failed)throw this.failed;
    this.closed=true;
    do{this.plan();if(this.failed)throw this.failed;if(!this.planned)break;const batch=this.device.createCommandEncoder({label:'Drawing brush dabs'});this.encode(batch);this.device.queue.submit([batch.finish()]);}while(this.dirty);
    const tiles=[...this.tiles.values()],count=tiles.length,device=this.device;
    if(!count){this.readBack=true;return {changes:[],tiles:[]};}
    const pixelBytes=count*TILE_BYTES,slots=new Uint32Array(tiles.map(tile=>tile.after.slot));
    const slotBuffer=device.createBuffer({label:'Drawing read-back slots',size:Math.max(16,slots.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    const boundsBuffer=device.createBuffer({label:'Drawing alpha bounds',size:count*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const params=device.createBuffer({label:'Drawing alpha bounds parameters',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const readback=device.createBuffer({label:'Drawing brush read-back',size:pixelBytes+count*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    try{
      device.queue.writeBuffer(slotBuffer,0,slots);device.queue.writeBuffer(params,0,new Uint32Array([count,0,0,0]));
      const encoder=device.createCommandEncoder({label:'Drawing brush completion'}),pass=encoder.beginComputePass({label:'Drawing alpha bounds'});
      pass.setPipeline(this.gpu.boundsPipeline);
      pass.setBindGroup(0,device.createBindGroup({layout:this.gpu.boundsPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.gpu.pool.buffer}},{binding:1,resource:{buffer:slotBuffer}},{binding:2,resource:{buffer:boundsBuffer}},{binding:3,resource:{buffer:params}}]}));
      pass.dispatchWorkgroups(...workgroups(count));pass.end();
      tiles.forEach((tile,i)=>encoder.copyBufferToBuffer(this.gpu.pool.buffer,tile.after.slot*TILE_BYTES,readback,i*TILE_BYTES,TILE_BYTES));
      encoder.copyBufferToBuffer(boundsBuffer,0,readback,pixelBytes,count*16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const mapped=readback.getMappedRange(),bounds=new Uint32Array(mapped,pixelBytes,count*4),changes=[],prepared=[];
      let slice=performance.now();
      for(let i=0;i<count;i++){
        // Long read-backs yield in 8 ms slices so input and rendering keep running.
        if(performance.now()-slice>8){await yieldToInput();slice=performance.now();}
        if(this.failed)throw this.failed;if(this.released)throw messageError(new DOMException('', 'AbortError'), "errors.drawingGpu.strokeReleased", {});
        const tile=tiles[i],view=new Uint8ClampedArray(mapped,i*TILE_BYTES,TILE_BYTES),before=tile.source?.pixels??null;
        if(before&&sameBytes(before,view))continue;
        const after=view.slice(),afterSide=normalizeSide(compactTile(after)),beforeSide=normalizeSide(compactTile(before));
        if(beforeSide===null&&afterSide===null)continue;
        const b=bounds.subarray(i*4,i*4+4),visible=b[0]!==GPU_NONE;
        changes.push({tx:tile.tx,ty:tile.ty,before:beforeSide,after:afterSide});
        // The committed tile shares the history buffer: it is adopted frozen,
        // so any later edit copies it before writing and history stays exact.
        prepared.push({tx:tile.tx,ty:tile.ty,pixels:visible?after:null,shared:afterSide===after,alphaBounds:visible?{x:b[0],y:b[1],width:b[2]-b[0]+1,height:b[3]-b[1]+1}:null});
      }
      readback.unmap();this.readBack=true;return {changes,tiles:prepared};
    }finally{readback.destroy();slotBuffer.destroy();boundsBuffer.destroy();params.destroy();}
  }
  fail(error){if(this.failed)return;this.failed=error;}
  /** Stop displaying the overlay. After a successful commit, tiles that the
   * commit replaced adopt the overlay slot that already holds their bytes;
   * every other overlay slot returns to the pool. */
  release({committed=false}={}){
    if(this.released)return;this.released=true;this.closed=true;this.pending=[];this.planned=null;this.tail=null;
    const gpu=this.gpu,store=this.presenter.store;gpu.sessions.delete(this);
    for(const tile of this.tiles.values()){
      const current=committed&&this.readBack?store?.get(tile.tx,tile.ty):null;
      gpu.unpin(tile.after);
      if(current&&current!==tile.source&&tile.after.slot>=0&&!gpu.tiles.has(current)){Object.assign(tile.after,{kind:'tile',version:current.version});gpu.tiles.set(current,tile.after);gpu.touch(tile.after);}
      else if(tile.after.slot>=0)gpu.evict(tile.after);
      if(tile.before)gpu.unpin(tile.before);
    }
    if(this.state.overlay){this.state.overlay=null;this.state.overlayOccupancy=[];this.state.version++;}
    // Every tile's reduced ancestors must rebuild from committed pixels.
    gpu.invalidateKeys(this.state,this.tiles.keys());
    this.coverage.destroy();this.dabBuffer.destroy();this.paramBuffer.destroy();this.maskBuffer.destroy();this.passes?.main.destroy();this.passes?.tail.destroy();this.tiles.clear();
  }
}
// Smudge on the GPU: DrawingStroke.smudgeDab(), one dab at a time because
// every dab picks up the paint the previous one left. `sample` (one
// workgroup) averages the premultiplied colour under the tip on the same
// ≤64×64 grid as the CPU and updates the carried paint; `apply` (one
// workgroup per touched tile) lays the carried paint down. State persists
// across frames: the carried colour and the index of the dab in flight.
const SMUDGE_SHADER=/* wgsl */`
struct Params {
  color: vec4f,
  hardness: f32, invRound: f32, round: u32, hasMask: u32,
  length: f32, rate: f32, originX: i32, originY: i32,
  maskX: i32, maskY: i32, maskW: u32, maskH: u32,
  maskMax: f32, pad0: u32, pad1: u32, pad2: u32,
}
struct Dab { x: f32, y: f32, r: f32, strength: f32, cos: f32, sin: f32, stride: i32, pad: u32, left: i32, top: i32, right: i32, bottom: i32, tx0: i32, ty0: i32, cols: u32, refStart: u32 }
struct Ref { read: u32, write: u32, init: u32, before: u32 }
struct State { carry: vec4f, has: u32, next: u32, current: u32, skip: u32 }
@group(0) @binding(0) var<storage, read_write> pool: array<u32>;
@group(0) @binding(1) var<storage, read> dabs: array<Dab>;
@group(0) @binding(2) var<storage, read> refs: array<Ref>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read> mask: array<u32>;
@group(0) @binding(5) var<storage, read_write> state: State;
var<workgroup> sums: array<vec4f, 256>;
var<workgroup> weights: array<f32, 256>;
fn maskAt(x: i32, y: i32) -> f32 {
  let lx = x - params.maskX;
  let ly = y - params.maskY;
  if (lx < 0 || ly < 0 || u32(lx) >= params.maskW || u32(ly) >= params.maskH) { return 0.0; }
  let i = u32(ly) * params.maskW + u32(lx);
  return f32((mask[i >> 2u] >> ((i & 3u) * 8u)) & 255u) / params.maskMax;
}
fn floorDiv(v: i32) -> i32 { return select(v / 64, (v - 63) / 64, v < 0); }
fn weight(dab: Dab, ax: i32, ay: i32) -> f32 {
  var dx = f32(ax - params.originX) + 0.5 - dab.x;
  var dy = f32(ay - params.originY) + 0.5 - dab.y;
  if (params.round == 1u) { let u = dx * dab.cos + dy * dab.sin; dy = (dy * dab.cos - dx * dab.sin) * params.invRound; dx = u; }
  let r = dab.r;
  let d2 = dx * dx + dy * dy;
  if (d2 >= r * r) { return 0.0; }
  var e = 0.0;
  if (params.hardness >= 0.999) {
    if (d2 <= (r - 1.0) * (r - 1.0)) { e = 1.0; } else { e = clamp(r - sqrt(d2), 0.0, 1.0); }
  } else {
    let t = clamp((1.0 - sqrt(d2) / r) / max(1e-6, 1.0 - params.hardness), 0.0, 1.0);
    e = t * t * (3.0 - 2.0 * t);
  }
  if (params.hasMask == 1u) { e = e * maskAt(ax, ay); }
  return e;
}
fn readPixel(dab: Dab, ax: i32, ay: i32) -> u32 {
  let tx = floorDiv(ax);
  let ty = floorDiv(ay);
  let slot = refs[dab.refStart + u32(ty - dab.ty0) * dab.cols + u32(tx - dab.tx0)].read;
  if (slot == 0xffffffffu) { return 0u; }
  return pool[slot * 4096u + u32(ay - ty * 64) * 64u + u32(ax - tx * 64)];
}
fn channel(v: f32) -> u32 { return u32(clamp(floor(v + 0.5), 0.0, 255.0)); }
@compute @workgroup_size(256) fn sample(@builtin(local_invocation_index) li: u32) {
  let index = state.next;
  let dab = dabs[index];
  let stride = dab.stride;
  let columns = (dab.right - dab.left + stride - 1) / stride;
  let rows = (dab.bottom - dab.top + stride - 1) / stride;
  let total = u32(max(0, columns * rows));
  var acc = vec4f(0);
  var sw = 0.0;
  for (var k = li; k < total; k += 256u) {
    let ax = dab.left + i32(k % u32(columns)) * stride;
    let ay = dab.top + i32(k / u32(columns)) * stride;
    let e = weight(dab, ax, ay);
    if (e <= 0.0) { continue; }
    sw += e;
    let p = readPixel(dab, ax, ay);
    let a = f32(p >> 24u) / 255.0;
    acc += vec4f(f32(p & 255u) * a, f32((p >> 8u) & 255u) * a, f32((p >> 16u) & 255u) * a, a) * e;
  }
  sums[li] = acc;
  weights[li] = sw;
  workgroupBarrier();
  for (var span = 128u; span > 0u; span >>= 1u) {
    if (li < span) { sums[li] += sums[li + span]; weights[li] += weights[li + span]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let w = weights[0];
    if (w <= 0.0) { state.skip = 1u; }
    else {
      let picked = sums[0] / w;
      // The carried paint keeps \`length\` of itself and picks up the rest.
      var carry = picked;
      if (state.has == 1u) { carry = state.carry * params.length + picked * (1.0 - params.length); }
      if (params.rate > 0.0) { carry = carry * (1.0 - params.rate) + vec4f(params.color.rgb, 1.0) * params.rate; }
      state.carry = carry;
      state.has = 1u;
      state.skip = 0u;
    }
    state.current = index;
    state.next = index + 1u;
  }
}
@compute @workgroup_size(256) fn apply(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let dab = dabs[state.current];
  let tile = refs[dab.refStart + wg.x];
  let tx = dab.tx0 + i32(wg.x % dab.cols);
  let ty = dab.ty0 + i32(wg.x / dab.cols);
  let carry = state.carry;
  let paint = state.skip == 0u;
  for (var k = 0u; k < 16u; k++) {
    let q = li + k * 256u;
    let ax = tx * 64 + i32(q % 64u);
    let ay = ty * 64 + i32(q / 64u);
    var p = 0u;
    if (tile.init == 1u) { if (tile.before != 0xffffffffu) { p = pool[tile.before * 4096u + q]; } }
    else { p = pool[tile.write * 4096u + q]; }
    var changed = tile.init == 1u;
    if (paint && ax >= dab.left && ax < dab.right && ay >= dab.top && ay < dab.bottom) {
      let e = weight(dab, ax, ay) * dab.strength;
      if (e > 0.0) {
        let a = f32(p >> 24u) / 255.0;
        let pa = a * (1.0 - e) + carry.w * e;
        if (pa <= 0.0) { p = 0u; }
        else {
          let c = (vec3f(f32(p & 255u), f32((p >> 8u) & 255u), f32((p >> 16u) & 255u)) * a * (1.0 - e) + carry.xyz * e) / pa;
          p = channel(c.x) | (channel(c.y) << 8u) | (channel(c.z) << 16u) | (channel(pa * 255.0) << 24u);
        }
        changed = true;
      }
    }
    if (changed) { pool[tile.write * 4096u + q] = p; }
  }
}`;
/** Frames paint at most this many smudge dabs; later dabs wait for the next
 * frame so a fast stroke with a huge tip cannot stall the display. */
const SMUDGE_DABS_PER_FRAME=192;
const SMUDGE_DAB_WORDS=16;

/** Smudges one stroke on the GPU, dab by dab, into the same private overlay
 * slots, read-back and commit path as GpuStroke. */
export class GpuSmudgeStroke extends GpuStroke {
  constructor(gpu,presenter,brush,options){
    super(gpu,presenter,brush,{...options,coverage:false});
    this.refBuffer=new GrowableBuffer(this.device,'Drawing smudge tiles',GPUBufferUsage.STORAGE);
    this.stateBuffer=this.device.createBuffer({label:'Drawing smudge state',size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.device.queue.writeBuffer(this.stateBuffer,0,new Uint32Array(8));
  }
  get dirty(){return this.pending.length>0;}
  plan(){
    if(!this.pending.length||this.failed||this.planned)return;
    const dabs=this.pending.splice(0,SMUDGE_DABS_PER_FRAME);
    this.origin??={x:Math.floor(dabs[0].x),y:Math.floor(dabs[0].y)};
    const ox=this.origin.x,oy=this.origin.y,dabData=new ArrayBuffer(dabs.length*SMUDGE_DAB_WORDS*4),f=new Float32Array(dabData),s=new Int32Array(dabData),u=new Uint32Array(dabData),refs=[],touched=new Set();
    let dispatch=[];
    try{
      dabs.forEach((dab,index)=>{
        const tx0=Math.floor(dab.left/TILE),ty0=Math.floor(dab.top/TILE),tx1=Math.floor((dab.right-1)/TILE),ty1=Math.floor((dab.bottom-1)/TILE),cols=tx1-tx0+1,start=refs.length/4;
        for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++){
          const key=tileKey(tx,ty),tile=this.tile(tx,ty,key),init=!tile.initialized;tile.initialized=true;touched.add(key);
          const before=tile.before?.slot>=0?tile.before.slot:GPU_NONE;
          refs.push(init?before:tile.after.slot,tile.after.slot,init?1:0,before);
        }
        const o=index*SMUDGE_DAB_WORDS;
        f[o]=dab.x-ox;f[o+1]=dab.y-oy;f[o+2]=dab.radius;f[o+3]=dab.opacity*dab.flow;f[o+4]=dab.cos;f[o+5]=dab.sin;s[o+6]=smudgeStride(dab.right-dab.left,dab.bottom-dab.top);
        s[o+8]=dab.left;s[o+9]=dab.top;s[o+10]=dab.right;s[o+11]=dab.bottom;s[o+12]=tx0;s[o+13]=ty0;u[o+14]=cols;u[o+15]=start;
        dispatch.push(cols*(ty1-ty0+1));
      });
    }catch(error){this.fail(error);return;}
    this.planned={dabData,refs:new Uint32Array(refs),dispatch};
    this.gpu.invalidateKeys(this.state,touched);
  }
  encode(encoder){
    const planned=this.planned;if(!planned)return;this.planned=null;
    const {dabData,refs,dispatch}=planned,queue=this.device.queue,gpu=this.gpu;
    this.dabBuffer.ensure(dabData.byteLength);this.refBuffer.ensure(Math.max(16,refs.byteLength));
    queue.writeBuffer(this.dabBuffer.buffer,0,dabData);queue.writeBuffer(this.refBuffer.buffer,0,refs);
    // Dab indices restart with each frame's dab list; the carried paint stays.
    queue.writeBuffer(this.stateBuffer,20,new Uint32Array([0]));
    const b=this.brush,m=this.mask,params=new ArrayBuffer(PARAM_BYTES),f=new Float32Array(params),u=new Uint32Array(params),s=new Int32Array(params);
    f[0]=b.color[0];f[1]=b.color[1];f[2]=b.color[2];f[4]=b.hardness;f[5]=1/b.roundness;u[6]=b.roundness<.999?1:0;u[7]=m?1:0;
    f[8]=b.smudgeLength;f[9]=b.colorRate;s[10]=this.origin.x;s[11]=this.origin.y;s[12]=m?.x??0;s[13]=m?.y??0;u[14]=m?.width??0;u[15]=m?.height??0;f[16]=m?.max??1;
    queue.writeBuffer(this.paramBuffer,0,params);
    const key=`${gpu.pool.generation}|${this.dabBuffer.generation}|${this.refBuffer.generation}`;
    if(!this.bindGroup||this.bindGroupKey!==key){this.bindGroupKey=key;this.bindGroup=this.device.createBindGroup({layout:gpu.smudgeLayout,entries:[
      {binding:0,resource:{buffer:gpu.pool.buffer}},{binding:1,resource:{buffer:this.dabBuffer.buffer}},{binding:2,resource:{buffer:this.refBuffer.buffer}},
      {binding:3,resource:{buffer:this.paramBuffer}},{binding:4,resource:{buffer:this.maskBuffer}},{binding:5,resource:{buffer:this.stateBuffer}}]});}
    const pass=encoder.beginComputePass({label:'Drawing smudge dabs'});pass.setBindGroup(0,this.bindGroup);
    for(const tiles of dispatch){pass.setPipeline(gpu.smudgeSample);pass.dispatchWorkgroups(1);pass.setPipeline(gpu.smudgeApply);pass.dispatchWorkgroups(tiles);}
    pass.end();gpu.stats.strokeDispatches+=dispatch.length;
    // Dabs beyond this frame's share keep the display asking for frames.
    if(this.pending.length)queueMicrotask(()=>gpu.renderer.options.onInvalidate?.());
  }
  release(options){if(this.released)return;super.release(options);this.refBuffer.destroy();this.stateBuffer.destroy();}
}
function sameBytes(a,b){if(a.length!==b.length)return false;const x=new Uint32Array(a.buffer,a.byteOffset,a.length>>2),y=new Uint32Array(b.buffer,b.byteOffset,b.length>>2);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return false;return true;}
const normalizeSide=v=>v&&v.byteLength===4&&v[3]===0?null:v;
const yieldToInput=()=>globalThis.scheduler?.yield?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0));
function unionRect(a,b){if(!a)return b?{...b}:null;if(!b)return{...a};const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return{x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y};}
function intersect(a,b){if(!a||!b)return null;const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),width=Math.min(a.x+a.width,b.x+b.width)-x,height=Math.min(a.y+a.height,b.y+b.height)-y;return width>0&&height>0?{x,y,width,height}:null;}
