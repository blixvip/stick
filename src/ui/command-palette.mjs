import {replaceLocalized, localizedAttribute, localizedText, appendLocalized} from '../localization-bindings.mjs';
import {interfaceLocalization} from '../localization.mjs';

/**
 * The command palette: type to find any command (or anything a feature
 * provides: figures, layers, tutorials, settings) and run it with Enter. It is
 * an index of the registry, never a home of its own. Keyboard first: a
 * combobox with a listbox driven by aria-activedescendant.
 *
 * It is a modal dialog (a .ui-dialog, md, anchored near the top; the whole
 * window at the compact and minimal tiers), registered as the palette: the
 * rest of the window is inert behind the veil, the editor's hotkeys are off,
 * messages stay above it, and Escape, a press outside it or leaving the
 * window closes it. Tab is not trapped beyond what a modal dialog does.
 *
 * paletteGroups() is the pure part: the rows for a query. Recent commands come
 * first when the query is empty; typing a number offers "Go to frame N".
 */
import {COMMAND_BY_ID} from './command-catalog.mjs';
import {focusFirst} from './overlay-manager.mjs';
import {kitText} from './ui-strings.mjs';

/** The catalog entry of the action that opens the palette (a page without the app's action registers it with commands.define()). */
export const PALETTE_COMMAND = COMMAND_BY_ID.get('command-palette');

/**
 * The palette's groups for `query`: [{id, label, rows}] where a row is
 * {key, id, label, icon, meta, enabled, reason, ranges, run}. Providers are
 * {id, label, search(query, context) => rows}; `frameJump(n)` enables
 * "Go to frame N" for numeric queries. `t` translates the palette's own words.
 */
export function paletteGroups({commands, query = '', context, providers = [], frameJump = null, limit = 60, recentLabel = null,
  commandsLabel = null, t = null} = {}) {
  const text = String(query).trim(), groups = [];
  if (frameJump && /^\d{1,6}$/.test(text)) {
    const frame = Number(text);
    groups.push({id: 'goto', label: kitText(t, 'overlays.palette.goTo'), labelKey: 'overlays.palette.goTo', labelParams: {}, rows: [{key: `frame:${frame}`, id: null,
      label: kitText(t, 'overlays.palette.goToFrame', {frame}), labelKey: 'overlays.palette.goToFrame', labelParams: {frame}, icon: 'frame', meta: '', enabled: true, reason: '', ranges: [], run: () => frameJump(frame)}]});
  }
  recentLabel ??= kitText(t, 'overlays.palette.recent');
  commandsLabel ??= kitText(t, 'overlays.palette.commands');
  const toRow = command => ({key: `command:${command.id}`, id: command.id, label: command.label, icon: command.icon,
    meta: command.enabled ? command.shortcut : command.reason, enabled: command.enabled, reason: command.reason, ranges: command.match?.ranges ?? [], run: null});
  if (!text) {
    const recent = commands.recent().map(id => commands.get(id, context)).filter(command => command.palette && !command.hidden);
    if (recent.length) groups.push({id: 'recent', label: recentLabel, rows: recent.map(toRow)});
    const seen = new Set(recent.map(command => command.id));
    groups.push({id: 'commands', label: commandsLabel, rows: commands.list({context, limit: limit + seen.size}).filter(command => !seen.has(command.id)).slice(0, limit).map(toRow)});
  } else {
    const rows = commands.list({query: text, context, limit}).map(toRow);
    if (rows.length) groups.push({id: 'commands', label: commandsLabel, rows});
  }
  for (const provider of providers) {
    let found = [];
    try { found = text ? provider.search(text, context) ?? [] : []; } catch (error) { globalThis.reportError?.(error); }
    if (found.length) groups.push({id: provider.id, label: provider.label, rows: found.slice(0, limit).map((row, index) => ({key: `${provider.id}:${row.id ?? index}`,
      id: row.id ?? null, label: row.label, icon: row.icon ?? null, meta: row.meta ?? '', enabled: row.enabled !== false && !row.disabled,
      reason: row.reason ?? '', ranges: row.ranges ?? [], run: row.run}))});
  }
  return groups.filter(group => group.rows.length);
}

let paletteCount = 0;

/**
 * createCommandPalette({commands, overlays, providers, frameJump, icon,
 * context, topInset, openKeys, placeholder, label, emptyLabel, t, document})
 * Returns {element, input, open({invoker}), close(), toggle(), isOpen, addProvider, removeProvider, refresh}.
 * `openKeys(event)` is true for the keys that open the palette: pressed inside
 * it they select the query instead of reaching the browser (Ctrl+P prints).
 */
export function createCommandPalette({commands, overlays = null, providers = [], frameJump = null, icon = null, context = null, topInset = 0,
  openKeys = null, placeholder = null, label = null, emptyLabel = null, t = null, document: doc = globalThis.document} = {}) {
  const placeholderKey = placeholder === null ? 'overlays.palette.placeholder' : null;
  const labelKey = label === null ? 'overlays.palette.label' : null;
  const emptyKey = emptyLabel === null ? 'overlays.palette.empty' : null;
  placeholder ??= kitText(t, 'overlays.palette.placeholder');
  label ??= kitText(t, 'overlays.palette.label');
  emptyLabel ??= kitText(t, 'overlays.palette.empty');
  const id = `ui-palette-${++paletteCount}`;
  const element = doc.createElement('dialog');
  element.id = id;
  element.className = 'ui-dialog ui-palette';
  element.dataset.size = 'md';
  element.setAttribute('aria-label', label);
  if (labelKey) localizedAttribute(element, 'aria-label', labelKey);
  if ('closedBy' in element) element.closedBy = 'any';   // a press outside closes it (Chromium 134+; a pointerdown check below otherwise)
  const search = doc.createElement('div');
  search.className = 'ui-palette-search';
  const glyph = icon?.('search');
  if (typeof glyph === 'string') search.insertAdjacentHTML('beforeend', glyph); else if (glyph) appendLocalized(search, glyph);
  search.firstElementChild?.classList.add('ui-icon');
  const input = doc.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', placeholder);
  if (placeholderKey) {
    localizedAttribute(input, 'placeholder', placeholderKey);
    localizedAttribute(input, 'aria-label', placeholderKey);
  }
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', `${id}-list`);
  appendLocalized(search, input);
  // Where the palette fills the window (compact and minimal width) it has a close button, for pointer and pen.
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ui-icon-button ui-palette-close';
  localizedAttribute(closeButton, 'aria-label', 'common.close', {});
  const closeGlyph = icon?.('close');
  if (typeof closeGlyph === 'string') closeButton.insertAdjacentHTML('beforeend', closeGlyph); else if (closeGlyph) appendLocalized(closeButton, closeGlyph); else closeButton.textContent = '×';
  closeButton.addEventListener('click', () => close({restore: true}));
  appendLocalized(search, closeButton);
  const list = doc.createElement('div');
  list.className = 'ui-palette-list';
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  if (labelKey) localizedAttribute(list, 'aria-label', labelKey);
  appendLocalized(element, search, list);

  const sources = [...providers];
  let open = false, rows = [], active = -1, controller = null, handle = null, invoker = null;
  const currentContext = () => { try { return context?.(); } catch { return undefined; } };

  const highlight = (target, text, ranges) => {
    const characters = Array.from(text);
    let at = 0;
    for (const [start, end] of ranges) {
      if (start > at) appendLocalized(target, doc.createTextNode(characters.slice(at, start).join('')));
      const mark = doc.createElement('mark');
      mark.textContent = characters.slice(start, end).join('');
      appendLocalized(target, mark);
      at = end;
    }
    if (at < characters.length) appendLocalized(target, doc.createTextNode(characters.slice(at).join('')));
  };

  function render() {
    const groups = paletteGroups({commands, query: input.value, context: currentContext(), providers: sources, frameJump, t});
    rows = [];
    replaceLocalized(list);
    groups.forEach((group, groupIndex) => {
      const section = doc.createElement('div'), heading = doc.createElement('div');
      section.setAttribute('role', 'group');
      heading.className = 'ui-palette-group';
      heading.id = `${id}-group-${groupIndex}`;
      heading.textContent = group.label;
      section.setAttribute('aria-labelledby', heading.id);
      appendLocalized(section, heading);
      for (const row of group.rows) {
        const option = doc.createElement('div');
        option.className = 'ui-palette-row';
        option.id = `${id}-option-${rows.length}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        if (!row.enabled) option.setAttribute('aria-disabled', 'true');
        if (row.id) option.dataset.command = row.id;
        const rowGlyph = row.icon && icon?.(row.icon);
        if (typeof rowGlyph === 'string') option.insertAdjacentHTML('beforeend', rowGlyph); else if (rowGlyph) appendLocalized(option, rowGlyph);
        option.firstElementChild?.classList.add('ui-icon');
        if (!rowGlyph) { const pad = doc.createElement('i'); pad.className = 'ui-palette-pad'; pad.setAttribute('aria-hidden', 'true'); appendLocalized(option, pad); }
        const name = doc.createElement('span');
        name.className = 'ui-palette-label';
        highlight(name, row.label, row.ranges);
        appendLocalized(option, name);
        if (row.meta) {
          const meta = doc.createElement(row.enabled && row.id && row.meta === commands.shortcut?.(row.id) ? 'kbd' : 'span');
          meta.className = 'ui-palette-meta';
          meta.textContent = row.meta;
          appendLocalized(option, meta);
        }
        const index = rows.length;
        option.addEventListener('pointermove', () => { if (active !== index) setActive(index, false); });
        option.addEventListener('click', () => { setActive(index, false); runActive(); });
        rows.push({...row, option});
        appendLocalized(section, option);
      }
      appendLocalized(list, section);
    });
    if (!rows.length) {
      const empty = doc.createElement('div');
      empty.className = 'ui-palette-empty';
      empty.textContent = emptyLabel;
      if (emptyKey) localizedText(empty, emptyKey);
      appendLocalized(list, empty);
    }
    // The first row Enter can run (a disabled row still explains itself when chosen).
    const runnable = rows.findIndex(row => row.enabled);
    setActive(runnable >= 0 ? runnable : rows.length ? 0 : -1);
  }

  function setActive(index, scroll = true) {
    rows[active]?.option.setAttribute('aria-selected', 'false');
    active = index;
    const row = rows[active];
    if (!row) { input.removeAttribute('aria-activedescendant'); return; }
    row.option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.option.id);
    if (scroll) row.option.scrollIntoView?.({block: 'nearest'});
  }

  function runActive() {
    const row = rows[active];
    if (!row || !row.enabled) return;
    close({restore: true});
    if (row.run) row.run();
    else commands.run(row.id, {source: 'palette'});
  }

  function onKeydown(event) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.target === closeButton && (event.key === 'Enter' || event.key === ' ')) return;   // the button's own click
    if (openKeys?.(event)) { event.preventDefault(); input.select(); return; }
    const count = rows.length;
    const move = {ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8}[event.key];
    if (move !== undefined) {
      event.preventDefault();
      if (count) setActive(Math.min(count - 1, Math.max(0, (active < 0 ? (move > 0 ? -1 : count) : active) + move)));
    } else if (event.key === 'Enter') { event.preventDefault(); runActive(); }
    else if (event.key === 'Escape') { event.preventDefault(); close({restore: true}); }
  }

  // A press on the veil: the event targets the dialog itself, outside its box.
  const outside = event => {
    if (event.target !== element) return false;
    const box = element.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };

  function show({invoker: from = doc.activeElement} = {}) {
    if (open) { input.select(); return; }
    invoker = from;
    if (element.parentElement !== doc.body) appendLocalized(doc.body, element);
    const view = doc.defaultView ?? globalThis;
    const inset = typeof topInset === 'function' ? topInset() : topInset;
    element.style.setProperty('--palette-top', `${Math.round(Math.max(inset + 8, view.innerHeight * 0.12))}px`);
    input.value = '';
    render();
    input.autofocus = true;
    element.showModal();
    open = true;
    controller = new AbortController();
    const {signal} = controller;
    const stopLanguage = interfaceLocalization.subscribe(() => {
      const selected = rows[active]?.key, scroll = list.scrollTop;
      render();
      const index = rows.findIndex(row => row.key === selected);
      if (index >= 0) setActive(index, false);
      list.scrollTop = scroll;
    });
    signal.addEventListener('abort', stopLanguage, {once: true});
    input.addEventListener('input', render, {signal});
    element.addEventListener('keydown', onKeydown, {signal});
    element.addEventListener('cancel', event => { event.preventDefault(); close({restore: true}); }, {signal});
    element.addEventListener('close', () => close({restore: false}), {signal});
    element.addEventListener('pointerdown', event => { if (outside(event)) close({restore: false}); }, {signal});
    view.addEventListener('blur', () => close({restore: false}), {signal});
    handle = overlays?.register(element, {kind: 'palette', modal: true, keyboardScope: true, invoker, returnFocus: false, closeOnEscape: false,
      onClose: () => close({restore: false})}) ?? null;
    input.focus({preventScroll: true});
  }

  function close({restore = true} = {}) {
    if (!open) return;
    open = false;
    controller.abort();
    if (element.open) element.close();
    const returnTo = handle?.returnTo ?? [invoker];
    handle?.close(undefined, 'close');
    handle = null;
    if (restore || doc.activeElement === doc.body || !doc.activeElement) focusFirst([...returnTo, overlays?.fallbackFocus?.()], {document: doc});
  }

  return {
    element, input,
    open: show, close,
    toggle(options) { if (open) close(); else show(options); },
    refresh() { if (open) render(); },
    addProvider(provider) { sources.push(provider); },
    removeProvider(provider) { const index = sources.indexOf(provider); if (index >= 0) sources.splice(index, 1); },
    get isOpen() { return open; },
  };
}
