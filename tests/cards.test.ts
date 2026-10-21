/**
 * Card JSON 2.0 structure tests.
 */

import { describe, expect, it } from 'vitest'
import {
  CARD_MAX_BYTES,
  CARD_TARGET_BYTES,
  INTERRUPTION_NOTICE,
  PANEL_CHEVRON_TOKEN,
  PANEL_TITLES,
  REASONING_MAX_BYTES,
  TRUNCATION_SUFFIX,
  buildApprovalCard,
  buildApprovalSettledCard,
  buildCard,
  buildInterruptionCard,
  buildOnboardingCard,
  buildPickerCard,
  cardJsonBytes,
  initialStreamingCard,
  MAX_PICKER_OPTIONS,
  parsePickAction,
  PICK_ACTION,
  STOP_ACTION,
  segmentCardContent,
  splitBodyForCard,
  stripTables,
  tableBlocks,
} from '../src/cards.ts'
import type { ApprovalQuestion, CardState } from '../src/cards.ts'

/** JSON-escaped UTF-8 size of a string; the metric the panel budget uses. */
function escapedJsonBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length
}

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

function tags(list: Array<Record<string, any>>): string[] {
  return list.map(element => element.tag)
}

/** Full stats for footer assertions. */
const fullStats = {
  sessionId: 'sess-42',
  inputTokens: 12345,
  outputTokens: 678,
  cacheHitPct: 0.873,
  contextTokens: 24100,
  contextWindow: 128000,
  model: 'deepseek-v4-pro',
  effort: 'max',
}

describe('buildCard', () => {
  it('emits the 2.0 structure: schema + config.width_mode + body.elements', () => {
    const card = buildCard(baseState()) as unknown as CardShape
    expect(card.schema).toBe('2.0')
    expect(card.config.width_mode).toBe('fill')
    // A live first frame: the reasoning panel (phase indicator) + body placeholder.
    expect(tags(card.body.elements)).toEqual(['collapsible_panel', 'markdown'])
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
    for (const phase of ['thinking', 'replying', 'done', 'error'] as const) {
      const panel = elements({ phase, reasoning: '想过' })[0]
      expect(panel?.header.title.content).toBe(PANEL_TITLES[phase])
    }
  })

  it('uses placeholders for empty reasoning and body', () => {
    const list = elements({ phase: 'thinking' })
    expect(list[0]?.elements[0]?.content).toContain('等待模型输出')
    expect(list[1]?.content).toContain('正在生成')
    expect(elements({ phase: 'done' })[0]?.content).toContain('本次无正文输出')
  })

  it('omits the panel once the turn settles without reasoning content', () => {
    // A settled non-reasoning turn: no empty bordered box at the top — just the
    // body, the divider and the two footer lines.
    expect(tags(elements({ phase: 'done', body: '答案' }))).toEqual(['markdown', 'hr', 'markdown', 'markdown'])
    expect(tags(elements({ phase: 'error', body: '失败', reasoning: '   ' })))
      .toEqual(['markdown', 'hr', 'markdown', 'markdown'])
    // Reasoning content keeps it.
    expect(tags(elements({ phase: 'done', reasoning: '想过', body: '答案' }))[0]).toBe('collapsible_panel')
    // While thinking the panel is the phase indicator, even with no reasoning yet.
    expect(tags(elements({ phase: 'thinking' }))[0]).toBe('collapsible_panel')
  })

  it('renders the settled footer under a divider: model/session/reasoning + usage', () => {
    const list = elements({ phase: 'done', reasoning: '想过', body: '答案', stats: fullStats })
    // panel → body → hr → model line → usage line.
    expect(tags(list)).toEqual(['collapsible_panel', 'markdown', 'hr', 'markdown', 'markdown'])

    const modelLine = list[3]?.content ?? ''
    const usageLine = list[4]?.content ?? ''
    expect(list[3]?.text_size).toBe('notation')
    expect(list[4]?.text_size).toBe('notation')
    expect(modelLine).toContain('🧠 模型 deepseek-v4-pro(max)')
    expect(modelLine).toContain('🔑 会话 sess-42')
    expect(modelLine).toContain('⏱ 推理 —')
    expect(usageLine).toContain('📊 上下文 24,100/128,000 (19%)')
    expect(usageLine).toContain('📩 输入 12,345')
    expect(usageLine).toContain('📨 输出 678')
    expect(usageLine).toContain('⚡ 缓存命中 87.3%')

    // Live cards never show the not-yet-meaningful counters.
    for (const phase of ['thinking', 'replying'] as const) {
      expect(elements({ phase, body: '答案' }).some(element => element.text_size === 'notation')).toBe(false)
    }
    // Continuation cards never repeat the footer (it already lives on the main card).
    expect(list).toHaveLength(5)
    expect(elements({ phase: 'done', body: '答案' }, { segment: 2 })).toHaveLength(2)
    expect(tags(elements({ phase: 'done', body: '答案' }, { segment: 2 }))).toEqual(['markdown', 'markdown'])
  })

  it('formats the reasoning time as seconds or minutes', () => {
    const reasoningLine = (reasoningMs?: number): string =>
      elements({ phase: 'done', reasoning: '想过', body: '答案', stats: { ...fullStats, reasoningMs } })[3]?.content ?? ''
    expect(reasoningLine(0)).toContain('推理 0.0s')
    expect(reasoningLine(1_500)).toContain('推理 1.5s')
    expect(reasoningLine(3_200)).toContain('推理 3.2s')
    expect(reasoningLine(59_960)).toContain('推理 60.0s')
    expect(reasoningLine(60_000)).toContain('推理 1分0s')
    expect(reasoningLine(65_000)).toContain('推理 1分5s')
    expect(reasoningLine()).toContain('推理 —')
  })

  it('renders placeholders for missing cache/context/model figures', () => {
    const list = elements({ phase: 'done', body: '答案' })
    const modelLine = list[2]?.content ?? ''
    const usageLine = list[3]?.content ?? ''
    expect(modelLine).toContain('🧠 模型 —')
    expect(modelLine).toContain('⏱ 推理 —')
    expect(usageLine).toContain('📊 上下文 —')
    expect(usageLine).toContain('⚡ 缓存命中 —')
  })

  it('renders the context share with a sane precision', () => {
    const usage = (stats: Partial<typeof fullStats>): string =>
      elements({ phase: 'done', body: '答案', stats: { ...fullStats, ...stats } })[3]?.content ?? ''
    expect(usage({ contextTokens: 3_618, contextWindow: 1_000_000 })).toContain('(0.4%)')
    expect(usage({ contextTokens: 5_000, contextWindow: 100_000 })).toContain('(5.0%)')
    // Just below ten percent rounds to 10 and uses the integer form.
    expect(usage({ contextTokens: 9_960, contextWindow: 100_000 })).toContain('(10%)')
    expect(usage({ contextTokens: 9_960, contextWindow: 100_000 })).not.toContain('(10.0%)')
    expect(usage({ contextTokens: 64_000, contextWindow: 100_000 })).toContain('(64%)')
    expect(usage({ contextTokens: 64_000, contextWindow: undefined })).toContain('上下文 64,000 tokens')
    // A non-positive window is treated as "no window".
    expect(usage({ contextTokens: 64_000, contextWindow: 0 })).toContain('上下文 64,000 tokens')
  })

  it('renders the two activity lines (status + tool) between the panel and the body, omitted when empty', () => {
    const list = elements({
      status: '🧵 工作流 audit 结束（完成）',
      tool: '🔧 调用工具：bash · 已运行 12s',
    })
    expect(tags(list)).toEqual(['collapsible_panel', 'markdown', 'markdown', 'markdown'])
    expect(list[1]?.content).toBe('🧵 工作流 audit 结束（完成）')
    expect(list[1]?.text_size).toBe('notation')
    expect(list[2]?.content).toBe('🔧 调用工具：bash · 已运行 12s')
    expect(list[2]?.text_size).toBe('notation')
    // Only the tool line.
    expect(tags(elements({ tool: '🔧 调用工具：bash' }))).toEqual(['collapsible_panel', 'markdown', 'markdown'])
    // Empty / undefined activity keeps the compact layout.
    expect(tags(elements({ status: '', tool: '' }))).toEqual(['collapsible_panel', 'markdown'])
  })

  it('renders both activity lines on continuation cards too (after the segment header)', () => {
    const list = elements(
      { status: '🧵 工作流 audit · 3/8 子代理完成 · 已运行 1分2s', tool: '🔧 调用工具：grep' },
      { segment: 2 },
    )
    expect(tags(list)).toEqual(['markdown', 'markdown', 'markdown', 'markdown'])
    expect(list[0]?.content).toBe('📄 回复分段 2')
    expect(list[0]?.text_size).toBe('notation')
    expect(list[1]?.content).toContain('工作流 audit')
    expect(list[1]?.text_size).toBe('notation')
    expect(list[2]?.content).toContain('调用工具：grep')
    expect(list[2]?.text_size).toBe('notation')
  })
})

describe('card budget (28 KB target, 30 KB cap)', () => {
  it('keeps the card under the target when reasoning overflows', () => {
    const body = 'y'.repeat(5_000)
    const card = buildCard(baseState({ body, reasoning: 'r'.repeat(40_000) }))
    const list = (card as unknown as CardShape).body.elements
    const panelText = list[0]?.elements[0]?.content ?? ''
    const bodyText = list[1]?.content ?? ''

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
    const bodyText = list[1]?.content ?? ''
    expect(bodyText).toContain('已截断')
    expect(bodyText.length).toBeLessThan(40_000)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES)
  })

  it('caps pathological caller-supplied activity lines so the hard cap still holds', () => {
    const card = buildCard(baseState({
      status: 's'.repeat(40_000),
      tool: 't'.repeat(40_000),
      body: '答案',
    }))
    const list = (card as unknown as CardShape).body.elements
    // panel, status, tool, body — the activity lines are defensively clipped.
    expect(list[1]?.text_size).toBe('notation')
    expect((list[1]?.content ?? '').length).toBeLessThan(1_000)
    expect((list[2]?.content ?? '').length).toBeLessThan(1_000)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES)
  })

  it('passes short content through untouched', () => {
    const card = buildCard(baseState({ reasoning: '想想', body: '答' }))
    const list = (card as unknown as CardShape).body.elements
    expect(list[0]?.elements[0]?.content).toBe('想想')
    expect(list[1]?.content).toBe('答')
  })

  it('renders the continuation variant: segment header only, no panel and no footer', () => {
    const card = buildCard(baseState({ phase: 'done', body: '分段正文' }), { segment: 2 }) as unknown as CardShape
    const list = card.body.elements
    expect(tags(list)).toEqual(['markdown', 'markdown'])
    expect(list[0]?.text_size).toBe('notation')
    expect(list[0]?.content).toBe('📄 回复分段 2')
    expect(list[1]?.content).toBe('分段正文')
  })
})

describe('reasoning panel budget (5 KB cap)', () => {
  /** The rendered fold-panel markdown of a built card. */
  function panelMarkdown(card: object): string {
    const list = (card as unknown as CardShape).body.elements
    return list[0]?.elements?.[0]?.content ?? ''
  }

  it('caps the panel window at 5 KB and keeps it independent of the body', () => {
    expect(REASONING_MAX_BYTES).toBe(5_000)
    const reasoning = 'r'.repeat(40_000)
    const small = buildCard(baseState({ phase: 'replying', reasoning, body: '答' }))
    const large = buildCard(baseState({ phase: 'replying', reasoning, body: 'b'.repeat(20_000) }))

    // The panel neither yields space to the growing body nor borrows any.
    expect(panelMarkdown(small)).toBe(panelMarkdown(large))
    expect(escapedJsonBytes(panelMarkdown(large))).toBeLessThanOrEqual(REASONING_MAX_BYTES)
    expect(panelMarkdown(large)).toContain('r'.repeat(4_000))
    expect(cardJsonBytes(small)).toBeLessThanOrEqual(CARD_TARGET_BYTES)
    expect(cardJsonBytes(large)).toBeLessThanOrEqual(CARD_TARGET_BYTES)
  })

  it('passes reasoning inside the cap through untouched', () => {
    const reasoning = '推'.repeat(1_600)
    const card = buildCard(baseState({ phase: 'replying', reasoning }))

    expect(panelMarkdown(card)).toBe(reasoning)
    expect(escapedJsonBytes(reasoning)).toBeLessThanOrEqual(REASONING_MAX_BYTES)
  })

  it('clips overflowing reasoning to the cap and marks it', () => {
    // Visible windows at the cap: ASCII ≈4.96 K chars, CJK ≈1.65 K, 🤔 ≈1.24 K.
    for (const [chunk, minChars] of [['r', 4_000], ['推', 1_500], ['🤔', 2_400]] as const) {
      const panel = panelMarkdown(buildCard(baseState({ phase: 'replying', reasoning: chunk.repeat(20_000) })))
      expect(panel.endsWith(TRUNCATION_SUFFIX)).toBe(true)
      expect(panel).toContain(chunk)
      expect(escapedJsonBytes(panel)).toBeLessThanOrEqual(REASONING_MAX_BYTES)
      // The window stays useful instead of collapsing to the bare marker.
      expect(panel.replace(TRUNCATION_SUFFIX, '').length).toBeGreaterThanOrEqual(minChars)
    }
  })

  it('keeps a frozen main-card segment inside the target when its panel fills up', () => {
    const split = segmentCardContent(baseState({ body: 'x'.repeat(200_000) }))
    const frozen = buildCard(baseState({ phase: 'error', body: split.head, reasoning: '推'.repeat(40_000) }))

    expect(split.tail).not.toBe('')
    // The main-card probe budgets the panel's full window and the settled
    // footer, so a panel that keeps growing after the split still fits.
    expect(cardJsonBytes(frozen)).toBeLessThanOrEqual(CARD_TARGET_BYTES)
  })

  it('lets continuation cards use the whole budget (no panel reserve)', () => {
    const split = segmentCardContent(baseState({ body: 'x'.repeat(200_000) }), { segment: 2 })
    // The old card-wide reserve held continuation bodies back by ~5.5 KB.
    expect(split.head.length).toBeGreaterThan(27_000)
    expect(cardJsonBytes(buildCard(baseState({ body: split.head }), { segment: 2 })))
      .toBeLessThanOrEqual(CARD_TARGET_BYTES)
  })

  it('still clips a pathological body to the hard cap with a full panel', () => {
    const card = buildCard(baseState({ body: 'y'.repeat(300_000), reasoning: 'r'.repeat(40_000) }))
    const list = (card as unknown as CardShape).body.elements
    const body = list[1]?.content ?? ''

    expect(body).toContain('已截断')
    expect(escapedJsonBytes(panelMarkdown(card))).toBeLessThanOrEqual(REASONING_MAX_BYTES)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES)
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

  it('never splits inside a fenced code block that straddles the ceiling', () => {
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

  it('never splits inside a fenced code block that sits below the ceiling', () => {
    // The fence closes before the ceiling, but the last paragraph break lies
    // inside it: the breakpoint must fall back to the fence start.
    const body = 'a'.repeat(16_000) + '\n\n```js\n' + 'c'.repeat(900) + '\n\n'
      + 'd'.repeat(900) + '\n```\n' + 'z'.repeat(4_200)

    const split = splitBodyForCard(body, 22_000)
    expect((split.head.match(/^[ \t]*```/gm) ?? [])).toHaveLength(0)
    expect(split.head).toBe('a'.repeat(16_000))
    expect(split.tail.startsWith('```js')).toBe(true)
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

describe('buildInterruptionCard', () => {
  it('renders the minimal interruption notice', () => {
    const card = buildInterruptionCard() as unknown as CardShape
    expect(card.schema).toBe('2.0')
    expect(card.config.width_mode).toBe('fill')
    expect(tags(card.body.elements)).toEqual(['markdown'])
    expect(card.body.elements[0]?.content).toBe(INTERRUPTION_NOTICE)
  })

  it('keeps the segment header on repaired continuation cards', () => {
    const card = buildInterruptionCard({ segment: 2 }) as unknown as CardShape
    expect(tags(card.body.elements)).toEqual(['markdown', 'markdown'])
    expect(card.body.elements[0]?.content).toBe('📄 回复分段 2 · 回复中断')
    expect(card.body.elements[1]?.content).toBe(INTERRUPTION_NOTICE)
  })
})

describe('buildOnboardingCard', () => {
  it('renders the welcome text and command cheat sheet', () => {
    const card = buildOnboardingCard() as unknown as CardShape
    expect(card.schema).toBe('2.0')
    const all = card.body.elements.map(element => element.content ?? '').join('\n')
    expect(all).toContain('欢迎使用飞书 DSH')
    expect(all).toContain('常用命令')
    expect(all).toContain('/status')
  })
})

describe('approval decision cards', () => {
  const question: ApprovalQuestion = {
    token: 'tok-1',
    toolName: 'bash',
    reason: '需要写入工作区外的文件',
    timeoutMs: 300_000,
    sessionId: 'sess-1',
  }

  function approvalElements(card: object): Array<Record<string, any>> {
    return (card as unknown as CardShape).body.elements
  }

  function markdownsOf(card: object): string[] {
    return approvalElements(card)
      .filter(element => element.tag === 'markdown')
      .map(element => element.content as string)
  }

  function buttonsOf(card: object): Array<Record<string, any>> {
    const row = approvalElements(card).find(element => element.tag === 'column_set')
    return row?.columns.flatMap((column: Record<string, any>) =>
      column.elements.filter((element: Record<string, any>) => element.tag === 'button')) ?? []
  }

  function notationMarkdownsOf(card: object): string[] {
    return approvalElements(card)
      .filter(element => element.tag === 'markdown' && element.text_size === 'notation')
      .map(element => element.content as string)
  }

  it('renders the 2.0 structure with question summary and two enabled callback buttons', () => {
    const card = buildApprovalCard(question) as unknown as CardShape
    expect(card.schema).toBe('2.0')
    expect(card.config.width_mode).toBe('fill')
    expect(approvalElements(card).map(element => element.tag)).toEqual([
      'markdown', 'markdown', 'markdown', 'hr', 'markdown', 'markdown', 'column_set',
    ])

    const markdowns = markdownsOf(card)
    expect(markdowns[0]).toContain('需要你的审批')
    expect(markdowns[1]).toContain('bash')
    // The reason renders as its own blockquote markdown line.
    expect(markdowns[2]).toBe('> 需要写入工作区外的文件')
    expect(markdowns[3]).toContain('5 分钟')
    expect(markdowns[3]).toContain('超时自动拒绝')
    expect(markdowns[4]).toContain('sess-1')

    const actionRow = approvalElements(card).at(-1)!
    expect(actionRow.tag).toBe('column_set')
    expect(actionRow.flex_mode).toBe('bisect')
    expect(actionRow.horizontal_spacing).toBe('medium')
    expect(actionRow.columns).toHaveLength(2)
    expect(actionRow.columns.every((column: Record<string, any>) =>
      column.tag === 'column' && column.width === 'weighted' && column.weight === 1,
    )).toBe(true)

    const [allow, deny] = buttonsOf(card)
    expect(allow!.text.content).toBe('✅ 允许')
    expect(allow!.type).toBe('primary')
    expect(allow!.width).toBe('fill')
    expect(allow!.behaviors).toEqual([{ type: 'callback', value: { decision: 'allow', token: 'tok-1' } }])
    expect(deny!.text.content).toBe('❌ 拒绝')
    expect(deny!.type).toBe('danger')
    expect(deny!.width).toBe('fill')
    expect(deny!.behaviors).toEqual([{ type: 'callback', value: { decision: 'deny', token: 'tok-1' } }])

    expect(notationMarkdownsOf(card)).toContain(markdowns[3]!)
  })

  it('omits the reason blockquote and session line when absent', () => {
    const card = buildApprovalCard({ token: 'tok-1', toolName: 'pwsh', timeoutMs: 60_000 })
    const markdowns = markdownsOf(card)
    expect(markdowns.join('\n')).not.toContain('sess-')
    expect(markdowns.some(text => text.startsWith('> '))).toBe(false)
    expect(notationMarkdownsOf(card)).toEqual([
      expect.stringContaining('1 分钟'),
    ])
  })

  it('adds the owner-only notice when requested', () => {
    const card = buildApprovalCard(question, { unauthorizedNote: true })
    const notices = notationMarkdownsOf(card)
    expect(notices).toHaveLength(3)
    expect(notices.some(content => content.includes('仅发起该会话的用户'))).toBe(true)
  })

  it('clips a pathological reason and stays far under the 30 KB cap', () => {
    const huge = buildApprovalCard({
      token: 'tok-1',
      toolName: 'bash',
      reason: 'x'.repeat(50_000),
      timeoutMs: 300_000,
    })
    expect(cardJsonBytes(huge)).toBeLessThanOrEqual(CARD_MAX_BYTES)
    expect(cardJsonBytes(huge)).toBeLessThan(5_000)
  })

  it.each([
    ['allowed', '已允许执行'],
    ['denied', '已拒绝'],
    ['expired', '已超时'],
    ['cancelled', '已取消'],
  ] as const)('renders the %s settled variant without decision controls', (state, expected) => {
    const card = buildApprovalSettledCard(question, state) as unknown as CardShape
    expect(markdownsOf(card)[0]).toContain(expected)
    expect(buttonsOf(card)).toHaveLength(0)
    expect(approvalElements(card).some(element => element.tag === 'column_set')).toBe(false)
    // The settled card keeps the question summary for context.
    expect(markdownsOf(card).some(text => text.includes('bash'))).toBe(true)
  })
})

type Element = Record<string, unknown>

function elementsOf(card: object): Element[] {
  return (card as { body: { elements: Element[] } }).body.elements
}

function buttonsOf(card: object): Element[] {
  const out: Element[] = []
  const walk = (elements: Element[]): void => {
    for (const element of elements) {
      if (element.tag === 'button') out.push(element)
      for (const column of (element.columns as Array<{ elements: Element[] }> | undefined) ?? []) walk(column.elements)
    }
  }
  walk(elementsOf(card))
  return out
}

function buttonLabel(button: Element): string | undefined {
  return (button.text as { content?: string } | undefined)?.content
}

function buttonValue(button: Element): unknown {
  return (button.behaviors as Array<{ value: unknown }>)[0]!.value
}

describe('streaming card stop button', () => {
  it('renders an enabled stop button after the body while ready', () => {
    const elements = elementsOf(buildCard(baseState({ phase: 'replying', body: '正文', stop: 'ready' })))
    const index = elements.findIndex(element => element.tag === 'button')
    expect(index).toBe(elements.length - 1)
    expect(elements[index - 1]).toMatchObject({ tag: 'markdown', content: '正文' })
    expect(buttonLabel(elements[index]!)).toBe('⏹ 停止')
    expect(elements[index]!.disabled).toBeUndefined()
    expect(buttonValue(elements[index]!)).toEqual({ decision: STOP_ACTION })
  })

  it('disables the button while stopping and adds the owner-only notice when denied', () => {
    const card = buildCard(baseState({ phase: 'replying', stop: 'stopping', stopDenied: true }))
    const [button] = buttonsOf(card)
    expect(buttonLabel(button!)).toBe('正在停止…')
    expect(button!.disabled).toBe(true)
    expect(JSON.stringify(card)).toContain('仅发起该会话的用户可停止')
  })

  it('omits the button without a stop control', () => {
    expect(buttonsOf(buildCard(baseState({ phase: 'done', body: 'x' })))).toHaveLength(0)
  })

  it('leaves the button off the first frame', () => {
    expect(buttonsOf(initialStreamingCard('sess-1'))).toHaveLength(0)
  })

  it('settles a stopped turn with its own panel title and the footer', () => {
    const card = buildCard(baseState({ phase: 'stopped', reasoning: '想了想', body: '' }))
    const json = JSON.stringify(card)
    expect(json).toContain(PANEL_TITLES.stopped)
    expect(json).toContain('已按请求停止本轮回复')
    expect(json).toContain('本次无正文输出')
    expect(json).toContain('缓存命中')
  })

  it('keeps a split continuation head within the target budget with the button', () => {
    const body = 'x'.repeat(40_000)
    const options = { segment: 2 }
    const split = segmentCardContent(baseState({ phase: 'replying', body }), options)
    const card = buildCard(baseState({ phase: 'replying', body: split.head, stop: 'stopping', stopDenied: true }), options)
    expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_TARGET_BYTES)
  })
})

describe('command picker cards', () => {
  const input = {
    title: '🧠 模型',
    command: 'model' as const,
    text: '**当前模型**：`a`',
    sessionId: 'sess-pick',
    options: [{ label: 'a', arg: 'a' }, { label: 'b', arg: 'b' }, { label: 'c', arg: 'c' }],
    current: 'a',
  }

  it('renders the choices in two-column rows with the current one highlighted', () => {
    const card = buildPickerCard(input)
    const rows = elementsOf(card).filter(element => element.tag === 'column_set')
    expect(rows).toHaveLength(2)
    const buttons = buttonsOf(card)
    expect(buttons.map(buttonLabel)).toEqual(['✅ a', 'b', 'c'])
    expect(buttons[0]!.type).toBe('primary')
    expect(buttonValue(buttons[1]!)).toEqual({ decision: PICK_ACTION, command: 'model', arg: 'b', sessionId: 'sess-pick' })
    expect(JSON.stringify(card)).toContain('仅发起该会话的用户可操作')
  })

  it('adds a reset button on request', () => {
    const buttons = buttonsOf(buildPickerCard({ ...input, reset: true }))
    expect(buttonLabel(buttons.at(-1)!)).toBe('恢复默认')
    expect(buttonValue(buttons.at(-1)!)).toMatchObject({ arg: 'reset' })
  })

  it('skips arguments that are not one token and reports the overflow', () => {
    const options = [
      { label: 'bad', arg: 'two words' },
      ...Array.from({ length: MAX_PICKER_OPTIONS + 2 }, (_, index) => ({ label: `m${index}`, arg: `m${index}` })),
    ]
    const card = buildPickerCard({ ...input, options })
    expect(buttonsOf(card)).toHaveLength(MAX_PICKER_OPTIONS)
    expect(buttonsOf(card).map(buttonLabel)).not.toContain('bad')
    expect(JSON.stringify(card)).toContain('另有 2 项未展示')
  })

  it('parses only well-formed picker values', () => {
    const value = { decision: PICK_ACTION, command: 'effort', arg: 'high', sessionId: 's' }
    expect(parsePickAction(value)).toEqual(value)
    expect(parsePickAction(undefined)).toBeUndefined()
    expect(parsePickAction({ ...value, decision: STOP_ACTION })).toBeUndefined()
    expect(parsePickAction({ ...value, command: 'renew' })).toBeUndefined()
    expect(parsePickAction({ ...value, arg: 'a b' })).toBeUndefined()
    expect(parsePickAction({ ...value, arg: 1 })).toBeUndefined()
    expect(parsePickAction({ ...value, sessionId: '' })).toBeUndefined()
  })
})
