import {restoreMessageError, messageError} from './localized-error.mjs';

import {documentChunks} from './document-transport.mjs';
import {clipboardWireChunks, createClipboardWireDecoder} from './clipboard-wire.mjs';

export const CLIPBOARD_CHUNK_BYTES = 256 * 1024;
export const CLIPBOARD_TRANSFER_BYTES = 512 * 1024 * 1024;
const CONTROL_BYTES = 64 * 1024;
const streams = ['report', 'clipboard', 'state'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abortError = (message = 'Clipboard operation cancelled.') => new DOMException(message, 'AbortError');
const yieldToInput = () => globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));
const chunkOptions = {maxBytes: CONTROL_BYTES, maxRecords: 128, timeBudgetMs: 2};

/** A bounded record check for small control/progress messages, without JSON. */
export function clipboardControlBytes(value) {
  if (!record(value)) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardControlDataMustBeARecord", {});
  let bytes = 0;
  for (const chunk of documentChunks(value, {...chunkOptions, omitRuntimeSegments: false})) {
    bytes += chunk.header ? 64 : chunk.estimatedBytes;
    if (!Number.isFinite(bytes) || bytes > CONTROL_BYTES) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardControlDataExceedsThe64KibLimit", {});
  }
  return bytes;
}

export function clipboardChunkBytes(chunk, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !(chunk instanceof ArrayBuffer) || !chunk.byteLength || chunk.byteLength > CLIPBOARD_CHUNK_BYTES)
    throw messageError(new Error(''), "errors.clipboardWorkerClient.invalidOrOversizedClipboardChunk", {});
  return chunk.byteLength;
}

/** Each run owns a disposable worker and unpublished result. Input and output
 * cross in ACK-bounded packets; no entire report is cloned or stringified here. */
export class ClipboardWorkerClient {
  constructor({workerFactory, workerURL = new URL('./clipboard-worker.mjs', import.meta.url),
    timeoutMs = 300000, maxBytes = CLIPBOARD_TRANSFER_BYTES, yieldControl = yieldToInput} = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardTimeoutMustBeGreaterThanZeroAnd", {});
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > CLIPBOARD_TRANSFER_BYTES) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardTransferBudgetMustBeBetween1Kib", {});
    Object.assign(this, {workerFactory, workerURL, timeoutMs, maxBytes, yieldControl});
    this.disposed = false; this.active = null; this.sequence = 0; this.lastTimings = null;
  }

  async run({report, clipboard, state, request = {}} = {}, {signal, checkCurrent = () => {}, onProgress} = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.clipboardWorkerClient.theClipboardWorkerClientHasBeenDisposed", {});
    if (this.active) throw messageError(new Error(''), "errors.clipboardWorkerClient.aClipboardOperationIsAlreadyRunning", {});
    if (!record(report)) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardOperationsRequireADocumentRecord", {});
    const input = {report, clipboard, state}, selected = streams.filter(name => input[name] != null);
    for (const name of selected) if (!record(input[name])) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardMustBeARecord", {name: name});
    clipboardControlBytes(request);
    const current = () => {
      if (signal?.aborted || this.disposed) throw abortError();
      if (checkCurrent() === false) throw abortError('The document changed during the clipboard operation.');
    };
    current();
    const worker = this.workerFactory ? this.workerFactory(this.workerURL, {type: 'module', name: 'StykAnimate clipboard'})
      : new Worker(this.workerURL, {type: 'module', name: 'StykAnimate clipboard'});
    const jobId = ++this.sequence, started = performance.now();
    let pending = null, requestId = 0, failure = null, closed = false, result = null, outputSequence = 0;
    const timings = {inputBytes: 0, outputBytes: 0, inputChunks: 0, outputChunks: 0,
      inputLogicalBytes: 0, outputLogicalBytes: 0, maxPrepareMs: 0, maxPostMs: 0, maxReceiveMs: 0, mainWorkMs: 0};
    const post = (message, transfer = []) => {
      const begin = performance.now(); worker.postMessage(message, transfer);
      const elapsed = performance.now() - begin; timings.maxPostMs = Math.max(timings.maxPostMs, elapsed); timings.mainWorkMs += elapsed;
    };
    const fail = error => {
      if (failure || closed) return;
      failure = error instanceof Error ? error : new Error(String(error));
      result = null; const waiting = pending; pending = null; waiting?.reject(failure);
      worker.terminate();
    };
    const check = () => {if (failure) throw failure; current();};
    const outputDecoder = createClipboardWireDecoder({maxBytes: this.maxBytes, timeBudgetMs: 4, signal, checkCurrent: check, yieldControl: this.yieldControl});
    const ask = (operation, values = {}, transfer = []) => {
      check();
      if (pending) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardTransportAlreadyAwaitsAResponse", {});
      return new Promise((resolve, reject) => {
        const id = ++requestId; pending = {id, operation, ...values, resolve, reject};
        try {post({jobId, id, operation, ...values}, transfer);} catch (error) {fail(error);}
      });
    };
    const receive = async event => {
      if (closed || failure) return;
      try {
        check(); const message = event.data;
        if (!record(message) || message.jobId !== jobId || !Number.isSafeInteger(message.id) || message.id !== pending?.id)
          throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardWorkerResponseDoesNotMatchTheActive", {});
        if (message.type === 'error') {
          const error = restoreMessageError((message.error?.message ? new Error(message.error?.message) : messageError(new Error(''), "errors.clipboardWorkerClient.theClipboardWorkerFailed")), message.error);
          error.name = message.error?.name || 'Error'; error.code = message.error?.code; throw error;
        }
        if (message.type === 'progress') {
          if (pending.operation !== 'run') throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardProgressArrivedOutsidePlanning", {});
          clipboardControlBytes(message.progress); onProgress?.(message.progress); check(); return;
        }
        if (message.type === 'result-chunk') {
          if (pending.operation !== 'run' || message.sequence !== outputSequence) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardResultChunksArrivedOutOfOrder", {});
          const bytes = clipboardChunkBytes(message.chunk, outputSequence);
          if (timings.outputBytes + bytes > this.maxBytes) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardOutputExceedsItsTransferBudget", {});
          const beforeWork = outputDecoder.stats.workMs;
          await outputDecoder.push(message.chunk); check();
          timings.maxReceiveMs = Math.max(timings.maxReceiveMs, outputDecoder.stats.maxSliceMs);
          timings.mainWorkMs += outputDecoder.stats.workMs - beforeWork;
          timings.outputBytes += bytes; timings.outputChunks++; outputSequence++;
          check(); post({jobId, id: pending.id, operation: 'result-ack', sequence: message.sequence}); return;
        }
        if (message.type === 'result') {
          if (pending.operation !== 'run' || !outputSequence || message.sequence !== outputSequence)
            throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardResultCompletedBeforeAllItsChunks", {});
          result = outputDecoder.finish();
          if (!record(result)) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardResultMustBeARecord", {});
          timings.outputLogicalBytes = outputDecoder.stats.residentBytes;
          check(); const waiting = pending; pending = null; waiting.resolve({wire: result, timings: message.timings}); return;
        }
        if (message.type !== 'ack' || message.operation !== pending.operation || message.stream !== pending.stream || message.sequence !== pending.sequence)
          throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardAcknowledgementArrivedOutOfOrder", {});
        check(); const waiting = pending; pending = null; waiting.resolve();
      } catch (error) {fail(error);}
    };
    const onError = event => {event.preventDefault?.(); fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.clipboardWorkerClient.theClipboardWorkerStopped")));};
    const onMessageError = () => fail(messageError(new Error(''), "errors.clipboardWorkerClient.clipboardDataCouldNotBeTransferred", {}));
    const abort = () => fail(abortError());
    worker.addEventListener('message', receive); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onMessageError);
    signal?.addEventListener('abort', abort, {once: true});
    const timer = this.timeoutMs ? setTimeout(() => fail(messageError(new Error(''), "errors.clipboardWorkerClient.clipboardOperationTimedOut", {})), this.timeoutMs) : null;
    const job = {cancel: abort}; this.active = job;
    try {
      await ask('start', {request, streams: selected, maxBytes: this.maxBytes});
      for (const stream of selected) {
        let sequence = 0; const iterator = clipboardWireChunks(input[stream], {maxBytes: CLIPBOARD_CHUNK_BYTES,
          timeBudgetMs: 2, signal, checkCurrent: check, omitRuntimeSegments: true,
          onTimings: stats => {timings.inputLogicalBytes += stats.residentBytes;
            timings.mainWorkMs += stats.workMs; timings.maxPrepareMs = Math.max(timings.maxPrepareMs, stats.maxSliceMs);
            if (timings.inputLogicalBytes > this.maxBytes * 8) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardInputExceedsItsResidentDataBudget", {});}});
        try {
          for (;;) {
            check(); const step = await iterator.next();
            if (step.done) break;
            const bytes = clipboardChunkBytes(step.value, sequence);
            if (timings.inputBytes + bytes > this.maxBytes) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardInputExceedsItsTransferBudget", {});
            check(); await ask('chunk', {stream, sequence: sequence++, chunk: step.value}, [step.value]);
            timings.inputBytes += bytes; timings.inputChunks++;
            check();
          }
          await ask('end', {stream, sequence});
        } finally {await iterator.return?.();}
      }
      check(); const completed = await ask('run'); check();
      this.lastTimings = {...timings, worker: completed.timings, totalMs: performance.now() - started};
      return completed.wire;
    } catch (error) {fail(error); throw error;}
    finally {
      closed = true; result = null; pending = null; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      outputDecoder.dispose();
      worker.removeEventListener?.('message', receive); worker.removeEventListener?.('error', onError); worker.removeEventListener?.('messageerror', onMessageError);
      worker.terminate(); if (this.active === job) this.active = null;
    }
  }

  dispose() {if (this.disposed) return; this.disposed = true; this.active?.cancel();}
}
