// Persists multiple authoring sessions (serialized event log + runs) so past
// sessions can be browsed and reopened. Primary backend is IndexedDB, one
// record per session — the old single-key localStorage blob was rewritten
// wholesale on every save and hit the ~5MB quota — with a one-time migration
// on first open. A storage-blob fallback remains for tests and environments
// without IndexedDB; both backends share the same async API.

import type { SessionRun } from './editable-tables.js'
import { defaultStorage, type MinimalStorage } from './storage.js'

const STORAGE_KEY = 'eventable.sessions'
const STORAGE_VERSION = 1

const DB_NAME = 'eventable'
const DB_VERSION = 1
const DB_STORE = 'sessions'

export interface SessionRecord {
  id: string
  createdAt: number
  updatedAt: number
  name: string
  tables: string[]
  events: string
  runs: SessionRun[]
  // Branch head (apply id) at last save, so a reload reopens on the same
  // branch. Null for a legacy/single-branch session (the store re-derives it).
  head: string | null
  // The table tab shown when the session was last saved — like `head`, purely
  // local working state, so resuming reopens on the table the user was looking
  // at rather than the default. Null/absent for a legacy session (the panel
  // falls back to its default tab).
  table: string | null
}

export interface SessionSummary {
  id: string
  createdAt: number | null
  updatedAt: number | null
  name: string
  tables: string[]
}

export interface SessionSaveData {
  events: string
  tables?: string[]
  runs?: SessionRun[]
  head?: string | null
  table?: string | null
}

export interface SessionStore {
  newId(): string
  list(): Promise<SessionSummary[]>
  // Upsert; preserves createdAt/name across updates.
  save(id: string, data: SessionSaveData): Promise<SessionRecord>
  get(id: string): Promise<SessionRecord | null>
  // No-op for an id that was never saved.
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
}

function newSessionId(): string {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// Stored records may predate newer fields — normalize to the full shape.
function normalizeRecord(s: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    id: s.id,
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? s.createdAt ?? Date.now(),
    name: typeof s.name === 'string' ? s.name : '',
    tables: Array.isArray(s.tables) ? s.tables : [],
    events: typeof s.events === 'string' ? s.events : '',
    runs: Array.isArray(s.runs) ? s.runs : [],
    head: typeof s.head === 'string' ? s.head : null,
    table: typeof s.table === 'string' ? s.table : null,
  }
}

function upsertRecord(existing: SessionRecord | null, id: string, { events, tables = [], runs = [], head = null, table = null }: SessionSaveData): SessionRecord {
  const now = Date.now()
  return {
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    name: existing?.name ?? '',
    tables,
    events,
    runs,
    head,
    table,
  }
}

function toSummary(s: SessionRecord): SessionSummary {
  return {
    id: s.id,
    createdAt: s.createdAt ?? null,
    updatedAt: s.updatedAt ?? s.createdAt ?? null,
    name: s.name,
    tables: s.tables,
  }
}

// Newest-updated first; a positional index breaks timestamp ties stably.
function sortedSummaries(records: SessionRecord[]): SessionSummary[] {
  return records
    .map((s, i) => ({ s: toSummary(s), i }))
    .sort((a, b) => ((b.s.updatedAt ?? 0) - (a.s.updatedAt ?? 0)) || b.i - a.i)
    .map(({ s }) => s)
}

// ── Storage-blob backend ─────────────────────────────────────────────────────

interface StoredData {
  version: number
  sessions: SessionRecord[]
}

function parseStoredSessions(raw: string | null): SessionRecord[] {
  try {
    if (!raw) return []
    const data = JSON.parse(raw) as StoredData
    if (!data || !Array.isArray(data.sessions)) return []
    return data.sessions
      .filter((s): s is SessionRecord => !!s && typeof (s as { id?: unknown }).id === 'string')
      .map(normalizeRecord)
  } catch {
    return []
  }
}

export function createSessionStore(storage: MinimalStorage = defaultStorage()): SessionStore {
  function readAll(): SessionRecord[] {
    try {
      return parseStoredSessions(storage?.getItem(STORAGE_KEY) ?? null)
    } catch {
      return []
    }
  }

  // A failed write (quota, no storage) must propagate — silent save failures
  // are how session data got lost before.
  function writeAll(sessions: SessionRecord[]): void {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, sessions }))
  }

  function update(id: string, change: (s: SessionRecord) => SessionRecord): void {
    const sessions = readAll()
    const idx = sessions.findIndex((s) => s.id === id)
    if (idx < 0) return
    sessions[idx] = change(sessions[idx])
    writeAll(sessions)
  }

  return {
    newId: newSessionId,

    list: async () => sortedSummaries(readAll()),

    async save(id: string, data: SessionSaveData): Promise<SessionRecord> {
      const sessions = readAll()
      const idx = sessions.findIndex((s) => s.id === id)
      const record = upsertRecord(idx >= 0 ? sessions[idx] : null, id, data)
      if (idx >= 0) sessions[idx] = record
      else sessions.push(record)
      writeAll(sessions)
      return record
    },

    async get(id: string): Promise<SessionRecord | null> {
      return readAll().find((s) => s.id === id) ?? null
    },

    async rename(id: string, name: string): Promise<void> {
      update(id, (s) => ({ ...s, name }))
    },

    async remove(id: string): Promise<void> {
      writeAll(readAll().filter((s) => s.id !== id))
    },
  }
}

// ── IndexedDB backend ────────────────────────────────────────────────────────

function idbRequest<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('indexedDB request failed'))
  })
}

// One-time import of the legacy localStorage blob. Existing ids are left
// alone, and the blob is removed only after the transaction commits, so an
// interrupted migration just retries next open.
function migrateFromStorage(db: IDBDatabase, storage: MinimalStorage | undefined): Promise<void> {
  let raw: string | null = null
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null
  } catch {
    return Promise.resolve()
  }
  // A corrupt blob parses to no records, so possibly-recoverable data is
  // never deleted.
  const legacy = parseStoredSessions(raw)
  if (!legacy.length) return Promise.resolve()
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite')
    const store = tx.objectStore(DB_STORE)
    for (const record of legacy) {
      const req = store.add(record)
      req.onerror = (e) => {
        // Already migrated (or otherwise unwritable) — keep the rest going.
        e.preventDefault()
        e.stopPropagation()
      }
    }
    tx.oncomplete = () => {
      try {
        storage?.removeItem?.(STORAGE_KEY)
      } catch { /* the copy staying behind is harmless — ids dedupe next open */ }
      resolve()
    }
    // A failed migration must not block the store — the next open retries.
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

export function createIdbSessionStore(storage: MinimalStorage | undefined = defaultStorage()): SessionStore {
  let dbPromise: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) {
          req.result.createObjectStore(DB_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    }).then(async (db) => {
      await migrateFromStorage(db, storage)
      return db
    })
    return dbPromise
  }

  async function get(db: IDBDatabase, id: string): Promise<SessionRecord | null> {
    const s = await idbRequest<(Partial<SessionRecord> & { id: string }) | undefined>(
      db.transaction(DB_STORE).objectStore(DB_STORE).get(id),
    )
    return s ? normalizeRecord(s) : null
  }

  async function put(db: IDBDatabase, record: SessionRecord): Promise<void> {
    await idbRequest(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(record))
  }

  async function update(id: string, change: (s: SessionRecord) => SessionRecord): Promise<void> {
    const db = await open()
    const existing = await get(db, id)
    if (!existing) return
    await put(db, change(existing))
  }

  return {
    newId: newSessionId,

    async list(): Promise<SessionSummary[]> {
      const db = await open()
      const all = await idbRequest<(Partial<SessionRecord> & { id: string })[]>(
        db.transaction(DB_STORE).objectStore(DB_STORE).getAll(),
      )
      return sortedSummaries(all.map(normalizeRecord))
    },

    async save(id: string, data: SessionSaveData): Promise<SessionRecord> {
      const db = await open()
      const record = upsertRecord(await get(db, id), id, data)
      await put(db, record)
      return record
    },

    async get(id: string): Promise<SessionRecord | null> {
      return get(await open(), id)
    },

    async rename(id: string, name: string): Promise<void> {
      await update(id, (s) => ({ ...s, name }))
    },

    async remove(id: string): Promise<void> {
      const db = await open()
      await idbRequest(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(id))
    },
  }
}

export function defaultSessionStore(): SessionStore {
  return typeof indexedDB !== 'undefined' ? createIdbSessionStore() : createSessionStore()
}
