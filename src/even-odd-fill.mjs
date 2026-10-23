/** Triangles covering the even-odd interior of a self-crossing or
 * self-touching outline, the fill rule Pivot polygons use.
 *
 * Every corner and every crossing of two edges starts a new horizontal slab, so
 * no edges cross inside a slab. Within it, the edges that span the slab are
 * ordered by x and paired first-second, third-fourth, …; each pair bounds one
 * filled trapezoid. The trapezoids exactly partition the filled region, and a
 * shared slab boundary evaluates each edge with the same expression, so
 * neighbouring trapezoids meet without cracks.
 *
 * `coords` holds x, y pairs. Returns x0, y0, x1, y1, x2, y2 per triangle, or
 * null when the outline would need more than `limit` triangles. */
export function evenOddTriangles(coords, limit = 65536) {
  const n = coords.length >> 1, edges = [], heights = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = coords[2 * i], ay = coords[2 * i + 1], bx = coords[2 * j], by = coords[2 * j + 1];
    heights.push(ay);
    // A horizontal edge lies on a slab boundary and never crosses a slab.
    if (ay !== by) edges.push(ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay]);
  }
  for (let a = 0; a < edges.length; a++) for (let b = a + 1; b < edges.length; b++) {
    const [x1, y1, x2, y2] = edges[a], [x3, y3, x4, y4] = edges[b];
    if (y2 <= y3 || y4 <= y1) continue;
    const denominator = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (!denominator) continue;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / denominator, u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / denominator;
    if (t > 0 && t < 1 && u > 0 && u < 1) heights.push(y1 + t * (y2 - y1));
  }
  heights.sort((p, q) => p - q);
  const at = (edge, y) => edge[0] + (y - edge[1]) * (edge[2] - edge[0]) / (edge[3] - edge[1]);
  const triangles = [], active = [];
  for (let k = 0; k + 1 < heights.length; k++) {
    const y0 = heights[k], y1 = heights[k + 1];
    if (!(y1 > y0)) continue;
    const middle = (y0 + y1) / 2;
    active.length = 0;
    for (const edge of edges) if (edge[1] <= y0 && edge[3] >= y1) active.push(edge);
    active.sort((p, q) => at(p, middle) - at(q, middle));
    for (let i = 0; i + 1 < active.length; i += 2) {
      const l0 = at(active[i], y0), r0 = at(active[i + 1], y0), l1 = at(active[i], y1), r1 = at(active[i + 1], y1);
      if (r0 !== l0) triangles.push(l0, y0, r0, y0, r1, y1);
      if (r1 !== l1) triangles.push(l0, y0, r1, y1, l1, y1);
      if (triangles.length > limit * 6) return null;
    }
  }
  return triangles;
}
