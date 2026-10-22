/**
 * Streaming reply card: the reasoning fold panel, the transient activity
 * lines, the reply body and the settled footer — plus the byte/table budgets
 * that keep one card inside Feishu's limits.
 *
 * Composition, main card:
 *
 *   [fold panel] [activity status] [activity tool] [body]
 *   [hr] [model · session · reasoning time]
 *   [context share · input · output · cache hit]
 *
 * - The panel shows the reasoning behind its own window. While the turn is
 *   still thinking it doubles as the phase indicator; once the turn settles
 *   without any reasoning content (non-reasoning models) it is omitted
 *   entirely instead of leaving an empty bordered box.
 * - The two activity lines are transient: the streamer only passes them for
 *   the card that is currently streaming, so frozen segment cards never repeat
 *   a stale "正在调用工具" line.
 * - The settled footer is a divider plus two notation lines and renders
 *   exactly once: on the main card, only after the turn settles. It carries
 *   the model/effort, session id and the turn's accumulated reasoning time
 *   (line 1), then the context pressure with its window share plus the
 *   input/output token counts and cache hit ratio (line 2). First frames
 *   therefore never show a row of zeroed counters.
 *
 * Continuation cards (`options.segment`) carry a segment header and the body;
 * they have no panel and no footer, so a long answer is not repeated chrome.
 *
 * The stop button follows the activity lines: the streamer only passes it for
 * the card that is currently streaming and drops it once the turn settles, so
 * a settled card never offers a control that can no longer act.
 *
 * Budgets, two independent ones:
 * - Each card is measured as a whole: segmentation targets `CARD_TARGET_BYTES`
 *   (main cards probe the panel at its maximum window, so reasoning that keeps
 *   growing after the split cannot push the card over), while `CARD_MAX_BYTES`
 *   is the platform hard cap used only by `buildCard` as an absolute guard.
 * - The reasoning panel is a fixed `REASONING_MAX_BYTES` window, clipped from
 *   the tail with a truncation marker. It neither competes with nor is squeezed
 *   by the reply body: the visible reasoning window is identical whether the
 *   answer is one line or a full segment.
 *
 * @module dsh-channels/cards/streaming
 */

import { card, divider, foldPanel, markdown, note, textButton } from './primitives.ts'

export type PanelPhase = 'thinking' | 'replying' | 'done' | 'stopped' | 'error'

export const PANEL_TITLES: Record<PanelPhase, string> = {
  thinking: '推理中',
  replying: '回复中',
  done: '回复结束',
  stopped: '已停止',
  error: '回复失败',
}

/** `decision` carried by the streaming card's stop button. */
export const STOP_ACTION = 'turn-stop'

/** `decision` carried by a queued card's "add to the current reply" button. */
export const STEER_ACTION = 'turn-steer'

/**
 * Stop control state on the streaming card: `ready` offers the button,
 * `stopping` shows it disabled after the owner clicked it.
 */
export type StopControl = 'ready' | 'stopping'

/** Built-in icon token for the fold-panel chevron (from the official component docs). */
export const PANEL_CHEVRON_TOKEN = 'down-small-ccm_outlined'

/** Feishu hard cap for one card message body. */
export const CARD_MAX_BYTES = 30_000
/** Target budget per card — 2 KB below the hard cap as headroom for the
 *  figures that keep growing between a segment split and the final patch. */
export const CARD_TARGET_BYTES = 28_000
/**
 * Cap for the reasoning fold panel's markdown (5 KB, JSON-escaped UTF-8,
 * including the truncation marker). The panel is clipped against this alone —
 * never against the card — so the visible reasoning window is the same whether
 * the reply is one line or a full segment. Visible window at the cap: ≈4.96 K
 * ASCII chars, ≈1.65 K CJK chars, ≈1.24 K emoji.
 */
export const REASONING_MAX_BYTES = 5_000
/**
 * Feishu hard-limits the number of markdown tables a single card may contain
 * (API error 11310 "card table number over limit"; verified on device: the
 * platform allows 5). Segmentation therefore keeps at most 5 tables per card.
 */
export const MAX_TABLES_PER_CARD = 5

/** Appended to clipped reasoning (and, as an absolute last resort, clipped body). */
export const TRUNCATION_SUFFIX = '\n\n…（内容过长，已截断）'

/** Session-scoped figures rendered on the settled card's footer. */
export interface CardStats {
  /** DSH session id. */
  sessionId: string
  /** Cumulative uncached input tokens of the whole session. */
  inputTokens: number
  /** Cumulative output tokens of the whole session. */
  outputTokens: number
  /** Cache hit ratio of the current turn's latest provider sample, 0–1; undefined → `—`. */
  cacheHitPct?: number
  /** Latest provider-reported prompt pressure in tokens; undefined → `—`. */
  contextTokens?: number
  /** Model context window in tokens; undefined → `—`. */
  contextWindow?: number
  /** Model id (current turn's latest request header). */
  model?: string
  /** Reasoning effort (current turn's latest request header). */
  effort?: string
  /**
   * Accumulated wall-clock time the turn spent in reasoning phases, in ms.
   * Each step's phase opens at its first reasoning delta and closes when that
   * step's output ends (first answer text or step end), so tool execution time
   * is never counted. Undefined when the turn produced no reasoning → `—`.
   */
  reasoningMs?: number
}

export interface CardState {
  phase: PanelPhase
  /** Raw reasoning text accumulated so far (may be empty). */
  reasoning: string
  /** Reply body accumulated so far (may be empty). */
  body: string
  /**
   * Transient delegation status (subagent/workflow progress, settled workflow
   * outcome, heartbeat elapsed) rendered as a notation line between the panel
   * and the body. The streamer only passes it for the card that is currently
   * streaming. Empty/undefined → omitted. Callers cap its length so it stays
   * inside the budget headroom.
   */
  status?: string
  /**
   * The parent agent's in-flight tool call, rendered as a notation line below
   * the status line. Independent of `status`: neither ever supersedes the
   * other. Same rule as `status` — only the actively streaming card renders it.
   * Empty/undefined → omitted.
   */
  tool?: string
  /**
   * Stop control for the actively streaming card. Same rule as `status`: the
   * streamer passes it only for the current card of an unsettled turn.
   * Undefined → no button.
   */
  stop?: StopControl
  /** Add the owner-only notice under the stop button (a non-owner clicked it). */
  stopDenied?: boolean
  /**
   * The message waits behind another turn of the same session: the main card
   * renders only the queue notice and the steer button, never the panel,
   * body or footer. Ignored on continuation cards.
   */
  queued?: boolean
  /** Add the owner-only notice under the steer button (a non-owner clicked it). */
  queuedDenied?: boolean
  stats: CardStats
}

/**
 * Rendering variant. Omitted → the main card (reasoning panel + settled
 * footer); a 1-based `segment` → a continuation card (segment header only).
 */
export interface CardOptions {
  /** 1-based continuation segment number. */
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

const encoder = new TextEncoder()

/** UTF-8 byte size of a card's JSON — the metric behind Feishu's 30 KB cap. */
export function cardJsonBytes(value: object): number {
  return encoder.encode(JSON.stringify(value)).length
}

/** JSON-escaped UTF-8 size of a string, as embedded in a card's JSON. */
function jsonBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).length
}

// ---- body primitives ------------------------------------------------------

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

/** Fenced code block ranges (opening fence line through the closing line). An
 *  unclosed fence extends to the end of the body. */
function codeFenceBlocks(body: string): TableBlock[] {
  const blocks: TableBlock[] = []
  let start = -1
  let offset = 0
  for (const line of body.split('\n')) {
    if (/^[ \t]*```/.test(line)) {
      if (start < 0) {
        start = offset
      } else {
        blocks.push({ start, end: offset + line.length })
        start = -1
      }
    }
    offset += line.length + 1
  }
  if (start >= 0) blocks.push({ start, end: body.length })
  return blocks
}

/**
 * Move a cut position out of any protected block (code fence or table) it
 * lands inside: the block is kept whole on the following card. A block that
 * starts at position 0 cannot be moved back (that would produce an empty
 * head), so that degenerate case is left to the hard-cut escape hatch.
 */
function avoidProtected(blocks: TableBlock[], at: number): number {
  for (const block of blocks) {
    if (block.start >= at) break
    if (at < block.end) return block.start > 0 ? block.start : at
  }
  return at
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

// ---- card content ---------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Context-window share: one decimal below 10%, a whole number from 10% up. */
function fmtContextPct(tokens: number, window: number): string {
  const pct = (tokens / window) * 100
  // Round first, then decide the precision, so 9.96% renders as `10%` (not
  // `10.0%`) and agrees with the integer branch.
  return `${Number(pct.toFixed(1)) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`
}

/** `上下文 3,618/1,000,000 (0.4%)`; without a usable window the share is omitted. */
function fmtContext(tokens?: number, window?: number): string {
  if (tokens === undefined) return '—'
  if (window === undefined || window <= 0) return `${fmt(tokens)} tokens`
  return `${fmt(tokens)}/${fmt(window)} (${fmtContextPct(tokens, window)})`
}

function fmtCacheHit(pct?: number): string {
  return pct === undefined ? '—' : `${(pct * 100).toFixed(1)}%`
}

/** `推理 3.2s` / `推理 1分5s`; `—` when the turn had no reasoning phase. */
function fmtReasoningTime(ms?: number): string {
  if (ms === undefined) return '—'
  const safe = Math.max(0, ms)
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`
  const total = Math.round(safe / 1000)
  return `${Math.floor(total / 60)}分${total % 60}s`
}

/**
 * Settled footer, line 1: 🧠 model/effort · 🔑 session id · ⏱ reasoning time.
 * Rendered once, after the turn settles, so live cards never flash a row of
 * zeroed counters.
 */
function buildModelLine(stats: CardStats): string {
  const model = stats.model ?? '—'
  const effort = stats.effort !== undefined && stats.effort !== '' ? `(${stats.effort})` : ''
  return `🧠 模型 ${model}${effort} · 🔑 会话 ${stats.sessionId} · ⏱ 推理 ${fmtReasoningTime(stats.reasoningMs)}`
}

/**
 * Settled footer, line 2: 📊 context pressure (counts + share) · 📩 input
 * tokens · 📨 output tokens · ⚡ cache hit ratio.
 */
function buildUsageLine(stats: CardStats): string {
  return `📊 上下文 ${fmtContext(stats.contextTokens, stats.contextWindow)}`
    + ` · 📩 输入 ${fmt(stats.inputTokens)} · 📨 输出 ${fmt(stats.outputTokens)} · ⚡ 缓存命中 ${fmtCacheHit(stats.cacheHitPct)}`
}

function reasoningPlaceholder(phase: PanelPhase): string {
  return phase === 'thinking' ? '*等待模型输出…*' : '*（本次无推理内容）*'
}

function bodyPlaceholder(phase: PanelPhase): string {
  return isSettled(phase) ? '*（本次无正文输出）*' : '*正在生成…*'
}

/** The panel's markdown: stripped of tables, with a placeholder when empty. */
function panelContent(phase: PanelPhase, reasoning: string): string {
  const stripped = stripTables(reasoning)
  return stripped.trim() === '' ? reasoningPlaceholder(phase) : stripped
}

/**
 * Whether the fold panel renders. `thinking` always does (it carries the
 * phase indicator while the card is otherwise empty); every later phase only
 * when there is actual reasoning to fold away — a settled non-reasoning turn
 * gets no empty bordered box.
 */
function panelShown(phase: PanelPhase, reasoning: string): boolean {
  return phase === 'thinking' || stripTables(reasoning).trim() !== ''
}

/** Continuation header: `📄 回复分段 {n}`. */
function segmentHeader(segment: number): string {
  return `📄 回复分段 ${segment}`
}

/** Interruption notice header for a repaired continuation card. */
function interruptionHeader(segment: number): string {
  return `📄 回复分段 ${segment} · 回复中断`
}

function isSettled(phase: PanelPhase): boolean {
  return phase === 'done' || phase === 'stopped' || phase === 'error'
}

/**
 * Defensive cap on caller-supplied activity lines. The streamer already clips
 * them to 64 chars; this bound keeps `buildCard`'s "always ≤ CARD_MAX_BYTES"
 * guarantee even for a direct caller that passes an unbounded line.
 */
const ACTIVITY_LINE_MAX_CHARS = 512

/** One caller-supplied notation line, defensively capped; undefined when empty. */
function activityNote(text: string | undefined): object | undefined {
  if (text === undefined || text === '') return undefined
  const clipped = text.length <= ACTIVITY_LINE_MAX_CHARS
    ? text
    : `${text.slice(0, ACTIVITY_LINE_MAX_CHARS - 1)}…`
  return note(clipped)
}

/** Main-card line of a turn that ended through a stop request. */
export const STOPPED_NOTICE = '⏹ 已按请求停止本轮回复'

/** The stop button plus its optional owner-only notice. */
function stopElements(stop: StopControl, denied: boolean): object[] {
  const elements: object[] = [textButton({
    label: stop === 'stopping' ? '正在停止…' : '⏹ 停止',
    type: 'default',
    width: 'default',
    margin: '8px 0 0 0',
    disabled: stop === 'stopping',
    value: { decision: STOP_ACTION },
  })]
  if (denied) elements.push(note('ℹ️ 仅发起该会话的用户可停止'))
  return elements
}

/** Body of a card whose message waits behind the session's running turn. */
export const QUEUED_NOTICE = '⏳ 排队中：上一轮回复结束后再处理这条消息'

/** Label of the queued card's button that moves the message into the running turn. */
export const STEER_LABEL = '⚡ 立即补充到当前回复'

/** Body of a queued card after its message moved into the running turn. */
export const MERGED_NOTICE = '↪️ 已补充到当前回复：当前这一步结束后模型就会读到这条消息，回复继续在上一张卡片中输出'

/** The queued card: notice, steer button and the optional owner-only notice. */
function queuedElements(denied: boolean): object[] {
  const elements: object[] = [
    markdown(QUEUED_NOTICE),
    textButton({
      label: STEER_LABEL,
      type: 'default',
      width: 'default',
      margin: '8px 0 0 0',
      value: { decision: STEER_ACTION },
    }),
  ]
  if (denied) elements.push(note('ℹ️ 仅发起该会话的用户可补充'))
  return elements
}

// ---- rendering ------------------------------------------------------------

/** Render one card. `reasoning`/`body` are the already-budgeted texts. */
function renderCard(
  state: CardState,
  options: CardOptions,
  reasoning: string,
  body: string,
): object {
  const segment = options.segment
  const main = segment === undefined
  if (main && state.queued === true) return card(queuedElements(state.queuedDenied === true))
  const elements: object[] = []

  if (main) {
    if (panelShown(state.phase, reasoning)) {
      elements.push(foldPanel(
        PANEL_TITLES[state.phase],
        panelContent(state.phase, reasoning),
        PANEL_CHEVRON_TOKEN,
      ))
    }
  } else {
    elements.push(note(segmentHeader(segment)))
  }

  const statusNote = activityNote(state.status)
  if (statusNote !== undefined) elements.push(statusNote)
  const toolNote = activityNote(state.tool)
  if (toolNote !== undefined) elements.push(toolNote)

  elements.push(markdown(body.trim() === '' ? bodyPlaceholder(state.phase) : body))

  if (state.stop !== undefined) elements.push(...stopElements(state.stop, state.stopDenied === true))

  if (main && state.phase === 'stopped') elements.push(note(STOPPED_NOTICE))

  if (main && isSettled(state.phase)) {
    // The divider separates the answer from the turn's metadata; the two
    // notation lines below it are the only place the settled figures appear.
    elements.push(divider())
    elements.push(note(buildModelLine(state.stats)))
    elements.push(note(buildUsageLine(state.stats)))
  }

  return card(elements)
}

// ---- budgeting ------------------------------------------------------------

/**
 * Longest prefix of `text` that fits `budget` under `measure`.
 *
 * Returns `text` unchanged when it already fits; otherwise the longest prefix
 * with `suffix` appended still fits, so a clipped result is guaranteed to stay
 * within the same budget.
 */
function fitPrefix(
  text: string,
  budget: number,
  measure: (candidate: string) => number,
  suffix = '',
): string {
  if (measure(text) <= budget) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid) + suffix) <= budget) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + suffix
}

/** Reasoning as rendered: clipped against the panel's own fixed window. */
function budgetReasoning(state: CardState): string {
  return fitPrefix(
    state.reasoning,
    REASONING_MAX_BYTES,
    content => jsonBytes(panelContent(state.phase, content)),
    TRUNCATION_SUFFIX,
  )
}

/**
 * Build one card.
 *
 * The reasoning window is clipped against `REASONING_MAX_BYTES` alone, and the
 * body is then clipped against `CARD_MAX_BYTES` measured on the card that is
 * actually rendered — the guard exists only for direct callers and for the
 * turn-failure notice appended to a settled body; the streamer pre-splits with
 * `segmentCardContent`.
 *
 * Guarantee: the returned card is ≤ `CARD_MAX_BYTES`, and its panel markdown
 * is ≤ `REASONING_MAX_BYTES`.
 */
export function buildCard(state: CardState, options: CardOptions = {}): object {
  const reasoning = options.segment === undefined ? budgetReasoning(state) : state.reasoning
  const body = fitPrefix(
    state.body,
    CARD_MAX_BYTES,
    content => cardJsonBytes(renderCard(state, options, reasoning, content)),
    TRUNCATION_SUFFIX,
  )
  return renderCard(state, options, reasoning, body)
}

/**
 * Worst-case panel markdown: exactly `REASONING_MAX_BYTES` JSON bytes of
 * ASCII text (the surrounding quotes cost 2 B).
 */
const PANEL_PROBE_MARKDOWN = 'r'.repeat(REASONING_MAX_BYTES - 2)

/**
 * Split a body so one card fits: `head` re-renders within `CARD_TARGET_BYTES`
 * and `tail` flows into the next segment card ('' when everything fits).
 *
 * The probe renders the worst card this segment can ever become: the main card
 * always budgets the panel's full window (reasoning may keep growing after the
 * split) and its settled footer, while continuation cards have neither. Every
 * card also budgets the stop button with its notice, since the newest card
 * carries it while streaming. The `error` phase is probed because it has the
 * longest panel title.
 */
export function segmentCardContent(state: CardState, options: CardOptions = {}): BodySplit {
  const main = options.segment === undefined
  const probe: CardState = {
    ...state,
    phase: 'error',
    reasoning: main ? PANEL_PROBE_MARKDOWN : '',
    stop: 'stopping',
    stopDenied: true,
  }
  const limit = fitPrefix(
    state.body,
    CARD_TARGET_BYTES,
    content => cardJsonBytes(renderCard(probe, options, probe.reasoning, content)),
  ).length
  return splitBodyForCard(state.body, limit)
}

/** Card-variant options for one segment (`0` is the main card). */
export function segmentCardOptions(index: number): CardOptions {
  return index === 0 ? {} : { segment: index + 1 }
}

/** Interruption notice body for cards repaired after a restart mid-turn. */
export const INTERRUPTION_NOTICE = '⚠️ 服务已重启，本次回复中断，请重新发送消息。'

/**
 * Terminal "interrupted" card used by the restart repair pass (`repairInflight`).
 *
 * Deliberately NOT built through `buildCard`: the local process has no copy of
 * the partial body/reasoning the card previously streamed (patch is full
 * replacement), and fabricating zero-valued token stats would be misleading.
 * The card is therefore minimal — a plain notice (+ segment header on
 * continuation cards) — and always far inside the size budget.
 */
export function buildInterruptionCard(options: CardOptions = {}): object {
  const elements: object[] = []
  if (options.segment !== undefined) elements.push(note(interruptionHeader(options.segment)))
  elements.push(markdown(INTERRUPTION_NOTICE))
  return card(elements)
}

/**
 * Split a body at a clean breakpoint so `head` fits one card:
 *  1. the head holds at most `maxTables` whole markdown tables — the boundary
 *     is capped at the first excess table (Feishu rejects cards with more);
 *  2. never inside a fenced code block or a table block — the boundary is
 *     pulled back to the block's start (a block beginning the body is left to
 *     the hard-cut escape hatch);
 *  3. then the clean-breakpoint tiers: paragraph blank line → `#` heading line
 *     → line break → hard cut as the escape hatch.
 */
export function splitBodyForCard(body: string, maxChars: number, maxTables: number = MAX_TABLES_PER_CARD): BodySplit {
  const tables = tableBlocks(body)
  if (body.length <= maxChars && tables.length <= maxTables) {
    return { head: body, tail: '' }
  }

  // Every range a cut may never land inside: fenced code blocks and tables.
  const blocks = [...codeFenceBlocks(body), ...tables].sort((a, b) => a.start - b.start)

  // 1. Table-count ceiling, then 2. pull the ceiling out of any block that
  //    straddles it.
  const limit = avoidProtected(blocks, Math.min(maxChars, tables[maxTables]?.start ?? body.length))

  const window = body.slice(0, limit)
  // Preferred breakpoints scanning back from the ceiling; only accept one that
  // keeps the card reasonably full, else fall through to the next tier.
  const minFill = Math.floor(limit * 0.7)

  const cut = (at: number): BodySplit => ({
    head: body.slice(0, at).replace(/\s+$/u, ''),
    tail: body.slice(at).replace(/^\n+/u, ''),
  })

  // 3. Clean-breakpoint tiers, each moved out of a protected block.
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph >= minFill) return cut(avoidProtected(blocks, paragraph + 2))

  let heading = -1
  for (const match of window.matchAll(/^#{1,6} .*$/gm)) {
    const start = match.index ?? 0
    heading = start === 0 ? 0 : start - 1
  }
  if (heading >= minFill) return cut(avoidProtected(blocks, heading))

  const line = window.lastIndexOf('\n')
  if (line >= minFill) return cut(avoidProtected(blocks, line + 1))

  return cut(limit)
}

/**
 * The initial (empty) streaming card for one session: thinking phase, empty
 * body and reasoning, zeroed stats. It has no stop button: the turn may still
 * be preparing or queued behind another one, and the streamer adds the button
 * once the turn is the active one. The service sends it as the topic-creating
 * first reply and then streams into the same message.
 */
export function initialStreamingCard(sessionId: string): object {
  const state: CardState = {
    phase: 'thinking',
    reasoning: '',
    body: '',
    stats: { sessionId, inputTokens: 0, outputTokens: 0 },
  }
  return buildCard(state)
}

/**
 * The first frame for a message that waits behind the session's running turn:
 * the queue notice plus the button that moves the message into that turn.
 * The streamer re-renders it as a normal streaming card once the message's
 * own turn becomes the active one.
 */
export function queuedStreamingCard(sessionId: string): object {
  return buildCard({
    phase: 'thinking',
    reasoning: '',
    body: '',
    queued: true,
    stats: { sessionId, inputTokens: 0, outputTokens: 0 },
  })
}

/** Terminal card of a queued message that moved into the running turn. */
export function buildMergedCard(): object {
  return card([markdown(MERGED_NOTICE)])
}
