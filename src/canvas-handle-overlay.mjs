const intersects = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;
function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y};
}
function handleBounds(handle, point, width, height, dpr) {
  // Include the outline and antialias coverage, including centers just outside
  // the viewport. Align damage to backing pixels so clips introduce no seams.
  const radius = handle.screenRadius + 1;
  const x = Math.max(0, Math.floor((point.x - radius) * dpr) / dpr),
    y = Math.max(0, Math.floor((point.y - radius) * dpr) / dpr),
    right = Math.min(width, Math.ceil((point.x + radius) * dpr) / dpr),
    bottom = Math.min(height, Math.ceil((point.y + radius) * dpr) / dpr);
  return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
}
export function paintCanvasHandle(context, handle, point, outline = false) {
  context.beginPath();
  const radius = handle.screenRadius;
  if (handle.connector) {
    context.moveTo(point.x, point.y - radius); context.lineTo(point.x + radius, point.y);
    context.lineTo(point.x, point.y + radius); context.lineTo(point.x - radius, point.y); context.closePath();
  } else context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fillStyle = handle.color;
  context.strokeStyle = handle.ik ? '#0d99ff' : '#000000';
  context.lineWidth = 1;
  context.fill();
  if (outline || handle.ik) context.stroke();
}

/** Retains the existing single overlay surface. Unchanged descriptor groups
 * reuse projected handles; pose edits clear affected pixels and repaint every
 * overlapping group in native order. View/order/style changes use a full pass.
 */
export class CanvasHandleOverlay {
  constructor(surface) {
    this.surface = surface;
    this.context = surface.getContext('2d');
    this.groups = [];
    this.key = null;
  }
  clear() { this.groups = []; this.key = null; }
  draw(target, handles, {project, projectionKey, width, height, dpr = 1, translations, outline = false}) {
    const surface = this.surface, context = this.context;
    const key = `${projectionKey}|${width}|${height}|${dpr}|${outline}|${[...(translations?.keys() ?? [])].join(',')}`;
    const groups = handles.groups ?? [{uid: null, handles}];
    let full = this.key !== key || groups.length !== this.groups.length ||
      groups.some((group, i) => group.uid !== this.groups[i]?.uid);
    const next = [], dirty = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index], previous = this.groups[index];
      if (!full && previous?.handles === group.handles) { next.push(previous); continue; }
      const points = [];
      let rect = null;
      if (!translations?.has(group.uid)) for (const handle of group.handles) {
        const point = project(handle.point), bound = handleBounds(handle, point, width, height, dpr);
        if (!bound) continue;
        points.push({handle, point}); rect = union(rect, bound);
      }
      next.push({uid: group.uid, handles: group.handles, points, rect});
      if (!full) {
        const damage = union(previous?.rect, rect);
        if (damage) dirty.push(damage);
      }
    }
    // A few moving groups stay local. Large damage/order changes are cheaper
    // and simpler as a full pass than many clips or a second raster cache.
    const merged = [];
    for (const damage of dirty) {
      let rect = damage;
      for (let index = 0; index < merged.length;)
        if (intersects(merged[index], rect)) { rect = union(rect, merged.splice(index, 1)[0]); index = 0; }
        else index++;
      merged.push(rect);
    }
    if (merged.length > 16 || merged.reduce((area, rect) => area + rect.width * rect.height, 0) > width * height / 2) full = true;
    const physicalWidth = Math.round(width * dpr), physicalHeight = Math.round(height * dpr);
    if (surface.width !== physicalWidth) { surface.width = physicalWidth; full = true; }
    if (surface.height !== physicalHeight) { surface.height = physicalHeight; full = true; }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const paint = rect => {
      for (const group of next) if (!rect || intersects(group.rect, rect))
        for (const {handle, point} of group.points) {
          const radius = handle.screenRadius + 1;
          if (!rect || point.x + radius > rect.x && point.x - radius < rect.x + rect.width &&
              point.y + radius > rect.y && point.y - radius < rect.y + rect.height)
            paintCanvasHandle(context, handle, point, outline);
        }
    };
    if (full) { context.clearRect(0, 0, width, height); paint(null); }
    else for (const rect of merged) {
      context.save(); context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip();
      context.clearRect(rect.x, rect.y, rect.width, rect.height); paint(rect); context.restore();
    }
    this.groups = next; this.key = key;
    target.drawImage(surface, 0, 0, width, height);
    // Keep translated figures in the existing foreground pass. The retained
    // layer excludes them for the whole gesture, so moving only updates these.
    if (translations) for (const handle of handles) {
      const delta = translations.get(handle.uid);
      if (!delta) continue;
      const point = project({x: handle.point.x + delta.x, y: handle.point.y + delta.y});
      if (handleBounds(handle, point, width, height, dpr)) paintCanvasHandle(target, handle, point, outline);
    }
    return {full, regions: full ? 1 : merged.length, visible: next.reduce((count, group) => count + group.points.length, 0)};
  }
}
