/**
 * Host bridge, agent surface: creation/resume options, the live Agent and its
 * scoped context, the agent registry, and the agent-preset roster.
 *
 * @module dsh-channels/host/agent
 */

import type { AttachmentStore } from './attachments.ts'
import type { CommandRuntime } from './commands.ts'
import type { Session, SessionId, UserMessage } from './core.ts'

// ---- Agent surface ------------------------------------------------------

/** Cancellation causes accepted by `agent.cancel()`. */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

export interface AgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

/** Exact model-call configuration exposed by the Agent-scoped request waterfall. */
export interface AgentRequestConfig {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
  [key: string]: unknown
}

/** Agent-scoped request override installed before the first prompt assembly. */
export type AgentRequestListener = (
  payload: { turn: number; step: number; signal: AbortSignal },
  next: () => Promise<AgentRequestConfig>,
) => Promise<AgentRequestConfig>

/** Cordis listener placement used to make an explicit channel override outermost. */
export interface AgentRequestListenerOptions {
  prepend?: boolean
}


/** One ordered system-prompt section the plugin contributes to an Agent scope. */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly interpolate?: boolean
  readonly complete?: boolean
}

/** The Agent-scoped slice of the host `systemPrompt` registry. */
export interface SystemPromptRuntime {
  section(section: PromptSection): () => void
}

/** One model-facing content block a channel tool may project (text/image/file). */
export interface ToolContentBlock {
  readonly type: string
  readonly [key: string]: unknown
}

/** One tool execution's cooperative cancellation signal. */
export interface ToolExecution {
  readonly signal: AbortSignal
}

/** Canonical output contract of one channel tool registration. */
export interface ToolOutputContract {
  readonly schema: Record<string, unknown>
  render(args: Record<string, unknown>, value: unknown): readonly ToolContentBlock[]
  presentationMeta?(args: Record<string, unknown>, value: unknown): unknown
}

/**
 * One model-facing tool registration. Kept structural (no runtime import of
 * the host's `@deepseek-ai/dsh-tools` package) so the plugin keeps its
 * zero-host-dependency stance.
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutputContract
  readonly timeoutMs?: number
  execute(
    args: Record<string, unknown>,
    exec: ToolExecution,
  ): Promise<unknown> | unknown
  presentCall?(args: Record<string, unknown>): unknown
  presentResult?(args: Record<string, unknown>, value: unknown): unknown
  readonly isConcurrencySafe?: () => boolean
}

/** The Agent-scoped slice of the host `tools` registry. */
export interface ToolRuntime {
  register(definition: ToolDefinition): unknown
}

export interface AgentContext {
  commands: CommandRuntime
  /** Present inside a setup scope that injected `systemPrompt`. */
  systemPrompt?: SystemPromptRuntime
  /** Present inside a setup scope that injected `tools`. */
  tools?: ToolRuntime
  /**
   * Present inside a setup scope that injected `attachments` (the DSH native
   * attachment store). Optional: headless or legacy hosts, and test doubles,
   * may not mount it, so consumers resolve it through the degradation-aware
   * helper in `src/feishu/native-attachments.ts` instead of assuming presence.
   */
  attachments?: AttachmentStore
  /** Safe service lookup (returns undefined for absent services). */
  get?(name: string): unknown
  /** Register an Agent-scoped model-call override. */
  on(
    event: 'agent/request',
    listener: AgentRequestListener,
    options?: boolean | AgentRequestListenerOptions,
  ): () => boolean
  /** Mount a child plugin only after its declared Host services are available. */
  inject(
    dependencies: readonly string[],
    callback: (ctx: AgentContext) => void,
  ): PromiseLike<unknown>
}

export interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: 'idle' | 'running'
  readonly inbox: {
    readonly nextTurn: readonly unknown[]
    readonly nextStep: readonly unknown[]
  }
  readonly ctx: AgentContext
  followup(message: UserMessage): void
  /** Abort the active turn (and pending input unless `keepInbox`). */
  cancel?(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
}

export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/**
 * Compose one unpublished agent's scoped world before publication. The host
 * factory awaits it after minting the agent context and before announcing the
 * session/agent, so everything registered there (preset tools, prompt
 * sections, listeners) exists before the first prompt assembly; a rejection
 * rolls the creation back. The plugin only returns `void` — the synchronous
 * `AgentSetupCommit` flavor is never produced here.
 */
export type AgentSetup = (agentCtx: AgentContext) => Promise<void> | void

export interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
}

export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
}

export interface AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  /**
   * Synchronous live-registry lookup (host parity with `ctx.agents.get`):
   * the published agent for a session id when one is live, regardless of
   * which owner published it. The plugin uses this to BORROW a live agent
   * instead of cold-resuming a session another owner already holds (the
   * persistence layer rejects `resume` on a live session).
   */
  get(id: SessionId): Agent | undefined
}


// ---- Agent-preset surface ------------------------------------------------

/** One resolvable preset identity on the host's preset roster. */
export interface AgentPreset {
  readonly id: string
  readonly path?: string
  /** Display metadata published by a user-authored preset declaration. */
  readonly name?: string
  readonly description?: string
  readonly order?: number
  /** Why this preset cannot compose a session; absent when it can. */
  readonly broken?: string
}

/**
 * The host agent-preset roster (`@deepseek-ai/dsh-agent-presets`). In
 * web-profile deployments the model-facing tools live BEHIND agent presets
 * (the host disables the tool rows at the host layer) and `agents.create()`
 * applies none on its own — the caller composes the agent's world through
 * `setup`, which is where a preset is mounted. The plugin reads the roster
 * through `ctx.get('agentPresets')` because deployments without one compose
 * their tools at the host layer instead, and direct property access on a
 * cordis context throws for services that were not injected.
 */
export interface AgentPresets {
  /**
   * Default preset id for a session that names none. Absent on roster
   * implementations that do not publish their default.
   */
  readonly defaultId?: string
  /**
   * Resolve one preset by id; `undefined` resolves the roster default.
   * Resolves BEFORE the session exists so the header meta can record it.
   * @throws when no configured root supplies that id.
   */
  resolve(id?: string): Promise<AgentPreset>
  /**
   * Compose one agent from a preset (standing mount + scope parent bind).
   * Call from the agent factory's `setup`; a rejection there rolls the
   * agent creation back. `id` defaults to the roster default.
   * @returns the composed preset.
   */
  mount(agentCtx: AgentContext, id?: string): Promise<AgentPreset>
  /** Every declared preset, including activation diagnostics, when exposed. */
  list?(): Promise<readonly AgentPreset[]>
}

