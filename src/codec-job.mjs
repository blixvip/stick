/** The UI owns cancellation even when a busy worker must be terminated.
 *
 * A job is one import or export against the Pivot codec. `link()` returns what
 * the worker running it needs to reach the codec: nothing for HTTP (the desktop
 * app and the development server), a MessagePort for the in-browser codec of the
 * web build. Callers spread `link().fields` into the worker message and add
 * `link().transfer` to its transfer list. */
import {browserCodecHost} from './codec-web-host.mjs';

/** 'browser' when the page runs the codec in a worker; 'http' otherwise.
 * The web build marks its page with <meta name="styk-codec" content="browser">;
 * ?codec=browser selects it for a page served next to the development codec.
 * The desktop app always uses its own codec. */
export function codecMode(scope = globalThis) {
  if (scope.stykDesktop) return 'http';
  const requested = new URLSearchParams(scope.location?.search ?? '').get('codec')
    ?? scope.document?.querySelector?.('meta[name="styk-codec"]')?.content;
  return requested === 'browser' ? 'browser' : 'http';
}

export function codecJob(baseURL, token = '', {mode = codecMode(), host} = {}) {
  const id = crypto.randomUUID().replaceAll('-', '');
  let settled = false, cancellation;
  if (mode === 'browser') {
    const codec = host ?? browserCodecHost();
    codec.register(id);
    return {id,
      link() { return codec.link(id); },
      finish() { settled = true; codec.release(id); },
      cancel() {
        if (settled) return cancellation;
        settled = true;
        codec.cancel(id);
        return cancellation = Promise.resolve();
      },
    };
  }
  return {id,
    link() { return {fields: {}, transfer: []}; },
    finish() { settled = true; },
    cancel() {
      if (settled) return cancellation;
      settled = true;
      const headers = token ? {Authorization: `Bearer ${token}`} : {};
      // No document data crosses this control request. It has an independent
      // lifetime from the worker/fetch being cancelled and a bounded timeout.
      return cancellation = fetch(new URL(`/api/cancel?id=${id}`, baseURL), {method: 'POST', body: '', headers,
        signal: AbortSignal.timeout(2000), keepalive: true}).catch(() => {});
    },
  };
}
