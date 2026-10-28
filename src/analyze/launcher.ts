/**
 * Log-platform analysis launcher: the business side of the analyze API.
 *
 * Synchronously (before the `202`): service state, target-group permission,
 * `Idempotency-Key` replay, and the root card (分析中). In the background: the
 * topic (opened by the first streaming card, replied in thread below the root
 * card), the `<baseDir>/analyze/<app>/<errorCode>` workspace and its per-topic
 * directory, the Session, the group-shared route, and the first turn: the
 * platform prompt verbatim, streamed into that card like any topic turn. When
 * the first turn settles, the root card's status follows it (已完成 / 已停止 /
 * 失败), and the request record keeps the same status. At channel start,
 * records still `running` belong to analyses a previous instance never
 * finished; {@link AnalyzeLauncher.markInterrupted} marks their cards 已中断.
 * Log packages are fetched by the analysis skill the prompt invokes.
 *
 * The topic is reserved in the inbound router from its creation until the
 * route and the first prompt are published, so replies posted meanwhile queue
 * behind the first turn. Follow-ups then use the ordinary topic routing: the
 * route is `shared`, so every member admitted in the group may continue it. A
 * failure before the first turn (including a disconnect meanwhile) marks the
 * root card failed with the reason, closes the streaming card, and leaves no
 * route.
 *
 * @module dsh-channels/analyze/launcher
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, HostContext, SessionId } from '../dsh-types.ts'
import type { FeishuConfig } from '../config.ts'
import { buildAnalyzeRootCard, buildCard, initialStreamingCard } from '../cards.ts'
import type { AnalyzeStatus, AnalyzeSubject } from '../cards.ts'
import type { RouteOperationQueue } from '../commands.ts'
import type { AnalyzeRequestRecord, FeishuDomainHandle, RouteRecord } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import { feishuUserMessage } from '../routing/inbound.ts'
import { enterTopic, placementServices, planTopic } from '../session/isolation.ts'
import type { TopicPlacement } from '../session/isolation.ts'
import type { SessionManager } from '../session/manager.ts'
import type { InflightRepair } from '../session/repair.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TurnStreamer } from '../streamer.ts'
import { ensureAnalyzeWorkspace, topicTokenFor } from '../workspaces.ts'
import { analyzeRequestHash } from './contract.ts'
import type { AnalyzeAccepted, AnalyzeRequest, AnalyzeResponse } from './contract.ts'
import type { AnalyzeHandler } from './server.ts'

/** Collaborators of the launcher (late-bound where the service swaps them per connection). */
export interface AnalyzeLauncherDeps {
  ctx: HostContext
  config: FeishuConfig
  started(): boolean
  channel(): FeishuChannel | undefined
  domain(): FeishuDomainHandle | undefined
  routes: RouteStore
  repair: InflightRepair
  sessions: SessionManager
  streamer(): TurnStreamer | undefined
  /** Shared per-route FIFO (the first turn must precede any follow-up). */
  queue: RouteOperationQueue
  /**
   * Reserve an opened topic until its route is published, so replies posted
   * meanwhile wait instead of being dropped or starting a competing Session.
   * The returned closer is called exactly once.
   */
  reserveTopic(threadId: string): () => void
  /** Whether the analyze API may post into the group. */
  mayAnalyzeIn(chatId: string): boolean
  /** Resolve the configured bearer token; undefined when unresolvable. */
  resolveToken(): Promise<string | undefined>
}

/** One accepted request still answering its `202`. */
interface PendingAccept {
  readonly bodyHash: string
  readonly response: Promise<AnalyzeResponse>
}

/** Readable reason of an error value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AnalyzeLauncher implements AnalyzeHandler {
  /** `Idempotency-Key` → request still being accepted (concurrent retries share it). */
  private readonly accepting = new Map<string, PendingAccept>()
  /** Background analyses still starting (drained on shutdown). */
  private readonly running = new Set<Promise<void>>()
  /** Whether requests are admitted: from {@link open} after start until {@link close}. */
  private admitting = false

  constructor(private readonly deps: AnalyzeLauncherDeps) {}

  /**
   * Start admitting requests. Called at channel start after
   * {@link markInterrupted}, so a new request is never marked interrupted.
   */
  open(): void {
    this.admitting = true
  }

  /** Stop admitting requests (503) ahead of shutdown. */
  close(): void {
    this.admitting = false
  }

  enabled(): boolean {
    return this.deps.config.analyzeEnabled
  }

  async token(): Promise<string | undefined> {
    return await this.deps.resolveToken()
  }

  async analyze(request: AnalyzeRequest, idempotencyKey: string): Promise<AnalyzeResponse> {
    const bodyHash = analyzeRequestHash(request)
    const pending = this.accepting.get(idempotencyKey)
    if (pending !== undefined) {
      if (pending.bodyHash !== bodyHash) return reusedKey()
      return await pending.response
    }
    const response = this.accept(request, idempotencyKey, bodyHash)
    this.accepting.set(idempotencyKey, { bodyHash, response })
    try {
      return await response
    } finally {
      this.accepting.delete(idempotencyKey)
    }
  }

  /**
   * Wait for every acceptance in flight, then every background analysis that
   * is still starting. Called after `started` turns false, so each one ends on
   * its failure card or, when its first prompt was already sent, as an
   * ordinary topic.
   */
  async drain(): Promise<void> {
    // Acceptances still sending the root card or writing the record finish
    // first; each one adds its launch to `running` before it settles.
    await Promise.allSettled([...this.accepting.values()].map(pending => pending.response))
    await Promise.allSettled([...this.running])
  }

  /**
   * Mark every analysis still `running` as interrupted, on its card and in
   * its record. Called at channel start before admission opens, so each
   * such record belongs to a previous instance whose first turn never
   * settled. A card that cannot be updated (deleted, recalled) is logged and
   * still recorded as interrupted, so it is not retried on every start.
   */
  async markInterrupted(): Promise<void> {
    const channel = this.deps.channel()
    const domain = this.deps.domain()
    if (channel === undefined || domain === undefined) return
    for (const [key, record] of [...domain.analyzeRequests.entries()]) {
      if (record.status !== 'running') continue
      await channel.updateCard(record.messageId, buildAnalyzeRootCard(record.subject, { kind: 'interrupted' }))
        .catch((error: unknown) => {
          this.deps.ctx.logger?.warn?.('dsh-channels: marking analysis card %s interrupted failed: %s', key, String(error))
        })
      await this.recordStatus(key, 'interrupted')
    }
  }

  private async accept(request: AnalyzeRequest, key: string, bodyHash: string): Promise<AnalyzeResponse> {
    const channel = this.deps.channel()
    const domain = this.deps.domain()
    if (!this.admitting || !this.deps.started() || channel === undefined || domain === undefined) {
      return refused(503, '飞书渠道尚未连接，请稍后重试')
    }
    const stored = domain.analyzeRequests.get(key)
    if (stored !== undefined) {
      if (stored.bodyHash !== bodyHash) return reusedKey()
      return { status: 202, body: { ok: true, chatId: stored.chatId, messageId: stored.messageId } }
    }
    if (!this.deps.mayAnalyzeIn(request.chatId)) {
      return refused(403, '目标群未授权：请管理员在该群发送 /auth group add，或在设置面板「访问与授权」中添加')
    }
    const subject = subjectOf(request)
    let rootId: string
    try {
      rootId = (await channel.send(request.chatId, {
        card: buildAnalyzeRootCard(subject, { kind: 'running' }),
      })).messageId
    } catch (error) {
      return refused(502, `分析卡片发送失败（机器人需在目标群内）：${messageOf(error)}`)
    }
    const body: AnalyzeAccepted = { ok: true, chatId: request.chatId, messageId: rootId }
    try {
      await domain.analyzeRequests.put(key, {
        key, bodyHash, chatId: request.chatId, messageId: rootId, acceptedAt: Date.now(),
        subject: { ...subject, logDetails: [...subject.logDetails] }, status: 'running',
      })
    } catch (error) {
      // The card is visible already; a lost record only means a retry of this
      // key would post a second analysis.
      this.deps.ctx.logger?.warn?.('dsh-channels: recording analyze request %s failed: %s', key, String(error))
    }
    const run = this.launch(channel, request, subject, rootId, key)
    this.running.add(run)
    void run.finally(() => { this.running.delete(run) })
    return { status: 202, body }
  }

  /** Start the analysis below an accepted root card; every failure ends on the cards. */
  private async launch(
    channel: FeishuChannel,
    request: AnalyzeRequest,
    subject: AnalyzeSubject,
    rootId: string,
    key: string,
  ): Promise<void> {
    const warn = (message: string, ...args: unknown[]): void => {
      this.deps.ctx.logger?.warn?.(message, ...args)
    }
    const showStatus = async (status: AnalyzeStatus): Promise<void> => {
      await channel.updateCard(rootId, buildAnalyzeRootCard(subject, status)).catch((error: unknown) => {
        warn('dsh-channels: updating analysis card %s failed: %s', rootId, String(error))
      })
      await this.recordStatus(key, status.kind)
    }
    const sessionId = randomUUID() as SessionId
    let handle: AgentHandle | undefined
    let cardId: string | undefined
    let threadId: string | undefined
    let releaseTopic: (() => void) | undefined
    let published = false
    try {
      const topic = await this.openTopic(channel, request.chatId, rootId, sessionId)
      cardId = topic.cardId
      threadId = topic.threadId
      releaseTopic = this.deps.reserveTopic(threadId)
      const services = placementServices(this.deps.ctx)
      const workspace = await ensureAnalyzeWorkspace(
        this.deps.ctx, this.deps.config.baseDir, request.app, request.errorCode,
      )
      const topicToken = topicTokenFor(threadId, 'thread', sessionId)
      const plan = await planTopic(services, this.deps.config, workspace.path, topicToken, warn)
      this.assertStarted()
      handle = await this.deps.sessions.createSession(sessionId, plan.cwd)
      const placement: TopicPlacement = await enterTopic(
        services, handle.agent, plan, workspace.path, topicToken, warn,
      )
      if (plan.cwd === workspace.path) {
        void Promise.resolve(workspace.attachSession(sessionId)).catch((error: unknown) => {
          warn('dsh-channels: attaching analysis session %s to workspace failed: %s', sessionId, String(error))
        })
      }
      await this.deps.sessions.mountGuidance(handle.agent, placement.sessionDir)
      this.assertStarted()

      const createdAt = handle.agent.session.header.createdAt
      const record: RouteRecord = {
        key: threadId,
        kind: 'thread',
        sessionId,
        chatId: request.chatId,
        chatType: 'group',
        senderUserId: request.requesterUserId,
        workspacePath: workspace.path,
        sessionDir: placement.sessionDir,
        ...(placement.worktreeBranch === undefined ? {} : { worktreeBranch: placement.worktreeBranch }),
        cardMessageId: cardId,
        createdAt,
        lastActivityAt: createdAt,
        sessionHistory: [{ sessionId, createdAt }],
        shared: true,
      }
      await this.deps.repair.write({
        key: cardId,
        sessionId,
        chatId: request.chatId,
        triggerMessageId: rootId,
        cards: [{ messageId: cardId, mode: 'card' }],
        startedAt: Date.now(),
        attempts: 0,
      })
      const agent = handle.agent
      const routeKey = threadId
      const streamCardId = cardId
      // Route, stream binding, and prompt land in one queue slot, so a reply
      // posted in the topic meanwhile is delivered after the first turn.
      await this.deps.queue.run(routeKey, async () => {
        this.assertStarted()
        await this.deps.routes.put(routeKey, record)
        published = true
        this.deps.streamer()?.attach(agent.session, streamCardId, rootId, undefined, {
          onSettled: outcome => { void showStatus({ kind: outcome }) },
        })
        agent.followup(feishuUserMessage(request.prompt))
      })
    } catch (error) {
      const reason = messageOf(error)
      warn('dsh-channels: analysis for %s/%s failed to start: %s', request.app, request.errorCode, reason)
      if (published && threadId !== undefined) {
        await this.deps.routes.remove(threadId).catch((removeError: unknown) => {
          warn('dsh-channels: removing analysis route %s failed: %s', threadId, String(removeError))
        })
      }
      await handle?.dispose().catch(() => {})
      if (cardId !== undefined) {
        void this.deps.repair.clear(cardId)
        await channel.updateCard(cardId, buildCard({
          phase: 'error',
          reasoning: '',
          body: `❌ 分析未能开始：${reason}`,
          stats: { sessionId, inputTokens: 0, outputTokens: 0 },
        })).catch(() => {})
      }
      await showStatus({ kind: 'failed', reason })
    } finally {
      releaseTopic?.()
    }
  }

  /**
   * Open the analysis topic: the first streaming card, replied in thread below
   * the root card. The topic id is read from that card (or the root card, in
   * topic groups).
   */
  private async openTopic(
    channel: FeishuChannel,
    chatId: string,
    rootId: string,
    sessionId: SessionId,
  ): Promise<{ cardId: string; threadId: string }> {
    const sent = await channel.send(chatId, { card: initialStreamingCard(sessionId) }, {
      replyTo: rootId, replyInThread: true,
    })
    const threadId = await channel.threadIdOfMessage(sent.messageId).catch(() => undefined)
      ?? await channel.threadIdOfMessage(rootId).catch(() => undefined)
    if (threadId === undefined) {
      await channel.updateCard(sent.messageId, buildCard({
        phase: 'error',
        reasoning: '',
        body: '❌ 无法在目标群创建话题',
        stats: { sessionId, inputTokens: 0, outputTokens: 0 },
      })).catch(() => {})
      throw new Error('无法在目标群创建话题（读取话题 id 失败）')
    }
    return { cardId: sent.messageId, threadId }
  }

  /** Store a root card status in the request record (best-effort; the card already shows it). */
  private async recordStatus(key: string, status: AnalyzeRequestRecord['status']): Promise<void> {
    const domain = this.deps.domain()
    const record = domain?.analyzeRequests.get(key)
    if (domain === undefined || record === undefined) return
    try {
      await domain.analyzeRequests.put(key, { ...record, status })
    } catch (error) {
      this.deps.ctx.logger?.warn?.('dsh-channels: recording analysis %s status failed: %s', key, String(error))
    }
  }

  private assertStarted(): void {
    if (!this.deps.started()) throw new Error('飞书渠道已断开，分析已取消')
  }
}

function subjectOf(request: AnalyzeRequest): AnalyzeSubject {
  return {
    requesterUserId: request.requesterUserId,
    triggeredAt: request.triggeredAt,
    app: request.app,
    errorCode: request.errorCode,
    logDetails: request.logDetails,
  }
}

function refused(status: number, error: string): AnalyzeResponse {
  return { status, body: { ok: false, error } }
}

function reusedKey(): AnalyzeResponse {
  return refused(409, 'Idempotency-Key 已被内容不同的请求使用')
}
