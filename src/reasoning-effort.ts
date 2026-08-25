/**
 * Agent-scoped reasoning-effort policy for channel-owned turns.
 *
 * Cordis waterfalls run the earliest listener as the outermost wrapper.
 * `prepend` is therefore required: preset/model-selection listeners may be
 * standing registrations that predate this Agent, and they rewrite the
 * request after `next()` resolves. The outer channel wrapper writes last.
 */

import type { AgentContext } from './dsh-types.ts'

/** Install one explicit channel effort and return its idempotent disposer. */
export function installReasoningEffortOverride(
  agentCtx: AgentContext,
  reasoningEffort: string | undefined,
): () => void {
  if (reasoningEffort === undefined) return () => {}
  const dispose = agentCtx.on('agent/request', async (_payload, next) => ({
    ...(await next()),
    reasoningEffort,
  }), { prepend: true })
  return () => { dispose() }
}
