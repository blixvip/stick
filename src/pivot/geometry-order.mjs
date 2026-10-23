// A pose keeps most primitive records unchanged. Merge their already sorted
// order with the changed records instead of sorting every face again. Ties use
// native insertion order, not the order of the preceding pose.
export function orderPoseDrawables(current, previous) {
  // Mesh drawables are regrouped from the evaluated faces on every pose.
  if (!previous?.drawables || current.spatialMesh || previous.spatialMesh) return;
  const raw = (g, s) => s.type === 'poly' ? g.polys[s.index] : g.segments[s.index];
  // Expanded sprites and imported compound shapes have their own ordering.
  if (current.obj?._sticknodesShapes || current.segments.some(s => s.seg._sticknodes) ||
      previous.drawables.some(s => raw(previous, s) !== s || !Number.isFinite(s.z))) return;
  const visible = s => s.type === 'poly' ? !s.culled : s.seg.visible !== false;
  const rank = s => s.type === 'poly' ? s.index : current.polys.length + s.index;
  const compare = (a, b) => (a.z - b.z) || (rank(a) - rank(b));
  const retained = [], changed = [];
  for (const s of previous.drawables) if (raw(current, s) === s && visible(s)) retained.push(s);
  for (const list of [current.polys, current.segments]) for (const s of list) {
    if (!Number.isFinite(s.z)) return;
    if (visible(s) && raw(previous, s) !== s) changed.push(s);
  }
  changed.sort(compare);
  const result = new Array(retained.length + changed.length);
  let a = 0, b = 0, at = 0;
  while (a < retained.length && b < changed.length)
    result[at++] = compare(retained[a], changed[b]) <= 0 ? retained[a++] : changed[b++];
  while (a < retained.length) result[at++] = retained[a++];
  while (b < changed.length) result[at++] = changed[b++];
  return result;
}
