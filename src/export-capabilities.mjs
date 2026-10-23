import {messageTuple} from './localization-bindings.mjs';
import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
/** Export choices describe actual encoders; container extensions are never aliases. */
import {videoQualityOptions} from './export-video-quality.mjs';
import {EXPORT_MAX_PIXELS} from './export-sampling.mjs';
import {avcCodedSize} from './video-export.mjs';
import {avcCodecStrings} from './mp4-muxer.mjs';
import {audioEncoderSupported} from './audio-encode.mjs';
const descriptions = [
  {id: 'webm', label: interfaceText("exportCapabilities.webmVideo"), labelKey: "exportCapabilities.webmVideo", extension: 'webm', mimeType: 'video/webm', kind: 'video', quality: 'bitrate'},
  {id: 'mp4', label: interfaceText("exportCapabilities.mp4Video"), labelKey: "exportCapabilities.mp4Video", extension: 'mp4', mimeType: 'video/mp4', kind: 'video', quality: 'video'},
  {id: 'avi', label: interfaceText("exportCapabilities.aviVideo"), labelKey: "exportCapabilities.aviVideo", extension: 'avi', mimeType: 'video/x-msvideo', kind: 'video', quality: 'video'},
  {id: 'wmv', label: interfaceText("exportCapabilities.windowsMediaVideo"), labelKey: "exportCapabilities.windowsMediaVideo", extension: 'wmv', mimeType: 'video/x-ms-wmv', kind: 'video', quality: 'video'},
  {id: 'gif', label: interfaceText("exportCapabilities.animatedGif"), labelKey: "exportCapabilities.animatedGif", extension: 'gif', mimeType: 'image/gif', kind: 'animation', quality: null},
  {id: 'apng', label: interfaceText("exportCapabilities.animatedPng"), labelKey: "exportCapabilities.animatedPng", extension: 'png', mimeType: 'image/apng', kind: 'animation', quality: null},
  {id: 'png-sequence', label: interfaceText("exportCapabilities.pngSequence"), labelKey: "exportCapabilities.pngSequence", extension: 'zip', mimeType: 'application/zip', kind: 'sequence', quality: null},
  {id: 'jpeg-sequence', label: interfaceText("exportCapabilities.jpegSequence"), labelKey: "exportCapabilities.jpegSequence", extension: 'zip', mimeType: 'application/zip', kind: 'sequence', quality: 'jpeg'},
  {id: 'gif-sequence', label: interfaceText("exportCapabilities.gifSequence"), labelKey: "exportCapabilities.gifSequence", extension: 'zip', mimeType: 'application/zip', kind: 'sequence', quality: null},
  {id: 'svg-sequence', label: interfaceText("exportCapabilities.svgSequence"), labelKey: "exportCapabilities.svgSequence", extension: 'zip', mimeType: 'application/zip', kind: 'sequence', quality: null},
];

async function portableVideo(environment, {width, height, fps}) {
  if (!environment.VideoEncoder || !environment.VideoFrame) return {supported: false, reason: interfaceText("exportCapabilities.webcodecsVideoEncodingIsUnavailableInThisBrowser"), reasonKey: "exportCapabilities.webcodecsVideoEncodingIsUnavailableInThisBrowser"};
  for (const codec of messageTuple(['vp8', "vp09.00.51.08"], {1: {key: "exportCapabilities.vp09005108", params: {}}})) {
    try {
      const response = await environment.VideoEncoder.isConfigSupported({codec, width, height, framerate: fps,
        bitrate: videoQualityOptions({width, height, fps, provider: 'WebCodecs'}).bitrate,
        latencyMode: 'quality', hardwareAcceleration: 'prefer-software', alpha: 'discard'});
      if (response.supported) return {supported: true, codec: codec === 'vp8' ? interfaceText("exportCapabilities.vp8") : interfaceText("exportCapabilities.vp9"), provider: 'WebCodecs'};
    } catch { /* Try the next supported WebM encoder. */ }
  }
  return {supported: false, reason: interfaceText("exportCapabilities.noWebmEncoderSupportsTheseExportDimensionsAnd"), reasonKey: "exportCapabilities.noWebmEncoderSupportsTheseExportDimensionsAnd"};
}

/** H.264 in an MP4 from WebCodecs, the browser's MP4 (the desktop encodes MP4 with FFmpeg). */
async function portableMp4(environment, {width, height, fps}) {
  if (!environment.VideoEncoder || !environment.VideoFrame) return {supported: false, reason: interfaceText("exportCapabilities.webcodecsVideoEncodingIsUnavailableInThisBrowser"), reasonKey: "exportCapabilities.webcodecsVideoEncodingIsUnavailableInThisBrowser"};
  const coded = avcCodedSize(width, height);
  for (const codec of avcCodecStrings(coded.width, coded.height, fps)) {
    try {
      const response = await environment.VideoEncoder.isConfigSupported({codec, ...coded, framerate: fps,
        bitrate: videoQualityOptions({width, height, fps, provider: 'WebCodecs'}).bitrate, latencyMode: 'quality', avc: {format: 'avc'}});
      if (response.supported) return {supported: true, codec: "H.264", provider: 'WebCodecs', encodedWidth: coded.width, encodedHeight: coded.height,
        codecs: [{id: 'h264', label: interfaceText("exportCapabilities.h264"), labelKey: "exportCapabilities.h264", supported: true}], defaultCodec: 'h264'};
    } catch { /* Try the next H.264 profile before reporting unavailable support. */ }
  }
  return {supported: false, reason: interfaceText("exportCapabilities.thisBrowserCannotEncodeH264AtThese"), reasonKey: "exportCapabilities.thisBrowserCannotEncodeH264AtThese"};
}

/** Query again after changing export dimensions/rate. Unsupported choices retain a reason for the UI. */
export async function getExportCapabilities({width = 640, height = 480, fps = 24,
  environment = globalThis, desktop = environment.stykDesktop} = {}) {
  const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && Number.isFinite(fps) && fps >= 1 && fps <= 1000;
  if (!valid) throw messageError(new Error(''), "errors.exportCapabilities.chooseValidExportDimensionsAndAFrameRate", {});
  const desktopEncoder = typeof desktop?.getVideoCapabilities === 'function';
  const [webm, mp4, native, [opus, aac]] = await Promise.all([
    portableVideo(environment, {width, height, fps}),
    desktopEncoder ? null : portableMp4(environment, {width, height, fps}),
    desktopEncoder
      ? desktop.getVideoCapabilities({width, height, fps}).catch(error => ({formats: [], reason: error?.message || interfaceText("exportCapabilities.theNativeEncoderCouldNotBeQueried")}))
      : Promise.resolve({formats: [], reason: interfaceText("exportCapabilities.availableInTheDesktopAppWithItsNative"), reasonKey: "exportCapabilities.availableInTheDesktopAppWithItsNative"}),
    // Sound in browser video: Opus for WebM and AAC for MP4, each only where the browser can encode it.
    Promise.all([audioEncoderSupported('opus', environment), audioEncoderSupported('aac', environment)]),
  ]);
  const worker = Boolean(environment.Worker), raster = worker && Boolean(environment.OffscreenCanvas && environment.createImageBitmap);
  const formats = descriptions.map(description => {
    let availability;
    if (description.id === 'webm' && !native.formats?.some(format=>format.id==='webm'&&format.supported)) availability = {...webm,alpha:false,audio:opus,notice:webm.supported?interfaceText("exportCapabilities.browserWebmExportsDoNotPreserveTransparency"):undefined, noticeKey:webm.supported?"exportCapabilities.browserWebmExportsDoNotPreserveTransparency":undefined};
    else if (description.id === 'mp4' && mp4) availability = {...mp4, alpha: false, matte: 'black', audio: aac};
    else if (description.kind === 'video') {
      const capability = native.formats?.find(format => format.id === description.id);
      availability = capability ? {supported: Boolean(capability.supported), reason: capability.reason, reasonKey:capability.reasonKey, reasonParams:capability.reasonParams, codec: capability.codec, provider: 'FFmpeg',
        encodedWidth: capability.encodedWidth, encodedHeight: capability.encodedHeight, notice: capability.notice, noticeKey:capability.noticeKey, noticeParams:capability.noticeParams, alpha:Boolean(capability.alpha), matte:capability.matte,
        defaultCodec: capability.defaultCodec, codecs: capability.codecs?.map(codec => ({...codec}))}
        : {supported: false, reason: native.reason || interfaceText("exportCapabilities.thisNativeVideoEncoderIsUnavailable"), reasonKey:native.reasonKey ?? (!native.reason ? "exportCapabilities.thisNativeVideoEncoderIsUnavailable" : undefined), reasonParams:native.reasonParams};
      if (availability.supported && !raster) availability = {...availability, supported: false, reason: interfaceText("exportCapabilities.nativeVideoExportRequiresWorkerCanvasSupport"), reasonKey: "exportCapabilities.nativeVideoExportRequiresWorkerCanvasSupport"};
      if (availability.supported && width * height > EXPORT_MAX_PIXELS) availability = {...availability, supported: false, reason: interfaceText("exportCapabilities.nativeVideoIsLimitedToMillionPixelsPer", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)}), reasonKey: "exportCapabilities.nativeVideoIsLimitedToMillionPixelsPer", reasonParams: {value: Math.round(EXPORT_MAX_PIXELS / 1e6)}};
    } else if (description.id === 'svg-sequence') availability = {supported: worker, reason: worker ? undefined : interfaceText("exportCapabilities.svgSequenceExportRequiresWorkerSupport"), reasonKey:worker?undefined:"exportCapabilities.svgSequenceExportRequiresWorkerSupport"};
    else if (!raster) availability = {supported: false, reason: interfaceText("exportCapabilities.imageExportRequiresABrowserWithWorkerCanvas"), reasonKey: "exportCapabilities.imageExportRequiresABrowserWithWorkerCanvas"};
    else if (width * height > EXPORT_MAX_PIXELS) availability = {supported: false, reason: interfaceText("exportCapabilities.rasterImageExportsAreLimitedToMillionPixels", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)}), reasonKey: "exportCapabilities.rasterImageExportsAreLimitedToMillionPixels", reasonParams: {value: Math.round(EXPORT_MAX_PIXELS / 1e6)}};
    else if (description.id === 'gif' && fps > 50) availability = {supported: false, reason: interfaceText("exportCapabilities.animatedGifSupports150FpsChooseApng"), reasonKey: "exportCapabilities.animatedGifSupports150FpsChooseApng"};
    else availability = {supported: true, provider: 'Portable worker'};
    return {...description, ...availability};
  });
  return {formats, width, height, fps, nativeVersion: native.version ?? null};
}

export function exportFormat(id) { const entry = descriptions.find(format => format.id === id); return entry ? {...entry} : null; }
