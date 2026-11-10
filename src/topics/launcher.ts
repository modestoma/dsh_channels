/**
 * The `feishuTopics` service: other plugins start group topics (see
 * `./contract.ts`).
 *
 * Synchronously (before {@link TopicLauncher.launch} settles): spec
 * validation, service state, a Feishu requester's chat access, idempotency
 * replay, and the root card (进行中).
 * In the background: the topic (opened by the first streaming card, replied
 * in thread below the root card), the topic's own workspace under the
 * group's directory, the group's permission record, the Session, the group
 * route, and the first turn: the prompt verbatim, streamed into that card
 * like any topic turn. When the first turn settles, the root card's status follows it
 * (已完成 / 已停止 / 失败), and the launch record keeps the same status. At
 * channel start, records still `running` belong to topics a previous instance
 * never finished; {@link TopicLauncher.markInterrupted} marks their cards
 * 已中断. Every recorded status is emitted as the `feishu-topics/status`
 * event. {@link TopicLauncher.state} and {@link TopicLauncher.launchKeyOf}
 * read the record together with the topic's current route;
 * {@link TopicLauncher.updateLinks} replaces the recorded link table and
 * redraws the root card. Root card writes of one launch (status changes,
 * link updates, the 已中断 redraw) run one at a time in call order.
 *
 * The topic is reserved in the inbound router from its creation until the
 * route and the first prompt are published, so replies posted meanwhile queue
 * behind the first turn. Follow-ups then use the ordinary topic routing: the
 * route is a group route, so anyone with chat access in the
 * group may continue it, and the group's permission record gates its tools. A
 * failure before the first turn (including a disconnect meanwhile) marks the
 * root card failed with the reason, closes the streaming card, and leaves no
 * route.
 *
 * @module dsh-channels/topics/launcher
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentHandle, HostContext, SessionId } from '../host/index.ts'
import type { FeishuConfig } from '../config.ts'
import { buildTopicRootCard, failedStreamingCard, initialStreamingCard } from '../cards/index.ts'
import type { TopicStatus } from '../cards/index.ts'
import type { RouteOperationQueue } from '../commands.ts'
import { FEISHU_USER_ID_PATTERN, isGroupRoute } from '../domain.ts'
import type { FeishuDomainHandle, TopicLaunchRecord } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import { feishuGroupPrincipal } from '../access/principal.ts'
import type { SessionManager } from '../session/manager.ts'
import type { InflightRepair } from '../session/repair.ts'
import { channelPrompt, storablePrompt } from '../session/prompt.ts'
import type { TurnSubmission } from '../session/submit.ts'
import { newTopicRoute } from '../session/routes.ts'
import type { RouteStore } from '../session/routes.ts'
import { openTopicWorkspace, topicTokenFor } from '../workspaces.ts'
import type { TopicLocationPort } from '../workspaces.ts'
import type {
  FeishuTopicService, FeishuTopicsServiceName, FeishuTopicsStatusEvent, FeishuTopicsVersion,
  TopicCardLinks, TopicLaunchFailureCode, TopicLaunchResult, TopicLaunchSpec, TopicLaunchState,
  TopicLinksUpdateFailureCode, TopicLinksUpdateResult, TopicRequester, TopicRootCard,
} from './contract.ts'

/** Name the launcher is provided under. */
export const FEISHU_TOPICS_SERVICE: FeishuTopicsServiceName = 'feishuTopics'

/** Contract version the launcher implements. */
export const FEISHU_TOPICS_VERSION: FeishuTopicsVersion = 3

/** Event emitted after a launch status is recorded. */
export const FEISHU_TOPICS_STATUS_EVENT: FeishuTopicsStatusEvent = 'feishu-topics/status'

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim() !== '', 'must not be blank')

/** Feishu group chat id (`oc_…`). */
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/u

const linkUrl = z.url({ protocol: /^https?$/u, error: 'must be an http(s) URL' }).max(2048)

/** Link table validation: the rules {@link TopicCardLinks} documents. */
const topicCardLinksSchema = z.object({
  nameHeader: text(20),
  linkHeader: text(20),
  extraLinkHeader: text(20).optional(),
  rows: z.array(z.object({
    name: text(200),
    url: linkUrl.optional(),
    extraUrl: linkUrl.optional(),
  }).strict()).max(50),
}).strict()

/** Launch spec validation: the rules {@link TopicLaunchSpec} documents. */
const topicLaunchSpecSchema = z.object({
  key: z.string().regex(/^[\x21-\x7E]{1,200}$/u, 'must be 1-200 visible ASCII characters'),
  fingerprint: z.string().min(1).max(512),
  chatId: z.string().regex(CHAT_ID, 'must be a Feishu group chat_id (oc_...)'),
  requester: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('feishu-user'),
      userId: z.string().regex(FEISHU_USER_ID_PATTERN, 'must be a Feishu user_id').max(128),
    }).strict(),
    z.object({
      kind: z.literal('external'),
      label: text(200).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'must be one line without control characters'),
    }).strict(),
  ]),
  card: z.object({
    title: text(100),
    taskName: text(20),
    lead: z.array(z.object({ text: z.string().max(1000), bold: z.boolean().optional() }).strict()).min(1).max(20),
    links: topicCardLinksSchema.optional(),
  }).strict(),
  prompt: text(100_000),
}).strict()

/** Collaborators of the launcher (late-bound where the service swaps them per connection). */
export interface TopicLauncherDeps {
  ctx: HostContext
  /** Live configuration; read per launch. */
  config(): FeishuConfig
  started(): boolean
  channel(): FeishuChannel | undefined
  domain(): FeishuDomainHandle | undefined
  routes: RouteStore
  repair: InflightRepair
  sessions: SessionManager
  /** Card-bound prompt submission (the service owns the streamer and the submitter). */
  prompts: TurnSubmission
  /** Shared per-route FIFO (the first turn must precede any follow-up). */
  queue: RouteOperationQueue
  /**
   * Reserve an opened topic until its route is published, so replies posted
   * meanwhile wait instead of being dropped or starting a competing Session.
   * The returned closer is called exactly once.
   */
  reserveTopic(threadId: string): () => void
  /** Group names and group registration. */
  location: TopicLocationPort
  /** Whether a Feishu requester (`user_id`) may speak: the first turn is submitted as them. */
  mayLaunchFor(requesterUserId: string): boolean
}

/** One accepted launch still posting its root card. */
interface PendingAccept {
  readonly fingerprint: string
  readonly result: Promise<TopicLaunchResult>
}

/** Readable reason of zod issues. */
function issuesText(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(spec)'}: ${issue.message}`).join('; ')
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
  /** Idempotency key → last root card write, so writes of one launch apply in call order. */
  private readonly cardWrites = new Map<string, Promise<unknown>>()

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

  state(key: string): TopicLaunchState | undefined {
    const record = this.deps.domain()?.topicLaunches.get(key)
    if (record === undefined) return undefined
    // A retired route's tombstone wins over a leftover row whose delete failed.
    const route = record.threadId === undefined || this.deps.routes.expiredRoute(record.threadId) !== undefined
      ? undefined
      : this.deps.routes.get(record.threadId)
    return {
      key,
      status: record.status,
      ...(record.status === 'failed' && record.reason !== undefined ? { reason: record.reason } : {}),
      ...(route === undefined ? {} : { sessionId: route.sessionId, workDir: route.workspacePath }),
    }
  }

  launchKeyOf(sessionId: string): string | undefined {
    const route = this.deps.routes.findBySession(sessionId)
    if (route?.kind !== 'thread' || !isGroupRoute(route)) return undefined
    const domain = this.deps.domain()
    if (domain === undefined) return undefined
    for (const [key, record] of domain.topicLaunches.entries()) {
      if (record.threadId === route.key) return key
    }
    return undefined
  }

  async updateLinks(key: string, links: TopicCardLinks | undefined): Promise<TopicLinksUpdateResult> {
    const parsed = topicCardLinksSchema.optional().safeParse(links)
    if (!parsed.success) return linksRefused('invalid', `链接表不合法：${issuesText(parsed.error)}`)
    const valid = parsed.data
    return await this.serialize(key, async () => {
      const channel = this.deps.channel()
      const domain = this.deps.domain()
      if (!this.deps.started() || channel === undefined || domain === undefined) {
        return linksRefused('not-connected', '飞书渠道尚未连接，请稍后重试')
      }
      const record = domain.topicLaunches.get(key)
      if (record === undefined) return linksRefused('unknown-key', `没有幂等键为 ${key} 的话题`)
      const card: TopicLaunchRecord['card'] = { title: record.card.title, taskName: record.card.taskName, lead: record.card.lead }
      if (valid !== undefined) card.links = copyLinks(valid)
      const next: TopicLaunchRecord = { ...record, card }
      try {
        await domain.topicLaunches.put(key, next)
      } catch (error) {
        return linksRefused('update-failed', `记录链接表失败：${messageOf(error)}`)
      }
      try {
        await channel.updateCard(record.messageId, buildTopicRootCard(requesterOfRecord(next), card, statusOfRecord(next)))
      } catch (error) {
        return linksRefused('update-failed', `更新根卡片失败：${messageOf(error)}`)
      }
      return { ok: true }
    })
  }

  async launch(spec: TopicLaunchSpec): Promise<TopicLaunchResult> {
    const parsed = topicLaunchSpecSchema.safeParse(spec)
    if (!parsed.success) {
      return refused('invalid', `话题参数不合法：${issuesText(parsed.error)}`)
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
    for (const [key, listed] of [...domain.topicLaunches.entries()]) {
      if (listed.status !== 'running') continue
      await this.serialize(key, async () => {
        // A link update may have replaced the card while earlier redraws ran.
        const record = domain.topicLaunches.get(key)
        if (record?.status !== 'running') return
        await channel.updateCard(record.messageId, buildTopicRootCard(requesterOfRecord(record), record.card, { kind: 'interrupted' }))
          .catch((error: unknown) => {
            this.deps.ctx.logger?.warn?.('dsh-channels: marking topic card %s interrupted failed: %s', key, String(error))
          })
        await this.recordStatus(key, 'interrupted')
      })
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
    if (spec.requester.kind === 'feishu-user' && !this.deps.mayLaunchFor(spec.requester.userId)) {
      return refused('forbidden-chat', '发起人没有对话权限：请管理员发送 /auth add @发起人，或在设置面板「访问授权」中添加')
    }
    const card = copyCard(spec.card)
    let rootId: string
    try {
      rootId = (await channel.send(spec.chatId, {
        card: buildTopicRootCard(spec.requester, card, { kind: 'running' }),
      })).messageId
    } catch (error) {
      return refused('send-failed', `${spec.card.taskName}卡片发送失败（机器人需在目标群内）：${messageOf(error)}`)
    }
    try {
      await domain.topicLaunches.put(spec.key, {
        key: spec.key, bodyHash: spec.fingerprint, chatId: spec.chatId, messageId: rootId, acceptedAt: Date.now(),
        ...requesterFields(spec.requester), card, status: 'running',
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
      await this.serialize(spec.key, async () => {
        // The recorded card carries link tables replaced since the launch.
        const current = this.deps.domain()?.topicLaunches.get(spec.key)?.card ?? card
        await channel.updateCard(rootId, buildTopicRootCard(spec.requester, current, status)).catch((error: unknown) => {
          warn('dsh-channels: updating topic card %s failed: %s', rootId, String(error))
        })
        await this.recordStatus(spec.key, status.kind, status.kind === 'failed' ? status.reason : undefined)
      })
    }
    const sessionId = randomUUID() as SessionId
    const requesterUserId = spec.requester.kind === 'feishu-user' ? spec.requester.userId : undefined
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
      await this.recordThread(spec.key, threadId)
      const workspace = await openTopicWorkspace(this.deps.ctx, this.deps.location, {
        baseDir: this.deps.config().baseDir,
        chatType: 'group',
        chatId: spec.chatId,
        ...(requesterUserId === undefined ? {} : { userId: requesterUserId }),
        topicToken: topicTokenFor(threadId, 'thread', sessionId),
        titleText: card.title,
      })
      this.assertStarted()
      handle = await this.deps.sessions.openTopicSession(sessionId, workspace.path)
      this.assertStarted()

      const record = newTopicRoute({
        key: threadId,
        kind: 'thread',
        sessionId,
        chatId: spec.chatId,
        chatType: 'group',
        ...(requesterUserId === undefined ? {} : { senderUserId: requesterUserId }),
        ...(spec.requester.kind === 'external' ? { senderLabel: spec.requester.label } : {}),
        workspacePath: workspace.path,
        cardMessageId: cardId,
      }, handle.agent.session.header.createdAt)
      // The topic belongs to the group: its first prompt is submitted as the
      // group, with a Feishu requester as the speaker.
      const prompt = channelPrompt(spec.prompt, feishuGroupPrincipal(spec.chatId, requesterUserId))
      const stored = storablePrompt(prompt)
      await this.deps.repair.write({
        key: cardId,
        sessionId,
        chatId: spec.chatId,
        triggerMessageId: rootId,
        routeKey: threadId,
        ...(stored === undefined ? {} : { prompt: stored }),
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
        const outcome = await this.deps.prompts.run(agent, prompt, {
          cardMessageId: streamCardId,
          triggerMessageId: rootId,
          onSettled: outcome => { void showStatus({ kind: outcome }) },
        })
        if (!outcome.accepted) throw new Error(outcome.reason)
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
        await channel.updateCard(cardId, failedStreamingCard(sessionId, `❌ ${card.taskName}未能开始：${reason}`)).catch(() => {})
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
      await channel.updateCard(sent.messageId, failedStreamingCard(sessionId, '❌ 无法在目标群创建话题')).catch(() => {})
      throw new Error('无法在目标群创建话题（读取话题 id 失败）')
    }
    return { cardId: sent.messageId, threadId }
  }

  /**
   * Store a root card status in the launch record (best-effort; the card
   * already shows it), then emit the launch state.
   */
  private async recordStatus(key: string, status: TopicLaunchRecord['status'], reason?: string): Promise<void> {
    const domain = this.deps.domain()
    const record = domain?.topicLaunches.get(key)
    if (domain === undefined || record === undefined) return
    const next: TopicLaunchRecord = { ...record, status }
    if (reason === undefined) delete next.reason
    else next.reason = reason
    try {
      await domain.topicLaunches.put(key, next)
    } catch (error) {
      this.deps.ctx.logger?.warn?.('dsh-channels: recording topic %s status failed: %s', key, String(error))
      return
    }
    const state = this.state(key)
    if (state === undefined) return
    try {
      this.deps.ctx.emit?.(FEISHU_TOPICS_STATUS_EVENT, state)
    } catch (error) {
      this.deps.ctx.logger?.warn?.('dsh-channels: a %s listener failed for topic %s: %s', FEISHU_TOPICS_STATUS_EVENT, key, String(error))
    }
  }

  /** Store the opened topic's id in the launch record, so its route can be found (best-effort). */
  private async recordThread(key: string, threadId: string): Promise<void> {
    const domain = this.deps.domain()
    const record = domain?.topicLaunches.get(key)
    if (domain === undefined || record === undefined) return
    try {
      await domain.topicLaunches.put(key, { ...record, threadId })
    } catch (error) {
      this.deps.ctx.logger?.warn?.('dsh-channels: recording topic %s thread failed: %s', key, String(error))
    }
  }

  /**
   * Run one root card write of a launch after the writes queued before it.
   * @param key - the launch's idempotency key.
   * @param write - the write; its failure is returned to its own caller only.
   * @returns the write's result.
   */
  private async serialize<T>(key: string, write: () => Promise<T>): Promise<T> {
    const previous = this.cardWrites.get(key) ?? Promise.resolve()
    const result = previous.then(write, write)
    const settled = result.then(() => {}, () => {})
    this.cardWrites.set(key, settled)
    void settled.then(() => {
      if (this.cardWrites.get(key) === settled) this.cardWrites.delete(key)
    })
    return await result
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
    ...(card.links === undefined ? {} : { links: copyLinks(card.links) }),
  }
}

/** A detached copy of a link table, without absent optional fields. */
function copyLinks(links: TopicCardLinks): NonNullable<TopicLaunchRecord['card']['links']> {
  return {
    nameHeader: links.nameHeader,
    linkHeader: links.linkHeader,
    ...(links.extraLinkHeader === undefined ? {} : { extraLinkHeader: links.extraLinkHeader }),
    rows: links.rows.map(row => ({
      name: row.name,
      ...(row.url === undefined ? {} : { url: row.url }),
      ...(row.extraUrl === undefined ? {} : { extraUrl: row.extraUrl }),
    })),
  }
}

/**
 * The root card status a launch record names.
 * @param record - a stored launch.
 * @returns the card status.
 */
function statusOfRecord(record: TopicLaunchRecord): TopicStatus {
  switch (record.status) {
    case 'running': return { kind: 'running' }
    case 'done': return { kind: 'done' }
    case 'stopped': return { kind: 'stopped' }
    case 'error': return { kind: 'error' }
    case 'failed': return { kind: 'failed', reason: record.reason ?? '' }
    case 'interrupted': return { kind: 'interrupted' }
    default: return assertNever(record.status)
  }
}

function refused(code: TopicLaunchFailureCode, message: string): TopicLaunchResult {
  return { ok: false, code, message }
}

function linksRefused(code: TopicLinksUpdateFailureCode, message: string): TopicLinksUpdateResult {
  return { ok: false, code, message }
}

function reusedKey(): TopicLaunchResult {
  return refused('key-conflict', '幂等键已被内容不同的请求使用')
}

/**
 * The launch record fields naming a requester.
 * @param requester - the spec's requester.
 * @returns `requesterUserId` or `requesterLabel`.
 */
function requesterFields(requester: TopicRequester): Pick<TopicLaunchRecord, 'requesterUserId' | 'requesterLabel'> {
  switch (requester.kind) {
    case 'feishu-user': return { requesterUserId: requester.userId }
    case 'external': return { requesterLabel: requester.label }
    default: return assertNever(requester)
  }
}

/**
 * The requester a launch record names. The record schema requires exactly
 * one of the two fields.
 * @param record - a stored launch.
 * @returns the requester.
 */
function requesterOfRecord(record: TopicLaunchRecord): TopicRequester {
  if (record.requesterUserId !== undefined) return { kind: 'feishu-user', userId: record.requesterUserId }
  return { kind: 'external', label: record.requesterLabel ?? '' }
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`)
}
