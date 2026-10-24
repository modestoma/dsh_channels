/**
 * The Feishu bridge service: inbound routing, workspace/session ownership,
 * topic creation, and streaming-card orchestration.
 *
 * Ownership model (one workspace per user × chat):
 *  - p2p:   one workspace per (bot, user), all of that user's sessions inside;
 *  - group: one workspace per (chat, user), sessions grouped per user.
 *
 * Every topic's Session works in its own directory inside that workspace
 * (`topics/<token>` or a Git worktree), so topics never mix files while the
 * workspace list grows with users instead of conversations.
 *
 * Routing model:
 *  - `thread_id` → bound session (no @ needed inside an owned topic);
 *  - degraded chat-scoped keys when Feishu refuses topic replies;
 *  - new topic + new session for an @-triggered message without a route.
 *
 * @module dsh-channels/service
 */

import { AccessController } from './access/controller.ts'
import { AccessRequests } from './access/requests.ts'
import { AccessStore } from './access/store.ts'
import { AUTH_USER_TARGET_ERRORS, resolveAuthUserTarget } from './access/targets.ts'
import { ApprovalAnswerer } from './approvals.ts'
import type { ApprovalRoute } from './approvals.ts'
import { QuestionAnswerer } from './questions.ts'
import type {
  CommandInvocation,
  CommandResult,
  CredentialInfo,
  CredentialProvider,
  CordisFiber,
  HostContext,
  LlmModelInfo,
  LlmService,
  Session,
  SessionId,
  SessionProjections,
  TokenMeter,
} from './dsh-types.ts'
import { buildPickerCard, parsePickAction, standaloneInfoCard, STEER_ACTION, STOP_ACTION } from './cards.ts'
import type { PickerOption } from './cards.ts'
import {
  armEffortCommand, armModelCommand, armRenewCommand, registerModelCommand, commandResultCardKind, parseSlashCommand,
  registerEffortCommand, registerRenewCommand, RouteOperationQueue, supportedCommandHelp, supportedCommandList,
} from './commands.ts'
import type { EffortCommandAction, ParsedSlashCommand } from './commands.ts'
import { commandSpec } from './commands/registry.ts'
import type { ChannelCommandSpec } from './commands/registry.ts'
import type { PermissionPresets, SessionQuery } from './dsh-types.ts'
import { FEISHU_USER_ID_PATTERN, feishuDomain, sessionDirOf } from './domain.ts'
import type {
  AccessGroupRecord, AccessRequestRecord, AccessUserRecord,
  AnalyzeRequestRecord, ExpiredRouteRecord, FeishuDomainGlobal, FeishuDomainHandle, InflightSnapshot,
  ProcessedRecord, RawDomainHandle, RouteRecord, SessionOriginRecord,
} from './domain.ts'
import { RouteStore } from './session/routes.ts'
import { AnalyzeLauncher } from './analyze/launcher.ts'
import { startAnalyzeServer } from './analyze/server.ts'
import type { AnalyzeServer } from './analyze/server.ts'
import { InflightRepair } from './session/repair.ts'
import { SessionManager } from './session/manager.ts'
import type { LiveAgent, RenewCommit } from './session/manager.ts'
import { CardDelivery } from './feishu/delivery.ts'
import { AttachmentIntake } from './feishu/inbound-attachments.ts'
import { InboundAttachmentStore, effectiveAttachmentMode, resolveAttachmentService } from './feishu/native-attachments.ts'
import { AttachmentFetchToolRuntime, TopicMessagesToolRuntime } from './feishu/tools.ts'
import { SendFileToolRuntime } from './feishu/send-file.ts'
import { WikiConsent } from './feishu/wiki/consent.ts'
import { WikiToolRuntime } from './feishu/wiki/tools.ts'
import type { KnownAttachmentMessageInput, KnownAttachmentSource } from './feishu/tools.ts'
import {
  MessageReader, TOPIC_MESSAGES_MAX_LIMIT, buildHistoryContextBlock,
  buildQuoteContextBlock, clampInt, knownMessageOfItems, knownMessagesOfHistory, quoteItemsOf,
  readQuoteItems,
} from './feishu/message-read.ts'
import type { MessageReadRoute, RawMessageItem } from './feishu/message-read.ts'
import type { AttachmentStore } from './host/attachments.ts'
import { InboundRouter } from './routing/inbound.ts'
import type { RequestPolicyController } from './session/request-policy.ts'
import type { CardActionEvent, ChannelFactory, FeishuChannel, NormalizedMessage } from './feishu-channel.ts'
import { AppOwnerLookupError, FeishuApiError } from './feishu-channel.ts'
import { buildHealthCard, foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES } from './health.ts'
import type { HealthDependencyName, HealthSnapshot } from './health.ts'
import {
  buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard, buildWorkDirCard,
  compactFailureContext, resolveWorkDir, SESSION_HISTORY_DISPLAY_LIMIT,
} from './session-commands.ts'
import type { SessionHistoryAnnotation } from './session-commands.ts'
import { normalizeSessionHistory } from './domain.ts'
import { foldSessionStats, measureSessionContext, readProjectionViews } from './stats.ts'
import type { ContextMeasurement, ContextServices } from './stats.ts'
import { createLogicalSessionExport } from './session-export.ts'
import type { SessionExportBuilder } from './session-export.ts'
import { ACTIVITY_BUILD_MARKER, TurnStreamer } from './streamer.ts'
import type { ProjectedStats, StreamerHooks } from './streamer.ts'
import type { FeishuConfig } from './config.ts'
import type {
  AccessMutationResponse, AccessRequestWire, AccessUserWire, AccessWire, CredentialField, FeishuProfilesWire, FeishuProfileWire,
  ScopeCheckWire, SessionOriginWire,
  SlashCommandSyncWire,
} from './settings/contract.ts'
import { checkScopes } from './feishu/scopes.ts'
import { desiredSlashCommands, syncSlashCommands } from './feishu/slash-commands.ts'
import { mergeOverlay } from './settings/overlay.ts'
import type { OverlayPatch, OverlayStore } from './settings/overlay.ts'

/** Periodic route-GC sweep cadence (a long-running instance also accumulates
 *  dead records; TTL semantics make 6 h granularity more than sufficient). */
const GC_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Dedup-record retention: Feishu redelivery windows are minutes-scale, so a
 *  day is 100×+ headroom while keeping the table bounded. */
const PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000
/** Upper bound on the boot-time app-owner lookup before the connection opens. */
const APP_OWNER_LOOKUP_TIMEOUT_MS = 10_000
/** Upper bound on the post-connect scope grant query. */
const SCOPE_CHECK_TIMEOUT_MS = 10_000
/** Upper bound on the whole post-connect slash-command panel sync (one list plus per-command writes). */
const SLASH_COMMAND_SYNC_TIMEOUT_MS = 30_000

/** Outcome of the app-owner lookup for the current connection. */
type AppOwnerState =
  | { readonly userId: string }
  /** `apiRejected`: Feishu answered with an error code (typically a missing app-info scope). */
  | { readonly error: string; readonly apiRejected: boolean }


interface RenewAdmission {
  route: RouteRecord
  live: LiveAgent
  commit?: RenewCommit
}

interface EffortAdmission {
  live: LiveAgent
  controller: RequestPolicyController
}

interface ModelAdmission {
  live: LiveAgent
  controller: RequestPolicyController
}

/**
 * How long one resolved user or chat profile is reused. Short enough that
 * every page entry shows current Feishu data; long enough that the session
 * header and its sidebar tab opening together cost one lookup.
 */
const PROFILE_TTL_MS = 30 * 1000

/** The Feishu `code=<n> <msg>` of a failed API call, else the error text. */
function feishuReason(error: unknown): string {
  return error instanceof FeishuApiError ? error.detail : messageOf(error)
}

/** Feishu `chat_id`s the profile lookup accepts. */
const FEISHU_CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]+$/u

/** Wrap the host's storage facility open behind a stable local type. */
async function openFeishuDomain(ctx: HostContext): Promise<FeishuDomainHandle> {
  const domain = await ctx.storageDomain.open(feishuDomain) as unknown as RawDomainHandle
  const table = domain.table('routes')
  const inflightRaw = domain.table('inflight')
  const processedRaw = domain.table('processed')
  const expiredRoutesRaw = domain.table('expired_routes')
  const accessGroupsRaw = domain.table('access_groups')
  const accessUsersRaw = domain.table('access_users')
  const accessRequestsRaw = domain.table('access_requests')
  const accessWikiUsersRaw = domain.table('access_wiki_users')
  const analyzeRequestsRaw = domain.table('analyze_requests')
  const sessionOriginsRaw = domain.table('session_origins')
  return {
    routes: {
      get: key => table.get(key) as RouteRecord | undefined,
      put: (key, value) => table.put(key, value),
      delete: key => table.delete(key),
      entries: () => table.entries() as IterableIterator<[string, RouteRecord]>,
    },
    inflight: {
      get: key => inflightRaw.get(key) as InflightSnapshot | undefined,
      put: (key, value) => inflightRaw.put(key, value),
      update: (key, fn) => inflightRaw.update(key, current => fn(current as InflightSnapshot)),
      delete: key => inflightRaw.delete(key),
      entries: () => inflightRaw.entries() as IterableIterator<[string, InflightSnapshot]>,
    },
    processed: {
      get: key => processedRaw.get(key) as ProcessedRecord | undefined,
      put: (key, value) => processedRaw.put(key, value),
      delete: key => processedRaw.delete(key),
      entries: () => processedRaw.entries() as IterableIterator<[string, ProcessedRecord]>,
    },
    expiredRoutes: {
      get: key => expiredRoutesRaw.get(key) as ExpiredRouteRecord | undefined,
      put: (key, value) => expiredRoutesRaw.put(key, value),
      entries: () => expiredRoutesRaw.entries() as IterableIterator<[string, ExpiredRouteRecord]>,
    },
    accessGroups: {
      get: key => accessGroupsRaw.get(key) as AccessGroupRecord | undefined,
      put: (key, value) => accessGroupsRaw.put(key, value),
      delete: key => accessGroupsRaw.delete(key),
      entries: () => accessGroupsRaw.entries() as IterableIterator<[string, AccessGroupRecord]>,
    },
    accessUsers: {
      get: key => accessUsersRaw.get(key) as AccessUserRecord | undefined,
      put: (key, value) => accessUsersRaw.put(key, value),
      delete: key => accessUsersRaw.delete(key),
      entries: () => accessUsersRaw.entries() as IterableIterator<[string, AccessUserRecord]>,
    },
    accessRequests: {
      get: key => accessRequestsRaw.get(key) as AccessRequestRecord | undefined,
      put: (key, value) => accessRequestsRaw.put(key, value),
      delete: key => accessRequestsRaw.delete(key),
      entries: () => accessRequestsRaw.entries() as IterableIterator<[string, AccessRequestRecord]>,
    },
    accessWikiUsers: {
      get: key => accessWikiUsersRaw.get(key) as AccessUserRecord | undefined,
      put: (key, value) => accessWikiUsersRaw.put(key, value),
      delete: key => accessWikiUsersRaw.delete(key),
      entries: () => accessWikiUsersRaw.entries() as IterableIterator<[string, AccessUserRecord]>,
    },
    analyzeRequests: {
      get: key => analyzeRequestsRaw.get(key) as AnalyzeRequestRecord | undefined,
      put: (key, value) => analyzeRequestsRaw.put(key, value),
      entries: () => analyzeRequestsRaw.entries() as IterableIterator<[string, AnalyzeRequestRecord]>,
    },
    sessionOrigins: {
      get: key => sessionOriginsRaw.get(key) as SessionOriginRecord | undefined,
      put: (key, value) => sessionOriginsRaw.put(key, value),
    },
    getGlobal: () => (domain.global.get() ?? {}) as FeishuDomainGlobal,
    setGlobal: value => domain.global.set(value),
    close: () => domain.close(),
  }
}

/** `/auth wiki` usage line (input-error card). */
const AUTH_WIKI_USAGE = '用法：/auth wiki add <@用户|user_id> 或 /auth wiki remove <@用户|user_id>。知识库白名单里的用户（以及管理员）发起的话题可以使用知识库工具。'

/**
 * Resolve one credential reference through the host credentials seam.
 *
 * Precedence is owned by the provider (env > `$DSH_HOME/.credentials.yaml`
 * > `.env` fallbacks). Without a mounted seam the process environment is the
 * whole credential plane.
 */
async function resolveCredentialRef(ctx: HostContext, ref: string): Promise<string> {
  const provider = ctx.get?.('credentials') as CredentialProvider | undefined
  if (provider !== undefined) {
    const hit = await provider.resolve(ref)
    if (hit !== undefined) return hit.value
  } else {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient !== '') return ambient
  }
  throw new Error(
    `dsh-channels: credential "${ref}" is not configured; add it to $DSH_HOME/.credentials.yaml `
    + `(e.g. "${ref}: <value>") or export it in the launching environment`,
  )
}

/** Best-effort human-readable error text for the settings panel. */
/** One whitelisted user as the panel shows it. */
function userWire(record: AccessUserRecord): AccessUserWire {
  return {
    userId: record.userId,
    ...(record.name === undefined ? {} : { name: record.name }),
    source: record.source,
    addedAt: record.addedAt,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FeishuService {
  private readonly ctx: HostContext
  /** Live config object. Mutated in place — collaborators captured this reference. */
  private readonly config: FeishuConfig
  /** Loader/profile-provided config, the layer below the Web overlay. */
  private readonly baseConfig: FeishuConfig
  /** Web overlay store (`$DSH_HOME/dsh-channels/settings.json`), when mounted. */
  private readonly overlay: OverlayStore | undefined
  private readonly channelFactory: ChannelFactory
  private readonly sessionExportBuilder: SessionExportBuilder
  private channel: FeishuChannel | undefined
  private streamer: TurnStreamer | undefined
  private domain: FeishuDomainHandle | undefined
  /** Durable route store (cache + TTL retirement). */
  private readonly routes: RouteStore
  /** In-flight turn snapshots + startup repair. */
  private readonly repair: InflightRepair
  /** Outbound card delivery + reaction lifecycle. */
  private readonly delivery: CardDelivery
  /** Inbound attachment archival (Feishu resources → workspace files). */
  private readonly attachments: AttachmentIntake
  /**
   * Backend-selecting inbound storage facade. The native path stays lazy in
   * admission (prefetch images + manifest); this facade owns the legacy
   * workspace download used by `attachmentStore: 'archive'` and by the
   * fallback when the host does not mount `ctx.attachments`.
   */
  private readonly inboundAttachmentStore: InboundAttachmentStore
  /**
   * Read-only Feishu message access (P2): the quoted-message excerpt and the
   * first-turn topic history. Constructed before the inbound router so the
   * turn assembly can reach it; it resolves the live channel lazily.
   */
  private readonly messageReader = new MessageReader({ channel: () => this.channel })
  /** Inbound routing: dedup, admission, decision tree, session establishment. */
  private readonly inbound: InboundRouter
  /** Log-platform analyze API business side (requests → shared analysis topics). */
  private readonly analyzeLauncher: AnalyzeLauncher
  /** Bound analyze listener while connected with `analyzeListen` set. */
  private analyzeServer: AnalyzeServer | undefined
  /** Why the analyze listener could not bind at the last connect. */
  private analyzeListenError: string | undefined
  /** Agent/session lifecycle: live registry, resume, presets, renew. */
  private readonly sessions: SessionManager
  /**
   * Model-facing Feishu tools. `feishu_attachment_fetch` plus the shared
   * per-route known-message whitelist the admission, quote and history layers
   * populate; `feishu_topic_messages` reads the current topic on demand.
   */
  private readonly attachmentFetchTools: AttachmentFetchToolRuntime
  private readonly topicMessagesTools: TopicMessagesToolRuntime
  private readonly sendFileTools: SendFileToolRuntime
  private readonly wikiConsent: WikiConsent
  private readonly wikiTools: WikiToolRuntime
  /** FIFO admission for ordinary turns and commands targeting one route. */
  private readonly routeOperations = new RouteOperationQueue()
  /** Active Host command executions, aborted before shutdown tears peers down. */
  private readonly commandControllers = new Set<AbortController>()
  /** Whole command admissions, drained before channel/storage teardown. */
  private readonly commandOperations = new Set<Promise<void>>()
  /** `<provider>/<model>` → context window (lazy async fill; sync reads). */
  private readonly contextWindows = new Map<string, number>()
  private readonly windowRequests = new Set<string>()
  private started = false
  /** Epoch ms when `start()` completed (uptime for `/status`). */
  private startedAt: number | undefined
  /** Last failed connection attempt, surfaced in the Web settings panel. */
  private lastStartError: string | undefined
  /** Whether both Feishu application credentials currently resolve. */
  private configured = false
  /** Names of the missing credential references (never their values). */
  private missingConfigItems: string[] = []
  /** Guards the panel's explicit connect action (distinct from a restart). */
  private connecting = false
  /** Effective config captured at the last successful connect (restart-pending diff). */
  private runningConfig: FeishuConfig | undefined
  /** Guards overlapping panel-triggered reconnects. */
  private restarting = false
  /** One-shot warning for a native deployment without the host attachment library. */
  private warnedNativeAttachmentsUnmounted = false
  /** One-shot warning for silently degraded quote/history reads (missing scope). */
  private warnedPromptReadDegraded = false
  private unlisten: (() => void) | undefined
  /** Disposers for host-scoped listeners registered by `start()`. */
  private readonly unlistenHost: Array<() => boolean> = []
  /** Periodic route-GC timer (unref'd; only armed when `routeTtlMs > 0`). */
  private gcTimer: ReturnType<typeof setInterval> | undefined
  /** HITL approval answerer (created in `start()`). */
  private approvalAnswerer: ApprovalAnswerer | undefined
  /** HITL structured-question answerer (`ask_user_question`). */
  private questionAnswerer: QuestionAnswerer | undefined
  /** Disposers for the host approval waterfall listener + card actions. */
  private unlistenApproval: (() => boolean) | undefined
  /** Disposer for the host user-questions waterfall listener. */
  private unlistenQuestions: (() => boolean) | undefined
  private unlistenCardAction: (() => void) | undefined
  /** Durable access-control whitelists (groups + users + authorization requests). */
  private readonly accessStore: AccessStore
  /** Channel-plane admission gate (administrator / group / user). */
  private readonly accessController: AccessController
  /** Administrator DM authorization cards + bot-added group info cards. */
  private accessRequests: AccessRequests | undefined
  private unlistenBotAdded: (() => void) | undefined
  /**
   * App owner resolved at `start()`; the administrator whenever `adminUserId`
   * is unset. Cleared on shutdown so a reconnect looks it up again.
   */
  private appOwner: AppOwnerState | undefined
  /** Live-resolved user and chat profiles, by `user:`/`chat:` key; misses are kept as `{}`. */
  private readonly profileCache = new Map<string, { profile: FeishuProfileWire; at: number }>()
  /** Post-connect scope self-check; cleared on shutdown. */
  private scopeCheckState: ScopeCheckWire | undefined
  /** Post-connect slash-command panel sync; cleared on shutdown. */
  private slashCommandSyncState: SlashCommandSyncWire | undefined
  /** Aborts the running panel sync's remaining writes (timeout, shutdown, reconnect). */
  private slashCommandSyncAbort: AbortController | undefined

  constructor(
    ctx: HostContext,
    config: FeishuConfig,
    channelFactory: ChannelFactory,
    sessionExportBuilder: SessionExportBuilder = createLogicalSessionExport,
    overlay?: OverlayStore,
  ) {
    this.ctx = ctx
    this.config = config
    this.baseConfig = { ...config }
    this.overlay = overlay
    this.channelFactory = channelFactory
    this.sessionExportBuilder = sessionExportBuilder
    this.routes = new RouteStore({
      domain: () => this.domain,
      ttlMs: () => this.config.routeTtlMs,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.repair = new InflightRepair({
      domain: () => this.domain,
      channel: () => this.channel,
      ttlMs: () => this.config.routeTtlMs,
      info: (message, ...args) => this.ctx.logger?.info?.(message, ...args),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.sessions = new SessionManager({
      ctx: this.ctx,
      config: this.config,
      persistRoute: (key, record) => this.routes.put(key, record),
      started: () => this.started,
      detachStream: sessionId => this.streamer?.detach(sessionId),
      mountTools: (agentCtx, sessionId) => {
        // The fetch tool only makes sense for the lazy native backend: in
        // archive deployments (explicit, missing host library, or fetch tool
        // disabled) every attachment is downloaded before the turn and the
        // Agent reads the workspace copy, so mounting the tool would only
        // advertise an operation that can never be authorized.
        //
        // The topic-messages tool is backend-independent: quoted excerpts and
        // topic history are read-only, so it is mounted for both backends and
        // self-gates on `feishuTools.topicMessages`; `feishu_send_file`
        // self-gates on `feishuTools.sendFile`. The mounts start together and
        // resolve as one promise (no serial blocking).
        const mounts: Array<Promise<void>> = []
        if (this.effectiveAttachmentBackend() === 'native') {
          mounts.push(this.attachmentFetchTools.mount(agentCtx, sessionId))
        }
        mounts.push(this.topicMessagesTools.mount(agentCtx, sessionId))
        mounts.push(this.sendFileTools.mount(agentCtx, sessionId))
        mounts.push(this.wikiTools.mount(agentCtx, sessionId))
        return Promise.all(mounts).then(() => undefined)
      },
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.attachments = new AttachmentIntake({
      enabled: () => this.config.acceptAttachments,
      channel: () => this.channel,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.inboundAttachmentStore = new InboundAttachmentStore({
      enabled: () => this.config.acceptAttachments,
      // Effective backend, not the raw config: `store()` is only called after
      // admission already decided `archive`, so a native-configured deployment
      // with the fetch tool disabled must download to the workspace here too.
      mode: () => this.effectiveAttachmentBackend(),
      service: () => this.nativeAttachmentService(),
      channel: () => this.channel,
      archive: this.attachments,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.attachmentFetchTools = new AttachmentFetchToolRuntime({
      config: () => this.config,
      channel: () => this.channel,
      routeOfSession: sessionId => {
        const record = this.routes.findBySession(sessionId)
        if (record === undefined) return undefined
        return {
          key: record.key,
          kind: record.kind,
          chatId: record.chatId,
          chatType: record.chatType,
          senderUserId: record.senderUserId,
          ...(record.shared === true ? { shared: true } : {}),
        }
      },
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.topicMessagesTools = new TopicMessagesToolRuntime({
      config: () => this.config,
      channel: () => this.channel,
      routeOfSession: sessionId => {
        const record = this.routes.findBySession(sessionId)
        if (record === undefined) return undefined
        return {
          key: record.key,
          kind: record.kind,
          chatId: record.chatId,
          chatType: record.chatType,
          senderUserId: record.senderUserId,
          ...(record.shared === true ? { shared: true } : {}),
        }
      },
      noteKnownMessage: (route, message, source) => {
        this.attachmentFetchTools.noteKnownMessage(route, message, source)
      },
      isKnownMessage: (route, messageId) => this.attachmentFetchTools.isKnownMessage(route, messageId),
      // The tool description must not promise a fetch tool that archive
      // deployments do not mount; the runtime appends a degradation note.
      fetchAvailable: () => this.effectiveAttachmentBackend() === 'native',
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.wikiConsent = new WikiConsent({
      channel: () => (this.started ? this.channel : undefined),
      timeoutMs: () => this.config.approvalTimeoutMs,
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels wiki consent error (session %s): %s', sessionId, String(error))
      },
    })
    this.wikiTools = new WikiToolRuntime({
      config: () => this.config,
      channel: () => (this.started ? this.channel : undefined),
      routeOfSession: sessionId => this.approvalRouteFor(sessionId),
      mayUseWiki: userId => this.accessController.isAdmin(userId) || this.accessStore.hasWikiUser(userId),
      consent: this.wikiConsent,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.sendFileTools = new SendFileToolRuntime({
      config: () => this.config,
      channel: () => (this.started ? this.channel : undefined),
      targetOfSession: sessionId => {
        const record = this.routes.findBySession(sessionId)
        if (record === undefined) return undefined
        return {
          replyTo: record.cardMessageId,
          inThread: record.kind === 'thread',
          rootDir: sessionDirOf(record),
        }
      },
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.delivery = new CardDelivery({
      channel: () => this.channel,
      started: () => this.started,
      routeForSession: sessionId => this.routes.findBySession(sessionId),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.accessStore = new AccessStore({
      domain: () => this.domain,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.accessController = new AccessController({
      config: () => this.accessConfig(),
      store: this.accessStore,
      channel: () => this.channel,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
      onDeniedGroup: msg => {
        void this.accessRequests?.ensureGroupRequest(msg).catch((error: unknown) => {
          this.ctx.logger?.warn?.('dsh-channels: group authorization request failed: %s', String(error))
        })
      },
      onDeniedUser: msg => {
        void this.accessRequests?.ensureUserRequest(msg).catch((error: unknown) => {
          this.ctx.logger?.warn?.('dsh-channels: user authorization request failed: %s', String(error))
        })
      },
    })
    this.inbound = new InboundRouter({
      ctx: this.ctx,
      config: this.config,
      started: () => this.started,
      domain: () => this.domain,
      routes: this.routes,
      repair: this.repair,
      delivery: this.delivery,
      sessions: this.sessions,
      attachmentMode: () => this.config.attachmentStore,
      nativeAttachments: () => this.nativeAttachmentService(),
      attachmentStore: this.inboundAttachmentStore,
      noteKnownAttachments: (record, message, source) => {
        this.noteKnownAttachmentMessage(record, message, source ?? 'trigger')
      },
      messageRead: {
        quote: input => this.readQuoteContext(input),
        history: input => this.readHistoryContext(input),
      },
      prefetchImages: () => ({
        enabled: this.config.prefetchImages,
        maxImageBytes: this.config.prefetchImageMaxBytes,
        maxTotalBytes: this.config.prefetchTotalMaxBytes,
        timeoutMs: this.config.prefetchTimeoutMs,
      }),
      access: this.accessController,
      queue: this.routeOperations,
      streamer: () => this.streamer,
      questionAnswerer: () => this.questionAnswerer,
      approvalAnswerer: () => this.approvalAnswerer,
      commands: { handleSlash: (msg, line) => this.handleSlashMessage(msg, line) },
    })
    this.analyzeLauncher = new AnalyzeLauncher({
      ctx: this.ctx,
      config: this.config,
      started: () => this.started,
      channel: () => this.channel,
      domain: () => this.domain,
      routes: this.routes,
      repair: this.repair,
      sessions: this.sessions,
      streamer: () => this.streamer,
      queue: this.routeOperations,
      reserveTopic: threadId => this.inbound.reserveTopic(threadId),
      mayAnalyzeIn: chatId => this.accessController.mayAnalyzeIn(chatId),
      resolveToken: () => resolveCredentialRef(this.ctx, this.config.analyzeToken).catch(() => undefined),
    })
  }

  /** Effective inbound attachment backend (matches the inbound router). */
  private effectiveAttachmentBackend(): 'native' | 'archive' {
    return effectiveAttachmentMode(
      this.config.attachmentStore,
      this.nativeAttachmentService(),
      this.config.feishuTools.attachmentFetch,
      this.config.acceptAttachments,
    )
  }

  /**
   * Resolve the host's native attachment library from the plugin scope.
   *
   * The service is registered host-wide (`@deepseek-ai/dsh-attachment-local`),
   * so the safe `ctx.get` lookup resolves it even though this plugin does not
   * declare `attachments` in its cordis `inject` list (the per-Agent scopes
   * still inject it for the fetch tool). A missing service reads as
   * `undefined` and switches admission to the legacy archive backend.
   */
  private nativeAttachmentService(): AttachmentStore | undefined {
    const service = resolveAttachmentService(this.ctx)
    if (service === undefined && this.config.attachmentStore === 'native'
      && !this.warnedNativeAttachmentsUnmounted) {
      // The facade now receives the effective backend, so its own downgrade
      // warning cannot fire: report the missing library once from the resolver.
      this.warnedNativeAttachmentsUnmounted = true
      this.ctx.logger?.warn?.(
        'dsh-channels: attachmentStore=native 但宿主未挂载 ctx.attachments，'
        + '入站附件回退话题 attachments/ 工作区落盘',
      )
    }
    return service
  }

  /**
   * Pre-authorize one admitted Feishu message for `feishu_attachment_fetch`.
   *
   * The admission and quote layers call this after their access gates for the
   * triggering / quoted message; the tool otherwise only authorizes the route
   * owner's own messages it reads back from Feishu. Registering is a pure
   * in-memory operation (one LRU entry per route) and never fails the caller.
   */
  noteKnownAttachmentMessage(
    record: RouteRecord,
    message: KnownAttachmentMessageInput,
    source: KnownAttachmentSource = 'trigger',
  ): void {
    this.attachmentFetchTools.noteKnownMessage({
      key: record.key,
      kind: record.kind,
      chatId: record.chatId,
      chatType: record.chatType,
      senderUserId: record.senderUserId,
    }, message, source)
  }

  // ---- read-only message context (quoted excerpt / topic history) -------

  /**
   * Channel-plane identity of one route for message reads (structurally the
   * same as the attachment-tool route: key/kind/chat/sender).
   */
  private messageReadRouteOf(record: RouteRecord): MessageReadRoute {
    return {
      key: record.key,
      kind: record.kind,
      chatId: record.chatId,
      chatType: record.chatType,
      senderUserId: record.senderUserId,
    }
  }

  /**
   * Resolve one quoted message into the bounded `<feishu_quote>` block and the
   * whitelist registration of the quoted message (merged-forward containers
   * keep their container id, per the P0 download rule).
   *
   * The quoted message must belong to this route's visible container: another
   * chat is always rejected; on a thread route a quoted message of a
   * *different* topic is rejected as well (a main-timeline message carries no
   * thread id and stays allowed — quotes happen before the bot owns a topic);
   * on a degraded chat route any topic message is rejected (a chat route must
   * not read another topic of the same group).
   *
   * The read budget is the short prompt-enrichment budget, never the model
   * tool timeout. Read failures (missing scope, deleted message, channel down)
   * degrade to `undefined`: the turn runs without an excerpt (AC6).
   */
  private async readQuoteContext(input: {
    messageId: string
    record: RouteRecord
  }): Promise<{ block: string; message?: KnownAttachmentMessageInput } | undefined> {
    try {
      const result = await readQuoteItems(this.messageReader, input.messageId, {
        timeoutMs: this.config.promptContextTimeoutMs,
      })
      if (!result.ok) {
        this.reportDegradedRead('quoted message', input.messageId, result.reason)
        return undefined
      }
      const container: RawMessageItem | undefined = quoteItemsOf(result.value)
      if (container === undefined) return undefined
      if (!this.quotedMessageBelongsToRoute(input.record, container)) {
        this.ctx.logger?.debug?.(
          'dsh-channels: dropping quoted message %s from another chat/topic', input.messageId,
        )
        return undefined
      }
      const block = buildQuoteContextBlock(result.value, {
        attachmentFetchAvailable: this.attachmentFetchMounted(),
      })
      if (block === '') return undefined
      const message = knownMessageOfItems(result.value)
      return { block, ...(message === undefined ? {} : { message }) }
    } catch (error) {
      // Defensive: the reader reports structured failures; a raw throw is still
      // only ever a missing excerpt, never a failed turn.
      this.ctx.logger?.debug?.(
        'dsh-channels: reading quoted message %s failed: %s', input.messageId, String(error),
      )
      return undefined
    }
  }

  /** Whether one quoted message may be shown/authorized for one route. */
  private quotedMessageBelongsToRoute(record: RouteRecord, container: RawMessageItem): boolean {
    // Fail closed on a missing/foreign chat id: every real Feishu item carries
    // one, so an absent id is a malformed response, never a legitimate quote.
    if (container.chatId === undefined || container.chatId !== record.chatId) return false
    // A main-timeline message has no thread id; a message of another topic must
    // never leak into this route's excerpt or whitelist. A degraded chat route
    // (no topic) must reject topic messages entirely, even in the same chat.
    if (record.kind === 'thread') {
      return container.threadId === undefined || container.threadId === record.key
    }
    return container.threadId === undefined
  }

  /**
   * Resolve the bounded first-turn `<feishu_history>` block plus the whitelist
   * registrations of the history messages (chronological order).
   *
   * `limit` is `historyBootstrapLimit` (0/negative → no read at all). The page
   * is requested newest-first so a long topic yields the most recent messages;
   * excluded ids (the trigger and the streaming card), deleted messages, and
   * messages outside the route container are filtered before the newest
   * `limit` rows are reversed into chronological order for rendering. The read
   * uses the short prompt-enrichment budget and degrades to `undefined` (AC6).
   */
  private async readHistoryContext(input: {
    record: RouteRecord
    limit: number
    excludeMessageIds: readonly string[]
  }): Promise<{ block: string; messages: readonly KnownAttachmentMessageInput[] } | undefined> {
    if (!Number.isFinite(input.limit) || input.limit <= 0) return undefined
    try {
      const route = this.messageReadRouteOf(input.record)
      const pageSize = clampInt(
        input.limit + input.excludeMessageIds.length,
        1,
        TOPIC_MESSAGES_MAX_LIMIT,
      )
      const result = await this.messageReader.listRoute(route, {
        pageSize,
        order: 'newest-first',
        timeoutMs: this.config.promptContextTimeoutMs,
      })
      if (!result.ok) {
        this.reportDegradedRead('topic history', input.record.key, result.reason)
        return undefined
      }
      const excluded = new Set(input.excludeMessageIds)
      const recent = result.value.items
        .filter(item => !item.deleted && !excluded.has(item.messageId))
        .slice(0, input.limit)
        .reverse()
      const block = buildHistoryContextBlock(recent, {
        maxMessages: input.limit,
        attachmentFetchAvailable: this.attachmentFetchMounted(),
      })
      if (block === '') return undefined
      return { block, messages: knownMessagesOfHistory(recent) }
    } catch (error) {
      this.ctx.logger?.debug?.(
        'dsh-channels: reading topic history of %s failed: %s', input.record.key, String(error),
      )
      return undefined
    }
  }

  /** Whether this deployment mounts the lazy attachment fetch tool. */
  private attachmentFetchMounted(): boolean {
    return this.effectiveAttachmentBackend() === 'native'
  }

  /**
   * Report one silently degraded prompt read: debug per occurrence (expected
   * when a deployment misses a scope) plus ONE warn per service lifetime so an
   * operator can find the cause without log spam.
   */
  private reportDegradedRead(kind: string, target: string, reason: string): void {
    if (this.warnedPromptReadDegraded) {
      this.ctx.logger?.debug?.(
        'dsh-channels: %s read of %s failed (degraded): %s', kind, target, reason,
      )
      return
    }
    this.warnedPromptReadDegraded = true
    this.ctx.logger?.warn?.(
      'dsh-channels: %s（%s）读取失败，已静默降级（不带引用/历史上下文继续回合）：%s。'
      + '如持续出现请检查飞书应用的消息读取权限（如 im:message:readonly / im:message.group_msg），'
      + '或确认该消息未被撤回、网络正常',
      kind, target, reason,
    )
  }

  // ---- lifecycle / Web settings panel ----------------------------------

  /**
   * Load the Web overlay and open the long connection when — and only when —
   * the Feishu application credentials are complete.
   *
   * An incomplete configuration is a normal state, not an error: the plugin
   * stays loaded so the Web settings panel can guide the user through the
   * credentials form, and no connection is attempted. A failed connection
   * attempt is recorded for the panel instead of failing the plugin fiber.
   */
  async boot(): Promise<void> {
    if (this.connecting || this.restarting) return
    // Acquire the lifecycle lock before the first await so a panel action can
    // never interleave with the boot sequence.
    this.connecting = true
    try {
      await this.loadOverlay()
      await this.refreshReadiness()
      if (!this.configured) {
        this.lastStartError = undefined
        this.runningConfig = undefined
        this.ctx.logger?.info?.(
          'dsh-channels: 飞书应用凭据未配置完整（缺少 %s），本次不连接飞书；'
          + '请在 Web 设置面板 → 飞书渠道中配置，保存后会自动连接',
          this.missingConfigItems.join('、'),
        )
        return
      }
      await this.openConnection()
    } catch {
      // Recorded in `lastStartError`; the plugin itself stays loaded.
    } finally {
      this.connecting = false
    }
  }

  /**
   * Refresh the cached configuration readiness from the credentials seam.
   * Only presence is checked (describe/resolve), never values; the secrets
   * themselves are resolved by `start()` when a connection is opened.
   */
  async refreshReadiness(): Promise<void> {
    const states = await this.credentialStates()
    const missing: string[] = []
    if (!states.appId.configured) missing.push(`${this.config.appId}（飞书 App ID）`)
    if (!states.appSecret.configured) missing.push(`${this.config.appSecret}（飞书 App Secret）`)
    this.missingConfigItems = missing
    this.configured = missing.length === 0
  }

  /**
   * Open the connection with the live config. A failure tears the partial
   * service down and records the reason for the panel before rethrowing it to
   * the caller; the plugin fiber is never failed by a connection problem.
   */
  private async openConnection(): Promise<void> {
    try {
      await this.start()
      this.lastStartError = undefined
      this.runningConfig = { ...this.config }
    } catch (error) {
      this.lastStartError = messageOf(error)
      this.ctx.logger?.error?.('dsh-channels: 飞书连接失败：%s', String(error))
      // Headless profiles have no settings panel; keep the failure visible on
      // the console, symmetric with the success line at the end of `start()`.
      console.error('[dsh-channels] feishu connection failed:', error)
      try {
        await this.shutdown()
      } catch {
        // The connection error is the useful one.
      }
      throw error
    }
  }

  /**
   * Panel action: open the long connection when the channel is stopped.
   * Credentials are re-checked first — an incomplete pair throws a message the
   * panel shows next to the credentials form instead of attempting a connect.
   */
  async connect(): Promise<void> {
    if (this.started) return
    // Boot, an explicit connect and a restart all drive the same connection
    // wiring; serialize them instead of racing two `start()` bodies. The lock
    // is acquired synchronously, before any await.
    if (this.connecting || this.restarting) throw new Error('飞书连接正在连接或重启，请稍候再试')
    this.connecting = true
    try {
      // A stopped channel may have been edited on disk (the overlay file is
      // writable by hand); connecting re-reads it like a restart does.
      await this.loadOverlay()
      await this.refreshReadiness()
      if (!this.configured) {
        throw new Error(`飞书应用凭据尚未配置完整：缺少 ${this.missingConfigItems.join('、')}`)
      }
      await this.openConnection()
    } finally {
      this.connecting = false
    }
  }

  /** Re-read the Web overlay over the profile config (no channel touch). */
  private async loadOverlay(): Promise<void> {
    const overlay = this.overlay === undefined ? {} : await this.overlay.load()
    this.replaceConfig(mergeOverlay(this.baseConfig, overlay))
  }

  /**
   * Replace every own key of the live config object. `Object.assign` alone
   * would keep stale overlay-only keys (e.g. `provider`) when the next layer
   * no longer defines them; collaborators hold this object identity, so the
   * mutation must happen in place.
   */
  private replaceConfig(next: FeishuConfig): void {
    const live = this.config as unknown as Record<string, unknown>
    for (const key of Object.keys(live)) delete live[key]
    Object.assign(live, next)
  }

  /**
   * Apply an already-validated overlay over the profile config. Fields read
   * per event/turn take effect immediately; `RESTART_KEYS` need `restart()`.
   */
  applyOverlay(overlay: OverlayPatch): void {
    this.replaceConfig(mergeOverlay(this.baseConfig, overlay))
  }

  /**
   * Tear the connection down and bring it back with the latest config. When the
   * credentials are no longer complete the channel simply stays stopped (no
   * error): the panel then shows the configuration guide instead of a failure.
   */
  async restart(): Promise<void> {
    if (this.restarting || this.connecting) throw new Error('飞书连接正在连接或重启，请稍候再试')
    this.restarting = true
    try {
      await this.shutdown()
      await this.loadOverlay()
      await this.refreshReadiness()
      if (!this.configured) {
        this.lastStartError = undefined
        this.runningConfig = undefined
        return
      }
      await this.openConnection()
    } finally {
      this.restarting = false
    }
  }

  isRunning(): boolean { return this.started }
  isRestarting(): boolean { return this.restarting }
  /** True while the panel's explicit connect action is in flight. */
  isConnecting(): boolean { return this.connecting }
  /** Whether both Feishu application credentials currently resolve. */
  isConfigured(): boolean { return this.configured }
  /** Names of the missing configuration items (never values). */
  missingConfig(): readonly string[] { return this.missingConfigItems }
  startedAtMs(): number | undefined { return this.startedAt }
  uptimeMs(): number | undefined {
    return this.startedAt === undefined || !this.started ? undefined : Math.max(0, Date.now() - this.startedAt)
  }
  startError(): string | undefined { return this.lastStartError }
  configSnapshot(): FeishuConfig { return { ...this.config } }
  baseConfigSnapshot(): FeishuConfig { return { ...this.baseConfig } }
  runningConfigSnapshot(): FeishuConfig | undefined {
    return this.runningConfig === undefined ? undefined : { ...this.runningConfig }
  }

  // ---- access-control panel surface ------------------------------------

  /** Whitelists + pending authorization requests (read-only Web projection). */
  accessSnapshot(): AccessWire {
    const admin = this.effectiveAdminUserId()
    const owner = this.appOwner
    return {
      mode: this.config.accessMode,
      // Whitelists live in the storage domain, which is only open while the
      // channel runs; an unconnected panel must not present them as empty.
      loaded: this.domain !== undefined,
      admin: {
        ...(admin === undefined ? {} : { userId: admin, source: this.configuredAdminUserId() === undefined ? 'owner' : 'config' }),
        configured: admin !== undefined,
        ...(owner !== undefined && 'error' in owner ? { ownerLookupError: owner.error } : {}),
      },
      groups: this.accessStore.groupRecords().map(record => ({
        chatId: record.chatId,
        ...(record.name === undefined ? {} : { name: record.name }),
        source: record.source,
        addedAt: record.addedAt,
      })),
      users: this.accessStore.userRecords().map(userWire),
      wikiUsers: this.accessStore.wikiUserRecords().map(userWire),
      requests: this.accessStore.pendingRequests().map(record => {
        const wire: AccessRequestWire = {
          token: record.token,
          kind: record.kind,
          targetId: record.targetId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        }
        const name = record.kind === 'group' ? record.groupName : record.requesterName
        if (name !== undefined) wire.name = name
        if (record.chatId !== undefined) wire.chatId = record.chatId
        if (record.groupName !== undefined) wire.groupName = record.groupName
        const requester = record.requesterName ?? record.requesterUserId
        if (requester !== undefined) wire.requester = requester
        return wire
      }),
    }
  }

  /** Panel: authorize one group by id. */
  async addAccessGroup(chatId: string, name?: string): Promise<AccessMutationResponse> {
    const id = this.cleanAccessTargetId(chatId)
    if (id === undefined) return { ok: false, error: 'chat_id 不合法（应为 oc_ 开头的群 ID）' }
    const admin = this.effectiveAdminUserId()
    if (admin === undefined) return { ok: false, error: '请先在「访问授权」标签页设置管理员 user_id' }
    try {
      if (!this.accessStore.hasGroup(id)) {
        await this.accessStore.addGroup({
          chatId: id,
          ...(name === undefined || name.trim() === '' ? {} : { name: name.trim() }),
          source: 'panel',
          addedBy: admin,
          addedAt: Date.now(),
        })
      }
      return { ok: true, access: this.accessSnapshot() }
    } catch (error) {
      return { ok: false, error: `写入授权失败：${messageOf(error)}` }
    }
  }

  /** Panel: revoke one group. */
  async removeAccessGroup(chatId: string): Promise<AccessMutationResponse> {
    const id = this.cleanAccessTargetId(chatId)
    if (id === undefined) return { ok: false, error: 'chat_id 不合法' }
    try {
      await this.accessStore.removeGroup(id)
      return { ok: true, access: this.accessSnapshot() }
    } catch (error) {
      return { ok: false, error: `撤销授权失败：${messageOf(error)}` }
    }
  }

  /** Panel: authorize one user (global across authorized groups). */
  async addAccessUser(userId: string, name?: string): Promise<AccessMutationResponse> {
    return this.addPanelUser(userId, name, id => this.accessStore.hasUser(id), record => this.accessStore.addUser(record))
  }

  /** Panel: revoke one user. */
  async removeAccessUser(userId: string): Promise<AccessMutationResponse> {
    return this.removePanelUser(userId, id => this.accessStore.removeUser(id))
  }

  /** Panel: add one user to the wiki whitelist. */
  async addWikiUser(userId: string, name?: string): Promise<AccessMutationResponse> {
    return this.addPanelUser(userId, name, id => this.accessStore.hasWikiUser(id), record => this.accessStore.addWikiUser(record))
  }

  /** Panel: remove one user from the wiki whitelist. */
  async removeWikiUser(userId: string): Promise<AccessMutationResponse> {
    return this.removePanelUser(userId, id => this.accessStore.removeWikiUser(id))
  }

  private async addPanelUser(
    userId: string,
    name: string | undefined,
    has: (id: string) => boolean,
    add: (record: AccessUserRecord) => Promise<AccessUserRecord>,
  ): Promise<AccessMutationResponse> {
    const id = this.cleanAccessUserId(userId)
    if (id === undefined) return { ok: false, error: 'user_id 不合法（只能包含字母、数字、_ 和 -，不是 ou_ 开头的 open_id）' }
    const admin = this.effectiveAdminUserId()
    if (admin === undefined) return { ok: false, error: '请先在「访问授权」标签页设置管理员 user_id' }
    try {
      if (!has(id)) {
        await add({
          userId: id,
          ...(name === undefined || name.trim() === '' ? {} : { name: name.trim() }),
          source: 'panel',
          addedBy: admin,
          addedAt: Date.now(),
        })
      }
      return { ok: true, access: this.accessSnapshot() }
    } catch (error) {
      return { ok: false, error: `写入授权失败：${messageOf(error)}` }
    }
  }

  private async removePanelUser(userId: string, remove: (id: string) => Promise<boolean>): Promise<AccessMutationResponse> {
    const id = this.cleanAccessUserId(userId)
    if (id === undefined) return { ok: false, error: 'user_id 不合法' }
    try {
      await remove(id)
      return { ok: true, access: this.accessSnapshot() }
    } catch (error) {
      return { ok: false, error: `撤销授权失败：${messageOf(error)}` }
    }
  }

  /** Panel: Feishu origin of one Session, or null when Feishu never routed it. */
  async sessionOrigin(sessionId: string): Promise<SessionOriginWire | null> {
    const origin = this.routes.origin(sessionId)
    if (origin === undefined) return null
    const route = this.routes.findBySession(sessionId)
    const bound = route !== undefined
    const group = origin.chatType === 'group'
    const profiles = await this.feishuProfiles([origin.senderUserId], group ? [origin.chatId] : [])
    const chat = profiles.chats[origin.chatId] ?? {}
    const sender = profiles.users[origin.senderUserId] ?? {}
    const senderName = sender.name ?? (group ? await this.memberName(origin.senderUserId, origin.chatId) : undefined)
    return {
      sessionId,
      chatType: origin.chatType,
      kind: origin.kind,
      chatId: origin.chatId,
      ...(chat.name === undefined ? {} : { chatName: chat.name }),
      ...(chat.avatarUrl === undefined ? {} : { chatAvatarUrl: chat.avatarUrl }),
      senderUserId: origin.senderUserId,
      ...(senderName === undefined ? {} : { senderName }),
      ...(sender.avatarUrl === undefined ? {} : { senderAvatarUrl: sender.avatarUrl }),
      shared: origin.shared === true,
      createdAt: origin.createdAt,
      bound,
      ...(bound ? { lastActivityAt: route.lastActivityAt } : {}),
      chatLink: `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(origin.chatId)}`,
    }
  }

  /**
   * Live Feishu names and avatars for the panel and the session-origin view,
   * through a {@link PROFILE_TTL_MS} cache. Ids that are not Feishu
   * `user_id`s / `chat_id`s are skipped; a disconnected channel and failed
   * lookups leave ids absent, and failures are reported in `warning` and not
   * cached.
   * @param userIds - user `user_id`s to resolve.
   * @param chatIds - chat `chat_id`s to resolve.
   * @returns the resolved profiles by id.
   */
  async feishuProfiles(userIds: readonly string[], chatIds: readonly string[]): Promise<FeishuProfilesWire> {
    const result: FeishuProfilesWire = { users: {}, chats: {} }
    const warnings: string[] = []
    const now = Date.now()
    for (const [key, cached] of this.profileCache) {
      if (now - cached.at >= PROFILE_TTL_MS) this.profileCache.delete(key)
    }
    const fresh = (key: string): FeishuProfileWire | undefined => this.profileCache.get(key)?.profile
    const keep = (target: Record<string, FeishuProfileWire>, id: string, profile: FeishuProfileWire): void => {
      if (profile.name !== undefined || profile.avatarUrl !== undefined) target[id] = profile
    }
    const users = [...new Set(userIds)].filter(id => FEISHU_USER_ID_PATTERN.test(id))
    const chats = [...new Set(chatIds)].filter(id => FEISHU_CHAT_ID_PATTERN.test(id))
    const missingUsers: string[] = []
    for (const id of users) {
      const cached = fresh(`user:${id}`)
      if (cached === undefined) missingUsers.push(id)
      else keep(result.users, id, cached)
    }
    const missingChats: string[] = []
    for (const id of chats) {
      const cached = fresh(`chat:${id}`)
      if (cached === undefined) missingChats.push(id)
      else keep(result.chats, id, cached)
    }
    const channel = this.channel
    if (channel === undefined) return result
    const lookups: Array<Promise<void>> = []
    if (missingUsers.length > 0 && channel.userProfiles !== undefined) {
      lookups.push(channel.userProfiles(missingUsers).then(
        (found) => {
          for (const id of missingUsers) {
            const profile = found.get(id) ?? {}
            this.profileCache.set(`user:${id}`, { profile, at: now })
            keep(result.users, id, profile)
          }
        },
        (error: unknown) => { warnings.push(`读取用户资料失败：${feishuReason(error)}`) },
      ))
    }
    const chatProfile = channel.chatProfile?.bind(channel)
    if (chatProfile !== undefined) {
      let chatError: string | undefined
      for (const id of missingChats) {
        lookups.push(chatProfile(id).then(
          (profile) => {
            this.profileCache.set(`chat:${id}`, { profile, at: now })
            keep(result.chats, id, profile)
          },
          (error: unknown) => {
            if (chatError !== undefined) return
            chatError = `读取群信息失败：${feishuReason(error)}`
            warnings.push(chatError)
          },
        ))
      }
    }
    await Promise.all(lookups)
    if (warnings.length > 0) {
      result.warning = warnings.join('；')
      this.ctx.logger?.debug?.('dsh-channels: Feishu profile lookup: %s', result.warning)
    }
    return result
  }

  /** Chat-member-list name for a user the contact profile cannot name. */
  private async memberName(userId: string, chatId: string): Promise<string | undefined> {
    const cached = this.profileCache.get(`member:${chatId}:${userId}`)
    if (cached !== undefined && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile.name
    const name = await this.channel?.memberName?.(userId, chatId)
    this.profileCache.set(`member:${chatId}:${userId}`, { profile: name === undefined ? {} : { name }, at: Date.now() })
    return name
  }

  /** Panel: decide one pending authorization request (same path as the card). */
  async resolveAccessRequest(token: string, decision: 'allow' | 'deny'): Promise<AccessMutationResponse> {
    const requests = this.accessRequests
    if (requests === undefined) return { ok: false, error: '授权服务尚未启动' }
    const actor = this.effectiveAdminUserId()
    if (actor === undefined) return { ok: false, error: '请先在「访问授权」标签页配置管理员 user_id' }
    try {
      const result = await requests.resolve(token, decision, actor)
      if (!result.ok) return { ok: false, error: result.error }
      return { ok: true, access: this.accessSnapshot() }
    } catch (error) {
      return { ok: false, error: `处理授权申请失败：${messageOf(error)}` }
    }
  }

  /** `/auth status` administrator line: id plus where it came from. */
  private adminStatusLine(): string {
    const admin = this.effectiveAdminUserId()
    if (admin === undefined) return '未配置'
    return this.configuredAdminUserId() === undefined ? `\`${admin}\`（应用所有者，自动）` : `\`${admin}\``
  }

  /** The explicitly configured administrator, trimmed; empty counts as unset. */
  private configuredAdminUserId(): string | undefined {
    const admin = this.config.adminUserId?.trim()
    return admin === undefined || admin === '' ? undefined : admin
  }

  /** Configured administrator, else the app owner looked up at `start()`. */
  private effectiveAdminUserId(): string | undefined {
    const configured = this.configuredAdminUserId()
    if (configured !== undefined) return configured
    const owner = this.appOwner
    return owner !== undefined && 'userId' in owner ? owner.userId : undefined
  }

  /** Live config with `adminUserId` replaced by the effective administrator. */
  private accessConfig(): FeishuConfig {
    return { ...this.config, adminUserId: this.effectiveAdminUserId() }
  }

  /**
   * Look up the app owner for the administrator fallback. Never throws: a
   * failure is recorded for the panel and only warned about when no
   * administrator is configured (the fallback is then what admission needs).
   */
  private async resolveAppOwner(channel: FeishuChannel): Promise<void> {
    this.appOwner = undefined
    if (channel.appOwnerUserId === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: AppOwnerState
    try {
      const userId = await Promise.race([
        channel.appOwnerUserId(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时（${APP_OWNER_LOOKUP_TIMEOUT_MS} ms）`)), APP_OWNER_LOOKUP_TIMEOUT_MS)
        }),
      ])
      state = userId !== undefined && FEISHU_USER_ID_PATTERN.test(userId)
        ? { userId }
        : { error: '应用所有者不是企业内成员，或接口未返回其 user_id', apiRejected: false }
    } catch (error) {
      const detail = error instanceof AppOwnerLookupError ? error.detail : messageOf(error)
      state = {
        error: `获取应用信息失败：${detail}。请在「访问授权」手动填写管理员 user_id（私聊机器人发 /userid 获取，私聊模式关闭时可在飞书管理后台的成员详情里查看用户 ID）；或为应用开通「获取应用信息」权限并发布版本后重新连接`,
        apiRejected: error instanceof AppOwnerLookupError && error.code !== undefined,
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // A background lookup can outlive its connection (shutdown/reconnect).
    if (this.channel !== channel) return
    this.appOwner = state
    if ('error' in state && this.configuredAdminUserId() === undefined) {
      this.ctx.logger?.warn?.('dsh-channels: app owner fallback unavailable: %s', state.error)
    }
  }

  /** Latest post-connect scope self-check, when one finished for this connection. */
  scopeCheck(): ScopeCheckWire | undefined {
    return this.scopeCheckState
  }

  /** Latest native slash-command panel sync, when one finished for this connection. */
  slashCommandSync(): SlashCommandSyncWire | undefined {
    return this.slashCommandSyncState
  }

  /**
   * Reconcile Feishu's native `/` panel with the command registry and log the
   * outcome. Never throws; a failure only loses the panel listing, typed
   * commands keep working.
   */
  private async runSlashCommandSync(channel: FeishuChannel): Promise<void> {
    this.slashCommandSyncState = undefined
    this.slashCommandSyncAbort?.abort()
    this.slashCommandSyncAbort = undefined
    const api = channel.slashCommands
    if (api === undefined) return
    const abort = new AbortController()
    this.slashCommandSyncAbort = abort
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: SlashCommandSyncWire
    try {
      const result = await Promise.race([
        syncSlashCommands(api, desiredSlashCommands(), abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时（${SLASH_COMMAND_SYNC_TIMEOUT_MS} ms）`)), SLASH_COMMAND_SYNC_TIMEOUT_MS)
        }),
      ])
      state = { state: 'ok', checkedAt: Date.now(), ...result }
    } catch (error) {
      const detail = error instanceof FeishuApiError ? error.detail : messageOf(error)
      state = { state: 'error', checkedAt: Date.now(), error: detail }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // A timed-out sync must not keep writing behind a reported failure.
      abort.abort()
      if (this.slashCommandSyncAbort === abort) this.slashCommandSyncAbort = undefined
    }
    // A background sync can outlive its connection (shutdown/reconnect).
    if (this.channel !== channel) return
    this.slashCommandSyncState = state
    if (state.state === 'ok') {
      this.ctx.logger?.info?.('dsh-channels: slash command panel synced (%d commands, %d created, %d updated, %d removed)', state.total, state.created, state.updated, state.removed)
    } else {
      this.ctx.logger?.warn?.('dsh-channels: 飞书原生斜杠指令面板同步失败（直接输入命令不受影响）：%s', state.error)
    }
  }

  /**
   * Compare the app's granted scopes with what the plugin uses and log the
   * missing ones. Never throws; waits for the owner lookup so the app-info
   * need reflects its outcome.
   */
  private async runScopeCheck(channel: FeishuChannel, appId: string, ownerLookup: Promise<void>): Promise<void> {
    this.scopeCheckState = undefined
    if (channel.grantedScopes === undefined) return
    await ownerLookup
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: ScopeCheckWire
    try {
      const grants = await Promise.race([
        channel.grantedScopes(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时（${SCOPE_CHECK_TIMEOUT_MS} ms）`)), SCOPE_CHECK_TIMEOUT_MS)
        }),
      ])
      const result = checkScopes(grants, appId, {
        dmEnabled: this.config.dmMode === 'open',
        requireMention: this.config.requireMention,
        ownerLookupFailed: this.config.accessMode === 'guarded'
          && this.configuredAdminUserId() === undefined
          && this.appOwner !== undefined && 'error' in this.appOwner && this.appOwner.apiRejected,
        slashCommandPanel: this.config.slashCommandPanel,
        sendFile: this.config.feishuTools.sendFile,
        wikiRead: this.config.feishuTools.wikiRead && this.config.wikiRoots.length > 0,
        wikiWrite: this.config.feishuTools.wikiWrite && this.config.wikiRoots.length > 0,
      })
      state = result.consoleUrl === undefined
        ? { state: 'ok', checkedAt: Date.now() }
        : {
            state: 'missing',
            checkedAt: Date.now(),
            missing: result.missing.map(item => ({
              scopes: [...item.anyOf], level: item.level, purpose: item.purpose, consoleUrl: item.consoleUrl,
            })),
            consoleUrl: result.consoleUrl,
          }
    } catch (error) {
      const detail = error instanceof FeishuApiError ? error.detail : messageOf(error)
      state = { state: 'error', checkedAt: Date.now(), error: detail }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    // A background check can outlive its connection (shutdown/reconnect).
    if (this.channel !== channel) return
    this.scopeCheckState = state
    if (state.state === 'ok') {
      this.ctx.logger?.info?.('dsh-channels: scope self-check passed')
    } else if (state.state === 'missing') {
      const lines = state.missing.map(item => `${item.level === 'required' ? '必需' : '可选'} ${item.scopes.join(' 或 ')}：${item.purpose}`)
      this.ctx.logger?.warn?.('dsh-channels: 飞书权限缺失 %d 项，开通后需发布新版本（%s）：\n  %s', state.missing.length, state.consoleUrl, lines.join('\n  '))
    } else {
      this.ctx.logger?.warn?.('dsh-channels: 飞书权限自检失败：%s', state.error)
    }
  }

  /** Trim + bound one panel-supplied identifier; rejects control characters. */
  private cleanAccessTargetId(raw: string): string | undefined {
    const value = raw.trim()
    if (value === '' || value.length > 128) return undefined
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined
    return value
  }

  /** Same normalization for user ids, which must be Feishu `user_id`s. */
  private cleanAccessUserId(raw: string): string | undefined {
    const value = this.cleanAccessTargetId(raw)
    if (value === undefined || !FEISHU_USER_ID_PATTERN.test(value)) return undefined
    return value
  }

  /** Aggregate health used by `/health` and the Web settings panel. */
  health(): HealthSnapshot { return this.healthSnapshot() }

  /**
   * Credential facts for the panel's credential refs. Values are never returned:
   * `describe()` reports presence/source/writability only.
   */
  async credentialStates(): Promise<Record<CredentialField, CredentialInfo>> {
    const provider = this.credentialProvider()
    const read = async (ref: string): Promise<CredentialInfo> => {
      try {
        if (provider?.describe !== undefined) {
          const info = await provider.describe(ref)
          return {
            configured: info?.configured === true,
            writable: info?.writable !== false && provider.set !== undefined,
            ...(info?.source === undefined ? {} : { source: info.source }),
          }
        }
        if (provider === undefined) {
          const ambient = process.env[ref]
          return { configured: ambient !== undefined && ambient !== '', writable: false }
        }
        return { configured: (await provider.resolve(ref)) !== undefined, writable: provider.set !== undefined }
      } catch {
        return { configured: false, writable: false }
      }
    }
    const [appId, appSecret, analyzeToken] = await Promise.all([
      read(this.config.appId), read(this.config.appSecret), read(this.config.analyzeToken),
    ])
    return { appId, appSecret, analyzeToken }
  }

  /** The host credentials seam, when mounted. */
  private credentialProvider(): CredentialProvider | undefined {
    return this.ctx.get?.('credentials') as CredentialProvider | undefined
  }

  /** Store one credential value through the host seam; the value is never logged. */
  async setCredential(field: CredentialField, value: string): Promise<void> {
    const provider = this.credentialProvider()
    if (provider?.set === undefined) {
      throw new Error('主机的凭据服务不可写（未挂载 credentials.set，或当前提供方只读）')
    }
    const ref = this.credentialRef(field)
    try {
      await provider.set(ref, value)
    } catch (error) {
      throw new Error(`写入凭据引用 ${ref} 失败：${messageOf(error)}`)
    }
    await this.refreshReadiness()
  }

  /** Remove the stored value of one credential reference. */
  async clearCredential(field: CredentialField): Promise<void> {
    const provider = this.credentialProvider()
    if (provider?.unset === undefined) {
      throw new Error('主机的凭据服务不支持移除凭据')
    }
    const ref = this.credentialRef(field)
    try {
      await provider.unset(ref)
    } catch (error) {
      throw new Error(`移除凭据引用 ${ref} 失败：${messageOf(error)}`)
    }
    await this.refreshReadiness()
  }

  /** The overlay-independent ref name backing one editable credential slot. */
  private credentialRef(field: CredentialField): string {
    switch (field) {
      case 'appId': return this.config.appId
      case 'appSecret': return this.config.appSecret
      case 'analyzeToken': return this.config.analyzeToken
    }
  }

  /** Wire events and open the long connection. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // 1. Resolve credentials through the host seam (env > .credentials.yaml > .env).
    const appId = await resolveCredentialRef(this.ctx, this.config.appId)
    const appSecret = await resolveCredentialRef(this.ctx, this.config.appSecret)

    // 2. Build the channel with the resolved secrets.
    const channel = this.channelFactory({
      appId,
      appSecret,
      loggerLevel: this.config.loggerLevel,
      requireMention: this.config.requireMention,
      dmMode: this.config.dmMode,
    })
    this.channel = channel
    const hooks: StreamerHooks = {
      measureContext: session => this.measureContext(session),
      projectStats: session => this.projectCardStats(session),
      sessionLabel: sessionId => sessionId,
      onError: (_key, error) => {
        this.ctx.logger?.warn?.('dsh-channels stream error: %s', String(error))
      },
      onTurnFinalized: (_sessionId, _turn, mainCardMessageId) => {
        // The turn settled (final patches fired, reaction swap requested):
        // retire its repair snapshot. Kept deliberately non-awaited — repair
        // state is a safety net, never a dependency of the turn lifecycle.
        void this.repair.clear(mainCardMessageId)
      },
      onSegmentDelivered: (mainCardMessageId, segmentIndex, messageId, mode) => {
        void this.repair.recordSegment(mainCardMessageId, segmentIndex, messageId, mode)
      },
      sendSegmentCard: (sessionId, segment, card, fallbackText) =>
        this.delivery.segmentCard(sessionId, segment, card, fallbackText),
    }
    this.streamer = new TurnStreamer(
      channel,
      this.config.refreshMs,
      hooks,
      this.config.statusRefreshMs,
    )

    this.domain = await openFeishuDomain(this.ctx)
    this.routes.load()
    this.accessStore.load()

    // HITL: answer the host's approval/request waterfall for sessions this
    // channel routes. `prepend` claims such requests BEFORE the web gateway's
    // generic answerer (its panel would be invisible to a Feishu user), while
    // non-owned sessions delegate through `next()`.
    const answerer = new ApprovalAnswerer(channel, {
      routeFor: sessionId => this.approvalRouteFor(sessionId),
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels approval error (session %s): %s', sessionId, String(error))
      },
      onWaitingChange: (sessionId, toolNames) => {
        this.streamer?.setAwaitingApproval(sessionId, toolNames)
      },
    }, this.config.approvalTimeoutMs)
    this.approvalAnswerer = answerer
    this.unlistenApproval = this.ctx.on('approval/request', (req, next) => answerer.onRequest(req, next), { prepend: true })
    // Structured questions (`ask_user_question`): the host's only shipped
    // answerer is the Web client, so a Feishu-only session would otherwise
    // fail every ask with NO_PROVIDER.
    const questions = new QuestionAnswerer(channel, {
      routeFor: sessionId => this.approvalRouteFor(sessionId),
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels question error (session %s): %s', sessionId, String(error))
      },
    }, this.config.questionTimeoutMs)
    this.questionAnswerer = questions
    this.unlistenQuestions = this.ctx.on(
      'user-questions/request',
      (request, next) => questions.onRequest(request, next),
      { prepend: true },
    )
    const accessRequests = new AccessRequests({
      config: () => this.accessConfig(),
      store: this.accessStore,
      channel: () => this.channel,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.accessRequests = accessRequests
    this.unlistenBotAdded = channel.onBotAdded(event => {
      void accessRequests.handleBotAdded(event).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels: bot-added group info card failed: %s', String(error))
      })
    })
    void accessRequests.expirePending().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: access request expiry sweep failed: %s', String(error))
    })
    this.unlistenCardAction = channel.onCardAction(event => {
      void accessRequests.onCardAction(event)
      answerer.onCardAction(event)
      questions.onCardAction(event)
      this.wikiConsent.onCardAction(event)
      this.onStopAction(event)
      this.onSteerAction(event)
      void this.onPickAction(event).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels: picker card action failed: %s', String(error))
      })
    })

    this.unlistenHost.push(this.ctx.on('session/event', (session, event) => {
      this.streamer?.onSessionEvent(session, event)
      this.approvalAnswerer?.onSessionEvent(session.id, event)
    }))
    // DSH removed the durable `assistant/chunk` event (format v2 embeds the
    // stream in the settlement); the live deltas arrive here instead.
    this.unlistenHost.push(this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.streamer?.onAssistantFrame(agent.session, frame)
    }))
    this.unlisten = channel.onMessage(message => {
      void this.inbound.handle(message).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels inbound error: %s', String(error))
        // User-facing safety net: never leave the user without a reply.
        void channel
          .send(message.chatId, { text: `dsh-channels 处理失败：${String(error)}` }, { replyTo: message.messageId })
          .catch(() => {})
      })
    })
    // Without a configured administrator, resolve the owner before the
    // handshake so the first inbound message already sees the fallback; with
    // one, the lookup only backs a later runtime clear and must not delay boot.
    const ownerLookup = this.resolveAppOwner(channel)
    if (this.configuredAdminUserId() === undefined) await ownerLookup
    await channel.connect()
    // Background: the results only feed the panel and the log.
    void this.runScopeCheck(channel, appId, ownerLookup)
    if (this.config.slashCommandPanel) void this.runSlashCommandSync(channel)
    // Before the listener opens, so every `running` record left is a previous instance's.
    await this.analyzeLauncher.markInterrupted()
    await this.openAnalyzeListener()
    // Repair cards a previous instance left mid-flight (best-effort, background).
    void this.repair.repairAll().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: inflight repair failed: %s', String(error))
    })
    // Record GC: one sweep right after boot, then a slow periodic sweep.
    // Dedup records are pruned unconditionally (fixed retention); route
    // records of deleted topics (their thread id never reappears) are pruned
    // when `routeTtlMs` is enabled.
    void this.gcExpiredEntries().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: record GC failed: %s', String(error))
    })
    const timer = setInterval(() => {
      void this.gcExpiredEntries().catch(() => {})
    }, GC_SWEEP_INTERVAL_MS)
    timer.unref?.()
    this.gcTimer = timer
    this.ctx.logger?.info?.(
      'dsh-channels: feishu long connection established (bot open_id %s, %d route(s) loaded)',
      channel.botOpenId() ?? 'unknown',
      this.routes.size(),
    )
    console.info('[dsh-channels] feishu long connection established, bot open_id:', channel.botOpenId())
    console.info('[dsh-channels] activity build:', ACTIVITY_BUILD_MARKER)
    this.startedAt = Date.now()
    console.info('[dsh-channels] model request overrides:', {
      provider: this.config.provider ?? 'deployment-default',
      model: this.config.model ?? 'deployment-default',
      reasoningEffort: this.config.reasoningEffort ?? 'adapter-default',
    })
    if (this.config.accessMode === 'open') {
      console.warn('[dsh-channels] 准入=open：任何应用可用范围内的用户都可以对话（不安全，仅调试）')
    } else if (this.effectiveAdminUserId() === undefined) {
      const ownerError = this.appOwner !== undefined && 'error' in this.appOwner ? this.appOwner.error : undefined
      console.warn(
        '[dsh-channels] 准入=guarded 但未配置管理员 user_id，也无法使用应用所有者兜底：所有对话都会被拒绝；'
        + '私聊机器人发送 /userid 取得 user_id 后填入 Web 设置面板'
        + (ownerError === undefined ? '' : `（${ownerError}）`),
      )
    } else if (this.configuredAdminUserId() === undefined) {
      console.info('[dsh-channels] 准入=guarded，未配置管理员，使用应用所有者', this.effectiveAdminUserId())
    } else {
      console.info('[dsh-channels] 准入=guarded，管理员已配置')
    }
    const approvalMounted = this.ctx.get?.('approval') !== undefined
    console.info(
      approvalMounted
        ? `[dsh-channels] HITL 审批应答已就绪（决策卡片超时 ${this.config.approvalTimeoutMs} ms）`
        : '[dsh-channels] 主机未挂载 approval 服务，HITL 审批应答关闭',
    )
    const questionsMounted = this.ctx.get?.('userQuestions') !== undefined
    console.info(
      questionsMounted
        ? `[dsh-channels] ask_user_question 应答已就绪（提问卡片超时 ${this.config.questionTimeoutMs} ms）`
        : '[dsh-channels] 主机未挂载 userQuestions 服务，结构化提问应答关闭',
    )
  }

  /**
   * Bind the analyze listener when `analyzeListen` is set. A bind failure is
   * logged and folded into the health snapshot (panel reasons, `/health`); the Feishu connection stays up.
   */
  private async openAnalyzeListener(): Promise<void> {
    this.analyzeListenError = undefined
    const listen = this.config.analyzeListen
    if (listen === undefined) return
    try {
      this.analyzeServer = await startAnalyzeServer(
        listen,
        this.analyzeLauncher,
        (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
      )
      console.info('[dsh-channels] 日志分析接口已监听', listen)
    } catch (error) {
      this.analyzeListenError = messageOf(error)
      this.ctx.logger?.error?.('dsh-channels: analyze listener on %s failed: %s', listen, this.analyzeListenError)
      console.error('[dsh-channels] 日志分析接口监听失败:', listen, error)
    }
  }

  /** Tear down: close the connection and dispose all live agents. */
  async shutdown(): Promise<void> {
    // Close admission first. In-flight Host commands receive cancellation
    // before their Agent/channel/storage dependencies are disposed, while
    // already queued route operations observe `started === false` and retire.
    this.started = false
    const analyzeServer = this.analyzeServer
    this.analyzeServer = undefined
    await analyzeServer?.close()
    await this.analyzeLauncher.drain()
    for (const controller of this.commandControllers) controller.abort()
    await Promise.allSettled([...this.commandOperations])
    this.commandControllers.clear()
    this.commandOperations.clear()
    this.unlisten?.()
    this.unlisten = undefined
    this.unlistenCardAction?.()
    this.unlistenCardAction = undefined
    this.unlistenBotAdded?.()
    this.unlistenBotAdded = undefined
    this.accessRequests?.clear()
    this.accessRequests = undefined
    this.accessController.clear()
    this.unlistenApproval?.()
    this.unlistenApproval = undefined
    this.unlistenQuestions?.()
    this.unlistenQuestions = undefined
    // Host-scoped listeners must be released on every teardown: a failed
    // connect retry or a reconnect calls `start()` again, and a leaked pair
    // would feed the same session events into the streamer twice.
    for (const dispose of this.unlistenHost.splice(0)) dispose()
    // Withdraw in-flight approval questions (the host settles them cancelled).
    this.approvalAnswerer?.dispose()
    this.approvalAnswerer = undefined
    this.questionAnswerer?.dispose()
    this.wikiConsent.dispose()
    this.questionAnswerer = undefined
    if (this.gcTimer !== undefined) {
      clearInterval(this.gcTimer)
      this.gcTimer = undefined
    }
    await this.sessions.disposeAll()
    this.attachmentFetchTools.clear()
    this.routeOperations.clear()
    this.inbound.clear()
    this.routes.clear()
    this.accessStore.clear()
    try {
      await this.channel?.disconnect()
    } catch {
      // Already disconnected is fine.
    }
    this.channel = undefined
    this.streamer?.detachAll()
    this.streamer = undefined
    await this.domain?.close()
    this.domain = undefined
    this.runningConfig = undefined
    this.appOwner = undefined
    this.scopeCheckState = undefined
    this.slashCommandSyncState = undefined
    this.slashCommandSyncAbort?.abort()
    this.slashCommandSyncAbort = undefined
  }

  // ---- inbound routing -------------------------------------------------

  
  /** Slash-command plane. Nothing in this method calls `agent.followup()`. */
  /**
   * Slash-command admission. The command vocabulary and its admission rules
   * come from the command registry; nothing here calls `agent.followup()`.
   */
  private async handleSlashMessage(msg: NormalizedMessage, line: string): Promise<void> {
    if (!this.started) return
    const parsed = parseSlashCommand(line)
    // Channel-plane command admission runs before ANY card/topic/side effect:
    // denied senders get at most a fixed private-chat notice (or silence in
    // groups), never an unknown-command card or a command thread.
    if (!(await this.accessController.admitCommand(msg, parsed?.name))) return
    if (parsed === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'input-error',
        text: '命令名必须以小写字母开头，且只能包含小写字母、数字、下划线或连字符。',
        supported: supportedCommandList(),
      })
      return
    }
    const spec = commandSpec(parsed.name)
    if (spec === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'unknown', command: parsed.name,
        text: `未找到命令 /${parsed.name}。`, supported: supportedCommandList(),
      })
      return
    }

    // `/auth` is administrator-only, route-free, and handled right here so it
    // works even inside an unauthorized group (that is the "authorize from
    // the conversation" entry point).
    if (spec.name === 'auth') {
      await this.runAuthCommand(msg, parsed)
      return
    }

    // Route-free commands answer without any Session work.
    if (spec.routeFree === true) {
      await this.runRouteFreeCommand(spec, msg, parsed)
      return
    }

    // A TTL-retired topic is permanently closed except for session-optional
    // diagnostics (`/health`).
    const expiredRoute = msg.threadId === undefined ? undefined : this.routes.expiredRoute(msg.threadId)
    if (expiredRoute !== undefined) {
      if (spec.sessionOptional === true) {
        await this.runRouteFreeCommand(spec, msg, parsed)
        return
      }
      await this.delivery.expiredRouteCard(msg, parsed.name)
      return
    }

    const route = await this.inbound.resolveRoute(msg)
    if (route === undefined) {
      if (spec.sessionOptional === true) {
        await this.runRouteFreeCommand(spec, msg, parsed)
        return
      }
      await this.delivery.commandCard(msg, {
        kind: 'unbound', command: parsed.name,
        text: '当前话题尚未绑定 Session。请先发送普通消息创建会话，或使用 /health 检查通道。',
      })
      return
    }

    if (!this.accessController.ownsRoute(msg, route)) {
      await this.delivery.commandCard(msg, {
        kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
      })
      return
    }

    const operation = this.routeOperations.run(route.key, async () => {
      if (!this.started) return
      const current = this.routes.get(route.key) ?? route
      if (!this.accessController.ownsRoute(msg, current)) {
        await this.delivery.commandCard(msg, {
          kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
        })
        return
      }
      await this.runRouteCommand(spec, msg, parsed, current)
    })
    this.commandOperations.add(operation)
    try {
      await operation
    } finally {
      this.commandOperations.delete(operation)
    }
  }

  /**
   * `/auth`: administrator-only access management on the channel plane. It
   * never creates a Session or resumes an Agent; every reply is a fixed card.
   */
  private async runAuthCommand(msg: NormalizedMessage, parsed: ParsedSlashCommand): Promise<void> {
    if (!this.accessController.isAdmin(msg.senderId)) return
    const direct = { createThread: false }
    const words = parsed.rawInput.trim().split(/\s+/u).filter(word => word !== '')
    const action = words[0] ?? 'status'
    const now = Date.now()
    try {
      if (action === 'status') {
        const groups = this.accessStore.groupRecords()
        const users = this.accessStore.userRecords()
        const pending = this.accessStore.pendingRequests()
        await this.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 访问授权状态**', [
          `**准入模式**：\`${this.config.accessMode}\``,
          `**管理员**：${this.adminStatusLine()}`,
          ...(msg.chatType === 'group'
            ? [`**本群**：${this.accessStore.hasGroup(msg.chatId) ? '已授权' : '未授权'}（\`${msg.chatId}\`）`]
            : []),
          `**白名单**：群 ${groups.length} 个 · 用户 ${users.length} 个 · 知识库 ${this.accessStore.wikiUserRecords().length} 个 · 待处理申请 ${pending.length} 个`,
          '群授权：`/auth allow` 或 `/auth revoke`（在目标群内发）；用户授权：`/auth user add @用户` 或 `/auth user add <user_id>`；知识库授权：`/auth wiki add @用户`。',
        ]), direct)
        return
      }
      if (action === 'allow' || action === 'revoke') {
        if (msg.chatType !== 'group') {
          await this.delivery.commandCard(msg, {
            kind: 'input-error', command: 'auth',
            text: '群授权命令只能在群聊中使用：在目标群里发送 /auth allow 或 /auth revoke。',
          }, direct)
          return
        }
        if (action === 'allow') {
          if (this.accessStore.hasGroup(msg.chatId)) {
            await this.delivery.commandCard(msg, {
              kind: 'success', command: 'auth', text: `本群已经授权（\`${msg.chatId}\`）。`,
            }, direct)
            return
          }
          let name: string | undefined
          try {
            name = (await this.channel?.getChatInfo(msg.chatId))?.name
          } catch {
            name = undefined
          }
          await this.accessStore.addGroup({
            chatId: msg.chatId,
            ...(name === undefined || name === '' ? {} : { name }),
            source: 'command',
            addedBy: msg.senderId,
            addedAt: now,
          })
          await this.delivery.commandCard(msg, {
            kind: 'success', command: 'auth',
            text: '✅ 已授权本群。群内只有管理员与已授权用户能与我对话。',
          }, direct)
          return
        }
        const removed = await this.accessStore.removeGroup(msg.chatId)
        await this.delivery.commandCard(msg, {
          kind: removed ? 'success' : 'unavailable', command: 'auth',
          text: removed ? '已撤销本群授权，立即生效。' : '本群当前未被授权。',
        }, direct)
        return
      }
      if (action === 'user') {
        const sub = words[1]
        const target = sub === 'add' || sub === 'remove'
          ? resolveAuthUserTarget(words.slice(2).join(' '), msg.mentions, this.channel?.botOpenId())
          : { ok: false as const, reason: 'usage' as const }
        if (!target.ok) {
          await this.delivery.commandCard(msg, {
            kind: 'input-error', command: 'auth', text: AUTH_USER_TARGET_ERRORS[target.reason],
          }, direct)
          return
        }
        const { userId } = target
        const label = target.name === undefined ? `\`${userId}\`` : `${target.name}（\`${userId}\`）`
        if (sub === 'add') {
          if (this.accessStore.hasUser(userId)) {
            await this.delivery.commandCard(msg, {
              kind: 'success', command: 'auth', text: `该用户已在白名单中：${label}。`,
            }, direct)
            return
          }
          await this.accessStore.addUser({
            userId,
            ...(target.name === undefined ? {} : { name: target.name }),
            source: 'command', addedBy: msg.senderId, addedAt: now,
          })
          await this.delivery.commandCard(msg, {
            kind: 'success', command: 'auth',
            text: `✅ 已授权用户 ${label}（在所有已授权群里生效）。`,
          }, direct)
          return
        }
        const removed = await this.accessStore.removeUser(userId)
        await this.delivery.commandCard(msg, {
          kind: removed ? 'success' : 'unavailable', command: 'auth',
          text: removed ? `已移除用户 ${label}，立即生效。` : `用户 ${label} 不在白名单中。`,
        }, direct)
        return
      }
      if (action === 'wiki') {
        const sub = words[1]
        const target = sub === 'add' || sub === 'remove'
          ? resolveAuthUserTarget(words.slice(2).join(' '), msg.mentions, this.channel?.botOpenId())
          : { ok: false as const, reason: 'usage' as const }
        if (!target.ok) {
          await this.delivery.commandCard(msg, {
            kind: 'input-error', command: 'auth',
            text: target.reason === 'usage' ? AUTH_WIKI_USAGE : AUTH_USER_TARGET_ERRORS[target.reason],
          }, direct)
          return
        }
        const { userId } = target
        const label = target.name === undefined ? `\`${userId}\`` : `${target.name}（\`${userId}\`）`
        if (sub === 'add') {
          if (this.accessStore.hasWikiUser(userId)) {
            await this.delivery.commandCard(msg, {
              kind: 'success', command: 'auth', text: `该用户已在知识库白名单中：${label}。`,
            }, direct)
            return
          }
          await this.accessStore.addWikiUser({
            userId,
            ...(target.name === undefined ? {} : { name: target.name }),
            source: 'command', addedBy: msg.senderId, addedAt: now,
          })
          await this.delivery.commandCard(msg, {
            kind: 'success', command: 'auth',
            text: `✅ 已把 ${label} 加入知识库白名单：他发起的话题里可以使用知识库工具（每次读取、新建、修改仍需他在授权卡上确认）。`,
          }, direct)
          return
        }
        const removed = await this.accessStore.removeWikiUser(userId)
        await this.delivery.commandCard(msg, {
          kind: removed ? 'success' : 'unavailable', command: 'auth',
          text: removed ? `已把 ${label} 移出知识库白名单，立即生效。` : `用户 ${label} 不在知识库白名单中。`,
        }, direct)
        return
      }
      if (action === 'list') {
        const groups = this.accessStore.groupRecords()
        const users = this.accessStore.userRecords()
        const pending = this.accessStore.pendingRequests()
        const groupLines = groups.length === 0
          ? ['（暂无）']
          : groups.slice(0, 30).map(group => `- ${group.name ?? group.chatId} \`${group.chatId}\``)
        const userLines = users.length === 0
          ? ['（暂无）']
          : users.slice(0, 30).map(user => `- ${user.name ?? user.userId} \`${user.userId}\``)
        const wikiUsers = this.accessStore.wikiUserRecords()
        const wikiLines = wikiUsers.length === 0
          ? ['（暂无；管理员始终可用）']
          : wikiUsers.slice(0, 30).map(user => `- ${user.name ?? user.userId} \`${user.userId}\``)
        await this.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 访问授权清单**', [
          `**已授权群（${groups.length}）**`,
          ...groupLines,
          `**已授权用户（${users.length}）**`,
          ...userLines,
          `**知识库白名单（${wikiUsers.length}）**`,
          ...wikiLines,
          `**待处理申请**：${pending.length} 个（可在 Web 设置面板处理）`,
        ]), direct)
        return
      }
      await this.delivery.commandCard(msg, {
        kind: 'input-error', command: 'auth',
        text: '用法：/auth [status|allow|revoke|list|user add <@用户|user_id>|user remove <@用户|user_id>|wiki add <@用户|user_id>|wiki remove <@用户|user_id>]',
      }, direct)
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: /auth failed: %s', String(error))
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: 'auth', text: `授权操作失败：${messageOf(error)}`,
      }, direct).catch(() => {})
    }
  }

  /** Answer one command that needs no Session (help / userid / groupid / health). */
  private async runRouteFreeCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
  ): Promise<void> {
    const createThread = spec.directReply !== true
    if (parsed.rawInput.trim() !== '') {
      await this.delivery.commandCard(msg, {
        kind: 'input-error', command: spec.name, text: `用法错误：/${spec.name} 不接受参数。`,
      }, { createThread })
      return
    }
    if (spec.mentionGate === true
      && msg.chatType === 'group'
      && msg.threadId === undefined
      && this.config.requireMention
      && !msg.mentionedBot) {
      return
    }
    if (spec.chatType !== undefined && msg.chatType !== spec.chatType) {
      await this.delivery.commandCard(msg, {
        kind: 'context-error', command: spec.name,
        text: spec.chatType === 'p2p'
          ? `命令 /${spec.name} 仅支持在私聊中使用。`
          : `命令 /${spec.name} 仅支持在群聊中使用。`,
      }, { createThread })
      return
    }
    await this.delivery.withCommandReaction(msg, async () => {
      switch (spec.name) {
        case 'help':
          await this.delivery.commandCard(msg, { kind: 'help', text: supportedCommandHelp() }, { createThread })
          return
        case 'userid':
          await this.delivery.commandCard(msg, {
            kind: 'success', command: spec.name, text: `当前用户 ID：\`${msg.senderId}\``,
          }, { createThread })
          return
        case 'groupid':
          await this.delivery.commandCard(msg, {
            kind: 'success', command: spec.name, text: `当前群组 ID：\`${msg.chatId}\``,
          }, { createThread })
          return
        case 'health':
          await this.delivery.standaloneReply(msg, buildHealthCard(this.healthSnapshot()), { createThread })
          return
        default:
          await this.delivery.commandCard(msg, {
            kind: 'unavailable', command: spec.name, text: `命令 /${spec.name} 暂不可用。`,
          }, { createThread })
      }
    })
  }

  /** Answer one route-bound command inside the per-route admission queue. */
  private async runRouteCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    await this.delivery.withCommandReaction(msg, async () => {
      try {
        if (spec.channelPlane === true) {
          await this.runChannelCommand(spec, msg, parsed, current)
          return
        }
        await this.runAgentCommand(spec, msg, parsed, current)
      } catch (error) {
        this.ctx.logger?.warn?.(
          'dsh-channels: command /%s failed for session %s: %s',
          spec.name, current.sessionId, String(error),
        )
        await this.delivery.commandCard(msg, {
          kind: 'internal-error', command: spec.name,
          text: '命令执行失败，请稍后重试；若持续发生，请查看 Harness 日志。',
          sessionId: current.sessionId,
        })
      }
    })
  }

  /**
   * Commands the channel answers itself. `/stop` aborts the live turn
   * directly and deliberately never cold-resumes a Session just to cancel
   * nothing.
   */
  private async runChannelCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    if (spec.name === 'permissions') {
      await this.runPermissionsCommand(msg, parsed, current)
      return
    }
    if (spec.name === 'stop') {
      const running = this.cancelTurn(current.sessionId)
      await this.delivery.commandCard(msg, {
        kind: 'success', command: 'stop', sessionId: current.sessionId,
        text: running ? '已请求停止当前回合。' : '当前没有正在运行的回合。',
      })
      return
    }
    await this.delivery.commandCard(msg, {
      kind: 'unavailable', command: spec.name, text: `命令 /${spec.name} 暂不可用。`,
      sessionId: current.sessionId,
    })
  }

  /**
   * Cancel one Session's live turn without resuming anything. Queued
   * messages stay in the inbox: each already has its own streaming card and
   * runs next.
   * @param sessionId The Session to cancel.
   * @returns Whether a turn was running.
   */
  private cancelTurn(sessionId: string): boolean {
    const agent = this.sessions.get(sessionId)?.agent
      ?? this.ctx.agents.get(sessionId as SessionId)
    const running = agent?.status === 'running'
    agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
    if (running) this.streamer?.markStopping(sessionId)
    return running
  }

  /**
   * Streaming-card stop button. Only the session owner, clicking inside the
   * session's own chat, cancels the turn; another operator gets the
   * owner-only notice on the card instead.
   */
  private onStopAction(event: CardActionEvent): void {
    if (!this.started) return
    if ((event.action.value as { decision?: unknown } | undefined)?.decision !== STOP_ACTION) return
    const sessionId = this.streamer?.stopTargetOf(event.messageId)
    if (sessionId === undefined) return
    const route = this.routes.findBySession(sessionId)
    if (route === undefined) return
    if (!this.accessController.mayActOnRoute(event.operator.userId, event.chatId, route)) {
      this.streamer?.markStopDenied(sessionId)
      return
    }
    this.cancelTurn(sessionId)
  }

  /**
   * Queued-card steer button: a user who may act on the route (the owner, or
   * any admitted member of a group-shared route), clicking inside the
   * session's own chat, moves the queued message out of the next-turn queue
   * and into the running turn's next step; another operator gets the
   * owner-only notice instead. A message the driver already claimed (its turn
   * started) or a turn that is stopping leaves the card to its own turn.
   */
  private onSteerAction(event: CardActionEvent): void {
    if (!this.started) return
    if ((event.action.value as { decision?: unknown } | undefined)?.decision !== STEER_ACTION) return
    const target = this.streamer?.steerTargetOf(event.messageId)
    if (target === undefined) return
    const route = this.routes.findBySession(target.sessionId)
    if (route === undefined) return
    if (!this.accessController.mayActOnRoute(event.operator.userId, event.chatId, route)) {
      this.streamer?.markQueuedDenied(event.messageId)
      return
    }
    const agent = this.sessions.get(target.sessionId)?.agent
      ?? this.ctx.agents.get(target.sessionId as SessionId)
    if (agent?.status !== 'running') return
    const merged = this.streamer?.mergeQueued(event.messageId, (_sessionId, message) => {
      if (!agent.inbox.remove(message.id)) return false
      agent.steer(message)
      return true
    }) === true
    // The queued card no longer owns a turn: retire its restart-repair snapshot.
    if (merged) void this.repair.clear(event.messageId)
  }

  /**
   * Picker-card click: run the chosen `/<command> <arg>` exactly as if the
   * operator had typed it under the picker card, so access admission, route
   * ownership and validation are the typed command's. The result replaces
   * the picker card in place instead of arriving as a new card. Stale pickers (the
   * topic was rebound, or the card was forwarded elsewhere) and non-owner
   * clicks are ignored.
   */
  private async onPickAction(event: CardActionEvent): Promise<void> {
    if (!this.started) return
    const action = parsePickAction(event.action.value)
    if (action === undefined) return
    const route = this.routes.findBySession(action.sessionId)
    const userId = event.operator.userId
    if (route === undefined || userId === undefined
      || !this.accessController.mayActOnRoute(userId, event.chatId, route)) return
    const line = `/${action.command} ${action.arg}`
    await this.delivery.replacingCard(event.messageId, () => this.handleSlashMessage({
      messageId: event.messageId,
      chatId: route.chatId,
      chatType: route.chatType,
      senderId: userId,
      content: line,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      ...(route.kind === 'thread' ? { threadId: route.key } : {}),
      createTime: Date.now(),
    }, line))
  }

  /**
   * `/permissions`: show this Session's effective sandbox+approval preset and
   * the selectable catalog; switch only when the deployment opted in.
   */
  private async runPermissionsCommand(
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    const presets = this.ctx.get?.('permissionPresets') as PermissionPresets | undefined
    if (presets === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
        text: '当前部署未挂载 permissionPresets 服务，无法查看权限预设。',
      })
      return
    }
    const live = await this.sessions.ensureLive(current)
    let active: string | undefined
    let catalogLine = ''
    let choices: PickerOption[] = []
    try {
      active = presets.current(live.agent.session)
      const catalog = presets.catalog()
      catalogLine = catalog.options.map(option => `\`${option.value}\``).join('、')
      choices = catalog.options.map(option => ({ label: option.name || option.value, arg: option.value }))
    } catch {
      active = undefined
    }
    const requested = parsed.rawInput.trim()
    if (requested === '' && this.config.allowPermissionSwitch && choices.length > 0) {
      await this.delivery.standaloneReply(msg, buildPickerCard({
        title: '🔐 权限预设',
        command: 'permissions',
        text: `**当前权限预设**：${active === undefined ? '暂无数据' : `\`${active}\``}\n切换会同时调整沙箱与审批策略。`,
        sessionId: current.sessionId,
        options: choices,
        ...(active === undefined ? {} : { current: active }),
      }))
      return
    }
    if (requested === '') {
      const lines = [
        `**当前权限预设**：${active === undefined ? '暂无数据' : `\`${active}\``}`,
        ...(catalogLine === '' ? [] : [`**可选预设**：${catalogLine}`]),
        ...(this.config.allowPermissionSwitch
          ? ['使用 `/permissions <name>` 切换；切换会同时调整沙箱与审批策略。']
          : ['当前部署未开启飞书侧切换（`allowPermissionSwitch: false`），仅支持查看。']),
      ]
      await this.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 权限预设**', lines))
      return
    }
    if (!this.config.allowPermissionSwitch) {
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
        text: '当前部署未开启飞书侧权限切换，仅支持 /permissions 查看。',
      })
      return
    }
    try {
      presets.set(live.agent.session, requested)
      await this.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 权限预设已切换**', [
        `**当前权限预设**：\`${requested}\``,
        '沙箱模式与审批策略已按该预设更新。',
      ]))
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: permission switch for session %s failed: %s', current.sessionId, String(error),
      )
      await this.delivery.commandCard(msg, {
        kind: 'input-error', command: 'permissions', sessionId: current.sessionId,
        text: `未知或不可用的权限预设：\`${requested}\`。可用：${catalogLine === '' ? '暂无数据' : catalogLine}`,
      })
    }
  }

  /**
   * Execute one command through the agent command plane: resolve the live
   * agent, mount borrowed channel commands when needed, arm the channel-scoped
   * `/renew` and `/effort` handlers, then render the settled result.
   */
  private async runAgentCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    // An alias (`/new`) resolves to this canonical spec; execute the canonical
    // line so the agent command plane finds the registered definition.
    const line = `/${spec.name}${parsed.rawInput}`
    const live = await this.sessions.ensureLive(current)
    let definition = this.ctx.commands.find(live.agent, spec.name)
    let unregisterBorrowedCommand: (() => void) | undefined
    if (definition === undefined && spec.name === 'renew') {
      unregisterBorrowedCommand = registerRenewCommand(live.agent.ctx.commands)
      definition = this.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined && spec.name === 'effort') {
      unregisterBorrowedCommand = registerEffortCommand(live.agent.ctx.commands)
      definition = this.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined && spec.name === 'model') {
      unregisterBorrowedCommand = registerModelCommand(live.agent.ctx.commands)
      definition = this.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined) {
      unregisterBorrowedCommand?.()
      const text = spec.name === 'compact'
        ? '当前部署未挂载 Harness 原生 /compact 命令。'
        : `当前 Session 未挂载 /${spec.name} 命令。`
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name, text, sessionId: current.sessionId,
      })
      return
    }
    const compactBefore = spec.name === 'compact'
      ? await this.measureCommandContext(live.agent.session)
      : undefined
    const controller = new AbortController()
    this.commandControllers.add(controller)
    const renewAdmission: RenewAdmission | undefined = spec.name === 'renew'
      ? { route: current, live }
      : undefined
    const effortAdmission: EffortAdmission | undefined = spec.name === 'effort'
      ? { live, controller: this.sessions.requestPolicy(live.agent) }
      : undefined
    const modelAdmission: ModelAdmission | undefined = spec.name === 'model'
      ? { live, controller: this.sessions.requestPolicy(live.agent) }
      : undefined
    const disarmRenew = renewAdmission === undefined
      ? undefined
      : armRenewCommand(controller.signal, invocation => this.runRenewCommand(invocation, renewAdmission))
    const disarmEffort = effortAdmission === undefined
      ? undefined
      : armEffortCommand(
          controller.signal,
          (invocation, action) => this.runEffortCommand(invocation, action, effortAdmission),
        )
    const disarmModel = modelAdmission === undefined
      ? undefined
      : armModelCommand(
          controller.signal,
          (invocation, rawInput) => this.runModelCommand(invocation, rawInput, modelAdmission),
        )
    let execution
    try {
      execution = await this.ctx.commands.execute(live.agent, line, [], controller.signal)
    } finally {
      this.commandControllers.delete(controller)
      disarmRenew?.()
      disarmEffort?.()
      disarmModel?.()
      unregisterBorrowedCommand?.()
      if (renewAdmission?.commit !== undefined) {
        await this.sessions.releaseRenewed(renewAdmission.commit)
      }
    }
    if (controller.signal.aborted || !this.started) return
    if (execution === undefined) {
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name,
        text: `当前 Session 无法执行 /${spec.name}。`, sessionId: current.sessionId,
      })
      return
    }
    await this.renderCommandResult({
      spec, msg, current, live,
      bare: parsed.rawInput.trim() === '',
      result: execution.result,
      compactBefore,
      renewAdmission,
      effortAdmission,
      modelAdmission,
    })
  }

  /** Render one settled agent-plane command result. */
  private async renderCommandResult(input: {
    spec: ChannelCommandSpec
    msg: NormalizedMessage
    current: RouteRecord
    live: LiveAgent
    /** The command was typed without arguments. */
    bare: boolean
    result: CommandResult
    compactBefore: ContextMeasurement | undefined
    renewAdmission: RenewAdmission | undefined
    effortAdmission: EffortAdmission | undefined
    modelAdmission: ModelAdmission | undefined
  }): Promise<void> {
    const { spec, msg, current, live, result, compactBefore, renewAdmission, effortAdmission, modelAdmission } = input
    if (spec.name === 'effort') effortAdmission?.controller.sync(live.agent.session.snapshotEvents())
    if (spec.name === 'model') modelAdmission?.controller.sync(live.agent.session.snapshotEvents())
    if (input.bare && result.kind === 'success') {
      const picker = spec.name === 'model' && modelAdmission !== undefined
        ? await this.modelPicker(current, live, modelAdmission)
        : spec.name === 'effort' && effortAdmission !== undefined
          ? await this.effortPicker(current, live, effortAdmission, result.text ?? '')
          : undefined
      if (picker !== undefined) {
        await this.delivery.standaloneReply(msg, picker)
        return
      }
    }
    if (spec.name === 'renew' && result.kind === 'success' && renewAdmission?.commit !== undefined) {
      await this.delivery.standaloneReply(msg, buildRenewCard({
        previousSessionId: renewAdmission.commit.previous.sessionId,
        currentSessionId: renewAdmission.commit.current.sessionId,
        sessionDir: sessionDirOf(renewAdmission.commit.current),
      }))
      return
    }
    if (spec.name === 'health' && result.kind === 'success') {
      await this.delivery.standaloneReply(msg, buildHealthCard(this.healthSnapshot()), { createThread: false })
      return
    }
    if (spec.name === 'status' && result.kind === 'success') {
      const session = live.agent.session
      const stats = foldSessionStats(session, this.projectionRegistry())
      const context = await measureSessionContext(
        session, this.commandContextServices(), stats.lastHeader,
      )
      await this.delivery.standaloneReply(msg, buildSessionStatusCard({
        sessionId: current.sessionId,
        stats,
        context,
        extras: {
          permissionPreset: this.permissionPresetOf(session),
          sessionDir: sessionDirOf(current),
          uptimeMs: this.startedAt === undefined ? undefined : Date.now() - this.startedAt,
          liveAgents: this.sessions.liveCount(),
          routeCount: this.routes.size(),
        },
      }))
      return
    }
    if (spec.name === 'workspace' && result.kind === 'success') {
      const resolved = resolveWorkDir(live.agent.session.header.cwd, {
        workspacePath: current.workspacePath,
        ...(current.sessionDir === undefined ? {} : { sessionDir: current.sessionDir }),
      })
      if (resolved.kind === 'success') {
        await this.delivery.standaloneReply(msg, buildWorkDirCard(current.sessionId, resolved.path))
        return
      }
      if (resolved.kind === 'mismatch') {
        this.ctx.logger?.warn?.(
          'dsh-channels: workspace mismatch for session %s (paths redacted)', current.sessionId,
        )
      }
      await this.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name,
        text: resolved.text, sessionId: current.sessionId,
      })
      return
    }
    if (spec.name === 'history' && result.kind === 'success') {
      await this.delivery.standaloneReply(msg, buildSessionHistoryCard(
        current, await this.sessionHistoryAnnotations(current),
      ))
      return
    }
    if (spec.name === 'export' && result.kind === 'success') {
      try {
        const file = await this.sessionExportBuilder(live.agent.session)
        await this.delivery.requireChannel().send(msg.chatId, { file }, {
          replyTo: msg.messageId,
          replyInThread: true,
        })
      } catch (error) {
        this.ctx.logger?.warn?.(
          'dsh-channels: logical export delivery failed for session %s: %s',
          current.sessionId, String(error),
        )
        await this.delivery.commandCard(msg, {
          kind: 'internal-error', command: spec.name,
          text: 'Session 逻辑日志导出失败，未交付文件；请稍后重试并查看 Harness 日志。',
          sessionId: current.sessionId,
        })
      }
      return
    }
    if (spec.name === 'compact' && compactBefore !== undefined) {
      const compactAfter = await this.measureCommandContext(live.agent.session)
      if (result.kind === 'success') {
        await this.delivery.standaloneReply(msg, buildCompactComparisonCard({
          sessionId: current.sessionId,
          resultText: result.text ?? '命令已执行。',
          before: compactBefore,
          after: compactAfter,
        }))
        return
      }
      await this.delivery.commandCard(msg, {
        kind: commandResultCardKind(result), command: spec.name,
        text: `${result.text}\n\n${compactFailureContext(compactBefore, compactAfter)}`,
        sessionId: current.sessionId,
      })
      return
    }
    await this.delivery.commandCard(msg, {
      kind: commandResultCardKind(result), command: spec.name,
      text: result.text ?? '命令已执行。', sessionId: current.sessionId,
    })
  }

  /**
   * Annotate a route's session history with host-query facts: the latest
   * log-backed title per session and whether it is currently live. Both are
   * best-effort — a missing or failing `sessionQuery` only drops the titles.
   */
  private async sessionHistoryAnnotations(record: RouteRecord): Promise<Record<string, SessionHistoryAnnotation>> {
    const ids = normalizeSessionHistory(record)
      .slice(-SESSION_HISTORY_DISPLAY_LIMIT)
      .map(entry => entry.sessionId)
    const annotations: Record<string, SessionHistoryAnnotation> = {}
    for (const id of ids) {
      annotations[id] = { live: this.sessions.get(id) !== undefined || this.ctx.agents.get(id as SessionId) !== undefined }
    }
    const query = this.ctx.get?.('sessionQuery') as SessionQuery | undefined
    if (query === undefined) return annotations
    try {
      const results = await query.readTitleSnapshots(ids as SessionId[])
      for (const item of results) {
        if (item.status !== 'fulfilled' || item.value.title === undefined) continue
        annotations[item.sessionId] = { ...annotations[item.sessionId], title: item.value.title.title }
      }
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: session title lookup failed: %s', String(error))
    }
    return annotations
  }

  /** Effective permission preset of one Session, when the service is mounted. */
  private permissionPresetOf(session: Session): string | undefined {
    const presets = this.ctx.get?.('permissionPresets') as PermissionPresets | undefined
    try {
      return presets?.current(session)
    } catch {
      return undefined
    }
  }

  /** Optional diagnostic services resolved without topology-sensitive property access. */
  private commandContextServices(): ContextServices {
    return {
      tokenMeter: this.ctx.get?.('tokenMeter') as TokenMeter | undefined,
      llm: this.ctx.get?.('llm') as LlmService | undefined,
    }
  }

  /** Exact command-time measurement shared by `/status` and `/compact`. */
  private measureCommandContext(session: Session): Promise<ContextMeasurement> {
    return measureSessionContext(session, this.commandContextServices())
  }

  /** Capture aggregate health only; raw configuration and errors are excluded. */
  private healthSnapshot(): HealthSnapshot {
    const serviceKeys: Record<HealthDependencyName, string> = {
      agents: 'agents',
      commands: 'commands',
      workspace: 'workspaceRegistry',
      storage: 'storageDomain',
      credentials: 'credentials',
      llm: 'llm',
      'token-meter': 'tokenMeter',
    }
    const directServices: Record<HealthDependencyName, () => unknown> = {
      agents: () => this.ctx.agents,
      commands: () => this.ctx.commands,
      workspace: () => this.ctx.workspaceRegistry,
      storage: () => this.ctx.storageDomain,
      credentials: () => this.ctx.credentials,
      llm: () => this.ctx.llm,
      'token-meter': () => this.ctx.tokenMeter,
    }
    const dependencies = Object.fromEntries(HEALTH_DEPENDENCY_NAMES.map(name => {
      try {
        const service = this.ctx.get === undefined
          ? directServices[name]()
          : this.ctx.get(serviceKeys[name])
        return [name, service !== undefined]
      } catch {
        return [name, false]
      }
    })) as Record<HealthDependencyName, boolean>

    const fibers: CordisFiber[] = []
    try {
      for (const runtime of this.ctx.registry.values()) {
        for (const fiber of runtime.fibers) fibers.push(fiber)
      }
    } catch {
      // Registry inspection is diagnostic only. An empty fold is safer than
      // exposing or propagating an internal registry error to the user.
    }

    const inflightTurnCount = this.repair.count()

    let connection
    let botOpenId: string | undefined
    try { connection = this.channel?.getConnectionStatus() } catch {}
    try { botOpenId = this.channel?.botOpenId() } catch {}

    return foldHealthSnapshot({
      fibers,
      dependencies,
      connection,
      botOpenId,
      started: this.started,
      routeCount: this.routes.size(),
      liveAgentCount: this.sessions.liveCount(),
      inflightTurnCount,
      ...(this.analyzeListenError === undefined ? {} : { analyzeListenError: this.analyzeListenError }),
    })
  }











  /**
   * GC pass over the routing domain. Two independent parts:
   *
   * 1. Dedup records (unconditional): `processed` records and in-process
   *    guard entries older than `PROCESSED_RETENTION_MS` are dropped —
   *    redelivery windows are minutes, so a day of retention is ample and
   *    keeps the table bounded regardless of the route TTL setting.
   * 2. Route/inflight GC (`routeTtlMs > 0`): thread routes idle past the TTL
   *    are retired into minimal persistent tombstones before their active
   *    records are deleted. A later message in that visible topic is then
   *    rejected instead of silently creating a context-free Session. Degraded
   *    chat-scoped routes have no topic boundary and are deleted normally.
   *    Stale in-flight snapshots are deleted without surprising the user with
   *    a repair of an ancient card. Sessions and workspaces remain host-owned.
   *
   * Per-key failures are logged and skipped; concurrent writes are safe
   * because `entries()` snapshots.
   */
  private async gcExpiredEntries(): Promise<void> {
    const now = Date.now()
    const processedCutoff = now - PROCESSED_RETENTION_MS
    let removedRoutes = 0
    let retiredThreadRoutes = 0
    let removedInflight = 0
    let removedProcessed = 0

    const processed = this.domain?.processed
    if (processed !== undefined) {
      for (const [key, record] of [...processed.entries()]) {
        if (record.processedAt >= processedCutoff) continue
        try {
          await processed.delete(key)
          removedProcessed++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of processed record %s failed: %s', key, String(error))
        }
      }
    }
    this.inbound.pruneAccepted(processedCutoff)

    const ttlMs = this.config.routeTtlMs
    if (ttlMs === 0) {
      if (removedProcessed > 0) {
        this.ctx.logger?.info?.('dsh-channels: record GC removed %d dedup record(s)', removedProcessed)
      }
      return
    }
    const cutoff = now - ttlMs

    const routes = this.domain?.routes
    if (routes !== undefined) {
      for (const [key, record] of [...routes.entries()]) {
        if (record.lastActivityAt >= cutoff) continue
        try {
          if (record.kind === 'thread') {
            await this.routes.expireThread(key, now)
            retiredThreadRoutes++
          } else {
            await this.routes.remove(key)
          }
          this.attachmentFetchTools.forgetRoute(key)
          removedRoutes++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of route %s failed: %s', key, String(error))
        }
      }
    }

    // Reconcile the attachment-fetch whitelist with the active route set: the
    // inbound TTL path retires a thread route directly (tombstone), so its
    // in-memory whitelist bucket would otherwise live until process exit.
    const droppedToolRoutes = this.attachmentFetchTools.pruneRoutes(
      routeKey => this.routes.get(routeKey) !== undefined,
    )
    if (droppedToolRoutes > 0) {
      this.ctx.logger?.info?.(
        'dsh-channels: record GC dropped %d stale attachment-tool route bucket(s)',
        droppedToolRoutes,
      )
    }

    const inflight = this.domain?.inflight
    if (inflight !== undefined) {
      for (const [key, snapshot] of [...inflight.entries()]) {
        if (snapshot.startedAt >= cutoff) continue
        try {
          await inflight.delete(key)
          removedInflight++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of inflight snapshot %s failed: %s', key, String(error))
        }
      }
    }

    if (removedRoutes > 0 || removedInflight > 0 || removedProcessed > 0) {
      this.ctx.logger?.info?.(
        'dsh-channels: record GC removed %d route(s) (%d thread tombstone(s)), %d stale snapshot(s), %d dedup record(s)',
        removedRoutes, retiredThreadRoutes, removedInflight, removedProcessed,
      )
    }
  }


  /**
   * HITL answerer hook: the Feishu placement of one session's approval cards,
   * or `undefined` when this channel does not route the session (the answerer
   * then delegates to other answerers).
   */
  private approvalRouteFor(sessionId: string): ApprovalRoute | undefined {
    const record = this.routes.findBySession(sessionId)
    if (record === undefined) return undefined
    return {
      chatId: record.chatId,
      cardMessageId: record.cardMessageId,
      inThread: record.kind === 'thread',
      senderUserId: record.senderUserId,
      ...(record.shared === true
        ? { mayDecide: (userId: string) => this.accessController.mayActOnRoute(userId, record.chatId, record) }
        : {}),
    }
  }

  /**
   * Send one body-segment continuation card into the session's topic (or, for
   * degraded chat-scoped routes, as a plain reply anchored to the main card).
   * When Feishu rejects the card (e.g. per-card table limit, error 11310) the
   * segment is re-delivered as a plain-text message so the content is never
   * lost — text messages carry no card constraints.
   */
  /** Authorized Session-level `/model` view/switch operation. */
  private async runModelCommand(
    invocation: CommandInvocation,
    rawInput: string,
    admission: ModelAdmission,
  ): Promise<CommandResult> {
    if (admission.live.agent !== invocation.agent) {
      return { kind: 'error', text: '/model 只能通过已授权的飞书话题执行。' }
    }
    const { provider: currentProvider, model: currentModel } = currentModelRoute(admission.live, admission.controller)

    if (rawInput === '') {
      const lines = [currentModelLine(admission.live, admission.controller)]
      const models = await this.listModels(currentProvider)
      if (models.length > 0) {
        lines.push(`**可选模型（${models.length}）**：${models.slice(0, 20).map(id => `\`${id}\``).join('、')}`
          + (models.length > 20 ? ' …' : ''))
      } else if (currentProvider === undefined) {
        lines.push('当前还没有模型请求记录；可先用 `/model <provider>/<model>` 指定，或先发一条普通消息。')
      }
      lines.push('用法：`/model <模型-id>`（沿用当前 provider）· `/model <provider>/<model>` · `/model reset`')
      return { kind: 'success', text: lines.join('\n') }
    }

    if (rawInput === 'reset') {
      return { kind: 'success', text: '已恢复部署默认模型（下一条消息生效）。' }
    }

    const slash = rawInput.indexOf('/')
    const provider = slash === -1 ? currentProvider : rawInput.slice(0, slash)
    const model = slash === -1 ? rawInput : rawInput.slice(slash + 1)
    if (model === '' || (slash !== -1 && (provider === undefined || provider === ''))) {
      return { kind: 'error', text: '用法错误：/model [模型-id|provider/model|reset]。' }
    }
    // Validate against the advertised catalog when the deployment exposes one;
    // an unsupported value would otherwise only fail at the next request.
    if (provider !== undefined) {
      const models = await this.listModels(provider)
      if (models.length > 0 && !models.includes(model)) {
        return {
          kind: 'error',
          text: `provider \`${provider}\` 未提供模型 \`${model}\`。可选：${models.slice(0, 20).map(id => `\`${id}\``).join('、')}`,
        }
      }
    }
    const label = provider === undefined ? model : `${provider}/${model}`
    return { kind: 'success', text: `当前 Session 模型已切换为 \`${label}\`（下一条消息生效）。` }
  }

  /** `/model` picker: the provider's advertised models, or undefined when none are listed. */
  private async modelPicker(
    current: RouteRecord,
    live: LiveAgent,
    admission: ModelAdmission,
  ): Promise<object | undefined> {
    const route = currentModelRoute(live, admission.controller)
    const models = await this.listModels(route.provider)
    if (models.length === 0) return undefined
    return buildPickerCard({
      title: '🧠 模型',
      command: 'model',
      text: `${currentModelLine(live, admission.controller)}\n切换在下一条消息生效。`,
      sessionId: current.sessionId,
      options: models.map(id => ({ label: id, arg: id })),
      ...(route.model === undefined ? {} : { current: route.model }),
      reset: true,
    })
  }

  /**
   * `/effort` picker: the efforts the current model route advertises, or
   * undefined when the route is unknown or advertises none.
   */
  private async effortPicker(
    current: RouteRecord,
    live: LiveAgent,
    admission: EffortAdmission,
    text: string,
  ): Promise<object | undefined> {
    const route = currentModelRoute(live, admission.controller)
    if (route.provider === undefined || route.model === undefined) return undefined
    let reasoning: LlmModelInfo['reasoning']
    try {
      const llm = this.ctx.get?.('llm') as LlmService | undefined
      reasoning = (await llm?.resolveModelInfo(route.provider, route.model))?.reasoning
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: effort catalog lookup failed: %s', String(error))
      return undefined
    }
    if (reasoning === undefined || reasoning.efforts.length === 0) return undefined
    const active = admission.controller.state.effectiveEffort ?? reasoning.defaultEffort
    return buildPickerCard({
      title: '💭 推理强度',
      command: 'effort',
      text,
      sessionId: current.sessionId,
      options: reasoning.efforts.map(effort => ({ label: effort.name || effort.id, arg: effort.id })),
      ...(active === undefined ? {} : { current: active }),
      reset: true,
    })
  }

  /** Model ids advertised for one provider route (empty when unavailable). */
  private async listModels(provider: string | undefined): Promise<string[]> {
    if (provider === undefined) return []
    try {
      const llm = this.ctx.get?.('llm') as LlmService | undefined
      const models = await llm?.listModels?.(provider)
      return (models ?? []).map(entry => entry.id ?? entry.name ?? '').filter(id => id !== '')
    } catch {
      return []
    }
  }

  /**
   * Agent-scoped `/renew` handler. Only the Feishu admission path arms its
   * AbortSignal, preventing another Host client from switching a Feishu route
   * by invoking the scoped command out of band.
   */
  private async runRenewCommand(
    invocation: CommandInvocation,
    admission: RenewAdmission,
  ): Promise<CommandResult> {
    if (admission.live.agent !== invocation.agent) {
      return { kind: 'error', text: '/renew 只能通过已授权的飞书话题执行。' }
    }
    const current = this.routes.get(admission.route.key)
    if (current === undefined || current.sessionId !== admission.route.sessionId) {
      return { kind: 'error', text: '当前话题绑定已变化，请重试 /renew。' }
    }
    try {
      admission.commit = await this.sessions.renew(current, admission.live)
      return { kind: 'success', text: '新 Session 已创建并绑定。' }
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: renew transaction failed for session %s: %s',
        current.sessionId, String(error),
      )
      return { kind: 'error', text: 'Session 续建失败，原 Session 仍保持绑定；请稍后重试。' }
    }
  }

  /** Authorized Session-level `/effort` view/switch operation. */
  private runEffortCommand(
    invocation: CommandInvocation,
    action: EffortCommandAction,
    admission: EffortAdmission,
  ): CommandResult {
    if (admission.live.agent !== invocation.agent) {
      return { kind: 'error', text: '/effort 只能通过已授权的飞书话题执行。' }
    }
    const state = admission.controller.state
    if (action.kind === 'show') {
      if (state.effortSource === 'session') {
        return { kind: 'success', text: `当前 Session 推理强度：\`${state.effectiveEffort}\`（Session 覆盖）。` }
      }
      if (state.effortSource === 'config') {
        return { kind: 'success', text: `当前 Session 推理强度：\`${state.effectiveEffort}\`（配置默认）。` }
      }
      return { kind: 'success', text: '当前 Session 未设置推理强度覆盖，使用模型适配器/provider 默认。' }
    }
    if (action.kind === 'reset') {
      return state.configuredEffort === undefined
        ? { kind: 'success', text: '已恢复模型适配器/provider 默认推理强度。' }
        : { kind: 'success', text: `已恢复配置默认推理强度：\`${state.configuredEffort}\`。` }
    }
    return { kind: 'success', text: `当前 Session 推理强度已切换为：\`${action.value}\`。` }
  }

  // ---- outbound helpers ------------------------------------------------

  /** Context pressure for the card's second info line (synchronous reads only). */
  private measureContext(session: Session): { contextTokens?: number; contextWindow?: number } {
    let contextTokens: number | undefined
    try {
      // Optional peers are read through ctx.get (safe lookup); direct property
      // access on a cordis context throws for services the plugin did not inject.
      const meter = this.ctx.get?.('tokenMeter') as TokenMeter | undefined
      contextTokens = meter?.measure(session).totalTokens
    } catch {
      contextTokens = undefined
    }

    // The route-capacity window is published by the host's `contextPressure`
    // projection; the old request/header scan + resolveModelInfo call stays as
    // a fallback for deployments without the projection registry.
    let contextWindow = readProjectionViews(this.projectionRegistry(), session).contextPressure?.contextWindow
    if (contextWindow === undefined) {
      try {
        const header = session.requestHeader?.()?.config
        const provider = typeof header?.provider === 'string' ? header.provider : undefined
        const model = typeof header?.model === 'string' ? header.model : undefined
        if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
          const routeKey = `${provider}/${model}`
          contextWindow = this.contextWindows.get(routeKey)
          if (contextWindow === undefined && !this.windowRequests.has(routeKey)) {
            this.windowRequests.add(routeKey)
            const llm = this.ctx.get?.('llm') as LlmService | undefined
            void llm?.resolveModelInfo(provider, model)
              .then(info => {
                if (info?.context?.contextWindow !== undefined) {
                  this.contextWindows.set(routeKey, info.context.contextWindow)
                }
              })
              .catch(() => {})
          }
        }
      } catch {
        contextWindow = undefined
      }
    }

    return { contextTokens, contextWindow }
  }

  /** Host projection registry, when this deployment mounts one. */
  private projectionRegistry(): SessionProjections | undefined {
    return this.ctx.get?.('sessionProjections') as SessionProjections | undefined
  }

  /** Card figures from host projections (token totals / cache hit / window). */
  private projectCardStats(session: Session): ProjectedStats | undefined {
    const views = readProjectionViews(this.projectionRegistry(), session)
    const usage = views.tokenUsage
    const pressure = views.contextPressure
    if (usage === undefined && pressure === undefined) return undefined
    const last = usage?.last?.buckets
    const hit = last === undefined ? undefined : last.cacheReadTokens
    const uncached = last === undefined ? undefined : last.uncachedInputTokens
    const cacheHit = hit !== undefined && uncached !== undefined && hit + uncached > 0
      ? hit / (hit + uncached)
      : undefined
    return {
      ...(usage === undefined ? {} : {
        inputTokens: usage.totals.uncachedInputTokens,
        outputTokens: usage.totals.outputTokens,
      }),
      ...(cacheHit === undefined ? {} : { cacheHitPct: cacheHit }),
      ...(pressure?.contextWindow === undefined ? {} : { contextWindow: pressure.contextWindow }),
    }
  }
}

/** The model route the next request of a Session uses, as far as it is known. */
function currentModelRoute(
  live: LiveAgent,
  controller: RequestPolicyController,
): { provider: string | undefined; model: string | undefined } {
  const state = controller.state
  const header = live.agent.session.requestHeader?.()?.config
  return {
    provider: state.effectiveModel?.provider
      ?? (typeof header?.provider === 'string' && header.provider !== '' ? header.provider : undefined),
    model: state.effectiveModel?.model
      ?? (typeof header?.model === 'string' && header.model !== '' ? header.model : undefined),
  }
}

/** `**当前模型**：…` line shared by the `/model` text answer and its picker. */
function currentModelLine(live: LiveAgent, controller: RequestPolicyController): string {
  const { provider, model } = currentModelRoute(live, controller)
  const source = controller.state.modelSource === 'session'
    ? 'Session 覆盖'
    : controller.state.modelSource === 'config' ? '配置默认' : '部署默认'
  return `**当前模型**：${model === undefined ? '尚无模型请求记录' : `\`${model}\``}`
    + `${provider === undefined ? '' : `（provider \`${provider}\`）`} · ${source}`
}
