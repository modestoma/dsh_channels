/**
 * HITL approval answerer: turns the host's `approval/request` waterfall
 * events into standalone Feishu decision cards.
 *
 * The answerer is registered with `prepend: true` on the plugin context so it
 * runs BEFORE generic answerers: a request for a session this channel routes
 * is claimed here, and the decision card (or a typed topic reply) becomes the
 * only way to answer. Requests for sessions the channel does NOT route
 * delegate through `next()`.
 *
 * The host request carries no tool arguments, so the answerer keeps the
 * current turn's `tool/call` arguments per session (fed from `session/event`)
 * and looks the asked call up by `callId` to show what will run. Standing
 * "stop asking in this topic" grants live only in memory, keyed by session,
 * tool name, and requested sandbox mode; they end with the session (`/renew`),
 * the topic, or the process.
 *
 * Rendering lives in `cards/approval.ts`; the shared pending-card lifecycle
 * (delivery, owner gating, timeout, settle-once, withdrawal) lives in
 * `interactions/pending.ts`.
 *
 * @module dsh-channels/interactions/approvals
 */

import { randomUUID } from 'node:crypto'
import { buildApprovalCard, buildApprovalSettledCard } from '../cards/approval.ts'
import type { ApprovalCardState, ApprovalQuestion } from '../cards/approval.ts'
import type { ApprovalOutcome, ApprovalRequest, SessionEvent } from '../dsh-types.ts'
import type { CardActionEvent, FeishuChannel } from '../feishu-channel.ts'
import { PendingCardTable } from './pending.ts'
import type { InteractionRoute, PendingCardEntry } from './pending.ts'

/** Feishu placement of one session's approval cards. */
export type ApprovalRoute = InteractionRoute

export interface ApprovalHooks {
  /**
   * Resolve the Feishu placement for a session. `undefined` means the session
   * is not owned by this channel — the answerer delegates through `next()`.
   */
  routeFor(sessionId: string): ApprovalRoute | undefined
  /** Log a non-fatal error (delivery/update failures). */
  onError(sessionId: string, error: unknown): void
  /**
   * The tool names a session is currently waiting on for approval (empty when
   * none), called on every open and settle so the streaming card can show it.
   */
  onWaitingChange?(sessionId: string, toolNames: readonly string[]): void
}

/**
 * How one typed topic reply was consumed by {@link ApprovalAnswerer.submitText}:
 * a keyword decision (`allowed`, `remembered`, `denied`), or any other text
 * that rejected every pending request of the session (`superseded`) and must
 * still be delivered as the next instruction.
 */
export type ApprovalTextResult = 'allowed' | 'remembered' | 'denied' | 'superseded'

/** One in-flight approval question: its card content and its resolver. */
interface Pending extends PendingCardEntry {
  question: ApprovalQuestion
  /** Standing-grant key for "stop asking in this topic". */
  grantKey: string
  /** Open order, so a typed reply answers the newest card. */
  openedAt: number
  resolve(outcome: ApprovalOutcome): void
}

/** One recorded `tool/call` of a session's current turn. */
interface RecordedCall {
  turn: number
  name: string
  arguments: string
}

const ALLOW_WORDS = new Set(['允许', '同意', '可以', '好', '好的', '行', '确认', 'y', 'yes', 'ok', 'allow', 'approve'])
const DENY_WORDS = new Set(['拒绝', '不允许', '不行', '不', '否', '不同意', 'n', 'no', 'deny', 'reject'])
const ALWAYS_WORDS = new Set(['全部允许', '都允许', '允许所有', '允许全部', '总是允许', '始终允许', 'allow all', 'always'])

/**
 * Classify one typed reply. Trailing punctuation and case are ignored; the
 * whole message must be the keyword so ordinary sentences never match.
 * @param text - the reply text with mentions already stripped.
 * @returns The keyword decision, or `undefined` for any other text.
 */
export function classifyApprovalReply(text: string): 'allow' | 'always' | 'deny' | undefined {
  const word = text.trim().toLowerCase().replace(/[\s。.!！~～]+$/u, '')
  if (ALWAYS_WORDS.has(word)) return 'always'
  if (ALLOW_WORDS.has(word)) return 'allow'
  if (DENY_WORDS.has(word)) return 'deny'
  return undefined
}

/**
 * Read what a call will run and the sandbox mode it asks for. `bash` shows
 * its `command`; other tools show their raw arguments. Arguments are
 * model-produced JSON, so a parse failure shows the raw text.
 */
function describeCall(call: RecordedCall | undefined): { command?: string; escalateTo?: string } {
  if (call === undefined) return {}
  let args: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch {
    // Unparseable arguments: shown verbatim below.
  }
  if (args === undefined) return call.arguments === '' ? {} : { command: call.arguments }
  const escalateTo = typeof args.sandbox_permissions === 'string' && args.sandbox_permissions !== ''
    ? args.sandbox_permissions
    : undefined
  const command = typeof args.command === 'string' && args.command !== ''
    ? args.command
    : JSON.stringify(args, null, 2)
  return { command, ...(escalateTo === undefined ? {} : { escalateTo }) }
}

export class ApprovalAnswerer {
  private readonly table: PendingCardTable<Pending>
  /** sessionId → callId → the current turn's recorded tool calls. */
  private readonly calls = new Map<string, Map<string, RecordedCall>>()
  /** sessionId → standing "stop asking in this topic" grant keys. */
  private readonly grants = new Map<string, Set<string>>()
  private opened = 0

  constructor(
    channel: FeishuChannel,
    private readonly hooks: ApprovalHooks,
    private readonly timeoutMs: number,
  ) {
    this.table = new PendingCardTable(channel, hooks.onError)
  }

  /** In-flight question count (diagnostics/tests). */
  pendingCount(): number {
    return this.table.count()
  }

  /** Whether a session currently has an undecided approval card. */
  hasPendingFor(sessionId: string): boolean {
    return this.pendingOf(sessionId).length > 0
  }

  /**
   * Track the current turn's tool calls so a later approval can show what it
   * approves. Only `tool/call` and `turn/end` are read; nothing earlier than
   * the current turn is kept.
   */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === 'tool/call') {
      let calls = this.calls.get(sessionId)
      if (calls === undefined) {
        calls = new Map()
        this.calls.set(sessionId, calls)
      }
      calls.set(event.data.callId, { turn: event.data.turn, name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'turn/end') {
      const calls = this.calls.get(sessionId)
      if (calls === undefined) return
      for (const [callId, call] of calls) {
        if (call.turn <= event.data.turn) calls.delete(callId)
      }
      if (calls.size === 0) this.calls.delete(sessionId)
    }
  }

  /**
   * The `approval/request` waterfall listener. Never rejects: the host service
   * already contains answerer failures to the fail-closed `'unavailable'`.
   */
  onRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = req.agent.session.id
    const route = this.hooks.routeFor(sessionId)
    if (route === undefined) return next()
    // The abort window between the service's own signal check and this
    // listener is closed by settling synchronously: an aborted ask never
    // opens a question.
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')

    const call = req.callId === undefined ? undefined : this.calls.get(sessionId)?.get(req.callId)
    const described = describeCall(call)
    const grantKey = `${req.toolName}\u0000${described.escalateTo ?? ''}`
    if (this.grants.get(sessionId)?.has(grantKey) === true) return Promise.resolve('allowed-once')

    const token = randomUUID()
    // `displayReason` (DSH 0.2.0) is presentation-only and locale-aware;
    // `reason` remains the audit-trail fallback.
    const displayReason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
    const question: ApprovalQuestion = {
      token,
      toolName: req.toolName,
      ...(displayReason === undefined ? {} : { reason: displayReason }),
      ...described,
      timeoutMs: this.timeoutMs,
      sessionId,
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: Pending = {
        token,
        sessionId,
        route,
        messageId: undefined,
        settled: false,
        timer: undefined,
        signal: req.signal,
        onAbort: undefined,
        unauthorizedNoted: false,
        question,
        grantKey,
        openedAt: ++this.opened,
        resolve,
      }
      const onAbort = (): void => {
        this.settle(entry, 'cancelled', 'cancelled')
      }
      entry.onAbort = onAbort
      // Registered synchronously at promise creation so no abort can slip
      // between the ownership check and the card delivery; a residual abort
      // in the tiny window before addEventListener is still covered because
      // the host's decide() races the signal against this promise and
      // discards a late resolution (worst case: the card times out).
      req.signal?.addEventListener('abort', onAbort, { once: true })
      this.table.add(entry)
      this.notifyWaiting(sessionId)
      void this.table.deliver(entry, {
        card: buildApprovalCard(question),
        onWithdrawn: e => this.table.patch(e, buildApprovalSettledCard(e.question, 'cancelled')),
        onDelivered: e => this.table.armTimeout(e, this.timeoutMs, () => {
          this.settle(e, 'rejected', 'expired')
        }),
        // No card → no human answerer → fail closed.
        onFailure: e => {
          this.table.close(e, () => {})
          this.notifyWaiting(e.sessionId)
          e.resolve('unavailable')
        },
      })
    })
  }

  /**
   * Route one card button-callback event to its pending question. Unknown
   * cards and non-owner operators are ignored (a non-owner click adds the
   * owner-only notice to the card once); owner decisions settle the question.
   */
  onCardAction(event: CardActionEvent): void {
    const entry = this.table.resolveAction(event, candidate => {
      if (candidate.unauthorizedNoted) return
      candidate.unauthorizedNoted = true
      this.table.patch(candidate, buildApprovalCard(candidate.question, { unauthorizedNote: true }))
    })
    if (entry === undefined) return
    const decision = (event.action.value as { decision?: unknown } | undefined)?.decision
    if (decision === 'allow') this.settle(entry, 'allowed-once', 'allowed')
    else if (decision === 'always') this.remember(entry)
    else if (decision === 'deny') this.settle(entry, 'rejected', 'denied')
  }

  /**
   * Answer a session's pending approvals with one typed topic reply. The
   * caller has already checked that the sender owns the topic. A keyword
   * decides the newest card; any other text rejects every pending card of the
   * session and is reported as `superseded` so the caller still delivers it.
   * @param sessionId - the session the reply was routed to.
   * @param text - the reply text.
   * @returns How the reply was consumed, or `undefined` when nothing is pending.
   */
  submitText(sessionId: string, text: string): ApprovalTextResult | undefined {
    const pending = this.pendingOf(sessionId)
    const newest = pending.at(-1)
    if (newest === undefined) return undefined
    switch (classifyApprovalReply(text)) {
      case 'allow':
        this.settle(newest, 'allowed-once', 'allowed-text')
        return 'allowed'
      case 'always':
        this.remember(newest)
        return 'remembered'
      case 'deny':
        this.settle(newest, 'rejected', 'denied-text')
        return 'denied'
      case undefined:
        for (const entry of pending) this.settle(entry, 'rejected', 'superseded')
        return 'superseded'
    }
  }

  /** Withdraw every in-flight question (plugin shutdown). */
  dispose(): void {
    this.table.withdrawAll(entry => this.settle(entry, 'cancelled'))
    this.calls.clear()
    this.grants.clear()
  }

  /** Undecided entries of one session, oldest first. */
  private pendingOf(sessionId: string): Pending[] {
    return [...this.table.values()]
      .filter(entry => entry.sessionId === sessionId && !entry.settled)
      .sort((left, right) => left.openedAt - right.openedAt)
  }

  /**
   * Record a standing grant for the entry's tool + mode, allow it, and allow
   * every other pending card of the session the grant now covers.
   */
  private remember(entry: Pending): void {
    let grants = this.grants.get(entry.sessionId)
    if (grants === undefined) {
      grants = new Set()
      this.grants.set(entry.sessionId, grants)
    }
    grants.add(entry.grantKey)
    for (const candidate of this.pendingOf(entry.sessionId)) {
      if (candidate.grantKey === entry.grantKey) this.settle(candidate, 'allowed-once', 'remembered')
    }
  }

  /** Report the session's remaining waits to the streaming card. */
  private notifyWaiting(sessionId: string): void {
    this.hooks.onWaitingChange?.(sessionId, this.pendingOf(sessionId).map(entry => entry.question.toolName))
  }

  /** Settle once, then patch the card to its terminal state. */
  private settle(entry: Pending, outcome: ApprovalOutcome, cardState?: ApprovalCardState): void {
    const closed = this.table.close(entry, () => {
      if (cardState !== undefined) {
        this.table.patch(entry, buildApprovalSettledCard(entry.question, cardState))
      }
    })
    if (!closed) return
    this.notifyWaiting(entry.sessionId)
    entry.resolve(outcome)
  }
}
