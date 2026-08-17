import { describe, expect, it } from 'vitest'
import {
  buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard,
  buildWorkDirCard, compactFailureContext, querySessionHistory, resolveWorkDir,
} from '../src/session-commands.ts'
import { foldAll } from '../src/stats.ts'
import type { SessionEvent } from '../src/dsh-types.ts'
import type { RouteRecord } from '../src/domain.ts'

function at(time: number, type: string, data: unknown): SessionEvent {
  return { type, seq: time, time, data } as unknown as SessionEvent
}

function route(partial: Partial<RouteRecord> = {}): RouteRecord {
  return {
    key: 'thread-1', kind: 'thread', sessionId: 'session-current', chatId: 'chat-1', chatType: 'group',
    senderOpenId: 'ou_owner', workspacePath: '/workspace/alice', cardMessageId: 'message-1',
    createdAt: 1_000, lastActivityAt: 1_000, ...partial,
  }
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

  it('renders both Session ids and the reused workspace after renew', () => {
    const json = JSON.stringify(buildRenewCard({
      previousSessionId: 'session-old',
      currentSessionId: 'session-new',
      workspacePath: '/workspace/alice',
    }))
    expect(json).toContain('session-old')
    expect(json).toContain('session-new')
    expect(json).toContain('/workspace/alice')
    expect(json).toContain('仍由 Harness 保留')
  })

  it('queries newest-first history, marks the current Session, and limits output to 20 rows', () => {
    const sessionHistory = Array.from({ length: 25 }, (_, index) => ({
      sessionId: `session-${String(index + 1).padStart(2, '0')}`,
      createdAt: Date.UTC(2026, 7, 17, 0, index),
    }))
    const record = route({ sessionId: 'session-25', sessionHistory })
    const view = querySessionHistory(record)

    expect(view.total).toBe(25)
    expect(view.hidden).toBe(5)
    expect(view.items).toHaveLength(20)
    expect(view.items[0]).toMatchObject({ sessionId: 'session-25', current: true })
    expect(view.items.at(-1)).toMatchObject({ sessionId: 'session-06', current: false })

    const json = JSON.stringify(buildSessionHistoryCard(record))
    expect(json).toContain('**总数**：25')
    expect(json).toContain('session-25')
    expect(json).toContain('**当前**')
    expect(json).toContain('2026-08-17T00:24:00.000Z')
    expect(json).toContain('另有 5 条未展示')
    expect(json).not.toContain('session-05')
  })

  it('uses the current Session as the sole history entry for a legacy route', () => {
    const legacy = route({ sessionId: 'legacy-session', createdAt: Date.UTC(2026, 7, 17, 8) })
    expect(querySessionHistory(legacy)).toEqual({
      total: 1,
      hidden: 0,
      items: [{ sessionId: 'legacy-session', createdAt: Date.UTC(2026, 7, 17, 8), current: true }],
    })
    const json = JSON.stringify(buildSessionHistoryCard(legacy))
    expect(json).toContain('**总数**：1')
    expect(json).toContain('legacy-session')
    expect(json).not.toContain('未展示')
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
