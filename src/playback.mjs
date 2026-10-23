import {restoreMessageError, messageError} from './localized-error.mjs';

import {drawingBarrier} from './drawing-resources.mjs';
import { timeline } from './pivot/geometry.mjs';
import { documentChunks } from './document-transport.mjs';
import {nativePlaybackChunks, MAX_NATIVE_PLAYBACK_BYTES} from './playback-native.mjs';
import { playbackProperties, retainedSourceChanges } from './playback-patch.mjs';
import {PlaybackPlanner} from './playback-planning.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {PlaybackBitmapPool,packetFootprint,closePacketBitmaps} from './playback-bitmap-pool.mjs';
import {playbackMemoryBudget, playbackWorkerMemoryPlan, playbackWorkerCount, playbackWorkerAdmissionBudget, playbackWorkerAdmission} from './playback-budget.mjs';
import {playbackRetentionSnapshot,unchangedPlaybackTicks} from './playback-retention.mjs';
import {softwareFrameSize} from './playback-software-size.mjs';

const MAX_WORKER_RESTARTS = 2;
// Workers take runs of consecutive ticks. Adjacent frames share retained
// geometry, artwork identities and rasters within one worker's caches; strict
// tick parity made every worker rebuild what its neighbor had just prepared.
export const PLAYBACK_LANE_TICKS = 8;
export const playbackLane = (tick, count, laneTicks = PLAYBACK_LANE_TICKS) => Math.floor(tick / laneTicks) % count;
const abortError = message => { const error = new Error(message); error.name = 'AbortError'; return error; };
const closePacket = closePacketBitmaps;
const yieldToInput = () => globalThis.scheduler?.yield ? scheduler.yield() : new Promise(resolve => {
  const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);
});

/**
 * Bounded CPU packet LRU backed by native-evaluation workers. Rendering calls
 * get() only: a miss never silently evaluates the scene on the animation thread.
 * The owner advances one exact tick after its packet arrives, holding on underrun.
 * Additional workers take disjoint lanes of consecutive ticks: each mirrors the
 * document and prepares its own packets, so dense scenes produce several frames
 * at once while admission, ordering and delivery acknowledgement stay here.
 */
export class PlaybackCache {
  constructor({ maxBytes = playbackMemoryBudget(), maxFrames = 120, maxPending = 120,
    baseURL = globalThis.location?.href, token = '', scale = 1, gpuIsolation = false, onReady, onError, diagnostics, timeoutMs = 120000,
    workerCount, maxWorkerBytes, workerURL = new URL('./playback-worker.mjs', import.meta.url), workerFactory } = {}) {
    Object.assign(this, { maxBytes, maxFrames, maxPending, baseURL, token, scale, gpuIsolation, onReady, onError, diagnostics, timeoutMs });
    this.cache = new Map(); this.pending = new Map(); this.revision = 0; this.disposed = false; this.needsLoad = false;
    this.cacheNamespace = globalThis.crypto.randomUUID();
    this._mirrorAvailable = false; this._frameUpdates = new Map(); this._protectedTick = null; this._prefetchRanks = null;
    this._mirrorSources = new Map(); this._sourceUpdates = new Map(); this._figureUpdates = new Map();
    this._mirrorTables = null; this._patchPending = false;
    this._packetSizes = new Map(); this._sizeLimit = Math.max(256, maxFrames * 4, maxPending * 4); this._recentPacketBytes = 0; this._recentPacketSoftware = false;
    this.bitmapPool=new PlaybackBitmapPool();this._packetFootprints=new Map();this._footprintBytes=0;this._recentShared=false;
    this.stats = { backend: 'Worker prepared playback', revision: 0, readyFrames: 0, pendingFrames: 0, bytes: 0,bitmapResources:0,footprintBytes:0,
      maxBytes, maxFrames, hits: 0, misses: 0, evictions: 0, preparedFrames: 0, compileMs: 0, lastCompileMs: 0, loadMs: 0,
      loadChunks: 0, loadSerializationMs: 0, loadMaxTaskMs: 0, loadKind: null, updatedFrames: 0, droppedPrefetchFrames: 0, suppressedPrefetchFrames: 0, failure: null };
    // An injected factory is a controlled/test endpoint; it stays single-worker
    // unless the caller opts into pool behavior explicitly.
    const count = Math.max(1, Math.min(4, Math.floor(workerCount ?? (workerFactory ? 1 : playbackWorkerCount())) || 1));
    this._failures = 0; this.stats.workerRestarts = 0;
    this.workerLimit=count;this.workerURL=workerURL;this.workerFactory=workerFactory;
    // Explicit pool sizes remain controlled overrides. Tests can opt into
    // admission with an explicit allowance without faking global hardware.
    this.maxWorkerBytes=maxWorkerBytes??(workerCount===undefined&&!workerFactory?playbackWorkerAdmissionBudget():Infinity);
    if(!(this.maxWorkerBytes>0))throw messageError(new Error(''), "errors.playback.playbackWorkerAllowanceMustBePositive", {});
    this.workers=[];this.workerMemoryPlan=playbackWorkerMemoryPlan(maxBytes);
    this.stats.workerCaches=[];this.stats.workerCacheTotals={};this._resizeWorkers(count);
    // The primary worker owns one background planning stream across resizes.
    this.planner = new PlaybackPlanner(this);
  }
  /** Replaces a failed worker pool on its next use. Each document revision gets
   * a bounded number of fresh pools, so a scene that deterministically crashes
   * the worker cannot spin through idle warm-up; an edit or new document retries. */
  _recover(revision = this.documentRevision) {
    if (!this.failure || this.disposed) return true;
    if (revision === this._failedRevision && this._failures > MAX_WORKER_RESTARTS) return false;
    if (revision !== this._failedRevision) this._failures = 0;
    this.failure = null; this.stats.failure = null; this.stats.workerRestarts++;
    // The failed pool was terminated by _fail(). Recreate its admitted size
    // through the same owner used for memory-driven resizing.
    const count = this.workers.length;
    this.workers = [];
    this._resizeWorkers(count);
    // The new pool holds no mirror: send current options and reload the document.
    this.invalidate();
    return true;
  }
  _resizeWorkers(count) {
    for(const client of this.workers.splice(count))client.worker.terminate();
    while(this.workers.length<count){
      const index=this.workers.length;
      const worker = this.workerFactory ? this.workerFactory(this.workerURL) : new Worker(this.workerURL, {
        type: 'module', name: `StykAnimate playback preparation ${index + 1}` });
      const client = { worker, index, loadAck: null };
      worker.addEventListener('message', event => this._receive(event.data, client));
      worker.addEventListener('error', event => { event.preventDefault?.(); if(this.workers[index]===client)this._fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.playback.thePlaybackWorkerStoppedUnexpectedly"))); });
      worker.addEventListener('messageerror', () => {if(this.workers[index]===client)this._fail(messageError(new Error(''), "errors.playback.aPreparedPlaybackFrameCouldNotBeTransferred", {}));});
      this.workers.push(client);
      if(this.interactionActive)worker.postMessage({type:'interaction',active:true});
    }
    this.stats.workerCount = count;
    this.worker = this.workers[0].worker;
    this.stats.workerMemoryPlan = {...this.workerMemoryPlan, workers: count, poolRetainedBytes: this.workerMemoryPlan.retainedBytes * count};
    this.stats.workerCaches=Array(count).fill(null);this.stats.workerCacheTotals={};
  }
  _admitWorkers(documentBytes, nativeBytes, {restore=false}={}) {
    const plan=playbackWorkerAdmission({maxWorkers:restore?this.workerLimit:this.workers.length,
      maxBytes:this.maxWorkerBytes,frameBytes:this.maxBytes,documentBytes,nativeBytes});
    if(plan.workers!==this.workers.length)this._resizeWorkers(plan.workers);
    this.stats.workerAdmission={...plan,maxWorkers:this.workerLimit,reduced:plan.workers<this.workerLimit};
  }
  load(report, { scale = this.scale, revision, cameraEnabled = true, storedFrames = false, softwareFrames = false, hiddenUids, hiddenKey = '' } = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.playback.thePlaybackCacheHasBeenDisposed", {});
    const available = this._recover(revision);
    report = report?.document ?? report?.report ?? report;
    const staged = this._nativeSnapshot;
    const native = staged?.report === report && staged.revision === revision && staged.isCurrent() &&
      staged.snapshot.frames === report.keyframes ? staged : null;
    this.invalidate(); this.report = report; this.scale = scale; this.cameraEnabled = cameraEnabled;
    this.softwareFrames = softwareFrames; this.hiddenUids = hiddenUids; this.hiddenKey = hiddenKey;
    this.documentRevision = revision; this.storedFrames = storedFrames; this._refreshTimeline();
    this.needsLoad = true; if (available) this._loadWorker(native); return this;
  }
  stageNativeSnapshot(report, snapshot, {revision, isCurrent}) {
    this.discardNativeSnapshot();
    if(this.disposed || this.failure || !snapshot || snapshot.frames !== report?.keyframes || typeof isCurrent !== 'function' ||
      snapshot.buffer.byteLength > Math.min(MAX_NATIVE_PLAYBACK_BYTES, this.maxBytes / 4) ||
      this.report === report && (this._loadPromise || this._mirrorAvailable) || !isCurrent()) return false;
    this._nativeSnapshot = {report, snapshot, revision, isCurrent};
    this.stats.nativeStagedBytes = snapshot.buffer.byteLength;
    return true;
  }
  discardNativeSnapshot() {
    this._nativeSnapshot = null; this.stats.nativeStagedBytes = 0;
  }
  setInteractionActive(active) {
    active=Boolean(active);
    if(active===this.interactionActive)return;
    this.interactionActive=active;
    // Speculative packet rasterization shares the GPU with the editable canvas.
    // Suspend it as well as snapshot serialization while foreground input owns
    // the frame budget. Suspended requests must not time out during a long drag.
    for(const pending of this.pending.values()){
      clearTimeout(pending.timer);
      pending.timer=!active&&this.timeoutMs>0?setTimeout(()=>this._fail(messageError(new Error(''), "errors.playback.playbackPreparationTimedOut", {})),this.timeoutMs):null;
    }
    if(!this.disposed)for(const client of this.workers)client.worker.postMessage({type:'interaction',active});
    if(!active){this._releaseInteraction?.();this._releaseInteraction=null;this._interactionPromise=null;}
  }
  setVfxEnabled(enabled){
    enabled=Boolean(enabled);if(enabled===(this.vfxEnabled!==false))return;
    this.vfxEnabled=enabled;this.invalidate({retainDocument:this._mirrorAvailable&&!this.needsLoad&&!this._patchPending});
    if(this.needsLoad)this._loadWorker();
  }
  async _yieldLoad(revision) {
    await yieldToInput();
    if(revision!==this.revision||this.disposed)throw abortError('Playback snapshot was superseded.');
    if(this.failure)throw this.failure;
    if(this.interactionActive&&!this.disposed)await (this._interactionPromise??=new Promise(resolve=>{this._releaseInteraction=resolve;}));
    if(revision!==this.revision||this.disposed)throw abortError('Playback snapshot was superseded.');
    if(this.failure)throw this.failure;
  }
  updateView({ scale = this.scale, cameraEnabled = this.cameraEnabled, storedFrames = this.storedFrames,
    softwareFrames = this.softwareFrames, hiddenUids = this.hiddenUids, hiddenKey = this.hiddenKey } = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.playback.thePlaybackCacheHasBeenDisposed", {});
    if (scale === this.scale && cameraEnabled === this.cameraEnabled && storedFrames === this.storedFrames &&
      softwareFrames === this.softwareFrames && hiddenKey === this.hiddenKey) return this;
    if (!this.report) { this.scale = scale; this.cameraEnabled = cameraEnabled; this.storedFrames = storedFrames; this.softwareFrames = softwareFrames; this.hiddenUids = hiddenUids; this.hiddenKey = hiddenKey; return this; }
    // Preserve an unfinished edit when the view changes; ordinary view changes
    // keep the acknowledged mirror without resending scene data.
    if (!this._mirrorAvailable || this.needsLoad)
      return this.load(this.report, { revision: this.documentRevision, scale, cameraEnabled, storedFrames, softwareFrames, hiddenUids, hiddenKey });
    if (this._patchPending || this._frameUpdates.size || this._sourceUpdates.size || this._figureUpdates.size)
      return this.updateDocument({revision: this.documentRevision, scale, cameraEnabled, storedFrames, softwareFrames, hiddenUids, hiddenKey});
    // Packets carry their own camera mode. A camera-only toggle such as
    // timeline scrubbing keeps them so playback resumes warm instead of cold.
    // Bitmap packets bake visibility: a different hidden signature drops them.
    const retainTicks = scale === this.scale && storedFrames === this.storedFrames &&
      (!softwareFrames || hiddenKey === this.hiddenKey) ? new Set(this.cache.keys()) : undefined;
    this.invalidate({ scale, cameraEnabled, storedFrames, softwareFrames, hiddenUids, hiddenKey, retainDocument: true, retainTicks }); this._refreshTimeline();
    this._retentionSnapshot = playbackRetentionSnapshot(this.report, this.entries, this); return this;
  }
  updateFrame(index, frame, { revision = this.documentRevision } = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.playback.thePlaybackCacheHasBeenDisposed", {});
    if (!Number.isInteger(index) || index < 0 || index >= (this.report?.keyframes?.length || 0) || frame !== this.report.keyframes[index])
      throw messageError(new Error(''), "errors.playback.playbackFrameUpdatesMustReferenceAFrameIn", {});
    return this.updateDocument({frameIndices: [index], revision, loadKind: 'frame'});
  }
  planLayerMigration(request, options) {return this.planner.planLayerMigration(request, options);}
  planInsertInbetweens(request, options) {return this.planner.planInsertInbetweens(request, options);}
  _refreshTimeline() {
    const report = this.storedFrames ? storedFrameReport(this.report, {validate: false}) : this.report;
    this.entries = timeline(report); const last = this.entries.at(-1); this.totalTicks = last ? last.start + last.count : 0;
  }
  _snapshotTables() {
    return {definitions: [...(this.report.figure_types || [])], backgrounds: [...(this.report.backgrounds || [])],
      frameIds: this.report.keyframes.map(frame => frame._styk?.frameId ?? null)};
  }
  _tablesMatch() {
    const tables = this._mirrorTables, report = this.report;
    return tables && tables.frameIds.length === report.keyframes.length &&
      tables.frameIds.every((id, index) => id === (report.keyframes[index]._styk?.frameId ?? null)) &&
      tables.definitions.length === (report.figure_types?.length || 0) && tables.definitions.every((value, index) => value === report.figure_types[index]) &&
      tables.backgrounds.length === (report.backgrounds?.length || 0) && tables.backgrounds.every((value, index) => value === report.backgrounds[index]);
  }
  updateDocument({frameIndices = [], sourceIds = [], figureIndices = [], revision = this.documentRevision, scale = this.scale,
    cameraEnabled = this.cameraEnabled, storedFrames = this.storedFrames, softwareFrames = this.softwareFrames,
    hiddenUids = this.hiddenUids, hiddenKey = this.hiddenKey, structural = false, definition = false, loadKind = 'patch'} = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.playback.thePlaybackCacheHasBeenDisposed", {});
    if (!this.report) throw messageError(new Error(''), "errors.playback.loadADocumentBeforeUpdatingPlayback", {});
    for (const index of frameIndices) if (!Number.isInteger(index) || index < 0 || index >= (this.report?.keyframes.length || 0))
      throw messageError(new Error(''), "errors.playback.playbackFrameUpdatesMustReferenceAFrameIn", {});
    for (const index of figureIndices) if (!Number.isInteger(index) || index < 0 || index >= (this.report?.figure_types?.length || 0))
      throw messageError(new Error(''), "errors.playback.playbackFigureUpdatesMustReferenceAFigureIn", {});
    for (const id of sourceIds) if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(id)) throw messageError(new Error(''), "errors.playback.invalidRetainedPlaybackSourceId", {});
    if (!this._mirrorAvailable || this.needsLoad || structural || (definition && !figureIndices.length) || !this._tablesMatch())
      return this.load(this.report, {revision, scale, cameraEnabled, storedFrames, softwareFrames, hiddenUids, hiddenKey});
    for (const index of frameIndices) this._frameUpdates.set(index, {frame: this.report.keyframes[index]});
    // In-place definition edits travel as sparse figure replacements; the worker
    // validates figure_type_id identity so a stale write can never land.
    for (const index of figureIndices) this._figureUpdates.set(index, {figure: this.report.figure_types[index]});
    const sourceChanges = retainedSourceChanges(this.report, this._mirrorSources, [...this._sourceUpdates.keys(), ...sourceIds]);
    const dirtySources = new Set(sourceChanges.map(entry => entry.id));
    // Keep all uncertain IDs until an ACK. A cancelled transaction may already
    // have committed in the worker while its ACK was still crossing threads.
    for (const {id, frame} of sourceChanges) this._sourceUpdates.set(id, {frame});
    const previousSnapshot = this._retentionSnapshot;
    this._refreshTimeline();
    const nextSnapshot = playbackRetentionSnapshot(this.report, this.entries, {scale, cameraEnabled, storedFrames});
    const figureUpdates = [...this._figureUpdates];
    // A replaced figure can appear on any tick; sparse updates drop every
    // retained packet instead of guessing which exposures show the cel.
    const retainTicks = figureUpdates.length ? new Set() : unchangedPlaybackTicks(previousSnapshot, nextSnapshot, this.cache.values(), this._frameUpdates.keys(), dirtySources);
    this.invalidate({revision, scale, cameraEnabled, storedFrames, softwareFrames, hiddenUids, hiddenKey, retainDocument: true, retainTicks}); this._patchPending = true;
    this._retentionSnapshot = nextSnapshot;
    const generation = this.revision, updates = [...this._frameUpdates], sourceUpdates = [...this._sourceUpdates], started = performance.now();
    const payload = {properties: playbackProperties(this.report), frames: updates.map(([index, entry]) => ({index, frame: entry.frame})),
      sources: sourceUpdates.map(([id, entry]) => ({id, frame: entry.frame})), hasFrameSources: this.report._styk?.frameSources !== undefined,
      figureUpdates: figureUpdates.map(([index, entry]) => ({index, figure: entry.figure}))};
    Object.assign(this.stats, {loadKind, loadChunks: 0, loadSerializationMs: 0, loadMaxTaskMs: 0, maxChunkBytes: 0,
      patchFrames: updates.length, patchFigures: figureUpdates.length,
      patchSourceUpserts: sourceUpdates.filter(([, entry]) => entry.frame !== null).length,
      patchSourceDeletes: sourceUpdates.filter(([, entry]) => entry.frame === null).length});
    const task = (async () => {
      await drawingBarrier(this.report);
      let sequence = 0; const iterator = documentChunks(payload, {maxBytes: 64 * 1024, maxRecords: 128, timeBudgetMs: 2});
      for (;;) {
        if (generation !== this.revision || this.disposed) throw abortError('Playback document updates were superseded.');
        const step = performance.now(), next = iterator.next(); if (next.done) break;
        const sent = this._broadcastLoad({type: 'patch-chunk', revision: generation, sequence: sequence++, chunk: next.value});
        this.stats.loadMaxTaskMs = Math.max(this.stats.loadMaxTaskMs, performance.now() - step);
        this.stats.maxChunkBytes = Math.max(this.stats.maxChunkBytes, next.value.estimatedBytes || 0); await sent;
        await this._yieldLoad(generation);
      }
      await this._broadcastLoad({type: 'patch-complete', revision: generation, sequence}, 'loaded');
      if (generation === this.revision) {
        for (const [index, entry] of updates) if (this._frameUpdates.get(index) === entry) this._frameUpdates.delete(index);
        for (const [index, entry] of figureUpdates) {
          this._mirrorTables.definitions[index] = entry.figure;
          if (this._figureUpdates.get(index) === entry) this._figureUpdates.delete(index);
        }
        for (const [id, entry] of sourceUpdates) {
          if (entry.frame === null) this._mirrorSources.delete(id); else this._mirrorSources.set(id, entry.frame);
          if (this._sourceUpdates.get(id) === entry) this._sourceUpdates.delete(id);
        }
        this._patchPending = false;
        this.stats.loadMs = performance.now() - started; this.stats.updatedFrames += updates.length;
      }
    })();
    this._loadPromise = task;
    task.catch(error => { if (generation === this.revision && error.name !== 'AbortError') this._fail(error); })
      .finally(() => { if (this._loadPromise === task) this._loadPromise = null; });
    return this;
  }
  invalidate({ scale = this.scale, revision = this.documentRevision, cameraEnabled = this.cameraEnabled, storedFrames = this.storedFrames,
    softwareFrames = this.softwareFrames, hiddenUids = this.hiddenUids, hiddenKey = this.hiddenKey, retainDocument = false, retainTicks } = {}) {
    this.discardNativeSnapshot();
    this.planner.cancel(abortError('Background planning was invalidated by a document or view change.'));
    this._abortLoad(abortError('Playback snapshot was invalidated by a document change.'));
    this.stats.nativeSourceBytes = 0;
    this.revision++; this.scale = scale; this.documentRevision = revision; this.cameraEnabled = cameraEnabled; this.storedFrames = storedFrames;
    this.softwareFrames = softwareFrames; this.hiddenUids = hiddenUids; this.hiddenKey = hiddenKey;
    for (const [tick, packet] of this.cache) if (!retainTicks?.has(tick)) {this.bitmapPool.release(packet); this.cache.delete(tick);}
    if (!this.cache.size) this.cacheEpoch = `${this.cacheNamespace}:${this.revision}`;
    this._retentionSnapshot = null;
    this._protectedTick = null;
    this._prefetchRanks = null;
    for (const tick of this._packetSizes.keys()) if (!this.cache.has(tick)) this._packetSizes.delete(tick);
    for (const tick of this._packetFootprints.keys()) if (!this.cache.has(tick)) this._packetFootprints.delete(tick);
    this._footprintBytes = [...this._packetFootprints.values()].reduce((sum, entry) => sum + entry.metadataBytes, 0);
    const latest = [...this.cache.values()].at(-1);
    this._recentPacketBytes = latest?.byteLength || 0; this._recentPacketSoftware = Boolean(latest?.softwareFrames);
    this._recentShared = Boolean(latest?.compatibility?.some(entry => entry.artworkKey !== undefined));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(abortError('Playback preparation was invalidated by a document change.')); }
    this.pending.clear();
    Object.assign(this.stats, { revision: this.revision, bytes: this.bitmapPool.bytes, readyFrames: this.cache.size, retainedFrames: this.cache.size,
      pendingFrames: 0,bitmapResources:this.bitmapPool.resources.size,footprintBytes:this._footprintBytes,workerCache:null,lastSharing:null,reusedGeometryObjects:0 });
    if (!retainDocument) {
      this.stats.workerCaches.fill(null); this.stats.workerCacheTotals = {};
      this.stats.workerAdmission=null;
      this._mirrorAvailable = false; this._frameUpdates.clear(); this._sourceUpdates.clear();
      this._figureUpdates.clear();
      this._mirrorSources.clear(); this._mirrorTables = null; this._patchPending = false;
    }
    this.needsLoad = Boolean(this.report) && !retainDocument;
    if (!this.disposed) for (const client of this.workers)
      client.worker.postMessage({ type: 'invalidate', revision: this.revision, retainDocument, options: { scale, cameraEnabled, storedFrames, softwareFrames, gpuIsolation:this.gpuIsolation, hiddenUids, hiddenKey, vfxEnabled:this.vfxEnabled!==false } });
    return this;
  }
  _loadWorker(native = null) {
    if (!this.needsLoad) return this._loadPromise || Promise.resolve();
    this.needsLoad = false;
    this._refreshTimeline();
    this._retentionSnapshot = playbackRetentionSnapshot(this.report, this.entries, this);
    const start = performance.now(), revision = this.revision, tables = this._snapshotTables(), sources = new Map(Object.entries(this.report._styk?.frameSources || {}));
    // Original encoded source is useful for saving, but has no role in playback.
    const { _stykSource, ...renderReport } = this.report;
    if(renderReport._styk?.audio){const {audio,...metadata}=renderReport._styk;renderReport._styk=metadata;}
    // Leave room for background commands inside the existing cache allocation.
    // Texture bytes do not share WebGPU's per-storage-buffer size limit; the
    // worker checks vector buffers separately instead of capping all pixels.
    const options = { scale: this.scale, cameraEnabled: this.cameraEnabled, storedFrames: this.storedFrames, vfxEnabled:this.vfxEnabled!==false, baseURL: this.baseURL, token: this.token,
      softwareFrames: Boolean(this.softwareFrames), gpuIsolation: this.gpuIsolation, hiddenUids: this.hiddenUids, hiddenKey: this.hiddenKey || '',
      acknowledgePackets: true, maxPacketBytes: this.maxBytes * .8, maxAssetBytes: this.workerMemoryPlan.images,
      maxRasterBytes: this.workerMemoryPlan.rasters, maxVectorBytes: this.workerMemoryPlan.vectors,
      maxSoftwareFilterBytes: this.workerMemoryPlan.softwareFilters, maxBackgroundBytes: this.workerMemoryPlan.backgrounds };
    this.stats.loadKind = 'document'; this.stats.loadChunks = 0; this.stats.loadSerializationMs = 0; this.stats.loadMaxTaskMs = 0;
    this.stats.maxChunkBytes = 0; this.stats.patchFrames = 0; this.stats.patchFigures = 0;
    this.stats.patchSourceUpserts = 0; this.stats.patchSourceDeletes = 0;
    this.stats.documentTransferEstimate = 0; this.stats.nativeTransferBytes = 0;
    this.stats.loadTransport = native ? 'native-frames' : 'document';
    this.stats.nativeSourceBytes = native?.snapshot.buffer.byteLength || 0;
    const task = (async () => {
      await drawingBarrier(this.report);
      if(revision!==this.revision||this.disposed)throw abortError('Playback snapshot was superseded.');
      let documentBytes=native?.snapshot.poseBytesEstimate||0;
      const nativeBytes=native?.snapshot.meta.byteLength||0;
      this._admitWorkers(documentBytes,nativeBytes,{restore:true});
      let sequence = 0;
      const snapshotReport = native ? {...renderReport, keyframes: renderReport.keyframes.map(frame =>
        Object.hasOwn(frame, '_styk') ? {_styk: frame._styk} : {})} : renderReport;
      for (const chunk of documentChunks(snapshotReport,{maxBytes:1024*1024,timeBudgetMs:2,sharedFigures:true})) {
        if (revision !== this.revision || this.disposed) throw abortError('Playback snapshot was superseded.');
        documentBytes+=chunk.estimatedBytes||0;
        // Only resize between fully acknowledged chunks, before any lane can
        // prepare packets. Tick lanes are stable once the mirror is published.
        this._admitWorkers(documentBytes,nativeBytes);
        await this._broadcastLoad({ type: 'load-chunk', revision, sequence: sequence++, chunk, options });
        if (revision === this.revision) this.stats.documentTransferEstimate += (chunk.estimatedBytes || 0) * this.workers.length;
        await this._yieldLoad(revision);
      }
      if(native) for(const chunk of nativePlaybackChunks(native.snapshot)) {
        if(revision !== this.revision || this.disposed) throw abortError('Native playback snapshot was superseded.');
        await this._broadcastLoad({type:'load-native-chunk', revision, sequence:sequence++, ...chunk});
        if(revision === this.revision) this.stats.nativeTransferBytes += chunk.buffer.byteLength * this.workers.length;
        await this._yieldLoad(revision);
      }
      await this._broadcastLoad({ type: 'load-complete', revision, sequence }, 'loaded');
      if (revision === this.revision) { this.stats.loadMs = performance.now() - start; this._mirrorAvailable = true; this._mirrorTables = tables; this._mirrorSources = sources; }
    })();
    this._loadPromise = task;
    // load() deliberately returns immediately; prepareRange() observes failures.
    task.catch(error => { if (revision === this.revision && error.name !== 'AbortError') this._fail(error); })
      .finally(() => { if (revision === this.revision) this.stats.nativeSourceBytes = 0; if (this._loadPromise === task) this._loadPromise = null; });
    return task;
  }
  // A patch/load stream mirrors the identical document into every worker. Each
  // chunk waits for all workers to acknowledge so no lane can prepare a
  // packet from a partial mirror.
  _broadcastLoad(message, responseType) {
    return Promise.all(this.workers.map(client => this._sendLoad(client, message, responseType)));
  }
  _sendLoad(client, message, responseType = 'load-ack') {
    // The preceding ACK may resolve just before another document replaces this
    // generation. Its resumed continuation must never replace the new waiter.
    if (this.disposed || message.revision !== this.revision)
      return Promise.reject(abortError('Playback snapshot was superseded.'));
    // A failed pool never acknowledges; its replacement reloads from scratch.
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = this.timeoutMs > 0 ? setTimeout(() => this._fail(messageError(new Error(''), "errors.playback.playbackSnapshotTimedOut", {})), this.timeoutMs) : null;
      client.loadAck = { revision: message.revision, sequence: message.sequence, responseType, resolve, reject, timer };
      try {
        const start = performance.now(); client.worker.postMessage(message); const elapsed = performance.now() - start;
        this.stats.loadChunks++; this.stats.loadSerializationMs += elapsed; this.stats.loadMaxTaskMs = Math.max(this.stats.loadMaxTaskMs, elapsed);
        this.stats.maxChunkBytes = Math.max(this.stats.maxChunkBytes || 0, message.chunk?.estimatedBytes || message.buffer?.byteLength || 0);
      } catch (error) { this._abortLoad(error); }
    });
  }
  _abortLoad(error) {
    // Retire suspended generations without ending foreground interaction.
    // A current replacement creates its own gate; old streams fail their
    // revision check before advancing or retaining the next snapshot chunk.
    this._releaseInteraction?.();this._releaseInteraction=null;this._interactionPromise=null;
    for (const client of this.workers)
      if (client.loadAck) { clearTimeout(client.loadAck.timer); client.loadAck.reject(error); client.loadAck = null; }
    this._loadPromise = null;
  }
  // A packet retained across a camera-view toggle was cropped for the other
  // mode. Reading paths evict it so the current view recompiles on demand.
  _kept(tick) {
    const packet = this.cache.get(tick);
    if (!packet) return false;
    const stale = (packet.cameraEnabled ?? true) !== (this.cameraEnabled ?? true) ||
      Boolean(packet.softwareFrames) !== Boolean(this.softwareFrames) ||
      (this.softwareFrames && (packet.hiddenKey || '') !== (this.hiddenKey || ''));
    if (!stale) return true;
    this.cache.delete(tick); this.bitmapPool.release(packet); this._packetSizes.delete(tick);
    const footprint = this._packetFootprints.get(tick);
    if (footprint) { this._packetFootprints.delete(tick); this._footprintBytes -= footprint.metadataBytes; this.stats.footprintBytes = this._footprintBytes; }
    Object.assign(this.stats, { bytes: this.bitmapPool.bytes, bitmapResources: this.bitmapPool.resources.size, readyFrames: this.cache.size });
    return false;
  }
  get(tick) {
    if (!this._kept(tick)) { this.stats.misses++; return null; }
    const packet = this.cache.get(tick);
    this.cache.delete(tick); this.cache.set(tick, packet); this.stats.hits++; return packet;
  }
  has(tick) { return this._kept(tick); }
  bufferedAhead(tick, count, end = this.totalTicks) {
    if(!this.has(tick))return false;
    const ticks=Array.from({length:Math.max(0,Math.min(count,end-tick))},(_,i)=>tick+i);
    // Admission learns unique bitmap footprints. A one-frame cache must never
    // wait for a second frame that cannot coexist with its protected next tick.
    return this._feasiblePrefetch(ticks).every(next=>this.has(next));
  }
  _feasiblePrefetch(ticks) {
    const feasible = [],seen=new Set(); let estimatedBytes = 0,probed=false;
    // Whole-frame software pixels have an exact cold footprint. Measurements
    // take over after pressure lowers worker quality; packet-format provenance
    // prevents an inherited vector estimate from seeding software admission.
    const coldBytes=this.softwareFrames?softwareFrameSize(this.report,{scale:this.scale}).byteLength:0;
    const recentBytes=this._recentPacketSoftware===Boolean(this.softwareFrames)?this._recentPacketBytes:0;
    for (const tick of ticks) {
      const storedFootprint=this._packetFootprints.get(tick),footprint=Boolean(storedFootprint?.softwareFrames)===Boolean(this.softwareFrames)?storedFootprint:undefined;
      const bytes=footprint?footprint.base+footprint.resources.reduce((n,[key,bytes])=>n+(seen.has(key)?0:bytes),0):recentBytes||coldBytes;
      // Always admit the next exact tick. Later unknown sizes follow the most
      // recent measurement for their format until their own packet arrives.
      if(feasible.length>=this.maxFrames)break;
      if(feasible.length&&estimatedBytes+bytes>this.maxBytes){
        // Discover one unknown frame's overlap. Its actual packet still passes
        // admission/eviction checks; a known non-fitting frame is not reprobed.
        if(!footprint&&this._recentShared&&this._recentPacketSoftware===Boolean(this.softwareFrames)&&!probed){feasible.push(tick);probed=true;}
        break;
      }
      feasible.push(tick); estimatedBytes += bytes;
      for(const [key] of footprint?.resources||[])seen.add(key);
    }
    return feasible;
  }
  _trimQueuedPrefetch() {
    if (!this._prefetchRanks?.size) return;
    const requested = [...this._prefetchRanks.keys()], feasible = this._feasiblePrefetch(requested);
    if (feasible.length === requested.length) return;
    const keep = new Set(feasible), previousRanks = this._prefetchRanks;
    this._prefetchRanks = new Map(feasible.map((tick, index) => [tick, index]));
    this.stats.suppressedPrefetchFrames += requested.length - feasible.length;
    for (const [tick, pending] of this.pending) if (previousRanks.has(tick) && !keep.has(tick)) {
      clearTimeout(pending.timer); this.pending.delete(tick);
      pending.reject(abortError('Playback prefetch was trimmed to the measured frame budget.'));
    }
    this.stats.pendingFrames = this.pending.size;
    // Trim as soon as a size arrives, before another animation tick. Otherwise
    // a cold 24-frame batch can continue rasterizing after only two frames fit.
    // Explicit requests outside the speculative window retain their queue slots.
    this._retainWorkerTicks([...new Set([...feasible, ...this.pending.keys()])]);
  }
  /** Pending requests retain their assigned owner when software windows change
   * lane length. GPU packets keep their established eight-tick routing. */
  _retainWorkerTicks(ticks) {
    const count = this.workers.length;
    for (const client of this.workers)
      client.worker.postMessage({ type: 'retain', revision: this.revision,
        ticks: count > 1 ? ticks.filter(tick => (this.pending.get(tick)?.workerIndex ??
          (this.softwareFrames ? -1 : playbackLane(tick, count))) === client.index) : ticks });
  }
  _workerTicks(ticks, index) {
    const count = this.workers.length;
    return count > 1 ? ticks.filter(tick => this.pending.get(tick)?.workerIndex === index) : ticks;
  }
  async prepareRange(ticks, { replacePending = false } = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.playback.thePlaybackCacheHasBeenDisposed", {});
    if (!this._recover()) throw this.failure;
    if (!this.report) return [];
    const revision = this.revision;
    await this._loadWorker();
    if (this.disposed || revision !== this.revision) throw abortError('Playback preparation was superseded.');
    if (replacePending) {
      const requested = [...new Set(ticks)].filter(tick => Number.isInteger(tick) && tick >= 0 && tick < this.totalTicks);
      const feasible = this._feasiblePrefetch(requested);
      this.stats.suppressedPrefetchFrames += requested.length - feasible.length;
      ticks = feasible;
      const keep = new Set(ticks);
      this._protectedTick = ticks[0] ?? null;
      this._prefetchRanks = new Map([...keep].map((tick, index) => [tick, index]));
      for (const [tick, pending] of this.pending) if (!keep.has(tick)) {
        clearTimeout(pending.timer); this.pending.delete(tick); pending.reject(abortError('Playback prefetch moved to a different frame window.'));
      }
      this._retainWorkerTicks([...keep]);
    }
    const requests = [], promises = [];
    // Large software frames often admit fewer ticks than a legacy lane. Short
    // consecutive runs use the admitted CPU workers in that real window while
    // keeping neighboring artwork in each worker when several ticks fit.
    const laneTicks=this.softwareFrames?Math.max(1,Math.min(PLAYBACK_LANE_TICKS,
      Math.floor(this._feasiblePrefetch([...new Set(ticks)]).length/this.workers.length))):PLAYBACK_LANE_TICKS;
    for (const tick of new Set(ticks)) {
      if (!Number.isInteger(tick) || tick < 0 || tick >= this.totalTicks) continue;
      if (this.has(tick)) continue;
      let pending = this.pending.get(tick);
      if (!pending) {
        if (this.pending.size >= this.maxPending) break;
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        const timer = this.timeoutMs > 0 && !this.interactionActive ? setTimeout(() => this._fail(messageError(new Error(''), "errors.playback.playbackPreparationTimedOut", {})), this.timeoutMs) : null;
        const measured=this.diagnostics?.enabled&&Math.random()<1/30;
        pending = { promise, resolve, reject, timer,workerIndex:playbackLane(tick,this.workers.length,laneTicks),...(measured?{measuredAt:performance.now(),context:this.diagnostics.context(),diagnosticGeneration:this.diagnostics.generation}: {}) }; this.pending.set(tick, pending); requests.push(tick);
      }
      promises.push(pending.promise);
    }
    this.stats.pendingFrames = this.pending.size;
    if (requests.length) for (const client of this.workers) {
      const own = this._workerTicks(requests, client.index);
      if (own.length) client.worker.postMessage({ type: 'prepare', revision, ticks: own,
        measuredTicks: own.filter(tick => this.pending.get(tick)?.measuredAt !== undefined) });
    }
    // Resolve without retaining packet references outside the LRU.
    await Promise.all(promises); return { revision, readyFrames: this.cache.size, requestedFrames: requests.length };
  }
  _receive(message, client = this.workers[0]) {
    try { return this._acceptMessage(message, client); }
    finally {
      // Admission/eviction and any queue trimming must reach the worker before
      // it starts allocating the next packet. Stale/dropped packets also ACK.
      if (message.type === 'packet' && message.deliveryId && this.workers[client.index]===client && !this.disposed && !this.failure)
        client.worker.postMessage({type:'packet-ack', revision:message.revision, deliveryId:message.deliveryId});
    }
  }
  _acceptMessage(message, client = this.workers[0]) {
    if (this.disposed || this.failure || this.workers[client.index]!==client || message.revision !== this.revision) { closePacket(message.packet); return; }
    if (client === this.workers[0] && this.planner.receive(message)) return;
    const loading = client.loadAck;
    if (loading && message.type === loading.responseType && message.sequence === loading.sequence) {
      clearTimeout(loading.timer); client.loadAck = null; loading.resolve(); return;
    }
    if (message.type === 'load-error') { this._fail(restoreMessageError(new Error(message.message), message)); return; }
    if (message.type === 'loaded') return;
    // Every current packet updates its owner, including packets discarded after
    // a prefetch trim. These snapshots describe the worker cache, not CPU LRU
    // residency; retaining a document through a view change retains its caches.
    if (message.type === 'packet' && message.packet?.workerCache) {
      this.stats.workerCaches[client.index] = {...message.packet.workerCache};
      const totals = {};
      for (const snapshot of this.stats.workerCaches) for (const [key, value] of Object.entries(snapshot || {}))
        if (Number.isFinite(value) && value >= 0) totals[key] = (totals[key] || 0) + value;
      this.stats.workerCacheTotals = totals;
    }
    const pending = this.pending.get(message.tick);
    if (!pending) { closePacket(message.packet); return; }
    // A cancelled window may request the same tick on a different software
    // lane before an obsolete transfer arrives. Only its current owner can
    // settle that request; the producer still receives its delivery ACK.
    if(pending.workerIndex!==undefined&&pending.workerIndex!==client.index){closePacket(message.packet);return;}
    clearTimeout(pending.timer); this.pending.delete(message.tick); this.stats.pendingFrames = this.pending.size;
    if (message.type === 'error') { const error = restoreMessageError(new Error(message.message), message); if (message.code) error.code = message.code; pending.reject(error); this.onError?.(error); return; }
    const packet = message.packet;
    if(pending.measuredAt!==undefined&&this.diagnostics?.enabled&&pending.diagnosticGeneration===this.diagnostics.generation&&packet){
      const roundtrip=performance.now()-pending.measuredAt,compute=message.measurement?.computeMs,queued=message.measurement?.queueMs;
      this.diagnostics.record('worker_roundtrip',roundtrip,pending.context);
      this.diagnostics.record('worker_compute',compute,pending.context);
      this.diagnostics.record('worker_queue',queued,pending.context);
      if(Number.isFinite(compute)&&Number.isFinite(queued))this.diagnostics.record('worker_transfer',Math.max(0,roundtrip-compute-queued),pending.context);
    }
    if (!packet) { pending.reject(messageError(new Error(''), "errors.playback.thePlaybackWorkerReturnedNoRenderPacket", {})); return; }
    this._failures = 0;
    this.diagnostics?.recovery('playback_worker','recovered');
    // Packet keys/revisions identify immutable compilation results. An epoch
    // identifies shared pixel ownership across explicitly retained revisions.
    packet.cacheEpoch = this.cacheEpoch;
    this._packetSizes.delete(packet.tick); this._packetSizes.set(packet.tick, packet.byteLength); this._recentPacketBytes = packet.byteLength; this._recentPacketSoftware = Boolean(packet.softwareFrames);
    const footprint=packetFootprint(packet);footprint.softwareFrames=Boolean(packet.softwareFrames);footprint.metadataBytes=32+footprint.resources.reduce((n,[key])=>n+32+key.length*2,0);
    this._footprintBytes-=this._packetFootprints.get(packet.tick)?.metadataBytes||0;
    this._packetFootprints.delete(packet.tick);this._packetFootprints.set(packet.tick,footprint);this._footprintBytes+=footprint.metadataBytes;
    this._recentShared=footprint.resources.length>0;
    while(this._packetFootprints.size>this._sizeLimit||this._footprintBytes>Math.max(65536,this.maxBytes/8)){
      const [tick,entry]=this._packetFootprints.entries().next().value;this._packetFootprints.delete(tick);this._footprintBytes-=entry.metadataBytes;
    }
    while (this._packetSizes.size > this._sizeLimit)this._packetSizes.delete(this._packetSizes.keys().next().value);
    this.stats.footprintBytes=this._footprintBytes;
    // One frame larger than the budget cannot be retained safely. Surface this
    // explicitly, allowing the application to offer its normal rendering path.
    if (packet.byteLength > this.maxBytes || this.maxFrames < 1) {
      closePacket(packet); const error = messageError(new Error(''), "errors.playback.aPlaybackFrameExceedsTheMbPreparationBudget", {value: Math.round(this.maxBytes / 1024 / 1024)});
      error.code = 'playback_frame_budget'; pending.reject(error); this.onError?.(error); return;
    }
    while (this.cache.size && (this.cache.size >= this.maxFrames || this.stats.bytes + this.bitmapPool.incrementalBytes(packet) > this.maxBytes)) {
      let victim, victimRank = -1;
      for (const entry of this.cache) if (entry[0] !== this._protectedTick) {
        const rank = this._prefetchRanks?.get(entry[0]) ?? Infinity;
        if (!victim || rank > victimRank) { victim = entry; victimRank = rank; }
      }
      const incomingRank = this._prefetchRanks?.get(packet.tick) ?? Infinity;
      if (!victim || (Number.isFinite(victimRank) && incomingRank > victimRank)) {
        // The next exact tick must survive a sudden jump in media size. Future
        // speculative packets may be prepared again after that tick is consumed.
        closePacket(packet); this.stats.droppedPrefetchFrames++; this.stats.readyFrames = this.cache.size;
        this._trimQueuedPrefetch(); pending.resolve(); return;
      }
      const [tick, oldest] = victim; this.cache.delete(tick); this.bitmapPool.release(oldest);this.stats.bytes=this.bitmapPool.bytes;this.stats.bitmapResources=this.bitmapPool.resources.size;this.stats.evictions++;
    }
    try{this.bitmapPool.acquire(packet);}catch(error){closePacket(packet);pending.reject(error);this.onError?.(error);return;}
    this.cache.set(packet.tick, packet);this.stats.bytes=this.bitmapPool.bytes;this.stats.bitmapResources=this.bitmapPool.resources.size;this.stats.readyFrames = this.cache.size;
    this.stats.preparedFrames++; this.stats.compileMs += packet.compileMs; this.stats.lastCompileMs = packet.compileMs;
    this.stats.workerCache=packet.workerCache;this.stats.lastSharing=packet.sharing;this.stats.reusedGeometryObjects=packet.reusedGeometryObjects;
    this._trimQueuedPrefetch();
    pending.resolve(); this.onReady?.(packet);
  }
  _fail(error) {
    if (this.failure) return;
    this.discardNativeSnapshot();
    this._mirrorAvailable = false;
    this.failure = error; this.stats.failure = error.message;
    this._failures = this._failedRevision === this.documentRevision ? this._failures + 1 : 1; this._failedRevision = this.documentRevision;
    this.diagnostics?.recovery('playback_worker','started');
    this.planner.cancel(error);
    this._abortLoad(error);
    for (const client of this.workers) client.worker.terminate();
    this.stats.workerCaches.fill(null); this.stats.workerCacheTotals = {};
    this.stats.workerAdmission=null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.stats.pendingFrames = 0; this.onError?.(error);
  }
  dispose() {
    if (this.disposed) return;
    this.setInteractionActive(false);
    this.disposed = true; this.invalidate(); for (const client of this.workers) client.worker.terminate(); this.report = null; this.entries = [];
  }
}
