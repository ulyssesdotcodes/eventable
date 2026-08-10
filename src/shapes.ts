// The scene shapes' shared vocabulary. The renderer (three-scene.ts
// makeGeometry), the physics engine (physics.ts makeShape) and the DSL surface
// (dsl.ts) all import from here so geometry, collision shape and the types the
// editor completes can't desynchronize.
// hx/hy/hz are half-extents, r a radius, h a half-height (rendered as 2·h).

export const SHAPE_DEFAULTS: Record<string, Record<string, number>> = {
  box:      { hx: 0.25, hy: 0.25, hz: 0.25 },
  sphere:   { r: 0.3 },
  cylinder: { r: 0.2, h: 0.3 },
  cone:     { r: 0.3, h: 0.3 },
  torus:    { r: 0.3 },
}

export type LightKind = 'ambient' | 'directional' | 'point' | 'spot' | 'hemisphere'

export const LIGHT_KINDS: ReadonlySet<LightKind> =
  new Set<LightKind>(['ambient', 'directional', 'point', 'spot', 'hemisphere'])
