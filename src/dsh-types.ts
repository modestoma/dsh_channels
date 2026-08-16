/**
 * Local minimal type bridge for the DeepSeek Harness host surface.
 *
 * This plugin is loaded into a DSH host (Cordis composition), so all host
 * capabilities arrive through `ctx`. To stay buildable without depending on
 * DSH's npm release cadence (published packages lag the source checkout), the
 * plugin declares the exact slice of the host API it consumes — mirrored from
 * the DSH source at implementation time — and augments `@deepseek-ai/cordis`
 * `Context`/`Events` with it, exactly like the host packages do.
 *
 * The consumed surface is deliberately narrow and stable:
 *   ctx.agents.create/resume · agent.followup · agent.session
 *   ctx.workspaceRegistry.create · workspace.attachSession
 *   ctx.storageDomain.open · table/global handles
 *   ctx.tokenMeter.measure · ctx.llm.resolveModelInfo
 *   ctx.get('agentPresets') → preset roster (optional, read lazily)
 *   ctx.on('session/event')
 *
 * @module dsh-channels/dsh-types
 */

/** Branded session identity (runtime value is a plain string). */
export type SessionId = string & { readonly __sessionId: never }
/** Branded message identity (runtime value is a plain string). */
export type MessageId = string & { readonly __messageId: never }

// ---- LLM surface --------------------------------------------------------

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** Per-message model-facing blocks (plugin only ever produces plain text). */
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | { type: string; [key: string]: unknown }

/** Provider usage buckets; input/output/cache fields are disjoint. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UserMessage {
  id: MessageId
  role: 'user'
  content: ContentBlock[]
  source: { kind: string }
}

/** The chunk vocabulary the plugin consumes from `assistant/chunk` events. */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: string; text?: string } }
  | { type: 'usage'; usage: TokenUsage }
  | { type: string; [key: string]: unknown }

// ---- Session surface ----------------------------------------------------

export interface SessionHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
}

/** The live session object (durable event log + header). */
export interface Session {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly firstLiveSeq: number
}

export interface SessionEventEnvelope {
  readonly seq: number
  readonly ignorable?: boolean
}

export interface AssistantChunkEvent extends SessionEventEnvelope {
  type: 'assistant/chunk'
  data: { turn: number; step: number; chunk: StreamChunk }
}

export interface AssistantMessageEvent extends SessionEventEnvelope {
  type: 'assistant/message'
  data: {
    turn: number
    step: number
    message: unknown
    usage?: TokenUsage
    sourceEventSeqs?: readonly number[]
  }
}

export interface StepStartEvent extends SessionEventEnvelope {
  type: 'step/start'
  data: { turn: number; step: number }
}

export interface TurnEndEvent extends SessionEventEnvelope {
  type: 'turn/end'
  data: { turn: number; reason: string }
}

export interface RequestHeaderEvent extends SessionEventEnvelope {
  type: 'request/header'
  data: {
    header: {
      config: {
        provider?: string
        model?: string
        reasoningEffort?: string
        [key: string]: unknown
      }
      [key: string]: unknown
    }
  }
}

export interface ToolCallEvent extends SessionEventEnvelope {
  type: 'tool/call'
  data: {
    turn: number
    step: number
    callId: string
    /** Model-facing tool name (e.g. `bash`, `subagent`, `workflow`). */
    name: string
    /** Raw arguments JSON exactly as the model produced it (unparsed). */
    arguments: string
  }
}

export interface ToolResultEvent extends SessionEventEnvelope {
  type: 'tool/result'
  data: {
    turn: number
    step: number
    message: unknown
    error?: { name: string; code: string }
    meta?: unknown
  }
}

/** Durable workflow-run progress record projected into the calling session's log. */
export interface ToolWorkflowRunStartEvent extends SessionEventEnvelope {
  type: 'tool-workflow/run-start'
  data: { runId: string; name: string }
}

export interface ToolWorkflowAgentStartEvent extends SessionEventEnvelope {
  type: 'tool-workflow/agent-start'
  data: { runId: string; seq: number; label: string; phase?: string; childId: string }
}

export interface ToolWorkflowAgentEndEvent extends SessionEventEnvelope {
  type: 'tool-workflow/agent-end'
  data: { runId: string; seq: number; outcome: 'completed' | 'failed' | 'cancelled' }
}

export interface ToolWorkflowRunEndEvent extends SessionEventEnvelope {
  type: 'tool-workflow/run-end'
  data: { runId: string; stopReason: 'completed' | 'cancelled' | 'error' }
}

export interface OtherSessionEvent extends SessionEventEnvelope {
  /** Unknown/extension event types are ignored by the folds. */
  type: Exclude<string, 'assistant/chunk' | 'assistant/message' | 'step/start' | 'turn/end' | 'request/header'
    | 'tool/call' | 'tool/result'
    | 'tool-workflow/run-start' | 'tool-workflow/agent-start' | 'tool-workflow/agent-end' | 'tool-workflow/run-end'>
  data: unknown
}

export type SessionEvent =
  | AssistantChunkEvent
  | AssistantMessageEvent
  | StepStartEvent
  | TurnEndEvent
  | RequestHeaderEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolWorkflowRunStartEvent
  | ToolWorkflowAgentStartEvent
  | ToolWorkflowAgentEndEvent
  | ToolWorkflowRunEndEvent

// ---- Agent surface ------------------------------------------------------

export interface AgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

export interface Agent {
  readonly id: SessionId
  readonly session: Session
  readonly status: 'idle' | 'running'
  readonly inbox: {
    readonly nextTurn: readonly unknown[]
    readonly nextStep: readonly unknown[]
  }
  followup(message: UserMessage): void
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
export type AgentSetup = (agentCtx: unknown) => Promise<void> | void

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

// ---- Workspace surface --------------------------------------------------

export interface Workspace {
  readonly id: string
  readonly path: string
  readonly title: string
  attachSession(id: SessionId): unknown
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

/**
 * The host credentials seam (`@deepseek-ai/dsh-credentials`): resolves a
 * reference per call with the provider's layer precedence
 * (env > $DSH_HOME/.credentials.yaml > .env fallbacks).
 */
export interface CredentialProvider {
  resolve(ref: string): Promise<ResolvedCredential | undefined>
}

export interface TokenMeasurement {
  readonly totalTokens: number
}

export interface TokenMeter {
  measure(session: Session, requestHeader?: unknown): TokenMeasurement
}

export interface LlmModelInfo {
  context?: { contextWindow: number }
}

export interface LlmService {
  resolveModelInfo(provider: string, model: string): Promise<LlmModelInfo>
}

// ---- Agent-preset surface ------------------------------------------------

/** One resolvable preset identity on the host's preset roster. */
export interface AgentPreset {
  readonly id: string
  readonly path?: string
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
  mount(agentCtx: unknown, id?: string): Promise<AgentPreset>
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
  workspaceRegistry: WorkspaceRegistry
  storageDomain: StorageDomainFacility
  /** Resolved through the injected `credentials` seam (env > .credentials.yaml > .env). */
  credentials: CredentialProvider
  tokenMeter: TokenMeter
  llm: LlmService
  logger?: HostLogger
  /** Safe service lookup (returns undefined for absent services). */
  get?(name: string): unknown
  /** The only host event this plugin subscribes to. */
  on(name: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => boolean
  effect(callback: () => (() => void | Promise<void>) | void): void
}
