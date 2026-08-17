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
    onCardAction: vi.fn(() => () => {}),
    botOpenId: () => 'bot',
    getConnectionStatus: vi.fn(() => ({ state: 'connected' as const, reconnectAttempts: 0 })),
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

  it('splits an oversized body into continuation segment cards, losing nothing', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-seg')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const huge = 'x'.repeat(30_000)
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: huge } },
    })

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

  it('finalizes continuation cards with the 回复结束 header', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, hooks())
    const session = makeSession('sess-seg-done')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    const segCard = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)
    expect(segCard).toBeDefined()
    const header = markdownOf(segCard!.card, 0)
    expect(header).toContain('回复分段 2')
    expect(header).toContain('回复结束')

    const headCard = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card as {
      body: { elements: [{ header: { title: { content: string } } }] }
    }
    expect(headCard.body.elements[0]?.header.title.content).toBe('回复结束')
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
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: body } },
    })
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

    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
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

    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
    await vi.advanceTimersByTimeAsync(500)

    // One segment delivered as plain text (fallback).
    expect(sendSegment).toHaveBeenCalledTimes(1)
    expect(sendSegment.mock.calls[0]?.[3]).toContain('xxxx')
    // The text-mode card is never patched via updateCard.
    expect(ch.updated.some(update => update.messageId === 'om_text')).toBe(false)

    // More text arrives after the text-fallback delivery: it must NOT be lost
    // (it flows into a fresh segment card, never into the finished text one).
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 2,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '后续内容' } },
    })
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
      streamer.onSessionEvent(session, {
        type: 'assistant/chunk', seq: i + 1,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `行${i}\n` } },
      })
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
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
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
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 8,
      data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: '结论' } },
    })
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
    // panel, status line, hr, body, hr, info line 1, info line 2.
    const elements = (finalCard as { body: { elements: unknown[] } }).body.elements
    expect(elements.length).toBe(7)
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

    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)

    const finalCard = headCard(ch)
    expect(markdownLines(finalCard).join('\n')).not.toContain('处理中')
    // Original element layout restored: panel, hr, body, hr, line1, line2.
    const elements = (finalCard as { body: { elements: unknown[] } }).body.elements
    expect(elements.length).toBe(6)
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
    }
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
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 4,
      data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: '答案' } },
    })
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
    streamer.onSessionEvent(session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } },
    })
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
