import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {videoQualityOptions} from '../src/export-video-quality.mjs';
const {validateConfig, encoderArguments} = createRequire(import.meta.url)('../desktop/video-export-service.cjs');

test('automatic native quality leaves bitrate to the encoder, while all presets change quality', () => {
  const values = ['small', 'recommended', 'high'].map(preset => videoQualityOptions({preset}));
  assert.ok(values.every(value => value.bitrate === undefined));
  assert.ok(values[0].quality < values[1].quality && values[1].quality < values[2].quality);
  for (const format of ['mp4', 'webm', 'avi', 'wmv']) {
    const args = encoderArguments(validateConfig({format, width: 3840, height: 2160, fps: 24, totalFrames: 12, ...values[1]}), `test.${format}`);
    if (format === 'webm') {assert.equal(args[args.indexOf('-b:v') + 1], '0'); assert.ok(args.includes('-crf'));}
    else {assert.ok(!args.includes('-b:v')); assert.ok(args.includes(format === 'mp4' ? '-crf' : '-q:v'));}
  }
});

test('browser automatic bitrate follows final size, frame rate and preset with finite bounds', () => {
  const plan = (width, height, fps = 24, preset = 'recommended') => videoQualityOptions({width, height, fps, preset, provider: 'WebCodecs'}).bitrate;
  assert.ok(plan(3840, 2160) > plan(1920, 1080));
  assert.ok(plan(1920, 1080, 60) > plan(1920, 1080, 24));
  assert.ok(plan(1920, 1080, 24, 'high') > plan(1920, 1080, 24));
  assert.ok(plan(1920, 1080, 24, 'small') < plan(1920, 1080, 24));
  assert.equal(plan(16384, 1024, 1000, 'high'), 80e6);
  assert.ok(plan(1, 1) >= 100000);
});

test('manual rate is exact, independent of dimensions, and cannot leak into auto or lossless', () => {
  assert.equal(videoQualityOptions({mode: 'manual', manualMbps: '0.25'}).bitrate, 250000);
  assert.equal(videoQualityOptions({mode: 'auto', manualMbps: 'bad'}).bitrate, undefined);
  assert.deepEqual(videoQualityOptions({mode: 'manual', manualMbps: 'bad', lossless: true}), {quality: 1});
  for (const manualMbps of ['', 0, NaN, Infinity, 201]) assert.throws(() => videoQualityOptions({mode: 'manual', manualMbps}), /bitrate/);
  assert.throws(() => videoQualityOptions({preset: 'unknown'}), /quality/);
});
