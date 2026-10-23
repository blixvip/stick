/** CPU profiles of an Electron app's dedicated workers over the DevTools port.
 * Playwright cannot attach to workers, so this reads the debugging endpoint the
 * app was launched with (`--remote-debugging-port`) and drives each worker's
 * Profiler domain itself. */
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

async function session(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`Could not open ${url}`)); });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, {resolve, reject}); socket.send(JSON.stringify({id, method, params})); }),
    close: () => socket.close(),
  };
}

export async function startWorkerProfiles(port, {intervalUs = 250} = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const workers = targets.filter(target => target.type === 'worker' || target.type === 'service_worker');
  const sessions = [];
  for (const target of workers) {
    const connection = await session(target.webSocketDebuggerUrl);
    await connection.send('Profiler.enable');
    await connection.send('Profiler.setSamplingInterval', {interval: intervalUs});
    await connection.send('Profiler.start');
    // Wall-clock start lets callers align samples with timestamps taken inside the worker.
    sessions.push({target, connection, startedAt: Date.now()});
  }
  return {
    count: sessions.length,
    async stop(directory) {
      const written = [];
      for (const [index, {target, connection, startedAt}] of sessions.entries()) {
        const {profile} = await connection.send('Profiler.stop');
        connection.close();
        const file = path.join(directory, `worker-${index}.cpuprofile`);
        await writeFile(file, JSON.stringify(profile));
        written.push({file, url: target.url, startedAt});
      }
      return written;
    },
  };
}

/** Self time per function across profiles, largest first. */
export function summarizeProfiles(profiles, limit = 25) {
  const totals = new Map();
  let total = 0;
  for (const profile of profiles) {
    const byId = new Map(profile.nodes.map(node => [node.id, node]));
    for (let i = 0; i < profile.samples.length; i++) {
      const node = byId.get(profile.samples[i]), delta = profile.timeDeltas[i] / 1000;
      const {functionName, url, lineNumber} = node.callFrame;
      const key = `${functionName || '(anonymous)'} ${url.split('/').slice(-2).join('/')}:${lineNumber + 1}`;
      totals.set(key, (totals.get(key) ?? 0) + delta); total += delta;
    }
  }
  return {totalMs: total, top: [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, ms]) => ({name, ms: Math.round(ms), share: Number((ms / total * 100).toFixed(1))}))};
}
