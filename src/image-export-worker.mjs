import {errorMessageData, messageError} from './localized-error.mjs';

import { GIFPaletteBuilder } from "./gif-quantize.mjs";
import { APNGEncoder, GIFEncoder, SequenceZIP, validatePNGFrame } from "./image-codecs.mjs";
import {exportContext, checkExportContext} from './export-canvas.mjs';

let output, canvas, context, config, paletteBuilder;
let busy = false;
// In streaming mode the encoder's appended bytes are forwarded to the caller
// with every response instead of being retained until finish.
const respond = (id, fields = {}) => {
  const chunk = config?.stream && output ? output.drain() : null;
  self.postMessage({ id, ok: true, ...(chunk ? { output: chunk } : {}), ...fields });
};
self.addEventListener("message", async (event) => {
  const message = event.data;
  if (busy) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: "The image export worker is busy.",
    });
    return;
  }
  busy = true;
  try {
    if (message.operation === "start") {
      config = message.config;
      if (config.encodedPNG && !["apng", "png-sequence"].includes(config.format))
        throw new Error("Encoded PNG frames require APNG or PNG sequence export.");
      if (config.format !== "svg-sequence" && !config.encodedPNG) {
        canvas = new OffscreenCanvas(config.width, config.height);
        context = exportContext(canvas);
        if (!context) throw messageError(new Error(''), "errors.imageExportWorker.aCanvasImageEncoderIsUnavailable", {});
      }
      const Encoder =
        config.format === "gif"
          ? GIFEncoder
          : config.format === "apng"
            ? APNGEncoder
            : SequenceZIP;
      paletteBuilder = config.format === "gif" ? new GIFPaletteBuilder() : null;
      output = paletteBuilder ? null : new Encoder(config);
      respond(message.id);
    } else if (message.operation === "encode") {
      if (!paletteBuilder || paletteBuilder.frames !== config.totalFrames)
        throw messageError(new Error(''), "errors.imageExportWorker.theGifPaletteAnalysisIsIncomplete", {});
      output = new GIFEncoder({ ...config, palette: paletteBuilder.finish() });
      paletteBuilder = null;
      respond(message.id);
    } else if (message.operation === "frame") {
      if (!output && !paletteBuilder)
        throw messageError(new Error(''), "errors.imageExportWorker.theImageExportWasNotInitialized", {});
      if (config.encodedPNG) {
        if (!(message.png instanceof Blob) || message.png.type !== "image/png" ||
            !message.png.size || message.png.size > config.maxBytes)
          throw messageError(new Error(''), "errors.imageCodecs.theBrowserDidNotProduceAPngFrame", {});
        const data = new Uint8Array(await message.png.arrayBuffer());
        if (config.format === "png-sequence") validatePNGFrame(data, config.width, config.height);
        output.add(data);
        respond(message.id);
        return;
      }
      if (config.format === "svg-sequence") {
        const svg =
          message.svg instanceof Blob
            ? message.svg
            : new Blob([message.svg], { type: "image/svg+xml" });
        if (!svg.size || svg.size > config.maxBytes)
          throw messageError(new Error(''), "errors.imageExportWorker.theSvgFrameIsEmptyOrExceedsThe", {});
        const prefix = await svg.slice(0, 1024).text();
        if (!/<svg(?:\s|>)/i.test(prefix))
          throw messageError(new Error(''), "errors.imageExportWorker.theVectorFrameDoesNotContainAnSvg", {});
        output.add(new Uint8Array(await svg.arrayBuffer()));
        respond(message.id);
        return;
      }
      const bitmap = message.bitmap;
      try {
        checkExportContext(context);
        if (bitmap.width !== config.width || bitmap.height !== config.height)
          throw messageError(new Error(''), "errors.imageExportWorker.theRenderedImageFrameHasTheWrongDimensions", {});
        context.clearRect(0, 0, config.width, config.height);
        if (config.format === "jpeg-sequence") {
          context.fillStyle = "#fff";
          context.fillRect(0, 0, config.width, config.height);
        }
        context.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      checkExportContext(context);
      if (config.format === "gif") {
        const rgba = context.getImageData(
          0,
          0,
          config.width,
          config.height,
        ).data;
        if (paletteBuilder) paletteBuilder.add(rgba, config.width);
        else output.add(rgba);
      } else if (config.format === "gif-sequence") {
        const frame = new GIFEncoder({
          ...config,
          totalFrames: 1,
          loop: false,
        });
        frame.add(context.getImageData(0, 0, config.width, config.height).data);
        output.add(new Uint8Array(await frame.finish().arrayBuffer()));
      } else {
        const type =
          config.format === "jpeg-sequence" ? "image/jpeg" : "image/png";
        const encoded = await canvas.convertToBlob({
          type,
          quality: config.quality,
        });
        checkExportContext(context);
        if (encoded.type !== type)
          throw messageError(new Error(''), "errors.imageExportWorker.theBrowserDoesNotSupportImageEncoding", {type: type});
        output.add(new Uint8Array(await encoded.arrayBuffer()));
      }
      respond(message.id);
    } else if (message.operation === "finish") {
      if (!output) throw messageError(new Error(''), "errors.imageExportWorker.theImageExportWasNotInitialized", {});
      if (config.stream) {
        output.finish();
        if (canvas) canvas.width = canvas.height = 1;
        respond(message.id);
        output = null;
        return;
      }
      const blob = output.finish();
      output = null;
      if (canvas) canvas.width = canvas.height = 1;
      self.postMessage({ id: message.id, ok: true, blob });
    } else throw messageError(new Error(''), "errors.imageExportWorker.unknownImageExportOperation", {});
  } catch (error) {
    message.bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
    output = paletteBuilder = null;
    self.postMessage({
      id: message.id,
      ok: false,
      error: error?.message || String(error), ...errorMessageData(error),
    });
  } finally {
    busy = false;
  }
});
