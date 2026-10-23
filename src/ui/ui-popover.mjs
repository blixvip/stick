import {appendLocalized, localizedMarkup, localizedText, localizedAttribute} from '../localization-bindings.mjs';
/**
 * Anchored, non-modal panels (onion settings, Go to frame, the Document
 * popover, brush presets, …): a [popover] in the top layer with an optional
 * head (title and close), a scrolling body and an optional foot.
 *
 * The popover owns chrome, placement and dismissal only; the feature owns its
 * controls and what they commit. Opened from inside a modal it mounts inside
 * that dialog; opened from a popover or sheet it joins that host's popover
 * ancestry (showPopover with a source), so the host stays open.
 */
import {anchorWith, placeFloating} from './anchor-position.mjs';
import {focusFirst, overlayMount, showPopoverFrom} from './overlay-manager.mjs';
import {kitText} from './ui-strings.mjs';

let popoverCount = 0;
const FOCUSABLE = 'input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

const content = (doc, value) => (value === null || value === undefined ? null : typeof value === 'string' ? doc.createTextNode(value) : value);

/**
 * createPopover({anchor, placement, title, closeLabel, body, foot, dismiss,
 * returnFocus, mount, overlays, keyboardScope, label, className, cssAnchor,
 * topInset, onOpen, onClose, icon, t})
 *   body, foot   Nodes (or text); the feature keeps building them
 *   dismiss      'auto': light dismiss (outside click, Escape, another popover);
 *                'manual': only the close button, Escape or hide()
 *   cssAnchor    tether with CSS anchor positioning when available (follows the
 *                anchor while it scrolls); the default places it once, in JS
 *   keyboardScope  typing belongs to the popover (hotkeys stay off while open)
 *   closeLabel     the close button's name (default: common.close through `t`)
 *   titleKey, labelKey, closeLabelKey and their Params retain localized captions
 * Returns {element, body, show(), hide(reason), toggle(), update(), isOpen, signal}.
 */
export function createPopover({anchor, placement = 'bottom-start', title = '', titleKey, titleParams, closeLabel = null, closeLabelKey, closeLabelParams, body = null, foot = null, dismiss = 'auto',
  returnFocus = true, mount = 'auto', overlays = null, keyboardScope = false, label = '', labelKey, labelParams, className = '', cssAnchor = false, topInset = 0,
  onOpen = null, onClose = null, icon = null, t = null, document: doc = anchor?.ownerDocument ?? globalThis.document} = {}) {
  const id = `ui-popover-${++popoverCount}`;
  const element = doc.createElement('div');
  element.id = id;
  element.className = ['ui-popover', className].filter(Boolean).join(' ');
  element.popover = dismiss === 'manual' ? 'manual' : 'auto';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'false');
  if (title || titleKey) {
    const head = doc.createElement('div'), heading = doc.createElement('span');
    head.className = 'ui-popover-head';
    heading.className = 'ui-popover-title';
    heading.id = `${id}-title`;
    heading.textContent = title;
    if (titleKey) localizedText(heading, titleKey, titleParams);
    appendLocalized(head, heading);
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'ui-icon-button ui-popover-close';
    close.dataset.size = 'sm';
    close.setAttribute('aria-label', closeLabel ?? kitText(t, 'common.close'));
    if (closeLabelKey || closeLabel === null) localizedAttribute(close, 'aria-label', closeLabelKey ?? 'common.close', closeLabelParams);
    if (icon) { const glyph = icon('close'); if (typeof glyph === 'string') localizedMarkup(close, glyph); else if (glyph) appendLocalized(close, glyph); }
    else close.textContent = '×';
    close.addEventListener('click', () => hide('close-button'));
    appendLocalized(head, close);
    appendLocalized(element, head);
    element.setAttribute('aria-labelledby', heading.id);
  } else if (labelKey) localizedAttribute(element, 'aria-label', labelKey, labelParams);
  else if (label) element.setAttribute('aria-label', label);
  const bodyElement = doc.createElement('div');
  bodyElement.className = 'ui-popover-body';
  const bodyNode = content(doc, body);
  if (bodyNode) appendLocalized(bodyElement, bodyNode);
  appendLocalized(element, bodyElement);
  const footNode = content(doc, foot);
  if (footNode) {
    const footElement = doc.createElement('div');
    footElement.className = 'ui-popover-foot';
    appendLocalized(footElement, footNode);
    appendLocalized(element, footElement);
  }

  let open = false, controller = null, handle = null, untether = null, invoker = null;
  const anchorElement = anchor?.nodeType === 1 ? anchor : null;

  function update() {
    if (!open || untether) return;
    placeFloating(element, anchor, {placement, topInset, overlap: false});
  }

  function show() {
    // Removed with the dialog it was mounted in: nothing fired a toggle, so finish that session first.
    if (open && !element.isConnected) finish('disconnected');
    if (open) return;
    const host = mount === 'auto' ? overlayMount(anchorElement, doc) : mount;
    if (host && element.parentElement !== host) appendLocalized(host, element);
    invoker = doc.activeElement;
    showPopoverFrom(element, anchorElement);
    open = true;
    controller = new AbortController();
    const {signal} = controller;
    untether = cssAnchor && anchorElement ? anchorWith(anchorElement, element, {placement}) : null;
    update();
    // A body taller than its room scrolls, and says so (the "more below" fade; popover.css draws the scrollbar).
    const more = () => bodyElement.toggleAttribute('data-more-below', bodyElement.scrollHeight - bodyElement.scrollTop - bodyElement.clientHeight > 1);
    more();
    bodyElement.addEventListener('scroll', more, {passive: true, signal});
    anchorElement?.setAttribute('aria-expanded', 'true');
    element.addEventListener('toggle', event => { if (event.newState === 'closed' && open) finish('dismiss'); }, {signal});
    element.addEventListener('keydown', event => {
      if (keyboardScope) event.stopPropagation();
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      hide('escape');
    }, {signal});
    if (!untether) (doc.defaultView ?? globalThis).addEventListener('resize', update, {signal});
    handle = overlays?.register(element, {kind: 'popover', keyboardScope, invoker: anchorElement ?? invoker, returnFocus: false, closeOnEscape: false,
      onClose: (value, reason) => finish(reason)}) ?? null;
    // Focus the first control, never the close button when there is anything else.
    const controls = [...bodyElement.querySelectorAll(FOCUSABLE), ...element.querySelectorAll(`.ui-popover-foot :is(${FOCUSABLE})`)];
    (controls[0] ?? element.querySelector('.ui-popover-close'))?.focus({preventScroll: true});
    onOpen?.();
  }

  function finish(reason) {
    if (!open) return;
    open = false;
    const hadFocus = element.contains(doc.activeElement);
    controller.abort();
    untether?.();
    untether = null;
    try { if (element.matches(':popover-open')) element.hidePopover(); } catch { /* already hidden */ }
    anchorElement?.setAttribute('aria-expanded', 'false');
    const returnTo = handle?.returnTo ?? [];
    handle?.close(undefined, reason);
    handle = null;
    // Escape and the close button hand focus back; a click elsewhere keeps its own focus, and so
    // does closing along with a dialog (that dialog returns focus). A hidden or removed anchor
    // hands over to what opened its overlay, then the stage.
    const passive = reason === 'dismiss' || reason === 'parent-closed' || reason === 'disconnected';
    if (returnFocus && (!passive || hadFocus && (doc.activeElement === doc.body || !doc.activeElement)))
      focusFirst([anchorElement, invoker, ...returnTo, overlays?.fallbackFocus?.()], {document: doc});
    onClose?.(reason);
  }

  function hide(reason = 'hide') { finish(reason); }

  return {
    element, body: bodyElement, show, hide, update,
    toggle() { if (open) hide('toggle'); else show(); },
    get isOpen() { return open; },
    get signal() { return controller?.signal ?? null; },
  };
}
