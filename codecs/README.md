# Desktop codecs

The Python codec modules that read and write Pivot (`.piv`, `.stk`) and StykAnimate files. Development, PyInstaller and electron-builder all use this directory, so release builds work from a clean checkout.

The Pivot format support was reverse-engineered for interoperability; StykAnimate is not affiliated with Pivot Animator.

Rebuild the sidecar (`npm run build:sidecar`) before packaging after changing a codec. Release uploads attach only the built installers, never this directory.
