# Sprite image import

PNG, GIF, BMP, JPEG and WebP sprite imports preserve source colors and alpha by
default. Opaque artwork stays opaque, including pixels that match the bottom-left
corner. All background imports also preserve their pixels. The image's actual
byte signature is used for format validation, even when its filename or MIME
label disagrees. No additional import dialog is required.

Pivot-style bottom-left color-key removal is available only through explicit API
opt-in. It removes every exact RGB match across an opaque image, including artwork
inside the sprite; any existing transparency disables that removal.

The existing API remains compatible:

```js
await imageFileToFigure(file, {signal});
await imageFileToFigure(file, {preserveOpaqueBackground: true, signal});
await imageFileToBackground(file, {signal});
```

Explicit `preserveOpaqueBackground: true` retains opaque sprite backgrounds;
`false` requests the bottom-left rule, including for extra image formats. Existing
source alpha always wins. Results remain regular reusable figure/background
objects containing embedded PNG bytes and the original source name.

`media-image-worker.mjs` decodes the image, applies any explicitly requested color key and
compresses the normalized PNG outside the UI thread. The worker returns a Blob;
the caller asynchronously converts it to the existing data-URL asset format.
Native PNG/GIF/BMP headers are checked before allocating decoded surfaces, and
decoded dimensions are checked for every format. Defaults allow 16 Mi pixels,
64 MiB source/normalized PNG bytes and a 120-second timeout. An AbortSignal stops
the worker; successful and failed imports dispose it and its temporary surfaces.
Animated image inputs become a single still sprite rather than animation frames.

Verification:

- Preservation-default regression: both supplied eye images decode and import with
  zero changed RGBA bytes; their rendered previews were visually inspected.
  Media unit tests and the media browser test (including PIV/STK round trips) pass.
  The broader media-worker browser suite passes its import assertions but currently
  times out waiting for an export download, so its full run is not certified for
  this change. The coverage below describes the existing suite and earlier runs.

- Five media unit tests cover factories, undo/redo/serialization, source signatures, preservation defaults,
  explicit options, color-key matching and alpha precedence.
- [Browser checks](../artifacts/media-worker/report.json) decode actual PNG,
  BMP, GIF, JPEG and WebP files; verify transparency, source-alpha precedence,
  background preservation, mislabeled signatures, dimension rejection, cancellation
  and retry. Neither main-thread Canvas nor OffscreenCanvas pixel reads occur
  during imports.
- Actual New and Open interrupt a deliberately deferred image worker through both
  application file-input routes. The worker is terminated before decoding starts,
  its delayed message is cleared, and no image reaches the replacement document.
  Selecting the same image immediately afterward succeeds.
- The actual app file input imports PNG/BMP/GIF without extra prompts. Actual
  PIV/STK Export and the supplied native decoder preserve the normalized PNG bytes
  exactly. The [resulting scene](../artifacts/media-worker/imported-sprites.png)
  was visually inspected.

These checks cover the specified import behavior and byte preservation. They do
not establish every original-Pivot sprite deformation, reflection or sampling
combination.
