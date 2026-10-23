import {restoreMessageError, messageError} from './localized-error.mjs';

/** Canvas -> worker PNG -> bounded native FFmpeg stream. No lossy intermediate. */
import {exportFormat} from './export-capabilities.mjs';
import {EXPORT_MAX_PIXELS} from './export-sampling.mjs';
const MAX_BYTES = 1024 * 1024 * 1024;
const cancelled = () => messageError(new DOMException('', 'AbortError'), "errors.audioEncode.videoExportCancelled", {});

export async function encodeNativeVideo({format, codec, width, height, fps, totalFrames, renderFrame, renderNativeFrame, quality = 0.9,
  bitrate, signal, onProgress, maxBytes = MAX_BYTES, desktop = globalThis.stykDesktop, timeoutMs = 120000, sink, save, audioChunks}) {
  if (!['webm', 'mp4', 'avi', 'wmv'].includes(format)) throw messageError(new Error(''), "errors.nativeVideoExport.chooseWebmMp4AviOrWmvForNative", {});
  if (codec !== undefined && !{webm:['vp9'],mp4:['h264','mpeg4'],avi:['mpeg4','ffv1','rawvideo'],wmv:['wmv2']}[format].includes(codec)) throw messageError(new Error(''), "errors.nativeVideoExport.chooseASupportedCodecForThisVideoFormat", {});
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > EXPORT_MAX_PIXELS) throw messageError(new Error(''), "errors.nativeVideoExport.nativeVideoSupportsUpToMillionPixelsPer", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)});
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000 || !Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 1000000) throw messageError(new Error(''), "errors.nativeVideoExport.chooseAValidVideoFrameRateAndFrame", {});
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw messageError(new Error(''), "errors.nativeVideoExport.videoQualityMustBeBetweenZeroAndOne", {});
  if (bitrate !== undefined && (!Number.isFinite(bitrate) || bitrate < 1000 || bitrate > 200e6)) throw messageError(new Error(''), "errors.nativeVideoExport.videoBitrateMustBeBetween1KbitS", {});
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw messageError(new Error(''), "errors.nativeVideoExport.nativeVideoSizeMustBeLimitedToBetween", {});
  const directFrames = typeof renderNativeFrame === 'function';
  if (!directFrames && typeof renderFrame !== 'function') throw messageError(new Error(''), "errors.nativeVideoExport.nativeVideoExportNeedsAFrameRenderer", {});
  for (const method of ['beginVideoExport', 'beginVideoFrame', 'writeVideoChunk', 'endVideoFrame', 'finishVideoExport', 'readVideoChunk', 'cancelVideoExport'])
    if (typeof desktop?.[method] !== 'function') throw messageError(new Error(''), "errors.nativeVideoExport.thisVideoFormatRequiresTheStykanimateDesktopApp", {});
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw messageError(new Error(''), "errors.nativeVideoExport.nativeVideoExportNeedsWorkerCanvasSupport", {});
  if (signal?.aborted) throw cancelled();
  if (audioChunks && typeof desktop?.writeVideoAudioChunk !== 'function') throw messageError(new Error(''), "errors.nativeVideoExport.thisDesktopBuildDoesNotSupportAudioVideo", {});
  const worker = directFrames ? null : new Worker(new URL('./native-video-frame-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate native video frames'});
  let pending, sequence = 0, failure, transfer, cancellation, completed = false;
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const fail = error => { failure = error; clearTimeout(pending?.timer); pending?.reject(error); pending = null; worker?.terminate(); };
  worker?.addEventListener('error', event => { event.preventDefault(); fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.nativeVideoExport.theVideoFrameWorkerStopped"))); });
  worker?.addEventListener('messageerror', () => fail(messageError(new Error(''), "errors.nativeVideoExport.aVideoFrameCouldNotBeTransferred", {})));
  worker?.addEventListener('message', ({data}) => {
    if (data?.id !== pending?.id) return;
    const request = pending; pending = null;
    clearTimeout(request.timer);
    data.ok ? request.resolve(data.blob) : request.reject(restoreMessageError((data.error ? new Error(data.error) : messageError(new Error(''), "errors.nativeVideoExport.videoFrameEncodingFailed")), data));
  });
  const request = (operation, fields = {}, transfers = []) => {
    check(); return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => fail(messageError(new Error(''), "errors.nativeVideoExport.videoFrameEncodingTimedOutExportStoppedTry", {})), timeoutMs);
      pending = {id, resolve, reject, timer};
      try { worker.postMessage({id, operation, ...fields}, transfers); } catch (error) { clearTimeout(timer); pending = null; reject(error); }
    });
  };
  const abort = () => {
    fail(cancelled());
    if (transfer) cancellation = desktop.cancelVideoExport(transfer.token).catch(() => {});
  };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    transfer = await desktop.beginVideoExport({format, codec, width, height, fps, totalFrames, quality, bitrate, maxBytes, ...(audioChunks ? {audio:true} : {})});
    check();
    if (!transfer?.token) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeVideoEncoderDidNotStart", {});
    const chunkSize = Math.min(256 * 1024, transfer.maxChunkBytes || 256 * 1024);
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeVideoTransferSizeIsInvalid", {});
    if (audioChunks) {
      onProgress?.({completed:0,total:totalFrames,progress:0,phase:'mixing audio'});
      for await (const pcm of audioChunks) { check(); await desktop.writeVideoAudioChunk(transfer.token, pcm); }
      check();
    }
    if (worker) await request('start', {width, height,preserveAlpha:format==='webm'});
    for (let index = 0; index < totalFrames; index++) {
      check(); let png;
      if (directFrames) {
        const frame = await renderNativeFrame(index); check();
        if (frame?.width !== width || frame?.height !== height || !(frame.blob instanceof Blob) || frame.blob.type !== 'image/png' || !frame.blob.size)
          throw messageError(new Error(''), "errors.nativeVideoExport.renderedVideoFrameIsIncomplete", {value: index + 1});
        png = frame.blob;
      } else {
        const canvas = await renderFrame(index); check();
        if (!canvas || canvas.width !== width || canvas.height !== height) throw messageError(new Error(''), "errors.nativeVideoExport.renderedVideoFrameHasTheWrongDimensions", {value: index + 1});
        const bitmap = await createImageBitmap(canvas);
        try { png = await request('frame', {bitmap}, [bitmap]); } finally { bitmap.close(); }
      }
      check(); await desktop.beginVideoFrame(transfer.token, {index, size: png.size});
      for (let offset = 0; offset < png.size; offset += chunkSize) {
        check(); const bytes = await png.slice(offset, offset + chunkSize).arrayBuffer(); check();
        await desktop.writeVideoChunk(transfer.token, bytes);
      }
      check(); await desktop.endVideoFrame(transfer.token);
      check(); onProgress?.({completed: index + 1, total: totalFrames, progress: (index + 1) / totalFrames, phase: 'rendering'});
    }
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'encoding'});
    const encoded = await desktop.finishVideoExport(transfer.token); check();
    if (!Number.isSafeInteger(encoded?.size) || encoded.size < 1 || encoded.size > maxBytes) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeVideoFileHasAnInvalidSize", {});
    if (save && typeof desktop.saveVideoExport === 'function') {
      // The encoded file already exists on disk in the main process; move it to
      // the chosen destination without piping bytes through the renderer. A
      // failed move keeps the reading session, so fall back to chunked
      // readback instead of losing the finished export.
      try {
        const result = await desktop.saveVideoExport(transfer.token, save);
        transfer = null;
        check();
        onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'complete'});
        return result?.saved ? {saved: true, path: result.path, size: result.size} : {saved: false};
      } catch (error) {
        if (failure) throw failure;
      }
    }
    let size = 0, done = false;
    const parts = sink ? null : [];
    while (!done) {
      check(); const chunk = await desktop.readVideoChunk(transfer.token); check();
      const bytes = chunk?.bytes;
      if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeEncoderReturnedAnInvalidOutputChunk", {});
      if (!bytes.byteLength && !chunk.done) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeVideoOutputStoppedBeforeCompletion", {});
      size += bytes.byteLength;
      if (size > encoded.size || size > maxBytes) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeVideoExceedsItsDeclaredFileSize", {});
      if (sink) await sink.write(bytes);
      // Blob parts can spill to Chromium's backing store. Do not retain the
      // entire encoded file as JS ArrayBuffers while the renderer is alive.
      else parts.push(new Blob([bytes]));
      done = Boolean(chunk.done);
    }
    if (size !== encoded.size) throw messageError(new Error(''), "errors.nativeVideoExport.theNativeVideoOutputIsIncomplete", {});
    transfer = null;
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'complete'});
    if (sink) { const result = await sink.finish(); completed = true; return result; }
    const description = exportFormat(format), blob = new Blob(parts, {type: description.mimeType});
    return blob;
  } finally {
    clearTimeout(pending?.timer);
    signal?.removeEventListener('abort', abort); worker?.terminate();
    if (transfer) await desktop.cancelVideoExport(transfer.token).catch(() => {});
    if (sink && !completed) await sink.abort();
    await cancellation;
  }
}
