import {messageError} from './localized-error.mjs';
/** One-use native import handoff. Never part of the editable document or history. */
import {materializeNativeFrames} from './import-wire.mjs';
export const MAX_NATIVE_PLAYBACK_BYTES = 64 * 1024 * 1024;
export const NATIVE_PLAYBACK_CHUNK_BYTES = 1024 * 1024;

export function nativePlaybackSnapshot(document, buffer, offset, meta, poseBytesEstimate) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_NATIVE_PLAYBACK_BYTES ||
      !Number.isSafeInteger(offset) || offset < 0 || buffer.byteLength - offset < 4 ||
      meta?.version !== 1 || meta.byteLength !== buffer.byteLength - offset ||
      !Number.isSafeInteger(meta.sourceOffset) || meta.sourceOffset < 0 || document?.version !== 5)
    return null;
  const frames = document.keyframes;
  // Editor loading creates a private working pose for a zero-frame import.
  // That normalization cannot be reconstructed from the original frame table.
  if (!Array.isArray(frames) || !frames.length || new DataView(buffer, offset).getUint32(0, true) !== frames.length)
    return null;
  return {buffer, offset, meta: {...meta}, frames,
    poseBytesEstimate: Number.isSafeInteger(poseBytesEstimate) && poseBytesEstimate >= 0
      ? poseBytesEstimate : meta.byteLength * 16 + frames.length * 512};
}

export function* nativePlaybackChunks(snapshot) {
  for (let position = 0; position < snapshot.meta.byteLength; position += NATIVE_PLAYBACK_CHUNK_BYTES) {
    const end = Math.min(snapshot.meta.byteLength, position + NATIVE_PLAYBACK_CHUNK_BYTES);
    // Copy only a bounded frame-table slice. Cloning a view of the full import
    // buffer would also clone its JSON/media header on every worker boundary.
    yield {position, buffer: snapshot.buffer.slice(snapshot.offset + position, snapshot.offset + end),
      ...(position === 0 ? {meta: snapshot.meta} : {})};
  }
}

export async function materializePlaybackSnapshot(report, {bytes, meta, position}, options) {
  if(position !== bytes.byteLength) throw messageError(new Error(''), "errors.playbackNative.incompleteNativeSnapshot", {});
  const frames = report.keyframes;
  await materializeNativeFrames({document:report, nativeFrames:meta}, bytes.buffer, 0, options);
  if(report.keyframes.length !== frames.length) throw messageError(new Error(''), "errors.playbackNative.nativeSnapshotFrameCountChanged", {});
  for(let index=0; index<frames.length; index++) if(Object.hasOwn(frames[index], '_styk'))
    report.keyframes[index]._styk = frames[index]._styk;
}
