import {restoreMessageError, messageError} from './localized-error.mjs';

/** Genuine installed Windows codecs, distinct from bundled FFmpeg encoders. */
import {EXPORT_MAX_PIXELS} from './export-sampling.mjs';
// The native VFW helper enforces this bound in compiled code; keep them in sync.
const MAX_BYTES = 256 * 1024 * 1024;
const cancelled = () => messageError(new DOMException('', 'AbortError'), "errors.vfwVideoExport.windowsVideoExportCancelled", {});
export async function getVfwCapabilities(options = {}, desktop = globalThis.stykDesktop) {
  if (typeof desktop?.getVfwCapabilities !== 'function') return {available: false, codecs: [], reason: 'Installed Video for Windows codecs require the Windows desktop app.',reasonKey:'desktop.vfwExportService.errors.installedVideoForWindowsCodecsAreAvailableOnlyInTheWindowsDesktopApp'};
  return desktop.getVfwCapabilities(options);
}
export async function configureVfwCodec(options, desktop = globalThis.stykDesktop) {
  if (typeof desktop?.configureVfwCodec !== 'function') throw messageError(new Error(''), "errors.vfwVideoExport.codecConfigurationRequiresTheWindowsDesktopApp", {});
  return desktop.configureVfwCodec(options);
}
export async function encodeVfwVideo({codecId, width, height, fps, totalFrames, renderFrame, quality = .9, keyframeEvery = 0, bitrate = 0, configurationId,
  signal, onProgress, maxBytes = MAX_BYTES, desktop = globalThis.stykDesktop, timeoutMs = 120000, sink, save}) {
  if (!/^vfw:(x86|x64):[0-9a-f]{8}$/i.test(codecId ?? '')) throw messageError(new Error(''), "errors.vfwVideoExport.chooseAnInstalledWindowsVideoCodec", {});
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > EXPORT_MAX_PIXELS) throw messageError(new Error(''), "errors.vfwVideoExport.windowsVideoSupportsUpToMillionPixelsPer", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)});
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000 || !Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 1000000) throw messageError(new Error(''), "errors.nativeVideoExport.chooseAValidVideoFrameRateAndFrame", {});
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw messageError(new Error(''), "errors.nativeVideoExport.videoQualityMustBeBetweenZeroAndOne", {});
  if (!Number.isInteger(keyframeEvery) || keyframeEvery < 0 || keyframeEvery > 1000000 || !Number.isInteger(bitrate) || bitrate < 0 || bitrate > 200000000) throw messageError(new Error(''), "errors.vfwVideoExport.chooseAValidCodecKeyframeIntervalAndBitrate", {});
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw messageError(new Error(''), "errors.vfwVideoExport.windowsVideoMustBeLimitedToBetween1", {});
  if (typeof renderFrame !== 'function') throw messageError(new Error(''), "errors.vfwVideoExport.windowsVideoExportNeedsAFrameRenderer", {});
  for (const method of ['beginVfwExport', 'beginVfwFrame', 'writeVfwChunk', 'endVfwFrame', 'finishVfwExport', 'readVfwChunk', 'cancelVfwExport']) if (typeof desktop?.[method] !== 'function') throw messageError(new Error(''), "errors.vfwVideoExport.installedWindowsCodecsRequireTheStykanimateWindowsDesktop", {});
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw messageError(new Error(''), "errors.vfwVideoExport.windowsVideoExportNeedsWorkerCanvasSupport", {});
  if (signal?.aborted) throw cancelled();
  const worker = new Worker(new URL('./vfw-frame-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate Windows video frames'});
  let pending, sequence = 0, failure, transfer, cancellation, completed = false;
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const fail = error => { failure = error; clearTimeout(pending?.timer); pending?.reject(error); pending = null; worker.terminate(); };
  worker.addEventListener('error', event => { event.preventDefault(); fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.vfwVideoExport.theWindowsVideoWorkerStopped"))); });
  worker.addEventListener('messageerror', () => fail(messageError(new Error(''), "errors.vfwVideoExport.aWindowsVideoFrameCouldNotBeTransferred", {})));
  worker.addEventListener('message', ({data}) => { if (data?.id !== pending?.id) return; const request = pending; pending = null; clearTimeout(request.timer); data.ok ? request.resolve(data.blob) : request.reject(restoreMessageError((data.error ? new Error(data.error) : messageError(new Error(''), "errors.vfwVideoExport.windowsVideoConversionFailed")), data)); });
  const request = (operation, fields = {}, transfers = []) => { check(); return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => fail(messageError(new Error(''), "errors.vfwVideoExport.windowsVideoFrameConversionTimedOutExportStopped", {})), timeoutMs);
    pending = {id, resolve, reject, timer};
    try { worker.postMessage({id, operation, ...fields}, transfers); } catch (error) { clearTimeout(timer); pending = null; reject(error); }
  }); };
  const abort = () => { fail(cancelled()); if (transfer) cancellation = desktop.cancelVfwExport(transfer.token).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    transfer = await desktop.beginVfwExport({codecId, width, height, fps, totalFrames, quality, keyframeEvery, bitrate, configurationId}); check();
    if (!transfer?.token || transfer.frameBytes !== Math.ceil(width * 3 / 4) * 4 * height) throw messageError(new Error(''), "errors.vfwVideoExport.theWindowsCodecReturnedInvalidFrameDimensions", {});
    const chunkSize = Math.min(256 * 1024, transfer.maxChunkBytes || 256 * 1024);
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw messageError(new Error(''), "errors.vfwVideoExport.invalidWindowsVideoTransferSize", {});
    await request('start', {width, height});
    for (let index = 0; index < totalFrames; index++) {
      check(); const canvas = await renderFrame(index); check();
      if (!canvas || canvas.width !== width || canvas.height !== height) throw messageError(new Error(''), "errors.vfwVideoExport.renderedWindowsVideoFrameHasTheWrongDimensions", {value: index + 1});
      const bitmap = await createImageBitmap(canvas); let frame;
      try { frame = await request('frame', {bitmap}, [bitmap]); } finally { bitmap.close(); }
      check(); if (frame.size !== transfer.frameBytes) throw messageError(new Error(''), "errors.vfwVideoExport.theConvertedWindowsVideoFrameHasTheWrong", {});
      await desktop.beginVfwFrame(transfer.token, {index, size: frame.size});
      for (let offset = 0; offset < frame.size; offset += chunkSize) { check(); const bytes = await frame.slice(offset, offset + chunkSize).arrayBuffer(); check(); await desktop.writeVfwChunk(transfer.token, bytes); }
      check(); await desktop.endVfwFrame(transfer.token); check(); onProgress?.({completed: index + 1, total: totalFrames, progress: (index + 1) / totalFrames, phase: 'rendering'});
    }
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'encoding'});
    const encoded = await desktop.finishVfwExport(transfer.token); check();
    if (!Number.isSafeInteger(encoded?.size) || encoded.size < 256 || encoded.size > maxBytes) throw messageError(new Error(''), "errors.vfwVideoExport.theWindowsCodecReturnedAnEmptyOrOversized", {});
    if (save && typeof desktop.saveVfwExport === 'function') {
      // The encoded file already exists on disk in the main process; move it to
      // the chosen destination without piping bytes through the renderer. A
      // failed move keeps the reading session, so fall back to chunked
      // readback instead of losing the finished export.
      try {
        const result = await desktop.saveVfwExport(transfer.token, save);
        transfer = null; check();
        onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'complete'});
        return result?.saved ? {saved: true, path: result.path, size: result.size} : {saved: false};
      } catch (error) {
        if (failure) throw failure;
      }
    }
    const parts = sink ? null : []; let size = 0, done = false;
    while (!done) {
      check(); const chunk = await desktop.readVfwChunk(transfer.token); check(); const bytes = chunk?.bytes;
      if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw messageError(new Error(''), "errors.vfwVideoExport.theWindowsCodecReturnedAnInvalidOutputChunk", {});
      if ((!bytes.byteLength && !chunk.done) || bytes.byteLength > 256 * 1024) throw messageError(new Error(''), "errors.vfwVideoExport.theWindowsVideoOutputChunkIsInvalid", {});
      size += bytes.byteLength; if (size > encoded.size || size > maxBytes) throw messageError(new Error(''), "errors.vfwVideoExport.theWindowsVideoExceedsItsDeclaredSize", {});
      if (sink) await sink.write(bytes); else parts.push(new Blob([bytes]));
      done = Boolean(chunk.done);
    }
    if (size !== encoded.size) throw messageError(new Error(''), "errors.vfwVideoExport.theWindowsVideoOutputIsIncomplete", {});
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'complete'});
    if (sink) { const result = await sink.finish(); completed = true; return result; }
    const blob = new Blob(parts, {type: 'video/x-msvideo'}); return blob;
  } finally {
    clearTimeout(pending?.timer);
    signal?.removeEventListener('abort', abort); worker.terminate();
    if (transfer) await desktop.cancelVfwExport(transfer.token).catch(() => {});
    if (sink && !completed) await sink.abort();
    await cancellation;
  }
}
