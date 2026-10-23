'use strict';
const { messageError } = require('./localization.cjs');


const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

// Must match session_proof() in backend/server.py.
function sessionProof(token) {
  return crypto.createHash('sha256').update(`styk-session:${token}`).digest('hex');
}

function pythonCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  const add = (command, args = []) => {
    if (command && !candidates.some((item) => item.command === command)) candidates.push({ command, args });
  };
  add(env.STYK_PYTHON);
  if (env.VIRTUAL_ENV) add(path.join(env.VIRTUAL_ENV, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  if (env.CONDA_PREFIX) add(path.join(env.CONDA_PREFIX, platform === 'win32' ? 'python.exe' : 'bin/python'));
  if (platform === 'win32') {
    for (const directory of ['miniconda3', 'anaconda3', 'miniforge3']) {
      const candidate = path.join(os.homedir(), directory, 'python.exe');
      if (fs.existsSync(candidate)) add(candidate);
    }
    add('py', ['-3']);
    add('python');
    add('python3');
  } else {
    add('python3');
    add('python');
  }
  return candidates;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// A listener that took the port first cannot produce the proof for our token.
async function probeBackend(origin, token = '', signal) {
  const timeout = AbortSignal.timeout(700);
  const response = await fetch(`${origin}/api/health`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) return false;
  return !token || (await response.json()).session === sessionProof(token);
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/**
 * A token makes /api/* require `Authorization: Bearer <token>`, so other local
 * processes and localhost pages cannot use the codec. Readiness then also
 * requires the health proof, rejecting a listener that took the port first.
 */
async function startBackend({ appRoot, resourcesPath, packaged = false, onError = () => {}, log = () => {}, port: requestedPort, token = '', signal }) {
  signal?.throwIfAborted();
  const port = requestedPort || await availablePort();
  signal?.throwIfAborted();
  const origin = `http://127.0.0.1:${port}`;
  const resourceRoot = packaged ? resourcesPath : appRoot;
  const server = path.join(resourceRoot, 'backend', 'server.py');
  const webRoot = packaged ? path.join(resourcesPath, 'web') : appRoot;
  const toolsRoot = packaged ? path.join(resourcesPath, 'tools') : path.join(appRoot, 'codecs');
  const bridgePath = packaged ? path.join(resourcesPath, 'codec_bridge.py') : path.join(appRoot, 'codecs', 'codec_bridge.py');
  const binary = path.join(resourcesPath || appRoot, 'sidecar', 'styk-codec', process.platform === 'win32' ? 'styk-codec.exe' : 'styk-codec');
  const commands = packaged && fs.existsSync(binary)
    ? [{ command: binary, args: [] }]
    : pythonCandidates().map((candidate) => ({ command: candidate.command, args: [...candidate.args, server] }));
  const attempts = [];
  for (const candidate of commands) {
    signal?.throwIfAborted();
    let output = '';
    let terminated = false;
    let intentionalStop = false;
    let startupError;
    // stdin stays an open pipe for the codec's whole life: the OS closes it when
    // this process dies by any route, and --exit-on-stdin-close then stops the
    // codec, so a crashed or killed app never leaves it running.
    const child = spawn(candidate.command, [...candidate.args, '--host', '127.0.0.1', '--port', String(port), '--exit-on-stdin-close'], {
      cwd: resourceRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', STYK_WEB_ROOT: webRoot, STYK_TOOLS_ROOT: toolsRoot, STYK_BRIDGE_PATH: bridgePath, ...(token ? { STYK_API_TOKEN: token } : {}) },
    });
    child.stdin.on('error', () => { /* The codec closed its end; exit handling below reports it. */ });
    const stop = () => { intentionalStop = true; if (!terminated) child.kill(); };
    signal?.addEventListener('abort',stop,{once:true});
    child.once('close',()=>signal?.removeEventListener('abort',stop));
    child.on('error', (error) => { startupError = error; terminated = true; });
    child.on('exit', (code, signal) => {
      terminated = true;
      if (child.stykReady && !intentionalStop) onError(`The Pivot codec stopped (${signal || code}). ${output.slice(-1600)}`);
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      const message = chunk.toString();
      output = (output + message).slice(-12000);
      log(message);
    });
    const deadline = Date.now() + 20000;
    while (!terminated && Date.now() < deadline) {
      try {
        if (await probeBackend(origin, token, signal)) {
          signal?.throwIfAborted();
          child.stykReady = true;
          return {
            origin,
            port,
            child,
            stop,
          };
        }
      } catch { /* The child is still binding its loopback socket. */ }
      if (signal?.aborted) break;
      await wait(90);
    }
    stop();
    signal?.throwIfAborted();
    attempts.push(`${candidate.command}: ${startupError?.message || output.trim() || 'Startup timed out.'}`);
  }
  throw messageError(new Error(''), 'desktop.backend.errors.thePivotCodecCouldNotStartInstallPython311OrNewerOrSetSTYKPYTHONToItsExecutableValue', {value: attempts.join('\n\n')});
}

module.exports = { startBackend, pythonCandidates, availablePort, probeBackend, sessionProof };
