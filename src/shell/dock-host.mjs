import {messageError} from '../localized-error.mjs';
import {localizedText, appendLocalized, localizedAttribute, localizedMarkup} from '../localization-bindings.mjs';
import {t as interfaceText} from '../localization.mjs';

/**
 * The dock host: lays the editor's static shell (index.html) out from the
 * layout solver, and is the single owner of which panel shows where.
 *
 * - The stored layout comes from layout-store.mjs (the workspace preferences
 *   IPC on desktop, localStorage in the browser), loaded before the first
 *   commit. The solver fits it into the `#app` box; the host applies the
 *   solution in one synchronous commit: `:root[data-tier|data-height|
 *   data-left]`, the band's fold steps (`.titlebar[data-band]`, from the
 *   band's widths that topbar.mjs measures and the solver reads as
 *   `bandMin`), the workspace grid (CSS custom properties on `.workspace`),
 *   the islands, tabs, strips and sheets of each side, the floating
 *   islands, the timeline's state and the splitters. Nothing animates its
 *   size; resizes and splitter drags commit once per frame.
 * - Panel roots (`#properties-panel`, `#vfx-panel`, `#user-library`,
 *   `#builder-outliner`, `.timeline-panel`) are moved with append() and never
 *   re-created; they move only when their place changes, so scroll positions
 *   and focus survive a commit. Tabs (`#properties-tab`, `#vfx-tab`,
 *   `#library-tab`) move with their panel. Feature modules never hide each
 *   other: they hear `onVisibility` from the panel registry.
 * - Sheets are islands shown as `popover="manual"` in place (the band's
 *   Properties button at compact width, a strip's icon, the timeline body at
 *   the low height tier), so every root keeps its DOM ancestry while it
 *   renders in the top layer. They close on Escape and on a press outside
 *   them and outside any other open overlay.
 * - Fitting never writes the stored layout; only a person's action does
 *   (a tab, a splitter, a toggle, the workspace API).
 *
 * Transitional (until the stage header and the hidden log of M3b): the
 * status bar under the workspace is passed to the solver as `footer`, and
 * the stage island's header row is measured (the canvas toolbar, plus
 * Build's bar) instead of the stage header's 40px. Until M5's painter draws
 * 24px Camera and Scene rows and 28px short-tier rows, `timelineRows` (the
 * painter's ruler and row heights) sizes the default timeline, so it shows
 * the content rows it promises.
 */
import {icon} from '../icons.mjs';
import {PANEL_CATALOG, createPanelRegistry} from './panel-registry.mjs';
import {createLayoutStore, desktopLayoutBackend, storageLayoutBackend} from './layout-store.mjs';
import {
  activatePanel, applyPreset, canPlacePanel, canSavePreset, deletePreset, movePanel, normalizeMode, renamePreset, resetLayout,
  resetMode, savePreset, setSharedSize, toggleFocus, updatePreset,
} from './layout-schema.mjs';
import {SHELL_METRICS, solveLayout} from './layout-solver.mjs';
import {MENUBAR_FOLD, watchBand} from './topbar.mjs';
import {COLLECTIONS} from './dock-keyboard.mjs';

const SIDES = Object.freeze(['left', 'right']);
const DEFAULT_ROOTS = Object.freeze({properties: '#properties-panel', vfx: '#vfx-panel', library: '#user-library',
  structure: '#builder-outliner', timeline: '#animation-timeline'});
const SIDE_NAMES = Object.freeze({left: interfaceText("dockHost.leftPanels"), right: interfaceText("dockHost.inspector")});
const STEP = 12, BIG_STEP = 40;
/** Tall timeline stores this share of the window (the solver's 60% maximum). */
const TALL_TIMELINE = 0.6;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const px = value => `${Math.round(value)}px`;

/** The browser's localStorage, or null where the page may not use it. */
function browserStorage(win) {
  try { return win.localStorage ?? null; } catch { return null; }
}

/**
 * Loads the stored layout, then lays the shell out. Resolves to the dock
 * host (see createDockHost), whose `workspace` is `window.styk.workspace`.
 */
export async function installShell({document: doc = globalThis.document, window: win = globalThis.window, desktop,
  legacy, platform, onError, onBeforeChange, timelineRows, ready = null, catalog = PANEL_CATALOG, touch = null} = {}) {
  const registry = createPanelRegistry({catalog});
  const backend = desktop?.getWorkspacePreferences && desktop?.setWorkspacePreferences
    ? desktopLayoutBackend(desktop) : storageLayoutBackend(browserStorage(win));
  const workspace = doc.querySelector('.workspace');
  const store = createLayoutStore({...backend, catalog: () => registry.constraints(), legacy, onError: error => {
    workspace?.dispatchEvent(new CustomEvent('styk-workspace-persistence-error', {detail: {message: error?.message || String(error)}}));
    onError?.(error);
  }});
  await store.load();
  return createDockHost({document: doc, window: win, registry, store, platform, onBeforeChange, timelineRows, ready, touch});
}

/**
 * SHELL_METRICS with the timeline painter's own heights ({ruler, pinnedRow,
 * row} in px) in place of the solver's, so a default height holds the rows
 * the painter really draws.
 */
export function paintedMetrics(timelineRows, metrics = SHELL_METRICS) {
  if (!timelineRows) return metrics;
  const {ruler, pinnedRow, row} = timelineRows;
  const height = Object.fromEntries(Object.entries(metrics.height).map(([tier, value]) =>
    [tier, {...value, timeline: {...value.timeline, ruler: ruler ?? value.timeline.ruler, row: row ?? value.timeline.row}}]));
  return {...metrics, height, timeline: {...metrics.timeline, pinnedRow: pinnedRow ?? metrics.timeline.pinnedRow}};
}

/**
 * Applies solutions to the shell's DOM. `registry` is the panel registry
 * (panel-registry.mjs), `store` the layout store (loaded), `timelineRows`
 * the timeline painter's heights (see paintedMetrics), `ready` a promise of
 * the editor being ready (the band's first measurement waits for it where it
 * can; topbar.mjs), `touch` the touch mode (src/touch/touch-mode.mjs: its
 * `state` and `on`), whose layouts the touch stylesheet arranges: the host
 * then solves for the workspace's own box, folds the menubar into the mark
 * and leaves the sheets' places to the stylesheet (docs/TOUCH.md).
 */
export function createDockHost({document: doc = globalThis.document, window: win = globalThis.window, registry, store,
  platform, onBeforeChange, timelineRows, ready = null, touch = null} = {}) {
  const metrics = paintedMetrics(timelineRows);
  const root = doc.documentElement;
  const app = doc.getElementById('app');
  const workspace = doc.querySelector('.workspace');
  const stage = workspace.querySelector('.shell-stage');
  const viewport = doc.getElementById('viewport');
  const band = doc.querySelector('.titlebar');
  const footer = doc.querySelector('.statusbar');
  const hosts = Object.fromEntries(SIDES.map(side => [side, workspace.querySelector(`.shell-${side}`)]));
  const bottom = doc.getElementById('animation-timeline');
  const body = doc.getElementById('timeline');
  const sheetButton = doc.querySelector('.shell-sheet-button');
  const bodyButton = doc.querySelector('.shell-timeline-sheet');
  const expandButton = doc.getElementById('expand-timeline');
  const abort = new AbortController(), signal = abort.signal;
  const listeners = {solve: new Set()};
  const islands = Object.fromEntries(SIDES.map(side => [side, [...hosts[side].querySelectorAll(':scope > .shell-island:not(.shell-sheet)')]]));
  const sheetIslands = {}, strips = {}, floats = new Map();
  const sheets = Object.fromEntries(SIDES.map(side => [side, {open: false, active: null, invoker: null}]));
  const splitters = {};
  // Every tab element, attached or not: a tab moves with its panel and is never re-created.
  const tabElements = new Map([...workspace.querySelectorAll('[role="tab"][data-panel]')].map(tab => [tab.dataset.panel, tab]));
  const written = new Map();
  /** Writes a custom property only when it changes, so a commit that changes nothing restyles nothing. */
  const setVar = (element, name, value) => {
    const key = `${element.className}|${name}`;
    if (written.get(key) === value) return;
    written.set(key, value);
    element.style.setProperty(name, value);
  };
  let floatHost = null, solution = null, override = null, frame = 0, destroyed = false, bodyOpen = false, bodyInvoker = null;
  // The floating tool bar's columns: two where one column of tools would not fit #viewport's height.
  let railColumns = 1;
  let currentMode = normalizeMode(workspace.dataset.mode);

  const descriptor = id => registry.get(id);
  const title = id => descriptor(id)?.titleKey ? interfaceText(descriptor(id).titleKey) : descriptor(id)?.title ?? id;
  const rootOf = id => registry.root(id) ?? doc.querySelector(DEFAULT_ROOTS[id] ?? `[data-panel="${id}"]`);
  const report = error => { globalThis.reportError?.(error); };
  const mode = () => normalizeMode(workspace.dataset.mode);

  // ---------------------------------------------------------------------
  // Solving

  /** The touch mode's state while the touch interface is on, else null. */
  const touchState = () => (touch?.state?.active ? touch.state : null);

  function env() {
    // #viewport's top in the stage island: the stage header, and in Build the builder's row under it.
    const head = viewport && stage && !stage.hidden ? Math.round(viewport.getBoundingClientRect().top - stage.getBoundingClientRect().top) || undefined : undefined;
    const touching = touchState();
    // The touch layouts place the band, the wing and the tab bar around the workspace themselves (touch.css), so the
    // solver fits the workspace's own box.
    if (touching) {
      // The touch band always has its menubar folded into the mark: its fold steps are the folded pass's.
      const widths = bandWatch?.forWidth(0);
      const bandMin = widths?.minimal ? {...widths.minimal, minimal: widths.minimal} : 0;
      return {width: workspace.offsetWidth, height: workspace.offsetHeight, mode: mode(), platform, footer: 0,
        bandMin, metrics, measured: {band: 0, stageHead: head}, railColumns, touch: touching};
    }
    // The window, the band above the workspace and (until M3b) the status bar below it.
    // The band's and the stage header's measured heights (the height tier's values unless the UI scale changed them).
    const chrome = band?.offsetHeight || undefined;
    const below = footer && !footer.hidden ? footer.offsetHeight : 0;
    return {width: app.clientWidth, height: app.clientHeight, mode: mode(), platform, footer: below,
      bandMin: bandWatch?.forWidth(app.clientWidth) ?? 0, metrics, measured: {band: chrome, stageHead: head}, railColumns};
  }

  /** Solves the stored layout (or a splitter's transient size) and applies it now. */
  function commit() {
    if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
    if (destroyed) return solution;
    try {
      const layout = override ? override(store.layout) : store.layout;
      const focused = doc.activeElement;
      solution = solveLayout(layout, env());
      apply(solution);
      keepFocus(focused);
      for (const listener of [...listeners.solve]) {
        try { listener(solution); } catch (error) { report(error); }
      }
    } catch (error) { report(error); }
    return solution;
  }
  /**
   * A commit that moves or hides the focused tab, panel or strip button (a
   * tab menu's Dock left, Hide or Fold, Focus mode) must not drop focus to
   * the page (WCAG 2.4.3): focus goes to the panel's tab where it is docked
   * or floating, its strip button where it is folded, the band's Properties
   * button where it is a sheet, else the stage. No layout is read.
   */
  function keepFocus(focused) {
    if (!focused || focused === doc.body || focused === doc.documentElement) return;
    const lost = !focused.isConnected || doc.activeElement === doc.body || !doc.activeElement
      || Boolean(focused.closest('[hidden], .shell-sheet[popover]:not(:popover-open), .shell-timeline-body[popover]:not(:popover-open)'));
    if (!lost) return;
    const id = focused.closest?.('[data-panel]')?.dataset.panel ?? focused.dataset?.stripFor ?? null;
    const shown = element => element?.isConnected && !element.hidden && !element.closest('[hidden]');
    const where = id ? presentation(id) : null;
    let target = null;
    if (where === 'docked' || where === 'float') {
      const tab = tabOf(id);
      target = shown(tab) && !tab.parentElement?.hidden ? tab : [...(rootOf(id)?.querySelectorAll(COLLECTIONS) ?? [])].find(shown) ?? null;
    } else if (where === 'strip') target = [...SIDES.map(side => strips[side]?.querySelector(`:scope > [data-panel="${id}"]`))].find(shown) ?? null;
    else if (where === 'sheet' && sideOf(id) === 'right') target = shown(sheetButton) ? sheetButton : null;
    (target ?? viewport)?.focus({preventScroll: true});
  }
  /** Coalesces continuous changes (a resize, a drag) into one commit per frame. */
  function schedule() {
    if (!frame && !destroyed) frame = win.requestAnimationFrame(() => { frame = 0; commit(); });
  }

  // ---------------------------------------------------------------------
  // Applying

  function apply(s) {
    root.dataset.tier = s.tier;
    root.dataset.height = s.height;
    root.dataset.chrome = s.chrome;
    applyBand(s);
    root.dataset.left = s.regions.left.state;
    workspace.dataset.rail = s.rail.side;
    // Along the stage's bottom on an upright phone (the touch interface), down its side everywhere else.
    if (s.rail.orientation === 'horizontal') workspace.dataset.railOrientation = 'horizontal';
    else delete workspace.dataset.railOrientation;
    const tools = workspace.querySelector('.shell-rail > .tool-dock');
    if (tools && tools.getAttribute('aria-orientation') !== s.rail.orientation) tools.setAttribute('aria-orientation', s.rail.orientation);
    workspace.dataset.bottomSpan = s.regions.bottom.span;
    if (s.mode === 'rig') workspace.dataset.builderTimeline = s.regions.bottom.state === 'hidden' ? 'hidden' : 'visible';
    else delete workspace.dataset.builderTimeline;
    applyGrid(s);
    for (const side of SIDES) applySide(s, side);
    applyFloating(s);
    applyBottom(s);
    applyControls(s);
    applyVisibility(s);
  }

  /** The band's fold steps, and at the minimal tier the menubar folded into the mark. */
  function applyBand(s) {
    if (!band) return;
    // The touch interface always reaches the menus through the mark (docs/TOUCH.md); a tablet's band folds its words too.
    const steps = (s.touch ? [MENUBAR_FOLD, ...s.band] : s.tier === 'minimal' ? [MENUBAR_FOLD, ...s.band] : s.band).join(' ');
    if ((band.getAttribute('data-band') ?? '') === steps) return;
    if (steps) band.setAttribute('data-band', steps); else band.removeAttribute('data-band');
  }

  function applyGrid(s) {
    const across = SHELL_METRICS.width[s.tier], down = SHELL_METRICS.height[s.height];
    const extent = side => {
      const region = s.regions[side];
      if (region.state === 'docked') return region.size + (region.strip ? across.columnGap + region.strip : 0);
      return region.state === 'strip' ? region.strip : 0;
    };
    const names = [], columns = [];
    const add = (name, size) => { names.push(name); columns.push(size); };
    // The rail floats inside the stage (layout/rail.css places it); it takes no column.
    if (extent('left')) add('left', px(extent('left')));
    add('stage', 'minmax(0, 1fr)');
    if (extent('right')) add('right', px(extent('right')));
    const b = s.regions.bottom, shown = b.state !== 'hidden';
    const lower = names.map(name => (b.span === 'stage' && name !== 'stage' ? name : 'bottom'));
    const set = (name, value) => setVar(workspace, name, value);
    set('--shell-columns', columns.join(' '));
    set('--shell-rows', shown ? `minmax(0, 1fr) ${px(b.size)}` : 'minmax(0, 1fr)');
    set('--shell-areas', shown ? `"${names.join(' ')}" "${lower.join(' ')}"` : `"${names.join(' ')}"`);
    set('--shell-gap', px(across.columnGap));
    set('--shell-row-gap', px(down.rowGap));
    set('--shell-pad-start', px(across.padEnd));
    set('--shell-pad-end', px(across.padEnd));
    set('--shell-pad-bottom', px(down.padBottom));
    set('--shell-pad-top', px(s.padTop ?? down.padBottom));
    set('--shell-rail', px(s.rail.width));
    // The floating tool bar's top in the stage island (the solver's rect: #viewport's top and the bar's margin).
    set('--shell-rail-top', px(s.rail.rect.y - s.stage.y));
    set('--shell-left', px(s.regions.left.size));
    set('--shell-right', px(s.regions.right.size));
    set('--shell-bottom', px(shown ? b.size : 0));
  }

  /** The panels of a side that wait off the grid: folded to a strip or a sheet, or hidden. */
  const offGrid = (s, side) => Object.entries(s.panels)
    .filter(([id, panel]) => panel.side === side && ['strip', 'sheet', 'hidden'].includes(panel.presentation) && id !== 'timeline')
    .map(([id]) => id);
  const byOrder = (s, ids) => {
    const records = store.layout.modes[s.mode]?.panels ?? [];
    const order = id => records.find(record => record.id === id)?.order ?? 999;
    return [...ids].sort((a, b) => order(a) - order(b));
  };

  function applySide(s, side) {
    const region = s.regions[side], host = hosts[side];
    host.dataset.state = region.state;
    const waiting = byOrder(s, offGrid(s, side));
    host.hidden = region.state === 'hidden' && !waiting.length;
    host.setAttribute('aria-label', region.groups.length ? region.groups.flatMap(group => group.tabs).map(title).join(', ') : SIDE_NAMES[side]);
    // Docked islands, stacked by their share of the side's height.
    region.groups.forEach((group, index) => {
      const island = islandAt(side, index);
      island.hidden = false;
      island.style.flex = region.groups.length > 1 ? `0 0 ${px(group.rect.height)}` : '';
      fill(island, group.tabs, group.active);
    });
    islands[side].slice(region.groups.length).forEach(island => { island.hidden = true; island.style.flex = ''; });
    // The strip's icons, then the sheet island that holds everything off the grid.
    const stripped = region.state === 'sheet' ? [] : region.panels.strip;
    const strip = stripFor(side);
    strip.hidden = !stripped.length;
    host.toggleAttribute('data-strip', Boolean(stripped.length));
    syncStrip(strip, stripped);
    const sheet = sheetFor(side), state = sheets[side];
    const openable = waiting.filter(id => s.panels[id].presentation !== 'hidden');
    if (!openable.includes(state.active)) state.active = openable[0] ?? null;
    if (state.open && !state.active) closeSheet(side, {restoreFocus: false, recommit: false});
    fill(sheet, waiting, state.active, {hide: waiting.filter(id => s.panels[id].presentation === 'hidden')});
    sheet.dataset.side = side;
    if (state.open) placeSheet(side);
  }

  function islandAt(side, index) {
    let island = islands[side][index];
    if (!island) {
      island = makeIsland(`${side}-${index}`);
      const after = islands[side].at(-1) ?? null;
      if (after) after.after(island); else hosts[side].prepend(island);
      islands[side][index] = island;
    }
    return island;
  }

  function makeIsland(key) {
    const island = doc.createElement('div');
    island.className = 'ui-island shell-island';
    island.dataset.island = key;
    const tabs = doc.createElement('div');
    tabs.className = 'ui-tabs shell-tabs';
    tabs.dataset.ui = '';
    tabs.setAttribute('role', 'tablist');
    appendLocalized(island, tabs);
    return island;
  }

  function sheetFor(side) {
    if (!sheetIslands[side]) {
      const sheet = makeIsland(`${side}-sheet`);
      sheet.classList.add('ui-sheet', 'shell-sheet');
      sheet.setAttribute('popover', 'manual');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', SIDE_NAMES[side]);
      sheet.id = `${side}-sheet`;
      appendLocalized(hosts[side], sheet);
      sheetIslands[side] = sheet;
      sheet.addEventListener('focusout', event => {
        if (sheets[side].open && leaves(event, [sheet, sheets[side].invoker])) closeSheet(side, {restoreFocus: false});
      }, {signal});
    }
    return sheetIslands[side];
  }

  function stripFor(side) {
    if (!strips[side]) {
      const strip = doc.createElement('div');
      strip.className = 'ui-strip shell-strip';
      strip.dataset.ui = '';
      strip.setAttribute('role', 'toolbar');
      localizedAttribute(strip, 'aria-label', "dockHost.folded", {value: SIDE_NAMES[side]});
      strip.setAttribute('aria-orientation', 'vertical');
      if (side === 'left') hosts[side].prepend(strip); else appendLocalized(hosts[side], strip);
      strips[side] = strip;
    }
    return strips[side];
  }

  function syncStrip(strip, ids) {
    const buttons = ids.flatMap(id => {
      let button = strip.querySelector(`:scope > [data-panel="${id}"]`);
      if (!button) {
        button = doc.createElement('button');
        button.type = 'button';
        button.className = 'ui-icon-button shell-strip-button';
        button.dataset.panel = id;
        button.setAttribute('aria-haspopup', 'dialog');
        localizedMarkup(button, icon(descriptor(id)?.icon ?? 'panel-right'));
      }
      if (descriptor(id)?.titleKey) localizedAttribute(button, 'aria-label', descriptor(id).titleKey); else button.setAttribute('aria-label', title(id));
      button.dataset.tip = title(id);
      return [button, ...stripActions(id)];
    });
    order(strip, buttons);
    for (const button of [...strip.children]) if (!buttons.includes(button)) button.remove();
  }

  // A folded panel's own one-click actions ([data-strip-action="order"] in its root: Structure's Fit figure,
  // Timeline and Snapping) stay one click away as strip buttons under its icon. Each one clicks its source,
  // so the source's handlers stay the one path, and mirrors the source's name, glyph and state.
  const stripMirrors = new Map();
  const MIRRORED = ['aria-pressed', 'aria-expanded', 'aria-controls', 'disabled'];
  function stripActions(id) {
    const sources = [...(rootOf(id)?.querySelectorAll('[data-strip-action]') ?? [])]
      .sort((a, b) => Number(a.dataset.stripAction) - Number(b.dataset.stripAction));
    return sources.map(source => {
      let mirror = stripMirrors.get(source);
      if (!mirror) {
        mirror = doc.createElement('button');
        mirror.type = 'button';
        mirror.className = 'ui-icon-button shell-strip-action';
        mirror.dataset.stripFor = id;
        mirror.addEventListener('click', () => source.click(), {signal});
        const copy = () => {
          const name = source.getAttribute('aria-label') || source.textContent.trim();
          mirror.setAttribute('aria-label', name);
          mirror.dataset.tooltip = name;
          for (const attribute of MIRRORED) {
            if (source.hasAttribute(attribute)) mirror.setAttribute(attribute, source.getAttribute(attribute));
            else mirror.removeAttribute(attribute);
          }
          const glyph = source.querySelector('svg')?.outerHTML ?? '';
          if (mirror.innerHTML !== glyph) localizedMarkup(mirror, glyph);
        };
        copy();
        const watch = new win.MutationObserver(copy);
        watch.observe(source, {attributes: true, attributeFilter: [...MIRRORED, 'aria-label'], childList: true});
        signal.addEventListener('abort', () => watch.disconnect(), {once: true});
        stripMirrors.set(source, mirror);
      }
      return mirror;
    });
  }

  /** Puts `nodes` into `parent` in order from `start`, moving only what is out of place. */
  function order(parent, nodes, start = 0) {
    nodes.forEach((node, index) => {
      const at = parent.children[start + index] ?? null;
      if (at !== node) parent.insertBefore(node, at);
    });
  }

  function tabOf(id) {
    let tab = tabElements.get(id);
    if (!tab) {
      tab = doc.createElement('button');
      tab.type = 'button';
      tab.className = 'ui-tab';
      tab.id = `${id}-tab`;
      tab.setAttribute('role', 'tab');
      tab.dataset.panel = id;
      if (descriptor(id)?.titleKey) localizedText(tab, descriptor(id).titleKey); else tab.textContent = title(id);
      localizedAttribute(tab, "title", "dockHost.dragToMovePanelRightClickForLayout", {});
      tabElements.set(id, tab);
    }
    const target = rootOf(id);
    if (target?.id) tab.setAttribute('aria-controls', target.id);
    return tab;
  }

  /** Moves the panels' tabs and roots into an island and shows the active one. */
  function fill(island, ids, active, {hide = []} = {}) {
    const tablist = island.querySelector(':scope > .shell-tabs');
    const tabs = ids.map(tabOf);
    order(tablist, tabs);
    for (const tab of [...tablist.children]) if (!tabs.includes(tab)) tab.remove();
    const roots = ids.map(rootOf).filter(Boolean);
    order(island, roots, 1);
    const shown = ids.filter(id => !hide.includes(id));
    tablist.hidden = !shown.length;
    tablist.setAttribute('aria-label', shown.map(title).join(', ') || SIDE_NAMES.right);
    for (const id of ids) {
      const tab = tabOf(id), selected = id === active;
      tab.hidden = hide.includes(id);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    island.dataset.panels = ids.join(' ');
  }

  function applyFloating(s) {
    const live = new Set(s.floating.map(item => item.panel));
    for (const [id, island] of floats) if (!live.has(id)) { island.remove(); floats.delete(id); }
    if (!s.floating.length) { floatHost?.remove(); floatHost = null; return; }
    if (!floatHost) {
      floatHost = doc.createElement('div');
      floatHost.className = 'shell-floats';
      appendLocalized(stage, floatHost);
    }
    for (const item of s.floating) {
      let island = floats.get(item.panel);
      if (!island) {
        island = makeIsland(`float-${item.panel}`);
        island.dataset.floating = '';
        island.setAttribute('role', 'region');
        appendLocalized(floatHost, island);
        floats.set(item.panel, island);
      }
      if (descriptor(item.panel)?.titleKey) localizedAttribute(island, 'aria-label', descriptor(item.panel).titleKey); else island.setAttribute('aria-label', title(item.panel));
      Object.assign(island.style, {inlineSize: px(item.w), blockSize: px(item.h), transform: `translate(${Math.round(item.x)}px, ${Math.round(item.y)}px)`});
      fill(island, [item.panel], item.panel);
      island.querySelector(':scope > .shell-tabs').hidden = false;
    }
  }

  function applyBottom(s) {
    const b = s.regions.bottom;
    bottom.hidden = b.state === 'hidden';
    bottom.dataset.state = b.state;
    const folded = b.state === 'strip';
    if (!folded && bodyOpen) closeBody({restoreFocus: false, recommit: false});
    if (folded && !body.hasAttribute('popover')) body.setAttribute('popover', 'manual');
    if (!folded && body.hasAttribute('popover')) body.removeAttribute('popover');
    if (bodyButton) {
      if (bodyButton.hidden !== !folded) bodyButton.hidden = !folded;
      bodyButton.setAttribute('aria-expanded', String(bodyOpen));
    }
    if (bodyOpen) placeBody();
  }

  function applyControls(s) {
    if (sheetButton) {
      const right = s.regions.right;
      if (sheetButton.hidden !== (right.state !== 'sheet')) sheetButton.hidden = right.state !== 'sheet';
      sheetButton.setAttribute('aria-expanded', String(sheets.right.open));
      sheetButton.setAttribute('aria-controls', sheetFor('right').id);
    }
    if (expandButton) {
      const tall = isTall();
      expandButton.setAttribute('aria-pressed', String(tall));
      localizedAttribute(expandButton, 'aria-label', (tall ? "dockHost.restoreTimelineHeight" : "dockHost.expandTimeline"), (tall ? {} : {}));
    }
    for (const side of SIDES) {
      for (const button of strips[side]?.children ?? []) {
        // A panel's strip button says whether its sheet is open; a mirrored action (no data-panel) keeps its source's state.
        if (!button.dataset.panel) continue;
        const open = sheets[side].open && sheets[side].active === button.dataset.panel;
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-pressed', String(open));
      }
    }
    applySplitters(s);
  }

  function applyVisibility(s) {
    const open = SIDES.filter(side => sheets[side].open && sheets[side].active).map(side => sheets[side].active);
    if (bodyOpen) open.push('timeline');
    registry.applySolution(s, {open});
    for (const descriptorData of registry.list()) {
      const {id} = descriptorData;
      if (id === 'timeline') continue;
      const panelRoot = rootOf(id);
      if (!panelRoot) continue;
      const visible = registry.isVisible(id);
      if (panelRoot.hidden === visible) panelRoot.hidden = !visible;
    }
  }

  // ---------------------------------------------------------------------
  // Sheets

  function placeSheet(side) {
    const sheet = sheetIslands[side];
    if (!sheet) return;
    // The touch stylesheet places sheets at the window's edges (touch.css).
    if (touchState()) {
      for (const name of ['--sheet-top', '--sheet-start', 'max-block-size', 'block-size']) sheet.style.removeProperty(name);
      return;
    }
    const area = workspace.getBoundingClientRect();
    const strip = side === 'left' && solution?.regions.left.strip ? solution.regions.left.strip : 0;
    // Down to the stage island's bottom (the timeline's header stays in view), or the workspace's when the stage spans it.
    const floor = Math.min(area.bottom - 8, stage.getBoundingClientRect().bottom);
    sheet.style.setProperty('--sheet-top', px(area.top));
    sheet.style.setProperty('--sheet-start', px(SHELL_METRICS.width.wide.padEnd + strip + SHELL_METRICS.width.wide.columnGap));
    // Inline: the sheet component's own cap (the window) would beat the layout layer's. The right sheet
    // (Properties at compact width) is as tall as its content; a strip's sheet keeps that whole height for
    // its lists (Structure's tree is virtual, so it has no content height of its own).
    const cap = px(Math.max(120, floor - area.top));
    sheet.style.setProperty('max-block-size', cap);
    if (side === 'left') sheet.style.setProperty('block-size', cap); else sheet.style.removeProperty('block-size');
  }

  function openSheet(side, id, {invoker = doc.activeElement, focus = true} = {}) {
    const state = sheets[side];
    onBeforeChange?.();
    // Focus returns to what opened the sheet, not to a tab inside it.
    if (!state.open) state.invoker = invoker instanceof win.HTMLElement ? invoker : null;
    state.active = id;
    state.open = true;
    const sheet = sheetFor(side);
    commit();
    if (!sheet.matches(':popover-open')) {
      try { sheet.showPopover(); } catch (error) { report(error); }
    }
    placeSheet(side);
    if (focus) focusPanel(id);
  }

  function closeSheet(side, {restoreFocus = true, recommit = true} = {}) {
    const state = sheets[side], sheet = sheetIslands[side];
    if (!state.open) return;
    const hadFocus = sheet?.contains(doc.activeElement);
    state.open = false;
    if (sheet?.matches(':popover-open')) {
      try { sheet.hidePopover(); } catch (error) { report(error); }
    }
    if (recommit) commit();
    if (restoreFocus && hadFocus && state.invoker?.isConnected) state.invoker.focus({preventScroll: true});
    state.invoker = null;
  }

  function placeBody() {
    const rect = bottom.getBoundingClientRect(), area = workspace.getBoundingClientRect();
    const room = Math.max(120, rect.top - area.top - 12);
    body.style.setProperty('--sheet-bottom', px(win.innerHeight - rect.top + 6));
    body.style.setProperty('--sheet-block', px(Math.min(room, 360)));
  }

  /** Opens the timeline body as a sheet (the low height tier) and, like the side sheets, moves focus into it. */
  function openBody({invoker = doc.activeElement, focus = true} = {}) {
    if (solution?.regions.bottom.state !== 'strip') return false;
    onBeforeChange?.();
    bodyOpen = true;
    bodyInvoker = invoker instanceof win.HTMLElement ? invoker : null;
    if (!body.hasAttribute('popover')) body.setAttribute('popover', 'manual');
    placeBody();
    if (!body.matches(':popover-open')) {
      try { body.showPopover(); } catch (error) { report(error); }
    }
    commit();
    if (focus) focusPanel('timeline');
    return true;
  }

  function closeBody({restoreFocus = true, recommit = true} = {}) {
    if (!bodyOpen) return;
    const hadFocus = body.contains(doc.activeElement);
    bodyOpen = false;
    if (body.matches?.(':popover-open')) {
      try { body.hidePopover(); } catch (error) { report(error); }
    }
    if (recommit) commit();
    if (restoreFocus && hadFocus && bodyInvoker?.isConnected) bodyInvoker.focus({preventScroll: true});
    bodyInvoker = null;
  }

  /** A press or key inside another overlay (a menu, a picker, a dialog) leaves the shell's sheets alone. */
  const insideOverlay = target => Boolean(target?.closest?.('dialog[open], #menu, [popover]:popover-open:not(.shell-sheet, .shell-timeline-body)'));
  doc.addEventListener('pointerdown', event => {
    for (const side of SIDES) {
      const sheet = sheetIslands[side];
      if (!sheets[side].open || sheet?.contains(event.target)) continue;
      if (event.target.closest?.(`.shell-strip-button, .shell-sheet-button`) || insideOverlay(event.target)) continue;
      closeSheet(side, {restoreFocus: false});
    }
    if (bodyOpen && !body.contains(event.target) && !event.target.closest?.('.shell-timeline-sheet') && !insideOverlay(event.target))
      closeBody({restoreFocus: false});
  }, {capture: true, signal});
  // Escape inside a sheet closes it (captured, so the editor's Cancel does not also run).
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || insideOverlay(event.target)) return;
    for (const side of SIDES) {
      const state = sheets[side];
      if (state.open && (sheetIslands[side]?.contains(event.target) || event.target === state.invoker)) { event.preventDefault(); closeSheet(side); return; }
    }
    // The timeline body's sheet closes from anywhere in the timeline (its header too).
    if (bodyOpen && (bottom.contains(event.target) || event.target === bodyInvoker)) { event.preventDefault(); closeBody(); }
  }, {capture: true, signal});
  // A sheet closes when focus leaves it for something it could cover (WCAG 2.4.11), as a press outside does:
  // not for its invoker, another overlay, or (the timeline's) its own header.
  const leaves = (event, keep) => {
    const next = event.relatedTarget;
    return next instanceof win.Element && !keep.some(element => element?.contains?.(next)) && !insideOverlay(next);
  };
  body.addEventListener('focusout', event => {
    if (bodyOpen && leaves(event, [bottom, bodyInvoker])) closeBody({restoreFocus: false});
  }, {signal});

  // ---------------------------------------------------------------------
  // Tabs, strips and the timeline's own controls

  workspace.addEventListener('click', event => {
    const tab = event.target.closest?.('.shell-tabs [role="tab"][data-panel]');
    if (tab) { showPanel(tab.dataset.panel, {focus: false}); return; }
    const strip = event.target.closest?.('.shell-strip-button[data-panel]');
    if (strip) {
      const side = SIDES.find(item => strips[item]?.contains(strip));
      if (sheets[side].open && sheets[side].active === strip.dataset.panel) closeSheet(side);
      else openSheet(side, strip.dataset.panel, {invoker: strip});
    }
  }, {signal});
  workspace.addEventListener('keydown', event => {
    const tab = event.target.closest?.('.shell-tabs [role="tab"]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll(':scope > [role="tab"]:not([hidden])')];
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    event.preventDefault();
    event.stopPropagation();
    showPanel(tabs[next].dataset.panel, {focus: false});
    tabs[next].focus();
  }, {signal});
  expandButton?.addEventListener('click', () => toggleTall(), {signal});

  // ---------------------------------------------------------------------
  // Splitters

  function splitterFor(name) {
    if (splitters[name]) return splitters[name];
    const el = doc.createElement('div');
    el.className = 'ui-splitter shell-splitter';
    el.dataset.splitter = name;
    el.dataset.ui = '';
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    const stacked = name.endsWith('-islands'), side = name.split('-')[0];
    const vertical = !stacked && name !== 'bottom';
    el.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
    // In the tab order beside the region it resizes (the grid places it; dock.css).
    if (stacked) { el.classList.add('shell-island-splitter'); appendLocalized(hosts[side], el); }
    else if (name === 'right') hosts.right.before(el);
    else if (name === 'left') hosts.left.after(el);
    else bottom.before(el);
    const sign = stacked || name === 'left' ? 1 : -1;
    const coordinate = event => (vertical ? event.clientX : event.clientY);
    let drag = null;
    const finish = cancel => {
      if (!drag) return;
      const {pointerId, key, size} = drag;
      drag = null;
      delete el.dataset.dragging;
      override = null;
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
      if (!cancel && size !== undefined) store.update(layout => resizedLayout(layout, name, size, key));
      commit();
    };
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag || !solution?.aria[name]) return;
      event.preventDefault();
      el.focus({preventScroll: true});
      drag = {pointerId: event.pointerId, origin: coordinate(event), start: sizeOf(name), key: keyOf(name)};
      el.setPointerCapture(event.pointerId);
      el.dataset.dragging = 'true';
    }, {signal});
    el.addEventListener('pointermove', event => {
      if (drag?.pointerId !== event.pointerId) return;
      event.preventDefault();
      const bounds = solution?.aria[name];
      if (!bounds) return;
      drag.size = Math.round(clamp(drag.start + sign * (coordinate(event) - drag.origin), bounds.min, bounds.max));
      const {key, size} = drag;
      override = layout => resizedLayout(layout, name, size, key);
      schedule();
    }, {signal});
    el.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finish(false); }, {signal});
    el.addEventListener('pointercancel', () => finish(true), {signal});
    el.addEventListener('lostpointercapture', () => finish(true), {signal});
    win.addEventListener('blur', () => finish(true), {signal});
    el.addEventListener('dblclick', event => { event.preventDefault(); resetSize(name); }, {signal});
    el.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      const grow = stacked ? {ArrowDown: 1, ArrowUp: -1} : name === 'right' ? {ArrowLeft: 1, ArrowRight: -1} : name === 'left' ? {ArrowRight: 1, ArrowLeft: -1} : {ArrowUp: 1, ArrowDown: -1};
      if (event.key === 'Home' || event.key === 'Enter') resetSize(name);
      else if ((grow[event.key] || event.key === 'End') && solution?.aria[name]) {
        const bounds = solution.aria[name];
        const size = event.key === 'End' ? bounds.max
          : Math.round(clamp(sizeOf(name) + grow[event.key] * (event.shiftKey ? BIG_STEP : STEP), bounds.min, bounds.max));
        store.update(layout => resizedLayout(layout, name, size));
        commit();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }, {signal});
    splitters[name] = {el, cancel: () => finish(true)};
    return splitters[name];
  }

  const keyOf = name => (name === 'bottom' ? 'bottom' : solution?.regions[name]?.sizeKey ?? name);
  const sizeOf = name => solution?.aria[name]?.now ?? 0;
  function resizedLayout(layout, name, size, key = keyOf(name)) {
    if (!name.endsWith('-islands')) return setSharedSize(layout, key, size);
    const side = name.split('-')[0], groups = solution?.regions[side]?.groups;
    if (groups?.length !== 2) return layout;
    const total = groups.reduce((sum, group) => sum + group.rect.height, 0);
    const share = size === null ? .5 : clamp(size / Math.max(1, total), 0, 1);
    const m = mode(), entry = layout.modes[m];
    return {...layout, modes: {...layout.modes, [m]: {...entry, weights: {...entry.weights, [side]: [share, 1 - share]}}}};
  }
  function resetSize(name) {
    store.update(layout => resizedLayout(layout, name, null));
    commit();
  }

  function applySplitters(s) {
    for (const name of ['left', 'right', 'bottom', 'left-islands', 'right-islands']) {
      const bounds = s.aria[name];
      const {el} = splitterFor(name);
      el.hidden = !bounds;
      if (!bounds) continue;
      el.setAttribute('aria-valuemin', String(bounds.min));
      el.setAttribute('aria-valuemax', String(bounds.max));
      el.setAttribute('aria-valuenow', String(bounds.now));
      localizedAttribute(el,'aria-valuetext','dockHost.sizePixels',{count:bounds.now});
      if (name.endsWith('-islands')) {
        const side = name.split('-')[0], groups = s.regions[side].groups;
        el.style.insetBlockStart = px(groups[0].rect.height + metrics.gutter / 2);
        localizedAttribute(el, 'aria-label', side === 'left' ? 'dockHost.resizeStackedLeftPanels' : 'dockHost.resizeStackedRightPanels', {});
        el.setAttribute('aria-controls', groups.flatMap(group => group.tabs.map(id => rootOf(id)?.id)).filter(Boolean).join(' '));
        continue;
      }
      const region = s.regions[name];
      const panels = name === 'bottom' ? ['timeline'] : region.panels.docked;
      const labelKey = name === 'bottom' ? "dockHost.resizeTimeline" : panels.includes('structure') ? "dockHost.resizeFigureStructure"
        : panels.includes('properties') ? "dockHost.resizePropertiesPanel" : 'dockHost.resizePanels';
      const labelParams=labelKey==='dockHost.resizePanels'?{panels:{format:'list',value:panels.map(id=>descriptor(id)?.titleKey?{messageKey:descriptor(id).titleKey}:title(id))}}:{};
      localizedAttribute(el,'aria-label',labelKey,labelParams);
      el.setAttribute('aria-controls', name === 'bottom' ? bottom.id : hosts[name].id || '');
      if (!hosts[name]?.id && name !== 'bottom') el.removeAttribute('aria-controls');
    }
  }

  // ---------------------------------------------------------------------
  // Commands (the workspace API and shell-commands.mjs)

  /** Replaces the current workspace's arrangement with `change(arrangement, mode)`. */
  function arrange(change) {
    const m = mode();
    store.update(layout => {
      const entry = layout.modes[m];
      const next = change({rail: entry.rail, bottomSpan: entry.bottomSpan, panels: entry.panels, weights: entry.weights}, m);
      return next === entry ? layout : {...layout, modes: {...layout.modes, [m]: {...entry, ...next}}};
    });
    commit();
  }
  const presentation = id => solution?.panels[id]?.presentation ?? 'unavailable';
  const sideOf = id => solution?.panels[id]?.side;
  const place = (id, target, options = {}) => arrange((arrangement, m) => movePanel(arrangement, id, target, {mode: m, ...options}));

  /** Shows a panel: its tab in a docked island, its floating island, or a sheet; `focus` moves focus to it. */
  function showPanel(id, {focus = true, invoker} = {}) {
    if (!registry.has(id) || presentation(id) === 'unavailable') return false;
    onBeforeChange?.();
    const current = presentation(id);
    if (id === 'timeline') {
      if (current === 'hidden') place(id, 'docked');
      else if (current === 'strip') openBody({invoker});
      if (focus) focusPanel(id);
      return true;
    }
    if (current === 'docked') arrange((arrangement, m) => activatePanel(arrangement, id, {mode: m}));
    else if (current === 'hidden') place(id, 'docked');
    else if (current === 'strip' || current === 'sheet') {
      openSheet(sideOf(id), id, {invoker, focus});
      return true;
    }
    if (focus) focusPanel(id);
    return true;
  }

  /** Focuses a panel: its tab, else its main collection (a tree, the timeline's grid or frame list), else its first control. */
  function focusPanel(id) {
    const tab = tabOf(id);
    if (id !== 'timeline' && tab.isConnected && !tab.hidden && !tab.parentElement?.hidden) { tab.focus({preventScroll: true}); return; }
    const panel = id === 'timeline' ? bottom : rootOf(id);
    const usable = element => element.getClientRects().length && !element.disabled && element.tabIndex >= 0;
    const target = [...(panel?.querySelectorAll(COLLECTIONS) ?? [])].find(usable)
      ?? [...(panel?.querySelectorAll('[tabindex="0"], button, input, select, textarea') ?? [])].find(usable);
    target?.focus({preventScroll: true});
  }

  const focusedIn = id => {
    const active = doc.activeElement;
    if (!active || active === doc.body) return false;
    return Boolean(rootOf(id)?.contains(active) || (tabOf(id).isConnected && tabOf(id) === active));
  };

  /**
   * The panel toggles (Ctrl+1–4, the band's Properties button): shows and
   * focuses the panel, and folds it when it is already shown and focused.
   * With `state` ('docked', 'strip' or 'hidden') it puts the panel there.
   * The timeline toggles Full ↔ Strip (Build: shown ↔ hidden); where the
   * window folds it, its body opens as a sheet.
   */
  function togglePanel(id, state) {
    if (!registry.has(id) || presentation(id) === 'unavailable') return false;
    if (state) {
      onBeforeChange?.();
      if (!canPlacePanel(id, state === 'docked' ? 'docked' : state, {mode: mode(), catalog: registry.constraints()})) return false;
      place(id, state);
      return true;
    }
    const current = presentation(id);
    if (id === 'timeline') {
      const stored = store.layout.modes[mode()].panels.find(record => record.id === 'timeline');
      if (current === 'strip' && stored?.dock === 'bottom') return bodyOpen ? (closeBody(), true) : openBody();
      onBeforeChange?.();
      place(id, current === 'docked' ? (mode() === 'rig' ? 'hidden' : 'strip') : 'docked');
      return true;
    }
    if (current === 'strip' || current === 'sheet') {
      const side = sideOf(id);
      if (sheets[side].open && sheets[side].active === id) { closeSheet(side); return true; }
      openSheet(side, id);
      return true;
    }
    const shown = registry.isVisible(id);
    if (shown && focusedIn(id)) {
      onBeforeChange?.();
      place(id, 'strip');
      return true;
    }
    return showPanel(id);
  }

  function toggleTimelineSheet() {
    if (bodyOpen) { closeBody(); return true; }
    return openBody();
  }

  const tallSize = () => Math.floor(TALL_TIMELINE * (app.clientHeight || win.innerHeight));
  // The stored timeline height before Expand (null: the default), which a second press restores.
  let beforeTall = null;
  function isTall() {
    const stored = store.layout.shared.sizes.bottom;
    return stored != null && stored >= Math.min(tallSize(), solution?.aria.bottom?.max ?? Infinity) - 1;
  }
  /** Tall timeline ↔ the height it had before (the user's or the default): a size only, so playback and edits carry on. */
  function toggleTall() {
    const tall = isTall();
    if (!tall) beforeTall = store.layout.shared.sizes.bottom ?? null;
    const next = tall ? beforeTall : tallSize();
    if (tall) beforeTall = null;
    store.update(layout => setSharedSize(layout, 'bottom', next));
    commit();
    return !tall;
  }

  /** `float('right')` (1.1's name) floats the right dock's shown panel if it can float, else its first floatable one. */
  function floatTarget(id) {
    if (id !== 'right' && id !== 'left') return id;
    const region = solution?.regions[id];
    const catalog = registry.constraints();
    const floatable = ids => ids.filter(panel => catalog.find(item => item.id === panel)?.floatable);
    const active = region?.groups.map(group => group.active) ?? [];
    return floatable(active)[0] ?? floatable(region?.panels.docked ?? [])[0] ?? floatable([...(region?.panels.strip ?? []), ...(region?.panels.sheet ?? [])])[0] ?? null;
  }

  const workspaceApi = {
    get sizes() {
      const s = solution ?? commit();
      return {left: s.regions.left.size, right: s.regions.right.size, timeline: s.regions.bottom.size};
    },
    /** What the store last read or wrote (the preferences file or localStorage). */
    get preferences() { return store.stored ?? {}; },
    get layout() { return store.layout; },
    get solution() { return solution; },
    get tier() { return solution?.tier; },
    get height() { return solution?.height; },
    get stageInsets() { return {...(solution?.stageInsets ?? {top: 0, right: 0, bottom: 0, left: 0})}; },
    get floating() { return (solution?.floating ?? []).map(item => ({...item})); },
    get layouts() { return store.layout.saved.map(item => ({id: item.id, name: item.name, mode: item.mode})); },
    get readOnly() { return store.readOnly; },
    /** Every workspace at its default and the shared sizes cleared (Settings › Reset workspace). */
    reset() {
      onBeforeChange?.();
      for (const side of SIDES) closeSheet(side, {restoreFocus: false, recommit: false});
      closeBody({restoreFocus: false, recommit: false});
      store.update(layout => resetLayout(layout));
      commit();
    },
    resize: () => commit(),
    flushPreferences: () => store.flush(),
    setPreset(id) {
      onBeforeChange?.();
      const m = mode();
      store.update(layout => applyPreset(layout, m, id, {workspaceHeight: workspace.clientHeight}));
      commit();
    },
    togglePanel,
    show: showPanel,
    activate: id => showPanel(id, {focus: false}),
    fold: id => togglePanel(id, 'strip'),
    hide: id => togglePanel(id, 'hidden'),
    /** Docks as a tab of `tabInto`, at `index`, or in a separate island with `split: before|after`. */
    dock(id, region, {tabInto, index, split} = {}) {
      onBeforeChange?.();
      const group = tabInto ? store.layout.modes[mode()].panels.find(record => record.id === tabInto)?.group ?? 0 : undefined;
      place(id, region, {group, index, split});
    },
    float(id, rect) {
      const panel = floatTarget(id);
      if (!panel) return false;
      onBeforeChange?.();
      place(panel, 'float', {rect});
      return true;
    },
    focus(on) {
      onBeforeChange?.();
      const m = mode();
      store.update(layout => toggleFocus(layout, m, {on}));
      commit();
    },
    resetWorkspace() {
      onBeforeChange?.();
      const m = mode();
      store.update(layout => resetMode(layout, m));
      commit();
    },
    saveLayout(name) {
      const m = mode();
      let result;
      store.update(layout => {
        result = savePreset(layout, {name, mode: m});
        return result.layout;
      });
      commit();
      if (result?.error) throw messageError(new Error(''), result.error === 'limit' ? "dockHost.message8PresetsSavedDeleteOneFirst"
        : result.error === 'budget' ? "dockHost.presetStorageIsFullDeleteOneFirst" : "dockHost.nameThePresetFirst");
      return result.id;
    },
    deleteLayout(id) {
      store.update(layout => deletePreset(layout, id));
      commit();
    },
    renameLayout(id, name) {
      let result;
      store.update(layout => {
        result = renamePreset(layout, id, name);
        return result.layout;
      });
      commit();
      if (result?.error) throw messageError(new Error(''), result.error === 'name' ? "dockHost.nameThePresetFirst" : "dockHost.thisPresetNoLongerExists");
    },
    /** Replaces a saved preset with its workspace's current arrangement. */
    updateLayout(id) {
      store.update(layout => updatePreset(layout, id).layout);
      commit();
    },
    /** Whether the workspace can be saved as a new preset: {ok} or {ok: false, reason: 'limit' | 'budget'}. */
    canSaveLayout: () => canSavePreset(store.layout, mode()),
    /** The tools' rail on the stage's `left` or `right`. */
    setRail(side) {
      if (side !== 'left' && side !== 'right') return false;
      onBeforeChange?.();
      arrange(arrangement => ({...arrangement, rail: side}));
      return true;
    },
    /** The timeline under the whole workspace (`full`, the default) or under the stage only (`stage`). */
    setTimelineSpan(span) {
      if (span !== 'full' && span !== 'stage') return false;
      onBeforeChange?.();
      arrange(arrangement => ({...arrangement, bottomSpan: span}));
      return true;
    },
    toggleTall,
    get tall() { return isTall(); },
    timelineSheet: toggleTimelineSheet,
    destroy: () => destroy(),
  };

  // ---------------------------------------------------------------------
  // Lifecycle

  function modeChanged() {
    const next = mode();
    if (next === currentMode) return;
    currentMode = next;
    for (const side of SIDES) closeSheet(side, {restoreFocus: false, recommit: false});
    closeBody({restoreFocus: false, recommit: false});
    // Entering Draw or Build shows Properties; Animate keeps its own last tab.
    const record = store.layout.modes[next]?.panels.find(item => item.id === 'properties');
    if (next !== 'animate' && record && record.dock === record.side && !record.active)
      arrange((arrangement, m) => activatePanel(arrangement, 'properties', {mode: m}));
    else commit();
  }

  const resizeObserver = new win.ResizeObserver(() => commit());
  resizeObserver.observe(app);
  // The touch layouts size the workspace around their own chrome (the tab bar, the wing), without resizing the window.
  resizeObserver.observe(workspace);
  const stopTouch = touch?.on?.(() => {
    for (const side of SIDES) closeSheet(side, {restoreFocus: false, recommit: false});
    closeBody({restoreFocus: false, recommit: false});
    // The band's controls changed size with the interface: measure its folds again.
    bandWatch?.refresh();
    commit();
  });
  // The band is shorter at the low height tier: its new height solves again.
  if (band) resizeObserver.observe(band);
  // The floating tool bar folds into two columns where its tools in one column would be taller than the room the
  // solver gives it (Draw's tools in a short window); the solver then widens it and the artboard keeps clear. Its
  // "more below" fade stays for a bar that still does not fit.
  const rail = workspace.querySelector('.shell-rail');
  const railFit = () => {
    const dock = rail.querySelector(':scope > .tool-dock');
    // A horizontal bar (an upright phone) is one row that scrolls sideways; columns are for a bar down the side.
    if (solution?.rail?.orientation === 'horizontal') {
      if (railColumns !== 1) { railColumns = 1; rail.toggleAttribute('data-columns', false); schedule(); }
    } else if (dock && solution?.rail?.rect) {
      const items = [...dock.children].filter(node => node.offsetParent !== null);
      const box = win.getComputedStyle(rail), gap = parseFloat(win.getComputedStyle(dock).rowGap) || 0;
      const add = dock.querySelector(':scope > .rail-add');
      const apart = add && add.offsetParent !== null ? parseFloat(win.getComputedStyle(add).marginBlockEnd) || 0 : 0;
      const natural = items.reduce((sum, node) => sum + node.offsetHeight, 0) + gap * Math.max(0, items.length - 1)
        + (parseFloat(box.paddingTop) || 0) + (parseFloat(box.paddingBottom) || 0) + apart
        + [...rail.children].filter(node => node !== dock && node.offsetParent !== null).reduce((sum, node) => {
          const style = win.getComputedStyle(node);
          return sum + node.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        }, 0);
      const columns = mode() === 'rig' || items.length > 1 && natural > solution.rail.rect.height + 0.5 ? 2 : 1;
      if (columns !== railColumns) {
        railColumns = columns;
        rail.toggleAttribute('data-columns', columns === 2);
        schedule();
      }
    }
    const horizontal = solution?.rail?.orientation === 'horizontal';
    const more = !horizontal && rail.scrollHeight - rail.scrollTop - rail.clientHeight > 1;
    if (rail.hasAttribute('data-more-below') !== more) rail.toggleAttribute('data-more-below', more);
    const after = horizontal && rail.scrollWidth - rail.scrollLeft - rail.clientWidth > 1;
    if (rail.hasAttribute('data-more-after') !== after) rail.toggleAttribute('data-more-after', after);
  };
  const railObserver = rail ? new win.ResizeObserver(railFit) : null;
  if (rail) {
    for (const element of [rail, ...rail.children]) railObserver.observe(element);
    rail.addEventListener('scroll', railFit, {passive: true, signal});
    listeners.solve.add(() => railFit());
  }
  // The band's widths change with its content (a name, a language, a session), never with the window.
  const bandWatch = band ? watchBand(band, {window: win, document: doc, storage: browserStorage(win), start: ready, onChange: () => schedule()}) : null;
  const modeObserver = new win.MutationObserver(modeChanged);
  modeObserver.observe(workspace, {attributes: true, attributeFilter: ['data-mode']});
  registry.on('define', () => schedule(), {signal});
  store.on('change', ({origin}) => { if (origin === 'merge') schedule(); });
  win.addEventListener('blur', () => { for (const splitter of Object.values(splitters)) splitter.cancel(); }, {signal});
  win.addEventListener('pagehide', () => { void store.flush(); }, {signal});

  function destroy() {
    if (destroyed) return store.flush();
    destroyed = true;
    abort.abort();
    stopTouch?.();
    resizeObserver.disconnect();
    railObserver?.disconnect();
    modeObserver.disconnect();
    bandWatch?.stop();
    if (frame) win.cancelAnimationFrame(frame);
    for (const splitter of Object.values(splitters)) splitter.el.remove();
    floatHost?.remove();
    return store.destroy();
  }

  commit();

  return {
    registry,
    store,
    workspace: workspaceApi,
    get solution() { return solution; },
    /** #viewport's insets at fit for the current solution (fittedView). */
    stageInsets: () => ({...(solution?.stageInsets ?? {top: 24, right: 28, bottom: 24, left: 28})}),
    define: descriptorInput => registry.define(descriptorInput),
    showPanel,
    togglePanel,
    toggleTimelineSheet,
    toggleTall,
    /** Closes every open sheet (the side panels' and the timeline body's), as Escape or a press outside does. */
    closeSheets({restoreFocus = false} = {}) {
      for (const side of SIDES) closeSheet(side, {restoreFocus, recommit: false});
      closeBody({restoreFocus, recommit: false});
      commit();
    },
    canPlace: (id, target) => canPlacePanel(id, target, {mode: mode(), catalog: registry.constraints()}),
    presentation,
    /** The current workspace (animate, draw or rig). */
    get mode() { return mode(); },
    place,
    commit,
    /** Calls `listener(solution)` after every commit; returns the unsubscribe function. */
    onSolve(listener) {
      listeners.solve.add(listener);
      return () => listeners.solve.delete(listener);
    },
    regions: () => ({hosts, bottom, stage, viewport, band, rail: workspace.querySelector('.shell-rail'), floats: [...floats.values()]}),
    destroy,
  };
}
