import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
/** User-facing choices map to the existing encoders' quality controls. */
export const VIDEO_QUALITY_PRESETS = Object.freeze([
  {value: 'recommended', label: interfaceText("exportVideoQuality.recommended"), labelKey: "exportVideoQuality.recommended", quality: 0.8, rateScale: 1},
  {value: 'small', label: interfaceText("exportVideoQuality.smallerFile"), labelKey: "exportVideoQuality.smallerFile", quality: 0.55, rateScale: 0.5},
  {value: 'high', label: interfaceText("exportVideoQuality.higherQuality"), labelKey: "exportVideoQuality.higherQuality", quality: 0.95, rateScale: 1.6},
]);

export function videoQualityOptions({width, height, fps, preset = 'recommended',
  provider = 'FFmpeg', mode = 'auto', manualMbps, lossless = false} = {}) {
  const choice = VIDEO_QUALITY_PRESETS.find(option => option.value === preset);
  if (!choice) throw messageError(new Error(''), "errors.exportVideoQuality.chooseAVideoQualityPreset", {});
  if (!['auto', 'manual'].includes(mode)) throw messageError(new Error(''), "errors.exportVideoQuality.chooseAutomaticOrManualBitrate", {});
  if (lossless) return {quality: 1};
  if (mode === 'manual') {
    const value = Number(manualMbps);
    if (!Number.isFinite(value) || value < 0.1 || value > 200)
      throw messageError(new Error(''), "errors.exportVideoQuality.enterABitrateBetween01And200", {});
    return {quality: choice.quality, bitrate: Math.round(value * 1e6)};
  }
  // Native codecs use a quality target; no fixed bitrate has to be guessed.
  if (provider === 'FFmpeg') return {quality: choice.quality};
  if (provider !== 'WebCodecs') throw messageError(new Error(''), "errors.exportVideoQuality.unknownVideoEncoder", {});
  if (![width, height, fps].every(value => Number.isFinite(value) && value > 0))
    throw messageError(new Error(''), "errors.exportVideoQuality.chooseValidVideoDimensionsAndFrameRate", {});
  // Browser WebCodecs needs a rate target. Derive it afresh from final output
  // dimensions so changing the preset to 4K cannot retain a source-size rate.
  const baseline = Math.max(1e6, width * height * fps * 0.18);
  return {quality: choice.quality, bitrate: Math.round(Math.max(100000, Math.min(80e6, baseline * choice.rateScale)))};
}
