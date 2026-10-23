import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {normalizeEditorSettings} from '../src/settings.mjs';

const bootstrap = readFileSync(new URL('../src/theme-bootstrap.js', import.meta.url), 'utf8');
function boot(values = {}, desktop, dark = false) {
  const dataset = {}, meta = {};
  const window = desktop ? {stykDesktop:{getEditorSettings:desktop}} : {};
  window.matchMedia = () => ({matches:dark});
  runInNewContext(bootstrap, {
    window,
    document: {documentElement:{dataset}, querySelector:() => ({setAttribute:(key,value) => {meta[key]=value;}})},
    localStorage: {getItem:key => {if (values instanceof Error) throw values; return values[key] ?? null;}},
  });
  return {dataset,meta,window};
}

test('Legacy, malformed and missing theme settings default to system', () => {
  for (const theme of [undefined,null,'system','DARK',1,{},true])
    assert.equal(normalizeEditorSettings({theme}).theme,'system');
  assert.equal(normalizeEditorSettings({theme:'dark'}).theme,'dark');
  assert.equal(normalizeEditorSettings({theme:'light'}).theme,'light');
  assert.equal(normalizeEditorSettings(null).theme,'system');
});

test('System appearance is resolved during browser and native bootstrap', async () => {
  for (const values of [{}, new Error('Storage denied'), {'stykanimate.theme.v1':'system'}])
    assert.equal(boot(values, undefined, true).dataset.theme, 'dark');
  assert.equal(boot({'stykanimate.theme.v1':'light'}, undefined, true).dataset.theme, 'light');
  const result = boot({}, () => ({}), true);
  await result.window.stykInitialEditorSettings;
  assert.equal(result.dataset.theme, 'dark');
});

test('Browser bootstrap restores the saved appearance without waiting for modules', () => {
  for (const values of [
    {'stykanimate.theme.v1':'dark'},
    {'stykanimate.editor.settings.v1':'{"theme":"dark"}'},
  ]) {
    const {dataset,meta}=boot(values);
    assert.equal(dataset.theme,'dark');
    assert.equal(meta.content,'#0a0b0f');
  }
  for (const values of [{},new Error('Storage denied'),{'stykanimate.editor.settings.v1':'invalid'}])
    assert.equal(boot(values).dataset.theme,'light');
});

test('Native preferences win on a new backend origin before revealing the workspace', async () => {
  let resolve;
  const native = new Promise(done => {resolve=done;});
  const result=boot({}, () => native);
  assert.ok('themePending' in result.dataset);
  resolve({theme:'dark',locale:'it'});
  const settings=await result.window.stykInitialEditorSettings;
  assert.equal(settings.theme,'dark');
  assert.equal(result.dataset.theme,'dark');
  assert.equal(result.meta.content,'#0a0b0f');
  assert.ok(!('themePending' in result.dataset));
  const light=boot({'stykanimate.theme.v1':'dark'}, () => ({theme:'light'}));
  await light.window.stykInitialEditorSettings;
  assert.equal(light.dataset.theme,'light');
});

test('A native preference read failure cannot leave the workspace hidden', async () => {
  const result=boot({}, () => {throw new Error('IPC unavailable');});
  assert.equal(await result.window.stykInitialEditorSettings,undefined);
  assert.equal(result.dataset.theme,'light');
  assert.ok(!('themePending' in result.dataset));
});

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const tokens = source('src/styles/tokens.css');
/** Declarations (name → value) of the first rule with this selector, or of every one. */
function block(selector, every = false) {
  const declarations = new Map();
  for (let start = tokens.indexOf(`${selector} {`); start >= 0; start = every ? tokens.indexOf(`${selector} {`, start + 1) : -1) {
    const body = tokens.slice(start, tokens.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) declarations.set(name, value.trim());
  }
  assert.ok(declarations.size, `tokens.css has ${selector}`);
  return declarations;
}
const primitives = block(':root', true);
const resolve = (theme, name) => {
  const value = theme.get(name) ?? primitives.get(name);
  const reference = /^var\((--[\w-]+)\)$/.exec(value ?? '');
  return reference ? resolve(theme, reference[1]) : value;
};

test('Colours painted before the stylesheets load match the brand window colour', () => {
  const light = block(':root[data-theme="light"]'), dark = block(':root[data-theme="dark"]');
  const [lightField, darkField] = [resolve(light, '--surface-field'), resolve(dark, '--surface-field')];
  assert.deepEqual([lightField, darkField], ['#eceff4', '#0a0b0f']);
  assert.equal(resolve(new Map(), '--surface-prepaint'), darkField, 'the desktop editor is hidden on the dark window colour');
  for (const file of ['src/theme-bootstrap.js', 'src/theme.mjs'])
    assert.ok(source(file).includes(`'${darkField}' : '${lightField}'`), `${file} uses the brand theme colours`);
  assert.ok(source('index.html').includes(`<meta name="theme-color" content="${lightField}"`), 'index.html starts light');
  assert.ok(source('desktop/main.cjs').includes(`backgroundColor: '${darkField}'`), 'the desktop window stays dark until settings load');
});

test('Every legacy token name resolves to a brand token in both themes', () => {
  const bridge = source('src/styles/legacy-bridge.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  const references = [...bridge.matchAll(/var\((--[\w-]+)\)/g)].map(match => match[1]);
  const bridged = [...bridge.matchAll(/^\s*(--[\w-]+):/gm)].map(match => match[1]);
  assert.ok(bridged.length > 30 && references.length >= bridged.length, 'every bridged name reads a token');
  for (const name of references) assert.ok(declared.has(name), `${name} is defined in tokens.css`);
  assert.doesNotMatch(bridge, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'the bridge holds no colour literals');
});
