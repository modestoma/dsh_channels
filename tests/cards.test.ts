/**
 * Card JSON 2.0 structure tests.
 */

import { describe, expect, it } from 'vitest'
import {
  CARD_MAX_BYTES,
  CARD_TARGET_BYTES,
  PANEL_CHEVRON_TOKEN,
  PANEL_TITLES,
  TRUNCATION_SUFFIX,
  buildCard,
  cardJsonBytes,
  segmentCardContent,
  splitBodyForCard,
  stripTables,
  tableBlocks,
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

function elements(state: Partial<CardState> = {}, options?: Parameters<typeof buildCard>[1]): Array<Record<string, any>> {
  const card = buildCard(baseState(state), options) as unknown as CardShape
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

describe('card budget (28 KB target, 30 KB cap)', () => {
  it('keeps the card under the 28 KB target when reasoning overflows', () => {
    const body = 'y'.repeat(5_000)
    const card = buildCard(baseState({ body, reasoning: 'r'.repeat(40_000) }))
    const list = (card as unknown as CardShape).body.elements
    const panelText = list[0]?.elements[0]?.content ?? ''
    const bodyText = list[2]?.content ?? ''

    // Body has priority: it survives intact, reasoning is clipped.
    expect(bodyText).toBe(body)
    expect(panelText).toContain('已截断')
    expect(panelText.length).toBeLessThan(40_000)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_TARGET_BYTES)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES)
  })

  it('clips the body too when it alone exceeds the budget (absolute last resort)', () => {
    const card = buildCard(baseState({ reasoning: 'r'.repeat(40_000), body: 'y'.repeat(40_000) }))
    const list = (card as unknown as CardShape).body.elements
    const bodyText = list[2]?.content ?? ''
    expect(bodyText).toContain('已截断')
    expect(bodyText.length).toBeLessThan(40_000)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES)
  })

  it('passes short content through untouched', () => {
    const card = buildCard(baseState({ reasoning: '想想', body: '答' }))
    const list = (card as unknown as CardShape).body.elements
    expect(list[0]?.elements[0]?.content).toBe('想想')
    expect(list[2]?.content).toBe('答')
  })

  it('renders the continuation variant: segment header, no fold panel', () => {
    const card = buildCard(baseState({ phase: 'replying', body: '分段正文' }), { panel: false, segment: 2 }) as unknown as CardShape
    const list = card.body.elements
    expect(list.map(element => element.tag)).toEqual([
      'markdown', 'hr', 'markdown', 'hr', 'markdown', 'markdown',
    ])
    expect(list[0]?.text_size).toBe('notation')
    expect(list[0]?.content).toBe('📄 回复分段 2 · 回复中')
    expect(list[2]?.content).toBe('分段正文')
  })
})

describe('segmentCardContent / splitBodyForCard', () => {
  it('returns the whole body when it fits', () => {
    const split = segmentCardContent(baseState({ body: '短回答' }))
    expect(split).toEqual({ head: '短回答', tail: '' })
  })

  it('splits at a paragraph boundary and preserves all content', () => {
    // Find the real hard-cut capacity first, then place a paragraph break
    // inside the budget with extra content after it.
    const capacity = segmentCardContent(baseState({ body: 'a'.repeat(30_000) })).head.length
    const first = 'a'.repeat(capacity - 100)
    const rest = `第二段正文${'z'.repeat(1_000)}`
    const body = `${first}\n\n${rest}`

    const split = segmentCardContent(baseState({ body }))
    expect(split.head).toBe(first)
    expect(split.tail).toBe(rest)
    expect(cardJsonBytes(buildCard(baseState({ body: split.head })))).toBeLessThanOrEqual(CARD_TARGET_BYTES)
  })

  it('never splits inside a fenced code block', () => {
    const overhead = cardJsonBytes(buildCard(baseState()))
    const fill = CARD_TARGET_BYTES - overhead - 100
    // The fence opens well before the budget ceiling and closes far after it,
    // so the cut must move to just before the fence.
    const code = '```js\n' + 'c'.repeat(fill * 2) + '\n```'
    const body = `intro\n${code}\n\nafter`

    const split = segmentCardContent(baseState({ body }))
    expect(split.head).toBe('intro')
    expect(split.tail.startsWith('```js')).toBe(true)
    expect(split.tail.endsWith('after')).toBe(true)
  })

  it('splits before a heading line when no paragraph break exists', () => {
    const first = 'a'.repeat(19_995)
    const body = `${first}\n## 标题\n内容`

    const split = splitBodyForCard(body, 20_000)
    expect(split.head).toBe(first)
    expect(split.tail).toBe('## 标题\n内容')
  })

  it('hard-cuts without newlines and loses nothing', () => {
    const overhead = cardJsonBytes(buildCard(baseState()))
    const fill = CARD_TARGET_BYTES - overhead - 100
    const body = 'x'.repeat(fill * 2)

    const split = segmentCardContent(baseState({ body }))
    expect(split.head + split.tail).toBe(body)
    expect(cardJsonBytes(buildCard(baseState({ body: split.head })))).toBeLessThanOrEqual(CARD_TARGET_BYTES)
  })

  it('splitBodyForCard passes short bodies through unchanged', () => {
    expect(splitBodyForCard('short', 100)).toEqual({ head: 'short', tail: '' })
  })

  it('TRUNCATION_SUFFIX marks clipped content', () => {
    expect(TRUNCATION_SUFFIX).toContain('已截断')
  })
})

describe('markdown table handling', () => {
  const table = (n: number) => `| 列${n} | 值 |\n| --- | --- |\n| 行 | ${n} |`

  it('locates table runs and ignores pipe lines inside code fences', () => {
    const blocks = tableBlocks(`前\n\n${table(1)}\n\n\`\`\`sh\n| grep x\n| sort\n\`\`\`\n\n${table(2)}`)
    expect(blocks).toHaveLength(2)
    // Neither block covers the fenced pipe lines.
    const fenced = tableBlocks(`\`\`\`sh\n| grep x\n| sort\n\`\`\``)
    expect(fenced).toHaveLength(0)
  })

  it('strips tables from reasoning panel content', () => {
    const out = stripTables(`想想\n\n${table(1)}\n\n结论`)
    expect(out).not.toContain('|')
    expect(out).toContain('表格已省略')
    expect(out).toContain('想想')
    expect(out).toContain('结论')
  })

  it('keeps at most five tables per segment, even when the body fits the byte budget', () => {
    const body = [
      '开头',
      table(1), table(2), table(3), table(4), table(5), table(6),
    ].join('\n\n')
    const split = segmentCardContent(baseState({ body }))
    expect(split.head).toContain('| 列1 |')
    expect(split.head).toContain('| 列5 |')
    expect(split.head).not.toContain('| 列6 |')
    expect(split.tail.startsWith('| 列6 |')).toBe(true)
  })

  it('never cuts inside a table that straddles the byte ceiling', () => {
    // The ceiling (19_500) lands inside the table: the cut must move to the
    // line right before it.
    const intro = 'a'.repeat(19_496)
    const body = `${intro}\n${table(1)}`
    const split = splitBodyForCard(body, 19_500)
    expect(split.head).toBe(intro)
    expect(split.tail.startsWith('| 列1 |')).toBe(true)
  })

  it('drains a multi-table body into table-capped pieces without loss', () => {
    const tables = Array.from({ length: 12 }, (_, i) => table(i + 1)).join('\n\n')
    const body = `开头\n\n${tables}\n\n结尾`
    const pieces: string[] = []
    let rest = body
    for (let i = 0; i < 10 && rest !== ''; i++) {
      const split = segmentCardContent(baseState({ body: rest }))
      expect(split.head).not.toBe('')
      pieces.push(split.head)
      rest = split.tail
    }
    expect(rest).toBe('')
    const flat = (text: string) => text.replace(/\s+/g, '')
    expect(flat(pieces.join(''))).toBe(flat(body))
    // Every piece holds at most 5 tables (3 pipe lines each).
    for (const piece of pieces) {
      const pipeLines = (piece.match(/^\s*\|[^\n]*\|/gm) ?? []).length
      expect(pipeLines).toBeLessThanOrEqual(15)
    }
  })
})
