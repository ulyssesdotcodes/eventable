// Editor support — the non-view half of the code editor: DSL documentation
// tables, completion sources, and hover-tooltip logic. Anything that builds
// DOM is injected by the view (ui/cm-editor.ts) as a factory.

import { EditorView, hoverTooltip, showTooltip, Decoration, WidgetType, type DecorationSet, type Tooltip } from '@codemirror/view'
import { StateField, StateEffect, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { localCompletionSource } from '@codemirror/lang-javascript'
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { isExprDot, isExprNamespaceDot, isThreeDot, cmCompletionType, completionBoost } from './completion.js'
import { SAMPLES } from './samples.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { LangClient } from './lang-client.js'
import type { LangSignatureHelp } from './lang-service.js'
import type { CodeLanguage } from './editable-tables.js'

// The language surface the editor currently shows; sources read it per query.
// 'bauble' cells hold Janet, so every source below goes quiet for them instead
// of offering JS answers on lisp.
export type GetLang = () => CodeLanguage

export interface DocEntry {
  sig: string
  detail: string
  info: string
}

export const DSL_BUILTIN_DOCS: Record<string, DocEntry> = {
  define:     { sig: 'define(name, fn)',             detail: 'register view',    info: 'Register a named view. fn receives (rand, table) and must return a Table. Views are cooked lazily; deps tracked via table(). table(name, fn) is the same thing by another spelling — and with .outHydra()/.outThree()/… routing, a table needs no name at all.' },
  table:      { sig: 'table(name?, source?)',        detail: 'read / make table', info: 'table("name") resolves a named view (inside a view fn, prefer the fn\'s own `table` argument so the dependency is tracked). table("name", rows | Table) registers a named table without define(); table("name", (rand, table) => …) is define() by another spelling. table() — or table([rows]) — is an ephemeral, unnamed table: chain it and route it to a consumer with .outHydra()/.outThree()/….' },
  math:       { sig: 'math(beat => value)',          detail: 'sample function',  info: 'Sample a numeric function of elapsed beats. Chain .range(beats) to emit rows of { beat, value }.' },
  rows:       { sig: 'rows([{...}, ...])',           detail: 'wrap array',       info: 'Wrap a literal array of plain objects into a Table.' },
  rotate:     { sig: 'rotate(rows, values)',         detail: 'cycle rows under values', info: 'One row per entry in `values` (output length matches `values`), cycling through `rows`: output row i is { ...rows[i % rows.length], ...values[i] }. `rows` is the short repeating base/pattern; `values` the longer array of overrides merged on top.' },
  data:       { sig: 'data(url)',                     detail: 'fetch dataset',    info: 'Load a pre-fetched CSV file by URL into a Table. Files in /data/ are served statically; the runtime fetches them before cooking.' },
  csv:        { sig: 'csv(string)',                  detail: 'parse CSV',        info: 'Parse a CSV string (header row + data rows) into a Table.' },
  json:       { sig: 'json(array | string)',         detail: 'parse JSON',       info: 'Wrap a JS array or parse a JSON string into a Table.' },
  grid:       { sig: 'grid(cols, rows)',             detail: 'XZ lattice',       info: 'Generate a cols×rows lattice of XZ positions as a Table (fields: col, row, x, z).' },
  three:      { sig: 'three.box / .sphere / .light / .camera / .translate …', detail: 'three.js namespace', info: 'The three.js helpers, grouped under one namespace (shorthand: t). Scene primitives three.box/sphere/cylinder/cone/torus/text/light and the generic three.object(shape, props) each build a "create"-row Table — beat 1, at the origin — to concat and .rasterize(). three.points(shape, props) ⇄ three.geometry(points) sample a primitive to point rows and back. three.camera([keyframes]) emits beat-timed camera moves. three.translate/scale/rotate(table, x, y, z) shift a scene table\'s create rows in place. e.g. t.box({ color: 0x4a9eff }).concat(t.sphere({ px: 1 })).rasterize(8).' },
  t:          { sig: 't.box / .sphere / .translate …', detail: 'three.js (shorthand)', info: 'Shorthand alias for the `three` namespace — t.box(...), t.translate(scene, 1, 0, 0), etc. Identical to `three`; use whichever reads better.' },
  physics:    { sig: 'physics(table)',               detail: 'physics scene',    info: 'Load a base scene table into the JoltPhysics engine. Chain .simulate() to run the simulation.' },
  editable:   { sig: 'editable(name, schema, seedRows?)', detail: 'user table', info: 'A user-editable table: rows are edited in the table panel, not computed — every edit is an appended event and the visible table is the fold (see the name·events tab). schema maps column name to "number" | "string" | "boolean" | "code" (or a string[] for an enum dropdown); code cells open in this editor, and declare their language via { type: "code", language: "hydra" } so completions match (default the DSL). seedRows fill the table when first created.' },
  origami:    { sig: 'origami()', detail: 'folding paper', info: 'A sheet of paper folded by a table of fold steps, each solved exactly. Chain .steps(table) — one row per fold: p1/p2 two points "x,y" on the fold line (drawn on the current folded paper, unit-square frame), move sheet-space marker(s) for the flap(s) that swing, kind/pick to choose the move when a fold is ambiguous ("simple", "reverse", "sink", …), at/dur/to its timing. Then .spawn({ id, color, … }) for the scene create row and .sequence() for the beat-timed keyframes. Every row is verified: a fold that cannot lie flat fails with an error naming the step.' },
  expr:       { sig: 'expr.field / .lit / .idx / .midi / .slider / .time / .loop', detail: 'expression namespace', info: 'The Expr helpers, grouped under one namespace. expr.field(name)/lit(value)/idx() build diffable expressions over a row — chain .add/.mul/.gt/.cond/… and use them in filter(expr), map(template), emit(template), derive. expr.midi(note)/slider(id)/time()/loop() are LIVE per-frame sources: a field derived from one follows the note, slider, playback clock, or loop counter as the loop replays. e.g. filter(expr.field("v").gt(3)), derive({ py: expr.slider("height") }).' },
  beats:      { sig: 'beats(count, { fit }?)',       detail: 'beat timeline',     info: 'A timeline that loops every `count` beats — one "retime" event row in the timeline schema (schemas.timeline). Tempo is automatic — the playhead always runs at the tapped tempo (Tap) — so this is a RETIME: define("timeline", () => beats(16)) just loops every 16 beats; { fit: beats } stretches a span of source beats across the window (e.g. beats(16, { fit: 8 }) plays 8 beats of content at half speed). Concat more timeline event rows onto it ("loop", "pingpong", "hold", "speed", more "retime"s) to warp sections of the loop.' },
  tempo:      { sig: 'tempo(fallback?)',             detail: 'beat length (s)',   info: 'Seconds per beat derived from the tap-beat table (Tap), or `fallback` (default 0.5s = 120 BPM) until two taps are recorded.' },
  taps:       { sig: 'taps()',                       detail: 'tap-beat table',    info: 'The tap-beat table: one row per wall-time button press ({ beat, time }, time as an absolute UTC epoch ms).' },
  schemas:    { sig: 'schemas.hydra / .post / .bauble / .timeline / .sliders / .path / .origami', detail: 'canonical table schemas', info: 'The column schemas of the tables the runtime knows by name, ready to pass to editable() — right columns, enum dropdowns, and code languages included: editable("post", schemas.post). Frozen; spread to extend: { ...schemas.hydra, extra: "string" }.' },
  linear:     { sig: 'linear',                       detail: 'easing curve',     info: 'Linear easing (t → t). Pass as the ease field of a color-pulse row.' },
  easeIn:     { sig: 'easeIn',                       detail: 'easing curve',     info: 'Quadratic ease-in (t → t²). Starts slow, ends fast.' },
  easeOut:    { sig: 'easeOut',                      detail: 'easing curve',     info: 'Quadratic ease-out (t → 1-(1-t)²). Starts fast, ends slow.' },
  easeInOut:  { sig: 'easeInOut',                    detail: 'easing curve',     info: 'Quadratic ease-in-out. Slow at both ends, fast in the middle.' },
}

export const TABLE_METHOD_DOCS: Record<string, DocEntry> = {
  map:         { sig: '.map(row => row | template)',          detail: 'transform rows',   info: 'Transform every row. Pass a function, or a declarative template of Expr/literals (e.g. { y: expr.field("v").mul(2) }) — the template form is diffable.' },
  filter:      { sig: '.filter({ field: value } | Expr)',     detail: 'keep rows',        info: 'Keep rows that match. Pass a { field: value, … } pattern to keep rows where every field strictly equals its value (multi-key = AND) — e.g. filter({ id: "ball", event: "update" }); or an Expr predicate for anything richer — filter(expr.field("v").gt(3)). Both forms are data (no opaque closure), so the result is diffable.' },
  flatMap:     { sig: '.flatMap(row => row | row[] | null)',  detail: 'fan out rows',     info: 'Map each row to zero (null), one, or many rows and flatten the result — like Array.flatMap. The function form for fan-out; for a diffable version use .filter(...).emit(template).' },
  emit:        { sig: '.emit(template | [templates])',        detail: 'fan out rows',     info: 'Declarative fan-out: emit one or many rows per source row from Expr/literal templates. The diffable counterpart of flatMap; pair with .filter(...).' },
  concat:      { sig: '.concat(other)',                       detail: 'combine tables',   info: 'Append the rows of another Table (or array) to this one.' },
  slice:       { sig: '.slice(start, end?)',                  detail: 'subset rows',      info: 'Return a sub-range of rows, like Array.slice.' },
  fold:        { sig: '.fold((acc, row) => acc, init)',       detail: 'reduce to value',  info: 'Reduce all rows to a single accumulated value, like Array.reduce.' },
  scan:        { sig: '.scan((state, row) => { state, emit }, init)', detail: 'running accumul.', info: 'Running accumulator threading state row-to-row. Each step returns { state, emit } — emit a row (or array, or null to skip); the final state is discarded. Covers running sums, hidden per-row state, and gated emits.' },
  join:        { sig: '.join(other, on)',                     detail: 'key join',         info: 'Key-based join: merge rows where the `on` field (or { left, right } fields, or key fn) matches. Like SQL LEFT JOIN.' },
  zip:         { sig: '.zip(other)',                          detail: 'positional join',  info: 'Merge rows positionally — row 0 with row 0, row 1 with row 1, etc.' },
  orderBy:     { sig: '.orderBy(field | fn, dir?)',           detail: 'sort rows',        info: 'Sort rows by a field name or comparator function. Optional dir: "asc" (default) or "desc".' },
  derive:      { sig: '.derive({ field: Expr | row => val | value })', detail: 'add fields', info: 'Add or overwrite fields on every row. Each value is an Expr (evaluated against the row), a function (r, i) => val, or a literal. A live Expr binds per frame: derive({ amount: expr.midi("c4") }) or derive({ py: expr.slider("height") }) follows the note/slider as the loop replays; a constant Expr bakes in immediately.' },
  rescale:     { sig: '.rescale(field, [min, max]?)',         detail: 'normalize field',  info: 'Normalize a numeric field to [0, 1] (or a custom range) across all rows.' },
  lag:         { sig: '.lag(n)',                              detail: 'shift rows',       info: 'Shift rows forward by n positions, padding the start with null rows.' },
  shift:       { sig: '.shift(beats)',                        detail: 'delay by beats',   info: 'Shift every row later by `beats` (negative = earlier). Rows without a `beat` are untouched.' },
  retime:      { sig: '.retime(timelineTable)',               detail: 'warp through timeline', info: 'Warp this table\'s `beat`s through a table of timeline events (schemas.timeline): each row lands at every playback beat its source beat is shown, so a "loop" event duplicates the looped rows once per cycle, a "retime" stretch rescales `dur` along with the spacing, and rows no event plays are dropped. Rows without a numeric `beat` — and every row when the timeline has no events — pass through unchanged. e.g. table("melody").retime(table("warp")).rasterize(). Works on an origami paper.sequence() too (keep the spawn row unmapped) — loop or stretch subsections of the folding.' },
  groupBy:     { sig: '.groupBy(field | fn)',                 detail: 'group rows',       info: 'Group rows by a key field or function. Chain .agg() or .count() to aggregate.' },
  agg:         { sig: '.agg({ field: rows => val })',         detail: 'aggregate groups', info: 'Aggregate each group into one row. Called after .groupBy().' },
  count:       { sig: '.count()',                             detail: 'count groups',     info: 'Emit one row per group with a `count` field. Called after .groupBy().' },
  triggerEach: { sig: '.triggerEach(pred, objs, make)',       detail: 'fan-out events',   info: 'Fan out: for each object in objs when pred fires, call make(row, obj) to emit rows.' },
  crossings:   { sig: '.crossings(field, level)',             detail: 'threshold events', info: 'Emit one row each time the named field crosses the given numeric level.' },
  pairBy:      { sig: '.pairBy({ field: value }, (first, second) => rows)', detail: 'transform matched pairs', info: 'Find rows matching the { field: value, … } pattern (every field strictly equal) and cycle through them pairwise — match k paired as `second` with match k-1 as `first` (the last match wraps around to pair with the first). fn(first, second) returns the row(s) that replace `second`; non-matching rows pass through unchanged.' },
  range:       { sig: '.range(beats)',                        detail: 'generate rows',    info: 'Emit rows over `beats` beats from a math() builder — each row has { beat, value }.' },
  rasterize:   { sig: '.rasterize(maxBeats?)',                detail: 'bake frame cache', info: 'Bake sparse event rows (keyed by `beat`) into a dense per-frame world state Table. Optional maxBeats bakes at least that many beats (the final pose holds to it); omitted, the cache sizes to the last event. The loop itself is the "beats" control under the scene — beats past it land on later passes: a last event on beat 21 with a 16-beat loop makes a 32-beat sequence, a last event on beat 13 resets every loop.' },
  simulate:    { sig: '.simulate({ steps, gravity, ... })',   detail: 'run physics',      info: 'Step the JoltPhysics world. Options: steps (frames), gravity, fps, sampleEvery, collisions.' },
  steps:       { sig: '.steps(table | rows)',                 detail: 'origami fold table', info: 'One table = the whole folding, one row per fold, applied in order. p1/p2: two points "x,y" on the fold line, in the fixed unit-square frame the flat sheet started in. move: sample point(s) on the UNFOLDED sheet (";"-separated), one inside each flap that swings — a sheet point names exactly one ply, so single layers of a stack can be picked out. kind: "simple", "reverse", "sink", … chooses the move when several layer orders are valid; pick indexes among same-kind states. kind "crease" cuts every ply along the line WITHOUT folding (origami pre-creasing) — it takes no timeline slot and gives later folds and the soft motion extra bend lines. at/dur: when the swing starts and how long it lasts, in beats (defaults: the row\'s position, 0.75). to: how far to swing — 1 lands flat; only the last row may stop short (wings held half-raised).' },
  spawn:       { sig: '.spawn({ id, color, px, … })',         detail: 'origami create row', info: 'The origami sheet\'s scene create row (shape: "origami"), with the compiled fold program riding along and fold at 0 (flat sheet). Props merge over defaults. Colouring is NOT set here — it is its own pipeline off .faces()/.edges().' },
  folds:       { sig: '.folds()',                             detail: 'origami fold table',  info: 'One row per fold, carrying that fold\'s beat/dur — so it is already an event: add an id and event and route it anywhere. Columns: step/name which fold, to how far it swings, kind its classification ("Pureland", "Inside Reverse", …), states how many valid layer orders existed, faces/moving/flaps how much paper there is and how much swings, layers the stack height, plies the deepest pile, flip whether the model turns over first, motion how the in-between plays ("rigid", "relaxed", "mechanism"). e.g. paper.folds().derive({ event: "pulse", name: "glow", value: 0.8 }).outPost() pulses a post-processing glow on every fold as it happens.' },
  faces:       { sig: '.faces({ at })',                       detail: 'origami face table',  info: 'What the folding knows about each face, one row per (fold, face), carrying that fold\'s beat/dur: step/name which fold, face its number within it, moving whether it swings, flap which rigid flap it belongs to (-1 if still), dir the solver\'s rotation sense, layer/layerFrom its stacking RANK after/before (a rank, not a count), plies how many sheets are stacked where it lies (this is "how many layers"), back whether the paper\'s reverse shows, cx/cy/area as displayed, sheetX/sheetY on the unfolded square. A scene "color" row carrying `face` recolours that one face, so painting is an ordinary pipeline: paper.faces().filter({ moving: true }).derive({ id: "crane", event: "color", color: 0x2f6fff }).outThree(). `at` samples where each face IS at that fraction of its own fold (0 starting, 1 landed), adding px/py/pz in the paper\'s frame — point a camera at the moving flap with tx/ty/tz. Face numbers only mean something inside their own fold: every fold re-splits the paper.' },
  edges:       { sig: '.edges({ at })',                       detail: 'origami crease table', info: 'What the folding knows about each crease, one row per (fold, edge), carrying that fold\'s beat/dur: step/name which fold, edge its number, a/b the vertices it joins, folds whether this fold actually TURNS this crease (the real "edges the fold is on" — being on the fold line is a different, wrong test: the line also cuts creases it merely crosses, and a reverse fold opens a spine crease nowhere near it), mv "M"/"V" once landed, hinge whether it separates moving paper from still, border whether it is the sheet\'s rim. A scene "color" row carrying `edge` recolours that one crease. `at` adds px/py/pz as in .faces().' },
  sequence:    { sig: '.sequence(steps?)',                    detail: 'origami schedule',  info: 'Bake the fold table\'s at/dur timings into beat-timed update keyframes driving one numeric field, fold: k means the first k folds have landed, fractions swing the next flap about its fold line. Pass rows { step, at, dur? } to retime individual folds.' },
  three:       { sig: '.three.rotate / .three.scale / .three.move', detail: 'animate scene objects', info: 'Transform animations for the 3D scene. Reads this table\'s `create` rows and appends the UPDATE keyframes carrying each object\'s transform over time; the base rows pass through, so the result is renderable and the animators chain. .three.rotate({ amount, dur, axis }) spins, .three.scale({ amount, dur }) grows, .three.move({ amount, dur, axis }) slides. e.g. t.box().three.rotate({ amount: Math.PI, dur: 8 }).three.scale({ amount: 1.5, dur: 8 }).rasterize(8).' },
  graph:       { sig: '.graph(...columns)',                   detail: 'draw graph',       info: 'Mark this Table to be drawn on the graph panel. Pass column name(s) to plot.' },
  save:        { sig: '.save(name)',                          detail: 'save as view',     info: 'Sugar for define(name, () => this) — register the current Table as a named view.' },
  outThree:    { sig: '.outThree()',                          detail: 'route to 3D scene', info: 'Send this table of scene event rows to the 3D scene — no define() or name needed: t.box().three.rotate().outThree(). Every .outThree() table is combined beat-sorted into the "three (system)" table, visible in the panel and rasterized for playback. Routing takes precedence: once anything routes, ONLY routed tables play — a table named "three" is read only when nothing routes (the backwards-compatibility fallback), so route it too if it should stay in the mix.' },
  outScene:    { sig: '.outScene()',                          detail: 'route to scene cache', info: 'Send PRE-RASTERIZED per-frame rows to the scene cache — for when you call .rasterize() yourself. Combined with every other .outScene() table into "scene (system)"; takes precedence over a table named "scene". Usually .outThree() is what you want.' },
  outHydra:    { sig: '.outHydra()',                          detail: 'route to hydra',    info: 'Send this table of hydra event rows (schemas.hydra) to the hydra video synth. Every .outHydra() table is combined beat-sorted into "hydra (system)", which playback reads. Routing takes precedence: a table named "hydra" is read only when nothing routes (the backwards-compatibility fallback), so route it too if it should stay in the mix.' },
  outBauble:   { sig: '.outBauble()',                         detail: 'route to bauble',   info: 'Send this table of bauble event rows (schemas.bauble) to the SDF renderer, combined with every other .outBauble() table into "bauble (system)". Takes precedence over a table named "bauble", which is read only when nothing routes.' },
  outPost:     { sig: '.outPost()',                           detail: 'route to post fx',  info: 'Send this table of post event rows (schemas.post) to the post-processing chain, combined with every other .outPost() table into "post (system)". Takes precedence over a table named "post", which is read only when nothing routes.' },
  outTimeline: { sig: '.outTimeline()',                       detail: 'route to timeline', info: 'Send this table of timeline event rows (schemas.timeline) to the playback timeline — e.g. beats(16).outTimeline(). Combined with every other .outTimeline() table into "timeline (system)". Takes precedence over a table named "timeline", which is read only when nothing routes.' },
  outParticles:{ sig: '.outParticles()',                      detail: 'route to particles', info: 'Send this table of particle event rows (schemas.particles) to the GPU particle sim, combined with every other .outParticles() table into "particles (system)". Takes precedence over a table named "particles", which is read only when nothing routes.' },
}

export const THREE_METHOD_DOCS: Record<string, DocEntry> = {
  rotate: { sig: '.three.rotate({ amount, dur, axis, ease, at })', detail: 'spin over time',  info: 'For every `create` row, add `amount` radians to its rotation about `axis` (\'x\'|\'y\'|\'z\', default y; default amount a full turn) over `dur` beats. `ease` shapes the segment; `at` overrides the start beat (default the create row\'s beat).' },
  scale:  { sig: '.three.scale({ amount, dur, ease, at })',       detail: 'grow over time',   info: 'For every `create` row, multiply its scale (sx/sy/sz, default 1) by the `amount` factor (default 2×) over `dur` beats, uniformly on all axes. `ease` shapes the segment; `at` overrides the start beat.' },
  move:   { sig: '.three.move({ amount, dur, axis, ease, at })',  detail: 'slide over time',  info: 'For every `create` row, add `amount` world units to its position along `axis` (\'x\'|\'y\'|\'z\', default x; default amount 1) over `dur` beats. `ease` shapes the segment; `at` overrides the start beat.' },
}

export const EXPR_NAMESPACE_DOCS: Record<string, DocEntry> = {
  field:  { sig: 'expr.field(name)',          detail: 'read field',   info: 'A chainable expression reading row[name]. Chain .add/.sub/.mul/.div/.mod, .eq/.gt/…, .and/.or/.not, .cond(a,b). Use in filter(expr), map(template), emit(template), derive — these are diffable (no opaque closures).' },
  lit:    { sig: 'expr.lit(value)',           detail: 'literal',      info: 'A constant expression. Usually you can pass a raw value directly to an Expr method.' },
  idx:    { sig: 'expr.idx()',                detail: 'row index',    info: 'An expression yielding the row index (0-based).' },
  midi:   { sig: 'expr.midi(note, channel?)', detail: 'live MIDI',    info: 'A live value from the streaming MIDI table — the most recent event for `note` (e.g. "c4", "c#4", or "cc1" for control change) at-or-before the playhead. Normalized 0–1 (note velocity / CC value). Chainable like any Expr: expr.midi("c4").mul(2). Resolves each frame, so notes you play while looping replay at the loop position they were heard. Optional 1-based `channel` filters to one channel.' },
  slider: { sig: 'expr.slider(id, min?, max?)', detail: 'live slider',  info: 'A live on-screen slider value. Calling it also declares the slider — the "sliders" table keeps one row per name, the latest declaration winning min/max (default 0–1) — so the labelled control appears over the visual with no other setup, recording its automation the way MIDI does. Resolves each frame: derive({ py: expr.slider("height") }) follows the slider as the loop replays.' },
  time:   { sig: 'expr.time()',               detail: 'playback clock', info: 'The playback clock in seconds at the playhead — the same clock hydra/post chains see as props.time, so pausing or scrubbing freezes or scrubs it. Live (resolves each frame): derive({ ry: expr.time().mul(0.5) }) spins an object continuously.' },
  progress: { sig: 'expr.progress()',         detail: 'event percent-done', info: 'Percent-done of the enclosing event, 0→1. A post setVariable/pulse value reads its own dur window (a setVariable without dur reads 1); a scene keyframe value reads its dur, else its per-field segment to the next keyframe. Works in "=" cells and code exprs alike — "=progress().mul(tau).sin()" shapes a setVariable\'s own sweep.' },
  loop:   { sig: 'expr.loop()',               detail: 'loop counter',   info: 'How many whole loops have elapsed since the session started — 0 on the first pass, 1 on the second, and so on. "Start" is the session origin on the activity log (the wall-aligned beat-0), so synced clients and a scrub or replay agree and pausing doesn\'t advance it. Live (resolves each frame): derive({ hue: expr.loop().mul(0.1) }) shifts color every loop; expr.loop().mod(4) cycles four states.' },
  min:    { sig: 'expr.min(a, b)',            detail: 'smaller value',  info: 'The smaller of a and b (each an Expr or number). Also chainable: a.min(b).' },
  max:    { sig: 'expr.max(a, b)',            detail: 'larger value',   info: 'The larger of a and b. Also chainable: a.max(b).' },
  clamp:  { sig: 'expr.clamp(x, lo, hi)',     detail: 'limit range',    info: 'Limit x into [lo, hi]. Also chainable: x.clamp(lo, hi).' },
  lerp:   { sig: 'expr.lerp(a, b, t)',        detail: 'blend a→b',      info: 'Blend from a toward b by t (0–1) — expr.lerp(0, 10, expr.progress()) glides over the event. Also chainable: a.lerp(b, t).' },
  pow:    { sig: 'expr.pow(x, e)',            detail: 'power',          info: 'x raised to e. Also chainable: x.pow(e).' },
  wrap:   { sig: 'expr.wrap(x, lo, hi)',      detail: 'wrap range',     info: 'Wrap x into [lo, hi) — expr.wrap(expr.time(), 0, expr.tau) keeps an angle in range. Also chainable: x.wrap(lo, hi).' },
  atan2:  { sig: 'expr.atan2(y, x)',          detail: 'vector angle',   info: 'Angle of the vector (y, x) in radians. Also chainable: y.atan2(x).' },
  pi:     { sig: 'expr.pi',                   detail: 'π',              info: 'π as an expression constant — expr.pi.div(2).' },
  tau:    { sig: 'expr.tau',                  detail: '2π',             info: '2π, a full turn in radians — progress().mul(expr.tau).sin() completes one cycle over the event.' },
}

export const EXPR_METHOD_DOCS: Record<string, DocEntry> = {
  add:  { sig: '.add(x)',           detail: 'expr  +',   info: 'Add. x is another Expr or a number.' },
  sub:  { sig: '.sub(x)',           detail: 'expr  −',   info: 'Subtract x (Expr or number).' },
  mul:  { sig: '.mul(x)',           detail: 'expr  ×',   info: 'Multiply by x (Expr or number).' },
  div:  { sig: '.div(x)',           detail: 'expr  ÷',   info: 'Divide by x (Expr or number).' },
  mod:  { sig: '.mod(x)',           detail: 'expr  %',   info: 'Modulo (remainder) by x.' },
  eq:   { sig: '.eq(x)',            detail: 'expr  ===', info: 'Strict-equal test. Returns a boolean Expr (use in filter / cond).' },
  ne:   { sig: '.ne(x)',            detail: 'expr  !==', info: 'Not-equal test. Returns a boolean Expr.' },
  gt:   { sig: '.gt(x)',            detail: 'expr  >',   info: 'Greater-than test. Returns a boolean Expr.' },
  gte:  { sig: '.gte(x)',           detail: 'expr  >=',  info: 'Greater-than-or-equal test. Returns a boolean Expr.' },
  lt:   { sig: '.lt(x)',            detail: 'expr  <',   info: 'Less-than test. Returns a boolean Expr.' },
  lte:  { sig: '.lte(x)',           detail: 'expr  <=',  info: 'Less-than-or-equal test. Returns a boolean Expr.' },
  and:  { sig: '.and(expr)',        detail: 'expr  &&',  info: 'Logical AND of two boolean Exprs.' },
  or:   { sig: '.or(expr)',         detail: 'expr  ||',  info: 'Logical OR of two boolean Exprs.' },
  not:  { sig: '.not()',            detail: 'expr  !',   info: 'Logical negation of a boolean Expr.' },
  cond: { sig: '.cond(then, else)', detail: 'ternary',   info: 'If this Expr is truthy yield `then`, else `else` (each an Expr or literal).' },
  sin:  { sig: '.sin()',            detail: 'sine',      info: 'Sine of this value (radians) — a live input oscillates: expr.time().sin().' },
  cos:  { sig: '.cos()',            detail: 'cosine',    info: 'Cosine of this value (radians).' },
  abs:  { sig: '.abs()',            detail: 'absolute',  info: 'Absolute value.' },
  floor:{ sig: '.floor()',          detail: 'round down', info: 'Round down to the nearest integer.' },
  round:{ sig: '.round()',          detail: 'round',     info: 'Round to the nearest integer.' },
  fract:{ sig: '.fract()',          detail: 'sawtooth',  info: 'Fractional part (x − floor(x)) — a 0→1 sawtooth over a growing input like expr.time().' },
  pow:  { sig: '.pow(e)',           detail: 'power',     info: 'This value raised to the power e.' },
  min:  { sig: '.min(o)',           detail: 'smaller',   info: 'The smaller of this and o.' },
  max:  { sig: '.max(o)',           detail: 'larger',    info: 'The larger of this and o.' },
  clamp:{ sig: '.clamp(lo, hi)',    detail: 'limit range', info: 'Limit this value into [lo, hi] — expr.slider("v").clamp(0, 1).' },
  lerp: { sig: '.lerp(b, t)',       detail: 'blend',     info: 'Blend from this value toward b by t (0–1) — a.lerp(b, expr.progress()) glides over the event.' },
  wrap: { sig: '.wrap(lo, hi)',     detail: 'wrap range', info: 'Wrap this value into [lo, hi) — expr.time().wrap(0, 6.283) keeps an angle in range.' },
}

export const DSL_BUILTINS = Object.keys(DSL_BUILTIN_DOCS)

// Seeds the "code" table's first fragment row (see programText).
export const defaultProgram = SAMPLES[0].code
// The default example's row data lives with the sample, not in the code, so a
// fresh session must seed the store with it.
export const defaultTables = SAMPLES[0].tables
// …and the tab it opens on, so a fresh session shows the same relevant table
// the example would (see main's newSession / openExample).
export const defaultTable = SAMPLES[0].table ?? null

export function viewAtPos(text: string, pos: number): string | null {
  const re = /\bdefine\(\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  let name: string | null = null
  while ((m = re.exec(text))) {
    if (m.index <= pos) name = m[1]
    else break
  }
  return name
}

// The smallest single splice turning `a` into `b`: the shared prefix and
// suffix are left untouched, so an editor applying it maps the caret and scroll
// through the unchanged text instead of resetting on a full replace. Identical
// strings yield an empty splice (from === to, insert === '').
export function minimalEdit(a: string, b: string): { from: number; to: number; insert: string } {
  const max = Math.min(a.length, b.length)
  let from = 0
  while (from < max && a.charCodeAt(from) === b.charCodeAt(from)) from++
  let endA = a.length
  let endB = b.length
  while (endA > from && endB > from && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB-- }
  return { from, to: endA, insert: b.slice(from, endB) }
}

export type InfoNodeFactory = (sig: string, info: string) => () => { dom: HTMLElement; destroy?: () => void }

export interface SymbolCardData {
  display: string | null
  docs: string
  curated: DocEntry | null
}
export type SymbolCardFactory = (data: SymbolCardData) => { dom: HTMLElement; destroy?: () => void }

// The method-doc table for a `.` at `dotPos`, picked by the chain's root.
function docsForDot(text: string, dotPos: number): Record<string, DocEntry> {
  return isThreeDot(text, dotPos) ? THREE_METHOD_DOCS
    : isExprNamespaceDot(text, dotPos) ? EXPR_NAMESPACE_DOCS
      : isExprDot(text, dotPos) ? EXPR_METHOD_DOCS
        : TABLE_METHOD_DOCS
}

// Curated prose for `name` at `start`: member access picks the method table by
// the chain's root (the same heuristic the fallback completions use), a bare
// identifier is a DSL builtin or nothing.
export function curatedDocFor(text: string, start: number, name: string): DocEntry | null {
  let i = start - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i >= 0 && text[i] === '.') return docsForDot(text, i)[name] ?? null
  return DSL_BUILTIN_DOCS[name] ?? null
}

// Complete view names inside table("…") / define("…" quotes (DSL-only).
export function viewNameCompletions(getViews: (() => Map<string, Table> | undefined) | undefined, getLang: GetLang) {
  return (context: CompletionContext): CompletionResult | null => {
    if (getLang() !== 'dsl') return null
    if (!context.matchBefore(/\b(?:table|define)\(\s*"[^"]*/)) return null
    const open = context.matchBefore(/"[^"]*/)
    const names = [...(getViews?.() ?? new Map()).keys()]
    if (!names.length) return null
    return {
      from: open ? open.from + 1 : context.pos,
      options: names.map((n: string) => ({ label: n, type: 'variable' })),
      validFor: /^[^"]*$/,
    }
  }
}

// Fallback completions while the language-service worker loads (or if it
// never does): chain-root heuristic after a dot, DSL builtins plus locals on
// bare words.
function heuristicCompletions(context: CompletionContext, makeInfoNode: InfoNodeFactory): CompletionResult | null {
  const dot = context.matchBefore(/\.\w*/)
  if (dot) {
    const text = context.state.doc.toString()
    const docs = docsForDot(text, dot.from)
    return {
      from: dot.from + 1,
      options: Object.keys(docs).map((label) => {
        const d = docs[label]
        return { label, type: 'method', detail: d.detail, info: makeInfoNode(d.sig, d.info) }
      }),
      validFor: /^\w*$/,
    }
  }
  const word = context.matchBefore(/\w+/)
  if (!word && !context.explicit) return null
  const from = word ? word.from : context.pos
  const local = localCompletionSource(context)
  return {
    from,
    options: [
      ...DSL_BUILTINS.map((label): Completion => {
        const d = DSL_BUILTIN_DOCS[label]
        return { label, type: 'function', detail: d.detail, info: makeInfoNode(d.sig, d.info) }
      }),
      ...(local && local.from === from ? local.options : []),
    ],
    validFor: /^\w*$/,
  }
}

// The main completion source: the TypeScript language service when its worker
// is ready, the heuristics otherwise.
export function codeCompletions(
  client: LangClient | null,
  makeInfoNode: InfoNodeFactory,
  makeSymbolCard: SymbolCardFactory,
  getLang: GetLang,
) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // No completions in strings/comments — quoted view names have their own
    // source (viewNameCompletions).
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    if (/String|Comment/.test(node.name)) return null
    const lang = getLang()
    if (lang === 'bauble') return null // Janet — no JS surface applies

    if (client && client.status() === 'ready') {
      const word = context.matchBefore(/[\w$]+/)
      const dot = context.matchBefore(/\.[\w$]*/)
      if (!word && !dot && !context.explicit) return null
      const text = context.state.doc.toString()
      const res = await client.completions(text, context.pos, lang)
      if (res && res.entries.length) {
        const from = word ? word.from : context.pos
        return {
          from,
          options: res.entries.map((e): Completion => {
            const curated = lang === 'dsl' ? curatedDocFor(text, from, e.name) : null
            return {
              label: e.name,
              type: cmCompletionType(e.kind),
              ...(curated ? { detail: curated.detail } : {}),
              boost: completionBoost(e.sortText, e.kind, curated !== null),
              info: async () => {
                const det = await client.details(text, context.pos, e.name, lang)
                if (!det && !curated) return null
                return makeSymbolCard({
                  display: det?.display ?? curated?.sig ?? null,
                  docs: det?.docs ?? '',
                  curated,
                })
              },
            }
          }),
          validFor: /^[\w$]*$/,
        }
      }
      // No answer (e.g. the parse is too broken mid-edit) — fall through.
    }
    // The heuristic fallback knows only the DSL surface; in a hydra cell wrong
    // suggestions are worse than none.
    return lang === 'dsl' ? heuristicCompletions(context, makeInfoNode) : null
  }
}

export function typeHover(client: LangClient, makeSymbolCard: SymbolCardFactory, getLang: GetLang) {
  return hoverTooltip(async (view, pos) => {
    if (client.status() !== 'ready') return null
    const lang = getLang()
    if (lang === 'bauble') return null // Janet — no JS surface applies
    const text = view.state.doc.toString()
    const info = await client.quickInfo(text, pos, lang)
    if (!info || !info.display) return null
    const curated = lang === 'dsl' ? curatedDocFor(text, info.start, text.slice(info.start, info.end)) : null
    return {
      pos: info.start,
      end: info.end,
      above: true,
      create: () => makeSymbolCard({ display: info.display, docs: info.docs, curated }),
    }
  })
}

// ── Signature help ───────────────────────────────────────────────────────────
// Typing "(" or "," inside a call pops a tooltip with the callee's signature
// and the active parameter highlighted.

export interface SigHelpState {
  pos: number
  sig: LangSignatureHelp
}

export type SigCardFactory = (sig: LangSignatureHelp) => { dom: HTMLElement; destroy?: () => void }

export function signatureHelp(client: LangClient, makeSigCard: SigCardFactory, getLang: GetLang): Extension {
  const setSig = StateEffect.define<SigHelpState | null>()

  const field = StateField.define<SigHelpState | null>({
    create: () => null,
    update(value, tr) {
      if (value && tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos) }
      for (const e of tr.effects) if (e.is(setSig)) value = e.value
      return value
    },
    provide: (f) => showTooltip.from(f, (value): Tooltip | null => value && {
      pos: value.pos,
      above: true,
      create: () => makeSigCard(value.sig),
    }),
  })

  // Stale-response guard: only the latest query may update the tooltip.
  let epoch = 0

  const listener = EditorView.updateListener.of((update) => {
    const active = update.state.field(field) !== null
    let trigger: string | undefined
    if (update.docChanged) {
      const head = update.state.selection.main.head
      const ch = head > 0 ? update.state.doc.sliceString(head - 1, head) : ''
      if (ch === '(' || ch === ',') trigger = ch
      else if (!active) return // only ( and , open the tooltip
    } else if (!(update.selectionSet && active)) {
      return // cursor moves only re-query (or clear) an open tooltip
    }
    if (client.status() !== 'ready') return
    const lang = getLang()
    if (lang === 'bauble') return // Janet — no JS surface applies
    const id = ++epoch
    const { view } = update
    const text = update.state.doc.toString()
    const head = update.state.selection.main.head
    void client.signatureHelp(text, head, trigger, lang).then((sig) => {
      if (id !== epoch) return
      const value = sig ? { pos: Math.min(sig.argumentStart, head), sig } : null
      if (value === null && view.state.field(field, false) == null) return // nothing to clear
      view.dispatch({ effects: setSig.of(value) })
    })
  })

  const closeOnEscape = EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (event.key === 'Escape' && view.state.field(field, false)) {
        view.dispatch({ effects: setSig.of(null) })
      }
      return false // never swallow — vim &co. still see the key
    },
  })

  return [field, listener, closeOnEscape]
}

// ── Remote cursors (multiplayer presence) ────────────────────────────────────
// Remote offsets are clamped rather than trusted: the two docs can drift
// between Applies (program text only syncs on a Run).

export interface RemoteCursor {
  client: string
  user: string
  color: string
  head: number
}

// The program is the "code" table's rows: every non-empty cell is a fragment of
// one concatenated source, joined in storage order. Concatenating rather
// than executing each fragment separately is what lets a top-level const in one
// row be visible to the next — the natural thing when a working program is
// split in two.
export function programText(rows: Row[]): string {
  return rows.map((r) => String(r.code ?? '')).filter((s) => s.trim() !== '').join('\n')
}

class RemoteCursorWidget extends WidgetType {
  constructor(private readonly user: string, private readonly color: string) { super() }

  override eq(other: RemoteCursorWidget): boolean {
    return other.user === this.user && other.color === this.color
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-remote-cursor'
    wrap.style.borderLeftColor = this.color
    const label = document.createElement('span')
    label.className = 'cm-remote-cursor-label'
    label.style.background = this.color
    label.textContent = this.user
    wrap.appendChild(label)
    return wrap
  }

  override ignoreEvent(): boolean { return true }
}

export const setRemoteCursorsEffect = StateEffect.define<RemoteCursor[]>()

export const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setRemoteCursorsEffect)) continue
      deco = Decoration.set(
        e.value.map((c) => Decoration.widget({
          widget: new RemoteCursorWidget(c.user, c.color),
          side: -1,
        }).range(Math.max(0, Math.min(c.head, tr.newDoc.length)))),
        true,
      )
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Hovering a quoted view name pops a data preview of that view.
export function dslHover(
  getViews: (() => Map<string, Table> | undefined) | undefined,
  getPlayIndex: (() => number) | undefined,
  buildPreview: (table: Table, opts: { playIndex?: number | null }) => { dom: HTMLElement; destroy?: () => void },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return hoverTooltip((view: any, pos: number) => {
    const line = view.state.doc.lineAt(pos) as { text: string; from: number }
    const re = /"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index
      const end = start + m[0].length
      if (pos < start || pos > end) continue
      const table = (getViews?.() ?? new Map()).get(m[1])
      if (!table) return null
      return {
        pos: start, end, above: true,
        create: () => buildPreview(table, { playIndex: getPlayIndex?.() }),
      }
    }
    return null
  })
}
