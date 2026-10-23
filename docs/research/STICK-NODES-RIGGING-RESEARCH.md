# Stick Nodes rigging study

Studied 2026-09-13 to improve StykAnimate's native rigging. This is a behavioral
study and an independent implementation, not a claim of full Stick Nodes compatibility.

## Evidence inspected

- [Official 4.2 connector/rigging guide](https://sticknodes.com/new-version-4-2-0-the-connector-joint-update/).
- [Original Smart Stretch guide](https://sticknodes.com/new-version-2-4-8-the-one-stretchy-boi-update/).
- Embedded [connector demonstration](https://sticknodes.com/images/420_connectors3.mp4),
  [node-property demonstration](https://sticknodes.com/images/420_node_properties3.mp4),
  and [combined rigging demonstration](https://sticknodes.com/images/420_rigging.mp4).
  Inspected the clips in the browser, including the bow/string attachment,
  absolute/relative lock explanation, floaty tween comparison, and mechanical rig.
- Local `Desktop/sticknodes-project-lab/research/private/Stick Nodes Pro_v4_3_2.apk`.
  SHA-256: `76a1dc2ca38817caa681f139629851ae85ef9cb055507c3dad1a39acf6adaecb`.
  Read its bundled `assets/i18n/SNBundle.properties`, the existing targeted
  decompilations, and independently decoded `R2.h` and `R2.a` using the supplied JADX 1.5.6
  CLI. The working output is local and ignored under `artifacts/rig-research/`.
  No APK, vendor source, or vendor assets were added to the app.

The guides establish that connectors hold two endpoints together and expose a
sliding attachment joint. They can connect to other connectors. Smart Stretch
deforms attached detail lengths and angles. Historically, the controlling node
had to be movable/stretchy, and affected detail nodes static/stretchy. The newer
angle locks maintain an orientation relative to the main node or nearest movable
ancestor. Their combination supports mechanical motion, muscle bulges and
projected constructions. Floaty changes tween trajectories and is a separate
feature from stretch propagation.

## What the APK clarified

The property serialization names identify the controls independently of obfuscated
method names: `mSmartStretchMultiplier`, `mSmartStretchResetImpulse`,
`doNotApplySmartStretch`, the angle-lock properties, and connector
`mSmartStretchAncestralValue`.

| Mechanism | Inspected behavior | Relevant implementation region |
| --- | --- | --- |
| Multiplier | Linear change relative to neutral; negative results reverse the axial component | `R2.h.f0` |
| Reset impulse | Uses this node's own axis, then restarts descendant traversal from it | `R2.h.f0`, `R2.h.o`, `Q2` |
| Ignore deformation | Retains the current part's dimensions while allowing traversal to continue | `R2.h.f0`, `k4` |
| Propagation | Static-node traversal, explicit connector handling, reset boundaries | `R2.h.o` |
| Connector output | Sliding-node distance relative to its default, multiplied by received ancestral stretch | `R2.a.g0`, `M7` |
| Angle lock | Main-node or nearest non-static ancestor orientation; relative rotation multiplier with whole-figure rotation compensation | `R2.h.M7`, angle property serialization |

This distinguishes three easily confused operations: leaving one part rigid,
stopping a branch, and restarting the axis. Reset is **spatial**, not an event
at an animation frame. It does not simply set the incoming amount to one.

For an input ratio `r` and a part multiplier `m`, the linear response is
`s = 1 + (r - 1) * m`. Split a part's vector into components parallel and
perpendicular to the impulse axis; scale the parallel component by `s` and retain
the perpendicular component. Reconstruct its length and angle. For example,
`r = 0.5, m = 2` collapses the parallel component; `m = -1` expands it to 1.5
times its neutral size. An exponential influence gives different results.

The APK contains small nonzero numerical clamps and mutable pose traversal.
StykAnimate instead evaluates a bounded, deterministic pose from native channels
for every frame. Zero and negative deformation do not depend on the previous frame.

## StykAnimate changes

- Enabling Smart Stretch sets up the current branch in one history command and
  includes parts drawn later. It does not require users to set two extra flags
  on every detail. A nested ordinary driver starts its own scope.
- Each affected part has a signed multiplier, **Keep rigid**, **Stop at this joint**,
  and **Reset impulse here**. Reset reorients the impulse for that part and its
  descendants; stopping does not silently deform downstream parts.
- A connector can derive stretch from **Anchor distance**, **Slide position**, or
  **Distance × slide**. When it receives a parent impulse, its own output combines
  with that input. Its endpoints remain authoritative. On new automatic drivers,
  changing a bend without moving the anchors does not change distance-based stretch.
- **Figure**, **Movable parent**, and **World** angle locks retain a reference
  orientation. Parent mode supports a signed rotation multiplier within the
  figure, so counter-rotating parts still follow whole-figure rotation. Locked drags
  stay on the locked axis; changing the lock angle is an explicit rig setting.
- Drawing on a deformed branch inverts its local deformation, so the new line
  appears where it was drawn. Signed inverse posing also works after reversal.
- Setup uses compact labels, named anchors, canvas pick icons, and grouped
  settings. Persistent explanations were removed from the inspector and tester;
  essential gesture hints remain in tooltips and errors remain visible.

Existing explicit bindings retain their exponential influence until a new linear
multiplier is set. Existing connector rigs retain their earlier span response.
No automatic migration changes their existing artwork. The older `orientation`
setting remains available for connector attachment compatibility; it is distinct
from a true angle lock, which also survives ancestor pose edits.

## Useful constructions

| Construction | Setup |
| --- | --- |
| Detailed limb | Enable the limb's driver; leave skin/details stretching; keep nails or accessories rigid |
| Muscle bulge | Connect two arm anchors, enable distance-driven stretch and inverse width response |
| Telescoping mechanism | Attach details to a slider; use slide-driven stretch to coordinate extension |
| Folding umbrella | Connect supports and use opposite multipliers on corresponding spokes |
| Counter-rotating control | Parent angle lock with rotation multiplier -1 |
| Projected panel | Axial stretch for depth foreshortening, rigid/world-locked offsets for independent vertical detail |
| Rig branch with a new direction | Reset impulse at the corner instead of adding a separately managed driver |

These are construction recipes, not claims that arbitrary rigs solve general IK.
The native dependency graph rejects cycles. A full IK solver, floaty tweening,
Stick Nodes absolute-distance/reversed slider modes, and translation of every
imported `.nodes` constraint are outside this change. Connectors retain the
existing normalized slide channel and curve support.

## Verification

`tests/rig-smart-stretch.test.mjs` adds independent-vector checks, axis reset and
stop cases, nested-source checks, drawn-chain inverse mapping, lock modes,
gesture undo, validation, reference remapping, native save round trips, and
nonsequential synchronous/async poses. Existing rig tests remain in
`tests/rig-constraints.test.mjs`.

`tests/rig-smart-stretch.browser.mjs` exercises the controls in the running app
and captures light, dark and compact layouts. `tests/rig-constraints.browser.mjs`
retains the existing setup, canvas drag and tester flows. The renderer test now
includes signed/reset stretching, a relative lock and a slide-driven connector,
in addition to the eleven current example rigs. All fourteen samples matched editable and
prepared WebGPU pixels exactly; SVG differences stayed within the existing
antialiasing tolerances. Evidence: `artifacts/rig-smart-stretch/` and
`artifacts/rig-constraints/`.

The geometry benchmark measured 2.40 / 8.86 / 48.75 ms medians for 1,000 / 5,000 /
20,000 connector segments on Node 24.11.0. The eleven example medians were 0.05–0.94 ms.
These are local geometry timings, not an end-to-end frame-rate guarantee. The
20,000-segment case still exceeds a synchronous 60 FPS editing budget.

The final targeted run passed all 69 rig/geometry tests, including 18 new
Smart Stretch and angle-lock tests. The rig setup, insertion and new-control
browser flows passed without page errors; light/dark screenshots were inspected.
The full suite at the final behavior change passed 1,968 of 1,969 tests. The
remaining failure is the existing `scrub-backpressure.test.mjs` playhead-input
assertion (`''` versus `'12'`), also present before these changes. Repository
syntax, changelog and whitespace checks passed. The shared checkout contains
other ongoing work, so these counts describe that recorded run.
