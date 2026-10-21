/**
 * Recent attachment discovery: the attachment messages a route owner sent after
 * the previous turn, read from Feishu message history when a turn starts.
 *
 * A message that does not trigger a model turn (an attachment-only p2p message,
 * an un-mentioned group message, an attachment-only message inside a bound
 * topic) gets no reply and leaves no local state. When the owner's next message
 * triggers a turn, the inbound layer lists the route's containers newest-first
 * and {@link recentAttachmentMessagesOf} selects the owner's attachment
 * messages that arrived after the previous turn. The prompt manifest lists
 * them and the fetch whitelist authorizes them for the route.
 *
 * Scan rules, applied newest-first after dropping the excluded ids (the
 * trigger and this turn's streaming card):
 *
 * - a bot message ends the scan: older messages were in front of an earlier
 *   turn already;
 * - in a chat main timeline, an owner message that roots a topic ends the scan:
 *   it was an earlier trigger;
 * - other senders' messages, deleted messages, merged-forward children, other
 *   topics' messages and messages without attachments are skipped.
 *
 * Pure module: no I/O, no clock.
 *
 * @module dsh-channels/feishu/recent-attachments
 */

import type { MessageReadKnownMessage, RawMessageItem } from './message-read.ts'

/** Which Feishu container one scanned page was listed from. */
export type RecentAttachmentContainer =
  | { readonly type: 'thread'; readonly threadId: string }
  | { readonly type: 'chat' }

/** Inputs of one container scan. */
export interface RecentAttachmentScan {
  /** One `message.list` page of the container, newest first. */
  readonly items: readonly RawMessageItem[]
  readonly container: RecentAttachmentContainer
  /** Feishu chat the route belongs to; items of another chat are skipped. */
  readonly chatId: string
  /** Route owner (open_id); only this sender's messages are selected. */
  readonly senderOpenId: string
  /** Ids that never select or end the scan (trigger, current streaming card). */
  readonly excludeMessageIds: readonly string[]
  /** Maximum number of messages returned (>= 1). */
  readonly limit: number
}

/**
 * Select the owner's attachment messages of one container page since the
 * previous turn, newest first, as fetch-whitelist registrations. A
 * merged-forward container carries no resources: its children download
 * through the container id (P0 rule).
 *
 * @param scan - The page, its container, and the route identity.
 * @returns At most `scan.limit` messages, newest first.
 */
export function recentAttachmentMessagesOf(scan: RecentAttachmentScan): MessageReadKnownMessage[] {
  const excluded = new Set(scan.excludeMessageIds)
  const limit = Math.max(1, scan.limit)
  const selected: MessageReadKnownMessage[] = []
  for (const item of scan.items) {
    if (selected.length >= limit) break
    if (excluded.has(item.messageId)) continue
    if (item.chatId !== undefined && item.chatId !== scan.chatId) continue
    if (item.upperMessageId !== undefined) continue
    if (item.senderType === 'app') break
    if (!inContainer(item, scan.container)) {
      // An owner message rooting a topic was an earlier trigger.
      if (scan.container.type === 'chat' && item.senderOpenId === scan.senderOpenId) break
      continue
    }
    if (item.deleted || item.senderOpenId !== scan.senderOpenId) continue
    if (item.msgType === 'merge_forward') {
      selected.push({
        messageId: item.messageId, kind: 'merge_forward', resources: [], senderOpenId: scan.senderOpenId,
      })
      continue
    }
    if (item.resources.length === 0) continue
    selected.push({
      messageId: item.messageId, kind: 'message', resources: item.resources, senderOpenId: scan.senderOpenId,
    })
  }
  return selected
}

/** Whether one item sits in the scanned container (main timeline = no topic id). */
function inContainer(item: RawMessageItem, container: RecentAttachmentContainer): boolean {
  if (container.type === 'chat') return item.threadId === undefined
  return item.threadId === undefined || item.threadId === container.threadId
}
