/** Import notices are UI copy; persisted recovery records retain their original diagnostics. */
export default Object.freeze({
  "importNotes.sourceTiming": "Stored poses are imported with source FPS, delays and available tween settings; exact Stick Nodes solvers/effects are not reproduced.",
  "importNotes.constraints": "Constrained source poses are preserved as editable StykAnimate joints; native constraint dynamics are not simulated.",
  "importNotes.legacyBackgroundFit": "The embedded legacy background is retained as a native image background; its original fit settings may differ.",
  "importNotes.textGlyphs": "Unavailable font glyphs use question-mark placeholders; the original text is preserved in asset metadata.",
  "importNotes.textFont": "Text remains editable with bundled Noto Sans outlines; the original Stick Nodes font metrics may differ.",
  "importNotes.spriteDistortion": "Sprite corner distortion is retained in import metadata; the imported sprite uses its affine transform.",
  "importNotes.effects": "Some Stick Nodes GPU effects differ; source effect settings remain recorded in import metadata.",
  "importNotes.joinOffsets": "Offset attachments keep their stored poses. Reattach them with StykAnimate joints to author new attachment motion.",
  "importNotes.cameraDynamics": "Camera position, zoom and rotation are imported; procedural wobble and tracking bindings are retained as metadata.",
  "importNotes.repeats": "Source repeat-loop settings are retained; native repeat-loop control flow is not expanded during import.",
  "importNotes.externalAudio": {
    "one": "{count} sound reference needs its external audio file; names are retained in import metadata.",
    "other": "{count} sound references need their external audio files; names are retained in import metadata."
  },
  "importNotes.unverifiedLayouts": "Best-effort import: untested layouts {profiles}{more} were read using existing version-based rules. Review the result for missing or inaccurate features.",
  "importNotes.additionalLayouts": {
    "one": " and {count} more",
    "other": " and {count} more"
  },
  "importNotes.recoveredIdentities": {
    "one": "Recovered {count} duplicate figure ID in keyframes {frames}. Every figure, join, and layer was preserved. Extra occurrences now have separate identities; review animation transitions around these keyframes.",
    "other": "Recovered {count} duplicate figure IDs in keyframes {frames}. Every figure, join, and layer was preserved. Extra occurrences now have separate identities; review animation transitions around these keyframes."
  },
  "importNotes.additionalFrames": " and more",
  "importNotes.missingImages": {
    "one": "{count} embedded image contains no image data ({names}). Its figures, anchors and animation are preserved, but this image is transparent. The missing artwork must be replaced from its original image.",
    "other": "{count} embedded images contain no image data ({names}). Their figures, anchors and animation are preserved, but these images are transparent. The missing artwork must be replaced from its original image."
  },
  "importNotes.frameList": "{list}{more}"
});
