/**
 * Recent attachment scan: which of the route owner's messages one turn lists,
 * driven with parsed `message.list` pages (newest first).
 */

import { describe, expect, it } from 'vitest'
import { parseMessagePage } from '../src/feishu/message-read.ts'
import type { RawMessageItem } from '../src/feishu/message-read.ts'
import { recentAttachmentMessagesOf } from '../src/feishu/recent-attachments.ts'
import type { RecentAttachmentScan } from '../src/feishu/recent-attachments.ts'
import { makeMessageListResponse, makeRawMessage } from './helpers.ts'

const OWNER = 'ou_owner'
const CHAT = 'oc_chat'
const TOPIC = 'omt_topic'

function page(...messages: Array<Parameters<typeof makeRawMessage>[0]>): readonly RawMessageItem[] {
  return parseMessagePage(makeMessageListResponse(messages.map(message => makeRawMessage({
    chat_id: CHAT,
    sender_id: OWNER,
    ...message,
  }))))?.items ?? []
}

const image = (messageId: string, extra: Parameters<typeof makeRawMessage>[0] = {}) => ({
  message_id: messageId, msg_type: 'image', content: { image_key: `img_${messageId}` }, ...extra,
})

function scan(items: readonly RawMessageItem[], partial: Partial<RecentAttachmentScan> = {}) {
  return recentAttachmentMessagesOf({
    items,
    container: { type: 'chat' },
    chatId: CHAT,
    senderOpenId: OWNER,
    excludeMessageIds: [],
    limit: 5,
    ...partial,
  }).map(message => message.messageId)
}

describe('recent attachment scan', () => {
  it('lists the owner\'s attachment messages newest first and skips everything else', () => {
    const items = page(
      image('om_new'),
      { message_id: 'om_text', msg_type: 'text', content: { text: 'hi' } },
      image('om_other_sender', { sender_id: 'ou_other' }),
      image('om_other_chat', { chat_id: 'oc_other' }),
      image('om_deleted', { deleted: true }),
      image('om_child', { upper_message_id: 'om_container' }),
      image('om_other_topic', { thread_id: 'omt_other', sender_id: 'ou_other' }),
      { message_id: 'om_forward', msg_type: 'merge_forward', content: {} },
      {
        message_id: 'om_post', msg_type: 'post',
        content: { title: '', content: [[{ tag: 'img', image_key: 'img_post' }]] },
      },
      { message_id: 'om_post_text', msg_type: 'post', content: { title: '', content: [[{ tag: 'text', text: 'x' }]] } },
    )
    const listed = recentAttachmentMessagesOf({
      items, container: { type: 'chat' }, chatId: CHAT, senderOpenId: OWNER, excludeMessageIds: [], limit: 10,
    })
    expect(listed).toEqual([
      { messageId: 'om_new', kind: 'message', resources: [{ type: 'image', fileKey: 'img_om_new' }], senderOpenId: OWNER },
      { messageId: 'om_forward', kind: 'merge_forward', resources: [], senderOpenId: OWNER },
      { messageId: 'om_post', kind: 'message', resources: [{ type: 'image', fileKey: 'img_post' }], senderOpenId: OWNER },
    ])
  })

  it('stops at a bot reply to the owner and at an earlier owner trigger rooting a topic', () => {
    expect(scan(page(
      image('om_after'),
      { message_id: 'om_bot', msg_type: 'interactive', sender_type: 'app', sender_id: 'cli_bot', parent_id: 'om_old_ask' },
      { message_id: 'om_old_ask', msg_type: 'text', content: { text: '上一轮' } },
      image('om_before_bot'),
    ))).toEqual(['om_after'])
    expect(scan(page(
      image('om_after'),
      { message_id: 'om_old_trigger', msg_type: 'text', thread_id: 'omt_old', content: { text: '上一轮' } },
      image('om_before_trigger'),
    ))).toEqual(['om_after'])
  })

  it('skips main-timeline bot messages that answer someone else', () => {
    expect(scan(page(
      image('om_after'),
      { message_id: 'om_help_card', msg_type: 'interactive', sender_type: 'app', sender_id: 'cli_bot' },
      {
        message_id: 'om_other_turn', msg_type: 'interactive', sender_type: 'app', sender_id: 'cli_bot',
        parent_id: 'om_bob_question',
      },
      { message_id: 'om_bob_question', msg_type: 'text', sender_id: 'ou_bob', content: { text: '@bot' } },
      image('om_before'),
    ))).toEqual(['om_after', 'om_before'])
  })

  it('never stops at an excluded id (the trigger and the current card)', () => {
    expect(scan(page(
      { message_id: 'om_card', msg_type: 'interactive', sender_type: 'app', sender_id: 'cli_bot' },
      { message_id: 'om_trigger', msg_type: 'text', thread_id: 'omt_new', content: { text: '看看' } },
      image('om_file'),
    ), { excludeMessageIds: ['om_trigger', 'om_card'] })).toEqual(['om_file'])
  })

  it('scans a topic container including its own thread id', () => {
    expect(scan(page(
      image('om_in_topic', { thread_id: TOPIC }),
      image('om_no_thread_id'),
      { message_id: 'om_bot', msg_type: 'interactive', sender_type: 'app', sender_id: 'cli_bot', thread_id: TOPIC },
      image('om_older', { thread_id: TOPIC }),
    ), { container: { type: 'thread', threadId: TOPIC } })).toEqual(['om_in_topic', 'om_no_thread_id'])
  })

  it('returns at most the limit', () => {
    expect(scan(page(image('om_1'), image('om_2'), image('om_3')), { limit: 2 })).toEqual(['om_1', 'om_2'])
  })
})
