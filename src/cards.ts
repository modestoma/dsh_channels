/**
 * Feishu card 2.0 JSON renderer for the three-section streaming card.
 *
 * Layout (top → bottom):
 *  1. `collapsible_panel` — bordered, default-collapsed reasoning panel. The
 *     header title carries the three phases (推理中 / 回复中 / 回复结束) and a
 *     right-aligned chevron icon that rotates 180° when expanded
 *     (`icon_expanded_angle`), i.e. down when folded, up when expanded.
 *  2. `markdown` — the reply body (rich text).
 *  3. `note` — two small-print lines of session info:
 *     line 1: session id · input token · output token   (session cumulative)
 *     line 2: model(effort) · cache hit · context
 *
 * Pure functions only — no I/O, no host imports.
 *
 * @module dsh-channels/cards
 */

export type PanelPhase = 'thinking' | 'replying' | 'done'

export const PANEL_TITLES: Record<PanelPhase, string> = {
  thinking: '推理中',
  replying: '回复中',
  done: '回复结束',
}

/** Session-scoped figures rendered on the info lines. */
export interface CardStats {
  /** DSH session id. */
  sessionId: string
  /** Cumulative uncached input tokens of the whole session. */
  inputTokens: number
  /** Cumulative output tokens of the whole session. */
  outputTokens: number
  /** Cache hit ratio of the latest provider sample, 0–1; undefined → `—`. */
  cacheHitPct?: number
  /** Latest provider-reported prompt pressure in tokens; undefined → `—`. */
  contextTokens?: number
  /** Model context window in tokens; undefined → `—`. */
  contextWindow?: number
  /** Model id (latest request header). */
  model?: string
  /** Reasoning effort (latest request header). */
  effort?: string
}

export interface CardState {
  phase: PanelPhase
  /** Raw reasoning text accumulated so far (may be empty). */
  reasoning: string
  /** Reply body accumulated so far (may be empty). */
  body: string
  stats: CardStats
}

/** Absolute caps keep the whole card well below Feishu's 30 KB limit. */
export const REASONING_MAX_CHARS = 13_000
export const BODY_MAX_CHARS = 11_000

export const TRUNCATION_SUFFIX = '\n\n…（内容过长，已截断）'

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${TRUNCATION_SUFFIX}`
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtContext(tokens?: number, window?: number): string {
  if (tokens === undefined) return '—'
  if (window === undefined) return `${fmt(tokens)} tokens`
  return `${fmt(tokens)} / ${fmt(window)}`
}

function fmtCacheHit(pct?: number): string {
  return pct === undefined ? '—' : `${(pct * 100).toFixed(1)}%`
}

/** Info line 2: `icon - 模型 {model}({effort}) · icon - 缓存命中 {cache} · icon - 上下文 {context}` */
function buildModelLine(stats: CardStats): string {
  const model = stats.model ?? '—'
  const effort = stats.effort !== undefined && stats.effort !== '' ? `(${stats.effort})` : ''
  return `🧠 模型 ${model}${effort} · ⚡ 缓存命中 ${fmtCacheHit(stats.cacheHitPct)} · 📊 上下文 ${fmtContext(stats.contextTokens, stats.contextWindow)}`
}

/** Info line 1: `icon - {session id} · icon - input token {input_token} · icon - output token {output_token}` */
function buildSessionLine(stats: CardStats): string {
  return `🔑 ${stats.sessionId} · ⬆ input token ${fmt(stats.inputTokens)} · ⬇ output token ${fmt(stats.outputTokens)}`
}

export interface ChevronIcon {
  /** img_key of the uploaded chevron icon, or undefined to omit the icon. */
  imgKey?: string
}

/** The raw markdown content sent into the reasoning panel. */
export function reasoningContent(reasoning: string, phase: PanelPhase): string {
  if (reasoning.trim() === '') {
    return phase === 'thinking' ? '_等待模型输出…_' : '_（本次无推理内容）_'
  }
  return clip(reasoning, REASONING_MAX_CHARS)
}

export function bodyContent(body: string, phase: PanelPhase): string {
  if (body.trim() === '') {
    return phase === 'done' ? '_（本次无正文输出）_' : '_正在生成…_'
  }
  return clip(body, BODY_MAX_CHARS)
}

/**
 * Assemble the complete card JSON for one streaming snapshot.
 *
 * NOTE: the root object deliberately carries NO `schema` field. Feishu's
 * current parser treats a card whose root declares `schema: "2.0"` as the
 * new-schema format and then rejects the classic top-level `elements` key
 * (`230099 / 200621: unknown property, property: elements`). Omitting
 * `schema` selects the classic card JSON shape (`config` / `header` /
 * top-level `elements`) instead — the same shape the official Lark bot
 * extensions still use.
 */
export function buildCard(state: CardState, chevron: ChevronIcon = {}): object {
  const elements: object[] = []

  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: PANEL_TITLES[state.phase] },
    icon_position: 'right',
    icon_expanded_angle: 180,
  }
  if (chevron.imgKey !== undefined) {
    header.icon = { tag: 'img', img_key: chevron.imgKey, alt: { tag: 'plain_text', content: '' } }
  }

  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    border: { color: 'grey-200', corner_radius: '8px' },
    header,
    elements: [
      { tag: 'markdown', content: reasoningContent(state.reasoning, state.phase) },
    ],
  })

  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: bodyContent(state.body, state.phase) })
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: buildSessionLine(state.stats) },
      { tag: 'plain_text', content: buildModelLine(state.stats) },
    ],
  })

  return { elements }
}

export const CHEVRON_DOWN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR42mNIySr+T0vMMGrBqAWjFoxaMGrBqAWjFoxaMDQsAAANFBBMbtFu8QAAAABJRU5ErkJggg=='
