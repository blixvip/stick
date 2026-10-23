import {restoreMessageError, messageError} from './localized-error.mjs';

import {nativeFigureDocument} from './native-figure.mjs';

export function librarySnapshot(editor) {
  return structuredClone(nativeFigureDocument(editor.report, {figureUids: [...editor.selectedUids], sourceFrame: editor.selectionFrame, tick: editor.tick}));
}
export function libraryPreview(report) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('./library-preview-worker.mjs', import.meta.url), {type:'module'});
    const finish = (error, result) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(messageError(new Error(''), "errors.libraryFiles.theLibraryPreviewTimedOut", {})), 60000);
    worker.onerror = event => finish(new Error(event.message));
    worker.onmessage = async ({data}) => {
      if (data.error) return finish(restoreMessageError(new Error(data.error), data));
      const reader = new FileReader(); reader.onerror = () => finish(messageError(new Error(''), "errors.libraryFiles.couldNotEncodeThePreview", {}));
      reader.onload = () => finish(null, reader.result); reader.readAsDataURL(data.blob);
    };
    worker.postMessage({report, baseURL: location.href});
  });
}
/** The PNG a saved asset keeps as its preview (at most 320 px), made from any image the browser can show. */
export async function pngThumbnail(url, size = 320) {
  const image = new Image(); image.src = url; await image.decode();
  const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
export async function saveLibraryFile(desktop, blob, options) {
  const transfer = await desktop.beginLibrarySave({...options, size:blob.size});
  try {
    for (let offset = 0; offset < blob.size; offset += transfer.maxChunkBytes)
      await desktop.writeLibraryChunk(transfer.token, await blob.slice(offset, offset + transfer.maxChunkBytes).arrayBuffer());
    return await desktop.finishLibrarySave(transfer.token);
  } catch (error) { await desktop.cancelLibraryTransfer(transfer.token).catch(() => {}); throw error; }
}
export async function readLibraryFile(desktop, path, {signal} = {}) {
  signal?.throwIfAborted();
  const transfer = await desktop.beginLibraryRead(path), parts = []; let size = 0;
  try {
    for (;;) { signal?.throwIfAborted(); const part = await desktop.readLibraryChunk(transfer.token); signal?.throwIfAborted(); parts.push(part.bytes); size += part.bytes.byteLength; if (part.done) break; }
    if (size !== transfer.size) throw messageError(new Error(''), "errors.libraryFiles.theLibraryFileChangedWhileReading", {});
    return new File(parts, transfer.name);
  } finally { await desktop.cancelLibraryTransfer(transfer.token).catch(() => {}); }
}
