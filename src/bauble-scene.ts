// eventable bauble-scene — the bauble compiler + WebGL layer. Wraps
// bauble-runtime (bauble.studio's Janet-to-GLSL compiler, wasm) and a small
// WebGL2 renderer for the fragment shaders it emits, using bauble.studio's
// uniform contract. Compilation is gated on script-string identity — a
// recompile is the expensive step — and a failed compile keeps the previous
// program on screen. tick() is driven only by the playback clock; the canvas
// is also wired into hydra as source s1 (see main.ts).

import baubleFactory, { type BaubleModule } from 'bauble-runtime'
import { baubleScript, type BaubleFrame } from './bauble.js'

export interface BaubleAPI {
  setSketch(frame: BaubleFrame | null): void
  tick(timeSeconds: number): void
  reset(): void
  // Re-run the resize/redraw sequence a real window resize triggers — the
  // visuals reset button's escape hatch.
  reinit(): void
}

const TAU = Math.PI * 2

// bauble.studio's default framing — the view its examples are written against.
const DEFAULT_CAMERA = { x: -0.125, y: 0.125, zoom: 1 }
const BASE_CAMERA_DISTANCE = 512

// Fullscreen triangle from gl_VertexID — no buffers needed.
const VERTEX_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

// Column-major 3×3 orbit matrix (camera space to world space): pitch (x,
// turns) then yaw (y, turns), so origin = matrix · (0, 0, distance) orbits the
// world origin.
function orbitMatrix(xTurns: number, yTurns: number): Float32Array {
  const ax = xTurns * TAU
  const ay = yTurns * TAU
  const cx = Math.cos(ax), sx = Math.sin(ax)
  const cy = Math.cos(ay), sy = Math.sin(ay)
  // rotY(ay) · rotX(ax), laid out column-major for uniformMatrix3fv.
  return new Float32Array([
    cy, 0, -sy,
    sy * sx, cx, cy * sx,
    sy * cx, -sx, cy * cx,
  ])
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function initBauble(canvas: HTMLCanvasElement): BaubleAPI {
  // preserveDrawingBuffer: hydra re-samples this canvas as s1 on its own
  // schedule — without it the buffer may be cleared and hydra reads black.
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!gl) console.error('bauble: WebGL2 unavailable — bauble sketches will not render')

  // The wasm compiler, loaded lazily so sessions that never touch bauble
  // never pay for it. Its stdout/stderr are captured: Janet errors surface
  // once per failed compile, timings stay out of the console.
  let module: BaubleModule | null = null
  let moduleLoading = false
  let lastErr = ''
  function ensureModule(): void {
    if (module || moduleLoading || !gl) return
    moduleLoading = true
    void baubleFactory({
      print: () => { /* eval/compile timings — drop */ },
      printErr: (line: string) => { lastErr += line + '\n' },
    }).then((m) => {
      module = m
      compilePending()
    }).catch((err) => {
      moduleLoading = false
      console.error('bauble: compiler failed to load:', err)
    })
  }

  // The script most recently asked for (null = blank), the one on screen, and
  // its compiled program. Camera values ride the frame's vars without touching
  // the script.
  let wantedScript: string | null = null
  let compiledScript: string | null = null
  let program: WebGLProgram | null = null
  let uniforms: Record<string, WebGLUniformLocation | null> = {}
  let camera = { ...DEFAULT_CAMERA }
  let timeSeconds = 0

  function compileShader(type: number, src: string): WebGLShader | null {
    if (!gl) return null
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('bauble shader error:', gl.getShaderInfoLog(shader))
      gl.deleteShader(shader)
      return null
    }
    return shader
  }

  // Compile whatever script is wanted but not yet on screen — runs on new
  // sketches and once when the wasm module finishes loading; a compile
  // failure keeps the previous program.
  function compilePending(): void {
    if (!gl || !module || wantedScript === compiledScript) return
    compiledScript = wantedScript
    if (wantedScript == null) {
      program = null
      draw()
      return
    }
    lastErr = ''
    let result: { isError: boolean; shaderSource: string }
    try {
      result = module.evaluate_script(wantedScript)
    } catch (err) {
      console.error('bauble sketch error:', err)
      return
    }
    if (result.isError) {
      console.error('bauble sketch error:', lastErr.trim() || 'evaluation error')
      return
    }
    const vert = compileShader(gl.VERTEX_SHADER, VERTEX_SRC)
    const frag = compileShader(gl.FRAGMENT_SHADER, result.shaderSource)
    if (!vert || !frag) return
    const next = gl.createProgram()
    gl.attachShader(next, vert)
    gl.attachShader(next, frag)
    gl.linkProgram(next)
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    if (!gl.getProgramParameter(next, gl.LINK_STATUS)) {
      console.error('bauble shader link error:', gl.getProgramInfoLog(next))
      gl.deleteProgram(next)
      return
    }
    if (program) gl.deleteProgram(program)
    program = next
    uniforms = Object.fromEntries(
      ['camera_origin', 'camera_matrix', 't', 'render_type', 'viewport']
        .map((name) => [name, gl.getUniformLocation(next, name)]),
    )
    draw()
  }

  function draw(): void {
    if (!gl) return
    const w = canvas.width
    const h = canvas.height
    gl.viewport(0, 0, w, h)
    if (!program) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return
    }
    gl.useProgram(program)
    const m = orbitMatrix(camera.x, camera.y)
    const d = BASE_CAMERA_DISTANCE * camera.zoom
    // origin = matrix · (0, 0, d) — the matrix's third column scaled.
    gl.uniform3f(uniforms.camera_origin, m[6] * d, m[7] * d, m[8] * d)
    gl.uniformMatrix3fv(uniforms.camera_matrix, false, m)
    gl.uniform1f(uniforms.t, timeSeconds)
    gl.uniform1i(uniforms.render_type, 0)
    gl.uniform4f(uniforms.viewport, 0, 0, w, h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function resize(): void {
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w
      canvas.height = h
      draw() // redraw at the new resolution even while paused
    }
  }
  resize()
  if (canvas.parentElement) new ResizeObserver(resize).observe(canvas.parentElement)

  function setSketch(frame: BaubleFrame | null): void {
    if (frame) {
      camera = {
        x: num(frame.vars['camera-x'], DEFAULT_CAMERA.x),
        y: num(frame.vars['camera-y'], DEFAULT_CAMERA.y),
        zoom: num(frame.vars['camera-zoom'], DEFAULT_CAMERA.zoom),
      }
      wantedScript = baubleScript(frame)
      ensureModule()
    } else {
      camera = { ...DEFAULT_CAMERA }
      wantedScript = null
    }
    compilePending()
  }

  return {
    setSketch,
    tick(t: number): void {
      timeSeconds = t
      draw()
    },
    reset(): void {
      timeSeconds = 0
      setSketch(null)
    },
    reinit: (): void => {
      resize()
      draw()
    },
  }
}
