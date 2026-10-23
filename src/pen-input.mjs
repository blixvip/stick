/** Drawing-tablet conventions shared by the canvas and widgets.
 *
 * - A pen tap wobbles a few pixels. Drags from a pen (or finger) only begin
 *   after that travel, so tapping a joint selects it without nudging it.
 *   Mouse input keeps its existing precision.
 * - Windows turns a stationary pen press into a right click ("press and
 *   hold"). Like Krita and Photoshop, the editor ignores that synthesized
 *   menu: animators often hold the pen still before dragging. The pen's
 *   barrel button (a real right press) still opens menus.
 */

const SLOP = {pen: 5, touch: 10};

/** Screen pixels a press may travel and still count as a tap. */
export const dragSlop = (event, mouse = 0) => SLOP[event?.pointerType] ?? mouse;

/** True once a drag that started at (x, y) has left its tap slop. */
export const beyondSlop = (event, x, y, slop) =>
  !slop || Math.hypot(event.clientX - x, event.clientY - y) >= slop;

// A press-and-hold menu arrives while the pen tip is down, or just after lift.
const HOLD_MENU_WINDOW_MS = 700;

/** Suppress context menus synthesized from a pen-tip press and hold. */
export function installPenMenuGuard(target = window, {signal} = {}) {
  let tip = null;
  const options = {capture: true, signal};
  target.addEventListener('pointerdown', event => {
    tip = event.pointerType === 'pen' && event.button === 0 ? {id: event.pointerId, down: true, time: performance.now()} : null;
  }, options);
  const lift = event => { if (tip?.id === event.pointerId) { tip.down = false; tip.time = performance.now(); } };
  target.addEventListener('pointerup', lift, options);
  target.addEventListener('pointercancel', lift, options);
  target.addEventListener('contextmenu', event => {
    // Keyboard menus (Shift+F10, Menu key) report no pointer type. Any new
    // press, including a barrel or mouse right press, has already reset `tip`.
    if (!tip || event.pointerType === '') return;
    if (!tip.down && performance.now() - tip.time > HOLD_MENU_WINDOW_MS) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, options);
}
