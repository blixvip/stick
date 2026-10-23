/**
 * Press and hold (docs/TOUCH.md): a finger held still on the chrome opens
 * that element's right-click menu, and on a control without one shows the
 * control's name (the tooltip), so an icon says what it is before it is
 * pressed. Either way the click that lifting the finger would send is
 * swallowed.
 *
 * It sends the platform's own `contextmenu` event, so every right-click menu
 * the editor has (layers, frames, library cards, tabs, the timeline) works
 * without a second implementation. Browsers that send their own contextmenu
 * for a long press (Chrome on Android) would open a menu twice: while a touch
 * press is on or just ended, their trusted event is stopped.
 *
 * The canvas and the Advanced timeline's grid handle their own holds
 * (canvas-touch.mjs, timeline-touch.mjs): `exclude` names them. Text fields
 * keep the platform's own long press (selection, the callout).
 */
import {HOLD_MS, SLOP, beyondSlop} from './touch-gestures.mjs';

const EDITABLE = 'input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"], [type="color"]), textarea, select, [contenteditable="true"], [contenteditable=""]';
const NAMED = 'button, [role="button"], [role="tab"], [role="menuitem"], [data-tooltip], [data-hotkey-title]';

/**
 * Swallows the click a lifted finger sends after a handled hold or a drag: the next click within `ms`, and only
 * that press's (a click that names another pointer is a new tap, and goes through).
 */
export function swallowNextClick(doc, {pointerId = null, ms = 400} = {}) {
  const swallow = event => {
    const other = pointerId !== null && Number.isInteger(event.pointerId) && event.pointerId > 0 && event.pointerId !== pointerId;
    if (!other) { event.preventDefault(); event.stopImmediatePropagation(); }
    stop();
  };
  const stop = () => { clearTimeout(timer); doc.removeEventListener('click', swallow, true); };
  const timer = setTimeout(stop, ms);
  doc.addEventListener('click', swallow, true);
  return stop;
}

/** A buzz the finger feels when a hold takes effect, where the device has one. */
export function haptic(win = globalThis) {
  try { win.navigator?.vibrate?.(8); } catch { /* not allowed here */ }
}

/**
 * installLongPress({touch, tooltips, exclude, holdMs, slop}) → {destroy()}
 *   touch     the touch mode (src/touch/touch-mode.mjs): holds count only while it is on
 *   tooltips  the one tooltip (ui/ui-tooltip.mjs installTooltips): {show(element), hide()}
 *   exclude   a selector for regions with holds of their own
 */
export function installLongPress({touch, tooltips = null, exclude = '#viewport, .sheet-scroll', holdMs = HOLD_MS, slop = SLOP,
  document: doc = globalThis.document, window: win = globalThis.window} = {}) {
  const abort = new AbortController(), signal = abort.signal;
  let press = null, lastTouch = -Infinity, hideTimer = 0;

  const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
  const fire = () => {
    const current = press;
    if (!current) return;
    current.fired = true;
    const target = current.target.isConnected ? current.target : doc.elementFromPoint(current.x, current.y);
    if (!target) return;
    const menu = new win.MouseEvent('contextmenu', {bubbles: true, cancelable: true, composed: true, view: win,
      clientX: current.x, clientY: current.y, screenX: current.screenX, screenY: current.screenY, button: 2, buttons: 0});
    const handled = !target.dispatchEvent(menu);
    if (handled) { haptic(win); current.handled = true; return; }
    // No menu here: a control says its name, and lifting the finger does not press it.
    const control = target.closest?.(NAMED);
    if (control && tooltips?.show) {
      tooltips.show(control);
      current.handled = true;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => tooltips.hide?.(), 1600);
    }
  };

  doc.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    lastTouch = event.timeStamp;
    if (!touch?.active) return;
    if (!event.isPrimary) { cancel(); return; }
    cancel();
    const target = event.target;
    if (!(target instanceof win.Element) || target.closest(exclude) || target.closest(EDITABLE)) return;
    press = {id: event.pointerId, x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY, target, fired: false, handled: false,
      timer: setTimeout(fire, holdMs)};
  }, {capture: true, passive: true, signal});
  doc.addEventListener('pointermove', event => {
    if (press?.id === event.pointerId && !press.fired && beyondSlop(press, {x: event.clientX, y: event.clientY}, slop)) cancel();
  }, {capture: true, passive: true, signal});
  const finish = event => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') lastTouch = event.timeStamp;
    if (press?.id !== event.pointerId) return;
    const handled = press.handled;
    cancel();
    if (handled && event.type === 'pointerup') swallowNextClick(doc, {pointerId: event.pointerId});
  };
  doc.addEventListener('pointerup', finish, {capture: true, passive: true, signal});
  doc.addEventListener('pointercancel', finish, {capture: true, passive: true, signal});
  // A browser's own long-press menu event arrives around ours: while a touch press is on or just ended, only ours counts.
  doc.addEventListener('contextmenu', event => {
    if (!touch?.active || !event.isTrusted) return;
    const fromTouch = event.pointerType === 'touch' || event.pointerType === 'pen' || press || event.timeStamp - lastTouch < 900;
    if (!fromTouch || event.target?.closest?.(EDITABLE)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, {capture: true, signal});
  win.addEventListener('blur', cancel, {signal});
  doc.addEventListener('scroll', cancel, {capture: true, passive: true, signal});

  return {
    destroy() { abort.abort(); cancel(); clearTimeout(hideTimer); },
  };
}
