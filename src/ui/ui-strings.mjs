export { messageText as kitText } from '../localization.mjs';

/** `t` from a localization object ({t(key, params)}) or a function; null when neither. */
export function translator(localization) {
  if (typeof localization === 'function') return localization;
  if (typeof localization?.t === 'function') return (key, params) => localization.t(key, params);
  return null;
}
