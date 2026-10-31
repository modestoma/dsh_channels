/**
 * Rebuild long-connection message events from Feishu's message history.
 *
 * Messages that arrived while the channel was offline never reach the long
 * connection, so missed-message catch-up (`routing/missed.ts`) lists them
 * through `im.v1.message.list` and turns each into the `im.message.receive_v1`
 * event body the SDK normalizer consumes. The list endpoint reports users by
 * `open_id` only, which the normalizer needs to recognize a mention of the bot;
 * the plugin keys every user by `user_id`, so a second `message.mget` with
 * `user_id_type=user_id` supplies the sender's and each mention's `user_id`.
 *
 * A message is dropped when its sender is not a user, has no `user_id` (same
 * rule as live delivery), or the message was deleted.
 *
 * @module dsh-channels/feishu/history-events
 */

import { z } from 'zod'
import type { NormalizedMessage, RawMessageEvent } from '@larksuiteoapi/node-sdk'

/** Page size of one `message.list` call and id count of one `message.mget` (Feishu maximum). */
export const HISTORY_PAGE_SIZE = 50

/** One chat timeline or topic whose history is read. */
export interface HistoryContainer {
  type: 'chat' | 'thread'
  id: string
  chatType: 'p2p' | 'group'
}

/** The Feishu calls behind history reads. */
export interface HistoryEventOps {
  /** Raw `im.v1.message.list` response. */
  list(params: {
    container_id_type: 'chat' | 'thread'
    container_id: string
    start_time: string
    sort_type: 'ByCreateTimeAsc'
    page_size: number
    page_token?: string
  }): Promise<unknown>
  /** Raw `message.mget` response with users reported by `idType`. */
  mget(messageIds: readonly string[], idType: 'open_id' | 'user_id'): Promise<unknown>
  /** The SDK normalizer configured like the live channel's. */
  normalize(event: RawMessageEvent): Promise<NormalizedMessage>
}

const historyItemSchema = z.looseObject({
  message_id: z.string().min(1),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
  msg_type: z.string(),
  create_time: z.string(),
  update_time: z.string().optional(),
  deleted: z.boolean().optional(),
  chat_id: z.string().min(1),
  sender: z.looseObject({ id: z.string(), id_type: z.string(), sender_type: z.string(), tenant_key: z.string().optional() }),
  body: z.looseObject({ content: z.string() }),
  mentions: z.array(z.looseObject({ key: z.string(), id: z.string(), id_type: z.string(), name: z.string().optional() })).optional(),
})

type HistoryItem = z.infer<typeof historyItemSchema>

const historyPageSchema = z.looseObject({
  code: z.number().optional(),
  msg: z.string().optional(),
  data: z.looseObject({
    items: z.array(z.unknown()).optional(),
    has_more: z.boolean().optional(),
    page_token: z.string().optional(),
  }).optional(),
})

/** Thrown when a history call answers with a Feishu error or an unreadable body. */
export class HistoryReadError extends Error {
  override readonly name = 'HistoryReadError'
}

function parsePage(response: unknown, call: string): { items: HistoryItem[]; hasMore: boolean; pageToken?: string } {
  const parsed = historyPageSchema.safeParse(response)
  if (!parsed.success) throw new HistoryReadError(`${call} returned an unreadable response`)
  const { code, msg, data } = parsed.data
  if (code !== undefined && code !== 0) throw new HistoryReadError(`${call} failed: ${msg ?? 'unknown error'} (code ${code})`)
  const items: HistoryItem[] = []
  for (const raw of data?.items ?? []) {
    const item = historyItemSchema.safeParse(raw)
    if (item.success) items.push(item.data)
  }
  return { items, hasMore: data?.has_more === true, ...(data?.page_token === undefined ? {} : { pageToken: data.page_token }) }
}

/**
 * Ids of the user messages created at or after `sinceMs` in one container,
 * oldest first, at most `limit`.
 * @param ops - the Feishu calls.
 * @param container - the chat or topic to read.
 * @param sinceMs - epoch ms of the earliest message wanted.
 * @param limit - maximum number of ids returned.
 * @returns the ids and whether more messages were left unread.
 */
export async function listHistoryIds(
  ops: HistoryEventOps,
  container: HistoryContainer,
  sinceMs: number,
  limit: number,
): Promise<{ ids: Array<{ messageId: string; createTime: number }>; truncated: boolean }> {
  const ids: Array<{ messageId: string; createTime: number }> = []
  let pageToken: string | undefined
  for (;;) {
    const page = parsePage(await ops.list({
      container_id_type: container.type,
      container_id: container.id,
      // Feishu filters by whole seconds.
      start_time: String(Math.floor(sinceMs / 1000)),
      sort_type: 'ByCreateTimeAsc',
      page_size: HISTORY_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { page_token: pageToken }),
    }), 'message.list')
    for (const item of page.items) {
      const createTime = Number(item.create_time)
      if (item.deleted === true || item.sender.sender_type !== 'user' || !(createTime >= sinceMs)) continue
      if (ids.length === limit) return { ids, truncated: true }
      ids.push({ messageId: item.message_id, createTime })
    }
    if (!page.hasMore || page.pageToken === undefined) return { ids, truncated: false }
    pageToken = page.pageToken
  }
}

/**
 * Normalized events of the given messages, in the given order, as live
 * delivery would hand them to the plugin (`senderId` is the sender's
 * `user_id`). Messages that live delivery would drop are left out.
 * @param ops - the Feishu calls.
 * @param messageIds - the messages to rebuild.
 * @param chatType - the chat type of every message.
 * @returns the rebuilt events.
 */
export async function historyMessages(
  ops: HistoryEventOps,
  messageIds: readonly string[],
  chatType: 'p2p' | 'group',
): Promise<NormalizedMessage[]> {
  const messages: NormalizedMessage[] = []
  for (let offset = 0; offset < messageIds.length; offset += HISTORY_PAGE_SIZE) {
    const batch = messageIds.slice(offset, offset + HISTORY_PAGE_SIZE)
    const [openItems, userItems] = await Promise.all([
      ops.mget(batch, 'open_id').then(response => parsePage(response, 'message.mget').items),
      ops.mget(batch, 'user_id').then(response => parsePage(response, 'message.mget').items),
    ])
    const byOpen = new Map(openItems.map(item => [item.message_id, item]))
    const byUser = new Map(userItems.map(item => [item.message_id, item]))
    for (const messageId of batch) {
      const open = byOpen.get(messageId)
      const user = byUser.get(messageId)
      if (open === undefined || user === undefined) continue
      const event = historyEventOf(open, user, chatType)
      if (event === undefined) continue
      messages.push({ ...await ops.normalize(event), senderId: user.sender.id })
    }
  }
  return messages
}

/**
 * The `im.message.receive_v1` body of one history message.
 * @param open - the message as read with `open_id` users.
 * @param user - the same message as read with `user_id` users.
 * @param chatType - the chat type of the message.
 * @returns the event, or undefined when live delivery would drop the message.
 */
export function historyEventOf(open: HistoryItem, user: HistoryItem, chatType: 'p2p' | 'group'): RawMessageEvent | undefined {
  if (open.deleted === true || open.sender.sender_type !== 'user') return undefined
  if (open.sender.id_type !== 'open_id' || user.sender.id_type !== 'user_id' || user.sender.id === '') return undefined
  const userMentions = new Map((user.mentions ?? []).filter(mention => mention.id_type === 'user_id').map(mention => [mention.key, mention.id]))
  return {
    sender: {
      sender_id: { open_id: open.sender.id, user_id: user.sender.id },
      sender_type: 'user',
      ...(open.sender.tenant_key === undefined ? {} : { tenant_key: open.sender.tenant_key }),
    },
    message: {
      message_id: open.message_id,
      ...(open.root_id === undefined ? {} : { root_id: open.root_id }),
      ...(open.parent_id === undefined ? {} : { parent_id: open.parent_id }),
      create_time: open.create_time,
      ...(open.update_time === undefined ? {} : { update_time: open.update_time }),
      chat_id: open.chat_id,
      ...(open.thread_id === undefined ? {} : { thread_id: open.thread_id }),
      chat_type: chatType,
      message_type: open.msg_type,
      content: open.body.content,
      mentions: (open.mentions ?? []).map(mention => {
        const userId = userMentions.get(mention.key)
        return {
          key: mention.key,
          id: {
            ...(mention.id_type === 'open_id' ? { open_id: mention.id } : {}),
            ...(userId === undefined ? {} : { user_id: userId }),
          },
          ...(mention.name === undefined ? {} : { name: mention.name }),
        }
      }),
    },
  }
}
