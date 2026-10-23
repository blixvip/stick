# Tutorials

A tutorial teaches by having the person do things in the real editor, one step at a time. It runs in Animate,
with the Advanced timeline, on a practice animation of its own. It adds no row to the window: its strip takes
the stage header's start, where the scene's name is. The design is the Home concept's lesson,
moved into the stage header so it costs no height on small screens.

## The five tutorials

| Id | Title | What the person does |
| --- | --- | --- |
| `tour` | Look around | the stage, the tools, deselect and select, the panels, the timeline, the workspaces |
| `canvas` | Move around the canvas | zoom, pan, Fit, 100%, the grid |
| `posing` | Pose a figure | select, bend a joint, move the origin, Undo, Flip |
| `timeline` | Make it move | scrub, Add frame, a second pose, Play, Stop, onion skin |
| `panels` | Panels and commands | the Library and Properties tabs, Search commands, View › Layout, Home |

## How it shows

`src/tutorials/tutorial-presenter.mjs`:

- **The strip** (`stageHead.setLesson`): the title and step count (it opens the details), the step dots, the
  step's one sentence, Back, Show me, Next and Leave. A step that waits for the person shows Skip instead of
  Next, so nobody is held on a step they cannot do. When the step is done the strip turns green, says so,
  and moves on after 1.3 s. At the end it offers the next tutorial not done yet and Back to Home.
- **The caption**: where the sentence does not fit the strip on one line (a narrow stage, a small window) it
  shows whole on a line of its own just under the header, over the stage's margin. It is never cut.
- **The details**: a popover with every step, the current one's longer explanation and its shortcut,
  Start over and Leave. A finished step can be visited again.
- **The mark**: a ring around the control or region the step is about, or a dot on the exact joint to drag. It
  follows its target while things move, glides between targets and pulses when a step begins.
- **Show me**: a pointer of its own acts the step out (a press, a drag, a scroll, a key) without sending any
  event: the editor is exactly as it was afterwards. A step that waits plays it once by itself after 7 s, and
  its mark pulses again every 11 s.
- **Messages**: a message that would cover the strip takes its own line under the header instead
  (`solveMessage({keepStart})`). Outside Animate (Draw and Build keep the header's start for their own bar) the
  strip hides and a message says the tutorial waits, with Back to Animate and Leave.

## How it runs

`src/tutorials/tutorials.mjs` starts, feeds and ends a tutorial.

- **Starting** leaves Draw or Build, opens a new practice animation as a project tab (the `new` command, beside
  the person's projects), or starts over on the practice animation in front when nothing changed it since. It
  names it Practice, switches to the Advanced timeline (and gives the person's mode back at the end), selects
  the Select tool, shows Properties where the panels are docked, the timeline if hidden, sets the selection the
  tutorial wants and fits the view.
- **The practice animation is never unsaved** while a tutorial runs: what a lesson changes is not work to lose,
  so closing asks nothing and no recovery copy is written. Editing it after the tutorial is ordinary editing.
- **Reading the editor**: the engine reads the editor only when something happens (a press, a key, the wheel,
  an edit, a command, an overlay opening or closing): one reading per frame at most, and twice more at 320 ms
  and 1.2 s for what settles late (playback starting, a zoom gliding). Nothing polls between events.
- **Ending**: Leave, Home, another document coming to the front, or starting another tutorial. Finishing
  records the tutorial's id in `tutorialsDone`.

`src/tutorials/tutorial-engine.mjs` is pure. A step is done by what the person changed since it began: the
engine reads the editor when a step begins and compares later readings with it (`done(now, start)`), so a
state the editor happened to be in never counts. `now.ran` holds the commands run during the step.

`src/tutorials/tutorial-probe.mjs` reads the editor as plain values (zoom, view offset, fitted, selection,
pose, origin, undo and redo, playhead, key count, playing, onion skin, panels, the palette, …) through lazy
getters, so a step pays only for what it compares.

`src/tutorials/tutorial-targets.mjs` finds a step's target on screen: a selector, the artboard, the practice
figure's bounds, its origin, a joint, or the timeline's ruler (the ruler alone: Camera and Scene's pinned rows are
rows of their own). A target that is not on screen marks nothing.

## Writing a tutorial

`src/tutorials/tutorial-catalog.mjs` is data. A tutorial is `{id, icon, tint, minutes, titleKey, lineKey, setup,
steps}`; a step is `{id, target, sayKey, moreKey, shortcut, done, doneKey, demo}`. Words live in
`src/locales/en-features/tutorials.mjs` as `tutorials.<id>.<step>.say|more|done`. A step's sentence says one
thing and names the control as the interface names it. `sayKey` may depend on the interface (touch, the zoom
gesture, whether a shortcut is bound); `{shortcut}` is the step's command as the person bound it.

Keep a tutorial to four to eight steps, two to three minutes, with at least one thing to do.
`tests/tutorials.test.mjs` checks the catalog's shape, that every key exists with only `{shortcut}`, and that
each `done` reads only what the probe offers.

## Checks

- `tests/tutorials.test.mjs`: the engine and the catalog.
- `tests/tutorials.browser.mjs`: all five tutorials in the real editor with real pointer and key input, plus
  Skip, Show me, Back, Leave, the next tutorial, pausing in Draw, the caption of a narrow header, and the
  timeline mode and unsaved state given back.
- `tests/stage-head.test.mjs`: messages make room for the strip.
