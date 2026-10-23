/**
 * Source scanners shared by the shell contract and the command registry
 * tests: a small HTML parser for index.html and the reader of the `actions`
 * map's keys in the modules that build it.
 */
import {readFileSync, readdirSync} from 'node:fs';

/** Every src/ module that builds the actions map: app.mjs owns it and passes it to modules that register more. */
export function readActionSources(root = new URL('../../src/', import.meta.url)) {
  return readdirSync(root, {recursive: true})
    .filter(file => file.endsWith('.mjs'))
    .map(file => readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8'))
    .filter(source => /const actions = \{|Object\.assign\(actions,/.test(source));
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** A small tag-stack scanner: enough HTML for a static, well-formed shell. */
export function parseHtml(text) {
  const root = {tag: '#root', attrs: {}, children: [], parent: null};
  const all = [];
  let node = root, i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) { i = text.indexOf('-->', lt) + 3; continue; }
    if (text.startsWith('<!', lt)) { i = text.indexOf('>', lt) + 1; continue; }
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt), tag = text.slice(lt + 2, end).trim().toLowerCase();
      if (node.tag !== tag) throw new Error(`Unexpected </${tag}> inside <${node.tag}> at offset ${lt}`);
      node = node.parent; i = end + 1; continue;
    }
    const match = /^<([a-zA-Z][\w-]*)/.exec(text.slice(lt));
    if (!match) { i = lt + 1; continue; }
    const element = {tag: match[1].toLowerCase(), attrs: {}, children: [], parent: node, text: ''};
    const attr = /\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?|\s*(\/?>)/y;
    attr.lastIndex = lt + match[0].length;
    let selfClosing = false;
    for (;;) {
      const part = attr.exec(text);
      if (!part) throw new Error(`Unterminated <${element.tag}> at offset ${lt}`);
      if (part[5]) { selfClosing = part[5] === '/>'; break; }
      element.attrs[part[1].toLowerCase()] = part[2] ?? part[3] ?? part[4] ?? '';
    }
    i = attr.lastIndex;
    node.children.push(element); all.push(element);
    if (element.tag === 'script' || element.tag === 'style') {
      const close = text.indexOf(`</${element.tag}`, i);
      element.text = text.slice(i, close);
      i = text.indexOf('>', close) + 1;
    } else if (!selfClosing && !VOID.has(element.tag)) node = element;
  }
  if (node !== root) throw new Error(`Unclosed <${node.tag}>`);
  return {root, all};
}

/** Action names registered on the `actions` map: the `const actions = {…}`
 * literal in app.mjs, `Object.assign(actions, {…})` in any module it passes the
 * map to, and `actions["x"] =` assignments. Keys built at runtime (zoom-25 …)
 * are not found; index.html uses none of them. */
export function actionKeys(sources) {
  const keys = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/const actions = \{|Object\.assign\(actions,\s*\{/g))
      for (const key of objectKeys(source, match.index + match[0].length - 1)) keys.add(key);
    for (const match of source.matchAll(/\bactions(?:\[\s*(['"])([^'"]+)\1\s*\]|\.([A-Za-z_$][\w$]*))\s*=(?!=)/g))
      keys.add(match[2] ?? match[3]);
  }
  return keys;
}

/** Top-level property names of the object literal whose `{` is at `open`.
 * Aware of strings, template literals, comments and regular expressions. */
export function objectKeys(source, open) {
  const keys = new Set(), stack = [];
  const KEY = /^(?:async\s+)?(?:([A-Za-z_$][\w$]*)|'([^'\\]*)'|"([^"\\]*)")\s*[:(,}]/;
  let i = open, expectKey = false, last = '';
  // Skips the quoted string or regular expression that starts at `from`.
  const skipLiteral = (from, close) => {
    let inClass = false;
    for (let j = from + 1; j < source.length; j++) {
      if (source[j] === '\\') j++;
      else if (close === '/' && source[j] === '[') inClass = true;
      else if (close === '/' && source[j] === ']') inClass = false;
      else if (source[j] === close && !inClass) return j + 1;
    }
    throw new Error(`Unterminated literal at offset ${from} of an actions source`);
  };
  while (i < source.length) {
    const ch = source[i];
    if (stack.at(-1) === '`') {
      // Template text: only an escape, `${` or the closing backtick matter.
      if (ch === '\\') i += 2;
      else if (ch === '`') { stack.pop(); i++; last = 'x'; }
      else if (source.startsWith('${', i)) { stack.push('${'); i += 2; last = '{'; }
      else i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); continue; }
    if (source.startsWith('/*', i)) { i = source.indexOf('*/', i) + 2; continue; }
    if (expectKey) {
      expectKey = false;
      const key = KEY.exec(source.slice(i, i + 200));
      if (key) keys.add(key[1] ?? key[2] ?? key[3]);
    }
    if (ch === '"' || ch === "'") { i = skipLiteral(i, ch); last = 'x'; continue; }
    if (ch === '/' && !/[\w$)\]]/.test(last)) { i = skipLiteral(i, '/'); last = 'x'; continue; }
    i++;
    if (ch === '`' || '{[('.includes(ch)) {
      stack.push(ch);
      if (ch === '{' && stack.length === 1) expectKey = true;
    } else if ('}])'.includes(ch)) {
      stack.pop();
      if (!stack.length) break;
    } else if (ch === ',' && stack.length === 1) expectKey = true;
    last = ch;
  }
  return keys;
}
