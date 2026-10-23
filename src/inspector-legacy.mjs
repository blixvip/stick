import {messageAttributes} from './localization-bindings.mjs';
/**
 * Today's inspector primitives, for the one sub-module that still builds its
 * inspector as HTML with them: drawing-view.mjs (Draw's tools), which
 * inspector-view.mjs hands numericField, group, grid, heading and esc until
 * Draw moves to descriptors (M7b). Every other context renders with the
 * inspector kit (src/inspector-kit.mjs).
 */
import {icon} from './icons.mjs';
import {formatPropertyValue} from './property-controls.mjs';
import {escapeHTML as esc} from './inspector-kit.mjs';

export {esc};

const animatedProperties = new Set([
  'scale', 'figure_opacity', 'figure_z_order', 'thickness', 'segment_opacity', 'segment_gradient_opacity',
  'camera_x', 'camera_y', 'camera_scale', 'camera_angle',
]);
const integerProperties = new Set(['fps', 'canvas_width', 'canvas_height', 'duration']);
/** The decimals a property edits with: none for counts, sizes, rates and draw orders, three otherwise. */
export const propertyPrecision = key => (integerProperties.has(key) || key.endsWith('_z_order') ? 0 : 3);

/** A PropertyControls number row in today's markup (the full-width row for animatable properties). */
export function numericField(label, key, value, unit = '', limits = '', state = {}, options = {}) {
  const animated = options.animated ?? animatedProperties.has(key),
    precision = propertyPrecision(key),
    // At rest, show readable values (456.4 px, 3.2°); focus reveals full precision.
    restPrecision = precision && (unit ? 1 : 2);
  value = state?.value ?? value;
  const description = options.description || `${label}${unit ? ` (${unit})` : ''}`;
  const labelRef = options.labelKey ? {messageKey:options.labelKey,messageParams:options.labelParams} : null;
  const descriptionRef = labelRef && !options.description ? unit ? {messageKey:'inspector.withUnit',messageParams:{label:labelRef,unit:unit==='°'?{messageKey:'inspector.unit.degrees'}:unit}} : labelRef : null;
  return `<div class="property-row${animated ? ' is-animatable' : options.wide ? ' is-wide' : ''}" data-property-row="${key}"><label class="field"><span class="property-scrub" data-property-scrub tabindex="0" role="button" aria-label="Scrub ${esc(description)}" title="Drag to adjust · Shift: fine · Alt: extra fine" ${messageAttributes("inspectorLegacy.scrub", {description: descriptionRef ?? description}, "aria-label")} data-i18n-title="inspectorLegacy.dragToAdjustShiftFineAltExtraFine"><span ${labelRef ? messageAttributes(labelRef.messageKey,labelRef.messageParams) : ''}>${label}</span></span><input type="number" ${options.id ? `id="${options.id}"` : ''} ${options.legacyField === false ? '' : `data-field="${key}"`} data-property="${key}" data-property-value="${esc(value)}" data-property-precision="${precision}" data-property-display-precision="${restPrecision}" data-property-step="1" value="${formatPropertyValue(value, restPrecision)}" step="any" aria-label="${esc(description)}" ${descriptionRef ? messageAttributes(descriptionRef.messageKey,descriptionRef.messageParams,'aria-label') : ''} ${limits}><small>${unit}</small></label></div>`;
}
export const heading = (title, symbol, {titleKey,titleParams} = {}) =>
  `<div class="property-context-heading"><span>${icon(symbol)}</span><div><strong ${titleKey ? messageAttributes(titleKey,titleParams) : ''}>${esc(title)}</strong></div></div>`;
const secondarySections = new Set(['Connections', 'Polygons', 'Canvas alignment', 'Neighboring pose', 'Color palette']);
export const group = (title, body, extra = '', {titleKey,titleParams} = {}) => secondarySections.has(title)
  ? `<details class="inspector-section inspector-disclosure" data-section="${esc(title)}"><summary class="inspector-title"><span ${titleKey ? messageAttributes(titleKey,titleParams) : ''}>${title}</span>${extra}</summary><div class="inspector-disclosure-body">${body}</div></details>`
  : `<section class="inspector-section"><div class="inspector-title"><span ${titleKey ? messageAttributes(titleKey,titleParams) : ''}>${title}</span>${extra}</div>${body}</section>`;
export const grid = body => `<div class="field-grid">${body}</div>`;
