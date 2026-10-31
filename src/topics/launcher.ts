/**
 * The `feishuTopics` service: other plugins start group-shared topics (see
 * `./contract.ts`).
 *
 * Synchronously (before {@link TopicLauncher.launch} settles): spec
 * validation, service state, target-group permission, idempotency replay, and
 * the root card (进行中). In the background: the topic (opened by the first
 * streaming card, replied in thread below the root card), the launch workspace
 * and its per-topic directory, the Session, the group-shared route, and the
 * first turn: the prompt verbatim, streamed into that card like any topic
 * turn. When the first turn settles, the root card's status follows it
 * (已完成 / 已停止 / 失败), and the launch record keeps the same status. At
 * channel start, records still `running` belong to topics a previous instance
 * never finished; {@link TopicLauncher.markInterrupted} marks their cards
 * 已中断.
 *
 * The topic is reserved in the inbound router from its creation until the
 * route and the first prompt are published, so replies posted meanwhile queue
 * behind the first turn. Follow-ups then use the ordinary topic routing: the
 * route is `shared`, so every member admitted in the group may continue it. A
 * failure before the first turn (including a disconnect meanwhile) marks the
 * root card failed with the reason, closes the streaming card, and leaves no
 * route.
 *
 * @module dsh-channels/topics/launcher
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentHandle, HostContext, SessionId } from '../dsh-types.ts'
import type { FeishuConfig } from '../config.ts'
import { buildCard, buildTopicRootCard, initialStreamingCard } from '../cards.ts'
import type { TopicStatus } from '../cards.ts'
import type { RouteOperationQueue } from '../commands.ts'
import { FEISHU_USER_ID_PATTERN, rootCardOf } from '../domain.ts'
import type { FeishuDomainHandle, RouteRecord, TopicLaunchRecord } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import { feishuUserMessage } from '../routing/inbound.ts'
import { enterTopic, placementServices, planTopic } from '../session/isolation.ts'
import type { TopicPlacement } from '../session/isolation.ts'
import type { SessionManager } from '../session/manager.ts'
import type { InflightRepair } from '../session/repair.ts'
import { storableMessage } from '../session/repair.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TurnStreamer } from '../streamer.ts'
import { ensureLaunchWorkspace, RESERVED_WORKSPACE_ROOTS, topicTokenFor } from '../workspaces.ts'
import type {
  FeishuTopicService, FeishuTopicsServiceName, FeishuTopicsVersion, TopicLaunchFailureCode,
  TopicLaunchResult, TopicLaunchSpec, TopicRootCard,
} from './contract.ts'

/** Name the launcher is provided under. */
export const FEISHU_TOPICS_SERVICE: FeishuTopicsServiceName = 'feishuTopics'

/** Contract version the launcher implements. */
export const FEISHU_TOPICS_VERSION: FeishuTopicsVersion = 1

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim() !== '', 'must not be blank')

/** Workspace path segment: path-safe, never `.` or `..`. */
const WORKSPACE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/u

/** Feishu group chat id (`oc_…`). */
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/u

/** Launch spec validation: the rules {@link TopicLaunchSpec} documents. */
const topicLaunchSpecSchema = z.object({
  key: z.string().regex(/^[\x21-\x7E]{1,200}$/u, 'must be 1-200 visible ASCII characters'),
  fingerprint: z.string().min(1).max(512),
  chatId: z.string().regex(CHAT_ID, 'must be a Feishu group chat_id (oc_...)'),
  requesterUserId: z.string().regex(FEISHU_USER_ID_PATTERN, 'must be a Feishu user_id').max(128),
  card: z.object({
    title: text(100),
    taskName: text(20),
    lead: z.array(z.object({ text: z.string().max(1000), bold: z.boolean().optional() }).strict()).min(1).max(20),
    links: z.object({
      nameHeader: text(20),
      linkHeader: text(20),
      rows: z.array(z.object({
        name: text(200),
        url: z.url({ protocol: /^https?$/u, error: 'must be an http(s) URL' }).max(2048),
      }).strict()).max(50),
    }).strict().optional(),
  }).strict(),
  workspace: z.object({
    segments: z.array(z.string().regex(WORKSPACE_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -')).min(1).max(8)
      .refine(segments => !RESERVED_WORKSPACE_ROOTS.includes(segments[0] ?? ''), `must not start with ${RESERVED_WORKSPACE_ROOTS.join(', ')}`),
    title: text(200),
  }).strict(),
  prompt: text(100_000),
}).strict()

/** Collaborators of the launcher (late-bound where the service swaps them per connection). */
export interface TopicLauncherDeps {
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
  /** Whether a launch may post into the group. */
  mayLaunchIn(chatId: string): boolean
}

/** One accepted launch still posting its root card. */
interface PendingAccept {
  readonly fingerprint: string
  readonly result: Promise<TopicLaunchResult>
}

/** Readable reason of an error value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TopicLauncher implements FeishuTopicService {
  readonly version = FEISHU_TOPICS_VERSION
  /** Idempotency key → launch still being accepted (concurrent retries share it). */
  private readonly accepting = new Map<string, PendingAccept>()
  /** Background topics still starting (drained on shutdown). */
  private readonly running = new Set<Promise<void>>()
  /** Whether launches are admitted: from {@link open} after start until {@link close}. */
  private admitting = false

  constructor(private readonly deps: TopicLauncherDeps) {}

  /**
   * Start admitting launches. Called at channel start after
   * {@link markInterrupted}, so a new launch is never marked interrupted.
   */
  open(): void {
    this.admitting = true
  }

  /** Refuse launches (`not-connected`) ahead of shutdown. */
  close(): void {
    this.admitting = false
  }

  async launch(spec: TopicLaunchSpec): Promise<TopicLaunchResult> {
    const parsed = topicLaunchSpecSchema.safeParse(spec)
    if (!parsed.success) {
      const details = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(spec)'}: ${issue.message}`)
        .join('; ')
      return refused('invalid', `话题参数不合法：${details}`)
    }
    const valid = parsed.data
    const pending = this.accepting.get(valid.key)
    if (pending !== undefined) {
      if (pending.fingerprint !== valid.fingerprint) return reusedKey()
      return await pending.result
    }
    const result = this.accept(valid)
    this.accepting.set(valid.key, { fingerprint: valid.fingerprint, result })
    try {
      return await result
    } finally {
      this.accepting.delete(valid.key)
    }
  }

  /**
   * Wait for every acceptance in flight, then every background topic that is
   * still starting. Called after `started` turns false, so each one ends on
   * its failure card or, when its first prompt was already sent, as an
   * ordinary topic.
   */
  async drain(): Promise<void> {
    // Acceptances still sending the root card or writing the record finish
    // first; each one adds its launch to `running` before it settles.
    await Promise.allSettled([...this.accepting.values()].map(pending => pending.result))
    await Promise.allSettled([...this.running])
  }

  /**
   * Mark every launch still `running` as interrupted, on its card and in its
   * record. Called at channel start before admission opens, so each such
   * record belongs to a previous instance whose first turn never settled. A
   * card that cannot be updated (deleted, recalled) is logged and still
   * recorded as interrupted, so it is not retried on every start.
   */
  async markInterrupted(): Promise<void> {
    const channel = this.deps.channel()
    const domain = this.deps.domain()
    if (channel === undefined || domain === undefined) return
    for (const [key, record] of [...domain.topicLaunches.entries()]) {
      if (record.status !== 'running') continue
      const root = rootCardOf(record)
      if (root !== undefined) {
        await channel.updateCard(record.messageId, buildTopicRootCard(root.requesterUserId, root.card, { kind: 'interrupted' }))
          .catch((error: unknown) => {
            this.deps.ctx.logger?.warn?.('dsh-channels: marking topic card %s interrupted failed: %s', key, String(error))
          })
      }
      await this.recordStatus(key, 'interrupted')
    }
  }

  private async accept(spec: TopicLaunchSpec): Promise<TopicLaunchResult> {
    const channel = this.deps.channel()
    const domain = this.deps.domain()
    if (!this.admitting || !this.deps.started() || channel === undefined || domain === undefined) {
      return refused('not-connected', '飞书渠道尚未连接，请稍后重试')
    }
    const stored = domain.topicLaunches.get(spec.key)
    if (stored !== undefined) {
      if (stored.bodyHash !== spec.fingerprint) return reusedKey()
      return { ok: true, replayed: true, chatId: stored.chatId, messageId: stored.messageId }
    }
    if (!this.deps.mayLaunchIn(spec.chatId)) {
      return refused('forbidden-chat', '目标群未授权：请管理员在该群发送 /auth group add，或在设置面板「访问与授权」中添加')
    }
    const card = copyCard(spec.card)
    let rootId: string
    try {
      rootId = (await channel.send(spec.chatId, {
        card: buildTopicRootCard(spec.requesterUserId, card, { kind: 'running' }),
      })).messageId
    } catch (error) {
      return refused('send-failed', `${spec.card.taskName}卡片发送失败（机器人需在目标群内）：${messageOf(error)}`)
    }
    try {
      await domain.topicLaunches.put(spec.key, {
        key: spec.key, bodyHash: spec.fingerprint, chatId: spec.chatId, messageId: rootId, acceptedAt: Date.now(),
        requesterUserId: spec.requesterUserId, card, status: 'running',
      })
    } catch (error) {
      // The card is visible already; a lost record only means a retry of this
      // key would post a second topic.
      this.deps.ctx.logger?.warn?.('dsh-channels: recording topic launch %s failed: %s', spec.key, String(error))
    }
    const run = this.start(channel, spec, card, rootId)
    this.running.add(run)
    void run.finally(() => { this.running.delete(run) })
    return { ok: true, replayed: false, chatId: spec.chatId, messageId: rootId }
  }

  /** Start the topic below an accepted root card; every failure ends on the cards. */
  private async start(
    channel: FeishuChannel,
    spec: TopicLaunchSpec,
    card: TopicRootCard,
    rootId: string,
  ): Promise<void> {
    const warn = (message: string, ...args: unknown[]): void => {
      this.deps.ctx.logger?.warn?.(message, ...args)
    }
    const showStatus = async (status: TopicStatus): Promise<void> => {
      await channel.updateCard(rootId, buildTopicRootCard(spec.requesterUserId, card, status)).catch((error: unknown) => {
        warn('dsh-channels: updating topic card %s failed: %s', rootId, String(error))
      })
      await this.recordStatus(spec.key, status.kind)
    }
    const sessionId = randomUUID() as SessionId
    let handle: AgentHandle | undefined
    let cardId: string | undefined
    let threadId: string | undefined
    let releaseTopic: (() => void) | undefined
    let published = false
    try {
      const topic = await this.openTopic(channel, spec.chatId, rootId, sessionId)
      cardId = topic.cardId
      threadId = topic.threadId
      releaseTopic = this.deps.reserveTopic(threadId)
      const services = placementServices(this.deps.ctx)
      const workspace = await ensureLaunchWorkspace(
        this.deps.ctx, this.deps.config.baseDir, spec.workspace.segments, spec.workspace.title,
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
          warn('dsh-channels: attaching topic session %s to workspace failed: %s', sessionId, String(error))
        })
      }
      await this.deps.sessions.mountGuidance(handle.agent, placement.sessionDir)
      this.assertStarted()

      const createdAt = handle.agent.session.header.createdAt
      const record: RouteRecord = {
        key: threadId,
        kind: 'thread',
        sessionId,
        chatId: spec.chatId,
        chatType: 'group',
        senderUserId: spec.requesterUserId,
        workspacePath: workspace.path,
        sessionDir: placement.sessionDir,
        ...(placement.worktreeBranch === undefined ? {} : { worktreeBranch: placement.worktreeBranch }),
        cardMessageId: cardId,
        createdAt,
        lastActivityAt: createdAt,
        sessionHistory: [{ sessionId, createdAt }],
        shared: true,
      }
      const message = feishuUserMessage(spec.prompt)
      const stored = storableMessage(message)
      await this.deps.repair.write({
        key: cardId,
        sessionId,
        chatId: spec.chatId,
        triggerMessageId: rootId,
        routeKey: threadId,
        ...(stored === undefined ? {} : { message: stored }),
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
          message,
        })
        agent.followup(message)
      })
    } catch (error) {
      const reason = messageOf(error)
      warn('dsh-channels: topic %s failed to start: %s', spec.key, reason)
      if (published && threadId !== undefined) {
        await this.deps.routes.remove(threadId).catch((removeError: unknown) => {
          warn('dsh-channels: removing topic route %s failed: %s', threadId, String(removeError))
        })
      }
      await handle?.dispose().catch(() => {})
      if (cardId !== undefined) {
        void this.deps.repair.clear(cardId)
        await channel.updateCard(cardId, buildCard({
          phase: 'error',
          reasoning: '',
          body: `❌ ${card.taskName}未能开始：${reason}`,
          stats: { sessionId, inputTokens: 0, outputTokens: 0 },
        })).catch(() => {})
      }
      await showStatus({ kind: 'failed', reason })
    } finally {
      releaseTopic?.()
    }
  }

  /**
   * Open the topic: the first streaming card, replied in thread below the
   * root card. The topic id is read from that card (or the root card, in
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

  /** Store a root card status in the launch record (best-effort; the card already shows it). */
  private async recordStatus(key: string, status: TopicLaunchRecord['status']): Promise<void> {
    const domain = this.deps.domain()
    const record = domain?.topicLaunches.get(key)
    if (domain === undefined || record === undefined) return
    try {
      await domain.topicLaunches.put(key, { ...record, status })
    } catch (error) {
      this.deps.ctx.logger?.warn?.('dsh-channels: recording topic %s status failed: %s', key, String(error))
    }
  }

  private assertStarted(): void {
    if (!this.deps.started()) throw new Error('飞书渠道已断开，已取消')
  }
}

/** A detached copy of the card, so the caller cannot change what is recorded. */
function copyCard(card: TopicRootCard): NonNullable<TopicLaunchRecord['card']> {
  return {
    title: card.title,
    taskName: card.taskName,
    lead: card.lead.map(run => (run.bold === undefined ? { text: run.text } : { text: run.text, bold: run.bold })),
    ...(card.links === undefined
      ? {}
      : {
          links: {
            nameHeader: card.links.nameHeader,
            linkHeader: card.links.linkHeader,
            rows: card.links.rows.map(row => ({ name: row.name, url: row.url })),
          },
        }),
  }
}

function refused(code: TopicLaunchFailureCode, message: string): TopicLaunchResult {
  return { ok: false, code, message }
}

function reusedKey(): TopicLaunchResult {
  return refused('key-conflict', '幂等键已被内容不同的请求使用')
}
