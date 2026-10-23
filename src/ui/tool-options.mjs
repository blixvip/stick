import {replaceLocalized, localizedAttribute, localizedText, appendLocalized} from '../localization-bindings.mjs';
import {messageError} from '../localized-error.mjs';

import {t as interfaceText, messageText as toolOptionsText} from '../localization.mjs';

/**
 * The tool options bar: the active tool's everyday options, one row in the
 * stage header's start (components.md "Tool options bar", experience.md §4.2,
 * architecture.md §0.1-0.2 and §3.12). A tool declares its options as
 * descriptors and the bar is rendered from them, so a new tool adds
 * descriptors and a fold order, never layout. The tool's complete settings
 * stay in its inspector section; the bar never holds the only copy of a
 * setting.
 *
 * Descriptor fields, every kind:
 *   id          unique within the bar; the item's root carries data-option
 *   kind        'toggle' | 'toggles' | 'button' | 'split' | 'select' | 'field' |
 *               'stepper' | 'colors' | 'recent' | 'segmented'
 *   label       the option's name: shown by labelled kinds, else the accessible name
 *   group       consecutive items with one group share a cluster (default: a
 *               cluster of its own); a nested array of descriptors is a cluster too
 *   fold        when the header is too narrow, items fold lowest first; an item
 *               without it never folds
 *   labelFold   the order visible labels drop in (default: fold, then from the
 *               row's end); every label drops before any item folds
 *   twin        folded, the option is shown by its twin in the tool's inspector
 *               section instead: the twin's id, reported through onFold
 *   home        folded, the option lives where it already does ("Brush details ›
 *               Dynamics") and is not listed in More options
 *   command     a registry id: data-action (the app's click delegation runs it),
 *               and the label, glyph, shortcut and checked state by default
 *   shiftCommand  data-shift-action
 *   icon, tip, shortcut, concept, disabled
 *   elementId   an existing contract id kept on the control (#rig-mode, #builder-branch)
 *   attributes  extra data-* and aria-* hooks for the control ({'data-draw-setting': 'pressure'})
 * Kind fields:
 *   toggle      pressed; accent: true for a mode that changes what edits do
 *               (blue when on; view toggles stay quiet); showLabel for a labelled toggle
 *   toggles     items: toggles sharing one visible label ("Mirror" and its pair)
 *   button      showLabel (a button without a glyph always shows its word)
 *   split       a toggle (toggle: false for a command) with more: {label, command,
 *               id, haspopup} for its chevron
 *   select      options [{value, label}], value, showLabel (an outside label, "Drag")
 *   field       property (the PropertyControls key: it owns scrubbing and typing),
 *               value, unit, step, precision, displayPrecision, min, max, vch
 *   stepper     value, min, max, step, precision, showLabel
 *   colors      stroke, fill (#rrggbb), picker (default true: data-paint-picker),
 *               swap: {command, label, icon}
 *   recent      colors: [#rrggbb], max
 *   segmented   options [{value, label, icon}], value, iconOnly
 *
 * planToolOptions() is the pure fold model; createToolOptions() is the thin DOM
 * half: it renders, measures, folds, keeps the bar one tab stop with arrow
 * keys (roving focus) and shows folded items in the More options popover (the
 * controls themselves move there while it is open, keeping their ids and
 * hooks). Controls with a command run through the app's [data-action]
 * delegation; everything else reports through onChange.
 */
import {computeOverflow, OVERFLOW_ATTRIBUTE} from './toolbar-overflow.mjs';
import {installRovingFocus} from './roving-focus.mjs';
import {createPopover} from './ui-popover.mjs';
import {formatPropertyValue} from '../property-controls.mjs';

export const OPTION_KINDS = Object.freeze(['toggle', 'toggles', 'button', 'split', 'select', 'field', 'stepper', 'colors', 'recent', 'segmented']);

export {toolOptionsText};

const ID = /^[A-Za-z][\w:.-]*$/;
const ATTRIBUTE = /^(?:data|aria)-[a-z][a-z0-9-]*$/;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SUB_KINDS = new Set(['toggle', 'button']);
const finiteOrNull = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** A colour a swatch may show, or null. */
export const optionColor = value => (COLOR.test(String(value ?? '').trim()) ? String(value).trim() : null);

/** True when the item shows a word that may drop to save room (labelled toggles and buttons, set, select and stepper labels). */
export function hasDroppableLabel(descriptor) {
  if (descriptor.dropLabel === false || !descriptor.label) return false;
  switch (descriptor.kind) {
    case 'toggle': case 'button': return Boolean(descriptor.showLabel) && Boolean(descriptor.icon ?? descriptor.command);
    case 'toggles': return true;
    case 'select': case 'stepper': return Boolean(descriptor.showLabel);
    default: return false;
  }
}

function checkDescriptor(descriptor, where, ids, sub = false) {
  if (!descriptor || typeof descriptor !== 'object') throw messageError(new TypeError(''), "errors.toolOptions.toolOptionIsNotADescriptor", {where: where});
  const {id, kind} = descriptor;
  if (!ID.test(String(id ?? ''))) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionNeedsAnId", {where: where});
  if (sub ? !SUB_KINDS.has(kind) : !OPTION_KINDS.includes(kind)) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionHasAnUnsupportedKind", {id: id, kind: kind});
  if (ids.has(id)) throw messageError(new TypeError(''), "errors.toolOptions.duplicateToolOptionId", {id: id});
  ids.add(id);
  if (descriptor.elementId !== undefined && !ID.test(String(descriptor.elementId))) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionHasAnInvalidElementId", {id: id});
  if (descriptor.twin !== undefined && descriptor.twin !== null && !ID.test(String(descriptor.twin))) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionHasAnInvalidTwinId", {id: id});
  if (descriptor.home !== undefined && descriptor.home !== null && typeof descriptor.home !== 'string') throw messageError(new TypeError(''), "errors.toolOptions.toolOptionHasAnInvalidHome", {id: id});
  for (const name of Object.keys(descriptor.attributes ?? {}))
    if (!ATTRIBUTE.test(name)) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionOnlyDataAndAriaAttributesMay", {id: id, name: name});
  if (kind === 'toggles') {
    if (!descriptor.items?.length) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionListsNoToggles", {id: id});
    descriptor.items.forEach((item, index) => checkDescriptor(item, `${id}.${index}`, ids, true));
  }
  if ((kind === 'select' || kind === 'segmented') && !descriptor.options?.length) throw messageError(new TypeError(''), "errors.toolOptions.toolOptionHasNoOptions", {id: id});
}

/**
 * Descriptors (flat, or nested arrays for clusters) → frozen items in row
 * order with {cluster, index, fold, labelFold, droppable}. Throws on
 * malformed descriptors: they are the tool's code, not user data.
 */
export function normalizeToolOptions(input = []) {
  const items = [], ids = new Set();
  let cluster = -1, lastGroup = null;
  const push = (descriptor, where, clusterIndex) => {
    checkDescriptor(descriptor, where, ids);
    items.push(Object.freeze({...descriptor, cluster: clusterIndex, index: items.length, fold: finiteOrNull(descriptor.fold),
      labelFold: finiteOrNull(descriptor.labelFold), droppable: hasDroppableLabel(descriptor)}));
  };
  (input ?? []).forEach((entry, position) => {
    if (Array.isArray(entry)) {
      cluster++;
      lastGroup = null;
      entry.forEach((descriptor, index) => push(descriptor, `${position}.${index}`, cluster));
      return;
    }
    const group = entry?.group ?? null;
    if (group === null || group !== lastGroup) cluster++;
    lastGroup = group;
    push(entry, String(position), cluster);
  });
  return Object.freeze(items);
}

const rank = value => (value === null || value === undefined ? Infinity : value);

/**
 * The fold model. `items` are normalized items in row order, each with
 * `width` (its box with its label shown) and `labelWidth` (what dropping its
 * label saves). `gap` separates items of a cluster, `groupGap` clusters and
 * the More options button (`moreWidth`), which shows only while a folded
 * item has neither a twin nor a home.
 *
 * Labels drop first (labelFold, then fold, then from the row's end); then
 * items fold, lowest fold first and the later of equals first
 * (toolbar-overflow's computeOverflow). Items without a fold stay, unless
 * even that row does not fit: then they move into More options from the
 * row's end rather than being cut off. Returns {dropped, folded, more, twins,
 * homes, forced, width, fits}: ids of dropped labels and folded items, the
 * folded items More options lists, the twin ids to show, [{id, home}] for
 * folded items that went home, the items that had to fold without declaring
 * it, the row's width and whether it fits.
 */
export function planToolOptions({items = [], available = Infinity, gap = 4, groupGap = 12, moreWidth = 24} = {}) {
  const count = items.length, dropped = new Set();
  let hidden = new Set();
  const widthOf = index => Math.max(0, (Number(items[index].width) || 0) - (dropped.has(index) ? Number(items[index].labelWidth) || 0 : 0));
  const needsMore = set => [...set].some(index => !items[index].twin && !items[index].home);
  const measure = (set = hidden) => {
    let width = 0, previous = -1;
    for (let index = 0; index < count; index++) {
      if (set.has(index)) continue;
      if (previous >= 0) width += items[previous].cluster === items[index].cluster ? gap : groupGap;
      width += widthOf(index);
      previous = index;
    }
    if (needsMore(set)) width += (previous >= 0 ? groupGap : 0) + moreWidth;
    return width;
  };
  if (measure() > available) {
    const labels = items.map((item, index) => index).filter(index => (Number(items[index].labelWidth) || 0) > 0)
      .sort((a, b) => rank(items[a].labelFold ?? items[a].fold) - rank(items[b].labelFold ?? items[b].fold) || b - a);
    for (const index of labels) {
      if (measure() <= available) break;
      dropped.add(index);
    }
  }
  if (measure() > available) {
    // computeOverflow takes one gap: each cluster's first item carries the extra cluster gap, and the More
    // button's room is `gap + moreWidth` once anything folds (none while only twins and homes fold). When a
    // cluster's first item folds and the rest of it stays, that estimate falls short of the real row, so the
    // budget shrinks by the difference and the fold runs again; it only ever folds more.
    const entries = items.map((item, index) => ({
      width: widthOf(index) + (index > 0 && items[index - 1].cluster !== item.cluster ? groupGap - gap : 0),
      priority: item.fold ?? 0, pinned: item.fold === null || item.fold === undefined,
    }));
    const foldable = entries.filter(entry => !entry.pinned).length;
    let budget = available;
    for (let attempt = 0; attempt <= count; attempt++) {
      let estimate = computeOverflow({items: entries, available: budget, gap, moreWidth: -gap});
      if (needsMore(new Set(estimate.overflow))) estimate = computeOverflow({items: entries, available: budget, gap, moreWidth: moreWidth + groupGap - gap});
      hidden = new Set(estimate.overflow);
      const width = measure();
      if (width <= available || hidden.size >= foldable) break;
      budget = Math.min(budget - 1, available - (width - estimate.width));
    }
  }
  // Never cut: when the declared folds are not enough, the items that declare none move into More options
  // too, from the row's end (`forced` names them, for audits: the tool's fold order misses this width).
  const forced = [];
  for (let index = count - 1; index >= 0 && measure() > available; index--) {
    if (hidden.has(index)) continue;
    hidden.add(index);
    forced.unshift(index);
  }
  const byIndex = list => [...list].sort((a, b) => a - b);
  const folded = byIndex(hidden);
  const width = measure();
  return {
    dropped: byIndex(dropped).map(index => items[index].id),
    folded: folded.map(index => items[index].id),
    more: folded.filter(index => !items[index].twin && !items[index].home).map(index => items[index].id),
    twins: [...new Set(folded.filter(index => items[index].twin).map(index => items[index].twin))],
    homes: folded.filter(index => !items[index].twin && items[index].home).map(index => ({id: items[index].id, home: items[index].home})),
    forced: forced.map(index => items[index].id),
    width, fits: width <= available,
  };
}

// The state a same-structure update() writes in place. Every other field is structure: it is built into the
// controls (tip, attributes, accent, limits, property hooks) or decides the fold (fold, labelFold, twin, home).
const STATE_FIELDS = new Set(['value', 'pressed', 'disabled', 'stroke', 'fill', 'colors']);
const stable = value => (Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.keys(value).sort().map(name => [name, stable(value[name])]) : value);
const structureOf = item => Object.keys(item).sort().filter(name => !STATE_FIELDS.has(name))
  .map(name => [name, name === 'items' && Array.isArray(item.items) ? item.items.map(structureOf) : stable(item[name])]);
/** The structure that decides whether update() re-renders or only writes state. */
export function structureKey(items) {
  return JSON.stringify(items.map(structureOf));
}

// ---------------------------------------------------------------------------
// DOM

const EDIT_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
const DELETE_KEYS = new Set(["Backspace", "Delete"]);
const GLUED_UNITS = new Set(['%', '°', '×']);
const CONTROLS = 'button, input, select';

function setAttribute(element, name, value) {
  if (value === null || value === undefined || value === false) { if (element.hasAttribute(name)) element.removeAttribute(name); return; }
  const text = value === true ? '' : String(value);
  if (element.getAttribute(name) !== text) element.setAttribute(name, text);
}
function setProperty(element, name, value) {
  if (value === null || value === undefined) { if (element.style.getPropertyValue(name)) element.style.removeProperty(name); return; }
  if (element.style.getPropertyValue(name) !== String(value)) element.style.setProperty(name, String(value));
}
function conceal(element) {
  if (element.hasAttribute(OVERFLOW_ATTRIBUTE)) return;
  element.style.setProperty('display', 'none', 'important');
  element.setAttribute(OVERFLOW_ATTRIBUTE, '');
}
function reveal(element) {
  if (!element.hasAttribute(OVERFLOW_ATTRIBUTE)) return;
  element.style.removeProperty('display');
  element.removeAttribute(OVERFLOW_ATTRIBUTE);
}

/**
 * createToolOptions({descriptors, label, role, tool, registry, context, icon,
 * t, onChange, onFold, overlays, popoverMount, document}) → {element,
 * update(descriptors, {label, tool}), invalidate(), state, destroy()}.
 *
 *   registry   the command registry: labels, glyphs, shortcuts and checked
 *              states of descriptors with a `command`
 *   context    () => the registry context (default: the registry's own)
 *   icon       (name, className) => SVG string or node (icons.mjs icon)
 *   onChange   ({id, value, part, element, event}) for controls without a
 *              command: a toggle's new state, a select's, segment's, recent
 *              colour's or stepper's value, a field's committed value (fields
 *              with a `property` belong to PropertyControls and do not report),
 *              part 'colors' for the colour pair and 'more' for a split's chevron
 *   onFold     ({dropped, folded, more, twins, homes, forced}) whenever it differs
 *              from the last report (a new tool reports its own, or an empty one
 *              while the bar is hidden): the owner shows the twins in the tool's
 *              inspector section
 *   popoverMount  the element More options mounts its popover in: the container
 *              the owner attached PropertyControls to (the stage header), so a
 *              folded scrub field still scrubs and commits there. The default
 *              ('auto': the overlay kit's choice, document.body) leaves property
 *              fields in More options without PropertyControls; never attach
 *              PropertyControls to the body instead (it would handle the
 *              inspector's fields a second time).
 *
 * The owner places `element` where it gets its width from layout (the stage
 * header's start, flex 1); it never sizes itself to its content. The bar
 * measures again when an item's size drifts (the fonts load, a label is
 * translated); invalidate() forces it.
 */
export function createToolOptions({descriptors = [], label = '', labelKey, labelParams, role = 'group', tool = '', registry = null, context = null, icon = null, t = null,
  onChange = null, onFold = null, overlays = null, popoverMount = 'auto', document: doc = globalThis.document, Observer = globalThis.ResizeObserver,
  requestFrame = callback => globalThis.requestAnimationFrame(callback), cancelFrame = id => globalThis.cancelAnimationFrame(id)} = {}) {
  const view = doc.defaultView ?? globalThis;
  const controller = new AbortController(), {signal} = controller;
  const element = doc.createElement('div');
  element.className = 'ui-optbar';
  element.setAttribute('role', role);
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'ui-icon-button ui-optbar-more';
  more.dataset.size = 'sm';
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', toolOptionsText(t, 'toolOptions.more'));
  more.dataset.tooltip = toolOptionsText(t, 'toolOptions.moreTip');
  localizedAttribute(more, 'aria-label', 'toolOptions.more');
  localizedAttribute(more, 'data-tooltip', 'toolOptions.moreTip');
  more.hidden = true;
  appendGlyph(more, 'chevron-down');

  let items = [], key = '', roots = new Map(), groups = [], byId = new Map(), measured = null, frame = 0, labelDrops = new Set();
  let gaps = {gap: 4, groupGap: 12, moreWidth: 24}, plan = emptyPlan(), popover = null, pressOpen = false;
  const placeholders = new Map(), editing = new WeakSet(), glyphless = new WeakSet();
  let reported = foldKey(plan);

  function emptyPlan() { return {dropped: [], folded: [], more: [], twins: [], homes: [], forced: [], width: 0, fits: true}; }
  function foldKey(value) { return JSON.stringify([value.dropped, value.folded, value.more, value.twins, value.homes, value.forced]); }
  function say(textKey, params) { return toolOptionsText(t, textKey, params); }
  function appendGlyph(parent, name, className = 'ui-icon') {
    if (!name || typeof icon !== 'function') return false;
    const glyph = icon(name, className);
    if (typeof glyph === 'string' && glyph) parent.insertAdjacentHTML('beforeend', glyph);
    else if (glyph?.nodeType) appendLocalized(parent, glyph);
    else return false;
    return true;
  }
  function describe(command) {
    if (!command || !registry?.get || (registry.has && !registry.has(command))) return null;
    try { return registry.get(command, typeof context === 'function' ? context() : undefined); } catch { return null; }
  }
  const node = (tag, className, text) => {
    const created = doc.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };

  // Common hooks: contract id, extra attributes, tooltip, shortcut, concept.
  function decorate(control, item, command) {
    if (item.elementId) control.id = item.elementId;
    for (const [name, value] of Object.entries(item.attributes ?? {})) setAttribute(control, name, value);
    if (item.tip) control.dataset.tooltip = item.tip;
    const shortcut = item.shortcut ?? command?.shortcut;
    if (shortcut) control.dataset.hotkeyHint = shortcut;
    if (command?.keyshortcuts) control.setAttribute('aria-keyshortcuts', command.keyshortcuts);
    control.dataset.concept = item.concept ?? item.command ?? item.id;
  }
  const nameOf = (item, command = describe(item.command)) => item.label ?? command?.label ?? item.id;

  function buildButton(item, {toggle = false, part = toggle ? 'toggle' : 'button'} = {}) {
    const command = describe(item.command);
    const name = nameOf(item, command);
    const button = node('button');
    // A button whose glyph did not render shows its word, and that word never drops (it would leave an empty square).
    const drawn = appendGlyph(button, item.icon ?? command?.icon ?? null);
    if (!drawn) glyphless.add(button);
    const labelled = Boolean(item.showLabel) || !drawn;
    button.className = labelled ? 'ui-button' : 'ui-icon-button';
    button.type = 'button';
    if (labelled) { button.dataset.size = 'sm'; button.dataset.variant = 'ghost'; }
    if (toggle && !item.accent) button.dataset.quiet = '';
    button.dataset.optionId = item.id;
    button.dataset.optionPart = part;
    if (item.command) button.dataset.action = item.command;
    if (item.shiftCommand) button.dataset.shiftAction = item.shiftCommand;
    if (labelled) appendLocalized(button, node('span', 'ui-label', name));
    else button.setAttribute('aria-label', name);
    decorate(button, item, command);
    syncButton(button, item, toggle);
    return button;
  }
  function syncButton(button, item, toggle) {
    const command = describe(item.command);
    if (toggle) setAttribute(button, 'aria-pressed', String(Boolean(item.pressed ?? command?.checked)));
    const disabled = Boolean(item.disabled ?? (command ? !command.enabled : false));
    if (button.disabled !== disabled) button.disabled = disabled;
  }

  function buildSelect(item) {
    const root = node('div', 'ui-optbar-select');
    if (item.showLabel && item.label) {
      const text = node('span', 'ui-optbar-label', item.label);
      if (item.labelKey) localizedText(text, item.labelKey, item.labelParams);
      text.setAttribute('aria-hidden', 'true');
      appendLocalized(root, text);
    }
    const wrap = node('span', 'ui-select');
    wrap.dataset.size = 'sm';
    const select = node('select');
    select.dataset.optionId = item.id;
    select.dataset.optionPart = 'select';
    select.setAttribute('aria-label', item.description ?? item.label ?? item.id);
    if (item.descriptionKey || item.labelKey) localizedAttribute(select, 'aria-label', item.descriptionKey ?? item.labelKey, item.descriptionKey ? item.descriptionParams : item.labelParams);
    for (const option of item.options) {
      const entry = node('option', '', option.label ?? String(option.value));
      entry.value = String(option.value);
      if (option.labelKey) localizedText(entry, option.labelKey, option.labelParams);
      appendLocalized(select, entry);
    }
    decorate(select, item, null);
    appendLocalized(wrap, select);
    appendGlyph(wrap, 'chevron-down', 'ui-icon ui-select-chev');
    appendLocalized(root, wrap);
    syncSelect(root, item);
    return root;
  }
  function syncSelect(root, item) {
    const select = root.querySelector('select');
    const value = item.value === undefined ? select.value : String(item.value);
    if (select.value !== value && doc.activeElement !== select) select.value = value;
    const disabled = Boolean(item.disabled);
    if (select.disabled !== disabled) select.disabled = disabled;
  }

  function buildField(item) {
    const root = node('div', 'ui-field');
    root.dataset.inline = '';
    root.dataset.size = 'sm';
    if (item.property) root.dataset.propertyRow = item.property;
    setProperty(root, '--_vch', finiteOrNull(item.vch));
    const name = item.label ?? item.id;
    const text = node('span', 'ui-field-label', name);
    if (item.property) text.dataset.propertyScrub = '';
    const input = node('input', 'ui-field-input');
    input.type = 'number';
    input.step = 'any';
    input.dataset.optionId = item.id;
    input.dataset.optionPart = 'field';
    input.setAttribute('aria-label', item.description ?? (item.unit ? `${name} (${item.unit})` : name));
    if (finiteOrNull(item.min) !== null) input.min = String(item.min);
    if (finiteOrNull(item.max) !== null) input.max = String(item.max);
    if (item.property) {
      input.dataset.property = item.property;
      input.dataset.propertyPrecision = String(item.precision ?? 2);
      input.dataset.propertyDisplayPrecision = String(item.displayPrecision ?? item.precision ?? 0);
      input.dataset.propertyStep = String(item.step ?? 1);
    }
    decorate(input, item, null);
    input.addEventListener('keydown', fieldKey, {signal});
    appendLocalized(root, text, input);
    if (item.unit) {
      const suffix = node('span', 'ui-field-suffix', item.unit);
      if (GLUED_UNITS.has(item.unit)) suffix.dataset.glue = '';   // '100%', '15°'; '8 px' keeps its space
      suffix.setAttribute('aria-hidden', 'true');
      appendLocalized(root, suffix);
    }
    syncField(root, item);
    return root;
  }
  function syncField(root, item) {
    const input = root.querySelector('input');
    const value = finiteOrNull(item.value);
    if (item.property) setAttribute(input, 'data-property-value', value);
    // A value being typed stays as the person left it.
    if (value !== null && doc.activeElement !== input) {
      const text = formatPropertyValue(value, item.displayPrecision ?? item.precision ?? 0);
      if (input.value !== text) input.value = text;
    }
    const disabled = Boolean(item.disabled);
    if (input.disabled !== disabled) input.disabled = disabled;
  }

  function buildStepper(item) {
    const root = node('div', 'ui-optbar-stepper');
    const name = item.label ?? item.id;
    if (item.showLabel && item.label) {
      const text = node('span', 'ui-optbar-label', item.label);
      text.setAttribute('aria-hidden', 'true');
      appendLocalized(root, text);
    }
    const stepper = node('div', 'ui-stepper');
    stepper.dataset.size = 'sm';
    stepper.setAttribute('role', 'group');
    stepper.setAttribute('aria-label', name);
    const step = direction => {
      const button = node('button', 'ui-icon-button');
      button.type = 'button';
      button.dataset.size = 'sm';
      button.dataset.optionId = item.id;
      button.dataset.optionPart = 'step';
      button.dataset.optionStep = String(direction);
      localizedAttribute(button, 'aria-label', 'toolOptions.settings', {name});
      if (!appendGlyph(button, direction < 0 ? 'minus' : 'plus')) button.textContent = direction < 0 ? '−' : '+';
      return button;
    };
    const input = node('input', 'ui-stepper-input');
    input.type = 'number';
    input.dataset.optionId = item.id;
    input.dataset.optionPart = 'stepper';
    input.setAttribute('aria-label', item.description ?? name);
    if (finiteOrNull(item.min) !== null) input.min = String(item.min);
    if (finiteOrNull(item.max) !== null) input.max = String(item.max);
    input.step = String(item.step ?? 1);
    decorate(input, item, null);
    input.addEventListener('keydown', fieldKey, {signal});
    appendLocalized(stepper, step(-1), input, step(1));
    appendLocalized(root, stepper);
    syncStepper(root, item);
    return root;
  }
  function syncStepper(root, item) {
    const input = root.querySelector('input');
    const value = finiteOrNull(item.value);
    if (value !== null && doc.activeElement !== input) {
      const text = formatPropertyValue(value, item.precision ?? 0);
      if (input.value !== text) input.value = text;
    }
    const disabled = Boolean(item.disabled);
    for (const control of root.querySelectorAll(CONTROLS)) if (control.disabled !== disabled) control.disabled = disabled;
  }

  function buildColors(item) {
    const root = node('div', 'ui-optbar-colors');
    const pair = node('button', 'ui-optbar-pair');
    pair.type = 'button';
    pair.dataset.optionId = item.id;
    pair.dataset.optionPart = 'colors';
    pair.setAttribute('aria-haspopup', 'dialog');
    if (item.picker !== false) pair.dataset.paintPicker = '';
    for (const part of ['stroke', 'fill']) {
      const swatch = node('span', 'ui-swatch');
      swatch.dataset.role = part;
      swatch.setAttribute('aria-hidden', 'true');
      appendLocalized(pair, swatch);
    }
    decorate(pair, item, null);
    appendLocalized(root, pair);
    if (item.swap) {
      const swap = buildButton({id: `${item.id}-swap`, label: item.swap.label ?? (item.swap.command ? undefined : say("toolOptions.swap")),
        icon: item.swap.icon, command: item.swap.command, tip: item.swap.tip}, {part: 'swap'});
      swap.dataset.size = 'sm';
      swap.dataset.optionId = item.id;
      appendLocalized(root, swap);
    }
    syncColors(root, item);
    return root;
  }
  function syncColors(root, item) {
    const pair = root.querySelector('.ui-optbar-pair');
    const stroke = optionColor(item.stroke), fillColor = optionColor(item.fill);
    setProperty(pair.querySelector('[data-role="stroke"]'), '--swatch', stroke);
    setProperty(pair.querySelector('[data-role="fill"]'), '--swatch', fillColor);
    setAttribute(pair, 'aria-label', say("toolOptions.colors", {name: item.label ?? item.id, stroke: (stroke ?? '').toUpperCase(), fill: (fillColor ?? '').toUpperCase()}));
    const disabled = Boolean(item.disabled);
    for (const control of root.querySelectorAll(CONTROLS)) if (control.disabled !== disabled) control.disabled = disabled;
  }

  function buildRecent(item) {
    const root = node('div', 'ui-optbar-recent');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', item.label ?? say("toolOptions.recent"));
    syncRecent(root, item);
    return root;
  }
  function syncRecent(root, item) {
    const colors = (item.colors ?? []).map(optionColor).filter(Boolean).slice(0, Math.max(0, finiteOrNull(item.max) ?? 6));
    const current = [...root.children].map(button => button.dataset.value);
    if (current.length === colors.length && current.every((value, index) => value === colors[index])) return;
    replaceLocalized(root, ...colors.map(color => {
      const button = node('button', 'ui-swatch');
      button.type = 'button';
      button.dataset.optionId = item.id;
      button.dataset.optionPart = 'recent';
      button.dataset.value = color;
      localizedAttribute(button, 'aria-label', 'toolOptions.color', {value: color.toUpperCase()});
      button.style.setProperty('--swatch', color);
      return button;
    }));
    roving?.refresh();
  }

  function buildSegmented(item) {
    const root = node('div', 'ui-segmented');
    root.dataset.size = 'sm';
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', item.description ?? item.label ?? item.id);
    for (const option of item.options) {
      const button = node('button', 'ui-segmented-item');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.dataset.optionId = item.id;
      button.dataset.optionPart = 'segment';
      button.dataset.value = String(option.value);
      const glyph = appendGlyph(button, option.icon);
      if (item.iconOnly && glyph) {
        button.setAttribute('aria-label', option.label ?? String(option.value));
        button.dataset.tooltip = option.tip ?? option.label ?? String(option.value);
      } else appendLocalized(button, node('span', 'ui-label', option.label ?? String(option.value)));
      appendLocalized(root, button);
    }
    syncSegmented(root, item);
    return root;
  }
  function syncSegmented(root, item) {
    const value = item.value === undefined ? null : String(item.value);
    for (const button of root.children) {
      setAttribute(button, 'aria-checked', String(button.dataset.value === value));
      const disabled = Boolean(item.disabled);
      if (button.disabled !== disabled) button.disabled = disabled;
    }
  }

  function buildSplit(item) {
    const root = node('div', 'ui-split');
    const command = describe(item.command);
    const name = nameOf(item, command);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', name);
    const toggle = item.toggle !== false;
    appendLocalized(root, buildButton({...item, showLabel: false, elementId: item.elementId}, {toggle}));
    const chevron = node('button', 'ui-split-more');
    chevron.type = 'button';
    chevron.dataset.optionId = item.id;
    chevron.dataset.optionPart = 'more';
    chevron.setAttribute('aria-haspopup', item.more?.haspopup ?? 'dialog');
    chevron.setAttribute('aria-expanded', 'false');
    chevron.setAttribute('aria-label', item.more?.label ?? say("toolOptions.settings", {name}));
    if (item.more?.id) chevron.id = item.more.id;
    if (item.more?.command) chevron.dataset.action = item.more.command;
    if (!appendGlyph(chevron, 'chevron-down')) chevron.textContent = '▾';
    appendLocalized(root, chevron);
    return root;
  }

  function buildSet(item) {
    const root = node('div', 'ui-optbar-set');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', item.description ?? item.label ?? item.id);
    if (item.label) {
      const text = node('span', 'ui-optbar-label', item.label);
      text.setAttribute('aria-hidden', 'true');
      appendLocalized(root, text);
    }
    for (const sub of item.items) appendLocalized(root, buildButton(sub, {toggle: sub.kind === 'toggle'}));
    return root;
  }

  const BUILD = {toggle: item => buildButton(item, {toggle: true}), button: item => buildButton(item), toggles: buildSet, split: buildSplit,
    select: buildSelect, field: buildField, stepper: buildStepper, colors: buildColors, recent: buildRecent, segmented: buildSegmented};

  function sync(item) {
    const root = roots.get(item.id);
    if (!root) return;
    switch (item.kind) {
      case 'toggle': case 'button': syncButton(root, item, item.kind === 'toggle'); break;
      case 'toggles': for (const sub of item.items) { const button = root.querySelector(`[data-option-id="${sub.id}"]`); if (button) syncButton(button, sub, sub.kind === 'toggle'); } break;
      case 'split': syncButton(root.querySelector('[data-option-part="toggle"], [data-option-part="button"]'), item, item.toggle !== false); break;
      case 'select': syncSelect(root, item); break;
      case 'field': syncField(root, item); break;
      case 'stepper': syncStepper(root, item); break;
      case 'colors': syncColors(root, item); break;
      case 'recent': syncRecent(root, item); break;
      case 'segmented': syncSegmented(root, item); break;
    }
  }

  function render() {
    closeMore();
    const focused = element.contains(doc.activeElement) ? doc.activeElement.dataset.optionId ?? null : null;
    for (const root of roots.values()) resize?.unobserve(root);
    roots = new Map();
    groups = [];
    byId = new Map();
    labelDrops = new Set();
    const children = [];
    let group = null, cluster = -1;
    for (const item of items) {
      byId.set(item.id, item);
      for (const sub of item.items ?? []) byId.set(sub.id, sub);
      if (item.cluster !== cluster) {
        cluster = item.cluster;
        group = node('div', 'ui-optbar-group');
        groups.push({element: group, ids: []});
        children.push(group);
      }
      const root = BUILD[item.kind](item);
      root.dataset.option = item.id;
      root.classList.add('ui-optbar-item');
      // Dropping a label hides every word in the item: only items whose buttons all drew their glyph may drop it.
      if (item.droppable && ![root, ...root.querySelectorAll('button')].some(button => glyphless.has(button))) labelDrops.add(item.id);
      roots.set(item.id, root);
      appendLocalized(group, root);
      groups.at(-1).ids.push(item.id);
    }
    replaceLocalized(element, ...children, more);
    for (const root of roots.values()) resize?.observe(root);
    measured = null;
    // Nothing is folded until the new items are measured; the owner hears about it with the next plan (or, while
    // the bar is hidden, with this empty one), never keeping the previous tool's twins.
    plan = emptyPlan();
    roving?.refresh();
    if (focused) element.querySelector(`[data-option-id="${focused}"]`)?.focus({preventScroll: true});
    schedule();
  }

  // Measuring: every item shown, first with its label, then without, so the plan knows what each label saves.
  function measure() {
    for (const group of groups) reveal(group.element);
    for (const root of roots.values()) { reveal(root); root.removeAttribute('data-label-dropped'); }
    more.hidden = false;
    const full = new Map([...roots].map(([id, root]) => [id, root.getBoundingClientRect().width]));
    const moreWidth = more.getBoundingClientRect().width || gaps.moreWidth;
    const droppable = items.filter(item => labelDrops.has(item.id));
    for (const item of droppable) roots.get(item.id).setAttribute('data-label-dropped', '');
    const saved = new Map(droppable.map(item => [item.id, Math.max(0, full.get(item.id) - roots.get(item.id).getBoundingClientRect().width)]));
    for (const item of droppable) roots.get(item.id).removeAttribute('data-label-dropped');
    const barStyle = view.getComputedStyle?.(element);
    const groupStyle = groups[0] ? view.getComputedStyle?.(groups[0].element) : null;
    gaps = {groupGap: Number.parseFloat(barStyle?.columnGap) || 12, gap: Number.parseFloat(groupStyle?.columnGap) || 4, moreWidth};
    measured = items.map(item => ({id: item.id, cluster: item.cluster, fold: item.fold, labelFold: item.labelFold, twin: item.twin ?? null,
      home: item.home ?? null, width: full.get(item.id) ?? 0, labelWidth: saved.get(item.id) ?? 0}));
  }

  function layout() {
    frame = 0;
    // Hidden, it cannot measure: the owner still hears when a new tool left nothing folded to show.
    if (!element.isConnected || !element.getClientRects().length || placeholders.size) { report(); return; }
    if (!measured) measure();
    const style = view.getComputedStyle?.(element);
    const padding = (Number.parseFloat(style?.paddingLeft) || 0) + (Number.parseFloat(style?.paddingRight) || 0);
    apply(planToolOptions({items: measured, available: element.clientWidth - padding, ...gaps}));
  }

  // onFold compares with what the owner was last told, not with the previous plan (render() resets that).
  function report() {
    const next = foldKey(plan);
    if (next === reported) return false;
    reported = next;
    try { onFold?.(state()); } catch (error) { globalThis.reportError?.(error); }
    return true;
  }

  function apply(next, {force = false} = {}) {
    const folded = new Set(next.folded), dropped = new Set(next.dropped);
    for (const [id, root] of roots) {
      setAttribute(root, 'data-label-dropped', dropped.has(id));
      if (folded.has(id)) conceal(root); else reveal(root);
    }
    for (const group of groups) if (group.ids.every(id => folded.has(id))) conceal(group.element); else reveal(group.element);
    const moreHidden = next.more.length === 0;
    if (more.hidden !== moreHidden) more.hidden = moreHidden;
    const moved = foldKey(next) !== foldKey(plan);
    plan = next;
    if (moved || force) roving?.refresh();
    report();
  }

  function schedule() { if (!frame) frame = requestFrame(layout); }

  function state() {
    return {dropped: [...plan.dropped], folded: [...plan.folded], more: [...plan.more], twins: [...plan.twins], homes: plan.homes.map(home => ({...home})),
      forced: [...plan.forced]};
  }

  // More options: the folded controls themselves move into a popover while it is open, then back.
  function openMore() {
    popover ??= createPopover({anchor: more, label: say("toolOptions.more"), labelKey: "toolOptions.more", labelParams: {}, overlays, t, className: 'ui-optbar-popover', mount: popoverMount ?? 'auto',
      onClose: restoreMore});
    const rows = plan.more.map(id => {
      const item = byId.get(id), root = roots.get(id);
      const row = node('div', 'ui-optbar-more-row');
      const labelled = item.kind === 'field' || (item.showLabel && item.label) || (item.kind === 'toggles' && item.label);
      if (!labelled) appendLocalized(row, node('span', 'ui-optbar-more-label', nameOf(item)));
      const placeholder = doc.createComment(`tool option ${id}`);
      root.before(placeholder);
      placeholders.set(root, placeholder);
      reveal(root);
      root.removeAttribute('data-label-dropped');
      // Roving focus left these out of the tab order; in the popover every control is a tab stop.
      for (const control of root.querySelectorAll(CONTROLS)) control.tabIndex = 0;
      appendLocalized(row, root);
      return row;
    });
    replaceLocalized(popover.body, ...rows);
    popover.body.classList.add('ui-optbar-more-body');
    popover.show();
    listen(popover.element);
  }
  function restoreMore() {
    for (const [root, placeholder] of placeholders) placeholder.replaceWith(root);
    placeholders.clear();
    popover?.body.replaceChildren();
    more.setAttribute('aria-expanded', 'false');
    // Back in the bar, folded as before; the width may have changed while the popover was open.
    apply(plan, {force: true});
    schedule();
  }
  function closeMore() { if (popover?.isOpen) popover.hide('replace'); }

  function emit(change) {
    try { onChange?.(change); } catch (error) { globalThis.reportError?.(error); }
  }
  // A field is entered by typing or clicking in it; until then the arrow keys move along the bar. Enter and
  // Escape hand the arrows back (editKeys). Typing is read from keydown and beforeinput: PropertyControls takes a
  // property field's `input` events in its capture phase, and it leaves both of these alone.
  function fieldKey(event) {
    const input = event.currentTarget;
    if (DELETE_KEYS.has(event.key) || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) editing.add(input);
    if (EDIT_KEYS.has(event.key) && editing.has(input)) event.stopPropagation();
  }
  // Before PropertyControls, which consumes Enter (commit) and Escape (roll back) in its capture phase. Escape in
  // More options on a control that is not being edited closes the popover at once, rather than rolling back an
  // edit that never happened.
  function editKeys(event) {
    if ((event.key !== 'Enter' && event.key !== 'Escape') || event.isComposing) return;
    if (editing.has(event.target)) { editing.delete(event.target); return; }
    if (event.key === 'Escape' && popover?.isOpen && popover.element.contains(event.target) && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      popover.hide('escape');
    }
  }

  function clamp(item, value) {
    let next = value;
    if (finiteOrNull(item.min) !== null) next = Math.max(Number(item.min), next);
    if (finiteOrNull(item.max) !== null) next = Math.min(Number(item.max), next);
    return next;
  }

  function onClick(event) {
    const control = event.target.closest?.('[data-option-part]');
    if (!control || control.disabled) return;
    const item = byId.get(control.dataset.optionId);
    if (!item) return;
    switch (control.dataset.optionPart) {
      case 'toggle':
        if (item.command) return;
        {
          const value = control.getAttribute('aria-pressed') !== 'true';
          control.setAttribute('aria-pressed', String(value));
          emit({id: item.id, value, element: control, event});
        }
        return;
      case 'button': if (!item.command) emit({id: item.id, element: control, event}); return;
      case 'swap': if (!item.swap?.command) emit({id: item.id, part: 'swap', element: control, event}); return;
      case 'more': if (!item.more?.command) emit({id: item.id, part: 'more', element: control, event}); return;
      case 'colors': emit({id: item.id, part: 'colors', element: control, event}); return;
      case 'recent': emit({id: item.id, value: control.dataset.value, element: control, event}); return;
      case 'segment':
        for (const sibling of control.parentElement.children) sibling.setAttribute('aria-checked', String(sibling === control));
        emit({id: item.id, value: control.dataset.value, element: control, event});
        return;
      case 'step': {
        const input = control.parentElement.querySelector('input');
        const step = (Number(item.step) || 1) * Number(control.dataset.optionStep) * (event.shiftKey ? 10 : 1);
        const value = clamp(item, (Number(input.value) || 0) + step);
        input.value = formatPropertyValue(value, item.precision ?? 0);
        emit({id: item.id, value, element: input, event});
      }
    }
  }
  function onChangeEvent(event) {
    const control = event.target;
    const part = control?.dataset?.optionPart;
    const item = byId.get(control?.dataset?.optionId);
    if (!item) return;
    if (part === 'select') emit({id: item.id, value: control.value, element: control, event});
    else if (part === 'field' && !item.property && control.value !== '') emit({id: item.id, value: clamp(item, Number(control.value)), element: control, event});
    else if (part === 'stepper' && control.value !== '') {
      const value = clamp(item, Number(control.value));
      control.value = formatPropertyValue(value, item.precision ?? 0);
      emit({id: item.id, value, element: control, event});
    }
  }
  const listening = new WeakSet();
  function listen(target) {
    if (listening.has(target)) return;
    listening.add(target);
    target.addEventListener('click', onClick, {signal});
    target.addEventListener('change', onChangeEvent, {signal});
    target.addEventListener('beforeinput', event => { if (event.target.matches?.('input')) editing.add(event.target); }, {signal});
    target.addEventListener('pointerdown', event => { if (event.target.matches?.('input')) editing.add(event.target); }, {signal});
    target.addEventListener('focusout', event => { if (event.target.matches?.('input')) editing.delete(event.target); }, {signal});
  }
  listen(element);
  view.addEventListener('keydown', editKeys, {capture: true, signal});
  more.addEventListener('pointerdown', () => { pressOpen = Boolean(popover?.isOpen); }, {signal});
  more.addEventListener('click', () => {
    const wasOpen = pressOpen || popover?.isOpen;
    pressOpen = false;
    if (popover?.isOpen) popover.hide('toggle');
    else if (!wasOpen) openMore();
  }, {signal});

  const controls = () => [...element.querySelectorAll(CONTROLS)].filter(control => !control.closest(`[${OVERFLOW_ATTRIBUTE}]`) && !control.hidden);
  const roving = installRovingFocus(element, {items: controls, orientation: 'horizontal', signal});
  // The bar's width and every item's: an item that no longer has its measured size (the fonts loaded, the
  // language changed a label) is measured again.
  const drifted = entry => {
    const root = entry.target, entryId = root.dataset?.option;
    if (!measured || !entryId || root.hasAttribute(OVERFLOW_ATTRIBUTE) || placeholders.has(root)) return false;
    const known = measured.find(item => item.id === entryId);
    const width = entry.borderBoxSize?.[0]?.inlineSize ?? root.getBoundingClientRect().width;
    return Boolean(known) && Math.abs(width - (known.width - (root.hasAttribute('data-label-dropped') ? known.labelWidth : 0))) > 0.5;
  };
  const resize = Observer ? new Observer(entries => {
    if (entries.some(drifted)) measured = null;
    schedule();
  }) : null;
  resize?.observe(element);
  signal.addEventListener('abort', () => {
    resize?.disconnect();
    closeMore();
    if (frame) cancelFrame(frame);
    frame = 0;
    popover?.element.remove();
  }, {once: true});

  /**
   * New descriptors: when only state changed (value, pressed, disabled, stroke, fill, colors) it is written in
   * place, keeping focus and a value being typed; any other change (a fold order, a tip, a limit) rebuilds the
   * bar and folds it again (force: always rebuild).
   */
  function update(next = [], {label: name = null, labelKey: nameKey = labelKey, labelParams: nameParams = labelParams, tool: toolName = null, force = false} = {}) {
    if (name !== null) setAttribute(element, 'aria-label', name || null);
    if (nameKey) localizedAttribute(element, 'aria-label', nameKey, nameParams);
    // data-options-for, never data-tool: [data-tool] is the rail's tools (app.mjs, the hotkey hints and the tests find them by it).
    if (toolName !== null) setAttribute(element, 'data-options-for', toolName || null);
    items = normalizeToolOptions(next);
    const nextKey = structureKey(items);
    if (force || nextKey !== key) { key = nextKey; render(); return; }
    for (const item of items) {
      byId.set(item.id, item);
      for (const sub of item.items ?? []) byId.set(sub.id, sub);
      sync(item);
    }
  }

  update(descriptors, {label, tool});
  return {
    element, update,
    /** Measure again: after the fonts load or the language changes the labels. */
    invalidate() { measured = null; schedule(); },
    get state() { return state(); },
    destroy() { controller.abort(); element.remove(); },
  };
}
