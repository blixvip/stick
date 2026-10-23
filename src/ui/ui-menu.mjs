import {replaceLocalized, appendLocalized, localizedText} from '../localization-bindings.mjs';
import {t as interfaceText} from '../localization.mjs';

/**
 * Menus and the menubar: one component for app menus, context menus, the
 * zoom menu, overflow menus and submenus.
 *
 * The model is data (normalizeMenu); the keyboard model is pure
 * (menuKeyAction, findTypeahead); openMenu() and installMenuBar() are the thin
 * DOM layer. A menu is a manual [popover] in the top layer that dismisses
 * itself (outside press, Escape, Tab, blur, resize, scrolling its anchor), so a
 * context menu opened between pointerdown and pointerup is not light-dismissed
 * at once. While one is open it takes every keydown, so letters never reach the
 * editor's hotkeys (H does not pick the Pan tool behind the File menu).
 *
 * Model items:
 *   null or '-'                          a separator
 *   'command-id'                         a command, described by `resolve`
 *   {label: 'Canvas', labelKey}          a group label (only a label, or type: 'label')
 *   {command, label, labelKey, icon,     an item; `shortcut` is text, false for
 *    shortcut, keyshortcuts, checked,    none, or 'auto' (default: the provided
 *    radio, group, danger, disabled,     formatter); `run(event, entry)` handles
 *    reason, hidden, keepOpen,           it here, otherwise the click bubbles with
 *    submenu, run}                       its data-action to the app's delegation
 * `labelKey` goes through `t` (localization.t); the label is the fallback.
 *
 * Rendering keeps today's hooks: items are `button.menu-item.ui-menu-item
 * [role][data-action]`, the first <span> is the label and the shortcut is a
 * <kbd>, so `#menu [data-action=…]` selectors and the localization of menu
 * labels keep working when a menu renders into the #menu host. An item's
 * accessible name is its label alone (aria-labelledby); the shortcut is
 * aria-keyshortcuts and a disabled item's reason its description. Items under
 * a group label sit in a role=group named by it.
 */
import {placeFloating, presentsAsSheet} from './anchor-position.mjs';
import {focusFirst, overlayMount, showPopoverFrom} from './overlay-manager.mjs';
import {installRovingFocus, nextRovingIndex} from './roving-focus.mjs';

// ---------------------------------------------------------------------------
// Model

/**
 * Resolves a model into render entries:
 *   {type: 'item', command, label, icon, shortcut, keyshortcuts, role, checked,
 *    disabled, reason, danger, submenu, run, keepOpen, group, id}
 *   {type: 'separator'} and {type: 'label', label}
 * `resolve(command)` returns the registry's description ({label, icon,
 * shortcut, keyshortcuts, enabled, reason, hidden, checked, danger});
 * `shortcut(command)` returns the display text of its shortcut; `t(key)`
 * translates `labelKey`s. Hidden items and empty submenus are left out;
 * separators and group labels never lead, trail or double.
 */
export function normalizeMenu(items = [], {resolve = null, shortcut = null, t = null} = {}) {
  const list = typeof items === 'function' ? items() : items;
  const entries = [];
  const text = item => {
    if (item.labelKey && typeof t === 'function') {
      try { const translated = t(item.labelKey); if (typeof translated === 'string' && translated && translated !== item.labelKey) return translated; } catch { /* the label is the fallback */ }
    }
    return item.label;
  };
  for (const raw of list ?? []) {
    if (raw === null || raw === undefined || raw === '-' || raw?.type === 'separator') { entries.push({type: 'separator'}); continue; }
    const item = typeof raw === 'string' ? {command: raw} : raw;
    if (item.type === 'label' || (item.type === undefined && Object.keys(item).every(key => key === 'label' || key === 'labelKey' || key === 'labelParams'))) {
      entries.push({type: 'label', label: String(text(item) ?? ''), ...(item.labelKey ? {labelKey: item.labelKey, labelParams: item.labelParams} : {})});
      continue;
    }
    const meta = item.command && resolve ? resolve(item.command) ?? null : null;
    if (item.hidden ?? meta?.hidden) continue;
    const submenu = item.submenu ?? null;
    if (Array.isArray(submenu) && !normalizeMenu(submenu, {resolve, shortcut, t}).some(entry => entry.type === 'item')) continue;
    const checked = item.checked ?? meta?.checked;
    const role = item.radio ? 'menuitemradio' : typeof checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem';
    const disabled = Boolean(item.disabled ?? (meta ? meta.enabled === false : false));
    const automatic = item.shortcut === undefined || item.shortcut === 'auto';
    const shown = submenu || item.shortcut === false ? '' : automatic ? (item.command ? shortcut?.(item.command) ?? meta?.shortcut ?? '' : '') : String(item.shortcut);
    entries.push({
      type: 'item', command: item.command ?? null, label: String(text(item) ?? meta?.label ?? item.command ?? ''),
      labelKey: item.labelKey ?? (item.label === undefined ? meta?.labelKey : undefined), labelParams: item.labelParams ?? meta?.labelParams,
      icon: item.icon ?? meta?.icon ?? null,
      shortcut: shown, keyshortcuts: shown && automatic ? String(item.keyshortcuts ?? meta?.keyshortcuts ?? '') : String(item.keyshortcuts ?? ''),
      role, checked: role === 'menuitem' ? undefined : Boolean(checked), disabled,
      reason: disabled ? String(item.reason ?? meta?.reason ?? '') : '',
      ...(disabled && (item.reasonKey ?? meta?.reasonKey) ? {reasonKey:item.reasonKey ?? meta.reasonKey, reasonParams:item.reasonParams ?? meta?.reasonParams} : {}), danger: Boolean(item.danger ?? meta?.danger),
      submenu, run: typeof item.run === 'function' ? item.run : null, keepOpen: Boolean(item.keepOpen), group: item.group ?? null, id: item.id ?? null,
      swatch: typeof item.swatch === 'string' ? item.swatch : null,
    });
  }
  const tidy = [];
  entries.forEach((entry, index) => {
    if (entry.type === 'label' && entries[index + 1]?.type !== 'item') return;
    if (entry.type === 'separator' && (!tidy.length || tidy.at(-1).type === 'separator')) return;
    tidy.push(entry);
  });
  while (tidy.at(-1)?.type === 'separator') tidy.pop();
  return tidy;
}

// ---------------------------------------------------------------------------
// Keyboard model

/** A typeahead buffer: characters typed within `timeout` ms of each other build one query. */
export function createTypeahead({timeout = 700, now = () => globalThis.performance?.now() ?? Date.now()} = {}) {
  let buffer = '', last = -Infinity;
  return {
    push(character) {
      const time = now();
      buffer = time - last < timeout ? buffer + character.toLowerCase() : character.toLowerCase();
      last = time;
      return buffer;
    },
    reset() { buffer = ''; last = -Infinity; },
    get buffer() { return buffer; },
  };
}

/**
 * The item a typeahead query selects, or -1. One character finds the next
 * label starting with it after `current` (repeating it cycles); a longer query
 * may stay on the current label.
 */
export function findTypeahead(labels, query, current = -1) {
  const text = String(query ?? '').toLowerCase(), count = labels.length;
  if (!text || !count) return -1;
  const repeated = [...text].every(character => character === text[0]);
  const needle = repeated ? text[0] : text;
  const start = repeated ? current + 1 : Math.max(0, current);
  for (let step = 0; step < count; step++) {
    const index = ((start + step) % count + count) % count;
    if (String(labels[index]).trim().toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * What a keydown does in an open menu, as data:
 *   {type: 'move', index} | {type: 'open-submenu'} | {type: 'close-submenu'} |
 *   {type: 'close', reason: 'escape' | 'tab'} | {type: 'menubar', delta} |
 *   {type: 'activate'} | {type: 'typeahead', character} | {type: 'swallow'}
 * `index` is the focused item (-1 for none) of `count`; `submenu`: the focused
 * item opens one; `nested`: this menu is a submenu; `menubar`: the menu tree
 * hangs off a menubar. Every key is at least swallowed: none reaches hotkeys.
 */
export function menuKeyAction(event, {index = -1, count = 0, submenu = false, nested = false, menubar = false, direction = 'ltr'} = {}) {
  const {key: originalKey = '', ctrlKey = false, metaKey = false, altKey = false, isComposing = false} = event ?? {};
  const key = direction === 'rtl' ? ({ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft'}[originalKey] ?? originalKey) : originalKey;
  const swallow = {type: 'swallow'};
  if (isComposing) return swallow;
  switch (key) {
    case 'ArrowDown': return count ? {type: 'move', index: index < 0 ? 0 : (index + 1) % count} : swallow;
    case 'ArrowUp': return count ? {type: 'move', index: index < 0 ? count - 1 : (index - 1 + count) % count} : swallow;
    case 'Home': case 'PageUp': return count ? {type: 'move', index: 0} : swallow;
    case 'End': case 'PageDown': return count ? {type: 'move', index: count - 1} : swallow;
    case 'ArrowRight': return submenu ? {type: 'open-submenu'} : menubar ? {type: 'menubar', delta: 1} : swallow;
    case 'ArrowLeft': return nested ? {type: 'close-submenu'} : menubar ? {type: 'menubar', delta: -1} : swallow;
    case 'Enter': case ' ': return index < 0 ? swallow : submenu ? {type: 'open-submenu'} : {type: 'activate'};
    case 'Escape': return nested ? {type: 'close-submenu'} : {type: 'close', reason: 'escape'};
    case 'Tab': return {type: 'close', reason: 'tab'};
    default:
      return key.length === 1 && !ctrlKey && !metaKey && !altKey ? {type: 'typeahead', character: key} : swallow;
  }
}

// ---------------------------------------------------------------------------
// DOM

let menuCount = 0;
// The open root menu per anchor and per host element: a second open replaces the first.
const openMenus = new WeakMap();
const isEditable = target => Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));

/** Appends a glyph from an icon function (an SVG string or a Node). */
function appendGlyph(parent, glyph, className) {
  if (!glyph) return null;
  let node = glyph;
  if (typeof glyph === 'string') {
    parent.insertAdjacentHTML('beforeend', glyph);
    node = parent.lastElementChild;
  } else appendLocalized(parent, glyph);
  if (className) node?.classList?.add(...className.split(' '));
  return node;
}

/** The open menu anchored to `anchor`, if any (lets a button toggle its menu). */
export function menuFor(anchor) {
  const menu = anchor ? openMenus.get(anchor) : null;
  return menu?.isOpen ? menu : null;
}

/**
 * Opens a menu and returns it ({element, isOpen, signal, close(reason), update(items)}).
 *
 *   items        the model (or a function returning it)
 *   anchor       the invoking element or a DOMRect; `point` {x, y} for context menus
 *   placement    'bottom-start' (menus), 'right-start' (submenus)
 *   host         render into an existing element (the #menu compatibility host);
 *                its `hidden` attribute mirrors the open state, and the class,
 *                name and side a menu adds are taken off again when it closes
 *   mount        'auto' (inside the anchor's open <dialog>, else the body) or an element
 *   overlays     the OverlayManager: registers the menu as a hotkey-blocking overlay
 *   resolve      (commandId) => description (the registry's get)
 *   shortcut     (commandId) => display text for its shortcut
 *   t            (key) => text: translates the model's labelKeys (localization.t)
 *   icon         (name) => SVG string or Node (icons.mjs icon)
 *   onSelect     (entry, event) handles items without their own run(); without
 *                it the click bubbles to the app's data-action delegation
 *   onClose      (reason) after the menu closed
 *   label        the menu's accessible name
 *   focus        'first' (default), 'last', 'none' or an item index
 *   topInset     number or () => number: the lowest top (the title band + 6)
 *   dismissOn    [[eventTarget, type], …] extra events that close the menu (editor 'change')
 *   invoker      where focus returns (default: the anchor element, else the focused element)
 */
export function openMenu(options) {
  const menu = new Menu(options);
  menu.open();
  return menu;
}

class Menu {
  constructor(options) {
    this.options = options;
    this.parent = options.parent ?? null;
    this.root = this.parent ? this.parent.root : this;
    this.document = options.document ?? options.host?.ownerDocument ?? (options.anchor?.ownerDocument) ?? globalThis.document;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.typeahead = createTypeahead();
    this.entries = [];
    this.buttons = [];
    this.entryByButton = new WeakMap();
    this.child = null;
    this.isOpen = false;
    this.anchorElement = typeof options.anchor?.getBoundingClientRect === 'function' && options.anchor.nodeType === 1 ? options.anchor : null;
    this.invoker = options.invoker ?? this.anchorElement ?? this.document.activeElement;
    const element = this.element = options.host ?? this.document.createElement('div');
    this.created = !options.host;
    if (!this.parent && !this.created) openMenus.get(element)?.close('replace', {restore: false});
    if (!element.id) element.id = `ui-menu-${++menuCount}`;
    // A reused host (#menu) gets back its own classes and name when this menu closes.
    const classes = ['ui-menu', ...String(options.className ?? '').split(/\s+/).filter(Boolean)];
    this.addedClasses = this.created ? [] : classes.filter(name => !element.classList.contains(name));
    this.hostLabel = this.created ? null : element.getAttribute('aria-label');
    element.classList.add(...classes);
    element.setAttribute('role', 'menu');
    element.popover = 'manual';
    if (options.label) element.setAttribute('aria-label', options.label); else element.removeAttribute('aria-label');
    this.render();
  }

  render() {
    const {element} = this, doc = this.document, root = this.root.options;
    const focused = this.buttons.indexOf(doc.activeElement);
    this.entries = normalizeMenu(this.options.items, {resolve: root.resolve, shortcut: root.shortcut, t: root.t});
    this.buttons = [];
    replaceLocalized(element);
    // A submenu shown as a sheet covers its parent: its first row leads back (docs/TOUCH.md).
    if (this.parent && presentsAsSheet(element)) {
      const back = doc.createElement('button');
      back.type = 'button';
      back.className = 'ui-menu-back';
      back.tabIndex = -1;
      appendGlyph(back, root.icon?.('chevron-left'), 'ui-icon');
      const label = doc.createElement('span');
      label.textContent = this.options.label ?? '';
      if (this.options.labelKey) localizedText(label,this.options.labelKey,this.options.labelParams);
      appendLocalized(back, label);
      back.addEventListener('click', event => { event.stopPropagation(); this.close('back', {restore: true}); });
      appendLocalized(element, back);
    }
    // Items under a group label go into a role=group the label names, until the next separator or label.
    let parent = element;
    this.entries.forEach((entry, index) => {
      if (entry.type === 'separator') {
        parent = element;
        const separator = doc.createElement('div');
        separator.className = 'menu-separator ui-menu-sep';
        separator.setAttribute('role', 'separator');
        appendLocalized(element, separator);
        return;
      }
      if (entry.type === 'label') {
        const group = doc.createElement('div'), label = doc.createElement('div');
        group.className = 'ui-menu-group';
        group.setAttribute('role', 'group');
        label.className = 'ui-menu-label';
        label.id = `${element.id}-group-${index}`;
        label.setAttribute('aria-hidden', 'true');
        label.textContent = entry.label;
        if (entry.labelKey) localizedText(label, entry.labelKey, entry.labelParams);
        group.setAttribute('aria-labelledby', label.id);
        appendLocalized(group, label);
        appendLocalized(element, group);
        parent = group;
        return;
      }
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'menu-item ui-menu-item';
      button.id = entry.id ?? `${element.id}-item-${index}`;
      button.tabIndex = -1;
      button.setAttribute('role', entry.role);
      if (entry.command) button.dataset.action = entry.command;
      if (entry.role !== 'menuitem') button.setAttribute('aria-checked', String(entry.checked));
      if (entry.disabled) button.setAttribute('aria-disabled', 'true');
      if (entry.danger) button.dataset.tone = 'danger';
      if (entry.submenu) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
      // The lead column: a glyph, the check or a pad, so every label lines up.
      if (entry.role !== 'menuitem') {
        const check = doc.createElement('i');
        check.className = 'ui-menu-check';
        check.setAttribute('aria-hidden', 'true');
        if (entry.role === 'menuitemcheckbox') appendGlyph(check, root.icon?.('check'), 'ui-icon');
        appendLocalized(button, check);
      } else if (!(entry.icon && appendGlyph(button, root.icon?.(entry.icon), 'ui-icon'))) {
        const pad = doc.createElement('i');
        pad.className = 'ui-menu-pad';
        pad.setAttribute('aria-hidden', 'true');
        appendLocalized(button, pad);
      }
      const label = doc.createElement('span');
      label.id = `${button.id}-label`;
      label.textContent = entry.label;
      if (entry.labelKey) localizedText(label, entry.labelKey, entry.labelParams);
      // A colour the row stands for (a layer colour): a dot before its name, outside its accessible name.
      if (entry.swatch) {
        const dot = doc.createElement('i');
        dot.className = 'ui-menu-swatch';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.setProperty('--swatch', entry.swatch);
        label.prepend(dot);
      }
      appendLocalized(button, label);
      button.setAttribute('aria-labelledby', label.id);
      if (entry.shortcut) {
        const key = doc.createElement('kbd');
        key.className = 'ui-menu-shortcut';
        key.textContent = entry.shortcut;
        appendLocalized(button, key);
        // Announced once, as the item's shortcut, rather than read out as text.
        if (entry.keyshortcuts) { button.setAttribute('aria-keyshortcuts', entry.keyshortcuts); key.setAttribute('aria-hidden', 'true'); }
      }
      if (entry.submenu) {
        const chevron = appendGlyph(button, root.icon?.('chevron-right'), 'ui-icon ui-menu-sub');
        if (!chevron) { const sub = doc.createElement('i'); sub.className = 'ui-menu-sub'; sub.setAttribute('aria-hidden', 'true'); appendLocalized(button, sub); }
      }
      if (entry.reason) {
        const reason = doc.createElement('small');
        reason.className = 'ui-menu-reason';
        reason.id = `${button.id}-reason`;
        reason.textContent = entry.reason;
        if (entry.reasonKey) localizedText(reason,entry.reasonKey,entry.reasonParams);
        appendLocalized(button, reason);
        button.setAttribute('aria-describedby', reason.id);
      }
      this.entryByButton.set(button, entry);
      this.buttons.push(button);
      appendLocalized(parent, button);
    });
    if (focused >= 0 && this.isOpen) this.focusIndex(Math.min(focused, this.buttons.length - 1));
  }

  /** Replaces the items, keeping the menu open (and the focused position). */
  update(items) { this.options.items = items; this.render(); }

  open() {
    const {options, element} = this, doc = this.document;
    if (!this.parent && this.anchorElement) openMenus.get(this.anchorElement)?.close('replace', {restore: false});
    const mount = options.mount && options.mount !== 'auto' ? options.mount
      : this.parent ? this.parent.element.parentElement : overlayMount(this.anchorElement ?? this.invoker, doc);
    if (this.created && mount && element.parentElement !== mount) appendLocalized(mount, element);
    element.removeAttribute('hidden');
    const source = this.parent ? this.options.anchor : this.anchorElement;
    showPopoverFrom(element, source);
    this.isOpen = true;
    this.#place();
    const signal = this.signal, view = doc.defaultView ?? globalThis;
    // A menu taller than its room scrolls, and says so (the "more below" fade; menu.css draws the scrollbar).
    const more = () => element.toggleAttribute('data-more-below', element.scrollHeight - element.scrollTop - element.clientHeight > 1);
    more();
    element.addEventListener('scroll', more, {passive: true, signal});
    element.addEventListener('click', event => this.#onClick(event), {signal});
    element.addEventListener('pointermove', event => this.#onPointerMove(event), {signal});
    element.addEventListener('pointerleave', () => this.root.#cancelIntent(), {signal});
    // Keys typed into a control inside a menu row stay out of the editor's hotkeys.
    element.addEventListener('keydown', event => { if (isEditable(event.target)) event.stopPropagation(); }, {signal});
    element.addEventListener('toggle', event => { if (event.newState === 'closed' && this.isOpen) this.close('dismiss', {restore: false}); }, {signal});
    if (!this.parent) {
      if (this.anchorElement) {
        openMenus.set(this.anchorElement, this);
        this.anchorElement.setAttribute('aria-expanded', 'true');
        this.anchorElement.setAttribute('aria-controls', element.id);
      }
      if (!this.created) openMenus.set(element, this);
      doc.addEventListener('keydown', event => this.#onKeydown(event), {capture: true, signal});
      doc.addEventListener('pointerdown', event => {
        if (!this.#contains(event.target) && !this.anchorElement?.contains(event.target)) this.close('outside', {restore: false});
      }, {capture: true, signal});
      doc.addEventListener('scroll', event => {
        const scrolled = event.target;
        if (this.#contains(scrolled)) return;
        if (scrolled === doc || scrolled?.contains?.(this.anchorElement)) this.close('scroll', {restore: false});
      }, {capture: true, signal});
      view.addEventListener('blur', () => this.close('blur', {restore: false}), {signal});
      view.addEventListener('resize', () => this.close('resize', {restore: false}), {signal});
      for (const [target, type] of options.dismissOn ?? []) target?.addEventListener?.(type, () => this.close('dismiss', {restore: false}), {signal});
      this.handle = options.overlays?.register(element, {kind: 'menu', keyboardScope: true, invoker: this.invoker, returnFocus: false,
        closeOnEscape: false, onClose: (value, reason) => this.close(reason, {restore: false})}) ?? null;
    }
    const focus = options.focus ?? 'first';
    // A menu a pointer opened focuses its row without the ring (as a dialog does); the first key brings it back.
    const quiet = !this.parent && options.overlays?.openedByPointer?.() === true ? {focusVisible: false} : {};
    if (focus === 'first') this.focusIndex(0, quiet);
    else if (focus === 'last') this.focusIndex(this.buttons.length - 1, quiet);
    else if (typeof focus === 'number') this.focusIndex(focus, quiet);
    return this;
  }

  #place() {
    const root = this.root.options;
    if (this.parent) {
      const rect = this.options.anchor.getBoundingClientRect(), view = this.document.defaultView ?? globalThis;
      // Where neither side has room for the submenu's labels, it overlaps its parent rather than cut them.
      // Measured at the window's corner, where it takes its natural width (placeFloating does the same).
      Object.assign(this.element.style, {maxWidth: '', left: '0px', top: '0px'});
      const width = this.element.getBoundingClientRect().width, margin = 8, gap = 2;
      const cramped = width > view.innerWidth - margin - rect.right - gap && width > rect.left - margin - gap;
      const right = cramped ? Math.max(margin, Math.min(rect.right, view.innerWidth - margin - width - gap)) : rect.right;
      // Line the submenu's first item up with its row (the menu has a 4px padding).
      placeFloating(this.element, {left: cramped ? right : rect.left, right, top: rect.top - 4, bottom: rect.bottom + 4, width: right - (cramped ? right : rect.left), height: rect.height + 8},
        {placement: this.document.documentElement.dir === 'rtl' ? 'left-start' : 'right-start', offset: gap, topInset: root.topInset, overlap: true, flip: !cramped});
      return;
    }
    const anchor = this.options.point ?? this.options.anchor ?? this.invoker;
    if (anchor) placeFloating(this.element, anchor, {placement: this.options.placement ?? 'bottom-start', offset: this.options.point ? 2 : 6,
      topInset: root.topInset, overlap: true});
  }

  #contains(target) {
    for (let menu = this.root; menu; menu = menu.child) if (menu.element.contains(target)) return true;
    return false;
  }

  /** The deepest open menu, or the one holding `target`. */
  #activeMenu(target) {
    let deepest = this.root;
    while (deepest.child?.isOpen) deepest = deepest.child;
    for (let menu = deepest; menu; menu = menu.parent) if (menu.element.contains(target)) return menu;
    return deepest;
  }

  focusIndex(index, {focusVisible} = {}) {
    const button = this.buttons[index];
    if (!button) return;
    button.focus(focusVisible === undefined ? {preventScroll: true} : {preventScroll: true, focusVisible});
    button.scrollIntoView?.({block: 'nearest'});
  }

  #onKeydown(event) {
    if (!this.isOpen) return;
    // Removed with the dialog it was mounted in: nothing fired a close, so close now and let the key through.
    if (!this.element.isConnected) { this.close('disconnected', {restore: false}); return; }
    const menu = this.#activeMenu(event.target), doc = this.document;
    if (menu.element.contains(event.target) && isEditable(event.target)) {
      if (event.key !== 'Escape') return;
    }
    const index = menu.buttons.indexOf(doc.activeElement);
    const button = menu.buttons[index], entry = button ? menu.entryByButton.get(button) : null;
    const action = menuKeyAction(event, {index, count: menu.buttons.length, submenu: Boolean(entry?.submenu && !entry.disabled),
      direction: this.document.documentElement.dir, nested: Boolean(menu.parent), menubar: Boolean(this.options.menubar)});
    event.stopImmediatePropagation();
    switch (action.type) {
      case 'move': event.preventDefault(); menu.focusIndex(action.index); break;
      case 'open-submenu': event.preventDefault(); menu.openSubmenu(button, {focus: 'first'}); break;
      case 'close-submenu': event.preventDefault(); menu.close('escape', {restore: true}); break;
      case 'close': if (action.reason === 'escape') event.preventDefault(); this.close(action.reason, {restore: true}); break;
      case 'menubar': event.preventDefault(); this.options.menubar.navigate(action.delta); break;
      case 'activate':
        event.preventDefault();
        button.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
          metaKey: event.metaKey, altKey: event.altKey}));
        break;
      case 'typeahead': {
        event.preventDefault();
        const found = findTypeahead(menu.buttons.map(item => item.querySelector('.ui-menu-label-text')?.textContent ?? item.querySelector('span')?.textContent ?? menu.entryByButton.get(item).label), menu.typeahead.push(action.character), index);
        if (found >= 0) menu.focusIndex(found);
        break;
      }
      default: break;
    }
  }

  #onClick(event) {
    const button = event.target.closest?.('.ui-menu-item');
    const entry = button && this.element.contains(button) ? this.entryByButton.get(button) : null;
    if (!entry) return;
    if (entry.disabled) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (entry.submenu) { event.stopPropagation(); this.openSubmenu(button, {focus: event.detail === 0 ? 'first' : 'none'}); return; }
    if (entry.keepOpen && entry.role !== 'menuitem') {
      entry.checked = entry.role === 'menuitemradio' ? true : !entry.checked;
      if (entry.role === 'menuitemradio')
        for (const other of this.buttons) {
          const peer = this.entryByButton.get(other);
          if (peer !== entry && peer.role === 'menuitemradio' && peer.group === entry.group) { peer.checked = false; other.setAttribute('aria-checked', 'false'); }
        }
      button.setAttribute('aria-checked', String(entry.checked));
    } else this.root.close('select', {restore: true});
    const select = this.root.options.onSelect;
    try {
      if (entry.run) { event.stopPropagation(); entry.run(event, entry); }
      else if (select) { event.stopPropagation(); select(entry, event); }
    } catch (error) { (this.root.options.onError ?? globalThis.reportError)?.(error); }
  }

  #onPointerMove(event) {
    if (event.pointerType === 'touch') return;
    const button = event.target.closest?.('.ui-menu-item');
    if (!button || !this.element.contains(button)) return;
    if (this.document.activeElement !== button) button.focus({preventScroll: true});
    const entry = this.entryByButton.get(button), root = this.root;
    if (this.child?.options.anchor === button) { root.#cancelIntent(); return; }
    root.#cancelIntent();
    if (entry.submenu && !entry.disabled) root.intent = setTimeout(() => this.openSubmenu(button, {focus: 'none'}), 150);
    else if (this.child) root.intent = setTimeout(() => this.child?.close('pointer', {restore: false}), 250);
  }

  #cancelIntent() { clearTimeout(this.intent); this.intent = 0; }

  openSubmenu(button, {focus = 'first'} = {}) {
    const entry = this.entryByButton.get(button);
    if (!this.isOpen || !entry?.submenu || entry.disabled) return null;
    if (this.child?.isOpen && this.child.options.anchor === button) {
      if (focus === 'first') this.child.focusIndex(0);
      return this.child;
    }
    this.child?.close('replace', {restore: false});
    const items = typeof entry.submenu === 'function' ? entry.submenu() : entry.submenu;
    const child = this.child = new Menu({items, anchor: button, parent: this, label: entry.label, labelKey:entry.labelKey, labelParams:entry.labelParams, document: this.document, focus});
    child.open();
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', child.element.id);
    return child;
  }

  /** Closes this menu and its submenus; `restore` puts focus back on the invoker (or, for a submenu, its row). */
  close(reason = 'close', {restore = true} = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.child?.close(reason, {restore: false});
    this.child = null;
    if (this === this.root) this.#cancelIntent();
    const {element} = this;
    const hadFocus = element.contains(this.document.activeElement);
    this.controller.abort();
    try { if (element.matches?.(':popover-open')) element.hidePopover(); } catch { /* already hidden */ }
    if (this.created) element.remove();
    else {
      element.setAttribute('hidden', '');
      if (this.addedClasses.length) element.classList.remove(...this.addedClasses);
      if (this.hostLabel === null) element.removeAttribute('aria-label'); else element.setAttribute('aria-label', this.hostLabel);
      element.removeAttribute('data-side');
    }
    if (this.parent) {
      const row = this.options.anchor;
      row.setAttribute('aria-expanded', 'false');
      row.removeAttribute('aria-controls');
      if (this.parent.child === this) this.parent.child = null;
      if (restore || hadFocus) row.focus({preventScroll: true});
      return;
    }
    for (const key of [this.anchorElement, element]) if (key && openMenus.get(key) === this) openMenus.delete(key);
    if (this.anchorElement && !openMenus.has(this.anchorElement)) {
      this.anchorElement.setAttribute('aria-expanded', 'false');
      if (this.anchorElement.getAttribute('aria-controls') === element.id) this.anchorElement.removeAttribute('aria-controls');
    }
    const returnTo = this.handle?.returnTo ?? [this.invoker];
    this.handle?.close(undefined, reason);
    // Focus goes back to the invoker when asked, or when it was inside the menu and is now lost;
    // an invoker that is hidden or gone hands over to what opened its own overlay, then the stage.
    const active = this.document.activeElement;
    if (restore || hadFocus || !active || active === this.document.body)
      focusFirst([...returnTo, this.anchorElement, this.options.overlays?.fallbackFocus?.()], {document: this.document});
    this.options.onClose?.(reason);
  }
}

// ---------------------------------------------------------------------------
// Menubar

/**
 * Makes `nav` a menubar: its buttons (`buttons()`, default `[data-app-menu], [data-menu]`)
 * are one tab stop with roving focus; a click, Enter, Space or ArrowDown opens
 * the button's menu (ArrowUp from the end); while a menu is open, hovering
 * another button or pressing Left and Right in the menu switches menus.
 * `menus` maps a button's name to its model (or a function returning it).
 * Every other option is passed to openMenu().
 */
export function installMenuBar(nav, {menus, signal, buttons = null, name = button => button.dataset.appMenu ?? button.dataset.menu, ...menuOptions} = {}) {
  const list = () => [...(buttons ? buttons() : nav.querySelectorAll('[data-app-menu], [data-menu]'))];
  nav.setAttribute('role', 'menubar');
  for (const button of list()) {
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
  }
  const roving = installRovingFocus(nav, {items: list, orientation: 'horizontal', signal});
  let current = null;
  const skip = all => index => all[index].disabled || all[index].hidden;
  const open = (button, {focus = 'first'} = {}) => {
    const model = menus[name(button)];
    if (!model) return null;
    current?.close('replace', {restore: false});
    button.setAttribute('aria-expanded', 'true');
    const menu = current = openMenu({...menuOptions, items: typeof model === 'function' ? model() : model, anchor: button, focus,
      label: menuOptions.label ?? button.textContent.trim(),
      menubar: {navigate: delta => {
        const all = list(), next = nextRovingIndex(delta > 0 ? "ArrowRight" : "ArrowLeft", all.indexOf(button), all.length, {skip: skip(all)});
        if (next === null) return;
        roving.focus(all[next]);
        open(all[next], {focus: 'first'});
      }},
      onClose: reason => {
        button.setAttribute('aria-expanded', 'false');
        if (current === menu) current = null;
        menuOptions.onClose?.(reason);
      }});
    return menu;
  };
  const buttonOf = target => list().find(button => button === target || button.contains(target)) ?? null;
  nav.addEventListener('click', event => {
    const button = buttonOf(event.target);
    if (!button) return;
    if (current?.isOpen && current.anchorElement === button) current.close('toggle', {restore: true});
    else open(button, {focus: 'first'});
  }, {signal});
  nav.addEventListener('keydown', event => {
    const button = buttonOf(event.target);
    if (!button || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    open(button, {focus: event.key === 'ArrowDown' ? 'first' : 'last'});
  }, {signal});
  nav.addEventListener('pointerover', event => {
    const button = buttonOf(event.target);
    if (button && current?.isOpen && current.anchorElement !== button && event.pointerType !== 'touch') {
      roving.focus(button);
      open(button, {focus: 'none'});
    }
  }, {signal});
  signal?.addEventListener('abort', () => current?.close('abort', {restore: false}), {once: true});
  return {
    open(target, options) { const button = typeof target === 'string' ? list().find(item => name(item) === target) : target; return button ? open(button, options) : null; },
    close(reason = 'close') { current?.close(reason, {restore: true}); },
    get openMenu() { return current?.isOpen ? current : null; },
    get openName() { return current?.isOpen ? name(current.anchorElement) : null; },
  };
}
