import {errorMessageData, messageError} from './localized-error.mjs';

/** Snapshot and PNG-compress one video frame off the UI thread. */
import {exportContext, checkExportContext} from './export-canvas.mjs';
let canvas, context, preserveAlpha;
self.addEventListener('message', async ({data}) => {
  try {
    if (data.operation === 'start') {
      preserveAlpha = data.preserveAlpha === true;
      if (canvas) canvas.width = canvas.height = 1;
      canvas = new OffscreenCanvas(data.width, data.height); context = exportContext(canvas);
      if (!context) throw messageError(new Error(''), "errors.nativeVideoFrameWorker.theVideoFrameCanvasIsUnavailable", {});
      self.postMessage({id: data.id, ok: true}); return;
    }
    if (data.operation !== 'frame' || !context) throw messageError(new Error(''), "errors.nativeVideoFrameWorker.theVideoFrameEncoderWasNotInitialized", {});
    try {
      checkExportContext(context);
      if (data.bitmap.width !== canvas.width || data.bitmap.height !== canvas.height) throw messageError(new Error(''), "errors.nativeVideoFrameWorker.theVideoFrameDimensionsChanged", {});
      // Pivot uses black behind transparent areas in video formats without alpha.
      // Native WebM keeps the original RGBA pixels for its separate alpha plane.
      context.clearRect(0,0,canvas.width,canvas.height);
      if (!preserveAlpha) { context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.drawImage(data.bitmap, 0, 0);
    } finally { data.bitmap?.close(); }
    const blob = await canvas.convertToBlob({type: 'image/png'});
    checkExportContext(context);
    if (blob.type !== 'image/png') throw messageError(new Error(''), "errors.exportFrameWorker.losslessVideoFrameEncodingIsUnavailable", {});
    self.postMessage({id: data.id, ok: true, blob});
  } catch (error) {
    data.bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
    context = null;
    self.postMessage({id: data.id, ok: false, error: error?.message || String(error), ...errorMessageData(error)});
  }
});
