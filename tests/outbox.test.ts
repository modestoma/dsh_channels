/**
 * Outbox tests: immediate attempt, stored retry with backoff, replacement of
 * a stored card patch, drop on gone/expired, reaction progress, restart
 * resume, and health counts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAILING_ATTEMPTS, Outbox } from '../src/outbox.ts'
import type { OutboxEntry, OutboxTable } from '../src/outbox.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'

function memoryTable(): OutboxTable & { rows: Map<string, OutboxEntry> } {
  const rows = new Map<string, OutboxEntry>()
  return {
    rows,
    get: key => rows.get(key),
    put: (key, value) => { rows.set(key, value) },
    delete: key => { rows.delete(key) },
    entries: () => rows.entries(),
  }
}

function fakeChannel() {
  return {
    updateCard: vi.fn(async (_messageId: string, _card: object) => {}),
    addReaction: vi.fn(async (_messageId: string, _emoji: string) => 'r-new'),
    removeReaction: vi.fn(async (_messageId: string, _reactionId: string) => {}),
  }
}

function setup(table: (OutboxTable & { rows: Map<string, OutboxEntry> }) | null = memoryTable()) {
  const channel = fakeChannel()
  const sendSegment = vi.fn(async (_sessionId: string, _segment: number, _card: object, _text: string) => ({}))
  const warn = vi.fn()
  const outbox = new Outbox({
    table: () => table ?? undefined,
    channel: () => channel as unknown as FeishuChannel,
    sendSegment,
    warn,
  })
  return { outbox, table, channel, sendSegment, warn }
}

describe('Outbox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('performs an action at once and stores nothing when it lands', async () => {
    const { outbox, table, channel } = setup()
    outbox.start()
    await outbox.patch('om_1', { v: 1 })
    expect(channel.updateCard).toHaveBeenCalledWith('om_1', { v: 1 })
    expect(table!.rows.size).toBe(0)
  })

  it('stores a failed action and retries it with backoff until it lands', async () => {
    const { outbox, table, channel } = setup()
    outbox.start()
    channel.updateCard.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'))
    await outbox.patch('om_1', { v: 1 })
    expect(table!.rows.get('card:om_1')).toMatchObject({ attempts: 1, nextAt: 1_005_000, lastError: 'timeout' })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(channel.updateCard).toHaveBeenCalledTimes(2)
    expect(table!.rows.get('card:om_1')).toMatchObject({ attempts: 2, nextAt: 1_015_000 })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(channel.updateCard).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(channel.updateCard).toHaveBeenCalledTimes(3)
    expect(table!.rows.size).toBe(0)
  })

  it('replaces a stored card patch with a newer one, so only the newest content lands', async () => {
    const { outbox, table, channel } = setup()
    outbox.start()
    channel.updateCard.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'))
    await outbox.patch('om_1', { v: 1 })
    await outbox.patch('om_1', { v: 2 })
    expect(table!.rows.get('card:om_1')).toMatchObject({ card: { v: 2 }, attempts: 2, createdAt: 1_000_000 })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(channel.updateCard.mock.calls.map(call => call[1])).toEqual([{ v: 1 }, { v: 2 }, { v: 2 }])
    expect(table!.rows.size).toBe(0)
  })

  it('drops an action when Feishu reports the message gone', async () => {
    const { outbox, table, channel, warn } = setup()
    outbox.start()
    channel.updateCard.mockRejectedValue(new FeishuApiError('code=230011 message recalled', 230011))
    await outbox.patch('om_1', { v: 1 })
    expect(table!.rows.size).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped'), 'card', 1, expect.any(String))
  })

  it('drops an action that still fails after 24 hours', async () => {
    const { outbox, table, channel } = setup()
    outbox.start()
    channel.updateCard.mockRejectedValue(new Error('down'))
    await outbox.patch('om_1', { v: 1 })
    // The first retry at or past 24 h drops it; retries run at most 5 min apart.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 300_000)
    expect(table!.rows.size).toBe(0)
    const attempts = channel.updateCard.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(channel.updateCard).toHaveBeenCalledTimes(attempts)
  })

  it('attempts once and stores nothing while the table is closed', async () => {
    const { outbox, channel, warn } = setup(null)
    channel.updateCard.mockRejectedValue(new Error('down'))
    await outbox.patch('om_1', { v: 1 })
    expect(channel.updateCard).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped'), 'card', 1, 'down')
  })

  it('keeps a completed reaction removal and retries only the add', async () => {
    const { outbox, table, channel } = setup()
    outbox.start()
    channel.addReaction.mockRejectedValueOnce(new Error('timeout'))
    await outbox.reaction('om_t', 'r-typing', 'DONE')
    expect(table!.rows.get('reaction:om_t')).not.toHaveProperty('removeReactionId')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(channel.removeReaction).toHaveBeenCalledTimes(1)
    expect(channel.addReaction).toHaveBeenCalledTimes(2)
    expect(table!.rows.size).toBe(0)
  })

  it('sends a failed segment through the segment sender', async () => {
    const { outbox, table, sendSegment } = setup()
    outbox.start()
    sendSegment.mockRejectedValueOnce(new Error('timeout'))
    await outbox.segment('sess-1', 2, { v: 1 }, 'body')
    expect(table!.rows.size).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendSegment).toHaveBeenLastCalledWith('sess-1', 2, { v: 1 }, 'body')
    expect(table!.rows.size).toBe(0)
  })

  it('resumes stored actions on start and keeps them across stop', async () => {
    const table = memoryTable()
    table.rows.set('card:om_1', { kind: 'card', key: 'card:om_1', messageId: 'om_1', card: { v: 1 }, createdAt: 999_000, attempts: 2, nextAt: 2_000_000 })
    const { outbox, channel } = setup(table)
    outbox.start()
    expect(channel.updateCard).not.toHaveBeenCalled()
    await outbox.stop()
    await vi.advanceTimersByTimeAsync(2_000_000)
    expect(channel.updateCard).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(1)

    table.rows.set('card:om_1', { ...table.rows.get('card:om_1')!, nextAt: 0 })
    outbox.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.updateCard).toHaveBeenCalledWith('om_1', { v: 1 })
    expect(table.rows.size).toBe(0)
  })

  it('stop waits for an attempt in flight', async () => {
    const { outbox, channel } = setup()
    outbox.start()
    let release: () => void = () => {}
    channel.updateCard.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    void outbox.patch('om_1', { v: 1 })
    let stopped = false
    const stopping = outbox.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
  })

  it('counts pending and failing actions for health', async () => {
    const { outbox, channel } = setup()
    outbox.start()
    channel.updateCard.mockRejectedValue(new Error('down'))
    await outbox.patch('om_1', { v: 1 })
    await outbox.patch('om_2', { v: 1 })
    expect(outbox.health()).toEqual({ pending: 2, failing: 0 })
    await vi.advanceTimersByTimeAsync(5_000 + 10_000)
    expect(outbox.health()).toEqual({ pending: 2, failing: 2 })
    expect(FAILING_ATTEMPTS).toBe(3)
  })
})
