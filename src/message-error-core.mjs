/** Pure diagnostic construction, also bundled into Electron's sandboxed preload. */
export function diagnosticError(error, source, messageKey, messageParams = {}) {
  if (typeof source !== 'string') throw new TypeError(`Unknown error message: ${messageKey}`);
  messageParams = Object.fromEntries(Object.entries(messageParams).map(([name, value]) => {
    // Only an explicit scalar diagnostic value can accompany a display reference.
    // Original English diagnostics remain stable through worker/IPC round trips.
    if (value && typeof value.messageKey === 'string' && Object.hasOwn(value, 'diagnosticValue'))
      return [name, {messageKey:value.messageKey, diagnosticValue:String(value.diagnosticValue),
        ...(value.messageParams ? {messageParams:Object.fromEntries(Object.entries(value.messageParams).map(([key, scalar]) => [key, typeof scalar === 'number' && Number.isFinite(scalar) ? scalar : String(scalar)]))} : {})}];
    return [name, typeof value === 'number' && Number.isFinite(value) ? value : String(value)];
  }));
  const message = source.replace(/\{([A-Za-z]\w*)\}/g, (token, name) => Object.hasOwn(messageParams, name) ? String(messageParams[name]?.diagnosticValue ?? messageParams[name]) : token);
  Object.defineProperty(error, 'message', {value: message, configurable: true, writable: true});
  error.messageKey = messageKey;
  error.messageParams = messageParams;
  return error;
}
