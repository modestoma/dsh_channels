/**
 * Log-platform analysis launcher: the business side of the analyze API.
 *
 * Synchronously (before the `202`): service state, target-group permission,
 * `Idempotency-Key` replay, and the placeholder card. In the background: the
 * topic (opened by a hint reply below the placeholder), the
 * `<baseDir>/analyze/<app>/<errorCode>` workspace and its per-topic directory,
 * the Session, the log package downloads, the group-shared route, and the
 * first turn, which renders quietly (once, when it ends) into the placeholder.
 *
 * Follow-ups then use the ordinary topic routing: the route is `shared`, so
 * every member admitted in the group may continue it. A failure before the
 * first turn replaces the placeholder with a failure card and leaves no route.
 *
 * @module dsh-channels/analyze/launcher
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, HostContext, SessionId } from '../dsh-types.ts'
import type { FeishuConfig } from '../config.ts'
import {
  ANALYZE_TOPIC_HINT, analyzePreface, buildAnalyzeFailureCard, buildAnalyzePlaceholderCard,
} from '../cards.ts'
import type { AnalyzeSubject } from '../cards.ts'
import type { RouteOperationQueue } from '../commands.ts'
import type { FeishuDomainHandle, RouteRecord } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import { feishuUserMessage } from '../routing/inbound.ts'
import { enterTopic, placementServices, planTopic } from '../session/isolation.ts'
import type { TopicPlacement } from '../session/isolation.ts'
import type { SessionManager } from '../session/manager.ts'
import type { InflightRepair } from '../session/repair.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TurnStreamer } from '../streamer.ts'
import { ensureAnalyzeWorkspace, topicTokenFor } from '../workspaces.ts'
import { analyzeRequestHash, chatApplink } from './contract.ts'
import type { AnalyzeAccepted, AnalyzeRequest, AnalyzeResponse } from './contract.ts'
import { downloadLogs } from './download.ts'
import type { DownloadedLog, FetchLike } from './download.ts'
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
  /** Whether the analyze API may post into the group. */
  mayAnalyzeIn(chatId: string): boolean
  /** Resolve the configured bearer token; undefined when unresolvable. */
  resolveToken(): Promise<string | undefined>
  /** Fetch seam for log downloads (defaults to the global fetch). */
  fetch?: FetchLike
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

/**
 * Prompt of the first turn: the platform prompt verbatim, then the list of
 * downloaded packages (paths relative to the topic directory).
 * @param prompt - the platform prompt.
 * @param logs - the downloaded packages.
 * @returns the user message text.
 */
export function analyzePromptText(prompt: string, logs: readonly DownloadedLog[]): string {
  const lines = logs.map(log => `- ${log.relativePath}（${log.bytes} 字节）`)
  return `${prompt}\n\n<analyze_logs>\n本次分析的日志包已下载到当前工作目录：\n${lines.join('\n')}\n</analyze_logs>`
}

export class AnalyzeLauncher implements AnalyzeHandler {
  /** `Idempotency-Key` → request still being accepted (concurrent retries share it). */
  private readonly accepting = new Map<string, PendingAccept>()
  /** Background analyses still starting (drained on shutdown). */
  private readonly running = new Set<Promise<void>>()

  constructor(private readonly deps: AnalyzeLauncherDeps) {}

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

  /** Wait for every background analysis that is still starting. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running])
  }

  private async accept(request: AnalyzeRequest, key: string, bodyHash: string): Promise<AnalyzeResponse> {
    const channel = this.deps.channel()
    const domain = this.deps.domain()
    if (!this.deps.started() || channel === undefined || domain === undefined) {
      return refused(503, '飞书渠道尚未连接，请稍后重试')
    }
    const stored = domain.analyzeRequests.get(key)
    if (stored !== undefined) {
      if (stored.bodyHash !== bodyHash) return reusedKey()
      return { status: 202, body: { ok: true, chatId: stored.chatId, messageId: stored.messageId, link: stored.link } }
    }
    if (!this.deps.mayAnalyzeIn(request.chatId)) {
      return refused(403, '目标群未授权：请管理员在该群发送 /auth group add，或在设置面板「访问与授权」中添加')
    }
    const subject = subjectOf(request)
    let placeholderId: string
    try {
      placeholderId = (await channel.send(request.chatId, { card: buildAnalyzePlaceholderCard(subject) })).messageId
    } catch (error) {
      return refused(502, `占位卡片发送失败（机器人需在目标群内）：${messageOf(error)}`)
    }
    const position = await channel.messagePositionOf(placeholderId).catch(() => undefined)
    const body: AnalyzeAccepted = {
      ok: true, chatId: request.chatId, messageId: placeholderId, link: chatApplink(request.chatId, position),
    }
    try {
      await domain.analyzeRequests.put(key, {
        key, bodyHash, chatId: request.chatId, messageId: placeholderId, link: body.link, acceptedAt: Date.now(),
      })
    } catch (error) {
      // The card is visible already; a lost record only means a retry of this
      // key would post a second analysis.
      this.deps.ctx.logger?.warn?.('dsh-channels: recording analyze request %s failed: %s', key, String(error))
    }
    const run = this.launch(channel, request, subject, placeholderId)
    this.running.add(run)
    void run.finally(() => { this.running.delete(run) })
    return { status: 202, body }
  }

  /** Start the analysis below an accepted placeholder; every failure ends on the card. */
  private async launch(
    channel: FeishuChannel,
    request: AnalyzeRequest,
    subject: AnalyzeSubject,
    placeholderId: string,
  ): Promise<void> {
    const warn = (message: string, ...args: unknown[]): void => {
      this.deps.ctx.logger?.warn?.(message, ...args)
    }
    let handle: AgentHandle | undefined
    try {
      const threadId = await this.openTopic(channel, request.chatId, placeholderId)
      const sessionId = randomUUID() as SessionId
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
      const logs = await downloadLogs(request.logUrls, placement.sessionDir, {
        maxBytes: this.deps.config.analyzeLogMaxBytes,
        timeoutMs: this.deps.config.analyzeLogTimeoutMs,
      }, this.deps.fetch)
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
        cardMessageId: placeholderId,
        createdAt,
        lastActivityAt: createdAt,
        sessionHistory: [{ sessionId, createdAt }],
        shared: true,
      }
      await this.deps.repair.write({
        key: placeholderId,
        sessionId,
        chatId: request.chatId,
        triggerMessageId: placeholderId,
        cards: [{ messageId: placeholderId, mode: 'card' }],
        startedAt: Date.now(),
        attempts: 0,
      })
      const agent = handle.agent
      // Route, stream binding, and prompt land in one queue slot, so a reply
      // posted in the topic meanwhile is delivered after the first turn.
      await this.deps.queue.run(threadId, async () => {
        this.assertStarted()
        await this.deps.routes.put(threadId, record)
        this.deps.streamer()?.attach(agent.session, placeholderId, placeholderId, undefined, {
          quiet: true,
          preface: analyzePreface(subject),
        })
        agent.followup(feishuUserMessage(analyzePromptText(request.prompt, logs)))
      })
    } catch (error) {
      warn('dsh-channels: analysis for %s/%s failed to start: %s', request.app, request.errorCode, String(error))
      await handle?.dispose().catch(() => {})
      void this.deps.repair.clear(placeholderId)
      await channel.updateCard(placeholderId, buildAnalyzeFailureCard(subject, messageOf(error))).catch(() => {})
    }
  }

  /**
   * Open the analysis topic: a hint reply in thread below the placeholder. The
   * topic id is read from the reply (or the placeholder, in topic groups).
   */
  private async openTopic(channel: FeishuChannel, chatId: string, placeholderId: string): Promise<string> {
    const hint = await channel.send(chatId, { text: ANALYZE_TOPIC_HINT }, {
      replyTo: placeholderId, replyInThread: true,
    })
    const threadId = await channel.threadIdOfMessage(hint.messageId).catch(() => undefined)
      ?? await channel.threadIdOfMessage(placeholderId).catch(() => undefined)
    if (threadId === undefined) throw new Error('无法在目标群创建话题（读取话题 id 失败）')
    return threadId
  }

  private assertStarted(): void {
    if (!this.deps.started()) throw new Error('飞书渠道已断开，分析已取消')
  }
}

function subjectOf(request: AnalyzeRequest): AnalyzeSubject {
  return {
    requesterUserId: request.requesterUserId,
    app: request.app,
    errorCode: request.errorCode,
    logCount: request.logUrls.length,
  }
}

function refused(status: number, error: string): AnalyzeResponse {
  return { status, body: { ok: false, error } }
}

function reusedKey(): AnalyzeResponse {
  return refused(409, 'Idempotency-Key 已被内容不同的请求使用')
}
