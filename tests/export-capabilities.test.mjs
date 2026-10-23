import test from 'node:test';
import assert from 'node:assert/strict';
import {getExportCapabilities, exportFormat} from '../src/export-capabilities.mjs';

const environment = {Worker: class {}, OffscreenCanvas: class {}, createImageBitmap() {}, VideoFrame: class {},
  VideoEncoder: {isConfigSupported: async config => ({supported: config.codec === 'vp8'})}};
test('portable capability choices distinguish real containers and numbered formats', async () => {
  const result = await getExportCapabilities({environment});
  assert.equal(result.formats.length, 10);
  assert.equal(result.formats.find(value => value.id === 'webm').codec, 'VP8');
  for (const id of ['mp4', 'avi', 'wmv']) { const format = result.formats.find(value => value.id === id); assert.equal(format.supported, false); assert.match(format.reason, /desktop/); }
  for (const id of ['gif-sequence', 'svg-sequence']) assert.equal(result.formats.find(value => value.id === id).supported, true);
  assert.equal(exportFormat('wmv').extension, 'wmv'); assert.equal(exportFormat('wmv').mimeType, 'video/x-ms-wmv');
});
test('MP4 is offered from WebCodecs H.264 when there is no desktop encoder', async () => {
  const seen = [];
  const h264 = {...environment, VideoEncoder: {isConfigSupported: async config => { seen.push(config.codec); return {supported: config.codec.startsWith('avc1.4d')}; }}};
  const result = await getExportCapabilities({environment: h264, width: 321, height: 181, fps: 30});
  const mp4 = result.formats.find(value => value.id === 'mp4');
  assert.deepEqual(seen.filter(codec => codec.startsWith('avc1')).map(codec => codec.slice(0, 7)), ['avc1.64', 'avc1.4d'], 'High is tried before Main');
  assert.equal(mp4.supported, true); assert.equal(mp4.provider, 'WebCodecs'); assert.equal(mp4.codec, 'H.264');
  assert.deepEqual([mp4.encodedWidth, mp4.encodedHeight], [322, 182], 'an odd picture is padded to an even width and height');
  assert.deepEqual(mp4.codecs.map(codec => codec.id), ['h264']); assert.equal(mp4.defaultCodec, 'h264'); assert.equal(mp4.alpha, false);
  assert.equal(result.formats.find(value => value.id === 'avi').supported, false, 'AVI and WMV remain desktop-only');
  // Where a desktop encoder exists it alone decides MP4, whatever the browser could do.
  const desktop = await getExportCapabilities({environment: h264, desktop: {getVideoCapabilities: async () => ({formats: []})}});
  assert.equal(desktop.formats.find(value => value.id === 'mp4').supported, false);
});
test('native probe support is honored independently for each format and failures remain explicit', async () => {
  const desktop = {getVideoCapabilities: async options => { assert.equal(options.width, 600); return {version: 'FFmpeg test', formats: [{id: 'mp4', codec: 'h264', supported: true}, {id: 'wmv', supported: false, reason: 'Encoder missing'}]}; }};
  const result = await getExportCapabilities({environment, desktop, width: 600});
  assert.equal(result.formats.find(value => value.id === 'mp4').supported, true);
  assert.equal(result.formats.find(value => value.id === 'wmv').reason, 'Encoder missing');
  assert.equal(result.formats.find(value => value.id === 'avi').supported, false);
  const failed = await getExportCapabilities({environment, desktop: {getVideoCapabilities: async () => { throw new Error('Probe failed'); }}});
  assert.equal(failed.formats.find(value => value.id === 'mp4').reason, 'Probe failed');
});
test('rate and dimension limits match raster encoders while vector sequences remain available', async () => {
  const highRate = await getExportCapabilities({environment, fps: 60});
  assert.equal(highRate.formats.find(value => value.id === 'gif').supported, false);
  assert.equal(highRate.formats.find(value => value.id === 'gif-sequence').supported, true);
  const raised = await getExportCapabilities({environment, width: 5000, height: 5000});
  assert.equal(raised.formats.find(value => value.id === 'png-sequence').supported, true);
  const large = await getExportCapabilities({environment, width: 9000, height: 9000});
  assert.equal(large.formats.find(value => value.id === 'png-sequence').supported, false);
  assert.equal(large.formats.find(value => value.id === 'svg-sequence').supported, true);
  await assert.rejects(() => getExportCapabilities({width: -1}), /dimensions/);
});
test('missing browser features and unsupported codecs never advertise working encoders', async () => {
  const empty = await getExportCapabilities({environment: {}});
  assert.ok(empty.formats.every(value => !value.supported));
  const fallback = await getExportCapabilities({environment: {...environment, VideoEncoder: {isConfigSupported: async config => ({supported: config.codec.startsWith('vp09')})}}});
  assert.equal(fallback.formats.find(value => value.id === 'webm').codec, 'VP9');
  const format = exportFormat('gif'); format.extension = 'fake'; assert.equal(exportFormat('gif').extension, 'gif');
});


test('desktop WebM chooses its transparent native encoder even without WebCodecs',async()=>{
  const result=await getExportCapabilities({environment:{Worker:class{},OffscreenCanvas:class{},createImageBitmap(){}},desktop:{getVideoCapabilities:async()=>({formats:[{id:'webm',supported:true,codec:'VP9 with transparency',alpha:true,defaultCodec:'vp9',codecs:[{id:'vp9',supported:true,alpha:true}]}]})}});
  const value=result.formats.find(f=>f.id==='webm');assert.equal(value.supported,true);assert.equal(value.provider,'FFmpeg');assert.equal(value.alpha,true);
});
