/**
 * Feishu card JSON 2.0 renderer for the three-section streaming card.
 *
 * The card uses the CURRENT 2.0 structure (`schema: "2.0"` + `body.elements`),
 * which is required for full rich-text markdown (headings, blockquotes,
 * tables, code fences) and is the shape the official Lark bot extensions
 * ship today.
 *
 * Layout (top → bottom), panel card (default):
 *  1. `collapsible_panel` — bordered, default-collapsed reasoning panel. The
 *     header title carries the three phases (推理中 / 回复中 / 回复结束) and a
 *     right-aligned built-in chevron (`standard_icon`, no upload needed) that
 *     rotates 180° when expanded (`icon_expanded_angle`).
 *  2. `markdown` — the reply body (rich text).
 *  3. two `markdown` lines in `notation` text size — session info:
 *     line 1: session id · input token · output token   (session cumulative)
 *     line 2: model(effort) · cache hit · context
 *
 * Layout, continuation card (`options.panel: false` — body segments that do
 * not fit the first card):
 *  1. `markdown` in `notation` size — `📄 回复分段 {n} · {phase}` header.
 *  2. `markdown` — this segment's body.
 *  3. the same two session-info lines.
 *
 * Size budget: Feishu caps one card's JSON at 30 KB (`CARD_MAX_BYTES`). While
 * streaming, cards are kept ≤ `CARD_TARGET_BYTES` (28 KB), leaving 2 KB of
 * headroom for stats-line growth between the split and the final patch. The
 * body has priority over reasoning: the body is never silently dropped by
 * this module — callers split it with `segmentCardContent` (probed at the
 * worst-case phase) — while reasoning is clipped to the remaining budget. A
 * body clip exists only as an absolute last resort at the 30 KB hard cap.
 *
 * Pure functions only — no I/O, no host imports (Node's ambient `TextEncoder`
 * is used for UTF-8 byte measurement).
 *
 * @module dsh-channels/cards
 */

export type PanelPhase = 'thinking' | 'replying' | 'done'

export const PANEL_TITLES: Record<PanelPhase, string> = {
  thinking: '推理中',
  replying: '回复中',
  done: '回复结束',
}

/** Built-in icon token for the fold-panel chevron (from the official component docs). */
export const PANEL_CHEVRON_TOKEN = 'down-small-ccm_outlined'

/** Feishu hard cap for one card message body. */
export const CARD_MAX_BYTES = 30_000
/** Target budget per card — 2 KB below the hard cap as headroom. */
export const CARD_TARGET_BYTES = 28_000
/**
 * Feishu hard-limits the number of markdown tables a single card may contain
 * (API error 11310 "card table number over limit"; verified on device: the
 * platform allows 5). Segmentation therefore keeps at most 5 tables per card.
 */
export const MAX_TABLES_PER_CARD = 5

/** Appended to clipped reasoning (and, as an absolute last resort, clipped body). */
export const TRUNCATION_SUFFIX = '\n\n…（内容过长，已截断）'

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

/** Rendering variants. */
export interface CardOptions {
  /** Render the reasoning fold panel (default `true`). Continuation segment
   *  cards pass `false` and get a segment header instead. */
  panel?: boolean
  /** 1-based segment number shown in the continuation header. */
  segment?: number
}

/** The result of splitting a body for one card. `head` + `tail` re-join to the
 *  original body except for blank-line separators at the cut. */
export interface BodySplit {
  /** Body prefix that fits one card (cut at a clean breakpoint). */
  head: string
  /** Remainder to flow into the next segment card ('' when everything fits). */
  tail: string
}

/** UTF-8 byte size of a card's JSON — the metric behind Feishu's 30 KB cap. */
export function cardJsonBytes(card: object): number {
  return new TextEncoder().encode(JSON.stringify(card)).length
}

/** A contiguous run of markdown table lines; `end` is exclusive. */
export interface TableBlock {
  start: number
  end: number
}

/**
 * Locate markdown table blocks: runs of ≥ 2 consecutive lines that start with
 * `|` and contain a second `|` (outside fenced code blocks). Feishu renders
 * each such run as a `table` element and hard-limits their count per card
 * (error 11310), so tables are the atomic unit for segmentation.
 */
export function tableBlocks(body: string): TableBlock[] {
  const blocks: TableBlock[] = []
  let inFence = false
  let runStart = -1
  let runEnd = -1
  let runLines = 0
  let offset = 0
  for (const line of body.split('\n')) {
    const fence = /^[ \t]*```/.test(line)
    const pipeLine = !inFence && /^[ \t]*\|[^\n]*\|/.test(line)
    if (fence) inFence = !inFence
    if (pipeLine) {
      if (runLines === 0) runStart = offset
      runEnd = offset + line.length
      runLines++
    } else if (runLines > 0) {
      if (runLines >= 2) blocks.push({ start: runStart, end: runEnd })
      runStart = -1
      runLines = 0
    }
    offset += line.length + 1
  }
  if (runLines >= 2) blocks.push({ start: runStart, end: runEnd })
  return blocks
}

/**
 * Replace markdown table blocks with a placeholder. Used for the reasoning
 * panel, whose content is auxiliary (truncation has no impact) and is never
 * segmented — this keeps panel tables from tripping the per-card table cap.
 */
export function stripTables(text: string): string {
  const blocks = tableBlocks(text)
  if (blocks.length === 0) return text
  let out = ''
  let position = 0
  for (const block of blocks) {
    out += text.slice(position, block.start)
    if (out !== '' && !out.endsWith('\n')) out += '\n'
    out += '*（表格已省略）*'
    position = block.end
  }
  out += text.slice(position)
  return out
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

function reasoningPlaceholder(phase: PanelPhase): string {
  return phase === 'thinking' ? '*等待模型输出…*' : '*（本次无推理内容）*'
}

function bodyPlaceholder(phase: PanelPhase): string {
  return phase === 'done' ? '*（本次无正文输出）*' : '*正在生成…*'
}

/** Continuation header: `📄 回复分段 {n} · {phase}` (or 续上一条卡片 without a number). */
function segmentHeader(options: CardOptions, phase: PanelPhase): string {
  const seg = options.segment
  const title = seg === undefined ? '续上一条卡片' : `回复分段 ${seg}`
  return `📄 ${title} · ${PANEL_TITLES[phase]}`
}

/** Raw card assembly — no clipping of any kind (the budget machinery wraps this). */
function assemble(
  phase: PanelPhase,
  reasoning: string,
  body: string,
  stats: CardStats,
  options: CardOptions,
): object {
  const elements: object[] = []

  if (options.panel ?? true) {
    const panelReasoning = stripTables(reasoning)
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      border: { color: 'grey', corner_radius: '8px' },
      header: {
        title: { tag: 'plain_text', content: PANEL_TITLES[phase] },
        icon: { tag: 'standard_icon', token: PANEL_CHEVRON_TOKEN },
        icon_position: 'right',
        icon_expanded_angle: 180,
      },
      elements: [
        { tag: 'markdown', content: panelReasoning.trim() === '' ? reasoningPlaceholder(phase) : panelReasoning },
      ],
    })
  } else {
    elements.push({ tag: 'markdown', content: segmentHeader(options, phase), text_size: 'notation' })
  }

  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: body.trim() === '' ? bodyPlaceholder(phase) : body })
  elements.push({ tag: 'hr' })
  elements.push({ tag: 'markdown', content: buildSessionLine(stats), text_size: 'notation' })
  elements.push({ tag: 'markdown', content: buildModelLine(stats), text_size: 'notation' })

  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: { elements },
  }
}

/**
 * Fit `text` into a byte budget: return `text` unchanged when the rendered
 * card already fits; otherwise binary-search the longest prefix that still
 * fits once `suffix` is appended. The result is guaranteed to render within
 * `budget`.
 */
function clipText(text: string, suffix: string, render: (content: string) => object, budget: number): string {
  if (cardJsonBytes(render(text)) <= budget) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (cardJsonBytes(render(text.slice(0, mid) + suffix)) <= budget) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return text.slice(0, lo) + suffix
}

/** JSON-escaped UTF-8 size of the truncation marker — reserved so clips can
 *  never push a card past the hard cap. */
const SUFFIX_JSON_BYTES = new TextEncoder().encode(JSON.stringify(TRUNCATION_SUFFIX)).length

/**
 * Build one card. Budget priority: the body wins.
 *
 * - Reasoning is clipped so the card stays ≤ `CARD_TARGET_BYTES` while it
 *   streams — it yields space to the growing body. Only when the body alone
 *   already drifts past the target (stats growth between the split and the
 *   final patch) does the reasoning budget relax to the hard cap, keeping the
 *   card sendable.
 * - The body is clipped only when it alone would exceed `CARD_MAX_BYTES`, the
 *   point where Feishu rejects the whole card. The streamer pre-splits with
 *   `segmentCardContent` (probed at the worst-case phase), so a live stream
 *   never reaches this: it is a pure guard for direct callers.
 *
 * Guarantee: the returned card is always ≤ `CARD_MAX_BYTES`; it is ≤
 * `CARD_TARGET_BYTES` whenever the body fits the target budget.
 */
export function buildCard(state: CardState, options: CardOptions = {}): object {
  const render = (reasoning: string, body: string) =>
    assemble(state.phase, reasoning, body, state.stats, options)

  const body = clipText(state.body, TRUNCATION_SUFFIX, content => render('', content), CARD_MAX_BYTES - SUFFIX_JSON_BYTES)
  const reasoningBudget = cardJsonBytes(render('', body)) <= CARD_TARGET_BYTES
    ? CARD_TARGET_BYTES
    : CARD_MAX_BYTES - SUFFIX_JSON_BYTES
  const reasoning = clipText(state.reasoning, TRUNCATION_SUFFIX, content => render(content, body), reasoningBudget)
  return render(reasoning, body)
}

/**
 * Largest body prefix (char count) whose card renders ≤ `CARD_TARGET_BYTES`
 * with reasoning minimized — i.e. the body gets the full card budget. The
 * probe renders at phase `done`, the worst case (its panel/segment header
 * titles are the longest), so a frozen segment can never outgrow the budget
 * merely by the phase flipping 回复中 → 回复结束. Stats growth between the
 * split and the final patch consumes the 2 KB redundancy (`CARD_MAX_BYTES` −
 * `CARD_TARGET_BYTES`).
 */
function largestBodyPrefix(state: CardState, options: CardOptions): number {
  const text = state.body
  const render = (content: string) => assemble('done', '', content, state.stats, options)
  if (cardJsonBytes(render(text)) <= CARD_TARGET_BYTES) return text.length
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (cardJsonBytes(render(text.slice(0, mid))) <= CARD_TARGET_BYTES) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return lo
}

/**
 * Split a body at a clean breakpoint so `head` fits one card:
 *  1. the head holds at most `maxTables` whole markdown tables — the boundary
 *     is capped at the first excess table (Feishu rejects cards with more);
 *  2. never inside a fenced code block (pull the boundary back before the fence);
 *  3. never inside a table block (a breakpoint that would land inside one is
 *     moved to its start);
 *  4. then the clean-breakpoint tiers: paragraph blank line → `#` heading line
 *     → line break → hard cut as the escape hatch.
 */
export function splitBodyForCard(body: string, maxChars: number, maxTables: number = MAX_TABLES_PER_CARD): BodySplit {
  const tables = tableBlocks(body)
  if (body.length <= maxChars && tables.length <= maxTables) {
    return { head: body, tail: '' }
  }

  let limit = maxChars

  // 1. Table-count ceiling: the head may hold at most `maxTables` tables, so
  //    never extend past the boundary right before the first excess table.
  const firstExcess = tables[maxTables]
  if (firstExcess !== undefined) {
    limit = Math.min(limit, firstExcess.start)
  }

  // 2. Never cut inside a fenced code block straddling the ceiling.
  const fencePattern = /^[ \t]*```[^\n]*$/gm
  let fenceStart = -1
  let inside = false
  for (const match of body.matchAll(fencePattern)) {
    const index = match.index ?? 0
    if (!inside) {
      if (index >= limit) break
      inside = true
      fenceStart = index
    } else if (index >= limit) {
      // The block opened before the ceiling and closes after it: move the
      // boundary to just before the opening fence (unless it starts at 0).
      if (fenceStart > 0) limit = fenceStart
      break
    } else {
      inside = false
    }
  }
  if (inside && fenceStart > 0 && fenceStart < limit) limit = fenceStart

  // 3. Never cut inside a table block straddling the ceiling (pull the
  //    boundary back to its start; a table beginning the body is left to the
  //    hard-cut escape hatch).
  for (const block of tables) {
    if (block.start >= limit) break
    if (block.end > limit) {
      if (block.start > 0) limit = block.start
      break
    }
  }

  /** Move a cut position out of any table block (to just before it). */
  const avoidTables = (at: number): number => {
    for (const block of tables) {
      if (block.start >= at) break
      if (at <= block.end && block.start > 0) return block.start
    }
    return at
  }

  const window = body.slice(0, limit)
  const cut = (at: number): BodySplit => ({
    head: body.slice(0, at).replace(/\s+$/u, ''),
    tail: body.slice(at).replace(/^\n+/u, ''),
  })

  // Preferred breakpoints scanning back from the ceiling; only accept one that
  // keeps the card reasonably full, else fall through to the next tier.
  const minFill = Math.floor(limit * 0.7)

  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph >= minFill) return cut(avoidTables(paragraph + 2))

  let heading = -1
  for (const match of window.matchAll(/^#{1,6} .*$/gm)) {
    const start = match.index ?? 0
    heading = start === 0 ? 0 : start - 1
  }
  if (heading >= minFill) return cut(avoidTables(heading))

  const line = window.lastIndexOf('\n')
  if (line >= minFill) return cut(avoidTables(line + 1))

  return { head: body.slice(0, avoidTables(limit)), tail: body.slice(avoidTables(limit)) }
}

/**
 * How the accumulated body should be laid out for one card: everything that
 * fits (clean breakpoint) plus the remainder for the next segment card.
 * `head` re-renders within `CARD_TARGET_BYTES`; the body is never dropped.
 */
export function segmentCardContent(state: CardState, options: CardOptions = {}): BodySplit {
  return splitBodyForCard(state.body, largestBodyPrefix(state, options))
}
