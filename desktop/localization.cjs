'use strict';
// Electron and browser use the same DOM-free catalog service and data packs.
const path = require('node:path');
const { existsSync } = require('node:fs');
const source = existsSync(path.join(__dirname, '..', 'src', 'localization.mjs'))
  ? path.join(__dirname, '..', 'src') : path.join(process.resourcesPath, 'web', 'src');
const { Localization, normalizeLocale } = require(path.join(source, 'localization.mjs'));
const { messageError } = require(path.join(source, 'localized-error.mjs'));
const { validationLabel } = require(path.join(source, 'validation-labels.mjs'));
const localization = new Localization();
module.exports = { validationLabel, localization, normalizeLocale, messageError, t: (key, params) => localization.t(key, params) };
