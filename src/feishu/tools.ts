/**
 * Model-facing Feishu tools: `feishu_attachment_fetch` (lazy attachment
 * download) and `feishu_topic_messages` (quoted/topic history reads), plus the
 * per-route authorization whitelist they share.
 *
 * Product shape (Roadmap attachment_pipeline_v2): a triggered message creates
 * the Session immediately; files stay unloaded until the model asks for them.
 * This module is the "ask" side: the model names a Feishu message id (and
 * optionally one `file_key`), the tool downloads the resources through the
 * existing channel wrappers, streams files into the DSH native attachment
 * library (`ctx.attachments`) and returns content blocks the model can use.
 *
 * Security model: a message id is NOT a capability. Every call is authorized
 * against a per-route whitelist of messages the channel has already admitted
 * as relevant:
 *
 * - the triggering message / a quoted message registered by the admission and
 *   quote layers through {@link AttachmentFetchToolRuntime.noteKnownMessage};
 * - silently registered attachment messages from the `pending_attachments`
 *   registry (same `(chat, thread?, sender)` scope rules);
 * - messages this tool already resolved (successful or failed attempts), so a
 *   later turn in the same session keeps its authorized resources.
 *
 * The whitelist is an in-memory LRU per route; the pending registry is the
 * durable source for admitted attachment messages (silent registrations and,
 * once the admission task wires it, triggering messages). A prompt-injected
 * message id from another chat, user, or topic therefore cannot download
 * anything. The whitelist is not replayed from Session history: after a host
 * restart the admission/manifest layer re-registers the current turn's
 * messages, while older attachments remain reachable through the durable
 * pending registry until its TTL.
 *
 * Failure model: every per-resource failure is a structured value (never a
 * thrown raw error) so one bad resource does not abort the call and session
 * history stays readable (the P0 `[object Object]` lesson). Cancellation and
 * the whole-call timeout are reported with explicit codes instead.
 *
 * @module dsh-channels/feishu/tools
 */

import { z } from 'zod'
import type { FeishuConfig } from '../config.ts'
import type { PendingAttachmentRecord, PendingAttachmentResource } from '../domain.ts'
import type {
  AgentContext, ToolContentBlock, ToolDefinition, ToolExecution,
} from '../host/agent.ts'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef,
} from '../host/attachments.ts'
import type { FeishuChannel, ResourceChunkStream } from '../feishu-channel.ts'
import { describeFailure } from './inbound-attachments.ts'
import {
  MessageReader,
  TOPIC_MESSAGES_DEFAULT_LIMIT,
  TOPIC_MESSAGES_MAX_LIMIT,
  clampInt,
  describeReadError,
  knownMessageOfItems,
  messageBelongsToRoute,
  quoteItemsOf,
  topicMessageViewOf,
} from './message-read.ts'
import type {
  MessageReadFailureCode, TopicMessageResourceView, TopicMessageView,
} from './message-read.ts'
import {
  attachmentFailureReason, FALLBACK_MAX_IMAGE_BYTES, nativeAttachmentStoreOf,
  resolveAttachmentService,
} from './native-attachments.ts'
import type {
  AttachmentFailureCode, AttachmentResult, NativeAttachmentStore, StoredFile, StoredImage,
} from './native-attachments.ts'
import type { PendingAttachmentScope, PendingAttachmentStore } from './pending-attachments.ts'

// ---- Public identity ----------------------------------------------------

/** Model-facing tool name; stable across releases (session history references it). */
export const ATTACHMENT_FETCH_TOOL_NAME = 'feishu_attachment_fetch'

/**
 * Default number of known messages kept per route (LRU). Sized well above one
 * history page (≤50 rows): a dense attachment page plus the trigger/quote
 * entries of the current turn must not evict each other.
 */
export const DEFAULT_KNOWN_MESSAGES_PER_ROUTE = 128

/**
 * Maximum time agent setup waits for the host `tools`/`attachments` services
 * before degrading to "tool not mounted". A deployment without those services
 * must not block session creation; if they appear later the pending injection
 * still registers the tool.
 */
const MOUNT_INJECT_WAIT_MS = 2_000

/** Retry wait for later sessions once the first mount timed out (fast-fail). */
const MOUNT_INJECT_RETRY_WAIT_MS = 250

// ---- Route / whitelist vocabulary ---------------------------------------

/**
 * The channel-plane identity of one conversation route. The service derives it
 * from the durable `RouteRecord`; all fields are needed to prove that a
 * whitelist entry belongs to the route currently executing the tool.
 */
export interface AttachmentFetchRoute {
  /** Durable route key (thread id, or the degraded chat route key). */
  readonly key: string
  readonly kind: 'thread' | 'chat'
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderOpenId: string
}

/** Why a message became known to one route. */
export type KnownAttachmentSource =
  | 'trigger'
  | 'quote'
  | 'pending'
  | 'tool-result'
  | 'manual'
  /** A message discovered while reading topic history/quote context (P2). */
  | 'history'

/** One downloadable resource of a known message. */
export interface KnownAttachmentResource {
  readonly type: 'image' | 'file'
  readonly fileKey: string
  readonly fileName?: string
  /** Feishu folder entries cannot be downloaded; reported as unsupported. */
  readonly folder?: boolean
  /** Top-level merged-forward container id to download through, when different. */
  readonly containerMessageId?: string
}

/** One message the current route may fetch attachments from. */
export interface KnownAttachmentMessage {
  readonly messageId: string
  readonly kind: 'message' | 'merge_forward'
  readonly resources: readonly KnownAttachmentResource[]
  /** Sender the message was attributed to when it entered the whitelist. */
  readonly senderOpenId?: string
}

/** Registration input for the whitelist. */
export interface KnownAttachmentMessageInput extends KnownAttachmentMessage {
  readonly source?: KnownAttachmentSource
}

/** The thread id a route's `(chat, thread?, sender)` scope carries. */
export function threadIdOfRoute(route: AttachmentFetchRoute): string | undefined {
  return route.kind === 'thread' ? route.key : undefined
}

/**
 * Whether a whitelist entry was registered for exactly this route. Route keys
 * are durable, but records can be replaced (a chat route re-created after a
 * TTL) — re-checking chat, sender, chat type and key kind keeps an old entry
 * from authorizing a new owner.
 */
function routesMatch(left: AttachmentFetchRoute, right: AttachmentFetchRoute): boolean {
  return left.key === right.key
    && left.kind === right.kind
    && left.chatId === right.chatId
    && left.chatType === right.chatType
    && left.senderOpenId === right.senderOpenId
}

/** Pending-registry scope for one route (`threadId` only for topic routes). */
export function pendingScopeOfRoute(route: AttachmentFetchRoute): PendingAttachmentScope {
  const threadId = threadIdOfRoute(route)
  return {
    chatId: route.chatId,
    senderOpenId: route.senderOpenId,
    ...(threadId === undefined ? {} : { threadId }),
  }
}

interface WhitelistedMessage {
  readonly route: AttachmentFetchRoute
  readonly message: KnownAttachmentMessage
  readonly source: KnownAttachmentSource
  readonly registeredAt: number
}

/**
 * Per-route LRU of messages the channel has declared relevant.
 *
 * The store is intentionally process-local: silently registered attachments
 * have a durable registry of their own, while trigger/quote knowledge only
 * lives as long as the process (after a restart the admission/manifest layer
 * re-registers the current turn's messages; this tool does not replay Session
 * history into the whitelist).
 */
export class RouteAttachmentWhitelist {
  private readonly routes = new Map<string, Map<string, WhitelistedMessage>>()

  constructor(private readonly limit: number = DEFAULT_KNOWN_MESSAGES_PER_ROUTE) {}

  /** Register (or refresh) one known message for one route. */
  register(
    route: AttachmentFetchRoute,
    message: KnownAttachmentMessage,
    source: KnownAttachmentSource = 'manual',
    now = Date.now(),
  ): void {
    let entries = this.routes.get(route.key)
    if (entries === undefined) {
      entries = new Map()
      this.routes.set(route.key, entries)
    }
    // Re-insertion is the LRU touch: a refreshed message sorts last.
    entries.delete(message.messageId)
    entries.set(message.messageId, {
      route: { ...route },
      message: {
        messageId: message.messageId,
        kind: message.kind,
        resources: message.resources.map(resource => ({ ...resource })),
        ...(message.senderOpenId === undefined ? {} : { senderOpenId: message.senderOpenId }),
      },
      source,
      registeredAt: now,
    })
    while (entries.size > Math.max(1, this.limit)) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  /** Look up one message for one route; misses for any other route. */
  lookup(route: AttachmentFetchRoute, messageId: string): KnownAttachmentMessage | undefined {
    const entries = this.routes.get(route.key)
    const hit = entries?.get(messageId)
    if (entries === undefined || hit === undefined) return undefined
    if (!routesMatch(hit.route, route)) return undefined
    // Touch for LRU recency.
    entries.delete(messageId)
    entries.set(messageId, hit)
    return hit.message
  }

  /** Number of known messages (one route at a time, or all routes). */
  size(routeKey?: string): number {
    if (routeKey !== undefined) return this.routes.get(routeKey)?.size ?? 0
    let total = 0
    for (const entries of this.routes.values()) total += entries.size
    return total
  }

  /** Every route key currently holding entries (route-GC sweep). */
  routeKeys(): string[] {
    return [...this.routes.keys()]
  }

  /** Drop every entry of one route (route retirement / tests). */
  forget(routeKey: string): void {
    this.routes.delete(routeKey)
  }

  /** Drop every route (shutdown / tests). */
  clear(): void {
    this.routes.clear()
  }
}

// ---- Structured failures ------------------------------------------------

/** Stable failure codes this tool reports per resource or per call. */
export type AttachmentFetchFailureCode =
  | AttachmentFailureCode
  | 'ROUTE_NOT_FOUND'
  | 'AUTHORIZATION_DENIED'
  | 'CHANNEL_UNAVAILABLE'
  | 'MESSAGE_READ_FAILED'
  | 'NO_RESOURCES'
  | 'UNKNOWN_FILE_KEY'
  | 'RESOURCE_LIMIT'
  | 'BYTES_LIMIT'
  | 'TOOL_DISABLED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'DOWNLOAD_FAILED'
  | 'INTERNAL_ERROR'

const FETCH_FAILURE_REASONS: Readonly<Record<string, string>> = {
  ROUTE_NOT_FOUND: '当前会话尚未绑定飞书对话，无法获取附件',
  AUTHORIZATION_DENIED: '该消息不在本会话的附件授权范围内（仅可获取触发消息、引用消息或附件清单中登记的消息）',
  CHANNEL_UNAVAILABLE: '飞书连接未运行，无法获取附件',
  MESSAGE_READ_FAILED: '读取飞书消息内容失败',
  NO_RESOURCES: '该消息不包含可下载的图片或文件',
  UNKNOWN_FILE_KEY: '该 file_key 不属于这条消息',
  RESOURCE_LIMIT: '本次消息的附件数量超过单次获取上限',
  BYTES_LIMIT: '本次下载总字节超过单次上限',
  TOOL_DISABLED: '附件获取工具已禁用',
  TIMEOUT: '附件获取超时',
  ABORTED: '附件获取已取消',
  DOWNLOAD_FAILED: '飞书附件下载失败',
  INTERNAL_ERROR: '附件获取失败',
}

/** Model-safe, user-facing reason for one failure code. */
export function attachmentFetchFailureReason(code: AttachmentFetchFailureCode): string {
  const own = FETCH_FAILURE_REASONS[code]
  if (own !== undefined) return own
  const host = attachmentFailureReason(code as AttachmentFailureCode)
  return typeof host === 'string' && host.length > 0 ? host : FETCH_FAILURE_REASONS.INTERNAL_ERROR ?? '附件获取失败'
}

/** One structured failure: a stable code plus a readable reason. */
export interface AttachmentFetchFailure {
  readonly ok: false
  readonly code: AttachmentFetchFailureCode
  readonly reason: string
}

function failure(code: AttachmentFetchFailureCode, reason?: string): AttachmentFetchFailure {
  return { ok: false, code, reason: reason ?? attachmentFetchFailureReason(code) }
}

// ---- Tool arguments -----------------------------------------------------

/**
 * Runtime argument validation. The host projects
 * {@link ATTACHMENT_FETCH_PARAMETERS} to the model but does not re-validate
 * arguments against it (verified against dsh-tools 0.2.1-rc.2), so this zod
 * schema is the authoritative argument gate; it also gives tests and
 * embedded/non-native callers a typed value.
 */
export const attachmentFetchArgsSchema = z.object({
  message_id: z.string().min(1),
  file_key: z.string().min(1).optional(),
}).strict()

export type AttachmentFetchArgs = z.infer<typeof attachmentFetchArgsSchema>

/** Model-facing parameter schema (hand-written; no DSH runtime import). */
export const ATTACHMENT_FETCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['message_id'],
  properties: {
    message_id: {
      type: 'string',
      description: 'Feishu message id (om_...) of the message whose attachments to fetch.',
    },
    file_key: {
      type: 'string',
      description: 'Optional image/file key of one attachment of that message; omit to fetch every attachment it carries.',
    },
  },
}

// ---- Tool result value --------------------------------------------------

/** One fetched (or failed) resource in the tool result value. */
export interface AttachmentFetchResultItem {
  readonly ok: boolean
  readonly kind: 'image' | 'file'
  readonly name?: string
  readonly file_key?: string
  readonly bytes?: number
  readonly media_type?: string
  readonly width?: number
  readonly height?: number
  /** Read-only host path of one stored image, when the backend maps one. */
  readonly read_path?: string
  /** Deterministic file handle text (name/bytes/digest/read-only path). */
  readonly handle_text?: string
  readonly code?: AttachmentFetchFailureCode
  readonly reason?: string
  readonly attachment?: ImageAttachmentRef | FileAttachmentRef
}

/** Tool output value: lossless JSON by construction (no `undefined` properties). */
export interface AttachmentFetchValue {
  readonly message_id: string
  readonly ok: boolean
  readonly summary: string
  readonly results: readonly AttachmentFetchResultItem[]
}

/** Model-facing output schema; mirrors {@link AttachmentFetchValue}. */
export const ATTACHMENT_FETCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['message_id', 'ok', 'summary', 'results'],
  properties: {
    message_id: { type: 'string' },
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'kind'],
        properties: {
          ok: { type: 'boolean' },
          kind: { type: 'string', enum: ['image', 'file'] },
          name: { type: 'string' },
          file_key: { type: 'string' },
          bytes: { type: 'number' },
          media_type: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          read_path: { type: 'string' },
          handle_text: { type: 'string' },
          code: { type: 'string' },
          reason: { type: 'string' },
          attachment: { type: 'object' },
        },
      },
    },
  },
}

// ---- Runtime dependency surface -----------------------------------------

/** Everything the tool runtime needs, injected by the service. */
export interface AttachmentFetchRuntimeDeps {
  /** Live plugin configuration (switches, limits). */
  config(): FeishuConfig
  /** Live Feishu channel; undefined while disconnected/shut down. */
  channel(): FeishuChannel | undefined
  /** Durable silent-registration registry (authorization + consumption). */
  pending?(): PendingAttachmentStore | undefined
  /** Resolve the route currently bound to one session. */
  routeOfSession(sessionId: string): AttachmentFetchRoute | undefined
  /** Structured warning sink (mount degradation, unexpected failures). */
  warn(message: string, ...args: unknown[]): void
  /** Clock seam for whitelist recency (tests). */
  now?(): number
}

interface FetchCallContext {
  readonly route: AttachmentFetchRoute
  readonly args: AttachmentFetchArgs
  readonly signal: AbortSignal
  readonly timeout: { value: boolean }
  readonly budget: DownloadBudget
  readonly limits: { readonly maxResources: number }
  readonly native: NativeAttachmentStore
  readonly imageCap: number
  readonly channel: FeishuChannel | undefined
  readonly pending: PendingAttachmentStore | undefined
}

interface DownloadBudget {
  readonly maxBytes: number
  usedBytes: number
  /** Set once a chunk would push the call over its total byte budget. */
  exceeded: boolean
}

/**
 * The `feishu_attachment_fetch` runtime: mounts the tool into Agent scopes and
 * owns the per-route whitelist that the admission/quote layers populate.
 */
export class AttachmentFetchToolRuntime {
  readonly whitelist: RouteAttachmentWhitelist
  /** Agent scope → its one mount attempt (cordis callbacks get distinct ctx objects). */
  private readonly mountAttempts = new WeakMap<AgentContext, Promise<void>>()
  private warnedMissingTools = false
  private warnedMissingAttachments = false
  private warnedMountFailure = false
  private warnedUnavailable = false

  constructor(private readonly deps: AttachmentFetchRuntimeDeps) {
    this.whitelist = new RouteAttachmentWhitelist(DEFAULT_KNOWN_MESSAGES_PER_ROUTE)
  }

  /**
   * Whether the feature switch currently allows tool registration/execution.
   * `acceptAttachments=false` keeps inbound attachment messages inert, so a
   * tool that only downloads them is disabled as well.
   */
  enabled(): boolean {
    const config = this.deps.config()
    return config.feishuTools.attachmentFetch && config.acceptAttachments
  }

  /**
   * Pre-authorize one message for one route. The admission layer calls this for
   * the triggering message; the quote layer calls it for quoted messages; this
   * tool itself records messages it resolved. A no-op while the feature is
   * disabled keeps a disabled runtime from accumulating state.
   */
  noteKnownMessage(
    route: AttachmentFetchRoute,
    message: KnownAttachmentMessageInput,
    source: KnownAttachmentSource = message.source ?? 'manual',
  ): void {
    if (!this.enabled()) return
    this.whitelist.register(route, message, source, this.now())
  }

  /**
   * Whether one message id is authorized for one route: the in-memory whitelist
   * first, then the durable pending registry — the same sources
   * {@link resolveKnownMessage} uses when a fetch is executed. The
   * `feishu_topic_messages` tool calls this to decide whether a main-timeline
   * message (no `thread_id`) may be detached into the current topic route.
   *
   * Never throws: an unavailable registry fails closed.
   */
  isKnownMessage(route: AttachmentFetchRoute, messageId: string): boolean {
    if (this.whitelist.lookup(route, messageId) !== undefined) return true
    const pending = this.deps.pending?.()
    if (pending === undefined) return false
    try {
      return pending.get(pendingScopeOfRoute(route), messageId) !== undefined
    } catch {
      // Authorization lookups fail closed; a storage hiccup must not throw into
      // the topic tool's read path.
      return false
    }
  }

  /**
   * Register the tool inside one Agent scope.
   *
   * Called from the agent-preset `setup` after the preset is mounted (the host
   * composes tools inside presets). `inject(['tools', 'attachments'])` is the
   * P0-proven registration path; the callback re-checks both services because
   * a host may resolve the injection with a partially mounted scope. Missing
   * services are a no-op with one warning; a mount failure never fails the
   * session.
   */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    if (!this.enabled()) return
    // Cordis hands the inject callback a DIFFERENT context object than the
    // agent ctx, so dedupe on the outer scope and reuse its single attempt.
    const existing = this.mountAttempts.get(agentCtx)
    if (existing !== undefined) return await existing
    const attempt = this.mountAttempt(agentCtx, sessionId)
    this.mountAttempts.set(agentCtx, attempt)
    await attempt
  }

  private async mountAttempt(agentCtx: AgentContext, sessionId: string): Promise<void> {
    let injected = false
    const outcome = await waitForAvailability(
      Promise.resolve(agentCtx.inject(['tools', 'attachments'], (ctx) => {
        injected = true
        this.registerInScope(ctx, sessionId)
      })),
      // A deployment that already timed out once is unlikely to gain the
      // services a moment later: fail fast on later sessions while the pending
      // injection can still backfill registration if they do appear.
      this.warnedUnavailable ? MOUNT_INJECT_RETRY_WAIT_MS : MOUNT_INJECT_WAIT_MS,
    )
    if (outcome === 'failed') {
      this.warnMountFailure(`dsh-channels: mounting ${ATTACHMENT_FETCH_TOOL_NAME} failed`)
      return
    }
    // Real cordis settles an injection whose dependencies never appear WITHOUT
    // calling the callback; treat "settled but never injected" as unavailable.
    // The fiber stays pending so a late service still backfills registration.
    if (!injected && !this.warnedUnavailable) {
      this.warnedUnavailable = true
      this.deps.warn(
        'dsh-channels: %s 未挂载：宿主 tools/attachments 服务不可用（会话继续）',
        ATTACHMENT_FETCH_TOOL_NAME,
      )
    }
  }

  /** Drop the whitelist entries of one retired route (record GC / cleanup). */
  forgetRoute(routeKey: string): void {
    this.whitelist.forget(routeKey)
  }

  /**
   * Drop whitelist routes that no longer resolve as active route records. The
   * inbound TTL path retires a thread route without going through the service
   * cleanup callback, so the periodic GC reconciles the whitelist afterwards.
   * @returns number of route buckets dropped.
   */
  pruneRoutes(stillActive: (routeKey: string) => boolean): number {
    let removed = 0
    for (const key of this.whitelist.routeKeys()) {
      if (stillActive(key)) continue
      this.whitelist.forget(key)
      removed += 1
    }
    return removed
  }

  /** Drop every whitelisted route (shutdown). */
  clear(): void {
    this.whitelist.clear()
  }

  private registerInScope(agentCtx: AgentContext, sessionId: string): void {
    // No per-callback-context dedupe: when a host service unloads/reloads,
    // cordis disposes the injection fiber's effects (including our
    // `tools.register`) and invokes this callback again with the same ctx
    // object. Skipping the re-registration would silently lose the tool; a
    // genuinely duplicated registration is caught below as a warning.
    const tools = agentCtx.tools
    if (tools === undefined || typeof tools.register !== 'function') {
      if (!this.warnedMissingTools) {
        this.warnedMissingTools = true
        this.deps.warn(
          'dsh-channels: %s 未注册：宿主 tools 服务不可用（附件工具已禁用）',
          ATTACHMENT_FETCH_TOOL_NAME,
        )
      }
      return
    }
    const service = resolveAttachmentService(agentCtx)
    if (service === undefined) {
      if (!this.warnedMissingAttachments) {
        this.warnedMissingAttachments = true
        this.deps.warn(
          'dsh-channels: %s 未注册：宿主 attachments 服务不可用（附件工具已禁用）',
          ATTACHMENT_FETCH_TOOL_NAME,
        )
      }
      return
    }
    try {
      tools.register(this.definitionFor(agentCtx, sessionId))
    } catch (error) {
      this.warnMountFailure(
        `dsh-channels: registering ${ATTACHMENT_FETCH_TOOL_NAME} failed: ${String(error)}`,
      )
    }
  }

  private warnMountFailure(message: string): void {
    if (this.warnedMountFailure) return
    this.warnedMountFailure = true
    this.deps.warn(message)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ---- Tool definition --------------------------------------------------

  private definitionFor(agentCtx: AgentContext, sessionId: string): ToolDefinition {
    return {
      name: ATTACHMENT_FETCH_TOOL_NAME,
      description:
        'Fetch images/files attached to a known Feishu message in this conversation. '
        + 'Images come back as viewable image content; files are saved as immutable read-only copies and returned with a readable path. '
        + 'Without file_key every attachment of the message is fetched. '
        + 'Only messages already known to this conversation (the triggering message, a quoted message, or an attachment listed in context) are accessible; unknown message ids are refused. '
        + 'Calls are bounded by a per-call attachment count, total byte budget and timeout; per-attachment failures are reported without aborting the whole call.',
      parameters: ATTACHMENT_FETCH_PARAMETERS,
      output: {
        schema: ATTACHMENT_FETCH_OUTPUT_SCHEMA,
        render: (_args, value) => renderAttachmentFetchResult(value),
      },
      execute: async (rawArgs, exec) => await this.execute(agentCtx, sessionId, rawArgs, exec),
      presentCall: args => presentAttachmentFetchCall(args),
      presentResult: (_args, value) => presentAttachmentFetchResult(value),
      isConcurrencySafe: () => false,
    }
  }

  // ---- Execution --------------------------------------------------------

  private async execute(
    agentCtx: AgentContext,
    sessionId: string,
    rawArgs: Record<string, unknown>,
    exec: ToolExecution,
  ): Promise<AttachmentFetchValue> {
    const parsed = attachmentFetchArgsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      // A thrown, readable error is the correct shape for invalid arguments:
      // the host turns it into a failed tool call with a text message (never a
      // raw object rendered as `[object Object]`).
      const issue = parsed.error.issues[0]
      const path = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.')
      throw new Error(`${ATTACHMENT_FETCH_TOOL_NAME}: invalid ${path}: ${issue?.message ?? 'invalid arguments'}`)
    }
    const args = parsed.data
    const messageId = args.message_id
    if (!this.enabled()) return callFailure(messageId, failure('TOOL_DISABLED'))

    const route = this.deps.routeOfSession(sessionId)
    if (route === undefined) {
      return callFailure(messageId, failure('ROUTE_NOT_FOUND'))
    }
    const config = this.deps.config().feishuTools
    const scope = createAbortScope(exec.signal, config.attachmentFetchTimeoutMs)
    const budget: DownloadBudget = { maxBytes: config.attachmentFetchMaxBytes, usedBytes: 0, exceeded: false }
    const call: FetchCallContext = {
      route,
      args,
      signal: scope.signal,
      timeout: scope.timeout,
      budget,
      limits: {
        maxResources: config.attachmentFetchMaxResources,
      },
      native: nativeAttachmentStoreOf(agentCtx),
      imageCap: imageByteCapOf(agentCtx),
      channel: this.deps.channel(),
      pending: this.deps.pending?.(),
    }
    try {
      return await this.fetch(call)
    } catch (error) {
      if (budget.exceeded) return callFailure(messageId, failure('BYTES_LIMIT'))
      if (scope.signal.aborted) {
        return callFailure(messageId, failure(scope.timeout.value ? 'TIMEOUT' : 'ABORTED'))
      }
      const reason = `${attachmentFetchFailureReason('INTERNAL_ERROR')}：${describeUnexpectedError(error)}`
      this.deps.warn('dsh-channels: %s failed unexpectedly: %s', ATTACHMENT_FETCH_TOOL_NAME, reason)
      return callFailure(messageId, { ok: false, code: 'INTERNAL_ERROR', reason })
    } finally {
      scope.dispose()
    }
  }

  private async fetch(call: FetchCallContext): Promise<AttachmentFetchValue> {
    const messageId = call.args.message_id
    if (call.signal.aborted) {
      return callFailure(messageId, failure(call.timeout.value ? 'TIMEOUT' : 'ABORTED'))
    }

    // 1. Authorize the message against this route's known resources.
    const known = this.resolveKnownMessage(call, messageId)
    if (known === undefined) {
      return callFailure(messageId, failure('AUTHORIZATION_DENIED'))
    }

    // 2. Resolve every resource (explicit list, or message/container expansion).
    let resources = [...known.resources]
    if (resources.length === 0) {
      const expanded = await this.expandMessageResources(call, known)
      if (!expanded.ok) return callFailure(messageId, expanded)
      resources = expanded.resources
    }
    const allResources = resources
    if (call.args.file_key !== undefined) {
      const key = call.args.file_key
      resources = allResources.filter(resource => resource.fileKey === key)
      if (resources.length === 0) {
        // Bound the listing: a merged-forward container may hold hundreds of
        // child keys and the error text is model-visible.
        const knownKeys = allResources.map(resource => resource.fileKey)
        const shown = knownKeys.slice(0, 10)
        const hidden = knownKeys.length - shown.length
        const available = knownKeys.length === 0
          ? ''
          : `（可用：${shown.join('、')}${hidden > 0 ? ` 等 ${knownKeys.length} 个` : ''}）`
        return callFailure(messageId, failure(
          'UNKNOWN_FILE_KEY',
          `${attachmentFetchFailureReason('UNKNOWN_FILE_KEY')}：${displayText(key)}${available}`,
        ))
      }
    }
    if (resources.length === 0) {
      return callFailure(messageId, failure('NO_RESOURCES'))
    }
    if (resources.length > call.limits.maxResources) {
      return callFailure(messageId, failure(
        'RESOURCE_LIMIT',
        `${attachmentFetchFailureReason('RESOURCE_LIMIT')}（本消息 ${resources.length} 个，单次上限 ${call.limits.maxResources} 个；请用 file_key 分批获取）`,
      ))
    }

    // 3. The message is authorized and has a usable resource set: remember it
    //    (with the resolved resources) for later turns of this route. This is
    //    an authorization fact, so it is recorded even if the downloads below
    //    fail and the model retries. Bookkeeping never fails the fetch.
    this.rememberKnownMessage(call, known, allResources)

    // 4. Fetch each resource, keeping per-resource failures as values.
    const results: AttachmentFetchResultItem[] = []
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index]
      if (resource === undefined) continue
      if (call.signal.aborted) {
        results.push(cancelledItem(resource, call.timeout.value))
        for (const rest of resources.slice(index + 1)) results.push(cancelledItem(rest, call.timeout.value))
        break
      }
      if (call.budget.exceeded) {
        results.push(failedItem(resource, failure('BYTES_LIMIT')))
        for (const rest of resources.slice(index + 1)) results.push(failedItem(rest, failure('BYTES_LIMIT')))
        break
      }
      if (call.channel === undefined) {
        results.push(failedItem(resource, failure('CHANNEL_UNAVAILABLE')))
        continue
      }
      results.push(await this.fetchResource(call, known, resource))
    }

    const fetched = results.filter(item => item.ok).length
    // A pending manifest row is consumed only once an attachment was actually
    // fetched: a run where every download failed keeps the row discoverable
    // (retries are still authorized by the whitelist entry recorded above).
    // The durable write is best-effort and raced against the call signal, so a
    // stalled storage backend can never keep the tool call pending.
    if (fetched > 0 && call.pending !== undefined) {
      try {
        await cancellable(
          Promise.resolve(call.pending.consume(pendingScopeOfRoute(call.route), known.messageId)),
          call.signal,
        )
      } catch {
        // Bookkeeping only: the attachments were already delivered.
      }
    }
    const shownMessageId = displayText(messageId)
    const summary = fetched > 0
      ? `已获取 ${fetched}/${results.length} 个附件（消息 ${shownMessageId}）`
      : `${attachmentFetchFailureReason(
        results.length === 0 ? 'NO_RESOURCES'
          : (results[0]?.code ?? 'DOWNLOAD_FAILED'),
      )}（消息 ${shownMessageId}）`
    return {
      message_id: messageId,
      ok: fetched > 0 && fetched === results.length,
      summary,
      results,
    }
  }

  /** Whitelist first, then the durable silent-registration registry. */
  private resolveKnownMessage(
    call: FetchCallContext,
    messageId: string,
  ): KnownAttachmentMessage | undefined {
    const known = this.whitelist.lookup(call.route, messageId)
    if (known !== undefined) return known
    const pending = call.pending
    if (pending === undefined) return undefined
    const record = pending.get(pendingScopeOfRoute(call.route), messageId)
    if (record === undefined) return undefined
    return knownMessageOfPending(record)
  }

  /** Record the resolved message as known for later turns of this route. */
  private rememberKnownMessage(
    call: FetchCallContext,
    message: KnownAttachmentMessage,
    resources: readonly KnownAttachmentResource[],
  ): void {
    this.whitelist.register(
      call.route,
      { ...message, resources },
      'tool-result',
      this.now(),
    )
  }

  // ---- Resource expansion ----------------------------------------------

  /**
   * Read one known message through the channel's raw message API to discover
   * its resources. This is the merged-forward path (P0: children are listed on
   * the top-level container message, while their bytes download through the
   * container id) and the fallback for trigger/quote registrations that carry
   * only a message id.
   */
  private async expandMessageResources(
    call: FetchCallContext,
    message: KnownAttachmentMessage,
  ): Promise<{ ok: true; resources: KnownAttachmentResource[] } | AttachmentFetchFailure> {
    const channel = call.channel
    if (channel === undefined) return failure('CHANNEL_UNAVAILABLE')
    const messageGet = channel.messageGet
    if (messageGet === undefined) {
      return failure(
        'MESSAGE_READ_FAILED',
        `${attachmentFetchFailureReason('MESSAGE_READ_FAILED')}：当前飞书通道不支持读取消息内容，无法展开附件`,
      )
    }
    let response: unknown
    try {
      response = await cancellable(Promise.resolve(messageGet.call(channel, message.messageId)), call.signal)
    } catch (error) {
      if (isAbortError(error)) throw error
      return failure(
        'MESSAGE_READ_FAILED',
        `${attachmentFetchFailureReason('MESSAGE_READ_FAILED')}：${describeFetchError(error)}`,
      )
    }
    const items = rawMessageItems(response)
    if (items === undefined) {
      return failure(
        'MESSAGE_READ_FAILED',
        `${attachmentFetchFailureReason('MESSAGE_READ_FAILED')}：返回内容无法识别`,
      )
    }
    const resources = message.kind === 'merge_forward'
      ? mergedForwardResources(items)
      : messageResourcesOfItems(items)
    return { ok: true, resources }
  }

  // ---- Per-resource fetch ----------------------------------------------

  private async fetchResource(
    call: FetchCallContext,
    message: KnownAttachmentMessage,
    resource: KnownAttachmentResource,
  ): Promise<AttachmentFetchResultItem> {
    // `containerMessageId` is part of a trusted registration (pending record or
    // admission-provided whitelist entry), never model input: the P0 rule makes
    // merged-forward child bytes downloadable only through the top-level
    // container id, so child ids are never used as download ids here.
    const downloadId = resource.containerMessageId ?? message.messageId
    if (resource.folder === true) {
      return failedItem(resource, failure('FOLDER_UNSUPPORTED'))
    }
    if (resource.type === 'image') {
      return await this.fetchImage(call, downloadId, resource)
    }
    return await this.fetchFile(call, downloadId, resource)
  }

  private async fetchImage(
    call: FetchCallContext,
    downloadId: string,
    resource: KnownAttachmentResource,
  ): Promise<AttachmentFetchResultItem> {
    const channel = call.channel
    if (channel === undefined) return failedItem(resource, failure('CHANNEL_UNAVAILABLE'))
    const remaining = call.budget.maxBytes - call.budget.usedBytes
    if (remaining <= 0) {
      call.budget.exceeded = true
      return failedItem(resource, failure('BYTES_LIMIT'))
    }
    const imageCap = call.imageCap
    const limit = Math.min(imageCap, remaining)
    let stream: ResourceChunkStream
    try {
      stream = await cancellable(Promise.resolve(channel.downloadResource(downloadId, resource.fileKey, 'image')), call.signal)
    } catch (error) {
      return downloadFailureItem(resource, error, call)
    }
    let bytes: Uint8Array
    try {
      bytes = await cancellable(
        collectBoundedBytes(stream, call.signal, call.budget, limit, imageCap),
        call.signal,
      )
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        call.budget.exceeded = true
        return failedItem(resource, failure('BYTES_LIMIT'))
      }
      if (error instanceof ImageTooLargeError) {
        return failedItem(resource, failure('IMAGE_TOO_LARGE'))
      }
      return downloadFailureItem(resource, error, call)
    }
    let saved: AttachmentResult<StoredImage>
    try {
      saved = await cancellable(call.native.saveImage({
        bytes,
        ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
      }), call.signal)
    } catch (error) {
      return downloadFailureItem(resource, error, call)
    }
    if (!saved.ok) return failedItem(resource, saved)
    const ref = saved.value.ref
    const read = call.native.imageReadPath(ref)
    return {
      ok: true,
      kind: 'image',
      ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
      file_key: resource.fileKey,
      bytes: ref.bytes,
      media_type: ref.mediaType,
      width: ref.width,
      height: ref.height,
      ...(read.ok ? { read_path: read.value } : {}),
      attachment: ref,
    }
  }

  private async fetchFile(
    call: FetchCallContext,
    downloadId: string,
    resource: KnownAttachmentResource,
  ): Promise<AttachmentFetchResultItem> {
    const channel = call.channel
    if (channel === undefined) return failedItem(resource, failure('CHANNEL_UNAVAILABLE'))
    if (call.budget.maxBytes <= call.budget.usedBytes) {
      call.budget.exceeded = true
      return failedItem(resource, failure('BYTES_LIMIT'))
    }
    let stream: ResourceChunkStream
    try {
      stream = await cancellable(Promise.resolve(channel.downloadResource(downloadId, resource.fileKey, 'file')), call.signal)
    } catch (error) {
      return downloadFailureItem(resource, error, call)
    }
    const gated = budgetedChunks(stream, call.signal, call.budget)
    let saved: AttachmentResult<StoredFile>
    try {
      saved = await cancellable(call.native.saveFile({
        source: gated,
        signal: call.signal,
        ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
      }), call.signal)
    } catch (error) {
      if (call.budget.exceeded) return failedItem(resource, failure('BYTES_LIMIT'))
      return downloadFailureItem(resource, error, call)
    }
    if (!saved.ok) {
      if (call.budget.exceeded) return failedItem(resource, failure('BYTES_LIMIT'))
      if (call.signal.aborted) return cancelledItem(resource, call.timeout.value)
      return failedItem(resource, saved)
    }
    return {
      ok: true,
      kind: 'file',
      name: saved.value.ref.name,
      file_key: resource.fileKey,
      bytes: saved.value.ref.bytes,
      handle_text: saved.value.handleText,
      attachment: saved.value.ref,
    }
  }
}

/** Map one thrown download/store error into a structured item. */
function downloadFailureItem(
  resource: KnownAttachmentResource,
  error: unknown,
  call: FetchCallContext,
): AttachmentFetchResultItem {
  if (call.budget.exceeded) return failedItem(resource, failure('BYTES_LIMIT'))
  if (call.signal.aborted) return cancelledItem(resource, call.timeout.value)
  return failedItem(resource, failure(
    'DOWNLOAD_FAILED',
    `${attachmentFetchFailureReason('DOWNLOAD_FAILED')}：${describeFetchError(error)}`,
  ))
}

// ---- Download plumbing --------------------------------------------------

/**
 * Run one promise with cooperative cancellation: an aborted signal rejects the
 * wrapper immediately (the underlying operation is signalled too where the
 * host contract supports it). Late rejections are swallowed so a timed-out
 * tool call never produces an unhandled rejection.
 */
function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    task.catch(() => {})
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      task.catch(() => {})
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

/** Total budget for one tool call; also forwards caller/timeout cancellation. */
function createAbortScope(caller: AbortSignal, timeoutMs: number): {
  signal: AbortSignal
  timeout: { value: boolean }
  dispose(): void
} {
  const controller = new AbortController()
  const timeout = { value: false }
  const forward = (): void => { controller.abort() }
  if (caller.aborted) controller.abort()
  else caller.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => {
    timeout.value = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    timeout,
    dispose(): void {
      clearTimeout(timer)
      caller.removeEventListener('abort', forward)
      controller.abort()
    },
  }
}

class BudgetExceededError extends Error {
  override readonly name = 'AttachmentFetchBudgetExceeded'
}

class ImageTooLargeError extends Error {
  override readonly name = 'AttachmentFetchImageTooLarge'
}

/** Byte cap for one image: the host's own limit is authoritative. */
function imageByteCap(service: AttachmentStore | undefined): number {
  const max = service?.imageLimits?.maxImageBytes
  if (typeof max === 'number' && Number.isFinite(max) && max > 0) return max
  return FALLBACK_MAX_IMAGE_BYTES
}

/** Read one image into memory under both the image cap and the call budget. */
async function collectBoundedBytes(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  budget: DownloadBudget,
  limit: number,
  imageCap: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let ownBytes = 0
  for await (const chunk of source) {
    if (signal.aborted) throw abortError()
    ownBytes += chunk.byteLength
    budget.usedBytes += chunk.byteLength
    if (ownBytes > imageCap) throw new ImageTooLargeError()
    if (budget.usedBytes > budget.maxBytes || ownBytes > limit) throw new BudgetExceededError()
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(ownBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Files stream through the native library; the generator enforces the budget. */
async function* budgetedChunks(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  budget: DownloadBudget,
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await cancellable(iterator.next(), signal)
      if (next.done === true) return
      budget.usedBytes += next.value.byteLength
      if (budget.usedBytes > budget.maxBytes) {
        budget.exceeded = true
        throw new BudgetExceededError()
      }
      yield next.value
    }
  } finally {
    // Best-effort cleanup: a cancelled stream must not keep the underlying
    // Node stream open. Never awaited so a stalled source cannot hang the tool
    // call after the abort was already reported.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {})
    } catch {
      // A synchronous throw from a broken iterator is already moot here.
    }
  }
}

// ---- Item helpers -------------------------------------------------------

function failedItem(
  resource: KnownAttachmentResource,
  result: AttachmentFetchFailure,
): AttachmentFetchResultItem {
  return {
    ok: false,
    kind: resource.type,
    ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
    file_key: resource.fileKey,
    code: result.code,
    reason: result.reason,
  }
}

function cancelledItem(
  resource: KnownAttachmentResource,
  timedOut: boolean,
): AttachmentFetchResultItem {
  return failedItem(resource, failure(timedOut ? 'TIMEOUT' : 'ABORTED'))
}

function callFailure(messageId: string, result: AttachmentFetchFailure): AttachmentFetchValue {
  return {
    message_id: messageId,
    ok: false,
    summary: `${result.reason}（消息 ${displayText(messageId)}）`,
    results: [],
  }
}

/** Cap for one untrusted error/file-name description placed into a result. */
const MAX_DESCRIPTION_TEXT = 500

/**
 * Inline-safe, bounded text: control characters (newlines could forge extra
 * result lines) collapse to spaces and the length is bounded.
 */
function sanitizeInlineText(value: string, max = MAX_DESCRIPTION_TEXT): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…（已截断）`
}

function truncateDescription(text: string): string {
  return sanitizeInlineText(text)
}

/** Readable, bounded description for an unexpected (non-abort) throw. */
function describeUnexpectedError(error: unknown): string {
  return truncateDescription(describeThrownValue(error))
}

/**
 * Readable text for an arbitrary thrown value (never `[object Object]`).
 *
 * Plain-object rejects are common in the Feishu SDK (`{ code, msg }`). Only a
 * whitelist of descriptive fields is surfaced: serializing the whole object
 * could leak request headers or large bodies into the model-visible result.
 */
function describeThrownValue(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['code', 'status', 'statusCode', 'name', 'msg', 'message']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) parts.push(`${key}=${value}`)
      else if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key}=${value}`)
    }
    if (parts.length > 0) return parts.join(' ')
    return '未知错误（不可序列化的对象）'
  }
  return String(error)
}

/** Readable, bounded download/store error text (Feishu 400/403 mapped). */
function describeFetchError(error: unknown): string {
  const raw = describeThrownValue(error)
  return truncateDescription(describeFailure(new Error(raw)))
}

/**
 * One untrusted display name for the model-facing text: control characters
 * (newlines could forge extra result lines) collapse to spaces and the length
 * is bounded; the structured value keeps the original name.
 */
function displayText(value: string): string {
  return sanitizeInlineText(value, 200)
}

// ---- Raw message parsing (merged forward / message.get) -----------------

interface RawMessageItem {
  readonly messageId?: string
  readonly msgType?: string
  readonly content?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `im.v1.message.get` response → message items. Tolerates the SDK envelope
 * (`{ data: { items } }`) and an unwrapped `{ items }` for stubs.
 */
function rawMessageItems(response: unknown): RawMessageItem[] | undefined {
  const root = asRecord(response)
  const data = asRecord(root?.data) ?? root
  const items = data?.items
  if (!Array.isArray(items)) return undefined
  const parsed: RawMessageItem[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const body = asRecord(record.body)
    parsed.push({
      ...(stringField(record, 'message_id') === undefined ? {} : { messageId: stringField(record, 'message_id') }),
      ...(stringField(record, 'msg_type') === undefined ? {} : { msgType: stringField(record, 'msg_type') }),
      ...(body?.content === undefined ? {} : { content: body.content }),
    })
  }
  return parsed
}

/** Parse Feishu's JSON-string message body content. */
function parsedContent(content: unknown): Record<string, unknown> | undefined {
  if (typeof content === 'string') {
    try {
      return asRecord(JSON.parse(content))
    } catch {
      return undefined
    }
  }
  return asRecord(content)
}

/** Resources of one regular (non merged-forward) message. */
function messageResourcesOfItems(items: readonly RawMessageItem[]): KnownAttachmentResource[] {
  const resources: KnownAttachmentResource[] = []
  const seen = new Set<string>()
  for (const item of items) {
    for (const resource of resourcesOfItem(item)) {
      if (seen.has(resource.fileKey)) continue
      seen.add(resource.fileKey)
      resources.push(resource)
    }
  }
  return resources
}

/**
 * Resources of a merged-forward container: every returned item is a child (the
 * top-level container itself carries no resource), and their bytes are fetched
 * through the container's own message id (P0 rule).
 */
function mergedForwardResources(items: readonly RawMessageItem[]): KnownAttachmentResource[] {
  const resources: KnownAttachmentResource[] = []
  const seen = new Set<string>()
  for (const item of items) {
    for (const resource of resourcesOfItem(item)) {
      if (seen.has(resource.fileKey)) continue
      seen.add(resource.fileKey)
      resources.push(resource)
    }
  }
  return resources
}

/** Extract downloadable resources from one raw message item. */
function resourcesOfItem(item: RawMessageItem): KnownAttachmentResource[] {
  const content = parsedContent(item.content)
  if (content === undefined) return []
  switch (item.msgType) {
    case 'image': {
      const fileKey = stringField(content, 'image_key')
      return fileKey === undefined ? [] : [{ type: 'image', fileKey }]
    }
    case 'file': {
      const fileKey = stringField(content, 'file_key')
      if (fileKey === undefined) return []
      const fileName = stringField(content, 'file_name')
      return [{ type: 'file', fileKey, ...(fileName === undefined ? {} : { fileName }) }]
    }
    case 'post': {
      return postResources(content)
    }
    case 'folder': {
      const fileKey = stringField(content, 'file_key')
      if (fileKey === undefined) return []
      const fileName = stringField(content, 'file_name')
      return [{
        type: 'file',
        fileKey,
        folder: true,
        ...(fileName === undefined ? {} : { fileName }),
      }]
    }
    default:
      return []
  }
}

/** Locale keys Feishu uses to wrap a localized post body. */
const POST_LOCALES: ReadonlySet<string> = new Set([
  'zh_cn', 'zh_hk', 'zh_tw', 'en_us', 'ja_jp', 'ko_kr', 'de_de', 'fr_fr',
  'es_es', 'pt_br', 'ru_ru', 'th_th', 'vi_vn', 'id_id', 'it_it', 'ms_my',
])

/**
 * Resources embedded in a rich-text (`post`) body.
 *
 * Feishu serializes a post as `{ title, content, files }`, optionally wrapped
 * in one or more known locales (`{ zh_cn: { content, files }, ... }`). The
 * `content` rows carry inline `img`/`file`/`media` elements while attached
 * files live in the body's top-level `files[]` array that the SDK's post
 * converter drops — the same gap `postAttachedFiles` recovers on the inbound
 * path.
 *
 * Only the standard body shape is inspected: arbitrary nested `files`/`tag`
 * fields elsewhere in the body are NOT adopted, so the tool never treats
 * unrelated metadata as an attachment of an authorized message.
 */
function postResources(content: Record<string, unknown>): KnownAttachmentResource[] {
  const resources: KnownAttachmentResource[] = []
  const byKey = new Map<string, KnownAttachmentResource>()
  const push = (resource: KnownAttachmentResource): void => {
    const existing = byKey.get(resource.fileKey)
    if (existing === undefined) {
      byKey.set(resource.fileKey, resource)
      resources.push(resource)
      return
    }
    // A folder marker from `files[]` must survive an inline duplicate.
    if (existing.folder !== true && resource.folder === true) {
      const index = resources.indexOf(existing)
      if (index !== -1) resources[index] = { ...existing, folder: true }
    }
  }
  for (const body of postBodies(content)) {
    const rows = body.content
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        for (const rawElement of row) {
          const element = asRecord(rawElement)
          if (element === undefined) continue
          const tag = stringField(element, 'tag')
          if (tag === 'img') {
            const fileKey = stringField(element, 'image_key')
            if (fileKey !== undefined) push({ type: 'image', fileKey })
            continue
          }
          if (tag === 'file' || tag === 'media') {
            const fileKey = stringField(element, 'file_key')
            if (fileKey === undefined) continue
            const fileName = stringField(element, 'file_name')
            push({
              type: 'file',
              fileKey,
              ...(fileName === undefined ? {} : { fileName }),
              ...(element.is_folder === true ? { folder: true } : {}),
            })
          }
        }
      }
    }
    const files = body.files
    if (Array.isArray(files)) {
      for (const rawFile of files) {
        const file = asRecord(rawFile)
        if (file === undefined) continue
        const fileKey = stringField(file, 'file_key')
        if (fileKey === undefined) continue
        const fileName = stringField(file, 'file_name')
        push({
          type: 'file',
          fileKey,
          ...(fileName === undefined ? {} : { fileName }),
          ...(file.is_folder === true ? { folder: true } : {}),
        })
      }
    }
  }
  return resources
}

/** The standard post body record(s): the direct shape plus known locale wrappers. */
function postBodies(content: Record<string, unknown>): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  if (isPostBody(content)) bodies.push(content)
  for (const [key, value] of Object.entries(content)) {
    if (!POST_LOCALES.has(key)) continue
    const body = asRecord(value)
    if (body !== undefined && isPostBody(body)) bodies.push(body)
  }
  return bodies
}

function isPostBody(record: Record<string, unknown>): boolean {
  return Array.isArray(record.content) || Array.isArray(record.files)
}

/** Pending registry record → known message (authorization snapshot). */
function knownMessageOfPending(record: PendingAttachmentRecord): KnownAttachmentMessage {
  return {
    messageId: record.messageId,
    kind: record.kind === 'merge_forward' ? 'merge_forward' : 'message',
    senderOpenId: record.senderOpenId,
    resources: record.resources.map((resource: PendingAttachmentResource): KnownAttachmentResource => ({
      type: resource.type,
      fileKey: resource.fileKey,
      ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
      ...(resource.folder === true ? { folder: true } : {}),
      ...(resource.containerMessageId === undefined ? {} : { containerMessageId: resource.containerMessageId }),
    })),
  }
}

/**
 * Wait for one cordis injection to settle, but never longer than `timeoutMs`:
 * a hard dependency on a service a deployment does not mount would otherwise
 * block agent creation forever.
 */
function waitForAvailability(
  task: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<'ready' | 'failed' | 'timeout'> {
  return new Promise<'ready' | 'failed' | 'timeout'>((resolve) => {
    let settled = false
    const finish = (outcome: 'ready' | 'failed' | 'timeout'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    timer.unref?.()
    Promise.resolve(task).then(
      () => finish('ready'),
      () => finish('failed'),
    )
  })
}

// ---- Rendering / presentation -------------------------------------------

function resourceLabel(item: AttachmentFetchResultItem): string {
  if (item.name !== undefined && item.name !== '') return displayText(item.name)
  if (item.file_key !== undefined) return displayText(item.file_key)
  return item.kind === 'image' ? '图片' : '文件'
}

function imageMetadataLine(item: AttachmentFetchResultItem): string {
  const parts: string[] = []
  if (item.bytes !== undefined) parts.push(`${item.bytes} 字节`)
  if (item.width !== undefined && item.height !== undefined) parts.push(`${item.width}×${item.height}`)
  if (item.media_type !== undefined) parts.push(item.media_type)
  const metadata = parts.length === 0 ? '' : `（${parts.join('，')}）`
  const path = item.read_path === undefined ? '' : `；只读路径：${item.read_path}`
  return `- 图片 ${resourceLabel(item)} 已获取${metadata}${path}`
}

function resultTextLine(item: AttachmentFetchResultItem): string {
  if (item.ok) {
    if (item.kind === 'image') return imageMetadataLine(item)
    const handle = item.handle_text === undefined ? '' : ` ${item.handle_text}`
    return `- 文件 ${resourceLabel(item)}（${item.bytes ?? 0} 字节）已保存为只读副本。${handle}`.trimEnd()
  }
  return `- ${resourceLabel(item)} 获取失败（${item.reason ?? attachmentFetchFailureReason(item.code ?? 'DOWNLOAD_FAILED')}）`
}

/**
 * Turn one tool result into model content: a text block (summary, per-resource
 * metadata, file handle fallback) plus one image/file block per fetched
 * resource. The text path is always present so a host that cannot deliver file
 * blocks (or a text-only model) still gets a usable answer.
 */
export function renderAttachmentFetchResult(value: unknown): readonly ToolContentBlock[] {
  const result = (typeof value === 'object' && value !== null ? value : {}) as Partial<AttachmentFetchValue>
  const items = (Array.isArray(result.results) ? result.results : []).filter(
    (item): item is AttachmentFetchResultItem => typeof item === 'object' && item !== null,
  )
  const summary = typeof result.summary === 'string' ? result.summary : ATTACHMENT_FETCH_TOOL_NAME
  const lines = [summary]
  for (const item of items) lines.push(resultTextLine(item))
  if (items.some(item => item.ok && item.kind === 'image')) {
    lines.push('若当前模型无法查看图片，请依据上面的元数据向用户说明，并请用户描述图片内容。')
  }
  const blocks: ToolContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const item of items) {
    if (!item.ok || item.attachment === undefined) continue
    if (item.kind === 'image') blocks.push({ type: 'image', attachment: item.attachment })
    else blocks.push({ type: 'file', attachment: item.attachment })
  }
  return blocks
}

/** Host-local card call projection: "fetch attachment of message X". */
export function presentAttachmentFetchCall(args: Record<string, unknown>): string {
  const messageId = typeof args.message_id === 'string' ? args.message_id : ''
  const fileKey = typeof args.file_key === 'string' ? args.file_key : undefined
  return fileKey === undefined
    ? `获取飞书附件 ${messageId}`
    : `获取飞书附件 ${messageId}（${fileKey}）`
}

/** Host-local card result projection: the one-line outcome. */
export function presentAttachmentFetchResult(value: unknown): string {
  const result = (typeof value === 'object' && value !== null ? value : {}) as Partial<AttachmentFetchValue>
  return typeof result.summary === 'string' ? result.summary : ATTACHMENT_FETCH_TOOL_NAME
}

// ---- Exposed helper for the image-cap resolution ------------------------

/**
 * Resolve the live image byte cap of one Agent scope (the service may unmount
 * between registration and execution; a missing service keeps the fallback cap
 * so the caller can still report a structured "unmounted" failure).
 */
function imageByteCapOf(agentCtx: AgentContext): number {
  return imageByteCap(resolveAttachmentService(agentCtx))
}

// ---- Topic messages tool ------------------------------------------------

/** Model-facing tool name; stable across releases (session history references it). */
export const TOPIC_MESSAGES_TOOL_NAME = 'feishu_topic_messages'

/**
 * Model-facing description of {@link TOPIC_MESSAGES_TOOL_NAME}: the vocabulary
 * the model needs to choose between one quoted-message read and paging through
 * the discussion that precedes the @.
 */
const TOPIC_MESSAGES_DESCRIPTION =
  'Read messages of the CURRENT Feishu conversation: the topic/thread history, or the chat main timeline on '
  + 'a degraded (non-topic) route. Pass message_id to read one message (a quoted message, or a merged-forward '
  + 'message which is expanded into its child messages); omit message_id to list the most recent messages '
  + 'newest-first and page with limit/cursor. Every message carries its message_id (usable with '
  + 'feishu_attachment_fetch), text, time, sender and attachment metadata. Only messages of this conversation '
  + 'are readable: a message id from another chat/topic, or one this session never admitted, is refused. '
  + 'Reading a message also authorizes its images/files for feishu_attachment_fetch. Output is bounded; use '
  + 'limit (default 10, maximum 50) and cursor to continue. Merged-forward child message ids are NOT '
  + 'downloadable; fetch their attachments with the top-level container message_id shown for the container row.'

/** Extra model guidance appended when this deployment cannot fetch attachments (archive backend). */
const TOPIC_MESSAGES_FETCH_UNAVAILABLE_DESCRIPTION =
  ' In this deployment feishu_attachment_fetch is unavailable; report attachment metadata to the user '
  + 'instead of fetching.'

/**
 * Runtime argument validation of `feishu_topic_messages`.
 *
 * The host projects {@link TOPIC_MESSAGES_PARAMETERS} to the model but does not
 * re-validate arguments (the same finding as the attachment tool), so this zod
 * schema is the authoritative argument gate. `message_id` is shape-checked
 * (Feishu ids are `om_` + URL-safe characters; no path/query injection reaches
 * the read API), and `message_id` (single read) / `cursor` (list paging) are
 * mutually exclusive; the execute path rejects that combination with a readable
 * Chinese error rather than a schema message.
 */
export const topicMessagesArgsSchema = z.object({
  message_id: z.string().min(1).max(160).regex(/^om_[A-Za-z0-9_-]{1,128}$/).optional(),
  limit: z.number().int().min(1).max(TOPIC_MESSAGES_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict()

export type TopicMessagesArgs = z.infer<typeof topicMessagesArgsSchema>

/** Model-facing parameter schema (hand-written; no DSH runtime import). */
export const TOPIC_MESSAGES_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      pattern: '^om_[A-Za-z0-9_-]{1,128}$',
      description:
        'Feishu message id (om_...) of one message to read. Omit to list the current topic/chat history instead.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: TOPIC_MESSAGES_MAX_LIMIT,
      default: TOPIC_MESSAGES_DEFAULT_LIMIT,
      description:
        'Page size when listing history, default 10 and maximum 50. Ignored in message_id mode.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      description:
        'Opaque page token from a previous result (its cursor field) used to continue an older page. '
        + 'Only for list mode; never combine it with message_id.',
    },
  },
}

// ---- Topic messages results ---------------------------------------------

/** Stable failure codes of `feishu_topic_messages` (one readable reason each). */
export type TopicMessagesFailureCode =
  | 'ROUTE_NOT_FOUND'
  | 'TOOL_DISABLED'
  | 'INVALID_ARGUMENT'
  | 'MESSAGE_OUT_OF_ROUTE'
  | 'MESSAGE_READ_FAILED'
  | 'PERMISSION_DENIED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'

const TOPIC_MESSAGES_FAILURE_REASONS: Readonly<Record<TopicMessagesFailureCode, string>> = {
  ROUTE_NOT_FOUND: '当前会话尚未绑定飞书话题或聊天，无法读取消息',
  TOOL_DISABLED: '话题消息读取工具已禁用',
  INVALID_ARGUMENT: '读取消息的参数不合法',
  MESSAGE_OUT_OF_ROUTE:
    '该消息不在当前会话的飞书话题/聊天范围内（仅可读取当前话题的消息或本会话已登记的消息）',
  MESSAGE_READ_FAILED: '读取飞书消息失败',
  PERMISSION_DENIED: '飞书应用缺少读取消息的权限（如 im:message:readonly），无法读取引用或话题消息',
  ABORTED: '读取飞书消息已取消',
  TIMEOUT: '读取飞书消息超时',
  INTERNAL_ERROR: '读取话题消息失败',
}

/** `single` for one message_id read, `newest_first` for a history page. */
export type TopicMessagesOrder = 'newest_first' | 'single'

/** The container the result belongs to (the current route's read scope). */
export interface TopicMessagesContainer {
  readonly type: 'thread' | 'chat'
  readonly id: string
}

/**
 * Result value of `feishu_topic_messages`. Lossless JSON by construction:
 * optional keys are omitted instead of set to `undefined`.
 */
export interface TopicMessagesValue {
  readonly ok: boolean
  readonly summary: string
  readonly container: TopicMessagesContainer
  readonly order: TopicMessagesOrder
  readonly message_count: number
  readonly has_more: boolean
  /** Opaque page token of the next older page (`has_more` pages only). */
  readonly cursor?: string
  readonly messages: readonly TopicMessageView[]
  readonly code?: TopicMessagesFailureCode
  readonly reason?: string
}

/** Model-facing output schema; mirrors {@link TopicMessagesValue}. */
export const TOPIC_MESSAGES_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary', 'container', 'order', 'message_count', 'has_more', 'messages'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    container: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: ['thread', 'chat'] },
        id: { type: 'string' },
      },
    },
    order: { type: 'string', enum: ['newest_first', 'single'] },
    message_count: { type: 'number' },
    has_more: { type: 'boolean' },
    cursor: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message_id', 'type', 'sender', 'text'],
        properties: {
          message_id: { type: 'string' },
          type: { type: 'string' },
          sender: { type: 'string', enum: ['user', 'bot', 'system'] },
          time: { type: 'string' },
          deleted: { type: 'boolean' },
          text: { type: 'string' },
          parent_message_id: { type: 'string' },
          resources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'file_key'],
              properties: {
                type: { type: 'string', enum: ['image', 'file'] },
                file_key: { type: 'string' },
                name: { type: 'string' },
                folder: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    code: { type: 'string' },
    reason: { type: 'string' },
  },
}

// ---- Topic messages runtime deps ----------------------------------------

/**
 * Everything the topic-messages tool runtime needs, injected by the service.
 *
 * `noteKnownMessage` / `isKnownMessage` MUST be the attachment-fetch runtime's
 * methods: both tools share one per-route whitelist, so a message discovered
 * here can immediately be fetched by `feishu_attachment_fetch` (AC5), and a
 * main-timeline message the fetch/quote layers already admitted stays readable
 * from a topic route.
 */
export interface TopicMessagesRuntimeDeps {
  /** Live plugin configuration (switch, timeout). */
  config(): FeishuConfig
  /** Live Feishu channel; undefined while disconnected/shut down. */
  channel(): FeishuChannel | undefined
  /** Resolve the route currently bound to one session. */
  routeOfSession(sessionId: string): AttachmentFetchRoute | undefined
  /** Register one discovered message's resources for the shared fetch whitelist. */
  noteKnownMessage(
    route: AttachmentFetchRoute,
    message: KnownAttachmentMessageInput,
    source: KnownAttachmentSource,
  ): void
  /** Whether one message id is already authorized for the route (whitelist/pending). */
  isKnownMessage(route: AttachmentFetchRoute, messageId: string): boolean
  /**
   * Whether `feishu_attachment_fetch` is usable in this deployment (native
   * backend + tool enabled). `false` makes the tool description tell the model
   * to report attachment metadata instead of fetching. Absent = available.
   */
  fetchAvailable?(): boolean
  /** Structured warning sink (mount degradation, unexpected failures). */
  warn(message: string, ...args: unknown[]): void
}

type TopicReadOutcome =
  | { readonly ok: true; readonly value: TopicMessagesValue }
  | { readonly ok: false; readonly code: TopicMessagesFailureCode; readonly reason: string }

/**
 * The `feishu_topic_messages` runtime: mounts the tool into Agent scopes and
 * executes message reads against the session's current route.
 *
 * It deliberately owns no per-route state: the authorization whitelist lives in
 * the attachment-fetch runtime (shared through {@link TopicMessagesRuntimeDeps}),
 * so this runtime only needs its mount bookkeeping.
 */
export class TopicMessagesToolRuntime {
  /** Agent scope → its one mount attempt (cordis callbacks get distinct ctx objects). */
  private readonly mountAttempts = new WeakMap<AgentContext, Promise<void>>()
  private warnedMissingTools = false
  private warnedMountFailure = false
  private warnedUnavailable = false

  constructor(private readonly deps: TopicMessagesRuntimeDeps) {}

  /** Whether the feature switch currently allows tool registration/execution. */
  enabled(): boolean {
    return this.deps.config().feishuTools.topicMessages
  }

  /**
   * Register the tool inside one Agent scope. Mirrors the attachment tool's
   * mount: `inject(['tools'])` is the P0-proven path, missing services are a
   * no-op with one readable warning, and a slow host never blocks session
   * creation (bounded 2 s wait, the pending injection can still backfill).
   */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    if (!this.enabled()) return
    // Cordis hands the inject callback a DIFFERENT context object than the
    // agent ctx, so dedupe on the outer scope and reuse its single attempt.
    const existing = this.mountAttempts.get(agentCtx)
    if (existing !== undefined) return await existing
    const attempt = this.mountAttempt(agentCtx, sessionId)
    this.mountAttempts.set(agentCtx, attempt)
    await attempt
  }

  /** No process-local state to drop; kept for symmetry with the fetch runtime. */
  clear(): void {
    // Intentionally empty: this runtime registers a tool per Agent scope only.
  }

  private async mountAttempt(agentCtx: AgentContext, sessionId: string): Promise<void> {
    let injected = false
    const outcome = await waitForAvailability(
      Promise.resolve(agentCtx.inject(['tools'], (ctx) => {
        injected = true
        this.registerInScope(ctx, sessionId)
      })),
      // A deployment that already timed out once is unlikely to gain the
      // services a moment later: fail fast on later sessions while the pending
      // injection can still backfill registration if they do appear.
      this.warnedUnavailable ? MOUNT_INJECT_RETRY_WAIT_MS : MOUNT_INJECT_WAIT_MS,
    )
    if (outcome === 'failed') {
      this.warnMountFailure(`dsh-channels: mounting ${TOPIC_MESSAGES_TOOL_NAME} failed`)
      return
    }
    // Real cordis settles an injection whose dependencies never appear WITHOUT
    // calling the callback; treat "settled but never injected" as unavailable.
    // The fiber stays pending so a late service still backfills registration.
    if (!injected && !this.warnedUnavailable) {
      this.warnedUnavailable = true
      this.deps.warn(
        'dsh-channels: %s 未挂载：宿主 tools 服务不可用（会话继续）',
        TOPIC_MESSAGES_TOOL_NAME,
      )
    }
  }

  private registerInScope(agentCtx: AgentContext, sessionId: string): void {
    // No per-callback-context dedupe: when a host service unloads/reloads,
    // cordis disposes the injection fiber's effects (including our
    // `tools.register`) and invokes this callback again with the same ctx
    // object. Skipping the re-registration would silently lose the tool.
    const tools = agentCtx.tools
    if (tools === undefined || typeof tools.register !== 'function') {
      if (!this.warnedMissingTools) {
        this.warnedMissingTools = true
        this.deps.warn(
          'dsh-channels: %s 未注册：宿主 tools 服务不可用（话题消息工具已禁用）',
          TOPIC_MESSAGES_TOOL_NAME,
        )
      }
      return
    }
    try {
      tools.register(this.definitionFor(sessionId))
    } catch (error) {
      this.warnMountFailure(
        `dsh-channels: registering ${TOPIC_MESSAGES_TOOL_NAME} failed: ${describeFetchError(error)}`,
      )
    }
  }

  private warnMountFailure(message: string): void {
    if (this.warnedMountFailure) return
    this.warnedMountFailure = true
    this.deps.warn(message)
  }

  private definitionFor(sessionId: string): ToolDefinition {
    return {
      name: TOPIC_MESSAGES_TOOL_NAME,
      description: TOPIC_MESSAGES_DESCRIPTION
        + (this.isFetchUnavailable() ? TOPIC_MESSAGES_FETCH_UNAVAILABLE_DESCRIPTION : ''),
      parameters: TOPIC_MESSAGES_PARAMETERS,
      output: {
        schema: TOPIC_MESSAGES_OUTPUT_SCHEMA,
        render: (_args, value) => renderTopicMessagesResult(value),
      },
      execute: async (rawArgs, exec) => await this.execute(sessionId, rawArgs, exec),
      presentCall: args => presentTopicMessagesCall(args),
      presentResult: (_args, value) => presentTopicMessagesResult(value),
      isConcurrencySafe: () => true,
    }
  }

  /**
   * Whether the deployment cannot fetch attachments (archive backend / fetch
   * tool disabled). A probe failure keeps the model guidance unchanged (the
   * tool still works; a fetch attempt returns its own readable failure).
   */
  private isFetchUnavailable(): boolean {
    try {
      return this.deps.fetchAvailable?.() === false
    } catch {
      return false
    }
  }

  // ---- Execution --------------------------------------------------------

  private async execute(
    sessionId: string,
    rawArgs: Record<string, unknown>,
    exec: ToolExecution,
  ): Promise<TopicMessagesValue> {
    const parsed = topicMessagesArgsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      // A thrown, readable error is the correct shape for invalid arguments:
      // the host turns it into a failed tool call with a text message (never a
      // raw object rendered as `[object Object]`).
      const issue = parsed.error.issues[0]
      const path = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.')
      throw new Error(
        `${TOPIC_MESSAGES_TOOL_NAME}: invalid ${path}: ${issue?.message ?? 'invalid arguments'}`,
      )
    }
    const args = parsed.data
    if (args.message_id !== undefined && args.cursor !== undefined) {
      throw new Error(
        `${TOPIC_MESSAGES_TOOL_NAME}: invalid arguments: message_id 与 cursor 不能同时使用`
        + '（message_id 是单条读取，cursor 只用于列表翻页）',
      )
    }
    if (!this.enabled()) return topicFailureValue(args, undefined, 'TOOL_DISABLED')

    // The route is re-read on every execution: a session can be re-bound (chat
    // route replaced by a topic route) between the mount and a later call.
    const route = this.deps.routeOfSession(sessionId)
    if (route === undefined) return topicFailureValue(args, undefined, 'ROUTE_NOT_FOUND')

    const config = this.deps.config().feishuTools
    const reader = new MessageReader({ channel: () => this.deps.channel() })
    try {
      const outcome = args.message_id === undefined
        ? await this.listMessages(reader, route, args, exec, config.topicMessagesTimeoutMs)
        : await this.readMessageById(reader, route, args.message_id, exec, config.topicMessagesTimeoutMs)
      if (outcome.ok) return outcome.value
      return topicFailureValue(args, route, outcome.code, outcome.reason)
    } catch (error) {
      if (exec.signal.aborted) return topicFailureValue(args, route, 'ABORTED')
      const detail = describeReadError(error)
      this.deps.warn(
        'dsh-channels: %s failed unexpectedly: %s',
        TOPIC_MESSAGES_TOOL_NAME,
        detail,
      )
      return topicFailureValue(
        args,
        route,
        'INTERNAL_ERROR',
        `${TOPIC_MESSAGES_FAILURE_REASONS.INTERNAL_ERROR}：${detail}`,
      )
    }
  }

  /** `message.list` mode: newest-first page of the current route's container. */
  private async listMessages(
    reader: MessageReader,
    route: AttachmentFetchRoute,
    args: TopicMessagesArgs,
    exec: ToolExecution,
    timeoutMs: number,
  ): Promise<TopicReadOutcome> {
    const limit = args.limit ?? TOPIC_MESSAGES_DEFAULT_LIMIT
    const listed = await reader.listRoute(route, {
      pageSize: limit,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      order: 'newest-first',
      signal: exec.signal,
      timeoutMs,
    })
    if (!listed.ok) {
      return { ok: false, code: topicFailureCodeOf(listed.code), reason: listed.reason }
    }
    const page = listed.value
    const messages: TopicMessageView[] = []
    for (const item of page.items) {
      messages.push(topicMessageViewOf(item))
      // Registering every row of a long history would churn the shared LRU
      // whitelist (a couple of 50-row pages evict the trigger/quote attachments
      // that ARE fetchable). Plain-text rows carry no downloadable resource, so
      // only attachment rows and merged-forward containers are noted.
      if (item.resources.length === 0 && item.msgType !== 'merge_forward') continue
      const known = knownMessageOfItems([item])
      if (known !== undefined) this.noteKnown(route, known)
    }
    const container = topicContainerOf(route)
    const label = topicContainerLabel(container.type)
    const more = page.hasMore ? '，还有更多（用 cursor 翻页）' : ''
    const summary = messages.length === 0
      ? `没有可读取的消息（${label} ${displayText(container.id)}）`
      : `已读取 ${messages.length} 条消息${more}（${label} ${displayText(container.id)}，按时间倒序）`
    return {
      ok: true,
      value: {
        ok: true,
        summary,
        container,
        order: 'newest_first',
        message_count: messages.length,
        has_more: page.hasMore,
        ...(page.pageToken === undefined ? {} : { cursor: page.pageToken }),
        messages,
      },
    }
  }

  /** `message.get` mode: one message, a merged-forward container expanded. */
  private async readMessageById(
    reader: MessageReader,
    route: AttachmentFetchRoute,
    messageId: string,
    exec: ToolExecution,
    timeoutMs: number,
  ): Promise<TopicReadOutcome> {
    const read = await reader.readMessage(messageId, { signal: exec.signal, timeoutMs })
    if (!read.ok) {
      return { ok: false, code: topicFailureCodeOf(read.code), reason: read.reason }
    }
    const items = read.value
    // The container is NOT necessarily the first item: a merged-forward
    // `message.get` returns a flat list whose children carry `upper_message_id`,
    // so the shared resolver picks the top-level item independent of order.
    const container = quoteItemsOf(items)
    if (container === undefined) {
      return {
        ok: false,
        code: 'MESSAGE_READ_FAILED',
        reason: `飞书未返回该消息（${displayText(messageId)}），可能已被撤回或无权访问`,
      }
    }
    // Route membership is enforced on the container: another chat, another
    // topic of the same group, or an unregistered main-timeline message is
    // refused. A message already admitted to this route (trigger/quote/pending)
    // may be read even without a topic id (quotes happen before the topic).
    const known = this.deps.isKnownMessage(route, messageId)
    if (!messageBelongsToRoute(route, container, known ? [messageId] : [])) {
      return {
        ok: false,
        code: 'MESSAGE_OUT_OF_ROUTE',
        reason: TOPIC_MESSAGES_FAILURE_REASONS.MESSAGE_OUT_OF_ROUTE,
      }
    }
    // The read succeeded: register the container (merged-forward resources are
    // downloadable only through the top-level container id) so the fetch tool
    // can serve them without a second discovery round-trip.
    const knownMessage = knownMessageOfItems(items)
    if (knownMessage !== undefined) this.noteKnown(route, knownMessage)

    // Container first, then its children in the order Feishu returned them.
    // The value is bounded by the same cap as rendering: one huge merged
    // forward must not flood the tool result/session history.
    const children = items.filter(item => item !== container)
    const ordered = [container, ...children]
    const shown = ordered.slice(0, TOPIC_MESSAGES_RENDER_MAX_MESSAGES)
    const hidden = ordered.length - shown.length
    const messages = shown.map(item => topicMessageViewOf(item))
    const resourceCount = ordered.reduce((total, item) => total + item.resources.length, 0)
    const containerInfo = topicContainerOf(route)
    const label = topicContainerLabel(containerInfo.type)
    const childCount = container.msgType === 'merge_forward' ? children.length : 0
    const mergeNote = container.msgType === 'merge_forward'
      ? `（合并转发，已展开 ${childCount} 条子消息）`
      : ''
    const resourceNote = resourceCount > 0 ? `，含 ${resourceCount} 个附件` : ''
    const hiddenNote = hidden > 0 ? `（另有 ${hidden} 条消息未展示）` : ''
    return {
      ok: true,
      value: {
        ok: true,
        summary: `已读取消息 ${displayText(container.messageId)}${mergeNote}${resourceNote}${hiddenNote}`
          + `（${label} ${displayText(containerInfo.id)}）`,
        container: containerInfo,
        order: 'single',
        message_count: messages.length,
        has_more: false,
        messages,
      },
    }
  }

  /**
   * Record one discovered message in the shared fetch whitelist. Bookkeeping
   * failures are warnings only: the model already has the read result and the
   * turn must not fail because the whitelist is momentarily unavailable.
   */
  private noteKnown(route: AttachmentFetchRoute, message: KnownAttachmentMessageInput): void {
    try {
      this.deps.noteKnownMessage(route, message, 'tool-result')
    } catch (error) {
      this.deps.warn(
        'dsh-channels: %s failed to register a known message: %s',
        TOPIC_MESSAGES_TOOL_NAME,
        describeReadError(error),
      )
    }
  }
}

/** The route's read container: the thread id for a topic, the chat id otherwise. */
function topicContainerOf(route: AttachmentFetchRoute | undefined): TopicMessagesContainer {
  if (route === undefined) {
    // No route means no read scope; the empty id keeps the value shape uniform
    // for replay/rendering without inventing an authorization fact.
    return { type: 'chat', id: '' }
  }
  return route.kind === 'thread'
    ? { type: 'thread', id: route.key }
    : { type: 'chat', id: route.chatId }
}

function topicContainerLabel(type: TopicMessagesContainer['type']): string {
  return type === 'thread' ? '话题' : '聊天'
}

/** Map one `message-read` failure code into the tool's stable code set. */
function topicFailureCodeOf(code: MessageReadFailureCode): TopicMessagesFailureCode {
  switch (code) {
    case 'PERMISSION_DENIED':
      return 'PERMISSION_DENIED'
    case 'INVALID_ARGUMENT':
      return 'INVALID_ARGUMENT'
    case 'ABORTED':
      return 'ABORTED'
    case 'TIMEOUT':
      return 'TIMEOUT'
    case 'CHANNEL_UNAVAILABLE':
    case 'MESSAGE_READ_FAILED':
    default:
      return 'MESSAGE_READ_FAILED'
  }
}

/** One structured failure value (never thrown as a business error). */
function topicFailureValue(
  args: TopicMessagesArgs | undefined,
  route: AttachmentFetchRoute | undefined,
  code: TopicMessagesFailureCode,
  reasonOverride?: string,
): TopicMessagesValue {
  const reason = reasonOverride ?? TOPIC_MESSAGES_FAILURE_REASONS[code]
  const container = topicContainerOf(route)
  const where = container.id === ''
    ? ''
    : `（${topicContainerLabel(container.type)} ${displayText(container.id)}）`
  return {
    ok: false,
    summary: `${reason}${where}`,
    container,
    order: args?.message_id === undefined ? 'newest_first' : 'single',
    message_count: 0,
    has_more: false,
    messages: [],
    code,
    reason,
  }
}

// ---- Topic messages rendering -------------------------------------------

/** Rendered message lines are bounded (whole-block character guard below). */
const TOPIC_MESSAGES_RENDER_MAX_MESSAGES = TOPIC_MESSAGES_MAX_LIMIT
const TOPIC_MESSAGES_RENDER_MAX_CHARS = 12_000

/** One model-facing line for a message view (id first so it is fetchable). */
function topicMessageLine(view: TopicMessageView): string {
  const messageId = typeof view.message_id === 'string' ? displayText(view.message_id) : ''
  const sender = view.sender === 'bot' ? '机器人' : view.sender === 'system' ? '系统' : '用户'
  const time = typeof view.time === 'string' && view.time !== '' ? `[${view.time}] ` : ''
  const text = typeof view.text === 'string' ? view.text : ''
  const resources = Array.isArray(view.resources) ? view.resources : []
  const idPart = messageId === '' ? '' : `${messageId} `
  return `- ${idPart}${time}${sender}: ${text}${topicResourcesSuffix(resources)}`
}

/** Compact attachment suffix of one rendered line (mirrors the prompt blocks). */
function topicResourcesSuffix(resources: readonly TopicMessageResourceView[]): string {
  if (resources.length === 0) return ''
  const images = resources.filter(resource => resource.type === 'image').length
  const files = resources.filter(resource => resource.type === 'file')
  const parts: string[] = []
  if (images > 0) parts.push(`图片×${images}`)
  if (files.length > 0) {
    const named = files
      .filter(resource => typeof resource.name === 'string' && resource.name !== '')
      .slice(0, 2)
      .map(resource => `"${displayText(resource.name ?? '')}"`)
    parts.push(named.length === 0 ? `文件×${files.length}` : `文件 ${named.join('、')}`)
  }
  return `（附件：${parts.join('；')}）`
}

/**
 * Turn one tool result into model content: the summary plus one bounded line
 * per message. Rendering never throws on a replayed/malformed value (session
 * history projection) and the whole text block is length-bounded.
 */
export function renderTopicMessagesResult(value: unknown): readonly ToolContentBlock[] {
  const result = (typeof value === 'object' && value !== null ? value : {}) as Partial<TopicMessagesValue>
  const summary = typeof result.summary === 'string' && result.summary !== ''
    ? result.summary
    : TOPIC_MESSAGES_TOOL_NAME
  const lines: string[] = [summary]
  if (typeof result.code === 'string') lines.push(`错误码：${result.code}`)
  if (typeof result.reason === 'string' && result.reason !== '' && result.reason !== summary) {
    lines.push(`原因：${result.reason}`)
  }
  const messages = (Array.isArray(result.messages) ? result.messages : [])
    .filter((message): message is TopicMessageView => typeof message === 'object' && message !== null)
  let used = lines.join('\n').length
  let shown = 0
  for (const view of messages) {
    if (shown >= TOPIC_MESSAGES_RENDER_MAX_MESSAGES) break
    const line = topicMessageLine(view)
    // Keep room for the truncation marker so the whole block stays bounded.
    if (used + line.length + 1 > TOPIC_MESSAGES_RENDER_MAX_CHARS - 120) break
    lines.push(line)
    used += line.length + 1
    shown += 1
  }
  const hidden = messages.length - shown
  if (hidden > 0) {
    lines.push(`- …（其余 ${hidden} 条消息未展示；可用 message_id 或 limit/cursor 继续读取）`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Host-local card call projection: "read one message" / "list recent messages". */
export function presentTopicMessagesCall(args: Record<string, unknown>): string {
  const messageId = typeof args.message_id === 'string' && args.message_id !== ''
    ? args.message_id
    : undefined
  if (messageId !== undefined) return `读取飞书消息 ${displayText(messageId)}`
  const rawLimit = args.limit
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? clampInt(rawLimit, 1, TOPIC_MESSAGES_MAX_LIMIT)
    : TOPIC_MESSAGES_DEFAULT_LIMIT
  return typeof args.cursor === 'string' && args.cursor !== ''
    ? `读取飞书话题消息（最近 ${limit} 条，翻页）`
    : `读取飞书话题消息（最近 ${limit} 条）`
}

/** Host-local card result projection: the one-line outcome. */
export function presentTopicMessagesResult(value: unknown): string {
  const result = (typeof value === 'object' && value !== null ? value : {}) as Partial<TopicMessagesValue>
  return typeof result.summary === 'string' ? result.summary : TOPIC_MESSAGES_TOOL_NAME
}
