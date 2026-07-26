// eventable GPU particle system — vertical slice
// ----------------------------------------------------------------------------
// A curl-noise-driven, fully GPU-resident particle system, ported from
// threely's `particle-specific` branch. Every particle's position/velocity
// lives in a WebGPU storage buffer and is advanced by a TSL compute kernel each
// frame — nothing touches the CPU. This is a live, stateful simulation (not a
// baked table), so for now it lives as a hardcoded sprite in the three scene
// rather than as a DSL table. See notes/particles-integration-plan.md.
//
// WebGPU ONLY: compute shaders don't exist under the WebGL2 fallback backend,
// so the caller must only build this when renderer.backend.isWebGPUBackend.
// ----------------------------------------------------------------------------

import * as THREE from 'three/webgpu'
import { curl } from './curl-noise.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any

export interface ParticleParams {
  // Curl field time scale — how fast the noise field itself evolves.
  timeMultiplier: number
  // Curl field spatial scale — larger = broader, smoother swirls.
  elscale: number
  // Per-particle speed along the curl field. This is the knob the slider drives.
  speed: number
}

export interface ParticleSystem {
  readonly sprite: THREE.Sprite
  // Advance the simulation to playback position `time` (in beats — the value
  // the playback engine reports, so the sim tracks play/pause/scrub/loop like
  // every other visualizer). The GPU step runs only when `time` has moved since
  // the last tick, so a paused (or idle) playhead freezes the sim; a stateful
  // GPU sim can't rewind, so scrubbing backward jumps the field but not the
  // particle positions.
  tick(time: number): void
  // Live-editable curl parameters; a TSL reference() reads these every frame,
  // so mutating a field takes effect on the next tick with no rebuild.
  readonly params: ParticleParams
  dispose(): void
}

const DEFAULT_PARAMS: ParticleParams = {
  timeMultiplier: 0.08,
  elscale: 12,
  speed: 0.001,
}

// Modest for a slice — dense enough to read as a fluid, light enough for most
// WebGPU GPUs. threely runs 400k; bump this once the pipeline is proven.
const PARTICLE_COUNT = 100_000
const SPRITE_SIZE = 0.03

export async function createParticleSystem(
  renderer: THREE.WebGPURenderer,
  count: number = PARTICLE_COUNT,
): Promise<ParticleSystem> {
  // TSL's node-builder API is a fluent DSL whose static types are far stricter
  // than the runtime (every .mul/.add/.select is overloaded per vector width).
  // Typing each intermediate exactly adds no safety to shader graph code, so we
  // treat the namespace as untyped here — the WGSL/TSL itself is the contract.
  const t: any = THREE.TSL
  const params: ParticleParams = { ...DEFAULT_PARAMS }

  // The simulation clock. Instead of three's wall-clock TSL.time (which runs
  // free of playback), this uniform is fed the playback position each tick, so
  // curl-field evolution and particle aging track the beat clock — pausing
  // freezes them, scrubbing/looping moves them, exactly like the scene and
  // hydra visualizers. Units are beats (whatever the playback engine reports).
  const clock = t.uniform(0)

  // ── Storage buffers (GPU-resident particle state) ──────────────────────────
  const makeBuffer = (itemSize: number): THREE.StorageInstancedBufferAttribute =>
    new THREE.StorageInstancedBufferAttribute(count, itemSize)

  const positionBuf = makeBuffer(3)
  const velocityBuf = makeBuffer(3)
  const birthBuf = makeBuffer(1)
  const lifeBuf = makeBuffer(1)

  const positionStore = t.storage(positionBuf, 'vec3', count)
  const velocityStore = t.storage(velocityBuf, 'vec3', count)
  const birthStore = t.storage(birthBuf, 'float', count)
  const lifeStore = t.storage(lifeBuf, 'float', count)

  // Per-invocation element views (indexed by the compute/instance index).
  const position: Node = positionStore.element(t.instanceIndex)
  const velocity: Node = velocityStore.element(t.instanceIndex)
  const birthTime: Node = birthStore.element(t.instanceIndex)
  const lifespan: Node = lifeStore.element(t.instanceIndex)

  // ── Init kernel: scatter particles into a random cloud ─────────────────────
  const initKernel = t.Fn(() => {
    const { float, instanceIndex, rand, vec3 } = t
    const i = float(instanceIndex)

    const px = rand(i.mul(0.1547)).sub(0.5).mul(8)
    const py = rand(i.mul(0.7834)).sub(0.5).mul(8)
    const pz = rand(i.mul(0.9123)).sub(0.5).mul(4)
    position.assign(vec3(px, py, pz))

    const velMul = 0.02
    const ang = rand(i.mul(0.4567)).mul(Math.PI * 2)
    const spd = rand(i.mul(0.2341)).mul(velMul)
    velocity.assign(vec3(ang.sin().mul(spd), ang.cos().mul(spd), 0))

    birthTime.assign(clock)
    lifespan.assign(rand(i).mul(10).add(5)) // 5–15 beats of life
  })().compute(count)

  await renderer.computeAsync(initKernel)

  // ── Curl force: reads params live via reference() ──────────────────────────
  const timeMultiplierRef = t.reference('timeMultiplier', 'float', params)
  const elscaleRef = t.reference('elscale', 'float', params)
  const speedRef = t.reference('speed', 'float', params)

  const curlForce = curl({
    index: t.float(t.instanceIndex),
    posa: position,
    elscale: elscaleRef,
    time: clock.mul(timeMultiplierRef),
    speed: speedRef,
    force: t.vec3(0),
  })

  // ── Update kernel: curl + damp + integrate + age/respawn ───────────────────
  const updateKernel = t.Fn(() => {
    const { float, instanceIndex, rand, vec3 } = t
    const i = float(instanceIndex)

    const vel = velocity.add(curlForce).mul(0.995).toVar()
    const pos = position.add(vel).toVar()

    const age = clock.sub(birthTime)
    const dead = age.greaterThanEqual(lifespan)

    // Respawn dead particles near the origin with a fresh outward kick.
    const ang = rand(i.div(4)).mul(Math.PI * 2)
    const spd = rand(i).mul(0.04).add(0.008)
    const reseedVel = vec3(ang.sin().mul(spd), ang.cos().mul(spd), 0)
    const reseedPos = vec3(
      rand(i.mul(0.254)).sub(0.5),
      rand(i.mul(0.9288)).sub(0.5),
      rand(i.mul(10.254)).sub(0.5),
    ).mul(0.2)

    // `position`/`velocity` are buffer-element views, so .assign() writes the
    // new state straight back to the GPU storage buffer for the next frame.
    position.assign(dead.select(reseedPos, pos))
    velocity.assign(dead.select(reseedVel, vel))
    birthTime.assign(dead.select(clock, birthTime))
  })().compute(count)

  // ── Render material: draw straight from the position buffer ────────────────
  const material = new THREE.SpriteNodeMaterial()
  material.positionNode = position
  // Colour by velocity direction — the curl field paints itself.
  material.colorNode = velocity.normalize().mul(0.5).add(0.5)
  material.scaleNode = t.float(SPRITE_SIZE)
  material.blending = THREE.AdditiveBlending
  material.depthWrite = false
  material.transparent = true

  const sprite = new THREE.Sprite(material)
  // Instanced draw: one sprite per particle, sourced from the storage buffers.
  ;(sprite as unknown as { count: number }).count = count
  sprite.frustumCulled = false

  // The render loop calls this every animation frame, but the sim should only
  // step in lockstep with playback — so we run the GPU kernel only when the
  // playback clock has moved since last time. A held (paused/idle) playhead
  // reports the same value each frame and the sim stays frozen.
  let lastTime = 0
  const tick = (time: number): void => {
    clock.value = time
    if (time === lastTime) return
    lastTime = time
    renderer.compute(updateKernel)
  }

  const dispose = (): void => {
    sprite.removeFromParent()
    material.dispose()
  }

  return { sprite, tick, params, dispose }
}
