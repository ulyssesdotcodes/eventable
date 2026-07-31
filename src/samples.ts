// Sample programs for the livecodata editor. The // lines inside each `code`
// string are user-facing tutorial text shown in the editor — keep them
// verbose. A sample's `tables` seeds its editable tables' rows, so the code
// declares only the schema.
import type { Row } from './lineage.js'

export interface Sample {
  name: string
  code: string
  tables?: Record<string, Row[]>
  // The tab to show when the example is opened — its most relevant table (the
  // editable one you tweak, or the primary data/graph view). The panel falls
  // back to its default tab when omitted (see main's openExample).
  table?: string
}

// A URL-safe id for an example, derived from its display name (e.g. "CO2
// (Mauna Loa)" -> "co2-mauna-loa"), so a link can open a specific example
// directly (?example=<slug>) without needing a separate id field to keep in
// sync with `name`.
export const slugify = (name: string): string =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export const sampleIndexForSlug = (slug: string): number =>
  SAMPLES.findIndex((s) => slugify(s.name) === slug)

export const SAMPLES: Sample[] = [
  {
    name: "Editable Table",
    table: "path",
    code: `// livecodata — a sphere moved by an editable table
// Unlike every other example here, the path below isn't computed by code —
// it's data you edit directly, live, in the table panel on the right.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. editable(name, schema) declares a user-editable table: rows are
//    entered/edited in the table panel (its own "path" tab), not computed —
//    edits persist across runs, unlike a normal view. It registers itself
//    under its name, so this one call is the whole declaration. The table
//    starts with the keyframes seeded on the right; the schema is all the
//    code carries, and \`schemas.path\` is the canonical one for beat-timed
//    positions — hover it to see the columns ({ beat, px, py, pz, disabled }).
//    Each keyframe sits on a beat (1-indexed: beat 1 is the top of the loop).
//    Try it: open the "path" tab, click a cell to change a coordinate, or hit
//    "+ row" to add a keyframe, then press Run again to see the sphere follow
//    the new path. (Every edit is recorded as an event too — see the
//    "path·events" tab.) "disabled" is just an ordinary boolean column, not a
//    special mechanism — check a row's box to mute that keyframe (the sphere
//    skips it) without deleting the row; uncheck to bring it back.
editable("path", schemas.path)

// 2. Turn the path's keyframes into a moving sphere and route it to the 3D
//    scene with .outThree(): the first row (sorted by beat, in case rows were
//    added out of order) creates it; every later row is an update, and
//    playback interpolates position between consecutive rows by their \`beat\`.
//    A routed table needs no name — everything that calls .outThree(), from
//    any number of tables, is combined beat-sorted into the "three (system)"
//    table (see its tab on the right), and playback bakes that into per-frame
//    motion automatically. The loop itself is the "beats" control under the
//    scene (16 by default), so the sphere holds its last pose until it wraps.
table("path").orderBy("beat").map((r, i) => ({
  id: "ball", event: i === 0 ? "create" : "update", beat: r.beat,
  shape: "sphere", color: 0x4a9eff, px: r.px, py: r.py, pz: r.pz, rx: 0, ry: 0, rz: 0,
})).outThree()

// 3. Post-processing is an editable table too (the "post" tab): beat-placed
//    events build a shader chain run over the rendered scene. Seeded here: a
//    soft bloom whose \`glow\` is a live variable, pulsed brighter at beat 9 —
//    edit the chain cell or the values on the right and Run to restyle the
//    whole scene. See the "Post" example for the full tour.
editable("post", schemas.post)

// 4. Any number cell can hold a live EXPRESSION instead of a literal: start
//    it with "=" — spreadsheet style — and write a chain over the expr
//    sources, e.g. "=slider('sway')" (an on-screen slider appears) or
//    "=time().sin().mul(0.5)". The path's middle keyframe is seeded with one:
//    open the "path" tab and tap the py cell to edit it in this editor with
//    completions; type a plain number to turn it back into one. Expressions
//    resolve every frame at the playhead, so the value follows sliders, MIDI,
//    the clock — and progress(), the row's own percent-done.
`,
    tables: {
      path: [
        { beat: 1, px: -1, py: 0,   pz: 0 },
        { beat: 3, px: 1,  py: "=slider('sway').mul(2)", pz: 0 },
        { beat: 5, px: 0,  py: 0.3, pz: -1 },
      ],
      post: [
        { beat: 1, event: "setCode", code: "bloom((p) => p.glow, 0.4, 0.6)" },
        { beat: 1, event: "setVariable", name: "glow", value: 0.35 },
        { beat: 9, event: "pulse", name: "glow", value: 0.8, dur: 2, ease: "easeOut" },
      ],
    },
  },
  {
    name: "Retime Table",
    table: "warp",
    code: `// livecodata — retiming ONE table with an editable table of time warps
// The scene is the Editable Table example: a sphere following a hand-entered
// path. New here is "warp" — an editable table of timeline EVENTS (its own
// tab on the right) that retimes JUST the sphere, by chaining
// .retime(table("warp")) on its way to the scene. Edit a warp row, press Run:
// same path, different time.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. The warp: one timeline EVENT per row (\`schemas.timeline\` — hover it).
//    Each row covers an UNTIL-NEXT window — from its own \`beat\` to the next
//    row's — so there's no \`dur\`: to make a window longer, move the next row
//    later. Rows are seeded on the right, one of each kind:
//      retime    beats 1..7   plays source 1..5 stretched across 6 beats
//      loop      beats 7..11  cycles source 1..3 at natural speed (2×)
//      pingpong  beats 11..15 swings source 1..5 there and back
//      hold      beats 15..17 freezes on source beat 5 (the path's end)
//    The last row (the hold) runs to the end of the loop — that length is the
//    "beats" control under the scene, not the timeline. retime is the general
//    one: \`from\`..\`to\` is the source range (from > to runs it backwards), and
//    an optional output block \`outFrom\`..\`outTo\` repeats across the window —
//    pingpong is a retime whose block plays the range forward then backward. A
//    plain stretch of unwarped time is just a bare retime row (its window
//    plays straight through). A numeric cell left 0 means "unset". The name is
//    ours to pick — "timeline" is the one reserved name: a table saved under
//    it (or routed with .outTimeline()) warps GLOBAL playback, every table at
//    once, instead of being applied by hand like this one.
editable("warp", schemas.timeline)

// 2. The sphere's keyframes, warped on their way to the scene:
//    .retime(table("warp")) places each row at every playback beat its source
//    beat is shown — the loop event duplicates rows once per cycle,
//    stretches rescale \`dur\` columns, rows no event plays are dropped —
//    and .outThree() routes the result on to the 3D scene ("three (system)"
//    in the panel shows the retimed rows). Only THIS table is retimed.
editable("path", schemas.path)
table("path").orderBy("beat").map((r, i) => ({
  id: "ball", event: i === 0 ? "create" : "update", beat: r.beat,
  shape: "sphere", color: 0x4a9eff, px: r.px, py: r.py, pz: r.pz, rx: 0, ry: 0, rz: 0,
})).retime(table("warp")).outThree()

// 3. The proof the MAIN timeline is untouched: this post table is NOT
//    retimed, so its bloom pulse still lands on the real beat 9 — halfway
//    through the 16-beat loop — while the warped sphere runs on its own
//    time. Retime the sphere however you like; the pulse keeps its place.
editable("post", schemas.post)
`,
    tables: {
      path: [
        { beat: 1, px: -1, py: 0,   pz: 0 },
        { beat: 3, px: 1,  py: 1,   pz: 0 },
        { beat: 5, px: 0,  py: 0.3, pz: -1 },
      ],
      warp: [
        { event: 'retime',   beat: 1,  from: 1, to: 5 },
        { event: 'loop',     beat: 7,  from: 1, to: 3 },
        { event: 'pingpong', beat: 11, from: 1, to: 5 },
        { event: 'hold',     beat: 15, from: 5 },
      ],
      post: [
        { beat: 1, event: "setCode", code: "bloom((p) => p.glow, 0.4, 0.6)" },
        { beat: 1, event: "setVariable", name: "glow", value: 0.35 },
        { beat: 9, event: "pulse", name: "glow", value: 0.8, dur: 2, ease: "easeOut" },
      ],
    },
  },
  {
    name: "Text",
    code: `// livecodata — text in the 3D scene
// A \`shape: "text"\` object is real extruded 3D text (three.js TextGeometry): it
// has depth, catches the scene's lights, and moves, spins and scales like any
// other object. The font is bundled, so it appears instantly — no asset to load.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// The text fields, alongside the usual px/py/pz + rx/ry/rz transform:
//   text   the string to draw (\\n splits into stacked, centered lines)
//   size   the cap height per line, in world units (default 0.5)
//   color  material color (default white) — recolors live, like any mesh
//
// \`text\` is just a normal column: it steps to the newest value as the loop
// plays, so a later "update" row can swap the string mid-loop the way a color
// pulse does. .outThree() routes the table to the 3D scene — no name, no
// boilerplate; playback bakes the keyframes into per-frame motion for you
// (the routed rows show up in the "three (system)" tab). The subtitle's ry
// keyframes ease back and forth, landing back on the start pose just before
// the loop wraps so it repeats without a jump.
rows([
  { id: "title", event: "create", beat: 1, shape: "text", text: "livecodata",
    color: 0x4a9eff, size: 0.7, px: 0, py: 0.4, pz: 0, rx: 0, ry: 0, rz: 0 },
  // A second line that gently swings side to side while turning about y.
  { id: "sub", event: "create", beat: 1, shape: "text", text: "tables to visuals",
    color: 0xffd43b, size: 0.32, px: 0, py: -0.5, pz: 0, rx: 0, ry: -0.6, rz: 0 },
  { id: "sub", event: "update", beat: 9, ry: 0.6 },
  { id: "sub", event: "update", beat: 16, ry: -0.6 },
]).outThree()
`,
  },
  {
    name: "Primitives",
    table: "things",
    code: `// livecodata — building 3D objects the easy way
// The three.js helpers live under the \`three\` namespace, or its shorthand \`t\`.
// t.box/sphere/cylinder/cone/torus/text each build a ready-made "create" row
// for a scene object: beat 1, at the origin, no rotation — you set only the
// fields you care about. They return Tables, so concat them into a scene and
// rasterize. Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. A few primitives, laid out along x. Each helper's \`id\` defaults to its
//    shape name, so give distinct ids when you have more than one of a kind.
//    Sizes follow the shared schema: box → hx/hy/hz (half-extents),
//    sphere/torus → r, cylinder/cone → r + h (half-height); leave a size out
//    and the renderer's default for that shape is used. table(name, table)
//    names the result — its own "things" tab in the panel — and .outThree()
//    routes it to the 3D scene.
table("things",
  t.box({ id: "b", px: -2.4, color: 0x4a9eff })
    .concat(t.sphere({ id: "s", px: -1.2, r: 0.4, color: 0xff6b6b }))
    .concat(t.cylinder({ id: "y", px: 0, r: 0.3, h: 0.5, color: 0x51cf66 }))
    .concat(t.cone({ id: "c", px: 1.2, r: 0.35, h: 0.5, color: 0xffd43b }))
    .concat(t.torus({ id: "r", px: 2.4, r: 0.35, color: 0xcc5de8 }))
).outThree()

// 2. t.object(shape, props) is the generic behind the named helpers — handy for
//    a label. Here a line of 3D text floats above the row of shapes, routed
//    straight to the scene with no name at all. Nudge the whole scene with
//    t.translate/scale/rotate(table, x, y, z).
t.text({ id: "caption", py: 1.4, size: 0.4, text: "primitives", color: 0xffffff })
  .outThree()

// 3. Everything routed with .outThree() combines beat-sorted into the one
//    "three (system)" table — no manual concat — and playback bakes it into a
//    per-frame cache automatically. The scene is static here — add "update"
//    rows (or animate ry) to make it move, exactly like the Text and Camera
//    Move samples do.
`,
  },
  {
    name: "Camera Move",
    table: "cubes",
    code: `// livecodata — moving the camera from the DSL
// The camera is just another scene object: \`t.camera([...])\` emits one keyframe
// per row (id "camera", shape "camera") that rides events → rasterize like
// anything else, so camera moves interpolate on the beat timeline for free.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. A little scene to look at: a 3×3 lattice of cubes on the floor. grid()
//    gives px/py/pz; each cell becomes a create row for a small box. Named
//    "cubes" for its own tab, routed to the scene with .outThree().
table("cubes",
  grid(3, 3, { spacing: 0.8 }).map((c, i) => ({
    id: "c" + i, event: "create", beat: 1, shape: "box",
    color: 0x4a9eff, hx: 0.2, hy: 0.2, hz: 0.2,
    px: c.px, py: c.py, pz: c.pz, rx: 0, ry: 0, rz: 0,
  }))
).outThree()

// 2. t.camera([...]) — one row per keyframe. px/py/pz are the eye, tx/ty/tz the
//    look-at target (here always the origin), fov the vertical field of view.
//    Over the 16-beat loop the eye swings around the lattice and cranes up,
//    while the fov eases from wide to tight (a subtle dolly-zoom), then lands
//    back on the start pose at beat 16 so the loop repeats without a jump.
//    Its .outThree() merges the keyframes with the cubes above into the one
//    "three (system)" scene table — no manual concat.
t.camera([
  { beat: 1,  px: 0,    py: 0.5, pz: 5, tx: 0, ty: 0, tz: 0, fov: 60 },
  { beat: 5,  px: 4,    py: 1.5, pz: 3, fov: 55 },
  { beat: 9,  px: 0,    py: 3,   pz: -5, fov: 45 },
  { beat: 13, px: -4,   py: 1.5, pz: 3, fov: 55 },
  { beat: 16, px: 0,    py: 0.5, pz: 5, fov: 60 },
]).outThree()
`,
  },
  {
    name: "Lights",
    table: "lights",
    code: `// livecodata — lighting the scene from the DSL
// A \`t.light(...)\` is just another scene object: no mesh, it adds a three.js
// light. The moment you add one, the scene's default lights switch off, so the
// program owns the lighting. Being ordinary keyframe tracks, a light's color,
// intensity and position animate on the beat timeline like anything else.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. Something to light: a row of pale spheres to catch the colored lights,
//    routed to the scene with .outThree() — no name needed.
grid(5, 1, { spacing: 0.9 }).map((c, i) => ({
  id: "b" + i, event: "create", beat: 1, shape: "sphere",
  color: 0xdddddd, r: 0.35, px: c.px, py: 0, pz: 0, rx: 0, ry: 0, rz: 0,
})).outThree()

// 2. The static lights. \`kind\` picks the type:
//    - a dim "ambient" fill so nothing is pure black,
//    - a cool "directional" key from the upper left for shape,
//    plus a camera pulled back to frame the row. color is a hex number; give
//    each light a distinct id. Named "lights" for its own tab in the panel.
table("lights",
  t.light({ id: "fill", kind: "ambient", color: 0x222233, intensity: 1 })
    .concat(t.light({ id: "key", kind: "directional", color: 0x88aaff, intensity: 1.5, px: -3, py: 4, pz: 2 }))
    .concat(t.camera([
      { beat: 1, px: 0, py: 1.5, pz: 6, tx: 0, ty: 0, tz: 0 },
    ]))
).outThree()

// 3. A moving colored point light: one create row plus update keyframes for
//    px/pz (a circle) and intensity (brightest at the front of the loop). It's
//    a plain "light" row, so it interpolates like any object. Everything
//    routed with .outThree() — spheres, lights, bulb — combines beat-sorted
//    into the one "three (system)" scene table, and playback bakes the
//    per-frame cache automatically.
rows([
  { id: "bulb", event: "create", beat: 1, shape: "light", kind: "point",
    color: 0xff6b6b, intensity: 5, distance: 12, px: 0, py: 1.5, pz: 2 },
  { id: "bulb", event: "update", beat: 3, px: 3,  pz: 0, intensity: 2 },
  { id: "bulb", event: "update", beat: 5, px: 0,  pz: -2, intensity: 5 },
  { id: "bulb", event: "update", beat: 7, px: -3, pz: 0, intensity: 2 },
  { id: "bulb", event: "update", beat: 9, px: 0,  pz: 2, intensity: 5 },
]).outThree()
`,
  },
  {
    name: "Origami Crane",
    table: "origami",
    code: `// livecodata — Origami Crane: a table of fold steps, solved exactly
// A square of paper folds itself into the traditional crane. Every row of
// the "origami" table is ONE FOLD, and each is solved exactly when the code
// runs: the paper is cut along the fold line, the chosen flaps swing over,
// and a layer solver works out how the paper stacks (seeded from the step
// before, so the folding stays coherent). Playback shows those exact
// states. Between them, simple folds hinge rigidly about the fold line;
// shallow reverse folds play a physically relaxed motion baked at compile
// time — pockets billow open and press flat the way real paper moves —
// and the deep ones (neck, tail, head) play the fold's exact rigid
// mechanism: the body opens around its spine, the point flips through,
// and everything presses flat again, landing exactly on the solved state.
// Every face shares its vertices with its neighbours, so the paper can
// never tear.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The 17 fold steps are seeded into the "origami" table on the right — the code
// here declares only their column schema; edit the steps live in the panel.
// Each column:
//   step   a name for the fold (errors point at it)
//   p1,p2  two points "x,y" on the fold line, drawn on the CURRENT folded
//          paper. The frame never moves: it is the unit square [0,1]² the
//          flat sheet started in
//   move   which flap(s) swing over: sample point(s) on the UNFOLDED
//          sheet ("x,y", ";"-separated), one inside each moving flap —
//          a sheet point names exactly one layer, so a single ply of a
//          thick stack can be picked out unambiguously
//   kind   for ambiguous folds, the move to make: "simple" (fold the flap
//          over), "reverse" (inside reverse fold), "sink", … — the solver
//          checks the paper really can fold that way
//   pick   when several stackings of that kind are valid, which one
//   beat,dur when the swing starts, and how long it takes, in beats
//   to     how far to swing: 1 lands flat (default). Only the last row
//          may stop short — the wings hold at 0.5, half-raised
//   disabled  an ordinary boolean column: check a step's box to skip that
//          fold entirely (as if the row weren't there) without deleting
//          it — handy for previewing an earlier stage of the fold.
//
// A row that asks the impossible — a fold that cannot lie flat, a marker
// off the paper, a kind the geometry does not allow — fails with an error
// naming the step. Nothing folds wrong silently.

// \`schemas.origami\` is the canonical fold-table schema (the columns above) —
// hover it in the editor to see them typed out. editable() registers the
// table under its name, so this one call is the whole declaration.
editable("origami", schemas.origami)

// Feed the fold table to a sheet of paper, colored side DOWN (backColor)
// the way a crane is folded so the finished bird comes out colored. Every
// fold swings toward you on its own — the engine keeps the paper flat on
// the table and turns it over whenever the next fold would dip away. The
// fold value is one number: how many folds have landed (fractions = the
// next flap mid-swing), so scrubbing the timeline scrubs the folding.
// .outThree() routes the create row + fold keyframes to the 3D scene (the
// "three (system)" tab), and playback bakes the per-frame cache
// automatically. The keyframes span about 52 beats — four passes of the
// 16-beat loop: the paper folds itself across the first three and a bit,
// holds the finished crane, then opens flat and folds itself all over
// again.
const paper = origami().steps(table("origami"))
paper.spawn({ id: "crane", color: 0xf4efe2, backColor: 0xd94f2a, pz: 1.2, rz: 2.356 })
  .concat(paper.sequence())
  .outThree()

// A whisper of video feedback (the rendered scene is hydra's s0) so the
// paper leaves faint trails as it moves — routed with .outHydra(); delete
// these two lines for a clean look.
rows([
  { beat: 1, event: "setCode",
    code: "src(s0).blend(src(o0).scale(1.003), 0.18).out(o0)" },
]).outHydra()

// Things to try, live in the "origami" tab:
//   - Set the wings row's \`to\` to 1: the wings press flat, the classic
//     pressed crane; 0.35 barely lifts them.
//   - Delete the "head" row: everything else still folds — steps only
//     depend on the geometry before them, not on names.
//   - Or check "head"'s \`disabled\` box instead of deleting it: same effect
//     on the fold, but the step is still there (unchecked) to bring back.
//   - Nudge a p1/p2 a little: small nudges re-solve fine; ask something
//     impossible and the error names the offending step instead of
//     folding wrong.
//   - Slow a step down: give "neck" dur: 6 and watch the reverse fold
//     swing through.
`,
    tables: {
      origami: [
        // in half along the diagonal
        { step: "diag", p1: "0,0", p2: "1,1", move: "0.667,0.333", beat: 1, dur: 2 },
        // collapse into the square base: four inside reverse folds
        { step: "collapse1", p1: "0,0.5", p2: "1,0.5", move: "0.333,0.167", kind: "reverse", beat: 4, dur: 2 },
        { step: "collapse2", p1: "0.5,0", p2: "0.5,1", move: "0.833,0.667", kind: "reverse", beat: 7, dur: 2 },
        { step: "collapse3", p1: "0,1", p2: "0.4142135624,0", move: "0.667,0.069036", kind: "reverse", beat: 10, dur: 2 },
        { step: "collapse4", p1: "0,1", p2: "1,0.5857864376", move: "0.930964,0.667", kind: "reverse", beat: 13, dur: 2 },
        // flatten the stray flap, then tuck the side corners in
        { step: "flatten", p1: "0,0.2928932188", p2: "0.7071067812,1", move: "0.930964,0.333", beat: 16, dur: 2 },
        { step: "tuck1", p1: "0,1", p2: "0.4142135624,0", move: "0.069036,0.667", kind: "reverse", beat: 19, dur: 2 },
        { step: "tuck2", p1: "0,1", p2: "1,0.5857864376", move: "0.667,0.930964", kind: "reverse", beat: 22, dur: 2 },
        // kite folds onto the centre line, front then (after turning a flap
        // like a page) back — this thins the points into neck and tail
        { step: "kite1", p1: "0,1", p2: "0.6681786379,0", move: "0.525373,0.274808", pick: 1, beat: 25, dur: 2 },
        { step: "kite2", p1: "0,1", p2: "1,0.3318213621", move: "0.897812,0.667", beat: 28, dur: 2 },
        { step: "turn", p1: "0,0.2928932188", p2: "0.7071067812,1", move: "0.333,0.930964", beat: 31, dur: 2 },
        { step: "kite3", p1: "0,1", p2: "1,0.3318213621", move: "0.667,0.897812", pick: 1, beat: 34, dur: 2 },
        { step: "kite4", p1: "0,1", p2: "0.6681786379,0", move: "0.208238,0.583899", pick: 1, beat: 37, dur: 2 },
        // swing the points up: neck, tail, then the head, all reverse folds
        { step: "neck", p1: "0.1345593806,0", p2: "0.4733251916,1", move: "0.906033,0.694263", kind: "reverse", beat: 40, dur: 2 },
        { step: "tail", p1: "0,0.5266748083", p2: "1,0.8654406193", move: "0.246505,0.203815", kind: "reverse", beat: 43, dur: 2 },
        { step: "head", p1: "0,0.1274716613", p2: "1,0.8431274379", move: "0.096435,0.080352", kind: "reverse", beat: 46, dur: 2 },
        // both wings at once — front sheet and back sheet — held half-raised
        { step: "wings", p1: "0,0.1414213562", p2: "0.8585786438,1", move: "0.858,0.377;0.377,0.858", beat: 49, dur: 4, to: 0.5 },
      ],
    },
  },
  {
    name: "Origami Cicada",
    table: "origami",
    code: `// livecodata — Origami Cicada: the traditional model, nine simple folds
// The classic cicada (semi), folded for nearly two centuries: halve the
// square, fold both corners up, sweep the tips back out past the edges
// for wings, fold two head layers down (leaving the stripe), then tuck
// the sides behind. Every row is one fold, solved exactly when the code
// runs — same fold-table dialect as the Origami Crane sample (see its
// header for the column notes). Press "Run", then hit Play.

// \`schemas.origami\` is the canonical fold-table schema — the rows are seeded
// in the table panel on the right, one fold each.
editable("origami", schemas.origami)

// Colored side down, like the crane — the finished bug comes out green.
// .outThree() routes the paper to the 3D scene; the fold keyframes span two
// passes of the 16-beat loop: fold across the first and a half, hold the
// finished bug, then open flat and fold again.
const paper = origami().steps(table("origami"))
paper.spawn({ id: "cicada", color: 0xf4efe2, backColor: 0x79b356, pz: 1.2, rz: -0.785 })
  .concat(paper.sequence())
  .outThree()

// Things to try, live in the "origami" tab:
//   - Nudge wingL/wingR's p1/p2: the wings splay wider or tighter.
//   - Swap the head rows' move markers ("0.97,0.03" <-> "0.03,0.97") and
//     the stripe folds in the other order.
//   - Delete both tuck rows for the wide-bodied cicada variant.
`,
    tables: {
      origami: [
        // in half along the diagonal: the triangle, point down
        { step: "half", p1: "0,0", p2: "1,1", move: "0.667,0.333", beat: 1, dur: 2 },
        // both corners up to the top point
        { step: "cornerL", p1: "0,0.5", p2: "1,0.5", move: "0.1,0.3;0.3,0.1", beat: 4, dur: 2 },
        { step: "cornerR", p1: "0.5,0", p2: "0.5,1", move: "0.6,0.8;0.8,0.6", beat: 7, dur: 2 },
        // wings: sweep each tip back down so they point away from each
        // other and stick out past the triangle's edges
        { step: "wingL", p1: "0.19885,0.598479", p2: "1.001892,0.99618", move: "0.03,0.12;0.12,0.03", beat: 10, dur: 2 },
        { step: "wingR", p1: "0.401521,0.80115", p2: "0.00382,-0.001892", move: "0.88,0.97;0.97,0.88", beat: 13, dur: 2 },
        // the head: one layer down over the wings, the second stops short —
        // that little gap is the cicada's stripe
        { step: "head1", p1: "-0.19,0.59", p2: "0.41,1.19", move: "0.97,0.03", beat: 16, dur: 2 },
        { step: "head2", p1: "-0.24,0.64", p2: "0.36,1.24", move: "0.03,0.97", beat: 19, dur: 2 },
        // narrow the body: fold the side corners behind
        { step: "tuckL", p1: "0.09,0.59", p2: "0.39,0.29", move: "0.05,0.55", beat: 22, dur: 2 },
        { step: "tuckR", p1: "0.41,0.91", p2: "0.71,0.61", move: "0.45,0.95", beat: 25, dur: 2 },
      ],
    },
  },
  {
    name: "Origami Lotus",
    table: "origami",
    code: `// livecodata — Origami Lotus: a blunt-petalled bloom from a blintz
// The traditional water-lily fold, top-down: blintz the four corners to the
// centre (a "blintz" fold), coax each corner-point back out past the rim as a
// petal, then fold every petal's tip back for the lotus's rounded, two-tone
// petals around a pale heart. Every row is one simple fold, solved exactly
// when the code runs — same fold-table dialect as the Origami Crane sample
// (see its header for the column notes). Press "Run", then hit Play.

// \`schemas.origami\` is the canonical fold-table schema — the rows are seeded
// in the table panel on the right, one fold each.
editable("origami", schemas.origami)

// Colored side down, like the crane, so the petals come out colored against a
// pale centre. rx tips the flower back so you look into the bloom; rz spins it
// 45° so the petals sit square-on. .outThree() routes the create row + fold
// keyframes to the 3D scene, and playback bakes the per-frame cache
// automatically.
const paper = origami().steps(table("origami"))
paper.spawn({ id: "lotus", color: 0xfff2d6, backColor: 0xe0518a, pz: 1.2, rx: -0.22, rz: 0.785 })
  .concat(paper.sequence())
  .outThree()

// Things to try, live in the "origami" tab:
//   - Delete the four "t…" tip rows: the petals stay sharp, like the Lily.
//   - Give the last row (tNW) \`to: 0.5\`: its tip lifts half-folded, mid-bloom.
//   - Recolor the bloom: set backColor above to 0xf6b73a for a golden lotus.
`,
    tables: {
      origami: [
        // blintz: fold all four corners to the centre
        { step: "bl1", p1: "0.5,0", p2: "0,0.5", move: "0.05,0.05", beat: 1, dur: 0.9 },
        { step: "bl2", p1: "0.5,0", p2: "1,0.5", move: "0.95,0.05", beat: 2, dur: 0.9 },
        { step: "bl3", p1: "1,0.5", p2: "0.5,1", move: "0.95,0.95", beat: 3, dur: 0.9 },
        { step: "bl4", p1: "0.5,1", p2: "0,0.5", move: "0.05,0.95", beat: 4, dur: 0.9 },
        // fold each corner-point back out past the rim: four petals
        { step: "petSW", p1: "0.65,0", p2: "0,0.65", move: "0.03,0.03", beat: 5, dur: 0.9 },
        { step: "petSE", p1: "0.35,0", p2: "1,0.65", move: "0.97,0.03", beat: 6, dur: 0.9 },
        { step: "petNE", p1: "1,0.35", p2: "0.35,1", move: "0.97,0.97", beat: 7, dur: 0.9 },
        { step: "petNW", p1: "0,0.35", p2: "0.65,1", move: "0.03,0.97", beat: 8, dur: 0.9 },
        // fold each petal's tip back for a rounded, two-tone petal
        { step: "tSW", p1: "0.42,0", p2: "0,0.42", move: "0.01,0.01", beat: 9, dur: 0.9 },
        { step: "tSE", p1: "0.58,0", p2: "1,0.42", move: "0.99,0.01", beat: 10, dur: 0.9 },
        { step: "tNE", p1: "1,0.58", p2: "0.58,1", move: "0.99,0.99", beat: 11, dur: 0.9 },
        { step: "tNW", p1: "0,0.58", p2: "0.42,1", move: "0.01,0.99", beat: 12, dur: 0.9 },
      ],
    },
  },
  {
    name: "Origami Lily",
    table: "origami",
    code: `// livecodata — Origami Lily: four sharp petals in a star
// A blintz base (four corners folded to the centre), then each corner-point
// pulled straight back out past the rim into a pointed petal — a crisp
// four-fold star of petals around a pale heart. Every row is one simple fold,
// solved exactly when the code runs — same fold-table dialect as the Origami
// Crane sample (see its header for the column notes). Press "Run", then hit
// Play.

// \`schemas.origami\` is the canonical fold-table schema — the rows are seeded
// in the table panel on the right, one fold each.
editable("origami", schemas.origami)

// Colored side down, so the petals come out colored against a pale centre. rx
// tips the flower back to look into it. .outThree() routes the paper to the 3D
// scene; playback bakes the per-frame cache automatically.
const paper = origami().steps(table("origami"))
paper.spawn({ id: "lily", color: 0xf0eeff, backColor: 0x7a3fc0, pz: 1.2, rx: -0.22 })
  .concat(paper.sequence())
  .outThree()

// Things to try, live in the "origami" tab:
//   - Give the last petal (petNW) \`to: 0.5\`: one petal stands half-open.
//   - Swap color and backColor for a pale flower with a violet heart.
//   - Ease rx toward 0 to look straight at the star, or past -1 to see it
//     nearly edge-on.
`,
    tables: {
      origami: [
        // blintz: fold all four corners to the centre
        { step: "bl1", p1: "0.5,0", p2: "0,0.5", move: "0.05,0.05", beat: 1, dur: 0.9 },
        { step: "bl2", p1: "0.5,0", p2: "1,0.5", move: "0.95,0.05", beat: 2, dur: 0.9 },
        { step: "bl3", p1: "1,0.5", p2: "0.5,1", move: "0.95,0.95", beat: 3, dur: 0.9 },
        { step: "bl4", p1: "0.5,1", p2: "0,0.5", move: "0.05,0.95", beat: 4, dur: 0.9 },
        // pull each corner-point back out past the rim into a petal
        { step: "petSW", p1: "0.65,0", p2: "0,0.65", move: "0.03,0.03", beat: 5, dur: 0.9 },
        { step: "petSE", p1: "0.35,0", p2: "1,0.65", move: "0.97,0.03", beat: 6, dur: 0.9 },
        { step: "petNE", p1: "1,0.35", p2: "0.35,1", move: "0.97,0.97", beat: 7, dur: 0.9 },
        { step: "petNW", p1: "0,0.35", p2: "0.65,1", move: "0.03,0.97", beat: 8, dur: 0.9 },
      ],
    },
  },
  {
    name: "Origami Metamorphosis",
    table: "lotus",
    code: `// livecodata — Origami Metamorphosis: one sheet, two flowers
// A single square folds itself into the lotus, opens all the way back to a
// flat square, then folds into the lily — proof that a fold table runs in
// reverse. The trick is that origami().sequence() emits the whole folding as
// beat-keyed keyframes of ONE number (\`fold\`: how many folds have landed).
// .retime() warps those beats through a timeline (schemas.timeline), and a
// "pingpong" event replays the run there and BACK — so the paper unfolds
// itself, with no hand-mirrored rows. Press "Run", then hit Play.

// Two crease patterns can't live on one sheet, so each flower is its own
// origami program. They hand off at the shared flat square: fold=0 is the
// exact same bare square for every program, so swapping one paper object for
// the other there is invisible.
editable("lotus", schemas.origami)
editable("lily", schemas.origami)

const pose = { pz: 1.2, rx: -0.3 }
const lotus = origami().steps(table("lotus"))
const lily = origami().steps(table("lily"))

// pingpong the lotus: its fold runs over source beats 1–13; the pingpong's
// until-next window (beat 1, closed by the hold at beat 25) plays that forward
// then backward across beats 1–25, so it blooms by beat 13 and is flat again
// by 25. .retime warps the sequence's beats; the spawn (create) row is unmapped.
const bloomFall = rows([
  { event: "pingpong", beat: 1, from: 1, to: 13 },
  { event: "hold", beat: 25, from: 1 },
])

lotus.spawn({ id: "flowerA", color: 0xfff2d6, backColor: 0xe0518a, ...pose })
  .concat(lotus.sequence().retime(bloomFall))
  // hand off at the flat square: retire the lotus and raise the lily there,
  // both a plain square at that instant, so the swap can't be seen
  .concat(rows([{ id: "flowerA", event: "destroy", beat: 25 }]))
  .concat(lily.spawn({ id: "flowerB", beat: 25, color: 0xf0eeff, backColor: 0x7a3fc0, ...pose }))
  .concat(lily.sequence().shift(24))
  .outThree()

// Things to try, live in the tabs on the right:
//   - Edit either flower's fold table ("lotus"/"lily" tabs): the bloom retimes
//     to match with no code change.
//   - pingpong the lily too — \`.retime(rows([{ event: "pingpong", beat: 25,
//     from: 1, to: 9 }]))\` in place of \`.shift(24)\` — so it opens and closes
//     and the whole loop returns to a square.
//   - Widen "beats" under the scene to 40 to watch the whole cycle in one pass.
`,
    tables: {
      lotus: [
        // blintz: fold all four corners to the centre
        { step: "bl1", p1: "0.5,0", p2: "0,0.5", move: "0.05,0.05", beat: 1, dur: 0.9 },
        { step: "bl2", p1: "0.5,0", p2: "1,0.5", move: "0.95,0.05", beat: 2, dur: 0.9 },
        { step: "bl3", p1: "1,0.5", p2: "0.5,1", move: "0.95,0.95", beat: 3, dur: 0.9 },
        { step: "bl4", p1: "0.5,1", p2: "0,0.5", move: "0.05,0.95", beat: 4, dur: 0.9 },
        { step: "petSW", p1: "0.65,0", p2: "0,0.65", move: "0.03,0.03", beat: 5, dur: 0.9 },
        { step: "petSE", p1: "0.35,0", p2: "1,0.65", move: "0.97,0.03", beat: 6, dur: 0.9 },
        { step: "petNE", p1: "1,0.35", p2: "0.35,1", move: "0.97,0.97", beat: 7, dur: 0.9 },
        { step: "petNW", p1: "0,0.35", p2: "0.65,1", move: "0.03,0.97", beat: 8, dur: 0.9 },
        { step: "tSW", p1: "0.42,0", p2: "0,0.42", move: "0.01,0.01", beat: 9, dur: 0.9 },
        { step: "tSE", p1: "0.58,0", p2: "1,0.42", move: "0.99,0.01", beat: 10, dur: 0.9 },
        { step: "tNE", p1: "1,0.58", p2: "0.58,1", move: "0.99,0.99", beat: 11, dur: 0.9 },
        { step: "tNW", p1: "0,0.58", p2: "0.42,1", move: "0.01,0.99", beat: 12, dur: 0.9 },
      ],
      lily: [
        { step: "bl1", p1: "0.5,0", p2: "0,0.5", move: "0.05,0.05", beat: 1, dur: 0.9 },
        { step: "bl2", p1: "0.5,0", p2: "1,0.5", move: "0.95,0.05", beat: 2, dur: 0.9 },
        { step: "bl3", p1: "1,0.5", p2: "0.5,1", move: "0.95,0.95", beat: 3, dur: 0.9 },
        { step: "bl4", p1: "0.5,1", p2: "0,0.5", move: "0.05,0.95", beat: 4, dur: 0.9 },
        { step: "petSW", p1: "0.65,0", p2: "0,0.65", move: "0.03,0.03", beat: 5, dur: 0.9 },
        { step: "petSE", p1: "0.35,0", p2: "1,0.65", move: "0.97,0.03", beat: 6, dur: 0.9 },
        { step: "petNE", p1: "1,0.35", p2: "0.35,1", move: "0.97,0.97", beat: 7, dur: 0.9 },
        { step: "petNW", p1: "0,0.35", p2: "0.65,1", move: "0.03,0.97", beat: 8, dur: 0.9 },
      ],
    },
  },
  {
    name: "Hydra Sketch",
    table: "hydra",
    code: `// livecodata — a video-synth sketch with hydra (hydra-ts, a port of ojack's hydra)
// A generative hydra sketch — no 3D scene involved (src(s0) can equally post-
// process a rendered scene, sourcing whatever the 3D view draws). Press "Run"
// (or Cmd/Ctrl-Enter), then hit Play.

// A hydra table is a stream of EVENTS, each placed on the loop by its \`beat\`
// (1-indexed: beat 1 is the top of the loop). Two kinds:
//   - setCode:     \`code\` becomes the sketch — a string ending in .out(o0).
//   - setVariable: \`name\`/\`value\` sets one variable in scope while the sketch
//                  runs (e.g. freq below) — the most-recent value at each
//                  beat wins, same as setCode's code.
// Reference a variable as a FUNCTION — (props) => props.freq — rather than
// the bare name: hydra calls it fresh every frame, so the value tracks the
// table live, during playback, with no recompile/rerun. A bare \`freq\` would
// only ever see the value from when the sketch was compiled.
// Pick variable names that aren't hydra's OWN per-frame fields (time, bpm,
// fps, resolution, speed, stats) — those always win over an injected value
// of the same name, so e.g. naming this variable \`speed\` would silently be
// overridden by hydra's own playback-speed multiplier instead of your data.
//
// The loop is as many beats long as the "beats" control under the scene (16
// by default). So the freq change at beat 9 comes in halfway through the loop
// (the start of the 3rd measure) and stays until the loop wraps. Tap to
// change the tempo (how long a beat lasts); change "beats" to make the loop
// longer/shorter.
//
// editable(name, schema) makes this table live-editable in the table panel —
// it's the ONLY table this sketch needs (named "hydra" so playback reads it
// directly, with no code-generated view in between). Its rows are seeded on
// the right, so the code here carries only the schema — and \`schemas.hydra\`
// is the canonical one (hover it to see the columns): \`event\` and \`mode\`
// come as dropdowns, and \`code\` cells open in this editor with hydra
// completions. The events themselves live in the table: click the code cell
// to open the sketch here; edit a value cell, or "+ row" a new setVariable
// event at a later beat (like the beat-9 setVariable row already seeded)
// right in the table — no code change needed, and any column you add via
// "+ column" survives the next Run too. (Every edit is an event too — see
// the "hydra·events" tab.) A second, code-generated table only becomes
// useful once you need to LAYER computed events on top of these — build it
// in code and route it with .outHydra() (see "Hydra Sketch Swap"). Routing
// takes precedence over this by-name lookup, so the moment anything routes,
// route every table that should still play: table("hydra").outHydra()
// would keep this one in the mix.
//
// "disabled" is just an ordinary boolean column: check a row's box to mute
// that event — the sketch skips it, as if the row weren't there — without
// losing it; uncheck to bring it back.
editable("hydra", schemas.hydra)
`,
    tables: {
      hydra: [
        { beat: 1, event: "setCode",
          code: "osc((props) => props.freq, 0.1, 1.5).kaleid(5).out(o0)" },
        { beat: 1, event: "setVariable", name: "freq", value: 3 },
        { beat: 9, event: "setVariable", name: "freq", value: 12 },
      ],
    },
  },
  {
    name: "Square + Hydra",
    table: "hydra",
    code: `// livecodata — a flat square spun by three.js, echoed by a two-part hydra sketch
// The square is the plainest possible 3D object: a "box" squashed thin on one
// axis. This example is really about the hydra half — a sketch that changes
// itself partway through the loop, not just a variable (see "Hydra Sketch" for
// that simpler, single-part case). Press "Run" (or Cmd/Ctrl-Enter), then Play.

// 1. One square, spinning a full turn each loop. Two keyframes are enough:
//    ry: 0 at beat 1, ry: 2π at beat 16 — since 2π and 0 are the same angle,
//    the square rests on its start pose for the loop's last beat and the wrap
//    lands with no jump. (Push a keyframe past the loop's end instead — say
//    beat 17 — and those beats land on a SECOND pass: the scene only resets
//    once every two loops.) A small fixed tilt (rx) keeps the face in view as
//    it turns edge-on to the camera, rather than vanishing to a line.
//    .outThree() routes it to the 3D scene — no define, no name.
rows([
  { id: "square", event: "create", beat: 1, shape: "box", color: 0x4a9eff,
    px: 0, py: 0, pz: 0, hx: 0.6, hy: 0.6, hz: 0.05, rx: 0.3, ry: 0, rz: 0 },
  { id: "square", event: "update", beat: 16, ry: Math.PI * 2 },
]).outThree()

// 2. A two-part hydra sketch, on the same 16-beat grid as the square's spin
//    above: the first half echoes the rendered scene (src(s0)) with a feedback
//    trail; the second half drops the square entirely for a plain generative
//    pattern, then the loop wraps back to part one. Both are ordinary setCode
//    rows in the SAME editable table — "two-part" just means two of them, each
//    the most-recent code at its point in the loop. Their rows are seeded into
//    the "hydra" tab on the right; the code declares only the canonical
//    schema (hover \`schemas.hydra\` to see its columns).
editable("hydra", schemas.hydra)
`,
    tables: {
      hydra: [
        { beat: 1, event: "setCode",
          code: "src(s0).blend(src(o0).scale(0.97), 0.15).out(o0)" },
        { beat: 9, event: "setCode",
          code: "osc(8, 0.1, 1.2).kaleid(4).color(0.2, 0.6, 1).out(o0)" },
      ],
    },
  },
  {
    name: "Post",
    table: "post",
    code: `// livecodata — GPU post-processing on the rendered scene, as a table (TSL)
// The "post" view is hydra's sibling: a table of EVENTS on the loop that build
// a shader chain run over the rendered 3D scene BEFORE hydra ever sees it. Here
// a spinning square is turned to glowing edges, then wiped to a mosaic halfway
// through. Press "Run" (or Cmd/Ctrl-Enter), then Play.

// 1. A square spinning one full turn per 16-beat loop — the thing to process —
//    routed to the 3D scene with .outThree().
rows([
  { id: "square", event: "create", beat: 1, shape: "box", color: 0x4a9eff,
    px: 0, py: 0, pz: 0, hx: 0.7, hy: 0.7, hz: 0.06, rx: 0.3, ry: 0, rz: 0 },
  { id: "square", event: "update", beat: 16, ry: Math.PI * 2 },
]).outThree()

// 2. The post chain. The scene is the IMPLICIT source, so a cell reads like
//    hydra — \`edges(0.2).bloom(1.2)\` IS the effect stack applied to the scene.
//    No head, no routing, no .out(). Every op argument is either LIVE or
//    STRUCTURAL:
//      - LIVE (the default): a number, OR a function of the props object —
//        (p) => p.th — bound to a uniform the engine rewrites each frame, so it
//        tracks the table live with NO recompile. props carries your folded
//        variables plus the playback clock (p.time, p.beat, p.bpm).
//      - STRUCTURAL: an arg that picks a shader path (e.g. edges' colorMode)
//        and so bakes into the compiled shader.
//    The seeded "post" tab on the right holds these events:
//      - beat 1  setCode: edges((p) => p.th, 1).bloom((p) => p.glow)
//                       (colorMode 1 = edges drawn over the source).
//      - beat 1  setVariable: th = 0.15, glow = 0.2 — the chain's live inputs.
//      - beat 3  setVariable: th = 0.15 again — a REPEAT keyframe, so th holds
//                       flat here; it's the idiom that starts a ramp later than
//                       beat 1 (hold, then ramp).
//      - beat 5  setVariable: th → 0.4 with ease:easeInOut — same-name rows are
//                       a KEYFRAME TRACK, and a named ease GLIDES from the
//                       previous keyframe (0.15), arriving on THIS beat; blank
//                       ease would STEP (jump) instead.
//      - beat 7  pulse: glow += 1.2 over dur:1, easeOut — an additive decaying
//                       burst (pulses stack); the bloom flares.
//      - beat 9  add:   pixelate(6) — append an effect mid-loop.
//      - beat 11 remove: pixelate — drop it again by op name (the beat-time
//                       bypass, the un-add). No chain rewrite.
//      - beat 13 transition: composite to the NEXT setCode ahead through a
//                       per-pixel mask, \`gradient(0).thresh(progress().oneSub())\`
//                       — a directional wipe. The mask is a black→white chain
//                       (black keeps the old chain, white shows the new); it moves
//                       ONLY because \`progress()\` sweeps 0→1 across the window
//                       (this beat → the destination's beat, shaped by \`ease\`).
//                       \`.oneSub()\` (1 − value, on any live arg) flips the mask so
//                       the white/new region GROWS as progress runs. A bare
//                       \`progress()\` would crossfade; leave \`code\` BLANK and the
//                       mask is static black — the old chain HOLDS the whole
//                       window, then cuts to the new one (a delayed cut).
//      - beat 15 setCode: blend(prev().mosaic(4), 0.5) — the destination the
//                       wipe crosses to over beats 13→15; it feeds back the
//                       PREVIOUS output frame (prev()) blended with a mosaic of
//                       it, for a trailing kaleidoscope.
//    editable() makes the table live: click a code cell to edit the chain here,
//    or tweak/"+ row" events on the right — \`schemas.post\` is the canonical
//    schema (hover it for the columns). Check "disabled" to mute a row.
editable("post", schemas.post)
`,
    tables: {
      post: [
        { beat: 1, event: "setCode", code: "edges((p) => p.th, 1)\n  .bloom((p) => p.glow)" },
        { beat: 1, event: "setVariable", name: "th", value: 0.15 },
        { beat: 1, event: "setVariable", name: "glow", value: 0.2 },
        { beat: 3, event: "setVariable", name: "th", value: 0.15 },
        { beat: 5, event: "setVariable", name: "th", value: 0.4, ease: "easeInOut" },
        { beat: 7, event: "pulse", name: "glow", value: 1.2, dur: 1, ease: "easeOut" },
        { beat: 9, event: "add", code: "pixelate(6)" },
        { beat: 11, event: "remove", name: "pixelate" },
        { beat: 13, event: "transition", code: "gradient(0).thresh(progress().oneSub())", ease: "easeInOut" },
        { beat: 15, event: "setCode", code: "blend(prev().mosaic(4), 0.5)" },
      ],
    },
  },
  {
    name: "Sliders",
    table: "sliders",
    code: `// livecodata — on-screen sliders (the twin of MIDI)
// Sliders are labelled controls drawn over the visual. Press "Run", then Play,
// then drag a slider on the top-left of the scene.

// 1. A table named "sliders" DEFINES them: one row per slider, { name, min, max }
//    (plus an optional \`default\`). Each row becomes a labelled control over the
//    visual. It's an editable() table, seeded on the right with the schema
//    declared here (\`schemas.sliders\`, the canonical slider-table schema —
//    hover it to see the columns) — so open the "sliders" tab in the panel
//    and add a row, rename a name, or change a min/max, then Run to apply.
//    (It could just as well be computed: table("sliders", rows([...])).)
//    Check a row's \`disabled\` box to pull that control off the screen
//    without losing its settings — uncheck to bring it back.
editable("sliders", schemas.sliders)

// 2. expr.slider(name) is the sibling of expr.midi(note): a live per-frame value
//    you bind into any field. Here the sphere's height follows the "height"
//    slider — drag it and the orb moves; the value is recorded against playback
//    time and replays every loop (watch the thumb retrace your move). derive
//    leaves a binding resolved each frame, exactly like
//    derive({ amount: expr.midi("c4") }) — or derive({ ry: expr.time() }) to
//    ride the playback clock itself. .outThree() routes the orb to the scene.
rows([{ id: "orb", event: "create", beat: 1, shape: "sphere", color: 0xffd43b,
        px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }])
  .derive({ py: expr.slider("height") })
  .outThree()

// 3. In a hydra sketch every slider is also on props.sliders, keyed by name — no
//    setVariable rows needed. Reference it as a FUNCTION so hydra reads it fresh
//    each frame: (props) => props.sliders.warp. Here "warp" drives the modulate
//    amount and "brightness" the output level; .outHydra() routes the sketch.
rows([
  { beat: 1, event: "setCode", code:
    "src(s0).modulate(osc(30), (props) => props.sliders.warp)" +
    ".brightness((props) => props.sliders.brightness - 0.5).out(o0)" },
]).outHydra()

// Recording & sync: while you're not touching a slider, its recorded automation
// drives the thumb as the loop plays. Grabbing one opens a one-cycle recording
// window anchored where you grabbed: for one full loop it follows your hand
// instead of playing back, so you can draw a sweep that runs right across the
// loop seam (end into beginning). Once the playhead returns to the grab point
// the window closes and your take replays every loop — a single click just
// holds that value for the cycle, then loops it. Slider moves ride the shared
// session log, so they sync to everyone in a room and persist with the session.
// The raw moves show in the "slider·events" tab, the folded current take in
// "slider".
`,
    tables: {
      sliders: [
        { name: "brightness", min: 0, max: 1,   default: 0.6 },
        { name: "warp",       min: 0, max: 1.5, default: 0.3 },
        { name: "height",     min: -1, max: 1,  default: 0 },
      ],
    },
  },
  {
    name: "Particles",
    table: "particles",
    code: `// livecodata — GPU curl-noise particles, driven by a table
// A live particle system that runs entirely on the GPU (ported from threely):
// a huge cloud of points swept along a curl-noise flow field and coloured by
// their velocity. WebGPU browsers only (desktop Chrome/Edge) — under the WebGL2
// fallback the particles are skipped and only the scene below shows.
// Press "Run", then Play: the flow advances with the timeline and freezes when
// you pause, because the sim rides the beat clock like every other visual.

// 1. The "particles" view opts the sim in and steers it — an event table folded
//    at the playhead, like "post" and "hydra". A \`spawn\` row turns the sim ON
//    (without one it never runs). \`setVariable\` rows drive the field: \`name\` is "speed"
//    (how fast points ride the flow), "elscale" (size of the swirls), or
//    "timeMultiplier" (how fast the flow itself churns); \`value\` is the number.
//    Here it starts slow and broad, then quickens and tightens halfway through.
//    It's editable — open the "particles" tab to tweak a value or "+ row" an
//    event; \`schemas.particles\` is the canonical schema (hover for columns), and
//    a row's \`disabled\` box mutes it.
editable("particles", schemas.particles)

// 2. A dark core for the particles to swirl around — and content for playback to
//    run, since the particle clock only advances while the timeline plays. A
//    sphere at the origin turning once across the 16-beat loop, routed to the
//    scene with .outThree(); the additive particles read brightest against it.
t.sphere({ id: "core", r: 0.6, color: 0x140f28, px: 0, py: 0, pz: 0 })
  .three.rotate({ axis: "y", amount: 6.283, dur: 16 })
  .outThree()

// Tip: define a slider named "particles" (see the Sliders example) and it rides
// on top as a live speed override — play the flow by hand over the table's base.
`,
    tables: {
      particles: [
        { beat: 1, event: "spawn" },
        { beat: 1, event: "setVariable", name: "speed",          value: 0.002 },
        { beat: 1, event: "setVariable", name: "elscale",        value: 16 },
        { beat: 1, event: "setVariable", name: "timeMultiplier", value: 0.06 },
        { beat: 9, event: "setVariable", name: "speed",          value: 0.009 },
        { beat: 9, event: "setVariable", name: "elscale",        value: 8 },
      ],
    },
  },
  {
    name: "Hydra Sketch Swap",
    table: "hydra sketch",
    code: `// livecodata — swapping between two hydra sketches, with a flicker
// See "Hydra Sketch" first for the setCode/setVariable basics. Here the base
// table (\`code\`, below) just swaps scenes with a plain setCode at beat 9 (and
// wraps back at beat 1 when the loop repeats) — the flicker on top of that
// swap is built with \`rotate\` and a new pairing helper, \`pairBy\`. Press "Run"
// (or Cmd/Ctrl-Enter), then hit Play.

// 1. The base sketch: two scenes, swapping with a bare setCode at beat 9. This
//    is the SAME editable table as "Hydra Sketch", just named "hydra sketch"
//    (not "hydra") because we're layering a code-generated transform on top —
//    the transform below routes ITSELF to playback with .outHydra(), so this
//    base table needs its name only so the code (and its tab) can read it.
//    Its two setCode rows are seeded into the "hydra sketch" tab on the
//    right; the schema is the canonical \`schemas.hydra\` even though the
//    table wears a different name — the schema describes the columns, not
//    the table it's attached to.
editable("hydra sketch", schemas.hydra)

// 2. \`.pairBy({ field: value }, fn)\` finds the rows matching that pattern and
//    cycles through them pairwise: match k is \`second\`, paired with match
//    k-1 as \`first\` — and the LAST match wraps around to pair with the
//    FIRST, so every match gets a partner. fn(first, second) returns the
//    row(s) that replace \`second\`. With two setCode rows that's exactly two
//    pairs: (beat 1 → beat 9), and the wraparound (beat 9 → beat 1).
// 3. \`flicker(n, step)\` is the fn passed to pairBy. \`rotate(rows, values)\`
//    emits one row per \`values\` entry (so \`2*n - 1\` rows here), cycling
//    through the short \`rows\` pattern and merging each value on top:
//    output i = { ...rows[i % rows.length], ...values[i] }. Cycling
//    [second, first] under a run of ascending beats alternates the incoming
//    and outgoing scene — starting AND ending on \`second\` — so the new
//    scene flickers in and out n times before it settles, instead of a
//    hard cut.
const flicker = (n, step) => (first, second) =>
  rotate(
    [second, first],
    Array.from({ length: 2 * n - 1 }, (_, i) => ({ beat: second.beat + i * step })),
  ).rows

// 4. The transform playback actually plays: the editable table run through
//    pairBy, routed with .outHydra() — an unnamed table, combined into the
//    "hydra (system)" tab. The base "hydra sketch" table stays untouched.
table("hydra sketch").pairBy({ event: "setCode" }, flicker(3, 0.1)).outHydra()
`,
    tables: {
      "hydra sketch": [
        { beat: 1, event: "setCode", code: "osc(60, 0.1, 1.5).kaleid(5).out(o0)" },
        { beat: 9, event: "setCode", code: "noise(3, 0.2).colorama(0.5).out(o0)" },
      ],
    },
  },
  {
    name: "Hydra Meta",
    table: "hydra",
    code: `// livecodata — a hydra sketch that rewrites ITSELF as the loop plays
// See "Hydra Sketch" first for setCode/setVariable. On top of those, a hydra
// table has META-PROGRAMMING events — each transforms the code built up so far
// instead of replacing it, so the whole program edits itself on the beat. Press
// "Run" (or Cmd/Ctrl-Enter), then Play, and watch the sketch grow.
//
//   - replace   : swap every occurrence of a literal string (\`find\`) for
//                 \`value\` in the current sketch — no regex, just a substring
//                 swap. Here it retunes the oscillator's frequency mid-loop.
//   - append    : tack a \`.method(...)\` fragment (\`code\`, starting with a dot)
//                 onto the end of the chain, before its .out(). Here it grows a
//                 five-fold kaleidoscope.
//   - setSource : swap the HEAD of the chain — the leading generator — for
//                 \`code\`, keeping the effects after it. Here osc → noise, and
//                 the kaleidoscope from the append carries straight over.
//   - layer      : composite another whole sketch (\`code\`) over the current one
//                 with the hydra blend operator named by \`mode\` — blend / add /
//                 mult (which also take an amount \`value\`) or diff / layer /
//                 mask. Here voronoi is added in over the tail of the loop.
//   - transition : WIPE from the program built up so far (the "before", layers
//                 and all) to the NEXT setCode ahead — the wipe runs from this
//                 beat UNTIL that setCode's beat, so you place the destination
//                 where the wipe should END (no duration to tune; move the beat
//                 to make it longer or shorter). \`code\` is a MASK: where it's
//                 BLACK the before shows, where it's WHITE the after shows. The
//                 mask is YOUR sketch and you animate it from all-black to
//                 all-white across the window — three names are in scope to
//                 drive it: \`transitionStart\` / \`transitionEnd\` (the window in
//                 props.time units) and \`transitionPos(t)\` (that time as 0→1).
//                 Here a gradient ramp thresholded by transitionPos sweeps in as
//                 a directional wipe. (With the destination on the transition's
//                 OWN beat, the wipe fills a whole loop pass instead.)
//
// The events fold in beat order onto one running sketch: sampling at any beat
// replays every earlier transform, so the code you see is always the sum of the
// rows up to that point. The \`out\` column names the hydra output a row drives
// (o0 by default) — it's appended as the terminal \`.out(oN)\`, so the setCode
// lines never write their own — and each output folds on its own, so you can
// build a multi-output program (here everything stays on o0). All of it is
// seeded into the "hydra" tab on the right — edit a cell, drag a beat, or
// "+ row" another transform, no code change needed. This just declares the schema.
//
// \`schemas.hydra\` is the canonical schema for this table — hover it to see
// the columns. Three of them are ENUMS: \`event\`, \`mode\`, and \`out\` render
// as dropdowns, so picking a valid one during a set is a click, not a typed
// guess. And because every column is typed, a cell that doesn't fit — a
// misspelled event, text where a number belongs — is flagged red (its row
// too), a quick "this row is wrong" you catch before hitting Run.
editable("hydra", schemas.hydra)
`,
    tables: {
      hydra: [
        // A plain oscillator to start — the sketch every transform below edits.
        // No .out() needed: the `out` column (o0 by default) is appended for you.
        { beat: 1, event: "setCode", code: "osc(20, 0.1, 1.2)" },
        // beat 5: retune it in place — swap the frequency literal 20 → 45.
        { beat: 5, event: "replace", find: "20", value: 45 },
        // beat 7: grow the chain — a five-fold kaleidoscope, before .out().
        { beat: 7, event: "append", code: ".kaleid(5)" },
        // beat 9: swap the source osc → noise; the kaleidoscope stays put.
        { beat: 9, event: "setSource", code: "noise(2.5, 0.3)" },
        // beat 13: add a voronoi field in over the current sketch (mode "add",
        // amount 0.5) — a different compositor than a plain crossfade.
        { beat: 13, event: "layer", code: "voronoi(10)", mode: "add", value: 0.5 },
        // beat 14: WIPE to the next setCode ahead. `transition` snapshots
        // everything so far (noise + kaleid + voronoi) as the "before"; `code`
        // is the mask YOU animate black→white across the window. Here a static
        // gradient ramp is thresholded by transitionPos, so the threshold sweeps
        // 1→0 and the ramp fills in white left→right — a directional wipe. Swap
        // the mask for a dissolve, an iris, anything that goes black→white.
        { beat: 14, event: "transition", code: "gradient(0).thresh((props) => 1 - transitionPos(props.time), 0.15)" },
        // beat 16: the destination the wipe reveals — a brand-new sketch. The
        // wipe runs from beat 14 UNTIL here, so this beat sets the wipe's length;
        // drag it later for a slower cross, earlier for a snappier one.
        { beat: 16, event: "setCode", code: "osc(30, 0.2, 2).kaleid(7)" },
      ],
    },
  },
  {
    name: "Bauble Sketch",
    table: "bauble",
    code: `// livecodata — a 3D SDF sketch with bauble (ianthehenry's bauble.studio)
// Where hydra post-processes 2D textures, bauble raymarches a 3D scene written
// in Janet — shapes composed as signed distance functions and compiled to a
// GLSL shader. No 3D scene or hydra table involved: the bauble render shows
// directly. Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The bauble table is the same event format as the hydra one — rows placed on
// the loop by \`beat\` (1-indexed: beat 1 is the top of the loop), two kinds:
//   - setCode:     \`code\` becomes the sketch — a Janet shape expression like
//                  "(union (box 60) (sphere 75))". \`t\` is the playback clock
//                  in seconds, so pausing/scrubbing the timeline freezes/
//                  scrubs the raymarch too. The dialect is bauble.studio's:
//                  box/sphere/torus/cone…, union/intersect/subtract (\`:r\` for
//                  smooth blends), rotate/move/scale, twist/bend/morph,
//                  shade/color and friends.
//   - setVariable: \`name\`/\`value\` binds a variable the sketch reads — it's
//                  compiled in as \`(def name value)\` ahead of the code. A
//                  string value is any Janet expression: value "(sin t)" makes
//                  the variable a live wave. NOTE the difference from hydra:
//                  hydra reads variables per frame through props with no
//                  recompile, but bauble BAKES them into the shader — each
//                  change recompiles the sketch. Changing on the beat grid
//                  (like size at beat 9 below) is exactly what that's for;
//                  just don't drive one from something that sweeps every frame.
//
// The exception is the camera: "camera-x" / "camera-y" (orbit, in turns of a
// full revolution) and "camera-zoom" (distance multiplier, 1 = default) are
// reserved names the renderer consumes as live uniforms — never compiled in —
// so a camera move costs nothing. The beat-5 row below steps the orbit around
// the scene with no recompile at all.
//
// The rows are seeded into the "bauble" tab on the right — the code here
// declares only the schema, and \`schemas.bauble\` is the canonical one (hover
// it to see the columns). \`event\` is a dropdown; \`code\` cells open in this
// editor as Janet (each row's ⓘ shows the full compiled script, defs
// included); check \`disabled\` to mute a row without deleting it.
//
// Want to post-process the raymarch? The bauble render is also hydra's s1
// source — add a hydra table reading src(s1) and its output takes over the
// display: try
//   editable("hydra", schemas.hydra)
// with a row { beat: 1, event: "setCode", code: "src(s1).kaleid(3)" }.
editable("bauble", schemas.bauble)
`,
    tables: {
      bauble: [
        // A box spinning inside a sphere, smoothly blended (:r 15) and shaded
        // blue. `size` and `t` are free in the code — size comes from the
        // setVariable rows, t is the playback clock. Cells hold multi-line
        // Janet, indented the way bauble.studio's own examples are written;
        // click one to open it in the editor.
        { beat: 1, event: "setCode",
          code: "(shade\n  (union :r 15\n    (rotate (box size) :y t)\n    (sphere 70))\n  [0.29 0.62 1])" },
        { beat: 1, event: "setVariable", name: "size", value: 55 },
        // beat 5: orbit the camera a third of a turn — a live uniform, no
        // recompile (camera-x tilts, camera-zoom dollies, the same way).
        { beat: 5, event: "setVariable", name: "camera-y", value: 0.35 },
        // beat 9: grow the box through the sphere — a (def size …) change,
        // so this one recompiles the sketch, right on the beat.
        { beat: 9, event: "setVariable", name: "size", value: 85 },
        // beat 13: a new sketch for the loop's tail — a golden box twisting
        // back and forth on its y axis until the loop wraps.
        { beat: 13, event: "setCode",
          code: "(shade\n  (twist (box 70) :y (* 0.03 (sin t)))\n  [1 0.83 0.23])" },
      ],
    },
  },
  {
    name: "Run Counter",
    table: "runs",
    code: `// livecodata — a sketch that counts how many times you've run it
// Everything authored in livecodata lands on an append-only event log, and the
// logs are TABLES: the streaming tabs you watch fill up in the panel resolve
// with table(name) like any other data. "activity" is the session's pulse —
// every Apply (Run / Cmd/Ctrl-Enter) appends one { kind: "apply" } row. This
// sketch reads that log, so RUNNING it is what plays it: the code below never
// changes, yet it cooks to a different program every time it runs.
// Press "Run" (or Cmd/Ctrl-Enter), then Play — then press Run again. And again.

// 1. The run history: one row per Apply so far. \`at\` is the press's wall-clock
//    epoch ms, \`edits\` the batch of table edits it committed, \`changed\` which
//    outputs it altered. A cook always sees the session as it was the instant
//    BEFORE its own Run (the apply is recorded once the cook succeeds), so the
//    count ticks the moment the next result lands. Watch this view's tab grow.
//    table(name, fn) registers a named view — define() by another spelling;
//    the fn's own \`table\` argument tracks the dependency on "activity".
table("runs", (rand, table) => table("activity").filter({ kind: "apply" }))

// 2. Fold the log into the knobs of a hydra sketch — plain top-level code,
//    routed to playback with .outHydra(), no name needed:
//    - every Run adds a kaleidoscope facet (wrapping around at nine),
//    - every Run retunes the oscillator — the setVariable row's value below
//      is different each time the code runs, with no edit to the code,
//    - and your PACE plays too: \`heat\` is how hard this Run followed the one
//      before. Mash Run twice inside ten seconds and the sketch runs hot
//      (bright, fast spin); let it breathe a minute and it cools back down.
const runs = table("runs").rows
const n = runs.length
const last = runs[n - 1], prev = runs[n - 2]
const gap = prev && typeof last.at === "number" && typeof prev.at === "number"
  ? (last.at - prev.at) / 1000 : 60            // seconds between the last two Runs
const heat = Math.max(0, 1 - gap / 10)         // 1 = frantic, 0 = calm
rows([
  { beat: 1, event: "setCode",
    code: "osc((props) => props.freq, 0.06, " + (0.4 + heat).toFixed(2) + ")" +
          ".kaleid(" + (3 + (n % 7)) + ")" +
          ".rotate((props) => props.time * " + (0.03 + 0.4 * heat).toFixed(3) + ")" +
          ".out(o0)" },
  { beat: 1, event: "setVariable", name: "freq", value: 4 + (n % 24) },
]).outHydra()

// Things to try:
//   - Scrub the session bar backward: every step re-cooks against the SHORTER
//     log, so the sketch un-counts itself — the past looks exactly as it did.
//   - Count a different pulse: filter({ kind: "peer-join" }) reacts to people
//     joining your room instead of your Runs.
//   - Every editable table streams too: its full edit history is readable as
//     table("name·events") — see the Session Sculpture example for that.
`,
  },
  {
    name: "Session Sculpture",
    table: "pace",
    code: `// livecodata — the session as a sculpture
// table("activity") holds this session's own history — one { kind: "apply" }
// row per Run — and history makes good building material. This scene lays ONE
// BRICK PER RUN into a coiling tower: a brick's size is how many table edits
// that Run committed, its color how hot on the heels of the previous Run it
// came (red = seconds later, blue = after a long think), and the newest brick
// slowly turns. The tower only ever grows — keep working and the session
// piles up. Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

table("applies", (rand, table) => table("activity").filter({ kind: "apply" }))

// 1. One brick per apply, coiling upward a golden angle at a time (so bricks
//    never stack into a straight seam), sized by the apply's edit batch and
//    colored by the gap to the Run before it. Plain top-level code — the
//    bricks are routed to the scene with .outThree() at the end.
const applies = table("applies").orderBy("seq").rows
const bricks = applies.map((a, i) => {
  const prev = applies[i - 1]
  const gap = prev && typeof a.at === "number" && typeof prev.at === "number"
    ? (a.at - prev.at) / 1000 : 600
  const hot = Math.max(0, 1 - Math.min(gap, 60) / 60)   // 1 = instant, 0 = a minute+
  const edits = Array.isArray(a.edits) ? a.edits.length : 0
  const s = 0.09 + Math.min(edits, 20) * 0.012          // committed more → bigger brick
  const angle = i * 2.39996                             // the golden angle
  return {
    id: "b" + i, event: "create", beat: 1, shape: "box",
    color: (Math.round(70 + 185 * hot) << 16) | (70 << 8) | Math.round(255 - 185 * hot),
    hx: s, hy: s, hz: s,
    px: Math.cos(angle) * 0.9, py: -0.8 + i * 0.17, pz: Math.sin(angle) * 0.9,
    rx: 0, ry: -angle, rz: 0,
  }
})
// The newest brick turns one full revolution per loop (2π lands it back on
// its start angle at beat 16, so the wrap is seamless — same trick as
// Square + Hydra).
if (bricks.length) {
  const top = bricks[bricks.length - 1]
  bricks.push({ id: top.id, event: "update", beat: 16, ry: top.ry + Math.PI * 2 })
}
rows(bricks).outThree()

// 2. A caption that keeps count, floating just above the tower's top brick.
const n = applies.length
t.text({ id: "count", text: n + (n === 1 ? " run" : " runs"),
  size: 0.22, color: 0xf4efe2, py: -0.8 + n * 0.17 + 0.45 }).outThree()

// 3. The camera orbits once per 16-beat loop, craning up and backing off as
//    the tower grows — a sculpture deserves a walk-around. Bricks, caption
//    and camera each call .outThree(), so they combine beat-sorted into the
//    one "three (system)" scene table — no manual concat anywhere.
const ty = Math.max(0, (-0.8 + n * 0.17) / 2)
const eye = 2.6 + n * 0.05
t.camera([0, 0.5, 1, 1.5, 2].map((turns, i) => ({
  beat: Math.min(1 + i * 4, 16), // the return leg lands inside the loop
  px: Math.cos(turns * Math.PI) * eye, py: ty + 1.2, pz: Math.sin(turns * Math.PI) * eye,
  tx: 0, ty, tz: 0,
}))).outThree()

// 4. Your working rhythm, graphed: seconds between consecutive Runs. Spikes
//    are the long thinks; the flats near zero are a jam in full flow.
//    .save() names the table (its own "pace" tab) so the chart has a home.
rows(applies.map((a, i) => ({
  run: i + 1,
  gap_s: i ? Math.round((a.at - applies[i - 1].at) / 100) / 10 : 0,
}))).save("pace").graph("gap_s")

// Things to try:
//   - Edit any editable table a few times before a Run: that Run's brick
//     grows with the batch it committed (\`edits\`).
//   - Read an edit history directly: table("name·events") is the streaming
//     log behind any editable table — one row per cell you ever touched.
`,
  },
  {
    name: "Tap Constellation",
    table: "stars",
    code: `// livecodata — your sense of time, drawn
// The Tap button is a streaming log too: taps() is the tap-beat table, one row
// per press ({ beat, time } — ordinal + wall-clock ms), the same log the tempo
// folds from. This sketch draws the current tap window as a CONSTELLATION: one
// star per press, placed around a ring by where that press SHOULD have landed
// on the grid your own tapping implies — and pushed off the ring by how early
// (inward) or late (outward) it actually was. A metronome taps a perfect
// circle; a human taps a constellation.
// Tap the Tap button under the scene eight or more times, then press "Run"
// (or Cmd/Ctrl-Enter) to draw it. Tap a new rhythm, Run again, compare.
// (A tap alone re-tempos playback but doesn't re-cook — the drawing refreshes
// on Run. The window keeps the last 16 presses; a 2-second pause starts a
// fresh window — see the "taps" tab for the raw rows.)

table("stars", () => {
  const tp = taps().rows
  const n = tp.length
  if (n < 3) return t.text({ text: "tap the Tap button\\na few times, then Run",
    size: 0.24, color: 0x8899aa })
  // Fit the straight line time ≈ at0 + i·beatMs through the presses (least
  // squares) — the grid a perfect metronome WOULD have tapped. (Just joining
  // the first and last press would pin both of them onto the ring.)
  const mi = (n - 1) / 2
  const mt = tp.reduce((s, r) => s + r.time, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mi) * (tp[i].time - mt)
    den += (i - mi) * (i - mi)
  }
  const beatMs = num / den                       // ms per beat of the fitted grid
  const at0 = mt - beatMs * mi                   // when its beat 0 fell
  const stars = tp.map((r, i) => {
    const err = (r.time - (at0 + i * beatMs)) / beatMs   // beats early (−) or late (+)
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const rad = 1 + err * 4
    const off = Math.min(1, Math.abs(err) * 10)          // 0 on the grid → 1 wild
    return {
      id: "t" + i, event: "create", beat: 1, shape: "sphere",
      r: i === n - 1 ? 0.09 : 0.055,
      color: (255 << 16) | (Math.round(255 - 130 * off) << 8) | Math.round(255 - 225 * off),
      px: Math.cos(a) * rad, py: Math.sin(a) * rad, pz: 0, rx: 0, ry: 0, rz: 0,
    }
  })
  // The newest press blinks — a color pulse early in the loop.
  const newest = stars[stars.length - 1]
  stars.push({ id: newest.id, event: "update", beat: 5, color: 0x334455 })
  stars.push({ id: newest.id, event: "update", beat: 9, color: newest.color })
  return rows(stars)
})
table("stars").outThree()

// The perfect circle those stars are judged against, plus the tempo the same
// log folds to (tempo() is seconds per beat), spelled out underneath — routed
// straight to the scene, where it merges with the stars above.
const bpm = Math.round(60 / tempo())
t.torus({ id: "ring", r: 1, color: 0x2a3646 })
  .concat(t.text({ id: "bpm", text: bpm + " bpm", size: 0.2, color: 0x8899aa, py: -1.45 }))
  .outThree()

// A whisper of feedback so the constellation twinkles.
rows([
  { beat: 1, event: "setCode",
    code: "src(s0).blend(src(o0).scale(1.004), 0.2).out(o0)" },
]).outHydra()

// Things to try:
//   - Tap deliberately BEHIND the beat (a lazy backbeat): the ring spirals
//     outward. Rush it and the stars collapse inward instead.
//   - \`err\` is measured in beats, so the drawing is tempo-independent: sloppy
//     at 60 bpm looks exactly as sloppy at 180.
`,
  },
  {
    name: "House of Cards",
    table: "ball_height",
    code: `// livecodata — House of Cards
// A triangular pyramid of playing cards collapses when a ball drops on it.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views, Table verbs, and Expr methods (the methods
// after expr.field()/lit()/idx() — e.g. expr.field("v").add(1).gt(2)); hover a "view" name
// to preview its table; your caret selects that view's tab on the right.

// 1. Build a 3-story pyramid of cards plus a ball held above it.
//    Story k has (n − k) leaning-card tent pairs and (n − k − 1) horizontal
//    bridge cards between them. Card positions are derived analytically from the
//    lean angle so each card's lowest rotated corner rests on its support
//    surface — the pyramid starts at rest, no settling wobble. The ball's
//    \`dropAt: 2\` holds it motionless in the air for the first 2 seconds of
//    sim time, then releases it into ordinary free fall.
const lean = 0.25                    // radians from vertical (~14°)
const H = 0.35, W = 0.22, T = 0.005  // card half-height, half-width, half-thickness
const sl = Math.sin(lean), cl = Math.cos(lean)
const dx    = H * sl                 // card-center x offset from tent apex
const cyOff = T * sl + H * cl       // support-surface to card-center (no corner overlap)
const S     = 0.50                   // spacing between adjacent tent apices
const n     = 3                      // tents on the ground floor (try 4 for ~27 cards)

const cards = []
let supportY = -1.0                  // current support surface y (floor to start)

for (let k = 0; k < n; k++) {
  const numTents = n - k
  const cardCY   = supportY + cyOff
  const topY     = supportY + T * sl + 2 * H * cl  // tent apex y
  const bHx      = S / 2 + 0.03                    // bridge half-span

  // Leaning card pairs — two cards per tent, tops meeting at the apex
  for (let i = 0; i < numTents; i++) {
    const tx = -(numTents - 1) * S / 2 + i * S     // apex x
    cards.push(
      { id: "s" + k + "t" + i + "a", event: "create", shape: "box", color: 0xfdf6e3,
        motion: "dynamic", friction: 0.3, restitution: 0,
        px: tx - dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz: -lean },
      { id: "s" + k + "t" + i + "b", event: "create", shape: "box", color: 0xfdf6e3,
        motion: "dynamic", friction: 0.3, restitution: 0,
        px: tx + dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz:  lean },
    )
  }

  // Horizontal bridge cards spanning adjacent tent apices
  for (let i = 0; i < numTents - 1; i++) {
    const bx = -(numTents - 1) * S / 2 + (i + 0.5) * S
    cards.push(
      { id: "s" + k + "b" + i, event: "create", shape: "box", color: 0xe74c3c,
        motion: "dynamic", friction: 0.3, restitution: 0,
        px: bx, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
    )
  }

  // Crown on the top-story apex (replaces bridges on the final story)
  if (k === n - 1) {
    cards.push(
      { id: "crown", event: "create", shape: "box", color: 0xe74c3c,
        motion: "dynamic", friction: 0.3, restitution: 0,
        px: 0, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
    )
  }

  supportY = topY + 2 * T  // bridge top surface becomes next story's floor
}

const base = rows([
  { id: "floor", event: "create", shape: "box", color: 0x1a2e1a,
    motion: "static", px: 0, py: -1.2, pz: 0, hx: 4, hy: 0.2, hz: 4 },
  { id: "ball",  event: "create", shape: "sphere", color: 0xf39c12,
    motion: "dynamic", restitution: 0.2, r: 0.12, dropAt: 2,
    px: 0.05, py: 2.0, pz: 0 },
  ...cards,
])

// 2. Bake a JoltPhysics simulation in the background: step the world for 360
//    frames (12 beats at the fixed 30-frames-per-beat grid). simulate() ADDS to
//    the table — a per-frame "update" row for each moving body (\`beat\`, in
//    beats; the cache interpolates between them) plus a "collision" row whenever
//    two bodies first touch. Physics runs in real seconds internally and lands
//    its output on the beat grid, so a collision at beat 4 always sits at beat 4.
//    .outThree() routes the result to the 3D scene: everything routed this way
//    combines beat-sorted into the "three (system)" table — several simulations
//    would merge into the one sparse stream of object motion + collisions, no
//    manual .concat — and playback bakes the per-frame cache automatically.
const sim = physics(base).simulate({ steps: 360, gravity: -9.81 })
sim.outThree()

// 3. Collisions are just rows — pull them into their own named view (.save
//    gives them a tab) to inspect, and graph the ball's height over time as
//    it bounces and settles.
sim.filter({ event: "collision" }).save("collisions")

sim.filter({ id: "ball", event: "update" })
  .map(r => ({ beat: r.beat, height: r.py }))
  .save("ball_height")
  .graph("height")

// 4. Beat-synced looping (optional). Tap the Tap button under the scene a few
//    times to set the tempo; the timeline's wall-clock length then follows it —
//    tap faster and the whole loop plays faster. "Loop" (next to Play) is on by
//    default. beats(16) loops every 16 beats; { fit: 12 } stretches this 12-beat
//    sim across the window so it plays once per loop:
//
// beats(16, { fit: 12 }).outTimeline()
`,
  },
  {
    name: "CO2 (Mauna Loa)",
    table: "co2_monthly",
    code: `// Mauna Loa CO2 — monthly atmospheric measurements by NOAA/Scripps, 1958–2026.
// The seasonal swing (~6 ppm) reflects northern-hemisphere plant growth;
// the long-run rise tracks fossil-fuel emissions.
// Source: github.com/datasets/co2-ppm (NOAA GML)

table("co2", () => data("/data/co2.csv"))

// Monthly readings — the seasonal sawtooth is clearly visible
table("co2_monthly", (rand, table) => table("co2").graph("co2_ppm"))

// Annual mean: group monthly rows by year, average the ppm readings
table("co2_annual", (rand, table) =>
  table("co2")
    .derive({ year: r => +r.date.slice(0, 4) })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, co2_ppm: rs => +(rs.reduce((s, r) => s + r.co2_ppm, 0) / rs.length).toFixed(2) })
    .graph("co2_ppm")
)`,
  },
  {
    name: "Global temperature",
    table: "temp_chart",
    code: `// Global surface temperature anomaly — GCAG dataset, 1850–2026.
// Values are mean °C deviation from the 1901–2000 baseline.
// The sharp uptick from ~1980 is the clearest signal of anthropogenic warming.
// Source: github.com/datasets/global-temp (GCAG / NOAA)

table("temp", () => data("/data/global-temp.csv"))

// Temperature anomaly over time — negative = cooler than baseline, positive = warmer
table("temp_chart", (rand, table) => table("temp").graph("mean"))

// Running 10-year mean to smooth inter-annual variability: scan threads a
// window of the last 10 readings row-to-row and emits one smoothed row each.
table("temp_smooth", (rand, table) =>
  table("temp")
    .scan((window, r) => {
      const next = [...window.slice(-9), r.mean]
      return { state: next, emit: { year: r.year, mean: r.mean, avg10: +(next.reduce((s, v) => s + v, 0) / next.length).toFixed(4) } }
    }, [])
    .graph("mean", "avg10")
)`,
  },
  {
    name: "HadCRUT5 (global)",
    table: "anomaly_monthly",
    code: `// HadCRUT5 global surface temperature anomaly — Met Office / CRU, monthly 1850–present.
// Values are °C deviation from the 1961–1990 baseline with 95 % confidence bounds.
// Run \`npm run fetch-data\` once to download src/data/hadcrut5-monthly.csv.
// Source: Met Office HadOBS (HadCRUT.5.1.0.0)

table("hadcrut5", () => data("/data/hadcrut5-monthly.csv"))

// Monthly anomaly with confidence ribbon
table("anomaly_monthly", (rand, table) =>
  table("hadcrut5")
    .map(r => ({ ...r, anomaly_c: +r.anomaly_c, lower_ci: +r.lower_ci, upper_ci: +r.upper_ci }))
    .graph("anomaly_c", "lower_ci", "upper_ci")
)

// Annual mean anomaly
table("anomaly_annual", (rand, table) =>
  table("hadcrut5")
    .derive({ year: r => r.year_month.slice(0, 4), anomaly_c: r => +r.anomaly_c })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, anomaly_c: rs => +(rs.reduce((s, r) => s + r.anomaly_c, 0) / rs.length).toFixed(4) })
    .graph("anomaly_c")
)`,
  },
]
