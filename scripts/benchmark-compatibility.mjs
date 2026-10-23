/** Browser-callable paired workload. Import every application module through
 * sourcePrefix so a frozen source tree and the candidate run identical inputs.
 * The result contains measurements/counts only, never document or asset data.
 */
const summary = samples => {
  const sorted = samples.toSorted((a, b) => a - b), count = sorted.length;
  return {count, medianMs: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2 : null,
    p95Ms: count ? sorted[Math.max(0, Math.ceil(count * .95) - 1)] : null, samplesMs: samples};
};
const numeric = object => Object.fromEntries(Object.entries(object ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
const statsSnapshot = renderer => ({backend: renderer.stats?.backend, ...numeric(renderer.stats),
  artworkBytes: renderer.artworkBytes ?? 0, artworkEntries: renderer.artwork?.size ?? 0,
  preparedBytes: renderer.preparedBytes ?? 0, ...numeric(renderer.stats?.artworkRefinement)});
const pixelHash = (source, width, height, rect = {x: 0, y: 0, width, height}) => {
  const surface = new OffscreenCanvas(width, height), context = surface.getContext('2d', {willReadFrequently: true});
  try {
    context.drawImage(source, rect.x, rect.y, rect.width, rect.height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let hash = 2166136261;
    for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
    return {width, height, fnv1a: (hash >>> 0).toString(16).padStart(8, '0')};
  } finally { surface.width = surface.height = 1; }
};
const closePacket = packet => {
  const closed = new Set();
  for (const entry of packet?.compatibility ?? []) {
    if (!entry.bitmap || closed.has(entry.bitmap)) continue;
    closed.add(entry.bitmap); entry.bitmap.close();
  }
};
const addCounters = (target, values) => {
  for (const [key, value] of Object.entries(numeric(values))) target[key] = (target[key] ?? 0) + value;
};
const maxCounters = (target, values) => {
  for (const [key, value] of Object.entries(numeric(values))) target[key] = Math.max(target[key] ?? 0, value);
};

export async function benchmarkCompatibility(report, {sourcePrefix = '/src', tick, frameCount = 16, scale = 1, onProgress} = {}) {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('Compatibility benchmarks require a browser with OffscreenCanvas.');
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 256) throw new RangeError('frameCount must be an integer from 1 to 256.');
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('scale must be positive and finite.');
  if (!(report?.canvas_width > 0 && report?.canvas_height > 0)) throw new TypeError('The benchmark requires a document with positive artboard dimensions.');
  const prefix = sourcePrefix.replace(/\/+$/, ''), width = 1280, height = 720;
  const [{createRenderer}, geometryModule, {PlaybackResources}, {ArtworkRegistry}, {PlaybackGeometryCache},
    {PlaybackTweenCache}, {compilePlaybackPacket, playbackLocation}, {frameImageDrawables, backgroundImageAssets}, {previewMemoryPlan}] = await Promise.all([
    import(`${prefix}/renderer.mjs`), import(`${prefix}/pivot/geometry.mjs`), import(`${prefix}/playback-resources.mjs`),
    import(`${prefix}/render-artwork.mjs`), import(`${prefix}/playback-geometry-cache.mjs`), import(`${prefix}/playback-tween-cache.mjs`),
    import(`${prefix}/playback-worker.mjs`), import(`${prefix}/scene-preparation.mjs`), import(`${prefix}/playback-budget.mjs`),
  ]);
  const {timeline, evaluatedFrame, buildGeometry, invalidateEvaluationCaches} = geometryModule;
  const entries = timeline(report), totalTicks = entries.at(-1)?.start + entries.at(-1)?.count;
  if (!(totalTicks > 0)) throw new Error('The benchmark requires at least one playable tick.');
  const startTick = Math.max(0, Math.min(totalTicks - 1, Math.floor(tick ?? (totalTicks - 1) / 2)));
  if (!Number.isFinite(startTick)) throw new RangeError('tick must be finite.');
  const rangeCount = Math.min(frameCount, totalTicks - startTick), plan = previewMemoryPlan();
  const rasterScale = Math.min(width / report.canvas_width, height / report.canvas_height) * scale;
  const view = {scale: rasterScale, x: (width - report.canvas_width * rasterScale) / 2,
    y: (height - report.canvas_height * rasterScale) / 2};
  const canvas = new OffscreenCanvas(width, height);
  let renderer, editorResources, workerResources, artworkRegistry, geometryCache, tweenCache, failed = false;
  const progress = async (phase, detail = {}) => { if (onProgress) await onProgress({phase, ...detail}); };
  try {
    editorResources = new PlaybackResources({preview: true, maxBytes: plan.editorImages, hardMaxBytes: plan.editorImages});
    workerResources = new PlaybackResources({preview: true, maxBytes: plan.workerImages, hardMaxBytes: plan.workerImages,
      maxRasterBytes: plan.workerRasters, maxVectorBytes: plan.workerVectors, maxSoftwareFilterBytes: plan.workerSoftwareFilters,
      maxBackgroundBytes: plan.workerBackgrounds, maxPacketBytes: 128 * 1024 * 1024});
    artworkRegistry = new ArtworkRegistry(); geometryCache = new PlaybackGeometryCache(); tweenCache = new PlaybackTweenCache();
    await progress('editor preparation', {tick: startTick, frameCount: rangeCount});
    const location = playbackLocation(entries, startTick), evaluationStarted = performance.now();
    const frame = evaluatedFrame(report, location.index, location.t, startTick), evaluated = performance.now();
    const geometry = buildGeometry(report, frame), geometrized = performance.now();
    const imageItems = [...frameImageDrawables(geometry), ...backgroundImageAssets(report, frame).map(asset => ({type: 'image', asset}))];
    await editorResources.preload(imageItems, {scale: Math.max(1 / 64, 2 ** Math.ceil(Math.log2(rasterScale))), maxDimension: 4096});
    const preloaded = performance.now();
    renderer = await createRenderer(canvas, {forceCanvas2D: true, asyncArtwork: false, resources: editorResources, onInvalidate() {}});
    renderer.resize(width, height, 1);
    const options = {report, frame, geometry, view, cameraEnabled: false, vfxEnabled: true, clipToCanvas: false,
      artworkRevision: 1, selectedUid: null, showHandles: false, onionFrames: []};
    const renderOnce = extra => {
      const started = performance.now(); renderer.render({...options, ...extra}); return performance.now() - started;
    };
    const coldMs = renderOnce(), coldStats = statsSnapshot(renderer), editorHash = pixelHash(canvas, width, height);
    await progress('editor cold', {elapsedMs: coldMs});
    const measureEditor = async (phase, extra) => {
      const samples = [];
      for (let index = 0; index < frameCount; index++) {
        samples.push(renderOnce(extra(index)));
        if ((index + 1) % 4 === 0 || index + 1 === frameCount) await progress(phase, {completed: index + 1, total: frameCount});
      }
      return {...summary(samples), firstMs: samples[0], settled: summary(samples.slice(1)), stats: statsSnapshot(renderer)};
    };
    const warm = await measureEditor('editor warm', () => ({}));
    const selected = geometry.orderedObjects?.find(group => group?.drawables?.length) ?? [...geometry.objects.values()].find(Boolean);
    let drag = {skipped: true};
    if (selected) drag = await measureEditor('editor translation', index => ({liveEditing: true,
      dragTranslations: new Map([[selected.obj.unique_id, {x: (index + 1) * 2 / rasterScale, y: (index + 1) / rasterScale}]])}));
    // Ending the edit before pan keeps gesture admission and view invalidation
    // identical for both source trees; this reset is outside measured samples.
    renderOnce();
    const pan = await measureEditor('editor pan', index => ({viewChanging: true,
      view: {...view, x: view.x + (index + 1) * 2, y: view.y + index + 1}}));
    const editorCache = numeric(editorResources.cacheSnapshot());
    // End the editor owner's lifetime before serial worker preparation. Its
    // bitmaps cannot warm worker caches or inflate their measured residency.
    renderer.destroy(); renderer.resources?.clear(); renderer = null;
    editorResources.dispose(); editorResources = null;
    canvas.width = canvas.height = 1;
    const compileRange = async phase => {
      const samples = [], packetTimes = [], timings = {}, sharing = {}, clipping = {}, peakWorkerCache = {};
      let lastWorkerCache = {}, hash = null, maxPacketBytes = 0, registryBytes = 0, peakResidentCacheBytes = 0, reducedPackets = 0;
      for (let index = 0; index < rangeCount; index++) {
        let packet;
        try {
          const started = performance.now();
          packet = await compilePlaybackPacket(report, startTick + index, {revision: 1, scale: rasterScale, entries,
            resources: workerResources, artworkRegistry, geometryCache, tweenCache, softwareFrames: true,
            cameraEnabled: true, vfxEnabled: true, sharedArtwork: true, maxPacketBytes: 128 * 1024 * 1024});
          samples.push(performance.now() - started); packetTimes.push(packet.compileMs);
          for (const [key, value] of Object.entries(numeric(packet.timings))) (timings[key] ??= []).push(value);
          addCounters(sharing, packet.sharing); addCounters(clipping, packet.clipping);
          lastWorkerCache = numeric(packet.workerCache); maxCounters(peakWorkerCache, lastWorkerCache);
          maxPacketBytes = Math.max(maxPacketBytes, packet.byteLength);
          registryBytes = Math.max(registryBytes, (artworkRegistry.bytes ?? 0) + (artworkRegistry.definitionBytes ?? 0));
          const residentBytes = Object.entries(lastWorkerCache).reduce((bytes, [key, value]) => bytes + (key.endsWith('Bytes') ? value : 0), 0);
          peakResidentCacheBytes = Math.max(peakResidentCacheBytes, residentBytes);
          reducedPackets += Number(Boolean(packet.previewQuality?.reduced));
          if (index === 0 && packet.compatibility[0]?.bitmap) hash = pixelHash(packet.compatibility[0].bitmap, width, height,
            {x: view.x, y: view.y, width: report.canvas_width * rasterScale, height: report.canvas_height * rasterScale});
        } finally { closePacket(packet); }
        await progress(phase, {completed: index + 1, total: rangeCount, elapsedMs: samples.at(-1)});
      }
      return {...summary(samples), compile: summary(packetTimes),
        timings: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summary(values)])),
        sharing, clipping, workerCache: lastWorkerCache, peakWorkerCache, reducedPackets, pixelHash: hash,
        memory: {maxPacketBytes, registryBytes, peakResidentCacheBytes, registryEntries: artworkRegistry.lru.size}};
    };
    const first = await compileRange('software compile first range');
    const repeated = await compileRange('software compile repeated range');
    return {settings: {sourcePrefix: prefix, width, height, dpr: 1, tick: startTick, frameCount, rangeCount,
      requestedScale: scale, rasterScale, editorCameraEnabled: false, softwareCameraEnabled: true, vfxEnabled: true,
      asyncArtwork: false, compilerExecution: 'serial on the calling browser thread'},
      scene: {totalTicks, objects: geometry.objects.size, drawables: geometry.drawables.length,
        translatedObjectDrawables: selected?.drawables?.length ?? 0, imageDrawables: imageItems.length},
      editor: {preparation: {evaluationMs: evaluated - evaluationStarted, geometryMs: geometrized - evaluated,
        imagePreloadMs: preloaded - geometrized}, cold: {elapsedMs: coldMs, stats: coldStats, pixelHash: editorHash}, warm, drag, pan, cache: editorCache},
      software: {first, repeated}};
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupError;
    for (const release of [() => renderer?.destroy(), () => renderer?.resources?.clear(), () => editorResources?.dispose(),
      () => workerResources?.dispose(), () => artworkRegistry?.clear(), () => geometryCache?.clear(), () => tweenCache?.clear(),
      () => { canvas.width = canvas.height = 1; }, () => invalidateEvaluationCaches?.(report)]) {
      try { release(); } catch (error) { cleanupError ??= error; }
    }
    if (cleanupError && !failed) throw cleanupError;
  }
}
