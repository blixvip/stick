import {interfaceLocalization} from '../src/localization.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPORT_PRESETS, applyExportPreset, artboardShape, exportPresetFit, exportPresetHeld} from '../src/export-presets.mjs';
import {EXPORT_FORMATS, exportFormatStates, exportTypeHint, initialExportRequest, sameShape, updateExportRequest, validateExportRequest} from '../src/export-request.mjs';
import {iconNames} from '../src/icons.mjs';

const landscape = {canvasWidth: 960, canvasHeight: 540, totalFrames: 48};
const portrait = {canvasWidth: 540, canvasHeight: 960, totalFrames: 48};
const square = {canvasWidth: 800, canvasHeight: 800, totalFrames: 48};
const desktop = {formats: [
  {id: 'mp4', supported: true, provider: 'FFmpeg', defaultCodec: 'h264', codecs: [{id: 'h264', label: 'H.264', supported: true}, {id: 'mpeg4', label: 'MPEG-4', supported: true}]},
  {id: 'webm', supported: true, provider: 'FFmpeg'},
]};
const browser = {formats: [{id: 'mp4', supported: false, reason: 'MP4 needs the desktop app.'}, {id: 'webm', supported: true, provider: 'WebCodecs'}]};
const statesFor = (capabilities, board = landscape) => exportFormatStates({capabilities: capabilities && {...capabilities, width: board.canvasWidth, height: board.canvasHeight}, totalFrames: board.totalFrames});
/** The request after choosing a preset in a fresh dialog. */
const choose = (id, board = landscape, states = statesFor(desktop, board)) =>
  updateExportRequest(initialExportRequest({states, context: board}), applyExportPreset(id, {board, states}), board);

test('every preset keeps the canvas shape and exports on the desktop', () => {
  for (const board of [landscape, portrait, square]) {
    const states = statesFor(desktop, board);
    for (const {id} of EXPORT_PRESETS) {
      const request = choose(id, board, states);
      assert.ok(sameShape(request, board), `${id} on ${board.canvasWidth}×${board.canvasHeight} keeps its shape (${request.width}×${request.height})`);
      const validity = validateExportRequest(request, {states, totalFrames: board.totalFrames, fps: 24});
      assert.equal(validity.error, '', `${id}: ${validity.error}`);
      assert.ok(validity.canExport, `${id} can export`);
    }
  }
});

test('platform presets choose MP4 (H.264), their size and quality, and automatic bitrate', () => {
  const youtube = choose('youtube');
  assert.deepEqual([youtube.format, youtube.codecs.mp4, youtube.sizePreset, youtube.width, youtube.height, youtube.videoQuality, youtube.bitrateMode],
    ['mp4', 'h264', '1080', 1920, 1080, 'high', 'auto']);
  const tiktok = choose('tiktok', portrait);
  assert.deepEqual([tiktok.format, tiktok.width, tiktok.height, tiktok.videoQuality], ['mp4', 1080, 1920, 'recommended']);
  const x = choose('x');
  assert.deepEqual([x.sizePreset, x.width, x.height], ['720', 1280, 720]);
  // Manual bitrate chosen earlier gives way to the preset's quality.
  const states = statesFor(desktop), manual = updateExportRequest(initialExportRequest({states, context: landscape}), {bitrateMode: 'manual', bitrateMbps: 2}, landscape);
  assert.equal(updateExportRequest(manual, applyExportPreset('youtube', {board: landscape, states}), landscape).bitrateMode, 'auto');
});

test('without MP4, presets whose platform takes WebM use it; MP4-only platforms keep MP4 and say why', () => {
  const states = statesFor(browser);
  assert.equal(applyExportPreset('youtube', {board: landscape, states}).format, 'webm');
  assert.equal(applyExportPreset('tiktok', {board: landscape, states}).format, 'webm');
  for (const id of ['instagram', 'x']) {
    const request = choose(id, landscape, states);
    assert.equal(request.format, 'mp4');
    const validity = validateExportRequest(request, {states, totalFrames: 48, fps: 24});
    assert.equal(validity.canExport, false);
    assert.equal(validity.notice, 'MP4 needs the desktop app.');
  }
  // While the encoders are still being checked, MP4 is kept (the sheet moves on if it proves unavailable).
  assert.equal(applyExportPreset('youtube', {board: landscape, states: statesFor(null)}).format, 'mp4');
});

test('the chat GIF is at most 480 pixels on its short side; Transparent is PNG frames at the canvas size', () => {
  const gif = choose('gif');
  assert.deepEqual([gif.format, gif.sizePreset, gif.width, gif.height], ['gif', 'custom', 853, 480]);
  const small = {canvasWidth: 320, canvasHeight: 240, totalFrames: 12};
  assert.deepEqual([choose('gif', small).sizePreset, choose('gif', small).width], ['original', 320]);
  const transparent = choose('transparent', portrait);
  assert.deepEqual([transparent.format, transparent.sizePreset, transparent.width, transparent.height], ['png-sequence', 'original', 540, 960]);
});

test('Best quality falls back to 1080p where 4K exceeds what an export allows', () => {
  assert.equal(choose('best').sizePreset, '2160');
  const tall = {canvasWidth: 100, canvasHeight: 1000, totalFrames: 12};
  const request = choose('best', tall);
  assert.deepEqual([request.sizePreset, request.width, request.height], ['1080', 1080, 10800]);
});

test('a preset stays chosen until a setting it chose changes', () => {
  const applied = choose('youtube');
  assert.ok(exportPresetHeld('youtube', applied, applied));
  for (const patch of [{name: 'Trailer'}, {from: 4}, {audio: false}, {smoothing: 'crisp'}])
    assert.ok(exportPresetHeld('youtube', applied, updateExportRequest(applied, patch, landscape)), `${Object.keys(patch)} keeps it`);
  for (const patch of [{videoQuality: 'small'}, {sizePreset: '720'}, {width: 1000}, {format: 'webm'}, {bitrateMode: 'manual'}, {codecs: {mp4: 'mpeg4'}}])
    assert.equal(exportPresetHeld('youtube', applied, updateExportRequest(applied, patch, landscape)), false, `${JSON.stringify(patch)} leaves it`);
  assert.equal(exportPresetHeld('youtube', null, applied), false);
  assert.equal(exportPresetHeld('nope', applied, applied), false);
});

test('the fit note says what the export will be, or why it plays with bars and where to change the canvas', () => {
  assert.equal(artboardShape(landscape), 'landscape');
  assert.equal(artboardShape(portrait), 'portrait');
  assert.equal(artboardShape({canvasWidth: 1000, canvasHeight: 1050}), 'square');
  const ready = exportPresetFit('tiktok', portrait, choose('tiktok', portrait));
  assert.equal(ready.fits, true);
  assert.equal(ready.message, 'Ready for TikTok: 1080 × 1920.');
  assert.equal(ready.messageKey, 'exportPresets.readySize');
  const wrong = exportPresetFit('tiktok', landscape, choose('tiktok'));
  assert.equal(wrong.fits, false);
  assert.match(wrong.message, /vertical \(9:16\).*landscape.*bars.*Canvas size/);
  assert.equal(exportPresetFit('youtube', portrait, choose('youtube', portrait)).fits, false);
  assert.equal(exportPresetFit('shorts', square, choose('shorts', square)).fits, true);
  assert.equal(exportPresetFit('gif', portrait, choose('gif', portrait)).fits, true);
});

test('presets are well formed: known types, drawn icons, unique ids', () => {
  const formats = new Set(EXPORT_FORMATS.map(format => format.id));
  assert.equal(new Set(EXPORT_PRESETS.map(entry => entry.id)).size, EXPORT_PRESETS.length);
  for (const entry of EXPORT_PRESETS) {
    assert.ok(entry.formats.every(id => formats.has(id)), entry.id);
    assert.ok(iconNames.includes(entry.icon), `${entry.id} has its icon`);
    assert.ok(entry.label && entry.detail, entry.id);
  }
  assert.throws(() => applyExportPreset('nope', {board: landscape}), TypeError);
});

test('every type says what it is for; a movieclip figure is described as a movieclip', () => {
  for (const format of EXPORT_FORMATS) assert.ok(exportTypeHint(format.id).endsWith('.'), `${format.id} has a sentence`);
  assert.equal(exportTypeHint('stkz', {movieclip: true}), exportTypeHint('stykmov'));
  assert.equal(exportTypeHint('nope'), '');
});

test('language changes preserve preset decisions, identifiers and format extensions', () => {
  const before = applyExportPreset('youtube', {board: landscape, states: statesFor(null)});
  const identifiers = EXPORT_FORMATS.map(({id,action,extension}) => ({id,action,extension}));
  interfaceLocalization.setPseudo('long');
  try {
    const states = statesFor(null);
    assert.ok(states.get('mp4').reason.includes('［'));
    assert.deepEqual(applyExportPreset('youtube', {board: landscape, states}), before);
    assert.deepEqual(EXPORT_FORMATS.map(({id,action,extension}) => ({id,action,extension})), identifiers);
    assert.equal(EXPORT_FORMATS.find(x=>x.id==='piv').short, 'PIV');
    assert.ok(EXPORT_PRESETS.find(x=>x.id==='gif').label.includes('［'));
    assert.ok(exportPresetFit('tiktok', landscape, choose('tiktok')).message.includes('［'));
  } finally { interfaceLocalization.setPseudo(null); }
});
