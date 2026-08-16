/**
 * Per-turn streaming card state: folds live session events into card snapshots
 * and patches the Feishu card on a fixed refresh interval (default 500 ms).
 *
 * Lifecycle per (session, user message):
 *  1. `attach()` — the reply card was just sent; bind it to the session as
 *     segment 1.
 *  2. `session/event` consumption — text deltas fill the body, reasoning
 *     deltas fill the fold panel, usage/header events advance the stats fold,
 *     and tool-call / workflow-record events feed the two transient activity
 *     lines: the delegation status line (子代理 / 工作流 progress, settled
 *     workflow outcome, heartbeat) and the tool line (the parent's in-flight
 *     tool call). The lines are INDEPENDENT — a later tool call never
 *     supersedes the settled workflow status. Subagent children live in their
 *     own sessions: their `subagent/descriptor` / `tool/call` / `turn/end`
 *     events are folded into the parent turn's status line through
 *     `session.header.parentSession` (status only — the child's text output
 *     never reaches the card).
 *  3. When the body outgrows one card's budget, the overflow is split at a
 *     clean breakpoint and sent as a continuation segment card (segment 2, 3,
 *     …) into the same topic; the stream then keeps flowing into the newest
 *     card. Reasoning is never segmented — it stays on card 1 and is clipped
 *     to the leftover budget (body has priority).
 *  4. `turnEnded(turn)` — finalize every segment card (`回复结束`) and request
 *     the Typing → DONE reaction swap on the triggering message.
 *
 * The first visible text delta flips the panel title 推理中 → 回复中; the
 * final patch flips it to 回复结束. Patching is throttled to `refreshMs` and
 * only runs when the content actually changed. Segment sends are serialized
 * per session so cards arrive in order.
 *
 * Keep-alive: turns that produce no text deltas for a while (tool calls,
 * subagent/workflow runs, provider-side work) are kept visibly alive by the
 * activity lines, whose elapsed counters are re-rendered on a slow heartbeat
 * (`heartbeatMs`, default 5 s) — the card never sits silently on a live turn.
 *
 * @module dsh-channels/streamer
 */

import type { Session, SessionEvent } from './dsh-types.ts'
import { buildCard, segmentCardContent } from './cards.ts'
import type { CardState, PanelPhase } from './cards.ts'
import type { FeishuChannel } from './feishu-channel.ts'
import { cacheHitPct, foldAll, foldEvent } from './stats.ts'
import type { StatsFold } from './stats.ts'

/**
 * Compact build marker printed by the service at startup so a deployment's
 * console can confirm which build of the activity status line is loaded.
 * Bump on every behavior change to this feature.
 */
export const ACTIVITY_BUILD_MARKER = 'activity-status-v3'

/** How a segment card reached Feishu. */
export interface SegmentDelivery {
  messageId: string
  /** `card` segments stream via `updateCard`; `text` messages are final
   *  (delivered as a plain-text fallback and never patched afterwards). */
  mode: 'card' | 'text'
}

export interface StreamerHooks {
  /** Fetch current context pressure for one session (may be expensive → cached by caller). */
  measureContext(session: Session): { contextTokens?: number; contextWindow?: number }
  /** Resolve the session id label shown on the card. */
  sessionLabel(sessionId: string): string
  /** Log a non-fatal streaming error. */
  onError(sessionId: string, error: unknown): void
  /**
   * Invoked once when a turn's card reaches its final state. Carries the main
   * card's message id so the caller can retire the turn's in-flight repair
   * snapshot (the id is the snapshot's storage key).
   */
  onTurnFinalized(sessionId: string, turn: number, mainCardMessageId: string): void
  /**
   * Invoked when a continuation segment's message id resolves (delivery
   * succeeded). Lets the caller fold the resolved id into the turn's repair
   * snapshot. `segmentIndex` is the card index within the turn (`0` is the
   * main card; never reported).
   */
  onSegmentDelivered?(
    mainCardMessageId: string,
    segmentIndex: number,
    messageId: string,
    mode: SegmentDelivery['mode'],
  ): void
  /**
   * Send one continuation segment card for a turn (calls arrive in segment
   * order per session). Implementations may fall back to a plain-text message
   * (reporting `mode: 'text'`) when the card is rejected — e.g. Feishu's
   * per-card table limit (error 11310) — so the content always reaches the
   * user. `fallbackText` carries the raw segment body for that fallback.
   */
  sendSegmentCard(
    sessionId: string,
    segment: number,
    card: object,
    fallbackText: string,
  ): Promise<SegmentDelivery>
}

/** One segment card of a turn. Card 1 is the attached reply card; further
 *  cards are created lazily when the body overflows the previous card. */
interface SegmentCard {
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

interface TurnState {
  /** Turn number once known; undefined until the first `step/start`. */
  turn: number | undefined
  /** Message whose reaction carries Typing → DONE. */
  triggerMessageId: string
  /** Reaction id of the Typing reaction (undefined when the add failed). */
  reactionId: string | undefined
  phase: PanelPhase
  reasoning: string
  /** Segment cards in order; `cards[0]` is the attached reply card. */
  cards: SegmentCard[]
  dirty: boolean
  lastPatchAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  finalized: boolean
  /** Set by `detach()`; pending sends then stop scheduling further patches. */
  disposed: boolean
  /** Unix ms when the turn was attached (heartbeat elapsed base). */
  turnStartedAt: number
  /** The in-flight tool call, if any (cleared by its `tool/result`). */
  toolActivity: { name: string; label: string; since: number } | undefined
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
  /** Currently rendered tool-call line (recomputed on every snapshot). */
  tool: string
  /** Kind of the tool line currently logged (change-detection only). */
  toolKind: string
  /** Slow keep-alive timer re-rendering the activity elapsed counter. */
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined
}

/** One live `tool-workflow/run-*` fold: run identity and member progress. */
interface WorkflowRun {
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
interface ChildActivity {
  /** Delegation description (subagent/descriptor label), default 子代理. */
  label: string
  /** The child's latest tool call, if any. */
  tool?: string
  /** When the child was first observed (elapsed base). */
  since: number
}

/** Hard cap on the activity line so it can never threaten the card budget. */
const ACTIVITY_MAX_CHARS = 64

/** Trim an activity line to `ACTIVITY_MAX_CHARS` (ellipsis counts as one char). */
function clipActivity(line: string): string {
  return line.length <= ACTIVITY_MAX_CHARS ? line : `${line.slice(0, ACTIVITY_MAX_CHARS - 1)}…`
}

/** `已运行 45s` / `已运行 2分5s` — the activity line's elapsed counter. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `已运行 ${total}s`
  return `已运行 ${Math.floor(total / 60)}分${total % 60}s`
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

export class TurnStreamer {
  private readonly channel: FeishuChannel
  private readonly refreshMs: number
  private readonly hooks: StreamerHooks
  /** Slow keep-alive interval for the activity line's elapsed counter. */
  private readonly heartbeatMs: number
  /** sessionId → queue of turn states (FIFO consumption of the driver). */
  private readonly bySession = new Map<string, TurnState[]>()
  /** sessionId → session-log stats fold (session cumulative). */
  private readonly folds = new Map<string, StatsFold>()
  /** sessionId → the Session object for context measurement. */
  private readonly sessions = new Map<string, Session>()
  /** sessionId → context pressure cache (refreshed every N patches). */
  private readonly contextCache = new Map<string, { contextTokens?: number; contextWindow?: number }>()
  /** sessionId → serialized segment-send chain (keeps card order). */
  private readonly segmentChains = new Map<string, Promise<void>>()

  constructor(channel: FeishuChannel, refreshMs: number, hooks: StreamerHooks, heartbeatMs: number = 5_000) {
    this.channel = channel
    this.refreshMs = refreshMs
    this.hooks = hooks
    this.heartbeatMs = heartbeatMs
  }

  /** Bind a freshly sent reply card to a session; seeds the stats fold from the log. */
  attach(session: Session, cardMessageId: string, triggerMessageId: string, reactionId: string | undefined): void {
    this.sessions.set(session.id, session)
    let fold = this.folds.get(session.id)
    if (fold === undefined) {
      fold = foldAll(session.events)
      this.folds.set(session.id, fold)
    }
    const queue = this.bySession.get(session.id) ?? []
    queue.push({
      turn: undefined,
      triggerMessageId,
      reactionId,
      phase: 'thinking',
      reasoning: '',
      cards: [{
        messageId: cardMessageId,
        body: '',
        dirty: true,
        frozen: false,
        mode: 'card',
        failed: false,
        sending: false,
        failures: 0,
        nextRetryAt: 0,
      }],
      dirty: true,
      lastPatchAt: 0,
      timer: undefined,
      finalized: false,
      disposed: false,
      turnStartedAt: Date.now(),
      toolActivity: undefined,
      workflowRuns: new Map(),
      workflowEndStatus: undefined,
      children: new Map(),
      settled: [],
      status: '',
      statusKind: '',
      tool: '',
      toolKind: '',
      heartbeatTimer: undefined,
    })
    this.bySession.set(session.id, queue)
    const state = queue[queue.length - 1]!
    this.scheduleHeartbeat(session.id, state)
  }

  /** Drop all state for a session (agent disposed / route removed). */
  detach(sessionId: string): void {
    const queue = this.bySession.get(sessionId) ?? []
    for (const state of queue) {
      state.disposed = true
      if (state.timer !== undefined) clearTimeout(state.timer)
      if (state.heartbeatTimer !== undefined) clearTimeout(state.heartbeatTimer)
    }
    this.bySession.delete(sessionId)
    this.folds.delete(sessionId)
    this.sessions.delete(sessionId)
    this.contextCache.delete(sessionId)
    this.segmentChains.delete(sessionId)
  }

  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  /** The front (oldest unfinished) turn state of a session. */
  private front(sessionId: string): TurnState | undefined {
    const queue = this.bySession.get(sessionId)
    if (queue === undefined || queue.length === 0) return undefined
    for (const state of queue) {
      if (!state.finalized) return state
    }
    return undefined
  }

  /** Consume one appended session event. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const fold = this.folds.get(session.id)
    if (fold !== undefined) foldEvent(fold, event)
    this.sessions.set(session.id, session)

    // Subagent children live in their OWN sessions (header.parentSession →
    // caller). Their events never touch the parent's log, so fold their
    // status into the parent turn's activity line here.
    const parentId = session.header.parentSession
    if (parentId !== undefined) {
      const parentState = this.front(parentId)
      if (parentState !== undefined) {
        this.foldChildEvent(parentId, parentState, session, event)
        return
      }
    }

    const state = this.front(session.id)
    if (state === undefined) return

    switch (event.type) {
      case 'step/start': {
        if (state.turn === undefined) {
          state.turn = event.data.turn
          this.markDirty(session.id, state)
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (state.turn === undefined) state.turn = event.data.turn
        switch (chunk.type) {
          case 'text-delta': {
            const last = state.cards[state.cards.length - 1]
            if (last !== undefined && !last.frozen) {
              last.body += chunk.text
              if (state.phase === 'thinking') state.phase = 'replying'
              this.markDirty(session.id, state)
            }
            break
          }
          case 'reasoning-delta': {
            state.reasoning += chunk.text
            this.markDirty(session.id, state)
            break
          }
          default:
            break
        }
        break
      }
      case 'tool/call': {
        if (state.turn === undefined) state.turn = event.data.turn
        state.toolActivity = {
          name: event.data.name,
          label: toolActivityLabel(event.data.name, event.data.arguments),
          since: Date.now(),
        }
        // The tool line is independent: it never supersedes the settled
        // workflow end status on the delegation line (both render together).
        this.markDirty(session.id, state)
        break
      }
      case 'tool/result': {
        if (state.turn === undefined) state.turn = event.data.turn
        state.toolActivity = undefined
        this.markDirty(session.id, state)
        break
      }
      case 'tool-workflow/run-start': {
        // Workflow record events carry no turn/step — they belong to the
        // front (oldest unfinished) turn by construction.
        state.workflowRuns.set(event.data.runId, {
          name: event.data.name,
          startedAt: Date.now(),
          started: 0,
          ended: 0,
          active: [],
          memberIds: new Set(),
        })
        state.workflowEndStatus = undefined
        this.markDirty(session.id, state)
        break
      }
      case 'tool-workflow/agent-start': {
        const run = state.workflowRuns.get(event.data.runId)
        if (run !== undefined) {
          run.started++
          run.active.push({ seq: event.data.seq, label: event.data.label })
          run.memberIds.add(event.data.childId)
          if (event.data.phase !== undefined) run.phase = event.data.phase
          this.markDirty(session.id, state)
        }
        break
      }
      case 'tool-workflow/agent-end': {
        const run = state.workflowRuns.get(event.data.runId)
        if (run !== undefined) {
          run.ended++
          const index = run.active.findIndex(member => member.seq === event.data.seq)
          if (index >= 0) run.active.splice(index, 1)
          this.markDirty(session.id, state)
        }
        break
      }
      case 'tool-workflow/run-end': {
        const run = state.workflowRuns.get(event.data.runId)
        if (run !== undefined) {
          state.workflowRuns.delete(event.data.runId)
          state.workflowEndStatus = {
            name: run.name,
            stopReason: WORKFLOW_OUTCOMES[event.data.stopReason] ?? event.data.stopReason,
          }
          this.markDirty(session.id, state)
        }
        break
      }
      case 'turn/end': {
        // The ended turn belongs to the front state: assign it if a turn was
        // rejected/emptied before any step started.
        if (state.turn === undefined) state.turn = event.data.turn
        this.finalize(session.id, state)
        break
      }
      default:
        break
    }
  }

  private markDirty(sessionId: string, state: TurnState): void {
    if (state.disposed) return
    state.dirty = true
    if (state.timer !== undefined) return
    const wait = state.lastPatchAt === 0
      ? this.refreshMs
      : Math.max(0, this.refreshMs - (Date.now() - state.lastPatchAt))
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.flush(sessionId, state)
    }, wait)
  }

  private statsFor(sessionId: string): CardState['stats'] {
    const fold = this.folds.get(sessionId)
    const lastUsage = fold?.lastUsage
    const header = fold?.lastHeader
    const cached = this.contextCache.get(sessionId)
    const session = this.sessions.get(sessionId)
    let context = cached
    if (session !== undefined) {
      try {
        context = this.hooks.measureContext(session)
        this.contextCache.set(sessionId, context)
      } catch {
        context = cached
      }
    }
    return {
      sessionId: this.hooks.sessionLabel(sessionId),
      inputTokens: fold?.totals.inputTokens ?? 0,
      outputTokens: fold?.totals.outputTokens ?? 0,
      cacheHitPct: cacheHitPct(lastUsage),
      contextTokens: context?.contextTokens,
      contextWindow: context?.contextWindow,
      model: header?.model,
      effort: header?.effort,
    }
  }

  /**
   * Fold one event from a subagent child session into its parent turn's
   * activity state. Only identity/progress signals are kept — the child's
   * text output stays out of the user-facing card (the parent model receives
   * it as the tool result and composes the final reply itself).
   *
   * Workflow members are skipped here: their childId is recorded on the run
   * fold and the workflow line already aggregates them.
   */
  private foldChildEvent(parentId: string, state: TurnState, child: Session, event: SessionEvent): void {
    for (const run of state.workflowRuns.values()) {
      if (run.memberIds.has(child.id)) return
    }
    switch (event.type) {
      case 'subagent/descriptor': {
        const label = typeof event.data.label === 'string' && event.data.label !== ''
          ? event.data.label
          : '子代理'
        const existing = state.children.get(child.id)
        if (existing === undefined) {
          state.children.set(child.id, { label, tool: undefined, since: Date.now() })
        } else if (existing.label === '子代理') {
          existing.label = label
        }
        this.markDirty(parentId, state)
        break
      }
      case 'tool/call': {
        const existing = state.children.get(child.id)
        if (existing === undefined) {
          state.children.set(child.id, { label: '子代理', tool: event.data.name, since: Date.now() })
        } else {
          existing.tool = event.data.name
        }
        this.markDirty(parentId, state)
        break
      }
      case 'tool/result': {
        const existing = state.children.get(child.id)
        if (existing !== undefined && existing.tool !== undefined) {
          existing.tool = undefined
          this.markDirty(parentId, state)
        }
        break
      }
      case 'turn/end': {
        const entry = state.children.get(child.id)
        if (entry === undefined) break
        state.children.delete(child.id)
        // A finished child leaves the live fold but is summarized on the
        // settled card (capped; placeholder labels are skipped).
        if (entry.label !== '子代理' && state.settled.length < 3) {
          state.settled.push(entry.label)
        }
        this.markDirty(parentId, state)
        break
      }
      default:
        break
    }
  }

  /**
   * The delegation status line, by priority:
   *  1. the most recently started live workflow run (member progress + phase);
   *  2. running subagent children (label + current tool + elapsed);
   *  3. the last settled workflow run's outcome — it persists across later
   *     tool calls and text streaming (only a new run-start replaces it), so
   *     the workflow conclusion stays visible;
   *  4. heartbeat fallback — a thinking turn with no output yet still shows
   *     an elapsed counter so the card never sits silently.
   * Once the turn is finalized, the line switches to the SETTLED form
   * (workflow conclusion + finished-subagent summary) — the final card keeps
   * the delegation status; only the tool line disappears.
   */
  private delegationLine(state: TurnState, now: number): string {
    if (state.finalized) return this.settledLine(state)

    let latest: WorkflowRun | undefined
    for (const run of state.workflowRuns.values()) {
      if (latest === undefined || run.startedAt > latest.startedAt) latest = run
    }
    if (latest !== undefined) {
      let line = `🧵 工作流 ${latest.name} · ${latest.ended}/${latest.started} 子代理完成`
      if (latest.phase !== undefined) line += ` · 阶段 ${latest.phase}`
      const labels = latest.active.slice(0, 3).map(member => member.label)
      if (labels.length > 0) line += ` · ${labels.join('、')}`
      line += ` · ${fmtElapsed(now - latest.startedAt)}`
      return clipActivity(line)
    }

    const children = [...state.children.values()]
    if (children.length > 0) {
      const listed = children.slice(0, 2).map(child => {
        const tool = child.tool === undefined ? '' : ` (${child.tool})`
        return `${child.label}${tool}`
      })
      const head = children.length === 1
        ? `🤖 子代理执行中：${listed[0]}`
        : `🤖 ${children.length} 个子代理执行中：${listed.join('、')}${children.length > 2 ? '、…' : ''}`
      const oldest = Math.min(...children.map(child => child.since))
      return clipActivity(`${head} · ${fmtElapsed(now - oldest)}`)
    }

    if (state.workflowEndStatus !== undefined) {
      const { name, stopReason } = state.workflowEndStatus
      return clipActivity(`🧵 工作流 ${name} 结束（${stopReason}）`)
    }

    const empty = state.cards.every(card => card.body === '')
    // The tool line already shows liveness while a call is in flight, so the
    // heartbeat fallback stays out of the way.
    if (state.phase === 'thinking' && empty && state.toolActivity === undefined) {
      return clipActivity(`⏳ 处理中 · ${fmtElapsed(now - state.turnStartedAt)}`)
    }
    return ''
  }

  /**
   * The settled-card form of the delegation status line: the workflow
   * conclusion and/or the finished-subagent summary, without elapsed counters.
   * Still-running (background) children are noted factually. Empty when the
   * turn delegated nothing.
   */
  private settledLine(state: TurnState): string {
    const parts: string[] = []
    if (state.workflowEndStatus !== undefined) {
      const { name, stopReason } = state.workflowEndStatus
      parts.push(`🧵 工作流 ${name} 结束（${stopReason}）`)
    }
    if (state.settled.length > 0) {
      parts.push(`🤖 子代理完成：${state.settled.join('、')}`)
    }
    if (parts.length > 0) return clipActivity(parts.join(' · '))

    const children = [...state.children.values()]
    if (children.length > 0) {
      const listed = children.slice(0, 2).map(child =>
        `${child.label}${child.tool === undefined ? '' : ` (${child.tool})`}`)
      const head = children.length === 1
        ? `🤖 子代理执行中：${listed[0]}`
        : `🤖 ${children.length} 个子代理执行中：${listed.join('、')}${children.length > 2 ? '、…' : ''}`
      return clipActivity(head)
    }
    return ''
  }

  /**
   * The tool-call line: the parent agent's in-flight tool call, independent
   * of the delegation status line — workflow/subagent status never hides it
   * and it never hides them. Cleared by the tool's `tool/result`; always
   * empty on the settled card.
   */
  private toolLine(state: TurnState, now: number): string {
    if (state.finalized) return ''
    const tool = state.toolActivity
    if (tool === undefined) return ''
    const prefix = tool.name === 'subagent'
      ? '🤖 调用子代理：'
      : tool.name === 'workflow'
        ? '🧵 调用工作流：'
        : '🔧 调用工具：'
    return clipActivity(`${prefix}${tool.label} · ${fmtElapsed(now - tool.since)}`)
  }

  /**
   * Slow keep-alive: recompute both activity lines and patch only when their
   * rendered text actually changed (the elapsed counter ticking). Reschedules
   * itself while the turn is pending; `finalize`/`detach` cancel it.
   */
  private scheduleHeartbeat(sessionId: string, state: TurnState): void {
    if (state.disposed || state.finalized || state.heartbeatTimer !== undefined) return
    state.heartbeatTimer = setTimeout(() => {
      state.heartbeatTimer = undefined
      if (state.disposed || state.finalized) return
      const now = Date.now()
      if (this.delegationLine(state, now) !== state.status
        || this.toolLine(state, now) !== state.tool) {
        this.markDirty(sessionId, state)
      }
      this.scheduleHeartbeat(sessionId, state)
    }, this.heartbeatMs)
  }

  private cardState(sessionId: string, state: TurnState, body: string): CardState {
    // The snapshot point recomputes (and remembers) both activity lines so
    // every patch — including heartbeat-driven ones — carries the current
    // status and tool call.
    const now = Date.now()
    const status = this.delegationLine(state, now)
    if (status !== state.status) {
      state.status = status
      const kind = this.noteKind('status', status, state.statusKind)
      if (kind !== undefined) state.statusKind = kind
    }
    const tool = this.toolLine(state, now)
    if (tool !== state.tool) {
      state.tool = tool
      const kind = this.noteKind('tool', tool, state.toolKind)
      if (kind !== undefined) state.toolKind = kind
    }
    return {
      phase: state.phase,
      reasoning: state.reasoning,
      body,
      status: state.status,
      tool: state.tool,
      stats: this.statsFor(sessionId),
    }
  }

  /**
   * Diagnostic: log activity-type transitions only (first segment of the
   * line, stable across elapsed/count ticks) so a live test can confirm
   * exactly which status the card is being patched with.
   */
  private noteKind(slot: 'status' | 'tool', line: string, current: string): string | undefined {
    const kind = line === '' ? '' : (line.split('·')[0] ?? '').trim()
    if (kind === current) return undefined
    console.info(`[dsh-channels] activity ${slot} →`, kind === '' ? '（收起）' : kind)
    return kind
  }

  /**
   * Freeze the newest card once its body stops fitting its budget (bytes or
   * the per-card table cap) and move the overflow into fresh segment cards
   * (their sends are chained in order).
   */
  private splitOverflow(sessionId: string, state: TurnState): void {
    for (;;) {
      const index = state.cards.length - 1
      const card = state.cards[index]
      if (card === undefined || card.frozen || card.mode === 'text') return

      const options = index === 0 ? {} : { panel: false, segment: index + 1 }
      const split = segmentCardContent(this.cardState(sessionId, state, card.body), options)
      if (split.head === '') {
        // Degenerate budget (cannot happen with the real fixed overhead):
        // keep streaming into this card; buildCard's absolute clip still
        // guards the card size.
        return
      }
      if (split.tail === '') {
        card.body = split.head
        card.dirty = true
        // A card with content but no message id yet (e.g. the continuation of
        // a text-fallback segment) needs its own send, not just a patch.
        if (card.messageId === undefined && !card.sending && !card.failed && card.body !== '') {
          this.sendSegment(sessionId, state, index)
        }
        return
      }

      card.body = split.head
      card.frozen = true
      card.dirty = true
      const next: SegmentCard = this.freshSegment(split.tail)
      state.cards.push(next)
      this.sendSegment(sessionId, state, state.cards.length - 1)
    }
  }

  private freshSegment(body: string): SegmentCard {
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Serialize one continuation-card send per session (order on Feishu), with
   * up to two retries (1s / 2s backoff) for transient failures. When delivery
   * resolves as a text fallback the segment is frozen and further growth
   * continues in a new segment — text messages cannot be patched afterwards.
   */
  private sendSegment(sessionId: string, state: TurnState, index: number): void {
    const card = state.cards[index]
    if (card === undefined || card.failed || card.sending || state.disposed) return
    card.sending = true

    const previous = this.segmentChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const snapshot = buildCard(this.cardState(sessionId, state, card.body), {
            panel: false,
            segment: index + 1,
          })
          const delivery = await this.hooks.sendSegmentCard(sessionId, index + 1, snapshot, card.body)
          card.sending = false
          card.messageId = delivery.messageId
          card.mode = delivery.mode
          this.hooks.onSegmentDelivered?.(
            state.cards[0]?.messageId ?? '',
            index,
            delivery.messageId,
            delivery.mode,
          )
          if (delivery.mode === 'card') {
            card.dirty = true
            this.markDirty(sessionId, state)
          } else if (!card.frozen && !state.disposed) {
            // Text fallback: this card is final; keep streaming into a new one.
            card.frozen = true
            if (state.cards[state.cards.length - 1] === card) {
              state.cards.push(this.freshSegment(''))
            }
            this.markDirty(sessionId, state)
          }
          return
        } catch (error) {
          lastError = error
          if (attempt >= 2 || state.disposed) break
          await this.delay(1_000 * 2 ** attempt)
        }
      }
      card.sending = false
      card.failed = true
      this.hooks.onError(sessionId, lastError)
    })
    this.segmentChains.set(sessionId, next.then(() => {}, () => {}))
  }

  /** Patch one card when due; failed updates retry with exponential backoff
   *  (logged on the first failure and every 10th — no per-flush spam).
   *
   *  The patch gate covers both per-card body growth (`card.dirty`) and
   *  turn-scoped snapshot changes (`turnDirty`: phase, reasoning, activity
   *  line, session stats), so activity-only events still reach the card. */
  private patchCard(sessionId: string, state: TurnState, index: number, force: boolean, turnDirty: boolean): void {
    const card = state.cards[index]
    if (card === undefined || card.messageId === undefined || card.mode === 'text' || card.failed) return
    const now = Date.now()
    if (!force && !card.dirty && !turnDirty) return
    if (!force && card.nextRetryAt > now) return
    card.dirty = false
    const options = index === 0 ? {} : { panel: false, segment: index + 1 }
    const snapshot = buildCard(this.cardState(sessionId, state, card.body), options)
    this.channel.updateCard(card.messageId, snapshot).catch((error: unknown) => {
      card.dirty = true
      card.failures++
      card.nextRetryAt = Date.now() + Math.min(1_000 * 2 ** Math.min(card.failures, 6), 60_000)
      if (card.failures === 1 || card.failures % 10 === 0) {
        this.hooks.onError(sessionId, error)
      }
    })
  }

  private flush(sessionId: string, state: TurnState): void {
    state.lastPatchAt = Date.now()
    const turnDirty = state.dirty
    if (state.dirty) {
      state.dirty = false
      this.splitOverflow(sessionId, state)
    }
    for (const [index] of state.cards.entries()) {
      this.patchCard(sessionId, state, index, false, turnDirty)
    }
  }

  private finalize(sessionId: string, state: TurnState): void {
    if (state.finalized) return
    state.finalized = true
    state.phase = 'done'
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    // The settled card keeps the delegation status (workflow conclusion /
    // subagent summary — `delegationLine` renders its settled form once
    // `finalized` is set); only the transient tool line disappears. The
    // heartbeat stops.
    if (state.heartbeatTimer !== undefined) {
      clearTimeout(state.heartbeatTimer)
      state.heartbeatTimer = undefined
    }
    state.tool = ''
    // Freeze the tail and spawn any remaining segment cards.
    this.splitOverflow(sessionId, state)

    // Final patches with the settled content: every patchable card flips to
    // 回复结束 (backoff is bypassed once so the final state always lands;
    // late-arriving sends are patched when they resolve).
    for (const [index] of state.cards.entries()) {
      this.patchCard(sessionId, state, index, true, false)
    }

    // Reaction swap: Typing → DONE on the triggering message.
    void this.swapReaction(state)

    // Prune the finalized state lazily (kept until the next attach so the
    // front-scan skips it, then removed).
    void Promise.resolve().then(() => {
      const queue = this.bySession.get(sessionId)
      if (queue === undefined) return
      const index = queue.indexOf(state)
      if (index >= 0) queue.splice(index, 1)
    })

    this.hooks.onTurnFinalized(sessionId, state.turn ?? 0, state.cards[0]?.messageId ?? '')
  }

  private async swapReaction(state: TurnState): Promise<void> {
    try {
      if (state.reactionId !== undefined) {
        await this.channel.removeReaction(state.triggerMessageId, state.reactionId)
      }
      await this.channel.addReaction(state.triggerMessageId, 'DONE')
    } catch (error) {
      // Reaction failures are cosmetic: never surface them to the user.
      this.hooks.onError(state.triggerMessageId, error)
    }
  }
}
