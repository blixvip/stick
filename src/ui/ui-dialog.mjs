import {clearTranslation, replaceLocalized, appendLocalized, localizedMarkup, localizedText, localizedAttribute} from '../localization-bindings.mjs';

import english from '../locales/en.mjs';

/**
 * Modal dialogs: a native <dialog> opened with showModal() around a
 * <form method="dialog">, so Enter submits the primary action and Escape asks
 * to cancel. Every dialog is its own element, so a confirm can open over
 * Settings or Export without either losing its content.
 *
 *   - Initial focus: [autofocus], else the first field, else the primary
 *     action; never the close button. A dialog opened by a pointer focuses it
 *     without the ring (data-pointer-open until the first key press).
 *   - Close guards: Escape and × go through requestClose(reason), which asks
 *     beforeClose(reason); returning false keeps the dialog open.
 *   - Sizes: sm 420, md 640, lg 880 (components/dialog.css); a dialog never
 *     changes size while it is open.
 *
 * createDialog() is the shell; confirm(), prompt() and choose() are the
 * promise helpers. Texts are set as text, never parsed as HTML.
 * showLegacyDialog() is the #dialog compatibility instance for callers that
 * still build HTML. Every helper takes `t` (localization.t) for its own words.
 */
import {focusFirst} from './overlay-manager.mjs';
import {kitText} from './ui-strings.mjs';

let dialogCount = 0;
const FIELDS = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';

const TEXT_ENTRY = 'input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=button], [type=submit], [type=reset], [type=file], [type=hidden]), textarea, [contenteditable="true"]';
/**
 * Whether focusing `target` would raise a touch screen's keyboard for a dialog that is not about typing: on the touch
 * interface (docs/TOUCH.md) such a dialog opens with focus on itself, and the keyboard comes when a field is tapped.
 */
export function keepsKeyboardDown(target, {typing = false} = {}) {
  if (typing || !target?.matches?.(TEXT_ENTRY)) return false;
  return target.ownerDocument?.documentElement?.dataset?.input === 'touch';
}

/** Where focus goes when `dialog` opens: [autofocus], the first field, the primary action; never the close button. */
export function initialFocusTarget(dialog) {
  const close = dialog.querySelector('.ui-dialog-close');
  const explicit = [...dialog.querySelectorAll('[autofocus]')].find(node => node !== close && !node.disabled);
  return explicit ?? dialog.querySelector(`.ui-dialog-body :is(${FIELDS})`) ?? dialog.querySelector('.ui-dialog-foot [data-primary]:not(:disabled)')
    ?? dialog.querySelector('.ui-dialog-foot button:not(:disabled)') ?? dialog.querySelector(`:is(${FIELDS}), button:not(.ui-dialog-close):not(:disabled)`) ?? null;
}

const nodeFrom = (doc, value, argument) => {
  const resolved = typeof value === 'function' ? value(argument) : value;
  if (resolved === null || resolved === undefined || resolved === '') return null;
  if (typeof resolved === 'string') { const paragraph = doc.createElement('p'); paragraph.className = 'ui-dialog-desc'; paragraph.textContent = resolved; return paragraph; }
  return resolved;
};

/**
 * createDialog({size, variant, title, description, body, actions, beforeClose, typing,
 * onSubmit, className, closeLabel, overlays, mount, icon, pointer, id, t})
 *   body      a Node, text, or (form) => Node
 *   actions   [{label, value, variant: 'primary' | 'danger' | 'ghost' | 'outline',
 *              tone, id, autofocus, cancel}] in visual order (Cancel before the
 *              primary). `cancel: true` closes with null; the others submit
 *              their value. The primary is the first with variant primary or
 *              danger, else the last submitting action; Enter in a field runs it.
 *   onSubmit  (value, form, submitter) runs before closing: return false or
 *             {error: 'message'} to keep the dialog open, {value} to resolve
 *             with another value, anything else to resolve with the action's value
 *   pointer   true when a pointer opened it (default: the overlay manager's last input)
 * Returns {element, form, body, showModal(), close(value), requestClose(reason),
 * setBusy(busy), setError(message), setMeta(text), result}. showModal()
 * resolves with the submitted value, or null when cancelled. Menus and
 * popovers opened inside the dialog close with it.
 */
export function createDialog({size = 'sm', variant = null, title = '', titleKey, titleParams, description = '', descriptionKey, descriptionParams, body = null, bodyKey, bodyParams, actions = [], beforeClose = null, onSubmit = null,
  className = '', closeLabel = null, closeLabelKey, closeLabelParams, overlays = null, mount = null, icon = null, pointer = null, id = null, t = null, typing = false,
  document: doc = globalThis.document} = {}) {
  const dialogId = id ?? `ui-dialog-${++dialogCount}`;
  const element = doc.createElement('dialog');
  element.id = dialogId;
  element.className = ['ui-dialog', className].filter(Boolean).join(' ');
  element.dataset.size = size;
  if (variant) element.dataset.variant = variant;
  if ('closedBy' in element) element.closedBy = 'closerequest';
  const form = doc.createElement('form');
  form.method = 'dialog';
  form.className = 'ui-dialog-form';
  form.noValidate = true;

  const head = doc.createElement('header');
  head.className = 'ui-dialog-head';
  const heading = doc.createElement('div');
  heading.className = 'ui-dialog-heading';
  const titleNode = doc.createElement('h2');
  titleNode.className = 'ui-dialog-title';
  titleNode.id = `${dialogId}-title`;
  titleNode.textContent = title;
  if (titleKey) localizedText(titleNode, titleKey, titleParams);
  appendLocalized(heading, titleNode);
  element.setAttribute('aria-labelledby', titleNode.id);
  if (description) {
    const text = doc.createElement('p');
    text.className = 'ui-dialog-desc';
    text.id = `${dialogId}-desc`;
    text.textContent = description;
    if (descriptionKey) localizedText(text, descriptionKey, descriptionParams);
    appendLocalized(heading, text);
    element.setAttribute('aria-describedby', text.id);
  }
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ui-icon-button ui-dialog-close';
  closeButton.setAttribute('aria-label', closeLabel ?? kitText(t, 'common.close'));
  if (closeLabelKey || !closeLabel) localizedAttribute(closeButton, 'aria-label', closeLabelKey ?? 'common.close', closeLabelParams);
  const glyph = icon?.('close');
  if (typeof glyph === 'string') closeButton.insertAdjacentHTML('beforeend', glyph); else if (glyph) appendLocalized(closeButton, glyph); else closeButton.textContent = '×';
  appendLocalized(head, heading, closeButton);

  const bodyNode = doc.createElement('div');
  bodyNode.className = 'ui-dialog-body';
  const content = nodeFrom(doc, body, form);
  if (content && bodyKey) localizedText(content, bodyKey, bodyParams);
  if (content) appendLocalized(bodyNode, content);
  const error = doc.createElement('div');
  error.className = 'ui-dialog-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  appendLocalized(bodyNode, error);

  const foot = doc.createElement('footer');
  foot.className = 'ui-dialog-foot';
  const meta = doc.createElement('span');
  meta.className = 'ui-dialog-meta';
  appendLocalized(foot, meta);
  const values = new Map();
  const submitting = actions.filter(action => !action.cancel);
  const primaryAction = submitting.find(action => action.variant === 'primary' || action.variant === 'danger') ?? submitting.at(-1) ?? null;
  let primary = null;
  for (const action of actions) {
    const button = doc.createElement('button');
    button.type = action.cancel ? 'button' : 'submit';
    button.className = 'ui-button';
    button.dataset.variant = action.variant ?? 'ghost';
    if (action.tone) button.dataset.tone = action.tone;
    if (action.id) button.id = action.id;
    button.textContent = action.label;
    if (action.labelKey) localizedText(button, action.labelKey, action.labelParams);
    if (action.cancel) button.addEventListener('click', () => requestClose('cancel'));
    else values.set(button, action.value === undefined ? action.labelKey && typeof english[action.labelKey] === 'string' ? english[action.labelKey] : action.label : action.value);
    if (action === primaryAction) { button.dataset.primary = ''; primary = button; }
    if (action.autofocus) button.autofocus = true;
    appendLocalized(foot, button);
  }
  appendLocalized(form, head, bodyNode, foot);
  appendLocalized(element, form);

  let resolve, open = false, settled = false, handle = null, submitted, busy = false;
  const result = new Promise(done => { resolve = done; });

  const finish = value => {
    if (settled) return;
    settled = true;
    open = false;
    // Menus and popovers mounted inside go first: removing a showing popover
    // fires no toggle event, so they would stay in the stack and keep the hotkeys off.
    const inside = overlays?.list?.().filter(other => other.element !== element && element.contains(other.element)) ?? [];
    for (const child of inside.reverse()) child.close(undefined, 'parent-closed');
    if (element.open) element.close();
    handle?.close(value, 'close');
    element.remove();
    resolve(value);
  };
  const guard = async reason => {
    if (!beforeClose) return true;
    try { return (await beforeClose(reason)) !== false; } catch (failure) { globalThis.reportError?.(failure); return false; }
  };
  async function requestClose(reason = 'request') {
    if (!open) return true;
    if (handle) return handle.requestClose(reason);
    if (!(await guard(reason))) return false;
    finish(null);
    return true;
  }

  closeButton.addEventListener('click', () => requestClose('close-button'));
  element.addEventListener('cancel', event => { event.preventDefault(); requestClose('escape'); });
  element.addEventListener('close', () => finish(submitted === undefined ? null : submitted));
  element.addEventListener('keydown', () => element.removeAttribute('data-pointer-open'));
  // Enter in a one-line field submits the primary action, even when another
  // submitting action (Don't save) comes first in the foot.
  form.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented || !primary) return;
    const target = event.target;
    if (!target.matches?.('input') || ['button', 'submit', 'checkbox', 'radio', 'reset', 'file'].includes(target.type)) return;
    event.preventDefault();
    if (!primary.disabled) form.requestSubmit(primary);
  });
  form.addEventListener('submit', event => {
    if (busy) { event.preventDefault(); return; }
    let value = values.has(event.submitter) ? values.get(event.submitter) : primary ? values.get(primary) : true;
    if (onSubmit) {
      const outcome = onSubmit(value, form, event.submitter);
      if (outcome === false || outcome?.error) {
        event.preventDefault();
        if (outcome?.error) setError(outcome.error);
        return;
      }
      if (outcome && typeof outcome === 'object' && 'value' in outcome) value = outcome.value;
    }
    submitted = value;
  });

  function setError(message = '') {
    if (message?.messageKey) localizedText(error, message.messageKey, message.messageParams);
    else { clearTranslation(error); error.textContent = String(message?.message ?? message); }
    error.hidden = !message;
  }

  return {
    element, form, body: bodyNode, result,
    /** Opens the dialog; resolves with the submitted value or null. */
    showModal() {
      if (open || settled) return result;
      const invoker = doc.activeElement;
      const host = mount ?? doc.body;
      appendLocalized(host, element);
      let target = initialFocusTarget(element);
      const shy = keepsKeyboardDown(target, {typing});
      if (shy) target = null;
      const byPointer = Boolean(target) && (pointer ?? overlays?.openedByPointer?.() ?? false);
      // The dialog's focusing steps pick [autofocus]. A pointer open focuses the
      // dialog first, then the target without the ring (focusVisible: false).
      if (byPointer || !target) { element.tabIndex = -1; element.autofocus = true; } else target.autofocus = true;
      element.showModal();
      // The dialog's own focusing steps may still pick a field's [autofocus]: the dialog keeps focus instead.
      if (shy && element.contains(doc.activeElement) && doc.activeElement !== element) element.focus({preventScroll: true});
      open = true;
      handle = overlays?.register(element, {kind: 'dialog', modal: true, invoker, beforeClose: guard, closeOnEscape: false,
        onClose: (value, reason) => { if (reason !== 'close') { submitted = undefined; finish(null); } }}) ?? null;
      if (byPointer) {
        element.dataset.pointerOpen = '';
        target.focus({preventScroll: true, focusVisible: false});
      }
      return result;
    },
    close(value = null) { submitted = value; finish(value); },
    requestClose,
    setBusy(next) {
      busy = Boolean(next);
      if (busy) element.setAttribute('aria-busy', 'true'); else element.removeAttribute('aria-busy');
      for (const button of foot.querySelectorAll('button[type=submit]')) button.disabled = busy;
    },
    setError,
    setMeta(text = '') { if (text?.messageKey) localizedText(meta, text.messageKey, text.messageParams); else { clearTranslation(meta); meta.textContent = text; } },
    get open() { return open; },
  };
}

/**
 * Asks a yes/no question. `alternatives` adds actions before Cancel
 * ([{label, value, danger}], e.g. "Don't save"). Resolves true for the
 * confirm action, an alternative's value, or false when cancelled.
 */
export async function confirm({title, body = '', description = '', confirmLabel = null, cancelLabel = null, danger = false, alternatives = [], size = 'sm', ...options} = {}) {
  const dialog = createDialog({size, title, description, body, ...options, actions: [
    ...alternatives.map(action => ({label: action.label, value: action.value, id: action.id, variant: 'ghost', tone: action.danger ? 'danger' : undefined})),
    {label: cancelLabel ?? kitText(options.t, 'common.cancel'), labelKey: options.cancelLabelKey ?? (cancelLabel === null ? 'common.cancel' : undefined), labelParams: options.cancelLabelParams, cancel: true, variant: 'ghost'},
    {label: confirmLabel ?? kitText(options.t, 'overlays.ok'), labelKey: options.confirmLabelKey ?? (confirmLabel === null ? 'overlays.ok' : undefined), labelParams: options.confirmLabelParams, value: true, variant: danger ? 'danger' : 'primary', autofocus: true, id: options.confirmId},
  ]});
  const value = await dialog.showModal();
  return value === null ? false : value;
}

/**
 * Asks for one line of text (rename). `validate(text)` returns an error
 * message to keep the dialog open. Resolves with the text, or null.
 */
export async function prompt({title, label = '', value = '', placeholder = '', validate = null, confirmLabel = null, cancelLabel = null,
  maxLength = null, inputId = null, size = 'sm', ...options} = {}) {
  const doc = options.document ?? globalThis.document;
  const row = doc.createElement('div'), caption = doc.createElement('label'), input = doc.createElement('input');
  row.className = 'ui-form-row';
  input.className = 'ui-field-input';
  input.id = inputId ?? `ui-prompt-${++dialogCount}`;
  input.type = 'text';
  input.value = value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.autofocus = true;
  if (placeholder) input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  caption.htmlFor = input.id;
  caption.className = 'ui-field-label';
  caption.textContent = label;
  if (options.labelKey) localizedText(caption, options.labelKey, options.labelParams);
  if (options.placeholderKey) localizedAttribute(input, 'placeholder', options.placeholderKey, options.placeholderParams);
  if (label) appendLocalized(row, caption); else if (options.titleKey) localizedAttribute(input, 'aria-label', options.titleKey, options.titleParams); else input.setAttribute('aria-label', title);
  appendLocalized(row, input);
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  const dialog = createDialog({size, title, body: row, typing: true, ...options, actions: [
    {label: cancelLabel ?? kitText(options.t, 'common.cancel'), labelKey: options.cancelLabelKey ?? (cancelLabel === null ? 'common.cancel' : undefined), labelParams: options.cancelLabelParams, cancel: true, variant: 'ghost'},
    {label: confirmLabel ?? kitText(options.t, 'overlays.ok'), labelKey: options.confirmLabelKey ?? (confirmLabel === null ? 'overlays.ok' : undefined), labelParams: options.confirmLabelParams, value: true, variant: 'primary'},
  ], onSubmit: () => {
    const problem = validate?.(input.value);
    if (problem) { input.setAttribute('aria-invalid', 'true'); input.focus(); return {error: problem}; }
    return {value: input.value};
  }});
  input.addEventListener('focus', () => input.select(), {once: true});
  return dialog.showModal();
}

/**
 * Asks to pick one of several options, each a full-width action with an
 * optional description ([{value, id, label, description, icon}]; ids keep test
 * hooks such as #builder-exit-update). Resolves with the value, or null.
 */
export async function choose({title, description = '', options: choices = [], cancelLabel = null, icon = null, size = 'sm', ...options} = {}) {
  const doc = options.document ?? globalThis.document;
  const list = doc.createElement('div');
  list.className = 'ui-dialog-choices';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', title);
  const values = new Map();
  for (const choice of choices) {
    const button = doc.createElement('button');
    button.type = 'submit';
    button.className = 'ui-dialog-choice';
    if (choice.id) button.id = choice.id;
    if (choice.icon && icon) { const glyph = icon(choice.icon); if (typeof glyph === 'string') button.insertAdjacentHTML('beforeend', glyph); else if (glyph) appendLocalized(button, glyph); }
    const text = doc.createElement('span'), name = doc.createElement('b');
    text.className = 'ui-dialog-choice-text';
    name.textContent = choice.label;
    if (choice.labelKey) localizedText(name, choice.labelKey, choice.labelParams);
    appendLocalized(text, name);
    if (choice.description) { const detail = doc.createElement('small'); detail.textContent = choice.description; if (choice.descriptionKey) localizedText(detail, choice.descriptionKey, choice.descriptionParams); appendLocalized(text, detail); }
    appendLocalized(button, text);
    if (choice.danger) button.dataset.tone = 'danger';
    values.set(button, choice.value);
    appendLocalized(list, button);
  }
  const dialog = createDialog({size, title, description, body: list, icon, ...options,
    actions: [{label: cancelLabel ?? kitText(options.t, 'common.cancel'), labelKey: options.cancelLabelKey ?? (cancelLabel === null ? 'common.cancel' : undefined), labelParams: options.cancelLabelParams, cancel: true, variant: 'ghost'}],
    onSubmit: (value, form, submitter) => (values.has(submitter) ? {value: values.get(submitter)} : false)});
  return dialog.showModal();
}

const legacyHandles = new WeakMap();
const LEGACY_PRIMARY = '[data-primary]:not(:disabled), button.primary:not(:disabled)';

/**
 * The #dialog compatibility instance: what showDialog(title, body) in app.mjs
 * does today, with the kit's rules, until every caller has its own dialog.
 * The markup and hooks are unchanged (.dialog-head with the title and the
 * [data-action=close-dialog] button, .dialog-body with the caller's HTML), now
 * inside a <form method="dialog"> (display: contents), so Enter in a field
 * runs the body's primary button ([data-primary] or button.primary). Buttons
 * without a type stay plain buttons, so the body's data-action buttons act as
 * before. The form's first element is a hidden submit button, so Enter always
 * lands on it (never on a button the caller appends later without a type) and
 * runs the primary once. Focus goes to [autofocus], the first field, the
 * primary or the first control, never the close button; the dialog joins the
 * overlay stack while it is open. Calling it while the dialog is open swaps
 * the content and keeps the registration. `bodyHTML` is trusted markup built by the app, as before.
 *
 * Returns {dialog, form, body, handle}.
 */
export function showLegacyDialog(title, bodyHTML, {titleKey, titleParams, dialog, content = null, overlays = null, icon = null, closeLabel = null, pointer = null, t = null} = {}) {
  const doc = dialog.ownerDocument, host = content ?? dialog.querySelector('#dialog-content') ?? dialog;
  const form = doc.createElement('form');
  form.method = 'dialog';
  form.className = 'ui-legacy-dialog-form';
  form.noValidate = true;
  const head = doc.createElement('div'), heading = doc.createElement('h2'), close = doc.createElement('button');
  head.className = 'dialog-head';
  heading.textContent = title;
  if (titleKey) localizedText(heading, titleKey, titleParams);
  close.type = 'button';
  close.className = 'icon-button';
  close.dataset.action = 'close-dialog';
  close.setAttribute('aria-label', closeLabel ?? kitText(t, 'overlays.closeDialog'));
  if (!closeLabel) localizedAttribute(close, 'aria-label', 'overlays.closeDialog');
  const glyph = icon?.('close');
  if (typeof glyph === 'string') close.insertAdjacentHTML('beforeend', glyph); else if (glyph) appendLocalized(close, glyph); else close.textContent = '×';
  appendLocalized(head, heading, close);
  const body = doc.createElement('div');
  body.className = 'dialog-body';
  localizedMarkup(body, bodyHTML);
  for (const button of body.querySelectorAll('button:not([type])')) button.type = 'button';
  // The form's default button (the first submit button in tree order): Enter in a field clicks it.
  const enter = doc.createElement('button');
  enter.type = 'submit';
  enter.hidden = true;
  enter.tabIndex = -1;
  enter.setAttribute('aria-hidden', 'true');
  appendLocalized(form, enter, head, body);
  // The body's own buttons act on click; the form only turns Enter in a field into the primary.
  form.addEventListener('submit', event => {
    // A form of the body's own (Reference joints) submits by itself; its event only bubbles through here.
    if (event.target !== form) return;
    event.preventDefault();
    // Any other submitter already ran its own click.
    if (event.submitter && event.submitter !== enter) return;
    body.querySelector(LEGACY_PRIMARY)?.click();
  });
  replaceLocalized(host, form);

  let handle = legacyHandles.get(dialog) ?? null;
  const byPointer = pointer ?? overlays?.openedByPointer?.() ?? false;
  if (!dialog.open) {
    const invoker = doc.activeElement;
    dialog.showModal();
    handle = overlays?.register(dialog, {kind: 'dialog', modal: true, invoker, closeOnEscape: false,
      onClose: () => { legacyHandles.delete(dialog); if (dialog.open) dialog.close(); }}) ?? null;
    if (handle) {
      legacyHandles.set(dialog, handle);
      dialog.addEventListener('close', () => handle.close(undefined, 'close'), {once: true, signal: handle.signal});
    }
  }
  const target = [...body.querySelectorAll('[autofocus]')].find(node => !node.disabled) ?? body.querySelector(FIELDS) ?? body.querySelector(LEGACY_PRIMARY)
    ?? body.querySelector('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
  if (target && !keepsKeyboardDown(target)) focusFirst([target], {focusVisible: byPointer ? false : undefined});
  else { dialog.tabIndex = -1; dialog.focus({preventScroll: true}); }
  return {dialog, form, body, handle};
}
