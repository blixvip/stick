/**
 * The stage's touch gestures besides the tools and the pinch (docs/TOUCH.md):
 *
 *   two-finger tap     undo
 *   three-finger tap   redo
 *   press and hold     the context menu of what is under the finger (the
 *                      right-click menu); the edit the press began is
 *                      cancelled first, so nothing moves
 *   double tap         a double-click (select connected figures, a branch),
 *                      where the browser sends none for a touch
 *
 * Listeners observe in the capture phase and never stop the editor's own
 * handlers, except the double-tap's native twin, which is stopped so it never
 * runs twice. The editor answers through callbacks: `holdable()` whether a
 * hold may open a menu now (not while drawing or playing), `onHold(point)`,
 * `onUndo()`, `onRedo()`. Pens draw and pose; they never undo by tapping.
 */
import {HOLD_MS, SLOP, beyondSlop, createMultiTap, isDoubleTap} from './touch-gestures.mjs';
import {haptic, swallowNextClick} from './long-press.mjs';

export function installCanvasTouch({viewport, overlay = viewport, touch, holdable = () => true, onHold, onUndo, onRedo,
  document: doc = viewport.ownerDocument, window: win = doc.defaultView ?? globalThis, holdMs = HOLD_MS} = {}) {
  const abort = new AbortController(), signal = abort.signal;
  const taps = createMultiTap();
  let hold = null, lastTap = null, nativeDouble = -Infinity, syntheticDouble = -Infinity;

  const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  // Only the finger's own events: the modifier dock's shaped copies (modifier-dock.mjs) would count twice.
  const active = event => touch?.active && event.pointerType === 'touch' && event.isTrusted;

  viewport.addEventListener('pointerdown', event => {
    if (!active(event)) return;
    taps.down({id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp});
    cancelHold();
    // Only a lone finger holds; a second one makes it a pinch or a multi-finger tap.
    if (taps.count !== 1 || !holdable()) return;
    const point = {x: event.clientX, y: event.clientY};
    hold = {id: event.pointerId, ...point, timer: setTimeout(() => {
      const pending = hold;
      hold = null;
      if (!pending || taps.count !== 1 || !holdable()) return;
      haptic(win);
      onHold?.(pending);
      pending.fired = true;
      swallowNextClick(doc, {pointerId: pending.id, ms: 1500});
    }, holdMs)};
  }, {capture: true, passive: true, signal});

  viewport.addEventListener('pointermove', event => {
    if (!active(event)) return;
    taps.move({id: event.pointerId, x: event.clientX, y: event.clientY});
    if (hold?.id === event.pointerId && beyondSlop(hold, {x: event.clientX, y: event.clientY}, SLOP)) cancelHold();
  }, {capture: true, passive: true, signal});

  const lift = event => {
    if (!active(event)) return;
    if (hold?.id === event.pointerId) cancelHold();
    if (event.type === 'pointercancel') { taps.cancel(); return; }
    const most = taps.most;
    const count = taps.up({id: event.pointerId, time: event.timeStamp});
    if (count === 2) { haptic(win); onUndo?.(); lastTap = null; return; }
    if (count === 3) { haptic(win); onRedo?.(); lastTap = null; return; }
    // A double tap: a double-click at the second tap, unless the browser sent its own.
    if (count === 0 && most === 1 && !taps.count) {
      const tap = {x: event.clientX, y: event.clientY, time: event.timeStamp};
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null;
        const at = {bubbles: true, cancelable: true, composed: true, view: win, clientX: tap.x, clientY: tap.y, button: 0, detail: 2};
        // Sent after the tap's own click, so the editor sees click, click, dblclick as from a mouse.
        setTimeout(() => {
          if (win.performance.now() - nativeDouble < 400) return;
          syntheticDouble = win.performance.now();
          overlay.dispatchEvent(new win.MouseEvent('dblclick', at));
        }, 0);
      } else lastTap = tap;
    }
  };
  viewport.addEventListener('pointerup', lift, {capture: true, passive: true, signal});
  viewport.addEventListener('pointercancel', lift, {capture: true, passive: true, signal});
  // The browser's own double-click for a touch double tap: one of the two runs, never both.
  viewport.addEventListener('dblclick', event => {
    if (!event.isTrusted || !touch?.active) return;
    if (win.performance.now() - syntheticDouble < 400) { event.stopImmediatePropagation(); return; }
    nativeDouble = win.performance.now();
  }, {capture: true, signal});
  win.addEventListener('blur', () => { cancelHold(); taps.cancel(); }, {signal});

  return {
    destroy() { abort.abort(); cancelHold(); },
  };
}
