// Cook worker — the Web Worker shell around cook-service.ts. Owns the physics
// engine (jolt's WASM loads here, not on the main thread). Requests are
// answered in arrival order — all messages await the same settled init
// promise, so then-callbacks run in registration order.

import { initPhysics, type PhysicsEngineInstance } from './physics.js'
import { createCookService, type CookRequest } from './cook-service.js'

let physics: PhysicsEngineInstance | null = null
const ready = initPhysics()
  .then((engine) => { physics = engine })
  .catch((err: unknown) => console.error('cook worker: physics failed to load:', err))

const service = createCookService({ physics: () => physics })
const post = self.postMessage.bind(self) as (msg: unknown) => void

self.addEventListener('message', (e) => {
  const req = (e as MessageEvent).data as CookRequest
  void ready.then(() => {
    const resp = service.handle(req)
    try {
      post(resp)
    } catch (err) {
      // A value the pack layer didn't reach (a function in a declared seed row,
      // say) throws DataCloneError here. Answering with the error keeps the
      // client's promise from hanging forever — an unanswered cook leaves the
      // main thread stuck mid-run with no error strip.
      post({ id: req.id, ok: false, error: `cook result could not be sent: ${(err as Error).message}` })
    }
  })
})
