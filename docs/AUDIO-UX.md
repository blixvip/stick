# Audio interface design

The audio interface should make adding and aligning sound easy while preserving
the animation workspace when sound controls are not needed. The September 2026
revision replaces the permanent audio bar and separate mixing panel with one
Audio icon and mode-appropriate editing space.

## Research and decisions

This is a review of published interaction guidance and an established animation
editor, followed by implementation and automated interaction checks. It is not
a user usability study.

- [Nielsen Norman Group: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
  describes revealing specialized controls when needed while keeping the entry
  point clear. The timeline therefore has one music-note button with a tooltip,
  accessible name and pressed/expanded state. Audio starts closed; a small dot
  indicates existing recordings. Opening a document never forces the tab open.
- [Adobe Animate: How to use sound](https://helpx.adobe.com/animate/desktop/multimedia-and-video/using-sounds.html)
  documents sound on dedicated timeline layers and placing imported audio on
  the timeline. Advanced therefore places audio beneath animation layers on
  the existing time axis. One scroll area, ruler, zoom and playhead keep the
  relationship between sound and poses visible.

Those sources motivate the direction; the following details are StykAnimate
design decisions rather than claims established by the sources:

- Simple swaps its filmstrip area for an Audio tab, retaining the transport and
  exposing a horizontal scrollbar when needed, synchronized to filmstrip time.
  Advanced reveals sound lanes in its existing viewport and opens selected clip tools in a compact popover from its toolbar, as Simple does.
- The outer timeline resize handle and Expand action work in both modes. There
  is no second panel resize handle or saved audio expansion preference.
- Import and New track stay visible while editing sound. Clip volume and common
  operations appear with a selection; exact source timing and fades remain in
  Details. Dragging, trimming, fades, keyboard transfers and undo retain their
  existing command ownership.
- Closing restores keyboard focus to the Audio icon and returns space to
  animation. Visibility is transient UI state: it neither changes history nor
  interrupts playback. Switching modes within a document keeps that state;
  loading another document resets it.

## Acceptance checks

`tests/audio-navigation.browser.mjs` checks the clean initial layout, explicit
opening/closing, focus return, shared Advanced coordinates after scrolling and
zooming, contextual clip controls, uninterrupted hidden playback, Simple tab, compact
layout and ignoring the old persisted expansion preference. Native save/reopen
coverage in `tests/audio.browser.mjs` also checks that controls stay closed when
a project containing recordings is loaded.

`tests/audio-ux.browser.mjs` exercises track transfers, cancellation, undo,
new-track drops, direct fades/volume, native file drop placement, shared viewport
resizing, snapping and drag autoscroll. Its 4,096-clip fixture checks that DOM
size remains bounded by visible rows and that pointer events coalesce into
animation-frame paints. Scrolling below all animation rows must leave the shared
ruler available without indexing nonexistent layer labels.

Screenshots under `artifacts/audio-navigation/` and `artifacts/audio-ux/` cover
the default workspace, empty tab, both modes, compact layout and scrolled dark
theme. These source-workspace checks do not certify a packaged desktop release.

The selected clip controls use the Audio clip controls button in both modes;
there is no persistent clip footer. Volume, split, duplicate, delete and Details
remain accessible there and through existing clip interactions. The audio toolbar
reduces labels at compact widths. Its time mapping follows the Simple zoomable
filmstrip or Advanced grid, preserving waveform/clip alignment while zooming.
