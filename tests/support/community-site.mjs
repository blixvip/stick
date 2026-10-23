// A stand-in for the website's community library, on a loopback port: the content document, the immutable
// index, posters and files (its public file host) and the counting download route. It is the site as
// web/worker.js and desktop/public-library.cjs see it, so browser tests never touch the real one.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** The smallest lossless WebP (1x1): what the site's posters are, in miniature. */
export const TINY_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

export async function startCommunitySite() {
  const state = { items: [], version: 0, counted: [], requests: [] };
  const files = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push(`${request.method} ${url.pathname}${url.search}`);
    const send = (status, body, type = 'application/octet-stream', headers = {}) => { response.writeHead(status, { 'content-type': type, ...headers }); response.end(body); };
    if (url.pathname === '/api/v1/content') return send(200, JSON.stringify({ content: {}, library: { v: state.version, count: state.items.length, base: `http://${request.headers.host}` } }), 'application/json');
    const counting = /^\/api\/v1\/library\/get\/([a-z0-9]{10})$/.exec(url.pathname);
    if (counting) {
      state.counted.push(counting[1]);
      const key = url.searchParams.get('k');
      return files.has(key) ? send(302, '', 'text/plain', { location: `http://${request.headers.host}/${key}` }) : send(404, 'gone', 'text/plain');
    }
    const key = url.pathname.slice(1);
    if (files.has(key)) return send(200, files.get(key).bytes, files.get(key).type);
    return send(404, 'missing', 'text/plain');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, state,
    /** The worker's environment for this site. */
    upstream: { SITE_URL: origin, FILES_URL: origin },
    /** Publishes items: [{id, kind: 'figure'|'movieclip'|'project', name, category, author, tags, description, bytes}]. */
    publish(items) {
      state.version += 1;
      state.items = items;
      files.clear();
      const index = { v: state.version, items: items.map((item) => {
        const extension = item.kind === 'movieclip' ? 'stykmov' : item.kind === 'project' ? 'styk' : 'stkz';
        const file = `i/${item.id}/${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${extension}`, poster = `i/${item.id}/poster.webp`;
        files.set(file, { bytes: item.bytes, type: 'application/octet-stream' });
        files.set(poster, { bytes: item.poster ?? TINY_WEBP, type: 'image/webp' });
        return { id: item.id, k: item.kind, c: item.category ?? 'characters', t: item.name, d: item.description ?? '', g: item.tags ?? [], a: item.author ?? 'Someone',
          s: item.bytes.length, sha256: createHash('sha256').update(item.bytes).digest('hex'), f: file, p: null, i: poster };
      }) };
      files.set(`index/${state.version}.json`, { bytes: Buffer.from(JSON.stringify(index)), type: 'application/json' });
    },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}
