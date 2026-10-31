/** Missed-message catch-up: what is read, handled, offered, and stored. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { MISSED_IGNORE_ACTION, MISSED_RUN_ACTION, parseMissedAction } from '../src/cards/missed.ts'
import { PROCESSED_RETENTION_MS } from '../src/domain.ts'
import type { FeishuDomainGlobal, ProcessedRecord, RouteRecord } from '../src/domain.ts'
import type { CardActionEvent, FeishuChannel, NormalizedMessage } from '../src/feishu-channel.ts'
import type { HistoryContainer } from '../src/feishu/history-events.ts'
import { MissedMessages } from '../src/routing/missed.ts'
import type { MissedConfig, MissedMessagesDeps } from '../src/routing/missed.ts'
import { makeChannel, makeMessage } from './helpers.ts'

const NOW = 10 * 60 * 60_000
const MINUTE = 60_000

function route(partial: Partial<RouteRecord> & Pick<RouteRecord, 'key' | 'chatId'>): RouteRecord {
  return {
    kind: 'thread', sessionId: 's', chatType: 'group', senderUserId: 'u_alice', workspacePath: '/w',
    cardMessageId: 'om_card', createdAt: 0, lastActivityAt: NOW - 60 * MINUTE, ...partial,
  }
}

interface Setup {
  missed: MissedMessages
  channel: ReturnType<typeof makeChannel>
  handled: NormalizedMessage[]
  global: FeishuDomainGlobal
  processed: Map<string, ProcessedRecord>
  historyIds: Mock<NonNullable<FeishuChannel['historyIds']>>
  warn: Mock
}

function setup(options: {
  lastAliveAt?: number
  messages?: NormalizedMessage[]
  routes?: RouteRecord[]
  groups?: string[]
  welcomed?: string[]
  config?: Partial<MissedConfig>
  processed?: string[]
} = {}): Setup {
  const messages = options.messages ?? []
  const global: FeishuDomainGlobal = {
    ...(options.lastAliveAt === undefined ? {} : { lastAliveAt: options.lastAliveAt }),
    ...(options.welcomed === undefined ? {} : { welcomedChats: options.welcomed }),
  }
  const processed = new Map<string, ProcessedRecord>((options.processed ?? []).map(id => [id, { key: id, processedAt: 0 }]))
  const historyIds = vi.fn<NonNullable<FeishuChannel['historyIds']>>(async (container, sinceMs, limit) => {
    const ids = messages
      .filter(message => (container.type === 'chat' ? message.chatId === container.id : message.threadId === container.id)
        && message.createTime >= sinceMs)
      .map(message => ({ messageId: message.messageId, createTime: message.createTime }))
    return { ids: ids.slice(0, limit), truncated: ids.length > limit }
  })
  const channel = Object.assign(makeChannel(), {
    historyIds,
    historyMessages: vi.fn(async (ids: readonly string[]) => ids.flatMap(id => messages.filter(message => message.messageId === id))),
  })
  const handled: NormalizedMessage[] = []
  const warn = vi.fn()
  const deps: MissedMessagesDeps = {
    config: () => ({ enabled: true, windowMs: 30 * MINUTE, heartbeatMs: MINUTE, maxMessages: 200, ...options.config }),
    domain: () => ({
      getGlobal: () => global,
      setGlobal: (value: FeishuDomainGlobal) => { Object.assign(global, value) },
      processed: {
        get: key => processed.get(key),
        put: (key, value) => { processed.set(key, value) },
        delete: key => { processed.delete(key) },
        entries: () => processed.entries(),
      },
    }),
    channel: () => channel,
    routes: () => options.routes ?? [],
    groupChats: () => options.groups ?? [],
    handle: async message => { handled.push(message) },
    isAdmin: userId => userId === 'u_admin',
    info: vi.fn(),
    warn,
  }
  return { missed: new MissedMessages(deps), channel, handled, global, processed, historyIds, warn }
}

function message(id: string, minutesAgo: number, partial: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return makeMessage({ messageId: id, chatId: 'oc_p2p', chatType: 'p2p', senderId: 'u_alice', content: id, createTime: NOW - minutesAgo * MINUTE, ...partial })
}

/** Callback values of every button in a card. */
function buttonValues(node: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(buttonValues)
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  if (record.type === 'callback' && typeof record.value === 'object' && record.value !== null) return [record.value as Record<string, unknown>]
  return Object.values(record).flatMap(buttonValues)
}

function click(messageId: string, value: unknown, userId = 'u_alice'): CardActionEvent {
  return { messageId, chatId: 'oc_p2p', operator: { openId: 'ou_x', userId }, action: { value, tag: 'button' } }
}

describe('MissedMessages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('handles recent missed messages in order and offers older ones on a card', async () => {
    const t = setup({
      lastAliveAt: NOW - 120 * MINUTE,
      welcomed: ['oc_p2p'],
      groups: ['oc_group'],
      routes: [route({ key: 'omt_1', chatId: 'oc_group' })],
      processed: ['om_done'],
      messages: [
        message('om_old', 90),
        message('om_old_group_chatter', 80, { chatId: 'oc_group', chatType: 'group', senderId: 'u_bob', mentionedBot: false }),
        message('om_old_mention', 70, { chatId: 'oc_group', chatType: 'group', senderId: 'u_bob', mentionedBot: true }),
        message('om_topic_reply', 25, { chatId: 'oc_group', chatType: 'group', threadId: 'omt_1' }),
        message('om_recent', 10),
        message('om_done', 5),
      ],
    })
    t.missed.start()
    await t.missed.settled()
    await t.missed.stop()

    expect(t.handled.map(handled => handled.messageId)).toEqual(['om_topic_reply', 'om_recent'])
    // Read from one heartbeat before the stored time.
    expect(t.historyIds).toHaveBeenCalledWith({ type: 'chat', id: 'oc_group', chatType: 'group' }, NOW - 121 * MINUTE, 200)
    expect(t.historyIds).toHaveBeenCalledWith({ type: 'thread', id: 'omt_1', chatType: 'group' }, NOW - 121 * MINUTE, expect.any(Number))
    expect(t.historyIds).toHaveBeenCalledWith({ type: 'chat', id: 'oc_p2p', chatType: 'p2p' }, NOW - 121 * MINUTE, expect.any(Number))

    const cards = t.channel.sent.map(sent => ({ chatId: sent.chatId, text: JSON.stringify(sent.input) }))
    expect(cards).toHaveLength(2)
    expect(cards.find(card => card.chatId === 'oc_p2p')!.text).toContain('离线期间收到 1 条消息')
    const group = cards.find(card => card.chatId === 'oc_group')!.text
    expect(group).toContain('om_old_mention')
    expect(group).not.toContain('om_old_group_chatter')
    expect(t.global.lastAliveAt).toBe(NOW)
  })

  it('only starts the heartbeat when no instance stored a last-alive time', async () => {
    const t = setup({ messages: [message('om_1', 1)], welcomed: ['oc_p2p'] })
    t.missed.start()
    expect(t.global.lastAliveAt).toBe(NOW)
    vi.advanceTimersByTime(MINUTE)
    expect(t.global.lastAliveAt).toBe(NOW + MINUTE)
    await t.missed.stop()
    expect(t.historyIds).not.toHaveBeenCalled()
    expect(t.handled).toHaveLength(0)
  })

  it('never reads further back than the processed retention', async () => {
    const t = setup({ lastAliveAt: NOW - 3 * PROCESSED_RETENTION_MS, welcomed: ['oc_p2p'] })
    t.missed.start()
    await t.missed.settled()
    await t.missed.stop()
    expect(t.historyIds).toHaveBeenCalledWith(expect.anything(), NOW - PROCESSED_RETENTION_MS, 200)
  })

  it('catches up from the connection loss after a reconnect', async () => {
    const t = setup({ welcomed: ['oc_p2p'], messages: [message('om_before', 20), message('om_during', 5)] })
    t.missed.start()
    vi.setSystemTime(NOW - 10 * MINUTE + MINUTE)
    t.missed.onReconnecting()
    vi.advanceTimersByTime(5 * MINUTE)
    // The heartbeat holds still while disconnected.
    expect(t.global.lastAliveAt).toBe(NOW)
    vi.setSystemTime(NOW)
    t.missed.onReconnected()
    await t.missed.settled()
    await t.missed.stop()
    expect(t.historyIds).toHaveBeenCalledWith(expect.anything(), NOW - 10 * MINUTE, 200)
    expect(t.handled.map(handled => handled.messageId)).toEqual(['om_during'])
  })

  it('stores the time of a lost connection when stopped before it came back', async () => {
    const t = setup()
    t.missed.start()
    vi.setSystemTime(NOW + 5 * MINUTE)
    t.missed.onReconnecting()
    vi.setSystemTime(NOW + 9 * MINUTE)
    await t.missed.stop()
    expect(t.global.lastAliveAt).toBe(NOW + 5 * MINUTE)
  })

  it('stops reading at the message budget', async () => {
    const t = setup({
      lastAliveAt: NOW - 20 * MINUTE,
      welcomed: ['oc_p2p', 'oc_p2p_2'],
      config: { maxMessages: 2 },
      messages: [message('om_1', 3), message('om_2', 2), message('om_3', 1), message('om_4', 1, { chatId: 'oc_p2p_2' })],
    })
    t.missed.start()
    await t.missed.settled()
    await t.missed.stop()
    expect(t.handled.map(handled => handled.messageId)).toEqual(['om_1', 'om_2'])
    expect(t.historyIds).toHaveBeenCalledTimes(1)
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('stopped at'), 2)
  })

  it('keeps going when one chat cannot be read', async () => {
    const t = setup({ lastAliveAt: NOW - 20 * MINUTE, welcomed: ['oc_p2p'], groups: ['oc_gone'], messages: [message('om_1', 3)] })
    const read = t.historyIds.getMockImplementation()!
    t.historyIds.mockImplementation(async (container: HistoryContainer, since: number, limit: number) => {
      if (container.id === 'oc_gone') throw new Error('bot not in chat')
      return await read(container, since, limit)
    })
    t.missed.start()
    await t.missed.settled()
    await t.missed.stop()
    expect(t.handled.map(handled => handled.messageId)).toEqual(['om_1'])
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('reading missed messages'), 'chat', 'oc_gone', expect.stringContaining('bot not in chat'))
  })

  it('handles or ignores the offered messages on a sender or administrator click', async () => {
    const t = setup({
      lastAliveAt: NOW - 120 * MINUTE,
      welcomed: ['oc_p2p'],
      messages: [message('om_old_1', 90), message('om_old_2', 80)],
    })
    t.missed.start()
    await t.missed.settled()
    await t.missed.stop()
    const run = buttonValues(t.channel.sent[0]!.input).find(value => value.decision === MISSED_RUN_ACTION)
    expect(parseMissedAction(run)).toEqual({ decision: 'run', batch: { chatId: 'oc_p2p', chatType: 'p2p', messageIds: ['om_old_1', 'om_old_2'], senders: ['u_alice'] } })

    t.missed.start()
    // Someone else's click changes nothing.
    t.missed.onCardAction(click('om_1', run, 'u_mallory'))
    t.missed.onCardAction(click('om_1', run))
    // A second click on the same card is ignored.
    t.missed.onCardAction(click('om_1', run))
    await t.missed.settled()
    await t.missed.stop()
    expect(t.handled.map(handled => handled.messageId)).toEqual(['om_old_1', 'om_old_2'])
    expect(JSON.stringify(t.channel.updated.at(-1))).toContain('已按顺序开始处理')

    t.missed.start()
    t.missed.onCardAction(click('om_2', { ...run, decision: MISSED_IGNORE_ACTION }, 'u_admin'))
    await t.missed.settled()
    await t.missed.stop()
    expect([...t.processed.keys()]).toEqual(['om_old_1', 'om_old_2'])
    expect(JSON.stringify(t.channel.updated.at(-1))).toContain('已忽略')
    expect(t.handled).toHaveLength(2)
  })

  it('does nothing when disabled', async () => {
    const t = setup({ lastAliveAt: NOW - 20 * MINUTE, welcomed: ['oc_p2p'], config: { enabled: false }, messages: [message('om_1', 3)] })
    t.missed.start()
    t.missed.onCardAction(click('om_1', { decision: MISSED_RUN_ACTION, chat: 'oc_p2p', chatType: 'p2p', ids: ['om_1'], senders: ['u_alice'] }))
    await t.missed.stop()
    expect(t.historyIds).not.toHaveBeenCalled()
    expect(t.global.lastAliveAt).toBe(NOW - 20 * MINUTE)
  })
})
