import {restoreMessageError, messageError} from './localized-error.mjs';

import { normalizeGIFDither } from "./gif-options.mjs";
import { EXPORT_MAX_PIXELS } from "./export-sampling.mjs";
/** Offline animated image and numbered image-sequence exports.
 * Canvas frames are snapshotted into a transferable ImageBitmap; palette creation,
 * LZW, PNG/JPEG compression, checksums, APNG and ZIP writing stay in a worker.
 * Animated GIF renders each index twice: first to collect one animation palette,
 * then to encode. renderFrame must return the same committed image in both passes.
 */
const MAX_BYTES = 512 * 1024 * 1024;
// Streamed exports are bounded by the destination disk, not renderer memory.
// ZIP32 stores 32-bit offsets, so sequences must stay under 4 GiB.
const STREAM_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const ZIP_STREAM_MAX_BYTES = 0xfff00000;
const formats = new Set([
  "gif",
  "apng",
  "png-sequence",
  "jpeg-sequence",
  "gif-sequence",
  "svg-sequence",
]);
const abortError = () =>
  messageError(new DOMException('', "AbortError"), "errors.imageExport.imageExportCancelled", {});

/**
 * @param {{format:'gif'|'apng'|'png-sequence'|'jpeg-sequence'|'gif-sequence'|'svg-sequence',width:number,height:number,
 * fps:number,totalFrames:number,renderFrame?:(index:number)=>Promise<HTMLCanvasElement|OffscreenCanvas>|HTMLCanvasElement|OffscreenCanvas,
 * renderSVGFrame?:(index:number)=>Promise<Blob|string>|Blob|string,
 * renderPNGFrame?:(index:number)=>Promise<{blob:Blob,width:number,height:number}>|{blob:Blob,width:number,height:number},
 * onProgress?:(value:{phase:"palette"|"encode",completed:number,total:number,progress:number})=>void,
 * signal?:AbortSignal,loop?:boolean,quality?:number,dither?:boolean,maxBytes?:number,
 * sink?:{streamed:boolean,write(part:Blob)=>Promise<void>,finish()=>Promise<object>,abort()=>Promise<void>}}} options
 * @returns {Promise<Blob|{saved:boolean,path?:string,size?:number,blob?:Blob}>} GIF, APNG, or ZIP
 * containing numbered PNG/JPEG frames — a Blob, or the sink's finish() result.
 */
export async function exportAnimation({
  format,
  width,
  height,
  fps,
  totalFrames,
  renderFrame,
  renderSVGFrame,
  renderPNGFrame,
  onProgress,
  signal,
  loop = true,
  quality = 0.94,
  dither = false,
  maxBytes,
  timeoutMs = 120000,
  sink,
}) {
  format =
    {
      "jpg-sequence": "jpeg-sequence",
      "png-zip": "png-sequence",
      "jpeg-zip": "jpeg-sequence",
      "jpg-zip": "jpeg-sequence",
    }[format] || format;
  if (!formats.has(format))
    throw messageError(new Error(''), "errors.imageExport.chooseGifApngOrAPngJpegGif", {});
  const vector = format === "svg-sequence";
  const encodedPNG = (format === "apng" || format === "png-sequence") &&
    typeof renderPNGFrame === "function";
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    (!vector && width * height > EXPORT_MAX_PIXELS)
  ) {
    throw messageError(new Error(''), "errors.imageExport.imageExportsSupportDimensionsUpTo16384", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)});
  }
  const maxFrames = format.endsWith("sequence") ? 65534 : 100000;
  if (
    !Number.isInteger(totalFrames) ||
    totalFrames < 1 ||
    totalFrames > maxFrames
  )
    throw messageError(new Error(''), "errors.imageExport.chooseBetween1AndExportFrames", {value: maxFrames.toLocaleString()});
  if (
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > (format === "gif" ? 50 : 1000)
  ) {
    throw new Error(
      format === "gif"
        ? "GIF export supports 1–50 fps; choose APNG or video for higher frame rates."
        : "Choose an image frame rate between 1 and 1,000 fps.",
    );
  }
  if (typeof (vector ? renderSVGFrame : encodedPNG ? renderPNGFrame : renderFrame) !== "function")
    throw new TypeError(
      vector
        ? "SVG sequence export needs a vector frame renderer."
        : "Image export needs a frame renderer.",
    );
  if (!Number.isFinite(quality) || quality < 0 || quality > 1)
    throw messageError(new Error(''), "errors.imageExport.jpegQualityMustBeBetweenZeroAndOne", {});
  const streamed = sink?.streamed === true;
  const maxBytesCap = streamed
    ? format.endsWith("sequence")
      ? ZIP_STREAM_MAX_BYTES
      : STREAM_MAX_BYTES
    : MAX_BYTES;
  maxBytes ??= maxBytesCap;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > maxBytesCap)
    throw new Error(
      streamed
        ? "The streamed export size limit is invalid."
        : "Choose an export size limit between 1 KiB and 512 MiB.",
    );
  dither = normalizeGIFDither(dither);
  if (signal?.aborted) throw abortError();
  if (
    typeof Worker === "undefined" ||
    (!vector && !encodedPNG &&
      (typeof createImageBitmap === "undefined" ||
        typeof OffscreenCanvas === "undefined"))
  ) {
    throw messageError(new Error(''), "errors.imageExport.thisBrowserCannotExportImagesInAWorker", {});
  }
  const worker = new Worker(
    new URL("./image-export-worker.mjs", import.meta.url),
    { type: "module", name: "StykAnimate image export" },
  );
  let sequence = 0,
    pending = null,
    failure;
  const fail = (error) => {
    failure = error;
    clearTimeout(pending?.timer);
    pending?.reject(error);
    pending = null;
    worker.terminate();
  };
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.imageExport.theImageExportWorkerStopped")));
  });
  worker.addEventListener("messageerror", () =>
    fail(messageError(new Error(''), "errors.imageExport.anImageFrameCouldNotBeTransferred", {})),
  );
  worker.addEventListener("message", (event) => {
    if (!pending || pending.id !== event.data?.id) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    event.data.ok
      ? request.resolve(event.data)
      : request.reject(restoreMessageError((event.data.error ? new Error(event.data.error) : messageError(new Error(''), "errors.imageExport.imageEncodingFailed")), event.data));
  });
  const check = () => {
    if (signal?.aborted) throw abortError();
    if (failure) throw failure;
  };
  const request = (operation, data = {}, transfer = []) => {
    check();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(messageError(new Error(''), "errors.imageExport.imageEncodingTimedOutExportStoppedTryAgain", {})), timeoutMs);
      pending = { id, resolve, reject, timer };
      try {
        worker.postMessage({ id, operation, ...data }, transfer);
      } catch (error) {
        clearTimeout(timer);
        pending = null;
        reject(error);
      }
    });
  };
  const abort = () => fail(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  let completed = false;
  const forward = async (response) => {
    if (sink && response?.output instanceof Blob) await sink.write(response.output);
  };
  try {
    await forward(
      await request("start", {
        config: {
          format,
          width,
          height,
          fps,
          totalFrames,
          loop,
          quality,
          dither,
          maxBytes,
          stream: Boolean(sink),
          encodedPNG,
        },
      }),
    );
    const passes = format === "gif" ? 2 : 1,
      totalWork = totalFrames * passes;
    for (let pass = 0; pass < passes; pass++) {
      if (pass === 1) await forward(await request("encode"));
      for (let index = 0; index < totalFrames; index++) {
        check();
        if (vector) {
          const svg = await renderSVGFrame(index);
          check();
          if (!(svg instanceof Blob) && typeof svg !== "string")
            throw messageError(new Error(''), "errors.imageExport.renderedSvgFrameMustContainSvgTextOr", {value: index + 1});
          await forward(await request("frame", { svg }));
          check();
          onProgress?.({
            phase: passes === 2 && pass === 0 ? "palette" : "encode",
            completed: pass * totalFrames + index + 1,
            total: totalWork,
            progress: (pass * totalFrames + index + 1) / totalWork,
          });
          continue;
        }
        if (encodedPNG) {
          const frame = await renderPNGFrame(index);
          check();
          if (!(frame?.blob instanceof Blob) || frame.blob.type !== "image/png" ||
              !frame.blob.size || frame.width !== width || frame.height !== height)
            throw messageError(new Error(''), "errors.imageExport.renderedImageFrameHasTheWrongDimensions", {value: index + 1});
          // The renderer already encoded this immutable frame off-thread. Keep
          // the same one-frame backpressure without creating pixel surfaces.
          await forward(await request("frame", {png: frame.blob}));
        } else {
          const canvas = await renderFrame(index);
          check();
          if (!canvas || canvas.width !== width || canvas.height !== height)
            throw messageError(new Error(''), "errors.imageExport.renderedImageFrameHasTheWrongDimensions", {value: index + 1});
          const bitmap = await createImageBitmap(canvas);
          try {
            check();
            // Backpressure: only one full-resolution frame is in flight at a time.
            await forward(await request("frame", { bitmap }, [bitmap]));
          } finally {
            bitmap.close();
          }
        }
        check();
        onProgress?.({
          phase: passes === 2 && pass === 0 ? "palette" : "encode",
          completed: pass * totalFrames + index + 1,
          total: totalWork,
          progress: (pass * totalFrames + index + 1) / totalWork,
        });
      }
    }
    const response = await request("finish");
    check();
    if (sink) {
      await forward(response);
      const result = await sink.finish();
      completed = true;
      return result;
    }
    completed = true;
    return response.blob;
  } finally {
    clearTimeout(pending?.timer);
    signal?.removeEventListener("abort", abort);
    worker.terminate();
    if (sink && !completed) await sink.abort();
  }
}
