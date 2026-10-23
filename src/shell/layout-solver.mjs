/**
 * The layout solver: fits a stored layout (layout-schema.mjs) into the
 * window. Pure and deterministic; the dock host applies its solution in one
 * commit and never writes a fitted size back to the stored layout.
 *
 * Input: the layout, the `#app` content box in CSS px after the UI scale
 * (the window, which nothing the solution changes can resize, so tiers never
 * oscillate), the workspace, `footer`: the px the window keeps under the
 * workspace (the status bar until its log is hidden; 0 by default), and
 * `bandMin`: the top band's measured
 * min-content width after each step of its fold order (BAND_FOLDS), so a
 * longer language or a session's extra buttons fold the band's labels and
 * spacing first and fold the menubar into the mark (the minimal tier) only
 * where even the last step does not fit.
 *
 * Two independent tiers: the width tier folds horizontal chrome only (the
 * docks, the rail's size at minimal), the height tier vertical chrome only
 * (the timeline body, the stage insets), so a short window keeps its docked
 * inspector and a narrow one keeps its timeline body.
 *
 * Collapse order, applied until #viewport (the stage island below its 40px
 * header) holds its minimum of 360×200:
 *   width:  the tier's folds (compact and minimal: the left dock becomes a
 *           strip, the right dock a sheet, floating panels sheets), then the
 *           left dock narrows to its panels' minimum (Structure: 232, then
 *           200), then it becomes a strip, then the right dock a strip, then
 *           a sheet;
 *   height: the vertical insets give way first (24, 10, then 8), then the
 *           short tier's timeline (three or four content rows under a 24px
 *           ruler), then the low tier folds it to its header (the body opens
 *           as a sheet); a stored height that would still leave #viewport
 *           under 200 is compressed first and folded to the header only when
 *           even its row minimum does not fit.
 * Geometry, tiers and folds are data (SHELL_METRICS, TIER_THRESHOLDS,
 * STAGE_FLOORS, BAND_FOLDS), so the visual design can change them without
 * touching the algorithm.
 *
 * The bottom dock is the timeline's region: its default height, its row
 * minimum and `timelineRows` follow SHELL_METRICS.timeline whichever panels
 * are docked there. The default gives at least today's layer capacity:
 * Camera and Scene as two 24px pinned rows, then 4½ content slots in windows
 * taller than 800px, 4 from 600px and 3 below (experience §1.9).
 */
import {PANEL_CATALOG, panelInMode} from './panel-registry.mjs';
import {normalizeLayout, normalizeMode, solvableArrangement} from './layout-schema.mjs';

export const WIDTH_TIERS = Object.freeze(['wide', 'regular', 'narrow', 'compact', 'minimal']);
export const HEIGHT_TIERS = Object.freeze(['tall', 'short', 'low']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * A window at or below each value takes that tier (visual-system §11).
 * Compact starts at 800 (revision 4.1): from 801px everything stays docked,
 * as today's app keeps it.
 */
export const TIER_THRESHOLDS = deepFreeze({
  width: {regular: 1366, narrow: 1180, compact: 800, minimal: 660},
  height: {short: 640, low: 568},
});

/**
 * The band's fold order (experience §1.8): each step applies only while the
 * band still overflows, and the primary's word folds last. Only where even
 * the last step does not fit does the menubar fold into the mark (the
 * minimal tier). The names are the values `data-band` lists.
 */
export const BAND_FOLDS = Object.freeze(['state', 'tight', 'name', 'name8', 'savelabel', 'testrig', 'save', 'winctl',
  'export2', 'switchtight', 'icons', 'dot', 'redo', 'export2out', 'primary']);

/**
 * Shell geometry in CSS px (visual-system §5, experience §1.1, §1.2 and §1.9).
 * `width` rows are keyed by width tier, `height` rows by height tier.
 */
export const SHELL_METRICS = deepFreeze({
  // The roomy chrome of windows at least 801px tall: a 52px band, 8px of the field above the islands and a 44px
  // stage header. Shorter windows get the compact chrome (`chrome.compact`), which gives the room to the stage.
  band: 52,
  chrome: {roomy: 801, padTop: 8, compact: {band: 44, stageHead: 40, padTop: 6}},
  bandMargin: 24,
  gutter: 6,
  strip: 40,
  // The smallest island of a side (or of the bottom) that stacks two islands, along the split.
  islandMin: 120,
  // #viewport: the stage island below its header row.
  stageMin: {width: 360, height: 200},
  stageHead: 44,
  // The tools float beside the canvas: a 52px bar (40px tools and 6px of padding) 12px inside the stage's
  // #viewport, on its left by default; the artboard keeps clear of it at fit. 44px (32px tools) at the minimal
  // width, the low height tier and in the compact chrome.
  rail: {width: 52, compact: 44, margin: 12},
  width: {
    wide: {padEnd: 8, columnGap: 8, inset: 28, dock: {left: 232, right: 320}},
    regular: {padEnd: 8, columnGap: 8, inset: 28, dock: {left: 232, right: 296}},
    narrow: {padEnd: 8, columnGap: 8, inset: 20, dock: {left: 232, right: 256}},
    compact: {padEnd: 8, columnGap: 0, inset: 20, dock: {left: 232, right: 256}, message: 'inset',
      fold: {left: 'strip', right: 'sheet', float: 'sheet'}},
    minimal: {padEnd: 4, columnGap: 0, inset: 10, dock: {left: 232, right: 256}, message: 'inset', compactRail: true,
      fold: {left: 'strip', right: 'sheet', float: 'sheet'}},
  },
  // The timeline's ruler and content rows per height tier. The short tier caps a
  // stored height at the default (the "short timeline").
  height: {
    tall: {padBottom: 8, rowGap: 6, timeline: {ruler: 32, row: 32}},
    short: {padBottom: 8, rowGap: 6, timeline: {ruler: 24, row: 28, capAtDefault: true}},
    low: {padBottom: 4, rowGap: 4, timeline: {ruler: 24, row: 28}, compactRail: true, fold: {bottom: 'strip'}},
  },
  // #viewport's vertical insets by window height, [at least H, inset]: they give
  // way before the timeline's rows do. The horizontal inset is the width tier's.
  insets: [[801, 16], [0, 8]],
  // Timeline rows: its header, the ruler, Camera and Scene pinned, then content
  // rows. The default content slots by window height, [at least H, slots]; a
  // half slot shows that more rows scroll below. Never fewer than two.
  timeline: {header: 40, pinnedRow: 24, pinned: 2, minSlots: 2, slots: [[801, 4.5], [600, 4], [0, 3]]},
  floating: {margin: 8, width: 288, height: 520, minHeight: 240, offset: 16, cascade: 24},
  // The stage header's message slot: centred between the start and the end
  // cluster (view toggles, zoom, Fit), keeping `gap` from the end cluster on
  // both sides; at compact and minimal width it may cover them (inset only).
  message: {end: 200, gap: 12, inset: 8},
  collapse: {width: [['left', 'narrow'], ['left', 'strip'], ['right', 'strip'], ['right', 'sheet'], ['left', 'sheet']]},
  // The touch interface (docs/TOUCH.md), by form factor: what folds whatever the width, the stage's minimum, and
  // the floating tool bar's width with its touch-sized tools. A phone's side panels open as sheets (Structure keeps
  // its strip in Build); a tablet docks the inspector while the stage keeps 560px.
  touch: {
    // An upright phone keeps the timeline's body docked (the artboard is as wide as the phone, so the stage has height
    // to spare): its default is this share of the workspace, whatever the height tier.
    phone: {fold: {left: 'strip', right: 'sheet', float: 'sheet'}, stageMin: {width: 240, height: 140}, rail: 56, railMargin: 8,
      portraitTimeline: 0.47,
      // Upright, width is what a phone lacks: the tools lie along the stage's bottom edge instead of down its side.
      portraitRail: 'horizontal', ownBand: true, timelineHeader: 52,
      // On its side the timeline stays docked too (docs/TOUCH.md): its header, the ruler and one row by default.
      landscapeTimeline: 52 + 44 + 48},
    tablet: {fold: {float: 'sheet'}, stageMin: {width: 560, height: 240}, rail: 60, railMargin: 12, portraitTimeline: 0.34, timelineHeader: 52,
      // A folded inspector opens from the band's Properties button (a sheet), never as a 40px strip beside a finger.
      collapse: [['left', 'narrow'], ['left', 'strip'], ['right', 'sheet'], ['left', 'sheet']]},
  },
});

/**
 * Artboard-zoom floors (experience §1.9): a window at least W×H never gets
 * less than Z% at fit with the default layout (each workspace's default
 * preset at default sizes). They never decrease as a window grows, so no
 * larger window gets a smaller artboard than a smaller one. What the user
 * chooses is theirs to trade: a stored size (a splitter, Tall timeline,
 * Timing) or an extra dock may take the artboard below its floor, while
 * #viewport keeps its 360×200 minimum in every layout. Revision 4.1 dropped
 * the 800×600 row: from 801px the inspector stays docked, as today.
 */
export const STAGE_FLOORS = deepFreeze([[500, 340, 35], [600, 441, 45], [1024, 700, 60], [1280, 720, 65], [1440, 900, 90]]);
export const stageFloor = (width, height) => STAGE_FLOORS.reduce((floor, [w, h, zoom]) => (width >= w && height >= h ? Math.max(floor, zoom) : floor), 0);

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const dimension = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const measured = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const rect = (x, y, width, height) => ({x, y, width: Math.max(0, width), height: Math.max(0, height)});
/** The value of the first `[at least, value]` row the input reaches. */
const byThreshold = (rows, input, fallback) => rows.find(([at]) => input >= at)?.[1] ?? fallback;

export function widthTierFor(width, thresholds = TIER_THRESHOLDS) {
  let tier = WIDTH_TIERS[0];
  for (const name of WIDTH_TIERS.slice(1)) if (width <= thresholds.width[name]) tier = name;
  return tier;
}

export function heightTierFor(height, thresholds = TIER_THRESHOLDS) {
  let tier = HEIGHT_TIERS[0];
  for (const name of HEIGHT_TIERS.slice(1)) if (height <= thresholds.height[name]) tier = name;
  return tier;
}

/**
 * The fewest fold steps whose measured band fits the window. `widths` maps
 * `none` (the unfolded band) and each BAND_FOLDS step to the band's width
 * after it; a step a session does not have is absent and skipped.
 */
function foldBand(width, widths, margin) {
  if (!widths || typeof widths !== 'object') return {fits: true, band: []};
  const band = [];
  const none = measured(widths.none);
  if (!none || none + margin <= width) return {fits: true, band};
  for (const step of BAND_FOLDS) {
    const after = measured(widths[step]);
    if (!after) continue;
    band.push(step);
    if (after + margin <= width) return {fits: true, band};
  }
  return {fits: false, band};
}

/**
 * The width and height tiers and the band's fold steps.
 *
 * `bandMin` is the band's measured min-content width (the 24px margin is
 * added here):
 * - a number: the band with every fold step applied and the menubar docked;
 *   a window it does not fit is minimal;
 * - `{none, state, tight, …}`: after each BAND_FOLDS step with the menubar
 *   docked, plus `minimal: {none, …}` with the menubar folded into the mark.
 *   The solver applies the fewest steps that fit (`band`); where even the
 *   last does not, the tier is minimal and the minimal band folds likewise
 *   (every step, if nothing fits).
 * Width thresholds set the tier first; the band can only step it down to
 * minimal, never up.
 */
export function resolveTiers(width, height, {bandMin = 0, thresholds = TIER_THRESHOLDS, bandMargin = SHELL_METRICS.bandMargin} = {}) {
  const sized = widthTierFor(width, thresholds);
  let tier = sized, band = [];
  if (typeof bandMin === 'number') {
    if (sized !== 'minimal' && measured(bandMin) && measured(bandMin) + bandMargin > width) tier = 'minimal';
  } else if (bandMin && typeof bandMin === 'object') {
    if (sized !== 'minimal') {
      const docked = foldBand(width, bandMin, bandMargin);
      if (docked.fits) band = docked.band;
      else tier = 'minimal';
    }
    if (tier === 'minimal') band = foldBand(width, bandMin.minimal, bandMargin).band;
  }
  return {tier, height: heightTierFor(height, thresholds), band, bandStep: tier !== sized};
}

/** The chrome for a window `height`: roomy from `chrome.roomy` px tall, compact below ({name, band, stageHead, padTop}). */
export function chromeFor(height, metrics = SHELL_METRICS) {
  const c = metrics.chrome;
  if (!c) return {name: 'roomy', band: metrics.band, stageHead: metrics.stageHead ?? 0, padTop: 0};
  return height >= c.roomy
    ? {name: 'roomy', band: metrics.band, stageHead: metrics.stageHead ?? 0, padTop: c.padTop}
    : {name: 'compact', band: c.compact.band, stageHead: c.compact.stageHead, padTop: c.compact.padTop};
}

/** A docked timeline's height with `content` rows visible under the pinned ones. */
export function timelineHeightFor(content, heightTier = 'tall', metrics = SHELL_METRICS) {
  const t = metrics.timeline, rows = metrics.height[heightTier]?.timeline ?? metrics.height.tall.timeline;
  return Math.round(t.header + rows.ruler + t.pinned * t.pinnedRow + content * rows.row);
}

/** The default number of content slots for a window height. */
export const timelineSlotsFor = (height, metrics = SHELL_METRICS) =>
  Math.max(metrics.timeline.minSlots, byThreshold(metrics.timeline.slots, height, metrics.timeline.minSlots));

/**
 * The default timeline height: a function of the window height only (never
 * of the document, the workspace or the timeline mode), so a tab switch, a
 * mode switch or a new layer never moves the stage. It is derived again on
 * every solve and never stored, so it follows the window (264 above 800px,
 * 248 from 641, 224 at 600–640, 196 below 600, the 40px header at the low
 * tier) until the user stores a height.
 */
export function timelineDefaultHeight(height, heightTier = heightTierFor(height), metrics = SHELL_METRICS) {
  if (metrics.height[heightTier]?.fold?.bottom === 'strip') return metrics.timeline.header;
  return timelineHeightFor(timelineSlotsFor(height, metrics), heightTier, metrics);
}

/** #viewport's insets at fit: across by the width tier, down by the window height. */
export function stageInsetsFor(width, height, {tier = widthTierFor(width), metrics = SHELL_METRICS} = {}) {
  const across = metrics.width[tier]?.inset ?? metrics.width.wide.inset;
  const down = byThreshold(metrics.insets, height, 0);
  return {top: down, right: across, bottom: down, left: across};
}

/** The artboard zoom at fit (architecture §3.11.8), capped at `max`. */
export function fitZoom(viewport, insets, artboard = {width: 960, height: 540}, max = 2) {
  const width = viewport.width - insets.left - insets.right, height = viewport.height - insets.top - insets.bottom;
  if (!(artboard.width > 0 && artboard.height > 0)) return 0;
  return Math.max(0, Math.min(width / artboard.width, height / artboard.height, max));
}

/** A floating panel's rect, relative to the stage island, kept inside #viewport. */
function clampFloating(stored, descriptor, stage, head, metrics, index) {
  const f = metrics.floating;
  const area = {width: stage.width, height: Math.max(0, stage.height - head)};
  const margin = Math.min(f.margin, area.width / 2, area.height / 2);
  const maxWidth = Math.max(0, area.width - margin * 2), maxHeight = Math.max(0, area.height - margin * 2);
  const width = Math.round(clamp(stored?.w ?? descriptor.pref ?? f.width, Math.min(descriptor.min ?? 0, maxWidth), maxWidth));
  const height = Math.round(clamp(stored?.h ?? f.height, Math.min(f.minHeight, maxHeight), maxHeight));
  const cascade = index * f.cascade;
  const x = Math.round(clamp(stored?.x ?? area.width - width - f.offset - cascade, margin, area.width - width - margin));
  const y = Math.round(clamp(stored?.y ?? head + f.offset + cascade, head + margin, head + area.height - height - margin));
  return {x, y, w: width, h: height};
}

/**
 * Solves the layout for a window. Returns:
 *   tier, height            width and height tiers (data-tier, data-height)
 *   chrome, padTop          roomy (from 801px tall) or compact: the band, the stage header and the field above the islands (data-chrome)
 *   band                    the band's fold steps (data-band), BAND_FOLDS order
 *   touch                   the touch interface's form factor (phone, tablet) when env.touch is active, else null
 *   rail                    {side, orientation: 'vertical' (or 'horizontal' along the stage's bottom on an upright
 *                           phone), compact, columns, width, rect}
 *   regions.left|right      {state: docked|strip|sheet|hidden, size, strip, sizeKey, reason, rect, stripRect, groups, panels}
 *   regions.bottom          {state: docked|strip|hidden, size, span, body: docked|sheet|null, reason, rect, groups, panels}
 *                           groups: the docked islands, [{tabs, active, rect}], stacked on a side and
 *                           side by side at the bottom; panels: {docked, strip, sheet} ids
 *   floating                [{panel, x, y, w, h}] relative to the stage island, inside #viewport
 *   stage                   the stage island's rect (its header row, then #viewport)
 *   stageHead               the header row's height above #viewport
 *   viewport                #viewport's rect
 *   stageInsets             {top, right, bottom, left} inside #viewport for the artboard fit
 *   timelineRows            {pinned, content} visible before the rows scroll (content in half slots, >= 2 when docked)
 *   messageSlot             {width}
 *   aria                    splitters' {min, max, now} (null where there is none): the docks'
 *                           `left`, `right`, `bottom`, and `left-islands`, `right-islands`,
 *                           `bottom-islands` between two islands (now: the first island's extent)
 *   panels                  {[id]: {presentation, side, dock, group, active, visible}}
 *   rects                   {band, workspace, rail, stage, viewport}
 *   zoom                    the artboard zoom at fit when `artboard` is given
 * Every rect is in the #app box's coordinates.
 */
export function solveLayout(layout, env = {}) {
  const catalog = env.panels ?? PANEL_CATALOG;
  const metrics = env.metrics ?? SHELL_METRICS;
  const width = dimension(env.width), height = dimension(env.height);
  const mode = normalizeMode(env.mode);
  const model = normalizeLayout({shared: layout?.shared, modes: {[mode]: layout?.modes?.[mode]}}, {catalog, now: 0});
  const entry = solvableArrangement(model.modes[mode], mode, {catalog}), sizes = model.shared.sizes;
  const byId = new Map(catalog.map(descriptor => [descriptor.id, descriptor]));
  const records = entry.panels.filter(record => byId.has(record.id) && panelInMode(byId.get(record.id), mode));
  const describe = record => byId.get(record.id);

  // The touch interface lays its band out itself (touch.css), so the band's folds do not apply; its profile folds
  // the side panels by form factor instead (docs/TOUCH.md).
  const touch = env.touch?.active ? metrics.touch?.[env.touch.form] ?? null : null;
  // A phone's band is laid out by the touch stylesheet (a wing, or a row with a tab bar); a tablet's folds as the desktop's.
  const {tier, height: heightTier, band: bandFolds} = resolveTiers(width, height, {bandMin: touch?.ownBand ? 0 : env.bandMin, thresholds: env.tiers ?? TIER_THRESHOLDS, bandMargin: metrics.bandMargin});
  const across = metrics.width[tier], down = metrics.height[heightTier];
  const folds = {...(across.fold ?? {}), ...(touch?.fold ?? {})};
  const stageMin = touch?.stageMin ?? metrics.stageMin;
  // The islands keep the field's padding on every side: under the white band as along the window's edges.
  const chrome = chromeFor(height, metrics);
  const gap = across.columnGap, padEnd = Math.min(across.padEnd, Math.floor(width / 2)), padBottom = down.padBottom, padTop = Math.min(chrome.padTop, padBottom), rowGap = down.rowGap;
  const railCompact = !touch && Boolean(across.compactRail || down.compactRail || chrome.name === 'compact');
  // Two columns (env.railColumns, measured by the dock host) where one column of tools does not fit the viewport.
  const railColumns = env.railColumns === 2 ? 2 : 1, railBase = touch ? touch.rail : railCompact ? metrics.rail.compact : metrics.rail.width;
  const railWidth = Math.min(railColumns === 2 ? 2 * railBase - 8 : railBase, width);
  // The band's and the stage header's heights: measured in the app (env.measured), else the tier's or the default.
  const head = env.measured?.stageHead ?? chrome.stageHead;

  // Side docks.
  const sides = {};
  for (const side of ['left', 'right']) {
    const docked = records.filter(record => record.dock === side);
    const strip = records.filter(record => record.dock === 'strip' && record.side === side);
    sides[side] = {docked, strip, sheet: [], state: docked.length ? 'docked' : strip.length ? 'strip' : 'hidden', reason: null};
  }
  const requirement = () => Math.max(stageMin.width,
    ...['left', 'right'].flatMap(side => sides[side].state === 'docked' ? sides[side].docked.map(record => describe(record).stageMin ?? 0) : []));
  const fold = (side, to, reason) => {
    const s = sides[side];
    if (to === 'narrow' && s.state === 'docked' && s.size > s.min) {
      s.size = Math.max(s.min, s.size - (requirement() - stageWidth()));
      return true;
    }
    if (to === 'strip' && s.state === 'docked') {
      Object.assign(s, {strip: [...s.docked, ...s.strip].sort((a, b) => a.order - b.order), docked: [], state: 'strip', reason});
      return true;
    }
    if (to === 'sheet' && (s.state === 'docked' || s.state === 'strip')) {
      Object.assign(s, {sheet: [...s.docked, ...s.strip].sort((a, b) => a.order - b.order), docked: [], strip: [], state: 'sheet', reason});
      return true;
    }
    return false;
  };
  for (const [side, to] of Object.entries(folds)) if (sides[side]) fold(side, to, touch ? 'touch' : 'tier');
  for (const side of ['left', 'right']) {
    const s = sides[side];
    if (s.state !== 'docked') continue;
    // A panel that owns its width (Structure) sizes its side; otherwise the side's shared size.
    const owner = s.docked.find(record => describe(record).sizeKey);
    s.sizeKey = owner ? describe(owner).sizeKey : side;
    const fallback = owner ? describe(owner).pref : across.dock?.[side];
    s.min = Math.max(...s.docked.map(record => describe(record).min ?? 0));
    s.max = Math.max(s.min, Math.min(...s.docked.map(record => describe(record).max ?? Infinity)));
    s.size = Math.round(clamp(sizes[s.sizeKey] ?? fallback ?? s.min, s.min, s.max));
  }
  const extent = side => {
    const s = sides[side];
    if (s.state === 'docked') return s.size + (s.strip.length ? gap + metrics.strip : 0);
    return s.state === 'strip' ? metrics.strip : 0;
  };
  function stageWidth() {
    const parts = [extent('left'), extent('right')].filter(part => part > 0);
    return Math.max(0, width - 2 * padEnd - parts.reduce((sum, part) => sum + part, 0) - parts.length * gap);
  }
  for (const [side, to] of touch?.collapse ?? metrics.collapse?.width ?? []) {
    if (stageWidth() >= requirement()) break;
    fold(side, to, 'stage');
  }

  // Bottom dock: compress the rows, then fold to the header.
  const band = Math.min(env.measured?.band ?? chrome.band, height);
  const workspaceHeight = Math.max(0, height - band - dimension(env.footer));
  // The touch interface's timeline header is a finger's height (features/touch.css --control-2xl).
  const t = touch?.timelineHeader ? {...metrics.timeline, header: touch.timelineHeader} : metrics.timeline;
  const rowMetrics = t === metrics.timeline ? metrics : {...metrics, timeline: t};
  const bottomDocked = records.filter(record => record.dock === 'bottom');
  const bottomStrip = records.filter(record => record.dock === 'strip' && record.side === 'bottom');
  const bottom = {state: bottomDocked.length ? 'docked' : bottomStrip.length ? 'strip' : 'hidden', size: 0, span: entry.bottomSpan, reason: null};
  let bottomLimits = null;
  const portraitTimeline = touch && env.touch.orient === 'portrait' ? touch.portraitTimeline ?? null : null;
  const landscapeTimeline = touch && env.touch.orient === 'landscape' ? touch.landscapeTimeline ?? null : null;
  if (bottom.state === 'docked' && down.fold?.bottom === 'strip' && !portraitTimeline && !landscapeTimeline) Object.assign(bottom, {state: 'strip', reason: 'tier'});
  if (bottom.state === 'docked') {
    // Never shorter than the pinned rows plus the minimum content rows at this tier.
    const min = landscapeTimeline ?? Math.max(timelineHeightFor(t.minSlots, heightTier, rowMetrics), ...bottomDocked.map(record => describe(record).min ?? 0));
    const fraction = Math.min(...bottomDocked.map(record => describe(record).maxFraction ?? 1));
    const fallback = portraitTimeline ? Math.round(portraitTimeline * height) : landscapeTimeline ?? timelineDefaultHeight(height, heightTier, rowMetrics);
    const cap = down.timeline?.capAtDefault && !portraitTimeline && !landscapeTimeline ? fallback : Infinity;
    const room = workspaceHeight - padTop - padBottom - rowGap - head - stageMin.height;
    const max = Math.min(Math.floor(fraction * height), cap, room);
    let size = sizes.bottom ?? fallback;
    if (size > cap) { size = cap; bottom.reason = 'tier'; }
    if (size > room) { size = room; bottom.reason = 'stage'; }
    if (max < min) Object.assign(bottom, {state: 'strip', reason: 'stage'});
    else {
      bottom.size = Math.round(clamp(size, min, max));
      bottomLimits = {min, max};
    }
  }
  if (bottom.state === 'strip') bottom.size = t.header;
  bottom.size = Math.min(bottom.size, Math.max(0, workspaceHeight - padTop - padBottom - rowGap));
  bottom.body = bottom.state === 'docked' ? 'docked' : bottom.state === 'strip' ? 'sheet' : null;
  const mainHeight = Math.max(0, workspaceHeight - padTop - padBottom - (bottom.state === 'hidden' ? 0 : bottom.size + rowGap));
  const fullHeight = Math.max(0, workspaceHeight - padTop - padBottom);

  // Columns in visual order, inside the field's padding on both sides; the rail floats inside the stage.
  const railLeft = entry.rail !== 'right';
  const columns = [];
  if (sides.left.state === 'strip' || sides.left.strip.length) columns.push({key: 'left-strip', width: metrics.strip});
  if (sides.left.state === 'docked') columns.push({key: 'left', width: sides.left.size});
  columns.push({key: 'stage', width: stageWidth()});
  if (sides.right.state === 'docked') columns.push({key: 'right', width: sides.right.size});
  if (sides.right.state === 'strip' || sides.right.strip.length) columns.push({key: 'right-strip', width: metrics.strip});
  const rects = {band: rect(0, 0, width, band), workspace: rect(0, band, width, workspaceHeight)};
  let x = padEnd;
  for (const column of columns) {
    const tall = bottom.span === 'stage' && column.key !== 'stage';
    rects[column.key] = rect(x, band + padTop, column.width, tall ? fullHeight : mainHeight);
    x += column.width + gap;
  }
  const stage = rects.stage;
  const viewport = rect(stage.x, stage.y + Math.min(head, stage.height), stage.width, stage.height - head);
  // The floating tool bar: inside #viewport, `margin` from its edge on the rail's side, as tall as its tools need
  // (at most the viewport less its margins; the bar scrolls past that).
  const railMargin = touch?.railMargin ?? metrics.rail.margin ?? 0;
  const railHorizontal = Boolean(touch && env.touch.orient === 'portrait' && touch.portraitRail === 'horizontal');
  rects.rail = railHorizontal
    ? rect(viewport.x + railMargin, viewport.y + viewport.height - railMargin - railBase, Math.max(0, viewport.width - 2 * railMargin), railBase)
    : rect(railLeft ? viewport.x + railMargin : viewport.x + viewport.width - railMargin - railWidth,
      viewport.y + railMargin, railWidth, Math.max(0, viewport.height - 2 * railMargin));
  if (bottom.state !== 'hidden') {
    const spanned = bottom.span === 'stage' ? [stage] : columns.filter(column => column.key !== 'rail').map(column => rects[column.key]);
    const left = Math.min(...spanned.map(item => item.x)), right = Math.max(...spanned.map(item => item.x + item.width));
    bottom.rect = rect(left, band + padTop + mainHeight + rowGap, right - left, bottom.size);
  } else bottom.rect = null;

  // A docked region's islands by group: stacked on a side, side by side at the
  // bottom, sharing its extent by the arrangement's weights, none under islandMin.
  const islandsOf = (docked, area, weights, across) => {
    const groups = [];
    for (const record of docked) (groups[record.group ?? 0] ??= []).push(record);
    const list = groups.filter(Boolean);
    const available = Math.max(0, (across ? area.width : area.height) - (list.length - 1) * metrics.gutter);
    const shares = Array.isArray(weights) && weights.length === list.length ? weights : list.map(() => 1 / list.length);
    const least = Math.min(metrics.islandMin, Math.floor(available / list.length));
    let start = across ? area.x : area.y, used = 0;
    const islands = list.map((group, index) => {
      const later = list.length - 1 - index;
      const size = later ? Math.round(clamp(available * shares[index], least, available - used - later * least)) : available - used;
      const box = across ? rect(start, area.y, size, area.height) : rect(area.x, start, area.width, size);
      used += size;
      start += size + metrics.gutter;
      return {tabs: group.map(record => record.id), active: (group.find(record => record.active) ?? group[0]).id, rect: box};
    });
    const split = list.length === 2 ? {min: least, max: available - least, now: across ? islands[0].rect.width : islands[0].rect.height} : null;
    return {islands, split};
  };
  const requirementNow = requirement();
  const aria = {left: null, right: null, bottom: null, 'left-islands': null, 'right-islands': null, 'bottom-islands': null};
  const byOrder = (a, b) => a.order - b.order;
  const bottomIslands = bottom.state === 'docked' ? islandsOf(bottomDocked, bottom.rect, entry.weights?.bottom, true) : null;
  Object.assign(bottom, {
    groups: bottomIslands?.islands ?? [],
    panels: {
      docked: bottom.state === 'docked' ? bottomDocked.map(record => record.id) : [],
      strip: (bottom.state === 'strip' ? [...bottomDocked, ...bottomStrip].sort(byOrder) : bottomStrip).map(record => record.id),
      sheet: [],
    },
  });
  aria['bottom-islands'] = bottomIslands?.split ?? null;
  const regions = {bottom};
  for (const side of ['left', 'right']) {
    const s = sides[side];
    const docked = s.state === 'docked';
    const islands = docked ? islandsOf(s.docked, rects[side], entry.weights?.[side], false) : null;
    regions[side] = {
      state: s.state,
      size: docked ? s.size : 0,
      strip: s.state === 'strip' || s.strip.length ? metrics.strip : 0,
      sizeKey: docked ? s.sizeKey : null,
      reason: s.reason,
      rect: rects[side] ?? null,
      stripRect: rects[`${side}-strip`] ?? null,
      groups: islands?.islands ?? [],
      panels: {docked: s.docked.map(record => record.id), strip: s.strip.map(record => record.id), sheet: s.sheet.map(record => record.id)},
    };
    if (docked) aria[side] = {min: s.min, max: Math.round(clamp(s.size + stage.width - requirementNow, s.min, s.max)), now: s.size};
    aria[`${side}-islands`] = islands?.split ?? null;
  }
  if (bottomLimits) aria.bottom = {min: bottomLimits.min, max: bottomLimits.max, now: bottom.size};

  // Floating panels: kept inside #viewport (never over the band, the stage header or the transport).
  const floatSheet = folds.float === 'sheet';
  const floating = floatSheet ? [] : records.filter(record => record.dock === 'float')
    .map((record, index) => ({panel: record.id, ...clampFloating(record.rect, describe(record), stage, Math.min(head, stage.height), metrics, index)}));

  const panels = {};
  for (const descriptor of catalog) {
    const record = records.find(item => item.id === descriptor.id);
    if (!record) { panels[descriptor.id] = {presentation: 'unavailable', side: null, dock: null, group: 0, active: false, visible: false}; continue; }
    let presentation;
    if (record.dock === 'hidden') presentation = 'hidden';
    else if (record.dock === 'float') presentation = floatSheet ? 'sheet' : 'float';
    else if (record.side === 'bottom') presentation = record.dock === 'bottom' && bottom.state === 'docked' ? 'docked' : 'strip';
    else presentation = sides[record.side].sheet.includes(record) ? 'sheet' : sides[record.side].strip.includes(record) ? 'strip' : 'docked';
    const active = presentation === 'docked' && record.active === true;
    panels[descriptor.id] = {presentation, side: record.side, dock: record.dock, group: record.group ?? 0, active, visible: active || presentation === 'float'};
  }

  const stageInsets = stageInsetsFor(width, height, {tier, metrics});
  // At fit the artboard keeps 8px clear of the floating tool bar.
  const railSide = railHorizontal ? 'bottom' : railLeft ? 'left' : 'right';
  stageInsets[railSide] = Math.max(stageInsets[railSide], (railHorizontal ? railBase : railWidth) + railMargin + 8);
  const message = metrics.message, endWidth = env.endWidth ?? message.end;
  const messageSlot = {width: Math.max(0, across.message === 'inset'
    ? stage.width - 2 * message.inset
    : stage.width - 2 * (endWidth + message.gap))};
  const bodyRows = size => {
    const rows = down.timeline ?? metrics.height.tall.timeline;
    const body = size - t.header - rows.ruler;
    const pinned = clamp(Math.floor(body / t.pinnedRow), 0, t.pinned);
    return {pinned, content: Math.max(0, Math.floor((body - pinned * t.pinnedRow) / rows.row * 2) / 2)};
  };
  const solution = {
    mode, tier, height: heightTier, chrome: chrome.name, padTop, band: bandFolds, touch: touch ? env.touch.form : null,
    rail: {side: railLeft ? 'left' : 'right', orientation: railHorizontal ? 'horizontal' : 'vertical', compact: railCompact,
      columns: railHorizontal ? 1 : railColumns, width: railHorizontal ? rects.rail.width : railWidth, rect: rects.rail},
    regions, floating, stage, stageHead: Math.min(head, stage.height), viewport, stageInsets,
    timelineRows: bottom.state === 'docked' ? bodyRows(bottom.size) : {pinned: 0, content: 0},
    messageSlot, aria, panels,
    rects: {band: rects.band, workspace: rects.workspace, rail: rects.rail, stage, viewport},
  };
  if (env.artboard) solution.zoom = fitZoom(viewport, stageInsets, env.artboard);
  return solution;
}
