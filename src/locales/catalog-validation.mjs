/** Pure validation shared by generation, CI and translator tooling. */
export const placeholders = text => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]))].sort();
const categories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const own = (object, key) => Object.hasOwn(object, key);

export function validateCatalog(pack, english) {
  const {locale, messages} = pack ?? {};
  const errors = [], missing = [], incompletePlurals = [];
  const fail = (key, reason) => errors.push(`${key}: ${reason}`);
  let forms = ['other'];
  try {
    if (!locale || Intl.getCanonicalLocales(locale.id)[0] !== locale.id) throw Error();
    forms = new Intl.PluralRules(locale.id).resolvedOptions().pluralCategories;
    if (!['ltr', 'rtl'].includes(locale.direction) || ![locale.name, locale.nativeName].every(value => typeof value === 'string' && value.trim() && value.length <= 100 && !/[\u0000-\u001f<>]/.test(value))) throw Error();
    if (locale.aliases !== undefined && !Array.isArray(locale.aliases)) throw Error();
    for (const alias of locale.aliases ?? []) if (Intl.getCanonicalLocales(alias)[0] !== alias) throw Error();
  } catch { fail('locale', 'invalid ID, metadata or aliases'); }
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) return { errors: [...errors, 'messages: expected an object'], missing, incompletePlurals };
  const checkText = (key, text, expected) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 16384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) { fail(key, 'invalid plain text'); return; }
    if (/[{}]/.test(text.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''))) fail(key, 'malformed named placeholder');
    if (/<\/?[A-Za-z][^>]*>/.test(text)) fail(key, 'markup is not allowed');
    if (expected && JSON.stringify(placeholders(text)) !== JSON.stringify(expected)) fail(key, 'placeholders differ from English');
  };
  for (const [key, message] of Object.entries(messages)) {
    if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(key) || !own(english, key)) { fail(key, 'unknown key'); continue; }
    const source = english[key];
    if (typeof source === 'string') checkText(key, message, placeholders(source));
    else {
      if (!message || typeof message !== 'object' || Array.isArray(message) || !own(message, 'other')) { fail(key, 'plural message requires other'); continue; }
      for (const [category, text] of Object.entries(message)) {
        if (!categories.has(category) || !forms.includes(category)) fail(key, `invalid plural form ${category} for ${locale?.id}`);
        checkText(`${key}.${category}`, text, placeholders(source.other));
      }
      const absent = forms.filter(form => !own(message, form));
      if (absent.length) incompletePlurals.push({key, forms: absent});
    }
  }
  for (const key of Object.keys(english)) if (!own(messages, key)) missing.push(key);
  return { errors, missing, incompletePlurals };
}

/** JSON.parse alone silently accepts duplicate keys. Reject them before a
 * translator's accidentally repeated message can replace reviewed copy. */
export function parseLanguagePack(source) {
  if (typeof source !== 'string' || source.length > 1024 * 1024) throw new SyntaxError('Language pack exceeds the 1 MiB limit.');
  const token = /\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:])/gy;
  let current, offset = 0;
  const next = () => { token.lastIndex = offset; const match = token.exec(source); if (!match) throw new SyntaxError(`Invalid JSON at ${offset}.`); offset = token.lastIndex; return current = match[1]; };
  const value = (depth = 0) => {
    if (depth > 32) throw new SyntaxError('Language pack is too deeply nested.');
    if (current === '{') {
      const seen = new Set(); next();
      if (current === '}') return;
      while (true) {
        if (!current.startsWith('"')) throw new SyntaxError(`Expected a key at ${offset}.`);
        const key = JSON.parse(current);
        if (seen.has(key)) throw new SyntaxError(`Duplicate JSON key: ${key}.`);
        seen.add(key); next();
        if (current !== ':') throw new SyntaxError(`Expected a colon at ${offset}.`);
        next(); value(depth + 1); next();
        if (current === '}') return;
        if (current !== ',') throw new SyntaxError(`Expected a comma at ${offset}.`);
        next();
      }
    }
    if (current === '[') {
      next(); if (current === ']') return;
      while (true) {
        value(depth + 1); next();
        if (current === ']') return;
        if (current !== ',') throw new SyntaxError(`Expected an array comma at ${offset}.`);
        next();
      }
    }
    if (/^[}\],:]$/.test(current)) throw new SyntaxError(`Expected a value at ${offset}.`);
  };
  next(); value();
  if (source.slice(offset).trim()) throw new SyntaxError(`Unexpected JSON at ${offset}.`);
  return JSON.parse(source);
}

/** English feature ownership is exclusive; never silently shadow a key. */
export function mergeEnglishMessages(...catalogs) {
  const result = {};
  for (const catalog of catalogs) for (const [key, value] of Object.entries(catalog)) {
    if (Object.hasOwn(result, key)) throw new Error(`English message is defined twice: ${key}`);
    result[key] = value;
  }
  return Object.freeze(result);
}
