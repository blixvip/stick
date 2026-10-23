/**
 * Whether the touch interface is on, and which form factor it lays out for
 * (docs/TOUCH.md). Pure decisions first, then the one installer that writes
 * them on the root element and tells the shell when they change.
 *
 *   :root[data-input]          touch | pointer
 *   :root[data-form]           phone | tablet        (touch only)
 *   :root[data-orient]         portrait | landscape  (touch only)
 *   :root[data-touch-layout]   phone-portrait | phone-landscape | tablet-portrait | tablet-landscape
 *
 * src/theme-bootstrap.js writes the same attributes before the stylesheet
 * loads (it cannot import this module): keep PHONE_MAX, the setting's name and
 * the ?ui= override in step with it.
 */

/** The setting's values: Automatic follows the primary pointer; On and Off force it. */
export const TOUCH_SETTINGS = Object.freeze(['auto', 'on', 'off']);
/** Drawing with a finger in Draw: until a pen is used (auto), always, or never (a finger pans). */
export const FINGER_DRAW_SETTINGS = Object.freeze(['auto', 'always', 'never']);
/** A window whose shorter side is under this many CSS px is laid out as a phone. */
export const PHONE_MAX = 600;

export const normalizeTouchSetting = value => (TOUCH_SETTINGS.includes(value) ? value : 'auto');
export const normalizeFingerDraw = value => (FINGER_DRAW_SETTINGS.includes(value) ? value : 'auto');

/** `?ui=touch` or `?ui=desktop` for this page load, else null. */
export function readOverride(search = '') {
  let value = null;
  try { value = new URLSearchParams(search).get('ui'); } catch { return null; }
  return value === 'touch' || value === 'desktop' ? value : null;
}

/**
 * Whether the touch interface is on. `coarse`: the primary pointer is coarse
 * (`(pointer: coarse)`), which is true on phones and tablets and false on a
 * laptop whose screen also takes touch.
 */
export function resolveTouch({setting = 'auto', override = null, coarse = false} = {}) {
  if (override === 'touch') return true;
  if (override === 'desktop') return false;
  const value = normalizeTouchSetting(setting);
  return value === 'on' || (value === 'auto' && Boolean(coarse));
}

/** The form factor and orientation of a window `width`×`height` CSS px. */
export function formFactor(width, height) {
  const w = Number.isFinite(width) && width > 0 ? width : 0, h = Number.isFinite(height) && height > 0 ? height : 0;
  const form = Math.min(w, h) < PHONE_MAX ? 'phone' : 'tablet';
  const orient = w >= h ? 'landscape' : 'portrait';
  return {form, orient, layout: `${form}-${orient}`};
}

/** The attributes the root carries for a state (null removes one). */
export function touchAttributes({active, form, orient, layout}) {
  return active
    ? {input: 'touch', form, orient, touchLayout: layout}
    : {input: 'pointer', form: null, orient: null, touchLayout: null};
}

/**
 * Keeps the root's attributes current and says when they change.
 *
 *   getSetting()   the stored setting (auto | on | off)
 *   size()         the window's {width, height} in CSS px (default: the #app box, else the window)
 *
 * Returns {state, refresh(), on(listener) → off, destroy()}; `state` is
 * {active, form, orient, layout}. A listener hears (state, previous) after a
 * change of any of them, never for a resize that changes nothing.
 */
export function installTouchMode({window: win = globalThis.window, document: doc = win?.document, getSetting = () => 'auto', size = null} = {}) {
  const root = doc.documentElement;
  const coarseQuery = win.matchMedia?.('(pointer: coarse)') ?? null;
  const override = readOverride(win.location?.search ?? '');
  const listeners = new Set();
  const abort = new AbortController();
  const measure = size ?? (() => {
    const app = doc.getElementById('app');
    // #app is the window (the shell never scrolls); before it lays out, the window itself.
    const width = app?.clientWidth || win.innerWidth, height = app?.clientHeight || win.innerHeight;
    return {width, height};
  });
  let state = null, measuredWidth = 0;

  /** A text field has the focus: an on-screen keyboard may be taking the window's height. */
  const typing = () => Boolean(doc.activeElement?.closest?.('input:not([type="range"], [type="checkbox"], [type="radio"], [type="color"], [type="button"]), textarea, [contenteditable="true"], [contenteditable=""]'));
  const compute = () => {
    const active = resolveTouch({setting: getSetting(), override, coarse: coarseQuery?.matches ?? false});
    const {width, height} = measure();
    const widthChanged = width !== measuredWidth;
    measuredWidth = width;
    // The keyboard rising under a field shrinks only the height: the layout stays as it was (an upright phone would
    // otherwise turn "landscape" mid-word and rearrange everything around the field).
    if (state?.active && active && !widthChanged && typing()) return {...state};
    return {active, ...formFactor(width, height)};
  };
  const write = next => {
    const attributes = touchAttributes(next);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null) delete root.dataset[name];
      else if (root.dataset[name] !== value) root.dataset[name] = value;
    }
  };
  const same = (a, b) => a && b && a.active === b.active && (!a.active || a.layout === b.layout);
  function refresh() {
    const next = compute(), previous = state;
    if (same(next, previous)) { state = next; return state; }
    state = next;
    write(state);
    for (const listener of [...listeners]) {
      try { listener(state, previous); } catch (error) { globalThis.reportError?.(error); }
    }
    return state;
  }

  coarseQuery?.addEventListener?.('change', refresh, {signal: abort.signal});
  win.addEventListener('resize', refresh, {signal: abort.signal});
  win.addEventListener('orientationchange', refresh, {signal: abort.signal});
  refresh();

  return {
    get state() { return state; },
    get active() { return Boolean(state?.active); },
    /** The override in the address, if any (the setting then shows but does not apply). */
    override,
    refresh,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { abort.abort(); listeners.clear(); },
  };
}
