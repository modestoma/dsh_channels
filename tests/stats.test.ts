/**
 * Session-log fold tests.
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_TOTALS, addUsage, cacheHitPct, foldAll, foldEvent } from '../src/stats.ts'
import type { SessionEvent, TokenUsage } from '../src/dsh-types.ts'

let seq = 0
function usageEvent(usage: TokenUsage, turn = 1, step = 1): SessionEvent {
  return {
    type: 'assistant/message',
    seq: ++seq,
    data: { turn, step, message: {}, usage },
  }
}

function headerEvent(provider: string, model: string, effort?: string): SessionEvent {
  return {
    type: 'request/header',
    seq: ++seq,
    data: { header: { config: { provider, model, reasoningEffort: effort } } },
  }
}

describe('stats folds', () => {
  it('sums usage across the whole session (cumulative scope)', () => {
    const fold = foldAll([
      usageEvent({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 1 }),
      usageEvent({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 6 }),
    ])
    expect(fold.totals).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      cacheReadTokens: 22,
      cacheWriteTokens: 1,
      reasoningTokens: 6,
    })
  })

  it('keeps zero totals for sessions without usage', () => {
    expect(foldAll([]).totals).toEqual(EMPTY_TOTALS)
  })

  it('tracks the latest usage sample for the cache-hit ratio', () => {
    const fold = foldAll([
      usageEvent({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 900 }),
      usageEvent({ inputTokens: 200, outputTokens: 1, cacheReadTokens: 100 }),
    ])
    expect(cacheHitPct(fold.lastUsage)).toBeCloseTo(100 / 300, 6)
  })

  it('returns undefined cache ratio without any usage or without cache info', () => {
    expect(cacheHitPct(foldAll([]).lastUsage)).toBeUndefined()
    const fold = foldAll([usageEvent({ inputTokens: 10, outputTokens: 1 })])
    expect(cacheHitPct(fold.lastUsage)).toBeUndefined()
  })

  it('reads model and effort from the latest request header', () => {
    const fold = foldAll([
      headerEvent('deepseek-official', 'deepseek-v4-flash', 'high'),
      headerEvent('deepseek-official', 'deepseek-v4-pro', 'max'),
    ])
    expect(fold.lastHeader).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' })
  })

  it('ignores unknown event types', () => {
    const fold = { totals: { ...EMPTY_TOTALS }, lastUsage: undefined, lastHeader: undefined }
    foldEvent(fold, { type: 'todo/write', seq: 1, data: {} } as unknown as SessionEvent)
    expect(fold.totals).toEqual(EMPTY_TOTALS)
  })

  it('addUsage sums disjoint buckets', () => {
    const result = addUsage(EMPTY_TOTALS, {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 1,
      reasoningTokens: 4,
    })
    expect(result).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 1,
      reasoningTokens: 4,
    })
  })
})
