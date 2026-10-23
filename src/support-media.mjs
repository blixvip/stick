import {messageError} from './localized-error.mjs';
import { SUPPORT_LIMITS, supportFileType } from './support-contract.mjs';

// Preparation is local and sequential. Never upload originals as a compression fallback.
export async function prepareSupportFile(file, { signal, progress = () => {} } = {}) {
  signal?.throwIfAborted();
  const mime = supportFileType(file.name);
  if (!mime || !file.size) throw messageError(new Error(''), "errors.supportMedia.invalidFile", {});
  if (mime.startsWith('image/')) return compressImage(file, signal);
  if (mime.startsWith('video/')) return compressVideo(file, { signal, progress });
  if (file.size > SUPPORT_LIMITS.fileBytes) throw messageError(new Error(''), "errors.supportMedia.invalidFile", {});
  return file;
}

async function compressImage(file, signal) {
  if (file.size > 32 * 1024 * 1024) throw messageError(new Error(''), "errors.supportMedia.mediaSourceLarge", {});
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw messageError(new Error(''), "errors.supportMedia.mediaDecodeFailed", {}); }
  try {
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > 32 * 1024 * 1024 || Math.max(bitmap.width, bitmap.height) > 16384) throw messageError(new Error(''), "errors.supportMedia.mediaSourceLarge", {});
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
    signal?.throwIfAborted();
    if (scale === 1 && file.size <= SUPPORT_LIMITS.imageBytes && blob.size >= file.size) return file;
    if (blob.size > SUPPORT_LIMITS.imageBytes) throw messageError(new Error(''), "errors.supportMedia.mediaOutputLarge", {});
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: blob.type });
  } finally { bitmap.close(); }
}

async function compressVideo(file, { signal, progress }) {
  if (file.size > 100 * 1024 * 1024) throw messageError(new Error(''), "errors.supportMedia.mediaSourceLarge", {});
  // Already compact clips need no lossy second encode.
  if (file.size <= 2 * 1024 * 1024) return file;
  const video = document.createElement('video'), url = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  let timer, drawTimer, recorder, stream, captured;
  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(messageError(new Error(''), "errors.supportMedia.mediaDecodeFailed", {}));
      video.onloadeddata = resolve; video.onerror = fail;
      timer = setTimeout(fail, 15000); video.src = url;
    });
    clearTimeout(timer); signal?.throwIfAborted();
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 60) {
      if (file.size <= SUPPORT_LIMITS.fileBytes) return file;
      throw messageError(new Error(''), "errors.supportMedia.videoTooLong", {});
    }
    const format = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'].find(type => globalThis.MediaRecorder?.isTypeSupported(type));
    if (!format || !video.captureStream || !HTMLCanvasElement.prototype.captureStream) {
      if (file.size <= SUPPORT_LIMITS.fileBytes) return file;
      throw messageError(new Error(''), "errors.supportMedia.videoCompressionUnavailable", {});
    }
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(2, Math.round(video.videoWidth * scale)); canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    stream = canvas.captureStream(30); captured = video.captureStream();
    for (const track of captured.getAudioTracks()) stream.addTrack(track);
    recorder = new MediaRecorder(stream, { mimeType: format, videoBitsPerSecond: 650000, audioBitsPerSecond: 64000 });
    const chunks = []; let bytes = 0;
    const blob = await new Promise((resolve, reject) => {
      let failed = false;
      const fail = error => { failed = true; reject(error); };
      const abort = () => fail(messageError(new DOMException('', 'AbortError'), "errors.supportMedia.cancelled", {}));
      signal?.addEventListener('abort', abort, { once: true });
      recorder.ondataavailable = event => {
        bytes += event.data.size;
        if (bytes > SUPPORT_LIMITS.fileBytes) fail(messageError(new Error(''), "errors.supportMedia.mediaOutputLarge", {}));
        else chunks.push(event.data);
      };
      recorder.onerror = () => fail(messageError(new Error(''), "errors.supportMedia.mediaDecodeFailed", {}));
      recorder.onstop = () => { signal?.removeEventListener('abort', abort); if (!failed) resolve(new Blob(chunks, { type: 'video/webm' })); };
      video.onended = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      video.onerror = () => fail(messageError(new Error(''), "errors.supportMedia.mediaDecodeFailed", {}));
      timer = setTimeout(() => fail(messageError(new Error(''), "errors.supportMedia.mediaDecodeFailed", {})), 75000);
      drawTimer = setInterval(() => { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); progress(Math.min(99, Math.round(video.currentTime / video.duration * 100))); }, 1000 / 30);
      recorder.start(250); video.play().catch(() => fail(messageError(new Error(''), "errors.supportMedia.mediaDecodeFailed", {})));
    });
    signal?.throwIfAborted();
    if (!blob.size || blob.size > SUPPORT_LIMITS.fileBytes) throw messageError(new Error(''), "errors.supportMedia.mediaOutputLarge", {});
    return blob.size < file.size ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webm', { type: blob.type }) : file;
  } finally {
    clearTimeout(timer); clearInterval(drawTimer); video.pause();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    for (const track of [...(stream?.getTracks() || []), ...(captured?.getTracks() || [])]) track.stop();
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
  }
}
