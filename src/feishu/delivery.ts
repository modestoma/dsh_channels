/**
 * Outbound Feishu delivery: card sends, the topic-creating first reply, body
 * segment fallbacks, and the command reaction lifecycle.
 *
 * Every send is gated on the service being started, and commands are the only
 * plane that adds/deletes reactions (`Typing` → `DONE`); ordinary turns get
 * their reaction lifecycle from the streamer's finalize path.
 *
 * @module dsh-channels/feishu/delivery
 */

import { buildCommandResultCard } from '../commands.ts'
import type { CommandCardState } from '../commands.ts'
import type { RouteRecord } from '../domain.ts'
import type { FeishuChannel, NormalizedMessage, SendResult } from '../feishu-channel.ts'

/** Rejection text for a message in a topic retired by route TTL. */
export const EXPIRED_ROUTE_TEXT = '该话题已超过路由保留时间，并已与原 Session 解绑。为避免误接续上下文，插件不会在此话题创建新 Session；请从私聊或群聊主会话发起新消息（群聊请 @ 机器人）创建新话题。'

export interface CardDeliveryDeps {
  /** The live channel, or undefined before `start()` / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Whether the service is accepting sends. */
  started(): boolean
  /** Route owning a session (segment-card anchoring). */
  routeForSession(sessionId: string): RouteRecord | undefined
  warn(message: string, ...args: unknown[]): void
}

export class CardDelivery {
  /** Inbound message ids whose command result replaces that message's card. */
  private readonly inPlace = new Set<string>()

  constructor(private readonly deps: CardDeliveryDeps) {}

  /**
   * Run `operation` with every `standaloneReply` anchored to `messageId`
   * patched into that (bot-sent card) message instead of replying to it.
   * Used for picker clicks, whose synthetic message id is the picker card.
   */
  async replacingCard(messageId: string, operation: () => Promise<void>): Promise<void> {
    this.inPlace.add(messageId)
    try {
      await operation()
    } finally {
      this.inPlace.delete(messageId)
    }
  }

  /** The live channel; throws instead of silently dropping a delivery. */
  requireChannel(): FeishuChannel {
    const channel = this.deps.channel()
    if (channel === undefined) throw new Error('dsh-channels: channel not started')
    return channel
  }

  /** Apply the command-only Typing → DONE reaction lifecycle. */
  async withCommandReaction(msg: NormalizedMessage, operation: () => Promise<void>): Promise<void> {
    if (!this.deps.started()) return
    const channel = this.requireChannel()
    const reactionId = await channel.addReaction(msg.messageId, 'Typing').catch(() => undefined)
    try {
      await operation()
    } finally {
      if (reactionId !== undefined) {
        await channel.removeReaction(msg.messageId, reactionId).catch(() => {})
      }
      await channel.addReaction(msg.messageId, 'DONE').catch(() => {})
    }
  }

  /** Standalone, non-streaming command result card with a non-threaded fallback. */
  async commandCard(
    msg: NormalizedMessage,
    state: CommandCardState,
    options: { createThread?: boolean } = {},
  ): Promise<void> {
    await this.standaloneReply(msg, buildCommandResultCard(state), options)
  }

  /** Reject a post-TTL topic message without creating or resuming an Agent. */
  async expiredRouteCard(msg: NormalizedMessage, command?: string): Promise<void> {
    await this.commandCard(msg, {
      kind: 'expired',
      ...(command === undefined ? {} : { command }),
      text: EXPIRED_ROUTE_TEXT,
    })
  }

  /**
   * Shared delivery policy for command-plane cards: reply in a new topic by
   * default, then degrade to a plain reply when Feishu refuses the topic.
   * `createThread: false` replies in the chat timeline, or inside the topic
   * the message already belongs to. Inside `replacingCard` the card patches
   * the anchored card instead, and falls back to a reply if the patch fails.
   */
  async standaloneReply(
    msg: NormalizedMessage,
    card: object,
    options: { createThread?: boolean } = {},
  ): Promise<void> {
    const channel = this.deps.channel()
    if (!this.deps.started() || channel === undefined) return
    if (this.inPlace.has(msg.messageId)) {
      try {
        await channel.updateCard(msg.messageId, card)
        return
      } catch (error) {
        this.deps.warn(
          'dsh-channels: in-place update of card %s failed, replying instead: %s',
          msg.messageId, String(error),
        )
      }
    }
    const createThread = options.createThread ?? true
    try {
      await channel.send(msg.chatId, { card }, createThread || msg.threadId !== undefined
        ? { replyTo: msg.messageId, replyInThread: true }
        : { replyTo: msg.messageId })
    } catch (error) {
      if (!createThread) {
        this.deps.warn(
          'dsh-channels: direct command result delivery failed for message %s: %s',
          msg.messageId, String(error),
        )
        return
      }
      try {
        await channel.send(msg.chatId, { card }, { replyTo: msg.messageId })
      } catch (fallbackError) {
        this.deps.warn(
          'dsh-channels: command result delivery failed for message %s: %s / %s',
          msg.messageId, String(error), String(fallbackError),
        )
      }
    }
  }

  /**
   * Send one short plain-text notice anchored to an inbound message. Replies
   * inside an existing topic when the message belongs to one, and never
   * creates a topic: an attachment-only message must stay a notice, not a new
   * conversation. Best-effort — a failed notice only warns.
   */
  async noticeText(msg: NormalizedMessage, text: string): Promise<void> {
    const channel = this.deps.channel()
    if (!this.deps.started() || channel === undefined) return
    try {
      await channel.send(msg.chatId, { text }, {
        replyTo: msg.messageId,
        ...(msg.threadId === undefined ? {} : { replyInThread: true }),
      })
    } catch (error) {
      this.deps.warn(
        'dsh-channels: attachment notice delivery failed for message %s: %s',
        msg.messageId, String(error),
      )
    }
  }

  /**
   * Reply with the first card frame. Prefers topic replies (`reply_in_thread`)
   * — the documented way a bot creates a topic — and falls back to a plain
   * reply when Feishu refuses (degraded chat-scoped routing).
   */
  async replyFirstCard(
    msg: NormalizedMessage,
    card: object,
  ): Promise<{ messageId: string; threadId?: string; degraded: boolean }> {
    const channel = this.requireChannel()
    try {
      const res = await channel.send(
        msg.chatId,
        { card },
        { replyTo: msg.messageId, replyInThread: true },
      )
      const threadId = await channel.threadIdOfMessage(res.messageId).catch(() => undefined)
      return { messageId: res.messageId, threadId, degraded: false }
    } catch (error) {
      if (!this.deps.started()) throw error
      const res = await channel.send(msg.chatId, { card }, { replyTo: msg.messageId })
      return { messageId: res.messageId, degraded: true }
    }
  }

  /**
   * Send one body-segment continuation card into the session's topic (or, for
   * degraded chat-scoped routes, as a plain reply anchored to the main card).
   * When Feishu rejects the card (e.g. per-card table limit, error 11310) the
   * segment is re-delivered as a plain-text message so the content is never
   * lost — text messages carry no card constraints.
   */
  async segmentCard(
    sessionId: string,
    segment: number,
    card: object,
    fallbackText: string,
  ): Promise<{ messageId: string; mode: 'card' | 'text' }> {
    const record = this.deps.routeForSession(sessionId)
    if (record === undefined) {
      throw new Error(`dsh-channels: no route record for session ${sessionId}; segment card not sent`)
    }
    const channel = this.requireChannel()
    const options = { replyTo: record.cardMessageId, replyInThread: record.kind === 'thread' }
    try {
      const res: SendResult = await channel.send(record.chatId, { card }, options)
      return { messageId: res.messageId, mode: 'card' }
    } catch (error) {
      this.deps.warn(
        'dsh-channels: segment %d card for session %s rejected, falling back to plain text: %s',
        segment, sessionId, String(error),
      )
      const res = await channel.send(record.chatId, {
        text: `📄 回复分段 ${segment}（卡片发送失败，已降级为纯文本）\n\n${fallbackText}`,
      }, options)
      return { messageId: res.messageId, mode: 'text' }
    }
  }
}
