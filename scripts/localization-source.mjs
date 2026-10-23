import {readdir, readFile} from 'node:fs/promises';

// Check explicit static bindings without requiring a build-time parser package.
// Dynamic keys remain the owning feature's responsibility and are covered by
// behavioral tests. Context is generated from the same source scan for reviewers.
export function inspectMessageReferences(source, file, english) {
  const references = [], errors = [], seen = new Set();
  const add = (key, offset, required = false) => {
    if (!Object.hasOwn(english, key)) {
      if (required && !key.includes('${')) errors.push(`${file}:${source.slice(0, offset).split('\n').length}: unknown message ${key}`);
      return;
    }
    const line = source.slice(0, offset).split('\n').length;
    const identity = `${key}:${line}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const context = source.slice(source.lastIndexOf('\n', offset) + 1, source.indexOf('\n', offset) === -1 ? source.length : source.indexOf('\n', offset)).trim();
    references.push({key, file, line, context: context.length > 240 ? context.slice(0, 237) + '…' : context});
  };
  for (const match of source.matchAll(/(['"`])([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)\1/g)) add(match[2], match.index);
  const quote = String.raw`(?:\\?["'])`;
  const key = String.raw`([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)`;
  const patterns = [
    new RegExp(String.raw`\b(?:interfaceText|t|say|messageHTML|messageAttributes|nativeText|saySettings|sayTimeline)\(\s*${quote}${key}${quote}`, 'g'),
    new RegExp(String.raw`\b(?:labelKey|titleKey|descriptionKey|placeholderKey|closeLabelKey|ariaLabelKey|messageKey|textKey|tipKey|wordKey|tooltipKey|scopeKey|reasonKey|hintKey|bodyKey|shortKey|readyKey|wantsKey|confirmLabelKey|cancelLabelKey)\s*:\s*${quote}${key}${quote}`, 'g'),
    new RegExp(String.raw`data-i18n(?:-(?:title|aria-label|placeholder|alt|tooltip|hotkey-title|aria-description|aria-valuetext))?=${quote}${key}${quote}`, 'g'),
    new RegExp(String.raw`\b(?:localizedText|translatedElement)\([^;\n]*?,\s*${quote}${key}${quote}`, 'g'),
    new RegExp(String.raw`\blocalizedAttribute\([^;\n]*?,\s*${quote}(?:title|aria-label|placeholder|alt|aria-description|aria-valuetext|data-tooltip|data-hotkey-title)${quote}\s*,\s*${quote}${key}${quote}`, 'g'),
    /["'](errors\.[A-Za-z0-9.]+)["']/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) add(match[1], match.index, true);
  return {references, errors};
}

export async function inspectApplicationMessages(english) {
  const files = ['index.html'];
  const walk = async directory => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (['locales', 'styles'].includes(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (/\.(mjs|cjs)$/.test(file)) files.push(file);
    }
  };
  await walk('src'); await walk('desktop');
  const contexts = {}, errors = [];
  let references = 0;
  for (const file of files.sort()) {
    const report = inspectMessageReferences(await readFile(file, 'utf8'), file, english);
    errors.push(...report.errors);
    for (const {key, ...context} of report.references) {
      references++;
      (contexts[key] ??= []).push(context);
    }
  }
  return {errors, references, contexts: Object.fromEntries(Object.entries(contexts).sort(([a], [b]) => a.localeCompare(b, 'en')))};
}
