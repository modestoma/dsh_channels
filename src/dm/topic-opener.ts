/**
 * What a private-chat projects-mode main Session does with topics: open one
 * (`feishu_topic_open`) and forward a message into one (`feishu_topic_send`).
 *
 * Opening posts a root card in the chat timeline, opens the topic below it
 * with the first streaming card, records the topic in the directory, and
 * answers with the topic id at once. In the background it then creates the
 * topic Session in the person's workspace (working in `topics/<topic>/`),
 * publishes the route, and submits the hand-over as the first turn, as the
 * person. The topic is reserved in the inbound router until the route and the
 * first prompt are published, so a reply the person posts meanwhile queues
 * behind the first turn. A failure before the first turn marks the root card,
 * the streaming card, and the directory record failed, and leaves no route.
 *
 * Forwarding posts the message in the topic, marked as coming from the main
 * Session, and submits it to the topic Session as the person through the
 * route's operation queue: a topic with a turn in flight gets a queued card
 * and runs the message next.
 *
 * Root cards follow the topic's turns: {@link DmTopicOpener.showTurnStatus}
 * redraws them when a turn starts and settles.
 *
 * @module dsh-channels/dm/topic-opener
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, HostContext, SessionId } from '../host/index.ts'
import type { FeishuConfig } from '../config.ts'
import { failedStreamingCard, initialStreamingCard, queuedStreamingCard } from '../cards/index.ts'
import { buildDmTopicRootCard } from '../cards/dm-topic.ts'
import type { DmTopicCardStatus } from '../cards/dm-topic.ts'
import type { RouteOperationQueue } from '../commands.ts'
import type { RouteRecord } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import { feishuUserPrincipal } from '../access/principal.ts'
import type { SessionManager } from '../session/manager.ts'
import type { InflightRepair } from '../session/repair.ts'
import { channelPrompt, storablePrompt } from '../session/prompt.ts'
import type { TurnSubmission } from '../session/submit.ts'
import { newTopicRoute } from '../session/routes.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TopicLocationPort } from '../workspaces.ts'
import { dmSessionDir, ensureDmProject } from './layout.ts'
import { topicTitle } from './topic-directory.ts'
import type { DmTopicDirectory, DmTopicRecord } from './topic-directory.ts'

/** Most other topics named in a new topic's first prompt. */
const SIBLINGS_LISTED = 10

export interface DmTopicOpenerDeps {
  ctx: HostContext
  /** Live configuration; read per call. */
  config(): FeishuConfig
  started(): boolean
  channel(): FeishuChannel | undefined
  routes: RouteStore
  repair: InflightRepair
  sessions: SessionManager
  /** Card-bound prompt submission. */
  prompts: TurnSubmission
  /** Shared per-route FIFO (the first turn precedes any reply; forwarded messages queue with replies). */
  queue: RouteOperationQueue
  /** Reserve an opened topic until its route is published; the closer runs exactly once. */
  reserveTopic(threadId: string): () => void
  /** Person names for the workspace title. */
  location: TopicLocationPort
  directory: DmTopicDirectory
  /** Whether a Session has a turn in flight or queued (a forwarded message then gets a queued card). */
  busy(sessionId: string): boolean
  warn(message: string, ...args: unknown[]): void
}

/** Why a topic operation was refused. */
export type DmTopicFailureCode =
  | 'not-main'
  | 'not-connected'
  | 'limit'
  | 'send-failed'
  | 'unknown-topic'
  | 'topic-closed'
  | 'submit-failed'

/** Result of {@link DmTopicOpener.open}. */
export type DmTopicOpenResult =
  | { readonly ok: true; readonly topicId: string; readonly title: string; readonly replayed: boolean }
  | { readonly ok: false; readonly code: DmTopicFailureCode; readonly message: string }

/** Result of {@link DmTopicOpener.send}. */
export type DmTopicSendResult =
  | { readonly ok: true; readonly topicId: string; readonly queued: boolean }
  | { readonly ok: false; readonly code: DmTopicFailureCode; readonly message: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DmTopicOpener {
  /** Background topic starts (drained on shutdown). */
  private readonly running = new Set<Promise<void>>()
  /** Person → topics accepted whose first turn is not queued yet (counted against the limit). */
  private readonly starting = new Map<string, number>()

  constructor(private readonly deps: DmTopicOpenerDeps) {}

  /**
   * Open a topic for a main Session.
   * @param main - the main Session's route.
   * @param title - the topic title (cut to its maximum length).
   * @param brief - the hand-over, submitted as the topic's first turn.
   * @returns the topic id, or why nothing was opened.
   */
  async open(main: RouteRecord, title: string, brief: string): Promise<DmTopicOpenResult> {
    const userId = main.senderUserId
    if (main.dmRole !== 'main' || userId === undefined) {
      return { ok: false, code: 'not-main', message: '只有私聊主会话可以开话题' }
    }
    const channel = this.deps.channel()
    if (!this.deps.started() || channel === undefined) {
      return { ok: false, code: 'not-connected', message: '飞书渠道尚未连接，请稍后重试' }
    }
    const name = topicTitle(title)
    const same = this.deps.directory.topicsOf(userId).find(record => record.openedBy === 'main' && record.title === name
      && record.failedReason === undefined && this.deps.directory.statusOf(record) === 'running')
    if (same !== undefined) return { ok: true, topicId: same.key, title: same.title, replayed: true }
    const limit = this.deps.config().dmMaxRunningTopics
    const running = this.deps.directory.runningOpenedByMain(userId) + (this.starting.get(userId) ?? 0)
    if (running >= limit) {
      return {
        ok: false,
        code: 'limit',
        message: `已有 ${running} 个由主会话开的话题在进行中（上限 ${limit}）；等其中一个结束再开，或用 feishu_topic_send 把事情交给已有话题`,
      }
    }
    this.starting.set(userId, (this.starting.get(userId) ?? 0) + 1)
    let handedOff = false
    try {
      const sessionId = randomUUID() as SessionId
      let rootId: string
      try {
        rootId = (await channel.send(main.chatId, { card: buildDmTopicRootCard(name, brief, { kind: 'running' }) })).messageId
      } catch (error) {
        return { ok: false, code: 'send-failed', message: `话题卡片发送失败：${messageOf(error)}` }
      }
      let topic: { cardId: string; threadId: string }
      try {
        topic = await this.openTopic(channel, main.chatId, rootId, sessionId)
      } catch (error) {
        const reason = messageOf(error)
        await channel.updateCard(rootId, buildDmTopicRootCard(name, brief, { kind: 'failed', reason })).catch(() => {})
        return { ok: false, code: 'send-failed', message: reason }
      }
      const release = this.deps.reserveTopic(topic.threadId)
      try {
        await this.deps.directory.register({
          key: topic.threadId, userId, chatId: main.chatId, title: name, openedBy: 'main', rootMessageId: rootId, brief,
        })
      } catch (error) {
        this.deps.warn('dsh-channels: recording topic %s failed: %s', topic.threadId, String(error))
      }
      handedOff = true
      const run = this.start(main, userId, name, brief, sessionId, rootId, topic, release)
      this.running.add(run)
      void run.finally(() => { this.running.delete(run) })
      return { ok: true, topicId: topic.threadId, title: name, replayed: false }
    } finally {
      if (!handedOff) this.unstart(userId)
    }
  }

  /**
   * Forward one message from a main Session into one of the person's topics.
   * @param main - the main Session's route.
   * @param topicId - the topic's thread id.
   * @param message - the message.
   * @returns whether it was submitted, and whether it waits behind a running turn.
   */
  async send(main: RouteRecord, topicId: string, message: string): Promise<DmTopicSendResult> {
    const userId = main.senderUserId
    if (main.dmRole !== 'main' || userId === undefined) {
      return { ok: false, code: 'not-main', message: '只有私聊主会话可以给话题发消息' }
    }
    const record = this.deps.directory.get(topicId)
    if (record === undefined || record.userId !== userId) {
      return { ok: false, code: 'unknown-topic', message: `没有 topic_id 为 ${topicId} 的话题；先用 feishu_topic_list 查看` }
    }
    const route = this.deps.routes.get(topicId)
    if (route === undefined || record.failedReason !== undefined) {
      return { ok: false, code: 'topic-closed', message: `话题「${record.title}」已${record.failedReason === undefined ? '过期' : '未能开始'}，不能再发消息；需要的话开一个新话题` }
    }
    const channel = this.deps.channel()
    if (!this.deps.started() || channel === undefined) {
      return { ok: false, code: 'not-connected', message: '飞书渠道尚未连接，请稍后重试' }
    }
    return await this.deps.queue.run(route.key, async (): Promise<DmTopicSendResult> => {
      const current = this.deps.routes.get(topicId)
      if (current === undefined || !this.deps.started()) {
        return { ok: false, code: 'topic-closed', message: `话题「${record.title}」已不可用` }
      }
      try {
        const live = await this.deps.sessions.ensureLive(current)
        const posted = await channel.send(current.chatId, { text: `【主会话】${message}` }, {
          replyTo: current.cardMessageId, replyInThread: true,
        })
        const queued = this.deps.busy(current.sessionId)
        const card = await channel.send(current.chatId, {
          card: queued ? queuedStreamingCard(current.sessionId) : initialStreamingCard(current.sessionId),
        }, { replyTo: posted.messageId, replyInThread: true })
        const prompt = channelPrompt(forwardedPrompt(message), feishuUserPrincipal(userId))
        const stored = storablePrompt(prompt)
        await this.deps.repair.write({
          key: card.messageId,
          sessionId: current.sessionId,
          chatId: current.chatId,
          triggerMessageId: posted.messageId,
          routeKey: current.key,
          ...(stored === undefined ? {} : { prompt: stored }),
          cards: [{ messageId: card.messageId, mode: 'card' }],
          startedAt: Date.now(),
          attempts: 0,
        })
        await this.deps.routes.put(current.key, { ...current, cardMessageId: card.messageId, lastActivityAt: Date.now() })
        const outcome = await this.deps.prompts.run(live.agent, prompt, {
          cardMessageId: card.messageId,
          triggerMessageId: posted.messageId,
        })
        if (!outcome.accepted) return { ok: false, code: 'submit-failed', message: outcome.reason }
        await this.showTurnStatus(topicId, { kind: 'running' })
        return { ok: true, topicId, queued }
      } catch (error) {
        return { ok: false, code: 'submit-failed', message: `发送失败：${messageOf(error)}` }
      }
    })
  }

  /**
   * Redraw the root card of a main-Session topic (best-effort; topics the
   * person opened have none).
   * @param topicId - the topic's thread id.
   * @param status - the status to show.
   */
  async showTurnStatus(topicId: string, status: DmTopicCardStatus): Promise<void> {
    const record = this.deps.directory.get(topicId)
    const channel = this.deps.channel()
    if (record?.rootMessageId === undefined || channel === undefined) return
    await channel.updateCard(record.rootMessageId, buildDmTopicRootCard(record.title, record.brief ?? '', status)).catch((error: unknown) => {
      this.deps.warn('dsh-channels: updating topic card %s failed: %s', record.rootMessageId, String(error))
    })
  }

  /** Wait for every background topic start (shutdown, after `started` turned false). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running])
  }

  /** Start an accepted topic below its root card; every failure ends on the cards and the record. */
  private async start(
    main: RouteRecord,
    userId: string,
    title: string,
    brief: string,
    sessionId: SessionId,
    rootId: string,
    topic: { cardId: string; threadId: string },
    release: () => void,
  ): Promise<void> {
    const { cardId, threadId } = topic
    let handle: AgentHandle | undefined
    let published = false
    let counted = true
    try {
      const workspace = await ensureDmProject(this.deps.ctx, this.deps.location, this.deps.config().baseDir, userId)
      const dir = dmSessionDir(workspace.path, 'topic', threadId)
      this.assertStarted()
      handle = await this.deps.sessions.openProjectSession(sessionId, workspace, 'topic', dir)
      this.assertStarted()
      const record = newTopicRoute({
        key: threadId,
        kind: 'thread',
        sessionId,
        chatId: main.chatId,
        chatType: 'p2p',
        senderUserId: userId,
        workspacePath: workspace.path,
        cardMessageId: cardId,
        dmRole: 'topic',
        currentDir: dir,
      }, handle.agent.session.header.createdAt)
      const prompt = channelPrompt(handOverPrompt(title, brief, this.siblings(userId, threadId)), feishuUserPrincipal(userId))
      const stored = storablePrompt(prompt)
      await this.deps.repair.write({
        key: cardId,
        sessionId,
        chatId: main.chatId,
        routeKey: threadId,
        ...(stored === undefined ? {} : { prompt: stored }),
        cards: [{ messageId: cardId, mode: 'card' }],
        startedAt: Date.now(),
        attempts: 0,
      })
      const agent = handle.agent
      await this.deps.queue.run(threadId, async () => {
        this.assertStarted()
        await this.deps.routes.put(threadId, record)
        published = true
        const outcome = await this.deps.prompts.run(agent, prompt, { cardMessageId: cardId })
        if (!outcome.accepted) throw new Error(outcome.reason)
        // The turn is in flight: the directory counts it from here on.
        this.unstart(userId)
        counted = false
      })
    } catch (error) {
      const reason = messageOf(error)
      this.deps.warn('dsh-channels: topic %s failed to start: %s', threadId, reason)
      if (published) {
        await this.deps.routes.remove(threadId).catch((removeError: unknown) => {
          this.deps.warn('dsh-channels: removing topic route %s failed: %s', threadId, String(removeError))
        })
      }
      await handle?.dispose().catch(() => {})
      void this.deps.repair.clear(cardId)
      const channel = this.deps.channel()
      await channel?.updateCard(cardId, failedStreamingCard(sessionId, `❌ 话题未能开始：${reason}`)).catch(() => {})
      await channel?.updateCard(rootId, buildDmTopicRootCard(title, brief, { kind: 'failed', reason })).catch(() => {})
      await this.deps.directory.markFailed(threadId, reason).catch((markError: unknown) => {
        this.deps.warn('dsh-channels: recording topic %s failure failed: %s', threadId, String(markError))
      })
    } finally {
      if (counted) this.unstart(userId)
      release()
    }
  }

  /**
   * Open the topic: the first streaming card, replied in thread below the
   * root card. The topic id is read from that card (or the root card).
   */
  private async openTopic(channel: FeishuChannel, chatId: string, rootId: string, sessionId: SessionId): Promise<{ cardId: string; threadId: string }> {
    const sent = await channel.send(chatId, { card: initialStreamingCard(sessionId) }, { replyTo: rootId, replyInThread: true })
    const threadId = await channel.threadIdOfMessage(sent.messageId).catch(() => undefined)
      ?? await channel.threadIdOfMessage(rootId).catch(() => undefined)
    if (threadId === undefined) {
      await channel.updateCard(sent.messageId, failedStreamingCard(sessionId, '❌ 无法创建话题')).catch(() => {})
      throw new Error('无法创建话题（读取话题 id 失败）')
    }
    return { cardId: sent.messageId, threadId }
  }

  /** The person's other topics a new topic's first prompt names. */
  private siblings(userId: string, threadId: string): DmTopicRecord[] {
    return this.deps.directory.topicsOf(userId)
      .filter(record => record.key !== threadId && record.failedReason === undefined && this.deps.routes.get(record.key) !== undefined)
      .slice(0, SIBLINGS_LISTED)
  }

  private unstart(userId: string): void {
    const left = (this.starting.get(userId) ?? 0) - 1
    if (left > 0) this.starting.set(userId, left)
    else this.starting.delete(userId)
  }

  private assertStarted(): void {
    if (!this.deps.started()) throw new Error('飞书渠道已断开，已取消')
  }
}

/**
 * The first prompt of a topic the main Session opened.
 * @param title - the topic title.
 * @param brief - the main Session's hand-over.
 * @param siblings - the person's other open topics.
 * @returns the prompt text.
 */
export function handOverPrompt(title: string, brief: string, siblings: readonly DmTopicRecord[]): string {
  const lines = ['<dm_topic_brief>', `私聊主会话开了这个话题「${title}」，交接说明如下：`, '', brief.trim(), '</dm_topic_brief>']
  if (siblings.length > 0) {
    lines.push('', '<dm_topics>', '这个人的其他话题（只供参考，你看不到它们的目录）：')
    for (const record of siblings) lines.push(`- 「${record.title}」`)
    lines.push('</dm_topics>')
  }
  return lines.join('\n')
}

/**
 * The prompt of a message the main Session forwarded into a topic.
 * @param message - the message.
 * @returns the prompt text.
 */
export function forwardedPrompt(message: string): string {
  return `<dm_main_message>\n私聊主会话转来一条消息：\n\n${message.trim()}\n</dm_main_message>`
}
