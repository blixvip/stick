import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolvePython} from '../scripts/run-python.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
void require;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// A parent that owns a real codec process and then dies without running any
// quit handler. On POSIX that is SIGKILL; process.kill maps to TerminateProcess
// on Windows. Either way the codec must follow it.
const parentSource = `
const {startBackend} = require(${JSON.stringify(path.join(appRoot, 'desktop', 'backend.cjs'))});
startBackend({appRoot: ${JSON.stringify(appRoot)}, resourcesPath: ${JSON.stringify(appRoot)}, packaged: false}).then(backend => {
  process.stdout.write(JSON.stringify({codec: backend.child.pid}) + '\\n');
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200);
}).catch(error => { console.error(error.message); process.exit(3); });
`;

test('a killed parent never leaves the codec running', {skip: resolvePython() ? false : 'Python 3.11+ is not installed', timeout: 60000}, async () => {
  const parent = spawn(process.execPath, ['-e', parentSource], {stdio: ['ignore', 'pipe', 'inherit']});
  let output = '';
  parent.stdout.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => parent.once('exit', (code, signal) => resolve({code, signal})));
  const started = Date.now();
  while (!output.includes('\n') && Date.now() - started < 30000) await delay(50);
  const {codec} = JSON.parse(output.split('\n')[0]);
  assert.ok(Number.isInteger(codec) && codec > 0, 'the parent reports its codec pid');
  try {
    await exited;
    const deadline = Date.now() + 15000;
    while (alive(codec) && Date.now() < deadline) await delay(100);
    assert.equal(alive(codec), false, 'the codec must exit after its parent is killed');
  } finally {
    if (alive(codec)) process.kill(codec, 'SIGKILL');
  }
});
