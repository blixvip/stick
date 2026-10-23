/** The Pivot codec running in WebAssembly.
 *
 * The same Python codec the desktop app freezes (backend/browser_service.py over
 * server.py's ProjectStore) runs inside Pyodide. This module boots it lazily and
 * turns one request into one response; it knows nothing about Workers, ports or
 * the page, so the worker shell and the Node tests drive it identically.
 *
 * `loadRuntime()` resolves a Pyodide instance and `loadBundle()` the codec's
 * Python sources as {files: {"backend/server.py": "...", ...}}. Boot happens on
 * the first request, never earlier, so pages that never open a Pivot file do not
 * download the runtime. A failed boot is retried by the next request.
 */
const JSON_HEADERS = {'Content-Type': 'application/json; charset=utf-8'};
const encoder = new TextEncoder();

function failure(status, code, error) {
  return {status, headers: JSON_HEADERS, body: encoder.encode(JSON.stringify({ok: false, error, code}))};
}

export function createCodecEngine({loadRuntime, loadBundle, onStatus = () => {}}) {
  let booting = null;

  async function boot() {
    onStatus({state: 'loading', stage: 'runtime'});
    const py = await loadRuntime();
    onStatus({state: 'loading', stage: 'codec'});
    const bundle = await loadBundle();
    for (const [name, source] of Object.entries(bundle.files)) {
      const target = `/codec/${name}`;
      py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
      py.FS.writeFile(target, source);
    }
    py.runPython("import sys\nsys.path[:0] = ['/codec/backend']\nimport browser_service");
    const service = py.pyimport('browser_service');
    onStatus({state: 'ready'});
    return {py, handle: service.handle};
  }

  const runtime = () => booting ??= boot().catch(error => { booting = null; onStatus({state: 'failed', message: error?.message}); throw error; });

  return {
    /** @returns {Promise<{status: number, headers: object, body: Uint8Array}>} Never rejects for codec errors. */
    async handle({method, path, headers = {}, body = new Uint8Array(0)}) {
      let engine;
      try { engine = await runtime(); }
      catch (error) {
        return failure(503, 'codec_unavailable', `The Pivot converter could not be loaded (${error?.message || 'unknown error'}). Check your connection and try again.`);
      }
      const {py, handle} = engine;
      const proxies = [];
      try {
        const pyHeaders = py.toPy(headers), pyBody = py.toPy(body);
        proxies.push(pyHeaders, pyBody);
        const result = handle(method, path, pyHeaders, pyBody);
        proxies.push(result);
        const [status, responseHeaders, data] = result.toJs({dict_converter: Object.fromEntries});
        // toJs copies bytes out of the WebAssembly heap; the buffer is safe to transfer.
        return {status, headers: responseHeaders, body: data};
      } catch (error) {
        // A WebAssembly fault (for example running out of memory) can leave the
        // interpreter unusable; the next request boots a fresh one.
        booting = null;
        onStatus({state: 'failed', message: error?.message});
        return failure(500, 'codec_error', 'The project operation failed.');
      } finally {
        for (const proxy of proxies) { try { proxy.destroy(); } catch { /* already released */ } }
      }
    },
  };
}
