/**
 * Per-session request policy: provider / model / reasoning-effort overrides.
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
 * Session overrides are recovered from successful command lifecycles
 * (`/effort`, `/model`). Reusing Harness' durable `command/run` /
 * `command/done` pair avoids inventing an out-of-repo Session event that
 * persistence could not safely recognize on restore.
 *
 * @module dsh-channels/session/request-policy
 */

import type { Agent, AgentContext, AgentModel, CommandId, SessionEvent } from '../dsh-types.ts'

/** A model selection override: a bare model keeps the composed provider. */
export interface ModelOverride {
  /** Provider route; absent keeps the route composed by earlier listeners. */
  readonly provider?: string
  readonly model: string
}

/** Host lookups the policy consults while folding the Session log. */
export interface RequestPolicyOptions {
  /**
   * Whether the host still lists a provider route. A logged `/model` naming
   * a route that returns false is ignored. Absent: every route is kept.
   */
  providerAvailable?(provider: string): boolean
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
  readonly configuredModel: ModelOverride | undefined
  /** Session-level `/effort` override; `null` after `/effort default` (the model's own default). */
  readonly effortOverride: EffortOverride | undefined
  /** Session-level `/model` override. */
  readonly modelOverride: ModelOverride | undefined
  /** Effort this channel writes into the next request, when defined. */
  readonly effectiveEffort: string | undefined
  /** Model this channel writes into the next request, when defined. */
  readonly effectiveModel: ModelOverride | undefined
  readonly effortSource: 'session' | 'config' | 'model-default'
  readonly modelSource: 'session' | 'config' | 'deployment-default'
}

export interface RequestPolicyController {
  readonly state: RequestPolicyState
  /**
   * Re-fold the durable log after resume or a settled command lifecycle.
   * With an `agent` whose host owns model selection, a changed policy is
   * recorded through `agent.model.select()` for the next step. `reconcile`
   * names a just-settled `/effort` or `/model` switch: the policy is recorded
   * even when this controller saw no change, so a reset also clears a
   * selection persisted before the controller existed (earlier plugin
   * instance or since-removed config default).
   */
  sync(events: readonly SessionEvent[], agent?: Agent, reconcile?: 'effort' | 'model'): void
  /** Remove only this controller's Agent-scoped request wrapper. */
  dispose(): void
}

/** A Session-level effort choice: a tier id, or `null` for the model's own default. */
export type EffortOverride = string | null

type PendingSelection =
  | { readonly kind: 'effort'; readonly value: EffortOverride | undefined }
  | { readonly kind: 'model'; readonly value: ModelOverride | undefined }

/**
 * Parse `/effort` input; only values the handler can accept. `reset` clears
 * the override (back to the configured effort); `default` overrides with the
 * model's own default.
 */
function effortSelection(args: string | undefined): EffortOverride | undefined | 'invalid' {
  if (args === undefined) return 'invalid'
  const value = args.trim()
  if (value === '' || /\s/u.test(value)) return 'invalid'
  if (value === 'reset') return undefined
  return value === 'default' ? null : value
}

/** The request without its reasoning effort. */
function withoutEffort<T extends { reasoningEffort?: unknown }>(request: T): T {
  if (!('reasoningEffort' in request)) return request
  const { reasoningEffort: _dropped, ...rest } = request
  return rest as T
}

/** The effort written into requests for an override over a configured effort. */
function effectiveEffortOf(override: EffortOverride | undefined, configured: string | undefined): string | undefined {
  if (override === null) return undefined
  return override ?? configured
}

/**
 * Parse `/model` input: `reset`, `<model>` (keeps the composed provider), or
 * `<provider>/<model>`.
 */
function modelSelection(args: string | undefined): ModelOverride | undefined | 'invalid' {
  if (args === undefined) return 'invalid'
  const value = args.trim()
  if (value === '' || /\s/u.test(value)) return 'invalid'
  if (value === 'reset') return undefined
  const slash = value.indexOf('/')
  if (slash === -1) return { model: value }
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  // Only the first slash separates the provider: catalog ids may be namespaced (`vendor/model`).
  if (provider === '' || model === '') return 'invalid'
  return { provider, model }
}

/** One folded policy: the last successful Session-level selections. */
export interface FoldedRequestPolicy {
  effort: EffortOverride | undefined
  model: ModelOverride | undefined
}

/**
 * Fold the durable log into the Session-level policy.
 *
 * A run changes nothing until its matching `command/done` succeeds. Failed,
 * incomplete, query-only, and malformed commands are therefore inert.
 */
export function foldRequestPolicy(events: readonly SessionEvent[]): FoldedRequestPolicy {
  const pending = new Map<CommandId, PendingSelection>()
  let effort: EffortOverride | undefined
  let model: ModelOverride | undefined
  for (const event of events) {
    if (event.type === 'command/run') {
      if (event.data.name === 'effort') {
        const selection = effortSelection(event.data.args)
        if (selection !== 'invalid') pending.set(event.data.commandId, { kind: 'effort', value: selection })
      } else if (event.data.name === 'model') {
        const selection = modelSelection(event.data.args)
        if (selection !== 'invalid') pending.set(event.data.commandId, { kind: 'model', value: selection })
      }
      continue
    }
    if (event.type !== 'command/done') continue
    const selection = pending.get(event.data.commandId)
    if (selection === undefined) continue
    pending.delete(event.data.commandId)
    if (event.data.kind !== 'success') continue
    if (selection.kind === 'effort') effort = selection.value
    else model = selection.value
  }
  return { effort, model }
}

/** Fold only the last successful Session-level `/effort` selection. */
export function foldEffortOverride(events: readonly SessionEvent[]): EffortOverride | undefined {
  return foldRequestPolicy(events).effort
}

/** Fold only the last successful Session-level `/model` selection. */
export function foldModelOverride(events: readonly SessionEvent[]): ModelOverride | undefined {
  return foldRequestPolicy(events).model
}

/** Policy values last recorded through `agent.model`, compared to skip no-op selections. */
interface AppliedPolicy {
  readonly effort: string | undefined
  readonly model: ModelOverride | undefined
}

function sameModel(left: ModelOverride | undefined, right: ModelOverride | undefined): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

/**
 * Record one effective policy as the Agent's next-step selection. A policy
 * without a model keeps the current route, except right after a model
 * override is cleared, when the Agent's live options (deployment default)
 * supply it again. Without a resolvable provider and model nothing is recorded.
 */
function selectPolicy(
  model: AgentModel,
  agent: Agent,
  effort: string | undefined,
  target: ModelOverride | undefined,
  modelCleared: boolean,
): void {
  const current = model.current()
  const base = modelCleared && agent.options.provider !== undefined && agent.options.model !== undefined
    ? { provider: agent.options.provider, model: agent.options.model }
    : current
  const provider = target?.provider ?? base?.provider
  const modelId = target?.model ?? base?.model
  if (provider === undefined || provider === '' || modelId === undefined || modelId === '') return
  model.select({ provider, model: modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
}

/** Install the mutable request policy outside every other request wrapper. */
export function installRequestPolicy(
  agentCtx: AgentContext,
  config: RequestPolicyConfig = {},
  options: RequestPolicyOptions = {},
): RequestPolicyController {
  let effortOverride: EffortOverride | undefined
  let modelOverride: ModelOverride | undefined
  let disposed = false
  /** Last policy recorded through `agent.model`; undefined until the first selecting sync. */
  let applied: AppliedPolicy | undefined
  const configuredModel: ModelOverride | undefined = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : undefined

  const disposeListener = agentCtx.on('agent/request', async (payload, next) => {
    const request = await next()
    // Hosts that own model selection reject a changed route or effort here.
    if (payload.agent?.model !== undefined) return request
    const effort = effectiveEffortOf(effortOverride, config.effort)
    const model = modelOverride ?? configuredModel
    // `/effort default` also drops an effort an inner listener composed.
    const base = effortOverride === null ? withoutEffort(request) : request
    if (effort === undefined && model === undefined) return base
    return {
      ...base,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(model === undefined ? {} : { model: model.model }),
      ...(model?.provider === undefined ? {} : { provider: model.provider }),
    }
  }, { prepend: true })

  return {
    get state(): RequestPolicyState {
      const effectiveEffort = effectiveEffortOf(effortOverride, config.effort)
      const effectiveModel = modelOverride ?? configuredModel
      return {
        configuredEffort: config.effort,
        configuredModel,
        effortOverride,
        modelOverride,
        effectiveEffort,
        effectiveModel,
        effortSource: typeof effortOverride === 'string'
          ? 'session'
          : effectiveEffort !== undefined ? 'config' : 'model-default',
        modelSource: modelOverride !== undefined
          ? 'session'
          : configuredModel !== undefined ? 'config' : 'deployment-default',
      }
    },
    sync(events, agent, reconcile) {
      const folded = foldRequestPolicy(events)
      // A logged switch to a provider the host no longer lists falls back to
      // the configured route; the effort chosen for that model goes with it.
      const stale = folded.model?.provider !== undefined && options.providerAvailable?.(folded.model.provider) === false
      effortOverride = stale ? undefined : folded.effort
      modelOverride = stale ? undefined : folded.model
      const model = agent?.model
      if (agent === undefined || model === undefined || disposed) return
      const next: AppliedPolicy = { effort: effectiveEffortOf(effortOverride, config.effort), model: modelOverride ?? configuredModel }
      const previous = applied ?? { effort: undefined, model: undefined }
      applied = next
      if (reconcile === undefined && previous.effort === next.effort && sameModel(previous.model, next.model)) return
      const modelCleared = next.model === undefined && (reconcile === 'model' || previous.model !== undefined)
      selectPolicy(model, agent, next.effort, next.model, modelCleared)
    },
    dispose() {
      if (disposed) return
      disposed = true
      disposeListener()
    },
  }
}
