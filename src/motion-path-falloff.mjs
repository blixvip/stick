/** Falloff planning for motion-path arc edits. A falloff drag moves the grabbed
 * frame fully and the target's existing keys inside the influence by their
 * weight; in-betweens stay ordinary tweens. Where a substantial change would
 * otherwise leak through a long tween past the influence, one unchanged edge
 * key holds the original pose just outside it. Pure data: no editor state. */

export const MOTION_PATH_FALLOFF_SHAPES = Object.freeze(['smooth', 'linear', 'sharp', 'flat']);
export const MOTION_PATH_FALLOFF_MAX = 240;
/** Below this weight a leaked change is too small to justify an edge key. */
const EDGE_THRESHOLD = 0.1;

/** Influence at `distance` frames from the grabbed frame: 1 there, 0 beyond
 * `radius`, and strictly positive inside it for every shape. */
export function falloffWeight(distance, radius, shape = 'smooth') {
  distance = Math.abs(distance);
  if (distance === 0) return 1;
  if (!(radius > 0) || distance > radius) return 0;
  const u = distance / (radius + 1);
  if (shape === 'linear') return 1 - u;
  if (shape === 'sharp') return (1 - u) ** 3;
  if (shape === 'flat') return 1;
  return 0.5 + 0.5 * Math.cos(Math.PI * u);
}

/**
 * The writes of one falloff edit, sorted by tick: `{tick, weight, kind}` where
 * kind is 'grab' (the dragged frame, weight 1), 'key' (an existing key inside
 * the influence) or 'edge' (an added key that keeps the original pose, weight 0).
 * `keys` are the target's key ticks; ticks lie in [0, totalTicks).
 */
export function planFalloff({tick, radius, shape = 'smooth', keys, totalTicks}) {
  const sorted = [...new Set(keys)].filter(k => Number.isInteger(k) && k >= 0 && k < totalTicks).sort((a, b) => a - b);
  const writes = [{tick, weight: 1, kind: 'grab'}];
  for (const key of sorted) {
    if (key === tick) continue;
    const weight = falloffWeight(key - tick, radius, shape);
    if (weight > 0) writes.push({tick: key, weight, kind: 'key'});
  }
  if (radius > 0) for (const side of [-1, 1]) {
    const edge = tick + side * (radius + 1);
    if (edge < 0 || edge >= totalTicks || sorted.includes(edge)) continue;
    // Only a key beyond the edge makes a tween that would carry the change further.
    if (!sorted.some(key => side < 0 ? key < edge : key > edge)) continue;
    const inside = writes.filter(w => side < 0 ? w.tick <= tick : w.tick >= tick);
    const outermost = inside.reduce((far, w) => Math.abs(w.tick - tick) > Math.abs(far.tick - tick) ? w : far);
    if (outermost.weight >= EDGE_THRESHOLD) writes.push({tick: edge, weight: 0, kind: 'edge'});
  }
  return writes.sort((a, b) => a.tick - b.tick);
}

/** Normalized falloff options, or null when the drag edits one frame. */
export function normalizeFalloff(value) {
  if (!value) return null;
  const radius = Math.round(Number(value.radius));
  if (!Number.isFinite(radius) || radius < 1) return null;
  return {radius: Math.min(MOTION_PATH_FALLOFF_MAX, radius),
    shape: MOTION_PATH_FALLOFF_SHAPES.includes(value.shape) ? value.shape : 'smooth'};
}
