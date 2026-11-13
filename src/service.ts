/**
 * The Feishu bridge service: the connection lifecycle (lock, connect,
 * restart, shutdown), the wiring of every channel component, the host event
 * listeners, and the submission and restart recovery of turns.
 *
 * Each topic (or degraded chat-scoped route) has its own workspace directory,
 * which is its Session's header cwd; `chatType` decides whether a route
 * belongs to a group or to one person (see `isGroupRoute`).
 *
 * Routing model:
 *  - `thread_id` → bound session (no @ needed inside an owned topic);
 *  - degraded chat-scoped keys when Feishu refuses topic replies;
 *  - new topic + new session for an @-triggered message without a route.
 *
 * @module dsh-channels/service
 */

import { CodeWriteGate } from './access/code-write.ts'
import { ReadFence } from './access/read-fence.ts'
import { SessionLineage } from './access/lineage.ts'
import { AccessController } from './access/controller.ts'
import { AccessRequests } from './access/requests.ts'
import { AccessStore } from './access/store.ts'
import { AccessAdmin } from './access/admin.ts'
import { ApprovalAnswerer } from './interactions/approvals.ts'
import type { ApprovalRoute } from './interactions/approvals.ts'
import { ApprovalStore } from './interactions/approval-store.ts'
import { QuestionAnswerer } from './interactions/questions.ts'
import type {
  Agent,
  CordisFiber,
  HostContext,
  LlmService,
  Session,
  SessionId,
  SessionProjections,
  TokenMeter,
  UserMessage,
} from './host/index.ts'
import { parseSlashCommand, RouteOperationQueue } from './commands.ts'
import { commandSpec } from './commands/registry.ts'
import { CommandDispatcher } from './commands/dispatcher.ts'
import { workingDirectoryService } from './host/index.ts'
import type { SessionQuery } from './host/index.ts'
import { isGroupRoute, openFeishuDomain, PROCESSED_RETENTION_MS } from './domain.ts'
import type { FeishuDomainHandle, InflightSnapshot, RouteRecord } from './domain.ts'
import { Outbox } from './outbox.ts'
import { RouteStore } from './session/routes.ts'
import { TopicLauncher } from './topics/launcher.ts'
import { FeishuActions } from './actions/service.ts'
import { ActionProposalStore } from './actions/store.ts'
import { ProposeActionsToolRuntime } from './feishu/propose-actions.ts'
import type { TopicLocationPort } from './workspaces.ts'
import { InflightRepair, storableMessage } from './session/repair.ts'
import type { ChannelPrompt } from './session/prompt.ts'
import { PromptSubmitter, submissionFailureText } from './session/submit.ts'
import type { SubmissionOutcome, TurnCard, TurnSubmission } from './session/submit.ts'
import { PeerRegistry } from './access/peers.ts'
import { registerChannelAccessPolicies } from './access/remote-policy.ts'
import { requireRemoteServices } from './host/remote.ts'
import type { RemoteServices } from './host/remote.ts'
import { SessionManager } from './session/manager.ts'
import { CardDelivery } from './feishu/delivery.ts'
import { AttachmentFetchToolRuntime, TopicMessagesToolRuntime } from './feishu/tools.ts'
import { SendFileToolRuntime } from './feishu/send-file.ts'
import { WikiConsent } from './feishu/wiki/consent.ts'
import { WikiToolRuntime } from './feishu/wiki/tools.ts'
import type { KnownAttachmentMessageInput, KnownAttachmentSource } from './feishu/tools.ts'
import { MessageReader } from './feishu/message-read.ts'
import { InboundRouter } from './routing/inbound.ts'
import { messageReadRouteOf, PromptContextReader } from './routing/message-context.ts'
import { dispatchCardAction, TurnCardActions } from './routing/card-actions.ts'
import { MissedMessages } from './routing/missed.ts'
import type { ChannelFactory, FeishuChannel, NormalizedMessage } from './feishu-channel.ts'
import { foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES } from './health.ts'
import type { HealthDependencyName, HealthSnapshot } from './health.ts'
import { readProjectionViews } from './stats.ts'
import { createLogicalSessionExport } from './session-export.ts'
import type { SessionExportBuilder } from './session-export.ts'
import { ACTIVITY_BUILD_MARKER, TurnStreamer } from './turn/streamer.ts'
import type { ProjectedStats, StreamerHooks } from './turn/streamer.ts'
import type { FeishuConfig } from './config.ts'
import { ConnectionChecks } from './feishu/connection-checks.ts'
import { ProfileDirectory } from './feishu/profiles.ts'
import { CredentialSlots, resolveCredentialRef } from './settings/credentials.ts'
import { SessionRecords } from './settings/records.ts'
import { mergeOverlay, resolveDshHome } from './settings/overlay.ts'
import { SYSTEM_INSTANCE_LOCK } from './instance-lock.ts'
import type { InstanceLock, InstanceLockProvider, LockHolderInfo } from './instance-lock.ts'
import { DSH_CHANNELS_VERSION } from './session-export.ts'
import type { OverlayPatch, OverlayStore } from './settings/overlay.ts'

/** Periodic route-GC sweep cadence (a long-running instance also accumulates
 *  dead records; TTL semantics make 6 h granularity more than sufficient). */
const GC_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000



/** How long a takeover waits for the previous owner to tear down and free the lock. */
const TAKEOVER_WAIT_MS = 15_000

/**
 * The Feishu connection of this App ID is owned by another dsh process on this
 * machine (see `instance-lock.ts`).
 */
export class InstanceLockHeldError extends Error {
  constructor(readonly holder: LockHolderInfo | undefined) {
    super(`飞书连接已被本机另一个 dsh 实例占用（${describeLockHolder(holder)}），可在设置面板「接管连接」`)
    this.name = 'InstanceLockHeldError'
  }
}

/**
 * `shutdown()` ran while `start()` was still awaiting: the superseded start
 * released what it had opened and must not report a connection failure.
 */
export class StartSupersededError extends Error {
  constructor() {
    super('dsh-channels: the channel was shut down while it was starting')
    this.name = 'StartSupersededError'
  }
}

/**
 * One-line description of a lock owner for logs and the panel.
 * @param holder - the owner, or undefined when it did not identify itself.
 * @returns e.g. `pid 1234 · DSH_HOME /Users/a/.dsh · v0.8.0`.
 */
export function describeLockHolder(holder: LockHolderInfo | undefined): string {
  if (holder === undefined) return '对方未响应身份查询'
  return `pid ${holder.pid} · DSH_HOME ${holder.home} · v${holder.version}`
}

/**
 * Origin line of a host-started turn's card, by the claimed message's source.
 * @param kind - `UserMessage.source.kind` of the message that opened the turn.
 * @returns the line rendered at the top of the card.
 */
export function hostTurnOriginLine(kind: string): string {
  switch (kind) {
    case 'subagent-settled': return '🤖 子代理已结束，继续处理'
    case 'agent-message': return '🤖 收到子代理的消息，继续处理'
    case 'tool-jobs': return '⚙️ 后台任务已完成，继续处理'
    case 'schedule': return '⏰ 定时跟进'
    case 'repo-activity': return '🔔 PR/MR 有新动态，继续处理'
    case 'user': return '💻 来自 dsh 客户端的消息'
    // Other sources come from plugins this channel does not know.
    default: return '⚙️ 会话被唤醒，继续处理'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FeishuService {
  private readonly ctx: HostContext
  /** Effective config (profile layer + Web overlay); collaborators read it through getters. */
  private config: FeishuConfig
  /** Loader/profile-provided config, the layer below the Web overlay. */
  private readonly baseConfig: FeishuConfig
  /** Web overlay store (`$DSH_HOME/dsh-channels/settings.json`), when mounted. */
  private readonly overlay: OverlayStore | undefined
  private readonly channelFactory: ChannelFactory
  private channel: FeishuChannel | undefined
  private streamer: TurnStreamer | undefined
  private domain: FeishuDomainHandle | undefined
  /** Durable retries of a turn's terminal card patches, reactions, and segments. */
  private readonly outbox: Outbox
  /** Durable route store (cache + TTL retirement). */
  private readonly routes: RouteStore
  /** In-flight turn snapshots + startup repair. */
  private readonly repair: InflightRepair
  private readonly missed: MissedMessages
  /** Outbound card delivery + reaction lifecycle. */
  private readonly delivery: CardDelivery
  /**
   * Read-only Feishu message access (P2): the quoted-message excerpt and the
   * first-turn topic history. Constructed before the inbound router so the
   * turn assembly can reach it; it resolves the live channel lazily.
   */
  private readonly messageReader = new MessageReader({ channel: () => this.channel })
  /** Quoted-message excerpt and first-turn topic history of a prompt. */
  private readonly promptContext = new PromptContextReader({
    reader: this.messageReader,
    config: () => this.config,
    debug: (message, ...args) => this.ctx.logger?.debug?.(message, ...args),
    warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
  })
  /** Inbound routing: dedup, admission, decision tree, session establishment. */
  private readonly inbound: InboundRouter
  /** The `feishuTopics` service (other plugins' launches → shared topics). */
  private readonly topicLauncher: TopicLauncher
  /** The `feishuActions` service (non-blocking follow-up action proposals). */
  private readonly feishuActions: FeishuActions
  private readonly actionProposalStore: ActionProposalStore
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
  private readonly proposeActionsTools: ProposeActionsToolRuntime
  private readonly wikiConsent: WikiConsent
  private readonly wikiTools: WikiToolRuntime
  /** FIFO admission for ordinary turns and commands targeting one route. */
  private readonly routeOperations = new RouteOperationQueue()
  /** The slash-command plane. */
  private readonly commands: CommandDispatcher
  /** Buttons on a turn's own cards. */
  private readonly turnActions: TurnCardActions
  /** `<provider>/<model>` → context window (lazy async fill; sync reads). */
  private readonly contextWindows = new Map<string, number>()
  private readonly windowRequests = new Set<string>()
  private started = false
  /**
   * Incremented by every `shutdown()`. A `start()` that observes a different
   * value after one of its awaits was superseded and releases what it opened.
   */
  private lifecycle = 0
  /** Machine-wide lock for the connected App ID, held while the channel runs. */
  private lock: InstanceLock | undefined
  /**
   * Set while the connection is unavailable because another process owns the
   * lock: after a refused acquisition, or after yielding to a takeover.
   */
  private occupied: { holder: LockHolderInfo | undefined } | undefined
  /** Acquisition deadline while a takeover waits for the previous owner. */
  private takeoverDeadline: number | undefined
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
  private unlisten: (() => void) | undefined
  /** Disposers for host-scoped listeners registered by `start()`. */
  private readonly unlistenHost: Array<() => boolean> = []
  /** Periodic route-GC timer (unref'd; only armed when `routeTtlMs > 0`). */
  private gcTimer: ReturnType<typeof setInterval> | undefined
  /** HITL approval answerer (created in `start()`). */
  private approvalAnswerer: ApprovalAnswerer | undefined
  /** Durable approval grants and cards. */
  private readonly approvalStore: ApprovalStore
  /** HITL structured-question answerer (`ask_user_question`). */
  private questionAnswerer: QuestionAnswerer | undefined
  /** Disposers for the host approval waterfall listener + card actions. */
  private unlistenApproval: (() => boolean) | undefined
  /** Disposer for the host user-questions waterfall listener. */
  private unlistenQuestions: (() => boolean) | undefined
  private unlistenCardAction: (() => void) | undefined
  /** Which routed Session each Session (subagents included) belongs to. */
  private readonly lineage = new SessionLineage(sessionId => this.routes.findBySession(sessionId))
  /** Code-write tool gate for Feishu Sessions (in-memory turn drivers). */
  private readonly codeWriteGate: CodeWriteGate
  /** One in-process Peer per Feishu principal (prompts are submitted through them). */
  private readonly peers: PeerRegistry
  /** `session/prompt` submission as the sender's principal. */
  private readonly submitter: PromptSubmitter
  /** The host's Remote-side services, read when the channel starts. */
  private remote: RemoteServices | undefined
  /** Disposer of this channel's `remoteAccess` policies (registered per start). */
  private unlistenAccessPolicy: (() => void) | undefined
  private readonly readFence: ReadFence
  /** Durable access-control user table and authorization requests. */
  private readonly accessStore: AccessStore
  /** Channel-plane admission gate (administrator / group / user). */
  private readonly accessController: AccessController
  /** Administrator DM authorization cards + bot-added group info cards. */
  private accessRequests: AccessRequests | undefined
  private unlistenBotAdded: (() => void) | undefined
  private unlistenConnection: (() => void) | undefined
  /** Cached Feishu user and chat profiles. */
  readonly profiles: ProfileDirectory
  /** Panel and `/auth` access administration. */
  readonly accessAdmin: AccessAdmin
  /** Panel views over Feishu-routed Sessions and their workspace files. */
  readonly records: SessionRecords
  /** Panel credential slots. */
  readonly credentials: CredentialSlots
  /** Post-connect scope self-check and slash-command panel sync. */
  readonly checks: ConnectionChecks

  constructor(
    ctx: HostContext,
    config: FeishuConfig,
    channelFactory: ChannelFactory,
    sessionExportBuilder: SessionExportBuilder = createLogicalSessionExport,
    overlay?: OverlayStore,
    private readonly instanceLock: InstanceLockProvider = SYSTEM_INSTANCE_LOCK,
  ) {
    this.ctx = ctx
    this.config = config
    this.baseConfig = { ...config }
    this.overlay = overlay
    this.channelFactory = channelFactory
    this.routes = new RouteStore({
      domain: () => this.domain,
      ttlMs: () => this.config.routeTtlMs,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
      // Bindings derive from the route table; tell snapshot readers it moved.
      changed: () => this.remote?.remoteAccess.invalidate(),
    })
    this.approvalStore = new ApprovalStore({
      tables: () => this.domain === undefined
        ? undefined
        : { grants: this.domain.approvalGrants, cards: this.domain.approvalCards },
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.actionProposalStore = new ActionProposalStore({
      table: () => this.domain?.actionProposals,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.repair = new InflightRepair({
      domain: () => this.domain,
      channel: () => this.channel,
      ttlMs: () => this.config.routeTtlMs,
      info: (message, ...args) => this.ctx.logger?.info?.(message, ...args),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
      recovery: {
        policy: () => this.config.replay,
        liveAgent: snapshot => this.recoveryAgent(snapshot),
        replay: (agent, snapshot, prompt, submit) => {
          const card: TurnCard = {
            cardMessageId: snapshot.cards[0]!.messageId,
            ...(snapshot.triggerMessageId === undefined ? {} : { triggerMessageId: snapshot.triggerMessageId }),
            ...(snapshot.reactionId === undefined ? {} : { reactionId: snapshot.reactionId }),
          }
          if (!submit) {
            this.streamer?.attach(agent.session, card.cardMessageId, card.triggerMessageId, card.reactionId, { prompt })
            return
          }
          // The same request id as before the restart: `session/prompt`
          // deduplicates against the inbox and the log.
          void this.runTurn(agent, prompt, card)
        },
      },
    })
    this.missed = new MissedMessages({
      config: () => this.config.missed,
      domain: () => this.domain,
      channel: () => this.channel,
      routes: () => this.routes.records(),
      handle: async message => {
        const channel = this.channel
        if (channel !== undefined) await this.dispatchInbound(channel, message)
      },
      isAdmin: userId => this.accessController.isAdmin(userId),
      info: (message, ...args) => this.ctx.logger?.info?.(message, ...args),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.sessions = new SessionManager({
      ctx: this.ctx,
      config: () => this.config,
      persistRoute: (key, record) => this.routes.put(key, record),
      started: () => this.started,
      detachStream: sessionId => this.streamer?.detach(sessionId),
      mountTools: (agentCtx, sessionId) => {
        // The fetch tool is the only way the model reaches attachment bytes,
        // so it is mounted exactly when the deployment accepts attachments.
        // The topic-messages tool self-gates on `feishuTools.topicMessages`
        // and `feishu_send_file` on `feishuTools.sendFile`. The mounts start
        // together and resolve as one promise (no serial blocking).
        const mounts: Array<Promise<void>> = []
        if (this.config.acceptAttachments) {
          mounts.push(this.attachmentFetchTools.mount(agentCtx, sessionId))
        }
        mounts.push(this.topicMessagesTools.mount(agentCtx, sessionId))
        mounts.push(this.sendFileTools.mount(agentCtx, sessionId))
        mounts.push(this.proposeActionsTools.mount(agentCtx, sessionId))
        mounts.push(this.wikiTools.mount(agentCtx, sessionId))
        return Promise.all(mounts).then(() => undefined)
      },
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.attachmentFetchTools = new AttachmentFetchToolRuntime({
      config: () => this.config,
      channel: () => this.channel,
      attachments: () => this.ctx.attachments,
      routeOfSession: sessionId => this.routes.findBySession(sessionId),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.topicMessagesTools = new TopicMessagesToolRuntime({
      config: () => this.config,
      channel: () => this.channel,
      routeOfSession: sessionId => this.routes.findBySession(sessionId),
      noteKnownMessage: (route, message, source) => {
        this.attachmentFetchTools.noteKnownMessage(route, message, source)
      },
      isKnownMessage: (route, messageId) => this.attachmentFetchTools.isKnownMessage(route, messageId),
      // The tool description must not promise a fetch tool that is not
      // mounted; the runtime appends a note when attachments are disabled.
      fetchAvailable: () => this.config.acceptAttachments,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.outbox = new Outbox({
      table: () => this.domain?.outbox,
      channel: () => this.channel,
      sendSegment: (sessionId, segment, card, text) => this.delivery.segmentCard(sessionId, segment, card, text),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.feishuActions = new FeishuActions({
      started: () => this.started,
      channel: () => this.channel,
      domain: () => this.domain,
      store: this.actionProposalStore,
      routes: this.routes,
      outbox: this.outbox,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.proposeActionsTools = new ProposeActionsToolRuntime({
      config: () => this.config,
      actions: this.feishuActions,
      agentOfSession: sessionId => this.sessions.get(sessionId)?.agent ?? this.ctx.agents.get(sessionId as SessionId),
      isRoutedSession: sessionId => this.routes.findBySession(sessionId) !== undefined,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.wikiConsent = new WikiConsent({
      channel: () => (this.started ? this.channel : undefined),
      timeoutMs: () => this.config.approvalTimeoutMs,
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels wiki consent error (session %s): %s', sessionId, String(error))
      },
      patchCard: (messageId, card) => this.outbox.patch(messageId, card),
    })
    this.wikiTools = new WikiToolRuntime({
      config: () => this.config,
      channel: () => (this.started ? this.channel : undefined),
      routeOfSession: sessionId => this.approvalRouteFor(sessionId),
      mayUseWiki: (sessionId, access) => {
        const record = this.routes.findBySession(sessionId)
        return record !== undefined && this.accessController.mayUseOnRoute(record, access === 'read' ? 'wikiRead' : 'wikiWrite')
      },
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
          rootDir: record.workspacePath,
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
    this.codeWriteGate = new CodeWriteGate({
      config: () => this.config,
      routeOf: sessionId => this.routes.findBySession(sessionId),
      lineage: this.lineage,
      mayWrite: route => this.accessController.mayUseOnRoute(route, 'codeWrite'),
    })
    this.readFence = new ReadFence({
      config: () => this.config,
      routeOf: sessionId => this.routes.findBySession(sessionId),
      lineage: this.lineage,
      workingDirectory: session => workingDirectoryService(this.ctx)?.get(session),
    })
    this.accessController = new AccessController({
      config: () => this.config,
      store: this.accessStore,
      channel: () => this.channel,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
      onDeniedUser: msg => {
        void this.accessRequests?.ensureUserRequest(msg).catch((error: unknown) => {
          this.ctx.logger?.warn?.('dsh-channels: user authorization request failed: %s', String(error))
        })
      },
    })
    this.profiles = new ProfileDirectory({
      channel: () => this.channel,
      tableName: userId => this.accessStore.getUser(userId)?.name,
      debug: (message, ...args) => this.ctx.logger?.debug?.(message, ...args),
    })
    this.accessAdmin = new AccessAdmin({
      config: () => this.config,
      store: this.accessStore,
      loaded: () => this.domain !== undefined,
      requests: () => this.accessRequests,
      delivery: this.delivery,
      botOpenId: () => this.channel?.botOpenId(),
      isAdmin: userId => this.accessController.isAdmin(userId),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.records = new SessionRecords({
      routes: this.routes,
      profiles: this.profiles,
      sessionQuery: () => this.ctx.get?.('sessionQuery') as SessionQuery | undefined,
      isLive: sessionId => this.sessions.get(sessionId) !== undefined || this.ctx.agents.get(sessionId as SessionId) !== undefined,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.credentials = new CredentialSlots({
      ctx: this.ctx,
      config: () => this.config,
      refreshed: () => this.refreshReadiness(),
    })
    this.checks = new ConnectionChecks({
      config: () => this.config,
      channel: () => this.channel,
      info: (message, ...args) => this.ctx.logger?.info?.(message, ...args),
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.peers = new PeerRegistry({
      connection: () => this.requireRemote().connection,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.submitter = new PromptSubmitter({
      gateway: () => this.requireRemote().gateway,
      fileUploads: () => this.requireRemote().fileUploads,
      attachments: () => this.ctx.attachments,
      peers: this.peers,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    const prompts: TurnSubmission = {
      stageImage: (agent, bytes, name) => this.submitter.stageImage(agent, bytes, name),
      run: (agent, prompt, card) => this.runTurn(agent, prompt, card),
    }
    this.inbound = new InboundRouter({
      ctx: this.ctx,
      config: () => this.config,
      started: () => this.started,
      domain: () => this.domain,
      routes: this.routes,
      repair: this.repair,
      delivery: this.delivery,
      sessions: this.sessions,
      nativeAttachments: () => this.ctx.attachments,
      prompts,
      noteKnownAttachments: (record, message, source) => {
        this.noteKnownAttachmentMessage(record, message, source ?? 'trigger')
      },
      messageRead: {
        quote: input => this.promptContext.quote(input),
        history: input => this.promptContext.history(input),
      },
      prefetchImages: () => ({
        enabled: this.config.prefetchImages,
        maxImageBytes: this.config.prefetchImageMaxBytes,
        maxTotalBytes: this.config.prefetchTotalMaxBytes,
        timeoutMs: this.config.prefetchTimeoutMs,
      }),
      access: this.accessController,
      location: this.topicLocation,
      queue: this.routeOperations,
      streamer: () => this.streamer,
      questionAnswerer: () => this.questionAnswerer,
      approvalAnswerer: () => this.approvalAnswerer,
      commands: {
        owns: (line) => {
          const parsed = parseSlashCommand(line)
          return parsed !== undefined && commandSpec(parsed.name) !== undefined
        },
        handleSlash: (msg, line) => this.commands.handle(msg, line),
      },
    })
    this.turnActions = new TurnCardActions({
      ctx: this.ctx,
      started: () => this.started,
      channel: () => this.channel,
      streamer: () => this.streamer,
      routes: this.routes,
      access: this.accessController,
      sessions: this.sessions,
      repair: this.repair,
      approvals: this.approvalStore,
      actionProposals: this.actionProposalStore,
      patchProposalCard: (proposalId, cardMessageId, card) =>
        this.feishuActions.patchCardSerialized(proposalId, cardMessageId, card),
      outbox: this.outbox,
      delivery: this.delivery,
      queue: this.routeOperations,
      runTurn: (agent, prompt, card) => this.runTurn(agent, prompt, card),
      runCommand: (msg, line) => this.commands.handle(msg, line),
    })
    this.commands = new CommandDispatcher({
      ctx: this.ctx,
      config: () => this.config,
      started: () => this.started,
      access: this.accessController,
      accessAdmin: this.accessAdmin,
      delivery: this.delivery,
      routes: this.routes,
      sessions: this.sessions,
      queue: this.routeOperations,
      resolveRoute: msg => this.inbound.resolveRoute(msg),
      cancelTurn: sessionId => this.turnActions.cancelTurn(sessionId),
      health: () => this.healthSnapshot(),
      uptimeMs: () => this.uptimeMs(),
      projections: () => this.projectionRegistry(),
      exportSession: sessionExportBuilder,
    })
    this.topicLauncher = new TopicLauncher({
      ctx: this.ctx,
      config: () => this.config,
      started: () => this.started,
      channel: () => this.channel,
      domain: () => this.domain,
      routes: this.routes,
      repair: this.repair,
      sessions: this.sessions,
      prompts,
      queue: this.routeOperations,
      reserveTopic: threadId => this.inbound.reserveTopic(threadId),
      location: this.topicLocation,
      mayLaunchFor: requesterUserId => this.accessController.mayLaunchFor(requesterUserId),
    })
  }

  /** Names of the places topics open in (Feishu profiles) and group registration (access store). */
  private readonly topicLocation: TopicLocationPort = {
    groupName: chatId => this.profiles.groupName(chatId),
    userName: userId => this.profiles.userName(userId),
    registerGroup: async (chatId, name) => { await this.accessStore.ensureGroup(chatId, name) },
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
    this.attachmentFetchTools.noteKnownMessage(messageReadRouteOf(record), message, source)
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
    const states = await this.credentials.states()
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
      if (error instanceof StartSupersededError) {
        // Not a connection failure: release what the superseded start
        // registered after the teardown that superseded it.
        this.ctx.logger?.info?.('%s', error.message)
        await this.shutdown().catch(() => undefined)
        throw error
      }
      this.lastStartError = messageOf(error)
      if (error instanceof InstanceLockHeldError) {
        // Expected when another profile runs the same bot: not a failure.
        this.ctx.logger?.info?.('dsh-channels: %s', error.message)
        console.warn('[dsh-channels]', error.message)
      } else {
        this.ctx.logger?.error?.('dsh-channels: 飞书连接失败：%s', String(error))
        // Headless profiles have no settings panel; keep the failure visible on
        // the console, symmetric with the success line at the end of `start()`.
        console.error('[dsh-channels] feishu connection failed:', error)
      }
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
    this.config = mergeOverlay(this.baseConfig, overlay)
  }

  /**
   * Apply an already-validated overlay over the profile config. Fields read
   * per event/turn take effect immediately; `RESTART_KEYS` need `restart()`.
   */
  applyOverlay(overlay: OverlayPatch): void {
    this.config = mergeOverlay(this.baseConfig, overlay)
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

  /** This process's identity as answered to lock queries. */
  private lockIdentity(): LockHolderInfo {
    return { pid: process.pid, home: resolveDshHome(), version: DSH_CHANNELS_VERSION, startedAt: Date.now() }
  }

  /**
   * Hand the connection to another process that asked to take over. The lock
   * already answered the request; tearing down releases it.
   */
  private async yieldConnection(from: LockHolderInfo): Promise<void> {
    this.restarting = true
    try {
      await this.shutdown()
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: shutdown during takeover failed: %s', String(error))
    } finally {
      this.restarting = false
    }
    this.occupied = { holder: from }
    this.lastStartError = `飞书连接已被本机另一个 dsh 实例接管（${describeLockHolder(from)}）`
    this.ctx.logger?.info?.('dsh-channels: yielded the feishu connection to %s', describeLockHolder(from))
  }

  /**
   * Panel action: ask the process owning this App ID to yield, then connect.
   * Interrupts the replies in flight over there; those cards are repaired when
   * that process starts its channel again.
   */
  async takeover(): Promise<void> {
    if (this.started) return
    if (this.connecting || this.restarting) throw new Error('飞书连接正在连接或重启，请稍候再试')
    await this.refreshReadiness()
    if (!this.configured) {
      throw new Error(`飞书应用凭据尚未配置完整：缺少 ${this.missingConfigItems.join('、')}`)
    }
    const appId = await resolveCredentialRef(this.ctx, this.config.appId)
    const outcome = await this.instanceLock.requestYield(this.instanceLock.address(appId), this.lockIdentity())
    if (outcome === 'busy') throw new Error('另一个 dsh 实例正在连接或重启，请稍候再试')
    this.takeoverDeadline = Date.now() + TAKEOVER_WAIT_MS
    try {
      await this.connect()
    } finally {
      this.takeoverDeadline = undefined
    }
  }

  /**
   * The process owning this App ID's connection, while it keeps this one from
   * connecting; `undefined` otherwise. `holder` is undefined when the owner did
   * not identify itself.
   */
  occupiedBy(): { holder: LockHolderInfo | undefined } | undefined {
    return this.started ? undefined : this.occupied
  }

  /**
   * Origin line for a turn no Feishu message started, or undefined when it
   * gets no card (disabled, or the session has no Feishu route).
   */
  private hostTurnOrigin(sessionId: string, message: UserMessage): string | undefined {
    if (!this.config.hostTurnCards || this.routes.findBySession(sessionId) === undefined) return undefined
    return hostTurnOriginLine(message.source.kind)
  }

  /** Restart snapshot of a host turn's card (no trigger message to settle). */
  private async writeHostSnapshot(sessionId: string, messageId: string, mode: 'card' | 'text', message: UserMessage): Promise<void> {
    const route = this.routes.findBySession(sessionId)
    if (route === undefined) return
    const stored = storableMessage(message)
    // A host turn acts for the Session's current speaker (diagnostics only).
    const driver = this.codeWriteGate.speakerOf(sessionId)
    try {
      await this.repair.write({
        key: messageId,
        sessionId,
        chatId: route.chatId,
        routeKey: route.key,
        ...(stored === undefined ? {} : { message: stored }),
        ...(driver === undefined ? {} : { senderUserId: driver }),
        cards: [{ messageId, mode }],
        startedAt: Date.now(),
        attempts: 0,
      })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: writing the host-turn snapshot %s failed: %s', messageId, String(error))
    }
  }

  /** The `feishuTopics` service, provided by `apply()`. */
  topics(): TopicLauncher { return this.topicLauncher }
  /** The `feishuActions` service, provided by `apply()`. */
  actions(): FeishuActions { return this.feishuActions }
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

  /**
   * Remember a group the bot joined for missed-message catch-up (bounded to
   * the 500 most recent). Best-effort: a failure only warns.
   */
  private async rememberGroup(chatId: string): Promise<void> {
    const domain = this.domain
    if (domain === undefined) return
    try {
      const global = domain.getGlobal()
      const known = global.knownGroups ?? []
      if (known.includes(chatId)) return
      await domain.setGlobal({ ...global, knownGroups: [...known, chatId].slice(-500) })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: remembering group %s failed: %s', chatId, String(error))
    }
  }

  /**
   * The route of the Feishu Session a Session belongs to: itself, or the
   * routed ancestor on its `parentSession` chain through the live agent
   * registry (see `SessionLineage.resolve`).
   * @param sessionId - the Session an event names.
   * @returns the route, or undefined when the chain holds no Feishu Session.
   */
  private routedRouteOf(sessionId: string): RouteRecord | undefined {
    const root = this.lineage.resolve(sessionId, id => this.ctx.agents.get(id as SessionId)?.session.header.parentSession)
    return root === undefined ? undefined : this.routes.findBySession(root)
  }

  /** Aggregate health used by `/health` and the Web settings panel. */
  health(): HealthSnapshot { return this.healthSnapshot() }

  /** Wire events and open the long connection. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const lifecycle = this.lifecycle
    // A plugin reload disposes this instance's host listeners and then calls
    // `shutdown()`, possibly while this body is still awaiting. Continuing
    // would leave a Feishu connection whose turns never reach a card.
    const ensureCurrent = (): void => {
      if (this.lifecycle !== lifecycle) throw new StartSupersededError()
    }

    // 0. The prompt path needs the host's Remote-side services (DSH Web
    //    composition); a composition without them cannot run this channel.
    this.remote = requireRemoteServices(this.ctx)

    // 1. Resolve credentials through the host seam (env > .credentials.yaml > .env).
    const appId = await resolveCredentialRef(this.ctx, this.config.appId)
    const appSecret = await resolveCredentialRef(this.ctx, this.config.appSecret)
    ensureCurrent()

    // 2. Own the App ID on this machine before connecting: Feishu splits the
    //    events of one app across all its long connections.
    const acquired = await this.instanceLock.acquire({
      address: this.instanceLock.address(appId),
      self: this.lockIdentity(),
      canYield: () => this.started && !this.connecting && !this.restarting,
      onYield: (from) => { void this.yieldConnection(from) },
      ...(this.takeoverDeadline === undefined ? {} : { waitUntil: this.takeoverDeadline }),
    })
    if (!acquired.ok) {
      ensureCurrent()
      this.occupied = { holder: acquired.holder }
      throw new InstanceLockHeldError(acquired.holder)
    }
    if (this.lifecycle !== lifecycle) {
      await acquired.lock.release()
      throw new StartSupersededError()
    }
    this.lock = acquired.lock
    this.occupied = undefined
    // The access policies of this channel's principals, for the lifetime of
    // the connection (disposed by `shutdown`, which a takeover yield runs too).
    this.unlistenAccessPolicy?.()
    this.unlistenAccessPolicy = registerChannelAccessPolicies(this.remote.remoteAccess, {
      routes: () => this.routes.records(),
      mayActOnRoute: (userId, chatId, record) => this.accessController.mayActOnRoute(userId, chatId, record),
    })

    // 3. Build the channel with the resolved secrets.
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
      settlePatch: (messageId, card) => this.outbox.patch(messageId, card),
      settleReaction: (messageId, removeReactionId, add) => this.outbox.reaction(messageId, removeReactionId, add),
      resendSegment: (sessionId, segment, card, fallbackText) => this.outbox.segment(sessionId, segment, card, fallbackText),
      hostTurnOrigin: (sessionId, message) => this.hostTurnOrigin(sessionId, message),
      onHostCardDelivered: (sessionId, messageId, mode, message) => this.writeHostSnapshot(sessionId, messageId, mode, message),
    }
    this.streamer = new TurnStreamer(
      channel,
      this.config.refreshMs,
      hooks,
      this.config.statusRefreshMs,
    )

    const domain = await openFeishuDomain(this.ctx.storageDomain)
    if (this.lifecycle !== lifecycle) {
      await domain.close()
      throw new StartSupersededError()
    }
    this.domain = domain
    this.routes.load()
    this.accessStore.load()
    this.outbox.start()

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
      isAdmin: userId => this.accessController.isAdmin(userId),
      patchCard: (messageId, card) => this.outbox.patch(messageId, card),
      backgroundTurn: sessionId => this.streamer?.runsHostTurn(sessionId) === true,
      store: this.approvalStore,
    }, () => ({
      timeoutMs: this.config.approvalTimeoutMs,
      backgroundTimeoutMs: this.config.approvalBackgroundTimeoutMs,
      reminderMs: this.config.approvalReminderMs,
    }))
    this.approvalAnswerer = answerer
    this.unlistenApproval = this.ctx.on('approval/request', (req, next) => answerer.onRequest(req, next), { prepend: true })
    // Structured questions (`ask_user_question`): the host's only shipped
    // answerer is the Web client, so a Feishu-only session would otherwise
    // fail every ask with NO_PROVIDER.
    const questions = new QuestionAnswerer(channel, {
      routeFor: sessionId => this.approvalRouteFor(sessionId),
      onWaitingChange: (sessionId, waiting) => {
        this.streamer?.setAwaitingAnswer(sessionId, waiting)
      },
      patchCard: (messageId, card) => this.outbox.patch(messageId, card),
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
      config: () => this.config,
      store: this.accessStore,
      channel: () => this.channel,
      warn: (message, ...args) => this.ctx.logger?.warn?.(message, ...args),
    })
    this.accessRequests = accessRequests
    this.unlistenBotAdded = channel.onBotAdded(event => {
      void this.rememberGroup(event.chatId)
      void accessRequests.handleBotAdded(event).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels: bot-added group info card failed: %s', String(error))
      })
    })
    void accessRequests.expirePending().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: access request expiry sweep failed: %s', String(error))
    })
    this.unlistenCardAction = channel.onCardAction(event => {
      dispatchCardAction(event, [
        { label: 'authorization card', handle: action => accessRequests.onCardAction(action) },
        { label: 'approval card', handle: action => answerer.onCardAction(action) },
        { label: 'question card', handle: action => questions.onCardAction(action) },
        { label: 'wiki consent card', handle: action => this.wikiConsent.onCardAction(action) },
        { label: 'missed-messages card', handle: action => this.missed.onCardAction(action) },
        ...this.turnActions.handlers(),
      ], (message, ...args) => this.ctx.logger?.warn?.(message, ...args))
    })

    this.unlistenHost.push(this.ctx.on('session/event', (session, event) => {
      this.streamer?.onSessionEvent(session, event)
      this.approvalAnswerer?.onSessionEvent(session.id, event)
      this.proposeActionsTools.onSessionEvent(session, event)
    }))
    // DSH removed the durable `assistant/chunk` event (format v2 embeds the
    // stream in the settlement); the live deltas arrive here instead.
    this.unlistenHost.push(this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.streamer?.onAssistantFrame(agent.session, frame)
    }))
    // Binds each card to the turn its own prompt opens (see `TurnStreamer`).
    this.unlistenHost.push(this.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      this.codeWriteGate.onClaimed(agent.session.id, message)
      this.proposeActionsTools.onInboxClaimed(agent.session.id, turn)
      this.streamer?.onInboxClaimed(agent.session, message, turn)
    }))
    this.unlistenHost.push(this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      this.streamer?.onInboxDiscarded(agent.session, message)
    }))
    this.unlistenHost.push(this.ctx.on('tools/pre-execute', async (exec, next) =>
      this.proposeActionsTools.decidePreExecute(exec)
      ?? this.codeWriteGate.decide(exec)
      ?? await this.readFence.decide(exec)
      ?? await next()))
    // Writes made for a Feishu Session are answered by where it lives, before
    // the writing plugin asks the user; Sessions this channel does not route
    // are left to other listeners.
    this.unlistenHost.push(this.ctx.on('access/authorize', (event) => {
      const route = this.routedRouteOf(event.session)
      if (route === undefined) return
      const refusal = this.accessController.authorizeRefusal(route, event)
      if (refusal !== undefined) throw new Error(refusal)
    }))
    this.unlistenHost.push(this.ctx.on('repo/commit-trailers', async (event) => {
      const route = this.routedRouteOf(event.session)
      if (route === undefined) return
      const userId = this.codeWriteGate.speakerOf(event.session)
      if (isGroupRoute(route)) {
        // A group's commits belong to the group: the token account authors
        // them, the group and the speaker (when a Feishu user speaks) are
        // recorded as trailers.
        const chatName = await this.profiles.commitChatName(route.chatId)
        event.add('Feishu-Chat', chatName === undefined ? route.chatId : `${chatName} <${route.chatId}>`)
        if (userId === undefined) return
        const name = await this.profiles.commitUserName(userId)
        event.add('Feishu-User', name === undefined ? userId : `${name} <${userId}>`)
        return
      }
      if (userId === undefined) return
      const name = await this.profiles.commitUserName(userId)
      event.add('Feishu-User', name === undefined ? userId : `${name} <${userId}>`)
      const gitEmail = this.accessStore.getUser(userId)?.gitEmail
      if (gitEmail !== undefined) event.setAuthor?.(name ?? userId, gitEmail)
    }))
    // A cold Feishu Session resumed by the host's generic controller would
    // lack this channel's tools and guidance; resume it here instead.
    this.unlistenHost.push(this.ctx.on('repo/resolve-agent', async (sessionId, next) => {
      const route = this.routes.findBySession(sessionId)
      if (route === undefined) return await next()
      return (await this.sessions.ensureLive(route)).agent
    }, { prepend: true }))
    this.unlisten = channel.onMessage(message => {
      void this.dispatchInbound(channel, message)
    })
    this.unlistenConnection = channel.onConnectionChange?.(change => {
      if (change === 'reconnecting') this.missed.onReconnecting()
      else this.missed.onReconnected()
    })
    ensureCurrent()
    await channel.connect()
    if (this.lifecycle !== lifecycle) {
      // The teardown's disconnect ran before this connect resolved.
      await channel.disconnect().catch(() => undefined)
      throw new StartSupersededError()
    }
    // Background: the results only feed the panel and the log.
    void this.checks.checkScopes(channel, appId)
    if (this.config.slashCommandPanel) void this.checks.syncSlashCommands(channel)
    // Before admission opens, so every `running` record left is a previous instance's.
    await this.topicLauncher.markInterrupted()
    ensureCurrent()
    this.topicLauncher.open()
    this.feishuActions.open()
    // Read back what arrived while no instance was connected (background).
    this.missed.start()
    // Repair cards a previous instance left mid-flight (best-effort, background).
    void this.repair.repairAll().catch((error: unknown) => {
      this.ctx.logger?.warn?.('dsh-channels: inflight repair failed: %s', String(error))
    })
    // Approval cards a crashed previous instance left undecided.
    const interruptedApprovals = answerer.recoverInterrupted()
    if (interruptedApprovals > 0) {
      this.ctx.logger?.info?.('dsh-channels: marked %d approval card(s) interrupted by the restart', interruptedApprovals)
    }
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
    } else if (this.accessStore.adminIds().length === 0) {
      console.warn(
        '[dsh-channels] 准入=guarded 但用户表里没有管理员：所有对话都会被拒绝；'
        + '私聊机器人发送 /userid 取得 user_id，在 Web 设置面板「访问授权」的用户表里添加并打开「管理员」',
      )
    } else {
      console.info('[dsh-channels] 准入=guarded，管理员 %d 人', this.accessStore.adminIds().length)
    }
    const approvalMounted = this.ctx.get?.('approval') !== undefined
    console.info(
      approvalMounted
        ? `[dsh-channels] HITL 审批应答已就绪（决策卡片超时 ${this.config.approvalTimeoutMs} ms，后台回合 ${this.config.approvalBackgroundTimeoutMs} ms，私聊提醒 ${this.config.approvalReminderMs} ms）`
        : '[dsh-channels] 主机未挂载 approval 服务，HITL 审批应答关闭',
    )
    const questionsMounted = this.ctx.get?.('userQuestions') !== undefined
    console.info(
      questionsMounted
        ? `[dsh-channels] ask_user_question 应答已就绪（提问卡片超时 ${this.config.questionTimeoutMs} ms）`
        : '[dsh-channels] 主机未挂载 userQuestions 服务，结构化提问应答关闭',
    )
  }

  /** Run one inbound message; a failure is logged and answered in the chat. */
  private async dispatchInbound(channel: FeishuChannel, message: NormalizedMessage): Promise<void> {
    try {
      await this.inbound.handle(message)
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels inbound error: %s', String(error))
      // User-facing safety net: never leave the user without a reply.
      await channel
        .send(message.chatId, { text: `dsh-channels 处理失败：${String(error)}` }, { replyTo: message.messageId })
        .catch(() => {})
    }
  }

  /** Tear down: close the connection and dispose all live agents. */
  async shutdown(): Promise<void> {
    this.lifecycle++
    // Stop Feishu intake before the first await. On a plugin reload the host
    // has already removed this instance's session listeners, so a message
    // admitted now would start a turn whose card never settles. Messages that
    // arrive from here on are read back by the next instance's catch-up.
    this.unlisten?.()
    this.unlisten = undefined
    this.unlistenCardAction?.()
    this.unlistenCardAction = undefined
    // While admission is still open, so a running catch-up finishes its
    // messages; the stored last-alive time stays at this intake cutoff. A
    // failure must not keep the connection open.
    try {
      await this.missed.stop()
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: stopping the missed-message catch-up failed: %s', String(error))
    }
    // Close admission first. In-flight Host commands receive cancellation
    // before their Agent/channel/storage dependencies are disposed, while
    // already queued route operations observe `started === false` and retire.
    this.started = false
    this.topicLauncher.close()
    this.feishuActions.close()
    await this.topicLauncher.drain()
    await this.feishuActions.drain()
    await this.commands.drain()
    this.unlistenBotAdded?.()
    this.unlistenBotAdded = undefined
    this.unlistenConnection?.()
    this.unlistenConnection = undefined
    this.accessRequests?.clear()
    this.accessRequests = undefined
    this.accessController.clear()
    this.codeWriteGate.clear()
    this.lineage.clear()
    this.unlistenAccessPolicy?.()
    this.unlistenAccessPolicy = undefined
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
    await this.peers.clear()
    this.attachmentFetchTools.clear()
    this.proposeActionsTools.clear()
    this.routeOperations.clear()
    this.inbound.clear()
    this.routes.clear()
    this.accessStore.clear()
    // Before the disconnect: the withdrawal patches above are in flight.
    await this.outbox.stop()
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
    // Last: the lock may only pass on once this process holds no connection.
    await this.lock?.release()
    this.lock = undefined
    this.runningConfig = undefined
    this.checks.clear()
  }

  /**
   * The live Agent of an interrupted turn's route, cold-resumed when needed;
   * undefined when the route is gone, was renewed to another Session, or the
   * resume failed.
   */
  private async recoveryAgent(snapshot: InflightSnapshot): Promise<Agent | undefined> {
    const route = snapshot.routeKey === undefined
      ? this.routes.findBySession(snapshot.sessionId)
      : this.routes.get(snapshot.routeKey)
    if (route === undefined || route.sessionId !== snapshot.sessionId) return undefined
    try {
      return (await this.sessions.ensureLive(route)).agent
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: resuming session %s for recovery failed: %s', snapshot.sessionId, String(error))
      return undefined
    }
  }

  /** The Remote-side services; the channel never submits before `start()` read them. */
  private requireRemote(): RemoteServices {
    if (this.remote === undefined) throw new Error('dsh-channels: channel not started')
    return this.remote
  }

  /**
   * Bind `card` to the turn `prompt` starts and submit the prompt as its
   * principal (see `TurnSubmission.run`). The card is bound before the
   * submission so the claim the fake-free Agent loop emits while the prompt
   * enters the inbox finds its turn state. A refused or failed submission
   * settles the card with the reason; the snapshot is retired with the card.
   */
  private async runTurn(agent: Agent, prompt: ChannelPrompt, card: TurnCard): Promise<SubmissionOutcome> {
    const streamer = this.streamer
    if (streamer === undefined) throw new Error('dsh-channels: channel not started')
    streamer.attach(agent.session, card.cardMessageId, card.triggerMessageId, card.reactionId, {
      prompt,
      ...(card.onSettled === undefined ? {} : { onSettled: card.onSettled }),
    })
    try {
      await this.submitter.submit(agent, prompt, 'queue')
      return { accepted: true }
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: submitting prompt %s to session %s as %s failed: %s',
        prompt.requestId, agent.id, JSON.stringify(prompt.principal), String(error),
      )
      const reason = submissionFailureText(error)
      streamer.rejectQueued(agent.id, prompt.requestId, reason)
      return { accepted: false, reason }
    }
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
      outbox: this.outbox.health(),
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
    // Grants of Sessions no route names any more (`/renew`, retired topics)
    // and 「重新发起」 records past their window.
    const removedApproval = this.approvalStore.prune(sessionId => this.routes.findBySession(sessionId) !== undefined, now)
    if (removedApproval > 0) {
      this.ctx.logger?.info?.('dsh-channels: record GC removed %d approval record(s)', removedApproval)
    }
    const removedProposals = await this.actionProposalStore.prune(now)
    if (removedProposals > 0) {
      this.ctx.logger?.info?.('dsh-channels: record GC removed %d expired action proposal(s)', removedProposals)
    }

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
      ...(record.senderUserId === undefined ? {} : { senderUserId: record.senderUserId }),
      chatType: record.chatType,
      ...(isGroupRoute(record)
        ? { mayDecide: (userId: string) => this.accessController.mayActOnRoute(userId, record.chatId, record) }
        : {}),
    }
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
