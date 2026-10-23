# GPU drawing residency and brush

On WebGPU, drawing cels are displayed from GPU-resident tiles and brush and
eraser strokes are rasterized on the GPU in the frame that receives input.
The CPU `TileStore` remains the only authoritative raster: history, saving,
publication, recovery, clipboard, fill, selection and export are unchanged.
`src/drawing-gpu.mjs` owns both halves; the renderer and the drawing
controller use it through narrow calls.

## Display

`DrawingGpu` keeps one storage-buffer pool of 64×64 straight-alpha RGBA8
slots. Committed level-0 tiles are uploaded when their `TileStore` version
changes, so copy-on-write forks that share tile objects share slots. Reduced
levels are exact integer box reductions of the level below, byte-identical to
`drawing-raster.mjs` mips. The display level follows the scratch path's rule
(`floor(-log2(screen pixels per source pixel))`, levels 0–8).

Each visible tile is one instanced quad. The fragment shader premultiplies
and bilinearly filters texels through the tile's 3×3 neighbourhood, so tile
seams never appear at any zoom or rotation. Transparent neighbours of
occupied tiles are drawn as halo instances so filtering fades past the last
tile instead of stopping at its edge. Opacity, hiding, drag offsets,
parallax, clipping and layer order come from the existing retained layout.

The pool grows by doubling up to its budget (512 MiB, capped by the device's
storage-buffer limits, which the renderer requests up to 1 GiB) before it
evicts least-recently-used slots. A slot used by the frame being encoded or
pinned by a stroke is never reused. At most 2,048 tiles upload per frame; a
reduced level whose children are not ready keeps drawing its previous content
and the renderer schedules another frame. An evicted CPU store keeps drawing
its last resident tiles until its decode completes.

`TileStore` keeps a bounded per-consumer log of changed tile keys (set,
delete, in-place `writable()` and `clear()`). The GPU state consumes it each
frame and invalidates only the reduced ancestors of changed tiles; an
overflow or replaced store rebuilds that cel's levels. Presentation refreshes
without pixel changes therefore cost nothing on the GPU path.

A cel's tile instances are reused on the next frame when its store revision,
view, display level, tile window and level/overlay versions are unchanged, and
every slot they reference still belongs to the same record (an evicted slot
handed to another tile forces a rebuild). Reduced tiles a stroke invalidates
keep their slots, so a reused frame only re-reduces the stale ones in view;
new overlay tiles bump only the levels whose occupancy they extend. On a dense
4K cel this took idle frames from 1.0 to 0.4 ms of render time, panning from
1.2 to 0.5 ms, and strokes at 100% from 1.1 to 0.7 ms (headless Chrome).

The brush, reduction, alpha-bounds and display pipelines compile
asynchronously after the renderer starts, and again ahead of an antialiasing
change; drawing uses the scratch presenter and stroke worker until
`renderer.gpuDrawingReady` settles. Compiling on first use stalled the first
stroke after launch by over 100 ms in Electron.

Onion skins, selection previews, cels with drawable effects and the Canvas 2D
renderer keep the scratch-canvas and worker-preview presenter described in
[DRAWING.md](DRAWING.md). `renderer.setGpuDrawing(false)` switches a WebGPU
renderer to that presenter for diagnostics and fallback tests.

## Brush

The controller runs the shared brush model (`drawing-brush.mjs`
`BrushStroke`: pressure curve, smoothing, quadratic curve sampling, spacing,
tapers and `dabShape()`) per mirror, so the GPU receives exactly the dab
shapes the stroke worker would. `GpuStroke` groups each frame's dabs by
touched tile in order. A compute shader evaluates the CPU brush per pixel over
those ordered dabs — elliptical and image tips, hard and soft falloff, grain,
and a dense selection mask uploaded once per stroke — carrying coverage
between frames, then
composites the colour from final coverage and the pixels the stroke first saw:
Normal, Behind, Multiply, Screen, Overlay and Color blends, alpha lock and
erasing, exactly as `DrawingStroke.composite()` does. Erasing and alpha lock
skip tiles the stroke found empty. It writes into private overlay slots that
the display reads instead of the committed tiles. Positions are relative to a
stroke origin so single precision stays exact across unbounded cel
coordinates. Image tips and grains are read from one texture atlas buffer
on the device (180 KB), each texture uploaded once on first use.

A brush with an end taper keeps its last dabs provisional until pen-up. A
second, ephemeral dispatch per frame paints that tail over the final coverage
without storing it, recompositing every tile the previous tail covered, so
the tail follows the pen and leaves nothing behind when it moves or is
finally tapered. It runs only when the tail moved and covers a few tiles.

Smudge picks up the paint the previous dab left, so `GpuSmudgeStroke` runs
two dispatches per dab: a single workgroup averages the premultiplied colour
under the tip on the same ≤64×64 grid as the CPU and updates the carried
paint (kept on the GPU between frames), then one workgroup per touched tile
lays it down. Each dab reads a tile's overlay slot once an earlier dab has
initialized it, and the committed slot before that. At most 192 smudge dabs
paint per frame; later ones wait for the next frame, so a huge fast smudge
stroke cannot stall the display.

Only selections too large for a pixel mask (polygon outlines beyond 16
megapixels) keep the stroke worker on WebGPU.

At pen-up the remaining dabs are dispatched, a second compute pass finds each
touched tile's nonzero-alpha bounds, and the tiles are read back. Read-back
processing yields to input every 8 ms. It produces the same exact
before/after history records as a worker stroke. The committed tile shares
the history record's buffer and is adopted frozen, so any later edit copies it
before writing and history stays exact; this saves a full copy of every
touched tile at pen-up. `adoptDrawingPreparation()` wraps the tiles in the existing validated,
pinned and memory-accounted preparation, so the commit adopts them without a
worker round trip. Committed tiles then take over the overlay slots that
already hold their bytes, so nothing is uploaded again.

Escape, blur, document replacement and lost capture discard the overlay
without history. A GPU failure — including running out of GPU memory
mid-stroke — replays the stroke's recorded input samples (bounded at 65,536)
through fresh paths on the stroke worker, which then commits normally. The
stroke worker also remains the brush for the Canvas 2D renderer.

GPU and CPU brushes differ only in floating-point width and the CPU's soft
falloff lookup table: across ink, soft, textured pencil, marker, eraser,
hairline, stabilized, nib, charcoal, airbrush, every blend mode, alpha lock,
selection clipping, tapered ink and eraser, the pulled string with a custom
pressure curve, and the chalk, bristle and sponge tips on paper, canvas and
noise grain with jitter, every channel matches within one 8-bit step and at
most 1% of touched pixels differ; smudge, whose carried colour compounds
rounding from dab to dab, stays within four steps on at most 3% of pixels
(`tests/drawing-gpu.browser.mjs`).

## Measurements — 24 September 2026 (brush engine overhaul)

Same machine and method as below, dense 1080p cel at 2×. The overhaul moves
dab shapes, tapers and texture sampling into the shared model without
changing hot-path cost. Matched runs of the committed build (715de266) and
the overhaul, two runs each, p50 / p95: Pencil 7.8–11.5 / 21–23 ms against
9.5–10.4 / 22–23 ms; Charcoal 6.2–6.3 / 14–15 ms against 5.9–6.1 / 15 ms;
Ink 6.0–6.2 / 15 ms against 6.0 / 15 ms. The Canvas 2D fallback (stroke
worker): Pencil 53 / 72 against 53 / 78 ms, Charcoal 30 / 40 against
29 / 41 ms, Liner 51 / 70 against 48 / 63 ms. No scenario recorded a long
task. The new presets on WebGPU: Brush pen 6.1–6.6 / 14–15 ms, Chalk
5.7–5.9 / 14 ms, Dry brush 6.2 / 15 ms (160 px: 7.3–7.6 / 23 ms), all at
frame p95 7.1 ms. Pencil's share of samples whose dab centre shows the brush
colour fell from 86% to 65–69% because paper grain pits now lighten some
centres; that is the intended texture, not delay. Sponge (82–88% shown, p95
up to 250 ms at 160 px) and Airbrush are likewise limited by what the probe
can detect: porous and slowly building dabs, with frame p95 7.1 ms and no
long tasks.

## Measurements — 23 September 2026 (every preset)

Same workstation and method as below, with the full brush engine merged:
`tests/drawing-latency.browser.mjs` paints each preset at its own tip and at
160 px over the dense 1080p cel at 2× (2,040 tiles), 240 Hz input for four
seconds. Before is `main` at 12f9c1f7, where only the stroke worker painted;
after is this merge. Latency is event to first render showing the dab centre
in the brush colour (magenta), so Marker (35% opacity) and the slow build-up
of Airbrush are not fully detectable by design. Raw results are in
`artifacts/drawing-latency/presets-2026-09-23/`.

| WebGPU, dense cel | Before p50 / p95 | After p50 / p95 | Pen-up to commit before → after |
| --- | ---: | ---: | ---: |
| Ink | 71 / 157 ms | 6.8 / 16 ms | 72 → 67 ms |
| Pencil | stroke discarded (queue limit), 586 ms task | 11 / 23 ms | — → 55 ms |
| Pencil, 160 px | 243 / 444 ms | 6.9 / 11 ms | 86 → 106 ms |
| Soft, 160 px | 56 / 281 ms | 6.8 / 20 ms | 58 → 101 ms |
| Nib | 30 / 48 ms | 6.7 / 16 ms | 78 → 50 ms |
| Charcoal | 28 / 47 ms | 7.9 / 16 ms | 74 → 83 ms |
| Liner (stabilized) | 373 / 6,112 ms, 1.4 s task | 14–18 / 23–26 ms | 3,607 → 64–74 ms |
| Oil (smudge) | 795 / 1,035 ms | 6.7 / 15 ms | 712 → 76 ms |
| Oil (smudge), 160 px | 1,087 / 1,199 ms, 6% shown | 6.3 / 10 ms | 19,391 → 95 ms |

Liner's remaining latency is its stabilization, which trails the pointer by
design. The Canvas 2D fallback (stroke worker) measured Liner 4,187 → 62 ms
p50 with rendering stalls of up to 4.3 s removed, Oil 1,288 → 40 ms, and
Pencil from 38% of samples shown at up to 2.4 s to 62 ms p50 once batches
were sized by tip area. The rendering stalls came from wet ink issuing one
canvas stroke per dab on every pointer event; see [DRAWING.md](DRAWING.md).

## Measurements — 22 September 2026

AMD Ryzen 5 5500, NVIDIA GeForce RTX 4070 SUPER, Windows 11, Node 24.11.0,
headless Chrome 153 at 1440×1000. `tests/drawing-latency.browser.mjs` sends
mouse input at 240 Hz through Chrome's input pipeline along a four-second,
ten-row zigzag. After each render it reads back the stroke region; a sample
counts as visible when its dab centre shows the brush colour. Latency runs
from the event timestamp to that render. Both builds are measured with the
same script after a warm-up stroke; read-back costs apply to both. This is not
display scanout or physical pen latency.

| Scenario | Baseline p50 / p95 / p99 | GPU p50 / p95 / p99 | Pen-up to commit |
| --- | ---: | ---: | ---: |
| 8 px brush, blank 1080p cel at 2× | 22 / 43 / 89 ms | 6.5 / 16 / 33 ms | 64 → 68 ms |
| 48 px brush, dense 1080p cel at 2× (2,040 tiles) | 30 / 71 / 173 ms | 6.6 / 18 / 71 ms | 101 → 85 ms |
| 300 px brush, same dense cel | 1,632 / 3,180 / 3,269 ms (54% shown) | 7.1 / 11 / 16 ms | 7,309 → 102 ms |
| 48 px brush, dense 4K cel at 2×, 25% zoom (8,160 tiles) | 66 / 152 / 197 ms | 7.8 / 14 / 21 ms | 298 → 142 ms |
| 8 px brush over 500 figures | 25 / 42 / 115 ms | 7.5 / 16 / 20 ms | 96 → 103 ms |

Headless Chrome paced frames at about 70 Hz, so one frame is about 14 ms. In
this matched run the GPU build recorded mid-stroke main-thread tasks of 77 ms
(blank cel) and 74–113 ms (dense 48 px), which explain its 71 ms p99; the
baseline recorded none. They coincide with the benchmark's per-frame canvas
read-back, which waits for the GPU. Two immediate repeats of both scenarios,
and CPU profiles of the same strokes without read-back, recorded no task over
50 ms (p50 6.2–8.3 ms, p99 11–22 ms). Their cause is not otherwise confirmed.

`tests/drawing-gpu.desktop.mjs` repeats the latency method in the Electron
39.8.10 runtime (Chromium 142) from a clean profile, after one warm-up stroke:
all 602 samples of a 2.5-second, 240 Hz stroke appeared, at p50 7.7 ms, p95
12.7 ms and p99 15.5 ms, with frames paced at about 8 ms; the stroke committed
through the GPU brush without the worker fallback
(`artifacts/drawing-gpu/desktop-result.json`).

The Canvas 2D fallback keeps the worker brush and measured within run-to-run
variation of the baseline: p50 23 / 36 / 55 ms against 24 / 36 / 50 ms for the
blank, dense and 500-figure scenarios. Raw results are in
`artifacts/drawing-latency/final/`.

### Animation workflow

`tests/drawing-workflow-latency.browser.mjs` builds a 24-frame 1080p drawing
layer at 2× (25 pressure strokes per cel, about 1,000 tiles each) with a
per-frame marker colour, and times each command until a render shows that
frame. Both builds ran back to back on a loaded workstation, so absolute times
are higher than in quieter runs; see `artifacts/drawing-workflow/`.

| WebGPU | Baseline | GPU residency |
| --- | ---: | ---: |
| Flip to a resident drawing, p50 / p95 | 249 / 451 ms | 23 / 47 ms |
| Flip to an evicted drawing, p50 / p95 | 968 / 1,112 ms | 23 / 33 ms |
| Scrub at 24 fps: frames shown before the next seek | 2% | 100% |
| Undo / redo of a 300 px stroke | 122 / 163 ms | 75 / 91 ms |
| Fill click on a frame evicted by memory pressure | click ignored | 337 ms to commit |

An evicted cel is shown from its still-resident GPU tiles while its CPU store
decodes; the retained image is discarded if history changes that cel first.
When memory pressure evicts a published store, the GPU notes the slots that
hold its exact tiles. Reopening that cel for editing reads them back instead
of decoding PNGs, keeps each tile's published PNG bytes, and re-adopts the
slots, provided every slot is still intact and the published base revision
matches; deferred history then applies as usual. Otherwise the cel decodes,
now with the in-place tile inflater described in [DRAWING.md](DRAWING.md).
A load that a pointer is waiting on overtakes queued display and prefetch
decodes and is never superseded by them; only the decode already running
finishes first. In the cold-edit measurement this took the fill from 843 ms to
337 ms after the click (297 ms on Canvas 2D).
A saturated pool — here 24 dense cels filled the 512 MiB budget — evicts
full-resolution tiles first, so restores favour recently shown cels. Three alternating 12-frame Canvas 2D runs measured warm
flips of 224–267 ms against 265–347 ms for the baseline and cold flips of
820–962 ms against 952–1,178 ms, so the fallback did not regress.

The workflow benchmark also exposed a controller defect present in the
baseline: a click or tap released while its cel was still loading was
discarded, because the browser's routine loss of pointer capture after
release was treated as a cancellation. Fill clicks on evicted cels did
nothing. Only a cancellation before release now abandons the pending gesture.

### Repeat under heavy background load

A later matched session of the final code ran while unrelated processes held
the CPU near 96%, so both builds are slower in absolute terms; the comparison
still uses identical conditions (`artifacts/drawing-latency/final-2/`,
`artifacts/drawing-workflow/final-2/`). On WebGPU, stroke latency p50 was
12–17 ms against 66–2,262 ms for the baseline, and p99 39–138 ms against
186–3,269 ms; the 300 px dense brush recorded one 175 ms main-thread task in
the GPU build. Resident and evicted flips took 34 and 26 ms against 360 and
1,471 ms, every scrubbed frame was shown in time against 8%, fill took 1.6 s
against 3.9 s, and the cold-edit fill committed in 0.55 s where the baseline
ignored the click. The Canvas 2D fallback was also faster than its baseline
(stroke p50 44–74 ms against 59–98 ms; flips 217 and 595 ms against 279 and
1,023 ms).

Profiling the pen-up window found and removed four costs that would otherwise
stall after every stroke: re-uploading tiles already on the GPU, rebuilding
every reduced level after a presentation-only refresh, hashing the published
tile blob as shared renderer artwork on each relayout, and re-rasterizing the
Properties brush preview whenever the inspector refreshed.

## Limits

Headless measurements on one workstation do not establish behaviour on other
GPUs, drivers or physical tablets. The pool's upper bound is GPU memory in
addition to the CPU drawing budgets. The GPU brush's pixels can differ from
the worker brush by one 8-bit step, so the renderer in use can change the
least significant bit of committed paint; history, saving and reopening
preserve whichever bytes were committed exactly. Publication, playback
preparation and cold cel decoding still run through the existing workers;
editing an evicted cel waits for its decode.
