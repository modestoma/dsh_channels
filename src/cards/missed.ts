/**
 * Card offering the messages that arrived while the channel was offline and
 * fell outside the catch-up window (see `routing/missed.ts`).
 *
 * @module dsh-channels/cards/missed
 */

import { card, columnSet, markdown, note, textButton } from './primitives.ts'

/** Button decision: handle the listed messages now. */
export const MISSED_RUN_ACTION = 'missed-run'

/** Button decision: drop the listed messages. */
export const MISSED_IGNORE_ACTION = 'missed-ignore'

/** Messages one card offers, carried in its button values. */
export interface MissedBatch {
  chatId: string
  chatType: 'p2p' | 'group'
  /** Message ids, oldest first. */
  messageIds: string[]
  /** `user_id`s of the senders: who may decide besides the administrator. */
  senders: string[]
}

/**
 * The pending card of one chat.
 * @param batch - the offered messages.
 * @param windowMinutes - the catch-up window the messages fell outside.
 * @returns the card.
 */
export function buildMissedMessagesCard(batch: MissedBatch, windowMinutes: number): object {
  const value = { chat: batch.chatId, chatType: batch.chatType, ids: batch.messageIds, senders: batch.senders }
  return card([
    markdown(`**📬 离线期间收到 ${batch.messageIds.length} 条消息**`),
    markdown(`这些消息已超过 ${windowMinutes} 分钟没有处理，内容可能已经过时。要现在按顺序处理吗？`),
    columnSet([
      textButton({ label: '全部处理', type: 'primary', value: { decision: MISSED_RUN_ACTION, ...value } }),
      textButton({ label: '忽略', value: { decision: MISSED_IGNORE_ACTION, ...value } }),
    ]),
    note('只有消息发送者或管理员可以操作。'),
  ])
}

/**
 * The pending card after a decision.
 * @param count - number of offered messages.
 * @param decision - the chosen action.
 * @returns the card without buttons.
 */
export function buildMissedDecidedCard(count: number, decision: 'run' | 'ignore'): object {
  return card([
    markdown(`**📬 离线期间收到 ${count} 条消息**`),
    markdown(decision === 'run' ? '已按顺序开始处理。' : '已忽略，这些消息不会再处理。'),
  ])
}

/**
 * Parse a pending-card click value.
 * @param value - `action.value` of a card click.
 * @returns the decision and its batch, or undefined for any other click.
 */
export function parseMissedAction(value: unknown): { decision: 'run' | 'ignore'; batch: MissedBatch } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const decision = record.decision === MISSED_RUN_ACTION ? 'run' : record.decision === MISSED_IGNORE_ACTION ? 'ignore' : undefined
  if (decision === undefined) return undefined
  const { chat, chatType, ids, senders } = record
  if (typeof chat !== 'string' || chat === '' || (chatType !== 'p2p' && chatType !== 'group')) return undefined
  if (!isStringList(ids) || ids.length === 0 || !isStringList(senders)) return undefined
  return { decision, batch: { chatId: chat, chatType, messageIds: ids, senders } }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item !== '')
}
