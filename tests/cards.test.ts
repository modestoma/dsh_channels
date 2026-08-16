/**
 * Card 2.0 JSON structure tests.
 */

import { describe, expect, it } from 'vitest'
import {
  BODY_MAX_CHARS,
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

function firstElement(card: { elements: Array<{ tag: string }> }): { tag: string } {
  const element = card.elements[0]
  if (element === undefined) throw new Error('card has no elements')
  return element
}

describe('buildCard', () => {
  it('emits a classic-shape card (no schema marker) with the three sections in order', () => {
    const card = buildCard(baseState()) as { schema?: unknown; elements: Array<{ tag: string }> }
    expect(card.schema).toBeUndefined()
    expect(card.elements.map(element => element.tag)).toEqual([
      'collapsible_panel',
      'hr',
      'markdown',
      'hr',
      'note',
    ])
  })

  it('renders the fold panel: default collapsed, bordered, right-aligned rotating chevron', () => {
    const card = buildCard(baseState(), { imgKey: 'img_chevron' }) as {
      elements: [{
        tag: string
        expanded: boolean
        border: { color: string; corner_radius: string }
        header: { title: { content: string }; icon: object; icon_position: string; icon_expanded_angle: number }
      }]
    }
    const panel = card.elements[0]
    expect(panel.expanded).toBe(false)
    expect(panel.border).toEqual({ color: 'grey-200', corner_radius: '8px' })
    expect(panel.header.title.content).toBe('推理中')
    expect(panel.header.icon_position).toBe('right')
    expect(panel.header.icon_expanded_angle).toBe(180)
    expect(panel.header.icon).toEqual({
      tag: 'img',
      img_key: 'img_chevron',
      alt: { tag: 'plain_text', content: '' },
    })
  })

  it('omits the chevron icon when no img key was uploaded', () => {
    const card = buildCard(baseState()) as {
      elements: [{ header: { icon?: unknown } }]
    }
    expect(card.elements[0]?.header.icon).toBeUndefined()
  })

  it('switches the panel title by phase', () => {
    for (const phase of ['thinking', 'replying', 'done'] as const) {
      const card = buildCard(baseState({ phase })) as {
        elements: [{ header: { title: { content: string } } }]
      }
      expect(card.elements[0]?.header.title.content).toBe(PANEL_TITLES[phase])
    }
  })

  it('uses placeholders for empty reasoning and body', () => {
    const card = buildCard(baseState({ phase: 'thinking' })) as {
      elements: [
        { elements: Array<{ content: string }> },
        { tag: string },
        { content: string },
      ]
    }
    expect(card.elements[0]?.elements[0]?.content).toContain('等待模型输出')
    expect(card.elements[2]?.content).toContain('正在生成')
  })

  it('clips overly long reasoning and body under the 30 KB card budget', () => {
    const long = 'x'.repeat(REASONING_MAX_CHARS + 5000)
    const card = buildCard(baseState({ reasoning: long, body: 'y'.repeat(BODY_MAX_CHARS + 200) })) as {
      elements: [
        { elements: Array<{ content: string }> },
        { tag: string },
        { content: string },
      ]
    }
    const reasoning = card.elements[0]?.elements[0]?.content ?? ''
    const body = card.elements[2]?.content ?? ''
    expect(reasoning.length).toBeLessThan(REASONING_MAX_CHARS + 100)
    expect(reasoning).toContain('已截断')
    expect(body.length).toBeLessThan(BODY_MAX_CHARS + 100)
    expect(body).toContain('已截断')
    expect(JSON.stringify(card).length).toBeLessThan(30_000)
  })

  it('renders the two info lines with session-cumulative figures', () => {
    const card = buildCard(baseState({
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
    })) as {
      elements: [
        object, object, object, object,
        { elements: Array<{ content: string }> },
      ]
    }
    const note = card.elements[4]?.elements ?? []
    const line1 = note[0]?.content ?? ''
    const line2 = note[1]?.content ?? ''
    expect(line1).toContain('🔑 sess-42')
    expect(line1).toContain('input token 12,345')
    expect(line1).toContain('output token 678')
    expect(line2).toContain('模型 deepseek-v4-pro(max)')
    expect(line2).toContain('缓存命中 87.3%')
    expect(line2).toContain('上下文 24,100 / 128,000')
  })

  it('renders placeholders for missing cache/context figures', () => {
    const card = buildCard(baseState()) as {
      elements: [
        object, object, object, object,
        { elements: Array<{ content: string }> },
      ]
    }
    const note = card.elements[4]?.elements ?? []
    expect(note[1]?.content).toContain('缓存命中 —')
    expect(note[1]?.content).toContain('上下文 —')
  })
})
