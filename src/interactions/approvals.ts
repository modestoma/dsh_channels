/**
 * HITL approval answerer: turns the host's `approval/request` waterfall
 * events into standalone Feishu decision cards.
 *
 * The answerer is registered with `prepend: true` on the plugin context so it
 * runs BEFORE generic answerers: a request for a session this channel routes
 * is claimed here, and the decision card becomes the only way to answer.
 * Requests for sessions the channel does NOT route delegate through `next()`.
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
import type { ApprovalOutcome, ApprovalRequest } from '../dsh-types.ts'
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
}

/** One in-flight approval question: its card content and its resolver. */
interface Pending extends PendingCardEntry {
  question: ApprovalQuestion
  resolve(outcome: ApprovalOutcome): void
}

export class ApprovalAnswerer {
  private readonly table: PendingCardTable<Pending>

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

  /**
   * The `approval/request` waterfall listener. Never rejects: the host service
   * already contains answerer failures to the fail-closed `'unavailable'`.
   */
  onRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const route = this.hooks.routeFor(req.agent.session.id)
    if (route === undefined) return next()
    // The abort window between the service's own signal check and this
    // listener is closed by settling synchronously: an aborted ask never
    // opens a question.
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')

    const token = randomUUID()
    // `displayReason` (DSH 0.2.0) is presentation-only and locale-aware;
    // `reason` remains the audit-trail fallback.
    const displayReason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
    const question: ApprovalQuestion = {
      token,
      toolName: req.toolName,
      ...(displayReason === undefined ? {} : { reason: displayReason }),
      timeoutMs: this.timeoutMs,
      sessionId: req.agent.session.id,
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: Pending = {
        token,
        sessionId: req.agent.session.id,
        route,
        messageId: undefined,
        settled: false,
        timer: undefined,
        signal: req.signal,
        onAbort: undefined,
        unauthorizedNoted: false,
        question,
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
      void this.table.deliver(entry, {
        card: buildApprovalCard(question),
        onWithdrawn: e => this.table.patch(e, buildApprovalSettledCard(e.question, 'cancelled')),
        onDelivered: e => this.table.armTimeout(e, this.timeoutMs, () => {
          this.settle(e, 'rejected', 'expired')
        }),
        // No card → no human answerer → fail closed.
        onFailure: e => {
          this.table.close(e, () => {})
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
    else if (decision === 'deny') this.settle(entry, 'rejected', 'denied')
  }

  /** Withdraw every in-flight question (plugin shutdown). */
  dispose(): void {
    this.table.withdrawAll(entry => this.settle(entry, 'cancelled'))
  }

  /** Settle once, then patch the card to its terminal state. */
  private settle(entry: Pending, outcome: ApprovalOutcome, cardState?: ApprovalCardState): void {
    const closed = this.table.close(entry, () => {
      if (cardState !== undefined) {
        this.table.patch(entry, buildApprovalSettledCard(entry.question, cardState))
      }
    })
    if (closed) entry.resolve(outcome)
  }
}
