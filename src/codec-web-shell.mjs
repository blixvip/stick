/** The in-browser codec's request queue, independent of the Worker it runs in.
 *
 * The page connects one MessagePort per job. Requests from every port join one
 * queue: the interpreter is single-threaded, so exactly one runs at a time, the
 * same admission the desktop codec applies to heavy requests. Between requests
 * the loop yields, so 'skip' and 'release' messages that arrived while Python was
 * busy take effect before the next request starts.
 *
 * From the page:  connect {jobId, port} | skip {jobId} | release {jobId}
 * To the page:    busy {jobId} | idle       (through `post`)
 * `engine.handle(request)` resolves {status, headers, body: Uint8Array}.
 */
const CANCELLED = {ok: false, error: 'The operation was cancelled.', code: 'cancelled'};

export function createCodecShell({engine, post, yieldToEvents = () => new Promise((resolve) => setTimeout(resolve, 0))}) {
  const ports = new Map();   // job id -> its ports
  const skipped = new Set(); // job ids whose already-queued requests must not run
  const queue = [];
  let running = false;

  // A cancelled job stays skipped only while requests it already queued remain.
  const forgetWhenDrained = (jobId) => {
    if (!queue.some((item) => item.jobId === jobId) && !ports.has(jobId)) skipped.delete(jobId);
  };

  function reply(port, id, {status, headers, body}) {
    try { port.postMessage({id, status, headers, body: body.buffer}, [body.buffer]); }
    catch { /* The job released this port while the request ran. */ }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        await yieldToEvents();
        const {jobId, port, request} = queue.shift();
        if (skipped.has(jobId)) {
          reply(port, request.id, {status: 499, headers: {'Content-Type': 'application/json; charset=utf-8'}, body: new TextEncoder().encode(JSON.stringify(CANCELLED))});
          forgetWhenDrained(jobId);
          continue;
        }
        post({type: 'busy', jobId});
        const result = await engine.handle({method: request.method, path: request.path, headers: request.headers, body: request.body});
        post({type: 'idle'});
        reply(port, request.id, result);
      }
    } finally { running = false; }
  }

  function attach(jobId, port) {
    if (!ports.has(jobId)) ports.set(jobId, new Set());
    ports.get(jobId).add(port);
    port.onmessage = ({data}) => { queue.push({jobId, port, request: data}); void pump(); };
  }

  return {
    handleMessage(data) {
      if (data?.type === 'connect') attach(data.jobId, data.port);
      else if (data?.type === 'skip') skipped.add(data.jobId);
      else if (data?.type === 'release') {
        for (const port of ports.get(data.jobId) ?? []) port.close();
        ports.delete(data.jobId);
        forgetWhenDrained(data.jobId);
      }
    },
    /** For tests: what the shell is still holding on to. */
    state: () => ({jobs: ports.size, skipped: skipped.size, queued: queue.length, running}),
  };
}
