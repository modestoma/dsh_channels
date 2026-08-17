/**
 * The Feishu bridge service: inbound routing, workspace/session ownership,
 * topic creation, and streaming-card orchestration.
 *
 * Ownership model (one workspace per user × chat):
 *  - p2p:   one workspace per (bot, user), all of that user's sessions inside;
 *  - group: one workspace per (chat, user), sessions grouped per user.
 *
 * Routing model:
 *  - `thread_id` → bound session (no @ needed inside an owned topic);
 *  - degraded chat-scoped keys when Feishu refuses topic replies;
 *  - new topic + new session for an @-triggered message without a route.
 *
 * @module dsh-channels/service
 */

import { randomUUID } from 'node:crypto'
import { ApprovalAnswerer } from './approvals.ts'
import type { ApprovalRoute } from './approvals.ts'
import type {
  Agent,
  AgentHandle,
  CommandInvocation,
  CommandResult,
  AgentPresets,
  AgentSetup,
  CredentialProvider,
  CordisFiber,
  HostContext,
  LlmService,
  Session,
  SessionId,
  TokenMeter,
  UserMessage,
} from './dsh-types.ts'
import { buildCard, buildInterruptionCard } from './cards.ts'
import type { CardState } from './cards.ts'
import {
  armRenewCommand, buildCommandResultCard, commandResultCardKind, isSupportedCommand, parseSlashCommand,
  registerChannelCommands, registerRenewCommand, RouteOperationQueue, supportedCommandList,
} from './commands.ts'
import type { CommandCardState } from './commands.ts'
import {
  appendSessionHistory, chatRouteKey, feishuDomain, normalizeRouteRecord,
} from './domain.ts'
import type {
  FeishuDomainGlobal, FeishuDomainHandle, InflightSnapshot, ProcessedRecord, RawDomainHandle, RouteRecord,
} from './domain.ts'
import type { ChannelFactory, FeishuChannel, NormalizedMessage } from './feishu-channel.ts'
import { buildHealthCard, foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES } from './health.ts'
import type { HealthDependencyName, HealthSnapshot } from './health.ts'
import {
  buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard, buildWorkDirCard,
  compactFailureContext, resolveWorkDir,
} from './session-commands.ts'
import { foldAll, measureSessionContext } from './stats.ts'
import type { ContextMeasurement, ContextServices } from './stats.ts'
import { ACTIVITY_BUILD_MARKER, TurnStreamer } from './streamer.ts'
import type { StreamerHooks } from './streamer.ts'
import { ensureWorkspace, workspaceTitleFor } from './workspaces.ts'
import type { FeishuConfig } from './config.ts'

/** Periodic route-GC sweep cadence (a long-running instance also accumulates
 *  dead records; TTL semantics make 6 h granularity more than sufficient). */
const GC_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Dedup-record retention: Feishu redelivery windows are minutes-scale, so a
 *  day is 100×+ headroom while keeping the table bounded. */
const PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000

/** Build one durable user message from inbound Feishu text (no host runtime import). */
export function feishuUserMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

interface LiveAgent {
  agent: Agent
  handle: AgentHandle
}

interface RenewCommit {
  previous: RouteRecord
  current: RouteRecord
  oldLive: LiveAgent
}

interface RenewAdmission {
  route: RouteRecord
  live: LiveAgent
  commit?: RenewCommit
}

/**
 * Wrap a live agent owned by someone else (web UI api-remote resolver, a
 * previous plugin instance, a won cold-resume race). The borrow is fully
 * deliverable through `followup`, but `dispose` is a no-op — the real owner
 * retains the lifecycle, and shutting the plugin down must never kill it.
 */
function borrowLiveAgent(agent: Agent): LiveAgent {
  return { agent, handle: { agent, dispose: async () => {} } }
}

/** What `agents.create`/`resume` need to compose one agent from a preset. */
interface PresetComposition {
  /** Preset id recorded on the session header meta (absent without a roster). */
  agentPreset?: string
  /** Mounts the resolved preset inside the agent factory's setup. */
  setup?: AgentSetup
}

/** Wrap the host's storage facility open behind a stable local type. */
async function openFeishuDomain(ctx: HostContext): Promise<FeishuDomainHandle> {
  const domain = await ctx.storageDomain.open(feishuDomain) as unknown as RawDomainHandle
  const table = domain.table('routes')
  const inflightRaw = domain.table('inflight')
  const processedRaw = domain.table('processed')
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
    getGlobal: () => (domain.global.get() ?? {}) as FeishuDomainGlobal,
    setGlobal: value => domain.global.set(value),
    close: () => domain.close(),
  }
}

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

export class FeishuService {
  private readonly ctx: HostContext
  private readonly config: FeishuConfig
  private readonly channelFactory: ChannelFactory
  private channel: FeishuChannel | undefined
  private streamer: TurnStreamer | undefined
  private domain: FeishuDomainHandle | undefined
  private readonly routeCache = new Map<string, RouteRecord>()
  private readonly live = new Map<string, LiveAgent>()
  private readonly pendingResume = new Map<string, Promise<LiveAgent>>()
  /**
   * chat-scoped key → in-flight session establishment. Concurrent first
   * messages of one (chat, user) pair all observe the same promise: they wait
   * for the establishment to settle, then either continue the just-created
   * session (same topic, or degraded chat route) or fall through to start
   * their own — never racing each other into duplicate sessions, route
   * overwrites, or the "no route, no mention" drop window.
   */
  private readonly establishing = new Map<string, Promise<RouteRecord>>()
  /** FIFO admission for ordinary turns and commands targeting one route. */
  private readonly routeOperations = new RouteOperationQueue()
  /**
   * In-process dedup guard: message id → accept timestamp. Set synchronously
   * at acceptance so a same-process redelivery can never slip through the
   * window between the persisted dedup check and its `put` landing. Removed
   * once the durable record lands; entries whose `put` failed stay until the
   * GC sweep prunes them (`PROCESSED_RETENTION_MS`).
   */
  private readonly accepted = new Map<string, number>()
  /** `<provider>/<model>` → context window (lazy async fill; sync reads). */
  private readonly contextWindows = new Map<string, number>()
  private readonly windowRequests = new Set<string>()
  private started = false
  private unlisten: (() => void) | undefined
  /** Periodic route-GC timer (unref'd; only armed when `routeTtlMs > 0`). */
  private gcTimer: ReturnType<typeof setInterval> | undefined
  /** HITL approval answerer (created in `start()`). */
  private approvalAnswerer: ApprovalAnswerer | undefined
  /** Disposers for the host approval waterfall listener + card actions. */
  private unlistenApproval: (() => boolean) | undefined
  private unlistenCardAction: (() => void) | undefined

  constructor(ctx: HostContext, config: FeishuConfig, channelFactory: ChannelFactory) {
    this.ctx = ctx
    this.config = config
    this.channelFactory = channelFactory
  }

  /** The live channel (created in `start()` once credentials resolve). */
  private requireChannel(): FeishuChannel {
    if (this.channel === undefined) throw new Error('dsh-channels: channel not started')
    return this.channel
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
      sessionLabel: sessionId => sessionId,
      onError: (_key, error) => {
        this.ctx.logger?.warn?.('dsh-channels stream error: %s', String(error))
      },
      onTurnFinalized: (_sessionId, _turn, mainCardMessageId) => {
        // The turn settled (final patches fired, reaction swap requested):
        // retire its repair snapshot. Kept deliberately non-awaited — repair
        // state is a safety net, never a dependency of the turn lifecycle.
        void this.clearInflight(mainCardMessageId)
      },
      onSegmentDelivered: (mainCardMessageId, segmentIndex, messageId, mode) => {
        void this.recordSegmentDelivery(mainCardMessageId, segmentIndex, messageId, mode)
      },
      sendSegmentCard: (sessionId, segment, card, fallbackText) =>
        this.sendSegmentCard(sessionId, segment, card, fallbackText),
    }
    this.streamer = new TurnStreamer(
      channel,
      this.config.refreshMs,
      hooks,
      this.config.statusRefreshMs,
    )

    this.domain = await openFeishuDomain(this.ctx)
    for (const [key, record] of this.domain.routes.entries()) {
      this.routeCache.set(key, normalizeRouteRecord(record))
    }

    // HITL: answer the host's approval/request waterfall for sessions this
    // channel routes. `prepend` claims such requests BEFORE the web gateway's
    // generic answerer (its panel would be invisible to a Feishu user), while
    // non-owned sessions delegate through `next()`.
    const answerer = new ApprovalAnswerer(channel, {
      routeFor: sessionId => this.approvalRouteFor(sessionId),
      onError: (sessionId, error) => {
        this.ctx.logger?.warn?.('dsh-channels approval error (session %s): %s', sessionId, String(error))
      },
    }, this.config.approvalTimeoutMs)
    this.approvalAnswerer = answerer
    this.unlistenApproval = this.ctx.on('approval/request', (req, next) => answerer.onRequest(req, next), { prepend: true })
    this.unlistenCardAction = channel.onCardAction(event => {
      answerer.onCardAction(event)
    })

    this.ctx.on('session/event', (session, event) => {
      this.streamer?.onSessionEvent(session, event)
    })
    this.unlisten = channel.onMessage(message => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels inbound error: %s', String(error))
        // User-facing safety net: never leave the user without a reply.
        void channel
          .send(message.chatId, { text: `dsh-channels 处理失败：${String(error)}` }, { replyTo: message.messageId })
          .catch(() => {})
      })
    })
    await channel.connect()
    // Repair cards a previous instance left mid-flight (best-effort, background).
    void this.repairInflight().catch((error: unknown) => {
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
      this.routeCache.size,
    )
    console.info('[dsh-channels] feishu long connection established, bot open_id:', channel.botOpenId())
    console.info('[dsh-channels] activity build:', ACTIVITY_BUILD_MARKER)
    const approvalMounted = this.ctx.get?.('approval') !== undefined
    console.info(
      approvalMounted
        ? `[dsh-channels] HITL 审批应答已就绪（决策卡片超时 ${this.config.approvalTimeoutMs} ms）`
        : '[dsh-channels] 主机未挂载 approval 服务，HITL 审批应答关闭',
    )
  }

  /** Tear down: close the connection and dispose all live agents. */
  async shutdown(): Promise<void> {
    this.unlisten?.()
    this.unlisten = undefined
    this.unlistenCardAction?.()
    this.unlistenCardAction = undefined
    this.unlistenApproval?.()
    this.unlistenApproval = undefined
    // Withdraw in-flight approval questions (the host settles them cancelled).
    this.approvalAnswerer?.dispose()
    this.approvalAnswerer = undefined
    if (this.gcTimer !== undefined) {
      clearInterval(this.gcTimer)
      this.gcTimer = undefined
    }
    for (const { handle } of this.live.values()) {
      await handle.dispose().catch(() => {})
    }
    this.live.clear()
    this.pendingResume.clear()
    this.establishing.clear()
    this.routeOperations.clear()
    this.accepted.clear()
    try {
      await this.channel?.disconnect()
    } catch {
      // Already disconnected is fine.
    }
    this.channel = undefined
    this.streamer = undefined
    await this.domain?.close()
    this.domain = undefined
    this.started = false
  }

  // ---- inbound routing -------------------------------------------------

  private async handleMessage(msg: NormalizedMessage): Promise<void> {
    const botId = this.requireChannel().botOpenId()
    if (botId !== undefined && msg.senderId === botId) return
    if (msg.chatType !== 'p2p' && msg.chatType !== 'group') return
    const content = (msg.content ?? '').trim()
    if (content === '') return

    if (msg.chatType === 'p2p' && this.config.dmMode === 'disabled') return

    // 0. Idempotency gate: Feishu redelivers un-acked events on WS reconnect.
    //    The in-process guard closes the window between the persisted check
    //    and its `put` landing; the durable record covers restarts. Recording
    //    happens BEFORE any side effect so a redelivery is dropped, never
    //    double-processed (at-most-once per message id).
    if (this.accepted.has(msg.messageId)) return
    if (this.domain?.processed.get(msg.messageId) !== undefined) return
    this.accepted.set(msg.messageId, Date.now())
    try {
      await this.domain?.processed.put(msg.messageId, {
        key: msg.messageId,
        processedAt: Date.now(),
      })
      this.accepted.delete(msg.messageId)
    } catch (error) {
      // Best-effort: the memory guard still covers this process; the failed
      // record only widens the crash window (pruned by the GC sweep later).
      this.ctx.logger?.warn?.('dsh-channels: recording processed message %s failed: %s', msg.messageId, String(error))
    }

    // Slash admission stays behind message-id dedup but ahead of every route,
    // mention, workspace, Session, card-stream, and model side effect.
    if (content.startsWith('/')) {
      await this.handleSlashMessage(msg, content)
      return
    }

    // 1. Real topic route first (works without a mention, per product spec).
    if (msg.threadId !== undefined) {
      const record = this.lookupRoute(msg.threadId)
      if (record !== undefined) {
        await this.routeOperations.run(record.key, () =>
          this.continueSession(msg, this.lookupRoute(record.key) ?? record))
        return
      }
    }

    // 2. Degraded chat-scoped route (topic-less fallback sessions).
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const chatRecord = this.lookupRoute(chatKey)
    if (chatRecord !== undefined) {
      await this.routeOperations.run(chatRecord.key, () =>
        this.continueSession(msg, this.lookupRoute(chatRecord.key) ?? chatRecord))
      return
    }

    // 3. In-flight establishment for this (chat, user) pair: wait for it and
    //    re-route with serial semantics (see the `establishing` field docs).
    const pending = this.establishing.get(chatKey)
    if (pending !== undefined) {
      const record = await pending.catch(() => undefined)
      if (record !== undefined
        && (record.kind === 'chat' || (msg.threadId !== undefined && msg.threadId === record.key))) {
        await this.routeOperations.run(record.key, () =>
          this.continueSession(msg, this.lookupRoute(record.key) ?? record))
        return
      }
      // Thread-scoped record but this message is not in that topic (or the
      // establishment failed): fall through — a fresh session is what the
      // serial order would have produced too.
    }

    // 4. New session: groups require a mention (unless disabled).
    if (msg.chatType === 'group' && this.config.requireMention && !msg.mentionedBot) return

    await this.startSession(msg, content)
  }

  /** Resolve the route visible to one command without creating a Session. */
  private async commandRoute(msg: NormalizedMessage): Promise<RouteRecord | undefined> {
    if (msg.threadId !== undefined) {
      const threaded = this.lookupRoute(msg.threadId)
      if (threaded !== undefined) return threaded
    }
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const degraded = this.lookupRoute(chatKey)
    if (degraded !== undefined) return degraded
    const pending = this.establishing.get(chatKey)
    if (pending === undefined) return undefined
    const record = await pending.catch(() => undefined)
    if (record?.kind === 'chat') return record
    if (record !== undefined && msg.threadId === record.key) return record
    return undefined
  }

  /** Slash-command plane. Nothing in this method calls `agent.followup()`. */
  private async handleSlashMessage(msg: NormalizedMessage, line: string): Promise<void> {
    const parsed = parseSlashCommand(line)
    if (parsed === undefined) {
      await this.sendCommandCard(msg, {
        kind: 'input-error',
        text: '命令名必须以小写字母开头，且只能包含小写字母、数字、下划线或连字符。',
        supported: supportedCommandList(),
      })
      return
    }
    if (!isSupportedCommand(parsed.name)) {
      await this.sendCommandCard(msg, {
        kind: 'unknown', command: parsed.name,
        text: `未找到命令 /${parsed.name}。`, supported: supportedCommandList(),
      })
      return
    }

    const route = await this.commandRoute(msg)
    if (route === undefined) {
      if (parsed.name !== 'health') {
        await this.sendCommandCard(msg, {
          kind: 'unbound', command: parsed.name,
          text: '当前话题尚未绑定 Session。请先发送普通消息创建会话，或使用 /health 检查通道。',
        })
        return
      }
      if (parsed.rawInput.trim() !== '') {
        await this.sendCommandCard(msg, {
          kind: 'input-error', command: parsed.name, text: '用法错误：/health 不接受参数。',
        })
        return
      }
      await this.withCommandReaction(msg, async () => {
        await this.sendHealthCard(msg)
      })
      return
    }

    if (msg.senderId !== route.senderOpenId) {
      await this.sendCommandCard(msg, {
        kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
      })
      return
    }

    await this.routeOperations.run(route.key, async () => {
      const current = this.lookupRoute(route.key) ?? route
      if (msg.senderId !== current.senderOpenId) {
        await this.sendCommandCard(msg, {
          kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
        })
        return
      }
      await this.withCommandReaction(msg, async () => {
        try {
          const live = await this.ensureLiveAgent(current)
          let definition = this.ctx.commands.find(live.agent, parsed.name)
          let unregisterBorrowedRenew: (() => void) | undefined
          if (definition === undefined && parsed.name === 'renew') {
            unregisterBorrowedRenew = registerRenewCommand(live.agent.ctx.commands)
            definition = this.ctx.commands.find(live.agent, parsed.name)
          }
          if (definition === undefined) {
            unregisterBorrowedRenew?.()
            const text = parsed.name === 'compact'
              ? '当前部署未挂载 Harness 原生 /compact 命令。'
              : `当前 Session 未挂载 /${parsed.name} 命令。`
            await this.sendCommandCard(msg, {
              kind: 'unavailable', command: parsed.name, text,
              sessionId: current.sessionId,
            })
            return
          }
          const compactBefore = parsed.name === 'compact'
            ? await this.measureCommandContext(live.agent.session)
            : undefined
          const controller = new AbortController()
          const renewAdmission: RenewAdmission | undefined = parsed.name === 'renew'
            ? { route: current, live }
            : undefined
          const disarmRenew = renewAdmission === undefined
            ? undefined
            : armRenewCommand(
                controller.signal,
                invocation => this.runRenewCommand(invocation, renewAdmission),
              )
          let execution
          try {
            execution = await this.ctx.commands.execute(live.agent, line, controller.signal)
          } finally {
            disarmRenew?.()
            unregisterBorrowedRenew?.()
            if (renewAdmission !== undefined) {
              if (renewAdmission.commit !== undefined) {
                await this.releaseRenewedAgent(renewAdmission.commit)
              }
            }
          }
          if (execution === undefined) {
            await this.sendCommandCard(msg, {
              kind: 'unavailable', command: parsed.name,
              text: `当前 Session 无法执行 /${parsed.name}。`, sessionId: current.sessionId,
            })
            return
          }
          const result = execution.result
          if (parsed.name === 'renew' && result.kind === 'success' && renewAdmission?.commit !== undefined) {
            await this.sendStandaloneCard(msg, buildRenewCard({
              previousSessionId: renewAdmission.commit.previous.sessionId,
              currentSessionId: renewAdmission.commit.current.sessionId,
              workspacePath: renewAdmission.commit.current.workspacePath,
            }))
            return
          }
          if (parsed.name === 'health' && result.kind === 'success') {
            await this.sendHealthCard(msg)
            return
          }
          if (parsed.name === 'status' && result.kind === 'success') {
            const stats = foldAll(live.agent.session.events)
            const context = await measureSessionContext(
              live.agent.session, this.commandContextServices(), stats.lastHeader,
            )
            await this.sendStandaloneCard(msg, buildSessionStatusCard({
              sessionId: current.sessionId,
              stats,
              context,
            }))
            return
          }
          if (parsed.name === 'work-dir' && result.kind === 'success') {
            const resolved = resolveWorkDir(live.agent.session.header.cwd, current.workspacePath)
            if (resolved.kind === 'success') {
              await this.sendStandaloneCard(msg, buildWorkDirCard(current.sessionId, resolved.path))
              return
            }
            if (resolved.kind === 'mismatch') {
              this.ctx.logger?.warn?.(
                'dsh-channels: workspace mismatch for session %s (paths redacted)', current.sessionId,
              )
            }
            await this.sendCommandCard(msg, {
              kind: 'unavailable', command: parsed.name,
              text: resolved.text, sessionId: current.sessionId,
            })
            return
          }
          if (parsed.name === 'history' && result.kind === 'success') {
            await this.sendStandaloneCard(msg, buildSessionHistoryCard(current))
            return
          }
          if (parsed.name === 'compact' && compactBefore !== undefined) {
            const compactAfter = await this.measureCommandContext(live.agent.session)
            if (result.kind === 'success') {
              await this.sendStandaloneCard(msg, buildCompactComparisonCard({
                sessionId: current.sessionId,
                resultText: result.text ?? '命令已执行。',
                before: compactBefore,
                after: compactAfter,
              }))
              return
            }
            await this.sendCommandCard(msg, {
              kind: commandResultCardKind(result), command: parsed.name,
              text: `${result.text}\n\n${compactFailureContext(compactBefore, compactAfter)}`,
              sessionId: current.sessionId,
            })
            return
          }
          await this.sendCommandCard(msg, {
            kind: commandResultCardKind(result), command: parsed.name,
            text: result.text ?? '命令已执行。', sessionId: current.sessionId,
          })
        } catch (error) {
          this.ctx.logger?.warn?.(
            'dsh-channels: command /%s failed for session %s: %s',
            parsed.name, current.sessionId, String(error),
          )
          await this.sendCommandCard(msg, {
            kind: 'internal-error', command: parsed.name,
            text: '命令执行失败，请稍后重试；若持续发生，请查看 Harness 日志。',
            sessionId: current.sessionId,
          })
        }
      })
    })
  }

  /** Apply the command-only Typing → DONE reaction lifecycle. */
  private async withCommandReaction(msg: NormalizedMessage, operation: () => Promise<void>): Promise<void> {
    const reactionId = await this.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)
    try {
      await operation()
    } finally {
      if (reactionId !== undefined) {
        await this.requireChannel().removeReaction(msg.messageId, reactionId).catch(() => {})
      }
      await this.requireChannel().addReaction(msg.messageId, 'DONE').catch(() => {})
    }
  }

  /** Standalone, non-streaming result card with a non-threaded fallback. */
  private async sendCommandCard(msg: NormalizedMessage, state: CommandCardState): Promise<void> {
    await this.sendStandaloneCard(msg, buildCommandResultCard(state))
  }

  /** Collect and send a privacy-preserving snapshot without Session I/O. */
  private async sendHealthCard(msg: NormalizedMessage): Promise<void> {
    await this.sendStandaloneCard(msg, buildHealthCard(this.healthSnapshot()))
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

  /** Shared delivery policy for command-plane cards. */
  private async sendStandaloneCard(msg: NormalizedMessage, card: object): Promise<void> {
    const channel = this.requireChannel()
    try {
      await channel.send(msg.chatId, { card }, { replyTo: msg.messageId, replyInThread: true })
    } catch (error) {
      try {
        await channel.send(msg.chatId, { card }, { replyTo: msg.messageId })
      } catch (fallbackError) {
        this.ctx.logger?.warn?.(
          'dsh-channels: command result delivery failed for message %s: %s / %s',
          msg.messageId, String(error), String(fallbackError),
        )
      }
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

    let inflightTurnCount = 0
    try {
      if (this.domain !== undefined) {
        for (const _entry of this.domain.inflight.entries()) inflightTurnCount++
      }
    } catch {
      // The storage dependency is reported separately; never expose details.
    }

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
      routeCount: this.routeCache.size,
      liveAgentCount: this.live.size,
      inflightTurnCount,
    })
  }

  private lookupRoute(key: string): RouteRecord | undefined {
    const cached = this.routeCache.get(key)
    if (cached !== undefined) return cached
    const stored = this.domain?.routes.get(key)
    if (stored === undefined) return undefined
    const normalized = normalizeRouteRecord(stored)
    this.routeCache.set(key, normalized)
    return normalized
  }

  private async persistRoute(key: string, record: RouteRecord): Promise<void> {
    await this.domain?.routes.put(key, record)
    this.routeCache.set(key, normalizeRouteRecord(record))
  }

  // ---- in-flight turn snapshots (restart repair) -------------------------

  /** Write the turn's repair snapshot. Keyed by the main card message id. */
  private async writeInflightSnapshot(snapshot: InflightSnapshot): Promise<void> {
    await this.domain?.inflight.put(snapshot.key, snapshot)
  }

  /** Retire a snapshot (turn finalized / creation failed). Never throws. */
  private async clearInflight(key: string): Promise<void> {
    if (key === '') return
    try {
      await this.domain?.inflight.delete(key)
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: clearing inflight snapshot %s failed: %s', key, String(error))
    }
  }

  /**
   * Fold a resolved segment card id into the turn's snapshot (atomic
   * read-modify-write). A missing snapshot means the turn already finalized
   * (the finalize delete won the race) — silently skipped.
   */
  private async recordSegmentDelivery(
    mainCardMessageId: string,
    segmentIndex: number,
    messageId: string,
    mode: 'card' | 'text',
  ): Promise<void> {
    if (mainCardMessageId === '') return
    try {
      await this.domain?.inflight.update(mainCardMessageId, snapshot => {
        // The snapshot starts with only the main card; segment sends are
        // serialized in order, so a delivery for index `cards.length` is the
        // next segment (append), anything below replaces, and a gap beyond
        // the tail cannot happen under the serialized chain (ignored).
        const cards = [...snapshot.cards]
        if (segmentIndex === cards.length) {
          cards.push({ messageId, mode })
        } else if (segmentIndex >= 0 && segmentIndex < cards.length) {
          cards[segmentIndex] = { messageId, mode }
        } else {
          return snapshot
        }
        return { ...snapshot, cards }
      })
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: updating inflight snapshot %s failed: %s', mainCardMessageId, String(error),
      )
    }
  }

  /**
   * Startup repair pass: settle every card a previous instance left
   * mid-flight. Runs in the background right after the long connection is
   * established; each snapshot is independent and best-effort.
   *
   * Per snapshot: patch every `card`-mode card to the terminal interrupted
   * state (the partial body is gone with the old process; patch is full
   * replacement), best-effort swap Typing → DONE, then delete. A failed card
   * patch keeps the snapshot for one more attempt (capped at 2) so a
   * transient failure at boot does not lose the repair, while a medium that
   * permanently rejects the patch cannot trigger an endless retry loop.
   */
  private async repairInflight(): Promise<void> {
    const table = this.domain?.inflight
    if (table === undefined) return
    const snapshots = [...table.entries()]
    if (snapshots.length === 0) return
    // With GC enabled, snapshots older than the TTL are the GC pass's job:
    // repairing an ancient card would surprise the user, so repair skips
    // them and lets the GC drop them silently (both passes run at boot).
    const ttlMs = this.config.routeTtlMs
    const cutoff = ttlMs === 0 ? undefined : Date.now() - ttlMs
    const due = snapshots.filter(([, snapshot]) => cutoff === undefined || snapshot.startedAt >= cutoff)
    if (due.length === 0) return
    this.ctx.logger?.info?.('dsh-channels: repairing %d interrupted turn(s)', due.length)
    for (const [key, snapshot] of due) {
      try {
        await this.repairSnapshot(snapshot)
        await table.delete(key)
        this.ctx.logger?.info?.('dsh-channels: repaired interrupted turn card %s', key)
      } catch (error) {
        this.ctx.logger?.warn?.('dsh-channels: repair of turn card %s failed: %s', key, String(error))
        const attempts = snapshot.attempts + 1
        try {
          if (attempts >= 2) {
            await table.delete(key)
          } else {
            await table.put(key, { ...snapshot, attempts })
          }
        } catch {
          // The domain may already be closing (shutdown raced the repair).
        }
      }
    }
  }

  /** Patch the cards of one interrupted turn to their terminal state. */
  private async repairSnapshot(snapshot: InflightSnapshot): Promise<void> {
    const channel = this.requireChannel()
    for (const [index, card] of snapshot.cards.entries()) {
      if (card.mode !== 'card') continue
      // Full replacement: the interrupted card's streamed content lived only
      // in the previous process. Continuation cards keep their segment header.
      const options = index === 0 ? {} : { panel: false, segment: index + 1 }
      await channel.updateCard(card.messageId, buildInterruptionCard(options))
    }
    if (snapshot.reactionId !== undefined) {
      await channel.removeReaction(snapshot.triggerMessageId, snapshot.reactionId).catch(() => {})
    }
    await channel.addReaction(snapshot.triggerMessageId, 'DONE').catch(() => {})
  }

  /**
   * GC pass over the routing domain. Two independent halves:
   *
   * 1. Dedup records (unconditional): `processed` records and in-process
   *    guard entries older than `PROCESSED_RETENTION_MS` are dropped —
   *    redelivery windows are minutes, so a day of retention is ample and
   *    keeps the table bounded regardless of the route TTL setting.
   * 2. Route/inflight GC (`routeTtlMs > 0`): route records idle past the TTL
   *    (a deleted topic's thread id never reappears) and stale in-flight
   *    snapshots (the card they describe is ancient — repairing it now would
   *    surprise the user) are deleted; `routeCache` is purged after the
   *    durable delete lands. Only the plugin's own routing entries are
   *    touched: sessions and workspaces stay in the host, and a later message
   *    in a GC'd topic simply starts a fresh session, exactly like an unknown
   *    topic.
   *
   * Per-key failures are logged and skipped; concurrent writes are safe
   * because `entries()` snapshots.
   */
  private async gcExpiredEntries(): Promise<void> {
    const now = Date.now()
    const processedCutoff = now - PROCESSED_RETENTION_MS
    let removedRoutes = 0
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
    for (const [messageId, acceptedAt] of this.accepted) {
      if (acceptedAt < processedCutoff) this.accepted.delete(messageId)
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
          await routes.delete(key)
          this.routeCache.delete(key)
          removedRoutes++
        } catch (error) {
          this.ctx.logger?.warn?.('dsh-channels: GC of route %s failed: %s', key, String(error))
        }
      }
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
        'dsh-channels: record GC removed %d route(s), %d stale snapshot(s), %d dedup record(s)',
        removedRoutes, removedInflight, removedProcessed,
      )
    }
  }

  /** Find the route record owning a session (prefers the thread route). */
  private findRouteBySession(sessionId: string): RouteRecord | undefined {
    let fallback: RouteRecord | undefined
    for (const record of this.routeCache.values()) {
      if (record.sessionId !== sessionId) continue
      if (record.kind === 'thread') return record
      fallback ??= record
    }
    return fallback
  }

  /**
   * HITL answerer hook: the Feishu placement of one session's approval cards,
   * or `undefined` when this channel does not route the session (the answerer
   * then delegates to other answerers).
   */
  private approvalRouteFor(sessionId: string): ApprovalRoute | undefined {
    const record = this.findRouteBySession(sessionId)
    if (record === undefined) return undefined
    return {
      chatId: record.chatId,
      cardMessageId: record.cardMessageId,
      inThread: record.kind === 'thread',
      senderOpenId: record.senderOpenId,
    }
  }

  /**
   * Send one body-segment continuation card into the session's topic (or, for
   * degraded chat-scoped routes, as a plain reply anchored to the main card).
   * When Feishu rejects the card (e.g. per-card table limit, error 11310) the
   * segment is re-delivered as a plain-text message so the content is never
   * lost — text messages carry no card constraints.
   */
  private async sendSegmentCard(
    sessionId: string,
    segment: number,
    card: object,
    fallbackText: string,
  ): Promise<{ messageId: string; mode: 'card' | 'text' }> {
    const record = this.findRouteBySession(sessionId)
    if (record === undefined) {
      throw new Error(`dsh-channels: no route record for session ${sessionId}; segment card not sent`)
    }
    const options = { replyTo: record.cardMessageId, replyInThread: record.kind === 'thread' }
    try {
      const res = await this.requireChannel().send(record.chatId, { card }, options)
      return { messageId: res.messageId, mode: 'card' }
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: segment %d card for session %s rejected, falling back to plain text: %s',
        segment, sessionId, String(error),
      )
      const res = await this.requireChannel().send(record.chatId, {
        text: `📄 回复分段 ${segment}（卡片发送失败，已降级为纯文本）\n\n${fallbackText}`,
      }, options)
      return { messageId: res.messageId, mode: 'text' }
    }
  }

  // ---- session lifecycle ----------------------------------------------

  private agentOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {}
    if (this.config.provider !== undefined) options.provider = this.config.provider
    if (this.config.model !== undefined) options.model = this.config.model
    if (this.config.maxTokens !== undefined) options.maxTokens = this.config.maxTokens
    return options
  }

  /**
   * Resolve the agent-preset composition for sessions this plugin creates or
   * resumes.
   *
   * `agents.create()` never applies a preset on its own — the caller composes
   * the agent's world through the `setup` callback, which the factory awaits
   * before publishing the session. In web-profile deployments the model-facing
   * tools exist only inside agent presets (the host disables the tool rows at
   * the host layer), so sessions created without mounting one reach the model
   * with an empty tool list: the agent writes `<tool_calls>` as plain text and
   * stops. Web-UI sessions mount the default preset via `session.create`;
   * channels sessions must do the same through `setup`, and record the preset
   * id on the header meta exactly like the host's own `composeAgent` does.
   *
   * The id resolves BEFORE the session exists because the session boundary
   * snapshots `meta` before asynchronous setup begins. Mounting stays inside
   * `setup`, where a failure rolls the whole creation back rather than
   * publishing a session whose capabilities are half-installed.
   *
   * Deployments without a preset roster compose nothing: their tools live in
   * the host composition and the agent already sees them.
   */
  private async resolvePresetComposition(
    requestedPreset: string | undefined = this.config.agentPreset,
    useRosterDefault = true,
  ): Promise<PresetComposition> {
    // Read through ctx.get (safe lookup): only the web profile ships a roster,
    // and direct property access on a cordis context throws for services the
    // plugin did not inject.
    const presets = this.ctx.get?.('agentPresets') as AgentPresets | undefined
    if (presets === undefined) {
      return {
        setup: agentCtx => {
          registerChannelCommands(agentCtx.commands)
        },
      }
    }
    if (requestedPreset === undefined && !useRosterDefault) {
      return { setup: agentCtx => { registerChannelCommands(agentCtx.commands) } }
    }
    const resolved = await presets.resolve(requestedPreset)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id)
        registerChannelCommands(agentCtx.commands)
      },
    }
  }

  /** Effective preset after folding any durable runtime preset switch. */
  private effectiveAgentPreset(session: Session): string | undefined {
    let selected = session.header.agentPreset
    for (const event of session.events) {
      if (event.type === 'agent-preset/selected') selected = event.data.agentPreset
    }
    return selected
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
    const current = this.lookupRoute(admission.route.key)
    if (current === undefined || current.sessionId !== admission.route.sessionId) {
      return { kind: 'error', text: '当前话题绑定已变化，请重试 /renew。' }
    }
    try {
      admission.commit = await this.commitRenew(current, admission.live)
      return { kind: 'success', text: '新 Session 已创建并绑定。' }
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: renew transaction failed for session %s: %s',
        current.sessionId, String(error),
      )
      return { kind: 'error', text: 'Session 续建失败，原 Session 仍保持绑定；请稍后重试。' }
    }
  }

  /** Create, workspace-attach, and atomically publish one renewed route. */
  private async commitRenew(record: RouteRecord, oldLive: LiveAgent): Promise<RenewCommit> {
    const sessionId = randomUUID() as SessionId
    const preset = this.effectiveAgentPreset(oldLive.agent.session)
    const composition = await this.resolvePresetComposition(preset, false)
    const workspace = await this.ctx.workspaceRegistry.create(
      record.workspacePath,
      workspaceTitleFor(record.chatType, record.chatId, record.senderOpenId),
    )

    let newHandle: AgentHandle | undefined
    let attached = false
    try {
      newHandle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: record.workspacePath,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { ...oldLive.agent.options },
        setup: composition.setup,
      })
      await workspace.attachSession(sessionId)
      attached = true
      const createdAt = newHandle.agent.session.header.createdAt

      const current: RouteRecord = {
        ...record,
        sessionId,
        sessionHistory: appendSessionHistory(record, sessionId, createdAt),
        lastActivityAt: Date.now(),
      }
      await this.persistRoute(record.key, current)
      this.live.set(sessionId, { agent: newHandle.agent, handle: newHandle })
      return { previous: record, current, oldLive }
    } catch (error) {
      if (attached) {
        await Promise.resolve(workspace.detachSession(sessionId)).catch((detachError: unknown) => {
          this.ctx.logger?.warn?.(
            'dsh-channels: rolling back workspace attachment for session %s failed: %s',
            sessionId, String(detachError),
          )
        })
      }
      await newHandle?.dispose().catch(() => {})
      throw error
    }
  }

  /** Release only this plugin's old handle, after `command/done` has landed. */
  private async releaseRenewedAgent(commit: RenewCommit): Promise<void> {
    const oldSessionId = commit.previous.sessionId
    if (this.live.get(oldSessionId) === commit.oldLive) {
      this.live.delete(oldSessionId)
      this.streamer?.detach(oldSessionId)
    }
    try {
      await commit.oldLive.handle.dispose()
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: releasing renewed session %s handle failed: %s',
        oldSessionId, String(error),
      )
    }
  }

  /**
   * Serialize session establishment per (chat, user) pair. The promise is
   * registered under the chat-scoped key SYNCHRONOUSLY (the key is known
   * before any network op), so concurrent first messages all observe the same
   * in-flight establishment instead of racing each other. The entry lives
   * exactly as long as the establishment; waiters holding the promise still
   * see the settled record after the entry is gone.
   */
  private startSession(msg: NormalizedMessage, content: string): Promise<RouteRecord> {
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const existing = this.establishing.get(chatKey)
    if (existing !== undefined) return existing
    const promise = this.establishSession(msg, content, chatKey)
    this.establishing.set(chatKey, promise)
    void promise.then(
      () => { this.establishing.delete(chatKey) },
      () => { this.establishing.delete(chatKey) },
    )
    return promise
  }

  private async establishSession(msg: NormalizedMessage, content: string, chatKey: string): Promise<RouteRecord> {
    // 1. "Typing" reaction immediately (id captured for the swap).
    const typingPromise = this.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)

    // 2. Workspace directory for this (user × chat) pair.
    const workspace = await ensureWorkspace(
      this.ctx, this.config.baseDir, msg.chatType, msg.chatId, msg.senderId,
    )

    const sessionId = randomUUID() as SessionId
    const initialStats = { sessionId, inputTokens: 0, outputTokens: 0 }

    // 3. First card frame — also creates the topic (reply_in_thread).
    const sent = await this.sendReplyCard(msg, this.initialCard(sessionId))
    const typingId = await typingPromise

    // 3.5 Repair snapshot FIRST (before the route record and the agent):
    // the crash window between the two writes then degrades to an orphan
    // snapshot — which startup repair handles safely — instead of a zombie
    // streaming card with no snapshot at all.
    await this.writeInflightSnapshot({
      key: sent.messageId,
      sessionId,
      chatId: msg.chatId,
      triggerMessageId: msg.messageId,
      reactionId: typingId,
      cards: [{ messageId: sent.messageId, mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
    })

    // 4. Create the agent/session bound to the workspace directory.
    let handle: AgentHandle
    try {
      const composition = await this.resolvePresetComposition()
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspace.path,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions: this.agentOptions(),
        setup: composition.setup,
      })
    } catch (error) {
      // The card lands in a final failure state — no repair needed later.
      void this.clearInflight(sent.messageId)
      await this.requireChannel().updateCard(sent.messageId, buildCard({
        phase: 'done',
        reasoning: '',
        body: `会话创建失败：${String(error)}`,
        stats: { ...initialStats },
      })).catch(() => {})
      throw error
    }
    this.live.set(sessionId, { agent: handle.agent, handle })
    void Promise.resolve(workspace.attachSession(sessionId)).catch(error => {
      this.ctx.logger?.warn?.(
        'dsh-channels: attaching initial session %s to workspace failed: %s',
        sessionId, String(error),
      )
    })

    // 5. Persist the route (thread-scoped, or degraded chat-scoped).
    const key = sent.degraded || sent.threadId === undefined ? chatKey : sent.threadId
    const createdAt = handle.agent.session.header.createdAt
    const record: RouteRecord = {
      key,
      kind: sent.degraded || sent.threadId === undefined ? 'chat' : 'thread',
      sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderOpenId: msg.senderId,
      workspacePath: workspace.path,
      cardMessageId: sent.messageId,
      createdAt,
      lastActivityAt: createdAt,
      sessionHistory: [{ sessionId, createdAt }],
    }
    await this.persistRoute(key, record)

    // 6. Stream into the card and hand the message to the driver.
    this.streamer?.attach(handle.agent.session, sent.messageId, msg.messageId, typingId)
    handle.agent.followup(feishuUserMessage(content))
    return record
  }

  private async continueSession(msg: NormalizedMessage, record: RouteRecord): Promise<void> {
    const typingPromise = this.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)
    const live = await this.ensureLiveAgent(record)

    const sent = await this.sendReplyCard(msg, this.initialCard(record.sessionId as SessionId))
    const typingId = await typingPromise

    // Repair snapshot first — same crash-window reasoning as `startSession`.
    await this.writeInflightSnapshot({
      key: sent.messageId,
      sessionId: record.sessionId,
      chatId: msg.chatId,
      triggerMessageId: msg.messageId,
      reactionId: typingId,
      cards: [{ messageId: sent.messageId, mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
    })

    await this.persistRoute(record.key, {
      ...record,
      cardMessageId: sent.messageId,
      lastActivityAt: Date.now(),
    })
    this.streamer?.attach(live.agent.session, sent.messageId, msg.messageId, typingId)
    live.agent.followup(feishuUserMessage(msg.content))
  }

  private async ensureLiveAgent(record: RouteRecord): Promise<LiveAgent> {
    const live = this.live.get(record.sessionId)
    if (live !== undefined) return live

    // The session may already be live under another owner — the web UI's
    // api-remote resolver, a previous plugin instance whose shutdown is still
    // draining, or a concurrent cold resume that won the race. `agents.resume`
    // refuses a live session ("cannot prepare … while it is live"), so BORROW
    // the live agent instead: `followup` delivery works identically and the
    // owning side keeps the dispose responsibility.
    const foreign = this.ctx.agents.get(record.sessionId as SessionId)
    if (foreign !== undefined) return borrowLiveAgent(foreign)

    let pending = this.pendingResume.get(record.sessionId)
    if (pending === undefined) {
      // Compose the resumed world from the same preset resolution as creation
      // (config override or roster default). A session persisted before this
      // fix has no preset recorded on its header; re-resolving here is what
      // repairs it on the first resume after a restart.
      pending = this.resolvePresetComposition()
        .then(composition => this.ctx.agents.resume({
          resumeSessionId: record.sessionId as SessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        }))
        .then(handle => {
          if (!this.started) {
            // Shutdown raced this in-flight resume: dispose the just-published
            // agent so it cannot leak into the live registry of the next
            // instance (whose every resume would then fail as "while it is live").
            void handle.dispose().catch(() => {})
            throw new Error('dsh-channels: session resume aborted by shutdown')
          }
          const liveAgent: LiveAgent = { agent: handle.agent, handle }
          this.live.set(record.sessionId, liveAgent)
          return liveAgent
        })
        .catch((error: unknown) => {
          // Lost a cold-resume race: another owner published the session
          // while our resume was in flight. Borrow the winner instead of
          // failing the turn with "cannot prepare … while it is live".
          const winner = this.ctx.agents.get(record.sessionId as SessionId)
          if (winner !== undefined) return borrowLiveAgent(winner)
          throw error
        })
        .finally(() => {
          this.pendingResume.delete(record.sessionId)
        })
      this.pendingResume.set(record.sessionId, pending)
    }
    return await pending
  }

  // ---- outbound helpers ------------------------------------------------

  private initialCard(sessionId: SessionId): object {
    const state: CardState = {
      phase: 'thinking',
      reasoning: '',
      body: '',
      stats: { sessionId, inputTokens: 0, outputTokens: 0 },
    }
    return buildCard(state)
  }

  /**
   * Reply with the first card frame. Prefers topic replies (`reply_in_thread`)
   * — the documented way a bot creates a topic — and falls back to a plain
   * reply when Feishu refuses (degraded chat-scoped routing).
   */
  private async sendReplyCard(
    msg: NormalizedMessage,
    card: object,
  ): Promise<{ messageId: string; threadId?: string; degraded: boolean }> {
    try {
      const res = await this.requireChannel().send(
        msg.chatId,
        { card },
        { replyTo: msg.messageId, replyInThread: true },
      )
      const threadId = await this.requireChannel().threadIdOfMessage(res.messageId).catch(() => undefined)
      return { messageId: res.messageId, threadId, degraded: false }
    } catch (error) {
      if (this.config.threadFallback === 'strict') throw error
      const res = await this.requireChannel().send(msg.chatId, { card }, { replyTo: msg.messageId })
      return { messageId: res.messageId, degraded: true }
    }
  }

  /** Context pressure for the card's second info line (synchronous fold). */
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

    let contextWindow: number | undefined
    try {
      const headers = session.events.filter(event => event.type === 'request/header')
      const last = headers.at(-1)
      if (last !== undefined && last.type === 'request/header') {
        const config = last.data.header?.config as { provider?: unknown; model?: unknown } | undefined
        if (typeof config?.provider === 'string' && typeof config.model === 'string') {
          const routeKey = `${config.provider}/${config.model}`
          contextWindow = this.contextWindows.get(routeKey)
          if (contextWindow === undefined && !this.windowRequests.has(routeKey)) {
            this.windowRequests.add(routeKey)
            const llm = this.ctx.get?.('llm') as LlmService | undefined
            void llm?.resolveModelInfo(config.provider, config.model)
              .then(info => {
                if (info?.context?.contextWindow !== undefined) {
                  this.contextWindows.set(routeKey, info.context.contextWindow)
                }
              })
              .catch(() => {})
          }
        }
      }
    } catch {
      contextWindow = undefined
    }

    return { contextTokens, contextWindow }
  }
}
