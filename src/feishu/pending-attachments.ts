/**
 * Pending attachment registry: silent metadata registration for inbound
 * messages that do not trigger a model turn.
 *
 * Product rule (decisions D2): attachment-only p2p messages, un-mentioned group
 * messages, and attachment-only messages inside an already-bound topic are
 * recorded as metadata only — no download, no reply, no session, no reaction.
 * A later triggered message can list the most recent unconsumed entries in its
 * prompt manifest and fetch them on demand; the fetch tool also uses the
 * registry as its per-route authorization whitelist.
 *
 * Isolation is structural: every record carries a `scopeKey` derived from
 * `(chat, thread?, sender)`. `list`/`get`/`consume` all require a route scope,
 * so a known message id alone can never unlock another sender's, chat's, or
 * topic's record. A thread route also sees the same sender's chat-scope rows of
 * the same chat (a group file posted without an @ before the topic existed must
 * remain reachable from the topic that the later @-mention creates — Roadmap
 * AC-4); everything else is exactly scope-bound.
 *
 * This task deliberately does NOT call the registry from the inbound path — the
 * admission layer (`admission_manifest_flow`) wires registration after its
 * access gates. To keep that contract enforceable, `registerMessage` requires
 * an explicit admission decision and is a no-op unless it says `admitted`,
 * while `acceptAttachments=false` disables registration entirely.
 *
 * Durability: the primary backing table is `pending_attachments` in the
 * `channels_routes` storage domain (added at the same domain version; the JSON
 * backend initializes the missing declared table as empty). When the domain
 * open succeeds but the host refuses that table (older/embedded host), the same
 * TTL/cap/query semantics run over an in-process map instead; records then live
 * only for this process and are lost on restart. That limitation is logged
 * once.
 *
 * No I/O beyond the injected table: this module never touches the Feishu
 * channel, the filesystem, or the native attachment library.
 *
 * @module dsh-channels/feishu/pending-attachments
 */

import { pendingAttachmentRecordSchema } from '../domain.ts'
import type {
  PendingAttachmentKind, PendingAttachmentRecord, PendingAttachmentResource, PendingAttachmentsTable,
} from '../domain.ts'
import type { NormalizedMessage } from '../feishu-channel.ts'
import {
  EMPTY_POST_PLACEHOLDER, attachmentResources, stripAttachmentPlaceholders,
} from './inbound-attachments.ts'

/** Manifest rows shown to the model: only the most recent N unconsumed entries. */
export const PENDING_ATTACHMENT_MANIFEST_LIMIT = 5

/** Longest caption excerpt kept per record, in Unicode code points. */
export const PENDING_ATTACHMENT_TEXT_EXCERPT_MAX = 200

/** `(chat, thread?, sender)` isolation unit of one pending record. */
export interface PendingAttachmentScope {
  /** Feishu chat id. */
  readonly chatId: string
  /** Feishu topic id; absent for the chat's main timeline. */
  readonly threadId?: string
  /** Normalized sender id (open_id) owning the scope. */
  readonly senderOpenId: string
}

/**
 * Stable, collision-free table value for one scope. Chat-scope and thread-scope
 * keys carry different prefixes so a sender id can never alias a thread id.
 */
export function pendingAttachmentScopeKey(scope: PendingAttachmentScope): string {
  return scope.threadId === undefined
    ? `chat:${scope.chatId}:${scope.senderOpenId}`
    : `thread:${scope.chatId}:${scope.threadId}:${scope.senderOpenId}`
}

/**
 * Whether one record is visible to a route query scope.
 *
 * The exact scope always matches. A thread-bound route additionally matches the
 * same sender's chat-scope rows of the same chat: in a group, a file posted
 * without an @ before the topic existed is registered without a `threadId`, yet
 * the later @-triggered topic must be able to list and fetch it (Roadmap AC-4).
 * Other topics, other senders, and other chats never match.
 */
function recordInScope(record: PendingAttachmentRecord, scope: PendingAttachmentScope): boolean {
  if (record.scopeKey === pendingAttachmentScopeKey(scope)) return true
  if (scope.threadId === undefined) return false
  return record.scopeKey === pendingAttachmentScopeKey({
    chatId: scope.chatId,
    senderOpenId: scope.senderOpenId,
  })
}

/**
 * The admission decision a registration must carry. Only an explicit
 * `admitted: true` may write a record — the registry has no own admission
 * policy, it just refuses to record anything that did not pass the caller's
 * gate.
 */
export type PendingAttachmentAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason?: string }

/** Why a registration did not store anything (`stored: false`). */
export type PendingAttachmentSkipReason =
  | 'disabled'
  | 'not-admitted'
  | 'not-attachment-message'
  | 'invalid-message'
  | 'duplicate'
  | 'storage-error'

/** Outcome of one registration attempt. */
export type PendingAttachmentRegistration =
  | {
    readonly stored: true
    readonly record: PendingAttachmentRecord
    /** Older records evicted from the same scope to respect the per-scope cap. */
    readonly evicted: number
  }
  | { readonly stored: false; readonly reason: PendingAttachmentSkipReason }

/** Backing store actually used by a registry instance. */
export type PendingAttachmentMode = 'durable' | 'memory'

/** Result of one TTL + per-scope-cap sweep (safe to run repeatedly). */
export interface PendingAttachmentPruneResult {
  /** Records removed because they were older than the TTL. */
  readonly removedExpired: number
  /** Oldest records removed because their scope exceeded the row cap. */
  readonly removedOverLimit: number
}

/** Every effect the registry needs, injected so tests can drive a fake clock. */
export interface PendingAttachmentStoreDeps {
  /**
   * Durable table handle. `undefined` = the host opened the storage domain but
   * refused the added table → the registry degrades to the in-process fallback
   * (a domain that cannot open at all fails service startup instead).
   */
  table(): PendingAttachmentsTable | undefined
  /** `acceptAttachments`; `false` makes registration a no-op. */
  enabled(): boolean
  /** Retention window in ms; `<= 0` disables age pruning (the cap still applies). */
  ttlMs(): number
  /** Maximum rows kept per scope (>= 1). */
  maxPerScope(): number
  /** Clock seam; defaults to `Date.now()`. */
  now?(): number
  /** Warning sink (in-memory fallback, per-key write failures). Never throws. */
  warn?(message: string, ...args: unknown[]): void
}

/** One extracted attachment message, before it becomes a durable record. */
export interface PendingAttachmentCandidate {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly threadId?: string
  readonly senderOpenId: string
  readonly kind: PendingAttachmentKind
  readonly resources: readonly PendingAttachmentResource[]
  readonly textExcerpt?: string
}

/**
 * Extract the attachable payload of one normalized message, or `undefined` when
 * the message carries nothing the registry may track.
 *
 * Only image / file / rich-text-with-files / merged-forward messages qualify
 * (audio, video and sticker payloads are out of scope). Feishu folders carry no
 * downloadable bytes but are recorded with a `folder` marker so the fetch tool
 * can answer with a structured "folder unsupported". A merged-forward container
 * has no directly listed resources: children are downloaded through the
 * record's own `messageId`, per the P0 container rule.
 */
export function pendingAttachmentCandidate(
  msg: NormalizedMessage,
): PendingAttachmentCandidate | undefined {
  if (msg.chatType !== 'p2p' && msg.chatType !== 'group') return undefined
  const forwarded = msg.rawContentType === 'merge_forward'
  const resources = attachmentResources(msg).map((resource): PendingAttachmentResource => ({
    type: resource.type,
    fileKey: resource.fileKey,
    ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
    ...(resource.folder === true ? { folder: true } : {}),
  }))
  let kind: PendingAttachmentKind
  if (forwarded) {
    kind = 'merge_forward'
  } else if (msg.rawContentType === 'post') {
    if (resources.length === 0) return undefined
    kind = 'post'
  } else if (msg.rawContentType === 'image' && resources.length > 0) {
    kind = 'image'
  } else if (msg.rawContentType === 'file' && resources.length > 0) {
    kind = 'file'
  } else {
    return undefined
  }
  const excerpt = textExcerptOf(msg.content ?? '', forwarded)
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    ...(msg.threadId === undefined ? {} : { threadId: msg.threadId }),
    senderOpenId: msg.senderId,
    kind,
    resources,
    ...(excerpt === undefined ? {} : { textExcerpt: excerpt }),
  }
}

/**
 * Remaining caption text after attachment placeholders, truncated. A
 * merged-forward record's content is an expanded transcript, not a caption, so
 * it never contributes an excerpt (the manifest formats `kind` instead). The
 * SDK's `[rich text message]` placeholder for a file-only rich-text message is
 * treated as "no caption" exactly like the archive path does.
 */
function textExcerptOf(content: string, forwarded: boolean): string | undefined {
  if (forwarded) return undefined
  const stripped = stripAttachmentPlaceholders(content, false).trim()
  if (stripped === '' || stripped === EMPTY_POST_PLACEHOLDER) return undefined
  const chars = [...stripped]
  if (chars.length <= PENDING_ATTACHMENT_TEXT_EXCERPT_MAX) return stripped
  return chars.slice(0, PENDING_ATTACHMENT_TEXT_EXCERPT_MAX).join('')
}

// ---- backing stores ------------------------------------------------------

/** Minimal storage contract shared by the durable table and the fallback map. */
interface PendingBacking {
  readonly mode: PendingAttachmentMode
  get(key: string): PendingAttachmentRecord | undefined
  put(key: string, value: PendingAttachmentRecord): Promise<unknown>
  update(key: string, fn: (current: PendingAttachmentRecord) => PendingAttachmentRecord): Promise<unknown>
  delete(key: string): Promise<unknown>
  entries(): IterableIterator<[string, PendingAttachmentRecord]>
}

/** Wrap one normalized domain table as a backing store. */
function tableBacking(table: PendingAttachmentsTable): PendingBacking {
  return {
    mode: 'durable',
    get: key => table.get(key),
    put: (key, value) => Promise.resolve(table.put(key, value)),
    update: (key, fn) => table.update(key, current => fn(current)),
    delete: key => Promise.resolve(table.delete(key)),
    entries: () => table.entries(),
  }
}

/**
 * Process-memory fallback for hosts without the added domain table. Same
 * semantics as the durable table (`update` rejects on a missing key) so the
 * registry code path is identical; records are lost when the process exits.
 */
class MemoryBacking implements PendingBacking {
  readonly mode = 'memory' as const
  private readonly records = new Map<string, PendingAttachmentRecord>()

  get(key: string): PendingAttachmentRecord | undefined {
    return this.records.get(key)
  }

  async put(key: string, value: PendingAttachmentRecord): Promise<unknown> {
    this.records.set(key, value)
    return true
  }

  async update(
    key: string,
    fn: (current: PendingAttachmentRecord) => PendingAttachmentRecord,
  ): Promise<unknown> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing-key')
    const next = fn(current)
    this.records.set(key, next)
    return next
  }

  async delete(key: string): Promise<unknown> {
    return this.records.delete(key)
  }

  entries(): IterableIterator<[string, PendingAttachmentRecord]> {
    return this.records.entries()
  }
}

// ---- registry ------------------------------------------------------------

/**
 * Narrow registry API used by the admission layer (register), the prompt
 * manifest (list) and the fetch tool (get/consume). The periodic record GC
 * calls `prune` together with the other routing-domain sweeps.
 */
export class PendingAttachmentStore {
  private readonly deps: PendingAttachmentStoreDeps
  private readonly memory = new MemoryBacking()
  private warnedFallback = false

  constructor(deps: PendingAttachmentStoreDeps) {
    this.deps = deps
  }

  /** Backing mode of the current configuration (no side effects). */
  mode(): PendingAttachmentMode {
    return this.deps.table() === undefined ? 'memory' : 'durable'
  }

  /**
   * Register one admitted attachment message. A no-op for non-attachment
   * messages, a denied admission, `acceptAttachments=false`, and a message id
   * that is already registered (storage-level idempotency; the inbound dedup
   * table remains the authoritative redelivery guard).
   *
   * The durable write happens BEFORE evicting older rows of the same scope: a
   * failed write leaves the scope untouched instead of losing an old row for
   * nothing. A successful eviction restores the cap immediately; only a failed
   * delete can leave the scope over the cap until the next sweep.
   */
  async registerMessage(
    msg: NormalizedMessage,
    admission: PendingAttachmentAdmission,
  ): Promise<PendingAttachmentRegistration> {
    if (!this.deps.enabled()) return { stored: false, reason: 'disabled' }
    if (admission.admitted !== true) return { stored: false, reason: 'not-admitted' }
    const candidate = pendingAttachmentCandidate(msg)
    if (candidate === undefined) return { stored: false, reason: 'not-attachment-message' }
    const now = this.now()
    const backing = this.backing()
    const existing = backing.get(candidate.messageId)
    if (existing !== undefined && !this.expired(existing, now)) {
      return { stored: false, reason: 'duplicate' }
    }
    const record = this.recordOf(candidate, now)
    // A record written here must survive the next domain open, which validates
    // every stored row against the schema; reject malformed input up front
    // instead of poisoning the whole `channels_routes` domain.
    const parsed = pendingAttachmentRecordSchema.safeParse(record)
    if (!parsed.success) {
      this.deps.warn?.(
        'dsh-channels: skipping malformed pending attachment metadata for message %s: %s',
        record.messageId, parsed.error.issues[0]?.message ?? 'invalid record',
      )
      return { stored: false, reason: 'invalid-message' }
    }
    try {
      await backing.put(record.key, record)
    } catch (error) {
      this.deps.warn?.(
        'dsh-channels: pending attachment registration failed for %s: %s',
        record.messageId, String(error),
      )
      return { stored: false, reason: 'storage-error' }
    }
    const evicted = await this.evictOverCap(backing, record.scopeKey, now, record.key)
    return { stored: true, record, evicted }
  }

  /**
   * Most recent unconsumed records visible to one route scope, newest first.
   * The prompt manifest shows at most `PENDING_ATTACHMENT_MANIFEST_LIMIT` rows;
   * callers that need a different window pass an explicit limit (never above the
   * per-scope cap). Expired and consumed rows are excluded.
   *
   * Visibility follows {@link recordInScope}: file-only messages posted in a
   * group's main timeline before the topic existed are registered without a
   * `threadId`, so the topic that a later @-mention creates still lists them
   * (Roadmap AC-4). Other topics, senders, and chats stay invisible.
   */
  list(
    scope: PendingAttachmentScope,
    options: { limit?: number } = {},
  ): PendingAttachmentRecord[] {
    const now = this.now()
    // A thread scope can see its own rows plus the same sender's chat-scope
    // rows (see `recordInScope`), so at most two scopes' caps (2× the per-scope
    // cap) can be visible; the requested manifest window is clamped to that.
    const maxVisible = Math.max(1, this.deps.maxPerScope() * 2)
    const requested = options.limit ?? PENDING_ATTACHMENT_MANIFEST_LIMIT
    const limit = Math.max(1, Math.min(requested, maxVisible))
    const backing = this.backing()
    const rows: PendingAttachmentRecord[] = []
    for (const [, record] of backing.entries()) {
      if (!recordInScope(record, scope)) continue
      if (record.consumed === true) continue
      if (this.expired(record, now)) continue
      rows.push(record)
    }
    rows.sort((left, right) =>
      right.receivedAt - left.receivedAt || left.messageId.localeCompare(right.messageId))
    return rows.slice(0, limit)
  }

  /**
   * Look up one registered message id in one route scope (the fetch tool's
   * authorization whitelist). Consumed rows still resolve — a fetch may be
   * retried — but expired rows and records of another sender / chat / topic do
   * not. Visibility follows {@link recordInScope}.
   */
  get(scope: PendingAttachmentScope, messageId: string): PendingAttachmentRecord | undefined {
    const record = this.backing().get(messageId)
    if (record === undefined) return undefined
    if (!recordInScope(record, scope)) return undefined
    return this.expired(record, this.now()) ? undefined : record
  }

  /**
   * Mark one record consumed so it drops out of the prompt manifest. Returns
   * the record (marked consumed), or `undefined` when absent, expired, or
   * outside the caller's scope. If the write fails the pre-read record is
   * returned anyway and the failure is only logged: the fetch itself must not
   * fail because bookkeeping did.
   */
  async consume(
    scope: PendingAttachmentScope,
    messageId: string,
  ): Promise<PendingAttachmentRecord | undefined> {
    const backing = this.backing()
    const current = backing.get(messageId)
    if (current === undefined || this.expired(current, this.now())) return undefined
    if (!recordInScope(current, scope)) return undefined
    if (current.consumed === true) return current
    try {
      await backing.update(messageId, record => ({ ...record, consumed: true }))
      return { ...current, consumed: true }
    } catch (error) {
      this.deps.warn?.(
        'dsh-channels: marking pending attachment %s consumed failed: %s',
        messageId, String(error),
      )
      return current
    }
  }

  /**
   * Remove expired rows and enforce the per-scope cap, oldest first. Runs at
   * startup and on every periodic record-GC sweep; idempotent by design.
   */
  async prune(): Promise<PendingAttachmentPruneResult> {
    const backing = this.backing()
    const now = this.now()
    const maxRows = Math.max(1, this.deps.maxPerScope())
    let removedExpired = 0
    const remaining: PendingAttachmentRecord[] = []
    for (const [key, record] of [...backing.entries()]) {
      if (this.expired(record, now)) {
        if (await this.remove(backing, key)) removedExpired += 1
        continue
      }
      remaining.push(record)
    }
    const byScope = new Map<string, PendingAttachmentRecord[]>()
    for (const record of remaining) {
      const rows = byScope.get(record.scopeKey)
      if (rows === undefined) byScope.set(record.scopeKey, [record])
      else rows.push(record)
    }
    let removedOverLimit = 0
    for (const rows of byScope.values()) {
      if (rows.length <= maxRows) continue
      rows.sort((left, right) =>
        left.receivedAt - right.receivedAt || left.messageId.localeCompare(right.messageId))
      for (const record of rows.slice(0, rows.length - maxRows)) {
        if (await this.remove(backing, record.key)) removedOverLimit += 1
      }
    }
    return { removedExpired, removedOverLimit }
  }

  /** Resolve a backing store, warning once when durability is unavailable. */
  private backing(): PendingBacking {
    const table = this.deps.table()
    if (table !== undefined) return tableBacking(table)
    if (!this.warnedFallback) {
      this.warnedFallback = true
      this.deps.warn?.(
        'dsh-channels: pending attachment storage domain unavailable; '
        + 'using a process-memory TTL fallback (records are lost on restart)',
      )
    }
    return this.memory
  }

  private recordOf(candidate: PendingAttachmentCandidate, receivedAt: number): PendingAttachmentRecord {
    const scopeKey = pendingAttachmentScopeKey({
      chatId: candidate.chatId,
      ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId }),
      senderOpenId: candidate.senderOpenId,
    })
    return {
      key: candidate.messageId,
      scopeKey,
      messageId: candidate.messageId,
      chatId: candidate.chatId,
      chatType: candidate.chatType,
      ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId }),
      senderOpenId: candidate.senderOpenId,
      receivedAt,
      kind: candidate.kind,
      resources: [...candidate.resources],
      ...(candidate.textExcerpt === undefined ? {} : { textExcerpt: candidate.textExcerpt }),
    }
  }

  /**
   * After a successful write, delete the oldest rows of one scope until the
   * record fits in the cap again (the new record may briefly make the scope
   * exceed the cap by one; a successful eviction restores the cap immediately,
   * only a failed delete leaves the scope over until the next sweep). The just
   * written `keepKey` is never a candidate: `receivedAt` ties (injected clock,
   * clock rollback) would otherwise let the message-id tiebreak evict it.
   */
  private async evictOverCap(
    backing: PendingBacking,
    scopeKey: string,
    now: number,
    keepKey: string,
  ): Promise<number> {
    const maxRows = Math.max(1, this.deps.maxPerScope())
    const rows: PendingAttachmentRecord[] = []
    for (const [, record] of backing.entries()) {
      if (record.scopeKey !== scopeKey) continue
      if (this.expired(record, now)) continue
      rows.push(record)
    }
    if (rows.length <= maxRows) return 0
    const excess = rows.length - maxRows
    const candidates = rows
      .filter(record => record.key !== keepKey)
      .sort((left, right) =>
        left.receivedAt - right.receivedAt || left.messageId.localeCompare(right.messageId))
    let evicted = 0
    for (const record of candidates.slice(0, excess)) {
      if (await this.remove(backing, record.key)) evicted += 1
    }
    return evicted
  }

  private async remove(backing: PendingBacking, key: string): Promise<boolean> {
    try {
      await backing.delete(key)
      return true
    } catch (error) {
      this.deps.warn?.('dsh-channels: pruning pending attachment %s failed: %s', key, String(error))
      return false
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Expired exactly AT the TTL boundary (`receivedAt + ttl <= now`). */
  private expired(record: PendingAttachmentRecord, now: number): boolean {
    const ttl = this.deps.ttlMs()
    if (ttl <= 0) return false
    return record.receivedAt + ttl <= now
  }
}
