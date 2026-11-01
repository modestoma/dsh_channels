/**
 * Model resolution for Sessions this plugin creates: a user's stored
 * preference plus the administrator's default endpoint become the Session's
 * starting choice, and that choice becomes the request policy's configured
 * values.
 *
 * @module dsh-channels/llm/selection
 */

import type { SessionLlm, UserLlmRecord } from '../domain.ts'
import type { RequestPolicyConfig } from '../session/request-policy.ts'

/** The administrator's default endpoint, as resolved for this deployment. */
export interface DefaultEndpoint {
  /** Default provider route (channel config, else the deployment default). */
  provider?: string
  /** Default model on that route. */
  model?: string
  /** Default reasoning effort (channel config only). */
  effort?: string
}

/**
 * The starting model choice of a Session the user creates.
 * @param record - the user's stored preference.
 * @param defaults - the administrator's default endpoint.
 * @returns the choice to record on the route, or undefined to follow the
 *   deployment default live.
 */
export function sessionLlmFor(record: UserLlmRecord | undefined, defaults: DefaultEndpoint): SessionLlm | undefined {
  if (record === undefined) return undefined
  const effort = record.effort === undefined ? {} : { effort: record.effort }
  if (record.source === 'own') {
    // An unbound personal endpoint falls back to the default endpoint.
    if (record.own === undefined) return undefined
    const model = record.model ?? record.own.models[0]
    return model === undefined ? undefined : { provider: record.own.route, model, ...effort }
  }
  if (record.model !== undefined) {
    return defaults.provider === undefined ? undefined : { provider: defaults.provider, model: record.model, ...effort }
  }
  return record.effort === undefined ? undefined : { effort: record.effort }
}

/**
 * The request-policy configuration of one Session.
 * @param base - the choice recorded on the Session's route.
 * @param deployment - the channel's deployment default configuration.
 * @returns the configured provider / model / effort the policy writes.
 */
export function policyConfigFor(base: SessionLlm | undefined, deployment: RequestPolicyConfig): RequestPolicyConfig {
  if (base === undefined) return deployment
  if (base.provider !== undefined && base.model !== undefined) {
    // Another model's efforts differ from the default model's, so the
    // deployment effort does not carry over to a pinned route.
    return { provider: base.provider, model: base.model, ...(base.effort === undefined ? {} : { effort: base.effort }) }
  }
  return { ...deployment, ...(base.effort === undefined ? {} : { effort: base.effort }) }
}
