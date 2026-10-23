// The editor's one server-side piece: a same-origin window onto the community library.
//
// The site's API sends no CORS headers, so a browser on the editor's origin cannot read it.
// Instead of loosening the production site, the editor asks its own origin and this Worker
// passes exactly these requests on, and nothing else:
//
//   GET /community/content            the site's /api/v1/content
//   GET /community/files/<key>        the public file host: index/<version>.json and i/<id>/<name>
//   GET /community/get/<id>?k=<key>   the site's counting download route, its redirect followed here
//
// Everything else is served from the static assets (`run_worker_first` in wrangler.jsonc names
// only /community/*). The requests carry no cookies, no user data and no project data, and the
// answers are size-bounded. web/_headers does not apply to Worker responses, so they set their
// own (see `answer`).
const MB = 1024 * 1024;
const LIMITS = {content: 256 * 1024, index: 4 * MB, poster: 512 * 1024, file: 16 * MB};
const ID = /^[a-z0-9]{10}$/;
const INDEX_KEY = /^index\/[0-9]{1,16}\.json$/;
const OBJECT_KEY = /^i\/[a-z0-9]{10}\/[\w.-]{1,120}$/;
const DEFAULTS = {SITE_URL: 'https://stykanimate.com', FILES_URL: 'https://files.stykanimate.com'};
const IMMUTABLE = 'public, max-age=31536000, immutable';

const config = env => ({site: (env?.SITE_URL ?? DEFAULTS.SITE_URL).replace(/\/+$/, ''), files: (env?.FILES_URL ?? DEFAULTS.FILES_URL).replace(/\/+$/, '')});

function answer(body, {status = 200, type = 'application/octet-stream', cache = 'no-store', length} = {}) {
  const headers = {'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow'};
  if (length !== undefined) headers['content-length'] = String(length);
  return new Response(body, {status, headers});
}
const fail = (status, message) => answer(JSON.stringify({error: message}), {status, type: 'application/json'});

/** The upstream body, cut off with an error once it passes `limit` bytes, whatever its headers claim. */
function bounded(response, limit) {
  if (!response.body) return null;
  let size = 0;
  return response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) controller.error(new Error('The upstream file is larger than allowed.'));
      else controller.enqueue(chunk);
    },
  }));
}

async function upstream(url, {fetcher, limit, signal}) {
  const response = await fetcher(url, {redirect: 'manual', signal, headers: {accept: '*/*'}});
  if (Number(response.headers.get('content-length')) > limit) throw new Error('The upstream file is larger than allowed.');
  return response;
}

/** What the browser is told about an object: poster images stay images, the rest is opaque bytes or JSON. */
function typeOf(key, response) {
  if (INDEX_KEY.test(key)) return 'application/json';
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return /^image\/(webp|png|jpeg)$/.test(type) && !/\.(stkz|stykmov)$/.test(key) ? type : 'application/octet-stream';
}

export async function handle(request, env = {}, {fetcher = (...args) => fetch(...args), cache = globalThis.caches?.default, waitUntil = () => {}} = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Only GET is supported.');
  const url = new URL(request.url), {site, files} = config(env), path = url.pathname;
  const signal = AbortSignal.timeout(20000);

  if (path === '/community/content') {
    try {
      const response = await upstream(`${site}/api/v1/content`, {fetcher, limit: LIMITS.content, signal});
      if (!response.ok) return fail(502, 'The community library is unavailable.');
      return answer(bounded(response, LIMITS.content), {type: 'application/json', cache: 'public, max-age=60'});
    } catch { return fail(502, 'The community library is unavailable.'); }
  }

  if (path.startsWith('/community/files/')) {
    const key = path.slice('/community/files/'.length);
    const index = INDEX_KEY.test(key), object = OBJECT_KEY.test(key);
    if (!index && !object) return fail(404, 'Not found.');
    const limit = index ? LIMITS.index : /\.(stkz|stykmov)$/.test(key) ? LIMITS.file : LIMITS.poster;
    const cached = cache && await cache.match(request).catch(() => undefined);
    if (cached) return cached;
    try {
      const response = await upstream(`${files}/${key}`, {fetcher, limit, signal});
      if (response.status === 404) return fail(404, 'Not found.');
      if (!response.ok) return fail(502, 'The community library is unavailable.');
      const out = answer(bounded(response, limit), {type: typeOf(key, response), cache: IMMUTABLE});
      if (cache && request.method === 'GET') waitUntil(cache.put(request, out.clone()).catch(() => {}));
      return out;
    } catch { return fail(502, 'The community library is unavailable.'); }
  }

  if (path.startsWith('/community/get/')) {
    const id = path.slice('/community/get/'.length), key = url.searchParams.get('k') ?? '';
    if (!ID.test(id) || !OBJECT_KEY.test(key) || !key.startsWith(`i/${id}/`) || !/\.(stkz|stykmov)$/.test(key)) return fail(404, 'Not found.');
    try {
      // The site counts the download and redirects to the public file; only its own hosts are followed.
      const route = `${site}/api/v1/library/get/${id}?k=${encodeURIComponent(key)}`;
      let response = await upstream(route, {fetcher, limit: LIMITS.file, signal});
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const target = new URL(response.headers.get('location') ?? '', route), allowed = [new URL(site), new URL(files)];
        if (target.protocol !== new URL(site).protocol || target.username || target.password || !allowed.some(host => host.host === target.host)) return fail(502, 'The community library is unavailable.');
        response = await upstream(target.href, {fetcher, limit: LIMITS.file, signal});
      }
      if (response.status === 404) return fail(404, 'Not found.');
      if (!response.ok) return fail(502, 'The community library is unavailable.');
      return answer(bounded(response, LIMITS.file), {type: 'application/octet-stream'});
    } catch { return fail(502, 'The community library is unavailable.'); }
  }

  return fail(404, 'Not found.');
}

export default {
  fetch(request, env, context) { return handle(request, env, {waitUntil: promise => context?.waitUntil?.(promise)}); },
};
