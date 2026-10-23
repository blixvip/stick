# StykAnimate logos

These SVGs are the source of the app's icons. The mark is drawn as smooth vector paths,
and the wordmark uses outlined Inter lettering (its OFL notice is in `Inter-LICENSE.txt`).
They contain no embedded images, fonts, scripts or network dependencies.

- `symbol-blue`, `symbol-black`, `symbol-white`: the standalone mark on a transparent background.
- `horizontal-primary`, `horizontal-black`, `horizontal-white`: wide lockups.
- `stacked-primary`, `stacked-black`, `stacked-white`: the mark centred above the wordmark.
- `app-icon-blue`, `app-icon-black`, `app-icon-light`: rounded-square app icons.

White variants are meant for dark surfaces. Primary colour: #0D99FF. Primary wordmark: #111418.
The light app icon uses #F5F7FA. Use the symbol alone at small sizes; the wordmark is not
meant to be read at favicon scale. `preview.svg` is a specimen sheet of every variant.

`npm run build:brand` rasterizes `svg/stykanimate-app-icon-blue.svg` into the native
PNG/ICO/ICNS files in `desktop/assets`, copies that tile to the favicon `mark.svg`, and copies
`svg/stykanimate-symbol-blue.svg` to `symbol.svg`. Packaging runs it automatically, and native
icons keep their alpha outside the rounded corners.

`node scripts/verify-brand-assets.mjs --assets-only` checks transparency and size variants.
Without the flag it also compares a packaged Windows build's icon resources with the generated ICO.

The StykAnimate name and logo identify the official project; see "Trademarks" in the root README.
