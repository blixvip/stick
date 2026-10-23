import {messageError} from '../localized-error.mjs';
/**
 * The panel registry: every dockable panel described once, with its size
 * limits, allowed docks and workspaces, plus the runtime visibility that
 * feature modules observe through onVisibility (to pause work while hidden).
 *
 * Pure state and events. Nothing here touches the DOM: a descriptor's `root`
 * is a function the dock host calls, and the stored layout (layout-schema.mjs)
 * and the solver (layout-solver.mjs) read only the plain constraint data from
 * `constraints()` or PANEL_CATALOG. Which panels exist and where they may go
 * is data, so a design pass can add, remove or re-home panels here without
 * touching the schema or the solver.
 *
 * Descriptor fields (sizes in CSS px along the dock's axis):
 *   id          lower-case id, also the stored panel id
 *   title, titleKey, icon
 *   docks       allowed sides in preference order; the first is the panel's home
 *   floatable   may float over the stage
 *   min, pref, max, maxFraction (of the window height, for the bottom dock)
 *   sizeKey     shared size the panel owns instead of its side's (Structure)
 *   modes       workspaces the panel exists in (null: every workspace; 'build' means 'rig')
 *   canHide     true, false or the workspaces where it may be Hidden
 *   hiddenFallback  the dock used where Hidden is not allowed (the timeline: strip)
 *   defaultDock where the panel goes in a workspace whose stored arrangement and
 *               default preset have no record of it: 'strip', 'hidden' or one of
 *               its docks (null: its home). A panel added later can then arrive
 *               folded instead of changing every user's layout.
 *   stageMin    the stage width below which the panel's side folds to a strip
 *   root        () => element, supplied at runtime
 *   onVisibility (visible, id) => void, supplied at runtime
 */

export const WORKSPACES = Object.freeze(['animate', 'draw', 'rig']);
export const DOCK_SIDES = Object.freeze(['left', 'right', 'bottom']);

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const DATA_FIELDS = ['id', 'title', 'titleKey', 'icon', 'docks', 'floatable', 'min', 'pref', 'max', 'maxFraction',
  'sizeKey', 'modes', 'canHide', 'hiddenFallback', 'defaultDock', 'stageMin'];
/** 'build' is Build's user-facing name; the workspace id is 'rig'. */
const workspaceId = mode => (mode === 'build' ? 'rig' : mode);

function freezeDescriptor(descriptor) {
  for (const key of ['docks', 'modes', 'canHide']) if (Array.isArray(descriptor[key])) Object.freeze(descriptor[key]);
  return Object.freeze(descriptor);
}

/**
 * Validates and copies the constraint data of a descriptor. Throws a TypeError
 * for an unusable descriptor: a registry that silently drops a panel would
 * leave its root unreachable.
 */
export function normalizePanelDescriptor(input) {
  if (!input || typeof input !== 'object') throw messageError(new TypeError(''), "errors.panelRegistry.aPanelDescriptorMustBeAnObject", {});
  const {id} = input;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw messageError(new TypeError(''), "errors.panelRegistry.invalidPanelId", {value: String(id)});
  const docks = [...new Set(input.docks ?? input.regions ?? [])];
  if (!docks.length || docks.some(side => !DOCK_SIDES.includes(side))) throw messageError(new TypeError(''), "errors.panelRegistry.panelNeedsDocksFrom", {id: id, value: DOCK_SIDES.join(', ')});
  const modes = input.modes == null ? null : [...new Set([...input.modes].map(workspaceId))];
  if (modes && (!modes.length || modes.some(mode => !WORKSPACES.includes(mode)))) throw messageError(new TypeError(''), "errors.panelRegistry.panelHasUnknownWorkspaces", {id: id});
  const number = (value, fallback) => Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
  const min = number(input.min, 0);
  const max = input.max == null ? null : Math.max(min, number(input.max, min));
  const pref = input.pref == null ? null : Math.min(max ?? Infinity, Math.max(min, number(input.pref, min)));
  const canHide = Array.isArray(input.canHide) ? [...new Set(input.canHide.map(workspaceId))].filter(mode => WORKSPACES.includes(mode)) : input.canHide !== false;
  const descriptor = {
    id,
    title: typeof input.title === 'string' ? input.title : id,
    titleKey: typeof input.titleKey === 'string' ? input.titleKey : null,
    icon: typeof input.icon === 'string' ? input.icon : null,
    docks,
    floatable: input.floatable === true,
    min, pref, max,
    maxFraction: Number.isFinite(input.maxFraction) && input.maxFraction > 0 && input.maxFraction <= 1 ? input.maxFraction : null,
    sizeKey: typeof input.sizeKey === 'string' && ID_PATTERN.test(input.sizeKey) ? input.sizeKey : null,
    modes,
    canHide,
    hiddenFallback: ['strip', ...DOCK_SIDES].includes(input.hiddenFallback) ? input.hiddenFallback : null,
    defaultDock: input.defaultDock === 'strip' || input.defaultDock === 'hidden' || docks.includes(input.defaultDock) ? input.defaultDock : null,
    stageMin: Number.isFinite(input.stageMin) && input.stageMin > 0 ? Math.round(input.stageMin) : null,
  };
  return descriptor;
}

/** Today's panels (architecture §3.11.1); the default catalogue of the schema and the solver. */
export const PANEL_CATALOG = Object.freeze([
  {id: 'properties', title: 'Properties', titleKey: 'shell.panel.properties', icon: 'inspector',
    docks: ['right', 'left'], floatable: true, min: 256, pref: 320, max: 420},
  {id: 'vfx', title: 'VFX', titleKey: 'shell.panel.vfx', icon: 'fx',
    docks: ['right', 'left'], floatable: true, min: 256, pref: 320, max: 420},
  {id: 'library', title: 'Library', titleKey: 'shell.panel.library', icon: 'library',
    docks: ['right', 'left'], floatable: true, min: 256, pref: 320, max: 460},
  // Structure docks at 232 and narrows to 200 before its side folds to a strip
  // (wherever docking it would leave #viewport under its 360px floor).
  {id: 'structure', title: 'Structure', titleKey: 'shell.panel.structure', icon: 'structure',
    docks: ['left', 'right'], floatable: true, min: 200, pref: 232, max: 360, sizeKey: 'structure', modes: ['rig']},
  // min 168: the header, the short tier's 24px ruler, Camera and Scene (24px
  // each) and two 28px content rows; the solver raises it to the tall tier's
  // rows (184).
  {id: 'timeline', title: 'Timeline', titleKey: 'shell.panel.timeline', icon: 'timeline',
    docks: ['bottom'], floatable: false, min: 168, maxFraction: 0.6, canHide: ['rig'], hiddenFallback: 'strip'},
].map(descriptor => freezeDescriptor(normalizePanelDescriptor(descriptor))));

/** True when the panel exists in the workspace ('build' or 'rig' for Build). */
export const panelInMode = (descriptor, mode) => !descriptor.modes || descriptor.modes.includes(workspaceId(mode));

/** True when the panel may be Hidden in the workspace ('build' or 'rig' for Build). */
export const panelCanHide = (descriptor, mode) => Array.isArray(descriptor.canHide) ? descriptor.canHide.includes(workspaceId(mode)) : descriptor.canHide !== false;

/**
 * Creates the runtime registry. `catalog` supplies constraint data that a
 * later define() with the same id completes with its root and callbacks
 * (late roots such as the library's are supported; each define emits
 * 'define' so the dock host re-applies the solution). Callbacks hear
 * changes, so an onVisibility that arrives while its panel is already
 * visible is called once at once with `(true, id)`: a late root never stays
 * paused.
 */
export function createPanelRegistry({catalog = PANEL_CATALOG} = {}) {
  const panels = new Map(catalog.map(descriptor => [descriptor.id, {data: freezeDescriptor(normalizePanelDescriptor(descriptor)), root: null, onVisibility: null}]));
  const visible = new Map();
  const watchers = new Map();
  const listeners = {define: new Set(), visibility: new Set(), activate: new Set()};
  let snapshot = null;

  const report = error => { globalThis.reportError?.(error); };
  const call = (callback, value, id) => {
    try { callback(value, id); } catch (error) { report(error); }
  };
  const emit = (type, detail) => {
    for (const listener of [...listeners[type]]) {
      try { listener(detail); } catch (error) { report(error); }
    }
  };
  const subscribe = (set, callback, signal) => {
    if (typeof callback !== 'function' || signal?.aborted) return () => {};
    set.add(callback);
    const remove = () => { set.delete(callback); signal?.removeEventListener('abort', remove); };
    signal?.addEventListener('abort', remove, {once: true});
    return remove;
  };

  function define(input) {
    if (!input || typeof input !== 'object') throw messageError(new TypeError(''), "errors.panelRegistry.aPanelDescriptorMustBeAnObject", {});
    const known = panels.get(input.id);
    const merged = {...(known?.data ?? {}), ...Object.fromEntries(DATA_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]))};
    if (input.regions !== undefined && input.docks === undefined) merged.docks = input.regions;
    const data = freezeDescriptor(normalizePanelDescriptor(merged));
    const entry = {
      data,
      root: typeof input.root === 'function' ? input.root : known?.root ?? null,
      onVisibility: typeof input.onVisibility === 'function' ? input.onVisibility : known?.onVisibility ?? null,
    };
    panels.set(data.id, entry);
    snapshot = null;
    if (entry.onVisibility && entry.onVisibility !== known?.onVisibility && visible.get(data.id)) call(entry.onVisibility, true, data.id);
    emit('define', {id: data.id, descriptor: data});
    return data;
  }

  function setVisible(id, value) {
    const entry = panels.get(id);
    if (!entry) return false;
    const next = Boolean(value);
    if ((visible.get(id) ?? false) === next) return false;
    visible.set(id, next);
    for (const callback of [entry.onVisibility, ...(watchers.get(id) ?? [])]) if (callback) call(callback, next, id);
    return true;
  }

  return {
    define,
    has: id => panels.has(id),
    get: id => panels.get(id)?.data ?? null,
    /** The panels of a workspace ('build' or 'rig' for Build; every panel without one), in definition order. */
    list: ({mode} = {}) => [...panels.values()].map(entry => entry.data).filter(data => !mode || panelInMode(data, mode)),
    /** Plain constraint data for layout-schema and layout-solver; stable until the next define(). */
    constraints() {
      snapshot ??= Object.freeze([...panels.values()].map(entry => entry.data));
      return snapshot;
    },
    root: id => panels.get(id)?.root?.() ?? null,
    isVisible: id => visible.get(id) ?? false,
    /**
     * Sets visibility from `{id: boolean}` or (id, boolean) and calls the
     * onVisibility callbacks of the panels that changed. Returns their ids.
     */
    setVisibility(changes, value) {
      const entries = typeof changes === 'string' ? [[changes, value]] : Object.entries(changes ?? {});
      const changed = entries.filter(([id, next]) => setVisible(id, next)).map(([id]) => id);
      if (changed.length) emit('visibility', {changed, visible: Object.fromEntries(changed.map(id => [id, visible.get(id)]))});
      return changed;
    },
    /**
     * Applies a layout-solver solution's `panels[id].visible`. `open` lists the
     * panels the dock host shows outside the solution (an open strip or tier
     * sheet), which are visible too, so a re-solve never pauses them.
     */
    applySolution(solution, {open = []} = {}) {
      const shown = new Set(open);
      const changes = {};
      for (const id of panels.keys()) changes[id] = Boolean(solution?.panels?.[id]?.visible) || shown.has(id);
      return this.setVisibility(changes);
    },
    /**
     * Calls `callback(visible, id)` on every change of the panel's visibility;
     * with `immediate` also once now with the current state.
     */
    onVisibility: (id, callback, {signal, immediate = false} = {}) => {
      if (!watchers.has(id)) watchers.set(id, new Set());
      const remove = subscribe(watchers.get(id), callback, signal);
      if (immediate && typeof callback === 'function' && !signal?.aborted) call(callback, visible.get(id) ?? false, id);
      return remove;
    },
    /** Asks the dock host to show and focus a panel; returns false for an unknown id. */
    activate(id) {
      if (!panels.has(id)) return false;
      emit('activate', {id});
      return true;
    },
    on: (type, callback, {signal} = {}) => {
      if (!listeners[type]) throw messageError(new TypeError(''), "errors.panelRegistry.unknownPanelRegistryEvent", {type: type});
      return subscribe(listeners[type], callback, signal);
    },
  };
}
