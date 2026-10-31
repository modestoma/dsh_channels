/**
 * Host bridge, core surface: identities, LLM message/stream vocabulary, the
 * durable Session log, and the session-event union this plugin folds.
 *
 * Split from the former single `dsh-types.ts`; `src/dsh-types.ts` remains the
 * public barrel so consumers keep one import specifier.
 *
 * @module dsh-channels/host/core
 */

import type { Agent } from './agent.ts'

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

/** The chunk vocabulary consumed from live assistant-stream frames. */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; argumentsDelta: string; id?: string; name?: string }
  | { type: 'block-end'; index: number; block: { type: string; text?: string } }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

/** Compacted durable stream record embedded in `assistant/message.stream`. */
export type AssistantStreamRecord = { readonly type: string; readonly [key: string]: unknown }

/**
 * One process-local live assistant streaming publication
 * (`agent/assistant-stream`, DSH `packages/core/agent/src/runtime-types.ts`).
 *
 * DSH stopped emitting the durable `assistant/chunk` session event in commit
 * `f99b06eaed` (2026-09-02, "feat(session)!: embed assistant streams in format
 * v2"), so this transient event is the only live delta source; the durable
 * `assistant/message.stream` records are the replay-safe counterpart.
 */
export type AssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: string
    readonly revision: number
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: string
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: StreamChunk
  }
  | {
    readonly type: 'end'
    readonly attemptId: string
    readonly revision: number
    readonly index: number
    readonly outcome:
      | { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'; readonly seq: number }
      | { readonly kind: 'abandoned' }
  }

export interface AssistantStreamPayload {
  readonly agent: Agent
  readonly frame: AssistantStreamFrame
}

/**
 * One inbox message claimed by a turn (`agent/inbox/claimed`, DSH
 * `packages/core/agent/src/runtime-types.ts`). Emitted when the turn opens
 * (its next-turn message) and when a step claims steered messages.
 */
export interface InboxClaimedPayload {
  readonly agent: Agent
  readonly message: UserMessage
  readonly turn: number
}

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

/**
 * The live session object (durable event log + header).
 *
 * DSH removed the synchronous whole-log `events` getter (commit 5660f44d29,
 * 2026-08-28) in favor of `eventAt()` / `snapshotEvents()` / `ownEvents()`;
 * all three are `@deprecated` as of 2026-09-09 in favor of session
 * projections plus explicit paged reads. This bridge keeps only the range
 * reader (the narrowest replacement that preserves existing folds) and the
 * request-header fold; new state should come from `ctx.sessionProjections`
 * or `ctx.sessionQuery` instead of a fresh whole-log read.
 */
export interface Session {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly firstLiveSeq: number
  /** Immutable snapshot of a half-open event range (defaults to the whole log). */
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
  /** Latest folded request header, when the session has produced one. */
  requestHeader?(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
}

export interface SessionEventEnvelope {
  readonly seq: number
  /** Unix epoch milliseconds recorded by the Session append boundary. */
  readonly time?: number
  readonly ignorable?: boolean
}

export interface AssistantMessageEvent extends SessionEventEnvelope {
  type: 'assistant/message'
  data: {
    turn: number
    step: number
    message: unknown
    /** Compacted durable stream records (v2 format); replays the exact deltas. */
    stream?: readonly AssistantStreamRecord[]
    usage?: TokenUsage
    /** Set when a cancelled turn finalized its delivered prefix as this message. */
    interrupted?: true
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

/** Serializable model failure carried by a failed Harness turn. */
export interface TurnFailure {
  message: string
  code: string
  [key: string]: unknown
}

/**
 * Why a Harness turn ended. String reasons remain accepted for compatibility
 * with older persisted fixtures; current Harness emits the structured union.
 */
export type TurnEndReason =
  | string
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: unknown }
  | { kind: 'blocked' }
  | { kind: 'error'; error: TurnFailure }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }

export interface TurnEndEvent extends SessionEventEnvelope {
  type: 'turn/end'
  data: { turn: number; reason: TurnEndReason }
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
      /** Message-level failure flag; authoritative when no `error` object is attached. */
      isError?: boolean
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

/**
 * Durable record of one model-request retry scheduled by `dsh-llm-retry`
 * (DSH `packages/llm/llm-retry/src/types.ts`), appended before the backoff
 * wait. The retry re-runs the failed step inside the SAME open turn: only
 * `turn/end` ends the turn.
 */
export interface LlmRetryEvent extends SessionEventEnvelope {
  type: 'llm/retry'
  data: {
    turn: number
    step: number
    provider: string
    mode: 'normal' | 'always'
    /** 1-based retry number. */
    retry: number
    /** Retry budget in `normal` mode; absent in `always` mode (unbounded). */
    maxRetries?: number
    delayMs: number
    failure: { message: string; code: string; [key: string]: unknown }
    [key: string]: unknown
  }
}

/** Appended when a retry's backoff wait ends, right before the retried request starts. */
export interface LlmRetryStartedEvent extends SessionEventEnvelope {
  type: 'llm/retry-started'
  data: { turn: number; step: number; retry: number; [key: string]: unknown }
}

export interface OtherSessionEvent extends SessionEventEnvelope {
  /** Unknown/extension event types are ignored by the folds. */
  type: Exclude<string, 'assistant/message' | 'step/start' | 'turn/end' | 'request/header'
    | 'tool/call' | 'tool/result' | 'subagent/descriptor' | 'llm/retry' | 'llm/retry-started'
    | 'command/run' | 'command/done'
    | 'tool-workflow/run-start' | 'tool-workflow/agent-start' | 'tool-workflow/agent-end' | 'tool-workflow/run-end'>
  data: unknown
}

export type SessionEvent =
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
  | LlmRetryEvent
  | LlmRetryStartedEvent

