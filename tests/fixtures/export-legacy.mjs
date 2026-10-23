/**
 * Today's export option code, verbatim from src/app.mjs (main at 5e115000),
 * run against a stand-in dialog so tests/export-request.test.mjs can prove
 * that src/export-request.mjs derives exactly the same values. Each block
 * sits between its BEGIN and END lines; the test checks that the blocks still
 * match app.mjs for as long as app.mjs holds them.
 */
export function legacyExport(env) {
  const {$, editor, state, document, vfwExportControls, videoQualityOptions, materializeSimpleFrameDraftForPivot, audibleClips, audioState,
    encodeVfwVideo, encodeWebM, encodeNativeVideo, defaultGIFDither, normalizeExportSmoothing, EXPORT_MAX_PIXELS} = env;
// BEGIN legacy exportOptions
function exportOptions({ animation = true } = {}) {
  const number = (id, fallback) => ($(id) ? Number($(id).value) : fallback);
  const options = {
    width: number("export-width", editor.report.canvas_width),
    height: number("export-height", editor.report.canvas_height),
    start: number("export-start", 1) - 1,
    end: number("export-end", editor.totalTicks),
    quality: $("export-quality")?.closest('label').hidden ? 0.94 : number("export-quality", 94) / 100,
    dither: $("export-gif-dither")?.checked ?? defaultGIFDither(editor.report),
    smoothing: normalizeExportSmoothing(
      $("export-smoothing")?.value || "edges",
    ),
  };
  if (
    !Number.isInteger(options.width) ||
    !Number.isInteger(options.height) ||
    options.width < 1 ||
    options.height < 1 ||
    options.width > 16384 ||
    options.height > 16384 ||
    options.width * options.height > EXPORT_MAX_PIXELS
  )
    throw new Error(
      `Export size must be whole pixels, up to ${Math.round(EXPORT_MAX_PIXELS / 1e6)} million pixels per frame.`,
    );
  if (
    animation &&
    (!Number.isInteger(options.start) ||
      !Number.isInteger(options.end) ||
      options.start < 0 ||
      options.start >= options.end ||
      options.end > editor.totalTicks)
  )
    throw new Error("Choose a valid export frame range.");
  if (
    !Number.isFinite(options.quality) ||
    options.quality < 0.01 ||
    options.quality > 1
  )
    throw new Error("Quality must be between 1 and 100 percent.");
  return options;
}
// END legacy exportOptions
  function imageArguments(format) {
// BEGIN legacy exportImages
  const options = exportOptions(),
    report =
      state.settings.timelineMode === "simple"
        ? materializeSimpleFrameDraftForPivot(editor.report)
        : editor.report,
    ticks = options.end - options.start,
    fps = report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps,
    extension = format.endsWith("sequence")
      ? "zip"
      : format === "apng"
        ? "png"
        : "gif",
    filename = `${editor.name}${format.endsWith("sequence") ? "-" + format : ""}.${extension}`,
    loop = state.loop;
  if (format === "svg-sequence") options.smoothing = "edges";
// END legacy exportImages
    return {options, report, ticks, fps, extension, filename, loop};
  }
  function videoArguments(format = "webm") {
// BEGIN legacy exportVideo
  const vfw = format === "vfw" ? vfwExportControls.getOptions() : null;
  const codec = $(`export-${format}-codec`)?.value || undefined;
  const nativeWebm =
    format === "webm" &&
    document.querySelector('[data-action="export-video"]')?.dataset.provider ===
      "FFmpeg";
  const options = exportOptions(),
    report =
      state.settings.timelineMode === "simple"
        ? materializeSimpleFrameDraftForPivot(editor.report)
        : editor.report,
    ticks = options.end - options.start,
    fps = report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps,
    extension = format === "vfw" ? "avi" : format,
    filename = `${editor.name}.${extension}`;
  const videoQuality = format === 'vfw' ? {} : videoQualityOptions({
    width: options.width, height: options.height, fps,
    preset: $('export-video-quality')?.value || 'recommended',
    provider: format === 'webm' && !nativeWebm ? 'WebCodecs' : 'FFmpeg',
    mode: $('export-bitrate-mode')?.value || 'auto',
    manualMbps: $('export-video-bitrate')?.value,
    lossless: format === 'avi' && ['ffv1', 'rawvideo'].includes(codec),
  });
  const encode =
    format === "vfw"
      ? encodeVfwVideo
      : format === "webm" && !nativeWebm
        ? encodeWebM
        : encodeNativeVideo;
  const includeAudio = ($('export-audio')?.checked ?? true) && audibleClips(audioState(report)).some(clip => clip.start < options.end / fps && clip.start + clip.duration > options.start / fps);
  if (includeAudio && encode !== encodeNativeVideo) throw new Error('Audio export requires a desktop FFmpeg video format. Choose MP4, WebM, AVI or WMV with FFmpeg, or turn off Include audio for a silent export.');
// END legacy exportVideo
    return {vfw, codec, nativeWebm, options, report, ticks, fps, extension, filename, videoQuality, encode, includeAudio};
  }
  return {exportOptions, imageArguments, videoArguments};
}
