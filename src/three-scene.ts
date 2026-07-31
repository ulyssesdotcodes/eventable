import * as THREE from 'three/webgpu'
import { attribute, materialColor, mix } from 'three/tsl'
import { createParticleSystem, type ParticleSystem } from './compute/particles.js'
import { FontLoader, type Font } from 'three/addons/loaders/FontLoader.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import helvetiker from 'three/examples/fonts/helvetiker_regular.typeface.json'
import { foldTablePositions, type FoldTableProgram } from './fold-engine.js'
import { geometryDims, primitiveGeometry, type GeometryDims } from './three-points.js'
import type { PostAPI } from './post-scene.js'

export interface SceneAPI {
  createObject(row: Record<string, unknown>): void
  updateObject(row: Record<string, unknown>): void
  destroyObject(id: unknown): void
  reset(): void
  // Driven by `shape: "camera"` rows (see cameraPose); also exposed for tooling.
  readonly camera: THREE.PerspectiveCamera
  // The renderer and scene, exposed so initPost (post-scene.ts) can stand up a
  // TSL RenderPipeline over the same scene the animate loop renders.
  readonly renderer: THREE.WebGPURenderer
  readonly scene: THREE.Scene
  // Install (or clear) the post-processing stage. When active, its render()
  // replaces the plain renderer.render in the animate loop.
  setPost(api: PostAPI | null): void
  // Opt the GPU particle system in or out. Particles are OFF by default: the
  // system is built lazily the first time a program enables it (main.ts
  // enables it exactly while a "particles" slider is defined), and only on the
  // WebGPU backend — the WebGL2 fallback has no compute shaders.
  setParticlesEnabled(on: boolean): void
  // Drive a live curl-noise particle parameter (GPU particle slice). A no-op
  // when the particle system isn't running — i.e. under the WebGL2 fallback,
  // which has no compute shaders. See src/compute/particles.ts.
  setParticleParam(name: 'timeMultiplier' | 'elscale' | 'speed', value: number): void
  // The playback position (in beats) that drives the particle sim's clock, so
  // it steps with play/pause/scrub like the other visualizers. Fed each tick
  // from the playback engine; a no-op when no particle system is running.
  setParticleTime(time: number): void
}

// Re-exported from three-points.ts, where the geometry builder is shared with
// the DSL's points() sampler so sampled and drawn geometry never drift.
export { geometryDims, type GeometryDims }

function sameDims(a: GeometryDims, b: GeometryDims): boolean {
  return a.hx === b.hx && a.hy === b.hy && a.hz === b.hz && a.r === b.r && a.h === b.h
}

// True when an update row's shape/size means the geometry must be disposed and
// rebuilt, not just repositioned.
export function geometryChanged(prevShape: string, prevDims: GeometryDims, row: Record<string, unknown>): boolean {
  const shape = (row.shape as string | undefined) ?? prevShape
  return shape !== prevShape || !sameDims(geometryDims(shape, row), prevDims)
}

const makeGeometry = primitiveGeometry

const PALETTE = [0x4a9eff, 0xff6b6b, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b]

// ── Text ────────────────────────────────────────────────────────────────────
// `shape: "text"` is real extruded geometry (TextGeometry) so it lights like any
// other mesh. The font is bundled and parsed synchronously — no asset fetch — so
// text builds the instant its create row is seen. `size` is the world-space cap
// height per line; glyphs outside the helvetiker set are skipped.

export interface TextParams { text: string; size: number; color: number }

const TEXT_DEFAULTS = { size: 0.5, color: 0xffffff }

export function textParams(row: Record<string, unknown>): TextParams {
  return {
    text: row.text == null ? '' : String(row.text),
    size: typeof row.size === 'number' ? (row.size as number) : TEXT_DEFAULTS.size,
    color: row.color != null ? (row.color as number) : TEXT_DEFAULTS.color,
  }
}

// True when the glyph geometry must be regenerated. Color is deliberately
// excluded — a color change is a cheap material swap, no rebuild.
export function textGeometryChanged(prev: TextParams, row: Record<string, unknown>): boolean {
  const p = textParams(row)
  return p.text !== prev.text || p.size !== prev.size
}

interface TextObject {
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
  params: TextParams
}

// Parsed lazily on the first text object so font parsing stays off the
// module-load path (and out of tests that only use the pure helpers above).
let _font: Font | null = null
function getFont(): Font {
  if (!_font) _font = new FontLoader().parse(helvetiker as unknown as Parameters<FontLoader['parse']>[0])
  return _font
}

// Centered on the origin so position/rotation place the CENTER, like the
// other shapes.
function makeTextGeometry(params: TextParams): THREE.BufferGeometry {
  const lines = params.text.split('\n')
  const font = getFont()
  const lineH = params.size * 1.4
  const parts: THREE.BufferGeometry[] = []
  lines.forEach((line, i) => {
    if (!line.length) return
    const g = new TextGeometry(line, {
      font, size: params.size, depth: params.size * 0.15, curveSegments: 6,
      bevelEnabled: true, bevelThickness: params.size * 0.02, bevelSize: params.size * 0.015, bevelSegments: 2,
    })
    // A line of only unknown glyphs yields no geometry — keep it out of the merge.
    if (!g.getAttribute('position')) { g.dispose(); return }
    g.translate(0, -i * lineH, 0)
    parts.push(g)
  })
  if (!parts.length) return new THREE.BufferGeometry()
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!
  if (parts.length > 1) parts.forEach((g) => g.dispose())
  merged.center()
  return merged
}

// Object3D.scale on top of the geometry's own dimensions, so a scale animation
// never rebuilds geometry.
function applyScale(obj: THREE.Object3D, row: Record<string, unknown>): void {
  obj.scale.set(num(row.sx, 1), num(row.sy, 1), num(row.sz, 1))
}

// Position/rotation/scale from a row, guarded: an unresolved binding or NaN
// degrades to the default instead of vanishing the mesh — the error surface
// is the table's invalid-cell flag, not a missing object.
function applyTransform(obj: THREE.Object3D, row: Record<string, unknown>): void {
  obj.position.set(num(row.px, 0), num(row.py, 0), num(row.pz, 0))
  obj.rotation.set(num(row.rx, 0), num(row.ry, 0), num(row.rz, 0))
  applyScale(obj, row)
}

function makeText(row: Record<string, unknown>): TextObject {
  const params = textParams(row)
  const geometry = makeTextGeometry(params)
  const material = new THREE.MeshStandardMaterial({ color: params.color, metalness: 0.3, roughness: 0.4 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = String(row.id)
  applyTransform(mesh, row)
  return { mesh, geometry, material, params }
}

function rebuildTextGeometry(obj: TextObject, row: Record<string, unknown>): void {
  const params = textParams(row)
  obj.geometry.dispose()
  obj.geometry = makeTextGeometry(params)
  obj.mesh.geometry = obj.geometry
  obj.params = params
}

function disposeText(obj: TextObject): void {
  obj.geometry.dispose()
  obj.material.dispose()
}

// ── Camera ──────────────────────────────────────────────────────────────────
// A `shape: "camera"` object adds no mesh — it drives the scene camera: px/py/pz
// the eye, tx/ty/tz the look-at target, `fov` vertical degrees. It flows through
// events → rasterize like any object, so camera moves are beat-timeline
// keyframes and interpolate for free.

export interface CameraPose { px: number; py: number; pz: number; tx: number; ty: number; tz: number; fov: number | null }

export const CAMERA_DEFAULT: CameraPose = { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, fov: 60 }

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

// `fov` is null when the row doesn't set it, so the current fov is left
// untouched.
export function cameraPose(row: Record<string, unknown>): CameraPose {
  return {
    px: num(row.px, CAMERA_DEFAULT.px), py: num(row.py, CAMERA_DEFAULT.py), pz: num(row.pz, CAMERA_DEFAULT.pz),
    tx: num(row.tx, CAMERA_DEFAULT.tx), ty: num(row.ty, CAMERA_DEFAULT.ty), tz: num(row.tz, CAMERA_DEFAULT.tz),
    fov: typeof row.fov === 'number' ? (row.fov as number) : null,
  }
}

// ── Lights ────────────────────────────────────────────────────────────────
// A `shape: "light"` object adds a three.js light instead of a mesh, riding
// events → rasterize like any object (so intensity/position/color animate as
// keyframe tracks). The user-facing field docs live on the DSL surface (dsl.ts).
// `kind` chooses the THREE.Light subclass; the rest resolve here.

export type LightKind = 'ambient' | 'directional' | 'point' | 'spot' | 'hemisphere'

const LIGHT_KINDS = new Set<LightKind>(['ambient', 'directional', 'point', 'spot', 'hemisphere'])

export interface LightParams {
  kind: LightKind
  color: number
  intensity: number
  px: number; py: number; pz: number
  tx: number; ty: number; tz: number
  distance: number
  decay: number
  angle: number
  penumbra: number
  groundColor: number
}

export const LIGHT_DEFAULT: LightParams = {
  kind: 'directional',
  color: 0xffffff,
  intensity: 1,
  px: 2, py: 3, pz: 4,
  tx: 0, ty: 0, tz: 0,
  distance: 0,
  decay: 2,
  angle: Math.PI / 3,
  penumbra: 0,
  groundColor: 0x444444,
}

// Resolve a (possibly partial) light row to concrete parameters. An unknown or
// missing `kind` reads as the default, so a bad kind never reaches THREE.
export function lightParams(row: Record<string, unknown>): LightParams {
  const d = LIGHT_DEFAULT
  return {
    kind: LIGHT_KINDS.has(row.kind as LightKind) ? (row.kind as LightKind) : d.kind,
    color: row.color != null ? (row.color as number) : d.color,
    intensity: num(row.intensity, d.intensity),
    px: num(row.px, d.px), py: num(row.py, d.py), pz: num(row.pz, d.pz),
    tx: num(row.tx, d.tx), ty: num(row.ty, d.ty), tz: num(row.tz, d.tz),
    distance: num(row.distance, d.distance),
    decay: num(row.decay, d.decay),
    angle: num(row.angle, d.angle),
    penumbra: num(row.penumbra, d.penumbra),
    groundColor: row.groundColor != null ? (row.groundColor as number) : d.groundColor,
  }
}

// A `kind` change is the one update that needs the THREE.Light rebuilt (a
// different class); every other field mutates in place. A row omitting `kind`
// (or naming an unknown one) keeps the current kind.
export function lightKindChanged(prevKind: LightKind, row: Record<string, unknown>): boolean {
  if (row.kind == null) return false
  const kind = LIGHT_KINDS.has(row.kind as LightKind) ? (row.kind as LightKind) : prevKind
  return kind !== prevKind
}

interface LightObject {
  light: THREE.Light
  // Directional/spot lights aim at this target, which must itself be added to
  // the scene for the aim to take effect; other kinds have none.
  target: THREE.Object3D | null
  kind: LightKind
}

function buildLight(p: LightParams): LightObject {
  switch (p.kind) {
    case 'ambient':
      return { light: new THREE.AmbientLight(p.color, p.intensity), target: null, kind: p.kind }
    case 'hemisphere':
      return { light: new THREE.HemisphereLight(p.color, p.groundColor, p.intensity), target: null, kind: p.kind }
    case 'point': {
      const l = new THREE.PointLight(p.color, p.intensity, p.distance, p.decay)
      l.position.set(p.px, p.py, p.pz)
      return { light: l, target: null, kind: p.kind }
    }
    case 'spot': {
      const l = new THREE.SpotLight(p.color, p.intensity, p.distance, p.angle, p.penumbra, p.decay)
      l.position.set(p.px, p.py, p.pz)
      const target = new THREE.Object3D()
      target.position.set(p.tx, p.ty, p.tz)
      l.target = target
      return { light: l, target, kind: p.kind }
    }
    case 'directional':
    default: {
      const l = new THREE.DirectionalLight(p.color, p.intensity)
      l.position.set(p.px, p.py, p.pz)
      const target = new THREE.Object3D()
      target.position.set(p.tx, p.ty, p.tz)
      l.target = target
      return { light: l, target, kind: p.kind }
    }
  }
}

// Live-update an existing light (same kind) from a resolved row.
function applyLight(obj: LightObject, p: LightParams): void {
  const l = obj.light
  l.color.set(p.color)
  l.intensity = p.intensity
  switch (obj.kind) {
    case 'ambient':
      break
    case 'hemisphere':
      (l as THREE.HemisphereLight).groundColor.set(p.groundColor)
      break
    case 'point': {
      const pl = l as THREE.PointLight
      pl.position.set(p.px, p.py, p.pz)
      pl.distance = p.distance
      pl.decay = p.decay
      break
    }
    case 'spot': {
      const sl = l as THREE.SpotLight
      sl.position.set(p.px, p.py, p.pz)
      sl.distance = p.distance
      sl.decay = p.decay
      sl.angle = p.angle
      sl.penumbra = p.penumbra
      if (obj.target) obj.target.position.set(p.tx, p.ty, p.tz)
      break
    }
    case 'directional': {
      (l as THREE.DirectionalLight).position.set(p.px, p.py, p.pz)
      if (obj.target) obj.target.position.set(p.tx, p.ty, p.tz)
      break
    }
  }
}

function disposeLight(obj: LightObject): void {
  obj.light.dispose()
}

// Folding paper. `fold` drives playback: how many folds have landed, fractional
// = the next flap mid-swing. Faces render as a per-face triangle soup so each
// face can be nudged by its layer index; edges are lines from the same positions.
interface OrigamiObject {
  root: THREE.Group
  program: FoldTableProgram
  fold: number
  shown: number
  paint: Paint
  painted: unknown            // the rows `paint` was built from, to skip rebuilds
  posAttr: THREE.BufferAttribute
  linePosAttr: THREE.BufferAttribute
  tintAttr: THREE.BufferAttribute
  maskAttr: THREE.BufferAttribute
  lineTintAttr: THREE.BufferAttribute
  lineMaskAttr: THREE.BufferAttribute
  front: THREE.MeshStandardNodeMaterial
  back: THREE.MeshStandardNodeMaterial
  line: THREE.LineBasicNodeMaterial
  geometry: THREE.BufferGeometry
  lineGeometry: THREE.BufferGeometry
}

const PAPER_BACK = 0xf4efe2

// A painted element: colour in the renderer's working space, plus how much the
// paint follows the swing (0 = held for the whole fold, 1 = a pulse peaking
// mid-swing).
interface Tint { r: number; g: number; b: number; fade: number }
// step → element → tint. Faces key on the face index, edges on "a,b" — the
// same numbering foldTablePositions hands back, valid within one step.
export interface Paint {
  faces: Map<number, Map<number, Tint>>
  edges: Map<number, Map<string, Tint>>
}

const _tint = new THREE.Color()

const tintOf = (row: Record<string, unknown>): Tint | null => {
  if (row.color == null) return null
  _tint.set(row.color as number)
  const fade = typeof row.fade === 'number' ? Math.min(1, Math.max(0, row.fade)) : 0
  return { r: _tint.r, g: _tint.g, b: _tint.b, fade }
}

/**
 * Index paint rows by (step, element). Rows without a `color` paint nothing;
 * later rows win, so a broad rule can be overridden by a narrower one after it.
 * Pure and exported: every decision the origami renderer acts on is testable
 * without a GPU.
 */
export function paintTables(
  faceRows: Record<string, unknown>[] | undefined,
  edgeRows: Record<string, unknown>[] | undefined,
): Paint {
  const paint: Paint = { faces: new Map(), edges: new Map() }
  for (const row of faceRows ?? []) {
    const tint = tintOf(row)
    if (tint == null || typeof row.step !== 'number' || typeof row.face !== 'number') continue
    const at = paint.faces.get(row.step) ?? new Map<number, Tint>()
    at.set(row.face, tint)
    paint.faces.set(row.step, at)
  }
  for (const row of edgeRows ?? []) {
    const tint = tintOf(row)
    if (tint == null || typeof row.step !== 'number') continue
    if (typeof row.a !== 'number' || typeof row.b !== 'number') continue
    const at = paint.edges.get(row.step) ?? new Map<string, Tint>()
    at.set(row.a < row.b ? `${row.a},${row.b}` : `${row.b},${row.a}`, tint)
    paint.edges.set(row.step, at)
  }
  return paint
}

function fillOrigami(obj: OrigamiObject): void {
  const { program } = obj
  const { FV, pos, zOff, zDir, step, swing } = foldTablePositions(program, obj.fold)
  // Layer offsets ride the paper: along the face's carried direction when the
  // motion provides one, else world z (the flat-state stacking axis).
  const offX = (fi: number): number => (zDir ? zDir[fi][0] * zOff[fi] : 0)
  const offY = (fi: number): number => (zDir ? zDir[fi][1] * zOff[fi] : 0)
  const offZ = (fi: number): number => (zDir ? zDir[fi][2] * zOff[fi] : zOff[fi])
  // How strongly a fading tint shows right now: nothing at either rest state,
  // full at the top of the swing. `fade: 0` opts out and paints throughout.
  const env = Math.sin(Math.PI * swing)
  const facePaint = obj.paint.faces.get(step)
  const edgePaint = obj.paint.edges.get(step)
  const P = obj.posAttr.array as Float32Array
  const T = obj.tintAttr.array as Float32Array
  const K = obj.maskAttr.array as Float32Array
  let n = 0, k = 0
  for (let fi = 0; fi < FV.length; ++fi) {
    const F = FV[fi]
    const ox = offX(fi), oy = offY(fi), oz = offZ(fi)
    const tint = facePaint?.get(fi)
    const mask = tint ? 1 - tint.fade + tint.fade * env : 0
    for (let j = 1; j + 1 < F.length; ++j) {
      for (const vi of [F[0], F[j], F[j + 1]]) {
        const v = pos[vi]
        P[n++] = v[0] + ox; P[n++] = v[1] + oy; P[n++] = v[2] + oz
        T[k * 3] = tint?.r ?? 0; T[k * 3 + 1] = tint?.g ?? 0; T[k * 3 + 2] = tint?.b ?? 0
        K[k++] = mask
      }
    }
  }
  obj.geometry.setDrawRange(0, n / 3)
  obj.posAttr.needsUpdate = true
  obj.tintAttr.needsUpdate = true
  obj.maskAttr.needsUpdate = true
  const L = obj.linePosAttr.array as Float32Array
  const LT = obj.lineTintAttr.array as Float32Array
  const LK = obj.lineMaskAttr.array as Float32Array
  let m = 0, e = 0
  const seen = new Set<string>()
  for (let fi = 0; fi < FV.length; ++fi) {
    const F = FV[fi]
    const ox = offX(fi), oy = offY(fi), oz = offZ(fi)
    let i = F.length - 1
    for (let j = 0; j < F.length; ++j) {
      const a = F[i], b = F[j]
      i = j
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (seen.has(key)) continue
      seen.add(key)
      L[m++] = pos[a][0] + ox; L[m++] = pos[a][1] + oy; L[m++] = pos[a][2] + oz
      L[m++] = pos[b][0] + ox; L[m++] = pos[b][1] + oy; L[m++] = pos[b][2] + oz
      const tint = edgePaint?.get(key)
      const mask = tint ? 1 - tint.fade + tint.fade * env : 0
      for (let end = 0; end < 2; ++end) {
        LT[e * 3] = tint?.r ?? 0; LT[e * 3 + 1] = tint?.g ?? 0; LT[e * 3 + 2] = tint?.b ?? 0
        LK[e++] = mask
      }
    }
  }
  obj.lineGeometry.setDrawRange(0, m / 3)
  obj.linePosAttr.needsUpdate = true
  obj.lineTintAttr.needsUpdate = true
  obj.lineMaskAttr.needsUpdate = true
  obj.shown = obj.fold
}

function makeOrigami(row: Record<string, unknown>): OrigamiObject {
  const program = row.program as FoldTableProgram
  let maxTris = Math.max(1, program.initial.FV.reduce((s, F) => s + F.length - 2, 0))
  let maxEdges = Math.max(1, program.initial.FV.reduce((s, F) => s + F.length, 0))
  for (const step of program.steps) {
    maxTris = Math.max(maxTris, step.FV.reduce((s, F) => s + F.length - 2, 0))
    maxEdges = Math.max(maxEdges, step.FV.reduce((s, F) => s + F.length, 0))
  }

  const dyn = (n: number, size: number): THREE.BufferAttribute => {
    const a = new THREE.BufferAttribute(new Float32Array(n), size)
    a.setUsage(THREE.DynamicDrawUsage)
    return a
  }
  const posAttr = dyn(maxTris * 9, 3)
  const tintAttr = dyn(maxTris * 9, 3)
  const maskAttr = dyn(maxTris * 3, 1)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', posAttr)
  geometry.setAttribute('tint', tintAttr)
  geometry.setAttribute('tintMask', maskAttr)

  const color = row.color != null ? (row.color as number) : 0xd94f2a
  const backColor = row.backColor != null ? (row.backColor as number) : PAPER_BACK
  // Two single-sided materials so front and back read differently (classic
  // origami: colored face, white back). flatShading derives face normals
  // in-shader, so no normal attribute needs recomputing per frame.
  const common = {
    metalness: 0.05,
    roughness: 0.85,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }
  // Per-element paint blends OVER each material's own colour rather than
  // multiplying it (what `vertexColors` would do): front and back share one
  // geometry, so a multiplied tint could never leave the two papers different
  // colours. `materialColor` reads material.color live, so an unpainted model
  // and the `color` decay pulse both keep working with no buffer refill.
  const paintNode = () =>
    mix(materialColor, attribute('tint', 'vec3'), attribute('tintMask', 'float'))
  const front = new THREE.MeshStandardNodeMaterial({ ...common, color, side: THREE.FrontSide })
  const back = new THREE.MeshStandardNodeMaterial({ ...common, color: backColor, side: THREE.BackSide })
  front.colorNode = paintNode()
  back.colorNode = paintNode()

  const linePosAttr = dyn(maxEdges * 6, 3)
  const lineTintAttr = dyn(maxEdges * 6, 3)
  const lineMaskAttr = dyn(maxEdges * 2, 1)
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', linePosAttr)
  lineGeometry.setAttribute('tint', lineTintAttr)
  lineGeometry.setAttribute('tintMask', lineMaskAttr)
  const line = new THREE.LineBasicNodeMaterial({ color: 0x1c1713, transparent: true, opacity: 0.5 })
  line.colorNode = paintNode()

  const root = new THREE.Group()
  root.add(new THREE.Mesh(geometry, front))
  root.add(new THREE.Mesh(geometry, back))
  root.add(new THREE.LineSegments(lineGeometry, line))

  const obj: OrigamiObject = {
    root, program, fold: 0, shown: -1,
    paint: { faces: new Map(), edges: new Map() }, painted: undefined,
    posAttr, linePosAttr, tintAttr, maskAttr, lineTintAttr, lineMaskAttr,
    front, back, line, geometry, lineGeometry,
  }
  applyOrigamiRow(obj, row)
  fillOrigami(obj)
  return obj
}

function applyOrigamiRow(obj: OrigamiObject, row: Record<string, unknown>): void {
  applyTransform(obj.root, row)
  if (row.color != null) obj.front.color.set(row.color as number)
  if (row.backColor != null) obj.back.color.set(row.backColor as number)
  if (typeof row.fold === 'number' && Number.isFinite(row.fold)) obj.fold = row.fold
  // Paint rows arrive as the same array object every frame (rasterize carries
  // extras through by reference), so identity is enough to skip the rebuild.
  const key = row.faces ?? row.edges ? [row.faces, row.edges] : undefined
  if (key && !sameRefs(obj.painted, key)) {
    obj.paint = paintTables(
      row.faces as Record<string, unknown>[] | undefined,
      row.edges as Record<string, unknown>[] | undefined)
    obj.painted = key
    obj.shown = NaN   // force a refill: the fold value alone hasn't changed
  }
}

const sameRefs = (a: unknown, b: unknown[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])

function disposeOrigami(obj: OrigamiObject): void {
  obj.geometry.dispose()
  obj.lineGeometry.dispose()
  obj.front.dispose()
  obj.back.dispose()
  obj.line.dispose()
}

// Renders to its own canvas, which is *not* shown directly — hydra (see
// hydra-scene.ts) takes it as a source texture and post-processes it onto the
// visible canvas.
export function initThree(canvas: HTMLCanvasElement, sizeFrom: HTMLElement): SceneAPI {
  // WebGPU when the browser has it, with an automatic WebGL2 fallback baked
  // into WebGPURenderer — so the same code path drives both backends. The
  // backend is chosen during renderer.init(), which the render loop awaits.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 5)

  // Default lighting so an unlit program still reads. Held on until the DSL
  // adds a light of its own (see syncDefaultLights).
  const dirLight = new THREE.DirectionalLight(0xffffff, 2)
  dirLight.position.set(2, 3, 4)
  const ambientLight = new THREE.AmbientLight(0xffffff, 2)
  const defaultLights: THREE.Light[] = [dirLight, ambientLight]
  let defaultLightsOn = false
  function setDefaultLights(on: boolean): void {
    if (on === defaultLightsOn) return
    for (const l of defaultLights) on ? scene.add(l) : scene.remove(l)
    defaultLightsOn = on
  }
  setDefaultLights(true)

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = sizeFrom
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  new ResizeObserver(resize).observe(sizeFrom)

  const objects = new Map<unknown, THREE.Mesh>()
  const origamis = new Map<unknown, OrigamiObject>()
  const texts = new Map<unknown, TextObject>()
  const lights = new Map<unknown, LightObject>()
  const cameras = new Set<unknown>()
  let colorIdx = 0

  // Defaults on exactly while the program has no light of its own.
  function syncDefaultLights(): void {
    setDefaultLights(lights.size === 0)
  }

  function addLight(id: unknown, obj: LightObject): void {
    scene.add(obj.light)
    if (obj.target) scene.add(obj.target)
    lights.set(id, obj)
    syncDefaultLights()
  }

  function removeLight(id: unknown, obj: LightObject): void {
    scene.remove(obj.light)
    if (obj.target) scene.remove(obj.target)
    disposeLight(obj)
    lights.delete(id)
  }

  function applyCamera(row: Record<string, unknown>): void {
    const p = cameraPose(row)
    camera.position.set(p.px, p.py, p.pz)
    camera.up.set(0, 1, 0)
    camera.lookAt(p.tx, p.ty, p.tz)
    if (p.fov != null && p.fov !== camera.fov) {
      camera.fov = p.fov
      camera.updateProjectionMatrix()
    }
  }

  function resetCamera(): void {
    const d = CAMERA_DEFAULT
    camera.position.set(d.px, d.py, d.pz)
    camera.up.set(0, 1, 0)
    camera.lookAt(d.tx, d.ty, d.tz)
    if (camera.fov !== d.fov) {
      camera.fov = d.fov!
      camera.updateProjectionMatrix()
    }
  }

  // The GPU particle system (curl-noise compute). Opt-in: built lazily the
  // first time setParticlesEnabled(true) arrives — never as scene furniture —
  // and only on the WebGPU backend (the WebGL2 fallback has no compute
  // shaders). Disabling hides the sprite and freezes the sim; re-enabling
  // reuses the built system.
  let particles: ParticleSystem | null = null
  let particlesWanted = false
  let particlesBuilding = false
  let webgpu = false

  function syncParticles(): void {
    if (particles) {
      particles.sprite.visible = particlesWanted
      return
    }
    if (!particlesWanted || !webgpu || particlesBuilding) return
    particlesBuilding = true
    createParticleSystem(renderer).then((p) => {
      particles = p
      scene.add(p.sprite)
      p.sprite.visible = particlesWanted
    }).catch((e) => {
      console.error('three-scene: particle system init failed', e)
    })
  }
  // Latest playback position (beats), pushed in by the engine via
  // setParticleTime; the sim steps only when this moves (see particles.tick).
  let particleTime = 0

  // The post-processing stage (post-scene.ts), installed by main.ts after
  // initPost. When it has a program its render() renders the scene through a TSL
  // RenderPipeline and returns true; with no post rows it returns false and the
  // plain path below runs — byte-identical to the pre-post loop.
  let post: PostAPI | null = null

  function animate(): void {
    for (const o of origamis.values()) {
      if (o.shown !== o.fold) fillOrigami(o)
    }
    if (particles?.sprite.visible) particles.tick(particleTime)
    if (!post?.render()) renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  // WebGPURenderer must finish backend init before the first render() (it
  // picks WebGPU, or falls back to a WebGL2 backend, during init). Gate the
  // loop on that; a rejected init would leave the scene un-drawn, so surface it.
  renderer.init().then(() => {
    const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined
    webgpu = backend?.isWebGPUBackend === true
    syncParticles() // in case a program enabled particles before init resolved
    requestAnimationFrame(animate)
  }).catch((e) => {
    console.error('three-scene: renderer init failed', e)
  })

  return {
    camera,
    renderer,
    scene,
    setPost(api: PostAPI | null): void {
      post = api
    },
    setParticlesEnabled(on: boolean): void {
      if (on === particlesWanted) return
      particlesWanted = on
      syncParticles()
    },
    setParticleParam(name: 'timeMultiplier' | 'elscale' | 'speed', value: number): void {
      if (particles) particles.params[name] = value
    },
    setParticleTime(time: number): void {
      particleTime = time
    },
    createObject(row: Record<string, unknown>): void {
      const { id, shape, color } = row
      if (objects.has(id) || origamis.has(id) || texts.has(id) || lights.has(id) || cameras.has(id)) return
      if (shape === 'camera') {
        applyCamera(row)
        cameras.add(id)
        return
      }
      if (shape === 'light') {
        addLight(id, buildLight(lightParams(row)))
        return
      }
      if (shape === 'origami' && row.program) {
        const obj = makeOrigami(row)
        scene.add(obj.root)
        origamis.set(id, obj)
        return
      }
      if (shape === 'text') {
        const obj = makeText(row)
        scene.add(obj.mesh)
        texts.set(id, obj)
        return
      }
      const geo = makeGeometry(shape as string, row)
      const mat = new THREE.MeshStandardMaterial({
        color: color != null ? color as number : PALETTE[colorIdx % PALETTE.length],
        metalness: 0.35,
        roughness: 0.4,
      })
      colorIdx++
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = String(id)
      applyTransform(mesh, row)
      mesh.userData.shape = shape
      mesh.userData.dims = geometryDims(shape as string, row)
      scene.add(mesh)
      objects.set(id, mesh)
    },

    updateObject(row: Record<string, unknown>): void {
      const { id, color } = row
      if (cameras.has(id)) {
        applyCamera(row)
        return
      }
      const origami = origamis.get(id)
      if (origami) {
        // An edited fold table re-cooks the program, but a re-run always
        // arrives here rather than as a create — so a changed program has to
        // rebuild the object. Its buffers are sized for the old topology and
        // its paint is keyed by the old face numbering; keeping it would draw
        // the wrong paper in the wrong colours.
        if (row.program && row.program !== origami.program) {
          scene.remove(origami.root)
          disposeOrigami(origami)
          const rebuilt = makeOrigami(row)
          scene.add(rebuilt.root)
          origamis.set(id, rebuilt)
          return
        }
        applyOrigamiRow(origami, row)
        return
      }
      const text = texts.get(id)
      if (text) {
        applyTransform(text.mesh, row)
        if (color != null) text.material.color.set(color as number)
        if (textGeometryChanged(text.params, row)) rebuildTextGeometry(text, row)
        return
      }
      const light = lights.get(id)
      if (light) {
        const p = lightParams(row)
        // A kind change swaps the THREE.Light class — rebuild in place; anything
        // else is a live property update on the existing light.
        if (lightKindChanged(light.kind, row)) {
          removeLight(id, light)
          addLight(id, buildLight(p))
        } else {
          applyLight(light, p)
        }
        return
      }
      const mesh = objects.get(id)
      if (!mesh) return
      applyTransform(mesh, row)
      if (color != null) (mesh.material as THREE.MeshStandardMaterial).color.set(color as number)
      const prevShape = mesh.userData.shape as string
      if (geometryChanged(prevShape, mesh.userData.dims, row)) {
        const shape = (row.shape as string | undefined) ?? prevShape
        mesh.geometry.dispose()
        mesh.geometry = makeGeometry(shape, row)
        mesh.userData.shape = shape
        mesh.userData.dims = geometryDims(shape, row)
      }
    },

    destroyObject(id: unknown): void {
      if (cameras.has(id)) {
        cameras.delete(id)
        if (cameras.size === 0) resetCamera()
        return
      }
      const origami = origamis.get(id)
      if (origami) {
        scene.remove(origami.root)
        disposeOrigami(origami)
        origamis.delete(id)
        return
      }
      const text = texts.get(id)
      if (text) {
        scene.remove(text.mesh)
        disposeText(text)
        texts.delete(id)
        return
      }
      const light = lights.get(id)
      if (light) {
        removeLight(id, light)
        syncDefaultLights()
        return
      }
      const mesh = objects.get(id)
      if (!mesh) return
      scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.MeshStandardMaterial).dispose()
      objects.delete(id)
    },

    reset(): void {
      for (const mesh of objects.values()) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        ;(mesh.material as THREE.MeshStandardMaterial).dispose()
      }
      objects.clear()
      for (const origami of origamis.values()) {
        scene.remove(origami.root)
        disposeOrigami(origami)
      }
      origamis.clear()
      for (const text of texts.values()) {
        scene.remove(text.mesh)
        disposeText(text)
      }
      texts.clear()
      for (const light of lights.values()) {
        scene.remove(light.light)
        if (light.target) scene.remove(light.target)
        disposeLight(light)
      }
      lights.clear()
      syncDefaultLights()
      cameras.clear()
      resetCamera()
      colorIdx = 0
    },
  }
}
