'use strict';
const { messageError } = require('./localization.cjs');


const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const {randomBytes} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {startBackend} = require('./backend.cjs');

const MIME = new Map(Object.entries({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm'}));
const LOOPBACK = new Set(['localhost','127.0.0.1','[::1]']);
const MAX_BODY = 256 * 1024 * 1024;
function error(status, code, key, params) { return Object.assign(messageError(new Error(''), key, params), {status,code}); }
function inside(root, target) { const relative = path.relative(root,target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
function headersWithoutHop(headers) {
  const skip = new Set(['connection','keep-alive','transfer-encoding','te','trailer','upgrade','proxy-connection','proxy-authenticate','proxy-authorization',
    ...String(headers.connection || '').toLowerCase().split(',').map(name=>name.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name])=>!skip.has(name.toLowerCase())));
}
function reject(response, failure) {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  const visible = failure.status ? failure : messageError(new Error(''), 'desktop.webHost.errors.resourceUnreadable');
  const data = Buffer.from(JSON.stringify({ok:false,code:failure.code || 'file_error',
    error:visible.message, messageKey:visible.messageKey, messageParams:visible.messageParams}));
  response.writeHead(failure.status || 500, {'Content-Type':'application/json','Content-Length':data.length,
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
  response.end(data);
}

/** The editor origin exists independently of codec readiness. Static files are
 * streamed from the packaged web root; bounded API jobs wait without consuming
 * their upload and forward with backpressure once Python is ready. */
async function startDesktopHost({appRoot, resourcesPath, packaged=false, onError=()=>{}, log=()=>{},
  startCodec=startBackend, maxApiRequests=16, token=''}={}) {
  if (!Number.isInteger(maxApiRequests) || maxApiRequests<1 || maxApiRequests>64) throw messageError(new RangeError(''), 'desktop.webHost.errors.invalidFileOperationCapacity', {});
  const root = await fs.realpath(packaged ? path.join(resourcesPath,'web') : appRoot);
  const controller = new AbortController(), jobs = new Set(), controls = new Set(), cancellations = new Set();
  const agent = new http.Agent({keepAlive:true,maxSockets:maxApiRequests,maxFreeSockets:2});
  const controlAgent = new http.Agent({keepAlive:true,maxSockets:4,maxFreeSockets:1});
  let codec, failure, stopped=false, closing;
  const notify = value => { try { onError(value); } catch { /* Diagnostics cannot stop the editor. */ } };
  const unavailable = () => error(503,'backend_unavailable',"desktop.webHost.errors.backendUnavailable");

  async function serveStatic(request,response,pathname) {
    const relative = decodeURIComponent(pathname).slice(1) || 'index.html';
    const parts = relative.split('/');
    if (relative.includes('\\') || relative.includes(':') || parts.some(part=>part.startsWith('.')) ||
        (parts.length > 1 && !['src','vendor','assets',...(!packaged?['tests','artifacts']:[])].includes(parts[0])) ||
        (parts.length === 1 && !['.html','.css','.svg','.png','.ico'].includes(path.extname(relative).toLowerCase())))
      throw error(403,'resource_forbidden',"desktop.webHost.errors.resourceForbidden");
    const type = MIME.get(path.extname(relative).toLowerCase());
    if (!type) throw error(403,'resource_forbidden',"desktop.webHost.errors.resourceForbidden");
    let target;
    try { target = await fs.realpath(path.join(root,relative)); }
    catch (cause) { if (cause.code==='ENOENT') throw error(404,'file_not_found',"desktop.webHost.errors.fileNotFound"); throw cause; }
    if (!inside(root,target)) throw error(403,'path_forbidden',"desktop.webHost.errors.pathForbidden");
    const file = await fs.open(target,'r');
    try {
      const stat = await file.stat({bigint:true});
      if (!stat.isFile()) throw error(404,'file_not_found',"desktop.webHost.errors.fileNotFound");
      const etag = `"${stat.mtimeNs.toString(16)}-${stat.size.toString(16)}"`;
      const tags = String(request.headers['if-none-match'] || '').split(',').map(tag=>tag.trim().replace(/^W\//,''));
      const unchanged = tags.includes('*') || tags.includes(etag);
      response.writeHead(unchanged ? 304 : 200, {'Content-Type':type,'Content-Length':String(stat.size),
        'ETag':etag,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      if (unchanged || request.method==='HEAD') response.end();
      else await pipeline(file.createReadStream({autoClose:false}),response);
    } finally { await file.close(); }
  }

  function cancelCodecJob(id,authorization) {
    if (!codec || stopped || failure || cancellations.size>=maxApiRequests) return;
    const control=http.request(new URL(`/api/cancel?id=${encodeURIComponent(id)}`,codec.origin),
      {method:'POST',agent:controlAgent,timeout:2000,
        headers:{'Content-Length':0,...(authorization?{Authorization:authorization}:{})}},incoming=>{
        incoming.resume();incoming.once('end',()=>cancellations.delete(control));
        incoming.once('error',()=>cancellations.delete(control));
      });
    cancellations.add(control);
    control.once('timeout',()=>control.destroy());
    control.once('error',()=>cancellations.delete(control));
    control.once('close',()=>cancellations.delete(control));control.end();
  }

  function forward(request,response,pathname) {
    const control=pathname==='/api/cancel'||pathname==='/api/source/release', collection=control?controls:jobs;
    if (control ? controls.size>=4 : jobs.size+cancellations.size>=maxApiRequests) { reject(response,error(503,'backend_busy',"desktop.webHost.errors.backendBusy")); return; }
    const cancellable=['/api/import','/api/open','/api/export','/api/source'].includes(pathname);
    const identity=cancellable?(request.headers['x-styk-job-id']||randomBytes(16).toString('hex')):null;
    let upstream, done=false;
    const finish = () => {
      if (done) return; done=true; collection.delete(job);
      request.removeListener('aborted',cancel); response.removeListener('close',cancel); response.removeListener('finish',finish);
    };
    const cancel = () => {
      if (!done && upstream && cancellable) cancelCodecJob(identity,request.headers.authorization);
      upstream?.destroy();finish();
    };
    const job = {cancel, fail() { cancel(); reject(response,unavailable()); }, start() {
      if (done) return;
      upstream = http.request(new URL(request.url,codec.origin), {method:request.method,agent:control?controlAgent:agent,
        headers:{...headersWithoutHop(request.headers),host:new URL(codec.origin).host,...(identity?{'x-styk-job-id':identity}:{})}}, incoming => {
        response.writeHead(incoming.statusCode,headersWithoutHop(incoming.headers));
        void pipeline(incoming,response).catch(()=>cancel());
      });
      upstream.on('error',()=>{if (!done) {finish(); reject(response,unavailable());}});
      request.pipe(upstream);
    }};
    collection.add(job); request.once('aborted',cancel); response.once('close',cancel); response.once('finish',finish);
    if (codec) job.start();
  }

  const server = http.createServer((request,response) => {
    void (async()=>{
      if (stopped) throw unavailable();
      let host; try { host = new URL(`http://${request.headers.host || ''}`); }
      catch { throw error(403,'host_forbidden',"desktop.webHost.errors.hostForbidden"); }
      if (!LOOPBACK.has(host.hostname) || host.port !== String(server.address().port))
        throw error(403,'host_forbidden',"desktop.webHost.errors.hostForbidden");
      if (request.headers.origin) {
        let origin; try { origin = new URL(request.headers.origin); } catch { /* Invalid and null origins are rejected. */ }
        if (!origin || origin.protocol!=='http:' || !LOOPBACK.has(origin.hostname))
          throw error(403,'origin_forbidden',"desktop.webHost.errors.originForbidden");
      }
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw error(400,'invalid_request',"desktop.webHost.errors.invalidRequest");
      const url = new URL(request.url,`http://${request.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        if (!['GET','HEAD','POST','OPTIONS'].includes(request.method)) throw error(405,'method_not_allowed',"desktop.webHost.errors.methodNotAllowed");
        // Authenticate before queue admission, including while Python starts.
        // Health/preflight stay public, as on the codec's direct loopback host.
        const publicRequest=request.method==='OPTIONS'||(['GET','HEAD'].includes(request.method)&&url.pathname==='/api/health');
        if(token&&!publicRequest&&request.headers.authorization!==`Bearer ${token}`)
          throw error(401,'unauthorized',"desktop.webHost.errors.unauthorized");
        if (failure) throw unavailable();
        if (request.method==='POST') {
          const length = Number(request.headers['content-length']);
          if (request.headers['transfer-encoding']) throw error(400,'unsupported_transfer',"desktop.webHost.errors.unsupportedTransfer");
          if (!Number.isSafeInteger(length) || length<0) throw error(411,'length_required',"desktop.webHost.errors.lengthRequired");
          if (length>MAX_BODY) throw error(413,'body_too_large',"desktop.webHost.errors.bodyTooLarge");
        }
        forward(request,response,url.pathname);
      } else {
        if (!['GET','HEAD'].includes(request.method)) throw error(405,'method_not_allowed',"desktop.webHost.errors.resourcesReadOnly");
        await serveStatic(request,response,url.pathname);
      }
    })().catch(cause=>reject(response,cause instanceof URIError ? error(400,'invalid_path',"desktop.webHost.errors.invalidPath") : cause));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const codecFailed = message => { failure = unavailable(); for (const job of [...jobs,...controls]) job.fail(); if (!stopped) notify(message); };
  const ready = Promise.resolve().then(()=>startCodec({appRoot,resourcesPath,packaged,log,token,signal:controller.signal,onError:codecFailed}))
    .then(value=>{if(stopped){value.stop();throw new DOMException('The editor closed.','AbortError');}codec=value;for(const job of [...controls,...jobs])job.start();return value;})
    .catch(cause=>{if(!stopped)codecFailed(cause.message);throw cause;});
  ready.catch(()=>{}); // Starting the shell does not require a caller awaiting Python.
  return {origin,port:server.address().port,ready,
    get child(){return codec?.child;},
    get pendingRequests(){return jobs.size+controls.size;},
    stop(){
      if (closing) return closing;
      stopped=true; controller.abort(); codec?.stop(); agent.destroy();controlAgent.destroy();
      for(const pending of cancellations)pending.destroy();cancellations.clear();
      for(const job of [...jobs,...controls]){job.cancel();}
      closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections();return closing;
    }};
}

module.exports = {startDesktopHost};
