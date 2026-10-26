# Native brand assets

Generated from `assets/brand/svg/stick-app-icon-dark.svg` using the checked-in
resvg WASM renderer. Run `npm run build:brand`; packaging regenerates these assets.

- `stick.png`: 512px window/Linux icon.
- `stick-1024.png`: high-resolution source raster.
- `stick.ico`: 16, 20, 24, 32, 40, 48, 64, 128, and 256px; 32-bit alpha DIBs
  with transparency masks at smaller sizes and lossless PNG at 256px.
- `stick.icns`: PNG representations from 16 to 1024px, including Retina types.

All blue tiles have transparent corners. Standalone in-app marks use the transparent
root `symbol.svg`, while the browser favicon uses the root `mark.svg` tile.

`win.signExecutable: false` intentionally leaves these beta builds unsigned while
electron-builder applies their icon and version resources. Do not restore
`signAndEditExecutable: false`: it also disables the application's icon update.
Setup, uninstaller, and installer header icons use the same ICO. File associations
inherit the application's icon. No code-signing service or paid dependency is used.
