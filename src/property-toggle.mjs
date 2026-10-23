import {icon} from './icons.mjs';
import {messageAttributes} from './localization-bindings.mjs';

/** Native, keyboard-operable toggles with a full-row pointer target.
 * Labels and attributes are supplied by the inspector, never document data. */
export function propertyToggle(id, label, checked, symbol, {title = label, controls, attrs = '', labelKey, labelParams, titleKey, titleParams} = {}) {
  return `<label class="property-toggle" title="${title}" ${titleKey ? messageAttributes(titleKey,titleParams,'title') : ''}><input type="checkbox" role="switch" id="${id}" aria-label="${label}" ${labelKey ? messageAttributes(labelKey,labelParams,'aria-label') : ''} ${checked ? 'checked' : ''}${controls ? ` aria-controls="${controls}"` : ''}${attrs ? ` ${attrs}` : ''}><span class="property-toggle-label">${icon(symbol)}<span ${labelKey ? messageAttributes(labelKey,labelParams) : ''}>${label}</span>${controls ? `<span class="property-toggle-disclosure" aria-hidden="true">${icon('chevron-right')}</span>` : ''}</span><span class="property-toggle-track" aria-hidden="true"></span></label>`;
}
