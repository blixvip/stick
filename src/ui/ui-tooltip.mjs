import {replaceLocalized, appendLocalized} from '../localization-bindings.mjs';
import {interfaceLocalization} from '../localization.mjs';

/**
 * The one tooltip: an ink pill with a control's name and, as plain text after
 * a middle dot, its shortcut ("Undo · Ctrl+Z"). It shows after a delay, then
 * instantly while moving between neighbours; it is never interactive, never
 * covers its invoker and is one element for the whole window.
 *
 * The name comes from data-tooltip, then data-hotkey-title, then aria-label;
 * the shortcut from the provided `shortcut(element)` (the command registry),
 * else data-hotkey-hint. Accessible names never include the shortcut; the
 * tooltip is linked with aria-describedby only while it is shown. On devices
 * without hover (touch) it appears for keyboard focus only. A control with a
 * native `title` and no data-tooltip keeps its native tip instead, except
 * inside `adopt` (the chrome): there its title becomes its data-tooltip the
 * first time it is pointed at or focused (and its name, when it had none), so
 * neighbours never show two tooltip styles. Beside a vertical toolbar (the
 * rail, a strip) the tooltip opens on the stage's side instead of above,
 * where it would cover the neighbouring tool.
 */
import {placeFloating} from './anchor-position.mjs';

export const TOOLTIP_SELECTOR = '[data-tooltip], [data-hotkey-title], button[aria-label], [role="button"][aria-label], [role="tab"][aria-label]';

/** The text a tooltip shows for `element`, or null when it would add nothing. */
export function tooltipContent(element, {shortcut = null} = {}) {
  if (!element || element.dataset?.tooltip === '') return null;
  // Markup whose native title still carries its tip (until that surface moves
  // to data-tooltip) keeps it: one tooltip, never two.
  if (!element.dataset?.tooltip && element.getAttribute?.('title')) return null;
  const label = (element.dataset?.tooltip || element.dataset?.hotkeyTitle || element.getAttribute?.('aria-label') || '').trim();
  const keys = String(shortcut?.(element) ?? element.dataset?.hotkeyHint ?? '').trim();
  if (!label && !keys) return null;
  // A visible label that already says the name, with no shortcut to add: no tooltip.
  if (!keys && label === (element.textContent ?? '').trim()) return null;
  return {label, shortcut: keys};
}

/** How long to wait before showing: `delay`, or 0 right after another tooltip hid (moving between neighbours). */
export function tooltipDelay({now, lastHiddenAt = -Infinity, delay = 500, skipDelay = 300}) {
  return now - lastHiddenAt < skipDelay ? 0 : delay;
}

/**
 * Delegated tooltips for everything under `root` that matches `selector`.
 * Returns {element, show(target), hide()}; `signal` removes the listeners and
 * the element.
 */
export function installTooltips(root = globalThis.document, {selector = TOOLTIP_SELECTOR, delay = 500, skipDelay = 300, shortcut = null,
  topInset = 0, adopt = null, signal, now = () => globalThis.performance?.now() ?? Date.now(), hoverless = null} = {}) {
  const doc = root.ownerDocument ?? root, view = doc.defaultView ?? globalThis;
  const element = doc.createElement('div');
  element.id = 'ui-tooltip';
  element.className = 'ui-tooltip';
  element.setAttribute('role', 'tooltip');
  element.popover = 'hint';
  if (element.popover !== 'hint') element.popover = 'manual';   // before popover="hint" (Chromium 133)
  appendLocalized(doc.body, element);
  const noHover = hoverless ?? view.matchMedia?.('(hover: none)');
  let target = null, timer = 0, lastHiddenAt = -Infinity, describedBy = null;

  const unlink = () => {
    if (!target) return;
    if (describedBy) target.setAttribute('aria-describedby', describedBy); else target.removeAttribute('aria-describedby');
    describedBy = null;
  };
  const hide = () => {
    clearTimeout(timer);
    timer = 0;
    if (!target) return;
    unlink();
    target = null;
    lastHiddenAt = now();
    try { if (element.matches(':popover-open')) element.hidePopover(); } catch { /* already hidden */ }
  };
  const part = (className, text) => {
    const span = doc.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  };
  const show = (next, refresh = false) => {
    const text = tooltipContent(next, {shortcut});
    if (!text || !next.isConnected) { hide(); return; }
    if (!refresh && next === target && element.matches(':popover-open')) return;   // already showing for it (hover, then focus)
    if (next !== target) {
      unlink();
      target = next;
      // The target's own descriptions, without ours: they come back when the tooltip hides.
      describedBy = (next.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== element.id).join(' ');
      next.setAttribute('aria-describedby', [describedBy, element.id].filter(Boolean).join(' '));
    }
    // Separate parts, so the pill's gap spaces both sides of the dot: "Undo · Ctrl+Z".
    replaceLocalized(element, part('ui-tooltip-label', text.label || text.shortcut));
    if (text.label && text.shortcut) {
      const dot = part('ui-tooltip-sep', '·');
      dot.setAttribute('aria-hidden', 'true');
      appendLocalized(element, dot, part('ui-tooltip-key', text.shortcut));
    }
    try { if (!element.matches(':popover-open')) element.showPopover(); } catch { hide(); return; }
    placeFloating(element, next, {placement: placementFor(next), offset: 6, fit: false, overlap: false, topInset, sheet: false});
  };
  /** Above the control; beside a vertical toolbar, on the side facing the middle of the window. */
  const placementFor = next => {
    if (!next.closest('[aria-orientation="vertical"], .shell-rail')) return 'top';
    const box = next.getBoundingClientRect();
    return box.left + box.width / 2 > (view.innerWidth || 0) / 2 ? 'left' : 'right';
  };
  /** A chrome control's native title becomes its data-tooltip (see the module comment). */
  const adoptTitle = node => {
    if (!adopt) return;
    const titled = node?.closest?.('[title]');
    if (!titled || !titled.closest(adopt) || titled.closest('#ui-tooltip')) return;
    const text = titled.getAttribute('title').trim();
    if (text && !titled.hasAttribute('aria-label') && !titled.hasAttribute('aria-labelledby') && !titled.textContent.trim()) titled.setAttribute('aria-label', text);
    if (text) titled.dataset.tooltip = text;
    titled.removeAttribute('title');
  };
  const schedule = next => {
    clearTimeout(timer);
    const wait = tooltipDelay({now: now(), lastHiddenAt: target ? now() : lastHiddenAt, delay, skipDelay});
    if (!wait) { show(next); return; }
    timer = setTimeout(() => show(next), wait);
  };
  const matching = node => node?.closest?.(selector) ?? null;

  root.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch' || noHover?.matches) return;
    adoptTitle(event.target);
    const next = matching(event.target);
    if (!next || next === target) return;
    if (!tooltipContent(next, {shortcut})) { hide(); return; }
    schedule(next);
  }, {signal});
  root.addEventListener('pointerout', event => {
    const current = target ?? matching(event.target);
    if (current && !current.contains(event.relatedTarget)) {
      if (target) hide(); else { clearTimeout(timer); timer = 0; }
    }
  }, {signal});
  root.addEventListener('focusin', event => {
    adoptTitle(event.target);
    const next = matching(event.target);
    if (!next || !next.matches?.(':focus-visible')) return;
    schedule(next);
  }, {signal});
  root.addEventListener('focusout', () => hide(), {signal});
  root.addEventListener('pointerdown', () => hide(), {capture: true, signal});
  root.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, {capture: true, signal});
  doc.addEventListener('scroll', () => hide(), {capture: true, signal});
  const unsubscribe = interfaceLocalization.subscribe(() => { if (target) show(target, true); });
  signal?.addEventListener('abort', () => { unsubscribe(); hide(); element.remove(); }, {once: true});
  return {element, show, hide, destroy() { unsubscribe(); hide(); element.remove(); }};
}
