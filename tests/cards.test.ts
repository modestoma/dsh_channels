/**
 * Card JSON 2.0 structure tests.
 */

import { describe, expect, it } from 'vitest'
import {
  BODY_MAX_CHARS,
  PANEL_CHEVRON_TOKEN,
  PANEL_TITLES,
  REASONING_MAX_CHARS,
  buildCard,
} from '../src/cards.ts'
import type { CardState } from '../src/cards.ts'

function baseState(partial: Partial<CardState> = {}): CardState {
  return {
    phase: 'thinking',
    reasoning: '',
    body: '',
    stats: { sessionId: 'sess-1', inputTokens: 100, outputTokens: 50 },
    ...partial,
  }
}

interface CardShape {
  schema: string
  config: { width_mode: string }
  body: { elements: Array<Record<string, any>> }
}

function elements(state: Partial<CardState> = {}): Array<Record<string, any>> {
  const card = buildCard(baseState(state)) as unknown as CardShape
  return card.body.elements
}

describe('buildCard', () => {
  it('emits the 2.0 structure: schema + config.width_mode + body.elements', () => {
    const card = buildCard(baseState()) as unknown as CardShape
    expect(card.schema).toBe('2.0')
    expect(card.config.width_mode).toBe('fill')
    expect(card.body.elements.map(element => element.tag)).toEqual([
      'collapsible_panel',
      'hr',
      'markdown',
      'hr',
      'markdown',
      'markdown',
    ])
  })

  it('renders the fold panel: default collapsed, bordered, right-aligned built-in chevron', () => {
    const panel = elements()[0]
    expect(panel?.expanded).toBe(false)
    expect(panel?.border).toEqual({ color: 'grey', corner_radius: '8px' })
    expect(panel?.header.title.content).toBe('推理中')
    expect(panel?.header.icon_position).toBe('right')
    expect(panel?.header.icon_expanded_angle).toBe(180)
    expect(panel?.header.icon).toEqual({
      tag: 'standard_icon',
      token: PANEL_CHEVRON_TOKEN,
    })
  })

  it('switches the panel title by phase', () => {
    for (const phase of ['thinking', 'replying', 'done'] as const) {
      const panel = elements({ phase })[0]
      expect(panel?.header.title.content).toBe(PANEL_TITLES[phase])
    }
  })

  it('uses placeholders for empty reasoning and body', () => {
    const list = elements({ phase: 'thinking' })
    expect(list[0]?.elements[0]?.content).toContain('等待模型输出')
    expect(list[2]?.content).toContain('正在生成')
  })

  it('clips overly long reasoning and body under the 30 KB card budget', () => {
    const card = buildCard(baseState({
      reasoning: 'x'.repeat(REASONING_MAX_CHARS + 5000),
      body: 'y'.repeat(BODY_MAX_CHARS + 200),
    }))
    const list = (card as unknown as CardShape).body.elements
    const reasoning = list[0]?.elements[0]?.content ?? ''
    const body = list[2]?.content ?? ''
    expect(reasoning.length).toBeLessThan(REASONING_MAX_CHARS + 100)
    expect(reasoning).toContain('已截断')
    expect(body.length).toBeLessThan(BODY_MAX_CHARS + 100)
    expect(body).toContain('已截断')
    expect(JSON.stringify(card).length).toBeLessThan(30_000)
  })

  it('renders the two info lines with session-cumulative figures in notation size', () => {
    const list = elements({
      stats: {
        sessionId: 'sess-42',
        inputTokens: 12345,
        outputTokens: 678,
        cacheHitPct: 0.873,
        contextTokens: 24100,
        contextWindow: 128000,
        model: 'deepseek-v4-pro',
        effort: 'max',
      },
    })
    const line1 = list[4]?.content ?? ''
    const line2 = list[5]?.content ?? ''
    expect(list[4]?.text_size).toBe('notation')
    expect(list[5]?.text_size).toBe('notation')
    expect(line1).toContain('🔑 sess-42')
    expect(line1).toContain('input token 12,345')
    expect(line1).toContain('output token 678')
    expect(line2).toContain('模型 deepseek-v4-pro(max)')
    expect(line2).toContain('缓存命中 87.3%')
    expect(line2).toContain('上下文 24,100 / 128,000')
  })

  it('renders placeholders for missing cache/context figures', () => {
    const list = elements()
    const line2 = list[5]?.content ?? ''
    expect(line2).toContain('缓存命中 —')
    expect(line2).toContain('上下文 —')
  })
})
