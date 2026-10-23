// Serves build/web the way Cloudflare does: static files with ETags and the
// rules in _headers applied. `npm run web:preview` runs it, and the browser
// tests use it, so what is tested runs under the policy production enforces.
//
//   node scripts/serve-web.mjs [--dir build/web] [--port 47850]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handle as community } from '../web/worker.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
};

/** Rules from a Cloudflare _headers file: a path pattern, then indented `Name: value` lines. */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { rules.push({ pattern: raw.trim(), headers: [] }); continue; }
    const colon = raw.indexOf(':');
    if (colon < 0 || !rules.length) throw new Error(`Invalid _headers line: ${raw}`);
    rules.at(-1).headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()]);
  }
  return rules;
}

function matches(pattern, pathname) {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)');
  return new RegExp(`^${source}$`).test(pathname);
}

/** Headers for a path. Like Cloudflare, matching rules add values; the same header repeats joined by a comma. */
export function headersFor(rules, pathname) {
  const merged = new Map();
  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      merged.set(key, merged.has(key) ? { name, value: `${merged.get(key).value}, ${value}` } : { name, value });
    }
  }
  return [...merged.values()];
}

/** Answers /community/* with web/worker.js, the same code Cloudflare runs. `upstream` names the site to read (the real one by default). */
async function serveCommunity(request, response, url, upstream) {
  const answer = await community(new Request(url, { method: request.method, headers: { accept: request.headers.accept ?? '*/*' } }), upstream);
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (!answer.body || request.method === 'HEAD') response.end(); else Readable.fromWeb(answer.body).on('error', () => response.destroy()).pipe(response);
}

export async function startWebServer({ root = path.join(appRoot, 'build', 'web'), port = 0, host = '127.0.0.1', upstream = {} } = {}) {
  let rules = [];
  try { rules = parseHeaders(await readFile(path.join(root, '_headers'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname.startsWith('/community/')) { await serveCommunity(request, response, url, upstream); return; }
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.join(root, pathname);
      if (!file.startsWith(root + path.sep) && file !== root) { response.writeHead(403).end(); return; }
      let info;
      try { info = await stat(file); if (info.isDirectory()) throw Object.assign(new Error('directory'), { code: 'ENOENT' }); }
      catch { response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
      const headers = { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'public, max-age=0, must-revalidate' };
      for (const { name, value } of headersFor(rules, pathname)) headers[name.toLowerCase()] = value;
      headers.etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      if (request.headers['if-none-match'] === headers.etag) { response.writeHead(304, headers).end(); return; }
      headers['content-length'] = info.size;
      response.writeHead(200, headers);
      if (request.method === 'HEAD') response.end(); else createReadStream(file).pipe(response);
    } catch (error) { response.writeHead(500).end(String(error.message)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, origin: `http://${host}:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const { origin } = await startWebServer({ root: path.resolve(option('--dir', path.join(appRoot, 'build', 'web'))), port: Number(option('--port', 47850)) });
  console.log(`StykAnimate web build is served at ${origin}`);
}
