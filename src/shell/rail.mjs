import {t as interfaceText} from '../localization.mjs';
import {appendLocalized, localizedMarkup, localizedAttribute} from '../localization-bindings.mjs';
/**
 * The tool rail (experience.md §3.2, components.md "Tool button and Rail"):
 * only the current workspace's tools, in the same column and anchored to its
 * vertical center in every workspace. The markup (index.html) lists every tool once, in
 * an order that reads right in each workspace; syncRail() shows the current
 * workspace's, names the tools that differ by workspace (Select and pose in
 * Animate, Select figure in Build) and marks the active tool.
 *
 *   Animate  + (the Add menu) · Select and pose · Tweener · Pan
 *   Draw     + (New drawing layer) · Brush · Eraser · Fill · Select pixels · Shapes · Transform · Pan
 *   Build    Edit joints · Select figure · Line · Chain · Circle · Polygon · Pan
 *
 * A tool with variants keeps today's small corner tick ([data-rail-menu]:
 * Select pixels, Shapes, and Draw's +, whose tick lists the Add menu; the
 * Tweener draws its own, tweener-controls.mjs). installRail() wraps such a
 * tool in a `.rail-slot` with a tick button: a click on the tick, a
 * right-click or a long press on the tool, or ArrowDown/ArrowRight while it
 * is focused asks `openMenu(kind, tool)` for its list, two clicks as today.
 * A long press never also runs the tool's click.
 *
 * Until the figure's quick actions (To front, To back, M4) exist, Animate
 * keeps today's two stacking buttons (.rail-order) under its tools; Draw and
 * Build do not show them (Build's parts have Arrange in their own menus).
 *
 * Build uses two columns, with part creation tools followed by branch scope,
 * Split, Duplicate branch, horizontal/vertical flips and Delete part.
 * syncRailQuick() reflects the branch scope toggle.
 */

/** Each workspace's rail, top to bottom: `data-tool` values and `add` (the +, #open-insert). */
export const RAIL_TOOLS = Object.freeze({
  animate: Object.freeze(['add', 'select', 'tweener', 'hand']),
  draw: Object.freeze(['add', 'drawing-brush', 'drawing-eraser', 'drawing-fill', 'drawing-lasso', 'drawing-shape', 'drawing-transform', 'hand']),
  rig: Object.freeze(['rig', 'select', 'line', 'chain', 'circle', 'polygon', 'hand']),
});

/** Names that differ by workspace; others keep the name in the markup. */
const WORKSPACE_NAMES = Object.freeze({
  animate: {add: "rail.add", select: "rail.selectAndPose"},
  draw: {add: "rail.newDrawingLayer"},
  rig: {rig: "rail.editJoints", select: "rail.selectFigure"},
});

/** The Tweener names itself after its current type (tweener-controls.mjs); every other tool's name is the rail's. */
const SELF_NAMED = new Set(['tweener']);
/** What each corner tick lists, by [data-rail-menu] value: its accessible name. */
const TICK_NAMES = Object.freeze({add: "rail.addToTheScene", lasso: "rail.chooseSelectionShape", shape: "rail.chooseShape"});
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 6;

const keyOf = button => button.id === 'open-insert' ? 'add' : button.dataset.tool;
/** The element that shows or hides with a tool: its slot (a tool with a tick) or the button. */
const hostOf = button => button.parentElement?.matches('.rail-slot, .tweener-tool') ? button.parentElement : button;

/**
 * Wires the rail's corner ticks. `openMenu(kind, tool, {keyboard})` opens
 * the list for a [data-rail-menu] kind anchored on its tool. Returns
 * {destroy()}.
 */
export function installRail(rail, {openMenu, signal} = {}) {
  const doc = rail.ownerDocument, win = doc.defaultView ?? globalThis;
  const controller = new AbortController();
  const options = {signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal};
  const open = (button, keyboard = false) => openMenu?.(button.dataset.railMenu, button, {keyboard});
  for (const button of rail.querySelectorAll('[data-rail-menu]')) {
    const slot = doc.createElement('div');
    slot.className = 'rail-slot';
    button.before(slot);
    appendLocalized(slot, button);
    const tick = doc.createElement('button');
    tick.type = 'button';
    tick.className = 'rail-tick ui-tool-tick-button';
    tick.tabIndex = -1;
    localizedAttribute(tick,'aria-label',TICK_NAMES[button.dataset.railMenu]??'rail.more');
    tick.setAttribute('aria-haspopup', 'menu');
    localizedAttribute(tick,'data-tooltip',TICK_NAMES[button.dataset.railMenu]??'rail.more');
    localizedMarkup(tick, '<span class="ui-tool-tick" aria-hidden="true"></span>');
    appendLocalized(slot, tick);
    tick.addEventListener('click', event => { event.stopPropagation(); open(button); }, options);
    slot.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); open(button); }, options);
    button.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight') return;
      event.preventDefault(); event.stopPropagation();
      open(button, true);
    }, options);
    // A long press lists the variants (pen and touch, where there is no right-click) and never also clicks the tool.
    let press = null;
    const cancel = () => { if (press) win.clearTimeout(press.timer); press = null; };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      cancel();
      press = {x: event.clientX, y: event.clientY, fired: false};
      press.timer = win.setTimeout(() => { if (!press) return; press.fired = true; open(button); }, LONG_PRESS_MS);
    }, options);
    button.addEventListener('pointermove', event => {
      if (press && !press.fired && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) cancel();
    }, options);
    // The click a fired long press ends with is swallowed; it follows pointerup in the same task, before any timer.
    const swallow = event => { event.stopImmediatePropagation(); event.preventDefault(); };
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, () => {
      if (press?.fired) {
        button.addEventListener('click', swallow, {capture: true, once: true});
        win.setTimeout(() => button.removeEventListener('click', swallow, {capture: true}), 0);
      }
      cancel();
    }, options);
  }
  return {destroy: () => controller.abort()};
}

/**
 * Shows `mode`'s tools (animate, draw or rig), names the ones that differ by
 * workspace, marks `tool` pressed and shows the stacking buttons in Animate
 * only. Every write compares first, so an unchanged rail writes nothing.
 */
export function syncRail(rail, {mode = 'animate', tool = null} = {}) {
  if (!rail) return;
  const shown = new Set(RAIL_TOOLS[mode] ?? RAIL_TOOLS.animate);
  const names = WORKSPACE_NAMES[mode] ?? {};
  for (const button of rail.querySelectorAll('#open-insert, .tool-dock [data-tool]')) {
    const key = keyOf(button), host = hostOf(button);
    const hidden = !shown.has(key);
    if (host.hidden !== hidden) host.hidden = hidden;
    if (host !== button && button.hidden) button.hidden = false;
    if (!SELF_NAMED.has(key)) {
      // The name the tooltip shows too (the registry adds the key); the markup's name unless this workspace renames it.
      if (button.dataset.railName === undefined) {
        button.dataset.railName = button.getAttribute('aria-label') ?? '';
        button.dataset.railNameKey = button.getAttribute('data-i18n-aria-label') ?? '';
      }
      const messageKey = names[key] ?? button.dataset.railNameKey;
      if (messageKey) {
        localizedAttribute(button,'aria-label',messageKey);
        localizedAttribute(button,'data-tooltip',messageKey);
      } else {
        const name = button.dataset.railName;
        if (name && button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
        if (name && button.dataset.tooltip !== name) button.dataset.tooltip = name;
      }
    }
    if (key === 'add') {
      // Animate's + opens the Add menu; Draw's makes a drawing layer (its corner tick has the menu).
      const popup = mode === 'draw' ? null : 'menu';
      if (button.getAttribute('aria-haspopup') !== popup) popup ? button.setAttribute('aria-haspopup', popup) : button.removeAttribute('aria-haspopup');
      continue;
    }
    const pressed = String(key === tool);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    if (button.classList.contains('active') !== (key === tool)) button.classList.toggle('active', key === tool);
    if (host !== button && host.hasAttribute('data-active') !== (key === tool)) host.toggleAttribute('data-active', key === tool);
  }
  const order = rail.querySelector('.rail-order');
  if (order && order.hidden !== (mode !== 'animate')) order.hidden = mode !== 'animate';
  const quick = rail.querySelector('.rail-quick');
  if (quick && quick.hidden !== (mode !== 'rig')) quick.hidden = mode !== 'rig';
}

/** The quick options' on/off states, by command ({'toggle-builder-branch': true}); a command not listed keeps its state. */
export function syncRailQuick(rail, pressed = {}) {
  for (const button of rail?.querySelectorAll('.rail-quick [aria-pressed][data-action]') ?? []) {
    if (!Object.hasOwn(pressed, button.dataset.action)) continue;
    const value = String(Boolean(pressed[button.dataset.action]));
    if (button.getAttribute('aria-pressed') !== value) button.setAttribute('aria-pressed', value);
  }
}
