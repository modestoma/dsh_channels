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
  LlmService, Session, SessionEvent, TokenMeter, TokenUsage,
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
  firstTokenTime?: number
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

function isTokenDelta(event: Extract<SessionEvent, { type: 'assistant/chunk' }>): boolean {
  const chunk = event.data.chunk
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

function toolResultCallId(event: Extract<SessionEvent, { type: 'tool/result' }>): string | undefined {
  const sourceId = event.data.message.source?.callId
  if (typeof sourceId === 'string' && sourceId !== '') return sourceId
  const blockId = event.data.message.content?.find(block => block.type === 'tool-result')?.toolCallId
  return typeof blockId === 'string' && blockId !== '' ? blockId : undefined
}

function toolResultFailed(event: Extract<SessionEvent, { type: 'tool/result' }>): boolean {
  if (event.data.error !== undefined) return true
  return event.data.message.content?.some(block => block.type === 'tool-result' && block.isError === true) ?? false
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
    case 'assistant/chunk': {
      const open = fold.openStep
      if (open === undefined || open.firstTokenTime !== undefined
        || open.turn !== event.data.turn || open.step !== event.data.step
        || !isTokenDelta(event)) break
      open.firstTokenTime = eventTime(event)
      break
    }
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
      if (open.firstTokenTime !== undefined) {
        const ttft = elapsed(open.startTime, open.firstTokenTime)
        if (ttft !== undefined) {
          fold.ttftMs += ttft
          fold.ttftSteps++
        }
        const outputTokens = usage?.outputTokens
        const decodeDuration = elapsed(open.firstTokenTime, completedAt)
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
}

/** Measure current surface pressure and resolve the latest model's context capacity. */
export async function measureSessionContext(
  session: Session,
  services: ContextServices,
  header = foldAll(session.events).lastHeader,
): Promise<ContextMeasurement> {
  let contextTokens: number | undefined
  try {
    const measured = services.tokenMeter?.measure(session).totalTokens
    if (measured !== undefined && Number.isFinite(measured) && measured >= 0) contextTokens = measured
  } catch {
    contextTokens = undefined
  }

  let contextWindow: number | undefined
  if (header !== undefined && header.provider !== '' && header.model !== '') {
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
