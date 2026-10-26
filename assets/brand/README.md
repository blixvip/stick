# Stick logos

These SVGs are the source of the app's icons. The mark (code brackets around a running
stick figure with motion ghosts) is drawn as vector strokes, and the wordmark uses outlined
Inter Tight Black Italic lettering (its OFL notice is in `Inter-LICENSE.txt`).
They contain no embedded images, fonts, scripts or network dependencies.

- `stick-symbol-white` (with glow), `stick-symbol-black`: the standalone mark on a transparent background.
- `stick-horizontal-white`, `stick-horizontal-black`: wide lockups.
- `stick-stacked-white`, `stick-stacked-black`: the mark centred above the wordmark;
  `stick-stacked-primary` is the white glow lockup on its black square.
- `stick-app-icon-dark`, `stick-app-icon-light`: rounded-square app icons.

Brand colours: black #050507 with glowing white #FFFFFF (glow #C9D6FF); ink #0C0D12 on light
surfaces; the light app icon uses #F5F7FA. White variants are meant for dark surfaces. Use the
symbol alone at small sizes; the wordmark is not meant to be read at favicon scale.

`npm run build:brand` rasterizes `svg/stick-app-icon-dark.svg` into the native
PNG/ICO/ICNS files in `desktop/assets` and copies that tile to the favicon `mark.svg` and the
in-app `symbol.svg`. Packaging runs it automatically, and native icons keep their alpha outside
the rounded corners. `node scripts/build-web-icons.mjs` renders the web install icons from `mark.svg`.

`node scripts/verify-brand-assets.mjs --assets-only` checks transparency and size variants.
Without the flag it also compares a packaged Windows build's icon resources with the generated ICO.

The Stick name and logo identify the official project; see "Trademarks" in the root README.
