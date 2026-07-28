# Origami engine research (2026-07-13)

Why the crease-table fold engine keeps failing, what exists in the origami-software
world, and the options for rebuilding the visualizer. Compiled from a five-agent
research sweep (theory/landscape, Origami Simulator internals, flat-folder,
Rabbit Ear, fold-sequence animators) plus a review of this repo's history.

**Goal recap:** a table with rows of fold steps that can be animated to watch the
paper fold into shape. Faces must move in sync via shared vertices (no tearing).
Paper passing through paper mid-motion is acceptable. As much as possible should
be computed statically. Ideally an LLM can author the fold table straight from a
crease diagram.

---

## 1. What this repo has tried (git archaeology)

Five architectures, each abandoned when the crane got harder:

| Era | Approach | Key commits/PRs |
|---|---|---|
| 1 | Live crease-pattern engine in three.js, then a "table of physical fold steps" driving it | `005a40c`, `1a1beb0`, PR #59–60 |
| 2 | Stepwise folding with rests; then rigid kinematics ("let the sheet break") | `59a7b16` PR #61, `b8e12ef` PR #62 |
| 3 | Reflection stitching ("fold by instructions: reflect along two points on known edges") | `d302375`, `875a176`, PR #63–64 |
| 4 | Hand-solved vertex-mechanism squash collapse for the square base | PR #65–67 |
| 5 | Static crease table: `compileFolds` cuts faces per crease row, heuristic hinge ownership, spanning tree; `createFoldPlayer` interpolates dihedrals and averages welded vertices | `dd28809` onward, PR #68 (`claude/origami-crane-petal`) |

State of approach 5 at stop time: square base/bird base/neck/tail work as flat
snap-states, but the wing step is kinematically dead (its crease chain fails to
sever the flap through every ply, so the spanning tree bypasses its hinges), the
final state carries 0.26 units of edge strain, and the model renders upside-down.
Every new crease re-cuts the sheet and re-derives hinge ownership globally, which
is why adding head/wing creases regressed the previously-working square base.

## 2. Why approach 5 fails structurally (theory)

- **Non-rigid steps cannot be interpolated kinematically.** The bird base contains
  degenerate flat-foldable vertices; petal folds and inside-reverse folds have *no*
  rigid-panel intermediate states. Interpolating dihedral angles along a spanning
  tree must therefore tear or strain mid-motion — it is a theorem, not a tuning
  problem. (Refs: Akitaya/Demaine/Horiyama/Hull/Ku/Tachi, "Rigid foldability is
  NP-hard", JoCG 2020, arXiv:1812.01160; "Robust Folding of Elastic Origami",
  arXiv:2109.10989 — researchers fold a *modified* bird base because the
  traditional one is not rigidly foldable.)
- **Layer ordering is the real hard problem.** Bern & Hayes (SODA 1996): global
  flat-foldability and valid layer ordering are NP-hard, even given a valid
  mountain/valley assignment. Our per-crease "hinge ownership" heuristic is an
  ad-hoc, non-local approximation of this, recomputed from scratch on every
  re-cut.
- **Authoring is brittle with no verifier.** One missed ply in a crease chain
  silently kills a step (dead hinge, bypassed tree). Nothing checks a row's
  geometric validity when it is written.

## 3. Theory cheat-sheet (what matters for a visualizer)

- **Flat-folding map:** a flat fold is a piecewise isometry. Fix a base face; every
  face's placement is the composition of reflections across the creases along any
  path in the face-adjacency graph (Kawasaki guarantees path-independence). Exact
  folded coordinates for the whole sheet in O(faces), zero physics, zero
  divergence. This is the engine inside ORIPA, flat-folder, and Rabbit Ear.
- **Local flat-foldability checks:** Kawasaki–Justin (alternating sector angles sum
  to 180°) and Maekawa–Justin (|M − V| = 2 per interior vertex). Linear time;
  these are the per-row verifier primitives.
- **Layer ordering as CSP:** Akitaya/Demaine/Ku (OSME 2024) reduce layer ordering
  to boolean variables over overlapping face pairs with four constraint families —
  taco-taco, taco-tortilla, tortilla-tortilla, transitivity — solved by
  propagation + component-wise backtracking. Fast in practice at model scale.
- **Huzita–Justin axioms:** the seven single-fold alignments (complete for single
  folds). Useful as the vocabulary for "fold A to B"-style commands and for
  constructing crease lines from landmarks.
- **Fold sequences in FOLD format:** `file_frames` with `frame_parent` /
  `frame_inherit` encode a sequence as diffs on a parent frame — the standard
  interchange for step sequences.

## 4. Tool landscape

Research clones live outside the repo (scratchpad); pin commits noted for re-fetch.

### flat-folder — Jason Ku (MIT) — pinned `d500048` (2026-06-25)
https://github.com/origamimagiro/flat-folder
- ~4,600 lines vanilla JS, ES modules, **zero dependencies, no build step**.
- Core (`math.js`, `avl.js`, `constraints.js`, `conversion.js`, `solver.js`,
  `note.js`, ~1,800 lines) is **DOM-free — verified running headless in Node 22**.
- Exact folded geometry: `X.V_FV_EV_EA_2_Vf_Ff` (conversion.js:338) walks a face
  spanning tree composing reflections; returns folded coords `Vf` + face parity `Ff`.
- Layer orders: overlap cells → boolean variables per overlapping face pair
  (`X.EF_SP_SE_CP_CF_2_BF`) → taco/tortilla/transitivity propagation + component
  backtracking (`src/solver.js`). Outputs FOLD-spec `faceOrders`.
- Inputs FOLD/CP/OPX/SVG; outputs FOLD with `faceOrders`.
- **Measured (this container, Node):** crane.svg 72 faces / 892 variables →
  137 ms end-to-end; ≤120-face models: median setup 14–25 ms, solve <1 ms.
- Naming is terse (`I1_I2_2_O1` convention) — read `src/NOTATION.txt` first.
- Paper: Akitaya, Demaine, Ku, "Computing Flat-Folded States", OSME 2024.

### line-folder — Jason Ku (MIT) — pinned `14d027e` (2026-07-09)
https://github.com/origamimagiro/line-folder
- **The per-step machinery, already built.** Vendors flat-folder's core verbatim.
- `MAIN.make_fold` (main.js:645): cut faces along a fold line drawn on the folded
  state; `COMP.reflect` (compute.js:216) reflects the moving set; **carries the
  previous step's faceOrders into the next solve as the initial assignment**
  (main.js:686); classifies each resulting state (Pureland / inside-reverse /
  outside-reverse / open-sink / closed-sink / complex).
- Exports multi-frame FOLD: one `file_frames` entry per step with folded
  `vertices_coords`, `faces_vertices`, `faceOrders`, plus `lf:line`, `lf:points`,
  `faces_lf:group` describing the fold op. `examples/crane.fold` has 18 frames.

### sequence-folder — Jason Ku (MIT) — pinned `e5978d7` (2026-06-25)
https://github.com/origamimagiro/sequence-folder
- Companion step viewer. Recovers each frame's CP by unfolding (main.js:99);
  `linearize` (main.js:266) converts pairwise faceOrders into total layer indices
  via topological sort — exactly what z-nudged rendering needs.

### Origami Simulator — Amanda Ghassaei (MIT) — pinned `7855983` (2025-11-19)
https://github.com/amandaghassaei/OrigamiSimulator · origamisimulator.org
- Compliant dynamics: triangulated sheet, three force families — axial edge
  springs, angular crease springs driving each dihedral toward
  `foldPercent × targetAngle`, and face-shear constraints. Explicit Euler/Verlet,
  entirely in GPU fragment shaders (~690 lines GLSL inlined in index.html;
  orchestration `js/dynamic/dynamicSolver.js`). Paper: Ghassaei/Demaine/
  Gershenfeld, 7OSME 2018.
- **One indexed shared-vertex mesh** (model.js:291–342); triangulation diagonals
  become flat "facet" creases so facets can bend — the source of the paper look.
- Fold percent is a single uniform, but per-crease target angle *and stiffness*
  live in a re-uploadable RGBA texture (`u_creaseMeta`, `updateCreasesMeta()`,
  dynamicSolver.js:481) → **per-step crease groups is a ~20–40 line change**
  (ramp active group's targets; keep future creases at k≈0).
- ~100 solver sub-steps/frame; built-in strain-error metric usable as a
  convergence gate for offline baking. Deterministic given fixed dt/steps → can
  bake vertex keyframes headless (Playwright WebGL, or port ~300 lines of GLSL
  force math to CPU TypeScript).
- **No self-collision** — tucks pass through paper.
- No CPU solver in practice (static/rigid solvers are commented out).
- **robbykraft/OrigamiSimulator** pinned `152c7a7` (2024-11-02): TypeScript
  rewrite, solver decoupled from UI, FOLD-only input, deps just earcut +
  three@0.169. Same `u_creaseMeta` layout, so the per-group change applies there.

### Rabbit Ear — Maya/Robby Kraft (**GPL-3.0**) — pinned `b717948`, npm `rabbit-ear@0.9.4`
https://github.com/rabbit-ear/rabbit-ear · rabbitear.org
- The most complete origami library: FOLD-native graph ops;
  `foldGraph`/`foldLine` (src/graph/fold/foldGraph.js) folds along a line
  *through the folded form*, splitting faces, transferring new vertices back to CP
  space, assigning M/V, and incrementally updating faceOrders, returning a change
  delta; folded coords via `makeVerticesCoordsFolded`; working layer solver
  (`src/layer/`, bird base 20 faces solved in 34 ms here); all 7 axioms with
  in-polygon clipping and validation (src/axioms/) — the best LLM-facing
  construction API found; per-crease `edges_foldAngle` animation verified.
- JS + shipped .d.ts, zero deps, 206 test files. Dormant since mid-2024 (author
  active on rabbit-ear-app). Dev branch has unreleased `simpleFold`/`reverseFold`/
  `squashFold` ops worth mining.
- **License blocker:** eventable is BSD-3-Clause; importing GPL code at runtime
  makes distributions effectively GPL. Safe uses: design reference, or build-time
  generator whose *data output* ships.

### Others (reference only)
- **FOLD format + `fold` npm** (MIT), Demaine/Ku: https://github.com/edemaine/fold —
  spec for geometry, M/V/F/B/C assignments, `edges_foldAngle` (±180, +=valley),
  `faceOrders` `[f,g,±1]`, `file_frames` sequences. The interchange everything
  else speaks.
- **Origuide** (GPL-3.0, Python+JS, dormant): https://github.com/maciekmm/origami ·
  origami.wtf — master's thesis; the closest architecture precedent: per-step
  Ghassaei-style solve done offline, precomputed frames played in three.js.
- **ORIPA** (Java, GPL) / **Oriedita** (Java, active) — CP editors with folded-form
  estimation; FOLD import/export; upstream authoring tools, not embeddable.
- **Tachi's Rigid Origami Simulator / Freeform Origami** — closed freeware; the
  4OSME paper "Simulation of Rigid Origami" is the recipe if a rigid-fold player
  is ever wanted (fold-angle velocities projected onto the constraint Jacobian's
  null space).
- **TreeMaker** (Lang) — CP *design*, irrelevant to visualization.
- **foldMation** (closed web app) — fold-command DSL (fold-to, inside-reverse,
  crimp, pleat over named bases); the best existing template for an LLM-authored
  fold-table grammar.
- **Academic:** Miyazaki et al. 1996 (first step-based origami simulator; stack of
  flat polygons + explicit layer bookkeeping); **Akitaya et al. 2013** ("Generating
  folding sequences from crease patterns", SIGGRAPH poster) — derives a diagram
  sequence from a finished CP by unfolding one flap at a time: the canonical
  crease-diagram → fold-table algorithm, same facewise machinery as flat-folder.
  2026 LLM work (OrigamiBench arXiv:2603.13856, Learn2Fold arXiv:2603.29585):
  LLMs fail multi-step folding without a deterministic geometric verifier in the
  loop — author-then-verify is mandatory.

## 5. Options considered

**Option 1 — exact static keyframes (flat-folder / line-folder core, MIT). CHOSEN.**
Each table row = one fold: a line (two points or landmark refs) + moving side
(+ optional target angle for final decorative poses). Per step, statically: cut
faces along the line through the folded state, reflect the moving set, solve the
layer order seeded from the previous step, z-order by linearized faceOrders.
Animation = rotate the moving set rigidly about the fold line 0→180°, snapping to
the exact next state. Key insight making this tear-free: after the cut, *every*
edge between a moving and a static face lies on the fold line in the folded
state, i.e. on the rotation axis — the motion is a perfect compound hinge with
shared vertices; the only artifact is paper-through-paper mid-swing (accepted).
End states are computed, never integrated → divergence is impossible by
construction. Fully deterministic, no physics, no WebGL dependency.

**Option 2 — baked compliant dynamics (Origami Simulator model, MIT).**
Table row = crease group + target angle + timing; bake vertex keyframes at
compile time by ramping per-group targets through the relaxation solver. Most
paper-like motion (facets bow); handles non-rigid steps gracefully; but final
states are near-exact rather than exact, stiffness needs tuning, and it needs the
GLSL force math ported to CPU or headless WebGL baking.

**Option 3 — hybrid (end-state).**
Option 1's exact states and verifier as ground truth; Option 2's solver used only
for in-between frames (seed at state N, activate step N+1's creases, blend into
exact state N+1). No published tool does this end-to-end; all pieces are MIT.

**Decision (user, 2026-07-13): start with Option 1.** No backward compatibility
with the old engine — `src/origami.ts` and the crease-table samples are dead code
once replaced, and should be deleted. The table schema is designed fresh; Option
2's baked in-betweens can slot behind the same table later as polish.

## 6. Option 1 implementation plan

1. Vendor flat-folder core (`math.js`, `avl.js`, `constraints.js`,
   `conversion.js`, `solver.js`, `note.js` @ `d500048`, MIT headers kept) under
   `src/flatfolder/`; treat as frozen third-party (no reformatting).
2. Adapt line-folder's step loop (`compute.js` + the relevant parts of
   `main.js:make_fold`) into a typed `src/fold-engine.ts`:
   `foldStep(state, line, side, opts)` → next state {Vf, faces, faceOrders,
   moving-face set, crease segment} with faceOrders carry-over; plus
   sequence-folder's `linearize` for per-face layer indices.
3. New fold-table schema (editable table rows), designed fresh: `step`, fold
   line (`p1`, `p2` in the *current folded view*, or landmark refs later), `side`
   sample point marking the moving half, optional `kind`/`pick` to disambiguate
   among enumerated layer states (simple vs reverse fold), optional final `deg`,
   schedule `at`/`dur`. The old engine (`src/origami.ts`), its player, and the
   crease-table crane/frog samples are deleted once the new path renders.
4. Player: per beat, either hold an exact state (z-nudged by layer index) or
   animate the current step's moving set rotating about its crease line; single
   shared-vertex position buffer, per-face z-nudge applied at render time.
5. Verifier surface: reject rows whose line misses the model, whose fold has no
   valid layer order, etc., with row-level error messages (this is what makes
   LLM/human authoring reliable).
6. Crane sample expressed as ~18 line-fold rows (line-folder's
   `examples/crane.fold` is the reference sequence); later, the frog.
7. Later (not now): Akitaya-2013-style automatic sequence generation from a full
   crease pattern; Option 2 in-betweens.

## 7. Failure modes to watch (from the research)

- line-folder enumerates *multiple* valid layer states per fold; animation
  continuity requires seeding from the previous step's orders (it does this) and
  the table needs a disambiguator when >1 state survives.
- flat-folder's snap-rounding epsilon auto-tuner can fail on dirty input lines —
  surface its "precision error" path as a row error rather than a crash.
- Non-flat final angles (wings at 90°) only work as terminal steps — no flat
  solve exists on top of a 3D pose; validate that ordering.
- Uint16-style index limits and per-face triangulation live in our renderer, not
  the core — keep face polygons intact in the engine and triangulate only at
  render time.

---

## 8. Spike results (2026-07-13, this branch)

Vendored the core (`src/vendor/flatfolder/` @ d500048, `src/vendor/linefolder/compute.js`
@ 14d027e, both MIT, import paths adjusted only) and replayed line-folder's
`examples/crane.fold` (17 recorded folds) headless in Node:

- **16 of 17 steps replay exactly**: folded geometry matches the recording
  (up to the old recorder's per-frame renormalization, recovered as a tracked
  similarity transform), the recorded layer order is found among my enumerated
  states, and the animation axis invariant (every moving/static shared vertex
  lies on the fold line) holds at every step. Whole replay runs in seconds.
- Fold-table rows extracted in a stable unit-square frame:
  `line [u,d] + sheet-space move markers + kind + pick`, with kind ∈
  {Pureland, Inside Reverse} and pick ∈ {0, 1} throughout — the disambiguation
  surface is tiny in practice.
- **Step 17 of the recording is invalid under the current solver**: its stored
  faceOrders violate a taco-tortilla constraint on the recorded geometry itself
  (verified by feeding the recorded orders into `SOLVER.initial_assignment`),
  and 358 of 1344 order variables aren't covered by the stored orders — the
  example predates current constraint code. Not an engine bug; the crane
  sample's final fold must be authored fresh.
- Recorder-vs-current version skew also explains the per-frame normalization;
  the new engine keeps one stable world frame and never renormalizes.

Engine mechanics validated: `split_FOLD_on_line` carries sheet coordinates
through splits; `get_groups` + sheet-space markers select single plies
unambiguously (a sheet point names exactly one face); `filter_clicked_and_reflect`
run twice with identical maps carries both folded and sheet coords;
carry-over `faceOrders → BA0` seeding keeps per-step enumeration tiny
(≤ 33 states on the crane).

---

## 9. Option 3 implemented (2026-07-13, soft in-betweens)

`src/fold-relax.ts`: a ~200-line CPU port of the Origami Simulator force
model — axial springs on every triangulated edge, discrete-hinge angular
springs driving each crease's dihedral to a target, kinetic damping
(velocities zeroed at kinetic-energy peaks), explicit integration with dt
from the stiffest spring (hinges enter as k/h²). Guards that mattered:
floor the hinge lever arm (a transiently degenerate triangle otherwise
kicks the mesh into orbit — one frame hit |x| ≈ 17,000 before the guard)
and clamp per-iteration displacement.

Integration: `foldStep` now emits the crease network with per-edge
dihedral targets before/after the fold (from the carried orders with the
movers' parity mirrored, and from the solved orders; empirically
calibrated sign: 'V' is negative in the hinge convention — verified by a
single-hinge micro-test after the first cut had the torque sign backwards
and exploded). `compileFoldTable` bakes non-Pureland steps: 16 keyframes,
seeded by the rigid swing at t≈0.05 so each flap breaks symmetry toward
the side it lands on, largest static face pinned, endpoints eased into the
exact states (smoothstep over the first/last 15%). Playback samples the
bake — no physics at runtime.

Numbers on the crane: compile 2.6 s (10 soft steps), peak transient edge
strain 15.6 % on one pocket edge mid-reverse-fold (the paper must bow —
reverse folds have no rigid path), endpoint error ~1e-4 before blending.
The collapse and neck folds visually reproduce the old hand-tuned
choreography's pocket-opening quality, from table rows alone.

---

## 10. Soft motion, take 2 (2026-07-13): what worked and what didn't

Iterated with per-step screenshot strips. Findings:

- **Shallow folds (≤ ~20 faces) relax beautifully** — the square-base
  collapse's pockets billow open and press flat; this is where the
  compliant solver earns its keep.
- **Deep-stack reverse folds (neck/tail/head, 44–60 faces, 8+ overlapped
  plies) resist relaxation.** Five attempts, all read as crumpling:
  uniform stiffness (whole body blossoms open), differentiated stiffness
  (stiff ratios make the ODE stiff — explicit relaxation under-converges;
  strain 15% → 107% at ratio 8), local pinning of everything away from the
  action (over-constrains, tears at the free/pinned boundary),
  choreographed targets (pocket flanks open sin(πt) then press — best of
  the five, point visibly sweeps through, body still splays), pocket
  scoping via the solved layer overlaps (differently messy).
- **Shipping rule: soft bake only for completing non-Pureland steps with
  ≤ SOFT_MAX_FACES (20); everything else keeps the rigid swing.** Clean
  everywhere, paper-like where the solver is competent, compile 0.85 s.
- **`kind: "crease"` rows** (cut all plies along a line, fold nothing, no
  timeline slot) are in — note that pre-creasing a fold's own line is
  redundant (every fold already cuts all plies along its line); crease
  rows matter for bend lines elsewhere.
- **The remaining path to soft deep reverses** is the analytic route, not
  tuning: a symmetric inside reverse fold is a 1-DOF rigid mechanism
  (flat-foldable degree-4 vertices) — parameterize by the spine angle,
  flanks and reverse creases follow in closed form. Moderate work,
  deterministic, no solver.

## 11. Analytic reverse-fold mechanism (2026-07-14, src/fold-mech.ts)

The analytic route from §10 works, and better than hoped: **the whole deep
reverse fold is a 1-DOF rigid mechanism with a closed form, no tuning
parameters at all.**

Structure. Cut the crease graph at (a) the step's changing creases (the
new fold-line creases and the flipping seam), (b) pressed creases on the
spine line, and (c) for models welded shut by earlier reverse folds, the
hinge/ridge/spine lines of those folds (escalating through the fold
history, most recent first). What remains are rigid assemblies in mirror
pairs: two flanks joined along the spine, and point pairs (the active
point plus one pair per slaved earlier reverse) each hanging off its
parents by a hinge line and joined to its partner along a seam. Plies on
one side of a point weld into one slab (they hinge to the same flank along
the same line, so they cannot move apart).

Kinematics. The flanks open ±β about the spine (a book opening). Every
other pair has ONE angle φ about its hinge, fixed by "the pair's seam
stays in the mirror plane z=0" — one linear equation in cos φ, sin φ:

- the active point's seam tip sits ON the spine, so φ=0 is always a root
  (the point rides its flank) and the folding branch is the tan-half law
  **φ = 2·atan2(b, a)** — the classic degree-4-vertex relation;
- a slaved earlier reverse has its OTHER pole pinned instead (its
  pre-reverse tip sat on the spine), so φ=π is always a root and its
  moving branch is **φ = 2·atan2(−a, b)** — single-valued in β: it
  un-presses as the book opens and exactly retraces as it closes;
- β* is where the active branch meets the trivial one (b crosses zero, or
  the linkage's solvable domain ends — same bracket). For flat-foldable
  models this is the fully-open state: **rigid reverse folds really do
  pass through the open book**, which is also how diagrams draw them.

Drive β = β*·sin(πt): the model opens, the point flips through at the
apex, everything re-presses. Closure is machine-exact (tears ~1e-10 on the
44–60-face neck/tail/head), endpoints land exactly on the solved states,
and a 16-frame bake costs ~10 ms per step.

Root choice: any pair can anchor the world frame — every rooting drives
the same 1-DOF shape curve — so we root at the biggest pair to keep the
model steady on screen (rooting at the neck to fold the head sends the
body tumbling around it).

Shipping rule now: completing non-Pureland steps ≤ 20 faces bake the
relaxed soft motion (§10), deeper ones bake the mechanism, and anything
the mechanism can't decompose (no flipping seam, unpaired assemblies)
falls back to the rigid swing.

---

## 12. Consolidated ledger: what worked, what didn't (through 2026-07-14)

For whoever picks up the next solver investigation — the shortest useful
history. Details in the section referenced.

### Worked, now load-bearing

- **Exact flat-state engine on the vendored MIT core** (§8, PR #75).
  One stable world frame; folds as reflections; layer order solved by
  taco/tortilla propagation seeded from the previous step's carried
  orders (keeps enumeration ≤ 33 states on the crane). Sheet-topology
  vertex indices are the tearing-proof foundation everything else sits on.
- **The fold-table dialect** (step / p1,p2 in the fixed unit-square frame
  / sheet-space move markers / kind / pick / at,dur,to). Sheet markers
  name exactly one ply — the only unambiguous way to pick a flap out of a
  deep stack. Kind+pick as *post-hoc filters over enumerated solved
  states* (not as instructions) means a row can never fold "wrong",
  only fail loudly.
- **Per-flap fold direction voted from the solved stacking** (PR #83):
  connected moving flaps are rigid bodies; each gets one rotation sense
  from side-weighted layer-order votes against overlapping static faces.
  (A single per-step scalar mirrors nothing — the two crane wings need
  opposite senses in one step.)
- **Continuous z-nudges**: display height lerps `layersFrom → layers` with
  a program-constant gap/midline. Carrying the pre-state stacking through
  splits (parent lookup by sheet centroid) is what removes boundary pops.
- **Hybrid motion routing** (§10, §11): rigid hinge for simple/held steps,
  compliant relaxation for shallow non-simple steps (≤ 20 faces), the
  analytic rigid mechanism for deep reverse folds, rigid fallback when
  the mechanism can't decompose. Route by step character, don't force one
  motion model to do everything — every attempt at a universal motion
  model has failed in this repo.
- **Closed-form mechanism for reverse folds** (§11): mirror-pair
  decomposition + tan-half laws + history-driven escalation. Zero tuning;
  machine-exact closure. The dead ends before it (§10's five relaxation
  strategies) were all attempts to *tune* around what is actually a
  well-posed kinematics problem.
- **Physics guards that mattered** (§9): hinge lever-arm floor, per-step
  displacement clamp, kinetic damping, dt from the stiffest spring with
  hinges entering as k/h². Time budgets, not iteration counts.

### Didn't work (do not retry without new information)

- **Hand-authored crease-table engines** (§1–2, eras 1–5): interpolating
  dihedrals through non-rigid steps is a theorem-level dead end, and
  global re-derivation per row made authoring regress previously-working
  steps.
- **Relaxation tuning for deep stacks** (§10): uniform stiffness,
  stiffness ratios (explicit integration under-converges — strain got
  *worse*, 15% → 107%, at ratio 8), local pinning (tears at the
  free/pinned boundary), choreographed pocket targets, overlap-scoped
  pockets. All five read as crumpling. The lesson: when 8+ plies overlap,
  a soft solver has no gradient toward the paper-like path; the path must
  be supplied analytically.
- **Soft frames as held poses**: a relaxed mid-frame is not a pose
  (user: "this looks really bad"). Held steps (`to < 1`) must show the
  exact rigid pose — their whole point is the displayed state.
- **|h|-based z with one direction scalar per step**: breaks rigidity for
  line-straddling merged faces and can't mirror simultaneous flaps.
- **Assuming the sample's recorded data is right** (§8): step 17 of
  line-folder's own crane recording violates the current solver's
  constraints. Recorded ground truth needs verifying too.
- **Trusting seed-row tests**: two shipped bugs (PR #76, #78) came from
  tests feeding rows directly to the compiler while the app materializes
  cells through editable-table defaults ("" for strings, 0 for numbers).
  Integration tests must go through `conformRow`/`schemaColumns` — the
  real path.

### Bugs worth remembering (cheap to re-hit)

- Torque sign in discrete hinges: m = k(θ − target), ∂θ/∂x along −n̂1 —
  verified by a two-triangle micro-test; the wrong sign explodes from
  flat and looks like "instability", not "sign error".
- Transiently degenerate triangles kick 1/h forces (one frame reached
  |x| ≈ 17,610) — floor the lever arm before blaming the integrator.
- flat-folder's per-cell CD stacking vs. our display order: linearize
  came out inverted (`n−1−i`); conventions between vendored modules need
  a dedicated test (`layers-vs-CD` in fold-engine.test.ts).
- Flat-state assertions need tolerance (−0, 1.8e-17), not equality.
- Slave-branch root selection near a branch point: nearest-to-previous
  sticks to a stationary root forever (§11's ±π-pinned root). Prefer a
  closed-form single-valued branch over root-picking whenever the
  structure provides one.

## 12b. Paper-clearance metric and motion routing gates (2026-07-15)

"Paper doesn't go through paper" became a measurable contract
(src/tri-clearance.ts + test/util/clearance.ts + test/paper-clearance.test.ts):

- **Depth, not length, is the mess discriminator.** Crossing length
  conflates long thin grazes (a flap sliding into an interleave — reads
  fine) with plunges. Penetration depth in units of the rendered stack
  thickness separates them perfectly: rigid interleave transits ≤ 0.3×,
  page-brushes ~4×, relaxation failures ~9×.
- **Compile-time routing gate** (fold-engine bakeMotion): every bake is
  probed; relax gets 2× stack budget, the mechanism 4.5×, failures fall
  back relax → mechanism (+page escalation) → rigid. Found by this gate:
  collapse4/tuck1/tuck2 relaxation plunged ~9× (never visible in
  screenshots at speed!); collapse4 now takes its mechanism, the tucks
  the rigid swing.
- **Layer offsets must ride the paper.** zOff along world z shears
  through vertical plies (apex shear 1.7–2.2 area units on the deep
  steps). Mechanism bakes now carry per-face offset directions (the
  assembly-rotated ẑ) and a sign-corrected scalar so endpoints still
  land exactly; shear fell 25–40× and exact-coincidence shear is zero.
- **Page-brush crossings are a modeling floor, not a solver bug**: faces
  that span the opening spine WITHOUT a crease there (flatten/turn
  material) cannot avoid brushing through the opposite cover's overhang
  in any rigid decomposition — they'd need to bend (the deferred
  bend-ruling work: split such faces geometrically and hinge the
  overhang). Freed *creased* pages fan at half the book angle
  (fold-mech pageLines); the uncreased pentagons bound the depth at
  ~1.9× stack (world), ~4.3× in display.
- **Stable layer linearization**: topological ties are now broken by the
  carried previous ranks, so faces never swap display layers without a
  solved reason (gratuitous swaps made offset paths cross mid-swing).
  Genuine overtakes (a flap crossing a layer to land beneath it) remain
  single-instant coincidences; the test allows them transiently, never
  persistently.

## 12c. Table folding (2026-07-15)

Real folding happens on a table with the working side up; the display now
honours that:

- **Auto flip-over**: each step's landing side is voted from its flap
  senses; a step acting on the underside turns the whole model over first
  (an animated half-turn about y in the step's opening 30%), exactly like
  a folder flipping the paper. Parity accumulates across steps
  (flipFrom/flipTo per step); exact half-turns are trig-residue-free so
  flat states stay exactly flat.
- **Anchored mechanism**: mechanism bakes hold the table-side cover flat
  (compose every frame with the inverse of that cover's spin — any
  rooting is the same shape curve), so the book opens UPWARD off the
  table instead of breathing ±β through it.
- **Capped opening for deep models** (the "don't unfold the neck to fold
  the head" note): when a deep step carries slaved earlier reverses, the
  book opens only ~35° (MECH_BETA_CAP): open on the trivial branch
  (exact), hold while the point sweeps between branches (the only torn
  stretch, bent across shared vertices — the folder pushing the point
  through), close riding the fold branch (exact). Shallow collapses in
  progress keep the full-open exact motion.
- **Hinge validation**: a fold whose flap boundary leaves the fold line
  is now rejected at compile ("the paper would stretch") instead of
  silently deforming static faces — this caught the cicada's wing
  creases missing their junction vertex by 0.05 (the user-visible
  wrong-way/snap artifact); the wing rows are re-derived through the
  junction.
- **One sampling path**: playback and the compile-time gates share
  sampleStepMotion, so what is judged is exactly what is shown (two
  hand-rolled replicas of the blend disagreed by 2.5x on strain before).
  The relax gate is a teleport guard (displayed strain ≤ 65% — approved
  pocket billow reaches ~60%; frame-lurch artifacts measure far above),
  plus bakeSoftMotion now stores the seed as frame 0 rather than a
  first-relax lurch.

## 13. Testing methodology (what actually catches things)

The verification stack, cheapest first. Every layer caught real bugs the
layers above/below missed; keep all of them for future solver work.

1. **Invariant unit tests** (test/fold-engine.test.ts, fold-mech.test.ts):
   - the 16-fold crane fixture replays with exact face counts and kinds;
   - hinge-axis invariant: every vertex shared by a moving and a static
     face lies on the fold line (this is what makes swings tear-free);
   - integer folds are exactly flat (|z| < tol);
   - **edge-length preservation through every animation frame** — the
     one-line definition of "rigid, no tear, no stretch". Any future
     motion model should pass this or explicitly declare its strain
     budget;
   - endpoint exactness: frame 0 = pre-state, frame N−1 = solved state;
   - determinism (bake twice, deepEqual);
   - convention checks against the vendored core (layers vs CD).
2. **Micro-tests for physics primitives**: a two-triangle single-hinge
   mesh answers "is the torque sign right" in isolation. Never debug
   force models on a 44-face crane.
3. **Structure dumps before kinematics**: for the mechanism, a scratch
   script printed components/adjacency/layer stats per step
   (.scratch/reverse-mech.mts) *before* any motion code was written —
   the pair-tree design fell out of reading those dumps, and the
   locked-vs-free distinction (neck bridges the flanks) was visible
   immediately.
4. **Headless painter renders** (PIL, .scratch/mech-render.py,
   cicada-render.py): fixed camera, per-frame tiles, faces depth-sorted,
   moving pieces tinted. Seconds per iteration; this is where motion
   *quality* judgments happen (crumple vs. paper) and where both
   mechanism rooting decisions were made. Montage strips beat videos —
   they diff visually across iterations.
5. **Numeric motion traces**: per-frame β/φ tables (env-gated MECH_DEBUG)
   found the stuck slave branch in one glance after renders only showed
   "the neck never comes back". When a picture confuses, print the
   angles.
6. **The real app in a real browser** (.scratch/shot.html +
   shot-entry.mts esbuild bundle of the actual runtime + three-scene,
   Playwright on the preinstalled chromium, `window.setShot(beat, yaw)`,
   front+side montages): catches everything the abstract renders hide —
   sample-row plumbing, editable-table materialization, backColor/nudge
   interaction, timing windows. Note the harness's off-by-one (drivers
   pass `beat − 1`); label montage tiles with the *passed* value.
7. **Look at the final model and ask if it is the animal** (user rule).
   After every "done": does the crane look like a crane at each landed
   state and at the end? Several engine-level "successes" failed this.

Process rules that proved out: verify PR state before pushing (a merged
PR got new commits once — never again); check in before rabbit-holing;
hand-authored helper creases in the table are acceptable by design; no
backward compatibility — delete dead code.

## 14. Open problems and candidate next investigations

Ranked roughly by expected value.

- **Wings step (74 faces, 'Complex', held at 0.5)** is still a plain
  rigid swing. It's a held step so the pose is exact, but the swing
  through the body could get the mechanism treatment (two simultaneous
  active pairs — the mechanism currently requires exactly one).
- **Mechanism coverage**: today it handles chains of symmetric reverse
  folds (mirror pairs, one active pair, seams anchored on parent seams).
  Not yet: sinks (closed vertices), swivel/rabbit-ear folds (asymmetric —
  no mirror plane, needs the general two-unknown loop closure instead of
  the one-angle tan-half law), petal folds as a unit, multi-active steps.
  The general tool if the mirror trick runs out: Newton on the loop-
  closure constraints of the degree-4+ vertex network (Tachi's rigid
  origami / Freeform Origami approach) — the mechanism module's pair tree
  is already the right scaffolding to seed it.
- **Mechanism + soft blend**: use the analytic trajectory as a per-frame
  seed/target for a *short* relaxation pass to add organic bow to the big
  open-flip-close motions without letting the solver invent its own path.
  Strictly bounded iterations; endpoint blend already in place. This is
  the most promising route if the exact rigid motion ever reads too
  mechanical.
- **Better soft solver, if ever needed again**: the failure mode was
  explicit integration on a stiff ODE — explicit force dynamics needs
  dt ≲ 2/√k_max, so the stiffest constraint sets the timestep while the
  softest sets convergence time; widening the ratio (rigid faces vs.
  opening hinges) is what drove strain 15% → 107%. The fix is the
  constraint-projection family, which satisfies constraints geometrically
  each step instead of integrating penalty forces: XPBD (per-constraint
  Lagrange multiplier with compliance α = 1/k, an approximation of
  implicit Euler; α = 0 — infinite stiffness — is unconditionally stable,
  so exact inextensibility costs nothing and stretch-crumple becomes
  structurally impossible), projective dynamics (same local projections +
  one prefactorized global solve; this is Kangaroo2's engine — its
  "goals" are projection functions), or implicit Euler outright.
  Determinism survives (fixed iteration counts/order). Caveat that keeps
  this ranked low: projection fixes the integrator, not the energy
  landscape — deep stacks still have no gradient toward the paper-like
  path, so XPBD's realistic role is upgrading shallow-fold quality and
  powering the mechanism-as-seed blend above, not replacing the
  mechanism. Only worth it with a concrete step the current routing
  handles badly — bring a failing screenshot strip as the spec.
- **Fold-table authoring from a crease pattern** (user goal from the
  start: "come up with the fold table if I present a crease diagram").
  sequence-folder (§4) searches fold sequences; even a semi-automatic
  version — propose lines/markers row by row, validate through the
  engine, binary-search reference points like .scratch/cicada-lab.mts
  did with env-tunable parameters — would beat hand-derivation. The
  cicada took ~15 lab iterations mostly spent re-deriving crease
  parameterizations by hand.
- **Layer-aware collision during motion**: mechanism frames are exact but
  plies pass arbitrarily close mid-swing; zOff nudges hide it at landed
  states only. A cheap post-pass separating coincident plies along the
  local normal during baked frames would remove residual mid-swing
  shimmer.
- **The scoped-cluster design (synthesis, 2026-07-14)** — three ideas
  that compose into the strongest candidate if the mechanism's exact
  open-flip-close ever reads too mechanical:
  1. *Static gluing*: fold-mech's weld/cut analysis already computes
     which plies provably move as one slab; feed those clusters into a
     solver as rigid bodies (6 DOF each, ~36 DOF for the neck instead of
     ~300). Internal crumple becomes impossible by construction, and
     rigid-cluster XPBD is a practical implementation of the "Newton on
     loop closure" generalization for asymmetric folds the closed form
     can't do. Glue conservatively-correctly: over-gluing locks the
     mechanism (the neck-bridges-the-flanks lesson); the history-driven
     cut escalation is the existing un-gluing tool.
  2. *Sparse static bend rulings*: paper is developable — curvature
     concentrates along straight rulings, so uniform subdivision is
     wasted DOF. Place a few bend lines statically where the mechanism
     says curvature must live (pocket plies near the spine and fold
     line); `kind:"crease"` rows are already the authoring primitive.
     Fewer DOF also shrinks the constraint-graph diameter, which is what
     Gauss-Seidel convergence scales with.
  3. *Base/embellishment scoping* (Lang's tree theory: a base is a tree
     of flaps; shaping folds operate on one flap): after the base, an
     embellishment fold touches one flap plus its pocket — freeze
     everything else and solve only those plies. This is also why the
     current hybrid routing works at all: traditional sequences put the
     layer-complex work in shallow collapse steps (soft relax) and the
     deep-stack work in point reverses (mechanism).
  Combined — flap-scoped solve + glued clusters + static rulings +
  XPBD projection, seeded by the analytic trajectory — each piece kills
  a documented failure: scoping kills whole-body splay, gluing kills
  crumple, rulings put the bow where paper bows, projection kills the
  stiffness-ratio trap. This is how the head fold could reverse with the
  body staying closed and slightly bowed (the way fingers cheat) instead
  of the rigid theorem's full re-opening.
- **Known non-goals**: universal physics playback (failed twice),
  runtime solving (everything bakes at compile), GPL code (Rabbit Ear
  stays reference-only).
- **The CAD attitude (Rhino/Grasshopper), for reference**: Kangaroo
  (Piker) folds origami as goal-driven constraint projection — hinge
  goals toward target dihedrals + edge-length + developability goals,
  relaxed interactively; its engine is projective dynamics, i.e. the
  same family as the XPBD candidate above. Crane (Suto/Tanimichi,
  Tachi lab) is the rigid-origami attitude in CAD: Newton iteration on
  fold-angle variables with loop-closure constraints around interior
  vertices, plus form-finding. Both are strong exactly where we are weak
  (smooth interactive 3D folding, non-flat target states) and weak
  exactly where we are strong: they are zero-thickness and layer-blind,
  and their constraint Jacobians degenerate at flat-folded states — so
  they avoid the flat↔flat transitions that make up a traditional
  fold sequence. Worth mining for solver tech (constraint projection,
  fold-angle Newton), not for architecture.
