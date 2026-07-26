# DSL live-coding plan

Design proposals for making the eventable DSL a first-class **live** instrument
— typed in front of an audience, where every keystroke costs and every verb has
to be *findable* under pressure. Hydra's grammar is the reference point: a flat
global namespace, terse chained verbs, every argument optional with a sensible
default, and function-valued args for per-frame liveness.

Nothing here is built yet. This is the roadmap that follows the essentials
refinement (see `src/dsl.ts`); it is written to be picked up one section at a
time. Priorities: **P0** = do first / highest leverage live, **P1** = clear win,
**P2** = nice to have.

## Where we are after the refinement

The surface is now: one `Table` type, generic verbs with no duplicates
(`map`/`filter`/`flatMap`/`emit`/`scan`/`fold`/`derive`/`join`/`zip`/`orderBy`/
`groupBy`), the scene-specific verbs (`pairBy`, `rotate`, `.three.*`, `retime`/
`shift`, `rasterize`, `crossings`, `rescale`, `lag`, `triggerEach`, `camera`),
and the builders (`box`…`text`/`object`, `origami`, `physics`, `beats`/`tempo`/
`taps`, `field`/`lit`/`idx`/`midi`/`slider`, `csv`/`data`/`json`/`grid`). Field/
value matching is object-based (`filter({ type: "collision" })`,
`pairBy({ event: "setCode" }, fn)`), and option types are inlined so hover shows
the shape.

That is the foundation the three goals build on.

## Goal A — a concise, findable grammar

**Problem.** Live, you can't grep docs. You need the right verb to be either
already in muscle memory or one Ctrl-Space away, and you need to *scan*
autocomplete fast. Hydra wins here because the vocabulary is small, flat, and
grouped by what it does.

- **A1 (P0) — Group the reference by task, not by receiver.** The ℹ popover and
  autocomplete currently list Builders / Table methods / Expr methods. Regroup
  into intent buckets — **make · shape · time · combine · aggregate · scene ·
  live** — so a performer thinks "I need to *time* this" and sees `retime`,
  `shift`, `beats`, `rasterize` together. Implementation: add a `group` field to
  each `DocEntry` in `src/editor-support.ts`; render buckets in
  `src/ui/docs-popover.tsx`; use the group as the CodeMirror completion `section`
  so the dropdown itself is grouped.
- **A2 (P0) — Every verb earns a one-line chip.** The `detail` string is what
  shows in the autocomplete row; audit all of them to be verb-first and scannable
  ("keep rows", "fan out rows", "spin over time"). Already mostly true — make it a
  rule and lint for it.
- **A3 (P1) — Fuzzy + recently-used ranking.** `completionBoost` in
  `src/completion.ts` already pins curated API above stdlib. Add a per-session
  most-recently-used set (persisted like other session state) and boost those to
  the top; let the fuzzy matcher tolerate subsequence matches ("rte" → `retime`).
- **A4 (P1) — An always-visible cheatsheet.** A collapsible one-column strip of
  verb → chip, filtered as you type, docked beside the editor. Reuses the
  `DocEntry` dictionaries, so it never drifts from completion.
- **A5 (P2) — Terse aliases for the hottest verbs**, hydra-style, only where the
  short form reads clearly (`fx` for a `.three` chain head, etc.). Add
  cautiously; each alias is surface to learn. Decide per-verb, not blanket.

## Goal B — three.js objects easy to manipulate

**Problem.** Today a static transform is set through `props`/`derive`, and only
`rotate`/`scale`/`move` animate. Anything else (absolute pose, continuous spin,
color, targeting one object in a crowd) means hand-writing `update` rows. Live,
that's too much typing.

- **B1 (P0) — `scene(...)` combinator.** Replace the ubiquitous
  `a.concat(b).concat(c).rasterize(n)` with `scene(a, b, c).rasterize(n)` (or fold
  the length in: `scene(a, b, c, { beats: n })`). Removes the most-repeated
  boilerplate in every scene sample.
- **B2 (P0) — Extend the `.three` chain.** Keep the keyframe+`rasterize` model;
  add ergonomic layers over it:
  - Absolute setters `moveTo` / `rotateTo` / `scaleTo` (today's verbs are all
    relative), so you can snap to a pose without knowing the current one.
  - `spin({ turns, per })` / `orbit({ radius, per })` for continuous, loop-length
    motion without computing wrap-around keyframes by hand.
  - `color(hex, { dur, ease })` to animate material color like a transform.
  - `hide(beat)` / `show(beat)` to gate objects on the timeline.
  - `at(beat)` / `over(beats)` chain modifiers so timing reads left-to-right:
    `box().three.at(4).spin({ turns: 1 })`.
- **B3 (P1) — Target objects by id/pattern.** `.three` acts on every `create`
  row; add `.only({ id })` / `.each(pattern)` so multi-object scenes can animate
  one body or a matching subset — pairs naturally with the object-match idiom now
  in `filter`/`pairBy`.
- **B4 (P2) — A fluent object handle.** `box({ id: "a" })` could return something
  that also chains transforms directly (`.spin().colorTo()`) without going through
  `.three`, collapsing the two-step build+animate into one.

## Goal C — beats & time ergonomics

**Problem.** Everything is on the beat grid, but placing events on it concisely is
still manual (`Array.from`, index math, hand-rolled retime). The primitives
(`beats`, `retime`, `rasterize`, `math().range`) are right; they need a terse
scheduling layer.

- **C1 (P0) — Scheduling sugar.**
  - `every(nBeats, template | fn)` → a Table of events on a regular grid over the
    loop (the single most common "do X on every beat/bar" need).
  - `.stagger(stepBeats)` → offset each row's `beat` by its index — sequenced
    spawns/arpeggios in one call.
  - `.repeat(n, everyBeats)` → clone a Table n times along the beat axis
    (`concat` + `shift` folded together), for building a phrase from one hit.
- **C2 (P0) — Beat-relative `Expr` helpers.** Add `beat()` (the row's beat) and a
  loop-`phase()` (0→1 within the current loop) as `Expr` nodes, so values can be
  driven by position in time declaratively — the diffable counterpart to reading
  the clock, and hydra-like (`osc` driven by time).
- **C3 (P1) — `retime` conveniences.** `.speed(x)` (= `retime({ scale: 1/x })`),
  `.reverse()`, and `.quantize(grid)` to snap ragged beats onto a subdivision —
  named verbs for the three retimes people actually reach for.
- **C4 (P1) — `.loop(beats)` as the one-call bake.** Sugar reading as "make this a
  `beats`-long loop" — `rasterize` + the `beats()` timeline in a single verb, so
  the last line of most programs shrinks to `scene(...).loop(16)`.

## Sequencing

1. **A1–A2, B1, C1** first — highest leverage for live use, all additive, no
   breaking changes.
2. **B2, C2–C4** next — the chained transform/time verbs that make the grammar
   feel like hydra.
3. **A3–A5, B3–B4** as polish once the vocabulary settles.

Each item is additive over the refined surface; none removes an existing verb.
Build them behind the same doc-dictionary + lang-env pipeline so completion,
hover, and the ℹ popover stay in lockstep automatically.
