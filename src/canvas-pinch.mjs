/** Two-finger zoom and pan for the editing canvas (touch only).
 *
 * A second finger turns whatever the first finger was doing into navigation: the
 * first finger's drag is cancelled (its edit is undone, as with Escape), then the
 * artwork under the fingers' midpoint follows the fingers, zooming by the change
 * in their distance. Lifting a finger ends the pinch, and the finger still down is
 * ignored until it lifts too, so it cannot move a joint or select a figure.
 *
 * The listeners run first (capture) and stop the events they use, so the canvas
 * handlers never see a pinch. Workspaces enable their own installation of this
 * shared gesture and supply their edit cancellation.
 */
const MIN_SCALE = 0.001, MAX_SCALE = 100;

/**
 * The view after a pinch. `start` and `now` are {mid: {x, y}, distance} in viewport
 * coordinates; `base` is the view when the pinch began. The point of the artwork
 * that was under the starting midpoint ends up under the current one. Other view
 * properties (a Draw view's rotation and flip) are kept.
 */
export function pinchView(base, start, now, {min = MIN_SCALE, max = MAX_SCALE} = {}) {
  const scale = Math.min(max, Math.max(min, base.scale * now.distance / Math.max(1, start.distance))), k = scale / base.scale;
  return {...base, scale, x: now.mid.x - (start.mid.x - base.x) * k, y: now.mid.y - (start.mid.y - base.y) * k};
}

const measure = (a, b) => ({mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, distance: Math.hypot(b.x - a.x, b.y - a.y)});

export function installCanvasPinch({overlay, viewport, getView, setView, enabled = () => true, onStart = () => {}, onEnd = () => {}, toLocal, signal}) {
  const down = new Map();   // touch pointer id -> viewport coordinates
  const ignored = new Set(); // fingers of a finished pinch that are still down
  let pinch = null;         // {ids: [a, b], base, start}

  const local = toLocal ?? (event => { const rect = viewport.getBoundingClientRect(); return {x: event.clientX - rect.left, y: event.clientY - rect.top}; });
  const take = event => { event.stopImmediatePropagation(); event.preventDefault?.(); };

  const begin = event => {
    const [first] = [...down.keys()].filter(id => id !== event.pointerId);
    pinch = {ids: [first, event.pointerId], base: {...getView()}, start: measure(down.get(first), down.get(event.pointerId))};
    onStart();
    // The cancelled edit may have released its pointer capture. Navigation owns
    // both fingers until release, including moves outside the canvas.
    for (const id of pinch.ids) overlay.setPointerCapture?.(id);
  };

  const onDown = event => {
    if (event.pointerType !== 'touch' || !enabled()) return;
    down.set(event.pointerId, local(event));
    if (pinch || ignored.size) { ignored.add(event.pointerId); take(event); return; }
    if (down.size === 2) { begin(event); take(event); }
  };
  const onMove = event => {
    if (event.pointerType !== 'touch') return;
    if (down.has(event.pointerId) && !ignored.has(event.pointerId)) down.set(event.pointerId, local(event));
    if (pinch?.ids.includes(event.pointerId)) {
      const [a, b] = pinch.ids;
      setView(pinchView(pinch.base, pinch.start, measure(down.get(a), down.get(b))));
      take(event);
    } else if (ignored.has(event.pointerId)) take(event);
  };
  const onUp = event => {
    if (event.pointerType !== 'touch') return;
    down.delete(event.pointerId);
    if (pinch?.ids.includes(event.pointerId)) {
      for (const id of pinch.ids) if (down.has(id)) ignored.add(id);
      pinch = null;
      onEnd();
      take(event);
    } else if (ignored.delete(event.pointerId)) take(event);
  };

  const cancel = () => {
    for (const id of down.keys()) ignored.add(id);
    if (pinch) { pinch = null; onEnd(); }
  };

  const options = {capture: true, signal};
  overlay.addEventListener('pointerdown', onDown, options);
  overlay.addEventListener('pointermove', onMove, options);
  overlay.addEventListener('pointerup', onUp, options);
  overlay.addEventListener('pointercancel', onUp, options);
  return {cancel, get active() { return pinch !== null; }};
}
