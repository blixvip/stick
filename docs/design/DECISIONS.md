# Sign-off decisions for revision 4.3 (2026-09-27)

Decided by the orchestrator under the owner's standing direction ("simple at a glance, super powerful, nothing lost or
buried; do not change core systems/functionality; no inspector keyframe diamonds; no canvas selection ring/halo/name
tags; no default-behaviour changes"). These override experience.md §11 "Default if not approved" where they differ.

## Approved (UI-layer, additive, reversible)
- Every new default key in experience.md §11's conflict table (palette Ctrl+P/Ctrl+Shift+P/F1, F6/Ctrl+F6 regions,
  Ctrl+1..4 panels (desktop only), Ctrl+\ focus mode, Ctrl+Alt+L layout, Ctrl+Alt+M move panel, Ctrl+' grid, Ctrl+G go to
  frame, W tweener, Q transform (Draw), scoped J/K/Y in Build, [ ] joint cycling in Animate/Build). No existing default
  binding changes; user bindings always win. Full screen gets no default key.
- Pinning commands to quick actions (`pins` per workspace in the layout store).
- Drag a swatch onto a limb / an effect onto a figure / an image onto a joint, hit-tested through the existing pick
  path, with the cursor badge + message slot only (NO live canvas preview, NO outline/glow/highlight: veto).
- The "Slow · N of M fps" message from a throttled read of today's playback stats.
- View popovers (Grid & guides, Motion path settings, Onion) close on the next outside click, with the 4.3-defined
  pass-through (on canvas it only selects/deselects; never a drag, pose, joint edit or box selection).
- 800×600 stage floor of 45% with the inspector docked from 801px.
- A message that does not fit beside the view cluster takes its own line under the stage header for its moment.
- Revision 4.3 timeline height for today's layer capacity (24px pinned Camera/Scene rows, 4½ / 4 content slots).
- Segment surgery in Animate via the joint menu's *Edit part ▸* (3 clicks) with the scope line and an Undo message.
- The ink primary shows its glyph only at compact width so the menubar stays docked.

## Deferred (not in this programme; listed as follow-ups for the owner)
- Cel thumbnails in the Advanced grid; filmstrip thumbnails framed on the figures (thumbnail-worker changes + perf gate).
  Keep neutral cels and today's artboard framing.
- Export aspect presets that differ from the artboard; export in the background (pipeline changes). Disabled with a
  reason; progress stays in the export dialog.
- Phase 2 timeline rows; window-bounds memory; cross-window sync; native theme sync (main-process work).
- Construction desk for Build (default change). Build keeps today's white artboard at fit canvas.
- *Ease new keys* (camera session opt-in and the remembered Settings preference): a new animation preference, i.e. a
  functionality change. Keep today's route (double-click the key, pick an easing). Report to the owner as a suggestion.
- Refusing/clamping camera edits past the last frame: today's behaviour (the frame-1 key is rewritten) is a core bug,
  not a UI decision. Leave behaviour unchanged; report the bug to the owner.
- A live drop preview on the canvas (renderer involvement; close to the canvas-cue veto).
