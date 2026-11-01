/**
 * Per-session request policy: the configured provider / model and the
 * reasoning effort (configured default plus the Session-level `/effort`
 * override).
 *
 * Cordis waterfalls run the earliest listener as the outermost wrapper, so the
 * channel policy registers with `prepend: true`: preset/model-selection
 * listeners may be standing registrations that predate this Agent, and they
 * rewrite the request after `next()` resolves. The outer channel wrapper
 * therefore writes last.
 *
 * DSH 0.2.2 moved model choice onto the Agent (`agent.model`) and fails a
 * step whose `agent/request` listener changes provider, model, or reasoning
 * effort. On such hosts the waterfall passes the request through and `sync`
 * records the effective policy with `agent.model.select()` instead; DSH 0.2.1
 * hosts (no `agent.model`) keep the waterfall override.
 *
 * The model comes only from channel settings. The Session-level effort
 * override is recovered from successful `/effort` command lifecycles: reusing
 * Harness' durable `command/run` / `command/done` pair avoids inventing an
 * out-of-repo Session event that persistence could not safely recognize on
 * restore.
 *
 * @module dsh-channels/session/request-policy
 */

import type { Agent, AgentContext, AgentModel, CommandId, SessionEvent } from '../dsh-types.ts'

/** A provider route and model id pinned in channel settings. */
export interface ConfiguredModel {
  readonly provider: string
  readonly model: string
}

/** Channel-configured defaults for sessions this plugin creates. */
export interface RequestPolicyConfig {
  /** Configured reasoning effort (optional → adapter/provider default). */
  effort?: string
  /** Configured provider pin (optional → deployment default). */
  provider?: string
  /** Configured model pin (optional → deployment default). */
  model?: string
}

export interface RequestPolicyState {
  readonly configuredEffort: string | undefined
  readonly configuredModel: ConfiguredModel | undefined
  /** Session-level `/effort` override. */
  readonly effortOverride: string | undefined
  /** Effort this channel writes into the next request, when defined. */
  readonly effectiveEffort: string | undefined
  readonly effortSource: 'session' | 'config' | 'model-default'
  readonly modelSource: 'config' | 'deployment-default'
}

export interface RequestPolicyController {
  readonly state: RequestPolicyState
  /**
   * Re-fold the durable log after resume or a settled command lifecycle.
   * With an `agent` whose host owns model selection, a changed policy is
   * recorded through `agent.model.select()` for the next step. `reconcile`
   * marks a just-settled `/effort` switch: the policy is recorded even when
   * this controller saw no change, so a reset also clears a selection
   * persisted before the controller existed (earlier plugin instance or
   * since-removed config default).
   */
  sync(events: readonly SessionEvent[], agent?: Agent, reconcile?: boolean): void
  /** Remove only this controller's Agent-scoped request wrapper. */
  dispose(): void
}

/** Parse `/effort` input; only values the handler can accept. */
function effortSelection(args: string | undefined): string | undefined | 'invalid' {
  if (args === undefined) return 'invalid'
  const value = args.trim()
  if (value === '' || /\s/u.test(value)) return 'invalid'
  return value === 'reset' ? undefined : value
}

/**
 * Fold the durable log into the last successful Session-level `/effort`
 * selection.
 *
 * A run changes nothing until its matching `command/done` succeeds. Failed,
 * incomplete, query-only, and malformed commands are therefore inert.
 */
export function foldEffortOverride(events: readonly SessionEvent[]): string | undefined {
  const pending = new Map<CommandId, string | undefined>()
  let effort: string | undefined
  for (const event of events) {
    if (event.type === 'command/run') {
      if (event.data.name !== 'effort') continue
      const selection = effortSelection(event.data.args)
      if (selection !== 'invalid') pending.set(event.data.commandId, selection)
      continue
    }
    if (event.type !== 'command/done') continue
    if (!pending.has(event.data.commandId)) continue
    const selection = pending.get(event.data.commandId)
    pending.delete(event.data.commandId)
    if (event.data.kind === 'success') effort = selection
  }
  return effort
}

/**
 * Record one effective policy as the Agent's next-step selection. Without a
 * configured model the current route is kept; without a resolvable provider
 * and model nothing is recorded.
 */
function selectPolicy(model: AgentModel, effort: string | undefined, target: ConfiguredModel | undefined): void {
  const current = model.current()
  const provider = target?.provider ?? current?.provider
  const modelId = target?.model ?? current?.model
  if (provider === undefined || provider === '' || modelId === undefined || modelId === '') return
  model.select({ provider, model: modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
}

/** Install the mutable request policy outside every other request wrapper. */
export function installRequestPolicy(
  agentCtx: AgentContext,
  config: RequestPolicyConfig = {},
): RequestPolicyController {
  let effortOverride: string | undefined
  let disposed = false
  /** Effort last recorded through `agent.model`; `null` until the first selecting sync. */
  let appliedEffort: string | undefined | null = null
  const configuredModel: ConfiguredModel | undefined = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : undefined

  const disposeListener = agentCtx.on('agent/request', async (payload, next) => {
    const request = await next()
    // Hosts that own model selection reject a changed route or effort here.
    if (payload.agent?.model !== undefined) return request
    const effort = effortOverride ?? config.effort
    if (effort === undefined && configuredModel === undefined) return request
    return {
      ...request,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(configuredModel === undefined ? {} : { provider: configuredModel.provider, model: configuredModel.model }),
    }
  }, { prepend: true })

  return {
    get state(): RequestPolicyState {
      return {
        configuredEffort: config.effort,
        configuredModel,
        effortOverride,
        effectiveEffort: effortOverride ?? config.effort,
        effortSource: effortOverride !== undefined
          ? 'session'
          : config.effort !== undefined ? 'config' : 'model-default',
        modelSource: configuredModel !== undefined ? 'config' : 'deployment-default',
      }
    },
    sync(events, agent, reconcile = false) {
      effortOverride = foldEffortOverride(events)
      const model = agent?.model
      if (agent === undefined || model === undefined || disposed) return
      const effort = effortOverride ?? config.effort
      const first = appliedEffort === null
      const changed = first ? effort !== undefined || configuredModel !== undefined : appliedEffort !== effort
      appliedEffort = effort
      if (!reconcile && !changed) return
      selectPolicy(model, effort, configuredModel)
    },
    dispose() {
      if (disposed) return
      disposed = true
      disposeListener()
    },
  }
}
