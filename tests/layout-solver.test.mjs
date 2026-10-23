/**
 * The layout solver (src/shell/layout-solver.mjs): tiers from each window
 * dimension, the band's measured width, docks, strips and sheets, the
 * timeline height, stage insets, floors and the #viewport guarantee.
 * Expected geometry is the reference build's (experience §1.2 and §1.9,
 * revision 4.3, and the 2026-09 redesign: the roomy chrome from 801px tall, the
 * stage header above #viewport, the vertical insets 16 and 8, and a default
 * timeline of Camera and Scene pinned at 24px plus 4½, 4 or 3 content slots).
 * Ports the constraint cases of tests/studio-layout.test.mjs and
 * tests/workspace-layout.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND_FOLDS, SHELL_METRICS, STAGE_FLOORS, fitZoom, heightTierFor, resolveTiers, solveLayout, stageFloor,
  stageInsetsFor, timelineDefaultHeight, widthTierFor,
} from '../src/shell/layout-solver.mjs';
import {
  applyPreset, defaultLayout, migrateLayout, movePanel, normalizeLayout, setSharedSize, toggleFocus,
} from '../src/shell/layout-schema.mjs';
import {PANEL_CATALOG, normalizePanelDescriptor} from '../src/shell/panel-registry.mjs';

const NOW = 1_700_000_100_000;
const ARTBOARD = {width: 960, height: 540};
const BAND_MIN = 626;   // the English Animate band with every fold step applied

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
const DEFAULT = deepFreeze(defaultLayout({now: NOW}));
const solve = (width, height, {layout = DEFAULT, mode = 'animate', ...env} = {}) => solveLayout(layout, {width, height, mode, bandMin: BAND_MIN, artboard: ARTBOARD, ...env});
const zoom = solution => Math.round(solution.zoom * 100);
const size = solution => `${solution.viewport.width}x${solution.viewport.height}`;
const usable = solution => solution.viewport.width >= 360 && solution.viewport.height >= 200;
/** A layout with one workspace's arrangement changed by `change(arrangement)`. */
const arranged = (mode, change, layout = DEFAULT) => normalizeLayout({...layout, modes: {...layout.modes, [mode]: {...layout.modes[mode], ...change(layout.modes[mode])}}}, {now: NOW});
const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const SWEEP_WIDTHS = [500, 540, 580, 601, 610, 620, 626, 640, 650, 660, 661, 680, 720, 800, 853, 900, 901, 911, 921, 940, 961, 962, 1000, 1024, 1100, 1180, 1181, 1280, 1366, 1367, 1440, 1600, 1920];
const SWEEP_HEIGHTS = [340, 370, 400, 440, 441, 450, 453, 480, 485, 500, 520, 540, 560, 568, 569, 580, 600, 620, 640, 641, 660, 700, 720, 749, 750, 768, 800, 900, 1080];

test('the reference geometry: tiers, timeline, #viewport and artboard zoom', () => {
  // [window, workspace, tiers, timeline, #viewport, zoom] from experience §1.2 (revision 4.3).
  const table = [
    ['1440x900', 'animate', 'wide/tall', 264, '1096x518', 90],
    ['1280x720', 'animate', 'regular/tall', 248, '960x368', 65],
    ['1152x720', 'animate', 'narrow/tall', 248, '872x368', 65],
    ['1100x700', 'animate', 'narrow/tall', 248, '820x348', 61],
    ['1024x700', 'animate', 'narrow/tall', 248, '744x348', 61],
    ['960x600', 'animate', 'narrow/short', 224, '680x272', 47],
    ['900x700', 'animate', 'narrow/tall', 248, '620x348', 56],
    ['800x600', 'animate', 'compact/short', 224, '784x272', 47],
    ['700x600', 'animate', 'compact/short', 224, '684x272', 47],
    ['1920x520', 'animate', 'wide/low', 40, '1576x384', 68],
    ['960x520', 'animate', 'narrow/low', 40, '680x384', 62],
    ['911x485', 'animate', 'narrow/low', 40, '631x349', 57],
    ['1000x450', 'animate', 'narrow/low', 40, '720x314', 55],
    ['853x453', 'animate', 'narrow/low', 40, '573x317', 51],
    ['823x514', 'animate', 'narrow/low', 40, '543x378', 48],
    ['640x480', 'animate', 'minimal/low', 40, '632x344', 58],
    ['601x441', 'animate', 'minimal/low', 40, '593x305', 54],
    ['500x340', 'animate', 'minimal/low', 40, '492x204', 35],
    ['1440x900', 'draw', 'wide/tall', 264, '1096x518', 90],
    // Build starts with Structure folded to its 40px strip.
    ['1440x900', 'rig', 'wide/tall', 0, '1048x788', 99],
    ['1024x700', 'rig', 'narrow/tall', 0, '696x602', 64],
    ['962x700', 'rig', 'narrow/tall', 0, '634x602', 57],
    ['900x700', 'rig', 'narrow/tall', 0, '572x602', 51],
    ['800x600', 'rig', 'compact/short', 0, '744x502', 69],
    ['500x340', 'rig', 'minimal/low', 0, '452x248', 39],
  ];
  for (const [window, mode, tiers, timeline, viewport, expected] of table) {
    const [width, height] = window.split('x').map(Number);
    const solution = solve(width, height, {mode});
    const label = `${window} ${mode}`;
    assert.equal(`${solution.tier}/${solution.height}`, tiers, label);
    assert.equal(solution.regions.bottom.size, timeline, label);
    assert.equal(size(solution), viewport, label);
    assert.equal(zoom(solution), expected, label);
    assert.ok(zoom(solution) >= stageFloor(width, height) || mode === 'rig', label);
    // The roomy chrome from 801px tall: a 44px stage header (40 in the compact chrome).
    const head = height >= 801 ? 44 : 40;
    assert.equal(solution.chrome, height >= 801 ? 'roomy' : 'compact', label);
    assert.equal(solution.stageHead, head, `${label}: the stage header sits above #viewport`);
    assert.equal(solution.viewport.y, solution.stage.y + head, label);
    assert.equal(solution.stage.height, solution.viewport.height + head, label);
  }
});

test('width and height tiers each come from their own dimension', () => {
  const widths = {1920: 'wide', 1367: 'wide', 1366: 'regular', 1181: 'regular', 1180: 'narrow', 900: 'narrow', 801: 'narrow', 800: 'compact', 661: 'compact', 660: 'minimal', 500: 'minimal'};
  for (const [width, tier] of Object.entries(widths)) assert.equal(widthTierFor(Number(width)), tier, width);
  const heights = {1080: 'tall', 641: 'tall', 640: 'short', 569: 'short', 568: 'low', 340: 'low'};
  for (const [height, tier] of Object.entries(heights)) assert.equal(heightTierFor(Number(height)), tier, height);
  // A short window keeps its docked inspector; a narrow tall one keeps its timeline body.
  const short = solve(1920, 520);
  assert.deepEqual([short.tier, short.height, short.regions.right.state, short.regions.bottom.state], ['wide', 'low', 'docked', 'strip']);
  const narrow = solve(800, 1080);
  assert.deepEqual([narrow.tier, narrow.height, narrow.regions.right.state, narrow.regions.bottom.state], ['compact', 'tall', 'sheet', 'docked']);
  assert.equal(narrow.regions.bottom.size, 264);
  // From 801px everything stays docked, as today's app keeps it (revision 4.1).
  const docked = solve(801, 700);
  assert.deepEqual([docked.tier, docked.regions.right.state, docked.regions.right.size], ['narrow', 'docked', 256]);
});

test('the band folds its labels and spacing before the menubar folds into the mark', () => {
  // A number is the band with every fold step applied: a band that needs 700px makes every width up to 723 minimal.
  for (const width of [661, 700, 723]) assert.equal(resolveTiers(width, 800, {bandMin: 700}).tier, 'minimal', width);
  assert.deepEqual(resolveTiers(724, 800, {bandMin: 700}), {tier: 'compact', height: 'tall', band: [], bandStep: false});
  assert.equal(resolveTiers(1000, 800, {bandMin: 700}).tier, 'narrow');
  assert.equal(resolveTiers(661, 800, {bandMin: BAND_MIN}).tier, 'compact');
  assert.equal(resolveTiers(649, 800, {bandMin: BAND_MIN}).tier, 'minimal');
  // Fold steps: the fewest that fit, in BAND_FOLDS order; steps a session lacks are skipped.
  const english = {none: 1020, state: 990, tight: 960, name: 930, name8: 900, savelabel: 860, save: 820, winctl: 800,
    switchtight: 780, icons: 720, dot: 700, redo: 676, primary: 650, minimal: {none: 560, state: 540, redo: 520, primary: 490}};
  assert.deepEqual(resolveTiers(1440, 800, {bandMin: english}).band, []);
  assert.deepEqual(resolveTiers(1044, 800, {bandMin: english}).band, []);
  assert.deepEqual(resolveTiers(1043, 800, {bandMin: english}).band, ['state']);
  assert.deepEqual(resolveTiers(900, 800, {bandMin: english}).band, ['state', 'tight', 'name', 'name8', 'savelabel']);
  const compact = resolveTiers(760, 800, {bandMin: english});
  assert.deepEqual([compact.tier, compact.band.at(-1)], ['compact', 'icons']);
  assert.ok(!compact.band.includes('testrig') && !compact.band.includes('export2'), 'steps the session lacks are skipped');
  // The primary's word folds last; only where even that does not fit does the menubar fold.
  assert.deepEqual(resolveTiers(674, 800, {bandMin: english}).band.slice(-2), ['redo', 'primary']);
  const folded = resolveTiers(673, 800, {bandMin: english});
  assert.deepEqual([folded.tier, folded.band, folded.bandStep], ['minimal', [], true]);
  assert.deepEqual(resolveTiers(560, 800, {bandMin: english}).band, ['state', 'redo']);
  assert.deepEqual(resolveTiers(400, 800, {bandMin: english}).band, ['state', 'redo', 'primary'], 'every step where nothing fits');
  assert.deepEqual(resolveTiers(640, 800, {bandMin: {none: 700}}).band, [], 'a minimal window without its own measure');
  assert.equal(BAND_FOLDS.at(-1), 'primary', 'the primary keeps its word longest');
  // The band never changes the height tier, and its steps reach the solution.
  const stepped = solve(700, 900, {bandMin: 700});
  assert.deepEqual([stepped.tier, stepped.height, stepped.rail.width], ['minimal', 'tall', 44]);
  assert.deepEqual(solve(900, 800, {bandMin: english}).band, ['state', 'tight', 'name', 'name8', 'savelabel']);
});

test('short windows keep the inspector at wide to narrow width and fold the timeline to its header', () => {
  for (const [width, height] of [[1920, 520], [960, 520], [911, 485], [1000, 450], [853, 453], [640, 480], [601, 441]]) {
    const solution = solve(width, height);
    const label = `${width}x${height}`;
    assert.equal(solution.height, 'low', label);
    assert.equal(solution.regions.bottom.state, 'strip', label);
    assert.equal(solution.regions.bottom.body, 'sheet', label);
    assert.equal(solution.regions.right.state, ['compact', 'minimal'].includes(solution.tier) ? 'sheet' : 'docked', label);
    assert.ok(usable(solution), label);
    assert.ok(zoom(solution) >= 45, label);
    assert.ok(solution.rail.compact, `${label}: 32px tools at the low tier`);
  }
});

test('heights between 569 and 640 show the short timeline before folding it', () => {
  // 600–640: four 28px content rows under a 24px ruler (224px); 569–599: three (196px).
  for (const [height, size, content] of [[569, 196, 3], [580, 196, 3], [599, 196, 3], [600, 224, 4], [620, 224, 4], [640, 224, 4]]) {
    for (const width of [601, 800, 1100, 1440]) {
      const solution = solve(width, height);
      assert.equal(solution.regions.bottom.state, 'docked');
      assert.equal(solution.regions.bottom.size, size, `${width}x${height}`);
      assert.deepEqual(solution.timelineRows, {pinned: 2, content}, `${width}x${height}`);
      assert.ok(zoom(solution) >= 45, `${width}x${height}: ${zoom(solution)}%`);
    }
  }
  // A tall timeline the user stored is the short timeline here, not left to starve the stage.
  const tall = setSharedSize(DEFAULT, 'bottom', 420, {now: NOW});
  const squeezed = solve(1440, 600, {layout: tall});
  assert.equal(squeezed.regions.bottom.size, 224);
  assert.equal(squeezed.regions.bottom.reason, 'tier');
  assert.ok(zoom(squeezed) >= 45);
  // At 568 and below the body opens as a sheet from the header.
  assert.equal(solve(1440, 568, {layout: tall}).regions.bottom.state, 'strip');
  // Where even the minimum body would leave #viewport under 200px, it folds; otherwise it is compressed.
  const lowThresholds = {width: {regular: 1366, narrow: 1180, compact: 800, minimal: 660}, height: {short: 300, low: 200}};
  const compressed = solveLayout(tall, {width: 1440, height: 500, mode: 'animate', tiers: lowThresholds});
  assert.equal(compressed.height, 'tall');
  assert.equal(compressed.regions.bottom.state, 'docked');
  assert.equal(compressed.regions.bottom.reason, 'stage');
  assert.equal(compressed.viewport.height, 200);
  assert.equal(solveLayout(tall, {width: 1440, height: 480, mode: 'animate', tiers: lowThresholds}).regions.bottom.state, 'strip', 'under its row minimum it folds');
  const folded = solveLayout(tall, {width: 1440, height: 360, mode: 'animate', tiers: lowThresholds});
  assert.equal(folded.regions.bottom.state, 'strip');
  assert.equal(folded.regions.bottom.reason, 'stage');
});

test('the artboard never drops under its floor at any swept size, and #viewport never under 360x200', () => {
  let sizes = 0;
  for (const mode of ['animate', 'draw', 'rig']) {
    for (const width of SWEEP_WIDTHS) {
      for (const height of SWEEP_HEIGHTS) {
        const solution = solve(width, height, {mode});
        const label = `${mode} ${width}x${height}`;
        assert.ok(usable(solution), `${label}: #viewport ${size(solution)}`);
        if (mode !== 'rig') assert.ok(zoom(solution) >= stageFloor(width, height), `${label}: ${zoom(solution)}% < ${stageFloor(width, height)}%`);
        sizes++;
      }
    }
  }
  assert.equal(sizes, 3 * 33 * 29);
  // The floors never decrease as a window grows in either dimension.
  for (const width of SWEEP_WIDTHS) {
    for (const height of SWEEP_HEIGHTS) {
      assert.ok(stageFloor(width + 1, height) >= stageFloor(width, height));
      assert.ok(stageFloor(width, height + 1) >= stageFloor(width, height));
    }
  }
  assert.equal(STAGE_FLOORS.length, 5);
  assert.equal(stageFloor(601, 569), 45);
  assert.equal(stageFloor(801, 600), 45, 'revision 4.1 dropped the 800x600 row');
});

test('floors hold for the default layout; the user\'s own sizes and docks may trade them, never #viewport 360x200', () => {
  // The default layout keeps every floor (swept above). A wide inspector, a tall timeline
  // (Tall timeline and Timing do so by design) or an extra dock is the user's trade.
  const cases = [
    ['right 360', setSharedSize(DEFAULT, 'right', 360, {now: NOW}), 850, 606],
    ['right 360', setSharedSize(DEFAULT, 'right', 360, {now: NOW}), 870, 700],
    ['timeline 400', setSharedSize(DEFAULT, 'bottom', 400, {now: NOW}), 1284, 725],
    ['Tall timeline', setSharedSize(DEFAULT, 'bottom', 432, {now: NOW}), 1280, 720],
    ['Library docked left', arranged('animate', entry => movePanel(entry, 'library', 'left', {mode: 'animate'})), 950, 700],
  ];
  for (const [name, layout, width, height] of cases) {
    const solution = solve(width, height, {layout});
    const label = `${name} at ${width}x${height}`;
    assert.ok(zoom(solve(width, height)) >= stageFloor(width, height), `${label}: the default layout`);
    assert.ok(zoom(solution) < stageFloor(width, height), label);
    assert.ok(usable(solution), label);
  }
});

test('#viewport keeps 360x200 in every preset and user arrangement', () => {
  const layouts = {
    default: DEFAULT,
    timing: applyPreset(DEFAULT, 'animate', 'timing', {now: NOW, workspaceHeight: 1036}),
    review: applyPreset(DEFAULT, 'animate', 'review', {now: NOW}),
    focus: toggleFocus(DEFAULT, 'animate', {now: NOW}),
    libraryLeft: arranged('animate', entry => movePanel(entry, 'library', 'left', {mode: 'animate'})),
    floating: arranged('animate', entry => movePanel(movePanel(entry, 'vfx', 'float', {mode: 'animate'}), 'library', 'float', {mode: 'animate'})),
    railRight: arranged('animate', entry => ({...entry, rail: 'right'})),
    underStage: arranged('animate', entry => ({...entry, bottomSpan: 'stage'})),
    maxSizes: normalizeLayout({...DEFAULT, shared: {sizes: {left: 420, right: 420, bottom: 4096, structure: 360}}}, {now: NOW}),
    buildTimeline: applyPreset(DEFAULT, 'rig', 'build-timeline', {now: NOW}),
    buildRightStructure: arranged('rig', entry => movePanel(entry, 'structure', 'right', {mode: 'rig'})),
  };
  layouts.maxLibraryLeft = arranged('animate', entry => movePanel(entry, 'library', 'left', {mode: 'animate'}), layouts.maxSizes);
  for (const [name, layout] of Object.entries(layouts)) {
    for (const mode of ['animate', 'rig']) {
      for (const width of SWEEP_WIDTHS) {
        for (const height of SWEEP_HEIGHTS) {
          const solution = solve(width, height, {layout, mode});
          assert.ok(usable(solution), `${name} ${mode} ${width}x${height}: ${size(solution)}`);
        }
      }
    }
  }
});

test('500x340: every region inside the window, a vertical rail and a usable stage', () => {
  for (const mode of ['animate', 'draw', 'rig']) {
    const solution = solve(500, 340, {mode});
    const window = {x: 0, y: 0, width: 500, height: 340};
    for (const [name, area] of Object.entries(solution.rects)) assert.ok(inside(area, window), `${mode} ${name}`);
    for (const side of ['left', 'right']) {
      for (const key of ['rect', 'stripRect']) if (solution.regions[side][key]) assert.ok(inside(solution.regions[side][key], window), `${mode} ${side} ${key}`);
    }
    if (solution.regions.bottom.rect) assert.ok(inside(solution.regions.bottom.rect, window), `${mode} bottom`);
    assert.equal(solution.rail.orientation, 'vertical');
    assert.equal(solution.rail.width, 44);
    assert.ok(usable(solution));
    assert.deepEqual(solution.stageInsets, {top: 8, right: 10, bottom: 8, left: 64});
  }
});

test('Build folds Structure by default; opened, it stays docked, narrowing to 200px, until #viewport would drop under 360px', () => {
  assert.equal(solve(1440, 900, {mode: 'rig'}).panels.structure.presentation, 'strip', 'Structure starts folded');
  const opened = arranged('rig', arrangement => ({panels: movePanel(arrangement, 'structure', 'left', {mode: 'rig'}).panels}));
  // [window, state, Structure width, #viewport width]: 232 down to 880px, then narrower down to 200 at 848.
  const cases = [[1440, 900, 'docked', 232, 856], [962, 700, 'docked', 232, 442], [961, 700, 'docked', 232, 441],
    [880, 700, 'docked', 232, 360], [879, 700, 'docked', 231, 360], [864, 700, 'docked', 216, 360], [900, 640, 'docked', 232, 380],
    [848, 700, 'docked', 200, 360], [847, 700, 'strip', 0, 519], [800, 600, 'strip', 0, 744], [640, 480, 'strip', 0, 592],
    [500, 340, 'strip', 0, 452]];
  for (const [width, height, state, left, viewport] of cases) {
    const solution = solve(width, height, {mode: 'rig', layout: opened});
    const label = `${width}x${height}`;
    assert.equal(solution.regions.left.state, state, label);
    assert.equal(solution.panels.structure.presentation, state, label);
    assert.ok(usable(solution), label);
    assert.equal(solution.viewport.width, viewport, label);
    if (state === 'docked') {
      assert.equal(solution.regions.left.sizeKey, 'structure');
      assert.equal(solution.regions.left.size, left, label);
    } else {
      assert.equal(solution.regions.left.strip, 40);
      assert.deepEqual(solution.regions.left.panels.strip, ['structure']);
    }
    assert.equal(solution.regions.bottom.state, 'hidden', 'Build hides the timeline by default');
    assert.equal(solution.panels.timeline.presentation, 'hidden');
  }
  assert.equal(solve(847, 700, {mode: 'rig', layout: opened}).regions.left.reason, 'stage');
  assert.equal(solve(800, 600, {mode: 'rig', layout: opened}).regions.left.reason, 'tier');
  // The stored Structure width sizes the left dock in Build, and its splitter reports it.
  const wide = setSharedSize(opened, 'structure', 300, {now: NOW});
  const build = solve(1440, 900, {mode: 'rig', layout: wide});
  assert.equal(build.regions.left.size, 300);
  assert.deepEqual(build.aria.left, {min: 200, max: 360, now: 300});
  assert.equal(solve(940, 700, {mode: 'rig', layout: wide}).regions.left.size, 292, 'a stored width narrows too');
  // Build + timeline spans Structure (once opened), the stage and the inspector.
  const withTimeline = solve(1440, 900, {mode: 'rig', layout: arranged('rig', arrangement => ({panels: movePanel(arrangement, 'structure', 'left', {mode: 'rig'}).panels}),
    applyPreset(DEFAULT, 'rig', 'build-timeline', {now: NOW}))});
  assert.equal(withTimeline.regions.bottom.size, 264);
  assert.equal(withTimeline.regions.bottom.rect.x, withTimeline.regions.left.rect.x);
  assert.equal(withTimeline.regions.bottom.rect.x + withTimeline.regions.bottom.rect.width, withTimeline.regions.right.rect.x + withTimeline.regions.right.rect.width);
});

test('a left dock the user added folds before the inspector', () => {
  const layout = arranged('animate', entry => movePanel(entry, 'library', 'left', {mode: 'animate'}));
  const wide = solve(1440, 900, {layout});
  assert.equal(wide.regions.left.state, 'docked');
  assert.equal(wide.regions.left.size, 256, 'the 232px default is raised to the Library minimum');
  assert.equal(wide.panels.library.visible, true);
  assert.equal(wide.panels.properties.visible, true, 'Library docked left keeps Properties visible');
  const big = normalizeLayout({...layout, shared: {sizes: {left: 420, right: 360}}}, {now: NOW});
  const narrow = solve(1000, 700, {layout: big});
  assert.equal(narrow.regions.left.state, 'strip', 'the left dock folds first');
  assert.equal(narrow.regions.left.reason, 'stage');
  assert.equal(narrow.regions.right.state, 'docked', 'the inspector stays');
  assert.equal(narrow.panels.library.presentation, 'strip');
  assert.ok(narrow.viewport.width >= 360);
  const compact = solve(800, 600, {layout});
  assert.deepEqual([compact.regions.left.state, compact.regions.right.state], ['strip', 'sheet']);
  assert.deepEqual([compact.panels.library.presentation, compact.panels.properties.presentation], ['strip', 'sheet']);
});

test('floating panels stay inside #viewport, never over the band, the stage header or the timeline', () => {
  const layout = arranged('animate', entry => movePanel(
    movePanel(entry, 'vfx', 'float', {mode: 'animate', rect: {x: 4000, y: -300, w: 900, h: 2000}}),
    'library', 'float', {mode: 'animate'}));
  for (const [width, height] of [[1440, 900], [1280, 720], [1024, 700], [1920, 520], [1000, 450]]) {
    const solution = solve(width, height, {layout});
    const label = `${width}x${height}`;
    assert.equal(solution.floating.length, 2, label);
    const viewport = {x: 0, y: solution.stageHead, width: solution.viewport.width, height: solution.viewport.height};
    for (const panel of solution.floating) {
      const area = {x: panel.x, y: panel.y, width: panel.w, height: panel.h};
      assert.ok(inside(area, viewport), `${label} ${panel.panel}`);
      const absolute = {...area, x: area.x + solution.stage.x, y: area.y + solution.stage.y};
      assert.ok(!overlaps(absolute, solution.rects.band), `${label}: over the band`);
      if (solution.regions.bottom.rect) assert.ok(!overlaps(absolute, solution.regions.bottom.rect), `${label}: over the transport`);
    }
    assert.equal(solution.panels.vfx.presentation, 'float');
    assert.equal(solution.panels.vfx.visible, true);
    assert.equal(solution.panels.properties.visible, true, 'VFX floating keeps Properties visible');
    assert.deepEqual(solution.regions.right.groups.map(group => group.tabs), [['properties']]);
  }
  // The stored rect is clamped, never rewritten.
  const stored = layout.modes.animate.panels.find(record => record.id === 'vfx').rect;
  assert.deepEqual(stored, {x: 4000, y: -300, w: 900, h: 2000});
  const placed = solve(1440, 900, {layout}).floating;
  assert.notDeepEqual(placed[0], placed[1], 'panels without a stored place do not stack exactly');
  // Compact and minimal widths open floating panels as sheets.
  const compact = solve(800, 600, {layout});
  assert.deepEqual(compact.floating, []);
  assert.equal(compact.panels.vfx.presentation, 'sheet');
});

test('the default timeline height depends on the window only', () => {
  // Camera and Scene pinned at 24px, then 4½ content slots above 800px, 4 from 600px, 3 below.
  assert.equal(timelineDefaultHeight(900), 264);
  assert.equal(timelineDefaultHeight(801), 264);
  assert.equal(timelineDefaultHeight(800), 248);
  assert.equal(timelineDefaultHeight(720), 248);
  assert.equal(timelineDefaultHeight(641), 248);
  assert.equal(timelineDefaultHeight(640), 224, 'the short tier: a 24px ruler and 28px rows');
  assert.equal(timelineDefaultHeight(600), 224);
  assert.equal(timelineDefaultHeight(599), 196);
  assert.equal(timelineDefaultHeight(569), 196);
  assert.equal(timelineDefaultHeight(568), 40);
  assert.equal(timelineDefaultHeight(2160), 264, '4½ content slots at most');
  const reference = solve(1440, 900);
  const variants = [
    solve(1440, 900, {mode: 'draw'}),
    solve(1440, 900, {timelineMode: 'simple'}),
    solve(1440, 900, {layout: arranged('animate', entry => ({...entry, panels: entry.panels.map(record => record.id === 'vfx' ? {...record, active: true} : record.id === 'properties' ? {...record, active: false} : record)}))}),
    solve(1440, 900, {mode: 'rig', layout: applyPreset(DEFAULT, 'rig', 'build-timeline', {now: NOW})}),
  ];
  for (const variant of variants) {
    assert.equal(variant.regions.bottom.size, reference.regions.bottom.size);
    assert.deepEqual(variant.timelineRows, {pinned: 2, content: 4.5});
  }
  assert.deepEqual(variants[0].stage, reference.stage, 'a workspace switch never moves the stage');
  assert.deepEqual(variants[2].stage, reference.stage, 'a tab switch never moves the stage');
});

test('a stored timeline height is the user\'s, from its row minimum to 60% of the window', () => {
  const at = (value, width = 1440, height = 900) => solve(width, height, {layout: setSharedSize(DEFAULT, 'bottom', value, {now: NOW})});
  assert.equal(at(300).regions.bottom.size, 300);
  assert.equal(at(1000).regions.bottom.size, 540, '60% of 900');
  assert.deepEqual(at(300).aria.bottom, {min: 184, max: 540, now: 300});
  assert.deepEqual(at(300).timelineRows, {pinned: 2, content: 5.5});
  assert.deepEqual(solve(1440, 900).aria.bottom, {min: 184, max: 540, now: 264});
  assert.deepEqual(solve(1440, 600).aria.bottom, {min: 168, max: 224, now: 224});
  assert.equal(solve(1440, 520).aria.bottom, null, 'no splitter while the timeline is its header');
  // The rule: a docked timeline always shows Camera, Scene and two content rows (32px
  // under a 32px ruler when tall, 28px under 24px when short), so no height hides the
  // pinned rows or every layer.
  assert.equal(normalizeLayout({shared: {sizes: {bottom: 120}}}, {now: NOW}).shared.sizes.bottom, 168, 'stored sizes start at 168');
  for (const [height, size] of [[900, 184], [1080, 184], [640, 168], [600, 168]]) {
    const solution = at(168, 1440, height);
    assert.equal(solution.regions.bottom.size, size, `${height}`);
    assert.deepEqual(solution.timelineRows, {pinned: 2, content: 2}, `${height}`);
    assert.equal(solution.aria.bottom.min, size);
  }
});

test('stage insets follow the width tier across and the height tier down', () => {
  // Clearance across: 28 wide and regular, 20 narrow and compact, 10 minimal; down: 16 above 800px tall, 8 below.
  // On the rail's side the artboard also keeps 8px clear of the floating tool bar (12 + 52, or 12 + 44 with the
  // 32px tools of the compact chrome under 801px tall).
  const insets = (width, height) => solve(width, height).stageInsets;
  assert.deepEqual(insets(1440, 900), {top: 16, right: 28, bottom: 16, left: 72});
  assert.deepEqual(insets(1440, 801), {top: 16, right: 28, bottom: 16, left: 72});
  assert.deepEqual(insets(1280, 720), {top: 8, right: 28, bottom: 8, left: 64});
  assert.deepEqual(insets(1024, 700), {top: 8, right: 20, bottom: 8, left: 64});
  assert.deepEqual(insets(800, 700), {top: 8, right: 20, bottom: 8, left: 64});
  assert.deepEqual(insets(800, 600), {top: 8, right: 20, bottom: 8, left: 64});
  assert.deepEqual(insets(1440, 520), {top: 8, right: 28, bottom: 8, left: 64});
  assert.deepEqual(insets(640, 480), {top: 8, right: 10, bottom: 8, left: 64});
  assert.deepEqual(stageInsetsFor(1440, 900), {top: 16, right: 28, bottom: 16, left: 28}, 'the clearance alone, before the tool bar');
  const right = solve(1440, 900, {layout: arranged('animate', entry => ({...entry, rail: 'right'}))});
  assert.deepEqual(right.stageInsets, {top: 16, right: 72, bottom: 16, left: 28}, "the tool bar's side follows the rail");
  // The artboard zoom follows the §3.11.8 formula on #viewport.
  const solution = solve(1280, 720);
  assert.equal(solution.zoom, fitZoom(solution.viewport, solution.stageInsets, ARTBOARD));
  assert.equal(fitZoom({width: 5000, height: 5000}, {top: 0, right: 0, bottom: 0, left: 0}, ARTBOARD), 2);
  assert.equal(fitZoom({width: 10, height: 10}, {top: 40, right: 28, bottom: 52, left: 28}, ARTBOARD), 0);
});

test('the message slot never reaches the stage header\'s end cluster from 801px', () => {
  const {message} = SHELL_METRICS;
  for (const width of [1920, 1440, 1280, 1024, 801]) {
    const solution = solve(width, 800);
    assert.equal(solution.messageSlot.width, solution.stage.width - 2 * (message.end + message.gap));
    // Centred, the slot keeps the end cluster's width plus 12px free on both sides.
    assert.ok((solution.stage.width - solution.messageSlot.width) / 2 >= message.end + message.gap);
  }
  assert.equal(solve(1440, 800, {endWidth: 120}).messageSlot.width, 1096 - 2 * (120 + 12), 'the measured end cluster');
  for (const width of [800, 640, 500]) {
    const solution = solve(width, 800);
    assert.equal(solution.messageSlot.width, solution.stage.width - 16, 'compact and minimal: the slot spans the inset');
  }
});

test('the rail floats inside #viewport in every workspace and can move to the right', () => {
  // The tool bar floats 12px inside #viewport's top corner on its side, beside the canvas in every workspace
  // (right of Structure in Build), and scrolls past the viewport's height less its margins.
  for (const [width, height] of [[1440, 900], [800, 600], [500, 340], [1920, 520]]) {
    for (const mode of ['animate', 'draw', 'rig']) {
      const solution = solve(width, height, {mode}), rail = solution.rail.rect, viewport = solution.viewport, label = `${width}x${height} ${mode}`;
      assert.deepEqual([rail.x, rail.y], [viewport.x + 12, viewport.y + 12], label);
      assert.equal(rail.width, solution.rail.compact ? 44 : 52, label);
      assert.equal(rail.height, viewport.height - 24, label);
      assert.ok(inside(rail, viewport), label);
    }
  }
  const right = solve(1440, 900, {layout: arranged('animate', entry => ({...entry, rail: 'right'}))});
  assert.equal(right.rail.side, 'right');
  assert.equal(right.rail.rect.x + right.rail.rect.width, right.viewport.x + right.viewport.width - 12);
  assert.equal(right.stage.x, 8, "the islands keep the field's padding on both sides");
  assert.deepEqual([right.viewport.width, right.viewport.height], [1096, 518]);
});

test('a footer under the workspace takes its room from the workspace, never from the tiers', () => {
  // The status bar (24px until it becomes the hidden activity log) sits under the workspace.
  const plain = solve(1440, 900), footed = solve(1440, 900, {footer: 24});
  assert.deepEqual([footed.tier, footed.height], [plain.tier, plain.height]);
  assert.equal(footed.regions.bottom.size, plain.regions.bottom.size, 'the default timeline follows the window height');
  assert.equal(footed.viewport.height, plain.viewport.height - 24);
  assert.equal(footed.rects.workspace.height, 900 - 52 - 24);
  assert.equal(footed.regions.bottom.rect.y + footed.regions.bottom.rect.height, 900 - 24 - 8);
  // Where the timeline would starve #viewport, the footer folds it sooner, never #viewport.
  const tight = solve(1440, 600, {footer: 24});
  assert.ok(tight.viewport.height >= 200);
  assert.equal(solve(1440, 340, {footer: 24}).regions.bottom.state, 'strip');
});

test('Under stage lets the right dock run full height', () => {
  const layout = arranged('animate', entry => ({...entry, bottomSpan: 'stage'}));
  const solution = solve(1440, 900, {layout});
  assert.equal(solution.regions.bottom.span, 'stage');
  assert.equal(solution.regions.bottom.rect.x, solution.stage.x);
  assert.equal(solution.regions.bottom.rect.width, solution.stage.width);
  assert.equal(solution.regions.right.rect.height, 900 - 52 - 8 - 8, 'the band, then the field above and below the islands');
  assert.equal(solution.viewport.height, 518);
  const full = solve(1440, 900);
  assert.equal(full.regions.bottom.rect.width, full.stage.width + 8 + full.regions.right.size);
});

test('Timing, Review and Focus fold panels to strips and hide them', () => {
  const timing = solve(1440, 900, {layout: applyPreset(DEFAULT, 'animate', 'timing', {now: NOW, workspaceHeight: 848})});
  assert.equal(timing.regions.bottom.size, 339);
  assert.equal(timing.regions.right.state, 'docked');
  assert.equal(timing.regions.right.strip, 40, 'VFX and Library wait in a strip beside Properties');
  assert.deepEqual(timing.regions.right.panels.strip, ['vfx', 'library']);
  assert.equal(timing.stage.width, 1440 - 8 - 320 - 8 - 40 - 8 - 8);
  const review = solve(1440, 900, {layout: applyPreset(DEFAULT, 'animate', 'review', {now: NOW})});
  assert.equal(review.regions.right.state, 'hidden');
  assert.equal(review.regions.bottom.state, 'strip');
  assert.equal(review.panels.properties.presentation, 'hidden');
  assert.equal(review.stage.width, 1440 - 8 - 8);
  const focus = solve(1440, 900, {layout: toggleFocus(DEFAULT, 'animate', {now: NOW})});
  assert.deepEqual([focus.regions.right.state, focus.regions.bottom.state], ['strip', 'strip']);
  assert.deepEqual(Object.values(focus.panels).filter(panel => panel.visible), []);
});

test('splitter bounds stay ordered and keep the stage minimum', () => {
  const layouts = [DEFAULT, arranged('animate', entry => movePanel(entry, 'library', 'left', {mode: 'animate'})), setSharedSize(DEFAULT, 'right', 999, {now: NOW})];
  for (const layout of layouts) {
    for (const width of SWEEP_WIDTHS) {
      for (const height of [480, 600, 700, 900]) {
        const solution = solve(width, height, {layout});
        for (const [name, bounds] of Object.entries(solution.aria)) {
          if (!bounds) continue;
          assert.ok(bounds.min <= bounds.now && bounds.now <= bounds.max, `${width}x${height} ${name} ${JSON.stringify(bounds)}`);
          if (name === 'left' || name === 'right') assert.ok(solution.stage.width + bounds.now - bounds.max >= 360 || bounds.max === bounds.min, `${width}x${height} ${name}`);
        }
      }
    }
  }
  assert.deepEqual(solve(1440, 900).aria.right, {min: 256, max: 420, now: 320});
  assert.equal(solve(1440, 900).aria.left, null);
});

test('panels report their presentation and visibility for the registry', () => {
  const animate = solve(1440, 900);
  assert.deepEqual(Object.fromEntries(Object.entries(animate.panels).map(([id, panel]) => [id, [panel.presentation, panel.visible]])), {
    properties: ['docked', true], vfx: ['docked', false], library: ['docked', false], structure: ['unavailable', false], timeline: ['docked', true],
  });
  assert.deepEqual(animate.regions.right.groups.map(group => [group.tabs, group.active]), [[['properties', 'vfx', 'library'], 'properties']]);
  assert.deepEqual(animate.regions.right.groups[0].rect, animate.regions.right.rect);
  const low = solve(1440, 520);
  assert.deepEqual([low.panels.timeline.presentation, low.panels.timeline.visible], ['strip', false]);
});

test('two islands on a side share its height by their weights, each at least islandMin', () => {
  const stack = weights => arranged('animate', entry => ({...entry, weights: {right: weights},
    panels: entry.panels.map(record => (record.id === 'library' ? {...record, group: 1} : record))}));
  const solution = solve(1440, 900, {layout: stack([0.75, 0.25])});
  const islands = solution.regions.right.groups;
  assert.deepEqual(islands.map(island => island.tabs), [['properties', 'vfx'], ['library']]);
  assert.equal(islands[0].rect.height + 6 + islands[1].rect.height, 562);
  assert.equal(islands[0].rect.height, Math.round(556 * 0.75));
  assert.deepEqual(solution.aria['right-islands'], {min: 120, max: 436, now: 417});
  assert.equal(solution.aria['left-islands'], null);
  // Swapping VFX and Library between the islands keeps the islands' heights.
  const swapped = arranged('animate', entry => movePanel(movePanel(entry, 'vfx', 'right', {mode: 'animate', group: 1}), 'library', 'right', {mode: 'animate', group: 0}), stack([0.75, 0.25]));
  assert.deepEqual(solve(1440, 900, {layout: swapped}).regions.right.groups.map(island => [island.tabs, island.rect.height]), [[['properties', 'library'], 417], [['vfx'], 139]]);
  // No island is squeezed under islandMin; in a tiny region they share it equally.
  assert.deepEqual(solve(1440, 900, {layout: stack([0.95, 0.05])}).regions.right.groups.map(island => island.rect.height), [436, 120]);
  const short = solve(1440, 380, {layout: stack([0.95, 0.05])});
  const heights = short.regions.right.groups.map(island => island.rect.height);
  assert.equal(heights[0] + 6 + heights[1], short.regions.right.rect.height);
  assert.ok(Math.min(...heights) >= Math.min(120, Math.floor((short.regions.right.rect.height - 6) / 2)));
});

test('the bottom region hosts islands and tabs like the sides', () => {
  const catalog = [...PANEL_CATALOG, normalizePanelDescriptor({id: 'audio', docks: ['bottom'], min: 120})];
  const layout = normalizeLayout({modes: {animate: {preset: 'animate', panels: [...DEFAULT.modes.animate.panels, {id: 'audio', dock: 'bottom', order: 1}]}}}, {catalog, now: NOW});
  const tabs = solveLayout(layout, {width: 1440, height: 900, mode: 'animate', panels: catalog});
  assert.deepEqual(tabs.regions.bottom.groups.map(group => [group.tabs, group.active]), [[['timeline', 'audio'], 'timeline']]);
  assert.deepEqual(tabs.regions.bottom.groups[0].rect, tabs.regions.bottom.rect);
  assert.deepEqual(tabs.regions.bottom.panels, {docked: ['timeline', 'audio'], strip: [], sheet: []});
  assert.deepEqual([tabs.panels.timeline.visible, tabs.panels.audio.visible, tabs.panels.audio.presentation], [true, false, 'docked']);
  // Two islands sit side by side.
  const split = normalizeLayout({...layout, modes: {animate: {...layout.modes.animate, weights: {bottom: [0.6, 0.4]},
    panels: layout.modes.animate.panels.map(record => (record.id === 'audio' ? {...record, group: 1} : record))}}}, {catalog, now: NOW});
  const side = solveLayout(split, {width: 1440, height: 900, mode: 'animate', panels: catalog});
  const [left, right] = side.regions.bottom.groups;
  assert.deepEqual([left.tabs, right.tabs], [['timeline'], ['audio']]);
  assert.equal(left.rect.y, right.rect.y);
  assert.equal(left.rect.width + 6 + right.rect.width, side.regions.bottom.rect.width);
  assert.equal(right.rect.x, left.rect.x + left.rect.width + 6);
  assert.equal(left.rect.width, Math.round((side.regions.bottom.rect.width - 6) * 0.6));
  assert.equal(side.aria['bottom-islands'].now, left.rect.width);
  assert.deepEqual([side.panels.timeline.visible, side.panels.audio.visible], [true, true]);
  // Folded at the low tier, every bottom panel waits in the header strip.
  const low = solveLayout(split, {width: 1440, height: 500, mode: 'animate', panels: catalog});
  assert.deepEqual(low.regions.bottom.panels, {docked: [], strip: ['timeline', 'audio'], sheet: []});
  assert.deepEqual(low.regions.bottom.groups, []);
});

test('records this version only keeps never reach the solution', () => {
  const layout = normalizeLayout({modes: {animate: {preset: 'animate', panels: [
    {id: 'properties', dock: 'right', order: 0},
    {id: 'vfx', dock: 'top', side: 'top', order: 0},
    {id: 'structure', dock: 'left', order: 0},
    {id: 'mixer', dock: 'left', order: 0},
  ]}}}, {now: NOW});
  const solution = solve(1440, 900, {layout});
  assert.equal(solution.regions.left.state, 'hidden', 'Structure outside Build and an unknown panel dock nothing');
  assert.deepEqual(solution.regions.right.groups.map(group => group.tabs), [['properties', 'library', 'vfx']]);
  assert.deepEqual([solution.panels.vfx.presentation, solution.panels.vfx.side], ['docked', 'right']);
  assert.equal(solution.panels.structure.presentation, 'unavailable');
  assert.equal('mixer' in solution.panels, false);
});

// Ported from tests/studio-layout.test.mjs and tests/workspace-layout.test.mjs.

test('old sidebar and floating preferences cannot consume the stage', () => {
  const {layout} = migrateLayout({left: 420, floating: {left: {width: 600}}}, {now: NOW});
  const solution = solveLayout(layout, {width: 1280, height: 652, mode: 'animate'});
  assert.equal(solution.regions.left.state, 'hidden');
  assert.equal(solution.regions.right.size, 296);
  assert.ok(solution.stage.width >= 900);
});

test('oversized saved panels still leave an editable stage at laptop sizes', () => {
  const {layout} = migrateLayout({studioVersion: 1, right: 99999, timeline: 99999}, {now: NOW});
  for (const [width, height] of [[1024, 700], [1280, 652], [1440, 832]]) {
    const solution = solveLayout(layout, {width, height, mode: 'animate'});
    assert.ok(width - solution.regions.right.size >= 600, `${width}x${height}`);
    assert.ok(solution.viewport.width >= 580 && solution.viewport.height >= 200, `${width}x${height}`);
    assert.ok(solution.regions.bottom.size >= 200);
    assert.ok(solution.regions.bottom.size <= 0.6 * height);
    assert.ok(solution.regions.right.size <= 420);
  }
  const workspace = migrateLayout({left: 420, right: 420, timeline: 800}, {now: NOW}).layout;
  const libraryLeft = arranged('animate', entry => movePanel(entry, 'library', 'left', {mode: 'animate'}), workspace);
  const solution = solveLayout(libraryLeft, {width: 1100, height: 660, mode: 'animate'});
  assert.ok(usable(solution));
  assert.ok(solution.regions.bottom.size <= 0.6 * 660);
});

test('invalid layouts solve to the default layout', () => {
  const reference = solveLayout(DEFAULT, {width: 1280, height: 652, mode: 'animate'});
  for (const value of [null, undefined, 'invalid', 7, [], {modes: 'x'}, {shared: {sizes: {right: 'bad', bottom: 'bad'}}}]) {
    assert.deepEqual(solveLayout(value, {width: 1280, height: 652, mode: 'animate'}), reference, JSON.stringify(value));
  }
  assert.deepEqual(solveLayout(DEFAULT, {width: 1280, height: 652, mode: 'studio'}), reference, 'an unknown workspace is Animate');
});

test('fitting into a small window never changes the saved layout', () => {
  const saved = deepFreeze(normalizeLayout({shared: {sizes: {right: 340, bottom: 440}}}, {now: NOW}));
  const copy = structuredClone(saved);
  const small = solveLayout(saved, {width: 760, height: 520, mode: 'animate'});
  assert.equal(small.regions.right.state, 'sheet');
  assert.equal(small.regions.bottom.state, 'strip');
  const large = solveLayout(saved, {width: 1600, height: 1000, mode: 'animate'});
  assert.equal(large.regions.right.size, 340);
  assert.equal(large.regions.bottom.size, 440);
  assert.deepEqual(saved, copy);
});

test('impossible small windows never produce negative or overflowing sizes', () => {
  for (const width of [0, 100, 320, 600, 800, 960, 1100, 1560]) {
    for (const height of [0, 60, 150]) {
      const solution = solveLayout(DEFAULT, {width, height, mode: 'animate'});
      for (const area of [...Object.values(solution.rects), solution.viewport, solution.regions.bottom.rect].filter(Boolean)) {
        assert.ok(area.width >= 0 && area.height >= 0, `${width}x${height}`);
      }
      assert.ok(solution.stage.x + solution.stage.width <= Math.max(width, solution.rail.width), `${width}x${height}`);
      assert.ok(solution.messageSlot.width >= 0);
    }
  }
  const nan = solveLayout(DEFAULT, {width: NaN, height: -5, mode: 'animate'});
  assert.deepEqual([nan.stage.width, nan.stage.height, nan.viewport.width, nan.viewport.height], [0, 0, 0, 0]);
});
