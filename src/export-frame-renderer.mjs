import {restoreMessageError, messageError} from './localized-error.mjs';

import { documentChunks } from "./document-transport.mjs";
import {drawingBarrier} from './drawing-resources.mjs';
import { exportMemoryPlan } from "./export-memory.mjs";
import {exportContext, checkExportContext} from './export-canvas.mjs';

const abortError = (message = "Export rendering cancelled.") =>
  new DOMException(message, "AbortError");
/** One export session: bounded document transfer, worker scene evaluation and
 * rasterization, then a reusable output canvas consumed by any existing encoder.
 */
export class ExportFrameRenderer {
  constructor({
    width,
    height,
    smoothing = "edges",
    baseURL = globalThis.location?.origin,
    token = "",
    signal,
    getRevision,
    canvas,
    timeoutMs = 120000,
    maxWorkingBytes,
    onFrame,
  } = {}) {
    if (signal?.aborted) throw abortError();
    Object.assign(this, exportMemoryPlan(width, height, smoothing, {maxWorkingBytes}), {
      baseURL,
      token,
      signal,
      getRevision,
      timeoutMs,
      onFrame,
    });
    this.canvas = canvas ?? document.createElement("canvas");
    // Native video consumes worker PNGs directly; allocate presentation pixels
    // only if a canvas consumer actually requests them.
    this.canvas.width = this.canvas.height = 1;
    // Export frames are read by image/video encoders. Keep this large surface
    // CPU-backed instead of competing with the editor's WebGPU allocations.
    try {this.context = exportContext(this.canvas);} catch (error) {this.canvas.width = this.canvas.height = 1; throw error;}
    this.sequence = 0;
    this.disposed = false;
    this.loaded = false;
    this.busy = false;
    this.stats = {
      loadChunks: 0,
      maxChunkBytes: 0,
      maxMainSnapshotMs: 0,
      renderedFrames: 0,
    };
    try {this._spawn();} catch (error) {this.canvas.width = this.canvas.height = 1; throw error;}
    this.abort = () => this._fail(abortError());
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  _spawn() {
    this.worker?.terminate();
    this.worker = new Worker(
      new URL("./export-frame-worker.mjs", import.meta.url),
      { type: "module", name: "StykAnimate export rendering" },
    );
    this.worker.addEventListener("message", ({ data }) => {
      const pending = this.pending;
      if (!pending || pending.id !== data.id) {
        data.bitmap?.close();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      if (data.ok) pending.resolve(data);
      else {
        const error = Object.assign(restoreMessageError((data.error ? new Error(data.error) : messageError(new Error(''), "errors.exportFrameRenderer.exportRenderingFailed")), data), {code: data.code,
          name:data.name||'Error',recoverable:Boolean(data.recoverable),telemetryCode:data.telemetryCode,telemetryStage:data.telemetryStage,telemetryFrames:data.telemetryFrames});
        data.bitmap?.close();
        // Recoverable render errors keep the worker alive for a tile retry.
        if (!error.recoverable) this._fail(error);
        pending.reject(error);
      }
    });
    this.worker.addEventListener("error", (event) => {
      event.preventDefault();
      this._fail(Object.assign((event.message ? new Error(event.message) : messageError(new Error(''), "errors.exportFrameRenderer.theExportRendererStopped")),{telemetryCode:'worker_failed',telemetryStage:'encode'}));
    });
    this.worker.addEventListener("messageerror", () =>
      this._fail(Object.assign(messageError(new Error(''), "errors.exportFrameRenderer.anExportFrameCouldNotBeTransferred", {}),{telemetryCode:'snapshot_failed',telemetryStage:'prepare'})),
    );
  }
  _check() {
    if (this.failure) throw this.failure;
    if (this.disposed || this.signal?.aborted) throw abortError();
    if (this.loaded && this.getRevision && this.getRevision() !== this.revision)
      throw abortError("The animation changed during export.");
  }
  _fail(error) {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.worker?.terminate();
    this.canvas.width = this.canvas.height = 1;
  }
  _request(operation, payload = {}) {
    this._check();
    if (this.pending)
      return Promise.reject(
        messageError(new Error(''), "errors.exportFrameRenderer.exportRendererRequestsMustRunSequentially", {}),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.sequence,
        timer =
          this.timeoutMs > 0
            ? setTimeout(
                () => this._fail(Object.assign(messageError(new Error(''), "errors.exportFrameRenderer.exportRenderingTimedOut", {}),{telemetryCode:'timeout',telemetryStage:operation==='render'?'encode':'prepare'})),
                this.timeoutMs,
              )
            : null;
      this.pending = { id, resolve, reject, timer };
      try {
        this.worker.postMessage({ id, operation, ...payload });
      } catch (error) {
        this._fail(error);
      }
    });
  }
  async _chunks(report, operation) {
    const chunks = documentChunks(report, {
      maxRecords: 128,
      maxBytes: 64 * 1024,
      timeBudgetMs: 2,
    });
    for (;;) {
      this._check();
      const started = performance.now(),
        next = chunks.next();
      this.stats.maxMainSnapshotMs = Math.max(
        this.stats.maxMainSnapshotMs,
        performance.now() - started,
      );
      if (next.done) return;
      await this._request(operation, { chunk: next.value });
      this.stats.loadChunks++;
      this.stats.maxChunkBytes = Math.max(
        this.stats.maxChunkBytes,
        next.value.estimatedBytes || 0,
      );
      if (this.getRevision && this.getRevision() !== this.revision)
        throw abortError("The animation changed during export.");
    }
  }
  async load(report) {
    this._check();
    await drawingBarrier(report,{signal:this.signal});this._check();
    if (this.busy) throw messageError(new Error(''), "errors.exportFrameRenderer.waitForTheCurrentExportFrame", {});
    this.busy = true;
    this.loaded = false;
    try {
      this.revision = this.getRevision?.();
      await this._request("start", {
        options: {
          width: this.width,
          height: this.height,
          smoothing: this.smoothing,
          baseURL: this.baseURL,
          token: this.token,
          maxWorkingBytes: this.maxWorkingBytes,
        },
      });
      const { _stykSource, ...renderReport } = report;
      if(renderReport._styk?.audio){const {audio,...metadata}=renderReport._styk;renderReport._styk=metadata;}
      // Kept so a dead worker can be rebuilt mid-export without a second load.
      this._report = renderReport;
      await this._chunks(renderReport, "chunk");
      await this._request("loaded");
      this.loaded = true;
      return this;
    } catch (error) {this._fail(error); throw error;} finally {
      this.busy = false;
    }
  }
  /** Resource failures retriable at smaller tiles or after a worker rebuild;
   * aborts, document errors and encoder faults are not. */
  _recoverable(error) {
    if (error?.name === 'AbortError') return false;
    return Boolean(error?.recoverable) ||
      ['vfx_surface_budget', 'export_memory_limit', 'export_canvas_lost'].includes(error?.code) ||
      ['timeout', 'worker_failed', 'snapshot_failed'].includes(error?.telemetryCode);
  }
  /** Replace a dead or wedged worker and replay the loaded document. */
  async _rebuild(tileSize) {
    this.failure = null;
    this.loaded = false;
    this._spawn();
    await this._request("start", {
      options: {
        width: this.width,
        height: this.height,
        smoothing: this.smoothing,
        baseURL: this.baseURL,
        token: this.token,
        maxWorkingBytes: this.maxWorkingBytes,
      },
    });
    await this._chunks(this._report, "chunk");
    await this._request("loaded");
    this.loaded = true;
    if (tileSize && tileSize !== this.tileSize)
      await this._request("retile", { tileSize });
  }
  _paint(result) {
    if (!result.bitmap)
      throw messageError(new Error(''), "errors.exportFrameRenderer.theExportRendererReturnedNoPixelFrame", {});
    try {
      this._check();
      if (this.canvas.width !== this.width) this.canvas.width = this.width;
      if (this.canvas.height !== this.height) this.canvas.height = this.height;
      checkExportContext(this.context);
      if (result.bitmap.width !== this.width || result.bitmap.height !== this.height)
        throw messageError(new Error(''), "errors.exportFrameRenderer.theExportRendererReturnedAnIncompleteFrame", {});
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.width, this.height);
      this.context.imageSmoothingEnabled = false;
      this.context.drawImage(result.bitmap, 0, 0);
      checkExportContext(this.context);
    } finally {
      result.bitmap.close();
    }
    Object.assign(this.stats, result.stats);
    this.stats.renderedFrames++;
    return this.canvas;
  }
  async _render({ tick, frame, svg = false, native = false, preserveAlpha = false }) {
    this._check();
    if (!this.loaded) throw messageError(new Error(''), "errors.exportFrameRenderer.loadTheAnimationBeforeExporting", {});
    if (this.busy)
      throw messageError(new Error(''), "errors.exportFrameRenderer.exportFramesMustBeRenderedSequentially", {});
    this.busy = true;
    try {
      this.onFrame?.({stage: 'rendering', tick});
      const sendFrame = async () => {
        if (!frame) return;
        await this._request("frame-start");
        await this._chunks({ keyframes: [frame] }, "frame-chunk");
      };
      await sendFrame();
      const payload = {tick, override: Boolean(frame), svg, native, preserveAlpha};
      // Retry ladder: resource failures halve the render tile to a 32px floor,
      // then rebuild the worker once and try again. Output pixels are identical;
      // only the amount of frame held in memory per pass changes.
      let result, tileSize = this.tileSize, mayRebuild = true;
      for (;;) {
        try {
          result = await this._request("render", payload);
          this.tileSize = tileSize; // later frames start at the size that worked
          break;
        } catch (error) {
          if (!this._recoverable(error) || this.signal?.aborted) throw error;
          // A wedged worker can't answer retile either; then or at the 32px
          // floor the ladder rebuilds it once with the document replayed.
          if (!this.failure && tileSize > 32) {
            tileSize = Math.max(32, Math.floor(tileSize / 2));
            this.onFrame?.({stage: 'retrying', tick, tileSize});
            try { await this._request("retile", { tileSize }); continue; }
            catch { /* fall through to the rebuild */ }
          }
          if (!mayRebuild) throw error; // the rebuilt worker already had its ladder
          mayRebuild = false;
          this.onFrame?.({stage: 'rebuilding', tick});
          await this._rebuild(tileSize);
          await sendFrame();
        }
      }
      if (native) {
        this._check();
        const output = result.nativeFrame;
        if (!(output?.blob instanceof Blob) || output.blob.type !== 'image/png' || !output.blob.size ||
            output.width !== this.width || output.height !== this.height)
          throw messageError(new Error(''), "errors.exportFrameRenderer.theExportRendererReturnedAnIncompleteNativeFrame", {});
        Object.assign(this.stats, result.stats);
        this.stats.renderedFrames++;
        this.onFrame?.({stage: 'rendered', tick});
        return output;
      }
      if (svg) {
        this._check();
        Object.assign(this.stats, result.stats);
        this.onFrame?.({stage: 'rendered', tick});
        return result.svg;
      }
      const canvas = this._paint(result);
      this.onFrame?.({stage: 'rendered', tick});
      return canvas;
    } catch (error) {this._fail(error); throw error;} finally {
      this.busy = false;
    }
  }
  renderTick(tick) {
    return this._render({ tick });
  }
  renderNativeTick(tick, {preserveAlpha = false} = {}) {
    return this._render({tick, native: true, preserveAlpha});
  }
  renderFrame(frame) {
    return this._render({ frame });
  }
  renderSVGTick(tick) {
    return this._render({ tick, svg: true });
  }
  renderSVGFrame(frame) {
    return this._render({ frame, svg: true });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._report = null;
    this.signal?.removeEventListener("abort", this.abort);
    this._fail(abortError());
    this.canvas.width = this.canvas.height = 1;
  }
}
