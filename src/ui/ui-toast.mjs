import {interfaceLocalization} from '../localization.mjs';
import {replaceLocalized, appendLocalized, localizedText, localizedAttribute, clearTranslation} from '../localization-bindings.mjs';
import {errorText} from '../error-presentation.mjs';
import {messageError, errorMessageData} from '../localized-error.mjs';

/**
 * Messages: the stage's one message slot. A toast is a short white pill with
 * an optional action (Undo, Restore, Show) and a dismiss button when it
 * persists; a task toast shows progress and can be cancelled.
 *
 * One message is visible at a time. Priority decides which: error, recovery,
 * a pick mode's instruction, update, toast, then the first-run hint; a higher
 * one takes the slot at once and a persistent one it displaces waits. At most
 * `max` wait; identical messages are merged. Timeouts pause while the pointer
 * or focus is on the message. The host is a manual [popover] in the top layer.
 * While a modal dialog is open the host lives inside the topmost one (the rest
 * of the page is inert, so a message outside it could be seen but not clicked)
 * and sits outside the dialog's box; it goes back when that dialog closes.
 * Otherwise `slot` places it (the stage header's centre, src/shell/
 * stage-head.mjs), or it sits at the bottom centre of the stage, moved clear
 * of the controls `avoid()` names. createMessageQueue() is the pure part.
 *
 * Screen readers hear each message once, from a visually hidden live region
 * that is always rendered (the pill itself is not a live region: it appears
 * already filled, and under a modal it is inert). While a modal dialog is open
 * the message is announced from a region inside that dialog instead.
 */
import {UserActionError} from '../user-action-error.mjs';
import {kitText} from './ui-strings.mjs';

export const MESSAGE_PRIORITY = Object.freeze({hint: 0, toast: 1, update: 2, mode: 3, recovery: 4, error: 5});

/**
 * The slot's queue. push(message) returns {show, displaced, duplicate,
 * dropped}; next() moves the best waiting message into the slot. Messages are
 * {id, key, slot, persistent}: `key` identifies duplicates, `slot` is a
 * MESSAGE_PRIORITY name, persistent messages survive being displaced.
 */
export function createMessageQueue({max = 3} = {}) {
  let current = null;
  const waiting = [];
  const rank = message => MESSAGE_PRIORITY[message.slot] ?? MESSAGE_PRIORITY.toast;
  const insert = message => {
    const index = waiting.findIndex(other => rank(other) < rank(message));
    waiting.splice(index < 0 ? waiting.length : index, 0, message);
    // Over the limit, the lowest-priority, newest waiting message goes.
    return waiting.length > max ? waiting.pop() : null;
  };
  return {
    push(message) {
      const duplicate = [current, ...waiting].find(other => other && other.key === message.key);
      if (duplicate) return {show: null, displaced: null, duplicate, dropped: null};
      if (!current) { current = message; return {show: message, displaced: null, duplicate: null, dropped: null}; }
      if (rank(message) > rank(current)) {
        const displaced = current;
        current = message;
        const dropped = displaced.persistent ? insert(displaced) : displaced;
        return {show: message, displaced, duplicate: null, dropped};
      }
      return {show: null, displaced: null, duplicate: null, dropped: insert(message)};
    },
    /** Ends `id` (the current message or a waiting one); returns the message that now shows, if it changed. */
    remove(id) {
      const index = waiting.findIndex(message => message.id === id);
      if (index >= 0) { waiting.splice(index, 1); return null; }
      if (current?.id !== id) return null;
      current = waiting.shift() ?? null;
      return current;
    },
    get current() { return current; },
    get waiting() { return [...waiting]; },
  };
}

const TIMEOUTS = Object.freeze({info: 4000, success: 4000, warning: 6000, error: 0});
// A region filled in the same task it was created or emptied in is often not read; write a moment later.
const ANNOUNCE_DELAY = 60;
let toastCount = 0;

/** The tone glyphs a message shows when it names none (components.md "Message"). */
const TONE_ICONS = Object.freeze({success: 'check', error: 'alert', warning: 'warning'});
/** The gap between the message and what it stays clear of. */
const GAP = 8;

const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * createToasts({host, overlays, icon, area, avoid, topInset, document})
 *   host      the element that holds the message (the #toast compatibility
 *             host); created when absent
 *   overlays  the OverlayManager: the host moves into every modal it opens
 *   icon      (name) => SVG string or Node, for the dismiss and tone glyphs
 *   area      () => DOMRect of the stage: the message sits bottom-centre in it
 *   avoid     () => DOMRects the message must not cover there: it moves
 *             left of them, else above them
 *   slot      {place({width, height}) => {x, top, place} | null, release()}:
 *             the message's own place (the stage header's centre, or a line of
 *             its own under it: place 'head' or 'drop'); null falls back to
 *             `area`. release() runs when the message leaves the slot
 *   topInset  () => px: the band's bottom, which a message never goes above
 *   feedback  {label, run(error)}: the extra action on unexpected errors (desktop)
 *   t         (key, params) => text for the kit's own words (localization.t)
 * Returns {host, live, show(options), task(options), fail(error), dismiss(id),
 * clear({tones}), raise(), reposition(), announce(text, {assertive})}.
 * show({variant}) draws the revision 4 kinds: 'mode' (a pick mode's
 * instruction) and 'quiet' ("Slow · 14 of 24 fps"); a handle's
 * update({title, message}) rewrites a shown message's words in place, without
 * announcing it again.
 */
export function createToasts({host = null, overlays = null, icon = null, area = null, avoid = null, slot = null, topInset = null, feedback = null, max = 3, t = null,
  document: doc = host?.ownerDocument ?? globalThis.document, setTimer = setTimeout, clearTimer = clearTimeout,
  now = () => globalThis.performance?.now() ?? Date.now()} = {}) {
  const element = host ?? doc.createElement('div');
  if (!host) appendLocalized(doc.body, element);
  // Where the host lives while no modal dialog is open.
  const home = element.parentNode ?? doc.body;
  element.classList.add('ui-toast-host');
  if (!element.hasAttribute('popover')) element.popover = 'manual';
  // The host is not a live region (role=status would make it one): every message is read once, from `live`.
  element.removeAttribute('aria-live');
  if (['status', 'alert', 'log'].includes(element.getAttribute('role'))) element.removeAttribute('role');
  const queue = createMessageQueue({max});
  const records = new Map();
  let visible = null, announceTimer = 0;

  // Visually hidden live regions, rendered from the start so that later text is read.
  const liveRegion = (parent, assertive) => {
    const region = doc.createElement('div');
    region.className = 'ui-toast-live';
    region.setAttribute('role', assertive ? 'alert' : 'status');
    region.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    region.setAttribute('aria-atomic', 'true');
    appendLocalized(parent, region);
    return region;
  };
  const live = {polite: liveRegion(doc.body, false), assertive: liveRegion(doc.body, true)};
  const topModal = () => {
    const known = overlays?.top?.(['dialog'])?.element;
    if (known?.open && known.matches?.(':modal') !== false) return known;
    const open = [...(doc.querySelectorAll?.('dialog[open]') ?? [])];
    return open.findLast(dialog => { try { return dialog.matches(':modal'); } catch { return true; } }) ?? null;
  };
  /** Reads `text` to screen readers once; from inside the top modal dialog while one is open (the rest of the page is inert). */
  const announce = (text, {assertive = false} = {}) => {
    if (!text) return;
    const modal = topModal();
    const selector = `:scope > .ui-toast-live[aria-live="${assertive ? 'assertive' : 'polite'}"]`;
    const region = modal ? modal.querySelector(selector) ?? liveRegion(modal, assertive) : assertive ? live.assertive : live.polite;
    for (const other of [live.polite, live.assertive]) if (other !== region) other.textContent = '';
    region.textContent = '';
    clearTimer(announceTimer);
    announceTimer = setTimer(() => { announceTimer = 0; region.textContent = text; }, ANNOUNCE_DELAY);
  };

  const glyph = (parent, name, className) => {
    const value = icon?.(name);
    if (!value) return;
    if (typeof value === 'string') { parent.insertAdjacentHTML('beforeend', value); parent.lastElementChild?.classList.add(...className.split(' ')); }
    else { value.classList?.add(...className.split(' ')); appendLocalized(parent, value); }
  };
  /** Keeps the host inside the topmost modal dialog while one is open (outside it the message would be inert), else at home. */
  const relocate = () => {
    const parent = topModal() ?? home;
    if (element.parentNode === parent || !parent) return;
    appendLocalized(parent, element);   // a shown popover that moves is hidden; the caller shows it again
  };
  /**
   * Places the shown message: outside an open modal's box (above it, else
   * below it, else under the band), otherwise bottom-centre of the stage,
   * moved left of whatever `avoid()` names there, else above it.
   */
  const place = () => {
    const view = doc.defaultView ?? globalThis;
    const pill = element.querySelector(':scope > .ui-toast');
    const modal = element.parentNode !== home ? element.parentNode : null;
    if (slot && !modal && pill) {
      // Measured at its whole width (the band centred on the window), then placed where the slot says.
      for (const name of ['--toast-x', '--toast-top', '--toast-bottom']) element.style.removeProperty(name);
      element.removeAttribute('data-place');
      const spot = slot.place({width: pill.offsetWidth, height: pill.offsetHeight});
      if (spot) {
        element.dataset.place = spot.place;
        element.style.setProperty('--toast-x', `${Math.round(spot.x)}px`);
        element.style.setProperty('--toast-top', `${Math.round(spot.top)}px`);
        return;
      }
    }
    slot?.release?.();
    element.removeAttribute('data-place');
    element.style.removeProperty('--toast-top');
    const width = pill?.offsetWidth ?? 0, height = pill?.offsetHeight ?? 0;
    let x, bottom;
    if (modal?.getBoundingClientRect) {
      const box = modal.getBoundingClientRect(), top = Math.max(0, Number(topInset?.()) || 0);
      x = box.left + box.width / 2;
      if (box.top - GAP - height >= top + GAP) bottom = view.innerHeight - box.top + GAP;
      else if (box.bottom + GAP + height <= view.innerHeight - GAP) bottom = view.innerHeight - box.bottom - GAP - height;
      else bottom = view.innerHeight - top - GAP - height;
    } else {
      const rect = area?.();
      if (!rect) { element.style.removeProperty('--toast-x'); element.style.removeProperty('--toast-bottom'); return; }
      x = rect.left + rect.width / 2;
      bottom = view.innerHeight - rect.bottom + GAP;
      for (const obstacle of avoid?.() ?? []) {
        if (!(obstacle?.width > 0 && obstacle.height > 0)) continue;
        const own = {left: x - width / 2, right: x + width / 2, top: view.innerHeight - bottom - height, bottom: view.innerHeight - bottom};
        if (!intersects(own, obstacle)) continue;
        const shifted = obstacle.left - GAP - width / 2;
        if (shifted - width / 2 >= rect.left + GAP) x = shifted;
        else bottom = view.innerHeight - obstacle.top + GAP;
      }
    }
    element.style.setProperty('--toast-x', `${Math.round(x)}px`);
    element.style.setProperty('--toast-bottom', `${Math.round(bottom)}px`);
  };
  const openHost = () => {
    element.removeAttribute('hidden');
    relocate();
    try { if (!element.matches(':popover-open')) element.showPopover(); } catch { /* not connected */ }
    place();
  };
  const closeHost = () => {
    try { if (element.matches(':popover-open')) element.hidePopover(); } catch { /* already hidden */ }
    element.setAttribute('hidden', '');
    replaceLocalized(element);
    element.removeAttribute('data-place');
    slot?.release?.();
    relocate();
  };
  /** After a modal opened or closed: the host moves into (or out of) it and goes to the top of the top layer. */
  const raise = () => {
    if (!visible) { relocate(); return; }
    relocate();
    try {
      if (element.matches(':popover-open')) element.hidePopover();
      element.showPopover();
    } catch { /* not connected */ }
    place();
  };
  overlays?.addEventListener('open', event => { if (event.detail.modal || event.detail.kind === 'dialog') raise(); });
  overlays?.addEventListener('close', event => { if (event.detail.kind === 'dialog') raise(); });
  // Dialogs that feature modules open and close themselves, without the manager, move it too.
  doc.addEventListener?.('toggle', event => { if (event.target?.localName === 'dialog') raise(); }, {capture: true});
  doc.addEventListener?.('close', event => { if (event.target?.localName === 'dialog') raise(); }, {capture: true});

  // The verb or subject in bold, then the rest: "<b>Restore unsaved work</b> from 12:04?"
  const writeText = (node, record) => {
    const {title, message, titleKey, titleParams, messageKey, messageParams} = record;
    replaceLocalized(node);
    if (title) { const strong = doc.createElement('b'); strong.textContent = title; if (titleKey) localizedText(strong, titleKey, titleParams); appendLocalized(node, strong); }
    if (message) {
      if (title) appendLocalized(node, doc.createTextNode(' '));
      const caption = doc.createTextNode(message);
      if (messageKey) localizedText(caption, messageKey, messageParams);
      appendLocalized(node, caption);
    }
  };
  const render = record => {
    const node = doc.createElement('div');
    node.className = 'ui-toast';
    if (record.tone === 'success') node.dataset.tone = 'success';
    if (record.tone === 'error') node.dataset.tone = 'danger';
    if (record.tone === 'warning') node.dataset.tone = 'warning';
    if (record.task) node.dataset.variant = 'task';
    else if (record.variant) node.dataset.variant = record.variant;
    if (record.slot === 'hint') { const dot = doc.createElement('span'); dot.className = 'ui-toast-dot'; appendLocalized(node, dot); }
    else if (record.icon) glyph(node, record.icon, 'ui-icon ui-toast-icon');
    const text = doc.createElement('span');
    text.className = 'ui-toast-text';
    writeText(text, record);
    appendLocalized(node, text);
    if (record.task) {
      const bar = doc.createElement('div');
      bar.className = 'ui-toast-progress';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', record.title || record.message);
      if (record.titleKey || record.messageKey) localizedAttribute(bar, 'aria-label', record.titleKey || record.messageKey, record.titleKey ? record.titleParams : record.messageParams);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      appendLocalized(node, bar);
      record.bar = bar;
      paintProgress(record);
    }
    for (const action of record.actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ui-button ui-toast-action';
      button.dataset.variant = action.variant ?? 'ghost';
      button.dataset.size = 'sm';
      if (action.command) button.dataset.action = action.command;
      button.textContent = action.label;
      if (action.labelKey) localizedText(button, action.labelKey, action.labelParams);
      if (action.tip) button.dataset.tooltip = action.tip;
      if (action.id) button.id = action.id;
      button.addEventListener('click', event => {
        if (!action.command) event.stopPropagation();
        try { action.run?.(event); } finally { if (action.dismiss !== false) dismiss(record.id); }
      });
      appendLocalized(node, button);
    }
    if (record.dismissible) {
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'ui-icon-button ui-toast-close';
      close.dataset.size = 'sm';
      close.setAttribute('aria-label', record.dismissLabel);
      if (record.dismissLabelKey) localizedAttribute(close, 'aria-label', record.dismissLabelKey);
      glyph(close, 'close', 'ui-icon');
      if (!close.firstChild) close.textContent = '×';
      close.addEventListener('click', event => { event.stopPropagation(); dismiss(record.id); });
      appendLocalized(node, close);
    }
    // Hover and focus pause the timeout; leaving resumes it with the time left.
    const pause = () => { if (record.timer) { clearTimer(record.timer); record.timer = 0; record.remaining = Math.max(0, record.deadline - now()); } };
    const resume = () => { if (!record.timer && record.remaining > 0 && !node.matches(':hover') && !node.contains(doc.activeElement)) arm(record, record.remaining); };
    node.addEventListener('pointerenter', pause);
    node.addEventListener('focusin', pause);
    node.addEventListener('pointerleave', resume);
    node.addEventListener('focusout', () => setTimer(resume, 0));
    record.node = node;
    return node;
  };
  const arm = (record, ms) => {
    clearTimer(record.timer);
    record.timer = 0;
    if (!(ms > 0)) return;
    record.deadline = now() + ms;
    record.remaining = ms;
    record.timer = setTimer(() => dismiss(record.id), ms);
  };
  const present = record => {
    if (visible && visible !== record) { clearTimer(visible.timer); visible.timer = 0; visible.remaining = Math.max(0, (visible.deadline ?? 0) - now()); }
    visible = record;
    replaceLocalized(element, render(record));
    openHost();
    arm(record, record.remaining ?? record.timeout);
    if (!record.announced) {
      record.announced = true;
      announce([record.title, record.message].filter(Boolean).join(' '), {assertive: record.tone === 'error'});
    }
  };
  const dismiss = id => {
    const record = records.get(id);
    if (!record) return;
    records.delete(id);
    clearTimer(record.timer);
    record.onDismiss?.();
    const next = queue.remove(id);
    if (visible === record) {
      visible = null;
      if (next) present(records.get(next.id)); else closeHost();
    }
  };

  function show({message = '', title = '', tone = 'info', slot: rank = null, variant = null, action = null, actions = null, timeout = null, dismissible = null,
    icon: iconName = null, key = null, dismissLabel = null, onDismiss = null, task = false,
    messageKey = null, messageParams = {}, titleKey = null, titleParams = {}} = {}) {
    const list = actions ?? (action ? [action] : []);
    const record = {
      id: `toast-${++toastCount}`, messageKey, messageParams, titleKey, titleParams, dismissLabelKey: dismissLabel === null ? 'overlays.dismiss' : null, message: String(message), title: String(title), tone, task, variant, actions: list, onDismiss,
      dismissLabel: dismissLabel ?? kitText(t, 'overlays.dismiss'),
      slot: rank ?? (tone === 'error' ? 'error' : 'toast'),
      // Errors and tasks stay until dismissed or done; an action earns a message more time to be read.
      timeout: timeout ?? (task || tone === 'error' ? 0 : Math.max(list.length ? 8000 : 0, TIMEOUTS[tone] ?? 4000)),
      icon: iconName ?? TONE_ICONS[tone] ?? null,
      progress: null, timer: 0, remaining: null,
    };
    record.key = key ?? `${tone}|${titleKey ?? record.title}|${messageKey ?? record.message}|${JSON.stringify(messageParams)}`;
    record.dismissible = dismissible ?? (record.timeout === 0 && !task);
    record.persistent = record.timeout === 0;
    const outcome = queue.push(record);
    if (outcome.duplicate) {
      const existing = records.get(outcome.duplicate.id) ?? outcome.duplicate;
      if (existing === visible) arm(existing, existing.timeout);   // the same message again: show it for longer
      return handleFor(existing);
    }
    records.set(record.id, record);
    if (outcome.dropped) { records.delete(outcome.dropped.id); outcome.dropped.onDismiss?.(); }
    if (outcome.show) present(record);
    return handleFor(record);
  }

  function handleFor(record) {
    return {
      id: record.id,
      dismiss: () => dismiss(record.id),
      /** Rewrites the message's words (a live readout, a mode's step); it was announced once and is not announced again. */
      update({title = record.title, message = record.message, titleKey = null, titleParams = {}, messageKey = null, messageParams = {}} = {}) {
        if (!records.has(record.id) || (String(title) === record.title && String(message) === record.message)) return;
        Object.assign(record, {titleKey, titleParams, messageKey, messageParams});
        record.title = String(title);
        record.message = String(message);
        const text = record.node?.querySelector('.ui-toast-text');
        if (text) writeText(text, record);
        if (visible === record) place();
      },
      get visible() { return visible === record; },
    };
  }

  function paintProgress(record) {
    const bar = record.bar;
    if (!bar) return;
    if (record.progress === null) { bar.dataset.indeterminate = ''; bar.removeAttribute('aria-valuenow'); bar.style.removeProperty('--_p'); return; }
    delete bar.dataset.indeterminate;
    const percent = Math.round(Math.min(1, Math.max(0, record.progress)) * 100);
    bar.setAttribute('aria-valuenow', String(percent));
    bar.style.setProperty('--_p', `${percent}%`);
  }

  /**
   * A task message that appears only if the work is still running after
   * `delay` ms. Returns {signal, progress(0..1 | null), update({title, meta}),
   * done({message, tone}), fail(error), cancel()}; `signal` aborts on cancel.
   * `confirmCancel()` may return false (or a promise of it) to keep going. The
   * caller's `signal` ends the task quietly when it aborts (at once if it already has).
   */
  function task({title = '', meta = '', titleKey = null, titleParams = {}, metaKey = null, metaParams = {}, cancellable = true, cancelLabel = null, confirmCancel = null, onCancel = null, signal = null, delay = 150} = {}) {
    const controller = new AbortController(), lifetime = new AbortController();
    let record = null, progress = null, finished = false, text = {title, meta, titleKey, titleParams, metaKey, metaParams}, timer = 0;
    const end = () => {
      finished = true;
      clearTimer(timer);
      lifetime.abort();   // drops the listener on the caller's signal
      if (record) dismiss(record.id);
    };
    const cancel = async () => {
      if (finished) return;
      if (confirmCancel && (await confirmCancel()) === false) return;
      if (finished) return;
      end();
      controller.abort(messageError(new DOMException('', 'AbortError'), "errors.supportMedia.cancelled", {}));
      onCancel?.();
    };
    if (signal?.aborted) finished = true;
    else {
      signal?.addEventListener('abort', end, {once: true, signal: lifetime.signal});
      timer = setTimer(() => {
        if (finished) return;
        const handle = show({title: text.title, titleKey: text.titleKey, titleParams: text.titleParams, message: text.meta, messageKey: text.metaKey, messageParams: text.metaParams, task: true, key: `task-${++toastCount}`,
          actions: cancellable ? [{label: cancelLabel ?? kitText(t, 'common.cancel'), labelKey: cancelLabel === null ? 'common.cancel' : null, run: () => { cancel(); }, dismiss: false}] : []});
        record = records.get(handle.id);
        if (record) { record.progress = progress; paintProgress(record); }
      }, delay);
    }
    return {
      signal: controller.signal,
      progress(value) {
        progress = value === null || value === undefined ? null : Number(value);
        if (record) { record.progress = progress; paintProgress(record); }
      },
      update({title: nextTitle = text.title, meta: nextMeta = text.meta, titleKey = null, titleParams = {}, metaKey = null, metaParams = {}} = {}) {
        text = {title: nextTitle, meta: nextMeta, titleKey, titleParams, metaKey, metaParams};
        if (!record) return;
        // Kept on the record too: when a message that displaced the task goes, the task re-renders from it.
        record.title = String(nextTitle);
        record.message = String(nextMeta);
        Object.assign(record, {titleKey, titleParams, messageKey: metaKey, messageParams: metaParams});
        const node = record.node?.querySelector('.ui-toast-text');
        if (node) writeText(node, record);
        if (record.bar) {
          if (titleKey || metaKey) localizedAttribute(record.bar, 'aria-label', titleKey || metaKey, titleKey ? titleParams : metaParams);
          else { clearTranslation(record.bar, 'aria-label'); record.bar.setAttribute('aria-label', record.title || record.message); }
        }
      },
      done({message = '', tone = 'success', ...rest} = {}) { if (finished) return; end(); if (message) show({message, tone, ...rest}); },
      fail(error) { if (finished) return; end(); fail(error); },
      cancel,
    };
  }

  /** Shows an error the way the app reports failures: aborts are silent, user preconditions are warnings. */
  function fail(error, options = {}) {
    if (error?.name === 'AbortError') return null;
    const message = errorText(error), metadata = errorMessageData(error);
    if (error instanceof UserActionError) return show({message, ...metadata, tone: 'warning', ...options});
    const actions = feedback ? [{label: feedback.label, run: () => feedback.run(error), variant: 'ghost'}] : [];
    return show({message, ...metadata, tone: 'error', actions, ...options});
  }

  const stopLanguage = interfaceLocalization.subscribe(() => queueMicrotask(() => { if (visible) place(); }));
  return {
    host: element, live, show, task, fail, raise, dismiss, announce,
    destroy() { stopLanguage(); for (const id of [...records.keys()]) dismiss(id); element.remove(); live.polite.remove(); live.assertive.remove(); },
    /** Places the shown message again (the stage header changed size or content). */
    reposition() { if (visible) place(); },
    /** Dismisses every message, or only those of the given tones (a press on the canvas clears info messages: clear({tones: ['info']})). */
    clear({tones = null} = {}) {
      for (const [id, record] of [...records]) if (!tones || tones.includes(record.tone)) dismiss(id);
    },
    get current() { return visible ? handleFor(visible) : null; },
  };
}
