import {errorMessageData, messageError} from './localized-error.mjs';

import {rgbaToVfwBgr24} from './vfw-pixels.mjs';
import {exportContext, checkExportContext} from './export-canvas.mjs';
let canvas, context;
self.addEventListener('message', ({data}) => {
  try {
    if (data.operation === 'start') {
      if (canvas) canvas.width = canvas.height = 1;
      canvas = new OffscreenCanvas(data.width, data.height); context = exportContext(canvas);
      if (!context) throw messageError(new Error(''), "errors.vfwFrameWorker.theWindowsVideoFrameCanvasIsUnavailable", {});
      self.postMessage({id: data.id, ok: true}); return;
    }
    if (data.operation !== 'frame' || !context) throw messageError(new Error(''), "errors.vfwFrameWorker.theWindowsVideoFrameConverterWasNotInitialized", {});
    try {
      checkExportContext(context);
      if (data.bitmap.width !== canvas.width || data.bitmap.height !== canvas.height) throw messageError(new Error(''), "errors.vfwFrameWorker.theWindowsVideoFrameSizeChanged", {});
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(data.bitmap, 0, 0);
    } finally { data.bitmap?.close(); }
    const {bytes} = rgbaToVfwBgr24(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    checkExportContext(context);
    self.postMessage({id: data.id, ok: true, blob: new Blob([bytes], {type: 'application/octet-stream'})});
  } catch (error) {
    data.bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
    context = null;
    self.postMessage({id: data.id, ok: false, error: error?.message || String(error), ...errorMessageData(error)});
  }
});
