/** Message history read back as long-connection events (missed-message catch-up). */

import { normalize } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { historyMessages, HistoryReadError, listHistoryIds } from '../src/feishu/history-events.ts'
import type { HistoryEventOps } from '../src/feishu/history-events.ts'

interface ItemOptions {
  id: string
  createTime: number
  senderType?: string
  senderId?: string
  idType?: 'open_id' | 'user_id'
  text?: string
  mentions?: Array<{ key: string; id: string; name: string }>
  deleted?: boolean
  threadId?: string
}

function item(options: ItemOptions): object {
  return {
    message_id: options.id,
    msg_type: 'text',
    create_time: String(options.createTime),
    chat_id: 'oc_chat',
    ...(options.threadId === undefined ? {} : { thread_id: options.threadId, root_id: 'om_root' }),
    ...(options.deleted === undefined ? {} : { deleted: options.deleted }),
    sender: { id: options.senderId ?? 'ou_alice', id_type: options.idType ?? 'open_id', sender_type: options.senderType ?? 'user', tenant_key: 't' },
    body: { content: JSON.stringify({ text: options.text ?? 'hi' }) },
    ...(options.mentions === undefined
      ? {}
      : { mentions: options.mentions.map(mention => ({ ...mention, id_type: options.idType ?? 'open_id' })) }),
  }
}

function page(items: object[], more?: string): object {
  return { code: 0, data: { items, has_more: more !== undefined, ...(more === undefined ? {} : { page_token: more }) } }
}

function ops(overrides: Partial<HistoryEventOps> = {}): HistoryEventOps {
  return {
    list: vi.fn(async () => page([])),
    mget: vi.fn(async () => page([])),
    normalize: async event => await normalize(event, { botIdentity: { openId: 'ou_bot', name: 'bot' }, stripBotMentions: true, includeRaw: true }),
    ...overrides,
  }
}

describe('listHistoryIds', () => {
  it('pages through user messages since the start time, oldest first', async () => {
    const list = vi.fn(async (params: { page_token?: string }) => params.page_token === undefined
      ? page([
        item({ id: 'om_old', createTime: 999 }),
        item({ id: 'om_1', createTime: 1_000 }),
        item({ id: 'om_bot', createTime: 1_001, senderType: 'app' }),
        item({ id: 'om_gone', createTime: 1_002, deleted: true }),
      ], 'next')
      : page([item({ id: 'om_2', createTime: 2_000 })]))
    const result = await listHistoryIds(ops({ list }), { type: 'chat', id: 'oc_chat', chatType: 'group' }, 1_000, 10)
    expect(result).toEqual({ ids: [{ messageId: 'om_1', createTime: 1_000 }, { messageId: 'om_2', createTime: 2_000 }], truncated: false })
    expect(list).toHaveBeenNthCalledWith(1, {
      container_id_type: 'chat', container_id: 'oc_chat', start_time: '1', sort_type: 'ByCreateTimeAsc', page_size: 50,
    })
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ page_token: 'next' }))
  })

  it('stops at the limit and reports the rest as truncated', async () => {
    const list = vi.fn(async () => page([item({ id: 'om_1', createTime: 1 }), item({ id: 'om_2', createTime: 2 })], 'next'))
    const result = await listHistoryIds(ops({ list }), { type: 'thread', id: 'omt_1', chatType: 'group' }, 0, 1)
    expect(result).toEqual({ ids: [{ messageId: 'om_1', createTime: 1 }], truncated: true })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('rejects a Feishu error or an unreadable body', async () => {
    const container = { type: 'chat' as const, id: 'oc_chat', chatType: 'p2p' as const }
    await expect(listHistoryIds(ops({ list: async () => ({ code: 230002, msg: 'bot not in chat' }) }), container, 0, 5))
      .rejects.toThrow(new HistoryReadError('message.list failed: bot not in chat (code 230002)'))
    await expect(listHistoryIds(ops({ list: async () => 'nope' }), container, 0, 5)).rejects.toBeInstanceOf(HistoryReadError)
  })
})

describe('historyMessages', () => {
  it('rebuilds events with user_id senders and recognizes a mention of the bot', async () => {
    const mget = vi.fn(async (ids: readonly string[], idType: 'open_id' | 'user_id') => {
      const user = idType === 'user_id'
      return page(ids.flatMap(id => {
        if (id === 'om_missing') return []
        if (id === 'om_app') return [item({ id, createTime: 3, senderType: 'app', senderId: 'cli_x', idType: user ? 'user_id' : 'open_id' })]
        if (id === 'om_external') return [item({ id, createTime: 4, senderId: user ? '' : 'ou_ext', idType: user ? 'user_id' : 'open_id' })]
        return [item({
          id,
          createTime: id === 'om_1' ? 1 : 2,
          senderId: user ? 'u_alice' : 'ou_alice',
          idType: user ? 'user_id' : 'open_id',
          text: '@_user_1 @_user_2 看一下',
          mentions: [
            { key: '@_user_1', id: user ? 'cli_bot' : 'ou_bot', name: 'bot' },
            { key: '@_user_2', id: user ? 'u_bob' : 'ou_bob', name: 'Bob' },
          ],
          threadId: 'omt_1',
        })]
      }))
    })
    const messages = await historyMessages(ops({ mget }), ['om_2', 'om_app', 'om_1', 'om_external', 'om_missing'], 'group')
    expect(messages.map(message => message.messageId)).toEqual(['om_2', 'om_1'])
    expect(messages[0]).toMatchObject({
      chatId: 'oc_chat', chatType: 'group', senderId: 'u_alice', mentionedBot: true, threadId: 'omt_1', rootId: 'om_root', createTime: 2,
    })
    expect(messages[0]!.content).toContain('看一下')
    expect(messages[0]!.mentions).toContainEqual(expect.objectContaining({ openId: 'ou_bob', userId: 'u_bob' }))
    expect(messages[0]!.raw).toMatchObject({ sender: { sender_id: { open_id: 'ou_alice', user_id: 'u_alice' } } })
  })

  it('reads ids in batches of 50', async () => {
    const mget = vi.fn(async (_ids: readonly string[], _idType: 'open_id' | 'user_id') => page([]))
    await historyMessages(ops({ mget }), Array.from({ length: 51 }, (_, index) => `om_${index}`), 'p2p')
    expect(mget.mock.calls.map(([ids, idType]) => [ids.length, idType]))
      .toEqual([[50, 'open_id'], [50, 'user_id'], [1, 'open_id'], [1, 'user_id']])
  })
})
