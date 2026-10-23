/**
 * Readers and assertions for inspector markup, shared by the inspector's
 * unit tests (tests/inspector-kit.test.mjs, tests/inspector-descriptors.test.mjs):
 * a start-tag reader (no comments, scripts or unquoted values), and parity
 * checks between today's markup (tests/fixtures/inspector-legacy.mjs) and the
 * markup under test.
 */
import assert from 'node:assert/strict';

const ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"};
export const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]);
export function tags(html) {
  return [...html.matchAll(/<([a-z][a-z0-9-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/gi)].map(match => ({
    tag: match[1].toLowerCase(), index: match.index, end: match.index + match[0].length,
    attrs: Object.fromEntries([...match[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, decode(value ?? '')])),
  }));
}
export const matches = (entry, where) => Object.entries(where).every(([name, value]) => (value === true ? name in entry.attrs : entry.attrs[name] === String(value)));
export const find = (html, where) => tags(html).find(entry => matches(entry, where));
export function tag(html, where, label = JSON.stringify(where)) {
  const found = find(html, where);
  assert.ok(found, `no element with ${label}`);
  return found;
}
export const pick = (entry, names) => Object.fromEntries(names.map(name => [name, entry.attrs[name] ?? null]));
/** Today's accessible names with the unit written out, as components.md §3 asks ("Angle (degrees)"): a deliberate change. */
export const human = values => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, name === 'aria-label' && value ? value.replace(/\(°\)/g, '(degrees)') : value]));
/** The text of an element's options (a select's contract: value, selected, disabled, label). */
export function options(html, where) {
  const select = tag(html, where), close = html.indexOf('</select>', select.end);
  return [...html.slice(select.end, close).matchAll(/<option((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>([^<]*)<\/option>/g)].map(([, attrs, text]) => {
    const entry = {attrs: Object.fromEntries([...attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, decode(value ?? '')]))};
    return {value: entry.attrs.value ?? null, selected: 'selected' in entry.attrs, disabled: 'disabled' in entry.attrs, text: decode(text)};
  });
}
/** A control's accessible name: aria-label, else the text of the <label> that wraps it up to the control. */
export function nameOf(html, where) {
  const entry = tag(html, where);
  if (entry.attrs['aria-label']) return entry.attrs['aria-label'];
  const before = html.slice(0, entry.index);
  return [...before.slice(before.lastIndexOf('<label')).matchAll(/>([^<]+)</g)].map(match => decode(match[1])).join('').trim();
}

export const NUMBER = ['type', 'id', 'data-field', 'data-property', 'data-property-value', 'data-property-precision', 'data-property-display-precision',
  'data-property-step', 'value', 'step', 'aria-label', 'min', 'max', 'disabled'];
export const SCRUB = ['data-property-scrub', 'tabindex', 'role', 'aria-label'];
/**
 * A PropertyControls number: its row, its input and the scrub label inside the
 * row are the same today and in the kit, except that the scrub tip is the one
 * tooltip (data-tooltip) instead of a native title.
 */
export function assertNumberParity(today, kit, key, names = NUMBER) {
  for (const [html, source] of [[today, 'today'], [kit, 'kit']]) tag(html, {'data-property-row': key}, `${source} data-property-row=${key}`);
  const expected = tag(today, {'data-property': key}), actual = tag(kit, {'data-property': key});
  assert.deepEqual(pick(actual, names), human(pick(expected, names)), `${key} input`);
  const scrub = (html, row) => tags(html).find(entry => entry.index > row.index && 'data-property-scrub' in entry.attrs);
  const todayScrub = scrub(today, tag(today, {'data-property-row': key})), kitScrub = scrub(kit, tag(kit, {'data-property-row': key}));
  if (names.includes('aria-label')) assert.deepEqual(pick(kitScrub, SCRUB), human(pick(todayScrub, SCRUB)), `${key} scrub label`);
  assert.equal(kitScrub.attrs['data-tooltip'], todayScrub.attrs.title, `${key}: the scrub tip is the tooltip`);
  assert.ok(!('title' in kitScrub.attrs), `${key}: no native title beside the tooltip`);
  assert.ok(kitScrub.index < actual.index, `${key}: the scrub label precedes its input inside the row`);
}
export function assertParity(today, kit, where, names) {
  assert.deepEqual(pick(tag(kit, where, `kit ${JSON.stringify(where)}`), names), human(pick(tag(today, where, `today ${JSON.stringify(where)}`), names)), JSON.stringify(where));
}
/** A switch: the same state and hooks, and a visible name that contains today's (label in name, WCAG 2.5.3). */
export function assertSwitchParity(today, kit, where, names = ['type', 'role', 'checked'], {name = true} = {}) {
  assertParity(today, kit, where, names);
  if (!name) return;
  const before = nameOf(today, where), after = nameOf(kit, where);
  assert.ok(after.includes(before), `${JSON.stringify(where)}: "${after}" names "${before}"`);
}
export const assertOptions = (today, kit, where) => assert.deepEqual(options(kit, where), options(today, where), `${JSON.stringify(where)} options`);
export function assertNoKeyState(html) {
  for (const hook of ['data-property-key', 'data-property-nav', 'property-key-controls', 'ui-key', 'data-icon="diamond"'])
    assert.ok(!html.includes(hook), `the inspector shows no key state (${hook})`);
}
/** Only controls whose browser tests still read `title` keep one; everything else uses the one tooltip. */
export function assertNoTitles(html, allowed = []) {
  const titled = tags(html).filter(entry => 'title' in entry.attrs).map(entry => entry.attrs['data-action'] ?? entry.attrs.id ?? entry.tag);
  assert.deepEqual(titled, allowed, 'no native titles beside the tooltip');
}
