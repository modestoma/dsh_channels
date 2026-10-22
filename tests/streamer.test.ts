/**
 * TurnStreamer tests: chunk folding, 500 ms throttle, finalization and the
 * Typing → DONE/No reaction swap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStreamer } from '../src/streamer.ts'
import type { MessageId, Session, SessionEvent, SessionId, UserMessage } from '../src/dsh-types.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import { makeSession, sessionEvents } from './helpers.ts'

function channel(): FeishuChannel & { updated: Array<{ messageId: string; card: object }> } {
  const updated: Array<{ messageId: string; card: object }> = []
  return {
    onMessage: vi.fn(() => () => {}),
    onCardAction: vi.fn(() => () => {}),
    onBotAdded: vi.fn(() => () => {}),
    getChatInfo: vi.fn(async () => ({ chatId: 'oc_chat', chatType: 'group' as const })),
    botOpenId: () => 'bot',
    getConnectionStatus: vi.fn(() => ({ state: 'connected' as const, reconnectAttempts: 0 })),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: 'om_1' })),
    replyMedia: vi.fn(async () => ({ messageId: 'om_1' })),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card })
    }),
    addReaction: vi.fn(async () => 'react-1'),
    removeReaction: vi.fn(async () => {}),
    threadIdOfMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => (async function* (): AsyncGenerator<Uint8Array> {})()),
    updated,
  }
}

function hooks() {
  return {
    measureContext: () => ({ contextTokens: 1000, contextWindow: 64000 }),
    sessionLabel: (id: string) => id,
    onError: vi.fn(),
    onTurnFinalized: vi.fn(),
    onSegmentDelivered: vi.fn(),
    sendSegmentCard: vi.fn(async (
      _sessionId: string,
      segment: number,
      _card: object,
      _fallbackText: string,
    ) => ({ messageId: `om_seg_${segment}`, mode: 'card' as const })),
  }
}

function markdownOf(card: object, index: number): string {
  const elements = (card as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements
  return elements.filter(element => element.tag === 'markdown')[index]?.content ?? ''
}

describe('TurnStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes the first frame immediately, then throttles to refreshMs', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-stream')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    // First mark: patch fires after the 500 ms throttle.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } })
    expect(ch.updated.length).toBe(0)

    await vi.advanceTimersByTimeAsync(499)
    expect(ch.updated.length).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(ch.updated.length).toBe(1)
    expect(markdownOf(ch.updated[0]!.card, 0)).toContain('你好')

    // Subsequent deltas in the same window coalesce into one patch.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(ch.updated.length).toBe(2)
    expect(markdownOf(ch.updated[1]!.card, 0)).toContain('你好，世界')
  })

  it('collects reasoning deltas into the fold panel and flips the title on first text', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-reason')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先想想' } })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 1, text: '答' } })
    await vi.advanceTimersByTimeAsync(500)

    const card = ch.updated[0]!.card as {
      body: { elements: [{
        tag: string
        header: { title: { content: string } }
        elements: Array<{ content: string }>
      }, { tag: string }] }
    }
    const panel = card.body.elements[0]
    expect(panel?.header.title.content).toBe('回复中')
    expect(panel?.elements[0]?.content).toContain('先想想')
  })

  it('finalizes on turn/end: settled card, final patch, and Typing→DONE swap', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-done')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onSessionEvent(session, {
      type: 'step/start', seq: 1, data: { turn: 1, step: 1 },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '完整回答' } })
    streamer.onSessionEvent(session, {
      type: 'assistant/message', seq: 3,
      data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 5 } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stop' } })

    // turn/end finalizes immediately without waiting for the throttle.
    const finalized = ch.updated.at(-1)!
    const elements = (finalized.card as {
      body: { elements: Array<{ tag: string; content?: string; text_size?: string }> }
    }).body.elements
    // No reasoning in this turn: no empty panel — body, divider and the two
    // settled footer lines.
    expect(elements.map(element => element.tag)).toEqual(['markdown', 'hr', 'markdown', 'markdown'])
    expect(elements[0]?.content).toContain('完整回答')
    expect(elements[2]?.text_size).toBe('notation')
    expect(elements[2]?.content).toContain('模型')
    expect(elements[2]?.content).toContain('推理 —')
    expect(elements[3]?.content).toContain('上下文')

    await vi.advanceTimersByTimeAsync(0)
    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('om_trigger', 'react-typing')
      expect(add).toHaveBeenCalledWith('om_trigger', 'DONE')
    })
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-done', 1, 'om_card')
  })

  it('skips removal when the Typing reaction was never added, still adds DONE', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-noreact')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })

    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(add).toHaveBeenCalledWith('om_trigger', 'DONE')
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it('renders a structured turn failure, isolates prior-turn effort, and swaps Typing→No', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-failed')
    // The preceding turn succeeded with high. The new turn fails before it can
    // emit request/header or usage, so none of these samples belong to it.
    ;(sessionEvents(session) as SessionEvent[]).push(
      {
        type: 'request/header',
        seq: 1,
        data: { header: { config: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash-vision-exp',
          reasoningEffort: 'high',
        } } },
      },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          turn: 1,
          step: 1,
          message: {},
          usage: { inputTokens: 91, outputTokens: 89, cacheReadTokens: 20 },
        },
      },
    )
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onSessionEvent(session, {
      type: 'turn/end',
      seq: 3,
      data: {
        turn: 2,
        reason: {
          kind: 'error',
          error: {
            message: 'provider "deepseek-official" model "deepseek-v4-flash-vision-exp" does not support reasoning effort "tiny"',
            code: 'UNSUPPORTED_REASONING_EFFORT',
          },
        },
      },
    })

    const finalized = ch.updated.at(-1)!.card as {
      body: { elements: Array<{ tag: string; content?: string; header?: { title: { content: string } } }> }
    }
    // The failure diagnostic renders once, in the body — the old duplicate
    // status line is gone, and no empty panel is left behind.
    const list = finalized.body.elements
    expect(list.map(element => element.tag)).toEqual(['markdown', 'hr', 'markdown', 'markdown'])
    expect(list[0]?.content).toContain('本轮运行失败')
    const rendered = JSON.stringify(finalized)
    expect(rendered.match(/本轮运行失败/g)).toHaveLength(1)
    expect(rendered).toContain('UNSUPPORTED_REASONING_EFFORT')
    expect(rendered).toContain('does not support reasoning effort')
    expect(rendered).toContain('模型 —')
    expect(rendered).toContain('缓存命中 —')
    expect(rendered).not.toContain('(high)')

    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('om_trigger', 'react-typing')
      expect(add).toHaveBeenCalledWith('om_trigger', 'No')
    })
    expect(add).not.toHaveBeenCalledWith('om_trigger', 'DONE')
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-failed', 2, 'om_card')
  })

  it('keeps session-cumulative token figures across turns', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-cum')
    // Historical usage already in the log before attach.
    ;(sessionEvents(session) as SessionEvent[]).push(
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 40 } } },
    )
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'assistant/message', seq: 2,
      data: { turn: 2, step: 1, message: {}, usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 45 } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 3, data: { turn: 2, reason: 'stop' } })

    const card = ch.updated.at(-1)!.card as { body: { elements: Array<{ content?: string }> } }
    // body, hr, model/session/reasoning line, usage line.
    const usageLine = card.body.elements[3]?.content ?? ''
    expect(usageLine).toContain('输入 130')
    expect(usageLine).toContain('输出 50')
    expect(usageLine).toContain('缓存命中 60.0%')
  })

  it('reports the accumulated reasoning time on the settled footer', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-reason-time')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // First reasoning phase: 3.0 s between the first reasoning delta and the
    // answer text.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })
    await vi.advanceTimersByTimeAsync(3_000)
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: '答' } })

    // Second step: another 2.0 s of reasoning, accumulated across phases.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 1, turn: 1, step: 2 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 3, chunk: { type: 'reasoning-delta', index: 0, text: '再想' } })
    await vi.advanceTimersByTimeAsync(2_000)
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 4, chunk: { type: 'text-delta', index: 0, text: '再答' } })
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a2', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 },
    })

    // Third step reasons for 4.0 s and ends in a tool call (no answer text):
    // the 30 s tool run afterwards must not count as reasoning time.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a3', revision: 1, turn: 1, step: 3 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a3', revision: 1, index: 0, time: 5, chunk: { type: 'reasoning-delta', index: 0, text: '还要查' } })
    await vi.advanceTimersByTimeAsync(4_000)
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a3', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 },
    })
    await vi.advanceTimersByTimeAsync(30_000)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a4', revision: 1, turn: 1, step: 4 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a4', revision: 1, index: 0, time: 7, chunk: { type: 'text-delta', index: 0, text: '最终答' } })

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    const json = JSON.stringify(ch.updated.at(-1)!.card)
    expect(json).toContain('会话 sess-reason-time')
    // 3.0 + 2.0 + 4.0 s of reasoning; the 30 s tool run is not counted.
    expect(json).toContain('推理 9.0s')
  })

  it('splits an oversized body into continuation segment cards, losing nothing', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-seg')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const huge = 'x'.repeat(30_000)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: huge } })

    // First flush: split + continuation send issued.
    await vi.advanceTimersByTimeAsync(500)
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    expect(sendSegment).toHaveBeenCalledTimes(1)
    expect(sendSegment.mock.calls[0]?.[1]).toBe(2)

    // Send resolves → the new card is patched; turn/end finalizes everything.
    await vi.advanceTimersByTimeAsync(500)
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    const headCard = ch.updated.filter(update => update.messageId === 'om_card').at(-1)
    const segCard = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)
    expect(headCard).toBeDefined()
    expect(segCard).toBeDefined()
    const headBody = markdownOf(headCard!.card, 0)
    const segBody = markdownOf(segCard!.card, 1)
    expect(headBody + segBody).toBe(huge)
  })

  it('finalizes continuation cards without repeating the main card footer', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-seg-done')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    const segCard = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)
    expect(segCard).toBeDefined()
    // The continuation card is just its segment header (no phase, no footer).
    const header = markdownOf(segCard!.card, 0)
    expect(header).toBe('📄 回复分段 2')
    expect(JSON.stringify(segCard!.card)).not.toContain('会话 sess-seg-done')

    // The main card carries the settled footer exactly once.
    const headCard = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
    expect(JSON.stringify(headCard)).toContain('会话 sess-seg-done')
  })

  it('splits a multi-table body into table-capped segments without losing content', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-tables')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const table = (n: number) => `| 列${n} | 值 |\n| --- | --- |\n| 行 | ${n} |`
    const tables = Array.from({ length: 7 }, (_, i) => table(i + 1)).join('\n\n')
    const body = `开头\n\n${tables}\n\n结尾`
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: body } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    // Final patch per message id, in first-seen order.
    const byId = new Map<string, object>()
    for (const update of ch.updated) {
      byId.set(update.messageId, update.card)
    }
    const bodies = [...byId.entries()].map(([messageId, card]) =>
      markdownOf(card, messageId === 'om_card' ? 0 : 1),
    )

    // Nothing lost (modulo blank-line separators at the cuts).
    const flat = (text: string) => text.replace(/\s+/g, '')
    expect(flat(bodies.join(''))).toBe(flat(body))
    // Every card carries at most 5 tables (3 pipe lines each).
    for (const content of bodies) {
      const pipeLines = (content.match(/^\s*\|[^\n]*\|/gm) ?? []).length
      expect(pipeLines).toBeLessThanOrEqual(15)
    }
  })

  it('reports segment deliveries to the hooks with the main card id', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-segdelivery')
    streamer.attach(session, 'om_main', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => {
      expect(hooksInstance.onSegmentDelivered).toHaveBeenCalledWith('om_main', 1, 'om_seg_2', 'card')
    })
  })

  it('stops streaming into a text-fallback segment and continues in a new one', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    sendSegment.mockResolvedValueOnce({ messageId: 'om_text', mode: 'text' })

    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-textmode')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)

    // One segment delivered as plain text (fallback).
    expect(sendSegment).toHaveBeenCalledTimes(1)
    expect(sendSegment.mock.calls[0]?.[3]).toContain('xxxx')
    // The text-mode card is never patched via updateCard.
    expect(ch.updated.some(update => update.messageId === 'om_text')).toBe(false)

    // More text arrives after the text-fallback delivery: it must NOT be lost
    // (it flows into a fresh segment card, never into the finished text one).
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '后续内容' } })
    await vi.advanceTimersByTimeAsync(500)

    // The follow-up content triggered its own segment send (card attempt).
    expect(sendSegment).toHaveBeenCalledTimes(2)
    expect(sendSegment.mock.calls[1]?.[1]).toBe(3)
  })

  it('throttles failed card updates with exponential backoff instead of per-flush spam', async () => {
    const ch = channel()
    ch.updateCard = vi.fn(async () => {
      throw new Error('card rejected')
    })
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-backoff')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Stream deltas for ~10 s; the rejected card must be retried at most a
    // handful of times (backoff), never once per flush.
    for (let i = 0; i < 20; i++) {
      streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: `行${i}\n` } })
      await vi.advanceTimersByTimeAsync(500)
    }
    const attempts = (ch.updateCard as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(attempts).toBeLessThanOrEqual(6)
    const onError = hooksInstance.onError as unknown as ReturnType<typeof vi.fn>
    expect(onError.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('gives up after retries when segment delivery keeps failing', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    sendSegment.mockRejectedValue(new Error('both card and text failed'))

    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-sendfail')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)
    // Retry backoffs: 1s + 2s.
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(sendSegment).toHaveBeenCalledTimes(3)
    const onError = hooksInstance.onError as unknown as ReturnType<typeof vi.fn>
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('TurnStreamer activity status + keep-alive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function markdownLines(card: object): string[] {
    const elements = (card as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements
    return elements.filter(element => element.tag === 'markdown').map(element => element.content ?? '')
  }

  function headCard(ch: ReturnType<typeof channel>): object {
    return ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
  }

  it('shows a tool call on the tool line and clears it on tool/result', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-tool')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    // Only the tool line renders (no status): the heartbeat fallback stays
    // hidden while a tool call already shows liveness.
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🔧 调用工具：bash')
    expect(markdownLines(headCard(ch)).join('\n')).toContain('已运行')
    expect(markdownLines(headCard(ch))).not.toContain('⏳ 处理中')

    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 2,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'ok' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('调用工具')
  })

  it('replaces the tool line with the approval wait while a card is undecided', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-approval-wait')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    streamer.setAwaitingApproval('sess-approval-wait', ['bash'])
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('⏳ 等待你审批：bash')
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('调用工具')

    streamer.setAwaitingApproval('sess-approval-wait', [])
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('等待你审批')
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🔧 调用工具：bash')
  })

  it('shows the activity lines only on the card that is still streaming', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-active-card')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Overflow the first card so a continuation card becomes the active one.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)

    // The live tool line belongs to the active card only; the frozen main card
    // must not repeat a stale "调用工具" line.
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 3,
      data: { turn: 1, step: 2, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    await vi.advanceTimersByTimeAsync(500)

    const head = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
    const active = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)!.card
    expect(JSON.stringify(head)).not.toContain('调用工具')
    expect(JSON.stringify(active)).toContain('调用工具')
  })

  it('labels the subagent tool with its description argument', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-subagent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: {
        turn: 1, step: 1, callId: 'call-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检索实现方案', prompt: '去查资料', run_in_background: false }),
      },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🤖 调用子代理：检索实现方案')

    // Unparseable arguments fall back to the bare tool name.
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 2,
      data: { turn: 1, step: 1, callId: 'call-2', name: 'subagent', arguments: '{broken' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🤖 调用子代理：subagent')
  })

  it('keeps the workflow end status while a later tool call runs (two independent lines)', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-end-tool')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-start', seq: 1, data: { runId: 'run-1', name: 'audit' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-start', seq: 2,
      data: { runId: 'run-1', seq: 1, label: '检索代码', childId: 'child-1' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-end', seq: 3, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-end', seq: 4, data: { runId: 'run-1', stopReason: 'completed' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 5,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'done' } },
    })
    // The model follows up with a plain tool call — it must NOT supersede
    // the settled workflow status: both lines render together.
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 6,
      data: { turn: 1, step: 2, callId: 'call-2', name: 'bash', arguments: '{"command":"git log"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('🧵 工作流 audit 结束（完成）')
    expect(markdownLines(headCard(ch))[1]).toContain('🔧 调用工具：bash')

    // Tool settles, text starts: the workflow end status persists.
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 7,
      data: { turn: 1, step: 2, message: { type: 'text', text: 'ok' } },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 2 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '结论' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('工作流 audit 结束（完成）')
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('调用工具')

    // The settled card keeps the workflow conclusion; only the tool line
    // disappears.
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)
    const finalCard = headCard(ch)
    expect(markdownLines(finalCard)[0]).toContain('🧵 工作流 audit 结束（完成）')
    expect(markdownLines(finalCard).join('\n')).not.toContain('调用工具')
    // Settled main card: status line, body, divider and the two footer lines.
    const elements = (finalCard as { body: { elements: unknown[] } }).body.elements
    expect(elements.length).toBe(5)
  })

  it('folds tool-workflow run events into a progress line with member counts', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-workflow')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-start', seq: 1, data: { runId: 'run-1', name: 'audit' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('🧵 工作流 audit')
    expect(markdownLines(headCard(ch))[0]).toContain('0/0 子代理完成')

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-start', seq: 2,
      data: { runId: 'run-1', seq: 1, label: '检索代码', phase: '审查', childId: 'child-1' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const running = markdownLines(headCard(ch))[0]!
    expect(running).toContain('0/1 子代理完成')
    expect(running).toContain('阶段 审查')
    expect(running).toContain('检索代码')

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-end', seq: 3, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('1/1 子代理完成')

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-end', seq: 4, data: { runId: 'run-1', stopReason: 'completed' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('🧵 工作流 audit 结束（完成）')

    // The workflow tool's own tool/result must NOT erase the settled status.
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 5,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'done' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('工作流 audit 结束（完成）')
  })

  it('heartbeats a silent turn: elapsed counter appears and ticks every statusRefreshMs', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks(), 5_000)
    const session = makeSession('sess-heartbeat')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // No events at all: the slow heartbeat is what first patches the card.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('⏳ 处理中 · 已运行 5s')

    // Still no events; the elapsed counter keeps ticking.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('⏳ 处理中 · 已运行 10s')
  })

  it('drops the heartbeat line once text arrives and finalizes without activity', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks(), 5_000)
    const session = makeSession('sess-heartbeat-done')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[0]).toContain('⏳ 处理中')

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)

    const finalCard = headCard(ch)
    expect(markdownLines(finalCard).join('\n')).not.toContain('处理中')
    // The settled card without activity: body, divider and the two footer lines.
    const elements = (finalCard as { body: { elements: unknown[] } }).body.elements
    expect(elements.length).toBe(4)
  })
})

describe('TurnStreamer subagent child folding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeChildSession(id: string, parentId: string): Session {
    return {
      id: id as SessionId,
      header: {
        version: 0,
        id: id as SessionId,
        createdAt: Date.now(),
        parentSession: parentId as SessionId,
        origin: 'subagent',
        delegationDepth: 1,
      },
      events: [],
      firstLiveSeq: 0,
      snapshotEvents: () => [],
    } as unknown as Session
  }

  function markdownLines(card: object): string[] {
    const elements = (card as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements
    return elements.filter(element => element.tag === 'markdown').map(element => element.content ?? '')
  }

  function headCard(ch: ReturnType<typeof channel>): object {
    return ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
  }

  function activity(ch: ReturnType<typeof channel>): string {
    return markdownLines(headCard(ch))[0]!
  }

  it('folds a child subagent\'s descriptor and tool calls into the parent card (status only)', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-parent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // The parent model called the subagent tool (label from description arg).
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: {
        turn: 1, step: 1, callId: 'call-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检索实现方案', prompt: '…' }),
      },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🤖 调用子代理：检索实现方案')

    // The child session publishes its descriptor, then starts working.
    const child = makeChildSession('child-1', 'sess-parent')
    streamer.onSessionEvent(child, {
      type: 'subagent/descriptor', seq: 1,
      data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '检索实现方案' },
    })
    streamer.onSessionEvent(child, {
      type: 'tool/call', seq: 2,
      data: { turn: 1, step: 1, callId: 'c-call-1', name: 'read', arguments: '{"path":"src"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).toContain('🤖 子代理执行中：检索实现方案 (read)')

    // The child's tool result drops the tool suffix; its turn/end removes it
    // from the fold, falling back to the parent's own subagent tool line.
    streamer.onSessionEvent(child, {
      type: 'tool/result', seq: 3,
      data: { turn: 1, step: 1, message: { type: 'text', text: '…' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).toContain('🤖 子代理执行中：检索实现方案')
    expect(activity(ch)).not.toContain('(read)')

    streamer.onSessionEvent(child, { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).not.toContain('子代理执行中')
    // Parent's tool line remains until its own tool/result.
    expect(markdownLines(headCard(ch)).join('\n')).toContain('调用子代理：检索实现方案')
  })

  it('summarizes finished subagents on the settled card (tool line disappears)', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-settled-sub')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: {
        turn: 1, step: 1, callId: 'call-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检索实现方案', prompt: '…' }),
      },
    })
    const child = makeChildSession('child-1', 'sess-settled-sub')
    streamer.onSessionEvent(child, {
      type: 'subagent/descriptor', seq: 1,
      data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '检索实现方案' },
    })
    streamer.onSessionEvent(child, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 3,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'done' } },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 2 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    const finalCard = headCard(ch)
    const lines = markdownLines(finalCard)
    expect(lines[0]).toContain('🤖 子代理完成：检索实现方案')
    expect(lines.join('\n')).not.toContain('调用子代理')
    expect(lines.join('\n')).not.toContain('子代理执行中')
  })

  it('counts parallel children and defaults the label to 子代理 before the descriptor', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-multi')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const childA = makeChildSession('child-a', 'sess-multi')
    streamer.onSessionEvent(childA, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'a-1', name: 'bash', arguments: '{}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    // Descriptor not seen yet → placeholder label.
    expect(activity(ch)).toContain('🤖 子代理执行中：子代理 (bash)')

    const childB = makeChildSession('child-b', 'sess-multi')
    streamer.onSessionEvent(childB, {
      type: 'subagent/descriptor', seq: 1,
      data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '代码审查' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const line = activity(ch)
    expect(line).toContain('🤖 2 个子代理执行中')
    expect(line).toContain('子代理 (bash)')
    expect(line).toContain('代码审查')
  })

  it('ignores workflow member children (the workflow line already aggregates them)', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-wf-member')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-start', seq: 1, data: { runId: 'run-1', name: 'audit' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-start', seq: 2,
      data: { runId: 'run-1', seq: 1, label: '检索代码', childId: 'wf-child-1' },
    })
    const member = makeChildSession('wf-child-1', 'sess-wf-member')
    streamer.onSessionEvent(member, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'w-1', name: 'grep', arguments: '{}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    // While the run is live the workflow line has priority anyway; settle the
    // run and check the member never leaked into the generic children fold.
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-end', seq: 3, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-end', seq: 4, data: { runId: 'run-1', stopReason: 'completed' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const line = activity(ch)
    expect(line).toContain('工作流 audit 结束（完成）')
    expect(line).not.toContain('(grep)')
    expect(line).not.toContain('子代理执行中')
  })

  it('ignores child sessions whose parent has no active turn', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-orphan-parent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Seed one patch so the card state is observable.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).toContain('⏳ 处理中')

    // A child of some other session: must neither crash nor touch this card.
    const foreign = makeChildSession('child-x', 'unknown-session')
    streamer.onSessionEvent(foreign, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'x-1', name: 'bash', arguments: '{}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).not.toContain('子代理')
  })
})

describe('TurnStreamer live assistant frames', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('streams text and reasoning deltas from agent/assistant-stream frames', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-live')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '你好' },
    })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '先想想' },
    })
    await vi.advanceTimersByTimeAsync(500)

    expect(ch.updated.length).toBe(1)
    expect(markdownOf(ch.updated[0]!.card, 0)).toContain('你好')
    const card = ch.updated[0]!.card as {
      body: { elements: [{ header: { title: { content: string } }; elements: Array<{ content: string }> }] }
    }
    expect(card.body.elements[0].header.title.content).toBe('回复中')
    expect(card.body.elements[0].elements[0]?.content).toContain('先想想')
  })

  it('rolls back an abandoned attempt and keeps a committed one', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-rollback')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Attempt 1 streams text, then abandons (retry / stream error): none of it
    // is model-visible history, so the card must drop it again.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '坏答案' },
    })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '坏推理' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownOf(ch.updated.at(-1)!.card, 0)).toContain('坏答案')

    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a1', revision: 1, index: 2, outcome: { kind: 'abandoned' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const rolledBack = ch.updated.at(-1)!.card as {
      body: { elements: [{ elements: Array<{ content: string }> }, { content: string }] }
    }
    expect(JSON.stringify(rolledBack)).not.toContain('坏答案')
    expect(JSON.stringify(rolledBack)).not.toContain('坏推理')

    // Attempt 2 commits: its text stays.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 2, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 3,
      chunk: { type: 'text-delta', index: 0, text: '好答案' },
    })
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a2', revision: 2, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownOf(ch.updated.at(-1)!.card, 0)).toContain('好答案')
  })

  it('prefers host projection figures for tokens, cache and window', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, {
      ...hooksInstance,
      projectStats: () => ({ inputTokens: 111, outputTokens: 22, cacheHitPct: 0.5, contextWindow: 64_000 }),
    })
    const session = makeSession('sess-projected')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'request/header', seq: 1,
      data: { header: { config: { provider: 'p', model: 'm' } } },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    })
    await vi.advanceTimersByTimeAsync(500)

    // Figures live on the settled card's footer (not on live frames).
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)
    const json = JSON.stringify(ch.updated.at(-1)!.card)
    expect(json).toContain('输入 111')
    expect(json).toContain('输出 22')
    expect(json).toContain('64,000')
  })
})

describe('TurnStreamer stop button', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function buttonsOf(card: object): Array<{ text: { content: string }; disabled?: boolean }> {
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements
    return elements.filter(element => element.tag === 'button') as never
  }

  function streamText(streamer: TurnStreamer, session: Session, text: string): void {
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text } })
  }

  it('shows the button on the streaming card, then drops it when the turn settles', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-live')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, '进行中')
    await vi.advanceTimersByTimeAsync(500)
    expect(buttonsOf(ch.updated.at(-1)!.card).map(button => button.text.content)).toEqual(['⏹ 停止'])
    expect(streamer.stopTargetOf('om_card')).toBe('sess-stop-live')
    expect(streamer.stopTargetOf('om_other')).toBeUndefined()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(buttonsOf(ch.updated.at(-1)!.card)).toHaveLength(0)
    expect(JSON.stringify(ch.updated.at(-1)!.card)).not.toContain('已按请求停止')
    expect(streamer.stopTargetOf('om_card')).toBeUndefined()
  })

  it('moves the button to the newest segment card', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-seg')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, 'x'.repeat(30_000))
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    const main = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!
    const segment = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)!
    expect(buttonsOf(main.card)).toHaveLength(0)
    expect(buttonsOf(segment.card)).toHaveLength(1)
    expect(streamer.stopTargetOf('om_seg_2')).toBe('sess-stop-seg')
  })

  it('renders stopping and denied states, and settles an aborted turn as stopped', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-abort')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, '进行中')
    await vi.advanceTimersByTimeAsync(500)
    const patches = ch.updated.length

    streamer.markStopDenied('sess-stop-abort')
    streamer.markStopDenied('sess-stop-abort')
    await vi.advanceTimersByTimeAsync(500)
    expect(ch.updated).toHaveLength(patches + 1)
    expect(JSON.stringify(ch.updated.at(-1)!.card)).toContain('仅发起该会话的用户可停止')

    streamer.markStopping('sess-stop-abort')
    await vi.advanceTimersByTimeAsync(500)
    const [button] = buttonsOf(ch.updated.at(-1)!.card)
    expect(button?.text.content).toBe('正在停止…')
    expect(button?.disabled).toBe(true)

    streamer.onSessionEvent(session, {
      type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    const settled = JSON.stringify(ch.updated.at(-1)!.card)
    expect(settled).toContain('⏹ 已按请求停止本轮回复')
    expect(settled).not.toContain('正在停止')
    // Marks on a session without a live turn are no-ops.
    streamer.markStopping('sess-stop-abort')
    streamer.markStopping('sess-unknown')
  })

  it('offers the button only on the active turn, and moves it to the next queued turn', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-queue')
    streamer.attach(session, 'om_first', 'om_t1', undefined)
    streamer.attach(session, 'om_second', 'om_t2', undefined)
    await vi.advanceTimersByTimeAsync(500)
    const latest = (id: string) => ch.updated.filter(update => update.messageId === id).at(-1)
    expect(buttonsOf(latest('om_first')!.card)).toHaveLength(1)
    expect(latest('om_second')).toBeUndefined()
    expect(streamer.stopTargetOf('om_second')).toBeUndefined()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(500)
    expect(buttonsOf(latest('om_second')!.card)).toHaveLength(1)
    expect(streamer.stopTargetOf('om_second')).toBe('sess-stop-queue')
  })

  it('settles a cancellation it did not request as a normal end', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-parent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, '进行中')
    streamer.onSessionEvent(session, {
      type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } },
    })
    const settled = JSON.stringify(ch.updated.at(-1)!.card)
    expect(settled).not.toContain('已按请求停止')
    expect(buttonsOf(ch.updated.at(-1)!.card)).toHaveLength(0)
  })
})

describe('TurnStreamer queued turns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function prompt(id: string): UserMessage {
    return { id: id as MessageId, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } }
  }

  function queued(ch: ReturnType<typeof channel>, sessionId: string) {
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession(sessionId)
    streamer.attach(session, 'om_first', 'om_t1', 'react-1', { message: prompt('m1') })
    streamer.attach(session, 'om_second', 'om_t2', 'react-2', { message: prompt('m2') })
    return { streamer, session }
  }

  it('resolves only queued cards that carry their prompt', () => {
    const ch = channel()
    const { streamer, session } = queued(ch, 'sess-q')
    streamer.attach(session, 'om_bare', 'om_t3', undefined)
    expect(streamer.hasLiveTurn('sess-q')).toBe(true)
    expect(streamer.hasLiveTurn('sess-other')).toBe(false)
    expect(streamer.steerTargetOf('om_first')).toBeUndefined()
    expect(streamer.steerTargetOf('om_second')).toEqual({ sessionId: 'sess-q', message: prompt('m2') })
    expect(streamer.steerTargetOf('om_bare')).toBeUndefined()
  })

  it('merges a queued turn into the running one and settles both reactions together', async () => {
    const ch = channel()
    const { streamer, session } = queued(ch, 'sess-merge')
    const steer = vi.fn(() => true)
    expect(streamer.mergeQueued('om_second', steer)).toBe(true)
    expect(steer).toHaveBeenCalledWith('sess-merge', prompt('m2'))
    expect(JSON.stringify(ch.updated.find(update => update.messageId === 'om_second')!.card)).toContain('已补充到当前回复')
    expect(streamer.steerTargetOf('om_second')).toBeUndefined()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(500)
    expect(mockCalls(ch.removeReaction)).toEqual([['om_t1', 'react-1'], ['om_t2', 'react-2']])
    expect(mockCalls(ch.addReaction)).toEqual([['om_t1', 'DONE'], ['om_t2', 'DONE']])
    // The merged card never streams again and leaves no live turn behind.
    expect(ch.updated.filter(update => update.messageId === 'om_second')).toHaveLength(1)
    expect(streamer.hasLiveTurn('sess-merge')).toBe(false)
  })

  it('retries the merged card patch after a transient failure', async () => {
    const ch = channel()
    const errors = hooks()
    const streamer = new TurnStreamer(ch, 500, errors)
    const session = makeSession('sess-merge-retry')
    streamer.attach(session, 'om_first', 'om_t1', undefined, { message: prompt('m1') })
    streamer.attach(session, 'om_second', 'om_t2', undefined, { message: prompt('m2') })
    mockFn(ch.updateCard).mockRejectedValueOnce(new Error('transient'))
    expect(streamer.mergeQueued('om_second', () => true)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(JSON.stringify(ch.updated.find(update => update.messageId === 'om_second')!.card)).toContain('已补充到当前回复')
    expect(errors.onError).not.toHaveBeenCalled()

    streamer.attach(session, 'om_third', 'om_t3', undefined, { message: prompt('m3') })
    mockFn(ch.updateCard).mockRejectedValue(new Error('down'))
    expect(streamer.mergeQueued('om_third', () => true)).toBe(true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(errors.onError).toHaveBeenCalledTimes(1)
  })

  it('refuses to merge while stopping, when the prompt was already claimed, or for unknown cards', () => {
    const ch = channel()
    const { streamer } = queued(ch, 'sess-refuse')
    expect(streamer.mergeQueued('om_second', () => false)).toBe(false)
    expect(streamer.mergeQueued('om_unknown', () => true)).toBe(false)
    streamer.markStopping('sess-refuse')
    const steer = vi.fn(() => true)
    expect(streamer.mergeQueued('om_second', steer)).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    expect(streamer.steerTargetOf('om_second')).toBeDefined()
  })

  it('renders the queued layout until the turn becomes the front', async () => {
    const ch = channel()
    const { streamer, session } = queued(ch, 'sess-layout')
    streamer.markQueuedDenied('om_second')
    streamer.markQueuedDenied('om_second')
    streamer.markQueuedDenied('om_first')
    await vi.advanceTimersByTimeAsync(500)
    const second = ch.updated.filter(update => update.messageId === 'om_second')
    expect(second).toHaveLength(1)
    expect(JSON.stringify(second[0]!.card)).toContain('仅发起该会话的用户可补充')

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(500)
    const active = JSON.stringify(ch.updated.filter(update => update.messageId === 'om_second').at(-1)!.card)
    expect(active).not.toContain('排队中')
    expect(active).toContain('⏹ 停止')
  })
})

function mockCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls
}

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>
}
