/**
 * Read-only Feishu context a prompt carries: the bounded `<feishu_quote>`
 * excerpt of a quoted message and the first-turn `<feishu_history>` block,
 * each with the messages it authorizes for the attachment fetch tool. Reads
 * use the short prompt-enrichment budget and degrade to no block.
 *
 * @module dsh-channels/routing/message-context
 */

import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import {
  buildHistoryContextBlock, buildQuoteContextBlock, clampInt, knownMessageOfItems, knownMessagesOfHistory,
  quoteItemsOf, readQuoteItems, TOPIC_MESSAGES_MAX_LIMIT,
} from '../feishu/message-read.ts'
import type { MessageReader, MessageReadRoute, RawMessageItem } from '../feishu/message-read.ts'
import type { KnownAttachmentMessageInput } from '../feishu/tools.ts'

/**
 * Channel-plane identity of one route for message reads and the attachment
 * tool's known-message whitelist.
 * @param record - the route.
 * @returns its key, kind, chat, and sender.
 */
export function messageReadRouteOf(record: RouteRecord): MessageReadRoute {
  return {
    key: record.key,
    kind: record.kind,
    chatId: record.chatId,
    chatType: record.chatType,
    senderUserId: record.senderUserId,
  }
}

export interface PromptContextReaderDeps {
  reader: MessageReader
  config(): FeishuConfig
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Quote and history blocks of a prompt. */
export class PromptContextReader {
  /** One-shot warning for silently degraded reads (missing scope). */
  private warnedDegraded = false

  constructor(private readonly deps: PromptContextReaderDeps) {}

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
  async quote(input: {
    messageId: string
    record: RouteRecord
  }): Promise<{ block: string; message?: KnownAttachmentMessageInput } | undefined> {
    try {
      const result = await readQuoteItems(this.deps.reader, input.messageId, {
        timeoutMs: this.deps.config().promptContextTimeoutMs,
      })
      if (!result.ok) {
        this.reportDegradedRead('quoted message', input.messageId, result.reason)
        return undefined
      }
      const container: RawMessageItem | undefined = quoteItemsOf(result.value)
      if (container === undefined) return undefined
      if (!this.quotedMessageBelongsToRoute(input.record, container)) {
        this.deps.debug(
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
      this.deps.debug(
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
  async history(input: {
    record: RouteRecord
    limit: number
    excludeMessageIds: readonly string[]
  }): Promise<{ block: string; messages: readonly KnownAttachmentMessageInput[] } | undefined> {
    if (!Number.isFinite(input.limit) || input.limit <= 0) return undefined
    try {
      const route = messageReadRouteOf(input.record)
      const pageSize = clampInt(
        input.limit + input.excludeMessageIds.length,
        1,
        TOPIC_MESSAGES_MAX_LIMIT,
      )
      const result = await this.deps.reader.listRoute(route, {
        pageSize,
        order: 'newest-first',
        timeoutMs: this.deps.config().promptContextTimeoutMs,
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
      this.deps.debug(
        'dsh-channels: reading topic history of %s failed: %s', input.record.key, String(error),
      )
      return undefined
    }
  }

  /** Whether this deployment mounts the lazy attachment fetch tool. */
  private attachmentFetchMounted(): boolean {
    return this.deps.config().acceptAttachments
  }

  /**
   * Report one silently degraded prompt read: debug per occurrence (expected
   * when a deployment misses a scope) plus ONE warn per service lifetime so an
   * operator can find the cause without log spam.
   */
  private reportDegradedRead(kind: string, target: string, reason: string): void {
    if (this.warnedDegraded) {
      this.deps.debug(
        'dsh-channels: %s read of %s failed (degraded): %s', kind, target, reason,
      )
      return
    }
    this.warnedDegraded = true
    this.deps.warn(
      'dsh-channels: %s（%s）读取失败，已静默降级（不带引用/历史上下文继续回合）：%s。'
      + '如持续出现请检查飞书应用的消息读取权限（如 im:message:readonly / im:message.group_msg），'
      + '或确认该消息未被撤回、网络正常',
      kind, target, reason,
    )
  }
}
