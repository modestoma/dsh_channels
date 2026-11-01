/**
 * Personal model endpoints: one `llm-pi-ai` provider route per Feishu user.
 *
 * The host LLM service binds the endpoint and API key to a provider route,
 * so a user's own endpoint becomes a hand-declared route in the `llm-pi-ai`
 * settings namespace (`providers.<route>`), written through the host
 * `settings` service. The key goes to the DSH credential store under the
 * reference the route names as its `apiKeyEnv`; it never enters this
 * plugin's storage or a card. Routes are visible deployment-wide (the Web
 * model picker lists them); this plugin only lets their owner select them
 * from Feishu.
 *
 * @module dsh-channels/llm/personal-routes
 */

import { createHash } from 'node:crypto'
import type { CredentialProvider, LlmDiscoveredModel, LlmService, SettingsService } from '../dsh-types.ts'
import type { PersonalLlm, PersonalLlmApi } from '../domain.ts'

/** Prefix of every personal provider route this plugin registers. */
export const PERSONAL_ROUTE_PREFIX = 'feishu-'

/** Upper bound of one endpoint's model discovery. */
const DISCOVERY_TIMEOUT_MS = 15_000

/** How long a bind waits for the host to register the written route. */
const REGISTRATION_WAIT_MS = 5_000

/** Characters an HTTP header value carries verbatim (the host's API-key rule). */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/u

/**
 * Provider route id of one user's personal endpoint: stable, opaque, and
 * free of the user_id itself.
 * @param userId - Feishu user_id.
 * @returns `feishu-<10 hex>`.
 */
export function personalRouteFor(userId: string): string {
  return `${PERSONAL_ROUTE_PREFIX}${createHash('sha256').update(userId).digest('hex').slice(0, 10)}`
}

/**
 * Credential reference of a route's API key, derived like the Web Models
 * page derives it, so that page shows the route's key as configured.
 * @param route - provider route id.
 * @returns e.g. `FEISHU_0A1B2C3D4E_API_KEY`.
 */
export function credentialRefFor(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

/** Why a bind did not complete; nothing is written for any of them except `write-failed`, which rolls back. */
export type BindFailureReason =
  | 'unavailable'
  | 'invalid-url'
  | 'missing-key'
  | 'invalid-key'
  | 'discovery-failed'
  | 'no-models'
  | 'write-failed'

export type BindResult =
  | { ok: true; own: PersonalLlm }
  | { ok: false; reason: BindFailureReason; detail?: string }

/** One bind request from the `/llm` form. */
export interface BindRequest {
  userId: string
  /** Route display name (`飞书 · <name>`). */
  displayName: string
  api: PersonalLlmApi
  baseURL: string
  /** Typed key; blank keeps the previous binding's key. */
  apiKey: string
  /** The user's current binding, when re-binding. */
  previous?: PersonalLlm
}

export interface PersonalRoutesDeps {
  settings(): SettingsService | undefined
  llm(): LlmService | undefined
  credentials: CredentialProvider
  /** Settings namespace of the `llm-pi-ai` plugin entry (read per call: config may change). */
  namespace(): string
  warn(message: string, ...args: unknown[]): void
}

/** Normalize a typed base URL; undefined when it is not an http(s) URL. */
export function normalizeBaseURL(raw: string): string | undefined {
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch (_notAUrl) {
    // Any unparsable input is reported as one invalid-url failure.
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  return value.replace(/\/+$/u, '')
}

/** The `llm-pi-ai` model profile for one discovered model. */
function modelProfile(model: LlmDiscoveredModel): Record<string, unknown> {
  return {
    id: model.id,
    ...(model.name === undefined || model.name === '' ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Longest failure detail a card shows. */
const DETAIL_LIMIT = 300

/**
 * A failure detail safe to show on a card: the key a provider or the host
 * may echo back is masked, and the text is capped.
 * @param error - the caught failure.
 * @param apiKey - the key the failed request carried.
 * @returns the redacted message.
 */
function redactedDetail(error: unknown, apiKey: string): string {
  const message = messageOf(error).split(apiKey).join('***')
  return message.length > DETAIL_LIMIT ? `${message.slice(0, DETAIL_LIMIT)}…` : message
}

export class PersonalRoutes {
  constructor(private readonly deps: PersonalRoutesDeps) {}

  /** Whether the host offers everything a bind needs. */
  available(): boolean {
    return this.deps.namespace() !== ''
      && this.deps.settings() !== undefined
      && this.deps.llm()?.discoverModels !== undefined
      && this.deps.credentials.set !== undefined
  }

  /**
   * Validate an endpoint by discovering its models, then store the key and
   * register (or replace) the user's route.
   * @param request - the submitted form.
   * @returns the stored binding, or why nothing changed.
   */
  async bind(request: BindRequest): Promise<BindResult> {
    const settings = this.deps.settings()
    const llm = this.deps.llm()
    const setCredential = this.deps.credentials.set?.bind(this.deps.credentials)
    const namespace = this.deps.namespace()
    if (namespace === '' || settings === undefined || llm?.discoverModels === undefined || setCredential === undefined) {
      return { ok: false, reason: 'unavailable' }
    }
    const baseURL = normalizeBaseURL(request.baseURL)
    if (baseURL === undefined) return { ok: false, reason: 'invalid-url' }
    const route = personalRouteFor(request.userId)
    const credentialRef = credentialRefFor(route)
    let apiKey = request.apiKey.trim()
    if (apiKey === '' && request.previous !== undefined) {
      apiKey = (await this.deps.credentials.resolve(request.previous.credentialRef))?.value ?? ''
    }
    if (apiKey === '') return { ok: false, reason: 'missing-key' }
    if (!LEGAL_API_KEY.test(apiKey)) return { ok: false, reason: 'invalid-key' }

    let discovered: readonly LlmDiscoveredModel[]
    try {
      discovered = await llm.discoverModels(
        namespace,
        { api: request.api, baseURL, apiKey },
        AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      )
    } catch (error) {
      return { ok: false, reason: 'discovery-failed', detail: redactedDetail(error, apiKey) }
    }
    const models = discovered.filter(model => model.id !== '')
    if (models.length === 0) return { ok: false, reason: 'no-models' }

    // The key stored under the reference before this bind, restored when the
    // route write fails so the unchanged route keeps its working key. An
    // environment value is not stored, so removing the new key restores it.
    const before = await this.deps.credentials.resolve(credentialRef)
    const previousKey = before === undefined || before.source === 'env' ? undefined : before.value
    try {
      await setCredential(credentialRef, apiKey)
      await settings.mutate(namespace, [{
        op: 'set',
        path: ['providers', route],
        value: {
          displayName: request.displayName,
          api: request.api,
          baseURL,
          apiKeyEnv: credentialRef,
          models: models.map(modelProfile),
        },
      }])
    } catch (error) {
      await this.restoreCredential(credentialRef, previousKey, setCredential)
      return { ok: false, reason: 'write-failed', detail: redactedDetail(error, apiKey) }
    }
    await this.awaitRegistration(llm, route)
    return {
      ok: true,
      own: {
        route,
        credentialRef,
        api: request.api,
        baseURL,
        models: models.map(model => model.id),
        boundAt: Date.now(),
      },
    }
  }

  /**
   * Remove a user's route and key. Failures are logged: the binding record
   * is dropped regardless, so the route is no longer selectable from Feishu.
   * @param own - the binding to remove.
   */
  async unbind(own: PersonalLlm): Promise<void> {
    try {
      await this.deps.settings()?.mutate(this.deps.namespace(), [{ op: 'unset', path: ['providers', own.route] }])
    } catch (error) {
      this.deps.warn('dsh-channels: removing personal route %s failed: %s', own.route, messageOf(error))
    }
    try {
      await this.deps.credentials.unset?.(own.credentialRef)
    } catch (error) {
      this.deps.warn('dsh-channels: removing personal key %s failed: %s', own.credentialRef, messageOf(error))
    }
  }

  /** Put back the key a failed bind replaced, or remove the one it added; failures are logged. */
  private async restoreCredential(
    credentialRef: string,
    previousKey: string | undefined,
    setCredential: (ref: string, value: string) => Promise<void>,
  ): Promise<void> {
    try {
      if (previousKey === undefined) await this.deps.credentials.unset?.(credentialRef)
      else await setCredential(credentialRef, previousKey)
    } catch (error) {
      this.deps.warn('dsh-channels: restoring personal key %s failed: %s', credentialRef, messageOf(error))
    }
  }

  /** Wait until the host lists the route, so the next Session can select it. */
  private async awaitRegistration(llm: LlmService, route: string): Promise<void> {
    if (llm.listProviders === undefined) return
    const deadline = Date.now() + REGISTRATION_WAIT_MS
    while (Date.now() < deadline) {
      if (llm.listProviders().some(provider => provider.id === route)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    this.deps.warn('dsh-channels: personal route %s was written but is not registered yet', route)
  }
}
