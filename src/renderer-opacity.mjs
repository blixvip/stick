import {hasDrawableVfx} from './vfx-canvas.mjs';
import {singleVectorPrimitive} from './renderer-geometry.mjs';

// Weak ownership follows retained geometry. A fade shares the opaque artwork,
// while the existing packet/texture owners still bound pixel allocations.
const opaqueSources = new WeakMap(), views = new WeakMap();

/** Lift an ordinary figure's isolation alpha onto its final textured quad.
 * Overlapping primitives still paint together before opacity is applied.
 * Nested clips and effects keep their complete established painter. */
export function opacityArtwork(g, items = g.drawables) {
  // Retained geometry is immutable, so its view is computed once per object.
  const retained = items === g.drawables && items ? views.get(g) : undefined;
  if (retained?.drawables === items) return retained.view;
  const view = artworkView(g, items);
  if (items && items === g.drawables) views.set(g, {drawables: items, view});
  return view;
}
function artworkView(g, items) {
  const source = g.renderSource || g;
  items = g.renderSource ? source.drawables : items;
  const opacity = items[0]?.opacity;
  if (!(opacity >= 0 && opacity < 1) || singleVectorPrimitive(items) ||
      items.some(item => item.opacity !== opacity || item.obj !== source.obj || item._movieclipOwner || hasDrawableVfx(item))) {
    return {source, items, opacity:1, isolated:false};
  }
  const base = source.opacitySource || source;
  let opaque = opaqueSources.get(base);
  if (!opaque) {
    const obj = {...base.obj, field28:0, transparency:0};
    opaque = {...base, obj, drawables:base.drawables.map(item=>({...item,obj,opacity:1}))};
    opaqueSources.set(base,opaque);
  }
  return {source:opaque, items:opaque.drawables, opacity, isolated:true};
}
