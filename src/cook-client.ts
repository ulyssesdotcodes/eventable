// Cook client — the main-thread handle on the cook worker: promise-per-request,
// unpacking transferred results back into real Tables (cook-transfer.ts).
// Takes anything Worker-shaped so tests can drive it with a fake channel.

import { unpackCooked } from './cook-transfer.js'
import type { CookRequest, CookResponse, DeclaredEditable, DeclaredSlider } from './cook-service.js'
import type { CookedResult } from './replay.js'
import type { Row } from './lineage.js'

export interface WorkerLike {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void
}

export interface CookInput {
  code: string
  seed: number
  dataCache: Map<string, string>
  tapRows: Row[]
  // See CookRequest.loopBeats.
  loopBeats?: number
  editables: Array<{ name: string; rows: Row[] }>
  // See CookRequest.seeds.
  seeds?: Record<string, Row[]>
  // Streaming log tables under their display names — see CookRequest.logs.
  logs?: Array<{ name: string; rows: Row[] }>
}

export interface CookOutcome {
  cooked: CookedResult
  declared: DeclaredEditable[]
  sliders: DeclaredSlider[]
}

export interface CookClient {
  cook(input: CookInput): Promise<CookOutcome>
}

export function createCookClient(worker: WorkerLike): CookClient {
  let nextId = 1
  const pending = new Map<number, { resolve: (o: CookOutcome) => void; reject: (e: Error) => void }>()

  worker.addEventListener('message', (e) => {
    const resp = e.data as CookResponse
    const p = pending.get(resp.id)
    if (!p) return
    pending.delete(resp.id)
    if (resp.ok) p.resolve({ cooked: unpackCooked(resp.cooked), declared: resp.declared, sliders: resp.sliders ?? [] })
    else p.reject(new Error(resp.error))
  })

  return {
    cook(input: CookInput): Promise<CookOutcome> {
      const req: CookRequest = {
        id: nextId++,
        code: input.code,
        seed: input.seed,
        dataCache: [...input.dataCache],
        tapRows: input.tapRows,
        ...(input.loopBeats !== undefined ? { loopBeats: input.loopBeats } : {}),
        editables: input.editables,
        ...(input.seeds !== undefined ? { seeds: input.seeds } : {}),
        ...(input.logs !== undefined ? { logs: input.logs } : {}),
      }
      return new Promise((resolve, reject) => {
        pending.set(req.id, { resolve, reject })
        worker.postMessage(req)
      })
    },
  }
}
