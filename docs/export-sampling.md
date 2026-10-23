# Export sampling

Pixel exports share three native Pivot choices. **Smooth edges** is the default:
vector edges have coverage antialiasing and sprites use nearest-neighbor sampling.
**No smoothing** uses hard shape edges while retaining figure, segment, gradient
and background opacity. **Smooth sprites** renders at twice the requested width
and height, then averages each 2×2 premultiplied block into the requested output
size. It affects the rendered pixels before GIF palette conversion, image
compression or video encoding. Transparent GIF and JPEG/video matte behavior
still belongs to the selected encoder.

The [official image export guide](https://pivotanimator.net/help5-2/separate_images.htm)
and [video export guide](https://pivotanimator.net/help5-2/video.htm) describe these
three choices. Read-only inspection of the supplied executable independently
confirms factor two, its specialized four-pixel average, the default choice,
and the disabled smoothing control for SVG. See
[the static evidence](../artifacts/native-static/export-sampling.json) and its
[reproducible audit](../tests/export-sampling-native-static.py).

SVG exports retain editable vector geometry, portable outlined text and embedded
sprite pixels. Pixel sampling choices do not apply to SVG; the native SVG
workflow also disables this control.

## Rendering API

```js
import {ExportFrameRenderer} from './src/export-frame-renderer.mjs';
const frames = new ExportFrameRenderer({
  width: 600, height: 340,
  smoothing: 'edges', // 'none' or 'sprites'
  baseURL: location.origin,
  signal: controller.signal,
  getRevision: () => editor.revision,
});
try {
  await frames.load(report);
  // Existing image/video encoders await this callback before requesting another.
  const renderFrame = index => frames.renderTick(startTick + index);
  const renderSVGFrame = index => frames.renderSVGTick(startTick + index);
  // For an unsaved current pose, use frames.renderFrame(currentFrame).
} finally {
  frames.dispose();
}
```

The report and current-pose overrides cross to a dedicated worker in bounded
64 KiB chunks with acknowledgement, a 2 ms snapshot budget and no whole-document
JSON pass. The worker evaluates absolute timeline ticks, user-layer visibility,
Scene and Camera channels, embedded media and native geometry. Smooth edges and
Smooth sprites produce transferable image bitmaps; the UI copies each bitmap
onto one reusable output canvas. No smoothing builds self-contained outlined SVG and rasterizes it with the bundled
Rust/WASM resvg engine in the same worker. Chromium's SVG-image rendering hints
did not disable antialiasing in the actual pixel probe, so they are not used as
a substitute. For bitmap quads, clamped edge texels extend beyond the original bounds and
a crisp geometric clip removes boundary coverage antialiasing without filtering
interior texels or thresholding source alpha. The
[native Direct2D audit](../artifacts/native-static/bitmap-smoothing.md) verifies
this separation of aliased geometry and nearest texel sampling. The worker
converts the rasterizer's premultiplied RGBA once for
Canvas ImageData. It never thresholds completed scene alpha, which would destroy
intentional opacity. The unmodified, pinned dependency and source/license links
are in [vendor/resvg](../vendor/resvg/NOTICE.md).

Only one frame request is active. Encoders already await this callback, so they
provide backpressure. A changed document revision or cancellation stops the
session; disposing releases the worker, image resources and output surface.
The optional `onFrame({stage, tick})` callback reports `rendering` before a
request and `rendered` only after a complete frame has been validated. It does
not count encoder completion or saving. The application releases the renderer
as soon as the last source frame is acknowledged, before final container
assembly and saving; single-image exports release it after image encoding.
The output canvas is reused and must be consumed before requesting the next
frame. SVG methods return independent Blobs. A worker's embedded resource cache
has a hard decoded-image allowance of at most 512 MiB. Ordinary output dimensions
remain limited to 16,384 pixels per side and 67 million pixels total (16.7
million in Safari, matching its canvas surface limit); Smooth
sprites additionally limits each output side to 8,192 so its intermediate
sampling coordinates stay within 16,384 pixels. No smoothing additionally bounds its temporary
padded bitmap to 128 MiB and 16,384 pixels per side; an extreme minification
that exceeds this buffer reports an error before encoding. A very dense frame can still take appreciable worker time; this is not a zero-latency guarantee.

Native FFmpeg video uses `renderNativeTick(tick, {preserveAlpha})` instead of
presenting a bitmap on the UI thread. The same worker applies the black matte
in place when alpha is not supported and returns `{blob, width, height}` with a
lossless PNG. `encodeNativeVideo({renderNativeFrame})` validates the result and
streams acknowledged 256 KiB chunks without allocating its legacy PNG worker.
The presentation canvas stays 1×1 until a canvas consumer requests a frame.
Timeout, revision checks, cancellation and final-frame disposal are unchanged;
the conservative pixel allowance has not been increased.

Tiled rendering builds one set of painter-ordered figure groups and conservative
bounds per frame. It skips off-tile painting but advances the native shared
stroke state with the same width-tolerance logic. Unknown image dimensions and
VFX groups retain the full drawing path. Bounds include square-cap coverage,
camera transforms and parallax. A retained decoded image that covers the next
draw avoids fetching its compressed source again; image eviction limits remain
unchanged.

## Export failure containment

Raster output and encoder canvases request software storage. Smooth sprites
renders tiles of at most 512 output pixels per side, then explicitly averages
their premultiplied 2×2 samples. It never allocates a full double-resolution
frame. Small memory allowances reduce tile size without changing output
dimensions or smoothing. Translated Canvas paths may differ slightly in edge
coverage from a full-surface raster; the regression suite bounds that difference.

`exportMemoryPlan` reserves six frame-sized pixel buffers (ten for the additional
crisp WASM/readback work), scratch surfaces, and decoded images. Its allowance is
64 MiB–2 GiB based on the device RAM hint (real system memory on desktop, the
browser's bucketed RAM tier on the web), or 256 MiB when unavailable. Tests can
pass `maxWorkingBytes` to exercise smaller allowances. Legal output dimensions
are never refused for budget reasons: the plan floors at what the frame needs
and reduces raster tile size instead. PNG dimensions are checked before pixel decoding;
other images use available asset metadata and a post-decode check that closes an
oversized bitmap. Images keep their original resolution; they are not silently
downsampled for export. These allowances do not measure free RAM or include the
document, compressed sources, encoder internals, and other applications.

The app permits one raster export at a time and releases speculative playback
pixels before starting. Worker requests time out after two minutes. Recoverable
frame failures first retry the same frame at progressively smaller raster tiles,
then rebuild the worker and canvas once at the smallest tile before the export
fails; a successful tile size is reused for later frames. Cancellation,
exhausted retries, invalid frame dimensions and unrecoverable 2D surface loss
stop the export and release its worker/output pixels. An invalid frame is never knowingly submitted
as a successful frame. Native video jobs are cancelled when their frame worker
fails or stalls. Browser WebM encoding requests a software encoder. Its pending
input window targets 32 MiB of RGBA source pixels, at least one and at most four
frames (one at 4K; a single larger frame may exceed 32 MiB). The window includes
submitted frames awaiting encoded output, since
`encodeQueueSize` alone excludes internally retained frames. Flushing each full
window preserves quality mode and avoids waiting indefinitely for codec
lookahead to fill. Existing output-frame validation rejects dropped frames.
FFmpeg uses one filter thread and two encoding threads; H.264 uses the `fast`
preset with `zerolatency` tuning at every resolution to remove its lookahead
and B-frame queues. Quality targets and manual bitrate controls are unchanged.
Native output chunks become Blob parts rather
than retaining the complete file as JavaScript ArrayBuffers.

Object and tile rasterization share an 8 ms cooperative scheduling target.
The worker yields when that time is consumed, instead of paying a nested timer
delay for every object in every tile. Raster order, brush state, tile dimensions,
sampling and resource allowances are unchanged. One expensive primitive or
decode can still exceed this scheduling target.

See [export experience and verification](export-experience.md) for the panel,
progress semantics, measured 4K throughput and desktop export evidence.

If the editor's WebGPU device is lost, its GPU resources are destroyed and the
scene canvas is replaced with a software compatibility renderer automatically.
The document, playhead, undo history and active software export remain available.
Recovery makes one attempt and leaves Save and a manual retry available if
software canvas creation also fails. Driver resets, total process memory
exhaustion and browser/OS termination remain outside this guarantee.

Regression commands:

```powershell
node --test tests/export-robustness.test.mjs tests/native-video-export.test.mjs tests/vfw-video.test.mjs
node tests/export-memory.browser.mjs
node tests/export-device-isolation.browser.mjs
```

The constructor's optional `token` is forwarded only to resource requests on
`baseURL`'s origin. `stats` reports document transfer bounds, worker frame time
and intermediate dimensions. Worker time does not include image presentation,
encoder work, filesystem writes, GPU completion or display timing.

## Verification

```powershell
node --test tests/export-sampling.test.mjs
python tests/export-sampling-native-static.py
node tests/export-sampling.browser.mjs
node tests/export-sampling-app.browser.mjs
python tests/export-sampling-decode.py
python tests/export-sampling-app-decode.py
```

The browser harness starts a fresh source backend and uses the real worker and
image encoders, with no application WebGPU renderer active. It compares direct
native-geometry rendering, opaque and translucent paths, outlined glyphs,
rotated checkerboard sprites, independent 2× box-filter expectations, revision
cancellation, unsaved-pose overrides and all portable image/sequence formats.
The decoder harness independently opens the resulting files with Pillow.

Verified results: [137 actual worker/encoder checks](../artifacts/export-sampling/report.json),
[38 independent file-decode checks](../artifacts/export-sampling/decoded.json),
six native static checks and two sampling-bound tests. The maximum observed
premultiplied-channel difference from an independently computed 2× box average
was 1.083/255. Hard line, circle, polygon, curve, outline, glyph and square-line pixels had
only alpha 0/255; the translucent line retained 0/127, gradients retained their
alpha ramps, and object opacity was applied once across overlapping segments.
All six portable image/sequence formats were encoded at all three settings;
actual GIF/APNG and ZIP files were independently decoded. Screenshots of hard
and smooth lines, outlined glyphs and nearest/supersampled rotated sprites were
visually inspected. These focused 128×96 cases validate behavior, not large-scene
throughput or native pixel identity across the complete corpus.

A separate 1,000-figure, 512×384 snapshot exercised each mode. All three produced
zero main-thread long tasks; the largest snapshot slice was 0.3 ms and largest
message was 65,228 bytes. Worker rendering was 17.8 ms for Smooth edges, 14.7 ms
for Smooth sprites and 111.9 ms for the first No smoothing frame including lazy
WASM initialization. These are focused export checks, not playback benchmarks.

The [23 actual app assertions](../artifacts/export-sampling-app/report.json)
exercise the PNG, APNG, SVG and PNG-sequence buttons with each relevant setting.
PNG pixels match the independent worker fixture exactly. Current-frame export
includes the unsaved Simple working pose; animation export uses the stored
poses and preserves the dirty working pose. Progress and Cancel appear before
worker loading, and cancellation produces no download. No uncaught UI or CSP
errors were recorded. The [export controls screenshot](../artifacts/export-sampling-app/smoothing-controls.png)
was visually inspected. [Ten independent download checks](../artifacts/export-sampling-app/decoded.json)
confirm APNG frame movement, the working-pose/stored-animation distinction,
numbered stored PNG poses and the downloaded sprite coverage. These checks do
not establish native pixel-edge tie-breaking or GDI+ fallback pixel identity.
Hard bitmap boundaries and continuous-alpha samples are covered by the worker
proof.

The aliased rotated opaque sprite has only alpha 0/255 and no blended interior
texels. Source alpha 0/64/128/255 remains exactly those four values; applying
half opacity yields 0/32/64/127. A minified sprite retains those same source
levels. All three cases match an independent inverse-transform nearest-sample
oracle away from pixel-edge ties, with zero mismatches across over 12,000
samples per case. Existing vector export regression scenarios retain a maximum
channel difference of 1/255 for camera and bitmap/gradient backgrounds.
