import test from 'node:test';
import assert from 'node:assert/strict';
import {evenOddTriangles} from '../src/even-odd-fill.mjs';

// Canvas even-odd rule: a horizontal ray crosses the outline an odd number of times.
function evenOdd(coords, x, y) {
  let inside = false;
  for (let i = 0, n = coords.length / 2, j = n - 1; i < n; j = i++) {
    const xi = coords[2 * i], yi = coords[2 * i + 1], xj = coords[2 * j], yj = coords[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inTriangle(t, i, x, y) {
  const [ax, ay, bx, by, cx, cy] = t.slice(i, i + 6), d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by), d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy), d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const distanceToOutline = (coords, x, y) => {
  let best = Infinity;
  for (let i = 0, n = coords.length / 2; i < n; i++) {
    const ax = coords[2 * i], ay = coords[2 * i + 1], bx = coords[(2 * i + 2) % coords.length], by = coords[(2 * i + 3) % coords.length];
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
};
function assertCovers(coords, label, samples = 2000) {
  const triangles = evenOddTriangles(coords);
  assert.ok(triangles, label);
  const xs = coords.filter((_, i) => i % 2 === 0), ys = coords.filter((_, i) => i % 2 === 1);
  const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1, y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
  let seed = 12345, checked = 0;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let s = 0; s < samples; s++) {
    const x = x0 + random() * (x1 - x0), y = y0 + random() * (y1 - y0);
    if (distanceToOutline(coords, x, y) < 1e-6) continue;
    let covered = 0;
    for (let i = 0; i < triangles.length; i += 6) if (inTriangle(triangles, i, x, y)) covered++;
    const expected = evenOdd(coords, x, y);
    // Inside points lie in exactly one trapezoid; a point on an internal diagonal can touch two.
    assert.equal(covered > 0, expected, `${label} at ${x}, ${y}`);
    checked++;
  }
  assert.ok(checked > samples * .9, label);
}

test('even-odd triangles cover exactly the canvas even-odd interior', () => {
  const star = Array.from({length: 5}, (_, i) => { const a = -Math.PI / 2 + i * 4 * Math.PI / 5; return [100 * Math.cos(a), 100 * Math.sin(a)]; }).flat();
  const cases = {
    'pentagram (crossing, hollow centre)': star,
    'figure eight': [0, 0, 100, 100, 100, 0, 0, 100],
    'touching at a corner': [0, 0, 50, 50, 100, 0, 100, 100, 50, 50, 0, 100],
    'overlapping collinear edges': [0, 0, 100, 0, 100, 50, 50, 50, 50, 0, 150, 0, 150, 80, 0, 80],
    'horizontal edges and a spike': [0, 0, 40, 0, 40, 30, 60, 30, 60, 0, 100, 0, 100, 100, 50, -20, 0, 100],
    'nested loops': [0, 0, 100, 0, 100, 100, 0, 100, 0, 0, 20, 20, 80, 20, 80, 80, 20, 80, 20, 20],
    'simple square': [0, 0, 10, 0, 10, 10, 0, 10],
  };
  for (const [label, coords] of Object.entries(cases)) assertCovers(coords, label);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 100; k++) {
    const n = 3 + Math.floor(random() * 40), coords = [];
    for (let i = 0; i < n; i++) coords.push(Math.round(random() * 200) / 2, Math.round(random() * 200) / 2);
    assertCovers(coords, `random ${k}`, 300);
  }
});

test('outlines beyond the triangle budget are left to the raster path', () => {
  const zigzag = Array.from({length: 256}, (_, i) => [i % 2 ? 1000 : 0, i * 3]).flat();
  assert.equal(evenOddTriangles(zigzag, 50), null);
  assert.ok(evenOddTriangles(zigzag));
});
