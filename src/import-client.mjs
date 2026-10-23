import {restoreMessageError, messageError} from './localized-error.mjs';

/** File I/O boundary: bytes transfer to a worker; JSON parsing stays off the UI. */
import { applyDocumentChunk } from './document-transport.mjs';
import {materializeNativeFrames} from './import-wire.mjs';
import {nativePlaybackSnapshot} from './playback-native.mjs';
import {codecJob} from './codec-job.mjs';
import {codecRequest} from './codec-request.mjs';
export class ImportClient {
  // The desktop codec requires its per-launch token; the browser dev server has none.
  constructor({baseURL = globalThis.location?.origin, token = globalThis.stykDesktop?.apiToken || '', timeoutMs = 180000,
    workerURL = new URL('./import-worker.mjs', import.meta.url)} = {}) {
    if (!baseURL) throw messageError(new Error(''), "errors.importClient.theImporterRequiresALocalBackendUrl", {});
    this.baseURL = new URL(baseURL, globalThis.location?.href).origin;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.cancelGeneration = 0;
    this.pending = new Map();
    this.sourceOwners = new Map();
    this.activeSourceOwner = null;
    this.sourceRelease = Promise.resolve();
    this.disposed = false;
    this.failure = null;
    this.workerURL=workerURL;this._startWorker();
  }

  _startWorker() {
    const worker = new Worker(this.workerURL, {type: 'module', name: 'StykAnimate file importer'});
    this.worker=worker;this.failure=null;
    worker.addEventListener('message', event => {if(this.worker===worker)this._receive(event.data);});
    worker.addEventListener('messageerror', () => {if(this.worker===worker)this._fail(Object.assign(messageError(new Error(''), "errors.importClient.theImportedProjectCouldNotBeTransferred", {}), { telemetryCode: 'snapshot_failed', telemetryStage: 'prepare' }));});
    worker.addEventListener('error', event => {
      event.preventDefault();
      if(this.worker===worker)this._fail(Object.assign((event.message ? new Error(event.message) : messageError(new Error(''), "errors.importClient.theFileImporterStoppedUnexpectedly")), { telemetryCode: 'worker_failed', telemetryStage: 'decode' }));
    });
  }

  _receive(message) {
    const request = this.pending.get(message?.id);
    if (!request) return;
    if(message.progress){request.onProgress?.(message.progress);return;}
    if(message.ok && message.nativeFrames) {
      if(request.materializing) return;
      request.materializing=true;
      const {buffer,offset}=message.nativeFrames;
      const result=message.complete?{...message.result,document:request.document}:message.result;
      const nativeMeta=result.nativeFrames;
      materializeNativeFrames(result,buffer,offset,{isCancelled:()=>this.pending.get(message.id)!==request}).then(result=>{
        if(this.pending.get(message.id)!==request) return;
        const snapshot=nativePlaybackSnapshot(result.document,buffer,offset,nativeMeta,result.timings.native_pose_bytes_estimate);
        if(snapshot)result.playbackFrames=snapshot;
        this.pending.delete(message.id);clearTimeout(request.timer);this._complete(request,result);
      },error=>{
        if(this.pending.get(message.id)!==request) return;
        this.pending.delete(message.id);clearTimeout(request.timer);this._cancelRequest(request);request.reject(error);
      });
      return;
    }
    if (message.chunk) {
      try {
        request.document = applyDocumentChunk(request.document, message.chunk);
        this.worker.postMessage({ operation: 'ack', id: message.id, sequence: message.sequence });
      } catch (error) {
        this.pending.delete(message.id); clearTimeout(request.timer); this._cancelRequest(request); this.worker.postMessage({ operation: 'cancel', id: message.id }); request.reject(error);
      }
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) { this._complete(request,message.complete ? { ...message.result, document: request.document } : message.result); }
    else {
      this._cancelRequest(request);
      const error = restoreMessageError((message.error?.message ? new Error(message.error?.message) : messageError(new Error(''), "errors.importClient.thisFileCouldNotBeImported")), message.error);
      if (message.error?.code) error.code = message.error.code;
      if (message.error?.status) error.status = message.error.status;
      error.telemetryCode = message.error?.telemetryCode; error.telemetryStage = message.error?.telemetryStage;
      error.telemetryFrames=message.error?.telemetryFrames;error.name=message.error?.name||'Error';
      request.reject(error);
    }
  }

  _complete(request,result) {
    if (request.sourceOwner && result?.sourceId && result.sourceOwner !== request.sourceOwner) {
      this._cancelRequest(request);
      request.reject(messageError(new Error(''), 'errors.documentExportWorker.theFileServiceReturnedAnInvalidSourceRecord', {}));
      return;
    }
    request.backendJob.finish();
    // Native files already carry their original source. Imports without a
    // retained source never leave an empty lease behind.
    if (result?.sourceOwner !== request.sourceOwner || !result?.sourceId) void this.releaseSource(request.sourceOwner);
    request.resolve(result);
  }

  _cancelRequest(request) {
    // Stop work promptly, then repeat its identity in cleanup so the service
    // also orders cancellation before release if this control request fails.
    const cancelled = request.backendJob.cancel();
    if (request.sourceOwner) void this.releaseSource(request.sourceOwner,cancelled,request.backendJob.id);
  }

  /** Transfer the imported original's lifetime to the accepted project. */
  adoptSource(result) {
    const owner = this.sourceOwners.get(result?.sourceOwner) === 'owned' ? result.sourceOwner : null;
    const previous = this.activeSourceOwner;
    this.activeSourceOwner = owner;
    if (previous && previous !== owner) void this.releaseSource(previous);
  }

  /**
   * Several projects stay open (project-tabs-host.mjs): the one leaving the front takes its original with it,
   * and gets it back when it returns. A resting project's original is released only when the project closes.
   */
  detachSource() {
    const owner = this.activeSourceOwner;
    this.activeSourceOwner = null;
    return owner;
  }
  attachSource(owner) {
    this.activeSourceOwner = this.sourceOwners.get(owner) === 'owned' ? owner : null;
  }

  /**
   * Several projects stay open (project-tabs-host.mjs): the one leaving the front takes its original with it,
   * and gets it back when it returns. A resting project's original is released only when the project closes.
   */
  detachSource() {
    const owner = this.activeSourceOwner;
    this.activeSourceOwner = null;
    return owner;
  }
  attachSource(owner) {
    this.activeSourceOwner = this.sourceOwners.get(owner) === 'owned' ? owner : null;
  }

  /** Release an unaccepted result, or the accepted project being replaced. */
  async releaseSource(result,cancelled,jobId) {
    const ownerId = typeof result === 'string' ? result : result?.sourceOwner;
    if (!ownerId || this.sourceOwners.get(ownerId) !== 'owned') return;
    this.sourceOwners.set(ownerId,'releasing');
    if (this.activeSourceOwner === ownerId) this.activeSourceOwner = null;
    // Bulk cancellation shares four small control slots with other clients.
    // Keep one cleanup request in flight and retry temporary transport failure.
    this.sourceRelease = this.sourceRelease.then(async () => {
      await cancelled;
      for (let attempt=0; attempt<3; attempt++) {
        const job = codecJob(this.baseURL, this.token);
        try {
          const link = job.link();
          const headers = {'Content-Type':'application/json',...(this.token ? {Authorization:`Bearer ${this.token}`} : {})};
          const response = await codecRequest({baseURL:this.baseURL,...link.fields}, '/api/source/release', {
            method:'POST',headers,body:JSON.stringify({ownerId,...(jobId ? {jobId} : {})}),signal:AbortSignal.timeout(10000),keepalive:true,
          });
          if (response.ok || response.status < 500) return;
        } catch { /* A transient transport failure must not drop queued cleanup. */ }
        finally { job.finish(); }
        if (attempt<2) await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
    }).finally(() => this.sourceOwners.delete(ownerId));
    await this.sourceRelease;
  }

  _fail(error) {
    if(!this.disposed)this.diagnostics?.recovery('import_worker','started');
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      this._cancelRequest(request);
      request.reject(error);
    }
    this.pending.clear();
  }

  _request(operation, payload, transfer = [], onProgress, project = false) {
    if (this.disposed) return Promise.reject(messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {}));
    if (project && this.sourceOwners.size >= 16) return Promise.reject(Object.assign(
      messageError(new Error(''), 'errors.importClient.thisFileCouldNotBeImported', {}), {code:'source_retention_limit',status:413}));
    // Retry only the user's next operation; never silently repeat a failed one.
    if(this.failure){try{this._startWorker();}catch(error){this.diagnostics?.recovery('import_worker','failed');return Promise.reject(error);}}
    const id = ++this.sequence, backendJob = codecJob(this.baseURL, this.token);
    const sourceOwner = project ? crypto.randomUUID().replaceAll('-','') : undefined;
    if (sourceOwner) this.sourceOwners.set(sourceOwner,'owned');
    return new Promise((resolve, reject) => {
      const timer = this.timeoutMs > 0 ? setTimeout(() => {
        const error = messageError(new Error(''), "errors.importClient.theFileImportTimedOutTryOpeningA", {});
        error.code = 'import_timeout';
        error.telemetryStage='decode';
        this._fail(error);
      }, this.timeoutMs) : null;
      const succeeded=value=>{this.diagnostics?.recovery('import_worker','recovered');resolve(value);};
      const request = {resolve:succeeded, reject, timer, onProgress, backendJob, sourceOwner};
      this.pending.set(id, request);
      try {
        const link = backendJob.link();
        this.worker.postMessage({id, operation, baseURL: this.baseURL, token: this.token, jobId: backendJob.id, sourceOwner, ...link.fields, ...payload}, [...transfer, ...link.transfer]);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this._cancelRequest(request);
        reject(error);
      }
    });
  }

  async importFile(file,{entryIndex,onProgress,project=false}={}) {
    if (this.disposed) throw messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {});
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') {
      throw messageError(new TypeError(''), "errors.importClient.chooseAStykanimatePivotOrStickNodesFile", {});
    }
    const native = /\.(styk|stkz|stykmov|json)$/i.test(file.name);
    const limit = (native ? 256 : 128) * 1024 * 1024;
    if (Number(file.size) > limit) throw Object.assign(messageError(new Error(''), "errors.importClient.theFileExceedsTheMibImportLimit", {value: limit / 1024 / 1024}), { telemetryCode: 'file_too_large', telemetryStage: 'prepare' });
    const generation=this.cancelGeneration,bytes = await file.arrayBuffer();
    if(generation!==this.cancelGeneration)throw messageError(new DOMException('', 'AbortError'), "errors.importClient.importSuperseded", {});
    // Transfer ownership rather than structured-cloning a second upload buffer.
    return this._request('import', {filename: file.name, bytes,entryIndex}, [bytes],onProgress,project);
  }

  cancelPending() {
    this.cancelGeneration++;
    for(const [id,request] of this.pending){clearTimeout(request.timer);this._cancelRequest(request);this.worker.postMessage({operation:'cancel',id});request.reject(messageError(new DOMException('', 'AbortError'), "errors.importClient.importSuperseded", {}));}
    this.pending.clear();
  }

  importNative(file,options) {
    if (!/\.(styk|stkz|stykmov|json)$/i.test(file?.name || '')) {
      return Promise.reject(messageError(new Error(''), "errors.importClient.chooseAStykProjectStkzFigureStykmovMovieclip", {}));
    }
    return this.importFile(file,options);
  }

  openSample(path,{project=false}={}) {
    if (typeof path !== 'string' || !path) return Promise.reject(messageError(new Error(''), "errors.importClient.chooseAProjectFromTheLibrary", {}));
    return this._request('open', {path},[],undefined,project);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._fail(messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {}));
    for (const owner of this.sourceOwners.keys()) void this.releaseSource(owner);
  }
}
