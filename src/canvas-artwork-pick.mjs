import {drawGeometry, releaseGeometryResources} from './pivot/geometry.mjs';
import {objectBounds} from './renderer-geometry.mjs';

/** Click-only artwork picking. Use the existing painter for fills, curves,
 * images, meshes and transparency instead of maintaining a second shape model.
 * A three-pixel surface bounds storage and is discarded after the click. */
export function pickCanvasArtwork(geometry, point, {resources = {}, hiddenUids, lockedUids, scale = 1} = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const objects = geometry.orderedObjects ?? [...geometry.objects.values()];
  let canvas, ctx;
  scale = Math.max(.01, Math.abs(scale));
  try {
    for (let i = objects.length - 1; i >= 0; i--) {
      const g = objects[i], uid = g.obj.unique_id;
      if (hiddenUids?.has(uid) || lockedUids?.has(uid) || !g.drawables.length) continue;
      const bounds = objectBounds(g.drawables, resources);
      if (point.x < bounds.x || point.x > bounds.x + bounds.width || point.y < bounds.y || point.y > bounds.y + bounds.height) continue;
      if (!ctx) {
        canvas = new OffscreenCanvas(3, 3);
        ctx = canvas.getContext('2d', {willReadFrequently: true});
        if (!ctx) return null;
      }
      ctx.resetTransform(); ctx.clearRect(0, 0, 3, 3);
      ctx.setTransform(scale, 0, 0, scale, 1.5 - point.x * scale, 1.5 - point.y * scale);
      drawGeometry(ctx, {drawables: g.drawables}, resources);
      if (ctx.getImageData(1, 1, 1, 1).data[3])
        return {g, uid, joint: -1, id: 0, kind: 'body', point: g.root, action: 'select'};
    }
    return null;
  } finally {
    if (ctx) releaseGeometryResources(ctx);
    if (canvas) canvas.width = canvas.height = 1;
  }
}
