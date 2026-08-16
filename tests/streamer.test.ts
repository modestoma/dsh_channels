/**
 * TurnStreamer tests: chunk folding, 500 ms throttle, finalization and the
 * Typing → DONE reaction swap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStreamer } from '../src/streamer.ts'
import type { Session, SessionEvent, SessionId } from '../src/dsh-types.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import { makeSession } from './helpers.ts'

function chunkEvent(sessionId: SessionId, type: SessionEvent['type'], data: SessionEvent['data'], seq = 1): { session: Session; event: SessionEvent } {
  const session = makeSession(sessionId)
  return { session, event: { type, data, seq } as SessionEvent }
}

function channel(): FeishuChannel & { updated: Array<{ messageId: string; card: object }> } {
  const updated: Array<{ messageId: string; card: object }> = []
  return {
    onMessage: vi.fn(() => () => {}),
    botOpenId: () => 'bot',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: 'om_1' })),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card })
    }),
    addReaction: vi.fn(async () => 'react-1'),
    removeReaction: vi.fn(async () => {}),
    threadIdOfMessage: vi.fn(async () => undefined),
    updated,
  }
}

function hooks() {
  return {
    measureContext: () => ({ contextTokens: 1000, contextWindow: 64000 }),
    sessionLabel: (id: string) => id,
    onError: vi.fn(),
    onTurnFinalized: vi.fn(),
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
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk',
      seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } },
    })
    expect(ch.updated.length).toBe(0)

    await vi.advanceTimersByTimeAsync(499)
    expect(ch.updated.length).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(ch.updated.length).toBe(1)
    expect(markdownOf(ch.updated[0]!.card, 0)).toContain('你好')

    // Subsequent deltas in the same window coalesce into one patch.
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk',
      seq: 2,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(ch.updated.length).toBe(2)
    expect(markdownOf(ch.updated[1]!.card, 0)).toContain('你好，世界')
  })

  it('collects reasoning deltas into the fold panel and flips the title on first text', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-reason')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'assistant/chunk',
      seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先想想' } },
    })
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk',
      seq: 2,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '答' } },
    })
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

  it('finalizes on turn/end: 回复结束 title, final patch, and Typing→DONE swap', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-done')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onSessionEvent(session, {
      type: 'step/start', seq: 1, data: { turn: 1, step: 1 },
    })
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 2,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '完整回答' } },
    })
    streamer.onSessionEvent(session, {
      type: 'assistant/message', seq: 3,
      data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 5 } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stop' } })

    // turn/end finalizes immediately without waiting for the throttle.
    const finalized = ch.updated.at(-1)!
    const panel = (finalized.card as { body: { elements: [{ header: { title: { content: string } } }] } }).body.elements[0]
    expect(panel?.header.title.content).toBe('回复结束')

    await vi.advanceTimersByTimeAsync(0)
    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('om_trigger', 'react-typing')
      expect(add).toHaveBeenCalledWith('om_trigger', 'DONE')
    })
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-done', 1)
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

  it('keeps session-cumulative token figures across turns', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-cum')
    // Historical usage already in the log before attach.
    ;(session.events as SessionEvent[]).push(
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 40 } } },
    )
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'assistant/message', seq: 2,
      data: { turn: 2, step: 1, message: {}, usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 45 } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 3, data: { turn: 2, reason: 'stop' } })

    const card = ch.updated.at(-1)!.card as { body: { elements: [object, object, object, object, { content: string }, { content: string }] } }
    const line1 = card.body.elements[4]?.content ?? ''
    const line2 = card.body.elements[5]?.content ?? ''
    expect(line1).toContain('input token 130')
    expect(line1).toContain('output token 50')
    expect(line2).toContain('缓存命中 60.0%')
  })
})
