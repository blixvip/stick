import {messageError} from './localized-error.mjs';
import {clipboardWireChunks, createClipboardWireDecoder} from './clipboard-wire.mjs';
import {CLIPBOARD_CHUNK_BYTES, CLIPBOARD_TRANSFER_BYTES, clipboardChunkBytes, clipboardControlBytes} from './clipboard-worker-client.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultRun = async (input, options) => (await import('./clipboard-worker-plan.mjs')).runClipboardWorkerRequest(input, options);
// Each reverse ACK already arrives in a new worker event task. Another timer
// per bounded chunk adds avoidable transfer latency without helping UI input.
const pause = () => Promise.resolve();

/** Isolated per-operation receiver. The injected planner is used only by tests;
 * production loads the shared clipboard planner after complete input streams. */
export function createClipboardWorkerEndpoint(postMessage, {runRequest = defaultRun, yieldControl = pause} = {}) {
  let job = null;
  const fail = (error, id) => {
    if (!job || job.failed) return;
    job.failed = true; job.input = null; job.decoder?.dispose(); job.decoder = null; job.ack?.reject(error); job.ack = null;
    postMessage({jobId: job.id, id, type: 'error', error: {
      name: String(error?.name || 'Error').slice(0, 128), message: String(error?.message || error).slice(0, 2000),
      ...(typeof error?.code === 'string' ? {code: error.code.slice(0, 128)} : {})}});
  };
  const ack = message => postMessage({jobId: job.id, id: message.id, type: 'ack', operation: message.operation,
    ...(message.stream === undefined ? {} : {stream: message.stream}), ...(message.sequence === undefined ? {} : {sequence: message.sequence})});
  async function run(message) {
    const active = job, started = performance.now(); let iterator;
    const check = () => {if (job !== active || active.failed) throw messageError(new Error(''), "errors.clipboardWorker.clipboardWorkerOperationWasCancelled", {});};
    try {
      active.phase = 'running';
      const onProgress = progress => {check(); clipboardControlBytes(progress); postMessage({jobId: active.id, id: message.id, type: 'progress', progress});};
      const result = await runRequest({...active.input, request: active.request}, {onProgress});
      check(); if (!record(result)) throw messageError(new Error(''), "errors.clipboardWorker.theClipboardPlannerReturnedNoResultRecord", {});
      const planned = performance.now(); active.input = null; active.phase = 'sending';
      let encoding;
      iterator = clipboardWireChunks(result, {maxBytes: CLIPBOARD_CHUNK_BYTES, timeBudgetMs: 2,
        checkCurrent: check, omitRuntimeSegments: true, onTimings: stats => {encoding = stats;}});
      let sequence = 0, bytes = 0;
      for (;;) {
        check(); const step = await iterator.next(); if (step.done) break;
        bytes += clipboardChunkBytes(step.value, sequence);
        if (bytes > active.maxBytes) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardOutputExceedsItsTransferBudget", {});
        const received = new Promise((resolve, reject) => {active.ack = {id: message.id, sequence, resolve, reject};});
        postMessage({jobId: active.id, id: message.id, type: 'result-chunk', sequence: sequence++, chunk: step.value}, [step.value]);
        await received; await yieldControl();
      }
      check(); active.phase = 'done';
      postMessage({jobId: active.id, id: message.id, type: 'result', sequence,
        timings: {planMs: planned - started, transferMs: performance.now() - planned, totalMs: performance.now() - started,
          outputBytes: bytes, outputLogicalBytes: encoding?.residentBytes, encoding}});
    } catch (error) {fail(error, message.id);}
    finally {await iterator?.return?.();}
  }
  return async message => {
    try {
      if (!record(message) || !Number.isSafeInteger(message.jobId) || message.jobId < 1 || !Number.isSafeInteger(message.id) || message.id < 1)
        throw messageError(new Error(''), "errors.clipboardWorker.invalidClipboardWorkerRequest", {});
      if (message.operation === 'start') {
        if (job) throw messageError(new Error(''), "errors.clipboardWorker.theClipboardWorkerAlreadyReceivedARequest", {});
        job = {id: message.jobId, phase: 'input', input: {}, request: message.request, streams: message.streams,
          streamIndex: 0, sequence: 0, bytes: 0, residentBytes: 0, lastRequestId: message.id, maxBytes: message.maxBytes};
        if (!Array.isArray(job.streams) || job.streams[0] !== 'report' || job.streams.length > 3 ||
            job.streams.some((name, index) => !['report', 'clipboard', 'state'].includes(name) || job.streams.indexOf(name) !== index) ||
            !Number.isSafeInteger(job.maxBytes) || job.maxBytes < 1024 || job.maxBytes > CLIPBOARD_TRANSFER_BYTES)
          throw messageError(new Error(''), "errors.clipboardWorker.invalidClipboardInputStreamsOrTransferBudget", {});
        clipboardControlBytes(job.request); ack(message); return;
      }
      if (!job || job.failed || message.jobId !== job.id) throw messageError(new Error(''), "errors.clipboardWorker.clipboardRequestDoesNotMatchTheWorkerOperation", {});
      if (job.receiving) throw messageError(new Error(''), "errors.clipboardWorker.clipboardInputArrivedBeforeItsAcknowledgement", {});
      if (message.operation === 'result-ack') {
        const waiting = job.ack;
        if (job.phase !== 'sending' || !waiting || waiting.id !== message.id || waiting.sequence !== message.sequence)
          throw messageError(new Error(''), "errors.clipboardWorker.clipboardResultAcknowledgementArrivedOutOfOrder", {});
        job.ack = null; waiting.resolve(); return;
      }
      if (message.id !== job.lastRequestId + 1) throw messageError(new Error(''), "errors.clipboardWorker.clipboardRequestsArrivedOutOfOrder", {});
      job.lastRequestId = message.id;
      if (message.operation === 'run') {
        if (job.phase !== 'input' || job.streamIndex !== job.streams.length) throw messageError(new Error(''), "errors.clipboardWorker.clipboardPlanningStartedBeforeAllInputsArrived", {});
        void run(message); return;
      }
      if (job.phase !== 'input' || message.stream !== job.streams[job.streamIndex] || message.sequence !== job.sequence)
        throw messageError(new Error(''), "errors.clipboardWorker.clipboardInputChunksArrivedOutOfOrder", {});
      if (message.operation === 'chunk') {
        const bytes = clipboardChunkBytes(message.chunk, job.sequence);
        if (job.bytes + bytes > job.maxBytes) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardInputExceedsItsTransferBudget", {});
        const active = job;
        if (active.residentBytes >= active.maxBytes * 8) throw messageError(new Error(''), "errors.clipboardWorkerClient.clipboardInputExceedsItsResidentDataBudget", {});
        active.decoder ??= createClipboardWireDecoder({maxBytes: active.maxBytes, maxResidentBytes: active.maxBytes * 8 - active.residentBytes, timeBudgetMs: 4,
          checkCurrent: () => {if (job !== active || active.failed) throw messageError(new Error(''), "errors.clipboardWorker.clipboardInputWasCancelled", {});}});
        active.receiving = true;
        try {await active.decoder.push(message.chunk);
          if (job !== active || active.failed) return;
          active.bytes += bytes; active.sequence++; active.receiving = false; ack(message);
        } finally {active.receiving = false;}
      } else if (message.operation === 'end') {
        if (!job.sequence || !job.decoder) throw messageError(new Error(''), "errors.clipboardWorker.clipboardInputStreamIsIncomplete", {});
        const value = job.decoder.finish();
        if (!record(value)) throw messageError(new Error(''), "errors.clipboardWorker.clipboardInputStreamMustBeARecord", {});
        job.input[message.stream] = value; job.residentBytes += job.decoder.stats.residentBytes;
        job.decoder.dispose(); job.decoder = null;
        job.streamIndex++; job.sequence = 0; ack(message);
      } else throw messageError(new Error(''), "errors.clipboardWorker.unknownClipboardWorkerOperation", {});
    } catch (error) {
      if (!job && record(message)) job = {id: message.jobId};
      fail(error, message?.id);
    }
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !globalThis.document) {
  const receive = createClipboardWorkerEndpoint((message, transfer) => self.postMessage(message, transfer));
  self.addEventListener('message', event => receive(event.data));
}
