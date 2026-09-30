/**
 * Shared lifecycle of a pending interaction card.
 *
 * Both HITL surfaces (approvals and `ask_user_question`) need the same
 * mechanics: a token-keyed registry, owner-gated card-action lookup, delivery
 * with a withdrawn-race guard, a local timeout, settle-once cleanup, and
 * shutdown withdrawal. Only the rendered card and the resolution semantics
 * differ, so those stay in the surface modules and everything else lives here.
 *
 * @module dsh-channels/interactions/pending
 */

import type { CardActionEvent, FeishuChannel } from '../feishu-channel.ts'

/** Where one session's interaction cards are placed on Feishu. */
export interface InteractionRoute {
  /** Feishu chat the cards live in. */
  chatId: string
  /** Reply anchor: the session's latest streaming card message id. */
  cardMessageId: string
  /** Whether the anchor lives in a real topic (replyInThread). */
  inThread: boolean
  /** The session owner (open_id) — the only operator allowed to decide. */
  senderOpenId: string
}

/** Fields every pending interaction card carries. */
export interface PendingCardEntry {
  /** Opaque token binding the card to one pending interaction. */
  readonly token: string
  /** DSH session the interaction belongs to (routing + error logs). */
  readonly sessionId: string
  /** Feishu placement of this card. */
  readonly route: InteractionRoute
  /** Card message id once it lands; undefined while sending. */
  messageId: string | undefined
  /** Settle-once guard: a late click/signal/timeout is discarded. */
  settled: boolean
  /** Local timeout handle (absent for host-owned deadlines). */
  timer: ReturnType<typeof setTimeout> | undefined
  /** The ask's own abort signal, when it has one. */
  readonly signal: AbortSignal | undefined
  /** Listener registered for that signal, removed on close. */
  onAbort: (() => void) | undefined
  /** The owner-only notice was already patched onto the card. */
  unauthorizedNoted: boolean
}

export interface DeliverHandlers<E extends PendingCardEntry> {
  /** The pending card to send as a topic/thread reply. */
  card: object
  /** The card landed and its message id is recorded (arm timeouts here). */
  onDelivered?(entry: E): void
  /** The request withdrew while the card was in flight. */
  onWithdrawn(entry: E): void
  /** Delivery failed: fail the request closed. */
  onFailure(entry: E, error: unknown): void
}

/**
 * The pending-card table: registry, delivery, owner gating, and cleanup.
 * Concrete surfaces supply rendering and the terminal action.
 */
export class PendingCardTable<E extends PendingCardEntry> {
  private readonly entries = new Map<string, E>()

  constructor(
    private readonly channel: FeishuChannel,
    private readonly onError: (sessionId: string, error: unknown) => void,
  ) {}

  add(entry: E): void {
    this.entries.set(entry.token, entry)
  }

  count(): number {
    return this.entries.size
  }

  /** Every pending entry (diagnostics and inbound text routing). */
  values(): IterableIterator<E> {
    return this.entries.values()
  }

  /**
   * Owner-gated lookup for one card action, containing the owner-only notice.
   * Returns `undefined` for unknown cards, settled entries, and non-owner
   * clicks (which call `onUnauthorized` once).
   */
  resolveAction(event: CardActionEvent, onUnauthorized: (entry: E) => void): E | undefined {
    let entry: E | undefined
    for (const candidate of this.entries.values()) {
      if (candidate.messageId === event.messageId) {
        entry = candidate
        break
      }
    }
    if (entry === undefined || entry.settled) return undefined
    if (event.operator.openId !== entry.route.senderOpenId) {
      onUnauthorized(entry)
      return undefined
    }
    return entry
  }

  /** Send the pending card and contain every outcome. */
  async deliver(entry: E, handlers: DeliverHandlers<E>): Promise<void> {
    try {
      const res = await this.channel.send(
        entry.route.chatId,
        { card: handlers.card },
        { replyTo: entry.route.cardMessageId, replyInThread: entry.route.inThread },
      )
      // Record the id before the withdrawn check: a request that settled
      // while the card was in flight still needs its card patched terminal.
      entry.messageId = res.messageId
      if (entry.settled) {
        handlers.onWithdrawn(entry)
        return
      }
      handlers.onDelivered?.(entry)
    } catch (error) {
      this.onError(entry.sessionId, error)
      handlers.onFailure(entry, error)
    }
  }

  /** Full-replacement patch of one delivered card; failures stay contained. */
  patch(entry: E, card: object): void {
    if (entry.messageId === undefined) return
    void this.channel.updateCard(entry.messageId, card)
      .catch((error: unknown) => { this.onError(entry.sessionId, error) })
  }

  /** Arm the local deadline for a request the host does not time itself. */
  armTimeout(entry: E, ms: number, onTimeout: () => void): void {
    entry.timer = setTimeout(onTimeout, ms)
    entry.timer.unref?.()
  }

  /**
   * Close one entry exactly once: clear the timer and abort listener, drop it
   * from the registry, then run the terminal action (usually a card patch).
   * @returns false when it was already settled.
   */
  close(entry: E, terminal: () => void): boolean {
    if (entry.settled) return false
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    this.entries.delete(entry.token)
    terminal()
    return true
  }

  /** Withdraw every pending entry (plugin shutdown). */
  withdrawAll(withdraw: (entry: E) => void): void {
    for (const entry of [...this.entries.values()]) withdraw(entry)
  }
}
