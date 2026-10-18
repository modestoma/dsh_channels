/**
 * Host bridge, service surface: workspaces, storage domains, credentials,
 * token meter, LLM catalog, session projections, Cordis diagnostics, and the
 * `HostContext` slice this plugin consumes.
 *
 * @module dsh-channels/host/services
 */

import type { AgentRegistry } from './agent.ts'
import type { CommandRuntime } from './commands.ts'
import type { AssistantStreamPayload, Session, SessionEvent, SessionId } from './core.ts'
import type { ApprovalAnswererListener, UserQuestionAnswererListener } from './interaction.ts'

// ---- Workspace surface --------------------------------------------------

export interface Workspace {
  readonly id: string
  readonly path: string
  readonly title: string
  attachSession(id: SessionId): Promise<void> | void
  detachSession(id: SessionId): Promise<void> | void
}

export interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<Workspace>
}

// ---- Storage / token-meter / llm / credentials surface ------------------

/** The host's storage-domain facility (narrowly typed at the call site). */
export interface StorageDomainFacility {
  open(spec: unknown): Promise<unknown>
}

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  value: string
  source: string
}

/** Presence/writability facts for one credential reference (never the value). */
export interface CredentialInfo {
  configured: boolean
  writable?: boolean
  source?: string
}

/**
 * The host credentials seam (`@deepseek-ai/dsh-credentials`): resolves a
 * reference per call with the provider's layer precedence
 * (env > $DSH_HOME/.credentials.yaml > .env fallbacks), and can store a value
 * for a reference through the same seam (the Web panel's credential editor).
 * Every member beyond the read path is optional so embedded/test hosts can
 * supply only what they support.
 */
export interface CredentialProvider {
  resolve(ref: string): Promise<ResolvedCredential | undefined>
  /** Presence check without revealing the value (the host's `credentials.describe`). */
  describe?(ref: string): Promise<CredentialInfo | undefined>
  /** Store a value for the reference; stored values outrank environment fallbacks. */
  set?(ref: string, value: string): Promise<void>
  /** Remove the stored value (environment fallbacks then apply again). */
  unset?(ref: string): Promise<void>
}

export interface TokenMeasurement {
  readonly totalTokens: number
}

export interface TokenMeter {
  measure(session: Session, requestHeader?: unknown): TokenMeasurement
}

/** One registered provider route, as advertised by the LLM service. */
export interface LlmProviderInfo {
  id: string
  name: string
}

export interface LlmModelInfo {
  /** Provider route that owns this entry. */
  provider?: string
  /** Model id passed to request generation. */
  id?: string
  /** Human-readable model name for selectors. */
  name?: string
  description?: string
  context?: { contextWindow: number }
}

export interface LlmService {
  resolveModelInfo(provider: string, model: string): Promise<LlmModelInfo>
  /** Registered provider routes, when the deployment exposes them. */
  listProviders?(): readonly LlmProviderInfo[]
  /** Models advertised for one provider route. */
  listModels?(provider: string): Promise<readonly LlmModelInfo[]>
}

// ---- Session projections -------------------------------------------------

/**
 * Whole-log figures maintained by the host's `sessionStats` projection
 * (`@deepseek-ai/dsh-session-stats`, mounted by the web-app bundle). Reading
 * these replaces re-folding the event log for wall times and TTFT.
 */
export interface SessionStatsView {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

/** Provider-reported token buckets maintained by the `tokenUsage` projection. */
export interface TokenUsageBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface TokenUsageView {
  totals: TokenUsageBuckets
  last: { turn: number; step: number; buckets: TokenUsageBuckets } | null
}

/** Route capacity and prompt pressure maintained by the `contextPressure` projection. */
export interface ContextPressureView {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

/**
 * The host projection registry (`ctx.sessionProjections`). Read through
 * `ctx.get` so deployments without the registry keep working: `stateOf`
 * returns `undefined` for an unregistered key.
 */
export interface SessionProjections {
  stateOf(session: Session, key: string): unknown
}


// ---- Session query -------------------------------------------------------

/** Latest log-backed title of one session. */
export interface SessionTitleSnapshot {
  title: string
  updatedAt: number
}

export interface SessionTitleObservation {
  /** Absent when the observed log has no title event. */
  title?: SessionTitleSnapshot
}

/** One ordered result from a batch title observation. */
export type SessionTitleObservationResult =
  | { sessionId: SessionId; status: 'fulfilled'; value: SessionTitleObservation }
  | { sessionId: SessionId; status: 'rejected'; reason: unknown }

/**
 * The narrow read side of `ctx.sessionQuery` this plugin consumes: live-first
 * title folding for the sessions a Feishu topic has bound.
 */
export interface SessionQuery {
  readTitleSnapshots(sessionIds: readonly SessionId[]): Promise<readonly SessionTitleObservationResult[]>
}

// ---- Attachments ---------------------------------------------------------

/** Raster media types accepted by the attachment service. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One encoded image handed to the attachment service. */
export interface SaveImageAttachment {
  data: Uint8Array
  mediaType: ImageMediaType
  name?: string
}

/** Opaque durable image reference (owned by the attachment service). */
export type ImageAttachmentRef = { readonly [key: string]: unknown }

/**
 * The host attachment service (`ctx.attachments`): durably commits image
 * bytes and returns the reference a model-visible `ImageBlock` carries.
 */
export interface AttachmentService {
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
}

// ---- Permission presets --------------------------------------------------

/** One selectable sandbox+approval preset offered to clients. */
export interface PermissionPresetOption {
  value: string
  name: string
  description?: string
}

/** The process-level preset catalog exposed to current-session controls. */
export interface PermissionCatalog {
  options: PermissionPresetOption[]
  defaultOptions: PermissionPresetOption[]
  defaultPreset: string
}

/**
 * The host permission-preset service (`ctx.permissionPresets`): reads the
 * current Session's effective preset and records a switched one.
 */
export interface PermissionPresets {
  catalog(): PermissionCatalog
  current(session: Session): string
  optionOf(name: string): PermissionPresetOption
  set(session: Session, name: string): void
}

// ---- Cordis diagnostic surface -----------------------------------------

/** Numeric values mirror Cordis 4's public `FiberState` enum. */
export const CordisFiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

export type CordisFiberState = typeof CordisFiberState[keyof typeof CordisFiberState]

export interface CordisFiber {
  readonly state: CordisFiberState
}

export interface CordisPluginRuntime {
  readonly fibers: Iterable<CordisFiber>
}

export interface CordisRegistry {
  readonly size: number
  values(): IterableIterator<CordisPluginRuntime>
}

// ---- Host context surface ----------------------------------------------

/**
 * The host (Cordis) context slice the plugin consumes. Declared locally and
 * structurally: the host injects every capability through `ctx`, and the
 * plugin never imports cordis at runtime, so there is no dependency on the
 * npm-published cordis typings (whose `.ts`-specifier augmentations do not
 * resolve under bundler module resolution).
 */
export interface HostLogger {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface HostContext {
  agents: AgentRegistry
  commands: CommandRuntime
  workspaceRegistry: WorkspaceRegistry
  storageDomain: StorageDomainFacility
  /** Resolved through the injected `credentials` seam (env > .credentials.yaml > .env). */
  credentials: CredentialProvider
  tokenMeter: TokenMeter
  llm: LlmService
  /** Built-in Cordis plugin registry used for aggregate health diagnostics. */
  registry: CordisRegistry
  logger?: HostLogger
  /** Safe service lookup (returns undefined for absent services). */
  get?(name: string): unknown
  /** Host events this plugin subscribes to (overloads per event). */
  on(name: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => boolean
  /** Live (transient) model stream for every agent; replaces the removed `assistant/chunk` events. */
  on(name: 'agent/assistant-stream', listener: (payload: AssistantStreamPayload) => void): () => boolean
  /**
   * The host's structured-question waterfall (`ask_user_question`). Same
   * shape as `approval/request`: return an answer to claim, or delegate with
   * `next()`. Untagged plugin contexts receive requests for every agent, so
   * ownership filtering is mandatory.
   */
  on(
    name: 'user-questions/request',
    listener: UserQuestionAnswererListener,
    options?: { prepend?: boolean },
  ): () => boolean
  /**
   * The host's HITL answerer waterfall. Registered with `prepend: true` so
   * this channel claims its own sessions before generic answerers (the web
   * gateway); non-owned requests delegate through `next()`. Untagged plugin
   * contexts receive requests for EVERY agent, so ownership filtering is
   * mandatory. Safe to register without the approval service mounted — the
   * event simply never fires.
   */
  on(
    name: 'approval/request',
    listener: ApprovalAnswererListener,
    options?: { prepend?: boolean },
  ): () => boolean
  effect(callback: () => (() => void | Promise<void>) | void, label?: string): void
}
