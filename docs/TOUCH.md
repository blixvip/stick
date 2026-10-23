# The touch interface (phones and tablets)

StykAnimate has a second interface for fingers and pens. It is the same editor with the
same document, commands, panels, undo history, renderer, workers and file formats, laid
out and operated differently. Nothing about a project depends on which interface edited it.

The desktop interface (mouse, trackpad, keyboard) does not change. Every rule below is
scoped to `:root[data-input="touch"]`, and every script path checks the same state.

## When it is on

`src/touch/touch-mode.mjs` decides, and writes the result on the root element:

| Attribute | Values | From |
| --- | --- | --- |
| `data-input` | `touch` or `pointer` | Settings › Interface › Touch interface: *Automatic* (default), *On* or *Off*. Automatic is on where the primary pointer is coarse (`(pointer: coarse)`): phones, tablets, and an iPad with a keyboard attached. A laptop with a touch screen has a fine primary pointer and keeps the desktop interface. |
| `data-form` | `phone` or `tablet` | The window's shorter side: under 600 CSS px is a phone. |
| `data-orient` | `portrait` or `landscape` | The window: landscape when it is at least as wide as it is tall. |
| `data-touch-layout` | `phone-portrait`, `phone-landscape`, `tablet-portrait`, `tablet-landscape` | The two above, as one name the stylesheets use. |

`?ui=touch` or `?ui=desktop` in the address overrides the setting for that page load, for
trying the other interface on any device. `src/theme-bootstrap.js` writes the attributes
before the stylesheet loads, from the stored setting, so a phone never paints the desktop
layout first; the module keeps them current as the window turns or the setting changes.

## Layouts

The editor keeps one set of elements. The dock host (`src/shell/dock-host.mjs`) still owns
which panel shows where; in touch mode it solves for the workspace's own box and passes the
solver (`src/shell/layout-solver.mjs`) a `touch` input, whose profile (`SHELL_METRICS.touch`)
folds the side panels into sheets by form factor, sizes the tool bar and the timeline header
for a finger and, on an upright phone, lays the tools along the stage's bottom edge. The touch
stylesheets arrange the regions; `src/touch/touch-shell.mjs` adds the few controls only touch
needs.

### Phone, on its side

```
┌───────────────────────────────────────────────┬────────┐
│ stage header: tool options · View ▾ · zoom     │ ≡   ⤓  │ the mark, Export
│ ┌──┐                                           │ ●   ↶  │ Animate, Undo
│ │  │ tools          STAGE                      │ ●   ↷  │ Draw, Redo
│ └──┘                                (modifiers)│ ●   ☰  │ Build, Properties
├────────────────────────────────────────────────┴────────┤
│ + ◀ ▶ ▶  00:03  [Key − + Copy Paste … ]    onion  ⋯     │ timeline header and actions
│ Layer 1 │ ● ● ● ●[●]○ ○ ○ ○                              │ the selected row, finger-tall
└──────────────────────────────────────────────────────────┘
```

- The top band becomes a two-column wing on the right: the StykAnimate menu over the three
  workspaces, Export over Undo, Redo and Properties; a session's Done, Test rig or Cancel take
  whole rows under them. The document's name and Save are in the menu (File).
- The tools float on the stage's left, in two columns where one does not fit.
- The timeline stays docked under the stage: one row of its header (the transport, then the
  frame actions or, in Simple, the frame bar) over the ruler and the selected layer's row,
  kept in view; a vertical swipe over the rows reaches the others. On a phone First frame,
  Loop, Playback range and Audio are rows of Timeline ⋯, so Select can be tapped beside
  the transport without swiping the frame actions. See [The timeline](#the-timeline).
- Properties, VFX and Library open as a sheet beside the wing, the stage's whole height.
- Menus opened from the wing open beside it, toward the stage.

### Phone, upright

```
┌─────────────────────────────┐
│ ≡  Kick combo •    ↶ ↷  ⤓  │ band
├─────────────────────────────┤
│        View ▾  38%  ⤢      │ stage header (in Draw, the brush bar takes a row under it)
│                             │
│     STAGE (full width)      │
│                  (modifiers)│
│ [ + ▸ ⋀ ✋  tools ...     ] │ the tool bar, along the stage's bottom edge
├─────────────────────────────┤
│ + ◀ ▶ ▶  00:03  onion  ⋯   │ timeline header
│ Key − + Copy Paste … Select │ frame actions (Simple: the frame bar, under the cards)
│ [ layers and keys ........ ] │ timeline body, 47% of the height, its grip resizes it
├─────────────────────────────┤
│ Animate  Draw  Build  Props │ tab bar
└─────────────────────────────┘
```

- Width is what an upright phone lacks, so the tools lie along the stage's bottom edge (one
  row that scrolls sideways) and the artboard gets the phone's whole width.
- The workspaces and Properties move to a tab bar under the thumb (the elements are moved,
  never copied, and move back in every other layout).
- The timeline stays docked whatever the height tier, at 47% of the workspace. In Advanced
  the frame actions take the header's second row; Simple puts its cards first and the frame
  bar under them (on a short phone its controls are one row that swipes sideways).
- Properties, VFX, Library and Structure rise as a bottom sheet above the tab bar, which
  keeps Properties at hand to close it again.
- Menus and popovers (the colour picker, keyframe easing, onion skin) open as sheets from
  the bottom edge, over a veil; a submenu leads back with a Back row.

### Tablet

Both orientations keep the desktop's arrangement at touch size: the band on top, the tools
floating on the stage, the timeline docked at the bottom, its header 52px. The band folds its
words in the desktop's fold order (measured at touch size, with the menubar always in the
mark), so Export and Properties stay on screen. The inspector stays docked while the stage
keeps 560px, and otherwise opens as a tall sheet from the band's Properties button, never a
40px strip. Upright, the timeline takes a third of the height and its header moves the frame
rate (the Scene's Rate) and First frame (Timeline ⋯) out of the way. The frame actions take
the header's second row.

## The timeline

A fingertip covers several frames, so the timeline on touch never asks a finger to hit one
frame's cell. The playhead is fixed at the middle of the grid and time slides under it: a
sideways swipe scrubs (with momentum), and the frame that settles under the playhead is the
current frame. The grid pads both ends by half its width, so frame 1 and the last frame reach
the middle too. Rows are 48px tall (the Camera and Scene rows and the ruler 44px), frames start 30px wide,
and a pinch zooms between 10 and 72px around the playhead.

The header's actions row works on the selected layer at the playhead (`timeline-scrubber.mjs`):

| Button | Does |
| --- | --- |
| Key / Remove | Adds a key at the playhead, or removes the one there (never frame 1's) |
| Shorter, Longer | Holds the frame one frame less or more (the later keys move with it) |
| Copy, Paste, Easing | As the frame's menu |
| Select | Makes the playhead's frame one end of a range: scrubbing moves the other end |
| More | The frame's menu |

With a range the row becomes Done (first, so it never needs a swipe), Earlier, Later, Copy,
Cut, Paste, Delete, Easing and More, and a handle stands at each end of the range: dragging one
moves that end, past the other end too, and time slides when it nears the grid's edge. Where
the row is longer than the window it swipes sideways and fades at the edge that has more.

Every command is the desktop's (the same history entries and undo). The Simple timeline keeps
its cards, compact on touch: the frame's number on its thumbnail and a slim hold bar under it.
On a phone on its side its frame bar is the header's actions row; upright it sits under the
cards.

## Sizes

Touch targets are at least 44×44 px on phones and 40×40 px on tablets. The touch tokens
(`src/styles/tokens.css`) raise the control and icon sizes and the type a step under
`:root[data-input="touch"]`, so every component of the kit follows. Text fields use 16px text,
so iOS never zooms the page when one takes focus. Keyboard shortcuts are not shown in menus
or on a held button's name.

The page respects the safe areas (`env(safe-area-inset-*)`): nothing interactive sits under a
notch, a camera cut-out or the home indicator. The installed app (`black-translucent` status
bar) draws under the status bar and keeps its controls below it.

## Gestures

| Where | Gesture | Does |
| --- | --- | --- |
| Stage | One finger | The current tool, as the mouse's left button |
| Stage | Two fingers | Pan and zoom (`src/canvas-pinch.mjs`); the first finger's edit is cancelled |
| Stage | Two-finger tap | Undo |
| Stage | Three-finger tap | Redo |
| Stage | Press and hold | The context menu of what is under the finger (the right-click menu) |
| Stage | Double tap | A double-click (select connected figures, or a branch) |
| Stage | A modifier held or latched, then drag | See [Modifiers](#modifiers) |
| Draw | One finger | Draws, until a pen is used (then a finger pans) |
| Draw | A second finger during a stroke | Takes the stroke back and pinches |
| Any button | Press and hold | Its name; lifting the finger does not press it |
| A tool with variants | Press and hold | Its variants (the corner tick's list) |
| Onion | Press and hold | Its settings |
| Rows, cards, tabs | Press and hold | Their menu (the right-click menu) |
| Advanced timeline | Swipe sideways | Scrubs: time slides under the fixed playhead, with momentum |
| Advanced timeline | Swipe up or down | Scrolls the rows |
| Advanced timeline | Tap | Selects that layer's frame and glides it under the playhead |
| Advanced timeline | Double tap | A double-click: adds a key, or edits a key's easing |
| Advanced timeline | Press, hold, then drag | The mouse's drag: selects frames, or moves the selected keys |
| Advanced timeline | Press and hold, then lift | The cell's menu |
| Advanced timeline | A range's handle | Drags that end of the range |
| Advanced timeline | Two fingers | Pinch to zoom around the playhead, move to scroll the rows |
| Advanced timeline | Swipe the names | Scrolls the rows |
| Simple frames | Swipe, tap, hold | Scroll, select, the frame's menu |
| A bottom sheet | Drag its grip or tab row | Resizes it to a resting height (42%, 62% or 92%), or closes it |
| A side sheet | Swipe toward its edge | Closes it |
| The timeline's edge | Drag its grip | Resizes the timeline |

`src/touch/long-press.mjs` turns a press and hold into the platform's `contextmenu` event,
so every existing right-click menu works without a second implementation. It stands aside
where the browser already sends one (Chrome on Android) so a menu never opens twice, and
swallows only the click of the press it handled.

`src/touch/canvas-touch.mjs` watches the stage's fingers for the multi-finger taps, the hold
and the double tap; `src/touch/timeline-touch.mjs` gives the Advanced grid's own handlers the
press a mouse would have given them (a copy at the same point for the same pointer), so
selection, key moves, resizing and menus keep one implementation. Surfaces that follow the
finger themselves (the stage, the grid, a sheet under drag) cancel the browser's `touchmove`
default: Chrome would otherwise start a fling on release, although nothing scrolls, and
swallow the next tap to stop it.

### Modifiers

The desktop editor uses the right mouse button and the Shift, Ctrl and Alt keys during a drag
(bending a joint, stretching it, adding to the selection, transforming or duplicating a
figure). `src/touch/modifier-dock.mjs` puts them on the stage as a round button in the corner
under the thumb that opens a column of labelled buttons, named for what they do with the
current tool:

| Workspace and tool | Buttons |
| --- | --- |
| Animate, Select and pose | Bend (the right button) · Stretch (Ctrl) · Add (Shift) · Transform (Alt) · Handles (hold R), and Depth (hold D) while the selected figure has 3D parts |
| Animate, Tweener | Add |
| Animate, Edit joints | Bend · Stretch |
| Build | Bend · Stretch · Add (by tool) |
| Draw, Brush | Line (Shift) · Pick (Alt) · Size (Ctrl) |
| Draw, Eraser · Fill · Select pixels · Shapes · Transform | Line and Size · Pick · Add and Subtract · Snap · Add |

Tap a button to latch it (it stays on, highlighted, until tapped again or the tool changes);
hold it with one thumb while another finger drags for a one-off. The round button shows what
is on. On a phone on its side the buttons stand in two columns. While a modifier is on, the stage's touch and pen events reach the editor as if the
button or key were held: the trusted event is stopped at `#viewport` and a copy with the
modifiers goes to the same target, so bending, stretching, selecting and drawing keep one
implementation. A mouse keeps its own buttons and keys.

### Drawing with a finger

In Draw, a finger draws until the device's pen is used; after that the pen draws and a finger
pans, as in drawing apps. A second finger landing during a finger's stroke takes the stroke
back and pinches, so a two-finger tap undoes the previous stroke. Settings › Interface ›
*Draw with a finger* chooses *Until a pen is used*, *Always* or *Never*. *Always* also draws
with a finger in the desktop layout, where *Until a pen is used* leaves a finger panning. Draw
navigates with the shared `src/canvas-pinch.mjs`, which cancels the finger's provisional edit
before pinching; a pen that is down or used in the last 700 ms rejects touches from a palm.

## Menus, sheets and dialogs

- `placeFloating()` (`src/ui/anchor-position.mjs`) is where every menu, popover and picker is
  placed; on an upright phone it presents them as sheets (`data-present="sheet"`), and a box
  meant to drop below the band opens beside it where the band is a wing (`besideWing`).
- On a phone every dialog fills the window, Settings included, with its actions at the bottom.
- On touch a dialog that is not about typing opens with focus on itself, so the keyboard does
  not cover half of it until a field is tapped; prompts (Rename, Save as) still take the caret.
- The StykAnimate menu lists File, Edit, View, the workspace's menu and Help as submenus and
  starts with *Search commands…*, which reaches every command a key reaches.
- The stage header folds its view toggles into one View menu on a phone.

## The page

In touch mode the page does not scroll, bounce, zoom or reload itself: `touch-action`,
`overscroll-behavior: none` and (Safari) the `gesture*` events keep the browser's own
gestures off the editor, so a pull down never reloads it and a pinch zooms the canvas, not
the page. Text in the chrome cannot be selected by a long press, and the grey tap highlight
is off; text fields keep both.

## Files

| File | Owns |
| --- | --- |
| `src/touch/touch-mode.mjs` | The decision, the form factor, the root attributes, change events |
| `src/touch/touch-shell.mjs` | The tab bar, the stage header's View menu, sheet grips and swipes, the page's gestures |
| `src/touch/touch-gestures.mjs` | Pure gesture rules: the hold, the slop, double tap, multi-finger tap |
| `src/touch/long-press.mjs` | Press and hold on the chrome: context menus and control names |
| `src/touch/canvas-touch.mjs` | The stage's multi-finger taps, hold and double tap |
| `src/touch/modifier-dock.mjs` | The stage's modifier buttons and the events they shape |
| `src/touch/timeline-touch.mjs` | The Advanced grid's touch adapter (installed by `timeline-navigation.mjs`) |
| `src/touch/timeline-scrubber.mjs` | The touch timeline's centred playhead, scrubbing, range handles and actions row (mixed into `layer-timeline.mjs`) |
| `src/styles/layout/touch.css` | The layouts, the page, the safe areas, the tool bar and the modifiers' places |
| `src/styles/features/touch.css` | The tab bar, the wing, sheets, menus as sheets, dialogs, the timeline and Draw at touch size |

## Verification

- `node --test tests/touch-mode.test.mjs tests/touch-gestures.test.mjs`: the decision, the
  form factors, the solver's touch profile, the gesture classifier, the modifiers' events and
  the sheet heights.
- `npm run test:touch` (`tests/touch.browser.mjs`): the built site in Chromium with touch
  emulation at phone and tablet sizes in both orientations: no chrome cut off by the window,
  finger-sized targets, the sheets, menus as sheets and beside the wing, press and hold, the
  multi-finger taps, the Bend modifier, the docked timeline's scrub, actions, range and pinch, finger
  drawing, and the desktop interface unchanged at 1440×900. `npm run test:pinch` and
  `tests/drawing-input.browser.mjs` cover the pinch, the pen and palm rejection.

Real devices are not part of the automated checks: performance on a phone's GPU and memory,
Safari's own behaviour (it is the engine of every iOS browser) and a real pen need a phone
and a tablet in hand.
