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

/**
 * Route key kinds. `thread` = real Feishu topic; `chat` = degraded chat-scoped
 * fallback.
 *
 * Version 2 adds the optional `sessionDir` / `worktreeBranch` fields (the
 * Session's effective working directory). Version-1 records stay readable: an
 * absent `sessionDir` means the workspace path itself is the working directory
 * (the pre-v2 model).
 */
export const ROUTE_RECORD_VERSION = 2

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
  /** Workspace owner (sender user_id). */
  senderUserId: z.string().min(1),
  /** Workspace root owning this route: the Session header cwd / sandbox root. */
  workspacePath: z.string().min(1),
  /**
   * Effective working directory of the bound Session (the per-topic directory
   * or Git worktree checkout). Absent on records written before per-topic
   * directories existed: `workspacePath` is then the working directory too.
   */
  sessionDir: z.string().min(1).optional(),
  /** Git branch owning `sessionDir` when it is a worktree checkout. */
  worktreeBranch: z.string().min(1).optional(),
  /** Message id of the latest streaming card (updated per turn). */
  cardMessageId: z.string().min(1),
  /** Epoch ms when the record was created. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms of the last activity routed through this record. */
  lastActivityAt: z.number().int().nonnegative(),
  /** Sessions this topic has pointed at, oldest first. Optional for v1 compatibility. */
  sessionHistory: z.array(sessionHistoryEntrySchema).optional(),
  /**
   * Group-shared route (log-platform analysis topics): every member admitted
   * in `chatId` may continue the Session and decide its cards, not only
   * `senderUserId` (who then names the requester). Absent = owner-only.
   */
  shared: z.literal(true).optional(),
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
  senderUserId: z.string().min(1),
  /** Epoch ms when the route was retired. */
  expiredAt: z.number().int().nonnegative(),
  /** Workspace the retired route belonged to; absent in tombstones written by
   *  older plugin versions, so the field must stay optional. */
  workspacePath: z.string().min(1).optional(),
  /** Effective working directory the retired route's Session used; absent in
   *  legacy tombstones, where `workspacePath` was the directory (pre-v2 routes). */
  sessionDir: z.string().min(1).optional(),
  /** Git branch of that directory when it was a worktree checkout. */
  worktreeBranch: z.string().min(1).optional(),
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
 * Effective working directory of one route's Session. Records written before
 * per-topic directories have no `sessionDir`; their workspace path is the
 * directory the Session really works in.
 */
export function sessionDirOf(record: Pick<RouteRecord, 'workspacePath' | 'sessionDir'>): string {
  return record.sessionDir ?? record.workspacePath
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
 * Access-control grants (v1 format, added without a domain version bump —
 * see the notes on `feishuDomain` below).
 *
 * One record per authorized group: the group gate is the first of the two
 * independent admission gates. Inside an authorized group only the
 * administrator and explicitly authorized users may start conversations.
 */
export const accessGroupRecordSchema = z.object({
  /** Feishu chat id (`oc_...`) — also the table key. */
  chatId: z.string().min(1),
  /** Human-readable group name captured at authorization time (optional). */
  name: z.string().optional(),
  /** Which authorization entry produced this grant. */
  source: z.enum(['command', 'card', 'panel']),
  /** Administrator user_id that authorized it. */
  addedBy: z.string().min(1),
  /** Epoch ms when it was authorized. */
  addedAt: z.number().int().nonnegative(),
})

export type AccessGroupRecord = z.infer<typeof accessGroupRecordSchema>

/**
 * One authorized user (`user_id`), global across every authorized group.
 * Private chats are administrator-only, so this grant only affects group
 * conversations.
 */
export const accessUserRecordSchema = z.object({
  /** Feishu `user_id` — also the table key. */
  userId: z.string().min(1),
  /** Display name captured when the user was authorized (optional). */
  name: z.string().optional(),
  /** Which authorization entry produced this grant. */
  source: z.enum(['command', 'card', 'panel']),
  /** Administrator user_id that authorized it. */
  addedBy: z.string().min(1),
  /** Epoch ms when it was authorized. */
  addedAt: z.number().int().nonnegative(),
})

export type AccessUserRecord = z.infer<typeof accessUserRecordSchema>

/**
 * One authorization request the administrator has been (or should be) asked
 * about. Requests are persisted so the DM card stays decidable across plugin
 * restarts; settled records are kept as an audit trail and for request
 * de-duplication/cooldown.
 */
export const accessRequestRecordSchema = z.object({
  /** Opaque token carried by the card buttons — also the table key. */
  token: z.string().min(1),
  /** What is being requested. */
  kind: z.enum(['group', 'user']),
  /** `chat_id` for a group request; `user_id` for a user request. */
  targetId: z.string().min(1),
  /** Chat the request originated from, when applicable. */
  chatId: z.string().optional(),
  /** Group name captured for the card (group requests, or the group the user was seen in). */
  groupName: z.string().optional(),
  /** User who triggered a user request. */
  requesterUserId: z.string().optional(),
  /** Display name of that user, when the event carried one. */
  requesterName: z.string().optional(),
  /** Lifecycle state; only `pending` requests accept a card action. */
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  /** Epoch ms when the request was created. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms after which a pending request can no longer be decided. */
  expiresAt: z.number().int().nonnegative(),
  /** DM message id of the administrator card, once delivery succeeded. */
  messageId: z.string().optional(),
})

export type AccessRequestRecord = z.infer<typeof accessRequestRecordSchema>

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

/**
 * One accepted analyze API request, keyed by its `Idempotency-Key`. Kept
 * forever: a retried key returns the stored response instead of posting a
 * second analysis, and a reused key with a different body is refused.
 */
export const analyzeRequestRecordSchema = z.object({
  /** The request's `Idempotency-Key` (also the table key). */
  key: z.string().min(1),
  /** SHA-256 (hex) of the canonical request body. */
  bodyHash: z.string().min(1),
  /** Target group chat. */
  chatId: z.string().min(1),
  /** Root card message id (the analysis topic's root). */
  messageId: z.string().min(1),
  /** Epoch ms when the request was accepted. */
  acceptedAt: z.number().int().nonnegative(),
  /** What the root card shows, kept so the card can be redrawn after a restart. */
  subject: z.object({
    requesterUserId: z.string(),
    triggeredAt: z.string(),
    app: z.string(),
    errorCode: z.string(),
    logDetails: z.array(z.object({ name: z.string(), url: z.string() })),
  }),
  /**
   * Root card status. `running` until the first turn settles; a record still
   * `running` when the channel starts belongs to an analysis the previous
   * instance never finished, and becomes `interrupted`.
   */
  status: z.enum(['running', 'done', 'stopped', 'error', 'failed', 'interrupted']),
})

export type AnalyzeRequestRecord = z.infer<typeof analyzeRequestRecordSchema>

export interface FeishuDomainSpecShape {
  name: 'channels_routes_v2'
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
    access_groups: {
      valueSchema: typeof accessGroupRecordSchema
      __key?: string
    }
    access_users: {
      valueSchema: typeof accessUserRecordSchema
      __key?: string
    }
    access_requests: {
      valueSchema: typeof accessRequestRecordSchema
      __key?: string
    }
    access_wiki_users: {
      valueSchema: typeof accessUserRecordSchema
      __key?: string
    }
    analyze_requests: {
      valueSchema: typeof analyzeRequestRecordSchema
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
  // v2 keys every user by `user_id`. The open_id-keyed `channels_routes` unit
  // is neither read nor migrated; it stays on disk untouched.
  name: 'channels_routes_v2',
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
    access_groups: { valueSchema: accessGroupRecordSchema },
    access_users: { valueSchema: accessUserRecordSchema },
    access_requests: { valueSchema: accessRequestRecordSchema },
    // Wiki whitelist (`/auth wiki add`): same record as `access_users`, an
    // independent grant. Added without a version bump like the other access
    // tables: a missing table loads empty.
    access_wiki_users: { valueSchema: accessUserRecordSchema },
    // Analyze API idempotency records; a missing table loads empty.
    analyze_requests: { valueSchema: analyzeRequestRecordSchema },
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

/** Normalized table handle for authorized groups (key = `chat_id`). */
export interface AccessGroupsTable {
  get(key: string): AccessGroupRecord | undefined
  put(key: string, value: AccessGroupRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, AccessGroupRecord]>
}

/** Normalized table handle for authorized users (key = `user_id`). */
export interface AccessUsersTable {
  get(key: string): AccessUserRecord | undefined
  put(key: string, value: AccessUserRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, AccessUserRecord]>
}

/** Normalized table handle for authorization requests (key = opaque token). */
export interface AccessRequestsTable {
  get(key: string): AccessRequestRecord | undefined
  put(key: string, value: AccessRequestRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, AccessRequestRecord]>
}

/** Normalized table handle for analyze API requests (key = `Idempotency-Key`). */
export interface AnalyzeRequestsTable {
  get(key: string): AnalyzeRequestRecord | undefined
  put(key: string, value: AnalyzeRequestRecord): Promise<unknown> | void
  entries(): IterableIterator<[string, AnalyzeRequestRecord]>
}

/** Normalized domain handle. */
export interface FeishuDomainHandle {
  routes: RoutesTable
  inflight: InflightTable
  processed: ProcessedTable
  expiredRoutes: ExpiredRoutesTable
  accessGroups: AccessGroupsTable
  accessUsers: AccessUsersTable
  accessRequests: AccessRequestsTable
  /** Wiki whitelist (key = `user_id`); same records as {@link AccessUsersTable}. */
  accessWikiUsers: AccessUsersTable
  /** Analyze API idempotency records. */
  analyzeRequests: AnalyzeRequestsTable
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

/**
 * Feishu tenant `user_id` (letters, digits, `_`, `-`). It doubles as a
 * workspace path segment and as a DM target, where the SDK infers the
 * receive id type from the prefix: `ou_`/`on_`/`oc_` would be sent as an
 * open_id/union_id/chat_id, so those prefixes are rejected (a pasted open_id
 * fails validation instead of matching nobody).
 */
export const FEISHU_USER_ID_PATTERN = /^(?!ou_|on_|oc_)[A-Za-z0-9_-]+$/u

/** Build a chat-scoped fallback key for degraded (topic-less) routing. */
export function chatRouteKey(chatType: 'p2p' | 'group', chatId: string, senderUserId: string): string {
  return chatType === 'p2p'
    ? `chat:p2p:${chatId}:${senderUserId}`
    : `chat:group:${chatId}:${senderUserId}`
}
