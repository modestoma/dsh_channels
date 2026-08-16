/**
 * Session-log folds feeding the card's info lines.
 *
 * Everything is computed from the durable session log (works identically for
 * live and resumed sessions):
 *  - cumulative input/output/cache tokens (session scope, per product decision),
 *  - the latest provider usage sample → cache hit ratio,
 *  - the latest `request/header` → model id + reasoning effort.
 *
 * @module dsh-channels/stats
 */

import type { SessionEvent, TokenUsage } from './dsh-types.ts'

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

export function addUsage(totals: SessionTotals, usage: TokenUsage): SessionTotals {
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (usage.reasoningTokens ?? 0),
  }
}

/** Latest provider usage sample carried by an `assistant/message` event. */
export interface UsageSample {
  usage: TokenUsage
  turn: number
  step: number
}

/** Fold one event into the running totals and last-sample slot. */
export interface StatsFold {
  totals: SessionTotals
  /** Latest usage sample seen so far, if any. */
  lastUsage: UsageSample | undefined
  /** Latest request-header config seen so far, if any. */
  lastHeader: HeaderSample | undefined
}

export interface HeaderSample {
  provider: string
  model: string
  effort?: string
}

export function foldEvent(fold: StatsFold, event: SessionEvent): void {
  switch (event.type) {
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage !== undefined) {
        fold.totals = addUsage(fold.totals, usage)
        fold.lastUsage = { usage, turn: event.data.turn, step: event.data.step }
      }
      break
    }
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
    default:
      break
  }
}

/** Fold a complete log prefix (used once when attaching to a session). */
export function foldAll(events: readonly SessionEvent[]): StatsFold {
  const fold: StatsFold = { totals: { ...EMPTY_TOTALS }, lastUsage: undefined, lastHeader: undefined }
  for (const event of events) foldEvent(fold, event)
  return fold
}

/** Cache hit ratio of the latest usage sample: cacheRead / (cacheRead + uncached input). */
export function cacheHitPct(lastUsage: UsageSample | undefined): number | undefined {
  if (lastUsage === undefined) return undefined
  const hit = lastUsage.usage.cacheReadTokens
  // Absent field = provider did not report cache usage; 0 = a genuine miss.
  if (hit === undefined) return undefined
  const total = hit + lastUsage.usage.inputTokens
  return total > 0 ? hit / total : undefined
}
