/** WebGPU drawing for generated effects.
 *
 * The vertex shader evaluates each particle from its layer record, birth table
 * and frame, mirroring evaluateParticle() in vfx-generators.mjs. Only the
 * compact records and table upload per frame; particles never exist on the
 * CPU. Material rows of the procedural atlas upload once, when first drawn.
 * Draws share the viewport's globals, attachments and sample count, so they
 * interleave with figure artwork inside the existing render passes. */
import {RECORD_BYTES,RECORD_FLOATS,BLEND} from './vfx-generators.mjs';
import {atlasRow,prewarmAtlas,CELL,COLUMNS,ATLAS_ROWS,ATLAS_LEVELS} from './vfx-generator-atlas.mjs';

const SHADER=/* wgsl */`
struct Globals { row0: vec4f, row1: vec4f, viewport: vec4f, clip: vec4f };
struct Layer { v: array<vec4f, 32> };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> tbl: array<vec4f>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlasSampler: sampler;
@group(1) @binding(0) var<uniform> L: Layer;

const TAU = 6.28318530718;
const ROWS = ${ATLAS_ROWS}.0;
const COLUMNS = ${COLUMNS}.0;
const CELL = ${CELL}.0;
const MAX_LOD = ${ATLAS_LEVELS - 1}.0;
const Q = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hsh(n: u32, k: u32, seed: u32) -> f32 { return f32(pcg(pcg(n ^ (seed * 1664525u)) + k * 1013904223u)) * (1.0 / 4294967296.0); }
fn hash2(x: i32, y: i32) -> f32 { return f32(pcg((bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u))) * (1.0 / 4294967296.0); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * (3.0 - 2.0 * f); let ix = i32(i.x); let iy = i32(i.y);
  return mix(mix(hash2(ix, iy), hash2(ix + 1, iy), u.x), mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), u.x), u.y);
}
fn smooth01(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// Local coordinates -> movieclip transform -> parallax/drag offset -> viewport.
fn toClip(p: vec2f) -> vec4f {
  let m = L.v[26]; let t = L.v[27];
  let q = vec3f(vec2f(m.x * p.x + m.z * p.y, m.y * p.x + m.w * p.y) + t.xy + L.v[12].xy, 1.0);
  let s = vec2f(dot(globals.row0.xyz, q), dot(globals.row1.xyz, q));
  return vec4f(s.x / globals.viewport.x * 2.0 - 1.0, 1.0 - s.y / globals.viewport.y * 2.0, 0.0, 1.0);
}
fn pixel() -> f32 { return 1.0 / max(globals.row0.w * globals.viewport.z * L.v[27].z, 0.0001); }
fn stopOpacity(i: u32) -> f32 { let q = L.v[24u + i / 4u]; return q[i % 4u]; }
fn ramp(x: f32) -> vec4f {
  let y = clamp(x, 0.0, 1.0) * 7.0; let i = min(6u, u32(floor(y))); let f = y - f32(i);
  let c = mix(L.v[16u + i], L.v[17u + i], f);
  // Additive layers clip toward white. Normal layers keep their hue: extra
  // intensity saturates the colour and lower intensity becomes transparency.
  let op = mix(stopOpacity(i), stopOpacity(i + 1u), f);
  if (L.v[4].w == 1.0) { return vec4f(min(vec3f(1.0), c.rgb * c.a), op); }
  if (c.a < 1.0) { return vec4f(c.rgb, op * max(c.a, 0.0)); }
  let rgb = c.rgb * c.a;
  return vec4f(min(vec3f(1.0), rgb / max(1.0, max(rgb.r, max(rgb.g, rgb.b)))), op);
}
// Material shading: 0.5 keeps the colour, lower darkens, higher lightens.
fn shadeRgb(c: vec3f, s: f32) -> vec3f {
  if (s < 0.5) { return c * (0.25 + 1.5 * s); }
  return mix(c, vec3f(1.0), (s - 0.5) * 1.4);
}
fn row(k: i32) -> vec4f { return tbl[u32(i32(L.v[7].z) + k * 2)]; }
fn row2(k: i32) -> vec4f { return tbl[u32(i32(L.v[7].z) + k * 2 + 1)]; }
fn beamTip(te: f32) -> vec2f {
  let k = clamp((te - L.v[14].w) / max(L.v[14].z, 1.0), 0.0, 1.0);
  return mix(L.v[9].xy, L.v[9].zw, 1.0 - (1.0 - k) * (1.0 - k));
}
fn beamWidth(te: f32) -> f32 { return smooth01(L.v[14].w - 1.0, L.v[14].w + 2.0, te) * (1.0 - smooth01(L.v[15].x - L.v[15].y, L.v[15].x, te)); }
fn curlPotential(q: vec2f, tt: f32) -> f32 { return vnoise(q + vec2f(tt, 0.0)) + 0.5 * vnoise(q * 2.03 + vec2f(13.7, -tt)); }

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) prm: vec4f,
  @location(3) @interpolate(flat) kind: u32,
};
fn dead() -> VO { var o: VO; o.pos = vec4f(-9.0, -9.0, 0.0, 1.0); o.uv = vec2f(0.0); o.color = vec4f(0.0); o.prm = vec4f(0.0); o.kind = 99u; return o; }
fn capsule(p0: vec2f, p1: vec2f, r: f32, margin: f32, c: vec2f) -> VO {
  var o = dead();
  let d = p1 - p0; let l = length(d);
  var dn = vec2f(1.0, 0.0); if (l > 1e-4) { dn = d / l; }
  let hl = 0.5 * l; let e = r + margin;
  let local = vec2f(c.x * (hl + e), c.y * e);
  o.pos = toClip((p0 + p1) * 0.5 + dn * local.x + vec2f(-dn.y, dn.x) * local.y);
  o.uv = local; o.prm = vec4f(hl, r, 0.0, 0.0);
  return o;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var q = Q; let c = q[vi];
  if (ii >= u32(L.v[0].z)) { return dead(); }
  let shape = u32(L.v[4].z); let seed = u32(L.v[1].w);
  let t = L.v[13].z; let cs = L.v[12].z; let stp = L.v[1].z;
  var te = t; if (stp > 1.0) { te = cs + floor((t - cs) / stp) * stp; }

  if (shape == 4u) {
    if (te < L.v[14].w - 1.0 || te > L.v[15].x) { return dead(); }
    let a = L.v[9].xy; let b = beamTip(te);
    let d = b - a; let len = max(length(d), 1.0); let dn = d / len; let nn = vec2f(-dn.y, dn.x);
    var w = L.v[14].x * beamWidth(te); if (w > 0.05) { w = w * L.v[30].y + L.v[30].z; }
    let halo = w * 3.5 + 8.0;
    let lx = mix(-halo, len + halo, c.x * 0.5 + 0.5); let ly = c.y * halo;
    var o = dead();
    o.pos = toClip(a + dn * lx + nn * ly); o.uv = vec2f(lx, ly);
    o.prm = vec4f(len, w, L.v[14].y, f32(seed % 997u)); o.kind = 4u; o.color = vec4f(te, pixel(), 0.0, L.v[6].z);
    return o;
  }
  if (shape == 5u) {
    if (te < L.v[14].w + L.v[14].z || te > L.v[15].x) { return dead(); }
    let segs = max(u32(L.v[15].z), 1u); let arc = ii / segs; let k = ii % segs;
    let key = pcg(seed + arc * 7919u + u32(floor(te / 2.0)) * 104729u);
    if (hsh(arc, 99u, key) < 0.3) { return dead(); }
    let a = L.v[9].xy; let b = beamTip(te);
    let d = b - a; let len = max(length(d), 1.0); let nn = vec2f(-d.y, d.x) / len;
    let f0 = f32(k) / f32(segs); let f1 = f32(k + 1u) / f32(segs);
    let amp = L.v[15].w * (0.6 + 0.8 * hsh(arc, 98u, key));
    let o0 = (hsh(k, 3u, key) - 0.5) * 2.0 * amp * sin(3.14159265 * f0);
    let o1 = (hsh(k + 1u, 3u, key) - 0.5) * 2.0 * amp * sin(3.14159265 * f1);
    let r = L.v[5].x;
    var o = capsule(mix(a, b, f0) + nn * o0, mix(a, b, f1) + nn * o1, r, r * 4.0, c);
    let col = ramp(0.0);
    o.kind = 5u; o.color = vec4f(col.rgb, L.v[6].z * col.a * beamWidth(te)); o.prm.z = pixel();
    return o;
  }

  let start = L.v[0].x; let emitDur = L.v[0].y; let K = i32(L.v[0].z);
  var n: u32; var born: f32;
  if (emitDur <= 0.0) {
    n = ii; born = start + hsh(n, 1u, seed) * L.v[10].y;
  } else {
    let r = max(L.v[0].w, 1e-4); let span = te - start;
    if (span < 0.0) { return dead(); }
    let nMax = i32(floor(span * r)); let m = ((nMax - i32(ii)) % K + K) % K; let ni = nMax - m;
    if (ni < 0) { return dead(); }
    n = u32(ni); born = start + (f32(ni) + hsh(n, 1u, seed)) / r;
    if (born > start + emitDur) { return dead(); }
  }
  let age = te - born; let life = mix(L.v[1].x, L.v[1].y, hsh(n, 2u, seed));
  if (age < 0.0 || age >= life) { return dead(); }
  let an = age / life; let ticks = i32(L.v[8].x); let fb = floor(born);
  let k = clamp(i32(fb - L.v[7].w), 0, ticks - 1); let k1 = min(k + 1, ticks - 1); let fr = clamp(born - fb, 0.0, 1.0);
  let rk = row(k); let rk1 = row(k1); let rs = row2(k);
  if (hsh(n, 15u, seed) >= rk.z) { return dead(); }
  var fade = 1.0;
  if (L.v[13].x > 0.0) { fade *= clamp((born - L.v[12].z) / L.v[13].x, 0.0, 1.0); }
  if (L.v[13].y > 0.0) { fade *= clamp((L.v[12].w - born) / L.v[13].y, 0.0, 1.0); }
  if (fade <= 0.001) { return dead(); }
  let anchor = mix(rk.xy, rk1.xy, fr);
  var p = anchor; var base = L.v[2].z + rk.w;
  let sq = L.v[30].w;
  let r1 = hsh(n, 3u, seed); let r2 = hsh(n, 4u, seed); let da = hsh(n, 10u, seed) * TAU; let dr = sqrt(hsh(n, 9u, seed));
  let disc = vec2f(cos(da) * dr, sin(da) * dr * sq);
  let es = u32(L.v[7].x); let er = L.v[7].y;
  if (es == 1u && L.v[8].z > 0.0) {
    let count = L.v[8].z; let si = min(floor(r1 * count), count - 1.0);
    var block = 0.0; if (L.v[8].w > 0.5) { block = clamp(fb - L.v[27].w, 0.0, L.v[8].w - 1.0) * count; }
    let s = tbl[u32(L.v[8].y + block + si)];
    p = mix(s.xy, s.zw, r2) + disc * er;
  } else if (es == 2u || es == 4u) {
    let b = beamTip(te); let e = b - L.v[9].xy; let len = max(length(e), 1e-3);
    base += atan2(e.y, e.x);
    if (es == 2u) { p = mix(L.v[9].xy, b, r2) + vec2f(-e.y, e.x) / len * (r1 - 0.5) * 2.0 * er; }
    else { p = b + disc * er; }
  } else if (es == 3u) { p = anchor + vec2f(cos(r1 * TAU), sin(r1 * TAU) * sq) * er; }
  else if (es == 5u) { p = vec2f(anchor.x + (r1 - 0.5) * 2.0 * er, L.v[11].y - 3.0); }
  else if (es == 6u) { p = anchor + vec2f(-sin(base), cos(base)) * (r1 - 0.5) * 2.0 * er; }
  else if (es == 7u) {
    let d = vec2f(cos(base), sin(base)); let stage = L.v[11].zw;
    let half = abs(d.x) * stage.x * 0.5 + abs(d.y) * stage.y * 0.5 + 20.0; let span = (abs(d.y) * stage.x + abs(d.x) * stage.y) * 1.2;
    p = stage * 0.5 - d * half + vec2f(-d.y, d.x) * (r1 - 0.5) * span;
  }
  else { p = anchor + disc * er; }

  let ang = base + (hsh(n, 5u, seed) - 0.5) * L.v[2].w;
  var dir = vec2f(cos(ang), sin(ang));
  if (es == 5u) { dir = normalize(vec2f(select(-1.0, 1.0, hsh(n, 11u, seed) > 0.5), -0.3 * hsh(n, 12u, seed))); }
  if (L.v[3].z != 0.0) {
    let rd = p - anchor; let rl = length(rd);
    if (rl > 1e-3) { dir = normalize(mix(dir, rd / rl * sign(L.v[3].z), abs(L.v[3].z)) + vec2f(1e-5, 0.0)); }
  }
  var vel = dir * mix(L.v[2].x, L.v[2].y, hsh(n, 6u, seed)) * rs.x;
  if (L.v[10].x != 0.0) { let kp = max(k - 1, 0); vel += L.v[10].x * (rk.xy - row(kp).xy); }
  // Launch velocity with drag, plus constant gravity and wind accelerations.
  let p0 = p; let g = vec2f(L.v[31].w, L.v[3].x); let kd = L.v[3].y;
  var gd: vec2f; var gv: vec2f;
  if (kd > 1e-4) {
    let e = exp(-kd * age); let qd = (1.0 - e) / kd; let w = (age - qd) / kd;
    p += vel * qd; vel *= e; gd = g * w; gv = g * qd;
  } else {
    p += vel * age; gd = g * (0.5 * age * age); gv = g * age;
  }
  let orb = L.v[29].y;
  if (orb != 0.0) {
    let a = orb * age; let co = cos(a); let si = sin(a); let rx = p.x - anchor.x; let wx = vel.x;
    if (es == 1u || es == 6u || es == 5u) {
      p = vec2f(anchor.x + rx * co, p.y + rx * si * sq);
      vel = vec2f(wx * co - orb * rx * si, vel.y + (wx * si + orb * rx * co) * sq);
    } else {
      let ry = (p.y - anchor.y) / sq; let wy = vel.y / sq; let nx = rx * co - ry * si; let ny = rx * si + ry * co;
      p = anchor + vec2f(nx, ny * sq);
      vel = vec2f(wx * co - wy * si - orb * ny, (wx * si + wy * co + orb * nx) * sq);
    }
  }
  p += gd; vel += gv;
  let turb = L.v[3].w;
  if (turb > 0.0) {
    let tq = p0 * L.v[4].x + vec2f(hsh(n, 7u, seed) * 37.0, 0.0); let tt = te * 0.035;
    let dsp = vec2f(vnoise(tq + vec2f(tt, 0.0)), vnoise(tq + vec2f(19.1, tt))) * 2.0 - 1.0;
    p += dsp * turb * an; vel += dsp * turb / life;
  }
  if (L.v[29].z > 0.0) {
    // Curl noise: a divergence-free flow sampled where the particle is.
    let qn = p * L.v[29].w; let tt = te * 0.02; let e = 0.35;
    let c0 = curlPotential(qn, tt); let gx = curlPotential(qn + vec2f(e, 0.0), tt) - c0; let gy = curlPotential(qn + vec2f(0.0, e), tt) - c0;
    let amount = L.v[29].z * an / e; p += vec2f(gy, -gx) * amount;
  }
  if (L.v[11].x > 0.5 && p.y > L.v[11].y - 1.5) { p.y = L.v[11].y - 1.5; vel.y = 0.0; }
  let sm = u32(L.v[30].x);
  var growth: f32;
  if (sm == 1u) { let qa = 1.0 - an; growth = 1.0 - qa * qa * qa; }
  else if (sm == 2u) { let qa = 1.0 - min(an * 4.0, 1.0); growth = 1.0 - qa * qa; }
  else { growth = pow(max(an, 1e-6), L.v[10].w); }
  var sz = rs.y * mix(L.v[5].x, L.v[5].y, growth) * (1.0 + (hsh(n, 8u, seed) - 0.5) * 2.0 * L.v[10].z) * mix(0.3, 1.0, fade);
  if (sm == 2u) { sz *= 1.0 - smooth01(0.6, 1.0, an); }
  else if (sm == 3u) { let h = hsh(n, 21u, seed); sz *= 0.55 + 0.9 * vnoise(vec2f(te * 0.45 + h * 61.7, h * 17.3)); }
  // Echo, halo and outline draws scale or widen the same particle.
  if (sz > 0.0) { sz = sz * L.v[30].y + L.v[30].z; } else { sz = 0.0; }
  let fi = select(smooth01(0.0, L.v[6].x, an), 1.0, L.v[6].x <= 0.0);
  let fo = select(1.0 - smooth01(1.0 - L.v[6].y, 1.0, an), 1.0, L.v[6].y <= 0.0);
  let col = ramp(select(an, hsh(n, 16u, seed), L.v[6].w > 0.5));
  var alpha = L.v[6].z * fi * fo * fade * col.a;
  if (L.v[31].x > 0.0) { let h = hsh(n, 22u, seed); alpha *= 1.0 - L.v[31].x * vnoise(vec2f(te * 0.8 + h * 53.1, h * 29.7)); }
  if (alpha <= 0.0 || sz <= 0.0) { return dead(); }
  let rm = u32(L.v[28].w);
  var rot: f32;
  if (rm == 1u) { rot = select(0.0, atan2(vel.y, vel.x) + 1.57079632679, dot(vel, vel) > 1e-6); }
  else if (rm == 2u) { rot = (hsh(n, 13u, seed) - 0.5) * 0.35; }
  else if (rm == 3u) { rot = 0.0; }
  else { rot = hsh(n, 13u, seed) * TAU + L.v[4].y * age * (1.0 + L.v[29].x * ((hsh(n, 19u, seed) * 2.0 - 1.0) * 1.5 - 1.0)); }
  let cr = vec2f(cos(rot), sin(rot));

  var o = dead();
  o.color = vec4f(col.rgb, alpha); o.kind = shape;
  let px = pixel();
  if (shape == 1u) {
    let sp = length(vel); var d = vec2f(1.0, 0.0); if (sp > 1e-4) { d = vel / sp; }
    let hl = 0.5 * sp * L.v[5].z; let rr = max(sz, px * 0.5);
    let local = vec2f(c.x * (hl + rr + px), c.y * (rr + px));
    o.pos = toClip(p - d * hl + d * local.x + vec2f(-d.y, d.x) * local.y);
    o.uv = local; o.prm = vec4f(hl, rr, L.v[5].w, px);
    return o;
  }
  if (shape == 3u) {
    let e = c * (sz * 1.3 + px);
    o.pos = toClip(p + vec2f(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x));
    o.uv = c * (1.3 + px / max(sz, 1e-3)); o.prm = vec4f(hsh(n, 14u, seed), px / max(sz, 1e-3), 0.0, 0.0);
    return o;
  }
  if (shape == 6u) {
    // Textured sprite: one atlas cell, scaled along its up axis by aspect and speed.
    let hx = max(sz, px * 0.5); let hy = hx * L.v[31].y + 0.5 * length(vel) * L.v[5].z;
    let e = vec2f(c.x * hx, c.y * hy);
    o.pos = toClip(p + vec2f(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x));
    let code = u32(L.v[28].y); let cells = max(code % 16u, 1u);
    var vi = min(u32(floor(hsh(n, 20u, seed) * f32(cells))), cells - 1u);
    if (L.v[31].z > 0.0) { vi = (vi + u32(floor(age / L.v[31].z))) % cells; }
    let cell = vec2f(f32(code / 16u + vi), L.v[28].x - 1.0);
    o.uv = vec2f((cell.x + c.x * 0.5 + 0.5) / COLUMNS, (cell.y + c.y * 0.5 + 0.5) / ROWS);
    // Level of detail from the cell's size on screen.
    o.prm = vec4f(L.v[28].z, clamp(log2(CELL * px / (2.0 * max(hx, hy))), 0.0, MAX_LOD), 0.0, 0.0);
    return o;
  }
  if (shape == 7u) {
    let rr = max(sz, px * 0.5); let e = c * (rr + px);
    o.pos = toClip(p + vec2f(e.x * cr.x - e.y * cr.y, e.x * cr.y + e.y * cr.x));
    o.uv = c * (1.0 + px / rr); o.prm = vec4f(px / rr, 0.0, 0.0, 0.0);
    return o;
  }
  let grow = select(1.0, 1.0 + L.v[5].w * 2.0, shape == 2u);
  let rr = max(sz, px * 0.5);
  // Soft discs may be flattened into ellipses, such as glows on the ground.
  let squash = select(1.0, L.v[31].y, shape == 0u);
  o.pos = toClip(p + c * (rr * grow + px) * vec2f(1.0, squash)); o.uv = c * (grow + px / rr);
  o.prm = vec4f(L.v[5].w, px / rr, 0.0, 0.0);
  return o;
}

fn outside(pos: vec4f) -> bool {
  let point = pos.xy / globals.viewport.z;
  let center = (globals.clip.xy + globals.clip.zw) * 0.5; let angle = globals.row1.w; let d = point - center;
  let s = center + vec2f(cos(angle) * d.x + sin(angle) * d.y, -sin(angle) * d.x + cos(angle) * d.y);
  return globals.viewport.w > 0.5 && (s.x < globals.clip.x || s.y < globals.clip.y || s.x > globals.clip.z || s.y > globals.clip.w);
}
fn soft(d: f32, s: f32, aa: f32) -> f32 {
  let edge = 1.0 - smooth01(1.0 - aa, 1.0, d);
  return pow(max(1.0 - d, 1e-5), s) * edge;
}
fn beamColor(i: VO) -> vec4f {
  let len = i.prm.x; let w = i.prm.y;
  if (w <= 0.05) { discard; }
  let t = i.color.x; let x = i.uv.x; let aa = i.color.y; let style = u32(L.v[28].x);
  let wob = (vnoise(vec2f(x * 0.018 - t * 0.55, i.prm.w)) - 0.5) * 2.0 * i.prm.z * w * smooth01(0.0, 80.0, x);
  let y = i.uv.y - wob;
  let ww = w * mix(0.55, 1.0, smooth01(0.0, 70.0, x));
  let d = length(vec2f(max(max(-x, x - len), 0.0), abs(y)));
  let c0 = ramp(0.0); let c1 = ramp(1.0);
  if (style == 2u) {
    // Cartoon: a flat body with a lighter core band and crisp edges.
    let body = 1.0 - smooth01(ww - aa, ww + aa, d); let core = 1.0 - smooth01(ww * 0.45 - aa, ww * 0.45 + aa, d);
    let a = body * i.color.w;
    return vec4f(mix(c1.rgb, c0.rgb, core) * a, a);
  }
  var core: f32; var body: f32; var glow: f32;
  let pulse = 0.8 + 0.4 * vnoise(vec2f(x * 0.035 - t * 1.7, 3.0 + i.prm.w));
  if (style == 1u) {
    // Laser: a hard, steady core with a tight glow.
    core = 1.0 - smooth01(ww * 0.2 - aa, ww * 0.2 + aa, d); body = 1.0 - smooth01(ww * 0.5 - aa, ww * 0.5 + aa, d); glow = exp(-d / (ww * 1.1 + 1.0)) * 0.5;
  } else {
    core = 1.0 - smooth01(ww * 0.26, ww * 0.42, d); body = 1.0 - smooth01(ww * 0.45, ww, d); glow = exp(-d / (ww * 0.9 + 1.0)) * 0.45;
  }
  var rgb = c0.rgb * core + c1.rgb * (body * 0.8 + glow) * select(pulse, 1.0, style == 1u);
  var a = core + body * 0.7 + glow * 0.5;
  if (style == 3u) {
    // Spiral: two strands winding around the beam.
    let period = max(24.0, w * 3.2); let inside = step(0.0, x) * step(x, len);
    for (var s = 0u; s < 2u; s++) {
      let phase = x / period * TAU - t * 0.35 + f32(s) * 3.14159265;
      let sy = sin(phase) * ww * 0.95; let depth = 0.55 + 0.45 * cos(phase);
      let strand = exp(-abs(y - sy) / (ww * 0.1 + 0.6)) * depth * inside;
      rgb += c0.rgb * strand; a += strand * 0.8;
    }
  }
  let alpha = clamp(a, 0.0, 1.0) * i.color.w;
  return vec4f(min(vec3f(1.0), rgb) * alpha, alpha);
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  if (outside(i.pos)) { discard; }
  var cov = 0.0;
  switch i.kind {
    case 0u: { cov = soft(length(i.uv), i.prm.x, min(i.prm.y * 1.5, 1.0)); }
    case 1u: {
      // A tapered streak: full width and brightness at the head, thinning and
      // fading toward the tail.
      let hl = i.prm.x; let t = clamp(i.uv.x / max(hl, 1e-3) * 0.5 + 0.5, 0.0, 1.0);
      let w = select(1.0, mix(0.3, 1.0, t), hl > 0.5);
      let d = length(vec2f(max(abs(i.uv.x) - hl, 0.0), i.uv.y / w)) / i.prm.y;
      let tail = select(1.0, t * t * (3.0 - 2.0 * t) * 0.9 + 0.1, hl > 0.5);
      cov = soft(d, i.prm.z, min(i.prm.w / i.prm.y * 1.5, 1.0)) * tail;
    }
    case 2u: {
      let d = length(i.uv); let rd = abs(d - 1.0) / max(i.prm.x, 0.01);
      cov = pow(max(1.0 - rd, 0.0), 1.6) + 0.18 * (1.0 - smooth01(0.0, 1.0, d)) * step(d, 1.0);
    }
    case 3u: {
      let q = abs(i.uv); let d = max(q.x, q.y * (0.55 + 0.6 * i.prm.x) + q.x * 0.25);
      cov = 1.0 - smooth01(1.0 - min(i.prm.y * 1.5, 1.0), 1.0, d);
    }
    case 4u: { return beamColor(i); }
    case 5u: {
      let d = length(vec2f(max(abs(i.uv.x) - i.prm.x, 0.0), i.uv.y)); let r = i.prm.y;
      cov = min(clamp(1.0 - (d - r) / i.prm.z, 0.0, 1.0) + exp(-d / (r * 2.5)) * 0.55, 1.0);
    }
    case 6u: {
      let tex = textureSampleLevel(atlas, atlasSampler, i.uv, i.prm.y);
      if (tex.g <= 0.002) { discard; }
      let rgb = shadeRgb(i.color.rgb, mix(0.5, clamp(tex.r / tex.g, 0.0, 1.0), i.prm.x));
      let k = tex.g * i.color.a;
      return vec4f(rgb * k, k);
    }
    case 7u: {
      let q = max(abs(i.uv.x), abs(i.uv.y)); let aa = min(i.prm.x * 1.5, 1.0);
      cov = 1.0 - smooth01(1.0 - aa, 1.0, q);
    }
    default: { discard; }
  }
  let k = cov * i.color.a;
  return vec4f(i.color.rgb * k, k);
}`;

const BLENDS={
 [BLEND.normal]:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}},
 [BLEND.add]:{color:{srcFactor:'one',dstFactor:'one',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one',operation:'add'}},
};

/** Owns generator pipelines, per-frame buffers and the material atlas on the viewport's device. */
export class GeneratorGpu{
 constructor(device,format,globals){
  this.device=device;this.format=format;this.globals=globals;this.pipelines=new Map();this.recordCapacity=0;this.tableCapacity=0;this.atlasRows=new Set();
  this.module=device.createShaderModule({label:'Generated effects',code:SHADER});
  this.layout0=device.createBindGroupLayout({label:'Generated effects globals',entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},{binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
  this.layout1=device.createBindGroupLayout({label:'Generated effects layer',entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform',hasDynamicOffset:true,minBindingSize:RECORD_FLOATS*4}}]});
  this.pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[this.layout0,this.layout1]});
  // Rows fill in on first use; untouched rows are never sampled.
  this.atlas=device.createTexture({label:'Generated effect materials',size:[CELL*COLUMNS,CELL*ATLAS_ROWS],format:'rg8unorm',mipLevelCount:ATLAS_LEVELS,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  this.sampler=device.createSampler({label:'Generated effect materials',magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
  this.stats={draws:0,particles:0,uploadBytes:0};prewarmAtlas();
 }
 pipelineDescriptor(blend,samples){
  return {label:`Generated effects ${blend?'additive':'normal'} ${samples}×`,layout:this.pipelineLayout,vertex:{module:this.module,entryPoint:'vs'},fragment:{module:this.module,entryPoint:'fs',targets:[{format:this.format,blend:BLENDS[blend]}]},primitive:{topology:'triangle-list'},multisample:{count:samples}};
 }
 /** Finish shader compilation before the renderer becomes interactive. Both
  * preview quality levels are ready, including camera and prepared playback. */
 async initialize(){
  const entries=await Promise.all([1,4].flatMap(samples=>[0,1].map(async blend=>[
   `${blend}:${samples}`,await this.device.createRenderPipelineAsync(this.pipelineDescriptor(blend,samples)),
  ])));
  if(!this.destroyed)for(const [key,pipeline] of entries)this.pipelines.set(key,pipeline);
 }
 pipeline(blend,samples){
  const key=`${blend}:${samples}`;let pipeline=this.pipelines.get(key);
  if(!pipeline){pipeline=this.device.createRenderPipeline(this.pipelineDescriptor(blend,samples));this.pipelines.set(key,pipeline);}
  return pipeline;
 }
 /** Upload a material row and its reduced levels once. */
 ensureRow(row){
  if(row<0||this.atlasRows.has(row))return;
  const strip=atlasRow(row);
  strip.levels.forEach((level,mip)=>this.device.queue.writeTexture({texture:this.atlas,mipLevel:mip,origin:[0,row*level.height,0]},level.data,{bytesPerRow:level.width*2,rowsPerImage:level.height},[level.width,level.height,1]));
  this.atlasRows.add(row);this.stats.uploadBytes+=strip.levels.reduce((n,l)=>n+l.data.byteLength,0);
 }
 /** Upload one batch. Queue order lets later passes upload their own batch. */
 upload(batch){
  const {device}=this,layers=batch.draws.length,recordBytes=layers*RECORD_BYTES,tableBytes=Math.max(16,batch.table.byteLength);
  let rebind=false;this.stats.uploadBytes=0;
  if(recordBytes>this.recordCapacity){this.records?.destroy();this.recordCapacity=Math.max(RECORD_BYTES*16,2**Math.ceil(Math.log2(recordBytes)));this.records=device.createBuffer({label:'Generated effect layers',size:this.recordCapacity,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.staging=new Float32Array(this.recordCapacity/4);rebind=true;}
  if(tableBytes>this.tableCapacity){this.table?.destroy();this.tableCapacity=Math.max(4096,2**Math.ceil(Math.log2(tableBytes)));this.table=device.createBuffer({label:'Generated effect birth table',size:this.tableCapacity,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});rebind=true;}
  if(rebind||this.boundGlobals!==this.globals){
   this.group0=device.createBindGroup({layout:this.layout0,entries:[{binding:0,resource:{buffer:this.globals}},{binding:1,resource:{buffer:this.table}},{binding:2,resource:this.atlas.createView()},{binding:3,resource:this.sampler}]});
   this.group1=device.createBindGroup({layout:this.layout1,entries:[{binding:0,resource:{buffer:this.records,size:RECORD_FLOATS*4}}]});this.boundGlobals=this.globals;
  }
  for(const draw of batch.draws)this.ensureRow(draw.material??-1);
  for(let i=0;i<layers;i++)this.staging.set(batch.records.subarray(i*RECORD_FLOATS,(i+1)*RECORD_FLOATS),i*RECORD_BYTES/4);
  device.queue.writeBuffer(this.records,0,this.staging,0,recordBytes/4);
  if(batch.table.byteLength)device.queue.writeBuffer(this.table,0,batch.table);
  this.stats.uploadBytes+=recordBytes+batch.table.byteLength;
 }
 /** Encode draws into an open pass; restores the caller's pipeline afterwards. */
 draw(pass,draws,samples,restore){
  let current=-1;
  for(const draw of draws){
   if(draw.blend!==current){pass.setPipeline(this.pipeline(draw.blend,samples));pass.setBindGroup(0,this.group0);current=draw.blend;}
   pass.setBindGroup(1,this.group1,[draw.record*RECORD_BYTES]);pass.draw(6,draw.count);
   this.stats.draws++;this.stats.particles+=draw.count;
  }
  if(current>=0)restore?.(pass);
 }
 destroy(){this.destroyed=true;this.records?.destroy();this.table?.destroy();this.atlas?.destroy();this.records=this.table=this.atlas=null;this.atlasRows.clear();this.pipelines.clear();}
}
