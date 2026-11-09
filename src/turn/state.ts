/**
 * Per-turn render state and the pure folds that advance it.
 *
 * A {@link TurnState} holds everything one turn's cards render: the body
 * segments, reasoning, the activity inputs (tool call, workflow runs,
 * subagent children, retry, waits) and the settled outcome. The fold
 * functions apply one session event, one live assistant-stream frame, or one
 * subagent child event to a state and report whether the rendered snapshot
 * changed; they never touch timers or Feishu. Scheduling and delivery belong
 * to {@link CardDelivery} (`./delivery.ts`); turn ownership to
 * {@link TurnStreamer} (`./streamer.ts`).
 *
 * @module dsh-channels/turn/state
 */

import type { AssistantStreamFrame, SessionEvent, TurnEndReason, UserMessage } from '../host/index.ts'
import type { ChannelPrompt } from '../session/prompt.ts'
import type { PanelPhase } from '../cards/index.ts'
import type { HeaderSample, UsageSample } from '../stats.ts'

/** How a segment card reached Feishu. */
export interface SegmentDelivery {
  messageId: string
  /** `card` segments stream via `updateCard`; `text` messages are final
   *  (delivered as a plain-text fallback and never patched afterwards). */
  mode: 'card' | 'text'
}

/** One segment card of a turn. Card 1 is the attached reply card; further
 *  cards are created lazily when the body overflows the previous card. */
export interface SegmentCard {
  /** Feishu message id; undefined until the segment send resolves. */
  messageId: string | undefined
  /** Body accumulated for this segment (frozen once a later segment exists). */
  body: string
  /** True when the card has unsent content for its message id. */
  dirty: boolean
  /** True once this card stopped accepting body growth. */
  frozen: boolean
  /** Delivery mode once known; `text` segments are never patched. */
  mode: SegmentDelivery['mode'] | undefined
  /** True when delivery failed permanently (logged; never retried again). */
  failed: boolean
  /** True while a segment send is enqueued/in flight (prevents duplicate sends). */
  sending: boolean
  /** Consecutive update failures (drives the retry backoff). */
  failures: number
  /** Earliest timestamp for the next update attempt. */
  nextRetryAt: number
}

/** A Feishu message whose Typing reaction swaps to DONE/No when a turn settles. */
export interface TriggerReaction {
  /** Undefined for a turn no Feishu message started (no reaction to swap). */
  triggerMessageId: string | undefined
  /** Reaction id of the Typing reaction (undefined when the add failed). */
  reactionId: string | undefined
}

/** Settled outcome of one turn, as its card shows it. */
export type TurnOutcome = 'done' | 'stopped' | 'error'

/** A failure the settled card reports in its body. */
export interface TurnFailure {
  message: string
  code?: string
}

export interface TurnState {
  /** `AttachOptions.onSettled`. */
  onSettled: ((outcome: TurnOutcome) => void) | undefined
  /**
   * Turn number once the Agent claimed this state's prompt (or, for a host
   * turn, the turn it was created for); undefined while queued.
   */
  turn: number | undefined
  /** Message whose reaction carries Typing → DONE/No; undefined for a host turn. */
  triggerMessageId: string | undefined
  /** Origin line of a host turn's card (see `StreamerHooks.hostTurnOrigin`). */
  origin: string | undefined
  /** Reaction id of the Typing reaction (undefined when the add failed). */
  reactionId: string | undefined
  /** Prompt submitted for this turn; a queued card can steer it into the running turn. Undefined for a host turn. */
  prompt: ChannelPrompt | undefined
  /** The claimed message of a host turn (restart snapshot); undefined for a Feishu-started turn. */
  message: UserMessage | undefined
  /** Triggers of queued messages merged into this turn (settle together). */
  mergedTriggers: TriggerReaction[]
  phase: PanelPhase
  reasoning: string
  /**
   * Request header in effect for a request THIS turn sent. DSH logs
   * `request/header` only when the request envelope changes, so a turn whose
   * requests continue the series adopts the session's latest header once it
   * actually sends one; a turn that never sends a request keeps `undefined`.
   */
  header: HeaderSample | undefined
  /** Provider usage produced during THIS turn; never inherited from history. */
  lastUsage: UsageSample | undefined
  /** Segment cards in order; `cards[0]` is the attached reply card. */
  cards: SegmentCard[]
  dirty: boolean
  lastPatchAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  finalized: boolean
  /** Set by `detach()`; pending sends then stop scheduling further patches. */
  disposed: boolean
  /** Unix ms when the turn started (attach, reset when a queued prompt is claimed). */
  turnStartedAt: number
  /** Wall-clock start of the currently open reasoning phase (undefined = not reasoning). */
  reasoningSince: number | undefined
  /** Accumulated wall-clock time the turn spent reasoning, in ms. A phase
   *  opens at the first reasoning delta and closes when the step's output ends
   *  (first answer text or step end), so tool execution is never counted. */
  reasoningMs: number
  /** The in-flight tool call, if any (cleared by its `tool/result`). */
  toolActivity: { name: string; label: string; since: number } | undefined
  /** Tool names whose approval card is still undecided (shown over the tool line). */
  awaitingApproval: readonly string[]
  /** Live workflow-run folds projected by the workflow tool into this session. */
  workflowRuns: Map<string, WorkflowRun>
  /** The last settled workflow run (kept visible until the next activity). */
  workflowEndStatus: { name: string; stopReason: string } | undefined
  /**
   * Live subagent child sessions folded into this turn (child session id →
   * status). Children are discovered through `session.header.parentSession`
   * and removed when their own turn ends.
   */
  children: Map<string, ChildActivity>
  /**
   * Labels of subagent children that FINISHED during this turn (capped). They
   * leave the live `children` fold at their turn/end but are summarized on
   * the settled card: `🤖 子代理完成：a、b`.
   */
  settled: string[]
  /** Currently rendered delegation status line (recomputed on every snapshot). */
  status: string
  /** Kind of the status line currently logged (change-detection only). */
  statusKind: string
  /** Currently rendered headline (recomputed on every snapshot). */
  headline: string
  /** Kind of the headline currently logged (change-detection only). */
  headlineKind: string
  /**
   * What the current stream attempt is producing: reasoning or answer text;
   * undefined between steps, before the first delta, and during tool calls.
   */
  output: 'reasoning' | 'text' | undefined
  /** An `ask_user_question` card of this session is unanswered. */
  awaitingAnswer: boolean
  /** A context compaction of this turn is running (`compaction/start` → `compaction/end`). */
  compacting: boolean
  /** Unix ms when the turn settled; undefined while it runs. */
  endedAt: number | undefined
  /** The queued message left the agent inbox unclaimed; the card says so instead of a reply. */
  dropped: boolean
  /** The steer button is moving the queued message; its inbox removal is not a drop. */
  merging: boolean
  /** Slow keep-alive timer re-rendering the activity elapsed counter. */
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Rollback marks for live stream attempts (`attemptId` → lengths at the
   * attempt's `start` frame). An `abandoned` attempt's deltas never reach the
   * durable model history, so the card must drop them again.
   */
  attempts: Map<string, AttemptMark>
  /**
   * The model-request retry `dsh-llm-retry` scheduled for the current step
   * (`llm/retry`), shown on the tool line until the retried request produces
   * output. A retry stays inside the open turn: only `turn/end` settles it.
   */
  retry: RetryActivity | undefined
  /** Retries scheduled during this turn (reported on a failed settled card). */
  retries: number
  /** The owner clicked stop; the button renders disabled until the turn settles. */
  stopRequested: boolean
  /** A non-owner clicked stop; the owner-only notice renders under the button. */
  stopDenied: boolean
  /** A non-owner clicked the queued card's steer button. */
  queuedDenied: boolean
}

/** One scheduled model-request retry (`llm/retry` → `llm/retry-started`). */
export interface RetryActivity {
  /** 1-based retry number. */
  retry: number
  /** Normal-mode budget; undefined in always mode. */
  maxRetries: number | undefined
  /** Failure code of the attempt that triggered the retry. */
  code: string
  /** Unix ms when the backoff wait ends. */
  until: number
  /** Set by `llm/retry-started`: the retried request is in flight. */
  started: boolean
}

/** Card/body lengths captured at one stream attempt's `start` frame. */
export interface AttemptMark {
  cardCount: number
  bodyLengths: number[]
  reasoningLength: number
  reasoningMs: number
  reasoningSince: number | undefined
}

/** One live `tool-workflow/run-*` fold: run identity and member progress. */
export interface WorkflowRun {
  name: string
  startedAt: number
  /** Members started so far. */
  started: number
  /** Members settled so far. */
  ended: number
  /** Still-running members (started minus ended), in start order. */
  active: Array<{ seq: number; label: string }>
  /** Latest phase declared by a member (`phase()` in the workflow script). */
  phase?: string
  /**
   * Child session ids of this run's members — their own events are already
   * aggregated by the workflow line and must not be folded again as generic
   * children.
   */
  memberIds: Set<string>
}

/** One running subagent child's displayable status. */
export interface ChildActivity {
  /** Delegation description (subagent/descriptor label), default 子代理. */
  label: string
  /** The child's latest tool call, if any. */
  tool?: string
  /** When the child was first observed (elapsed base). */
  since: number
}

/** Identity and trigger of a new turn state. */
export interface TurnStateInit {
  onSettled: ((outcome: TurnOutcome) => void) | undefined
  triggerMessageId: string | undefined
  reactionId: string | undefined
  prompt: ChannelPrompt | undefined
  message: UserMessage | undefined
  origin: string | undefined
  /** The already-sent main card; undefined when the card is still to be sent. */
  cardMessageId: string | undefined
}

/**
 * A segment card that has not been sent yet.
 * @param body - the segment's initial body.
 * @returns the unsent card.
 */
export function freshSegment(body: string): SegmentCard {
  return {
    messageId: undefined,
    body,
    dirty: true,
    frozen: false,
    mode: undefined,
    failed: false,
    sending: false,
    failures: 0,
    nextRetryAt: 0,
  }
}

/**
 * A fresh, unbound turn state with one main card.
 * @param init - the turn's identity and trigger.
 * @returns the state.
 */
export function newTurnState(init: TurnStateInit): TurnState {
  return {
    onSettled: init.onSettled,
    turn: undefined,
    triggerMessageId: init.triggerMessageId,
    reactionId: init.reactionId,
    prompt: init.prompt,
    message: init.message,
    origin: init.origin,
    mergedTriggers: [],
    phase: 'thinking',
    reasoning: '',
    header: undefined,
    lastUsage: undefined,
    cards: [init.cardMessageId === undefined
      ? freshSegment('')
      : { ...freshSegment(''), messageId: init.cardMessageId, mode: 'card' }],
    dirty: true,
    lastPatchAt: 0,
    timer: undefined,
    finalized: false,
    disposed: false,
    turnStartedAt: Date.now(),
    reasoningSince: undefined,
    reasoningMs: 0,
    toolActivity: undefined,
    awaitingApproval: [],
    workflowRuns: new Map(),
    workflowEndStatus: undefined,
    children: new Map(),
    settled: [],
    status: '',
    statusKind: '',
    headline: '',
    headlineKind: '',
    output: undefined,
    awaitingAnswer: false,
    compacting: false,
    endedAt: undefined,
    dropped: false,
    merging: false,
    heartbeatTimer: undefined,
    attempts: new Map(),
    retry: undefined,
    retries: 0,
    stopRequested: false,
    stopDenied: false,
    queuedDenied: false,
  }
}

/**
 * Human label for one tool call: the subagent tool contributes its
 * `description`, the workflow tool its `meta.name`; anything else uses the
 * bare tool name. Arguments are model-produced JSON — parsing failures fall
 * back to the tool name instead of failing the fold.
 */
function toolActivityLabel(name: string, rawArguments: string): string {
  if (name !== 'subagent' && name !== 'workflow') return name
  try {
    const args = JSON.parse(rawArguments) as Record<string, unknown>
    if (name === 'subagent' && typeof args.description === 'string' && args.description !== '') {
      return args.description
    }
    if (name === 'workflow') {
      const meta = args.meta as Record<string, unknown> | undefined
      if (meta !== undefined && typeof meta.name === 'string' && meta.name !== '') return meta.name
    }
  } catch {
    // Unparseable arguments: fall back to the bare tool name.
  }
  return name
}

/** `completed`/`failed`/`cancelled` → the Chinese line fragment. */
const WORKFLOW_OUTCOMES: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  error: '失败',
}

/**
 * Give a turn that sent a request without logging a new `request/header` the
 * session's latest header, which is the one that request continues.
 * @param state - the running turn.
 * @param seriesHeader - the session's latest logged header.
 * @returns whether the turn's header changed.
 */
export function adoptSeriesHeader(state: TurnState, seriesHeader: HeaderSample | undefined): boolean {
  if (state.header !== undefined) return false
  state.header = seriesHeader
  return state.header !== undefined
}

/**
 * Apply one event of the turn's own session to its state. The caller has
 * already matched the event's turn number.
 * @param state - the running turn.
 * @param event - the appended event.
 * @param seriesHeader - the session's latest logged header.
 * @returns whether the rendered snapshot changed.
 */
export function foldTurnEvent(state: TurnState, event: SessionEvent, seriesHeader: HeaderSample | undefined): boolean {
  switch (event.type) {
    case 'assistant/message': {
      adoptSeriesHeader(state, seriesHeader)
      let changed = false
      if (state.retry !== undefined) {
        state.retry = undefined
        changed = true
      }
      if (event.data.usage !== undefined) {
        state.lastUsage = {
          usage: event.data.usage,
          turn: event.data.turn,
          step: event.data.step,
        }
        changed = true
      }
      return changed
    }
    case 'request/header': {
      const config = event.data.header.config
      // Parse this exact event instead of copying the session fold's latest
      // sample, so malformed/current events can never expose prior history.
      state.header = {
        provider: typeof config.provider === 'string' ? config.provider : '',
        model: typeof config.model === 'string' ? config.model : '',
        effort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
      }
      return true
    }
    case 'tool/call': {
      state.output = undefined
      // The tool line is independent: it never supersedes the settled
      // workflow end status on the delegation line (both render together).
      state.toolActivity = {
        name: event.data.name,
        label: toolActivityLabel(event.data.name, event.data.arguments),
        since: Date.now(),
      }
      return true
    }
    case 'tool/result': {
      state.toolActivity = undefined
      return true
    }
    case 'tool-workflow/run-start': {
      // Workflow record events carry no turn/step — they belong to the
      // running turn by construction.
      state.workflowRuns.set(event.data.runId, {
        name: event.data.name,
        startedAt: Date.now(),
        started: 0,
        ended: 0,
        active: [],
        memberIds: new Set(),
      })
      state.workflowEndStatus = undefined
      return true
    }
    case 'tool-workflow/agent-start': {
      const run = state.workflowRuns.get(event.data.runId)
      if (run === undefined) return false
      run.started++
      run.active.push({ seq: event.data.seq, label: event.data.label })
      run.memberIds.add(event.data.childId)
      if (event.data.phase !== undefined) run.phase = event.data.phase
      return true
    }
    case 'tool-workflow/agent-end': {
      const run = state.workflowRuns.get(event.data.runId)
      if (run === undefined) return false
      run.ended++
      const index = run.active.findIndex(member => member.seq === event.data.seq)
      if (index >= 0) run.active.splice(index, 1)
      return true
    }
    case 'tool-workflow/run-end': {
      const run = state.workflowRuns.get(event.data.runId)
      if (run === undefined) return false
      state.workflowRuns.delete(event.data.runId)
      state.workflowEndStatus = {
        name: run.name,
        stopReason: WORKFLOW_OUTCOMES[event.data.stopReason] ?? event.data.stopReason,
      }
      return true
    }
    case 'compaction/start':
    case 'compaction/end': {
      state.compacting = event.type === 'compaction/start'
      return true
    }
    case 'llm/retry': {
      // The failed attempt ended the step's request, not the turn: the loop
      // re-runs the step after the backoff, so the card stays live.
      state.retry = {
        retry: event.data.retry,
        maxRetries: event.data.mode === 'normal' ? event.data.maxRetries : undefined,
        code: event.data.failure.code,
        until: Date.now() + Math.max(0, event.data.delayMs),
        started: false,
      }
      state.retries++
      return true
    }
    case 'llm/retry-started': {
      if (state.retry === undefined || state.retry.retry !== event.data.retry) return false
      state.retry.started = true
      return true
    }
    default:
      return false
  }
}

/**
 * Apply one live assistant-stream frame (`agent/assistant-stream`) to the
 * running turn. `start` records rollback marks; `end` keeps the deltas only
 * when the attempt committed to the durable log — an `abandoned` or failed
 * attempt's text is not model-visible history and leaves the card again.
 * The caller has already matched a `start` frame's turn.
 * @param state - the running turn.
 * @param frame - the frame.
 * @param seriesHeader - the session's latest logged header.
 * @returns whether the rendered snapshot changed.
 */
export function foldAssistantFrame(
  state: TurnState,
  frame: AssistantStreamFrame,
  seriesHeader: HeaderSample | undefined,
): boolean {
  switch (frame.type) {
    case 'start': {
      // A new step starts: close any reasoning phase the previous step left
      // open (defensive — its `end` frame normally does this first).
      closeReasoning(state)
      state.attempts.set(frame.attemptId, attemptMark(state))
      return adoptSeriesHeader(state, seriesHeader)
    }
    case 'chunk': {
      const chunk = frame.chunk
      let changed = false
      if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        && chunk.text !== '' && state.retry !== undefined) {
        // The retried request is producing output again.
        state.retry = undefined
        changed = true
      }
      if (chunk.type === 'text-delta') {
        if (chunk.text !== '') {
          closeReasoning(state)
          if (state.output !== 'text') {
            state.output = 'text'
            changed = true
          }
        }
        const last = state.cards[state.cards.length - 1]
        if (last !== undefined && !last.frozen && chunk.text !== '') {
          last.body += chunk.text
          if (state.phase === 'thinking') state.phase = 'replying'
          changed = true
        }
      } else if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
        if (state.reasoningSince === undefined) state.reasoningSince = Date.now()
        state.output = 'reasoning'
        state.reasoning += chunk.text
        changed = true
      }
      return changed
    }
    case 'end': {
      // The step's output is complete: a reasoning phase that ended with a
      // tool call (no answer text) stops counting here, so the tool run that
      // follows is not miscounted as reasoning time.
      closeReasoning(state)
      state.output = undefined
      const mark = state.attempts.get(frame.attemptId)
      state.attempts.delete(frame.attemptId)
      // A failed request attempt settles as `assistant/attempt`: like an
      // abandoned one, its partial output is not model-visible history, and
      // a retry streams the step again from scratch — keeping it would
      // repeat the reply on the card.
      const discarded = frame.outcome.kind === 'abandoned'
        || frame.outcome.eventType === 'assistant/attempt'
      if (discarded && mark !== undefined) rollbackAttempt(state, mark)
      return true
    }
  }
}

/**
 * Apply one event from a subagent child session to its parent turn. Only
 * identity/progress signals are kept — the child's text output stays out of
 * the user-facing card (the parent model receives it as the tool result and
 * composes the final reply itself). Workflow members are skipped: their
 * childId is recorded on the run fold and the workflow line already
 * aggregates them.
 * @param state - the parent's running turn.
 * @param childId - the child Session.
 * @param event - the child's appended event.
 * @returns whether the rendered snapshot changed.
 */
export function foldChildEvent(state: TurnState, childId: string, event: SessionEvent): boolean {
  for (const run of state.workflowRuns.values()) {
    if (run.memberIds.has(childId)) return false
  }
  switch (event.type) {
    case 'subagent/descriptor': {
      const label = typeof event.data.label === 'string' && event.data.label !== ''
        ? event.data.label
        : '子代理'
      const existing = state.children.get(childId)
      if (existing === undefined) {
        state.children.set(childId, { label, tool: undefined, since: Date.now() })
      } else if (existing.label === '子代理') {
        existing.label = label
      }
      return true
    }
    case 'tool/call': {
      const existing = state.children.get(childId)
      if (existing === undefined) {
        state.children.set(childId, { label: '子代理', tool: event.data.name, since: Date.now() })
      } else {
        existing.tool = event.data.name
      }
      return true
    }
    case 'tool/result': {
      const existing = state.children.get(childId)
      if (existing === undefined || existing.tool === undefined) return false
      existing.tool = undefined
      return true
    }
    case 'turn/end': {
      const entry = state.children.get(childId)
      if (entry === undefined) return false
      state.children.delete(childId)
      // A finished child leaves the live fold but is summarized on the
      // settled card (capped; placeholder labels are skipped).
      if (entry.label !== '子代理' && state.settled.length < 3) {
        state.settled.push(entry.label)
      }
      return true
    }
    default:
      return false
  }
}

/**
 * Close an open reasoning phase, accumulating its wall-clock time.
 * @param state - the turn.
 * @param now - the closing time.
 */
export function closeReasoning(state: TurnState, now = Date.now()): void {
  if (state.reasoningSince === undefined) return
  state.reasoningMs += Math.max(0, now - state.reasoningSince)
  state.reasoningSince = undefined
}

/** Capture the card/body lengths an attempt's deltas start from. */
function attemptMark(state: TurnState): AttemptMark {
  return {
    cardCount: state.cards.length,
    bodyLengths: state.cards.map(card => card.body.length),
    reasoningLength: state.reasoning.length,
    reasoningMs: state.reasoningMs,
    reasoningSince: state.reasoningSince,
  }
}

/**
 * Drop one discarded attempt's deltas. The attempt's text is a contiguous
 * suffix of the logical body: segments created during the attempt are
 * removed, the segment that was last at `start` is truncated, and the
 * reasoning tail is cut. Already-delivered plain-text segments cannot be
 * retracted and stop the removal; segment cards already sent (or being
 * sent) cannot be withdrawn, so they are emptied and kept. The newest
 * remaining card is reopened so a retry streams into it again.
 */
function rollbackAttempt(state: TurnState, mark: AttemptMark): void {
  const lastIndex = mark.cardCount - 1
  for (let index = state.cards.length - 1; index > lastIndex; index -= 1) {
    const card = state.cards[index]
    if (card === undefined) continue
    if (card.mode === 'text' && card.messageId !== undefined) break
    if (card.messageId !== undefined || card.sending) {
      card.body = ''
      card.dirty = true
      continue
    }
    state.cards.splice(index, 1)
  }
  const tail = state.cards[lastIndex]
  const length = mark.bodyLengths[lastIndex]
  if (tail !== undefined && length !== undefined
    && !(tail.mode === 'text' && tail.messageId !== undefined)) {
    tail.body = tail.body.slice(0, length)
    tail.dirty = true
  }
  const last = state.cards[state.cards.length - 1]
  if (last !== undefined) {
    if ((last.mode === 'text' && last.messageId !== undefined) || last.failed) {
      state.cards.push(freshSegment(''))
    } else {
      last.frozen = false
    }
  }
  state.reasoning = state.reasoning.slice(0, mark.reasoningLength)
  // The discarded attempt's reasoning time is not part of the visible turn.
  state.reasoningMs = mark.reasoningMs
  state.reasoningSince = mark.reasoningSince
}

/**
 * Settle a turn's state: outcome phase, reasoning time, and the failure
 * notice appended to the body. Timers and card delivery are the caller's.
 * Only a stop this channel requested reads as 已停止; other cancellation
 * causes (parent, hook, disposal) settle like a normal end.
 * @param state - the unsettled turn.
 * @param failure - the failure to report, when the turn failed.
 * @param aborted - whether the turn ended through a cancellation request.
 */
export function settleTurnState(state: TurnState, failure: TurnFailure | undefined, aborted: boolean): void {
  state.finalized = true
  state.endedAt = Date.now()
  state.phase = failure !== undefined ? 'error' : state.dropped || (aborted && state.stopRequested) ? 'stopped' : 'done'
  // A turn that ends inside a reasoning phase (e.g. no answer text) still
  // reports the time it spent reasoning.
  closeReasoning(state)
  if (failure !== undefined) {
    const code = failure.code === undefined ? '' : `\n\n错误码：\`${failure.code}\``
    const retried = state.retries === 0 ? '' : `\n\n已自动重试 ${state.retries} 次`
    const notice = `❌ **本轮运行失败**\n\n${failure.message}${code}${retried}`
    const tail = state.cards[state.cards.length - 1]
    if (tail !== undefined) {
      if (tail.mode === 'text' || tail.failed) {
        // An already-delivered plain-text fallback cannot be patched, and a
        // permanently failed card cannot surface new content. Put the
        // terminal diagnostic in its own continuation card instead.
        state.cards.push(freshSegment(notice))
      } else {
        tail.body = tail.body.trim() === '' ? notice : `${tail.body}\n\n${notice}`
        tail.dirty = true
      }
    }
  }
  state.retry = undefined
  state.output = undefined
}

/**
 * The settled outcome of a finalized state.
 * @param state - the finalized turn.
 * @returns its outcome.
 */
export function outcomeOf(state: TurnState): TurnOutcome {
  return state.phase === 'error' ? 'error' : state.phase === 'stopped' ? 'stopped' : 'done'
}

/**
 * Whether a turn ended through a cancellation request (`/stop`, the stop button).
 * @param reason - the `turn/end` reason.
 * @returns true for an aborted turn.
 */
export function turnAborted(reason: TurnEndReason): boolean {
  return typeof reason === 'object' && reason !== null && reason.kind === 'aborted'
}

/**
 * Extract the user-visible failure from the current Harness turn-end union.
 * @param reason - the `turn/end` reason.
 * @returns the failure, or undefined when the turn did not fail.
 */
export function turnFailure(reason: TurnEndReason): TurnFailure | undefined {
  if (typeof reason !== 'object' || reason === null || reason.kind !== 'error') return undefined
  const error = reason.error
  const message = typeof error?.message === 'string' && error.message !== ''
    ? error.message
    : '模型请求失败'
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined
  return { message, code }
}
