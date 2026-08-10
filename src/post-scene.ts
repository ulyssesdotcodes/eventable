// eventable post-scene — the TSL engine behind the post view. Turns the op
// lists folded by post.ts into a `three` node graph rendered by a RenderPipeline
// over the same scene three-scene.ts draws, BEFORE hydra samples the canvas as
// s0. All compilation happens at setProgram (cook/apply): every distinct folded
// state is built and warm-rendered once, so playback only writes uniforms and
// swaps between precompiled pipelines — never compiles on a beat.
//
// Works on the WebGL2 fallback (TSL compiles to GLSL there) — nothing gates on
// the backend. Determinism: no TSL `time`/`performance.now()` anywhere; all
// time/beat reaches ops through the props object the visualizer assembles from
// the playback clock.

import * as THREE from 'three/webgpu'
import * as TSL from 'three/tsl'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { sobel } from 'three/addons/tsl/display/SobelOperatorNode.js'
import { POST_OPS, forEachLiveArg, collectLiveValues, evalPostCode, type OpChain, type OpCall } from './post-lang.js'
import { postFrameAt, postStateFrames, type PostFrame } from './post.js'
import type { Row } from './lineage.js'

// TSL's node-builder types are far stricter than the runtime (every op is
// overloaded per vector width); typing each intermediate adds no safety to
// shader-graph code, so we treat the namespace as untyped — the shader is the
// contract. (Same stance as compute/particles.ts.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t: any = TSL

export interface PostAPI {
  // loopFrames is the wrap length the fold samples against: a transition's
  // until-next window can wrap the loop seam, so which states exist depends on
  // it. Precompiling with the wrong value (e.g. 0) leaves the wrapped state to
  // compile lazily on a beat — the recompile stall this precompile exists to
  // avoid. The visualizer re-programs when it changes.
  setProgram(index: Row[], loopFrames: number): void
  setFrame(frame: PostFrame | null, props: Record<string, unknown>): void
  // The open post cell's applied chain (null when no such cell is open), drawn
  // to initPost's `preview` canvas. Throws what that chain throws — the caller
  // owns reporting it.
  setPreview(code: string | null, props: Record<string, unknown>): void
  render(): boolean
  resize(): void
  reset(): void
}

const BLUR_SIGMA = 4

// Deterministic 2D hash → two values in [0, 1), the fract(sin(dot)) trick the
// grain op uses, doubled up. Shared by the noise/voronoi generators; no wall
// time anywhere, so both scrub deterministically.
const hash2 = (p: Node): Node =>
  t.fract(t.sin(t.vec2(t.dot(p, t.vec2(127.1, 311.7)), t.dot(p, t.vec2(269.5, 183.3)))).mul(43758.5453))

// One octave of 2D Perlin noise at `p`, remapped to roughly 0→1: the classic
// quintic-faded bilinear mix of four corner gradient·offset dot products.
function perlin(p: Node): Node {
  const i = t.floor(p)
  const f = t.fract(p)
  const corner = (ox: number, oy: number): Node => {
    const o = t.vec2(ox, oy)
    return t.dot(hash2(i.add(o)).mul(2).sub(1), f.sub(o))
  }
  const w = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10))
  const x0 = t.mix(corner(0, 0), corner(1, 0), w.x)
  const x1 = t.mix(corner(0, 1), corner(1, 1), w.x)
  return t.clamp(t.mix(x0, x1, w.y).mul(0.7).add(0.5), 0, 1)
}

// The initial value for op arg `i`: its constant when the arg is a plain number,
// else the registry default (a function-valued arg is overwritten every frame).
function liveInit(op: OpCall, i: number): number {
  const v = op.args[i]?.value
  return typeof v === 'number' ? v : (POST_OPS[op.op]?.args[i]?.default ?? 0)
}

interface Graph {
  node: Node
  uniforms: Node[]
  usesPrev: boolean
  chain: OpChain
}

export function initPost(
  three: { renderer: THREE.WebGPURenderer; scene: THREE.Scene; camera: THREE.Camera; preview?: HTMLCanvasElement },
): PostAPI {
  const { renderer, scene, camera } = three

  const scenePass = t.pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode('output')

  // The beat clock as a uniform, updated every frame from the props object.
  // Beat-seeded ops (strobe/film/rgbsplit) read this instead of a TSL `time`
  // node, so they stay deterministic under pause/scrub.
  const beatUniform = t.uniform(0)

  // Feedback: prev() samples the previous output frame. After the chain renders
  // to the canvas, its pixels are copied into `prevTexture` for the next frame —
  // one-frame-behind, race-proof, no extra pass. Allocated only when a state
  // references prev(); contents drop on resize.
  let prevTexture: THREE.FramebufferTexture | null = null
  const prevRefs: Node[] = []
  function ensurePrev(): void {
    if (prevTexture) return
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    prevTexture = new THREE.FramebufferTexture(Math.max(1, size.x), Math.max(1, size.y))
  }

  // Build a chain's node graph, collecting live uniforms and prev refs in the
  // deterministic forEachLiveArg order (own live args of each op, then its chain
  // args) so setFrame binds uniforms positionally. `sceneColor` is what the
  // scene() op reads — the preview passes its own renderer's pass.
  function buildGraph(chain: OpChain, sceneColor: Node = scenePassColor): Graph {
    const uniforms: Node[] = []
    let usesPrev = false
    const live = (init: number): Node => { const u = t.uniform(init); uniforms.push(u); return u }

    function build(c: OpChain): Node {
      let node: Node | null = null
      for (const op of c) node = buildOp(op, node)
      return node
    }

    function buildOp(op: OpCall, input: Node): Node {
      switch (op.op) {
        case 'scene':
          return sceneColor
        case 'prev': {
          ensurePrev()
          usesPrev = true
          const texNode = t.texture(prevTexture)
          prevRefs.push(texNode)
          return texNode
        }
        case 'edges': {
          const th = live(liveInit(op, 0))
          const colorMode = op.args[1]?.value as number
          const G: Node = (sobel(input) as Node).r
          const m = t.step(th, G)
          if (colorMode === 1) return t.vec4(t.vec3(input.rgb).add(t.vec3(m)), 1)
          if (colorMode === 2) return t.vec4(t.vec3(G, G.mul(0.5), t.oneMinus(G)).mul(m), 1)
          return t.vec4(t.vec3(m), 1)
        }
        case 'blur':
          return gaussianBlur(input, live(liveInit(op, 0)), BLUR_SIGMA)
        case 'bloom': {
          // BloomNode wraps its own uniforms — push those (in arg order) instead
          // of creating ours, keeping the forEachLiveArg alignment.
          const b = bloom(input, liveInit(op, 0), liveInit(op, 1), liveInit(op, 2))
          uniforms.push(b.strength, b.radius, b.threshold)
          return t.vec4(input).add(b)
        }
        case 'pixelate': {
          const size = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const cells = t.screenSize.div(size)
          const q = t.uv().mul(cells).floor().add(0.5).div(cells)
          return tex.sample(q)
        }
        case 'posterize': {
          const steps = live(liveInit(op, 0))
          return t.vec4(t.floor(t.vec3(input.rgb).mul(steps)).div(steps), 1)
        }
        case 'invert':
          return t.vec4(t.oneMinus(t.vec3(input.rgb)), 1)
        case 'rgbshift': {
          const amount = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const off = t.vec2(amount, 0)
          const uvN = t.uv()
          return t.vec4(tex.sample(uvN.add(off)).r, tex.sample(uvN).g, tex.sample(uvN.sub(off)).b, 1)
        }
        case 'mosaic': {
          const scale = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          // Mirror each cell so tiles meet seamlessly (abs of a saw wave).
          const uvm = t.abs(t.uv().mul(scale).fract().mul(2).sub(1))
          return tex.sample(uvm)
        }
        case 'scale': {
          const amount = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const uvS = t.uv().sub(0.5).div(amount).add(0.5)
          return tex.sample(uvS)
        }
        case 'rotate': {
          const angle = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const c = t.cos(angle)
          const s = t.sin(angle)
          const p = t.uv().sub(0.5)
          const uvR = t.vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).add(0.5)
          return tex.sample(uvR)
        }
        case 'scrollX': {
          const amount = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const uvN = t.uv()
          return tex.sample(t.vec2(uvN.x.add(amount).fract(), uvN.y))
        }
        case 'scrollY': {
          const amount = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const uvN = t.uv()
          return tex.sample(t.vec2(uvN.x, uvN.y.add(amount).fract()))
        }
        case 'kaleid': {
          const sides = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const p = t.uv().sub(0.5)
          const r = t.length(p)
          const wedge = t.float(Math.PI * 2).div(sides)
          const a = t.abs(t.mod(t.atan(p.y, p.x), wedge).sub(wedge.mul(0.5)))
          const uvK = t.vec2(t.cos(a), t.sin(a)).mul(r).add(0.5)
          return tex.sample(uvK)
        }
        case 'hue': {
          // Rodrigues rotation of the colour about the grey axis — a
          // luminance-preserving hue shift with no HSV round-trip.
          const amount = live(liveInit(op, 0))
          const angle = amount.mul(Math.PI * 2)
          const col = t.vec3(input.rgb)
          const k = t.vec3(0.57735, 0.57735, 0.57735)
          const cosA = t.cos(angle)
          const rotated = col.mul(cosA)
            .add(t.cross(k, col).mul(t.sin(angle)))
            .add(k.mul(t.dot(k, col)).mul(t.oneMinus(cosA)))
          return t.vec4(rotated, 1)
        }
        case 'saturate': {
          const amount = live(liveInit(op, 0))
          const col = t.vec3(input.rgb)
          return t.vec4(t.mix(t.vec3(t.luminance(col)), col, amount), 1)
        }
        case 'brightness': {
          const amount = live(liveInit(op, 0))
          return t.vec4(t.vec3(input.rgb).add(amount), 1)
        }
        case 'contrast': {
          const amount = live(liveInit(op, 0))
          return t.vec4(t.vec3(input.rgb).sub(0.5).mul(amount).add(0.5), 1)
        }
        case 'fade': {
          // Feedback trail: mix in the previous output frame (the same
          // one-frame-behind buffer prev() samples).
          const amount = live(liveInit(op, 0))
          ensurePrev()
          usesPrev = true
          const prevNode = t.texture(prevTexture)
          prevRefs.push(prevNode)
          return t.mix(t.vec4(input), t.vec4(prevNode), amount)
        }
        case 'strobe': {
          const speed = live(liveInit(op, 0))
          const on = t.step(0.5, beatUniform.mul(speed).fract())
          return t.vec4(t.vec3(input.rgb).mul(on.mul(0.8).add(0.2)), 1)
        }
        case 'film': {
          const intensity = live(liveInit(op, 0))
          // Beat-seeded hash grain — no wall time, so it scrubs deterministically.
          const seed = t.uv().add(beatUniform)
          const n = t.fract(t.sin(t.dot(seed, t.vec2(12.9898, 78.233))).mul(43758.5453))
          return t.vec4(t.vec3(input.rgb).add(n.sub(0.5).mul(intensity)), 1)
        }
        case 'rgbsplit': {
          // Hash the eighth-beat INDEX, so the offset jumps from step to step
          // instead of sweeping within one — the stutter is the whole op.
          const q = live(liveInit(op, 0)).mul(hash2(t.vec2(beatUniform.mul(8).floor(), 0)).x)
          const tex = t.convertToTexture(input)
          const uvN = t.uv()
          return t.vec4(tex.sample(uvN.add(t.vec2(q, 0))).r, tex.sample(uvN).g, tex.sample(uvN.sub(t.vec2(q, 0))).b, 1)
        }
        case 'transition': {
          // Per-pixel mask mix: black keeps before, white shows after. Build in
          // chainArg order (before, after, mask) to align live uniforms.
          const before = t.vec4(build(op.chainArgs![0]))
          const after = t.vec4(build(op.chainArgs![1]))
          const l = t.luminance(t.vec3(build(op.chainArgs![2])))
          return t.mix(before, after, l)
        }
        case 'fill':
          return t.vec4(t.vec3(live(liveInit(op, 0))), 1)
        case 'gradient': {
          const angle = live(liveInit(op, 0))
          const d = t.vec2(t.cos(angle), t.sin(angle))
          const l = t.clamp(t.dot(t.uv().sub(0.5), d).add(0.5), 0, 1)
          return t.vec4(t.vec3(l), 1)
        }
        case 'noise': {
          const scale = live(liveInit(op, 0))
          const octaves = Math.min(4, Math.max(1, Math.round(op.args[1]?.value as number)))
          const p = t.uv().mul(scale)
          let n = perlin(p)
          // Fractal stack: each octave doubles frequency, halves amplitude; the
          // running sum is renormalized so the result stays in 0→1.
          let amp = 1
          let total = 1
          for (let o = 1; o < octaves; o++) {
            amp *= 0.5
            total += amp
            n = n.add(perlin(p.mul(2 ** o)).mul(amp))
          }
          return t.vec4(t.vec3(n.div(total)), 1)
        }
        case 'voronoi': {
          const scale = live(liveInit(op, 0))
          const jitter = live(liveInit(op, 1))
          const p = t.uv().mul(scale)
          const i = t.floor(p)
          const f = t.fract(p)
          // Nearest feature point over the 3×3 neighbourhood, unrolled (the
          // offsets are constants, so no TSL loop is needed).
          let d: Node | null = null
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const o = t.vec2(ox, oy)
              const pt = o.add(hash2(i.add(o)).sub(0.5).mul(jitter).add(0.5))
              const dist = t.length(pt.sub(f))
              d = d === null ? dist : t.min(d, dist)
            }
          }
          return t.vec4(t.vec3(t.clamp(d, 0, 1)), 1)
        }
        case 'stripes': {
          const count = live(liveInit(op, 0))
          const angle = live(liveInit(op, 1))
          const d = t.vec2(t.cos(angle), t.sin(angle))
          const l = t.dot(t.uv().sub(0.5), d).add(0.5).mul(count).fract()
          return t.vec4(t.vec3(l), 1)
        }
        case 'thresh': {
          const edge = live(liveInit(op, 0))
          const soft = live(liveInit(op, 1))
          const l = t.luminance(t.vec3(input.rgb))
          const f = t.smoothstep(edge.sub(soft.mul(0.5)), edge.add(soft.mul(0.5)), l)
          return t.vec4(t.vec3(f), 1)
        }
        case 'polar': {
          const cx = live(liveInit(op, 0))
          const cy = live(liveInit(op, 1))
          const tex = t.convertToTexture(input)
          const centre = t.vec2(cx, cy)
          const d = t.uv().sub(centre)
          const far = t.max(centre, t.vec2(1, 1).sub(centre))
          const r = t.length(d).div(t.length(far))
          const a = t.atan(d.y, d.x).mul(0.15915494).add(0.5)
          return tex.sample(t.vec2(r, a))
        }
        // Combines (blend has a live amount; the rest composite raw).
        case 'blend':
          return t.mix(t.vec4(input), t.vec4(build(op.chainArgs![0])), live(liveInit(op, 0)))
        case 'add':
          return t.vec4(input).add(t.vec4(build(op.chainArgs![0])))
        case 'mult':
          return t.vec4(input).mul(t.vec4(build(op.chainArgs![0])))
        case 'diff':
          return t.abs(t.vec4(input).sub(t.vec4(build(op.chainArgs![0]))))
        case 'mask':
          return t.vec4(input).mul(t.luminance(t.vec3(build(op.chainArgs![0]))))
        case 'modulate': {
          const amount = live(liveInit(op, 0))
          const mod = t.convertToTexture(build(op.chainArgs![0]))
          const src = t.convertToTexture(input)
          const off = t.vec2(mod.r, mod.g).sub(0.5).mul(amount)
          return src.sample(t.uv().add(off))
        }
        case 'layer': {
          const b = t.vec4(build(op.chainArgs![0]))
          return t.mix(t.vec4(input), b, b.a)
        }
        default:
          throw new Error(`post: no TSL factory for op "${op.op}"`)
      }
    }

    const node = build(chain)
    let liveCount = 0
    forEachLiveArg(chain, () => liveCount++)
    if (liveCount !== uniforms.length) {
      throw new Error(`post: bound ${uniforms.length} uniforms for ${liveCount} live args`)
    }
    return { node, uniforms, usesPrev, chain }
  }

  interface State { pipeline: Node; graph: Graph; warmed: boolean }
  const states = new Map<string, State>()
  let active: State | null = null

  function buildState(chain: OpChain, into = renderer, sceneColor = scenePassColor): State {
    const graph = buildGraph(chain, sceneColor)
    return { pipeline: new THREE.RenderPipeline(into, graph.node), graph, warmed: false }
  }

  // Behind-editor preview (see setPreview): a second renderer drawing straight
  // to the editor's canvas. It can't borrow the main target and copy — a WebGPU
  // canvas snapshot lags a frame, so the mirror shows the real output rather
  // than the previewed chain. Its one state stays out of `states`, so a per-Apply
  // rebuild can't accumulate pipelines.
  let preview: { code: string; state: State | null } | null = null
  let previewRenderer: THREE.WebGPURenderer | null = null
  let previewSceneColor: Node = null
  let previewReady = false

  // On demand, not from the animate loop: a paused playhead draws no frames, so
  // whatever invalidates the preview has to redraw it.
  function renderPreview(): void {
    if (!preview?.state || !previewReady) return
    try {
      preview.state.pipeline.render()
    } catch (e) {
      console.error('post: preview render failed', e)
    }
  }

  function previewTarget(): THREE.WebGPURenderer | null {
    const canvas = three.preview
    if (!canvas) return null
    // Built on the first previewed edit, so a session that never opens a post
    // cell pays for none of it.
    if (!previewRenderer) {
      const r = new THREE.WebGPURenderer({ canvas, antialias: true })
      previewRenderer = r
      // Its own pass over the shared scene: a PassNode owns a render target
      // sized to its renderer, so the two must not share one.
      previewSceneColor = t.pass(scene, camera).getTextureNode('output')
      // The canvas has no size of its own — it fills the editor pane.
      const fit = (): void => {
        const { clientWidth: w, clientHeight: h } = canvas
        if (!w || !h) return
        r.setSize(w, h, false)
        renderPreview()
      }
      new ResizeObserver(fit).observe(canvas)
      r.init().then(() => { previewReady = true; fit() }).catch((e) => {
        console.error('post: preview renderer init failed', e)
      })
    }
    return previewRenderer
  }

  // Warm-render each state once (to the canvas — enough to force the backend
  // pipeline/shader build) inside the cook pause, so no compile lands on a beat.
  function warmAll(): void {
    void renderer.init().then(() => {
      for (const state of states.values()) {
        if (state.warmed) continue
        try {
          renderer.setRenderTarget(null)
          state.pipeline.render()
          state.warmed = true
        } catch (e) {
          console.error('post: warm render failed', e)
        }
      }
    })
  }

  function writeUniforms(graph: Graph, props: Record<string, unknown>): void {
    const values = collectLiveValues(graph.chain, props)
    const n = Math.min(values.length, graph.uniforms.length)
    for (let i = 0; i < n; i++) graph.uniforms[i].value = values[i]
  }

  return {
    setProgram(index, loopFrames): void {
      states.clear()
      prevRefs.length = 0
      active = null
      if (index.length === 0) return
      const seen = new Set<string>()
      for (const f of postStateFrames(index, loopFrames)) {
        const frame = postFrameAt(index, f, loopFrames)
        if (!frame || seen.has(frame.stateId)) continue
        seen.add(frame.stateId)
        try {
          states.set(frame.stateId, buildState(frame.chain))
        } catch (e) {
          console.error('post: state build failed', e)
        }
      }
      active = states.values().next().value ?? null
      warmAll()
    },

    setFrame(frame, props): void {
      if (!frame) { active = null; return }
      let state = states.get(frame.stateId)
      if (!state) {
        try {
          state = buildState(frame.chain)
          states.set(frame.stateId, state)
          warmAll()
        } catch (e) {
          console.error('post: lazy state build failed', e)
          return
        }
      }
      active = state
      beatUniform.value = typeof props.beat === 'number' ? props.beat : 0
      writeUniforms(state.graph, props)
    },

    setPreview(code, props): void {
      if (code == null) {
        preview?.state?.pipeline.dispose()
        preview = null
        return
      }
      const into = previewTarget()
      if (!into) return
      if (preview?.code !== code) {
        preview?.state?.pipeline.dispose()
        // The code goes in before the build: a chain that won't build throws on
        // out to the caller, which reports it on the cell (see visualizer.ts's
        // drawPreview), and must not be retried every frame.
        preview = { code, state: null }
        preview.state = buildState(evalPostCode(code), into, previewSceneColor)
      }
      if (!preview.state) return
      beatUniform.value = typeof props.beat === 'number' ? props.beat : 0
      writeUniforms(preview.state.graph, props)
      renderPreview()
    },

    render(): boolean {
      if (!active) return false
      active.pipeline.render()
      // Grab the just-rendered canvas for next frame's prev() — one-frame-behind
      // feedback with no extra pass.
      if (active.graph.usesPrev && prevTexture) renderer.copyFramebufferToTexture(prevTexture)
      return true
    },

    resize(): void {
      if (!prevTexture) return
      // FramebufferTexture has no in-place resize — recreate at the new size and
      // repoint the graphs' prev nodes; the feedback trail drops (like hydra).
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      prevTexture.dispose()
      prevTexture = new THREE.FramebufferTexture(Math.max(1, size.x), Math.max(1, size.y))
      for (const ref of prevRefs) ref.value = prevTexture
    },

    reset(): void {
      active = null
    },
  }
}
