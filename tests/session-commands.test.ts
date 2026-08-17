import { describe, expect, it } from 'vitest'
import {
  buildCompactComparisonCard, buildSessionStatusCard, buildWorkDirCard,
  compactFailureContext, resolveWorkDir,
} from '../src/session-commands.ts'
import { foldAll } from '../src/stats.ts'
import type { SessionEvent } from '../src/dsh-types.ts'

function at(time: number, type: string, data: unknown): SessionEvent {
  return { type, seq: time, time, data } as unknown as SessionEvent
}

describe('Session command result cards', () => {
  it('renders full status metrics without tool arguments, results, NaN, or Infinity', () => {
    const stats = foldAll([
      at(1, 'request/header', {
        header: { config: { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' } },
      }),
      at(1_000, 'step/start', { turn: 1, step: 1 }),
      at(1_500, 'assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' },
      }),
      at(2_500, 'assistant/message', {
        turn: 1, step: 1, message: {},
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 },
      }),
      at(3_000, 'tool/call', {
        turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"token":"secret"}',
      }),
      at(3_800, 'tool/result', {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, text: 'private-result' }],
        },
      }),
    ])
    const json = JSON.stringify(buildSessionStatusCard({
      sessionId: 'session-1', stats, context: { contextTokens: 64_000, contextWindow: 128_000 },
    }))
    expect(json).toContain('deepseek-official/deepseek-v4')
    expect(json).toContain('50.0%')
    expect(json).toContain('90.0%')
    expect(json).toContain('bash')
    expect(json).not.toContain('secret')
    expect(json).not.toContain('private-result')
    expect(json).not.toContain('NaN')
    expect(json).not.toContain('Infinity')
  })

  it('uses 暂无数据 for missing usage, model, timing, and context samples', () => {
    const json = JSON.stringify(buildSessionStatusCard({
      sessionId: 'session-empty', stats: foldAll([]), context: {},
    }))
    expect(json).toContain('尚未产生模型请求')
    expect(json.match(/暂无数据/g)?.length).toBeGreaterThanOrEqual(5)
    expect(json).not.toContain('0.0%')
    expect(json).not.toContain('0 tokens/s')
  })

  it('returns only a verified absolute work directory', () => {
    expect(resolveWorkDir('/workspace/alice', '/workspace/alice')).toEqual({
      kind: 'success', path: '/workspace/alice',
    })
    expect(resolveWorkDir('/workspace/alice', '/workspace/bob')).toMatchObject({ kind: 'mismatch' })
    expect(resolveWorkDir(undefined, '/workspace/alice')).toMatchObject({ kind: 'missing' })
    expect(resolveWorkDir('relative', '/workspace/alice')).toMatchObject({ kind: 'missing' })
    expect(JSON.stringify(buildWorkDirCard('session-1', '/workspace/alice'))).toContain('/workspace/alice')
  })

  it('renders compact before/after bars and exact token accounting', () => {
    const json = JSON.stringify(buildCompactComparisonCard({
      sessionId: 'session-1',
      resultText: 'Compacted 9 history items.',
      before: { contextTokens: 99_840, contextWindow: 128_000 },
      after: { contextTokens: 39_680, contextWindow: 128_000 },
    }))
    expect(json).toContain('████████░░')
    expect(json).toContain('███░░░░░░░')
    expect(json).toContain('99,840 / 128,000')
    expect(json).toContain('39,680 / 128,000')
    expect(json).toContain('60,160 tokens')
  })

  it('falls back to exact token counts without a known context window', () => {
    const json = JSON.stringify(buildCompactComparisonCard({
      sessionId: 'session-1', resultText: 'No compactable history yet.',
      before: { contextTokens: 500 }, after: { contextTokens: 500 },
    }))
    expect(json).toContain('压缩前  500 tokens')
    expect(json).toContain('压缩后  500 tokens')
    expect(json).toContain('释放    0 tokens')
    expect(json).not.toContain('█')
  })

  it('describes unchanged and unexpectedly changed contexts after failures', () => {
    expect(compactFailureContext({ contextTokens: 10 }, { contextTokens: 10 })).toContain('保持不变')
    expect(compactFailureContext({ contextTokens: 10 }, { contextTokens: 8 })).toContain('可能已变化')
    expect(compactFailureContext({}, {})).toContain('暂无可用测量数据')
  })
})
