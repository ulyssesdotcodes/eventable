// eventable multiplayer room — the Durable Object twin of server/server.ts,
// one instance per room name; shared behavior lives in src/room-core.ts.
// Built on the WebSocket Hibernation API so an idle room costs nothing: the
// platform may evict the object between messages, so state lives in
// this.ctx.storage, membership in this.ctx.getWebSockets(), and each socket's
// client id in its serializeAttachment (all of which survive hibernation).

import { DurableObject } from 'cloudflare:workers'
import type { StampedEvent } from '../src/event-log.js'
import { parseClientMessage, type ServerMessage } from '../src/protocol.js'
import { deliverOutbound, handleEvents, handleJoin, handleLeave, type RoomLogs } from '../src/room-core.js'

interface SocketAttachment {
  client: string
}

const LOGS_KEY = 'logs'

export class Room extends DurableObject {
  private logs: RoomLogs | null = null

  // Lazily (re)load from durable storage — a hibernation wake reconstructs
  // the object, resetting this.logs.
  private async getLogs(): Promise<RoomLogs> {
    if (this.logs) return this.logs
    const stored = (await this.ctx.storage.get<Record<string, StampedEvent[]>>(LOGS_KEY)) ?? {}
    this.logs = new Map(Object.entries(stored))
    return this.logs
  }

  private async saveLogs(logs: RoomLogs): Promise<void> {
    await this.ctx.storage.put(LOGS_KEY, Object.fromEntries(logs))
  }

  // Sockets that survived hibernation may be mid-close; those shouldn't get
  // a send() or count toward peers.
  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN)
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket closing under us */ }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(msg)
    for (const ws of this.openSockets()) {
      if (ws !== except) { try { ws.send(payload) } catch { /* ignore */ } }
    }
  }

  private joinedClient(ws: WebSocket): string | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null | undefined
    return attachment?.client ?? null
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // acceptWebSocket (not server.accept()) makes the socket hibernatable, so
    // the platform can evict this object between messages.
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    const msg = parseClientMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    if (!msg) return

    if (msg.type === 'join') {
      const logs = await this.getLogs()
      // This socket has no client attachment until below, so any other joined
      // open socket is a live peer; none means the joiner is alone and
      // initializes the room rather than merging onto stale logs.
      const hasPeers = this.openSockets().some((s) => s !== ws && this.joinedClient(s) !== null)
      const result = handleJoin(logs, msg, undefined, hasPeers)
      ws.serializeAttachment({ client: result.clientId } satisfies SocketAttachment)
      if (result.changed) await this.saveLogs(logs)
      deliverOutbound(result.outbound, (m) => this.send(ws, m), (m) => this.broadcast(m, ws))
      return
    }

    // Drop events from sockets that never joined (matches the Node server).
    if (msg.type === 'events' && this.joinedClient(ws) !== null) {
      const logs = await this.getLogs()
      const result = handleEvents(logs, msg)
      if (result.changed) await this.saveLogs(logs)
      deliverOutbound(result.outbound, (m) => this.send(ws, m), (m) => this.broadcast(m, ws))
    }
  }

  private async recordLeave(ws: WebSocket): Promise<void> {
    const clientId = this.joinedClient(ws)
    if (clientId) {
      const logs = await this.getLogs()
      const result = handleLeave(logs, clientId)
      if (result.changed) await this.saveLogs(logs)
      deliverOutbound(result.outbound, (m) => this.send(ws, m), (m) => this.broadcast(m, ws))
    }
    // Last socket left: drop the room's storage. Each client persisted its
    // own copy locally (main.ts sessionStore), so the next joiner re-seeds it.
    if (this.openSockets().length === 0) {
      this.logs = null
      await this.ctx.storage.delete(LOGS_KEY)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason)
    await this.recordLeave(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.recordLeave(ws)
  }
}
