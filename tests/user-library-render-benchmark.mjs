const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = async source => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const readSource = async url => {
  const response = await fetch(url, {cache: 'no-store'});
  assert(response.ok, `Could not read benchmark source: ${url}`);
  return response.text();
};
// Serve the frozen owner with its relative imports rewritten to /src/. Keeping
// both owners on this origin also preserves the application's script policy.
const importSource = async url => (await import(url)).UserLibrary;
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return {median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, min: sorted[0], max: sorted.at(-1)};
};

/** Production UserLibrary.render(), including filtering, translation binding,
 * card insertion and selection. The root agent coordinates the timing slot. */
export async function benchmarkUserLibraryRender({
  baselineUrl = '/artifacts/performance-improvements/control/user-library-before.mjs', baselineReference = '35ebad9b',
  count = 1000, samples = 5, warmups = 1, localization = globalThis.styk?.localization,
} = {}) {
  assert(localization?.stats, 'An initialized AppLocalization is required.');
  assert(Number.isInteger(count) && count > 0 && Number.isInteger(samples) && samples > 0 && Number.isInteger(warmups) && warmups >= 0, 'Use positive item/sample counts and nonnegative warmups.');
  const sourceUrls = {baseline: new URL(baselineUrl, location.href).href, current: new URL('/src/user-library.mjs', location.href).href};
  const before = Object.fromEntries(await Promise.all(Object.entries(sourceUrls).map(async ([name, url]) => [name, await readSource(url)])));
  const classes = Object.fromEntries(await Promise.all(Object.entries(sourceUrls).map(async ([name, url]) => [name, await importSource(url)])));
  const sourceHashesBefore = Object.fromEntries(await Promise.all(Object.entries(before).map(async ([name, source]) => [name, await digest(source)])));
  const host = document.createElement('section');
  host.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:700px;z-index:2147483000;display:flex;flex-direction:column;background:var(--surface);color:var(--text-1);font:var(--type-ui);';
  host.innerHTML = '<div class="library-head"><nav></nav><input type="search"><span class="library-count"></span></div><div class="library-content"><div class="library-grid" role="listbox"></div><div class="library-empty" hidden></div></div>';
  const entries = Array.from({length: count}, (_, index) => ({path: `Asset-${index}.stkz`, name: `Asset ${index}`, kind: index % 7 === 0 ? 'set' : 'figure', modified: 1}));
  const categories = [{id: 'effects', name: 'Effects'}, {id: 'props', name: 'Props'}, {id: 'characters', name: 'Characters'}];
  const publicCatalog = {categories, items: Array.from({length: count}, (_, index) => ({id: `asset${String(index).padStart(5, '0')}`, name: `Asset ${index}`, kind: index % 7 === 0 ? 'movieclip' : 'figure', category: categories[index % categories.length].id, description: 'Editable artwork', author: 'Kim', tags: ['paper', 'shared'], sha256: String(index)}))};
  const owners = Object.fromEntries(Object.entries(classes).map(([name, Library]) => [name, Object.assign(Object.create(Library.prototype), {
    source: 'mine', folder: '', entries, publicCatalog, publicState: 'ready', filterValue: 'all', selected: entries[Math.floor(count / 2)].path, publicSelected: publicCatalog.items[Math.floor(count / 2)].id,
    input: host.querySelector('input'), container: host, grid: host.querySelector('.library-grid'), empty: host.querySelector('.library-empty'), editor: {selectedObjects: []},
    generation: 1, busy: false, menu: null, hoverPreview: {stop() {}}, observer: {observe() {}, disconnect() {}}, cards: [], cardsByKey: new Map(), selectedCard: null, tabStopCard: null,
  })]));
  const scenarios = [{name: 'mine-all', source: 'mine', query: ''}, {name: 'public-all', source: 'public', query: ''}, {name: 'public-cached-search', source: 'public', query: 'paper'}];
  const rows = [], locale = localization.localization.locale;
  document.body.append(host);
  try {
    for (const scenario of scenarios) {
      const timings = {baseline: [], current: []};
      for (const owner of Object.values(owners)) {owner.source = scenario.source; owner.filterValue = 'all';}
      const run = name => {
        const owner = owners[name]; owner.input.value = scenario.query;
        const applications = localization.stats.applications, start = performance.now();
        owner.render(); const rendered = performance.now();
        const bounds = owner.grid.getBoundingClientRect(), end = performance.now();
        const measured = {renderMs: rendered - start, layoutFlushMs: end - rendered, totalMs: end - start, translationApplications: localization.stats.applications - applications, gridHeight: bounds.height};
        // Complete serialized output and counts are checked outside the clock.
        return {measured, markup: host.innerHTML};
      };
      let parity = true, renderedCards = 0, markupHash;
      for (let sample = -warmups; sample < samples; sample++) {
        const order = (sample + warmups) % 2 ? ['current', 'baseline'] : ['baseline', 'current'], outputs = {};
        for (const name of order) outputs[name] = run(name);
        parity &&= outputs.baseline.markup === outputs.current.markup;
        assert(parity, `Complete rendered markup differs for ${scenario.name}.`);
        if (sample >= 0) for (const name of order) timings[name].push(outputs[name].measured);
        renderedCards = host.querySelectorAll('.library-card').length;
        markupHash = await digest(outputs.current.markup);
        // Let browser rendering/other app work finish outside the measured run.
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const metrics = Object.fromEntries(Object.entries(timings).map(([name, measurements]) => [name, Object.fromEntries(['renderMs', 'layoutFlushMs', 'totalMs', 'translationApplications'].map(metric => [metric, summary(measurements.map(measurement => measurement[metric]))]))]));
      rows.push({scenario: scenario.name, inputCards: count, renderedCards, completeMarkupParity: parity, markupSha256: markupHash, samples: timings, summary: metrics, renderSpeedup: metrics.baseline.renderMs.median / metrics.current.renderMs.median, totalSpeedup: metrics.baseline.totalMs.median / metrics.current.totalMs.median});
    }
  } finally {host.remove(); localization.prune();}
  const after = Object.fromEntries(await Promise.all(Object.entries(sourceUrls).map(async ([name, url]) => [name, await readSource(url)])));
  const sourceHashesAfter = Object.fromEntries(await Promise.all(Object.entries(after).map(async ([name, source]) => [name, await digest(source)])));
  const changedSources = Object.keys(sourceUrls).filter(name => sourceHashesBefore[name] !== sourceHashesAfter[name]);
  assert(changedSources.length === 0, `Benchmark owner source changed during measurement: ${changedSources.join(', ')}`);
  return {
    benchmark: 'production-UserLibrary.render', baselineReference, sourceUrls, sourceHashesBefore, sourceHashesAfter, changedSources,
    userAgent: navigator.userAgent, locale, samples, warmups, host: {width: 360, height: 700, connected: true, styledGrid: true}, rows,
    scope: 'Synchronous production render plus a separate forced grid layout flush in a connected styled host; warm repeated snapshot/search cache; stub observer; no IPC, async thumbnail decoding, hover playback, constructor/startup, input event latency or paint timing. Both owner modules import current shared dependencies.',
  };
}
