/**
 * Topic-owner consent for wiki tool calls.
 *
 * A wiki tool that opens, creates, or edits a document asks the topic owner
 * on a consent card in the topic and waits for the answer. Only the topic
 * owner (`route.senderUserId`) can decide; a click by anyone else adds the
 * owner-only notice once. An unanswered card is denied after the configured
 * window (`approvalTimeoutMs`). A read consent is remembered per Session and
 * document, in memory only: it ends with the Session (`/renew`) or the
 * process. Create and edit consents are never remembered.
 *
 * @module dsh-channels/feishu/wiki/consent
 */

import { randomUUID } from 'node:crypto'
import { buildWikiConsentCard, buildWikiConsentSettledCard } from '../../cards/wiki.ts'
import type { WikiConsentAction, WikiConsentCardState, WikiConsentQuestion } from '../../cards/wiki.ts'
import type { CardActionEvent, FeishuChannel } from '../../feishu-channel.ts'
import { PendingCardTable } from '../../interactions/pending.ts'
import type { InteractionRoute, PendingCardEntry } from '../../interactions/pending.ts'

/** How one consent request ended. */
export type WikiConsentOutcome = 'allowed' | 'denied' | 'expired' | 'cancelled' | 'unavailable'

/** One consent to ask for. */
export interface WikiConsentRequest {
  readonly sessionId: string
  readonly route: InteractionRoute
  readonly action: WikiConsentAction
  readonly title: string
  readonly url?: string
  readonly location: string
  readonly details: readonly string[]
  /** The tool call's abort signal; aborting withdraws the card. */
  readonly signal: AbortSignal
}

interface Pending extends PendingCardEntry {
  readonly question: WikiConsentQuestion
  resolve(outcome: WikiConsentOutcome): void
}

export interface WikiConsentDeps {
  /** Live Feishu channel; undefined while disconnected. */
  channel(): FeishuChannel | undefined
  /** Decision window per card, read per request (`approvalTimeoutMs`). */
  timeoutMs(): number
  /** Log a non-fatal delivery/update failure. */
  onError(sessionId: string, error: unknown): void
}

/** Consent cards for the wiki tools. */
export class WikiConsent {
  /** One table per channel instance (cards are patched through their channel). */
  private table: { channel: FeishuChannel; entries: PendingCardTable<Pending> } | undefined
  /** sessionId → document ids with a standing read consent. */
  private readonly readGrants = new Map<string, Set<string>>()

  constructor(private readonly deps: WikiConsentDeps) {}

  /**
   * Whether the Session already holds a read consent for one document.
   * @param sessionId The Session.
   * @param documentId Docx document id.
   * @returns True when reading needs no new card.
   */
  hasReadGrant(sessionId: string, documentId: string): boolean {
    return this.readGrants.get(sessionId)?.has(documentId) === true
  }

  /**
   * Record a standing read consent (after an allowed read, or for a document
   * the topic owner just approved creating).
   * @param sessionId The Session.
   * @param documentId Docx document id.
   */
  grantRead(sessionId: string, documentId: string): void {
    let grants = this.readGrants.get(sessionId)
    if (grants === undefined) {
      grants = new Set()
      this.readGrants.set(sessionId, grants)
    }
    grants.add(documentId)
  }

  /**
   * Ask the topic owner and wait for the decision. Never rejects.
   * @param request What to ask.
   * @returns The outcome; `unavailable` when no card could be delivered.
   */
  request(request: WikiConsentRequest): Promise<WikiConsentOutcome> {
    if (request.signal.aborted) return Promise.resolve('cancelled')
    const channel = this.deps.channel()
    if (channel === undefined) return Promise.resolve('unavailable')
    const table = this.tableFor(channel)
    const timeoutMs = this.deps.timeoutMs()
    const question: WikiConsentQuestion = {
      token: randomUUID(),
      action: request.action,
      title: request.title,
      ...(request.url === undefined ? {} : { url: request.url }),
      location: request.location,
      details: request.details,
      timeoutMs,
    }
    return new Promise<WikiConsentOutcome>((resolve) => {
      const entry: Pending = {
        token: question.token,
        sessionId: request.sessionId,
        route: request.route,
        messageId: undefined,
        settled: false,
        timer: undefined,
        signal: request.signal,
        onAbort: undefined,
        unauthorizedNoted: false,
        question,
        resolve,
      }
      const onAbort = (): void => this.settle(table, entry, 'cancelled', 'cancelled')
      entry.onAbort = onAbort
      request.signal.addEventListener('abort', onAbort, { once: true })
      table.add(entry)
      void table.deliver(entry, {
        card: buildWikiConsentCard(question),
        onWithdrawn: e => table.patch(e, buildWikiConsentSettledCard(e.question, 'cancelled')),
        onDelivered: e => table.armTimeout(e, timeoutMs, () => this.settle(table, e, 'expired', 'expired')),
        onFailure: e => this.settle(table, e, 'unavailable'),
      })
    })
  }

  /**
   * Route one card button callback to its pending consent; unknown cards are
   * ignored.
   * @param event The card action.
   */
  onCardAction(event: CardActionEvent): void {
    const table = this.table?.entries
    if (table === undefined) return
    const entry = table.resolveAction(event, (candidate) => {
      if (candidate.unauthorizedNoted) return
      candidate.unauthorizedNoted = true
      table.patch(candidate, buildWikiConsentCard(candidate.question, { unauthorizedNote: true }))
    })
    if (entry === undefined) return
    const decision = (event.action.value as { decision?: unknown } | undefined)?.decision
    if (decision === 'allow') this.settle(table, entry, 'allowed', 'allowed')
    else if (decision === 'deny') this.settle(table, entry, 'denied', 'denied')
  }

  /** Withdraw every pending card and forget every read consent (shutdown). */
  dispose(): void {
    const table = this.table?.entries
    table?.withdrawAll(entry => this.settle(table, entry, 'cancelled', 'cancelled'))
    this.table = undefined
    this.readGrants.clear()
  }

  /** Pending consent count (diagnostics/tests). */
  pendingCount(): number {
    return this.table?.entries.count() ?? 0
  }

  private tableFor(channel: FeishuChannel): PendingCardTable<Pending> {
    if (this.table?.channel !== channel) {
      this.table = { channel, entries: new PendingCardTable<Pending>(channel, this.deps.onError) }
    }
    return this.table.entries
  }

  private settle(
    table: PendingCardTable<Pending>,
    entry: Pending,
    outcome: WikiConsentOutcome,
    cardState?: WikiConsentCardState,
  ): void {
    const closed = table.close(entry, () => {
      if (cardState !== undefined) table.patch(entry, buildWikiConsentSettledCard(entry.question, cardState))
    })
    if (closed) entry.resolve(outcome)
  }
}
