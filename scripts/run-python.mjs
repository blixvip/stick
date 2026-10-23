// Runs a Python script with an interpreter that exists on this machine.
//
// Stock Linux ships `python3` only, stock Windows ships `py`; the npm build
// scripts used a bare `python` and failed on the former. The candidate list is
// the one the desktop app uses to start the codec (desktop/backend.cjs), with
// the repository's own virtual environment tried first because that is where
// scripts/requirements-build.txt is installed.
//
//   node scripts/run-python.mjs scripts/build-sidecar.py [args...]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { pythonCandidates } = require('../desktop/backend.cjs');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINIMUM = 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)';

export function venvInterpreter(root = appRoot, platform = process.platform) {
  const candidate = platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  return existsSync(candidate) ? candidate : null;
}

function defaultProbe(command, args) {
  const result = spawnSync(command, [...args, '-c', MINIMUM], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

/** First candidate that runs and is Python 3.11 or newer, or null. */
export function resolvePython({ root = appRoot, env = process.env, platform = process.platform, probe = defaultProbe } = {}) {
  const candidates = pythonCandidates(env, platform);
  if (platform === 'win32') {
    // A build machine puts the interpreter it chose first on PATH (setup-python,
    // an activated environment) and installs the build requirements into that
    // one; `py -3` may select a different Python. The desktop app tries `py`
    // first to find any Python at runtime, which is the wrong order here.
    const py = candidates.findIndex((item) => item.command === 'py'), bare = candidates.findIndex((item) => item.command === 'python' && !item.args.length);
    if (py >= 0 && bare > py) candidates.splice(py, 0, ...candidates.splice(bare, 1));
  }
  const venv = venvInterpreter(root, platform);
  if (venv && !candidates.some((item) => item.command === venv)) {
    // An explicit STYK_PYTHON stays first; the repository environment beats PATH.
    const explicit = env.STYK_PYTHON ? 1 : 0;
    candidates.splice(explicit, 0, { command: venv, args: [] });
  }
  return candidates.find((candidate) => probe(candidate.command, candidate.args)) ?? null;
}

function main() {
  const [script, ...rest] = process.argv.slice(2);
  if (!script) { console.error('Usage: node scripts/run-python.mjs <script.py> [args...]'); return 2; }
  const python = resolvePython();
  if (!python) {
    console.error('Python 3.11 or newer was not found. Install it, or set STYK_PYTHON to its executable.');
    return 1;
  }
  const result = spawnSync(python.command, [...python.args, script, ...rest], { stdio: 'inherit', cwd: appRoot, windowsHide: true });
  if (result.error) { console.error(result.error.message); return 1; }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
