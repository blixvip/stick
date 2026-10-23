/**
 * Stylesheet lint, run by `npm run check`. See docs/DESIGN-SYSTEM.md.
 *
 *   node scripts/check-css.mjs                    lint; exits 1 on any problem
 *   node scripts/check-css.mjs --update-baseline  rewrite the ratchet after removing entries
 *
 * Layered files (everything under src/styles/ except app.css,
 * support-bridge.css and legacy/) follow these rules:
 *
 *   CSS01  exactly one top-level `@layer` block, named after the file's place
 *          (base/ → base, base/reset.css → reset, layout/, components/,
 *          features/, tokens.css and legacy-bridge.css → tokens, states.css,
 *          utilities.css). app.css declares the layer order once, then only
 *          imports; every stylesheet is imported exactly once.
 *   CSS02  no colour literals (hex, rgb(), hsl(), named or system colours)
 *          outside tokens.css. A declaration with an `artwork` comment is exempt;
 *          system colours are allowed inside `@media (forced-colors: active)`.
 *   CSS06  `!important` only in base/reset.css, states.css and utilities.css.
 *   CSS07  no id selectors, except inside `:where()`.
 *   CSS09  specificity budget in classes, attributes and pseudo-classes: base 0
 *          (a lone `.ui-*` helper class may use 1), layout and components 2,
 *          features 3. `:where()` counts 0; `:is()`, `:not()` and `:has()`
 *          count their most specific argument.
 *   CSS11  `z-index` is `var(--z-*)`, a literal 0–3 or `auto`.
 *   CSS14  viewport size media queries only in layout/shell.css.
 *   CSS16  `@import` only in app.css and support-bridge.css.
 *   JS02   modules link a stylesheet at runtime only from
 *          support-desktop-ui.mjs (src/styles/support-bridge.css).
 *
 * The legacy layer is not linted: its sheets are emptied and deleted, not
 * fixed. A ratchet in scripts/check-css-baseline.json records what legacy
 * still holds that later layers cannot override, and the check fails when an
 * entry is added or when a removed entry is still listed:
 *
 *   JS01             modules that create stylesheets at runtime (<style>
 *                    elements, constructed sheets, insertRule), per file.
 *   legacyImportant  every `!important` declaration in the legacy layer: the
 *                    legacy sheets, the sheets support-bridge.css imports into
 *                    it and the CSS text of the JS01 modules. Legacy
 *                    `!important` beats every later layer.
 *
 * `--update-baseline` rewrites the file after entries were removed and refuses
 * to record new ones.
 */
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const LAYER_ORDER = ['legacy', 'reset', 'tokens', 'base', 'layout', 'components', 'features', 'states', 'utilities'];
export const BASELINE_FILE = 'scripts/check-css-baseline.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = 'src/styles/';
const FILE_LAYERS = {'tokens.css': 'tokens', 'legacy-bridge.css': 'tokens', 'states.css': 'states', 'utilities.css': 'utilities', 'base/reset.css': 'reset'};
const FOLDER_LAYERS = new Set(['base', 'layout', 'components', 'features']);
const BUDGETS = {base: 0, layout: 2, components: 2, features: 3};
const IMPORTANT_FILES = new Set(['base/reset.css', 'states.css', 'utilities.css']);
const VIEWPORT_QUERY_FILES = new Set(['layout/shell.css']);
const RUNTIME_LINK_MODULES = new Set(['src/support-desktop-ui.mjs']);
const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
  'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey ' +
  'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey ' +
  'darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
  'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon ' +
  'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue ' +
  'lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid ' +
  'mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
  'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff ' +
  'peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver ' +
  'skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));
const SYSTEM_COLORS = new Set(['accentcolor', 'accentcolortext', 'activetext', 'buttonborder', 'buttonface', 'buttontext', 'canvas', 'canvastext',
  'field', 'fieldtext', 'graytext', 'highlight', 'highlighttext', 'linktext', 'mark', 'marktext', 'selecteditem', 'selecteditemtext', 'visitedtext']);
// Keywords are colours only in these properties; hex and colour functions count everywhere.
const COLOR_PROPERTY = /^(?:--.*|color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|column-rule(?:-color)?|text-decoration(?:-color)?|text-emphasis(?:-color)?|scrollbar-color|filter|stop-color|flood-color|lighting-color|-webkit-text-fill-color|-webkit-text-stroke(?:-color)?|-webkit-tap-highlight-color)$/;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX = /#([0-9a-f]+)(?![\w-])/gi;
const VIEWPORT_FEATURE = /(?<![\w-])(?:(?:min|max)-)?(?:device-)?(?:width|height|aspect-ratio)(?![\w-])|(?<![\w-])orientation(?![\w-])/i;
const RUNTIME_SHEET = /createElement\(\s*(['"`])style\1\s*\)|\bnew\s+CSSStyleSheet\b|\badoptedStyleSheets\b|\.insertRule\s*\(/g;
const RUNTIME_LINK = /\brel\s*=\s*\\?(['"])stylesheet\\?\1/g;

// ---------------------------------------------------------------------------
// A small CSS parser: comments, strings, url() and nesting aware.

/** Offset → 1-based line number. */
function lineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return offset => {
    let low = 0, high = starts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= offset) low = mid; else high = mid - 1; }
    return low + 1;
  };
}

const stringEnd = (text, start) => {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start] || text[i] === '\n') return i + 1;
  }
  return text.length;
};
const commentEnd = (text, start) => { const end = text.indexOf('*/', start + 2); return end < 0 ? text.length : end + 2; };
const stripComments = text => text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');

/**
 * Parses a stylesheet into items: `{type: 'rule', selector, block}`,
 * `{type: 'at', name, params, block}` (block is null for statements) and
 * `{type: 'decl', property, value, important, tags}`. Every item has a line.
 * `tags` holds the comments written inside or directly after a declaration.
 */
export function parseCss(text) {
  const lineAt = lineLookup(text), errors = [];
  // Index of the first `{`, `;` or `}` at bracket depth 0 from `from`.
  const scan = from => {
    let depth = 0;
    for (let i = from; i < text.length;) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '*') i = commentEnd(text, i);
      else if (ch === '"' || ch === "'") i = stringEnd(text, i);
      else if (ch === '\\') i += 2;
      else if (/^url\(\s*[^\s'")]/i.test(text.slice(i, i + 6)) && !/[\w-]/.test(text[i - 1] ?? '')) i = Math.max(i + 4, text.indexOf(')', i) + 1 || text.length);
      else {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        else if (!depth && (ch === '{' || ch === ';' || ch === '}')) return i;
        i++;
      }
    }
    return text.length;
  };
  const skipSpace = from => {
    let i = from;
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('/*', i)) i = commentEnd(text, i); else return i;
    }
  };
  const block = (from, nested) => {
    const items = [];
    let i = from;
    for (;;) {
      i = skipSpace(i);
      if (i >= text.length) { if (nested) errors.push({line: lineAt(from - 1), message: 'unclosed block'}); return {items, end: i}; }
      if (text[i] === '}') { if (nested) return {items, end: i + 1}; errors.push({line: lineAt(i), message: 'unexpected }'}); i++; continue; }
      if (text[i] === ';') { i++; continue; }
      const start = i, end = scan(i), raw = text.slice(start, end), prelude = stripComments(raw).trim(), line = lineAt(start);
      if (text[end] === '{') {
        const inner = block(end + 1, true);
        const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
        items.push(at ? {type: 'at', name: at[1].toLowerCase(), params: at[2].trim(), block: inner.items, line}
          : {type: 'rule', selector: prelude, block: inner.items, line});
        i = inner.end;
        continue;
      }
      i = text[end] === ';' ? end + 1 : end;
      const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
      if (at) { items.push({type: 'at', name: at[1].toLowerCase(), params: at[2].trim(), block: null, line}); continue; }
      const colon = prelude.indexOf(':');
      if (colon < 1) { errors.push({line, message: `cannot parse "${prelude.slice(0, 40)}"`}); continue; }
      // Comments inside the declaration or after it on the same line tag it.
      const after = text.slice(i, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i));
      const tags = [...(raw + (/^\s*\/\*/.test(after) ? after : '')).matchAll(/\/\*([\s\S]*?)\*\//g)].map(match => match[1].trim());
      let value = prelude.slice(colon + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
      items.push({type: 'decl', property: prelude.slice(0, colon).trim().toLowerCase(), value, important, tags, line});
    }
  };
  return {items: block(0, false).items, errors};
}

/** Splits a selector or argument list on top-level commas. */
export function splitList(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '"' || ch === "'") i = stringEnd(text, i) - 1;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && !depth) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

const identEnd = (text, from) => {
  let i = from;
  while (i < text.length && (/[\w-]/.test(text[i]) || text.charCodeAt(i) > 127 || text[i] === '\\')) i += text[i] === '\\' ? 2 : 1;
  return i;
};
const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** Specificity [ids, classes, types] of one complex selector (Selectors 4). */
export function specificity(selector) {
  let a = 0, b = 0, c = 0, i = 0;
  const s = selector;
  const most = list => splitList(list).map(specificity).reduce((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0]);
  const add = ([x, y, z]) => { a += x; b += y; c += z; };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { a++; i = identEnd(s, i + 1); }
    else if (ch === '.') { b++; i = identEnd(s, i + 1); }
    else if (ch === '[') {
      b++;
      for (i++; i < s.length && s[i] !== ']'; i++) if (s[i] === '"' || s[i] === "'") i = stringEnd(s, i) - 1;
      i++;
    } else if (ch === ':') {
      const element = s[i + 1] === ':';
      const nameStart = i + (element ? 2 : 1), nameEnd = identEnd(s, nameStart), name = s.slice(nameStart, nameEnd).toLowerCase();
      i = nameEnd;
      let args = null;
      if (s[i] === '(') {
        let depth = 0;
        const open = i;
        for (; i < s.length; i++) {
          if (s[i] === '\\') i++;
          else if (s[i] === '"' || s[i] === "'") i = stringEnd(s, i) - 1;
          else if (s[i] === '(') depth++;
          else if (s[i] === ')' && !--depth) break;
        }
        args = s.slice(open + 1, i);
        i++;
      }
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) c++;
      else if (name === 'where') continue;
      else if (['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any'].includes(name)) add(most(args ?? ''));
      else if (/^nth-(?:last-)?child$/.test(name) && /\sof\s/i.test(args ?? '')) { b++; add(most(args.slice(args.search(/\sof\s/i) + 4))); }
      else b++;
    } else if (/[\w-]/.test(ch) || s.charCodeAt(i) > 127 || ch === '\\') { c++; i = identEnd(s, i); }
    else i++;
  }
  return [a, b, c];
}

// ---------------------------------------------------------------------------
// Layered stylesheets

/** Where a file sits in the cascade: the entry, the support bridge, legacy or a layered file. */
export function styleRole(file) {
  const name = file.replaceAll('\\', '/');
  if (!name.startsWith(STYLES)) return {kind: 'other'};
  const local = name.slice(STYLES.length), folder = local.split('/')[0];
  if (local === 'app.css') return {kind: 'entry', local};
  if (local === 'support-bridge.css') return {kind: 'bridge', local};
  if (folder === 'legacy') return {kind: 'legacy', local};
  return {kind: 'layered', local, layer: FILE_LAYERS[local] ?? (local.includes('/') && FOLDER_LAYERS.has(folder) ? folder : null)};
}

function colorLiterals(declaration, forcedColors) {
  const value = declaration.value.replace(/url\([^)]*\)/gi, ' ').replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
  const found = [];
  for (const [literal, digits] of value.matchAll(HEX)) if ([3, 4, 6, 8].includes(digits.length)) found.push(literal);
  const fn = COLOR_FUNCTION.exec(value);
  if (fn) found.push(`${fn[0]}…)`);
  if (COLOR_PROPERTY.test(declaration.property))
    for (const [word] of value.matchAll(/(?<![\w-])[a-z]+(?![\w-])/gi)) {
      const key = word.toLowerCase();
      if (NAMED_COLORS.has(key) || (SYSTEM_COLORS.has(key) && !forcedColors)) found.push(word);
    }
  return found;
}

/** Lint findings for one stylesheet under src/styles/. File paths are relative to the repository root. */
export function lintCss(text, file) {
  const role = styleRole(file);
  if (role.kind === 'entry' || role.kind === 'bridge') return readImports(text, file).findings;
  if (role.kind !== 'layered') return [];
  const findings = [], add = (rule, line, message) => findings.push({rule, file, line, message});
  const {items, errors} = parseCss(text);
  for (const error of errors) add('CSS01', error.line, `syntax: ${error.message}`);
  const {local, layer} = role;
  if (!layer) add('CSS01', 1, 'no layer owns this location: use base/, layout/, components/, features/, tokens.css, states.css or utilities.css');
  const blocks = items.filter(item => item.type === 'at' && item.name === 'layer' && item.block);
  if (layer && !blocks.length) add('CSS01', 1, `wrap the file in one @layer ${layer} { … } block`);
  for (const item of items) {
    if (item === blocks[0]) {
      if (layer && item.params !== layer) add('CSS01', item.line, `the block is @layer ${item.params}; ${local} belongs in @layer ${layer}`);
    } else if (!(item.type === 'at' && item.name === 'import'))
      add('CSS01', item.line, blocks.includes(item) ? 'another top-level @layer block; keep one per file' : `outside the @layer ${layer ?? ''} block`);
  }
  const budget = BUDGETS[layer];
  const walk = (list, context) => {
    for (const item of list) {
      if (item.type === 'decl') {
        if (local !== 'tokens.css' && !item.tags.some(tag => /^artwork\b/i.test(tag)))
          for (const literal of colorLiterals(item, context.forcedColors))
            add('CSS02', item.line, `colour literal ${literal} in ${item.property}: use a colour token from tokens.css`);
        if (item.important && !IMPORTANT_FILES.has(local)) add('CSS06', item.line, `!important on ${item.property}: only base/reset.css, states.css and utilities.css may use it`);
        if (item.property === 'z-index' && !/^(?:var\(\s*--z-[\w-]+\s*\)|[0-3]|auto|inherit|initial|unset|revert|revert-layer)$/i.test(item.value))
          add('CSS11', item.line, `z-index: ${item.value}; use var(--z-*) or a local 0–3`);
        continue;
      }
      if (item.type === 'at') {
        if (item.name === 'import') { add('CSS16', item.line, '@import belongs in app.css only'); continue; }
        if (item.name === 'layer' && item !== blocks[0]) { if (context.depth) add('CSS01', item.line, 'nested @layer creates a sub-layer; keep one layer per file'); }
        if (item.name === 'media' && VIEWPORT_FEATURE.test(item.params) && !VIEWPORT_QUERY_FILES.has(local))
          add('CSS14', item.line, `@media ${item.params}: size rules follow the layout tier or a container query; only layout/shell.css queries the viewport`);
        if (item.block) walk(item.block, {...context, depth: context.depth + 1,
          forcedColors: context.forcedColors || (item.name === 'media' && /forced-colors\s*:\s*active/i.test(item.params)),
          keyframes: context.keyframes || /keyframes$/.test(item.name)});
        continue;
      }
      if (context.keyframes) { walk(item.block, {...context, depth: context.depth + 1}); continue; }
      const selectors = splitList(item.selector);
      const resolved = selectors.map(selector => !context.parents ? selector
        : selector.includes('&') ? selector.replaceAll('&', `:is(${context.parents.join(', ')})`) : `:is(${context.parents.join(', ')}) ${selector}`);
      selectors.forEach((selector, index) => {
        if (specificity(selector.replaceAll('&', ' '))[0]) add('CSS07', item.line, `id selector in "${selector}": use a class, or wrap the id in :where()`);
        const classes = specificity(resolved[index])[1];
        if (budget !== undefined && classes > budget && !(layer === 'base' && classes === 1 && /^\.ui-[\w-]+$/.test(selector)))
          add('CSS09', item.line, `"${selector}" has ${classes} classes, attributes or pseudo-classes; ${layer} allows ${budget} (move state qualifiers into :where())`);
      });
      walk(item.block, {...context, depth: context.depth + 1, parents: resolved});
    }
  };
  walk(items, {depth: 0, forcedColors: false, keyframes: false, parents: null});
  return findings;
}

/** The @import list of app.css or support-bridge.css, with CSS01/CSS16 findings for anything else. */
export function readImports(text, file) {
  const role = styleRole(file), findings = [], imports = [];
  const add = (rule, line, message) => findings.push({rule, file, line, message});
  const {items, errors} = parseCss(text);
  for (const error of errors) add('CSS01', error.line, `syntax: ${error.message}`);
  const order = LAYER_ORDER.join(', ');
  items.forEach((item, index) => {
    const isOrder = item.type === 'at' && item.name === 'layer' && !item.block;
    if (role.kind === 'entry' && index === 0) {
      if (!isOrder || item.params.replace(/\s+/g, ' ') !== order) add('CSS01', item.line, `app.css starts with @layer ${order};`);
      if (isOrder) return;
    }
    if (item.type !== 'at' || item.name !== 'import') {
      add('CSS16', item.line, `${path.basename(file)} holds only ${role.kind === 'entry' ? 'the layer order and ' : ''}@import rules`);
      return;
    }
    const match = /^(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)\s*([\s\S]*)$/.exec(item.params);
    if (!match) { add('CSS01', item.line, `unreadable @import ${item.params}`); return; }
    const layer = /^layer\(\s*([\w.-]+)\s*\)/.exec(match[5])?.[1] ?? (/^layer\b/.test(match[5]) ? '' : null);
    const href = match[2] ?? match[4];
    imports.push({href, layer, line: item.line});
    if (role.kind === 'bridge') { if (!['legacy', 'features'].includes(layer)) add('CSS01', item.line, `${href} must load into layer(legacy) or layer(features)`); }
    else if (href.startsWith('./legacy/')) { if (layer !== 'legacy') add('CSS01', item.line, `${href} must load into layer(legacy)`); }
    else if (layer !== null) add('CSS01', item.line, `${href} wraps itself in its @layer block; import it without layer()`);
  });
  if (role.kind === 'entry' && !items.length) add('CSS01', 1, `app.css starts with @layer ${order};`);
  return {findings, imports};
}

// ---------------------------------------------------------------------------
// Modules and the legacy ratchet

/** JS01 count and JS02 findings for one module under src/. */
export function lintSource(text, file) {
  const name = file.replaceAll('\\', '/'), findings = [], lineAt = lineLookup(text);
  const runtimeSheets = [...text.matchAll(RUNTIME_SHEET)].length;
  for (const match of text.matchAll(RUNTIME_LINK))
    if (!RUNTIME_LINK_MODULES.has(name)) findings.push({rule: 'JS02', file: name, line: lineAt(match.index), message: 'stylesheets load through src/styles/app.css, not runtime links'});
  return {runtimeSheets, findings};
}

/** Contents of the quoted and template literals in a module, each with the line it starts on. */
export function stringLiterals(source) {
  const lineAt = lineLookup(source), literals = [];
  let last = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) { i = commentEnd(source, i); continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1, depth = 0;
      for (; j < source.length; j++) {
        if (source[j] === '\\') j++;
        else if (ch === '`' && source.startsWith('${', j)) { depth++; j++; }
        else if (depth && source[j] === '{') depth++;
        else if (depth && source[j] === '}') depth--;
        else if (!depth && source[j] === ch) break;
      }
      literals.push({text: source.slice(i + 1, j), line: lineAt(i)});
      i = j + 1; last = 'x';
      continue;
    }
    if (ch === '/' && !/[\w$)\]]/.test(last)) {
      // A regular expression literal: skip it so its quotes do not open strings.
      let j = i + 1, inClass = false;
      for (; j < source.length && source[j] !== '\n'; j++) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
      }
      i = j + 1; last = 'x';
      continue;
    }
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  return literals;
}

/** Every !important declaration in a legacy stylesheet, keyed by selector and property. */
export function importantEntries(text, file, firstLine = 1) {
  const entries = [];
  const visit = (items, selector) => {
    for (const item of items) {
      if (item.type === 'decl') { if (item.important) entries.push({file, line: item.line + firstLine - 1, selector, property: item.property}); }
      else if (item.block) visit(item.block, item.type === 'rule' ? item.selector.replace(/\s+/g, ' ') : item.name === 'layer' ? selector : `@${item.name}`);
    }
  };
  visit(parseCss(text).items, '');
  return entries;
}

const listFiles = (root, directory, pattern) => readdirSync(path.join(root, directory), {recursive: true, withFileTypes: true})
  .filter(entry => entry.isFile() && pattern.test(entry.name))
  .map(entry => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'))
  .sort();

/** Lints the repository: findings plus the current ratchet state. */
export function lintTree(root = ROOT) {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const findings = [], legacyImportant = [], JS01 = {};
  const sheets = listFiles(root, 'src/styles', /\.css$/);
  const modules = listFiles(root, 'src', /\.(?:mjs|js)$/);
  const imported = new Map(), legacySheets = new Set();
  for (const sheet of sheets) {
    findings.push(...lintCss(read(sheet), sheet));
    const role = styleRole(sheet);
    if (role.kind === 'legacy') legacySheets.add(sheet);
    if (role.kind !== 'entry' && role.kind !== 'bridge') continue;
    for (const entry of readImports(read(sheet), sheet).imports) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(sheet), entry.href));
      if (!existsSync(path.join(root, target))) findings.push({rule: 'CSS01', file: sheet, line: entry.line, message: `${entry.href} does not exist`});
      if (entry.layer === 'legacy') legacySheets.add(target);
      if (role.kind === 'entry') imported.set(target, [...(imported.get(target) ?? []), entry.line]);
    }
  }
  for (const sheet of sheets) {
    const role = styleRole(sheet), lines = imported.get(sheet) ?? [];
    if (role.kind === 'layered' || role.kind === 'legacy') {
      if (!lines.length) findings.push({rule: 'CSS01', file: sheet, line: 1, message: 'not imported by src/styles/app.css, so it never loads'});
      if (lines.length > 1) findings.push({rule: 'CSS01', file: 'src/styles/app.css', line: lines[1], message: `${sheet} is imported ${lines.length} times`});
    }
  }
  for (const sheet of [...legacySheets].filter(sheet => existsSync(path.join(root, sheet)))) legacyImportant.push(...importantEntries(read(sheet), sheet));
  for (const module of modules) {
    const source = read(module), result = lintSource(source, module);
    findings.push(...result.findings);
    if (!result.runtimeSheets) continue;
    JS01[module] = result.runtimeSheets;
    for (const literal of stringLiterals(source))
      if (/!\s*important/i.test(literal.text) && literal.text.includes('{')) legacyImportant.push(...importantEntries(literal.text, module, literal.line));
  }
  legacyImportant.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  return {findings, current: {JS01, legacyImportant}, sheets: sheets.length, modules: modules.length};
}

const importantKey = entry => `${entry.file}|${entry.selector}|${entry.property}`;

/** Ratchet differences: `added` entries fail the check, `removed` ones must be taken out of the baseline. */
export function compareBaseline(current, baseline) {
  const added = [], removed = [];
  for (const file of new Set([...Object.keys(current.JS01), ...Object.keys(baseline.JS01 ?? {})])) {
    const now = current.JS01[file] ?? 0, before = baseline.JS01?.[file] ?? 0;
    if (now > before) added.push({rule: 'JS01', file, line: 1, message: `creates ${now} runtime stylesheet(s), baseline ${before}: add CSS to a layered file instead`});
    if (now < before) removed.push({rule: 'JS01', file, line: 1, message: `creates ${now} runtime stylesheet(s), baseline ${before}`});
  }
  const remaining = new Map();
  for (const entry of baseline.legacyImportant ?? []) remaining.set(importantKey(entry), [...(remaining.get(importantKey(entry)) ?? []), entry]);
  for (const entry of current.legacyImportant) {
    const listed = remaining.get(importantKey(entry));
    if (listed?.length) listed.shift();
    else added.push({rule: 'legacyImportant', file: entry.file, line: entry.line,
      message: `new !important in the legacy layer (${entry.selector} { ${entry.property} }): it would beat every later layer`});
  }
  for (const entry of [...remaining.values()].flat())
    removed.push({rule: 'legacyImportant', file: entry.file, line: entry.line, message: `${entry.selector} { ${entry.property} !important } is gone`});
  return {added, removed};
}

/** The baseline as stable, diff-friendly JSON: one entry per line. */
export function formatBaseline({JS01, legacyImportant}) {
  const counts = Object.keys(JS01).sort().map(file => `    ${JSON.stringify(file)}: ${JS01[file]}`);
  const entries = legacyImportant.map(entry => `    ${JSON.stringify({file: entry.file, line: entry.line, selector: entry.selector, property: entry.property})}`);
  return `{\n  "JS01": {\n${counts.join(',\n')}\n  },\n  "legacyImportant": [\n${entries.join(',\n')}\n  ]\n}\n`;
}

function main() {
  const update = process.argv.includes('--update-baseline');
  const baselinePath = path.join(ROOT, BASELINE_FILE);
  const {findings, current, sheets, modules} = lintTree(ROOT);
  const exists = existsSync(baselinePath);
  const baseline = exists ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {JS01: {}, legacyImportant: []};
  let {added, removed} = compareBaseline(current, baseline);
  const report = list => { for (const finding of list) console.error(`${finding.file}:${finding.line}: ${finding.rule} ${finding.message}`); };
  report(findings);
  if (update && !added.length || update && !exists) {
    // The first run records the current state; later runs may only remove entries.
    writeFileSync(baselinePath, formatBaseline(current));
    console.log(`${BASELINE_FILE} ${exists ? `updated (removed ${removed.length})` : 'created'}.`);
    added = removed = [];
  }
  report(added);
  report(removed);
  if (added.length && update) console.error(`${BASELINE_FILE} is unchanged: the ratchet only records removals.`);
  else if (removed.length) console.error(`${BASELINE_FILE} lists ${removed.length} removed item(s); record the removal with: node scripts/check-css.mjs --update-baseline`);
  const problems = findings.length + added.length + removed.length;
  console.log(`${sheets} stylesheets and ${modules} modules linted; ${problems} CSS lint problems ` +
    `(legacy layer: ${current.legacyImportant.length} !important, ${Object.keys(current.JS01).length} runtime style modules).`);
  if (problems) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
