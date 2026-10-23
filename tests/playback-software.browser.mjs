import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.'), out = path.join(root, 'artifacts/playback-software');
await mkdir(out, {recursive: true});
const {startBackend} = createRequire(import.meta.url)('../desktop/backend.cjs');
const backend = await startBackend({appRoot: root}); let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 960}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(backend.origin); await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    const {compilePlaybackPacket, packetTransferables} = await import('/src/playback-worker.mjs');
    const {createRenderer} = await import('/src/renderer.mjs');
    const {createDemo} = await import('/src/demo.mjs');
    const check = (condition, message) => {if (!condition) throw new Error(message);};
    const report = createDemo(), tick = 1, canvas = document.createElement('canvas');
    // The software packet must carry one composited surface instead of vectors.
    const packet = await compilePlaybackPacket(report, tick, {softwareFrames: true, scale: 1, hiddenKey: 'visible'});
    check(packet.softwareFrames === true && packet.hiddenKey === 'visible', 'Packet lost its software signature.');
    check(packet.shapes.length === 0 && packet.compatibility.length === 1, 'Software packet still carries shape data.');
    const bitmap = packet.compatibility[0].bitmap;
    check(bitmap.width > 0 && bitmap.height > 0, 'Software surface has no pixels.');
    check(packet.uids.length > 0, 'Software packet lost its visibility metadata.');
    check(packetTransferables(packet).includes(bitmap), 'Software surface is not transferable.');
    // Hidden figures are baked out of both the surface and the uid set.
    const hiddenUid = packet.uids[packet.uids.length - 1];
    const hidden = await compilePlaybackPacket(report, tick, {softwareFrames: true, scale: 1, hiddenUids: [hiddenUid], hiddenKey: 'one-hidden'});
    check(!hidden.uids.includes(hiddenUid) && hidden.hiddenKey === 'one-hidden', 'Hidden figure survived software baking.');
    // The compatibility renderer presents the surface in one blit.
    const renderer = await createRenderer(canvas, {forceCanvas2D: true});
    check(renderer.softwarePlayback === true, 'Compatibility renderer did not accept software playback.');
    renderer.resize(960, 540, 1);
    check(renderer.prepareFrame(packet, {report}) === packet.key, 'Software packet was not prepared.');
    check(renderer.hasPreparedFrame(packet.key), 'Prepared software surface missing.');
    const presented = renderer.renderPrepared(packet.key, {report, view: {x: 0, y: 0, scale: 1}, cameraEnabled: true, hiddenKey: 'visible'});
    check(presented === true, 'Software surface failed to present.');
    const ctx = renderer.context, data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    check(opaque > canvas.width * canvas.height * .5, `Software surface left ${100 - Math.round(100 * opaque / (canvas.width * canvas.height))}% of the artboard blank.`);
    // Stale visibility or an active drag must refuse the baked surface.
    check(renderer.renderPrepared(packet.key, {report, view: {scale: 1}, cameraEnabled: true, hiddenKey: 'changed'}) === false,
      'A stale visibility signature presented.');
    check(renderer.renderPrepared(packet.key, {report, view: {scale: 1}, cameraEnabled: true, hiddenKey: 'visible', dragTranslations: new Map([[7, {x: 1, y: 0}]])}) === false,
      'A dragged figure presented a baked surface.');
    check(renderer.renderPrepared(packet.key, {report, view: {scale: 1}, cameraEnabled: false, hiddenKey: 'visible'}) === false,
      'A camera-baked surface presented in the wrong mode.');
    // Eviction releases the copy; the packet bitmap still belongs to its pool.
    renderer.clearPreparedFrames();
    check(!renderer.hasPreparedFrame(packet.key) && renderer.preparedBytes === 0, 'Prepared surface bytes leaked.');
    const summary = {bitmap: {width: bitmap.width, height: bitmap.height}, opaque, canvas: {width: canvas.width, height: canvas.height}, uids: packet.uids.length};
    for (const entry of packet.compatibility) entry.bitmap.close();
    for (const entry of hidden.compatibility) entry.bitmap.close();
    renderer.destroy();
    return summary;
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({...result, pageErrors: errors}, null, 2));
} finally { await browser?.close(); backend.stop(); }
