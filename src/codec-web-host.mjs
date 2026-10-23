import {messageError} from './localized-error.mjs';
/** Page-side owner of the in-browser Pivot codec worker (web build).
 *
 * It creates the worker on first use, connects one MessagePort per job, and
 * applies cancellation. Python cannot be interrupted, so cancelling the job that
 * is running stops the worker itself, and the next request starts a fresh one
 * (the imported-source cache is lost, exactly as when the desktop codec
 * restarts). If other jobs are waiting on the same worker, terminating would
 * discard their requests, so the cancelled job is only skipped and its running
 * request finishes unobserved.
 */
export class BrowserCodecHost {
  #worker = null;
  #jobs = new Map();   // job id -> the worker its requests were sent to (null until it links)
  #busyJob = null;
  #listeners = new Set();
  #createWorker;

  constructor({createWorker = () => new Worker(new URL('./codec-web-worker.mjs', import.meta.url),
    {type: 'module', name: 'StykAnimate Pivot codec'})} = {}) {
    this.#createWorker = createWorker;
  }

  /** Progress of the runtime download and boot, for the interface. */
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(status) { for (const listener of this.#listeners) listener(status); }

  register(jobId) { this.#jobs.set(jobId, null); }

  /** A port for the worker running this job. Loading the runtime waits for its first request. */
  link(jobId) {
    if (!this.#jobs.has(jobId)) throw messageError(new DOMException('', 'AbortError'), "errors.codecWebHost.theCodecJobWasCancelled", {});
    const {port1, port2} = new MessageChannel();
    const worker = this.#ensure();
    this.#jobs.set(jobId, worker);
    worker.postMessage({type: 'connect', jobId, port: port2}, [port2]);
    return {fields: {codecPort: port1}, transfer: [port1]};
  }

  release(jobId) {
    if (this.#jobs.delete(jobId)) this.#worker?.postMessage({type: 'release', jobId});
  }

  cancel(jobId) {
    if (!this.#jobs.delete(jobId) || !this.#worker) return;
    // Skip what is already queued for the job, then let the worker drop its port.
    this.#worker.postMessage({type: 'skip', jobId});
    this.#worker.postMessage({type: 'release', jobId});
    // Stopping discards every request queued in this worker. Only jobs that sent
    // requests to it are affected; a job on a worker that already died is gone.
    const othersWaiting = [...this.#jobs.values()].some(worker => worker === this.#worker);
    if (this.#busyJob === jobId && !othersWaiting) this.#stop('cancelled');
  }

  dispose() { this.#jobs.clear(); this.#stop('disposed'); this.#listeners.clear(); }

  #ensure() {
    if (this.#worker) return this.#worker;
    const worker = this.#createWorker();
    this.#worker = worker;
    worker.addEventListener('message', ({data}) => {
      if (this.#worker !== worker || !data) return;
      if (data.type === 'busy') this.#busyJob = data.jobId;
      else if (data.type === 'idle') this.#busyJob = null;
      else if (data.type === 'status') this.#emit(data);
    });
    const failed = event => {
      if (this.#worker !== worker) return;
      event?.preventDefault?.();
      this.#emit({state: 'failed', message: event?.message || 'The Pivot converter stopped unexpectedly.'});
      this.#stop('failed');
    };
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    return worker;
  }

  #stop(reason) {
    const worker = this.#worker;
    this.#worker = null;
    this.#busyJob = null;
    worker?.terminate();
    if (worker) this.#emit({state: 'stopped', reason});
  }
}

let shared = null;
export function browserCodecHost() { return shared ??= new BrowserCodecHost(); }
