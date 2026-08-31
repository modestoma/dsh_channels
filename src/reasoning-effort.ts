/**
 * Agent-scoped reasoning-effort policy for channel-owned turns.
 *
 * Cordis waterfalls run the earliest listener as the outermost wrapper.
 * `prepend` is therefore required: preset/model-selection listeners may be
 * standing registrations that predate this Agent, and they rewrite the
 * request after `next()` resolves. The outer channel wrapper writes last.
 *
 * Session overrides are recovered from successful `/effort` command
 * lifecycles. Reusing Harness' durable `command/run` / `command/done` pair
 * avoids inventing an out-of-repo Session event that persistence cannot
 * safely recognize on restore.
 */

import type { AgentContext, CommandId, SessionEvent } from './dsh-types.ts'

export interface ReasoningEffortState {
  /** Channel configuration default; absent means delegate to the composed model policy. */
  readonly configured: string | undefined
  /** Current Session override recovered from successful `/effort` commands. */
  readonly sessionOverride: string | undefined
  /** Value this channel writes into the next request, when defined. */
  readonly effective: string | undefined
  readonly source: 'session' | 'config' | 'model-default'
}

export interface ReasoningEffortController {
  readonly state: ReasoningEffortState
  /** Re-fold the durable log after resume or a settled command lifecycle. */
  sync(events: readonly SessionEvent[]): void
  /** Remove only this controller's Agent-scoped request wrapper. */
  dispose(): void
}

type PendingSelection =
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'reset' }

/** Parse only inputs the `/effort` handler can successfully accept. */
function selectionFromArgs(args: string | undefined): PendingSelection | undefined {
  if (args === undefined) return undefined
  const value = args.trim()
  if (value === '' || /\s/u.test(value)) return undefined
  return value === 'reset' ? { kind: 'reset' } : { kind: 'set', value }
}

/**
 * Fold the last successful Session-level `/effort` selection.
 *
 * A run changes nothing until its matching `command/done` succeeds. Failed,
 * incomplete, query-only, and malformed commands are therefore inert.
 */
export function foldReasoningEffortOverride(events: readonly SessionEvent[]): string | undefined {
  const pending = new Map<CommandId, PendingSelection>()
  let selected: string | undefined
  for (const event of events) {
    if (event.type === 'command/run' && event.data.name === 'effort') {
      const selection = selectionFromArgs(event.data.args)
      if (selection !== undefined) pending.set(event.data.commandId, selection)
      continue
    }
    if (event.type !== 'command/done') continue
    const selection = pending.get(event.data.commandId)
    if (selection === undefined) continue
    pending.delete(event.data.commandId)
    if (event.data.kind !== 'success') continue
    selected = selection.kind === 'set' ? selection.value : undefined
  }
  return selected
}

/** Install a mutable Session-aware channel effort policy. */
export function installReasoningEffortOverride(
  agentCtx: AgentContext,
  configured: string | undefined,
): ReasoningEffortController {
  let sessionOverride: string | undefined
  let disposed = false
  const disposeListener = agentCtx.on('agent/request', async (_payload, next) => {
    const request = await next()
    const effective = sessionOverride ?? configured
    return effective === undefined ? request : { ...request, reasoningEffort: effective }
  }, { prepend: true })

  return {
    get state(): ReasoningEffortState {
      const effective = sessionOverride ?? configured
      return {
        configured,
        sessionOverride,
        effective,
        source: sessionOverride !== undefined
          ? 'session'
          : configured !== undefined ? 'config' : 'model-default',
      }
    },
    sync(events) {
      sessionOverride = foldReasoningEffortOverride(events)
    },
    dispose() {
      if (disposed) return
      disposed = true
      disposeListener()
    },
  }
}
