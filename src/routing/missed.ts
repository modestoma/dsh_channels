/**
 * Catch-up of messages that arrived while the long connection was down.
 *
 * Feishu does not replay events missed during a restart or a dropped
 * connection, so the channel reads them back from the message history:
 *
 * - at start, from the last-alive time the previous instance stored (a
 *   heartbeat keeps it current while connected; shutdown stores its own time);
 * - after a reconnect, from the moment the connection was lost.
 *
 * Each catch-up lists the user messages since that time in every chat the
 * channel knows (route chats, whitelisted groups, private chats it greeted)
 * and in the topics of recently active thread routes. A message newer than the
 * window goes through the normal inbound pipeline, whose `processed` dedup
 * drops anything already handled live. Older messages that would have reached
 * the bot (private chats, mentions, replies in a routed topic) are offered per
 * chat on a pending card instead; its buttons handle them all in order or
 * mark them processed. The read never reaches further back than the
 * `processed` retention, so a message handled before the outage is still
 * recognized.
 *
 * @module dsh-channels/routing/missed
 */

import { buildMissedDecidedCard, buildMissedMessagesCard, parseMissedAction } from '../cards/missed.ts'
import type { MissedBatch } from '../cards/missed.ts'
import { PROCESSED_RETENTION_MS } from '../domain.ts'
import type { FeishuDomainHandle, RouteRecord } from '../domain.ts'
import type { CardActionEvent, FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'
import type { HistoryContainer } from '../feishu/history-events.ts'

/** The `missed` config block. */
export interface MissedConfig {
  enabled: boolean
  windowMs: number
  heartbeatMs: number
  maxMessages: number
}

export interface MissedMessagesDeps {
  config(): MissedConfig
  /** The opened domain handle, or undefined before `start()` / after shutdown. */
  domain(): Pick<FeishuDomainHandle, 'getGlobal' | 'setGlobal' | 'processed'> | undefined
  /** The live channel, or undefined before `start()` / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Active route records. */
  routes(): readonly RouteRecord[]
  /** Chat ids of the whitelisted groups. */
  groupChats(): readonly string[]
  /** Hand one message to the inbound pipeline (dedup included). Never rejects. */
  handle(message: NormalizedMessage): Promise<void>
  /** Whether `userId` administers the channel. */
  isAdmin(userId: string): boolean
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

export class MissedMessages {
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** When the current connection loss began; undefined while connected. */
  private lostAt: number | undefined
  /** Catch-ups and card decisions run one at a time, in order. */
  private chain: Promise<void> = Promise.resolve()
  /** Pending cards already decided in this process. */
  private readonly decided = new Set<string>()
  /** Earliest time a queued or running catch-up has yet to cover. */
  private uncovered: number | undefined
  private stopping = false

  constructor(private readonly deps: MissedMessagesDeps) {}

  /**
   * Start after the long connection is up: catch up from the stored
   * last-alive time, then keep it current.
   */
  start(): void {
    const config = this.deps.config()
    if (!config.enabled) return
    this.stopping = false
    const since = this.deps.domain()?.getGlobal().lastAliveAt
    if (since !== undefined) this.scheduleCatchUp(since)
    this.startHeartbeat(config.heartbeatMs)
  }

  /** Connection lost: freeze the last-alive time at the loss. */
  onReconnecting(): void {
    if (!this.deps.config().enabled || this.lostAt !== undefined) return
    this.lostAt = Date.now()
    this.stopHeartbeat()
  }

  /** Connection back: catch up from the loss, then resume the heartbeat. */
  onReconnected(): void {
    const config = this.deps.config()
    const since = this.lostAt
    this.lostAt = undefined
    if (!config.enabled || since === undefined) return
    this.scheduleCatchUp(since)
    this.startHeartbeat(config.heartbeatMs)
  }

  /** Answer a pending-card click; other clicks are ignored. */
  onCardAction(event: CardActionEvent): void {
    const action = parseMissedAction(event.action.value)
    if (action === undefined || this.decided.has(event.messageId)) return
    const userId = event.operator.userId
    if (userId === undefined || (!action.batch.senders.includes(userId) && !this.deps.isAdmin(userId))) return
    this.decided.add(event.messageId)
    this.enqueue(async () => await this.decide(event.messageId, action.decision, action.batch))
  }

  /** Resolves once the catch-ups and card decisions queued so far have run. */
  async settled(): Promise<void> {
    await this.chain
  }

  /**
   * Stop: skip catch-ups not yet started, wait for the running one, and store
   * the earliest time not yet caught up as the last-alive time. Call before
   * the channel disconnects and the domain closes.
   */
  async stop(): Promise<void> {
    this.stopping = true
    this.stopHeartbeat()
    const lostAt = this.lostAt
    this.lostAt = undefined
    await this.chain
    if (this.deps.config().enabled) {
      await this.storeAlive(Math.min(this.uncovered ?? Infinity, lostAt ?? Infinity, Date.now()))
    }
    this.uncovered = undefined
    this.decided.clear()
  }

  /** Queue a catch-up from `since`; the heartbeat holds still until it ends. */
  private scheduleCatchUp(since: number): void {
    this.uncovered = Math.min(this.uncovered ?? since, since)
    this.enqueue(async () => {
      if (this.stopping) return
      await this.catchUp(since)
      this.uncovered = undefined
      await this.storeAlive(Date.now())
    })
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => {
      this.deps.warn('dsh-channels: missed-message catch-up failed: %s', String(error))
    })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    const beat = (): void => {
      // A pending catch-up still has older messages to read.
      if (this.uncovered === undefined) void this.storeAlive(Date.now())
    }
    beat()
    const timer = setInterval(beat, intervalMs)
    timer.unref?.()
    this.heartbeat = timer
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private async storeAlive(at: number): Promise<void> {
    const domain = this.deps.domain()
    if (domain === undefined) return
    try {
      await domain.setGlobal({ ...domain.getGlobal(), lastAliveAt: at })
    } catch (error) {
      this.deps.warn('dsh-channels: storing the last-alive time failed: %s', String(error))
    }
  }

  /** Read and dispatch every message since `since`. */
  private async catchUp(since: number): Promise<void> {
    const channel = this.deps.channel()
    if (channel?.historyIds === undefined || channel.historyMessages === undefined) return
    const config = this.deps.config()
    const now = Date.now()
    // One heartbeat of slack covers clock skew against Feishu's timestamps.
    const from = Math.max(since - config.heartbeatMs, now - PROCESSED_RETENTION_MS)
    const processed = this.deps.domain()?.processed
    const seen = new Set<string>()
    const found = new Map<'p2p' | 'group', Array<{ messageId: string; createTime: number }>>()
    let budget = config.maxMessages
    for (const container of this.containers(from)) {
      if (budget === 0) {
        this.deps.warn('dsh-channels: missed-message catch-up stopped at %d messages', config.maxMessages)
        break
      }
      let listed
      try {
        listed = await channel.historyIds(container, from, budget)
      } catch (error) {
        this.deps.warn('dsh-channels: reading missed messages of %s %s failed: %s', container.type, container.id, String(error))
        continue
      }
      for (const entry of listed.ids) {
        if (seen.has(entry.messageId)) continue
        seen.add(entry.messageId)
        if (processed?.get(entry.messageId) !== undefined) continue
        budget--
        const list = found.get(container.chatType) ?? []
        list.push(entry)
        found.set(container.chatType, list)
      }
      if (listed.truncated) budget = 0
    }
    if (found.size === 0) return
    const windowStart = now - config.windowMs
    const live: NormalizedMessage[] = []
    const stale = new Map<string, MissedBatch>()
    const routes = new Set(this.deps.routes().filter(route => route.kind === 'thread').map(route => route.key))
    for (const [chatType, entries] of found) {
      const messages = await channel.historyMessages(entries.map(entry => entry.messageId), chatType)
      for (const message of messages) {
        if (message.createTime >= windowStart) {
          live.push(message)
          continue
        }
        if (message.chatType === 'group' && !message.mentionedBot
          && (message.threadId === undefined || !routes.has(message.threadId))) continue
        const batch = stale.get(message.chatId) ?? { chatId: message.chatId, chatType, messageIds: [], senders: [] }
        batch.messageIds.push(message.messageId)
        if (!batch.senders.includes(message.senderId)) batch.senders.push(message.senderId)
        stale.set(message.chatId, batch)
      }
    }
    live.sort((a, b) => a.createTime - b.createTime)
    this.deps.info('dsh-channels: catching up %d missed message(s), offering %d older chat(s)', live.length, stale.size)
    for (const message of live) await this.deps.handle(message)
    for (const batch of stale.values()) {
      try {
        await channel.send(batch.chatId, { card: buildMissedMessagesCard(batch, Math.round(config.windowMs / 60_000)) })
      } catch (error) {
        this.deps.warn('dsh-channels: sending the missed-message card to %s failed: %s', batch.chatId, String(error))
      }
    }
  }

  /** Chats and topics to read, each once. */
  private containers(from: number): HistoryContainer[] {
    const chats = new Map<string, 'p2p' | 'group'>()
    const threads: HistoryContainer[] = []
    for (const route of this.deps.routes()) {
      chats.set(route.chatId, route.chatType)
      // Topics idle for a whole retention period before `from` are skipped.
      if (route.kind === 'thread' && route.lastActivityAt >= from - PROCESSED_RETENTION_MS) {
        threads.push({ type: 'thread', id: route.key, chatType: route.chatType })
      }
    }
    for (const chatId of this.deps.groupChats()) if (!chats.has(chatId)) chats.set(chatId, 'group')
    for (const chatId of this.deps.domain()?.getGlobal().welcomedChats ?? []) if (!chats.has(chatId)) chats.set(chatId, 'p2p')
    return [...[...chats].map(([id, chatType]): HistoryContainer => ({ type: 'chat', id, chatType })), ...threads]
  }

  /** Apply a pending-card decision. */
  private async decide(cardMessageId: string, decision: 'run' | 'ignore', batch: MissedBatch): Promise<void> {
    const channel = this.deps.channel()
    if (channel === undefined) return
    await channel.updateCard(cardMessageId, buildMissedDecidedCard(batch.messageIds.length, decision)).catch((error: unknown) => {
      this.deps.warn('dsh-channels: updating the missed-message card failed: %s', String(error))
    })
    if (decision === 'ignore') {
      const processed = this.deps.domain()?.processed
      for (const messageId of batch.messageIds) {
        await processed?.put(messageId, { key: messageId, processedAt: Date.now() })
      }
      return
    }
    if (channel.historyMessages === undefined) return
    const messages = await channel.historyMessages(batch.messageIds, batch.chatType)
    for (const message of messages) await this.deps.handle(message)
  }
}
