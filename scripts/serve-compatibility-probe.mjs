/** Isolated current codec service + two read-only source trees for paired probes. */
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import backend from '../desktop/backend.cjs';

const root=process.cwd(),baseline=process.argv[2]&&path.resolve(process.argv[2]);
if(!baseline)throw Error('Provide the frozen source-tree directory.');
const service=await backend.startBackend({appRoot:root,onError:message=>console.error(message)});
const mime={'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json',
  '.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm'};
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    const proxy=http.request(new URL(request.url,service.origin),{method:request.method,headers:{...request.headers,host:new URL(service.origin).host}},remote=>{
      response.writeHead(remote.statusCode,remote.headers);remote.pipe(response);
    });proxy.on('error',()=>{response.writeHead(502);response.end();});request.pipe(proxy);return;
  }
  const prefix='/__compat_baseline__/',frozen=url.pathname.startsWith(prefix);
  let relative=decodeURIComponent(frozen?url.pathname.slice(prefix.length):url.pathname.slice(1));
  if(!relative)relative='index.html';
  const directory=frozen&&(relative.startsWith('src/')||relative.startsWith('tests/'))?baseline:root;
  const filename=path.resolve(directory,relative),within=path.relative(directory,filename);
  if(within.startsWith('..')||path.isAbsolute(within)){response.writeHead(403);response.end();return;}
  try{const bytes=await readFile(filename);response.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-store'});response.end(bytes);}
  catch(error){response.writeHead(error.code==='ENOENT'?404:500);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,codec:service.origin}));
const stop=()=>{server.close();service.stop();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('exit',()=>service.stop());
