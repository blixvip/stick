import {CanvasHandleOverlay, paintCanvasHandle} from '../src/canvas-handle-overlay.mjs';

/** Browser-callable exact-pixel comparison of local damage against the former
 * full handle pass. No renderer, document caches or application UI required.
 */
export function verifyCanvasHandleOverlay() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const checks = [];
  const handle = (uid, x, y, color, extra = {}) => ({uid, point: {x, y}, screenRadius: 5, color, ...extra});
  const grouped = groups => {
    const handles = groups.flatMap(group => group.handles);
    Object.defineProperty(handles, 'groups', {value: groups}); return handles;
  };
  for (const dpr of [1, 1.5, 2]) for (const outline of [false, true]) {
    const width = 240, height = 140, surface = new OffscreenCanvas(width * dpr, height * dpr);
    const overlay = new CanvasHandleOverlay(new OffscreenCanvas(1, 1)), context = surface.getContext('2d');
    const reference = new OffscreenCanvas(width * dpr, height * dpr), expected = reference.getContext('2d');
    let projected = 0, transform = point => point;
    const project = point => { projected++; return transform(point); };
    const draw = (groups, name, {projectionKey = 'view', translations} = {}) => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      const stats = overlay.draw(context, grouped(groups), {project, projectionKey, width, height, dpr, outline, translations});
      expected.setTransform(dpr, 0, 0, dpr, 0, 0); expected.clearRect(0, 0, width, height);
      for (const group of groups) if (!translations?.has(group.uid))
        for (const item of group.handles) paintCanvasHandle(expected, item, transform(item.point), outline);
      if (translations) for (const group of groups) for (const item of group.handles) {
        const delta = translations.get(item.uid); if (!delta) continue;
        paintCanvasHandle(expected, item, transform({x: item.point.x + delta.x, y: item.point.y + delta.y}), outline);
      }
      const actualPixels = context.getImageData(0, 0, surface.width, surface.height).data,
        expectedPixels = expected.getImageData(0, 0, reference.width, reference.height).data;
      for (let i = 0; i < actualPixels.length; i++)
        check(actualPixels[i] === expectedPixels[i], `${name}, DPR ${dpr}, outline ${outline}: pixel byte ${i} differs (${actualPixels[i]} vs ${expectedPixels[i]})`);
      checks.push({name, dpr, outline, ...stats}); return stats;
    };
    const bottom = {uid: 1, handles: [handle(1, 35, 35, '#ff0000'), handle(1, 100, 90, '#ff8800')]},
      top = {uid: 2, handles: [handle(2, 37, 36, '#0000ff'), handle(2, -4, 70, '#12b886', {connector: true, ik: true})]},
      outside = {uid: 3, handles: [handle(3, -100, -100, '#7048e8'), handle(3, 500, 500, '#7048e8')]};
    draw([bottom, top, outside], 'initial native painter order and clipped edge handles');
    projected = 0;
    const unchanged = draw([bottom, top, outside], 'unchanged groups reuse all projected handles');
    check(unchanged.regions === 0 && projected === 0, 'Unchanged handles must not repaint/project');
    const changed = {uid: 1, handles: [handle(1, 36, 36, '#e64980'), bottom.handles[1]]};
    projected = 0;
    const sparse = draw([changed, top, outside], 'sparse lower-group edit restores overlapping upper artwork');
    check(!sparse.full && projected === changed.handles.length, 'Sparse poses must only project the changed group');
    const small = {uid: 1, handles: [handle(1, 40, 42, '#ff0000')]};
    draw([small, top, outside], 'removed handle clears its old pixels');
    const removed = {uid: 1, handles: [handle(1, 600, 400, '#ff0000')]};
    draw([removed, top, outside], 'moving a group outside clears its old pixels');
    draw([top, outside, small], 'native group reordering');
    draw([small, top], 'native group removal');
    const translations = new Map([[1, {x: 30, y: 10}]]);
    draw([small, top], 'translation excludes selected group from retained layer', {translations});
    translations.set(1, {x: 60, y: 20});
    draw([small, top], 'translation-only update');
    draw([small, top], 'translation release restores native order');
    transform = point => ({x: 150 - point.y, y: point.x});
    check(draw([small, top], 'rotated view invalidates the projected layer', {projectionKey: 'rotation'}).full,
      'A changed view must repaint the layer');
    overlay.clear(); check(draw([small, top], 'document/style invalidation releases retained groups').full,
      'An invalidated overlay must rebuild');
  }
  return {checks};
}
