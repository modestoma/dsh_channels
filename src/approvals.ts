/**
 * HITL approval answerer: turns the host's `approval/request` waterfall
 * events into standalone Feishu decision cards.
 *
 * The answerer is registered with `prepend: true` on the plugin context so it
 * runs BEFORE generic answerers (the web gateway's apiproxy): a request for a
 * session this channel routes is claimed here, and the decision card becomes
 * the only way to answer. Requests for sessions the channel does NOT route
 * delegate through `next()` untouched.
 *
 * Per pending question:
 *  1. a standalone card (⚠️ 需要你的审批 + 允许/拒绝 buttons) is sent as a
 *     reply anchored to the session's latest streaming card, in the same
 *     topic when the route is thread-scoped — never embedded into the
 *     streamed card, whose full-replacement patches would clobber the
 *     buttons;
 *  2. the request's promise settles exactly once, from one of:
 *     - a click on 允许/拒绝 by the session owner → `allowed-once`/`rejected`;
 *     - the ask's own abort signal (turn cancel) → `cancelled`;
 *     - the timeout expiring → fail-closed `rejected` (card shows 已超时);
 *     - card delivery failure → fail-closed `unavailable`;
 *     - plugin shutdown (`dispose`) → `cancelled`.
 *  3. the card is patched to its terminal state with the buttons removed.
 *
 * Non-owner clicks never settle a question; the first such click adds a
 * "owner only" notice to the card. Everything is in-memory: a restart settles
 * nothing durable — the host's own audit pair (`approval/asked`/`decided`)
 * records the outcome, and the abandoned ask dies with the turn, exactly
 * like the web gateway's pending registry.
 *
 * @module dsh-channels/approvals
 */

import { randomUUID } from 'node:crypto'
import { buildApprovalCard, buildApprovalSettledCard } from './cards.ts'
import type { ApprovalCardState, ApprovalQuestion } from './cards.ts'
import type { CardActionEvent, FeishuChannel } from './feishu-channel.ts'
import type { ApprovalOutcome, ApprovalRequest } from './dsh-types.ts'

/** Feishu placement of one session's approval cards. */
export interface ApprovalRoute {
  /** Feishu chat the cards live in. */
  chatId: string
  /** Reply anchor: the session's latest streaming card message id. */
  cardMessageId: string
  /** Whether the anchor lives in a real topic (replyInThread). */
  inThread: boolean
  /** The session owner (open_id) — the only operator allowed to decide. */
  senderOpenId: string
}

export interface ApprovalHooks {
  /**
   * Resolve the Feishu placement for a session. `undefined` means the session
   * is not owned by this channel — the answerer delegates through `next()`.
   */
  routeFor(sessionId: string): ApprovalRoute | undefined
  /** Log a non-fatal error (delivery/update failures). */
  onError(sessionId: string, error: unknown): void
}

/** One in-flight question: identity, card placement, and its settle guard. */
interface Pending {
  token: string
  question: ApprovalQuestion
  route: ApprovalRoute
  sessionId: string
  /** Feishu message id once the card lands; undefined while sending. */
  messageId: string | undefined
  /** Settle-once guard: a late click/signal/timeout is discarded. */
  settled: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  abortSignal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  /** The owner-only notice was already patched onto the card. */
  unauthorizedNoted: boolean
  resolve: (outcome: ApprovalOutcome) => void
}

export class ApprovalAnswerer {
  private readonly channel: FeishuChannel
  private readonly hooks: ApprovalHooks
  private readonly timeoutMs: number
  /** token → in-flight question. */
  private readonly pending = new Map<string, Pending>()

  constructor(channel: FeishuChannel, hooks: ApprovalHooks, timeoutMs: number) {
    this.channel = channel
    this.hooks = hooks
    this.timeoutMs = timeoutMs
  }

  /** In-flight question count (diagnostics/tests). */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * The `approval/request` waterfall listener. Non-owned sessions delegate
   * through `next()`; owned sessions get a decision card and a promise that
   * settles from a click, the ask's abort signal, the timeout, or a delivery
   * failure. Never rejects — the host service already contains answerer
   * failures to the fail-closed `'unavailable'`.
   */
  onRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const route = this.hooks.routeFor(req.agent.session.id)
    if (route === undefined) return next()
    // The abort window between the service's own signal check and this
    // listener is closed by settling synchronously: an aborted ask never
    // opens a question.
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')

    const token = randomUUID()
    const question: ApprovalQuestion = {
      token,
      toolName: req.toolName,
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      timeoutMs: this.timeoutMs,
      sessionId: req.agent.session.id,
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: Pending = {
        token,
        question,
        route,
        sessionId: req.agent.session.id,
        messageId: undefined,
        settled: false,
        timer: undefined,
        abortSignal: req.signal,
        onAbort: undefined,
        unauthorizedNoted: false,
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
      this.pending.set(token, entry)
      void this.deliver(entry)
    })
  }

  /** Send the decision card, then arm the timeout once it lands. */
  private async deliver(entry: Pending): Promise<void> {
    try {
      const res = await this.channel.send(
        entry.route.chatId,
        { card: buildApprovalCard(entry.question) },
        { replyTo: entry.route.cardMessageId, replyInThread: entry.route.inThread },
      )
      if (entry.settled) {
        // The abort won the race while the card was in flight: the question
        // is withdrawn, so the card that just landed must not stay answerable.
        void this.channel.updateCard(res.messageId, buildApprovalSettledCard(entry.question, 'cancelled'))
          .catch((error: unknown) => { this.hooks.onError(entry.sessionId, error) })
        return
      }
      entry.messageId = res.messageId
      entry.timer = setTimeout(() => {
        this.settle(entry, 'rejected', 'expired')
      }, this.timeoutMs)
      entry.timer.unref?.()
    } catch (error) {
      // No card → no human answerer → fail closed.
      this.hooks.onError(entry.sessionId, error)
      this.settle(entry, 'unavailable')
    }
  }

  /**
   * Route one card button-callback event to its pending question. Unknown
   * cards and non-owner operators are ignored (a non-owner click adds the
   * owner-only notice to the card once); owner decisions settle the question.
   */
  onCardAction(event: CardActionEvent): void {
    let entry: Pending | undefined
    for (const candidate of this.pending.values()) {
      if (candidate.messageId === event.messageId) {
        entry = candidate
        break
      }
    }
    if (entry === undefined || entry.settled) return
    if (event.operator.openId !== entry.route.senderOpenId) {
      if (!entry.unauthorizedNoted && entry.messageId !== undefined) {
        entry.unauthorizedNoted = true
        void this.channel.updateCard(
          entry.messageId,
          buildApprovalCard(entry.question, { unauthorizedNote: true }),
        ).catch((error: unknown) => { this.hooks.onError(entry.sessionId, error) })
      }
      return
    }
    const decision = (event.action.value as { decision?: unknown } | undefined)?.decision
    if (decision === 'allow') this.settle(entry, 'allowed-once', 'allowed')
    else if (decision === 'deny') this.settle(entry, 'rejected', 'denied')
  }

  /** Withdraw every in-flight question (plugin shutdown). */
  dispose(): void {
    for (const entry of [...this.pending.values()]) {
      this.settle(entry, 'cancelled')
    }
  }

  /** Settle once, clean up listeners/timers, and patch the card terminal. */
  private settle(entry: Pending, outcome: ApprovalOutcome, cardState?: ApprovalCardState): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.abortSignal !== undefined && entry.onAbort !== undefined) {
      entry.abortSignal.removeEventListener('abort', entry.onAbort)
    }
    this.pending.delete(entry.token)
    entry.resolve(outcome)
    if (entry.messageId !== undefined && cardState !== undefined) {
      void this.channel.updateCard(entry.messageId, buildApprovalSettledCard(entry.question, cardState))
        .catch((error: unknown) => { this.hooks.onError(entry.sessionId, error) })
    }
  }
}
