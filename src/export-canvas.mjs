import {messageError} from './localized-error.mjs';
/** A lost 2D context may accept no-op draws; never encode those as valid frames. */
const lostCanvases = new WeakSet(), watched = new WeakSet();
export function checkExportContext(context) {
  if (!context || lostCanvases.has(context.canvas) || context.isContextLost?.()) {
    const error = messageError(new Error(''), "errors.exportCanvas.theExportCanvasBecameUnavailableExportStoppedBefore", {});
    error.code = 'export_canvas_lost'; throw error;
  }
  return context;
}
export function exportContext(canvas) {
  if (!watched.has(canvas)) {
    watched.add(canvas);
    canvas.addEventListener?.('contextlost', () => lostCanvases.add(canvas));
  }
  return checkExportContext(canvas.getContext('2d', {willReadFrequently: true}));
}
