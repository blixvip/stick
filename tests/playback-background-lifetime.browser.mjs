import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('artifacts/playback-background-fix');
await mkdir(output, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const errors = [], baseline = process.env.STYK_BACKGROUND_BASELINE === '1';
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  if (baseline) for (const name of ['renderer', 'prepared-frames']) {
    const body = await readFile(path.join(output, `${name}.before.mjs`), 'utf8');
    await page.route(`**/src/${name}.mjs`, route => route.fulfill({body, contentType: 'text/javascript'}));
  }
  await page.goto(`${process.env.STYK_URL || 'http://127.0.0.1:47831'}/api/health`);
  const result = await page.evaluate(async () => {
    const {createRenderer} = await import('/src/renderer.mjs');
    const {compilePlaybackPacket} = await import('/src/playback-worker.mjs');
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const check = (value, message) => {if (!value) throw new Error(message);};
    const canvas = document.createElement('canvas'); document.body.replaceChildren(canvas);
    const source = new OffscreenCanvas(16, 12), ctx = source.getContext('2d');
    ctx.fillStyle = '#80c6f0'; ctx.fillRect(0, 0, 16, 12);
    ctx.fillStyle = '#d85c38'; ctx.fillRect(0, 0, 8, 6);
    const bitmap = await createImageBitmap(source);
    const image = {naturalWidth: 16, naturalHeight: 12};
    // Use a real CanvasImageSource with the same metadata as decoded previews.
    Object.assign(bitmap, {...image, complete: true});
    const resources = {url: asset => asset.asset_url, image: () => bitmap};
    const rows = [], captures = [];
    for (const kind of ['paint', 'image', 'solid']) {
      const report = emptyDocument(); report.canvas_width = 320; report.canvas_height = 240;
      report.backgrounds = [{background_id: 1, kind: 2, color: 0xff80c6f0}];
      if (kind === 'paint') report.backgrounds[0].paint = {type: 'linear', angle: 25,
        stops: [{offset: 0, color: [128, 198, 240], opacity: 1}, {offset: 1, color: [80, 110, 180], opacity: 1}]};
      if (kind === 'image') report.backgrounds[0] = {background_id: 1, kind: 1, asset_url: 'memory:bg', mime_type: 'image/png'};
      report.backgrounds.push({background_id: 2, kind: 2, color: 0xffd85c38});
      const figure = report.figure_types[0];
      report.keyframes = Array.from({length: 4}, (_, tick) => createFrame([createObject(figure, 1, 140 + tick * 12, 150, {scale: .6})]));
      for (const frame of report.keyframes) frame.background_id = 1;
      report.keyframes[2].camera = {x: 20, y: 10, scale: .8, angle_rad: .2};
      report.keyframes[3].background_id_b = 2; report.keyframes[3].background_mix = 100;
      const renderer = await createRenderer(canvas, {resources});
      const reference = await createRenderer(document.createElement('canvas'), {resources});
      check(renderer.device && reference.device, 'This regression requires WebGPU.');
      const gpuErrors = [];
      renderer.device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
      renderer.resize(320, 240, 1); reference.resize(320, 240, 1);
      const packets = [];
      const capture = async r => {await r.device.queue.onSubmittedWorkDone(); return r.canvas.toDataURL();};
      const present = async (tick, label) => {
        renderer.device.pushErrorScope('validation');
        check(renderer.renderPrepared(packets[tick].key, {report, view: {scale: 1}}), `${kind}/${label}: missing frame`);
        const actual = await capture(renderer), error = await renderer.device.popErrorScope();
        check(!error, `${kind}/${label}: ${error?.message}`);
        reference.render({report, frame: report.keyframes[tick], view: {scale: 1}, cameraEnabled: true});
        const expected = await capture(reference);
        check(actual === expected, `${kind}/${label}: pixels differ from independent rendering`);
        captures.push({name: `${kind}-${label}`, png: actual});
        return actual;
      };
      try {
        for (let tick = 0; tick < 4; tick++) packets.push(await compilePlaybackPacket(report, tick, {revision: 1}));
        for (const packet of packets.slice(0, 2)) renderer.prepareFrame(packet, {report});
        await present(0, 'before-pause');
        const frame = report.keyframes[0], geometry = buildGeometry(report, frame);
        const staged = await renderer.prepareSceneUpdate({report, frame, geometry, view: {scale: 1}, cameraEnabled: false});
        staged.dispose();
        await present(0, 'cancelled-edit');
        const stage = await renderer.prepareSceneUpdate({report, frame, geometry, view: {scale: 1}, cameraEnabled: false});
        stage.activate(); stage.dispose();
        renderer.render({report, frame, geometry, view: {scale: 1}, cameraEnabled: false});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await present(0, 'replayed');
        for (const packet of packets.slice(2)) renderer.prepareFrame(packet, {report});
        for (const tick of [2, 0, 3, 1, 2, 0]) await present(tick, `camera-${tick}`);
        const uploads = renderer.preparedFrames.stats.uploads, textureUploads = renderer.preparedFrames.stats.textureUploads;
        const submissions = [];
        for (let n = 0; n < 240; n++) {
          const started = performance.now();
          renderer.prepareFrame(packets[n % 4], {report});
          renderer.renderPrepared(packets[n % 4].key, {report, view: {scale: 1}});
          submissions.push(performance.now() - started);
        }
        await renderer.device.queue.onSubmittedWorkDone();
        check(renderer.preparedFrames.stats.uploads === uploads, 'Warm playback reuploaded frame buffers.');
        check(renderer.preparedFrames.stats.textureUploads === textureUploads, 'Warm playback reuploaded textures.');
        renderer.preparedFrames.maxFrames = 2;
        renderer.clearPreparedFrames();
        for (let n = 0; n < 12; n++) {
          const tick = n % 4;
          renderer.prepareFrame(packets[tick], {report}); await present(tick, `eviction-${n}`);
          check(renderer.preparedFrames.frames.size <= 2 && renderer.preparedFrames.bytes <= renderer.preparedFrames.maxBytes, 'Playback cache exceeded its limits.');
        }
        renderer.useReport(emptyDocument());
        check(renderer.preparedFrames.frames.size === 0 && renderer.preparedFrames.bytes === 0, 'Replacing the document retained playback resources.');
        check(gpuErrors.length === 0, gpuErrors.join('\n'));
        submissions.sort((a, b) => a - b);
        rows.push({kind, pixelComparisons: captures.filter(c => c.name.startsWith(kind)).length,
          warmSubmissions: submissions.length, warmUploads: 0, submissionP95Ms: submissions[Math.floor(submissions.length * .95)], gpuErrors});
      } finally {
        renderer.destroy(); reference.destroy();
        for (const packet of packets) for (const entry of packet.compatibility) entry.bitmap?.close();
      }
    }
    bitmap.close(); return {rows, captures};
  });
  for (const capture of result.captures) await writeFile(path.join(output, `${capture.name}.png`), Buffer.from(capture.png.split(',')[1], 'base64'));
  delete result.captures;
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'browser.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {await browser.close();}
