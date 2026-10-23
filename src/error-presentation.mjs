import {localizedText, clearTranslation} from './localization-bindings.mjs';
import {interfaceLocalization} from './localization.mjs';
export function errorText(error) {
  return typeof error?.messageKey === 'string'
    ? interfaceLocalization.t(error.messageKey, error.messageParams)
    : error?.message || String(error);
}

/** Bind owned failures while preserving verbatim external diagnostic details. */
export function presentError(element, error) {
  if (error?.messageKey) localizedText(element, error.messageKey, error.messageParams);
  else { clearTranslation(element); const text = errorText(error); if (element.textContent !== text) element.textContent = text; }
}
