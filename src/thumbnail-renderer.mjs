import {restoreMessageError, messageError} from './localized-error.mjs';

import {drawingBarrier} from './drawing-resources.mjs';
import {layerAppearance,thumbnailVisualChange} from './thumbnail-validity.mjs';
import { documentChunks } from "./document-transport.mjs";
import {playbackProperties, retainedSourceChanges} from './playback-patch.mjs';

const abortError = () =>
  messageError(new DOMException('', "AbortError"), "errors.thumbnailRenderer.thumbnailSuperseded", {});
/** One worker, one native frame in flight, byte-bounded document snapshots.
 * The filmstrip owns its small bitmap LRU; this adapter never duplicates it.
 */
export class ThumbnailRenderer {
  constructor(
    editor,
    {
      baseURL = globalThis.location?.href,
      token = "",
      storedFrames = false,
      onError = () => {},
      idleMs = 300000,
    } = {},
  ) {
    this.editor = editor;
    this.options = { baseURL, token, storedFrames };
    this.onError = onError;
    this.layerAppearance=layerAppearance(editor.report._styk?.layers);
    this.draftSnapshot = editor.report._styk?.simpleFrameDraft;
    this.version = 1;
    this.sequence = 0;
    this.loadedVersion = 0;
    this.fullSnapshot = true;
    this.changedFrames = new Set();
    this.definitionsChanged = false;
    this.mirrorSources = new Map();
    this.changedSources = new Set();
    this.mirrorTables = null;
    this.pending = new Map();
    this.chain = Promise.resolve();
    this.queued = 0;
    this.paused = false;
    this.disposed = false;
    this.idleMs = idleMs;
    this.idleTimer = null;
    this.stats = {
      backend: "Worker thumbnails",
      snapshots: 0,
      patches: 0,
      chunks: 0,
      maxChunkBytes: 0,
      maxMainTaskMs: 0,
      renders: 0,
      lastRenderMs: 0,
      mediaBytes: 0,
      pending: 0,
      cancelled: 0,
      snapshotBytes: 0,
      lastSnapshotBytes: 0,
      sourceUpserts: 0,
      sourceDeletes: 0,
    };
    this.events = new AbortController();
    editor.addEventListener(
      "change",
      (event) => this.invalidate(event.detail || {}),
      { signal: this.events.signal },
    );
  }
  _worker() {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined")
      throw messageError(new Error(''), "errors.thumbnailRenderer.framePreviewsRequireABrowserWithWorkerCanvas", {});
    const worker = (this.worker = new Worker(
      new URL("./thumbnail-worker.mjs", import.meta.url),
      { type: "module", name: "StykAnimate frame thumbnails" },
    ));
    worker.addEventListener("message", (event) => {
      if (this.worker !== worker) { event.data.bitmap?.close(); return; }
      const message = event.data,
        request = this.pending.get(message.id);
      if (!request) {
        message.bitmap?.close();
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message);
      else {
        const error = restoreMessageError((message.error ? new Error(message.error) : messageError(new Error(''), "errors.thumbnailRenderer.framePreviewFailed")), message);
        error.name = message.name || "Error";
        request.reject(error);
      }
      this._scheduleIdle();
    });
    const fail = (error) => {
      if (this.worker !== worker) return;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      worker.terminate();
      this.worker = null;
      this.snapshot = null;
      this.fullSnapshot = true;
      this.loadedVersion = 0;
      this._clearMirror();
      this.onError(error);
    };
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.thumbnailRenderer.framePreviewWorkerStopped")));
    });
    worker.addEventListener("messageerror", () =>
      fail(messageError(new Error(''), "errors.thumbnailRenderer.framePreviewCouldNotBeTransferred", {})),
    );
    return worker;
  }
  invalidate(detail = {}) {
    const appearance=detail.layers||detail.kind==='document'?layerAppearance(this.editor.report._styk?.layers):this.layerAppearance;
    const visual=thumbnailVisualChange(detail,this.layerAppearance,appearance);this.layerAppearance=appearance;if(!visual)return;
    const draft = this.editor.report._styk?.simpleFrameDraft;
    const previous = this.draftSnapshot;
    this.draftSnapshot = draft;
    // A seek or a clean Add/Update toggle changes draft bookkeeping, not pixels.
    if (detail.kind === 'frame-draft' &&
        !(previous?.mode === 'add' && previous.baseline || draft?.mode === 'add' && draft.baseline) &&
        Boolean(previous?.empty) === Boolean(draft?.empty)) return;
    this.version++;
    this.snapshot?.iterator.return?.();
    this.snapshot = null;
    if (
      detail.kind === "document" ||
      (detail.kind === "history" && !detail.animation && !detail.frameIndices) ||
      (detail.structural && !detail.layerSheet)
    ) {
      this.fullSnapshot = true;
      this._clearMirror();
    }
    for (const index of detail.frameIndices || detail.changedFrames || [
      detail.frameIndex ?? this.editor.frameIndex,
    ])
      this.changedFrames.add(index);
    if (detail.definition) this.definitionsChanged = true;
    for (const id of detail.sourceIds || []) this.changedSources.add(id);
    // Definition commands can also repair source poses in place.
    if (detail.definition) for (const id of Object.keys(this.editor.report._styk?.frameSources || {})) this.changedSources.add(id);
    this.currentAbort?.abort();
  }
  setPaused(paused) {
    if(this.paused===Boolean(paused))return;
    this.paused = Boolean(paused);
    if (this.paused) this.currentAbort?.abort();
  }
  _clearMirror() {
    this.mirrorSources.clear();
    this.changedSources.clear();
    this.mirrorTables = null;
  }
  _scheduleIdle() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (!this.worker || this.pending.size || this.disposed || this.idleMs <= 0) return;
    // An idle worker still pins a whole document mirror. Release it after a
    // rest; the next render pays one full snapshot instead of a small patch.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.worker || this.pending.size || this.disposed) return;
      const worker = this.worker;
      this.worker = null;
      this.snapshot?.iterator.return?.();
      this.snapshot = null;
      this.fullSnapshot = true;
      this.loadedVersion = 0;
      this._clearMirror();
      worker.terminate();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
  async _request(operation, data, signal) {
    if (signal?.aborted || this.disposed) throw abortError();
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const worker = this._worker(),
      id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const request = this.pending.get(id);
        if (!request) return;
        this.stats.cancelled++;
        // Keep backpressure until an in-flight native frame exits the worker;
        // another request must never race its reusable canvas/media context.
        if (operation === "render") {
          worker.postMessage({ operation: "cancel", request: id });
          return;
        }
        this.pending.delete(id);
        clearTimeout(request.timer);
        signal?.removeEventListener("abort", cancel);
        reject(abortError());
        this._scheduleIdle();
      };
      const finish = (callback) => (value) => {
        signal?.removeEventListener("abort", cancel);
        callback(value);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.fullSnapshot = true;
        this.loadedVersion = 0;
        this.snapshot = null;
        this._clearMirror();
        reject(messageError(new Error(''), "errors.thumbnailRenderer.framePreviewTimedOut", {}));
      }, 60000);
      this.pending.set(id, {
        resolve: finish(resolve),
        reject: finish(reject),
        timer,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        worker.postMessage({ id, operation, ...data });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(error);
      }
    });
  }
  async _snapshot(version, signal) {
    await drawingBarrier(this.editor.report,{signal});if(version!==this.version||signal.aborted)throw abortError();
    if (this.loadedVersion === version) return;
    // A scroll or canvas gesture cancels the bitmap request, not acknowledged
    // snapshot progress. Resume the same bounded transfer when the user rests.
    // Document edits discard it, because its remaining records may have changed.
    let snapshot=this.snapshot;
    if(!snapshot||snapshot.version!==version){
      const report = this.editor.report;
      const { _stykSource, keyframes, figure_types, ...properties } = report;
      const full = this.fullSnapshot || !this.loadedVersion || this.mirrorTables?.frames !== keyframes.length;
      const frames = [...this.changedFrames]
        .filter((index) => keyframes[index])
        .map((index) => ({ index, frame: keyframes[index] }));
      const sources = retainedSourceChanges(report, this.mirrorSources, this.changedSources);
      // Retain uncertainty until the complete transaction is acknowledged. A
      // cancelled request can already have committed on the worker.
      for (const {id} of sources) this.changedSources.add(id);
      const tables = {frames:keyframes.length, figures:figure_types};
      const sourceSnapshot = full ? new Map(Object.entries(report._styk?.frameSources || {})) : null;
      const payload = full
        ? { ...properties, figure_types, keyframes }
        : {
            properties: playbackProperties(report),
            frames,
            sources,
            hasFrameSources: report._styk?.frameSources !== undefined,
            ...(this.definitionsChanged || this.mirrorTables?.figures !== figure_types ? { figure_types } : {}),
            // Background records have legacy in-place edits without source IDs.
            ...(report.backgrounds ? {backgrounds:report.backgrounds} : {}),
          };
      const iterator = documentChunks(payload, {
        maxBytes: 64 * 1024,
        maxRecords: 128,
        timeBudgetMs: 2,
        sharedFigures: true,
      });
      snapshot=this.snapshot={version,iterator,full,sources,sourceSnapshot,tables,bytes:0};
    }
    const {iterator,full}=snapshot;
    try {
      for (;;) {
        if (version !== this.version || signal.aborted) throw abortError();
        const started = performance.now(),
          next = iterator.next();
        if (next.done) break;
        const task = this._request(
          "snapshot-chunk",
          {
            revision: version,
            mode: full ? "document" : "patch",
            chunk: next.value,
          },
          undefined,
        );
        this.stats.maxMainTaskMs = Math.max(
          this.stats.maxMainTaskMs,
          performance.now() - started,
        );
        this.stats.maxChunkBytes = Math.max(
          this.stats.maxChunkBytes,
          next.value.estimatedBytes || 0,
        );
        this.stats.chunks++;
        snapshot.bytes += next.value.estimatedBytes || 0;
        this.stats.snapshotBytes += next.value.estimatedBytes || 0;
        await task;
      }
      if (version !== this.version || signal.aborted) throw abortError();
      await this._request(
        "snapshot-complete",
        { revision: version, options: this.options },
        undefined,
      );
      if (version !== this.version) throw abortError();
      this.loadedVersion = version;
      if (full) this.mirrorSources = snapshot.sourceSnapshot;
      else for (const {id,frame} of snapshot.sources) {
        if (frame === null) this.mirrorSources.delete(id); else this.mirrorSources.set(id,frame);
      }
      this.mirrorTables = snapshot.tables;
      this.changedSources.clear();
      this.stats.lastSnapshotBytes = snapshot.bytes;
      this.stats.sourceUpserts = full ? this.mirrorSources.size : snapshot.sources.filter(entry=>entry.frame!==null).length;
      this.stats.sourceDeletes = full ? 0 : snapshot.sources.filter(entry=>entry.frame===null).length;
      if(this.snapshot===snapshot)this.snapshot=null;
      this.fullSnapshot = false;
      this.changedFrames.clear();
      this.definitionsChanged = false;
      full ? this.stats.snapshots++ : this.stats.patches++;
    }catch(error){
      if(error.name!=='AbortError'&&this.snapshot===snapshot){
        iterator.return?.();this.snapshot=null;this.fullSnapshot=true;
      }
      throw error;
    }
  }
  renderThumbnail = (index, canvas, { signal, inbetween, tick, storedFrames = this.options.storedFrames } = {}) => {
    if (this.disposed || this.paused || signal?.aborted)
      return Promise.resolve(false);
    // A caller outside the virtual filmstrip still cannot queue an unbounded scene backlog.
    if (this.queued >= 8) return Promise.resolve(false);
    this.queued++;
    this.stats.pending = this.queued;
    const version = this.version;
    const task = this.chain
      .catch(() => {})
      .then(async () => {
        if (
          this.disposed ||
          this.paused ||
          signal?.aborted ||
          version !== this.version
        )
          return false;
        const controller = (this.currentAbort = new AbortController());
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await this._snapshot(version, controller.signal);
          const result = await this._request(
            "render",
            {
              revision: version,
              index,
              width: canvas.width,
              height: canvas.height,
              storedFrames,
              ...(tick!==undefined?{tick}:{}),
              ...(inbetween ? {inbetween} : {}),
            },
            controller.signal,
          );
          try {
            if (
              controller.signal.aborted ||
              version !== this.version ||
              this.paused
            )
              return false;
            const context = canvas.getContext("2d");
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(result.bitmap, 0, 0);
            this.stats.renders++;
            this.stats.lastRenderMs = result.renderMs;
            this.stats.mediaBytes = result.mediaBytes;
            return true;
          } finally {
            result.bitmap.close();
          }
        } catch (error) {
          if (error.name === "AbortError") return false;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          if (this.currentAbort === controller) this.currentAbort = null;
        }
      });
    this.chain = task;
    return task.finally(() => {
      this.queued--;
      this.stats.pending = this.queued;
    });
  };
  destroy() {
    this.disposed = true;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this.snapshot?.iterator.return?.();this.snapshot=null;
    this.events.abort();
    this.currentAbort?.abort();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(abortError());
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this._clearMirror();
  }
}
