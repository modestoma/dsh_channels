/**
 * Whole-session diagnostic folds and context measurement.
 *
 * All historical figures come from the durable event log, so a live Agent
 * and the same Session resumed after restart produce identical output.
 * Command lifecycle records are intentionally ignored.
 *
 * @module dsh-channels/stats
 */

import type {
  AssistantStreamRecord, ContextPressureView, LlmService, Session, SessionEvent, SessionProjections, SessionStatsView,
  TokenMeter, TokenUsage, TokenUsageView,
} from './dsh-types.ts'

export interface SessionTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export const EMPTY_TOTALS: SessionTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

function usableCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0
}

export function addUsage(totals: SessionTotals, usage: TokenUsage): SessionTotals {
  return {
    inputTokens: totals.inputTokens + usableCount(usage.inputTokens),
    outputTokens: totals.outputTokens + usableCount(usage.outputTokens),
    cacheReadTokens: totals.cacheReadTokens + usableCount(usage.cacheReadTokens),
    cacheWriteTokens: totals.cacheWriteTokens + usableCount(usage.cacheWriteTokens),
    reasoningTokens: totals.reasoningTokens + usableCount(usage.reasoningTokens),
  }
}

/** Latest provider usage sample carried by an `assistant/message` event. */
export interface UsageSample {
  usage: TokenUsage
  turn: number
  step: number
}

export interface HeaderSample {
  provider: string
  model: string
  effort?: string
}

export type ToolEventStatus = 'success' | 'error' | 'running'

export interface ToolEventSample {
  callId: string
  name: string
  status: ToolEventStatus
  durationMs?: number
  startedAt?: number
}

interface OpenStep {
  turn: number
  step: number
  startTime?: number
}

interface PendingTool {
  callId: string
  name: string
  startedAt?: number
}

/** Complete fold state and public whole-log status figures. */
export interface StatsFold {
  totals: SessionTotals
  usageSamples: number
  lastUsage: UsageSample | undefined
  lastHeader: HeaderSample | undefined
  llmMs: number
  llmSteps: number
  toolMs: number
  toolTimedCalls: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  toolCalls: number
  pendingTools: Map<string, PendingTool>
  recentTools: ToolEventSample[]
  openStep: OpenStep | undefined
}

function eventTime(event: SessionEvent): number | undefined {
  return event.time !== undefined && Number.isFinite(event.time) ? event.time : undefined
}

/**
 * First non-whitespace delta time inside one durable embedded assistant
 * stream (`assistant/message.stream`). Local fallback for deployments where
 * the host `sessionStats` projection is not mounted; the projection remains
 * authoritative when present.
 */
function firstTokenTime(stream: readonly AssistantStreamRecord[] | undefined): number | undefined {
  let best: number | undefined
  for (const record of stream ?? []) {
    const time0 = record.time0
    if (typeof time0 !== 'number' || !Number.isFinite(time0)) continue
    if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks') continue
    const texts = record.texts
    const hasVisible = Array.isArray(texts)
      && texts.some(text => typeof text === 'string' && /\S/u.test(text))
    if (hasVisible && (best === undefined || time0 < best)) best = time0
  }
  return best
}

/**
 * Authoritative call correlation and failure flag of one `tool/result`.
 *
 * DSH's `ToolResultMessage` is `{ role:'tool', source:{kind:'tool', callId},
 * content, isError? }` and has no `tool-result` content-block type, so the
 * message-level `source.callId` / `isError` decide; the first content block is
 * only a legacy fallback.
 */
function toolResultCallId(event: Extract<SessionEvent, { type: 'tool/result' }>): string | undefined {
  const sourceId = event.data.message.source?.callId
  if (typeof sourceId === 'string' && sourceId !== '') return sourceId
  const blockId = event.data.message.content?.find(block => typeof block.toolCallId === 'string')?.toolCallId
  return typeof blockId === 'string' && blockId !== '' ? blockId : undefined
}

function toolResultFailed(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  if (event.data.error !== undefined) return true
  if (event.data.message.isError === true) return true
  return event.data.message.content?.some(block => block.isError === true) ?? false
}

function elapsed(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined
  return Math.max(0, end - start)
}

function pushRecentTool(fold: StatsFold, sample: ToolEventSample): void {
  fold.recentTools.push(sample)
  if (fold.recentTools.length > 5) fold.recentTools.shift()
}

/** Fold one durable event into the running Session figures. */
export function foldEvent(fold: StatsFold, event: SessionEvent): void {
  switch (event.type) {
    case 'step/start':
      fold.openStep = {
        turn: event.data.turn,
        step: event.data.step,
        startTime: eventTime(event),
      }
      break
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage !== undefined) {
        fold.totals = addUsage(fold.totals, usage)
        fold.usageSamples++
        fold.lastUsage = { usage, turn: event.data.turn, step: event.data.step }
      }
      const open = fold.openStep
      if (open === undefined || open.turn !== event.data.turn || open.step !== event.data.step) break
      const completedAt = eventTime(event)
      const llmDuration = elapsed(open.startTime, completedAt)
      if (llmDuration !== undefined) {
        fold.llmMs += llmDuration
        fold.llmSteps++
      }
      // Live `assistant/chunk` events no longer exist; the first-token time is
      // recovered from the durable embedded stream. The host `sessionStats`
      // projection (overlaid by `applyProjectionViews`) is authoritative when
      // mounted.
      const firstToken = firstTokenTime(event.data.stream)
      if (firstToken !== undefined) {
        const ttft = elapsed(open.startTime, firstToken)
        if (ttft !== undefined) {
          fold.ttftMs += ttft
          fold.ttftSteps++
        }
        const outputTokens = usage?.outputTokens
        const decodeDuration = elapsed(firstToken, completedAt)
        if (decodeDuration !== undefined && outputTokens !== undefined
          && Number.isFinite(outputTokens) && outputTokens >= 0) {
          fold.decodeMs += decodeDuration
          fold.decodeTokens += outputTokens
        }
      }
      fold.openStep = undefined
      break
    }
    case 'step/end':
      fold.openStep = undefined
      break
    case 'request/header': {
      const config = event.data.header?.config
      if (config !== undefined && typeof config === 'object') {
        const cfg = config as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
        fold.lastHeader = {
          provider: typeof cfg.provider === 'string' ? cfg.provider : '',
          model: typeof cfg.model === 'string' ? cfg.model : '',
          effort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : undefined,
        }
      }
      break
    }
    case 'tool/call': {
      fold.toolCalls++
      const pending: PendingTool = {
        callId: event.data.callId,
        name: event.data.name,
        startedAt: eventTime(event),
      }
      fold.pendingTools.set(event.data.callId, pending)
      pushRecentTool(fold, { ...pending, status: 'running' })
      break
    }
    case 'tool/result': {
      const callId = toolResultCallId(event)
      if (callId === undefined) break
      const pending = fold.pendingTools.get(callId)
      if (pending === undefined) break
      fold.pendingTools.delete(callId)
      const durationMs = elapsed(pending.startedAt, eventTime(event))
      const settled: ToolEventSample = {
        callId,
        name: pending.name,
        status: toolResultFailed(event) ? 'error' : 'success',
        startedAt: pending.startedAt,
        ...(durationMs === undefined ? {} : { durationMs }),
      }
      const recentIndex = fold.recentTools.findIndex(sample => sample.callId === callId)
      if (recentIndex !== -1) fold.recentTools.splice(recentIndex, 1)
      pushRecentTool(fold, settled)
      if (durationMs !== undefined) {
        fold.toolMs += durationMs
        fold.toolTimedCalls++
      }
      break
    }
    default:
      break
  }
}

/** Fold one complete Session log. */
export function foldAll(events: readonly SessionEvent[]): StatsFold {
  const fold: StatsFold = {
    totals: { ...EMPTY_TOTALS },
    usageSamples: 0,
    lastUsage: undefined,
    lastHeader: undefined,
    llmMs: 0,
    llmSteps: 0,
    toolMs: 0,
    toolTimedCalls: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    toolCalls: 0,
    pendingTools: new Map(),
    recentTools: [],
    openStep: undefined,
  }
  for (const event of events) foldEvent(fold, event)
  return fold
}

/** Cache hit ratio of the latest usage sample: cacheRead / (cacheRead + uncached input). */
export function cacheHitPct(lastUsage: UsageSample | undefined): number | undefined {
  if (lastUsage === undefined) return undefined
  const hit = lastUsage.usage.cacheReadTokens
  if (hit === undefined || !Number.isFinite(hit) || hit < 0) return undefined
  const input = lastUsage.usage.inputTokens
  if (!Number.isFinite(input) || input < 0) return undefined
  const total = hit + input
  return total > 0 ? hit / total : undefined
}

export interface ContextMeasurement {
  contextTokens?: number
  contextWindow?: number
}

export interface ContextServices {
  tokenMeter?: TokenMeter
  llm?: LlmService
  /** Optional projection registry; supplies the authoritative context window. */
  projections?: SessionProjections
}

/** Projection readings for one session; every key is optional (unmounted unit). */
export interface ProjectionViews {
  sessionStats?: SessionStatsView
  tokenUsage?: TokenUsageView
  contextPressure?: ContextPressureView
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read the host projection units this plugin consumes, tolerating absence. */
export function readProjectionViews(
  projections: SessionProjections | undefined,
  session: Session,
): ProjectionViews {
  if (projections === undefined) return {}
  const views: ProjectionViews = {}
  try {
    const stats = asRecord(projections.stateOf(session, 'sessionStats'))
    if (stats !== undefined) {
      const parsed: SessionStatsView = {
        turns: finiteNonNegative(stats.turns) ?? 0,
        steps: finiteNonNegative(stats.steps) ?? 0,
        llmMs: finiteNonNegative(stats.llmMs) ?? 0,
        toolMs: finiteNonNegative(stats.toolMs) ?? 0,
        ttftMs: finiteNonNegative(stats.ttftMs) ?? 0,
        ttftSteps: finiteNonNegative(stats.ttftSteps) ?? 0,
        decodeMs: finiteNonNegative(stats.decodeMs) ?? 0,
        decodeTokens: finiteNonNegative(stats.decodeTokens) ?? 0,
      }
      views.sessionStats = parsed
    }
  } catch { /* a failing projection must never break the fold */ }
  try {
    const usage = asRecord(projections.stateOf(session, 'tokenUsage'))
    const totals = asRecord(usage?.totals)
    if (usage !== undefined && totals !== undefined) {
      const buckets = (input: Record<string, unknown> | undefined) => ({
        uncachedInputTokens: finiteNonNegative(input?.uncachedInputTokens) ?? 0,
        outputTokens: finiteNonNegative(input?.outputTokens) ?? 0,
        cacheReadTokens: finiteNonNegative(input?.cacheReadTokens) ?? 0,
        cacheWriteTokens: finiteNonNegative(input?.cacheWriteTokens) ?? 0,
      })
      const last = asRecord(usage.last)
      views.tokenUsage = {
        totals: buckets(totals),
        last: last === undefined
          ? null
          : {
            turn: finiteNonNegative(last.turn) ?? 0,
            step: finiteNonNegative(last.step) ?? 0,
            buckets: buckets(asRecord(last.buckets)),
          },
      }
    }
  } catch { /* ignore malformed projection state */ }
  try {
    const pressure = asRecord(projections.stateOf(session, 'contextPressure'))
    if (pressure !== undefined) {
      views.contextPressure = {
        ...(finiteNonNegative(pressure.pressureTokens) === undefined
          ? {} : { pressureTokens: finiteNonNegative(pressure.pressureTokens) }),
        ...(finiteNonNegative(pressure.projectedTokens) === undefined
          ? {} : { projectedTokens: finiteNonNegative(pressure.projectedTokens) }),
        ...(positive(pressure.contextWindow) === undefined
          ? {} : { contextWindow: positive(pressure.contextWindow) }),
      }
    }
  } catch { /* ignore malformed projection state */ }
  return views
}

/** Map a projection token bucket into the plugin's usage vocabulary. */
export function usageFromBuckets(buckets: TokenUsageView['totals']): TokenUsage {
  return {
    inputTokens: buckets.uncachedInputTokens,
    outputTokens: buckets.outputTokens,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
  }
}

/**
 * Overlay host projection figures onto a log fold. The host units are
 * authoritative where mounted (they fold the same log, including the
 * embedded streams the plugin no longer sees as live events); the log fold
 * stays as the fallback and still owns tool-detail fields.
 */
export function applyProjectionViews(fold: StatsFold, views: ProjectionViews): StatsFold {
  const stats = views.sessionStats
  if (stats !== undefined) {
    // Times are host-authoritative; counts (llmSteps / toolTimedCalls) stay
    // with the fold, which sees the same boundaries.
    fold.llmMs = stats.llmMs
    fold.toolMs = stats.toolMs
    fold.ttftMs = stats.ttftMs
    fold.ttftSteps = stats.ttftSteps
    fold.decodeMs = stats.decodeMs
    fold.decodeTokens = stats.decodeTokens
  }
  const usage = views.tokenUsage
  if (usage !== undefined) {
    fold.totals = {
      inputTokens: usage.totals.uncachedInputTokens,
      outputTokens: usage.totals.outputTokens,
      cacheReadTokens: usage.totals.cacheReadTokens,
      cacheWriteTokens: usage.totals.cacheWriteTokens,
      reasoningTokens: fold.totals.reasoningTokens,
    }
    if (usage.last !== null) {
      fold.lastUsage = {
        usage: usageFromBuckets(usage.last.buckets),
        turn: usage.last.turn,
        step: usage.last.step,
      }
      fold.usageSamples = Math.max(fold.usageSamples, 1)
    }
  }
  return fold
}

/** Read one session's figures from the projection registry, falling back to the log fold. */
export function foldSessionStats(
  session: Session,
  projections: SessionProjections | undefined,
): StatsFold {
  const fold = foldAll(session.snapshotEvents())
  return applyProjectionViews(fold, readProjectionViews(projections, session))
}

/** Measure current surface pressure and resolve the latest model's context capacity. */
export async function measureSessionContext(
  session: Session,
  services: ContextServices,
  header = session.requestHeader?.()?.config ?? foldAll(session.snapshotEvents()).lastHeader,
): Promise<ContextMeasurement> {
  let contextTokens: number | undefined
  try {
    const measured = services.tokenMeter?.measure(session).totalTokens
    if (measured !== undefined && Number.isFinite(measured) && measured >= 0) contextTokens = measured
  } catch {
    contextTokens = undefined
  }

  let contextWindow: number | undefined
  if (services.projections !== undefined) {
    try {
      contextWindow = readProjectionViews(services.projections, session).contextPressure?.contextWindow
    } catch {
      contextWindow = undefined
    }
  }
  if (contextWindow === undefined && header !== undefined
    && typeof header.provider === 'string' && header.provider !== ''
    && typeof header.model === 'string' && header.model !== '') {
    try {
      const resolved = await services.llm?.resolveModelInfo(header.provider, header.model)
      const window = resolved?.context?.contextWindow
      if (window !== undefined && Number.isFinite(window) && window > 0) contextWindow = window
    } catch {
      contextWindow = undefined
    }
  }
  return { contextTokens, contextWindow }
}

export function averageTtftMs(stats: StatsFold): number | undefined {
  return stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : undefined
}

export function averageDecodeTokensPerSecond(stats: StatsFold): number | undefined {
  return stats.decodeMs > 0 ? stats.decodeTokens / stats.decodeMs * 1000 : undefined
}
