/**
 * Durable routing domain: thread/chat keys → bound DSH session records.
 *
 * Opened through the host's `ctx.storageDomain` facility; the spec is plain
 * data (no runtime import of DSH packages), so the plugin carries zero
 * runtime dependency on host internals — everything flows through `ctx`.
 *
 * @module dsh-channels/domain
 */

import { z } from 'zod'

/** Route key kinds. `thread` = real Feishu topic; `chat` = degraded chat-scoped fallback. */
export const ROUTE_RECORD_VERSION = 1

export const sessionHistoryEntrySchema = z.object({
  /** One Session that has been bound to this route. */
  sessionId: z.string().min(1),
  /** Epoch ms when the Session was created. */
  createdAt: z.number().int().nonnegative(),
})

export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>

export const routeRecordSchema = z.object({
  /** Route key the record is stored under (thread_id or chat:<chatId>). */
  key: z.string().min(1),
  /** Kind of the key. */
  kind: z.enum(['thread', 'chat']),
  /** Bound DSH session id. */
  sessionId: z.string().min(1),
  /** Feishu chat the session lives in. */
  chatId: z.string().min(1),
  /** `p2p` or `group`. */
  chatType: z.enum(['p2p', 'group']),
  /** Workspace owner (sender open_id). */
  senderOpenId: z.string().min(1),
  /** Workspace directory for this (chat, user) pair. */
  workspacePath: z.string().min(1),
  /** Message id of the latest streaming card (updated per turn). */
  cardMessageId: z.string().min(1),
  /** Epoch ms when the record was created. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms of the last activity routed through this record. */
  lastActivityAt: z.number().int().nonnegative(),
  /** Sessions this topic has pointed at, oldest first. Optional for v1 compatibility. */
  sessionHistory: z.array(sessionHistoryEntrySchema).optional(),
})

export type RouteRecord = z.infer<typeof routeRecordSchema>

/**
 * Minimal persistent tombstone for a thread route retired by route TTL.
 *
 * Deleting the active route alone would make a later message look like a new
 * conversation and silently create another Session in the same Feishu topic.
 * The tombstone preserves only enough identity to reject that message across
 * process restarts; the old Session and workspace remain host-owned.
 */
export const expiredRouteRecordSchema = z.object({
  /** Expired Feishu thread id (also the table key). */
  key: z.string().min(1),
  /** Feishu chat containing the expired topic. */
  chatId: z.string().min(1),
  /** Original chat type, retained for diagnostics and future policy. */
  chatType: z.enum(['p2p', 'group']),
  /** Original route owner; never used to grant access after expiry. */
  senderOpenId: z.string().min(1),
  /** Epoch ms when the route was retired. */
  expiredAt: z.number().int().nonnegative(),
  /** Workspace the retired route belonged to; absent in tombstones written by
   *  older plugin versions, so the field must stay optional. */
  workspacePath: z.string().min(1).optional(),
  /** Epoch ms of the last activity through the route before retirement.
   *  Optional for the same legacy-compatibility reason; consumers fall back to
   *  `expiredAt` when it is absent. */
  lastActivityAt: z.number().int().nonnegative().optional(),
})

export type ExpiredRouteRecord = z.infer<typeof expiredRouteRecordSchema>

/**
 * Normalize legacy and partially duplicated histories without mutating the
 * durable record. The current Session is always represented, duplicate ids
 * collapse to their earliest timestamp, and output order is deterministic.
 */
export function normalizeSessionHistory(record: RouteRecord): SessionHistoryEntry[] {
  const bySession = new Map<string, SessionHistoryEntry>()
  for (const entry of record.sessionHistory ?? []) {
    const existing = bySession.get(entry.sessionId)
    if (existing === undefined || entry.createdAt < existing.createdAt) {
      bySession.set(entry.sessionId, { ...entry })
    }
  }
  if (!bySession.has(record.sessionId)) {
    bySession.set(record.sessionId, { sessionId: record.sessionId, createdAt: record.createdAt })
  }
  return [...bySession.values()].sort((left, right) => left.createdAt - right.createdAt)
}

/** Materialize the optional legacy history field for in-memory consumers. */
export function normalizeRouteRecord(record: RouteRecord): RouteRecord {
  return { ...record, sessionHistory: normalizeSessionHistory(record) }
}

/** Append a newly created Session to one normalized route history. */
export function appendSessionHistory(
  record: RouteRecord,
  sessionId: string,
  createdAt: number,
): SessionHistoryEntry[] {
  return normalizeSessionHistory({
    ...record,
    sessionId,
    sessionHistory: [...normalizeSessionHistory(record), { sessionId, createdAt }],
  })
}

/**
 * In-flight turn snapshot: everything needed to repair a streaming card that a
 * restart left mid-flight (stuck panel, leftover Typing reaction, never-patched
 * segment cards). Keyed by the turn's MAIN card message id — unique per turn
 * and known at attach time — so overlapping turns of one session never
 * overwrite each other. Written before the route record, updated as segment
 * cards resolve, deleted when the turn finalizes (or the creation fails).
 */
export const INFLIGHT_VERSION = 1

export const inflightCardSchema = z.object({
  /** Feishu message id of one segment card. */
  messageId: z.string().min(1),
  /** Delivery mode; `text` messages are complete and never patched by repair. */
  mode: z.enum(['card', 'text']),
})

export type InflightCard = z.infer<typeof inflightCardSchema>

export const inflightSnapshotSchema = z.object({
  /** Key the snapshot is stored under (= `cards[0].messageId`, the main card). */
  key: z.string().min(1),
  /** DSH session the turn belongs to. */
  sessionId: z.string().min(1),
  /** Feishu chat the cards live in (reaction targeting). */
  chatId: z.string().min(1),
  /** User message that triggered the turn (Typing/DONE reaction anchor). */
  triggerMessageId: z.string().min(1),
  /** Reaction id of the Typing reaction (absent when the add failed). */
  reactionId: z.string().optional(),
  /** Segment cards in order; `[0]` is the main card. */
  cards: z.array(inflightCardSchema).min(1),
  /** Epoch ms when the turn attached. */
  startedAt: z.number().int().nonnegative(),
  /** Repair attempts spent (cap: 2 — see `repairInflight`). */
  attempts: z.number().int().nonnegative(),
})

export type InflightSnapshot = z.infer<typeof inflightSnapshotSchema>

/**
 * One processed inbound message, keyed by its Feishu message id. Feishu
 * redelivers un-acked events on WS reconnect, so every accepted message is
 * recorded here BEFORE its side effects begin; redeliveries then hit the
 * table (or the in-process guard) and are dropped. Records are pruned by the
 * GC sweep after a fixed retention window (24 h — redelivery windows are
 * minutes).
 */
export const PROCESSED_VERSION = 1

export const processedRecordSchema = z.object({
  /** Key the record is stored under (the Feishu message id). */
  key: z.string().min(1),
  /** Epoch ms when the message was accepted for processing. */
  processedAt: z.number().int().nonnegative(),
})

export type ProcessedRecord = z.infer<typeof processedRecordSchema>

export interface FeishuDomainSpecShape {
  name: 'channels_routes'
  version: 1
  global: {
    schema: z.ZodType<FeishuDomainGlobal>
    initial: FeishuDomainGlobal
  }
  tables: {
    routes: {
      valueSchema: typeof routeRecordSchema
      __key?: string
    }
    inflight: {
      valueSchema: typeof inflightSnapshotSchema
      __key?: string
    }
    processed: {
      valueSchema: typeof processedRecordSchema
      __key?: string
    }
    expired_routes: {
      valueSchema: typeof expiredRouteRecordSchema
      __key?: string
    }
  }
}

export const feishuDomainGlobalSchema = z.object({
  /** Legacy: img_key of a previously uploaded chevron icon. Kept optional so
   *  storage written by older plugin versions still validates; the card now
   *  uses the built-in `standard_icon` chevron and never writes this. */
  chevronImgKey: z.string().optional(),
  /** p2p chats already shown the one-time onboarding card (bounded list). */
  welcomedChats: z.array(z.string()).optional(),
})

export type FeishuDomainGlobal = z.infer<typeof feishuDomainGlobalSchema>

/**
 * Domain declaration for the host's storage facility. Plain data plus zod
 * schemas — deliberately not built with `defineDomain` so this module has no
 * runtime import of `@deepseek-ai/dsh-storage-domain`.
 */
export const feishuDomain: FeishuDomainSpecShape = {
  name: 'channels_routes',
  version: 1,
  global: {
    schema: feishuDomainGlobalSchema,
    initial: {} satisfies FeishuDomainGlobal,
  },
  tables: {
    routes: { valueSchema: routeRecordSchema },
    inflight: { valueSchema: inflightSnapshotSchema },
    processed: { valueSchema: processedRecordSchema },
    expired_routes: { valueSchema: expiredRouteRecordSchema },
  },
}

export type FeishuDomainSpec = typeof feishuDomain

/** Normalized table handle for the routes table. */
export interface RoutesTable {
  get(key: string): RouteRecord | undefined
  put(key: string, value: RouteRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, RouteRecord]>
}

/** Normalized table handle for the inflight table (repair snapshots). */
export interface InflightTable {
  get(key: string): InflightSnapshot | undefined
  put(key: string, value: InflightSnapshot): Promise<unknown> | void
  /**
   * Atomic read-modify-write on the host's write chain (mirrors `KvTable`).
   * Rejects with `missing-key` when the key is absent (e.g. the turn finalize
   * deleted the snapshot while a late segment delivery was still landing).
   */
  update(key: string, fn: (current: InflightSnapshot) => InflightSnapshot): Promise<unknown>
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, InflightSnapshot]>
}

/** Normalized table handle for the processed-message dedup table. */
export interface ProcessedTable {
  get(key: string): ProcessedRecord | undefined
  put(key: string, value: ProcessedRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, ProcessedRecord]>
}

/** Persistent thread tombstones used to reject post-TTL messages. */
export interface ExpiredRoutesTable {
  get(key: string): ExpiredRouteRecord | undefined
  put(key: string, value: ExpiredRouteRecord): Promise<unknown> | void
  entries(): IterableIterator<[string, ExpiredRouteRecord]>
}

/** Normalized domain handle. */
export interface FeishuDomainHandle {
  routes: RoutesTable
  inflight: InflightTable
  processed: ProcessedTable
  expiredRoutes: ExpiredRoutesTable
  getGlobal(): FeishuDomainGlobal
  setGlobal(value: FeishuDomainGlobal): Promise<unknown> | void
  close(): Promise<void>
}

/** The raw shape `ctx.storageDomain.open()` resolves to (cast at the seam).
 *  Mirrors `KvTable` from `@deepseek-ai/dsh-storage-domain`: reads are sync,
 *  writes go through `put`/`delete` (NOT `set`), and `update` provides the
 *  atomic read-modify-write used by the inflight merge. */
export interface RawDomainHandle {
  table(name: string): {
    get(key: string): unknown
    put(key: string, value: unknown): Promise<unknown>
    update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
    delete(key: string): Promise<unknown>
    entries(): IterableIterator<[string, unknown]>
  }
  global: {
    get(): unknown
    set(value: unknown): Promise<unknown>
  }
  close(): Promise<void>
}

/** Build a chat-scoped fallback key for degraded (topic-less) routing. */
export function chatRouteKey(chatType: 'p2p' | 'group', chatId: string, senderOpenId: string): string {
  return chatType === 'p2p'
    ? `chat:p2p:${chatId}:${senderOpenId}`
    : `chat:group:${chatId}:${senderOpenId}`
}
