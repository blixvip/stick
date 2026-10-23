import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BASELINE_FILE, LAYER_ORDER, compareBaseline, importantEntries, lintCss, lintSource, lintTree, parseCss, specificity,
  stringLiterals, styleRole,
} from '../scripts/check-css.mjs';

const rules = (css, file = 'src/styles/components/button.css') => lintCss(css, file).map(finding => finding.rule);
const ORDER = `@layer ${LAYER_ORDER.join(', ')};`;

test('parses nesting, at-rules, strings, url() and trailing comments', () => {
  const {items, errors} = parseCss(`
@layer components {
  .a { background: url(data:image/svg+xml;utf8,<svg/>); content: "{;}"; /* artwork */
    &:hover { color: var(--x) !important; }
  }
  @media (hover: none) { .b { opacity: 1 } }
}`);
  assert.deepEqual(errors, []);
  const [layer] = items, [rule, media] = layer.block;
  assert.equal(layer.params, 'components');
  assert.deepEqual(rule.block.slice(0, 2).map(item => item.property), ['background', 'content']);
  assert.deepEqual(rule.block[1].tags, ['artwork']);
  assert.equal(rule.block[2].selector, '&:hover');
  assert.deepEqual(rule.block[2].block[0], {type: 'decl', property: 'color', value: 'var(--x)', important: true, tags: [], line: 4});
  assert.equal(media.name, 'media');
  assert.equal(media.block[0].line, 6);
});

test('computes Selectors 4 specificity', () => {
  for (const [selector, expected] of [
    ['#a .b c', [1, 1, 1]],
    [':where(#a .b) .c', [0, 1, 0]],
    [':is(.a, #b) c', [1, 0, 1]],
    [':not(.a.b)', [0, 2, 0]],
    ['.a:has(> img, .b .c)', [0, 3, 0]],
    ['li:nth-child(2n of .x.y)', [0, 3, 1]],
    ['a:hover::after', [0, 1, 2]],
    ['p:first-line', [0, 0, 2]],
    ['[data-x="a,b]"] *', [0, 1, 0]],
    ['.ui-menu-item:where(:hover, [aria-expanded=true]):not([aria-disabled=true])', [0, 2, 0]],
  ]) assert.deepEqual(specificity(selector), expected, selector);
});

test('maps every stylesheet location to its layer', () => {
  assert.equal(styleRole('src/styles/app.css').kind, 'entry');
  assert.equal(styleRole('src/styles/support-bridge.css').kind, 'bridge');
  assert.equal(styleRole('src/styles/legacy/01-style.css').kind, 'legacy');
  assert.equal(styleRole('src/support-center.css').kind, 'other');
  for (const [file, layer] of [['base/reset.css', 'reset'], ['base/fonts.css', 'base'], ['tokens.css', 'tokens'], ['legacy-bridge.css', 'tokens'],
    ['layout/shell.css', 'layout'], ['components/button.css', 'components'], ['features/timeline.css', 'features'],
    ['states.css', 'states'], ['utilities.css', 'utilities'], ['misc.css', null], ['extra/x.css', null]])
    assert.equal(styleRole(`src/styles/${file}`).layer, layer, file);
});

test('CSS01: one top-level @layer block named after the file', () => {
  assert.deepEqual(rules('/* ok */ @layer components { .ui-button { display: flex } }'), []);
  assert.deepEqual(rules('@layer components {}'), [], 'an empty stub is fine');
  assert.deepEqual(rules('@layer reset { [hidden] { display: none !important } }', 'src/styles/base/reset.css'), []);
  assert.deepEqual(rules('.ui-button { display: flex }'), ['CSS01', 'CSS01'], 'missing block and a rule outside it');
  assert.deepEqual(rules('@layer features { .x {} }'), ['CSS01']);
  assert.deepEqual(rules('@layer components {} @layer components {}'), ['CSS01']);
  assert.deepEqual(rules('@layer components { @layer inner { .x {} } }'), ['CSS01']);
  assert.deepEqual(rules('@layer components, features; @layer components {}'), ['CSS01']);
  assert.deepEqual(rules('@layer base {}', 'src/styles/misc.css'), ['CSS01']);
  assert.deepEqual(rules('@layer components { .x { color: var(--a) }'), ['CSS01'], 'unclosed block');
});

test('CSS02: colour literals live only in tokens.css', () => {
  const colour = (declaration, file) => rules(`@layer components { .x { ${declaration} } }`, file);
  for (const declaration of ['color: #fff', 'background: linear-gradient(#0a0b0f80, transparent)', 'border-color: rgb(0 0 0 / 10%)',
    'box-shadow: 0 1px 2px hsl(0 0% 0%)', 'outline-color: Red', 'fill: white', '--_ring: oklch(70% 0.1 250)', 'color: CanvasText'])
    assert.deepEqual(colour(declaration), ['CSS02'], declaration);
  for (const declaration of ['color: var(--text-1)', 'background: url(#pattern) no-repeat', 'content: "#fff red"', 'grid-area: canvas',
    'font-family: "Inter", system-ui', 'border-color: transparent', 'color: currentColor', 'animation-name: fade',
    'background: #fff; /* artwork */', 'background: conic-gradient(#ccc 25%, #fff 0) /* artwork: checkerboard */'])
    assert.deepEqual(colour(declaration), [], declaration);
  assert.deepEqual(rules('@layer components { @media (forced-colors: active) { .x { border-color: ButtonText } } }'), []);
  assert.deepEqual(rules('@layer tokens { :root { --mist-100: #f5f6f9 } }', 'src/styles/tokens.css'), []);
  assert.deepEqual(rules('@layer tokens { :root { --theme-panel: #fff } }', 'src/styles/legacy-bridge.css'), ['CSS02']);
});

test('CSS06: !important only in reset, states and utilities', () => {
  assert.deepEqual(rules('@layer components { .x { display: none !important } }'), ['CSS06']);
  assert.deepEqual(rules('@layer states { body.is-panning * { cursor: grabbing !important } }', 'src/styles/states.css'), []);
  assert.deepEqual(rules('@layer utilities { .u-hidden { display: none ! important } }', 'src/styles/utilities.css'), []);
});

test('CSS07 and CSS09: no ids and a specificity budget per layer', () => {
  assert.deepEqual(rules('@layer components { #inspector .x {} }'), ['CSS07']);
  assert.deepEqual(rules('@layer components { :where(#inspector) .x {} }'), []);
  assert.deepEqual(rules('@layer features { .a .b .c {} }', 'src/styles/features/timeline.css'), []);
  assert.deepEqual(rules('@layer features { .a .b .c:hover {} }', 'src/styles/features/timeline.css'), ['CSS09']);
  assert.deepEqual(rules('@layer components { .a.b {} .a[data-x] > .b {} }'), ['CSS09']);
  assert.deepEqual(rules('@layer components { .ui-menu-item:where(:hover, [aria-expanded=true]):not([aria-disabled=true]) {} }'), []);
  assert.deepEqual(rules('@layer components { .a { .b { &:hover {} } } }'), ['CSS09'], 'nested selectors add up');
  assert.deepEqual(rules('@layer layout { .a { & > .b {} } }', 'src/styles/layout/shell.css'), []);
  assert.deepEqual(rules('@layer base { html {} ::selection {} .ui-icon {} :where([data-ui]) :where(button, input) {} }', 'src/styles/base/document.css'), []);
  assert.deepEqual(rules('@layer base { :root {} .button {} .ui-a.ui-b {} }', 'src/styles/base/document.css'), ['CSS09', 'CSS09', 'CSS09']);
  assert.deepEqual(rules('@layer components { @keyframes spin { from { rotate: 0 } 50% { rotate: 180deg } } }'), []);
});

test('CSS11, CSS14 and CSS16: z-index scale, viewport queries and imports', () => {
  assert.deepEqual(rules('@layer components { .a { z-index: 10 } .b { z-index: var(--z-floating) } .c { z-index: 2 } .d { z-index: auto } }'), ['CSS11']);
  for (const query of ['(max-width: 600px)', 'screen and (min-height: 400px)', '(width < 600px)', '(400px <= width <= 700px)', '(orientation: portrait)'])
    assert.deepEqual(rules(`@layer components { @media ${query} { .a {} } }`), ['CSS14'], query);
  assert.deepEqual(rules('@layer layout { @media (max-width: 600px) { .a {} } }', 'src/styles/layout/shell.css'), []);
  assert.deepEqual(rules('@layer components { @media (hover: none) and (prefers-reduced-motion: reduce) { .a {} } @container toolbar (width < 520px) { .b {} } }'), []);
  assert.deepEqual(rules('@import url("./other.css"); @layer components {}'), ['CSS16']);
});

test('app.css declares the layer order once and only imports', () => {
  const entry = css => lintCss(css, 'src/styles/app.css').map(finding => finding.rule);
  assert.deepEqual(entry(`${ORDER}\n@import url("./legacy/01-style.css") layer(legacy);\n@import url("./base/fonts.css");`), []);
  assert.deepEqual(entry('@layer legacy, base;'), ['CSS01']);
  assert.deepEqual(entry(`@import url("./base/fonts.css");\n${ORDER}`), ['CSS01', 'CSS16']);
  assert.deepEqual(entry(`${ORDER}\n@import url("./legacy/01-style.css");`), ['CSS01']);
  assert.deepEqual(entry(`${ORDER}\n@import url("./base/fonts.css") layer(base);`), ['CSS01']);
  assert.deepEqual(entry(`${ORDER}\nhtml { color: red }`), ['CSS16']);
  const bridge = css => lintCss(css, 'src/styles/support-bridge.css').map(finding => finding.rule);
  assert.deepEqual(bridge('@import url("../support-center.css") layer(legacy);'), []);
  assert.deepEqual(bridge('@import url("../support-center.css");'), ['CSS01']);
});

test('JS01 counts runtime stylesheets and JS02 allows one runtime link', () => {
  const source = `const a = document.createElement('style'), b = new CSSStyleSheet(); document.adoptedStyleSheets = [b]; b.insertRule('x{}');`;
  assert.deepEqual(lintSource(source, 'src/x.mjs'), {runtimeSheets: 4, findings: []});
  const link = "const link = document.createElement('link'); link.rel = 'stylesheet';";
  assert.deepEqual(lintSource(link, 'src/x.mjs').findings.map(finding => finding.rule), ['JS02']);
  assert.deepEqual(lintSource(`host.innerHTML = '<link rel="stylesheet" href="x.css">';`, 'src/x.mjs').findings.map(finding => finding.line), [1]);
  assert.deepEqual(lintSource(link, 'src/support-desktop-ui.mjs').findings, []);
});

test('finds !important in legacy sheets and in the CSS text of injector modules', () => {
  assert.deepEqual(importantEntries('.a { color: red }\n@media (x) { .b,\n .c { display: none !important } }', 'legacy.css'),
    [{file: 'legacy.css', line: 3, selector: '.b, .c', property: 'display'}]);
  const module = [
    "const re = /['`]/g; // a regular expression with quotes",
    'const STYLE = `',
    '.x [hidden]{display:none!important}',
    '.y{color:${color}}`;',
    'const other = "@layer legacy{.z{cursor:grab!important}}";',
  ].join('\n');
  const literals = stringLiterals(module).filter(literal => literal.text.includes('!important'));
  assert.deepEqual(literals.map(literal => literal.line), [2, 5]);
  assert.deepEqual(literals.flatMap(literal => importantEntries(literal.text, 'src/m.mjs', literal.line)).map(entry => [entry.line, entry.selector]),
    [[3, '.x [hidden]'], [5, '.z']]);
});

test('the ratchet fails on new entries and on entries that left the code', () => {
  const entry = (selector, line = 1) => ({file: 'a.css', line, selector, property: 'display'});
  const baseline = {JS01: {'src/a.mjs': 1, 'src/b.mjs': 1}, legacyImportant: [entry('.a'), entry('.a', 9), entry('.b')]};
  const same = compareBaseline({JS01: {'src/a.mjs': 1, 'src/b.mjs': 1}, legacyImportant: [entry('.b', 40), entry('.a', 3), entry('.a', 7)]}, baseline);
  assert.deepEqual(same, {added: [], removed: []}, 'line moves do not count');
  const changed = compareBaseline({JS01: {'src/a.mjs': 2}, legacyImportant: [entry('.a'), entry('.c')]}, baseline);
  assert.deepEqual(changed.added.map(item => [item.rule, item.file]), [['JS01', 'src/a.mjs'], ['legacyImportant', 'a.css']]);
  assert.deepEqual(changed.removed.map(item => [item.rule, item.file]), [['JS01', 'src/b.mjs'], ['legacyImportant', 'a.css'], ['legacyImportant', 'a.css']]);
});

test('lintTree finds unloaded, missing and legacy sheets in a project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-check-css-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const write = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), {recursive: true}); await writeFile(path.join(root, file), text); };
  await write('src/styles/app.css', `${ORDER}\n@import url("./legacy/01-a.css") layer(legacy);\n@import url("./base/gone.css");\n@import url("./base/fonts.css");`);
  await write('src/styles/legacy/01-a.css', '[hidden] { display: none !important }');
  await write('src/styles/base/fonts.css', '@layer base { @font-face { font-family: "Inter"; src: url("x.woff2") } }');
  await write('src/styles/components/orphan.css', '@layer components {}');
  await write('src/styles/support-bridge.css', '@import url("../support.css") layer(legacy);');
  await write('src/support.css', '.s * { transition: none !important }');
  await write('src/app.mjs', "document.head.append(Object.assign(document.createElement('style'), {textContent: '.m{cursor:wait!important}'}));");
  const {findings, current} = lintTree(root);
  assert.deepEqual(findings.map(finding => `${finding.file} ${finding.message}`).sort(), [
    './base/gone.css does not exist', 'not imported by src/styles/app.css, so it never loads',
  ].map((message, index) => `${['src/styles/app.css', 'src/styles/components/orphan.css'][index]} ${message}`));
  assert.deepEqual(current.JS01, {'src/app.mjs': 1});
  assert.deepEqual(current.legacyImportant.map(entry => `${entry.file} ${entry.selector}`),
    ['src/app.mjs .m', 'src/styles/legacy/01-a.css [hidden]', 'src/support.css .s *']);
});

test('the editor stylesheets pass and the committed baseline is exact', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const {findings, current} = lintTree(root);
  assert.deepEqual(findings, []);
  const baseline = JSON.parse(await readFile(path.join(root, BASELINE_FILE), 'utf8'));
  assert.deepEqual(compareBaseline(current, baseline), {added: [], removed: []});
});
