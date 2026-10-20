/**
 * Model-facing Feishu attachment tool (`feishu_attachment_fetch`) and its
 * per-route authorization whitelist.
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

/** Default number of known messages kept per route (LRU). */
export const DEFAULT_KNOWN_MESSAGES_PER_ROUTE = 64

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
export type KnownAttachmentSource = 'trigger' | 'quote' | 'pending' | 'tool-result' | 'manual'

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
