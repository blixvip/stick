import {errorMessageData, messageError} from './localized-error.mjs';

import { applyDocumentChunk } from "./document-transport.mjs";
import {applyPlaybackPatch} from './playback-patch.mjs';
import { PlaybackResources } from "./playback-resources.mjs";
import {previewMemoryPlan} from './playback-budget.mjs';
import {
  evaluatedFrame,
  timeline,
  buildGeometry,
  drawGeometry,
  invalidateEvaluationCaches,
  releaseGeometryResources,
} from "./pivot/geometry.mjs";
import {
  drawBackground,
  backgroundBounds,
  cameraIsIdentity,
  inverseCameraScale,
  effectiveCamera,
  sceneBackgroundColor,
} from "./pivot/background.mjs";
import { layerVisible } from "./layers.mjs";
import {sampleInbetweenPreview} from './editor-inbetween.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {activeVfx,vfxStack} from './vfx.mjs';
import {drawExportScene} from './export-frame-core.mjs';
import {sceneVfxPlan,sceneVfxBounds} from './vfx-scene.mjs';
import {connectedVfxGeometry} from './vfx-connected.mjs';
import {drawParallaxGeometry} from './parallax-draw.mjs';
import {canvasGenerators,canvasGeneratorWalker} from './vfx-generator-frame.mjs';

let report,
  storedReport,
  storedEntries,
  incoming,
  resources,
  entries,
  canvas,
  context,
  effectCanvas,
  revision = 0;
let rendering = false,
  activeRequest = null;
const cancelled = new Set();
const abortError = () =>
  messageError(new DOMException('', "AbortError"), "errors.thumbnailRenderer.thumbnailSuperseded", {});
const respond = (id, value = {}, transfer = []) =>
  self.postMessage({ id, ok: true, ...value }, transfer);

async function receive(message) {
  const { id, operation } = message;
  try {
    if (operation === "cancel") {
      if (activeRequest === message.request) cancelled.add(message.request);
      return;
    }
    if (operation === "snapshot-chunk") {
      if (message.chunk.header)
        incoming = {
          revision: message.revision,
          mode: message.mode,
          value: applyDocumentChunk(null, message.chunk),
        };
      else {
        if (incoming?.revision !== message.revision) throw abortError();
        applyDocumentChunk(incoming.value, message.chunk);
      }
      respond(id);
      return;
    }
    if (operation === "snapshot-complete") {
      if (incoming?.revision !== message.revision) throw abortError();
      if (incoming.mode === "document") {
        report = incoming.value;
        resources?.dispose();
        resources = new PlaybackResources({
          ...message.options,
          maxBytes: previewMemoryPlan().thumbnails,
          preview: true,
        });
      } else {
        if (!report) throw messageError(new Error(''), "errors.thumbnailWorker.thumbnailDocumentIsUnavailable", {});
        applyPlaybackPatch(report, incoming.value);
        invalidateEvaluationCaches(report);
      }
      revision = message.revision;
      incoming = null;
      entries = timeline(report);
      storedReport = storedEntries = null;
      respond(id);
      return;
    }
    if (operation !== "render") throw messageError(new Error(''), "errors.thumbnailWorker.unknownThumbnailOperation", {});
    if (rendering)
      throw messageError(new Error(''), "errors.thumbnailWorker.thumbnailWorkerAlreadyHasAPendingFrame", {});
    if (message.revision !== revision || !report) throw abortError();
    if (message.storedFrames !== undefined && typeof message.storedFrames !== 'boolean') throw messageError(new Error(''), "errors.thumbnailWorker.invalidStoredFramePreviewMode", {});
    if(message.tick!==undefined&&(!Number.isInteger(message.tick)||message.tick<0||message.tick>10000000))throw messageError(new Error(''), "errors.thumbnailWorker.invalidThumbnailTime", {});
    if (!Number.isInteger(message.index) || !report.keyframes[message.index])
      throw messageError(new RangeError(''), "errors.thumbnailWorker.thumbnailFrameIsUnavailable", {});
    if (
      !Number.isInteger(message.width) ||
      !Number.isInteger(message.height) ||
      message.width < 1 ||
      message.height < 1 ||
      message.width > 512 ||
      message.height > 512
    )
      throw messageError(new RangeError(''), "errors.thumbnailWorker.thumbnailDimensionsExceed512Pixels", {});
    rendering = true;
    activeRequest = id;
    try {
      const generation = revision,
        started = performance.now();
      const check = () => {
        if (cancelled.has(id) || revision !== generation) throw abortError();
      };
      check();
      const frameReport = message.storedFrames ? (storedReport ??= storedFrameReport(report)) : report;
      const frameEntries = message.storedFrames ? (storedEntries ??= timeline(frameReport)) : entries;
      const preview = message.inbetween;
      if (preview && (!['adjacent', 'settings', 'none'].includes(preview.onionMode) ||
          !Number.isInteger(preview.onionCount) || preview.onionCount < 0 || preview.onionCount > 9 ||
          !Number.isFinite(preview.onionOpacity) || preview.onionOpacity < 0 || preview.onionOpacity > 1))
        throw messageError(new Error(''), "errors.thumbnailWorker.invalidInbetweenPreviewOptions", {});
      const frame = preview ? sampleInbetweenPreview(frameReport, preview.ratio, message.index).frame : evaluatedFrame(
        frameReport,
        message.index,
        0,
        message.tick??frameEntries[message.index]?.start,
      );
      const geometry = connectedVfxGeometry(buildGeometry(frameReport, frame),frame,frameReport);
      const drawables = geometry.drawables.filter((item) =>
        layerVisible(frameReport, item.obj.unique_id),
      );
      const onions = [];
      if (preview && preview.onionMode !== 'none') {
        const count = preview.onionMode === 'adjacent' ? 1 : preview.onionCount;
        for (let distance = count; distance > 0; distance--) for (const direction of [-1, 1]) {
          if (preview.onionMode === 'settings' && direction > 0 && !preview.onionAhead) continue;
          const index = message.index + (direction < 0 ? -distance : distance - 1);
          if (!frameReport.keyframes[index]) continue;
          const source = evaluatedFrame(frameReport, index, 0, frameEntries[index]?.start);
          const ghost = connectedVfxGeometry(buildGeometry(frameReport, source),source,frameReport).drawables.filter(item => layerVisible(frameReport, item.obj.unique_id));
          onions.push({drawables: ghost.map(item => ({...item,slot:`onion/${index}/${item.slot}`,opacity: item.opacity * preview.onionOpacity / distance}))});
        }
      }
      const backgrounds =
        sceneBackgroundColor(frameReport, frame) === undefined
          ? (frameReport.backgrounds || []).filter(
              (bg) =>
                Number(bg.background_id) === Number(frame.background_id) ||
                Number(bg.background_id) === Number(frame.background_id_b),
            )
          : [];
      const width=frameReport.canvas_width,height=frameReport.canvas_height,
        scale=Math.min(message.width/width,message.height/height),hasSceneEffects=activeVfx(vfxStack(frame)).length>0;
      const effectPlan=hasSceneEffects?sceneVfxPlan(frame,Math.ceil(width*scale),Math.ceil(height*scale),undefined,scale):null;
      await resources.preload([
        ...drawables,
        ...onions.flatMap(geometry => geometry.drawables),
        ...backgrounds
          .filter((bg) => resources.url(bg))
          .map((asset) => ({ type: "image", asset })),
      ], {scale: Math.min(message.width / frameReport.canvas_width, message.height / frameReport.canvas_height), maxDimension: 512,
        visible: backgroundBounds(frame,width,height,true,frameReport,effectPlan?sceneVfxBounds(frameReport,effectPlan):undefined)});
      check();
      if (!canvas) {
        canvas = new OffscreenCanvas(message.width, message.height);
        context = canvas.getContext("2d");
      }
      canvas.width = message.width;
      canvas.height = message.height;
      // Uniform framing preserves artboard proportions in the fixed filmstrip cell.
      context.fillStyle = "#f5f5f5";
      context.fillRect(0, 0, message.width, message.height);
      if(hasSceneEffects){
        effectCanvas??=new OffscreenCanvas(1,1);
        effectCanvas.width=Math.ceil(width*scale);effectCanvas.height=Math.ceil(height*scale);
        const effectContext=effectCanvas.getContext('2d');
        try{
          drawExportScene(effectContext,frameReport,frame,{...geometry,drawables:[...onions.flatMap(onion=>onion.drawables),...drawables],connectedVfxSource:geometry.connectedVfxSource??geometry},resources);
          context.drawImage(effectCanvas,(message.width-width*scale)/2,(message.height-height*scale)/2,width*scale,height*scale);
        }finally{releaseGeometryResources(effectContext);effectCanvas.width=effectCanvas.height=1;}
      }else{
      context.save();
      context.translate(
        (message.width - width * scale) / 2,
        (message.height - height * scale) / 2,
      );
      context.scale(scale, scale);
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();
      const camera = effectiveCamera(frameReport, frame);
      if (!cameraIsIdentity(camera)) {
        context.translate(width / 2, height / 2);
        context.scale(inverseCameraScale(camera), inverseCameraScale(camera));
        context.rotate(-Number(camera.angle_rad || 0));
        context.translate(
          -width / 2 - Number(camera.x || 0),
          -height / 2 - Number(camera.y || 0),
        );
      }
      drawBackground(context, frameReport, frame, width, height, {
        ...resources,
        bounds: backgroundBounds(frame, width, height, true, frameReport),
      });
      for (const onion of onions) drawGeometry(context, onion, resources);
      const generators = canvasGenerators(frameReport, frame, geometry, null);
      if (generators) drawParallaxGeometry(context, { drawables }, resources, () => ({x: 0, y: 0}), undefined, canvasGeneratorWalker(generators, context));
      else drawGeometry(context, { drawables }, resources);
      context.restore();
      }
      check();
      const bitmap = canvas.transferToImageBitmap();
      releaseGeometryResources(context, { retainCanvases: true });
      respond(
        id,
        {
          bitmap,
          renderMs: performance.now() - started,
          mediaBytes: resources.bytes,
        },
        [bitmap],
      );
    } finally {
      rendering = false;
      activeRequest = null;
      cancelled.delete(id);
    }
  } catch (error) {
    cancelled.delete(id);
    self.postMessage({
      id,
      ok: false,
      error: error?.message || String(error), ...errorMessageData(error),
      name: error?.name,
    });
  }
}
self.addEventListener("message", (event) => void receive(event.data));
