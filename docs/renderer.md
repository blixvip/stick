# Rendering architecture

Canvas zoom settlement streams evaluated covered artwork through the existing
`DrawingWorker` request and acknowledged snapshot transport. One serial
`CanvasRasterRefinement` queue holds immutable input references and reserves
working pixels from the existing artwork owner's spare allowance. The renderer
keeps the previous covered raster until a transferable bitmap replaces it;
`whenArtworkReady()` resolves after installation, and `onInvalidate` requests
presentation. The app keeps editing available and pauses background speculation
and thumbnails while this work is pending.

Native paths, text and published version-two drawing cels use the same painter
and effects. Drawing eligibility reads the live owner's revision and publication
stamp; pinned selections and unpublished strokes retain immediate painting.
The worker prepares sparse cels through the existing drawing provider, counts
decoded tiles, mipmaps, encoded overlap and presenter scratch before allocation,
and disposes that provider before transferring the completed bitmap.
Single filtered cels retain their native destination dimensions and exact
device transform, rather than rounding their effect scale to an artwork bucket.
Their existing artwork entry reprojects covered pixels during input and copies
the settled bitmap on the device pixel grid. Live edits and unsupported
projections retain direct painting; publication stamps invalidate stale pixels.
Drawing captures use the existing image-surface policy, preserving native
compositing over other translucent layers and avoiding accelerated-source
readback. Path-only captures keep their software surface policy. The worker
borrows the prepared drawing owner's existing surface pool and releases it
before publication. Exact viewport drawing captures require the full native
domain; they reject insufficient allowance before allocating pixels.
Captures first admit the complete native canvas domain and effect halos. When
effect scratch cannot fit, bounded tiles partition
the original pixel grid with integer translations and sampling guards; the
complete output, snapshot, painter scratch, filter buffers and software regions
are admitted before large allocations. Effect admission counts the native
executor's retained slots. A capture owns private effect executors and releases
graphics storage before software fallback, so both executor lifetimes do not
overlap. Remaining private worker tile failures propagate instead of retrying
with a larger, unadmitted surface; the admitted GPU-to-software filter fallback
remains available. Each capture releases pixel storage before replying. Its private
graphics context and bounded shader programs stay warm until the worker is
disposed; they retain no scene or captured pixels. A quiet period of 30 s
releases the working pixels of both effect executors, never their compiled
programs or pipelines: compiling those again stalls the thread that presents
frames at the next playback or edit. Path-only captures preserve
the complete canvas domain, since subdividing native strokes can change their
antialiasing. Capture admission also limits repeated painting to 64 tiles. The existing
artwork/onion maps own and close adopted bitmaps; no second pixel cache exists.
View, scene, revision, playback, editing, resize, context loss and disposal reject
obsolete results. Immediate painting can release and restart a running capture
before allocating replacement pixels. A transient worker error retries once;
exhausted or permanent failure uses the existing fresh-paint path rather than
leaving the unchanged view blurry indefinitely. Media, depth surfaces and
unpublished drawing resources retain their immediate resource-aware paths.
Cold artwork from previous frames yields its existing LRU allowance before
background capture; visible owners stay protected. `asyncArtwork:false`
selects the synchronous reference path for independent pixel verification.
Starting playback and successful prepared-frame presentation cancel editing
refinement; borrowing a packet for the camera monitor preserves it. The app
reconciles background suspension after rendering in both directions, since
cancelling the last capture can leave an otherwise idle view with no next paint.

Editing paints keep the capture worker loaded: the first paint, and the first
paint after a cancellation closed a running worker, start a replacement that
loads its capture modules without a scene, scratch surface or reservation.
Queued jobs wait for that load because the worker admits one request at a
time. Playback never starts a worker, and injected workers without a lifetime
signal are not warmed. A cold module graph otherwise delays the first refined
pixels by far more than their capture.

The Compatibility camera image clears and replaces its projected artboard.
When that projection covers the whole viewport, object artwork and generator
draws beneath it are not presented, so the renderer neither paints nor refines
them and only the scene capture is requested; their cached rasters age
normally. A view showing space around the camera image, a backed-off camera
preview, or a camera failure in the same paint uses the ordinary object painter.

Unchanged camera effects with native artwork and published version-two drawing
cels retain their completed scene during navigation and refine its settled
density through the same queue. Hidden figure images do not block this path. The existing
artwork map owns that source; `CameraVfx` borrows its canvas or bitmap and native
dimensions. Missing or disposed ownership forces fresh native painting. Cold
paints, editing and playback keep their existing warm scratch allocations;
accepted background work releases those pixels before reserving worker scratch.
Eviction, replacement and disposal end the old source lifetime.

The GPU Camera image for scene effects never leaves the device. `CameraGpuSource` renders the retained or prepared artwork into its own texture, over the scene background, and the effect executor filters that texture. A background color clears the pass; solid and gradient backgrounds draw as the renderer's own shape records over the camera view widened by the effect sampling margin (`backgroundViewport`), so a moving camera costs nothing; painted and image backgrounds use the native Canvas painter on a software surface that is uploaded only when the background, camera or size changes (`stats.backgroundUploads`). Previously the artwork was drawn from a WebGPU canvas into a 2D canvas for the background and copied back for filtering, which waited on the graphics process twice for every presented frame with scene effects (20-55 ms on Linux/Vulkan). The `sceneVfxCameraParity` fixture compares the device image with the Compatibility renderer's for color, gradient, mixed, radial and painted backgrounds under still and transformed cameras.

GPU camera sources also track the settled layout's raster density when that
layout contains compatibility textures or native outline artwork. Reaching the
camera source size cap does not make later layout textures equivalent: the
source is repainted once when their settled density changes. Navigation keeps
the captured revision, and vector-only layouts and prepared playback do not
read this dependency.

A cold drawing scene retains live presentation dependencies, since its derived
preview may still be incomplete. Covered navigation can compare unchanged
published tiles while holding those pixels. Settlement requests a complete
published capture after a live-preview change even at unchanged dimensions,
and a settled view that was never navigated does the same when a derived
preview completes, holding the displayed scene instead of repainting it;
only worker adoption makes publication the retained source authority. Derived
preview completions then leave that source valid. Changed pixels, publication,
revision, ownership, loading state or pinned selections invalidate it immediately.

Camera captures transfer evaluated visible primitives and a small resolved
camera/background/effect recipe, then call the existing `drawExportScene` on its
original accelerated canvas domain, including existing internal scene tiles.
Admission traces native source clamps and
the maximum live painting, filtering and transfer phases. One-shot captures
release completed object scratch before final scene filtering. After the full
native padded scene is painted, the worker also ends its drawing-provider and
tint lifetimes; decoded drawing pixels and presenter scratch are charged only
to the object-paint phase. Root and padded scene pixels remain live through
filtering and capture transfer. The complete resource owner is still disposed
before bitmap publication. Captures release
temporary software source contexts after readback. Software filtering owns
private capture pixels within the same phase allowance and releases them before
publication. Ordinary export and main painting use no early-release callback and
retain their original resource and scratch policies. The scene job precedes queued
component upgrades without preempting running work. Active generators, visible
unsupported images, depth, native diamond brushes and nonzero parallax keep
native preparation.
Insufficient allowance rejects a full-domain scene before pixel allocation.


Onion opacity applies once to each completed ghost frame, after its figures have
composited at their own intrinsic opacity. Each frame is faded separately; tint,
before/after ordering, hidden figures, parallax and Show on top still apply.
Both backends retain the completed pixels of each consecutive run of ghosts as
one viewport layer. Runs never cross live artwork, preserving anchored painter
order. An ordinary drag composites this layer once without repainting any ghost.
Changing the view, opacity, visibility, parallax, geometry, or drawing resources
invalidates its pixels; changing only the live pose does not.

`OnionSurfaceCache` owns admission and surface lifetimes for both backends. Its
byte and entry limits are applied before drawing. Excess layers use one reusable
scratch surface instead of evicting layers used earlier in the same presentation.
Scrubbing recycles obsolete surfaces, dropping their old validity metadata. The
cache retains only the active range, not a history of full viewport images.
`previewMemoryPlan().editorOnions` caps retained onion pixels at 64 MiB and scales
down on smaller memory tiers. Canvas splits that allowance between completed
layers and object rasters, preventing large viewport images from flushing small
figure rasters. WebGPU's existing object artwork owners keep their own budgets.

Compatibility onion rasters must fit `editorOnions / 2` together: each
eviction re-rasterizes a ghost with its effects the next time its layer is
recomposited, and evictions cascaded on every zoom step. A ghost whose raster
at the requested density exceeds its share of that allowance (shared among the
frame's onion groups, `gestureProxyPixels(true)`) is painted at the highest
density that fits by `canvasArtworkPlanWithin()`, still cropped to the view;
its entry keeps the requested `resolution`, so it is not refined back over the
allowance. Navigation stand-ins for both figures and ghosts use the same shares.
Faded ghosts can therefore be softer than live artwork at high zoom. Image
decodes call the Canvas renderer's `invalidateImages(changedURLs)`, which
releases only artwork that paints a changed image, and a completed drawing-cel
decode no longer clears every raster: each raster records the cels it painted
and repaints when one of them changes. Both previously re-rasterized every
figure and ghost whenever zooming crossed an image decode scale or a nearby cel
finished decoding. `zoomCanvasOnionBudget` in
`tests/renderer-zoom-gesture-fixture.mjs` covers these rules.

WebGPU paints each ghost into one reusable frame texture and MSAA surface, then
blends that frame at its opacity into the completed layer. The main pass retains
its samples across composites; GPU timing spans the first and last pass. There
is no pixel readback. Canvas uses the same frame-then-layer sequence. Temporary
frame, MSAA, and overflow surfaces are additional viewport-sized working memory,
independent of ghost count. Resize replaces them; MSAA changes rebuild the GPU
pipelines. Disabling onions, replacing the document, and destroying or recovering
the renderer release the previous surfaces.

`onionRenderedFrames` and `onionFrameHits` distinguish rebuilding from reuse;
`onionCacheBytes` counts retained onion pixels and `onionCompositeBytes` counts
completed layers plus compositor scratch (excluding Canvas object rasters).
Pixel and lifetime regressions are in `tests/onion-composite-cache.browser.mjs`
and `tests/onion-scene-opacity.browser.mjs`. The paired renderer benchmark is
`scripts/benchmark-onion-interaction.mjs`.

Live spatial poses merge unchanged primitives in their retained painter order with newly sorted changed primitives. Equal-depth ties use native polygon/segment insertion order, so turning back through a tie does not inherit the previous pose's ordering. Imported compound shapes and non-finite orders use the general builder. This derived order belongs to the new geometry and retains no previous scene. Geometry, cancellation and collection tests compare the incremental result with full evaluation.

The shared depth compositor packs triangle fans into a reusable upload buffer. CPU scratch is capped at 8 MiB per live Canvas context; larger batches use temporary storage, and smaller batches shrink oversized CPU/GPU capacity. GPU storage is reused between uploads, deleted on disposal, and replaced with software painting after context loss. No per-face pose cache is introduced. The same compositor serves editing, worker playback preparation and export; pixel tests cover depth intersections, clipped quads, tile boundaries, buffer growth/shrink, disposal and context loss.

Canvas painting computes effect-content fingerprints lazily, only when an oversized software-filtered region uses the tile cache. Ordinary drawing and GPU filtering do not serialize poses. Fingerprints include each shared object, paint and style record once, so dense figures do not repeat whole joint arrays per face. Content changes still invalidate the software tile cache.

Figure meshes (docs/SPATIAL-MESHES.md) are one `mesh` drawable per painter layer, referencing typed positions, depth, visible triangles and palette indices evaluated once per pose. WebGPU draws a mesh-only object into its object texture with `src/renderer-mesh-raster.mjs`: vertex pulling from storage buffers, a 24-bit depth attachment and the renderer's MSAA count, with the depth mapping and tie order of the shared compositor. Objects with other primitives or effects, Canvas rendering and exports use the shared compositor. The artwork signature of a mesh is its root-relative pose input rather than its faces.

Published geometry creates its lazy drawable view outside the evaluator's generator scope. Retaining the generator context also retains its incremental input and every preceding scene, even when only an invalidation token appears in the returned fields. The collection regression verifies that superseded scenes and their figure geometry can be collected while the latest lazy view remains usable.

Native projected fills can supply depth-guide joint references to offset their painter order during shared geometry evaluation. Canvas unions consecutive opaque triangles of the same color and winding into one fill, preventing antialias seams along shared edges without crossing intervening painter layers. Transparent and outlined fills retain their existing compositing. The projected-surface browser check verifies coverage and layer ordering.

If the desktop editor process terminates, Electron main offers Reopen editor, Keep window open, or Close window. Reopening uses the normal recovery message (Restore unsaved work, in the stage header); closing a dead editor preserves the recovery file and never requests a save from the terminated process. One local `last-renderer-crash.json` records version, time, reason and exit code without document contents. `node scripts/smoke-renderer-recovery.mjs` forces a failure only in an isolated test instance and checks recovery and close behavior.

GPU startup shares an eight-second budget across adapter discovery, device creation and shader/pipeline compilation. Failed or timed-out initialization selects Canvas compatibility rendering, releases late devices, and does not retry automatically at startup. The scene canvas acquires its WebGPU context only after compilation succeeds; if final context configuration fails, startup replaces that surface before falling back. This bounds asynchronous waits, but cannot interrupt a blocked OS graphics driver. `tests/startup-fallback.desktop.mjs` exercises startup failures and pending GPU operations in Electron. The optional Documents library initializes without delaying the desktop window.

Artwork bounds exclude zero-width construction lines that have no figure or branch outline. Their joints and topology remain editable. The shared bounds calculation feeds editor raster allocation, playback preparation, export culling and effect surfaces, so distant invisible endpoints cannot lower the visible figure's resolution or consume its texture budget. Visible strokes, filled shapes, media and outlines retain conservative bounds. `tests/renderer-construction-bounds.test.mjs` and its browser counterpart cover topology preservation and matching editor, Canvas and prepared-playback pixels.

Node selection uses a lighter red tint within the selected figure, including selected branch descendants. Canvas and WebGPU share the handle colors from `src/canvas-interactions.mjs`; static and joined nodes retain distinct tints. Selection changes invalidate handle caches without changing artwork.

Starting playback fits the scene to the viewport once, before preparing playback frames at the fitted resolution. Zoom and pan remain available during playback; pausing preserves the current view.

Manual workspace zoom and Fit Selection support 0.1%–10,000%. These finite navigation bounds are independent of the renderer's texture and cache limits; Fit Canvas retains its automatic framing range.

The editor draws the actual camera boundary as screen-sized red dots with a light contrast halo in the final Canvas overlay pass, above artwork and tool feedback, including playback and preview. This boundary stays visible regardless of camera selection, visibility, or interaction settings; camera handles and composition guides remain selection-dependent. The overlay is not part of exported artwork.

During prepared playback, overlays use the exact displayed packet's camera/scene metadata instead of evaluating its figures again on the UI thread. Inactive VFX gizmos do not request geometry. A transient GPU device loss schedules accelerated reconnection on a new scene canvas with backoff (1 s, then 5 s); initialization failure or exhausting those two accelerated attempts selects the software fallback immediately. A renderer surviving 30 s without another loss restores the retry budget, and the manual reconnect action or a Graphics mode change always gets a fresh accelerated attempt. Document/history and overlay input handlers survive both paths. `tests/renderer-recovery.browser.mjs` covers reconnect pixels, bounded retries, both initialization failure stages, undo/redo, and zero extra frame evaluations during prepared playback.

`src/renderer.mjs` creates a WebGPU viewport with a premultiplied transparent canvas and multisample antialiasing. The MSAA level defaults to four samples and adapts at runtime through `setMsaa()`; the vector pipeline, handle pipeline, canvas antialias texture, camera monitor surface, VFX camera source and VFX compositor all derive their sample counts from the same `msaaCount`, so one rebuild keeps every attachment consistent. Adapters reporting `isFallbackAdapter` or a software signature (SwiftShader, llvmpipe, lavapipe, WARP, Basic Render) route to the Canvas compatibility renderer, which is faster than CPU-emulated WebGPU for this workload; the Graphics mode setting can force either backend explicitly. The imported Pivot geometry is compiled into a retained storage buffer of 96-byte shape records. A WGSL shader renders signed-distance capsules, square-ended lines, discs and rings; Earcut triangulates polygon fills. Gradient colors interpolate in the shader. Scene backgrounds and anchored asset images are composited in the decoder's painter order.

Preview image responses carry an identity for the immutable decoded worker
bitmap. `PreviewImages` preserves its consumer bitmap and closes a duplicate
transfer only when that worker identity, dimensions, logical dimensions and crop
metadata all match. Weak identity tables are scoped to one worker lifetime;
restarting a decoder cannot validate an earlier worker's bitmap. A wholly
unchanged batch leaves the renderer's resource generation and GPU caches intact.
New or replaced pixels, unknown identities and evictions retain invalidation.
This does not skip decoding decisions or remove the worker's transfer copies.

One transform record per figure contains its translation, opacity and visibility. Contiguous vector figures share one draw call. Camera pan, zoom, layer visibility and `dragTranslations` update only small uniform/transform buffers. Geometry edits reuse unchanged figure geometry and GPU draw ranges. A capacity change reallocates the packed layout; ordinary joint edits update only the affected figure's range.

Incremental `buildGeometry()` results carry ordered object groups, changed slots and a previous-generation token. Tokens do not retain previous scenes. The renderer updates only those slots when painter order, background and raster resolution are unchanged; it retains every untouched entry, texture and vector range. The flattened compatibility `drawables` list is lazy, so a joint edit no longer regroups every segment in the scene. Primitive compilation writes typed records directly and computes each segment brush once, including when a polygon produces many triangles. Layout changes safely use full preparation.

Native evaluated segments carry their drawable `type` and are shared with the ordered painter list, avoiding a second record per visible segment. These evaluated records are immutable to consumers; editor commands still modify native poses and publish replacement geometry. Worker compilation traverses ordered objects directly instead of materializing the flattened scene. Texture bounds are weakly cached by immutable geometry, drawable-array identity and resource generation, and shared with staged editable preparation.

One straight stroke or single-pass circle can apply figure opacity directly in its vector record. Bent strokes, overlapping primitives and white-backed rings retain isolation. Ordinary translucent groups cache their opaque artwork and apply their final alpha on the textured quad, including Canvas compatibility previews. Opacity-only seeks rebind drawing metadata while retaining exact joint/point arrays and a bounded canonical artwork source. Nested movieclips and VFX keep their established compositing path. The same existing CPU/GPU cache owners bound the retained textures; fades do not mutate published packets, native poses or earlier geometry.

`playback-window.mjs` plans lookahead within the selected half-open range. Non-looping playback stops preparation at its end; looping playback wraps within that range. Reverse seek neighbors remain bounded. This prevents speculative compilation of the opening from competing with presentation of the ending.

Canvas-painted artwork whose only effects are its outermost stack (a figure's own stack, or an opaque movieclip owner's, with no effects on inner clips, nodes or child objects) is painted without that stack and filtered on the WebGPU device by `filterArtworkVfx()` (`renderer-vfx-vector.mjs`), the executor vector artwork already uses. Filtering inside the Canvas painter moved the pixels to the effect executor, back to the Canvas, and then up to the renderer's texture; each transfer between Canvas and WebGPU waits for the graphics process and costs about 6 ms per megapixel on Linux/Vulkan. Path-only artwork paints on the software scratch surface and uploads as a detached `ImageBitmap` (under 1 ms per megapixel); artwork with images keeps the accelerated surface. Translucent figures and owners, nested effects and surfaces beyond the effect budget keep the complete Canvas painter, which composites them in its own order. `stats.artworkVfxObjects` counts device-filtered artwork, and `renderer.disableVectorVfx` selects the Canvas painter for comparison. `tests/renderer-artwork-vfx-fixture.mjs` compares both routes in the real renderer (mean channel difference at most 0.30/255, confined to native stroke edges that the software and accelerated surfaces antialias differently); `node tests/renderer-artwork-vfx.desktop.mjs` runs it in the desktop app.

`withVfx` asks the WebGL executor for a region of its canvas: with `VfxGPU.run(..., {region: true})` the drawing buffer only grows, in 256-pixel steps, and the caller copies the result's rectangle (the buffer's lower-left in image rows). Sizing the drawing buffer to every filtered figure waited on the graphics process twice per figure, 37% of worker time in Compatibility playback of an effect-heavy scene. The copied pixels are the same premultiplied result as before, so worker captures and main-thread painting stay identical; a straight-alpha `readPixels` route was tried and differed by up to 2/255. The grown buffer is released with the executor's other working pixels after a quiet period. `tests/vfx-gpu-region.test.mjs` covers both routes. A playback worker that serves a software presenter also compiles the executor's programs when a document with effects loads, one per task (`prewarmVfxGPU()`): each program compiles on the thread that presents frames and reports its status synchronously, so three workers compiling the same programs at the first effect frame stalled the start of playback by 60-220 ms.

`initVfxDevice()` asks the WebGPU effect executor to compile every operation's pipeline asynchronously shortly after startup (`VfxWebGPU.prewarm()`). A pipeline created on demand compiles on the thread that executes the device's commands, which stalled presentation by 30-90 ms the first time each effect type appeared in playback. A pipeline needed before its warm copy arrives is still created on demand.

Compatibility features reuse the existing Pivot Canvas implementation at the **object** boundary: isolated object opacity, global outlines, text glyph paths, embedded sprite segments, translucent bent strokes, and self-crossing or very dense polygon fills. These objects are rasterized into bounded, cached textures, then composited by WebGPU in the same layer order. The complete scene is never rasterized into one texture. At high zoom or when complete artwork exceeds the texture limit, `raster-view.mjs` crops to the visible region before limiting density. Canvas keeps its 4,096-pixel dimension bound; WebGPU uses at most 8,192 pixels and the device limit. Finite source images, effect surfaces and the existing allocation policy can still limit detail. Missing WebGPU adapters select an explicitly labeled Canvas 2D fallback.

The optional editor `viewChanging` render hint separates artwork sampling density from the current camera. An unchanged WebGPU layout retains its completed density during navigation; drawing tile presentation still uses the actual viewport. A held crop that no longer covers the view is never repainted at its held density: that region grows with every zoom-out step, and at a close-up density each step cost several large rasters. When the view's density is below the held density (zooming out), both backends instead present the whole artwork from the sharpest complete raster the existing cache still retains (`EditorRasterCache.sharpest()`), or paint one complete proxy at `gestureProxyResolution()` (`raster-view.mjs`): at most the view's own density, 8x, the texture limit and four megapixels. A proxy is complete, so further zooming out needs no painting. Panning or zooming in instead paints `gestureStandIn()`: a crop of the view widened by half its size on every side, at the highest density within `GESTURE_STAND_IN_PIXELS` (one megapixel; Canvas also within its `gestureProxyPixels()` share), so one bounded paint covers half a view of travel; whole artwork at a close-up density would be far softer. WebGPU first reuses a retained raster that covers the view if it is at least as sharp, such as the settled crop when a pan returns. Canvas crops a stand-in only where its settled raster is also a crop (above 8x or the texture limit): a full-density crop of whole-raster artwork would stay in place with different native edges. The settled paint always replaces a stand-in below the requested density, including when the gesture returns to the density it started from. Artwork can therefore look soft while a zoom-out from a close-up or a pan is in motion. The GPU Camera image for scene effects holds its painted density the same way while an unchanged scene is navigated: below its size cap it otherwise repainted, and moved through Canvas, on every zoom step. A scene/resource change or a capacity/allocation bailout uses normal preparation immediately. `lastRasterResolution` records only density actually prepared, so clearing the hint restores exact requested detail. Canvas chooses each existing artwork/onion raster's completed density and invalidates a held onion composite on settlement even when its final matrix is unchanged. The existing cache owners and synchronous publication retain their lifetimes and budgets. The app owns wheel/pinch/drag activity, including pans by drag, hand tool and wheel, which end once the view has been still for 100 ms, and requests the settled paint; playback and export retain their established sampling. Regression coverage is in `tests/renderer-zoom-gesture-fixture.mjs`.

Single solid text glyphs use reusable alpha masks from `renderer-glyphs.mjs`. An affine WebGPU quad applies the native placement, signed scale, reverse/mirror flags, tint and opacity without rerasterizing a moved or rotated figure. Mask keys contain exact path content, bounds and quantized pixel dimensions; no document name, figure ID or animation tick participates. Multi-glyph figures, gradients, outlines, movieclip compositing and VFX retain the complete object painter. Editor density beyond 8x uses the cropped object painter instead of allocating complete glyph masks; masks that cannot meet ordinary density within 4,096 pixels also use that painter. Mask resources belong to the existing bounded editor, worker and prepared-frame caches; memory planning deduplicates the actual dimensions at each candidate quality level.

Playback caches immutable vector commands by geometry identity, retaining at most 32 MiB and 4,096 entries, further limited by the hardware plan. A changed painter slot patches a private copy of the transform indices; it never mutates an already published packet. Geometry keys are weak and the LRU owns only arrays, avoiding retention of obsolete scene graphs. Document/resource disposal clears the cache.

Playback shares identical glyph content across definitions and can crop large masks to the camera's sampling bounds on their original pixel grid. Independent off-crop contours are culled using conservative control-point bounds; unsupported paths use the original painter. Allocation planning precedes bitmap captures. Up to three ready successors can upload into the existing GPU cache in cancellable slices, protecting the displayed frame and publishing only complete frames. See [adaptive preview](ADAPTIVE-PREVIEW.md) for admission, cancellation and quality-recovery rules.

Playback workers ship artwork with separable figure effects unfiltered: when `PlaybackCache` runs with `gpuIsolation`, the packet entry carries the unfiltered bitmap and `vfx: {stack, scale, domain}`, and `PreparedFrameCache` filters it on the device through `filterArtworkVfx()` when the frame is uploaded or warmed. A worker that filtered it used its own WebGL context: it compiled shaders on first use (150-210 ms on the thread that executes every graphics command, once per worker, in the middle of playback) and waited for the graphics process several times per figure. A cropped source keeps the effect's sampling padding beyond the artboard, since the device filters only the pixels it receives. Inseparable effects (nested, or under a translucent owner) and non-WebGPU presenters keep filtering in the worker. Playback workers also paint image artwork and the drawing-cel scratch on software surfaces (`PlaybackResources({softwareImages: true})`): an accelerated packet bitmap is read back on the UI thread when WebGPU copies it, 6 ms per megapixel plus the wait, while a bitmap in memory uploads in under 1 ms per megapixel. Thumbnail, library and export owners keep their accelerated image surfaces. `tests/playback-artwork-vfx.test.mjs` covers the packet contract and the `preparedArtworkVfxParity` fixture compares both routes through real prepared playback, including artwork the camera crops.

Preview workers rasterize path-only scratch surfaces of any size on a software-oriented Canvas context; image compositing retains acceleration outside playback packets. Accelerated worker canvases all flush through the single GPU-service thread that also presents frames, and on integrated GPUs large path flushes stalled playback for 100+ ms; software surfaces rasterize in parallel on the worker threads. Routing depends only on content, so an object keeps one antialiasing route as it grows or shrinks. On the 13 representative `svr_uriel.piv` ticks this differs from accelerated rasters only on antialiased edges (mean ≤ 0.008/255, no interior mismatches). Two reusable scratch contexts own no retained packet pixels, release storage between captures, and are disposed with the worker resources. Export keeps its existing accelerated/original-resolution policy.

Foreground editing, navigation, scrubbing and editable-frame preparation suspend queued playback compilation and its request timeouts; work resumes afterward. Navigation input pauses background work before its first animation frame. Worker preparation checks cancellation after image preloads and bitmap copies, and yields through scheduler/MessageChannel tasks before its first raster capture and native camera pass. Cached raster copies also take that checkpoint; vector-only packets keep their existing path. Superseded revisions cancel and close partial packets while interaction suspension preserves the mirror and requeues the exact tick. A graphics call already executing cannot be interrupted. Playback starts with about 100 ms of nearby packets (2–12 ticks), restricted to the active range and the measured cache capacity, so a one-frame cache cannot deadlock waiting for two frames. No ticks are skipped to improve measured FPS.

The Canvas 2D fallback requests a software-oriented surface (`willReadFrequently: true`) so it does not depend on the same accelerated drawing path that failed WebGPU initialization. Context loss suspends drawing and clears the onion, live-artwork and prepared-surface caches; restoration repaints the latest scene and invalidates the editor even when idle. Destroying the renderer removes these listeners. `tests/compatibility-canvas.browser.mjs` checks visible pixels after import, saved-file reopening, seeking, playback, pause, and simulated context restoration, with both missing WebGPU and a rejected `requestDevice()`.

During a gesture (`liveEditing`), the fallback repaints only what changes. Figures whose geometry object differs from the previous frame, or that carry a drag translation, form a live painter range; figures below and above it are composited once into two CPU layers. Each frame then draws the background, the lower layer, the live figures and the upper layer. Layers are reused while every figure outside the range keeps its geometry, opacity, visibility and parallax, and while the view differs only by a translation within the layer margin. Only a layer with no live figures (a pan) has a margin, a quarter of the viewport and at most 512 device pixels, and none when onion skins are shown, since their composites are viewport-sized. Canvas resamples cached figures slightly differently under that offset (edges within 16/255), which is invisible while the whole view moves; pans blit at whole device pixels and the release frame repaints exactly. Layers around edited figures have no margin and match a full repaint within 2/255. Scenes with scene VFX, generated particles or drawing cels keep direct painting. Figure rasters are admitted against the editor raster budget without evicting any raster already drawn in the same frame: an over-budget scene used to cycle through the whole cache and re-rasterize every figure on every repaint. Opaque figures that do not fit draw directly; translucent or effect-bearing ones use an uncached isolated raster. `tests/compatibility-layers.browser.mjs` compares layered frames with full repaints. On `svr_uriel.piv` (792 figures) posing, moving and panning went from about 6 fps to display rate, with one layer build per gesture.

Object rasters in both renderers and in playback packets use `rasterResolution()` (`renderer-geometry.mjs`): the physical scale rounded up to a quarter octave, with a minimum of 0.5. Whole-octave rounding drew a fitted 2.05× view at 4×, quadrupling raster time, memory and uploads; quarter octaves keep requested rasters at or above displayed density with at most 19% extra per axis. Ordinary fitted views retain the same density and dimensions. The former 8x ceiling no longer limits visible vector artwork; actual cropped dimensions and memory admission bound allocations instead.

The editor and worker share crop arithmetic, affine viewport inversion and pixel-grid guards in `raster-view.mjs`. Crops include effect sampling halos. Editor crops add 128-pixel coverage steps and margins, allowing small pans and drags to reuse pixels. Relative crop coordinates partition shared artwork variants inside the existing `EditorRasterCache`; no second raster owner or larger budget is introduced. Fully off-screen compatibility slots retain disabled records without rasterization. Immutable bounds are shared with staged preparation and Canvas culling. Zoom changes preserve the WebGPU painter layout and update visible raster slots; a pan or drag that exceeds the active allocation returns to complete-layout planning before submission. Cropped staged scenes require the same camera, dimensions and DPR at publication, and their existing leases protect cancellation and disposal.

Above 8x density, opaque native outlines on straight strokes and filled or white-backed circles can use the existing vector painter: all expanded silhouettes precede the original primitives. Eligibility excludes effects, secondary paint, nested clips, translucent outlines, hollow rings and primitives that become subpixel within the high-zoom range. Compiled geometry stays independent of the viewport; only visible draw ranges are submitted, so continuous zoom and panning require no outline rasters or geometry uploads. Isolated figure opacity uses those same records in the existing isolation pass. Other high-detail path-only editor rasters use a lazily allocated software-oriented scratch pool to avoid accelerated Canvas flushes competing with presentation; images and filters retain their existing route. Both scratch pools release storage and are disposed with their owning renderer or cancelled stage. Returning to ordinary zoom restores its established painter.

The fallback participates in prepared playback through **software packets**: when `PlaybackCache` is configured with `softwareFrames: true`, the playback worker evaluates the tick, bakes session-hidden and layer-hidden figures out of the drawable set, rasterizes the whole artboard — background, camera transform and camera VFX included — on a CPU worker canvas into one `ImageBitmap` (an accelerated worker canvas flushed the whole scene through the GPU-service thread and froze editing for up to 2 s on an integrated GPU), and transfers it instead of shape records. `prepareFrame()` copies that bitmap into a renderer-owned canvas so CPU packet eviction cannot invalidate the presented surface, and `renderPrepared()` composites it with a single `drawImage`. No geometry evaluation or scene rasterization happens on the UI thread during prepared playback. Because visibility is baked into the pixels, packets carry a `hiddenKey` signature: a different session-hidden set or layer-visibility state rejects the surface and falls back to live rendering, as does any active drag translation or camera-mode mismatch. Prepared surfaces share the GPU-frame memory allocation and the 120-frame LRU; `retainPreparedFrames` keeps them across camera-only view toggles exactly like GPU packets. Editing and scrubbing on the fallback reuse the same bounded raster strategy as onion skins: each unchanged live object is drawn once into an artwork canvas keyed by `renderSource` identity and blitted on later repaints, bounded by the editor-raster allocation.

While playing, a quality governor watches measured presentation FPS. A deficit sustained past about two seconds lowers the preview backing resolution to 75% then 50% and steps MSAA 4 → 1 → 1 on the WebGPU path; roughly six seconds at 98% of the target presentation rate restores each level, and pausing resets to full quality. Since the reduced backing updates `renderer.dpr`, worker packet resolution, software bitmaps and compatibility textures all shrink together. The overlay stays at native device pixel ratio so handles remain crisp, and the “Reduced preview quality” badge reflects governor state. Speculative prefetch depth also scales with `navigator.hardwareConcurrency` (minimum eight ticks, reaching the full lookahead on eight or more logical cores) so worker compilation does not starve few-core machines. On the GPU path, the viewport VFX working surface halves during playback, quartering its filter and copyExternalImageToTexture cost; the Canvas camera-VFX path already applied the same halving. `tests/playback-software.test.mjs` covers the packet contract, visibility baking, camera-mode semantics, cache retention and bitmap lifetime; `tests/playback-software.browser.mjs` verifies a real composited surface, presentation, stale-state rejection and eviction in Chrome.

API:

```js
const renderer = await createRenderer(canvas, {
  resources: { url: asset => asset.asset_url, image: url => imageCache.get(url) },
  onInvalidate: requestRender,
  onStatus: displayRendererStatus,
  forceCanvas2D: false,        // skip WebGPU entirely (compatibility mode)
  allowSoftwareAdapter: false, // opt back into CPU-emulated WebGPU adapters
  msaa: 4,                     // initial multisample count: 1 or 4
});
renderer.resize(cssWidth, cssHeight, devicePixelRatio);
renderer.render({ report, frame, geometry, view: { x, y, scale },
  hiddenUids: new Set(), dragTranslations: new Map(), onionFrames: [],
  clipToCanvas: false }); // editor workspace; omit for clipped playback/export
await renderer.setMsaa?.(1);          // WebGPU only: rebuild pipelines and targets
renderer.destroy();
```

`geometry` is the decoded `buildGeometry()` result. It must remain stable during a translation gesture; `dragTranslations` is a map from figure UID to world-coordinate delta. Commit the actual editor transform once the gesture ends. `cameraMatrix`, `worldToScreen` and `screenToWorld` are exported for overlays and hit testing. Handles are drawn by the editor overlay, outside the content renderer.

`clipToCanvas: false` lets figures and onion skins extend beyond the artboard throughout the editor viewport. Document camera transforms and workspace pan/zoom still apply to the full scene. Backgrounds remain clipped to the artboard, including rotated-camera image and gradient backgrounds. Image backgrounds keep their original world placement and top-left uniform cover fit; exposed areas repeat the nearest edge pixel under camera pan, rotation, and zoom-out. WebGPU samples the original texture with clamped world-space coordinates and no extra raster allocation. Canvas and SVG assemble at most nine slices on one pixel grid before transforming the image, preventing seams and doubled alpha. Temporary surfaces are capped at 16,384 pixels per side and 32 megapixels and released after drawing; extreme bounds can reduce background sampling detail. Transparency and background crossfades remain intact. Clipping is a uniform/shape flag, so toggling it does not rebuild geometry or upload shape buffers. Ordinary rendering defaults to clipping, and prepared playback always clips. The Canvas compatibility renderer follows the same behavior.

Only currently displayed onion scene graphs are retained. Changing a raster zoom bucket reuses those graphs and compiled vectors; document/geometry invalidation rebuilds them. On the Akane final frame with two dense neighbor onions (43,204 primitives and 36 compatibility textures), retained translation measured 0.4–0.5 ms p95 at 1×, 2× and 8× zoom with zero vector compilation or shape uploads. Editor GPU residency ranged from 24.6 to 79.3 MB. Changing texture resolution took roughly 8–12 ms; first activation of both uncached onion frames still took about 75 ms. Most fresh-render comparisons were pixel-identical; one repeated texture rasterization differed at seven pixels by one channel unit out of 255. See `artifacts/renderer-edit-profile-onion-zoom/report.json`. These are CPU-submission measurements, with the same hardware and UI exclusions as the editing benchmark.

Onion entries accept `{frame, geometry, opacity, beforeUid, showOnTop}`. With no anchor and a layer-aware report, ghosts appear immediately behind current artwork in their own layer, above lower layers; blank current exposures retain their position. Without layer metadata, they remain behind the complete current scene. With an anchor UID, groups appear immediately before that current figure, in the supplied far-to-near order, even if it has no visible artwork. Skins whose anchor is absent are omitted. `showOnTop` places ghosts above all current artwork. Layer-separated runs have distinct retained-surface keys, including when they originated in the same sampled frame. `src/scene-order.mjs` supplies the same order to WebGPU and Canvas; hidden UIDs affect both. Historical skins stay at their stored positions during live figure translation, including at 100% opacity. GPU/Canvas fixtures verify layer/background/anchored ordering, multiple skins, foreground occlusion, visibility and stationary history during drag. Interior colors match expected compositing within one channel unit; sparse stroke-corner antialias differences remain. See `tests/scene-order.test.mjs`, `tests/renderer-onion-order.mjs`, `tests/drawing-onion-layering.browser.mjs` and `artifacts/renderer-onion-order/`.

MSAA changes compile the vector and handle pipelines privately, then publish them
with a matching attachment in one synchronous step. Rendering continues with the
old complete resources while compilation is pending. Superseded or failed changes
cannot replace them; completion requests an idle repaint without clearing the
canvas. Viewport backing dimensions fit `device.limits.maxTextureDimension2D`
by reducing density while retaining CSS coordinates and aspect ratio. This is a
dimension limit, not a VRAM budget.

`tests/renderer-quality.desktop.mjs` checks delayed compilation with a concurrent
resize, unsupported sample normalization, failed/superseded changes, prepared
playback, idle invalidation, device disposal and oversized viewports. The real
app governor is exercised by `tests/preview-quality.desktop.mjs`; deterministic
clock cases live in `tests/preview-quality.test.mjs`.

## Prepared playback

`src/playback-worker.mjs` evaluates animation ticks and compiles the same primitive records in a worker. Compatible object rasterization also runs in worker `OffscreenCanvas` surfaces. The transferred packet contains typed shape/transform/UID buffers, ordered group ranges, background/camera metadata, and compatibility `ImageBitmap` objects. It does not send a geometry graph for ordinary vector figures. A mesh-only 3D figure sends its evaluated mesh arrays (`meshRaster`) instead of pixels; `prepared-frames.mjs` draws them into pooled object textures with a depth buffer, in the same command encoder as isolated vector rasters.

`PlaybackCache.updateDocument({revision, frameIndices, sourceIds, structural, definition})` patches the acknowledged worker mirror after edits. Native frame indices are explicit; headers, authored animation and layer metadata are replaced together. Immutable `figure_types` and `backgrounds` stay in the worker. Retained pose sources use stable IDs and reference comparison: only new, replaced or removed sources cross the boundary. `sourceIds` explicitly marks a source mutated in place. The patch is staged in acknowledged chunks capped at 64 KiB, with a 2 ms construction target, then validated and committed atomically. Evaluation caches and the worker timeline are refreshed at commit. `prepareRange()` waits for that revision's acknowledgement.

Pending frame/source changes survive superseding edits until acknowledged, including the case where a worker commit completed but its acknowledgement was still in flight. View changes merge an unfinished patch; unchanged mirrors receive only view configuration. A stale continuation cannot replace the next generation's acknowledgement waiter. Definition, background-table or native-frame topology changes use the complete snapshot fallback. `tests/playback-patch.test.mjs` and the independent `tests/playback-patch-review.test.mjs` cover retained assets, source deletion, undo races, mixed frame/source changes, atomic rejection and exact authored keys at floating-point tick boundaries.

The acknowledged mirror also supports `await playback.planLayerMigration({uids, targetLayerId, deletedLayerId, nextFrameIdentity}, {signal, onProgress})`. This read-only job pauses speculative worker preparation, samples the model's migration generator between event-loop yields, and returns a compact channel/source delta. Unchanged channels and historical source assets stay in their respective owners; new source assets are transferred once rather than duplicated in history records. Reverse transfer uses 64 KiB chunks, an acknowledgement before the next chunk, and a separate 128 MiB total result budget. Main-thread reconstruction stays in unpublished staging until completion. Cancellation, replacement documents and view revisions discard staging; playback resumes against the same unmodified mirror. The caller must still guard its editor revision and atomically publish the completed model plan. `tests/playback-planning.test.mjs` checks actual-worker equivalence, interruption, malformed ordering, partial-transfer budget failure and retained playback usability.

An actual visible desktop Akane test at tick 1871 verified one native translation and three authored translations against the newly compiled worker roots. Every update used patch messages; authored edits each sent one new 2.26 MB source snapshot, with no previous sources copied. Its initial run exposed 213–258 ms authored commits and 285–347 ms rAF gaps despite small transfer tasks. The editor now preserves exact committed pose geometry, layer membership revisions change only when membership changes, and collapsed timeline tracks avoid building hidden figure/property rows. A new visible run measured authored commits at 10.5–13.3 ms, acknowledgements at 35.2–44.8 ms and native commit at 6.4 ms. There were no main-thread long tasks or errors; maximum rAF gap was 20.9 ms. Authored worker-ready latency remained 292–298 ms, including the application's 250 ms idle-prefetch debounce. Chunk tasks stayed below 0.4 ms for authored updates and 1.3 ms for the native frame. These are four sampled commits on one machine, not a universal input-latency bound. The original and final reports are `artifacts/playback-patch-app/` and `artifacts/playback-patch-app-visible-final/`; independent headless CPU samples and function summaries are in `artifacts/playback-patch-app-headless-profile/`. One intervening visible profile had unexpected selection/revision changes and is excluded.

Prepared compatibility surfaces are cropped to the inverse-camera artboard bounds, with two raster-pixel guards and the original raster sampling grid. Fully offstage and zero-opacity compatibility objects are culled. Each visible figure keeps its own texture and UID, so layer visibility remains independent. Editor textures retain off-artboard content for posing. After a one-shot raster is captured by an `ImageBitmap` or GPU copy, its temporary canvas and nested opacity/outline scratch canvases release their backing surfaces; the captured bitmap remains owned by the CPU playback cache until eviction. Long-lived Canvas renderer contexts retain their reusable scratch canvases.

Cropped compatibility rasters with at least 64 drawables also pass their actual world-space raster clip to the native painter. Uncropped surfaces avoid the extra tests. Plain line/circle/polygon painting skips wholly outside primitives using conservative stroke/cap bounds and two output-pixel guards, after advancing native brush state. Outlines, figure effects and movieclip containers retain the full path; segment effects bypass primitive clipping. This removes unnecessary Canvas commands without changing visible geometry or object identity. `clipping.culledPrimitives` records work avoided, and `tests/raster-clip.browser.mjs` checks exact CPU/GPU pixels and brush state.

`src/raster-surfaces.mjs` retains one scratch canvas/context per worker resource owner or WebGPU renderer, together with its reusable opacity/outline contexts. Each lease restores fresh Canvas2D drawing state. After capture, the contexts keep their identities while their pixel storage shrinks to 1×1; a packet owns its independently captured bitmap. Resource disposal releases the small fixed set of contexts. This prevents thousands of short-lived Canvas contexts from accumulating for a later GPU resource-pool cleanup burst. The serial lease rejects overlapping use rather than allowing two objects to overwrite the same scratch surface.

`src/prepared-frames.mjs` uploads each packet once and retains GPU buffers, bind groups and draw commands. `renderPrepared()` then binds an existing packet and submits it; there is no geometry evaluation, tessellation, per-object compilation or shape-buffer upload on a cached playback frame. The GPU packet LRU retains up to 120 frames and uses `playbackMemoryBudget()` (128 MiB without a hardware memory hint, otherwise 32 MiB–1 GiB). It evicts before allocating replacement textures, rejects a single packet exceeding its budget, and invalidates on report, document revision, decoded-resource generation or device destruction. The CPU playback controller owns transferred bitmaps under a separate budget from the same policy. Document data, decoded background images, worker asset caches and ordinary editor resources have separate lifetimes outside these packet-cache limits.

Prepared playback reuses GPU allocations across ticks. Animated artwork changes size every tick, so pooled textures are bucketed (at most a quarter larger per axis) and a free texture of the same class that fits within twice the area can be reused. The artwork occupies the top-left of the allocation; its texture record scales UVs onto that region and clamps to the last used texel centre, so unused texels never filter in. Isolation rasters whose records are only lines, square-ended lines and circles render single-sampled: those primitives compute analytic coverage and their quads extend past it, so a multisampled scratch only allocated identical samples. Triangles, rectangles and textures keep the renderer's MSAA level. Glyph masks and filtered VFX keep exact allocations; meshes recycle exact sizes. The editor's raster cache applies the same rule to isolation and Canvas compatibility rasters: evicted allocations wait in a bounded free list (at most 64 MiB and half the editor raster budget, oldest destroyed first) that scrubbing reuses instead of allocating per tick. `textureBucket()` and `textureRegion()` in `renderer-geometry.mjs` are shared by both paths. On `svr_uriel.piv` at 21 fps on an Intel UHD (Gen 12) laptop this cut multisampled scratch allocations from 26 GB to 0.6 GB over the animation; pixels differ from the previous renderer by at most 2/255 on edges (one tick: 12/255 on 258 edge pixels).

Prepared frames own their background GPU textures independently of editable and staged scenes. `renderer.background(options, resolveTexture)` supplies lazy texture descriptors; playback checks their unique bytes before allocation, then retains them through the same reference-counted texture pool as figure artwork. Image backgrounds share by decoded image identity; painted backgrounds share by exact paint, camera bounds and canvas dimensions. Evicting the last referencing frame releases its texture. Pausing, cancelling an editable preparation, changing camera bounds or replacing the editor's background cache cannot destroy a cached playback frame's textures. Background pixels retain the existing rasterization and nearest-sampling rules. Warm replay adds no uploads or per-draw resource validation.

`tests/playback-background-lifetime.browser.mjs` compares paint/image/solid backgrounds against independent GPU rendering across pause/replay, cancelled preparation, camera changes, blending and cache eviction. `tests/playback-background-app.browser.mjs` exercises repeated Play/Pause through the app controls, including looping and restarting elsewhere. Unit tests cover background budget admission before allocation, shared references, disposal and failed uploads.

The same lifetime bug also occurred without editing a background: inserting `Flash aura.stykmov` into the middle of `16 Akane vs Akato Segundo round (2).piv`, then replaying, produced 24 consecutive empty canvas frames in a pre-fix browser run. WebGPU rejected the draw because the existing imported background texture had been destroyed during return to editing. `scripts/verify-movieclip-playback.mjs` loads those source files without modifying them, inserts the library movieclip through `Editor.importFigure`, and verifies exact tick order, visible canvas pixels, movieclip presence, replay and undo/redo. It records GPU errors and hashes both source files before/after. `STYK_PROBE_TICK`, `STYK_PROBE_MODE`, and `STYK_PROBE_FULL=1` select another insertion tick, timeline mode, or additional full-animation replays; `STYK_URL` selects the running local server. Reports and captures default to `artifacts/akane-flash-aura/`.

Prefetch plans a nearest-first prefix that fits the CPU budget, using remembered packet sizes as frames become known. Its bounded size metadata survives packet eviction and clears when document or view revision changes. The required next tick is always admitted. Every received packet immediately trims the remaining speculative queue to the newly measured prefix, before the next animation-loop request. This also bounds a cold batch whose sizes were initially unknown. Explicit pending requests outside that speculative window survive the automatic trim; cancelled packets already being computed release their bitmaps on arrival. These rules prevent redundant compatibility rasterization from accumulating in the shared GPU queue.

The controller opts into acknowledged packet delivery. After sending a packet, the worker prepares its next one but posts it only once admission/disposal and queue trimming of the previous packet have finished, so admission latency overlaps preparation. At most one current-revision transferred packet awaits admission, and retention that drops the prepared tick abandons it; the retained frame budget and lookahead are unchanged. Each acknowledgement matches both revision and delivery ID. Full/chunked replacement loads and invalidation release obsolete waits, while interaction suspension still prevents new compilation. Stale packets close on arrival. Direct endpoint consumers that omit this option keep the existing unacknowledged protocol. `tests/playback-delivery.test.mjs` covers these ownership and cancellation boundaries.

```js
await renderer.prepareBackgrounds(report, packet.frame);
const key = renderer.prepareFrame(packet, { report, view });
if (key && renderer.hasPreparedFrame(key)) {
  renderer.renderPrepared(key, { report, view, hiddenUids, hiddenKey });
}
renderer.clearPreparedFrames();
```

`hiddenKey` identifies the visibility signature baked into software packets; pass the same key `PlaybackCache` was configured with. It is ignored on the GPU path, where visibility stays a transform uniform.

`backgroundsReady(report, frame)` allows the transport to hold the current frame while an upcoming background decodes. A prepared frame is never cached with an unresolved background. Changing the zoom or device pixel ratio must invalidate the worker revision so bitmap resolution and GPU packet keys update together. Pass the exact physical viewport scale to the worker; it chooses a resolution bucket once, after applying the native camera scale. Rounding the viewport scale first can unnecessarily double texture resolution. Direct background-image textures use nearest sampling to match Pivot; cached vector/text object textures use linear sampling. A 2×2 source magnified into a 32×24 output matched the nearest-sampled Canvas reference with zero differing channel values.

Prepared packets identify their `cameraEnabled` mode. GPU upload and rendering default to that mode and reject an explicit mismatch: artwork cropped to the saved camera cannot simply be drawn through the neutral editor view. The same validated mode controls backgrounds and the compatibility Canvas raster fallback. Change `PlaybackCache.updateView({cameraEnabled})` before preparing the other view; this retains the loaded document and assets while invalidating derived packets. Normal editing uses neutral document coordinates; playback and export apply the saved camera. Prepared visibility accepts either a `Set` or a stable `{has(uid)}` membership provider.

`tests/renderer-prepared-camera.mjs` switches the same worker mirror neutral → rotated camera → neutral and verifies opposite offstage objects are culled correctly, visibility remains effective, and mismatched modes reject. All six prepared captures matched independent uncropped GPU rendering exactly. Five Canvas comparisons also matched exactly; the rotated translucent object had 0.135/255 mean channel difference from Canvas at antialiased edges. Paired captures are in `artifacts/renderer-prepared-camera/`.

When playback stops, the editor may pass its current packet once as `renderer.render({...options, preparedPacket})`. The application verifies the same report identity, editor revision and tick. The renderer then validates figure slots, UIDs, float32 roots and primitive ranges before copying the already compiled vectors into the corresponding editing caches. It also reuses compatibility classification, but rerasterizes complex objects with full editor bounds: cropped playback textures never replace off-artboard editor artwork. The copied records own their buffers, and the renderer does not retain the source packet. Stale or unmatched descriptors use ordinary compilation.

`STYK_NEUTRAL_EDITOR=1 node tests/renderer-adoption.mjs` separately checks camera-enabled playback packets adopted into neutral, off-artboard editor views. All ten Akane captures at 1×/2× matched independent fresh compilation exactly, with zero compiled objects; the final frame reused 602 vector objects and copied 1.38 MB. See `artifacts/renderer-adoption-neutral/`.

The actual desktop pointer/transport regression (`node tests/renderer-ui-performance.mjs --fps=60`) measured a 1,000-figure, 24-keyframe scene at 59.88 effective FPS after preparation. Warm renderer submission cost was 0.1 ms median / 0.2 ms p95; the editor's render section, including first-use packet uploads, measured 0.4 ms p95. The first frame appeared 93.4 ms after Play; the worker prepared all 24 frames in 518.6 ms. CPU packet residency was 27.36 MB and GPU packet residency 25.73 MB. These values describe one NVIDIA Lovelace test machine and exclude OS input latency, GPU-completion latency and display scanout. Worker preparation can still cause transport buffering on cache misses; the transport preserves sequential animation ticks.

Before prepared texture cropping, `node tests/renderer-corpus.mjs --prepared` covered the same 37 files and 101 sampled frames; all prepared GPU PNG hashes matched normal-renderer GPU hashes, including text, sprites, outlines, opacity groups and camera magnification. That historical equality does not establish exact pixels after cropping. Current `node tests/renderer-prepared-tail.mjs` validates the thirteen previously rejected Akane ticks 1824–1836 plus two controls at both 1× and 2× view scales, including the temporary-surface cleanup. All 30 packets render within the 128 MiB GPU cache, with no GPU or browser errors. The largest packet is 111.11 MB. The maximum cropped-versus-uncropped GPU mean absolute error is 0.280/255 and the largest significant differing-pixel area is 0.068%; cropping preserves or slightly improves the established Canvas-reference metrics. These comparisons use the existing Canvas renderer, not new native Pivot captures. Reports and paired images are in `artifacts/renderer-prepared-tail/`.

A full Akane playback exposed 701–784 ms presentation gaps despite cheap CPU submissions: some distant packets were rasterized 12–15 times after over-budget prefetch discarded them. Already-required frames had been available seconds before presentation. With the worker idle, repeatedly drawing eight problematic ticks completed in about 2.5–5 ms per queue fence, with one 8.8 ms outlier; the expensive backlog was not inherent to those cached GPU draws. See `artifacts/renderer-gpu-isolation/` for the independent vector/texture split and captures.

After feasible-prefix prefetch was implemented, actual UI checks at 16 FPS presented every tick in three affected spans: 1788–1812, 520–540 and 1844–1871. Their elapsed times were 1506.5, 1248.6 and 1691.2 ms versus nominal 1500, 1250 and 1687.5 ms; maximum presentation intervals were 69.5, 69.9 and 71.8 ms. Queue-completion callback delays stayed below 41 ms. There were no active-playback long tasks or errors; returning to the dense final editor frame still produced one 59 ms task. The first span suppressed 216 infeasible prefetch requests, and its previously repeated packets were compiled at most twice, including the initial unknown-size discard. These isolated spans do not replace a complete-animation pacing check. Artifacts are `renderer-live-tail-prefetch-budgeted`, `renderer-live-tail-prefetch-budgeted-520` and `renderer-live-tail-prefetch-budgeted-1844` under `artifacts/`. Queue-fence wall time includes callback scheduling; none of these measurements is display scanout latency.

A subsequent bounded Chrome GPU/compositor trace captured a different 139 ms rAF stall around tick 340. The GPU service thread was busy for 132 ms, with 2,463 shared-image destructions and 2,471 shared-image-pool destructions in that interval. DirectComposition presentation paused for about 153 ms, and Chrome's displayed-frame feedback also stopped. Main-thread JavaScript had no long task. After worker context reuse, all 480 ticks from 0–479 played in 29,942.6 ms versus a nominal 29,937.5 ms, with no active rAF gap exceeding 120 ms. The maximum submission interval was still 119.6 ms. Its retained trace tail showed at most 45 pool destructions per 150 ms versus 3,145 in the prior stall trace, though the retained tick windows differ. All 90 Akane prepared/normal/Canvas PNG hashes remained unchanged. These traces support the resource-lifetime fix while leaving full-run and cross-machine pacing verification necessary. See `artifacts/renderer-live-tail-stall-ring/`, `artifacts/renderer-live-tail-stall-ring-pool/`, and `artifacts/renderer-prepared-tail-pool-regression.json`.

A visible Electron comparison uses the actual Akane file, ticks 1824–1871 at 16 FPS, a 1120×652 viewport, physical scale 1.49117647 and DPR 1. Before immediate queue trimming, 13 speculative requests were still pending when Play began; a 342.1 ms submission gap coincided with hundreds of queued Canvas raster operations. Production queue trimming reduced that pending count to zero and completed all 48 ticks in 2933.9 ms versus 2937.5 ms nominal. Submission intervals measured 69.9 ms p95 / 73.8 ms maximum, with no active-playback long task or errors. Actual DirectComposition Present events still had a 94.42 ms maximum gap, and Chrome displayed-frame feedback reached 97.23 ms. Returning to the dense editor frame produced a separate 142 ms task. See `artifacts/renderer-live-tail-desktop-pool-pruned/`; its diagnostic-prefetch override is explicitly disabled.

The native comparison runs hash-verified Pivot 5.2.11 on the same file, ticks, viewport and scale through its real Play button and frame timer. All 48 instrumented DXGI Present calls returned `S_OK`; an earlier sandboxed, occluded run is excluded. Native engine evaluation/render wall time was 12.94 ms median / 16.75 ms p95, and native Present-return cadence was 67.35 ms p95 / 74.26 ms maximum. Native engine wall time includes evaluation, rasterization and waits, so it must not be compared directly to WebGPU's 0.2 ms p95 command-submission CPU cost. The measured web compositor tail remains above this native baseline; the results do not establish faster-than-native playback or physical display scanout latency. Native instrumentation and source hashes are recorded in `tests/native-playback-benchmark.py` and `artifacts/native-playback-tail-visible-v5/report.json`.

The return-to-edit CPU profile identified duplicate vector compilation and compatibility classification, alongside geometry reconstruction, handle generation and garbage collection. Adopting current worker vectors reduced the measured final-frame renderer call from 49.6 to 17.5 ms and the complete pause task from 142 to 78 ms in visible desktop runs. The final frame reused 602 vector objects, copied 1.38 MB, and compiled zero objects. All ten Akane pixel comparisons at 1×/2×, with off-artboard content visible, matched independent fresh editor rendering exactly. Geometry/handle preparation still makes this a noticeable pause on the dense frame, and that later playback run also recorded a 118 ms active interval; the fix does not establish uniform pacing. See `artifacts/renderer-adoption/`, `artifacts/renderer-live-tail-desktop-editor-adoption/` and `artifacts/renderer-live-tail-desktop-editor-return-profile/`.

Verification: `node --test tests/renderer.test.mjs` checks primitive compilation, concave fills and camera coordinate inversion. `node tests/renderer-gpu-smoke.mjs --imports` launches the actual desktop app, validates the shader on the available GPU, tests onion-skin passes, measures retained-buffer dragging, and compares real STK/PIV scenes with the established Canvas renderer. Artifacts include scene screenshots and metrics. Native graphics access may require running outside a restrictive process sandbox.

Full retained layouts now use one reusable 768 KiB CPU staging buffer for contiguous primitive uploads. A large figure may span batches; disabled capacity records retain the same zeroed fields and disabled mode as the former individual uploads. Dirty-object editing still uploads only changed objects. `tests/renderer-upload.test.mjs` checks exact bytes across live-data/padding/batch boundaries, nonzero staging offsets, empty layouts, and a 1,000-object layout requiring two uploads instead of 1,000. `renderer.stats.primitiveUploadCalls` distinguishes the API call count from the unchanged uploaded byte count. The staging allocation is released with the renderer; it does not grow with the scene.

`await renderer.prepareInitialScene({report, frame, view, getView, cameraEnabled, signal, checkCurrent})` stages a replacement document without changing the live canvas or its buffers. It returns the exact `frame` and `geometry`, a private URL-keyed `images` map, final `view`, measured `timings`, and `dispose()`. Geometry construction, per-object vector/compatibility preparation and contiguous buffer uploads use cooperative steps with a default 4 ms scheduling target. Image decoding covers the selected background and images referenced by that initial frame. GPU staging shares the existing device and pipelines, but owns separate document buffers, textures and caches until activation. It waits for queued preparation work before returning. A final `getView` recheck rebuilds only when the required compatibility raster bucket changes.

The application must first adopt the returned image map and view, then synchronously call `renderer.activatePreparedScene(prepared, {report, frame, geometry, view})` at model publication. The renderer validates object identities and transfers resource ownership exactly once. `dispose()` after activation is harmless; disposal before activation releases only staging resources. Abort or image-decode failure leaves the old report and renderer unchanged. Canvas fallback supports the same geometry/media staging contract, but does not precompile a GPU scene.

Pending image waits also check the model revision guard every 50 ms, so replacing or editing the old document can cancel a stalled network/decode operation even when no external AbortSignal was provided. The timer exists only while decoding is pending; completion, failure or disposal removes it and any abort listener. Disposing the private image owner immediately rejects its waiters. This guard was added after the recorded Akane diagnostic and has separate stale-load/disposal regression tests.

The 4 ms value is a scheduling target, not a maximum task guarantee: one figure's geometry, native image operation or compatibility raster remains an indivisible unit, and GPU/OS scheduling can take longer. During replacement, old and incoming scene resources coexist; this temporary residency is separate from the bounded playback packet caches. `stats.initialPreparation` reports geometry CPU work, maximum geometry task, media readiness, GPU preparation slices, queue-wait time and total stage time. These phases overlap, so their elapsed times must not be summed.

`tests/renderer-initial-scene.test.mjs` covers private staging ownership, identity checks, cancellation during GPU uploads, pending image-decode cancellation, URL deduplication and final view selection. The actual-app companion `tests/renderer-initial-scene.browser.mjs` passes nine checks including complete first-frame background/sprite media, neutral edit camera, retained rendering with zero uploads/compilation, exact independent pixels, exact old-upload pixels and preservation after failed replacement. Its small fixture screenshots are in `artifacts/renderer-initial-scene/`; it does not establish Akane import time or display scanout latency.

`node tests/renderer-corpus.mjs` compares the 37 original files in `../docs/piv_corpus_manifest.json` at their first, middle and last display ticks, including evaluated inbetween frames. The September 8, 2026 run covered 101 distinct sampled frames with no import, asset, browser or GPU errors. Every frame had mean absolute channel error below 0.782/255. Two dense-edge frames exceeded the conservative 1% differing-pixel threshold; more than 99.97% of those differences were within two pixels of a reference edge. The maximum differing interior area across the corpus was 0.007%. Paired images, explicit thresholds and per-file results are in `artifacts/renderer-corpus/`. The comparison oracle is the established studio Canvas renderer, not fresh native Pivot screenshots, and this sampling does not establish pixel-identical or exhaustive frame parity.

Compatibility texture resolution accounts for camera magnification as well as editor zoom and device pixel ratio. This was checked against `deformation_demo.piv`; the zoomed final frame's differing-pixel area fell from 1.139% to 0.028% after the camera-scale correction.

On the tested NVIDIA Lovelace adapter, 1,000 simple figures (11,001 primitives) render in one draw call. Sixty retained-scene translation submissions measured approximately 0.2 ms median and 0.5 ms p95 CPU time, with zero geometry uploads. These are CPU submission measurements on one machine, not universal frame-rate or input-latency guarantees. GPU completion, complex compatibility textures, import decode, UI work and display refresh have separate costs.

`node tests/renderer-edit-profile.mjs` uses the user's Akane file, final keyframe 1478 (643 figures, 15,054 segments), and actual `Editor.moveSelection` / `Editor.poseJoint` commands. Across 24 live updates per case, numeric root translation rendered at 0.8 ms p95; posing parent UID 460616 and its eight attached descendants rendered at 0.8 ms p95; posing the larger 105-object connected rig rendered at 2.9 ms p95. Mutation, geometry evaluation and renderer submission together measured 1.7, 1.4 and 5.7 ms p95 respectively. All 72 edits used changed-slot preparation; final GPU images matched fresh full-scene compilation exactly. The largest branch uploaded at most 193 KB versus the initial 1.75 MB primitive upload. These isolated editing measurements exclude app panels, input dispatch, autosave, GPU completion and display latency. The optimized compiler also retained identical PNG hashes for all 101 existing corpus images. Detailed measurements are in `artifacts/renderer-edit-profile/report.json` and `artifacts/renderer-edit-corpus-regression.json`.

## Dense collection preparation

`renderer-vector-raster.mjs` composites eligible translucent vector figures into GPU textures before applying their final figure alpha. Worker packets opt in through `PlaybackCache({gpuIsolation:true})` and transfer independent vector buffers, leaving retained worker buffers attached. Complex paints, effects, nested clip ownership and subpixel strokes use the native Canvas compatibility painter. Eligibility is checked at the actual bounded raster resolution. Editor textures and prepared textures retain their existing owners and eviction rules; packet admission conservatively reserves both the eventual texture and its vector payload. Temporary buffers and antialias targets are released after submission. Rasterization keeps a matched pipeline/sample-count pair when viewport MSAA changes.

`playback-upload.mjs` warms startup GPU resources one packet per animation frame. `PreparedFrameCache.canWarm()` counts additional texture and buffer residency without allocation or eviction, so startup cannot repeatedly evict its first frame to prepare later ones. The queue fence is cancellable by generation and does not block the UI thread. A larger startup window trades preparation time for steadier cold playback; reports must include startup separately from presentation cadence.

Ordinary PNG crops use the browser decoder when the possible full RGBA source fits twice the requested pixel allowance, capped at 16 MiB. Larger sources and tiny crops retain scanline decoding; RGBA rows copy directly at native crop size, and PNG filters dispatch once per scanline. Header inspection supplies native BMP/GIF/JPEG dimensions, including JPEG EXIF orientation, instead of assigning unknown images a fictitious square source. Embedded data uses direct byte copying. These paths preserve original dimensions and source-crop coordinates.

`PreviewImages` resolves lazy decode waits by URL, preserves pending backgrounds across coalesced batches, and rejects waits on disposal or decoding failure. Lazy lookahead requests only missing URLs and retains recent decoded images within its half of the image allowance. Its optional `priorityURLs` callback refreshes the bounded upcoming playback window before eviction: plain LRU otherwise discards the next prefetched image before recently displayed past frames. Priority never expands the byte cap. The application owns image invalidation through `managedInvalidation`; adding new lookahead URLs preserves complete GPU packets, while live edits and resized variants invalidate their consumers. Standalone image owners retain normal load events. Hidden camera/parallax monitors skip geometry evaluation and painting.



## Shared definition redraws

Dense definition edits and structural undo/redo use `EditableScenePreparation`,
as timeline seeks do. The native command finishes atomically first; geometry and
WebGPU artwork then stage in cooperative slices while the canvas retains its
last visible gesture. Panels and background preparation wait for activation.
A newer edit, seek, document or graphics lifetime cancels obsolete staging.
This preserves the exact native scene and export quality; it does not make the
required instance reconstruction free or promise a maximum task duration.

A staged layout shares the primitive arrays of vector objects that are
unchanged from the live layout (same retained source and transform slot)
instead of copying and uploading them again. Activation copies those ranges
from the live buffer on the GPU, before the live buffer is released; an entry
that changed in the live layout during staging is uploaded instead. A seek in
a dense scene therefore uploads only the objects it re-posed.

Image preparation reads cached image subsets of immutable object drawing lists,
including nested clip instances, without flattening every line and polygon on
each pointer frame. The original image records retain their anchor geometry for
resolution selection. Weak ownership follows the geometry's lifetime.

Shared-rig history copies native numeric pose vectors directly and retains all
other saved fields, including imported runtime lengths/bends. Its memory charge
uses a conservative constant per numeric element instead of formatting whole
pose arrays as JSON to measure them. Validation and independent undo ownership
remain intact.

## Preview failure recovery

The camera output monitor contains its own drawing failures, reports diagnostics, and backs off for 1.5 seconds. A restored canvas invalidates the monitor immediately. Failed camera-effect surfaces are released and recreated on a later render in both GPU and software modes; the base scene stays editable and a status message identifies the temporary unfiltered preview. A failed software object-raster allocation falls back to direct drawing under the same retry delay. These preview fallbacks never change the document or weaken export fidelity checks: failed export rendering still rejects instead of producing blank or partially filtered frames.

## Live drawing surfaces

On WebGPU, eligible drawing cels are drawn from GPU-resident tiles as
instanced quads inside the ordered retained layout, with GPU-reduced levels
and the GPU brush overlay; `src/drawing-gpu.mjs` owns that pool and its
budget ([DRAWING-GPU.md](DRAWING-GPU.md)). The scratch presenter below serves
Canvas 2D, onion skins, selection previews, cels with effects and
`setGpuDrawing(false)`.

A drawing resource supplies a visible-tile presenter for the active image
figure rather than a full-cel surface. Tiles are painted into bounded
scratch canvases covering tile-anchored rectangles: each presenter keeps a
small LRU of them keyed by anchor, and a requested rect contained in an
already-painted cover reuses that scratch without repainting, so zooming
into painted regions and alternating Canvas/WebGPU anchors keep independent
surfaces. Mip levels serve zoomed-out views, escalate to level 8 (256×) so
coverage of any span fits, and are invalidated by tile dirty regions; when a
region still exceeds the texture limit the scratch clamps to it around the
visible span instead of failing — a drawing is never rejected for size. Each
scratch tracks its own pending dirty rect per mip level.
WebGPU composes the scratch as an affine
RGBA quad in the existing ordered layout, retains its texture keyed to the
scratch anchor so deferred uploads always read the matching canvas, and
uploads only dirty rectangles; Canvas draws the scratch once. An evicted
presenter keeps its slot: the last texture stays bound until the store
re-decodes, and v2 cels never fall back to the placeholder data URL.
Unused drawing textures are retained in a bounded LRU before eviction, so
timeline hops do not force full re-uploads. Surface residency/publication
invalidates derived layouts. Layout replacement, cancellation and disposal
release owned textures. Drawing GPU bytes are included in renderer accounting.
View rotation transforms both artwork and stage clipping, and is excluded from
exported camera state.

## Scene effects and live drawing readiness

The completed camera image retains snapshots of the live drawing presenters it
samples. Geometry identity alone does not establish pixel readiness: decoding,
preview publication, store replacement and resource disposal can all change its
source. Camera invalidation compares presenter/owner/store identity and stamp;
compatibility-raster cache hits validate the same dependencies before reuse.

The camera GPU painter prepares drawing tiles for its own matrix and padded
surface, at camera raster density rather than the editor viewport's DPR. Its
coverage includes live drag, parallax and translation-only retained source
offsets. GPU upload/reduction progress and provisional brush/session changes
also advance camera readiness; unchanged complete frames reuse their image.
The camera scratch path samples independently through `EditorRasterCache` and
refreshes direct drawing bounds for live growth. Temporary shape overrides,
shared uniforms/transforms and leases restore even on failure, and existing
cache admission bounds camera-only variants. The camera does not own another
tile or artwork cache.

Scene VFX keeps onions outside the filtered camera source and redraws them over
the finished camera overlay. Ordinary layer composition places ghosts at their
layer boundaries; the existing Scene VFX overlay is a separate composition rule.

## Compatibility interaction and resource ownership

Compatibility editing uses conservative viewport bounds at every scale. Native
paths and glyphs keep complete source rasters at ordinary density, including
translucent groups and mixed path/image artwork, to preserve Canvas edge
coverage. Large verified image-only artwork, including eligible drawing groups,
may crop on the original pixel grid when this saves a substantial allocation.
Required high-density or oversized crops retain the established bounded painter
policy. The retained raster owner protects visible entries before admitting
replacements. Eviction searches beyond protected entries rather than repeatedly
repainting an over-budget scene. Native brush state advances even when primitives
are culled. Effects and unsupported bounds keep their established painter.

Gesture layers retain only the useful canvas coverage. Pose and move layers
preserve the destination origin to keep native curve sampling; pan layers may
crop both axes with coverage margins. Published drawing dependencies and stamps
invalidate affected ranges, including growth and erasure. Layer retirement
releases its child resources. A compatible completed software playback frame
can also serve the camera monitor without evaluating and repainting figures;
camera mode and visibility signatures still gate that reuse.

Overlay-only feedback does not invalidate scene artwork. Eligible native pose
input keeps one pending target, flushes at gesture/modifier boundaries and on
release, and preserves angular winding; cancellation discards it. Projected
handles reuse immutable groups and repaint damaged regions in painter order.
Complex constraints and drawing retain their existing input paths.

Preview software filter surfaces share a bounded owner hierarchy and realm LRU.
Background edge rasters cache only immutable decoded bitmaps, with at most two
variants per context and explicit byte admission. Document replacement and
renderer/worker teardown release owned surfaces. Unconfigured export contexts
retain their established larger filter allowance and tile reuse; preview
retention limits do not reduce export fidelity. These allowances do not cap all
temporary CPU buffers or browser/driver allocations.


