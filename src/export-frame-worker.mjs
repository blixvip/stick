import {errorMessageData, messageError} from './localized-error.mjs';

import { applyDocumentChunk } from "./document-transport.mjs";
import { timeline, evaluatedFrame } from "./pivot/geometry.mjs";
import { PlaybackResources } from "./playback-resources.mjs";
import { exportFrameGeometry, drawExportSceneTiled } from "./export-frame-core.mjs";
import { exportMemoryPlan, EXPORT_MAX_WORKING_BYTES } from "./export-memory.mjs";
import {diagnosticDetails} from './telemetry-schema.mjs';
import {exportContext, checkExportContext} from './export-canvas.mjs';
import { exportSVG } from "./svg-export.mjs";
import { rasterizeCrispSVG } from "./export-crisp.mjs";

let report,
  rows,
  frameDocument,
  resources,
  options,
  canvas,
  tile,
  running = false;
async function deliverFrame(message, stats) {
  if (!message.native) return {bitmap: canvas.transferToImageBitmap(), stats};
  const started = performance.now(), context = exportContext(canvas);
  if (!message.preserveAlpha) {
    // Composite behind the rendered pixels in place. No second full-size canvas
    // or renderer-thread bitmap round trip is needed for opaque native video.
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
    } finally {context.restore();}
  }
  const blob = await canvas.convertToBlob({type: 'image/png'});
  checkExportContext(context);
  if (blob.type !== 'image/png' || !blob.size) throw messageError(new Error(''), "errors.exportFrameWorker.losslessVideoFrameEncodingIsUnavailable", {});
  return {nativeFrame: {blob, width: canvas.width, height: canvas.height}, stats: {...stats, pngMs: performance.now() - started}};
}
function tickFrame(tick) {
  const end = rows.at(-1)?.start + rows.at(-1)?.count;
  if (!Number.isInteger(tick) || tick < 0 || tick >= end)
    throw messageError(new Error(''), "errors.exportFrameWorker.chooseAnExportFrameInsideThisAnimation", {});
  let low = 0,
    high = rows.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rows[middle].start <= tick) low = middle;
    else high = middle - 1;
  }
  const row = rows[low];
  return {
    frame: evaluatedFrame(
      report,
      low,
      row.count ? (tick - row.start) / row.count : 0,
      tick,
    ),
    index: low,
  };
}
async function render(message) {
  if (!report || !rows)
    throw messageError(new Error(''), "errors.exportFrameWorker.loadTheAnimationBeforeRenderingExportFrames", {});
  const started = performance.now(),
    { frame, index } = message.override
      ? { frame: frameDocument?.keyframes?.[0], index: 0 }
      : tickFrame(message.tick);
  if (!frame) throw messageError(new Error(''), "errors.exportFrameWorker.theCurrentExportFrameWasNotTransferred", {});
  const geometry = exportFrameGeometry(report, frame),
    backgroundIds = new Set([
      frame.background_id,
      ...(frame.background_mix ? [frame.background_id_b] : []),
    ]);
  if (message.svg || options.smoothing === "none") await resources.preload([
    ...geometry.drawables,
    ...(report.backgrounds || [])
      .filter(
        (asset) =>
          backgroundIds.has(asset.background_id) &&
          ![2, 3, 4].includes(asset.kind) &&
          asset.color === undefined,
      )
      .map((asset) => ({ type: "image", asset })),
  ]);
  // Keep embedded SVG strings only for this frame's decoded assets.
  for (const url of resources.svgBitmaps.keys())
    if (!resources.images.has(url)) resources.svgBitmaps.delete(url);
  if (message.svg || options.smoothing === "none") {
    const svg = await exportSVG({
      report,
      frame,
      frameIndex: message.tick ?? index,
      geometry,
      width: options.width,
      height: options.height,
      resources,
      smoothing: message.svg ? "edges" : options.smoothing,
    });
    if (!message.svg) {await rasterizeCrispSVG(svg, canvas); checkExportContext(exportContext(canvas));}
    const stats = {
        workerMs: performance.now() - started,
        smoothing: options.smoothing,
        renderWidth: options.width,
        renderHeight: options.height,
      };
    return message.svg ? {svg, stats} : deliverFrame(message, stats);
  }
  await drawExportSceneTiled(exportContext(canvas), report, frame, geometry, resources, options.tileSize, tile, options.factor);
  checkExportContext(exportContext(canvas));
  return deliverFrame(message, {
      workerMs: performance.now() - started,
      smoothing: options.smoothing,
      renderWidth: options.renderWidth,
      renderHeight: options.renderHeight,
      maxRasterTileSide: options.tileSize * options.factor + 4 * options.factor,
      maxWorkingBytes: options.maxWorkingBytes,
      decodedImageBytes: resources.bytes,
    });
}
self.addEventListener("message", async ({ data: message }) => {
  if (running) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: "An export frame is already being rendered.",
    });
    return;
  }
  running = true;
  try {
    let result = {};
    if (message.operation === "start") {
      options = {
        ...message.options,
        ...exportMemoryPlan(
          message.options.width,
          message.options.height,
          message.options.smoothing,
          {maxWorkingBytes: message.options.maxWorkingBytes},
        ),
      };
      resources?.dispose();
      resources = new PlaybackResources({
        baseURL: options.baseURL,
        token: options.token,
        maxBytes: options.assetBytes,
        hardMaxBytes: options.assetBytes,
        absoluteMaxBytes: EXPORT_MAX_WORKING_BYTES,
        preview: false,
      });
      resources.svgBitmaps = new Map();
      resources.fetch = (url) => {
        const resolved = new URL(url, options.baseURL),
          headers = {};
        if (
          options.token &&
          resolved.origin === new URL(options.baseURL).origin
        )
          headers.Authorization = `Bearer ${options.token}`;
        return fetch(resolved, { headers });
      };
      report = rows = frameDocument = undefined;
      canvas = new OffscreenCanvas(options.width, options.height);
      exportContext(canvas);
      tile = new OffscreenCanvas(1, 1);
      exportContext(tile);
    } else if (message.operation === "chunk")
      report = applyDocumentChunk(report, message.chunk);
    else if (message.operation === "loaded") {
      if (!report?.keyframes?.length || !report?.figure_types)
        throw messageError(new Error(''), "errors.exportFrameWorker.exportNeedsADecodedAnimationDocument", {});
      rows = timeline(report);
    } else if (message.operation === "frame-start") frameDocument = undefined;
    else if (message.operation === "frame-chunk")
      frameDocument = applyDocumentChunk(frameDocument, message.chunk);
    else if (message.operation === "retile")
      options.tileSize = Math.max(1, Math.min(1024, message.tileSize | 0));
    else if (message.operation === "render") result = await render(message);
    else throw messageError(new Error(''), "errors.exportFrameWorker.unknownExportRendererOperation", {});
    self.postMessage(
      { id: message.id, ok: true, ...result },
      result.bitmap ? [result.bitmap] : [],
    );
  } catch (error) {
    // Render failures keep the loaded document so the renderer can retry the
    // same frame at smaller tiles. Only prepare/load errors still tear down.
    const recoverable = message.operation === "render";
    if (!recoverable) {
      resources?.dispose();
      if (canvas) canvas.width = canvas.height = 1;
      report = rows = frameDocument = undefined;
    } else {
      // Free tile scratch and retained decodes before the retry; they are
      // re-decoded from the document if the smaller plan still needs them.
      if (tile) tile.width = tile.height = 1;
      resources?.trimImages?.(new Set());
      if (error?.code === 'export_canvas_lost') {
        // A lost 2D context never recovers; replace its canvas before retrying.
        try { canvas = new OffscreenCanvas(options.width, options.height); exportContext(canvas); } catch {}
        try { tile = new OffscreenCanvas(1, 1); exportContext(tile); } catch {}
      }
    }
    self.postMessage({
      id: message.id,
      ok: false,
      error: error?.message || String(error), ...errorMessageData(error),
      code: error?.code,
      recoverable,
      ...diagnosticDetails(error,message.operation==='render'?'encode':'prepare','worker_failed'),
    });
  } finally {
    running = false;
  }
});
