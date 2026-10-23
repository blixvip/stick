# Adaptive preview memory

Editing, playback, thumbnails and library previews use disposable image copies. The document's image URLs, encoded bytes, dimensions and anchor coordinates are unchanged. Preview bitmaps expose their original `naturalWidth`/`naturalHeight`; their actual `width`/`height` describe allocated pixels. GPU background uploads use the actual pixel dimensions.

`PlaybackResources` enables this with `preview: true`. It inspects PNG dimensions before decoding, estimates the needed pixels from the figure's scale and view resolution, deduplicates URLs, distributes its decoded-image allowance across the current draw, and discards obsolete variants before replacing them. When the caller supplies the visible document rect (playback) or a document→output plan (export), each image decodes only the source crop its draw can sample — `srcX/srcY/srcW/srcH` in source pixels — at the needed sampling density. A retained variant serves later draws while it still covers the needed region, and replacements decode the union of old and new coverage while it stays inside the allowance, so pans and zoom-direction changes do not re-decode multi-megabyte sources. The editable canvas uses a serial worker with a coalesced latest request. Zoom can request more detail; stale work cannot overwrite a replacement document. Empty vector-only scenes need no image worker.

For ordinary non-interlaced PNGs, `preview-image.mjs` streams decompression through two scanline buffers and samples into the bounded preview. It supports PNG filters, packed grayscale/palette samples, RGB/RGBA, 16-bit samples and transparency. Embedded colour profiles and interlacing use the browser decoder to preserve their interpretation. Other formats also use the browser decoder. Browser resizing does **not** guarantee bounded transient decoder memory for those fallback cases.

Playback retries a frame at half raster resolution when preparation exceeds its allowance. Path and glyph bitmap captures wait until the complete packet's allocation plan fits; rejected plans release packet-owned images while keeping bounded reusable raster originals. Image-bearing objects still consume their decoded variant immediately, before another object's preload can replace it. Failures discovered during drawing release cached originals before retrying. Ordinary vectors stay as exact vector records throughout pixel-pressure recovery, and vector-only frames report full quality. Per-figure vector rasterization is reserved for cases where the vector records themselves exceed their allocation. Figures remain separate, with their IDs, transforms, visibility and painter order. Cancellation yields use scheduler/MessageChannel tasks, avoiding timer clamping.

Raster detail remains stable under pressure. WebGPU preparation can recover one level after eight consecutive lightweight ticks whose estimated fourfold pixel growth fits one quarter of the packet allowance. Recovered levels retain that stricter admission limit, preserving lookahead headroom when a heavier scene returns. Repeated requests for one tick cannot advance recovery. Software surfaces retain their existing quality policy. A view/document revision resets the policy. This avoids a permanent reduction after a single heavy scene without forcing full-resolution allocation retries on every subsequent frame.

Packet admission uses 80% of the existing CPU cache allowance, leaving headroom for GPU backgrounds. The 64 MiB vector-buffer guard applies to vector records, not to the sum of independently allocated textures. Raster-original retention scales up to 128 MiB, capped at one quarter of the hardware-based frame allowance. The earlier blanket 64 MiB packet cap, 32 MiB raster cache and conversion of all vectors on any pixel-budget retry caused severe full-animation regressions; short runs starting after the pressure frame did not reproduce them.

During playback, up to three ready successors can upload before their display deadline. Upload tasks yield between textures with a 2 ms work target; a single graphics API call is not preemptible. The existing GPU cache admits each complete frame before allocation and protects the displayed frame and requested successors. Partial uploads stay unpublished. Pause, changed packets, view invalidation and device loss cancel obsolete work and release its resources. Foreground preparation can finish a partially uploaded frame if its deadline arrives first. This moves ordinary uploads out of presentation tasks without skipping ticks or changing rasterization. Diagnostics expose warmed frames, slice costs and speculative failures.

The editor estimates unique figure texture residency before building a layout and reduces raster detail if necessary. Its vector geometry, handles, poses and history remain available. An incremental edit that exceeds the texture target falls back to planning the complete layout. The UI shows “Reduced preview quality” when memory pressure reduces detail.

High zoom crops compatibility artwork to the visible sampling region before applying dimension and allocation limits. Editor and worker crops use the original artwork pixel grid, filtering guards and effect halos. Editor coverage has a small margin and quantized steps to reuse pixels during pans and drags; distinct crops share the existing bounded raster owner. Supported opaque native outlines use vectors at high zoom and consume no artwork texture allowance. Allocation planning counts the actual unique crop variants, including shared figures at different placements. A pan or drag that reveals more artwork rechecks active residency and replans before presentation. Zoomed staged layouts cannot publish against a changed viewport. Ordinary rasters, cache allowances, pressure reductions and export sampling retain their established policies.

During editor wheel, touch-pinch and drag zoom, covered artwork retains its completed sampling density while the actual projection follows input. WebGPU holds only an unchanged scene's density; Canvas retains individual artwork and onion rasters, plus the native camera source for unchanged scene effects with native artwork or published version-two drawing cels. Hidden figure images do not block eligible scene reuse. Newly exposed crops, drawing pixels, scene revisions and resource invalidation still update. Continuous wheel input, and notches with smooth zooming off, settle after 100 ms without another event; gliding notches also wait for their glide. Playback and export do not use this policy.

Canvas refines unchanged, covered native paths, text, published drawing cels and supported scene effects after input through one serial worker, retaining visible pixels until each replacement is ready. The existing artwork and onion owners admit these bitmaps; there is no additional pixel cache. Captures reuse the native painter and effect executor. Drawing cels and scene effects retain their full native source domain, including the scene painter's existing internal tiles; ordinary native paths retain it unless a required high-density crop or a guarded tiled capture fits their sampling contract. Preflight counts native scratch, source resources, private software filter pixels and transfer overlap before allocating pixels. Scene refinement has priority over queued component upgrades, while an already running job finishes or cancels through the same serial owner. A cold drawing scene keeps live preview dependencies; covered input can hold it against unchanged published tiles, but settlement captures complete pixels after a preview change even at the same dimensions. Only adoption changes that retained source to publication authority, so later derived preview completions cannot invalidate it. Pixel, revision, publication, owner, loading or pinned-selection changes still require immediate preparation.

Native worker scene capture releases its drawing provider and tint pixels after painting the full padded scene and before whole-scene filtering. Admission charges decoded drawing resources and presenter scratch only during object painting; root and padded scene pixels remain live through filtering and capture transfer. The complete resource owner is disposed before bitmap publication. Private worker tile failures propagate instead of retrying a larger surface outside admission; the admitted GPU-to-software filter fallback remains available. Main painting and export retain their existing resource lifetimes and use no early-release callback.

Large effects still take time to finish, but eligible refinement avoids native scene repainting on the UI thread. Editing and playback keep warm native scratch; worker admission, eviction and disposal release it when its lifetime ends. Background lookahead and thumbnails pause at navigation input, before the first animation frame, and remain paused through refinement. Worker post-await cancellation checks and task checkpoints before raster capture and native camera painting preserve the mirror and requeue the exact suspended tick; cached raster copies also yield once, while vector-only packets keep their existing path. Already executing graphics calls remain nonpreemptible. Background work resumes after the final completion or cancellation. Unsupported resources, insufficient allowance or a failed worker can still use the existing immediate path. See [renderer contracts](renderer.md).

Animation settings offer fixed Normal (100%, the default), Medium (75%), Low (50%) and Draft (25%) playback quality, plus opt-in Automatic. These preferences affect playback backing density and antialiasing only; editing returns to full density on pause and export never reads the setting. Saved values are normalized, and changing a preference during playback uses the existing atomic resize/repaint transaction without adding a preparation phase. Draft is an explicit choice; Automatic stops at 50%. In Automatic, a frame-rate governor complements the memory-pressure path during playback: a sustained presentation deficit lowers the viewport backing resolution (100% → 75% → 50%) and the WebGPU multisample level (4 → 1 → 1), while six seconds at 98% of the target presentation rate restores each level and pausing resets to full quality. Because the reduced backing is reported through `renderer.dpr`, worker packet resolution, compatibility textures and software surfaces all shrink together; the overlay keeps native density. The same badge reports governor reductions. On the Canvas compatibility renderer, playback packets are software packets: the worker rasterizes the complete artboard — camera and camera VFX included — into one transferable bitmap per tick, so the UI thread presents each frame with a single `drawImage` instead of re-rasterizing the scene. Visibility is baked into the surface and checked against a `hiddenKey` signature; editing reuses per-object artwork rasters keyed by `renderSource` identity under the editor-raster allocation.

Supported single glyphs share quantized alpha masks across poses and colors. Playback also shares identical mask content from separate imported definitions before checking the packet budget. Large masks (over 1 MiB) can crop to the camera and scene-effect sampling bounds when this saves at least half their pixels. Crops retain the original sampling density and pixel grid, two filtering guard pixels, and 128-pixel coverage steps for reuse during small camera movements. Small and mostly visible masks keep whole-mask sharing. Canvas curve clipping can round antialiasing at existing edges differently; solid interiors and placement remain covered by pixel comparisons. The editor counts the actual unique mask dimensions at each candidate quality, including when a very large object changes from the complete raster path to a mask as detail is reduced. Worker vector commands have a separate allocation of at most 32 MiB (one eighth of the frame allowance) and 4,096 entries. Worker path-only scratch surfaces up to 262,144 pixels use CPU rasterization; larger surfaces and image compositing retain acceleration. Both scratch contexts release pixels between captures and do not expand the retained raster budget.

`previewMemoryPlan()` centralizes hardware-based retention allocations. CPU/GPU frames, decoded images, raster originals, editable textures and thumbnails have separate allocations within that policy. Software filter surfaces and immutable background edge rasters have explicit editor and per-worker allocations, included in aggregate reservations. Existing shared artwork and measured prefetch eviction remain active. This is a policy for retained caches, **not** a hard cap on total process memory: the document, temporary transition copies, browser decoding internals, graphics-driver allocations, and export output surfaces also consume memory. Required live resources can temporarily exceed retention targets during atomic scene transitions.

Software startup admission estimates the actual artboard dimensions at the requested quality and texture cap, including packet overhead. Measurements from admitted software packets can replace that estimate, including reduced-resolution recovery; vector packet measurements cannot. The controller limits each software preparation lane to the feasible lookahead divided among admitted workers (one to eight requests), while preserving request ownership across lane changes. Stale packets are disposed and acknowledged to their producing worker.

Software painting yields between object groups and signature chunks. Source classification and conservative culling begin only after an exact destination phase repeats. Required image, background and drawing assets are planned together, including each background's parallax projection, so a later preload cannot evict an earlier required variant. The worker owns the frame surface and camera executor. Complex opacity-isolated native artwork can borrow the existing raster owner only after the same immutable source and exact destination phase recur: first use paints directly, the next repeat captures, and later repeats reuse it. Moving or changing artwork avoids fingerprint/capture churn. Opaque groups retain direct native painting because an extra transparent intermediate changes edge rounding. A single large object or software effect remains synchronous.

The plan's aggregate counts every playback worker, including encoded image
sources, decoded drawing tiles and tint targets. Pass the actual worker count
as the second argument when overriding the hardware default. The controller
derives per-worker raster/vector limits from its own frame allowance and sends
them with the snapshot; workers do not substitute a different device-memory
hint. Standalone export resources retain their existing defaults.

`PlaybackCache.stats.workerCaches` holds one latest cache snapshot per worker;
`workerCacheTotals` sums those snapshots, including packets discarded after
prefetch trimming. View invalidation retains these observations when it retains
the worker documents; full invalidation, failure and disposal clear them. These
are last-observed values, not synchronized heap samples. Geometry, document
mirrors, active scratch and driver allocations remain outside these totals.
`documentTransferEstimate` sums the transport's existing structured-clone size
estimates across all workers for a full load. It is neither serialized wire
bytes nor measured resident memory.

Default playback pools also apply `playbackWorkerAdmissionBudget()` to full
document loads. The allowance is one third of the available device-memory hint
(1 GiB when unknown). Each lane reserves its document estimate, retained cache
targets, one maximum packet, temporary native-frame bytes and a geometry reserve
of one quarter of the frame allowance. These are conservative planning values,
not measurements or a hard limit. At least one lane remains; diagnostics expose
when even that lane exceeds the target.

Admission reuses chunk estimates collected during the existing snapshot walk.
Native imports reuse the parser's pose estimate instead of walking the scene
again. Trailing workers may retire only between acknowledged snapshot chunks;
all surviving lanes receive the same complete document before packet requests
are partitioned. Their number stays fixed for sparse patches and view changes.
A replacement full load can restore lanes up to the hardware limit. The primary
planning endpoint stays stable, and late messages/errors from retired endpoints
cannot publish results or fail a replacement. Explicit worker-count/factory
overrides retain their prior behavior unless `maxWorkerBytes` is supplied.

`stats.workerAdmission` reports these reservations separately from observed
cache bytes. The native byte reservation describes the load's temporary peak,
even after that storage is released. Sparse edits do not remeasure document
growth; admission is reconsidered on the next full load. Decoders, live geometry,
GPU drivers and multi-hour editing growth still need independent measurements.


Snapshot and patch yields retain their originating revision across foreground
interaction suspension. Invalidation or worker failure releases those waits;
obsolete streams reject before advancing their document iterator. The active
replacement gets a new wait while interaction continues. This releases cancelled
snapshot data promptly without resuming background preparation during a gesture.

Raster export explicitly uses `preview: false`, but its tile plan still bounds each decode to the source region the output samples: an asset placed mostly off-canvas decodes only its visible crop instead of the full source, so oversized embedded bitmaps no longer exhaust the asset allowance merely by existing. Coverage grows across tiles and frames within the allowance, so moving cameras decode shared regions once. SVG and the existing “No smoothing” path still decode original assets at full resolution. Individual source decodes, the final output canvas and those existing export paths still have browser/format limits; this change does not promise arbitrary-size exports within a fixed amount of RAM.

For cropped glyph masks, independent absolute SVG contours outside the sampling bounds are omitted before rasterization. Line endpoints and complete Bezier control hulls supply conservative bounds, including surrounding contours and holes. Analysis is limited to 256 KiB of path text and 1,024 contours per mask. Relative, arc, smooth or unsupported commands fall back to the complete original path. The path geometry and fill rule are unchanged.

The playback controller acknowledges each transferred packet after admission or disposal and after trimming queued prefetch. The worker prepares its next packet while the controller admits the previous one but posts it only after that acknowledgement, bounding current-revision transferred-but-unadmitted packets to one without leaving the worker idle for the admission round trip. A retention message that no longer lists the prepared tick abandons it, as it removes an unstarted tick from the queue, so trimming wastes at most one packet of work. Revisions cancel obsolete waits; stale packets are closed on arrival and delivery IDs prevent a late acknowledgement from releasing a newer packet. Interaction suspension still gates preparation. This reduces redundant raster work when presentation delays the controller, without adding a second frame cache or changing the lookahead/memory policy.

Image planning reserves the required pixels for every visible image before spending remaining space on larger retained variants or union crops. Growth shares one allowance across the draw; off-screen variants can be evicted under pressure. Covered bitmaps supply their logical dimensions without fetching or rebuilding their encoded source. Replacements release superseded pixel storage before decoding, including export crops, so an obsolete crop cannot cause a false export-memory failure. Resolution checks cover both axes and preserve whole-pixel rounding; extremely thin previews obey the pixel cap and can regain detail when space returns. A draw still requires at least one pixel per visible image.

Embedded base64 images use the runtime's native byte decoder when available, avoiding an intermediate binary string and a JavaScript loop over every byte. Older runtimes keep the established fallback. Encoded bytes and MIME types remain identical.

Dense compatibility figures can skip lines, circles and polygons entirely outside the actual raster bounds. The test uses the painter's exact polyline points, conservative stroke/cap extents and two output-pixel guards. Native brush width advances even for skipped primitives. Figure outlines, movieclip containers and effects retain their established paths; segment effects are not clipped by the primitive test. No visible geometry is simplified. Packet diagnostics count `clipping.culledPrimitives`.

## Verification

Prepared GPU texture reuse is partitioned by format and permitted operations:
bitmap upload targets never become vector isolation targets. Reuse requires the
exact original width and height. Padded allocations changed filtering and vector
coverage rounding, even after correcting their UV rectangles; retaining the
original texture dimensions preserves the established sampling behavior.

`playbackReuseMemoryPlan()` adds explicit retained allocations for free textures
(up to 128 MiB), antialiasing attachments (64 MiB) and raster buffers (16 MiB),
scaled down with the frame-cache allowance. Raster batches submit after 32 passes
or an 8 MiB estimate; a single larger raster remains indivisible. Scratch is
trimmed only after submission or cancellation, never while an unsubmitted encoder
still references it. These allocations appear in `previewMemoryPlan()` and GPU
diagnostics; they remain separate from active-frame bytes.

Artwork keys use a unique worker-realm namespace when a signature cannot be
shared. Embedded payloads compare complete original strings locally and add a
128-bit content hash to transferable identities. Local artwork reuse still
compares the complete signature; the 128-bit hash of the definition, payloads,
evaluated metadata and every signature coordinate (`content-hash.mjs`) only has
to keep different artwork apart across workers and packets. Random collisions
are on the order of 2^-128 per pair, but the hash is not collision-resistant
against crafted input, which a locally authored animation does not contain. It
replaced SHA-256 through WebCrypto, which spent about 20 ms per megabyte on the
worker thread and was the largest single item in dense-scene playback profiles.
Keys are computed synchronously and no longer need a secure context.
Placement and anchor metadata are resnapshotted after edits even when the
embedded bytes stay unchanged.

The governor commits viewport density changes at the beginning of a paint task.
Resizing after presentation would clear the newly drawn image. Density-only
worker invalidation retains the current uploaded pose until replacement packets
arrive; document, visibility and camera changes still reject incompatible poses.
`tests/playback-quality-integrity.desktop.mjs` checks repaint ordering, authored
frame colors, sequential ticks and the absence of synchronous live fallback
through quality reduction and restoration.


- `node tests/raster-clip.browser.mjs`: CPU/GPU pixel equality and native brush state at three scales, removed drawing calls and byte-identical native/fallback embedded-image decoding. Unit image-resource checks cover shared crop budgets, covered-source reuse, thin/odd-sized images, export crop replacement and disposal during decode.
- `node --test tests/playback-delivery.test.mjs`: bounded delivery, retention-before-next-allocation, stale acknowledgement rejection, replacement loads/invalidation, interaction suspension and bitmap disposal.
- `node tests/playback-upload.browser.mjs`: exact staged/synchronous pixels, unchanged displayed pixels between upload slices, cancellation, protected cache eviction and bounded GPU ownership.
- `node tests/playback-glyph-crop.browser.mjs`: contour/hole coverage and unsupported-path fallback, mirrored/rotated masks, signed scales, GPU edge/interior comparisons, duplicate-definition admission, allocation-free rejected glyph plans, partial-packet cancellation, and gradual quality recovery.
- `node scripts/benchmark-project-playback.mjs <project.piv> <label>` records full-animation desktop timing, exact tick order, quality, allocation metrics and source hashes without saving the input. `STYK_BASELINE_SOURCES` can select a captured source snapshot; `STYK_PROBE_DPR` and `STYK_PROBE_MEMORY_GIB` record explicit diagnostic display/cache settings. `STYK_PROBE_FPS` overrides the in-memory frame rate, `STYK_PROBE_QUALITY=full` disables the automatic quality governor (its default lowers the backing resolution mid-run and changes the workload), `STYK_RENDERER=gpu|canvas` seeds the graphics mode, and `STYK_PROBE_WORKER_PROFILE=1` writes a CPU profile of every playback worker (`worker-*.cpuprofile`, each with its wall-clock start in `report.json`) and prints the largest self-time functions. `STYK_PROBE_HIDE=<selector>` skips that subtree's style, layout and paint to isolate interface cost during playback, and `STYK_PROBE_TRACE_EXTRA=<categories>` adds Chromium trace categories to `STYK_PROBE_TRACE=1`.
- `node --test tests/preview-image.test.mjs tests/playback-resources.test.mjs tests/playback-raster-cache.test.mjs tests/playback.test.mjs tests/renderer-initial-scene.test.mjs tests/renderer-raster-cache.test.mjs tests/prepared-frames.test.mjs tests/editable-scene-preparation.test.mjs`
- `node tests/adaptive-preview.browser.mjs`: generated 8192 × 4096 source (128 MiB decoded), zoom detail, simultaneous assets, cache reuse, budget recovery, real worker playback, unchanged original document, sequential/tiled export pixel comparisons, editing and undo, and editable texture budgeting with visible handles and quality status. Results and screenshots go to `artifacts/adaptive-preview/`.
- `node --test tests/playback-software.test.mjs`: software packet contract, hidden/layer visibility baking, camera-baked mode semantics, cache format switching and bitmap release.
- `node tests/playback-software.browser.mjs`: real Chrome composited-surface playback through the compatibility renderer — presentation pixels, stale visibility/camera/drag rejection and surface eviction. Results go to `artifacts/playback-software/`.
- Existing playback, initial-scene, artwork sharing and export-sampling browser suites verify unaffected rendering, cancellation and export sampling.

The original adaptive-preview investigation recorded nine animation/keyframing/materialization fixture failures, reproduced from its Git HEAD. Subsequent fixture corrections and the current full-suite result are recorded in the optimization report above.
