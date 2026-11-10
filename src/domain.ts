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
import { outboxEntrySchema } from './outbox.ts'
import type { OutboxEntry } from './outbox.ts'
import { approvalCardRecordSchema, approvalGrantRecordSchema } from './interactions/approval-store.ts'
import type { ApprovalCardRecord, ApprovalGrantRecord } from './interactions/approval-store.ts'
import type { StorageDomainFacility } from './host/services.ts'
import { typedTable } from './storage/table.ts'
import type { DomainTable } from './storage/table.ts'

export const sessionHistoryEntrySchema = z.object({
  /** One Session that has been bound to this route. */
  sessionId: z.string().min(1),
  /** Epoch ms when the Session was created. */
  createdAt: z.number().int().nonnegative(),
})

export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>

/**
 * One Feishu topic (or degraded chat-scoped conversation) bound to a DSH
 * Session. `workspacePath` is the topic's own directory: the Session header
 * cwd, the sandbox root, and the workspace the Session is grouped under.
 */
export const routeRecordSchema = z.object({
  /** Route key the record is stored under (thread_id or a {@link chatRouteKey}). */
  key: z.string().min(1),
  /** `thread` = real Feishu topic; `chat` = degraded chat-scoped fallback. */
  kind: z.enum(['thread', 'chat']),
  /** Bound DSH session id. */
  sessionId: z.string().min(1),
  /** Feishu chat the session lives in. */
  chatId: z.string().min(1),
  /** `p2p` or `group`; decides the route's scope (see {@link isGroupRoute}). */
  chatType: z.enum(['p2p', 'group']),
  /**
   * The user who opened the route. In a private chat the person the topic
   * belongs to, whose switches gate its tools; in a group the initiator,
   * shown on cards and records only.
   */
  senderUserId: z.string().min(1),
  /** The topic directory: Session header cwd, sandbox root, and workspace. */
  workspacePath: z.string().min(1),
  /**
   * The user whose message most recently continued a group route (the resume
   * click after a restart counts). Restores the speaker a commit trailer
   * names after a restart; absent until someone other than the initiator speaks.
   */
  lastSpeakerUserId: z.string().min(1).optional(),
  /** Message id of the latest streaming card (updated per turn). */
  cardMessageId: z.string().min(1),
  /** Epoch ms when the record was created. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms of the last activity routed through this record. */
  lastActivityAt: z.number().int().nonnegative(),
  /** Sessions this topic has pointed at, oldest first; always names `sessionId`. */
  sessionHistory: z.array(sessionHistoryEntrySchema),
})

export type RouteRecord = z.infer<typeof routeRecordSchema>

/**
 * Whether a route belongs to a group rather than to one person. Every route
 * in a group chat does, a degraded chat-scoped one included: anyone with chat
 * access in the chat may continue its topic, decide its cards, and run its
 * session commands; the group's permission record gates its tools; prompts
 * are submitted as the group; commits are authored by the token account.
 * @param route - the route (or anything carrying its chat type).
 * @returns true for a group route.
 */
export function isGroupRoute(route: { readonly chatType: 'p2p' | 'group' }): boolean {
  return route.chatType === 'group'
}

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
  /** Workspace the retired route belonged to. */
  workspacePath: z.string().min(1),
  /** Epoch ms of the last activity through the route before retirement. */
  lastActivityAt: z.number().int().nonnegative(),
})

export type ExpiredRouteRecord = z.infer<typeof expiredRouteRecordSchema>

/**
 * Append a newly created Session to one route history. A Session already in
 * the history keeps its earliest timestamp; the result is ordered oldest first.
 * @param record - the route.
 * @param sessionId - the new Session.
 * @param createdAt - its creation time.
 * @returns the new history.
 */
export function appendSessionHistory(
  record: Pick<RouteRecord, 'sessionHistory'>,
  sessionId: string,
  createdAt: number,
): SessionHistoryEntry[] {
  const bySession = new Map<string, SessionHistoryEntry>()
  for (const entry of [...record.sessionHistory, { sessionId, createdAt }]) {
    const existing = bySession.get(entry.sessionId)
    if (existing === undefined || entry.createdAt < existing.createdAt) bySession.set(entry.sessionId, { ...entry })
  }
  return [...bySession.values()].sort((left, right) => left.createdAt - right.createdAt)
}

/**
 * In-flight turn snapshot: everything needed to repair a streaming card that a
 * restart left mid-flight (stuck panel, leftover Typing reaction, never-patched
 * segment cards). Keyed by the turn's MAIN card message id — unique per turn
 * and known at attach time — so overlapping turns of one session never
 * overwrite each other. Written before the route record, updated as segment
 * cards resolve, deleted when the turn finalizes (or the creation fails).
 */
export const inflightCardSchema = z.object({
  /** Feishu message id of one segment card. */
  messageId: z.string().min(1),
  /** Delivery mode; `text` messages are complete and never patched by repair. */
  mode: z.enum(['card', 'text']),
})

export type InflightCard = z.infer<typeof inflightCardSchema>

/** Largest serialized prompt kept in a snapshot for restart replay. */
export const INFLIGHT_PROMPT_MAX_BYTES = 256 * 1024

/** A persisted `UserMessage` (content blocks are kept as the host wrote them). */
export const inflightMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal('user'),
  content: z.array(z.looseObject({ type: z.string() })),
  source: z.looseObject({ kind: z.string() }),
})

/** A principal this channel submits prompts as (`src/access/principal.ts`). */
export const channelPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('feishu-user'), userId: z.string().min(1) }),
  z.object({ kind: z.literal('feishu-group'), chatId: z.string().min(1), userId: z.string().min(1) }),
])

/**
 * A persisted channel prompt (`src/session/prompt.ts`): the request id DSH
 * records as the message's `source.rpcId`, the principal it is submitted
 * as, and its blocks (text, or durable attachment references; staged-upload
 * receipts are never stored).
 */
export const inflightPromptSchema = z.object({
  requestId: z.string().min(1),
  principal: channelPrincipalSchema,
  content: z.array(z.looseObject({ type: z.string() })),
})

export const inflightSnapshotSchema = z.object({
  /** Key the snapshot is stored under (= `cards[0].messageId`, the main card). */
  key: z.string().min(1),
  /** DSH session the turn belongs to. */
  sessionId: z.string().min(1),
  /** Feishu chat the cards live in (reaction targeting). */
  chatId: z.string().min(1),
  /**
   * User message that triggered the turn (Typing/DONE reaction anchor).
   * Absent for a turn no Feishu message started (a host-turn card).
   */
  triggerMessageId: z.string().min(1).optional(),
  /** Route the turn ran under; restart recovery resumes its Session. */
  routeKey: z.string().min(1).optional(),
  /**
   * The prompt this channel submitted through `session/prompt` (absent while
   * it is being assembled, for a host turn, or when it exceeded
   * `INFLIGHT_PROMPT_MAX_BYTES`). Restart recovery replays it, as the same
   * principal and with the same request id, when the Session log shows the
   * turn never claimed it.
   */
  prompt: inflightPromptSchema.optional(),
  /**
   * The claimed message of a host turn (a turn no Feishu message started),
   * kept for classifying the turn from the Session log; never replayed.
   */
  message: inflightMessageSchema.optional(),
  /**
   * Feishu user_id a host turn acts for (the Session's driver when it
   * started), restoring the code-write driver after a restart.
   */
  senderUserId: z.string().min(1).optional(),
  /** How often restart recovery already replayed `prompt` (cap: 1). */
  replays: z.number().int().nonnegative().optional(),
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
 * One user (`user_id`) of the access table. A user with `admin`
 * on is an administrator: always admitted, holding every permission, and
 * able to settle authorization requests; any number of users may be. Every
 * other user carries four independent permission switches; `chat` gates
 * everything, so a user with `chat` off is suspended and the other switches
 * have no effect.
 */
export const accessUserRecordSchema = z.object({
  /** Feishu `user_id` — also the table key. */
  userId: z.string().min(1),
  /** Display name captured when the user was authorized (optional). */
  name: z.string().optional(),
  /** Which authorization entry produced this grant. */
  source: z.enum(['command', 'card', 'panel']),
  /** Administrator user_id that authorized it, or `panel` for the Web settings panel. */
  addedBy: z.string().min(1),
  /** Epoch ms when it was authorized. */
  addedAt: z.number().int().nonnegative(),
  /** Administrator: overrides every switch below. */
  admin: z.boolean().default(false),
  /** May talk to the bot in a private chat and in any group. */
  chat: z.boolean().default(true),
  /** Topics the user drives may use the knowledge-base read tools. */
  wikiRead: z.boolean().default(false),
  /** Topics the user drives may use the knowledge-base create/edit tools. */
  wikiWrite: z.boolean().default(false),
  /** Turns the user drives may call the configured code-write tools. */
  codeWrite: z.boolean().default(false),
  /**
   * Git email an administrator set for this user; commits pushed for a turn
   * the user drives name them as author with it. Absent: the host token's
   * account stays the author.
   */
  gitEmail: z.string().optional(),
})

/** The four permission switches of one access-table user. */
export type AccessPermission = 'chat' | 'wikiRead' | 'wikiWrite' | 'codeWrite'

/** Every boolean field of an access-table user administrators set: the administrator flag and the four permissions. */
export type AccessSwitch = 'admin' | AccessPermission

/** Every permission switch, in display order. */
export const ACCESS_PERMISSIONS: readonly AccessPermission[] = ['chat', 'wikiRead', 'wikiWrite', 'codeWrite']

export type AccessUserRecord = z.infer<typeof accessUserRecordSchema>

/** The three permission switches of one group record (groups have no chat switch). */
export type GroupPermission = Exclude<AccessPermission, 'chat'>

/** Every group permission switch, in display order. */
export const GROUP_PERMISSIONS: readonly GroupPermission[] = ['wikiRead', 'wikiWrite', 'codeWrite']

/**
 * The permissions of one group chat (`chat_id`). A record is created the first time an
 * admitted message opens a topic in the group, with every switch off; only
 * the settings panel changes the switches. The switches gate the tools of
 * every route in the chat: knowledge-base read, knowledge-base
 * create/edit, and the configured code-write tools. Who may talk in the group
 * is decided per user by the user table, never here.
 */
export const groupPermissionRecordSchema = z.object({
  /** Feishu `chat_id` — also the table key. */
  chatId: z.string().min(1),
  /** Group name captured when the record was last written (optional). */
  name: z.string().optional(),
  /** Epoch ms when the record was created. */
  addedAt: z.number().int().nonnegative(),
  /** Topics in the group may use the knowledge-base read tools. */
  wikiRead: z.boolean().default(false),
  /** Topics in the group may use the knowledge-base create/edit tools. */
  wikiWrite: z.boolean().default(false),
  /** Topics in the group may call the configured code-write tools. */
  codeWrite: z.boolean().default(false),
})

export type GroupPermissionRecord = z.infer<typeof groupPermissionRecordSchema>

/**
 * One authorization request the administrators have been (or should be) asked
 * about. Requests are persisted so the DM card stays decidable across plugin
 * restarts; settled records are kept as an audit trail and for request
 * de-duplication/cooldown.
 */
export const accessRequestRecordSchema = z.object({
  /** Opaque token carried by the card buttons — also the table key. */
  token: z.string().min(1),
  /** `user_id` the request asks to add to the user table. */
  targetId: z.string().min(1),
  /** Chat the request originated from, when applicable. */
  chatId: z.string().optional(),
  /** Name of the group the request came from, when known. */
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
  /** DM message ids of the cards delivered to the administrators. */
  messageIds: z.array(z.string()).optional(),
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
/** Retention of `processed` records; also the farthest back missed-message catch-up reads. */
export const PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000

export const processedRecordSchema = z.object({
  /** Key the record is stored under (the Feishu message id). */
  key: z.string().min(1),
  /** Epoch ms when the message was accepted for processing. */
  processedAt: z.number().int().nonnegative(),
})

export type ProcessedRecord = z.infer<typeof processedRecordSchema>

/** A `TopicRootCard` as stored in a launch record. */
export const topicRootCardSchema = z.object({
  title: z.string(),
  taskName: z.string(),
  lead: z.array(z.object({ text: z.string(), bold: z.boolean().optional() })),
  links: z.object({
    nameHeader: z.string(),
    linkHeader: z.string(),
    rows: z.array(z.object({ name: z.string(), url: z.string() })),
  }).optional(),
})

/**
 * One accepted `feishuTopics` launch, keyed by its idempotency key. Kept
 * forever: a retried key answers the stored root card instead of posting a
 * second topic, and a reused key with another fingerprint is refused.
 */
export const topicLaunchRecordSchema = z.object({
  /** The launch's idempotency key (also the table key). */
  key: z.string().min(1),
  /** The launch's fingerprint. */
  bodyHash: z.string().min(1),
  /** Target group chat. */
  chatId: z.string().min(1),
  /** Root card message id (the topic's root). */
  messageId: z.string().min(1),
  /** Epoch ms when the launch was accepted. */
  acceptedAt: z.number().int().nonnegative(),
  /** Requester @-mentioned on the root card. */
  requesterUserId: z.string().min(1),
  /** What the root card shows, kept so the card can be redrawn after a restart. */
  card: topicRootCardSchema,
  /**
   * Root card status. `running` until the first turn settles; a record still
   * `running` when the channel starts belongs to a topic the previous
   * instance never finished, and becomes `interrupted`.
   */
  status: z.enum(['running', 'done', 'stopped', 'error', 'failed', 'interrupted']),
  /** Why the topic could not be started (status `failed`). */
  reason: z.string().optional(),
  /** Topic id (the route key) once the topic is opened. */
  threadId: z.string().min(1).optional(),
})

export type TopicLaunchRecord = z.infer<typeof topicLaunchRecordSchema>

/**
 * Where one Feishu-routed Session came from, keyed by its DSH session id.
 * Written the first time a route record names the Session (new topic,
 * `/renew`, `feishuTopics` launch) and kept after the route retires, so the Web
 * client can still show the origin of an old Session. Names are resolved
 * live when read, never stored.
 */
export const sessionOriginRecordSchema = z.object({
  /** DSH session id (also the table key). */
  key: z.string().min(1),
  /** Route key the Session was bound under (thread_id or chat:<chatId>). */
  routeKey: z.string().min(1),
  /** Topic-scoped (`thread`) or chat-scoped (`chat`) route. */
  kind: z.enum(['thread', 'chat']),
  /** Feishu chat the Session was started from. */
  chatId: z.string().min(1),
  /** `p2p` or `group`. */
  chatType: z.enum(['p2p', 'group']),
  /** `user_id` of the user who started the Session (the requester for launched topics). */
  senderUserId: z.string().min(1),
  /** Epoch ms when the Session was bound to the route. */
  createdAt: z.number().int().nonnegative(),
})

export type SessionOriginRecord = z.infer<typeof sessionOriginRecordSchema>

export const feishuDomainGlobalSchema = z.object({
  /** p2p chats already shown the one-time onboarding card (bounded list). */
  welcomedChats: z.array(z.string()).optional(),
  /** Groups the bot was added to (bounded list), read by missed-message catch-up. */
  knownGroups: z.array(z.string()).optional(),
  /** Epoch ms the long connection was last known up (missed-message catch-up). */
  lastAliveAt: z.number().int().nonnegative().optional(),
})

export type FeishuDomainGlobal = z.infer<typeof feishuDomainGlobalSchema>

/** The plugin's storage domain: one table per record kind plus a small global record. */
export const feishuDomain = {
  name: 'dsh_channels',
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
    access_users: { valueSchema: accessUserRecordSchema },
    access_requests: { valueSchema: accessRequestRecordSchema },
    // Per-group permission switches (key = chat_id).
    group_permissions: { valueSchema: groupPermissionRecordSchema },
    // `feishuTopics` launches (key = idempotency key).
    topic_launches: { valueSchema: topicLaunchRecordSchema },
    // Session id → Feishu origin.
    session_origins: { valueSchema: sessionOriginRecordSchema },
    // Terminal Feishu actions waiting for a retry.
    outbox: { valueSchema: outboxEntrySchema },
    // Session "stop asking in this topic" grants (key = session id).
    approval_grants: { valueSchema: approvalGrantRecordSchema },
    // Delivered approval cards until decided or retried (key = card message id).
    approval_cards: { valueSchema: approvalCardRecordSchema },
  },
} as const

/** The open storage domain, one typed handle per table. */
export interface FeishuDomainHandle {
  routes: DomainTable<RouteRecord>
  /** Repair snapshots of in-flight turns (key = main card message id). */
  inflight: DomainTable<InflightSnapshot>
  /** Inbound dedup records (key = Feishu message id). */
  processed: DomainTable<ProcessedRecord>
  /** Tombstones of TTL-retired thread routes (key = thread id). */
  expiredRoutes: DomainTable<ExpiredRouteRecord>
  accessUsers: DomainTable<AccessUserRecord>
  accessRequests: DomainTable<AccessRequestRecord>
  groupPermissions: DomainTable<GroupPermissionRecord>
  topicLaunches: DomainTable<TopicLaunchRecord>
  /** Feishu origin of every Session a route ever named. */
  sessionOrigins: DomainTable<SessionOriginRecord>
  outbox: DomainTable<OutboxEntry>
  approvalGrants: DomainTable<ApprovalGrantRecord>
  approvalCards: DomainTable<ApprovalCardRecord>
  getGlobal(): FeishuDomainGlobal
  setGlobal(value: FeishuDomainGlobal): Promise<unknown>
  close(): Promise<void>
}

/**
 * Open the plugin's storage domain through the host facility.
 * @param facility - `ctx.storageDomain`.
 * @returns the typed handle.
 */
export async function openFeishuDomain(facility: StorageDomainFacility): Promise<FeishuDomainHandle> {
  const domain = await facility.open(feishuDomain)
  return {
    routes: typedTable(domain.table('routes')),
    inflight: typedTable(domain.table('inflight')),
    processed: typedTable(domain.table('processed')),
    expiredRoutes: typedTable(domain.table('expired_routes')),
    accessUsers: typedTable(domain.table('access_users')),
    accessRequests: typedTable(domain.table('access_requests')),
    groupPermissions: typedTable(domain.table('group_permissions')),
    topicLaunches: typedTable(domain.table('topic_launches')),
    sessionOrigins: typedTable(domain.table('session_origins')),
    outbox: typedTable(domain.table('outbox')),
    approvalGrants: typedTable(domain.table('approval_grants')),
    approvalCards: typedTable(domain.table('approval_cards')),
    getGlobal: () => (domain.global.get() ?? {}) as FeishuDomainGlobal,
    setGlobal: value => domain.global.set(value),
    close: () => domain.close(),
  }
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
