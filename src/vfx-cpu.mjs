import {activeVfx} from './vfx.mjs';
import {vfxPaint} from './vfx-paint.mjs';

/** Software VFX executor: a typed-array port of the GLSL/WGSL fragment passes.
 * Surfaces are premultiplied unorm8 RGBA buffers matching the GPU ping-pong
 * slots. No texture dimension or GPU availability limit applies — a surface
 * only needs memory for its pixels. This is the guaranteed path for export
 * and for any region the GPU executors cannot allocate.
 * Conventions mirror vfx-shaders.mjs: buffers are top-down rows; fragment uv
 * is bottom-up (uv.y=1 at the top row, as in GLSL); sampleAt guards bounds
 * then bilinear-fetches with edge-clamped texels; every pass output rounds
 * back to unorm8 like an rgba8unorm render target. */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = v => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const fract = v => v - Math.floor(v);
const mix = (a, b, t) => a + (b - a) * t;
const hashValue = n => { n = (n ^ (n >>> 16)) >>> 0; n = Math.imul(n, 0x7feb352d) >>> 0; n = (n ^ (n >>> 15)) >>> 0; n = Math.imul(n, 0x846ca68b) >>> 0; n = (n ^ (n >>> 16)) >>> 0; return n; };
const hashPoint = (x, y, seed) => ((hashValue((Math.imul(x | 0, 1973) + Math.imul(y | 0, 9277) + Math.imul(seed >>> 0, 26699)) >>> 0) & 0xffff) / 65535);
function noiseAt(px, py, seed, smoothness) {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = mix(fx, fx * fx * (3 - 2 * fx), smoothness); fy = mix(fy, fy * fy * (3 - 2 * fy), smoothness);
  const a = hashPoint(ix, iy, seed), b = hashPoint(ix + 1, iy, seed), c = hashPoint(ix, iy + 1, seed), d = hashPoint(ix + 1, iy + 1, seed);
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

export class VfxCPU {
  constructor() {
    this.slots = [];
    this.canvas = null;
    this._screen = null;
    this.stats = { passes: 0, bytes: 0, calls: 0 };
  }
  slot(index, width, height) {
    let slot = this.slots[index];
    if (!slot) slot = this.slots[index] = { pixels: null, width: 0, height: 0 };
    if (slot.width !== width || slot.height !== height) {
      slot.width = width; slot.height = height;
      slot.pixels = new Uint8ClampedArray(width * height * 4);
    }
    return slot;
  }
  screen(width, height) {
    const s = this._screen ??= { pixels: null, width: 0, height: 0 };
    if (s.width !== width || s.height !== height) { s.width = width; s.height = height; s.pixels = new Uint8ClampedArray(width * height * 4); }
    return s;
  }
  /** Bilinear fetch of `buf` at top-down texture fraction (u,v): v=0 is the top
   * row. Out-of-range uv returns transparent black (sampleAt's guard); in-range
   * uv clamps its texel neighbourhood to the edge (CLAMP_TO_EDGE). */
  sample(buf, u, v, out) {
    if (u < 0 || u > 1 || v < 0 || v > 1) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    const W = buf.width, H = buf.height, px = buf.pixels;
    const x = u * W - 0.5, y = v * H - 0.5;
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    x0 = clamp(x0, 0, W - 1); y0 = clamp(y0, 0, H - 1);
    const x1 = clamp(x0 + 1, 0, W - 1), y1 = clamp(y0 + 1, 0, H - 1);
    const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = (px[i00] * w00 + px[i10] * w10 + px[i01] * w01 + px[i11] * w11) / 255;
    out[1] = (px[i00 + 1] * w00 + px[i10 + 1] * w10 + px[i01 + 1] * w01 + px[i11 + 1] * w11) / 255;
    out[2] = (px[i00 + 2] * w00 + px[i10 + 2] * w10 + px[i01 + 2] * w01 + px[i11 + 2] * w11) / 255;
    out[3] = (px[i00 + 3] * w00 + px[i10 + 3] * w10 + px[i01 + 3] * w01 + px[i11 + 3] * w11) / 255;
    return out;
  }
  /** texture() without the bounds guard: CLAMP_TO_EDGE bilinear. */
  texel(buf, u, v, out) {
    const W = buf.width, H = buf.height, px = buf.pixels;
    const x = u * W - 0.5, y = v * H - 0.5;
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const x0 = clamp(Math.floor(x), 0, W - 1), y0 = clamp(Math.floor(y), 0, H - 1);
    const x1 = clamp(x0 + 1, 0, W - 1), y1 = clamp(y0 + 1, 0, H - 1);
    const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = (px[i00] * w00 + px[i10] * w10 + px[i01] * w01 + px[i11] * w11) / 255;
    out[1] = (px[i00 + 1] * w00 + px[i10 + 1] * w10 + px[i01 + 1] * w01 + px[i11 + 1] * w11) / 255;
    out[2] = (px[i00 + 2] * w00 + px[i10 + 2] * w10 + px[i01 + 2] * w01 + px[i11 + 2] * w11) / 255;
    out[3] = (px[i00 + 3] * w00 + px[i10 + 3] * w10 + px[i01 + 3] * w01 + px[i11 + 3] * w11) / 255;
    return out;
  }
  /** One fragment pass, mirroring the WGSL uniforms: dimensions = input dims,
   * origin/outputSize in output pixels, uv bottom-up. */
  pass(operation, input, output, { original = null, mask = null, dimensions = null, origin = null, outputSize = null, p = [0, 0, 0, 0], q = [0, 0, 0, 0], paintType = 0, paintAngle = 0, paintStops = null, paintOffsets = null, stopCount = 1 }) {
    const W = output.width, H = output.height, out = output.pixels;
    const dim = dimensions ?? { x: input.width, y: input.height };
    const og = origin ?? { x: 0, y: 0 }, os = outputSize ?? { width: dim.x, height: dim.y };
    const src = input.pixels, SW = input.width, SH = input.height;
    const orig = original ?? input, maskBuf = mask ?? orig;
    const tmp = [0, 0, 0, 0], tmp2 = [0, 0, 0, 0], tmp3 = [0, 0, 0, 0], tmp4 = [0, 0, 0, 0];
    const sampleAt = (ax, ay, o) => this.sample(input, ax, 1 - ay, o);
    const sampleGlobal = (gx, gy, o) => this.sample(input, (gx - og.x) / dim.x, (gy - og.y) / dim.y, o);
    const texelOriginal = (u, v, o) => this.texel(orig, u, 1 - v, o);
    const texelMask = (u, v, o) => this.texel(maskBuf, u, 1 - v, o);
    const globalPixel = (uvx, uvy) => ({ x: uvx * dim.x + og.x, y: (1 - uvy) * dim.y + og.y });
    const brushAt = (uvx, uvy, o) => {
      const s = paintStops;
      if (paintType === 0) { o[0] = s[0]; o[1] = s[1]; o[2] = s[2]; o[3] = s[3]; return o; }
      const g = globalPixel(uvx, uvy);
      let px = g.x / os.width - 0.5, py = g.y / os.height - 0.5;
      const cs = Math.cos(paintAngle), sn = Math.sin(paintAngle);
      const rx = cs * px - sn * py, ry = sn * px + cs * py; px = rx; py = ry;
      let t = px + 0.5;
      if (paintType === 2) t = Math.hypot(px, py) * 2;
      else if (paintType === 3) t = fract(Math.atan2(py, px) / (2 * Math.PI) + 1);
      else if (paintType === 4) t = (Math.abs(px) + Math.abs(py)) * 2;
      const offs = paintOffsets;
      let ar = s[0], ag = s[1], ab = s[2], aa = s[3], offset = offs[0];
      for (let i = 1; i < 32; i++) {
        if (i >= stopCount) break;
        const next = offs[i];
        if (t < next) { const u = clamp01((t - offset) / Math.max(0.00001, next - offset)); o[0] = ar + (s[i * 4] - ar) * u; o[1] = ag + (s[i * 4 + 1] - ag) * u; o[2] = ab + (s[i * 4 + 2] - ab) * u; o[3] = aa + (s[i * 4 + 3] - aa) * u; return o; }
        ar = s[i * 4]; ag = s[i * 4 + 1]; ab = s[i * 4 + 2]; aa = s[i * 4 + 3]; offset = next;
      }
      o[0] = ar; o[1] = ag; o[2] = ab; o[3] = aa; return o;
    };
    // Ops 3-6: separable box blur (3/4) and alpha dilation (5/6). The window
    // runs over exact texel centres; prefix sums / a monotonic deque keep it
    // linear-time with the shader's tap set: out-of-range taps contribute zero.
    if (operation >= 3 && operation <= 6) {
      const horizontal = operation === 3 || operation === 5;
      const maxAlpha = operation === 5 || operation === 6;
      const radius = clamp(Math.trunc(p[0]), 0, 128), count = radius * 2 + 1;
      const lines = horizontal ? H : W, span = horizontal ? W : H;
      const row = this._line ??= { sum: new Float64Array(0), alpha: new Uint8Array(0) };
      if (row.sum.length < (span + 1) * 4) { row.sum = new Float64Array((span + 1) * 4); row.alpha = new Uint8Array(span + 1); }
      let deq = this._deque ??= new Int32Array(span);
      if (deq.length < span) deq = this._deque = new Int32Array(span);
      for (let line = 0; line < lines; line++) {
        row.sum[0] = row.sum[1] = row.sum[2] = row.sum[3] = 0;
        for (let i = 0; i < span; i++) {
          const j = horizontal ? (line * W + i) * 4 : (i * W + line) * 4, o = (i + 1) * 4;
          row.sum[o] = row.sum[o - 4] + src[j]; row.sum[o + 1] = row.sum[o - 3] + src[j + 1]; row.sum[o + 2] = row.sum[o - 2] + src[j + 2]; row.sum[o + 3] = row.sum[o - 1] + src[j + 3];
          row.alpha[i + 1] = src[j + 3];
        }
        let head = 0, tail = 0, added = 0;
        for (let i = 0; i < span; i++) {
          const lo = Math.max(0, i - radius), hi = Math.min(span - 1, i + radius);
          const o = horizontal ? (line * W + i) * 4 : (i * W + line) * 4;
          if (maxAlpha) {
            for (; added <= hi; added++) {
              while (tail > head && row.alpha[added + 1] >= row.alpha[deq[tail - 1] + 1]) tail--;
              deq[tail++] = added;
            }
            while (head < tail && deq[head] < lo) head++;
            const a = tail > head ? row.alpha[deq[head] + 1] : 0;
            out[o] = a; out[o + 1] = a; out[o + 2] = a; out[o + 3] = a;
          } else {
            const a4 = lo * 4, b4 = (hi + 1) * 4;
            out[o] = (row.sum[b4] - row.sum[a4]) / count;
            out[o + 1] = (row.sum[b4 + 1] - row.sum[a4 + 1]) / count;
            out[o + 2] = (row.sum[b4 + 2] - row.sum[a4 + 2]) / count;
            out[o + 3] = (row.sum[b4 + 3] - row.sum[a4 + 3]) / count;
          }
        }
      }
      this.stats.passes++;
      return;
    }
    for (let y = 0; y < H; y++) {
      const uvy = 1 - (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const uvx = (x + 0.5) / W, o = (y * W + x) * 4;
        const c = sampleAt(uvx, uvy, tmp);
        const ca = c[3], cr = ca > 0.000001 ? c[0] / ca : 0, cg = ca > 0.000001 ? c[1] / ca : 0, cb = ca > 0.000001 ? c[2] / ca : 0;
        let r = c[0], g = c[1], b = c[2], a = ca;
        if (operation === 0) { /* identity: pixel = c */ }
        else if (operation === 1) {
          const bb = brushAt(uvx, uvy, tmp2), k = p[0] * bb[3];
          r = (cr + (bb[0] - cr) * k) * ca; g = (cg + (bb[1] - cg) * k) * ca; b = (cb + (bb[2] - cb) * k) * ca; a = ca;
        } else if (operation === 2) {
          let rr = cr * Math.pow(2, p[0]), gg = cg * Math.pow(2, p[0]), bb2 = cb * Math.pow(2, p[0]);
          rr = (rr - 0.5) * p[1] + 0.5; gg = (gg - 0.5) * p[1] + 0.5; bb2 = (bb2 - 0.5) * p[1] + 0.5;
          const l = rr * 0.2126 + gg * 0.7152 + bb2 * 0.0722;
          rr += (l - rr) * (1 - p[2]); gg += (l - gg) * (1 - p[2]); bb2 += (l - bb2) * (1 - p[2]);
          rr += p[3] * 0.12; gg += q[0] * 0.12; bb2 -= p[3] * 0.12;
          const lc = clamp01(l), sh = q[1] * Math.pow(1 - lc, 2) * 0.4, hi = q[2] * Math.pow(lc, 2) * 0.4;
          rr += sh + hi; gg += sh + hi; bb2 += sh + hi;
          const inv = 1 / q[3];
          r = clamp01(Math.pow(Math.max(0, rr), inv)) * ca; g = clamp01(Math.pow(Math.max(0, gg), inv)) * ca; b = clamp01(Math.pow(Math.max(0, bb2), inv)) * ca; a = ca;
        } else if (operation === 7) {
          const front = texelOriginal(uvx, uvy, tmp2), bb = brushAt(uvx, uvy, tmp3);
          const sa = sampleAt(uvx - q[0] / dim.x, uvy + q[1] / dim.y, tmp4);
          const aa = clamp01(Math.pow(sa[3], p[1]) * p[0] * bb[3]);
          if (p[2] > 0) {
            let fr = front[0] + (bb[0] * front[3] - front[0]) * aa, fg = front[1] + (bb[1] * front[3] - front[1]) * aa, fb = front[2] + (bb[2] * front[3] - front[2]) * aa;
            if (p[3] === 1) { fr = Math.min(front[0] + bb[0] * front[3] * aa, front[3]); fg = Math.min(front[1] + bb[1] * front[3] * aa, front[3]); fb = Math.min(front[2] + bb[2] * front[3] * aa, front[3]); }
            if (p[3] === 2) { fr = front[0] + bb[0] * aa * (front[3] - front[0]); fg = front[1] + bb[1] * aa * (front[3] - front[1]); fb = front[2] + bb[2] * aa * (front[3] - front[2]); }
            r = fr; g = fg; b = fb; a = front[3];
          } else {
            const ur = bb[0] * aa, ug = bb[1] * aa, ub = bb[2] * aa, ua = aa;
            r = front[0] + ur * (1 - front[3]); g = front[1] + ug * (1 - front[3]); b = front[2] + ub * (1 - front[3]); a = front[3] + ua * (1 - front[3]);
            if (p[3] === 1) { r = Math.min(front[0] + ur, Math.max(front[3], ua)); g = Math.min(front[1] + ug, Math.max(front[3], ua)); b = Math.min(front[2] + ub, Math.max(front[3], ua)); a = Math.max(front[3], ua); }
            if (p[3] === 2) { r = front[0] + ur - front[0] * ur; g = front[1] + ug - front[1] * ug; b = front[2] + ub - front[2] * ub; a = Math.max(front[3], ua); }
          }
        } else if (operation === 8) {
          const g2 = globalPixel(uvx, uvy);
          const sx = clamp((Math.floor((g2.x - q[0]) / p[0]) + 0.5) * p[0] + q[0], 0.5, os.width - 0.5);
          const sy = clamp((Math.floor((g2.y - q[1]) / p[1]) + 0.5) * p[1] + q[1], 0.5, os.height - 0.5);
          const s = sampleGlobal(sx, sy, tmp2); r = s[0]; g = s[1]; b = s[2]; a = s[3];
        } else if (operation === 9) {
          const g2 = globalPixel(uvx, uvy), gx = g2.x / p[1], gy = g2.y / p[1];
          const seed = p[2] + p[3], sm = Math.max(q[2], q[3]), n = noiseAt(gx, gy, seed, sm) - 0.5;
          let gr = n, gg = n, gb = n;
          if (q[0] > 0) { gg = noiseAt(gx, gy, seed + 131, sm) - 0.5; gb = noiseAt(gx, gy, seed + 719, sm) - 0.5; }
          r = clamp01(cr + gr * p[0] * q[1]) * ca; g = clamp01(cg + gg * p[0] * q[1]) * ca; b = clamp01(cb + gb * p[0] * q[1]) * ca; a = ca;
        } else if (operation === 10) {
          const g2 = globalPixel(uvx, uvy);
          let xx = (g2.x / os.width - q[0]) * 2, yy = (g2.y / os.height - q[1]) * 2; xx /= q[2];
          const distance = mix(Math.max(Math.abs(xx), Math.abs(yy)), Math.hypot(xx, yy) / 1.41421356237, q[3]) / p[2];
          const dark = smoothstep(1 - p[1], 1, distance) * p[0], bb = brushAt(uvx, uvy, tmp2);
          r = c[0] + (bb[0] * ca - c[0]) * dark * bb[3]; g = c[1] + (bb[1] * ca - c[1]) * dark * bb[3]; b = c[2] + (bb[2] * ca - c[2]) * dark * bb[3]; a = ca;
        } else if (operation === 11) {
          const xx = ((x + 0.5) * p[0] - p[1]) / dim.x, yy = ((y + 0.5) * p[0] - p[2]) / dim.y;
          const s = this.sample(input, xx, yy, tmp2); r = s[0]; g = s[1]; b = s[2]; a = s[3];
        } else if (operation === 12) {
          const xx = ((x + 0.5) + p[1]) / p[0] / dim.x, yy = ((y + 0.5) + p[2]) / p[0] / dim.y;
          const s = this.sample(input, xx, yy, tmp2); r = s[0]; g = s[1]; b = s[2]; a = s[3];
        } else if (operation === 13) {
          r = 1 - ca; g = r; b = r; a = r;
        } else if (operation === 14) {
          let aa = ca;
          for (let i = 0; i < 16; i++) {
            const angle = i * Math.PI / 8, cs = Math.cos(angle), sn = Math.sin(angle);
            const s = sampleAt(uvx + cs * p[0] / dim.x, uvy + sn * p[0] / dim.y, tmp2);
            if (s[3] > aa) aa = s[3];
          }
          r = aa; g = aa; b = aa; a = aa;
        } else if (operation === 15) {
          const front = texelOriginal(uvx, uvy, tmp2), bb = brushAt(uvx, uvy, tmp3);
          let aa = p[1] > 0 ? ca * front[3] : Math.max(0, ca - front[3]); aa *= p[0] * bb[3];
          if (p[2] > 0) { r = bb[0] * aa; g = bb[1] * aa; b = bb[2] * aa; a = aa; }
          else if (p[1] > 0) { const k = clamp01(ca * p[0] * bb[3]); r = front[0] + (bb[0] * front[3] - front[0]) * k; g = front[1] + (bb[1] * front[3] - front[1]) * k; b = front[2] + (bb[2] * front[3] - front[2]) * k; a = front[3]; }
          else { r = front[0] + bb[0] * aa * (1 - front[3]); g = front[1] + bb[1] * aa * (1 - front[3]); b = front[2] + bb[2] * aa * (1 - front[3]); a = front[3] + aa * (1 - front[3]); }
        } else if (operation === 16) {
          const g2 = globalPixel(uvx, uvy);
          const dx = g2.x - q[0] * os.width, dy = g2.y - q[1] * os.height;
          let dirx, diry;
          if (p[1] === 1) { dirx = Math.cos(p[2]); diry = Math.sin(p[2]); }
          else { const len = Math.hypot(dx + 0.00001, dy + 0.00001) || 1; dirx = (dx + 0.00001) / len; diry = (dy + 0.00001) / len; }
          if (p[1] === 3) { const t = dirx; dirx = -diry; diry = t; }
          let sr = 0, sg = 0, sb = 0, sa = 0;
          for (let i = 0; i < 33; i++) {
            const t = i / 32 - 0.5, s = sampleGlobal(g2.x + dirx * p[0] * t * 2, g2.y + diry * p[0] * t * 2, tmp2);
            sr += s[0]; sg += s[1]; sb += s[2]; sa += s[3];
          }
          r = sr / 33; g = sg / 33; b = sb / 33; a = sa / 33;
        } else if (operation === 17) {
          const g2 = globalPixel(uvx, uvy);
          const n = noiseAt(g2.x / p[1], g2.y / p[1], p[3], 1);
          const keep = p[0] <= 0 ? 1 : p[0] >= 1 ? 0 : smoothstep(p[0] - p[2], p[0] + p[2], n);
          const edge = (1 - smoothstep(p[0], p[0] + q[0] + p[2], n)) * keep, bb = brushAt(uvx, uvy, tmp2);
          r = (c[0] + (bb[0] * ca - c[0]) * edge * bb[3]) * keep; g = (c[1] + (bb[1] * ca - c[1]) * edge * bb[3]) * keep; b = (c[2] + (bb[2] * ca - c[2]) * edge * bb[3]) * keep; a = ca * keep;
        } else if (operation === 18) {
          const dx = Math.cos(p[1]) * p[0], dy = Math.sin(p[1]) * p[0], g2 = globalPixel(uvx, uvy);
          const red = sampleGlobal(g2.x + dx * q[0], g2.y + dy * q[0], tmp2), green = sampleGlobal(g2.x + dx * q[1], g2.y + dy * q[1], tmp3), blue = sampleGlobal(g2.x + dx * q[2], g2.y + dy * q[2], tmp4);
          r = red[0]; g = green[1]; b = blue[2]; a = Math.max(red[3], Math.max(green[3], blue[3]));
        } else if (operation === 19) {
          const ax = Math.cos(p[2]), ay = Math.sin(p[2]), g2 = globalPixel(uvx, uvy);
          const wave = Math.sin((g2.x * ax + g2.y * ay) * 2 * Math.PI / p[1] + p[3]);
          const s = sampleGlobal(g2.x + (-ay) * wave * p[0], g2.y + ax * wave * p[0], tmp2);
          r = s[0]; g = s[1]; b = s[2]; a = s[3];
        } else if (operation === 20) {
          const g2 = globalPixel(uvx, uvy);
          const dx = g2.x - q[0] * os.width, dy = g2.y - q[1] * os.height;
          const distance = Math.hypot(dx, dy), ring = (distance - p[0]) / p[1];
          const strength = Math.sin(ring * Math.PI) * Math.pow(Math.max(0, 1 - Math.abs(ring)), p[3]) * p[2];
          const k = strength / Math.max(0.0001, distance);
          const s = sampleGlobal(g2.x + dx * k, g2.y + dy * k, tmp2);
          r = s[0]; g = s[1]; b = s[2]; a = s[3];
        } else if (operation === 21) {
          const l = Math.max(cr, Math.max(cg, cb)), m = smoothstep(p[0] - p[1], p[0] + p[1], l);
          r = c[0] * m; g = c[1] * m; b = c[2] * m; a = ca * m;
        } else if (operation === 22) {
          const front = texelOriginal(uvx, uvy, tmp2), bb = brushAt(uvx, uvy, tmp3);
          const cap = Math.max(front[3], ca);
          r = Math.min(front[0] + c[0] * bb[0] * bb[3] * p[0], cap); g = Math.min(front[1] + c[1] * bb[1] * bb[3] * p[0], cap); b = Math.min(front[2] + c[2] * bb[2] * bb[3] * p[0], cap); a = cap;
        } else if (operation === 23) {
          const g2 = globalPixel(uvx, uvy);
          const xx = g2.x / os.width - 0.5, yy = g2.y / os.height - 0.5;
          const position = (xx * Math.cos(p[1]) + yy * Math.sin(p[1])) + 0.5, distance = Math.abs(position - p[0]) * 2 / p[2];
          const light = 1 - smoothstep(1 - p[3], 1, distance), bb = brushAt(uvx, uvy, tmp2);
          r = clamp(c[0] + bb[0] * bb[3] * light * q[0] * ca, 0, ca); g = clamp(c[1] + bb[1] * bb[3] * light * q[0] * ca, 0, ca); b = clamp(c[2] + bb[2] * bb[3] * light * q[0] * ca, 0, ca); a = ca;
        } else if (operation === 24) {
          const g2 = globalPixel(uvx, uvy);
          const pxx = g2.x / os.width * 2 - 1, pyy = g2.y / os.height * 2 - 1;
          const warp = 1 + p[2] * (pxx * pxx + pyy * pyy);
          const wx = (pxx * warp * 0.5 + 0.5) * os.width, wy = (pyy * warp * 0.5 + 0.5) * os.height;
          let sr, sg, sb, sa;
          if (wx < 0 || wy < 0 || wx >= os.width || wy >= os.height) { sr = sg = sb = sa = 0; }
          else { const s = sampleGlobal(wx, wy, tmp2); sr = s[0]; sg = s[1]; sb = s[2]; sa = s[3]; }
          if (p[3] > 0) {
            sr = sampleGlobal(wx + p[3], wy, tmp3)[0]; sb = sampleGlobal(wx - p[3], wy, tmp4)[2];
            sr = Math.min(sr, sa); sg = Math.min(sg, sa); sb = Math.min(sb, sa);
          }
          const line = (0.5 + 0.5 * Math.cos((g2.y + q[0]) * 2 * Math.PI / p[1])) * p[0], bb = brushAt(uvx, uvy, tmp3);
          r = sr + (bb[0] * sa - sr) * line * bb[3]; g = sg + (bb[1] * sa - sg) * line * bb[3]; b = sb + (bb[2] * sa - sb) * line * bb[3]; a = sa;
        } else if (operation === 25) {
          const front = texelOriginal(uvx, uvy, tmp2), inner = texelMask(uvx, uvy, tmp3), bb = brushAt(uvx, uvy, tmp4);
          const outer = Math.max(0, ca - front[3]) * p[0] * bb[3];
          const rr = inner[0] + bb[0] * outer * (1 - inner[3]), rg = inner[1] + bb[1] * outer * (1 - inner[3]), rb = inner[2] + bb[2] * outer * (1 - inner[3]), ra = inner[3] + outer * (1 - inner[3]);
          if (p[1] > 0) { r = rr; g = rg; b = rb; a = ra; }
          else { r = rr + front[0] * (1 - ra); g = rg + front[1] * (1 - ra); b = rb + front[2] * (1 - ra); a = ra + front[3] * (1 - ra); }
        } else if (operation === 26) {
          const front = texelOriginal(uvx, uvy, tmp2);
          r = front[0] + (c[0] - front[0]) * p[0]; g = front[1] + (c[1] - front[1]) * p[0]; b = front[2] + (c[2] - front[2]) * p[0]; a = front[3] + (ca - front[3]) * p[0];
        } else if (operation === 27) {
          const g2 = globalPixel(uvx, uvy);
          let xx = g2.x / p[1] + p[2] * 0.73, yy = g2.y / p[1] + p[2] * 1.17;
          let ox = 0, oy = 0, weight = 1, total = 0;
          for (let i = 0; i < 4; i++) {
            if (i >= q[0]) break;
            ox += noiseAt(xx, yy, p[3] + i * 37, 1) * weight;
            oy += noiseAt(xx + 19.1, yy + 7.7, p[3] + 131 + i * 37, 1) * weight;
            total += weight; weight *= 0.5; xx *= 2; yy *= 2;
          }
          const s = sampleGlobal(g2.x + (ox / total * 2 - 1) * p[0], g2.y + (oy / total * 2 - 1) * p[0], tmp2);
          r = s[0]; g = s[1]; b = s[2]; a = s[3];
        }
        out[o] = r * 255; out[o + 1] = g * 255; out[o + 2] = b * 255; out[o + 3] = a * 255;
      }
    }
    this.stats.passes++;
  }
  /** Straight-alpha -> premultiplied, matching the GPU's premult upload. */
  premultiply(pixels) {
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3];
      if (a < 255) { pixels[i] = Math.round(pixels[i] * a / 255); pixels[i + 1] = Math.round(pixels[i + 1] * a / 255); pixels[i + 2] = Math.round(pixels[i + 2] * a / 255); }
    }
    return pixels;
  }
  /** Mirror of VfxGPU.run: same pass schedule, same slot roles, same math.
   * `source` is a {width,height} canvas or {pixels} buffer (premultiplied);
   * returns the final premultiplied {pixels,width,height} surface. */
  runPixels(pixels, w, h, stack, { scale = 1, origin = { x: 0, y: 0 }, outputSize, ownedPixels = false } = {}) {
    stack = activeVfx(stack); if (!stack.length) return { pixels, width: w, height: h };
    this.releaseInput();
    const input = ownedPixels ? (this.slots[0] = { width: w, height: h, pixels, borrowed: true }) : this.slot(0, w, h);
    if (!ownedPixels) input.pixels.set(pixels);
    this.stats.passes = 0;
    let current = input;
    let brushType = 0, brushAngle = 0, brushStops = 1;
    const paintColors = this.paintColors ??= new Float32Array(128), paintOffsets = this.paintOffsets ??= new Float32Array(32);
    const freeSlot = (a, b, c) => [1, 2, 3, 6].find(i => this.slots[i] !== a && this.slots[i] !== b && this.slots[i] !== c) ?? 6;
    const pass = (operation, p = [0, 0, 0, 0], q = [0, 0, 0, 0], original = current, width = w, height = h, screen = false, mask = null) => {
      const next = screen ? null : this.slot(freeSlot(current, original, mask), width, height);
      this.pass(operation, current, next ?? this.screen(width, height), {
        original, mask, dimensions: { x: current.width, y: current.height }, origin, outputSize,
        p, q, paintType: brushType, paintAngle: brushAngle, paintStops: paintColors, paintOffsets, stopCount: brushStops,
      });
      if (next) current = next;
    };
    const blur = radius => {
      if (radius <= 0) return;
      const factor = Math.max(1, Math.ceil(radius / 20)), ox = factor > 1 ? ((origin.x % factor) + factor) % factor : 0, oy = factor > 1 ? ((origin.y % factor) + factor) % factor : 0;
      const bw = Math.max(1, Math.ceil((w + ox) / factor)), bh = Math.max(1, Math.ceil((h + oy) / factor));
      if (factor > 1) pass(11, [factor, ox, oy, bh], undefined, current, bw, bh);
      const r = Math.min(128, Math.max(1, Math.round(radius / factor * 0.57735)));
      for (let i = 0; i < 3; i++) { pass(3, [r, 0, 0, 0], undefined, current, bw, bh); pass(4, [r, 0, 0, 0], undefined, current, bw, bh); }
      if (factor > 1) pass(12, [factor, ox, oy, h]);
    };
    const paint = value => {
      const brush = vfxPaint(value);
      brushType = ['solid', 'linear', 'radial', 'angular', 'diamond'].indexOf(brush.type);
      brushAngle = brush.angle * Math.PI / 180; brushStops = brush.stops.length;
      brush.stops.forEach((s, i) => { paintColors.set([...s.color.map(n => n / 255), s.opacity], i * 4); paintOffsets[i] = s.offset; });
    };
    const save = (index = 4) => { const saved = this.slot(index, w, h); saved.pixels.set(current.pixels); return saved; };
    const morph = (radius, rounded = false) => {
      radius = Math.ceil(radius); let step = 1;
      while (radius > 0) {
        const amount = Math.min(rounded ? step : 128, radius);
        if (rounded) pass(14, [amount, 0, 0, 0]); else { pass(5, [amount, 0, 0, 0]); pass(6, [amount, 0, 0, 0]); }
        radius -= amount; step *= 2;
      }
    };
    for (const { type, params: p } of stack) {
      const strengthSource = p.effectStrength < 1 ? save(7) : null;
      if (p.color !== undefined) paint(p.color);
      if (type === 'tint') pass(1, [p.mix, 0, 0, 0]);
      else if (type === 'grade') pass(2, [p.exposure, p.contrast, p.saturation, p.temperature], [p.tint, p.shadows, p.highlights, p.gamma]);
      else if (type === 'blur') { if (!p.mode) blur(p.radius * scale); else pass(16, [p.radius * scale, p.mode, p.angle * Math.PI / 180, 0], [p.centerX, p.centerY, 0, 0]); }
      else if (type === 'glow' || type === 'shadow') {
        if (type === 'glow' && p.coreMix) { paint(p.coreColor); pass(1, [p.coreMix, 0, 0, 0]); paint(p.color); }
        for (const inner of p.mode === 2 ? [true, false] : [p.mode === 1]) {
          const saved = save(); if (inner) pass(13);
          morph(p.spread * scale, true); blur(p.radius * scale);
          pass(7, [p.intensity ?? p.opacity, p.falloff ?? 1, Number(inner), p.blend ?? 0], [(p.offsetX ?? 0) * scale, (p.offsetY ?? 0) * scale, 0, 0], saved);
        }
      } else if (type === 'outline') {
        const saved = save(), width = p.width * scale * (p.mode === 2 ? 0.5 : 1);
        if (p.mode === 2) {
          pass(13); morph(width, p.rounded); pass(15, [p.opacity, 1, 1, 0], undefined, saved);
          const inner = save(5); current = saved; morph(width, p.rounded);
          pass(25, [p.opacity, p.only, 0, 0], undefined, saved, w, h, false, inner);
        } else { if (p.mode === 1) pass(13); morph(width, p.rounded); pass(15, [p.opacity, Number(p.mode === 1), p.only, 0], undefined, saved); }
      } else if (type === 'pixelate') pass(8, [Math.max(1, p.size * scale), Math.max(1, (p.linked ? p.size : p.sizeY) * scale), 0, 0], [p.offsetX * scale, p.offsetY * scale, 0, 0]);
      else if (type === 'noise') pass(9, [p.amount, Math.max(1, p.size * scale), p.seed, Math.floor(p.phase * 1024)], [p.colored, p.contrast, p.softness, p.pattern]);
      else if (type === 'vignette') pass(10, [p.amount, p.softness, p.radius, 0], [p.centerX, p.centerY, p.aspect, p.roundness]);
      else if (type === 'dissolve') pass(17, [p.progress, p.size * scale, p.softness, p.seed], [p.edge, 0, 0, 0]);
      else if (type === 'rgbSplit') pass(18, [p.amount * scale, p.angle * Math.PI / 180, 0, 0], [p.red, p.green, p.blue, 0]);
      else if (type === 'turbulence') pass(27, [p.amount * scale, p.size * scale, p.evolution, p.seed], [p.detail, 0, 0, 0]);
      else if (type === 'wave') pass(19, [p.strength * scale, p.wavelength * scale, p.angle * Math.PI / 180, p.phase * Math.PI / 180]);
      else if (type === 'shockwave') pass(20, [p.radius * scale, p.thickness * scale, p.strength * scale, p.falloff], [p.centerX, p.centerY, 0, 0]);
      else if (type === 'bloom') { const saved = save(); pass(21, [p.threshold, p.softness, 0, 0]); blur(p.radius * scale); pass(22, [p.intensity, 0, 0, 0], undefined, saved); }
      else if (type === 'lightSweep') pass(23, [p.position, p.angle * Math.PI / 180, p.width, p.softness], [p.intensity, 0, 0, 0]);
      else if (type === 'crt') pass(24, [p.amount, p.spacing * scale, p.curvature, p.chromatic * scale], [p.phase * scale, 0, 0, 0]);
      if (strengthSource) pass(26, [p.effectStrength, 0, 0, 0], undefined, strengthSource);
    }
    this.stats.calls++;
    this.stats.bytes = w * h * 4 + this.slots.reduce((n, s) => n + (s?.pixels?.length ?? 0), 0);
    return { pixels: current.pixels, width: w, height: h };
  }
  /** Canvas wrapper around runPixels: canvas sources are straight-alpha via
   * getImageData, so the input premultiplies and the output un-premultiplies. */
  run(source, stack, options = {}) {
    stack = activeVfx(stack); if (!stack.length) return source;
    const w = source.width, h = source.height;
    // A private worker readback replaces its previous borrowed input. End that
    // reference before acquiring another plane, including repeated native tiles.
    if (options.ownedPixels) this.releaseInput();
    let pixels;
    if (source.pixels) pixels = new Uint8ClampedArray(source.pixels);
    else pixels = this.premultiply(source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data);
    const result = this.runPixels(pixels, w, h, stack, options);
    const canvas = this.canvas ??= new OffscreenCanvas(w, h);
    if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
    const straight = options.ownedPixels ? result.pixels : new Uint8ClampedArray(result.pixels.length);
    for (let i = 0; i < result.pixels.length; i += 4) {
      const a = result.pixels[i + 3];
      straight[i + 3] = a;
      if (a) { straight[i] = Math.min(255, Math.round(result.pixels[i] * 255 / a)); straight[i + 1] = Math.min(255, Math.round(result.pixels[i + 1] * 255 / a)); straight[i + 2] = Math.min(255, Math.round(result.pixels[i + 2] * 255 / a)); }
      else if (options.ownedPixels) straight[i] = straight[i + 1] = straight[i + 2] = 0;
    }
    canvas.getContext('2d').putImageData(new ImageData(straight, w, h), 0, 0);
    return canvas;
  }
  releaseInput() { if (this.slots[0]?.borrowed) this.slots[0] = undefined; }
  destroy() { this.slots = []; this._screen = null; this._line = null; this._deque = null; if (this.canvas) this.canvas.width = this.canvas.height = 1; this.canvas = null; }
}

let executor;
/** Guaranteed filter path: software executor, always available. Accepts a
 * canvas or a {pixels,width,height} surface; returns a canvas, like
 * filterVfxCanvas. */
export function filterVfxCPU(source, stack, options) {
  executor ??= new VfxCPU();
  return executor.run(source, stack, options);
}
export function releaseVfxCPU() { executor?.destroy(); executor = null; }
export function releaseVfxCPUInput() { executor?.releaseInput(); }
