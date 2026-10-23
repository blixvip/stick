import {messageError} from './localized-error.mjs';

/** Handle detail is presentation metadata. The editor preference never becomes
 * a pose channel, changes a figure definition, or enters undo history. */
const details = new WeakMap();
export const rigControlIsDetail = segment => segment?._stykControl?.level === 'detail';
export const rigDetailsShown = editor => details.get(editor) === true;
export function setRigDetailsShown(editor, shown) { details.set(editor, Boolean(shown)); }

export function validateControlMetadata(segment) {
  const control = segment._stykControl;
  if (control === undefined) return;
  if (!control || typeof control !== 'object' || Array.isArray(control) ||
      Object.keys(control).some(key => key !== 'level') || control.level !== 'detail')
    throw messageError(new Error(''), 'errors.rigConstraints.invalidRigBehavior', {});
}
