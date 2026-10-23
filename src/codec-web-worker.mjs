import {messageError} from './localized-error.mjs';
/** Worker shell around the in-browser Pivot codec: Pyodide (codec-web-engine.mjs)
 * behind the request queue in codec-web-shell.mjs. Status of the runtime download
 * and boot goes to the page as {type: 'status', state, stage?, message?}. */
import {createCodecEngine} from './codec-web-engine.mjs';
import {createCodecShell} from './codec-web-shell.mjs';

// The web build places the runtime and the Python sources beside the app.
const RUNTIME = new URL('../vendor/pyodide/', import.meta.url);
const BUNDLE = new URL('../python/codec-bundle.json', import.meta.url);

const engine = createCodecEngine({
  onStatus: status => self.postMessage({type: 'status', ...status}),
  async loadRuntime() {
    const {loadPyodide} = await import(new URL('pyodide.mjs', RUNTIME).href);
    return loadPyodide({indexURL: RUNTIME.href});
  },
  async loadBundle() {
    const response = await fetch(BUNDLE);
    if (!response.ok) throw messageError(new Error(''), "errors.codecWebWorker.theCodecSourcesAreUnavailable", {status: response.status});
    return response.json();
  },
});

const shell = createCodecShell({engine, post: message => self.postMessage(message)});
self.addEventListener('message', ({data}) => shell.handleMessage(data));
