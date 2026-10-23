# Builder evolution proposals

The remaining items below are proposals. Implemented in this iteration: click-to-chain with one-step undo; joint, midpoint, axis and equal-length snapping; direct flip controls; cached branch-copy previews; and [native connectors, Smart Stretch and isolated rig testing](RIG-CONSTRAINTS.md). Tangent snapping, general geometric constraints and freehand stroke fitting remain future work. They build on the current native figure model, reusable library, polygon fills, branch operations, joint editing, IK controls, and command history. Priority reflects expected value for figure construction, not a measured delivery estimate.

## Recommended next work

| Priority | Proposal | What the user does | Why it matters | Architecture and acceptance target |
| --- | --- | --- | --- | --- |
| 1 | Tangent and angle snapping | Continue a curve tangentially or match a selected angle. | Extends the implemented construction snaps to curved and mechanical figures. | Add ranked candidates to the existing gesture index; preserve screen-space tolerance and Alt bypass. |
| 2 | Paired symmetry | Establish an axis and pair two limbs, then build or reshape one side while the other follows. Allow a pair to be broken. | Makes arms, legs, faces and mechanical figures much faster. | Store explicit stable-ID pairs and an axis; do not guess from proximity on every drag. Preview both sides, reject conflicting links, and commit atomically. Existing flips remain one-shot operations. |
| 3 | Branch parts library | Save an arm, hand, eye or accessory with an attachment joint; drop it on a target joint. | Reuses useful pieces instead of copying entire figures and deleting the rest. | Extend the existing library with a branch asset and anchor metadata. Remap IDs, reuse media, preserve internal fills, and insert through the existing command layer. |
| 4 | Freehand chain fitting | Sketch a short stroke and choose joint spacing before finishing. | Extends the implemented click-to-chain pen for tails, hair and ropes. | Fit samples off-thread, keep approximation error visible, and commit through the existing batch command. |
| 5 | Match and distribute | Select parts and match length, thickness, bend or style; distribute joints along a branch. | Improves existing property editing without adding more permanent panels. | Extend sparse branch commands. Explicitly choose absolute matching versus proportional scaling; preserve poses and unrelated overrides. |

A useful first release would combine snapping, paired symmetry and branch parts. They remove repetitive construction work while keeping the interface compact.

## Improvements to existing workflows

- **Split at the pointer:** preview the inserted joint before clicking, with midpoint as the default and a precise fractional position available on demand. Extend the existing split command; retain every original endpoint and posed frame.
- **Visible branch scope:** while Branch is active, show a quiet tint on the actual affected descendants. Preview the same set used by the command, including the command-specific rules for polygons and media.
- **Drag-to-reparent preview:** ghost the destination connection and show whether world position will be preserved. Invalid cycles should never look like valid drop targets.
- **Property sampling:** pick up a segment’s appearance and apply only selected attributes, such as thickness and caps. Keep topology and transparency unchanged unless explicitly included.
- **Repeat last operation:** repeat a supported builder command with its last parameters; add distance/angle stepping for copies. Store a small command recipe, not a replay of pointer events.
- **Named parts and selection sets:** make hands, feet and facial features easy to select. Allow arbitrary names for non-humanoid figures; anatomical presets should remain optional.
- **Builder command search:** a temporary searchable palette for commands and optional favorites. Display current shortcuts and whether a selection is required. Use the same command registry as toolbar/menu actions.
- **Connection repair:** detect disconnected roots, coincident joints, tiny segments and suspicious duplicate fills. Offer previews and individual fixes, never an automatic destructive cleanup on load.

## New tools worth prototyping

**Taper brush.** Paint a thickness profile down a selected chain with a preview and smoothing. First version can edit existing per-segment widths; truly continuous taper needs an explicit representation and export policy.

**Arc and curve pen.** Draw a curve and convert it into a chosen number of editable segments, preserving native bend semantics where possible. Keep the original draft until conversion is accepted, and show the approximation error.

**Proportion controls.** Set shoulder width, head size or limb ratios on a user-defined rig template. This should compile to ordinary edits; it must not force all figures into a humanoid schema.

**Construction constraints.** Add equal-length, parallel, perpendicular, fixed-angle and pinned-point relationships. Begin with one-shot match commands. Persistent constraints require explicit conflict handling and a bounded solver before becoming a default workflow.

**Repetition tool.** Create a linear or radial array of a branch for fingers, spokes, teeth or mechanical parts. Preview count and spacing; enforce native capacity limits before committing.

**Outline from skeleton.** Generate a 2D silhouette around connected segments using width profiles and controlled joins. Prototype as a reversible derived preview; preserve the editable skeleton and define how the result becomes native fills.

**Reference tracing.** Lock a local reference image behind the construction view, adjust opacity and trace over it. A later assisted version could suggest joints and connections, but every suggestion should remain editable and require acceptance before changing topology.

## Techniques and technology to evaluate

1. **Draft → preview → commit:** maintain lightweight temporary construction geometry; commit one editor command when the user accepts. Cancellation must discard the draft without cloning the full document.
2. **Stable-ID metadata:** symmetry pairs, named parts, anchors and constraints should reference native IDs. Every split, deletion, reroot and import needs a defined mapping policy.
3. **Spatial indexing:** use a grid or tree for nearby joint/edge queries; cache by figure revision. Keep pointer work bounded and avoid scanning every segment on each move.
4. **Worker geometry jobs:** curve fitting, silhouette generation and topology validation should run outside the UI thread. Cancel obsolete work and reject results for stale document revisions.
5. **Local geometric solvers first:** solve small explicit construction constraints deterministically. Evaluate WASM only after profiling demonstrates a bottleneck that JavaScript workers cannot meet; adding a runtime is not itself a performance improvement.
6. **GPU previews as derived data:** consider GPU-assisted silhouette/selection previews only when CPU profiling justifies them. Editable figure records and CPU/native export semantics remain authoritative.
7. **Assisted tracing as research:** evaluate local model inference for suggesting line centerlines and joints. Measure editability, correction time and false connections, not just visual similarity. This is a later experiment, not a dependency of the first improvements.

## Success criteria

Measure completion time, corrections, undo count and pointer travel for three repeatable tasks: build a symmetric character, attach a reusable hand, and construct a 20-joint tail. Include small and dense imported figures. Check native save/reopen, one-step undo, cancellation, stable IDs, retained poses and memory after repeated sessions. Set performance budgets from baseline measurements rather than promising a frame rate before implementation.

## Design precedents

Krita exposes snapping to nodes, orthogonal alignments, extensions and intersections. These are useful precedents for construction targets; the proposed StykAnimate ranking, hysteresis and equal-length snapping are our design extensions. [Krita snapping documentation](https://docs.krita.org/en/user_manual/snapping.html).

Blender’s armature Symmetrize mirrors selected bones using naming conventions. The proposal here goes further with persistent explicit pair metadata and a live preview; it is not a claim that StykAnimate already has that feature. [Blender Symmetrize documentation](https://docs.blender.org/manual/en/4.4/animation/armatures/bones/editing/symmetrize.html).
