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
 *   ctx.commands.register/list/find/execute
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
/** Branded command-execution identity (runtime value is a plain string). */
export type CommandId = string & { readonly __commandId: never }

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
  | { type: 'tool-call-delta'; index: number; argumentsDelta: string; name?: string }
  | { type: 'block-end'; index: number; block: { type: string; text?: string } }
  | { type: 'usage'; usage: TokenUsage }
  | { type: string; [key: string]: unknown }

// ---- Session surface ----------------------------------------------------

export interface SessionHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  /**
   * The session this one was forked/derived from — for a subagent child this
   * is the calling parent session's id (the link the streamer uses to fold
   * child progress into the parent's card).
   */
  readonly parentSession?: SessionId
  /** Coarse product classification (`'subagent'` for subagent children). */
  readonly origin?: string
  /** Delegation depth: 1 for a direct subagent child. */
  readonly delegationDepth?: number
  /** Preset used to compose this Session's agent, when the host uses presets. */
  readonly agentPreset?: string
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
  /** Unix epoch milliseconds recorded by the Session append boundary. */
  readonly time?: number
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

export interface StepEndEvent extends SessionEventEnvelope {
  type: 'step/end'
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
    message: {
      /** Message-level source is the authoritative call correlation. */
      source?: { kind?: string; callId?: string; [key: string]: unknown }
      /** The first tool-result block repeats correlation and outcome. */
      content?: ReadonlyArray<{
        type: string
        toolCallId?: string
        isError?: boolean
        [key: string]: unknown
      }>
      [key: string]: unknown
    }
    error?: { name: string; code: string }
    meta?: unknown
  }
}

export interface CommandRunEvent extends SessionEventEnvelope {
  type: 'command/run'
  data: {
    commandId: CommandId
    name: string
    args?: string
    source: { kind: string }
  }
}

export interface CommandDoneEvent extends SessionEventEnvelope {
  type: 'command/done'
  data: {
    commandId: CommandId
    kind: 'success' | 'error'
    text?: string
    sourceEventSeq?: number
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

/**
 * Durable subagent identity appended to the CHILD session's own log at
 * creation (in-process drivers). The `label` is the delegating model's short
 * description — what the parent card displays while the child runs.
 */
export interface SubagentDescriptorEvent extends SessionEventEnvelope {
  type: 'subagent/descriptor'
  data: {
    version: number
    mode: 'one-shot' | 'continuable'
    provider: string
    label?: string
    [key: string]: unknown
  }
}

/** Runtime preset switches are durable and define the currently composed preset. */
export interface AgentPresetSelectedEvent extends SessionEventEnvelope {
  type: 'agent-preset/selected'
  data: { agentPreset: string }
}

export interface OtherSessionEvent extends SessionEventEnvelope {
  /** Unknown/extension event types are ignored by the folds. */
  type: Exclude<string, 'assistant/chunk' | 'assistant/message' | 'step/start' | 'turn/end' | 'request/header'
    | 'tool/call' | 'tool/result' | 'subagent/descriptor'
    | 'command/run' | 'command/done'
    | 'tool-workflow/run-start' | 'tool-workflow/agent-start' | 'tool-workflow/agent-end' | 'tool-workflow/run-end'>
  data: unknown
}

export type SessionEvent =
  | AssistantChunkEvent
  | AssistantMessageEvent
  | StepStartEvent
  | StepEndEvent
  | TurnEndEvent
  | RequestHeaderEvent
  | ToolCallEvent
  | ToolResultEvent
  | CommandRunEvent
  | CommandDoneEvent
  | AgentPresetSelectedEvent
  | SubagentDescriptorEvent
  | ToolWorkflowRunStartEvent
  | ToolWorkflowAgentStartEvent
  | ToolWorkflowAgentEndEvent
  | ToolWorkflowRunEndEvent

// ---- Approval (HITL) surface --------------------------------------------

/**
 * Closed approval outcomes, mirrored from
 * `@deepseek-ai/dsh-user-approval/types`: a one-shot grant, explicit
 * rejection, withdrawn request, or unavailable answerer. Callers fail closed
 * on anything but `allowed-once`; a missing answerer yields `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Readonly same-process permission question (the payload of the host's
 * `approval/request` waterfall event). `callId` links to an already-presented
 * tool call; the plugin only renders `toolName` + `reason` on its decision
 * card and does not duplicate tool arguments.
 */
export interface ApprovalRequest {
  /** The agent on whose behalf the question is asked (routes + audit). */
  readonly agent: Agent
  /** The tool the question is about (model-facing name, e.g. `bash`). */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'` and a
   * late answer is discarded.
   */
  readonly signal?: AbortSignal
}

/**
 * One `approval/request` waterfall listener: return an outcome to claim the
 * request, or delegate by returning `next()`. The first claim occupies the
 * single decision slot.
 */
export type ApprovalAnswererListener = (
  req: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

// ---- Agent surface ------------------------------------------------------

export interface AgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

// ---- Human-command surface ---------------------------------------------

export interface CommandInputDescriptor {
  readonly hint: string
}

export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

export interface CommandExecution {
  readonly commandId: CommandId
  readonly result: CommandResult
}

export interface CommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: CommandInputDescriptor
}

export interface CommandInvocation {
  readonly commandId: CommandId
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}

export interface CommandDefinition extends CommandDescriptor {
  readonly recordInput?: boolean
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Minimal structural bridge to `@deepseek-ai/dsh-commands`' runtime. */
export interface CommandRuntime {
  register(definition: CommandDefinition): () => void
  list(agent: Agent): readonly CommandDescriptor[]
  find(agent: Agent, name: string): CommandDefinition | undefined
  execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined>
}

/** Agent-scoped Cordis context slice used to register scoped commands. */
export interface AgentContext {
  commands: CommandRuntime
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
  mount(agentCtx: AgentContext, id?: string): Promise<AgentPreset>
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
  effect(callback: () => (() => void | Promise<void>) | void): void
}
