/**
 * Placement for everything that floats next to something else: menus,
 * submenus, popovers, tooltips and context menus opened at the pointer.
 *
 * computePosition() is pure: an anchor rectangle (or a point), the floating
 * box's size and the window in, a position out. It flips to the side with more
 * room, sizes the box to what the window leaves on that side (the box scrolls
 * inside), shifts it along the anchor to stay inside the window, and keeps its
 * top below `topInset` (the title band). placeFloating() is the thin DOM
 * adapter; CSS anchor positioning is an optional enhancement (anchorWith()),
 * never required, because the band inset and the size limit need the JS path.
 */
const SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);
const OPPOSITE = Object.freeze({top: 'bottom', bottom: 'top', left: 'right', right: 'left', start: 'end', end: 'start', center: 'center'});

/** 'bottom-start' → {side: 'bottom', align: 'start'}; the align defaults to center. */
export function parsePlacement(placement = 'bottom-start') {
  const [side, align] = String(placement).split('-');
  return {side: SIDES.includes(side) ? side : 'bottom', align: align === 'start' || align === 'end' ? align : 'center'};
}

/** A DOMRect-like rectangle or a point {x, y} as a plain rectangle. */
export function toRect(value = {}) {
  const left = value.left ?? value.x ?? 0, top = value.top ?? value.y ?? 0;
  const width = value.width ?? Math.max(0, (value.right ?? left) - left), height = value.height ?? Math.max(0, (value.bottom ?? top) - top);
  return {left, top, width, height, right: left + width, bottom: top + height};
}

/** The area a floating box may use: the window less a margin, and never above topInset. */
export function viewportBounds(viewport, {margin = 8, topInset = 0} = {}) {
  const width = viewport?.width ?? 0, height = viewport?.height ?? 0;
  return {left: margin, right: Math.max(margin, width - margin), top: Math.min(Math.max(margin, topInset), Math.max(margin, height - margin)), bottom: Math.max(margin, height - margin)};
}

/**
 * Where a floating box goes.
 *
 *   anchor     DOMRect-like, or a point {x, y} for context menus
 *   size       {width, height} of the box at its natural size
 *   placement  side-align: bottom-start (default), top, right-start, left-end, …
 *   offset     gap between the anchor and the box on the main axis (6)
 *   viewport   {width, height} of the window
 *   margin     distance kept from the window edges (8)
 *   topInset   the lowest allowed top, e.g. the title band's bottom + 6
 *   flip       try the opposite side, and the opposite alignment, when that fits better (true)
 *   shift      slide along the cross axis to stay inside the window (true)
 *   fit        cap the size to the room on the chosen side; the box scrolls (true)
 *   overlap    allow covering the anchor to stay inside the window (false: a
 *              tooltip never covers its invoker; menus pass true for tiny windows)
 *   minSize    the smallest main-axis size fit may produce (48)
 *
 * Returns {x, y, width, height, maxWidth, maxHeight, side, align, placement};
 * maxWidth and maxHeight are null when the box fits at its natural size.
 */
export function computePosition({anchor, size, placement = 'bottom-start', offset = 6, viewport, margin = 8, topInset = 0,
  flip = true, shift = true, fit = true, overlap = false, minSize = 48} = {}) {
  const rect = toRect(anchor), bounds = viewportBounds(viewport, {margin, topInset});
  let {side, align} = parsePlacement(placement);
  const vertical = side === 'top' || side === 'bottom';
  const main = vertical ? size.height : size.width;
  const room = s => s === 'bottom' ? bounds.bottom - rect.bottom - offset : s === 'top' ? rect.top - offset - bounds.top
    : s === 'right' ? bounds.right - rect.right - offset : rect.left - offset - bounds.left;
  if (flip && main > room(side) && room(OPPOSITE[side]) > room(side)) side = OPPOSITE[side];

  const extent = vertical ? bounds.bottom - bounds.top : bounds.right - bounds.left;
  const crossExtent = vertical ? bounds.right - bounds.left : bounds.bottom - bounds.top;
  let width = size.width, height = size.height, maxWidth = null, maxHeight = null;
  if (fit) {
    const limit = Math.min(extent, Math.max(room(side), Math.min(minSize, extent)));
    if (main > limit) { if (vertical) height = maxHeight = limit; else width = maxWidth = limit; }
    const cross = vertical ? width : height;
    if (cross > crossExtent) { if (vertical) width = maxWidth = crossExtent; else height = maxHeight = crossExtent; }
  }

  // Main axis: adjacent to the anchor on the chosen side.
  let x, y;
  if (side === 'bottom') y = rect.bottom + offset;
  else if (side === 'top') y = rect.top - offset - height;
  else if (side === 'right') x = rect.right + offset;
  else x = rect.left - offset - width;
  if (overlap) {
    if (vertical) y = clamp(y, bounds.top, bounds.bottom - height);
    else x = clamp(x, bounds.left, bounds.right - width);
  }

  // Cross axis: align to the anchor, flip the alignment if that fits better, then shift inside.
  const start = vertical ? rect.left : rect.top, end = vertical ? rect.right : rect.bottom, length = vertical ? width : height;
  const low = vertical ? bounds.left : bounds.top, high = vertical ? bounds.right : bounds.bottom;
  const aligned = a => a === 'start' ? start : a === 'end' ? end - length : (start + end - length) / 2;
  const overflow = a => Math.max(0, low - aligned(a)) + Math.max(0, aligned(a) + length - high);
  if (flip && align !== 'center' && overflow(align) > 0 && overflow(OPPOSITE[align]) < overflow(align)) align = OPPOSITE[align];
  let cross = aligned(align);
  if (shift) cross = clamp(cross, low, high - length);
  if (vertical) x = cross; else y = cross;
  return {x, y, width, height, maxWidth, maxHeight, side, align, placement: align === 'center' ? side : `${side}-${align}`};
}

function clamp(value, low, high) { return high < low ? low : Math.min(Math.max(value, low), high); }

/**
 * Measures `element` (already shown, for example with showPopover()) and places
 * it next to `anchor`, an element, a DOMRect or a point. Writes left, top and
 * the size limits inline; `topInset` may be a number or a function read now.
 * The box is measured at the window's top-left corner: left where it was last
 * placed (near the right edge), a shrink-to-fit box would measure narrow and
 * tall, and the position would be computed for the wrong size.
 */
export function placeFloating(element, anchor, options = {}) {
  const view = element.ownerDocument?.defaultView ?? globalThis;
  // An upright phone's touch interface shows menus and popovers as sheets from its bottom edge (docs/TOUCH.md;
  // features/touch.css places them), where a thumb reaches them and a long list has the room. Tooltips pass
  // `sheet: false`.
  if (options.sheet !== false && presentsAsSheet(element)) {
    const {style} = element;
    for (const property of ['left', 'top', 'maxWidth', 'maxHeight']) style[property] = '';
    element.dataset.side = 'bottom';
    element.dataset.present = 'sheet';
    return {x: 0, y: 0, width: 0, height: 0, maxWidth: null, maxHeight: null, side: 'bottom', align: 'center', placement: 'bottom', sheet: true};
  }
  delete element.dataset.present;
  options = {...options, placement: besideWing(anchor, options.placement)};
  const anchorRect = typeof anchor?.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : anchor;
  const {style} = element;
  style.maxWidth = ''; style.maxHeight = '';
  style.left = '0px'; style.top = '0px';
  const box = element.getBoundingClientRect();
  const topInset = typeof options.topInset === 'function' ? options.topInset() : options.topInset;
  const result = computePosition({...options, topInset: topInset ?? 0, anchor: anchorRect, size: {width: box.width, height: box.height},
    viewport: {width: view.innerWidth, height: view.innerHeight}});
  style.left = `${Math.round(result.x)}px`;
  style.top = `${Math.round(result.y)}px`;
  if (result.maxWidth !== null) style.maxWidth = `${Math.floor(result.maxWidth)}px`;
  if (result.maxHeight !== null) style.maxHeight = `${Math.floor(result.maxHeight)}px`;
  element.dataset.side = result.side;
  return result;
}

/**
 * A box meant to drop below the band opens beside it instead where the band is a wing down the window's side (the
 * touch interface on a phone on its side, docs/TOUCH.md): toward the stage, from the anchor's top.
 */
export function besideWing(anchor, placement = 'bottom-start') {
  if (!String(placement).startsWith('bottom') || typeof anchor?.closest !== 'function') return placement;
  const band = anchor.closest('.shell-top');
  const box = band?.getBoundingClientRect();
  if (!box || !(box.height > box.width)) return placement;
  const view = anchor.ownerDocument?.defaultView ?? globalThis;
  return box.left + box.width / 2 > (view.innerWidth || 0) / 2 ? 'left-start' : 'right-start';
}

/** Whether floating boxes show as bottom sheets: the touch interface on an upright phone (src/touch/touch-mode.mjs). */
export function presentsAsSheet(element) {
  const root = element?.ownerDocument?.documentElement;
  return root?.dataset?.touchLayout === 'phone-portrait';
}

// ---------------------------------------------------------------------------
// CSS anchor positioning (optional; Chromium 125 and later).

const AREAS = Object.freeze({
  top: 'block-start', 'top-start': 'block-start span-inline-end', 'top-end': 'block-start span-inline-start',
  bottom: 'block-end', 'bottom-start': 'block-end span-inline-end', 'bottom-end': 'block-end span-inline-start',
  left: 'inline-start', 'left-start': 'inline-start span-block-end', 'left-end': 'inline-start span-block-start',
  right: 'inline-end', 'right-start': 'inline-end span-block-end', 'right-end': 'inline-end span-block-start',
});

/** The `position-area` value for a placement. */
export function positionArea(placement) {
  const {side, align} = parsePlacement(placement);
  return AREAS[align === 'center' ? side : `${side}-${align}`];
}

export function supportsAnchorPositioning(css = globalThis.CSS) {
  return Boolean(css?.supports?.('anchor-name: --a') && css.supports('position-area: block-end'));
}

let anchorCount = 0;
/**
 * Tethers `floating` to `anchor` with CSS anchor positioning, so it follows the
 * anchor without JavaScript. Returns a cleanup function, or null when the
 * browser lacks the feature (use placeFloating() instead).
 */
export function anchorWith(anchor, floating, {placement = 'bottom-start', offset = 6, css} = {}) {
  if (!supportsAnchorPositioning(css) || !anchor?.style || !floating?.style) return null;
  const name = anchor.style.getPropertyValue('anchor-name') || `--ui-anchor-${++anchorCount}`;
  const {side} = parsePlacement(placement);
  anchor.style.setProperty('anchor-name', name);
  floating.style.setProperty('position-anchor', name);
  floating.style.setProperty('position-area', positionArea(placement));
  floating.style.setProperty('position-try-fallbacks', 'flip-block, flip-inline');
  floating.style.setProperty(side === 'top' || side === 'bottom' ? 'margin-block' : 'margin-inline', `${offset}px`);
  return () => {
    for (const property of ['position-anchor', 'position-area', 'position-try-fallbacks', 'margin-block', 'margin-inline']) floating.style.removeProperty(property);
    if (anchor.style.getPropertyValue('anchor-name') === name) anchor.style.removeProperty('anchor-name');
  };
}
