import {t as interfaceText} from './localization.mjs';
import {messageError} from './localized-error.mjs';
/**
 * Export presets: one click for where the animation is going (YouTube,
 * TikTok, a chat GIF…). Pure functions over the export request
 * (export-request.mjs): a preset is a patch of the request's own fields, so
 * choosing one is an ordinary edit and every setting it chose stays visible
 * and editable. No DOM and no I/O.
 *
 * A preset never changes the picture's shape. Export scales the canvas to the
 * output size, so a 9:16 size on a 16:9 canvas would stretch the animation;
 * the size presets (export-request.mjs) keep the canvas's shape and so do
 * these. exportPresetFit() says when the canvas's shape is not the one the
 * platform shows full screen, and where to change it.
 *
 *   applyExportPreset(preset, {board, states}) → the patch for updateExportRequest
 *   exportPresetHeld(preset, applied, request) → whether the request still is the preset
 *   exportPresetFit(preset, board, request)     → {fits, message}
 */
import {lockedSide, sizePresetChoices} from './export-request.mjs';

const preset = (id, labelKey, detailKey, icon, fields) => Object.freeze({id, labelKey, detailKey, icon, ...fields,
  get label() { return interfaceText(labelKey); }, get detail() { return interfaceText(detailKey); }});
/**
 * `formats`: the types in order of preference; the first enabled one is used
 * (MP4 needs the desktop app's encoder, and YouTube, Shorts and TikTok also
 * take WebM). A platform that takes only MP4 lists only MP4, so the browser
 * shows why it cannot export rather than making a file the platform refuses.
 * `shapes`: the canvas shapes the platform shows full screen. `size`: a size
 * preset id, or `{shortSide}` for a smaller custom size (never larger than the
 * canvas). `quality`: the video quality preset. `ready`: the note once chosen, before the size.
 */
export const EXPORT_PRESETS = Object.freeze([
  preset('youtube', 'exportPresets.youtube.label', 'exportPresets.youtube.detail', 'export-youtube', {readyKey: 'exportPresets.youtube.ready', formats: ['mp4', 'webm'], size: '1080', quality: 'high', shapes: ['landscape'], wantsKey: 'exportPresets.landscape'}),
  preset('shorts', 'exportPresets.shorts.label', 'exportPresets.shorts.detail', 'export-shorts', {readyKey: 'exportPresets.shorts.ready', formats: ['mp4', 'webm'], size: '1080', quality: 'high', shapes: ['portrait', 'square'], wantsKey: 'exportPresets.vertical'}),
  preset('tiktok', 'exportPresets.tiktok.label', 'exportPresets.tiktok.detail', 'export-tiktok', {readyKey: 'exportPresets.tiktok.ready', formats: ['mp4', 'webm'], size: '1080', quality: 'recommended', shapes: ['portrait'], wantsKey: 'exportPresets.vertical'}),
  preset('instagram', 'exportPresets.instagram.label', 'exportPresets.instagram.detail', 'export-instagram', {readyKey: 'exportPresets.instagram.ready', formats: ['mp4'], size: '1080', quality: 'recommended', shapes: ['portrait', 'square'], wantsKey: 'exportPresets.vertical'}),
  preset('x', 'exportPresets.x.label', 'exportPresets.x.detail', 'export-x', {readyKey: 'exportPresets.x.ready', formats: ['mp4'], size: '720', quality: 'recommended', shapes: ['landscape', 'portrait', 'square']}),
  preset('gif', 'exportPresets.gif.label', 'exportPresets.gif.detail', 'export-gif', {readyKey: 'exportPresets.gif.ready', formats: ['gif'], size: {shortSide: 480}, shapes: ['landscape', 'portrait', 'square']}),
  preset('transparent', 'exportPresets.transparent.label', 'exportPresets.transparent.detail', 'export-transparent', {readyKey: 'exportPresets.transparent.ready', formats: ['png-sequence'], size: 'original', shapes: ['landscape', 'portrait', 'square']}),
  preset('best', 'exportPresets.best.label', 'exportPresets.best.detail', 'export-best', {readyKey: 'exportPresets.best.ready', formats: ['mp4', 'webm'], size: '2160', fallbackSize: '1080', quality: 'high', shapes: ['landscape', 'portrait', 'square']}),
]);
const PRESETS = new Map(EXPORT_PRESETS.map(entry => [entry.id, entry]));
export const exportPresetInfo = id => PRESETS.get(id) ?? null;

/** The canvas's shape: square within 10%, else landscape or portrait. */
export function artboardShape({canvasWidth, canvasHeight}) {
  const ratio = canvasWidth / canvasHeight;
  return ratio > 1.1 ? 'landscape' : ratio < 1 / 1.1 ? 'portrait' : 'square';
}

/**
 * The first of the preset's types that can export or is still being checked (so the desktop app's MP4 is chosen
 * before its encoder check returns; the sheet re-applies the preset if it proves unavailable); else the first listed.
 */
function presetFormat(entry, states) {
  const listed = entry.formats.filter(id => states?.get(id)?.listed ?? true);
  const usable = id => !states?.get(id)?.disabled || states?.get(id)?.pending === true;
  return listed.find(usable) ?? listed[0] ?? entry.formats[0];
}

/** The size fields for a preset: a size preset that fits the export limits, or a custom size scaled down to `shortSide`. */
function presetSizeFields(entry, board) {
  if (typeof entry.size === 'object') {
    const short = Math.min(board.canvasWidth, board.canvasHeight);
    if (short <= entry.size.shortSide) return {sizePreset: 'original'};
    const width = Math.max(1, Math.round(board.canvasWidth * entry.size.shortSide / short));
    return {sizePreset: 'custom', width, height: lockedSide('width', width, board), lockRatio: true};
  }
  if (entry.size === 'original') return {sizePreset: 'original'};
  const choices = sizePresetChoices(board), usable = id => choices.some(choice => choice.id === id && !choice.disabled);
  return {sizePreset: usable(entry.size) || !entry.fallbackSize ? entry.size : entry.fallbackSize};
}

/**
 * The request patch a preset applies. context: {board: {canvasWidth,
 * canvasHeight}, states: exportFormatStates()}. Video presets use H.264 for
 * MP4 (what the platforms expect) and automatic bitrate, so Quality decides.
 */
export function applyExportPreset(id, {board, states} = {}) {
  const entry = PRESETS.get(id);
  if (!entry) throw messageError(new TypeError(''), "errors.exportPresets.unknownExportPreset", {id: id});
  const format = presetFormat(entry, states);
  const patch = {format, ...presetSizeFields(entry, board)};
  if (entry.quality) Object.assign(patch, {videoQuality: entry.quality, bitrateMode: 'auto'});
  if (format === 'mp4') patch.codecs = {mp4: 'h264'};
  return patch;
}

const HELD = ['format', 'sizePreset', 'width', 'height', 'videoQuality', 'bitrateMode'];
/**
 * Whether `request` still is what choosing the preset gave (`applied`): an
 * edit to any field the preset chose leaves it (the preset shows unchosen);
 * the name, the range, sound and the other settings do not. A codec the
 * capability check replaced (H.264 unavailable) leaves it too.
 */
export function exportPresetHeld(id, applied, request) {
  const entry = PRESETS.get(id);
  if (!entry || !applied || !request) return false;
  if (!HELD.every(key => Object.is(applied[key], request[key]))) return false;
  return request.format !== 'mp4' || request.codecs?.mp4 === 'h264' || !request.codecs?.mp4;
}

/**
 * Whether the canvas's shape is one the platform shows full screen, with a
 * sentence for the dialog: what the export will be, or why it will show with
 * bars and where the canvas size is changed.
 */
export function exportPresetFit(id, board, request) {
  const entry = PRESETS.get(id);
  if (!entry) return {fits: true, message: ''};
  const shape = artboardShape(board), fits = entry.shapes.includes(shape);
  const messageKey = !fits ? 'exportPresets.labelShowsWantsVideoFullScreenThisCanvasIs'
    : Number.isFinite(request?.width) && Number.isFinite(request?.height) ? 'exportPresets.readySize' : 'exportPresets.ready';
  const messageParams = !fits ? {label: {messageKey: entry.labelKey}, wants: {messageKey: entry.wantsKey}, shape: {messageKey: `exportPresets.shape.${shape}`}}
    : {ready: {messageKey: entry.readyKey}, width: {format: 'number', value: request?.width, options: {useGrouping: false}}, height: {format: 'number', value: request?.height, options: {useGrouping: false}}};
  return {fits, message: interfaceText(messageKey, messageParams), messageKey, messageParams};
}
