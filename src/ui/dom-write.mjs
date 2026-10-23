import {localizedMarkup, clearTranslation} from '../localization-bindings.mjs';
/**
 * Compare-before-write DOM helpers (architecture.md §3.2). Chrome that is
 * updated often writes through these, so writing what an element already
 * shows never touches the DOM: no mutation record, no style invalidation, no
 * lost caret in a field. The comparison reads the element's current value
 * (text, attribute, class, property: none of them forces layout), so a write
 * by any other code is seen too. Each helper returns true when it wrote.
 *
 * DOM-free at import; every helper takes the element and ignores null.
 */

/** Sets the element's text when it differs. An element that shows one text node
 * keeps it and rewrites its data: assigning textContent removes and inserts a
 * node, which makes the browser re-evaluate every :has() rule and restyle much
 * of the chrome. Readouts updated on each playback tick made that cost a
 * millisecond-scale style recalculation per frame. */
export function setText(element, text) {
  if (!element) return false;
  clearTranslation(element);
  const value = String(text ?? '');
  if (element.textContent === value) return false;
  const node = element.firstChild;
  if (value !== '' && node && node.nodeType === 3 && node === element.lastChild) node.data = value;
  else element.textContent = value;
  return true;
}

/** Sets an attribute when it differs; null, undefined and false remove it, true sets it empty. */
export function setAttr(element, name, value) {
  if (!element) return false;
  clearTranslation(element, name);
  if (value === null || value === undefined || value === false) {
    if (!element.hasAttribute(name)) return false;
    element.removeAttribute(name);
    return true;
  }
  const text = value === true ? '' : String(value);
  if (element.getAttribute(name) === text) return false;
  element.setAttribute(name, text);
  return true;
}

/** Adds or removes a class when it differs. */
export function setFlag(element, className, on) {
  if (!element || element.classList.contains(className) === Boolean(on)) return false;
  element.classList.toggle(className, Boolean(on));
  return true;
}

/** Shows or hides the element (the `hidden` attribute) when it differs. */
export function setHidden(element, hidden) {
  if (!element || element.hidden === Boolean(hidden)) return false;
  element.hidden = Boolean(hidden);
  return true;
}

/** Sets a property (an input's `value`, `disabled`, `checked`, `title`) when it differs. */
export function setProp(element, name, value) {
  if (!element || element[name] === value) return false;
  element[name] = value;
  return true;
}

/** Sets a CSS custom property on the element's inline style when it differs; null removes it. */
export function setVar(element, name, value) {
  if (!element) return false;
  const text = value === null || value === undefined ? '' : String(value);
  if (element.style.getPropertyValue(name) === text) return false;
  if (text) element.style.setProperty(name, text);
  else element.style.removeProperty(name);
  return true;
}

const markup = new WeakMap();
/**
 * Replaces the element's children with `html` (trusted markup built by the
 * app) unless the last markup written here is the same. Serialized markup
 * rarely reads back as the string that made it, so this one compares with
 * what it wrote last; use it only for elements nothing else writes.
 */
export function setMarkup(element, html) {
  if (!element) return false;
  const value = String(html ?? '');
  if (markup.get(element) === value) return false;
  localizedMarkup(element, value);
  markup.set(element, value);
  return true;
}
