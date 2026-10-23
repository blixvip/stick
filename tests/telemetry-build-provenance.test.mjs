import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTelemetryInfo } from '../scripts/build-telemetry-info.cjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'styk-build-provenance-'));
  const sources = {
    'src/app.mjs': 'export const feature = "animation";\n',
    'src/nested/render.mjs': 'export const frames = 24;\n',
    'desktop/main.cjs': 'module.exports = { desktop: true };\n',
    'backend/app.py': 'APP = "StykAnimate"\n',
    'codecs/decoder.py': 'FORMAT_VERSION = 1\n',
    'package.json': JSON.stringify({ name: 'stykanimate-test', version: '0.5.6' }) + '\n',
  };
  for (const [file, content] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

test('build provenance is repeatable across runs and installation paths but changes with source code', async () => {
  const firstRoot = await fixture(), secondRoot = await fixture();
  const first = await buildTelemetryInfo(firstRoot, { internal: false });
  assert.match(first.build, /^[a-f0-9]{16}$/);
  assert.deepEqual(await buildTelemetryInfo(firstRoot, { internal: false }), first);
  assert.deepEqual(await buildTelemetryInfo(secondRoot, { internal: false }), first, 'temporary install path is not part of source identity');
  await writeFile(path.join(secondRoot, 'src/nested/render.mjs'), 'export const frames = 30;\n');
  const changed = await buildTelemetryInfo(secondRoot, { internal: false });
  assert.notEqual(changed.build, first.build);
  assert.deepEqual(await buildTelemetryInfo(secondRoot, { internal: false }), changed);
});

test('runtime identifiers, animation contents and generated build metadata cannot affect or leak through provenance', async () => {
  const root = await fixture(), initial = await buildTelemetryInfo(root, { internal: false });
  await mkdir(path.join(root, 'documents'), { recursive: true });
  await writeFile(path.join(root, 'documents/private-animation.stykz'), 'PRIVATE ANIMATION CONTENT');
  await writeFile(path.join(root, 'desktop/telemetry-state.json'), JSON.stringify({ token: 'private-runtime-token', installationId: 'private-installation', days: { today: 'private activity' } }));
  await writeFile(path.join(root, 'src/reference.png'), 'PRIVATE REFERENCE IMAGE');
  await writeFile(path.join(root, 'desktop/telemetry-build.json'), JSON.stringify({ build: 'ffffffffffffffff', internal: true, privateDevice: 'private device identity' }));
  const rebuilt = await buildTelemetryInfo(root, { internal: false });
  assert.deepEqual(rebuilt, initial);
  const generated = await readFile(path.join(root, 'desktop/telemetry-build.json'), 'utf8');
  assert.deepEqual(JSON.parse(generated), initial);
  assert.deepEqual(Object.keys(JSON.parse(generated)).sort(), ['build', 'internal']);
  assert.ok(!/private|runtime|installation|device/i.test(generated));
  await writeFile(path.join(root, 'desktop/telemetry-state.json'), JSON.stringify({ token: 'another-private-token' }));
  assert.deepEqual(await buildTelemetryInfo(root, { internal: false }), initial);
});

test('internal build classification is explicit and does not change the source fingerprint', async () => {
  const root = await fixture(), original = process.env.STYK_INTERNAL_BUILD;
  try {
    process.env.STYK_INTERNAL_BUILD = '1';
    const internal = await buildTelemetryInfo(root);
    assert.equal(internal.internal, true);
    const external = await buildTelemetryInfo(root, { internal: false });
    assert.equal(external.internal, false, 'explicit false overrides internal packaging environment');
    assert.equal(external.build, internal.build);
    process.env.STYK_INTERNAL_BUILD = '0';
    const defaultExternal = await buildTelemetryInfo(root);
    assert.deepEqual(defaultExternal, external);
    const explicitInternal = await buildTelemetryInfo(root, { internal: true });
    assert.deepEqual(explicitInternal, internal);
  } finally {
    if (original === undefined) delete process.env.STYK_INTERNAL_BUILD;
    else process.env.STYK_INTERNAL_BUILD = original;
  }
});
