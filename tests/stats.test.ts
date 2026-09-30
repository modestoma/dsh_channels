/** Session-log diagnostic fold tests. */

import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_TOTALS, addUsage, applyProjectionViews, averageDecodeTokensPerSecond, averageTtftMs,
  cacheHitPct, foldAll, measureSessionContext, readProjectionViews, usageFromBuckets,
} from '../src/stats.ts'
import type { SessionEvent, SessionProjections, TokenUsage } from '../src/dsh-types.ts'
import { makeSession, sessionEvents } from './helpers.ts'

let seq = 0
function at(time: number, type: string, data: unknown): SessionEvent {
  return { type, seq: ++seq, time, data } as unknown as SessionEvent
}

function usageEvent(usage: TokenUsage, turn = 1, step = 1): SessionEvent {
  return at(++seq, 'assistant/message', { turn, step, message: {}, usage })
}

function headerEvent(provider: string, model: string, effort?: string): SessionEvent {
  return at(++seq, 'request/header', { header: { config: { provider, model, reasoningEffort: effort } } })
}

function toolResult(callId: string, time: number, isError = false): SessionEvent {
  return at(time, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError }],
    },
  })
}

describe('stats folds', () => {
  it('sums usage across the whole session and keeps the latest cache/header samples', () => {
    const fold = foldAll([
      headerEvent('deepseek-official', 'deepseek-v4-flash', 'high'),
      usageEvent({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 1 }),
      headerEvent('deepseek-official', 'deepseek-v4-pro', 'max'),
      usageEvent({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 6 }),
    ])
    expect(fold.totals).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      cacheReadTokens: 22,
      cacheWriteTokens: 1,
      reasoningTokens: 6,
    })
    expect(fold.usageSamples).toBe(2)
    expect(cacheHitPct(fold.lastUsage)).toBeCloseTo(2 / 7, 6)
    expect(fold.lastHeader).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' })
  })

  it('uses the whole-log LLM, TTFT, and decode timing definitions across steps', () => {
    const fold = foldAll([
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(4_800, 'assistant/message', {
        turn: 1, step: 1, message: {},
        // The settlement embeds the timed stream; time0 is the first token.
        stream: [{ type: 'text-chunks', time0: 1_800, index: 0, dt: [], texts: ['a'] }],
        usage: { inputTokens: 10, outputTokens: 60 },
      }),
      at(4_900, 'step/end', { turn: 1, step: 1 }),
      at(5_000, 'step/start', { turn: 1, step: 2 }),
      at(6_500, 'assistant/message', {
        turn: 1, step: 2, message: {},
        stream: [{ type: 'reasoning-chunks', time0: 5_500, index: 0, dt: [], texts: ['x'] }],
        usage: { inputTokens: 5, outputTokens: 20 },
      }),
      at(6_600, 'step/end', { turn: 1, step: 2 }),
    ])
    expect(fold).toMatchObject({
      llmMs: 5_300,
      llmSteps: 2,
      ttftMs: 1_300,
      ttftSteps: 2,
      decodeMs: 4_000,
      decodeTokens: 80,
    })
    expect(averageTtftMs(fold)).toBe(650)
    expect(averageDecodeTokensPerSecond(fold)).toBe(20)
  })

  it('counts failed/cancelled steps without fabricating timing or usage samples', () => {
    const fold = foldAll([
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      // A cancelled step settles as `assistant/attempt` (no surface message).
      at(1_300, 'assistant/attempt', {
        turn: 1, step: 1,
        stream: [{ type: 'text-chunks', time0: 1_200, index: 0, dt: [], texts: ['partial'] }],
      }),
      at(2_000, 'step/end', { turn: 1, step: 1 }),
      at(2_100, 'turn/end', { turn: 1, reason: 'cancelled' }),
    ])
    expect(fold).toMatchObject({ usageSamples: 0, llmMs: 0, llmSteps: 0, ttftSteps: 0, decodeMs: 0 })
    expect(averageTtftMs(fold)).toBeUndefined()
    expect(averageDecodeTokensPerSecond(fold)).toBeUndefined()
  })

  it('pairs tools by call id, retains incomplete calls, and exposes only safe recent metadata', () => {
    const fold = foldAll([
      at(100, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{"secret":1}' }),
      at(200, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'read', arguments: '{"path":"private"}' }),
      toolResult('b', 1_200),
      toolResult('a', 600, true),
      at(1_300, 'tool/call', { turn: 1, step: 2, callId: 'c', name: 'write', arguments: '{"content":"secret"}' }),
    ])
    expect(fold.toolCalls).toBe(3)
    expect(fold.toolMs).toBe(1_500)
    expect(fold.toolTimedCalls).toBe(2)
    expect([...fold.pendingTools.keys()]).toEqual(['c'])
    expect(fold.recentTools).toEqual([
      { callId: 'b', name: 'read', status: 'success', startedAt: 200, durationMs: 1_000 },
      { callId: 'a', name: 'bash', status: 'error', startedAt: 100, durationMs: 500 },
      { callId: 'c', name: 'write', status: 'running', startedAt: 1_300 },
    ])
    expect(JSON.stringify(fold.recentTools)).not.toContain('secret')
    expect(JSON.stringify(fold.recentTools)).not.toContain('private')
  })

  it('caps recent tool events at five and ignores unmatched results', () => {
    const events: SessionEvent[] = [toolResult('ghost', 10)]
    for (let index = 0; index < 7; index++) {
      events.push(at(100 + index, 'tool/call', {
        turn: 1, step: 1, callId: `call-${index}`, name: `tool-${index}`, arguments: '{}',
      }))
    }
    const fold = foldAll(events)
    expect(fold.recentTools.map(event => event.name)).toEqual(['tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6'])
  })

  it('ignores command lifecycle records so /status itself cannot change figures', () => {
    const before = foldAll([usageEvent({ inputTokens: 3, outputTokens: 2 })])
    const after = foldAll([
      usageEvent({ inputTokens: 3, outputTokens: 2 }),
      at(100, 'command/run', { commandId: 'cmd-1', name: 'status' }),
      at(101, 'command/done', { commandId: 'cmd-1', kind: 'success' }),
    ])
    expect(after.totals).toEqual(before.totals)
    expect(after.toolCalls).toBe(before.toolCalls)
    expect(after.llmMs).toBe(before.llmMs)
  })

  it('produces the same fold for an equivalent live and resumed log', () => {
    const events = [
      headerEvent('provider', 'model', 'high'),
      usageEvent({ inputTokens: 8, outputTokens: 5, cacheReadTokens: 2 }),
    ]
    expect(foldAll(structuredClone(events))).toEqual(foldAll(events))
  })

  it('measures tokens and model capacity while containing unavailable peers', async () => {
    const session = makeSession('session-context')
    sessionEvents(session).push(headerEvent('provider', 'model'))
    const tokenMeter = { measure: vi.fn(() => ({ totalTokens: 9_984 })) }
    const llm = { resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 128_000 } })) }
    await expect(measureSessionContext(session, { tokenMeter, llm })).resolves.toEqual({
      contextTokens: 9_984,
      contextWindow: 128_000,
    })
    expect(llm.resolveModelInfo).toHaveBeenCalledWith('provider', 'model')

    await expect(measureSessionContext(session, {
      tokenMeter: { measure: () => { throw new Error('meter unavailable') } },
      llm: { resolveModelInfo: async () => { throw new Error('model unavailable') } },
    })).resolves.toEqual({ contextTokens: undefined, contextWindow: undefined })
  })

  it('keeps undefined cache ratios and guards invalid usage fields', () => {
    expect(foldAll([]).totals).toEqual(EMPTY_TOTALS)
    expect(cacheHitPct(foldAll([]).lastUsage)).toBeUndefined()
    expect(cacheHitPct(foldAll([usageEvent({ inputTokens: 10, outputTokens: 1 })]).lastUsage)).toBeUndefined()
    expect(addUsage(EMPTY_TOTALS, {
      inputTokens: Number.NaN, outputTokens: -2, cacheReadTokens: 7,
    })).toEqual({ ...EMPTY_TOTALS, cacheReadTokens: 7 })
  })
})

describe('host projection overlay', () => {
  function projectionsFor(states: Record<string, unknown>): SessionProjections {
    return { stateOf: (_session, key) => states[key] }
  }

  it('maps host projection state and tolerates malformed/unavailable units', () => {
    const session = makeSession('session-proj')
    const views = readProjectionViews(projectionsFor({
      sessionStats: {
        turns: 2, steps: 3, llmMs: 1_500, toolMs: 200,
        ttftMs: 300, ttftSteps: 2, decodeMs: 900, decodeTokens: 40,
      },
      tokenUsage: {
        totals: { uncachedInputTokens: 4_242, outputTokens: 777, cacheReadTokens: 100, cacheWriteTokens: 7 },
        last: { turn: 2, step: 1, buckets: { uncachedInputTokens: 42, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 } },
      },
      contextPressure: { contextWindow: 64_000, projectedTokens: 1_000 },
    }), session)
    expect(views.sessionStats).toMatchObject({ llmMs: 1_500, ttftSteps: 2, decodeTokens: 40 })
    expect(views.tokenUsage?.totals.uncachedInputTokens).toBe(4_242)
    expect(views.tokenUsage?.last?.turn).toBe(2)
    expect(views.contextPressure?.contextWindow).toBe(64_000)

    // A throwing registry never breaks the fold; garbage values degrade to 0.
    expect(readProjectionViews({
      stateOf: () => { throw new Error('projection unavailable') },
    }, session)).toEqual({})
    const malformed = readProjectionViews(projectionsFor({
      tokenUsage: { totals: { uncachedInputTokens: 'nope' }, last: null },
    }), session)
    expect(malformed.tokenUsage?.totals.uncachedInputTokens).toBe(0)
  })

  it('overlays host times and totals onto the log fold', () => {
    const fold = foldAll([
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(2_000, 'assistant/message', {
        turn: 1, step: 1, message: {}, usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 1 },
      }),
    ])
    expect(fold.llmMs).toBe(1_000)
    const overlaid = applyProjectionViews(fold, {
      sessionStats: {
        turns: 1, steps: 1, llmMs: 4_321, toolMs: 55,
        ttftMs: 111, ttftSteps: 1, decodeMs: 222, decodeTokens: 33,
      },
      tokenUsage: {
        totals: { uncachedInputTokens: 90, outputTokens: 9, cacheReadTokens: 10, cacheWriteTokens: 1 },
        last: { turn: 1, step: 1, buckets: { uncachedInputTokens: 90, outputTokens: 9, cacheReadTokens: 10, cacheWriteTokens: 1 } },
      },
    })
    expect(overlaid.llmMs).toBe(4_321)
    expect(overlaid.toolMs).toBe(55)
    expect(overlaid.ttftMs).toBe(111)
    expect(overlaid.decodeTokens).toBe(33)
    expect(overlaid.totals).toMatchObject({ inputTokens: 90, outputTokens: 9, cacheReadTokens: 10 })
    expect(usageFromBuckets({ uncachedInputTokens: 90, outputTokens: 9, cacheReadTokens: 10, cacheWriteTokens: 1 }))
      .toMatchObject({ inputTokens: 90, cacheReadTokens: 10 })
    expect(overlaid.lastUsage?.turn).toBe(1)
  })

  it('prefers the projected context window over the model-info lookup', async () => {
    const session = makeSession('session-window')
    const llm = { resolveModelInfo: vi.fn(async () => ({ context: { contextWindow: 128_000 } })) }
    const tokenMeter = { measure: () => ({ totalTokens: 1_234 }) }
    await expect(measureSessionContext(
      session,
      { tokenMeter, llm, projections: projectionsFor({ contextPressure: { contextWindow: 32_000 } }) },
      { provider: 'p', model: 'm', effort: undefined },
    )).resolves.toEqual({ contextTokens: 1_234, contextWindow: 32_000 })
    expect(llm.resolveModelInfo).not.toHaveBeenCalled()

    // Without the projection the fallback lookup still works (deployments
    // without the token-meter projections must not regress).
    await expect(measureSessionContext(
      session,
      { tokenMeter, llm },
      { provider: 'p', model: 'm', effort: undefined },
    )).resolves.toEqual({ contextTokens: 1_234, contextWindow: 128_000 })
  })
})
