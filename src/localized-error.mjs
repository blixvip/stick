import english from './locales/en.mjs';
import {diagnosticError} from './message-error-core.mjs';

/** Error identity and diagnostic English stay stable across workers and IPC.
 * Presentation translates the attached message key and scalar or explicit display-reference parameters. */
export function messageError(error, messageKey, messageParams = {}) {
  return diagnosticError(error, english[messageKey], messageKey, messageParams);
}

export function restoreMessageError(error, data) {
  if (typeof data?.messageKey === 'string' && Object.hasOwn(english, data.messageKey)) return messageError(error, data.messageKey, data.messageParams);
  return error;
}

export function errorMessageData(error) {
  return error?.messageKey ? {messageKey: error.messageKey, messageParams: error.messageParams} : {};
}
