import {t as interfaceText} from '../localization.mjs';
import {appendLocalized, localizedAttribute} from '../localization-bindings.mjs';
/**
 * The touch interface's own chrome (docs/TOUCH.md). The stylesheets
 * (layout/touch.css, features/touch.css) arrange the editor's regions for
 * each touch layout; this module adds what they cannot:
 *
 * - The tab bar of a phone held upright: the workspace switch and the band's
 *   Properties button move into it, under the thumb, and back into the band
 *   in every other layout. They are moved, never copied, so their handlers,
 *   state and names stay the one implementation (a comment marks each one's
 *   home in the band).
 * - The stage header's view toggles folded into its View menu on a phone
 *   (stage-head.mjs setViewMenu).
 * - Sheets under a finger: a bottom sheet's grip resizes it to a resting
 *   height (SHEET_DETENTS) or closes it; a side sheet swipes shut toward its
 *   edge.
 * - The page's own pinch kept off the editor (Safari's `gesture*` events).
 *   Double-tap zoom, pull to refresh and the rubber band are CSS
 *   (touch-action, overscroll-behavior).
 *
 * installTouchShell({touch}) follows the touch mode's changes; `destroy()`
 * puts everything back.
 */

import {swallowNextClick} from './long-press.mjs';

const TABBAR_ITEMS = Object.freeze(['.band-center > .workspace-switch', '.shell-sheet-button']);
/** A bottom sheet's resting heights, as shares of the room above the tab bar; under the smallest share, a release closes it. */
export const SHEET_DETENTS = Object.freeze([0.42, 0.62, 0.92]);
const SHEET_CLOSE = 0.3;
/** Surfaces whose touches the editor follows itself (touch-action: none): the browser makes no gesture of them. */
const OWN_GESTURES = '#viewport, .sheet-scroll, .sheet-labels';
/** How far a finger must move before a press on a sheet's grip becomes a drag (px), and how far a side sheet must travel to close. */
const SHEET_SLOP = 8, SIDE_CLOSE = 72;

/** The detent nearest `share` of the room, or null (close) under SHEET_CLOSE. Pure. */
export function sheetDetent(share, detents = SHEET_DETENTS) {
  if (!(share >= SHEET_CLOSE)) return null;
  return detents.reduce((best, value) => (Math.abs(value - share) < Math.abs(best - share) ? value : best), detents[0]);
}

/**
 * Which way a sheet moves under a finger in a layout: 'down' for sheets that rise from the bottom edge (the
 * inspector on an upright phone, the timeline body everywhere), 'right' or 'left' for sheets along a side.
 */
export function sheetAxis(sheet, layout) {
  if (sheet.classList.contains('shell-timeline-body')) return 'down';
  if (layout === 'phone-portrait') return 'down';
  return sheet.dataset.side === 'left' ? 'left' : 'right';
}

/** Moves nodes into a host and back to where they were, marking each home with a comment. */
function createMover(doc) {
  const homes = new Map();
  return {
    move(node, host) {
      if (!node || node.parentNode === host) return;
      if (!homes.has(node)) {
        const mark = doc.createComment(" touch: moved to the tab bar ");
        node.before(mark);
        homes.set(node, mark);
      }
      appendLocalized(host, node);
    },
    restore() {
      for (const [node, mark] of homes) {
        if (mark.isConnected) mark.replaceWith(node);
      }
      homes.clear();
    },
  };
}

export function installTouchShell({touch, stageHead = null, shell = null, document: doc = globalThis.document, window: win = globalThis.window} = {}) {
  const app = doc.getElementById('app');
  const workspace = app?.querySelector('.workspace');
  const abort = new AbortController(), signal = abort.signal;
  const mover = createMover(doc);
  let tabbar = null;

  const ensureTabbar = () => {
    if (tabbar) return tabbar;
    tabbar = doc.createElement('nav');
    tabbar.className = 'touch-tabbar';
    localizedAttribute(tabbar, 'aria-label', "touchShell.workspacesAndPanels", {});
    return tabbar;
  };

  function apply(state) {
    const layout = state?.active ? state.layout : null;
    // A phone's stage header has no room for the view toggles: they fold into its View menu.
    stageHead?.setViewMenu?.(Boolean(state?.active && state.form === 'phone'));
    if (layout === 'phone-portrait') {
      const bar = ensureTabbar();
      if (!bar.isConnected) workspace.after(bar);
      for (const selector of TABBAR_ITEMS) mover.move(app.querySelector(selector), bar);
      tabbarSize.observe(bar);
    } else {
      mover.restore();
      if (tabbar) tabbarSize.unobserve(tabbar);
      tabbar?.remove();
      doc.documentElement.style.removeProperty('--touch-tabbar-inset');
    }
  }

  // Safari pinches the page with its own gesture events; the canvas has its own pinch (canvas-pinch.mjs).
  const blockPageGesture = event => { if (touch?.active) event.preventDefault(); };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) doc.addEventListener(type, blockPageGesture, {signal, passive: false});
  // A quick second tap never zooms the page: the stylesheet sets `touch-action: manipulation` on the chrome, which
  // every touch browser honours; cancelling the second touch here would also cancel its click.

  // The tab bar's height, for the sheets that stop above it (features/touch.css).
  const root = doc.documentElement;
  const tabbarSize = new win.ResizeObserver(() => {
    const height = tabbar?.isConnected ? Math.round(tabbar.getBoundingClientRect().height) : 0;
    root.style.setProperty('--touch-tabbar-inset', `${height}px`);
  });

  // ---- Sheets under a finger: drag a bottom sheet's grip to resize it (it rests at a detent) or down to close
  // it; swipe a side sheet toward its edge to close it. The grip is the sheet's top band and its tab row.
  let drag = null;
  const room = sheet => {
    const top = sheet.classList.contains('shell-timeline-body') ? 0 : (win.visualViewport?.offsetTop ?? 0);
    const bottomInset = parseFloat(win.getComputedStyle(sheet).insetBlockEnd) || 0;
    return Math.max(1, win.innerHeight - top - bottomInset);
  };
  const onGrip = (sheet, event, axis) => {
    if (event.target.closest('input, textarea, select, [contenteditable]')) return false;
    const box = sheet.getBoundingClientRect();
    if (axis === 'down' && event.clientY - box.top <= 32) return true;
    return Boolean(event.target.closest('.shell-tabs, .ui-popover-head, .shell-sheet-grip'));
  };
  doc.addEventListener('pointerdown', event => {
    if (!touch?.active || drag || event.button > 0) return;
    const sheet = event.target.closest?.('.shell-sheet:popover-open, .shell-timeline-body:popover-open');
    if (!sheet) return;
    const axis = sheetAxis(sheet, touch.state.layout);
    if (!onGrip(sheet, event, axis)) return;
    const box = sheet.getBoundingClientRect();
    drag = {sheet, axis, id: event.pointerId, x: event.clientX, y: event.clientY, height: box.height, moved: false, delta: 0};
  }, {capture: true, passive: true, signal});
  doc.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const along = drag.axis === 'down' ? event.clientY - drag.y : drag.axis === 'right' ? event.clientX - drag.x : drag.x - event.clientX;
    const across = drag.axis === 'down' ? event.clientX - drag.x : event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(along) < SHEET_SLOP || Math.abs(across) > Math.abs(along)) {
        if (Math.abs(across) >= SHEET_SLOP) drag = null;
        return;
      }
      drag.moved = true;
      drag.sheet.setAttribute('data-dragging', '');
      try { drag.sheet.setPointerCapture(event.pointerId); } catch { /* the pointer already left */ }
    }
    drag.delta = along;
    if (drag.axis === 'down' && !drag.sheet.classList.contains('shell-timeline-body')) {
      const height = Math.max(80, Math.min(room(drag.sheet) * SHEET_DETENTS.at(-1), drag.height - along));
      drag.sheet.style.setProperty('--touch-sheet-h', `${Math.round(height)}px`);
    } else {
      const offset = Math.max(0, along);
      drag.sheet.style.translate = drag.axis === 'down' ? `0 ${offset}px` : `${drag.axis === 'right' ? offset : -offset}px 0`;
    }
  }, {capture: true, passive: true, signal});
  const release = event => {
    if (drag?.id !== event.pointerId) return;
    const {sheet, axis, moved, delta, height} = drag;
    drag = null;
    if (!moved) return;
    sheet.removeAttribute('data-dragging');
    sheet.style.translate = '';
    swallowNextClick(doc, {pointerId: event.pointerId});
    const body = sheet.classList.contains('shell-timeline-body');
    if (axis === 'down' && !body) {
      const detent = sheetDetent((height - delta) / room(sheet));
      if (detent === null) { sheet.style.removeProperty('--touch-sheet-h'); shell?.closeSheets?.(); return; }
      sheet.style.setProperty('--touch-sheet-h', `${Math.round(detent * room(sheet))}px`);
      return;
    }
    const limit = axis === 'down' ? Math.min(120, sheet.getBoundingClientRect().height / 3) : SIDE_CLOSE;
    if (delta > limit) shell?.closeSheets?.();
  };
  doc.addEventListener('pointerup', release, {capture: true, signal});
  doc.addEventListener('pointercancel', release, {capture: true, signal});
  // Surfaces that follow a finger themselves (a sheet being dragged, the canvas, the Advanced timeline's grid and names)
  // leave the browser no gesture to make of the touch: Chrome would otherwise start a fling on release, even though
  // nothing scrolls, and swallow the next tap to stop it.
  doc.addEventListener('touchmove', event => {
    if (!touch?.active || !event.cancelable) return;
    if (drag?.moved || event.target.closest?.(OWN_GESTURES)) event.preventDefault();
  }, {passive: false, signal});

  const stop = touch?.on?.(state => apply(state));
  apply(touch?.state);

  return {
    get tabbar() { return tabbar; },
    destroy() {
      abort.abort();
      tabbarSize.disconnect();
      stop?.();
      mover.restore();
      tabbar?.remove();
    },
  };
}
