import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx} from '../src/vfx.mjs';

/** Build a normalized stack entry like the document carries: defaults plus overrides. */
const fx = (type, id, params = {}) => { const e = createVfx(type, id); return {...e, params: {...e.params, ...params}}; };
const cpu = () => new VfxCPU();
const run = (pixels, w, h, stack, options) => cpu().runPixels(pixels, w, h, stack, options);
const buffer = (w, h, fill) => { const p = new Uint8ClampedArray(w * h * 4); if (fill) p.set(typeof fill === 'function' ? Array.from({length: w * h * 4}, (_, i) => fill(i)) : fill); return p; };
const px = (p, w, x, y) => [p[(y * w + x) * 4], p[(y * w + x) * 4 + 1], p[(y * w + x) * 4 + 2], p[(y * w + x) * 4 + 3]];

test('an empty or neutral stack returns the untouched premultiplied buffer', () => {
  const pixels = buffer(4, 4, i => (i * 37) % 256);
  const out = run(pixels, 4, 4, []);
  assert.deepEqual([...out.pixels], [...pixels]);
  const neutral = run(pixels, 4, 4, [fx('blur', 'a', {radius: 0}), fx('tint', 'b', {mix: 0})]);
  assert.deepEqual([...neutral.pixels], [...pixels]);
});

test('tint applies in straight alpha and stays premultiplied', () => {
  // One half-alpha pixel [64,32,16,128] (premultiplied ~[0.5,0.25,0.06]).
  const pixels = buffer(2, 2); pixels.set([64, 32, 16, 128], 0);
  const out = run(pixels, 2, 2, [fx('tint', 'a', {mix: 1, color: 0xff0000})]);
  assert.deepEqual(px(out.pixels, 2, 0, 0).map(Math.round), [128, 0, 0, 128]);
});

test('blur keeps interior uniform, darkens borders like the shader, and spreads impulses', () => {
  const flat = buffer(16, 16, () => 40);
  const blurred = run(flat, 16, 16, [fx('blur', 'a', {radius: 6})]);
  assert.ok(px(blurred.pixels, 16, 8, 8)[3] >= 36, 'interior stays nearly uniform');
  assert.ok(px(blurred.pixels, 16, 0, 0)[3] < 30, 'out-of-range taps count as transparent at the border, matching the shader');
  const impulse = buffer(16, 16); impulse.set([255, 255, 255, 255], (8 * 16 + 8) * 4);
  const spread = run(impulse, 16, 16, [fx('blur', 'a', {radius: 6})]);
  assert.ok(px(spread.pixels, 16, 8, 8)[3] < 255 && px(spread.pixels, 16, 8, 8)[3] > 0);
  assert.ok(px(spread.pixels, 16, 4, 8)[3] > 0, 'horizontal taps reached');
  assert.ok(px(spread.pixels, 16, 8, 4)[3] > 0, 'vertical taps reached');
});

test('box blur and alpha dilation match a brute-force window over the same tap set', () => {
  // Deterministic pseudo-random premultiplied buffer.
  const w = 24, h = 18, raw = buffer(w, h, i => (Math.imul(i, 2654435761) >>> 24) % 256);
  for (let i = 0; i < raw.length; i += 4) { const a = raw[i + 3]; raw[i] = Math.min(raw[i], a); raw[i + 1] = Math.min(raw[i + 1], a); raw[i + 2] = Math.min(raw[i + 2], a); }
  const radius = 5, count = radius * 2 + 1;
  // Reference: naive shader taps — sampleAt returns vec4(0) out of bounds.
  const naive = (op) => {
    const out = new Uint8ClampedArray(w * h * 4), horizontal = op === 3 || op === 5, maxAlpha = op === 5 || op === 6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (maxAlpha) {
        let a = 0;
        for (let i = -radius; i <= radius; i++) {
          const sx = horizontal ? x + i : x, sy = horizontal ? y : y + i;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          a = Math.max(a, raw[(sy * w + sx) * 4 + 3]);
        }
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = a;
      } else {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let i = -radius; i <= radius; i++) {
          const sx = horizontal ? x + i : x, sy = horizontal ? y : y + i;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const j = (sy * w + sx) * 4; sr += raw[j]; sg += raw[j + 1]; sb += raw[j + 2]; sa += raw[j + 3];
        }
        out[o] = sr / count; out[o + 1] = sg / count; out[o + 2] = sb / count; out[o + 3] = sa / count;
      }
    }
    return out;
  };
  const executor = cpu(), input = {pixels: raw, width: w, height: h};
  for (const op of [3, 4, 5, 6]) {
    const output = {pixels: new Uint8ClampedArray(w * h * 4), width: w, height: h};
    executor.pass(op, input, output, {p: [radius, 0, 0, 0]});
    assert.deepEqual([...output.pixels], [...naive(op)], `operation ${op} diverged from the shader tap set`);
  }
});

test('outline dilates alpha by its width and keeps the painted core', () => {
  const pixels = buffer(24, 24); for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) pixels.set([200, 200, 200, 255], (y * 24 + x) * 4);
  const out = run(pixels, 24, 24, [fx('outline', 'a', {width: 4, opacity: 1, mode: 0, rounded: 0, color: 0x0000ff})]);
  assert.ok(px(out.pixels, 24, 8, 6)[3] > 0, 'alpha reached above the square');
  assert.ok(px(out.pixels, 24, 8, 7)[3] > 0);
  assert.equal(px(out.pixels, 24, 8, 2)[3], 0, 'dilation stays inside its radius');
  assert.deepEqual(px(out.pixels, 24, 10, 10).map(Math.round), [200, 200, 200, 255], 'core preserved');
});

test('rgbSplit offsets channels in premultiplied space without shifting alpha', () => {
  const pixels = buffer(32, 8); for (let x = 8; x < 24; x++) pixels.set([100, 150, 200, 255], (4 * 32 + x) * 4);
  const out = run(pixels, 32, 8, [fx('rgbSplit', 'a', {amount: 6, angle: 0, red: 1, green: 0, blue: -1})], {outputSize: {width: 32, height: 8}});
  // Angle 0 → dir=(1,0): red output at x samples x+6 (bar's red reaches left to x=2), blue samples x-6 (reaches right to x=29).
  assert.equal(px(out.pixels, 32, 2, 4)[0], 100, 'red copy extends six pixels left of the bar');
  assert.equal(px(out.pixels, 32, 2, 4)[2], 0, 'blue copy has not started there');
  assert.equal(px(out.pixels, 32, 26, 4)[2], 200, 'blue copy extends six pixels right of the bar');
  assert.equal(px(out.pixels, 32, 26, 4)[0], 0, 'red copy has ended there');
  assert.deepEqual(px(out.pixels, 32, 16, 4), [100, 150, 200, 255], 'center pixel unaffected');
});

test('noise and dissolve are deterministic by seed', () => {
  const pixels = buffer(16, 16, i => (i * 13) % 200 + 20);
  for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = 255;
  const a = run(new Uint8ClampedArray(pixels), 16, 16, [fx('noise', 'a', {amount: .5, size: 4, seed: 7, phase: 0, colored: 0, contrast: 1, softness: 1, pattern: 0})], {outputSize: {width: 16, height: 16}});
  const b = run(new Uint8ClampedArray(pixels), 16, 16, [fx('noise', 'a', {amount: .5, size: 4, seed: 7, phase: 0, colored: 0, contrast: 1, softness: 1, pattern: 0})], {outputSize: {width: 16, height: 16}});
  const c = run(new Uint8ClampedArray(pixels), 16, 16, [fx('noise', 'a', {amount: .5, size: 4, seed: 8, phase: 0, colored: 0, contrast: 1, softness: 1, pattern: 0})], {outputSize: {width: 16, height: 16}});
  assert.deepEqual([...a.pixels], [...b.pixels]);
  assert.notDeepEqual([...a.pixels], [...c.pixels]);
});

test('effectStrength below one blends the filtered result with the input', () => {
  const pixels = buffer(8, 8); pixels.set([200, 100, 50, 255], 0);
  const full = run(new Uint8ClampedArray(pixels), 8, 8, [fx('tint', 'a', {mix: 1, color: 0x00ff00})]);
  const half = run(new Uint8ClampedArray(pixels), 8, 8, [fx('tint', 'a', {mix: 1, color: 0x00ff00, effectStrength: .5})]);
  const f = px(full.pixels, 8, 0, 0), s = px(half.pixels, 8, 0, 0);
  for (let c = 0; c < 4; c++) assert.ok(Math.abs(s[c] - (pixels[c] + (f[c] - pixels[c]) * .5)) <= 2, `channel ${c}: ${s[c]} vs ${pixels[c]}+(${f[c]}-${pixels[c]})*0.5`);
});

test('every effect keeps the premultiplied invariant on translucent input', () => {
  const w = 24, h = 24, pixels = buffer(w, h, i => (Math.imul(i * 7 + 3, 2246822519) >>> 20) % 256);
  for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; pixels[i] = Math.min(pixels[i], a); pixels[i + 1] = Math.min(pixels[i + 1], a); pixels[i + 2] = Math.min(pixels[i + 2], a); }
  const stacks = [
    fx('tint', 't', {mix: .8}), fx('grade', 'g', {exposure: .5, contrast: 1.2, saturation: .8, temperature: .2, tint: 0, shadows: 0, highlights: 0, gamma: 1.1}),
    fx('blur', 'b', {radius: 8}), fx('glow', 'l', {intensity: .8, radius: 6, spread: 2, mode: 0, falloff: 1, blend: 0, coreMix: .3}),
    fx('shadow', 'h', {opacity: .7, radius: 5, spread: 1, mode: 0, offsetX: 3, offsetY: -2}),
    fx('outline', 'o', {width: 3, opacity: 1, mode: 0, rounded: 0}), fx('pixelate', 'p', {size: 4, linked: 1, offsetX: 0, offsetY: 0}),
    fx('noise', 'n', {amount: .6, size: 3, seed: 3, phase: 0, colored: 1, contrast: 1, softness: 1, pattern: 0}),
    fx('vignette', 'v', {amount: .7, softness: .5, radius: .6, centerX: .5, centerY: .5, aspect: 1, roundness: .5}),
    fx('dissolve', 'd', {progress: .4, size: 4, softness: .1, seed: 5, edge: .2}), fx('rgbSplit', 'r', {amount: 4, angle: .7, red: 1, green: 0, blue: -1}),
    fx('turbulence', 'u', {amount: 6, size: 8, evolution: .3, seed: 2, detail: 2}), fx('wave', 'w', {strength: 4, wavelength: 12, angle: 0, phase: 0}),
    fx('shockwave', 's', {radius: 8, thickness: 6, strength: 4, falloff: 1, centerX: .5, centerY: .5}),
    fx('bloom', 'm', {threshold: .3, softness: .2, radius: 6, intensity: .8}), fx('lightSweep', 'e', {position: .5, angle: 0, width: .5, softness: .3, intensity: .7}),
    fx('crt', 'c', {amount: .5, spacing: 4, curvature: .2, chromatic: 1, phase: 0}),
  ];
  for (const effect of stacks) {
    const out = run(new Uint8ClampedArray(pixels), w, h, [effect], {outputSize: {width: w, height: h}});
    for (let i = 0; i < out.pixels.length; i += 4)
      for (let c = 0; c < 3; c++)
        assert.ok(out.pixels[i + c] <= out.pixels[i + 3] + 1, `${effect.type} broke premult at ${i}: ${out.pixels[i + c]} > ${out.pixels[i + 3]}`);
  }
});

test('a halo\'d tile renders the same core pixels as the whole frame', () => {
  // The export/scene tiling contract: each tile's core must be pixel-identical
  // to the full-frame pass whenever the halo covers the effect's tap reach.
  const w = 32, h = 20, pixels = buffer(w, h, i => (Math.imul(i + 11, 1103515245) >>> 22) % 256);
  for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; pixels[i] = Math.min(pixels[i], a); pixels[i + 1] = Math.min(pixels[i + 1], a); pixels[i + 2] = Math.min(pixels[i + 2], a); }
  const stack = [fx('tint', 'a', {mix: .6}), fx('blur', 'b', {radius: 4}), fx('rgbSplit', 'c', {amount: 3, angle: .4, red: 1, green: 0, blue: -1})];
  const os = {width: w, height: h}, whole = run(new Uint8ClampedArray(pixels), w, h, stack, {outputSize: os});
  const pad = 24, split = 16, assembled = new Uint8ClampedArray(whole.pixels.length);
  for (const [cx0, cx1] of [[0, split], [split, w]]) {
    const sx = Math.max(0, cx0 - pad), ex = Math.min(w, cx1 + pad), sw = ex - sx;
    const source = new Uint8ClampedArray(sw * h * 4);
    for (let y = 0; y < h; y++) source.set(pixels.subarray((y * w + sx) * 4, (y * w + ex) * 4), y * sw * 4);
    const filtered = run(source, sw, h, stack, {origin: {x: sx, y: 0}, outputSize: os});
    for (let y = 0; y < h; y++) assembled.set(filtered.pixels.subarray((y * sw + cx0 - sx) * 4, (y * sw + cx1 - sx) * 4), (y * w + cx0) * 4);
  }
  assert.deepEqual([...assembled], [...whole.pixels], 'tiled cores must equal the single-pass frame');
});

test('a four-way tile split with a displacement-heavy stack also composites exactly', () => {
  const w = 24, h = 24, pixels = buffer(w, h, i => (Math.imul(i * 5 + 9, 1664525) >>> 21) % 256);
  for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; pixels[i] = Math.min(pixels[i], a); pixels[i + 1] = Math.min(pixels[i + 1], a); pixels[i + 2] = Math.min(pixels[i + 2], a); }
  const stack = [fx('wave', 'a', {strength: 3, wavelength: 10, angle: .6, phase: 1}), fx('bloom', 'b', {threshold: .2, softness: .3, radius: 5, intensity: .9})];
  const os = {width: w, height: h}, whole = run(new Uint8ClampedArray(pixels), w, h, stack, {outputSize: os});
  const pad = 24, assembled = new Uint8ClampedArray(whole.pixels.length);
  for (const [cx0, cx1] of [[0, 12], [12, 24]]) for (const [cy0, cy1] of [[0, 12], [12, 24]]) {
    const sx = Math.max(0, cx0 - pad), sy = Math.max(0, cy0 - pad), ex = Math.min(w, cx1 + pad), ey = Math.min(h, cy1 + pad), sw = ex - sx, sh = ey - sy;
    const source = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) source.set(pixels.subarray(((sy + y) * w + sx) * 4, ((sy + y) * w + ex) * 4), y * sw * 4);
    const filtered = run(source, sw, sh, stack, {origin: {x: sx, y: sy}, outputSize: os});
    for (let y = cy0; y < cy1; y++) assembled.set(filtered.pixels.subarray(((y - sy) * sw + cx0 - sx) * 4, ((y - sy) * sw + cx1 - sx) * 4), (y * w + cx0) * 4);
  }
  assert.deepEqual([...assembled], [...whole.pixels], 'quartered cores must equal the single-pass frame');
});

test('a dense heavy stack on a large source completes and stays premultiplied', () => {
  // 512² with deep radii — the fallback path a 4K export takes when GPU surfaces
  // cannot be allocated. It must finish in bounded memory and keep its contract.
  const w = 512, h = 512, pixels = buffer(w, h, i => (Math.imul(i * 31 + 7, 747796405) >>> 24) % 256);
  for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; pixels[i] = Math.min(pixels[i], a); pixels[i + 1] = Math.min(pixels[i + 1], a); pixels[i + 2] = Math.min(pixels[i + 2], a); }
  const stack = [
    fx('blur', 'a', {radius: 64}), fx('glow', 'b', {intensity: 1.2, radius: 48, spread: 8, mode: 2, falloff: 1, blend: 1, coreMix: .4}),
    fx('turbulence', 'c', {amount: 24, size: 64, evolution: 2, seed: 9, detail: 3}),
    fx('shockwave', 'd', {radius: 200, thickness: 80, strength: 40, falloff: 1, centerX: .5, centerY: .5}),
    fx('bloom', 'e', {threshold: .2, softness: .3, radius: 48, intensity: 1}), fx('tint', 'f', {mix: .3}),
  ];
  const out = run(pixels, w, h, stack, {outputSize: {width: w, height: h}});
  assert.equal(out.width, w); assert.equal(out.height, h);
  for (let i = 0; i < out.pixels.length; i += 4)
    for (let c = 0; c < 3; c++)
      assert.ok(out.pixels[i + c] <= out.pixels[i + 3] + 1, `premult broken at ${i}`);
});
