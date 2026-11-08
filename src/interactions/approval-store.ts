/**
 * Durable approval state in the channel's storage domain.
 *
 * - `approval_grants` (key = DSH session id): the session's "stop asking in
 *   this topic" grants. They survive a restart and end with the Session:
 *   `/renew` binds a new Session id, and the GC sweep drops the grants of a
 *   Session no route names.
 * - `approval_cards` (key = card message id): every delivered approval card
 *   until it is decided. An `open` record left by an earlier process is a
 *   card a restart interrupted; an `expired` or `interrupted` record backs the
 *   card's 「重新发起」 button until it is clicked or {@link RETRY_WINDOW_MS}
 *   passes.
 *
 * Writes are contained: a failed write is logged and the in-memory decision
 * stands, so storage trouble never blocks or flips an approval.
 *
 * @module dsh-channels/interactions/approval-store
 */

import { z } from 'zod'

/** How long an expired or interrupted card's 「重新发起」 button stays usable. */
export const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export const approvalGrantRecordSchema = z.object({
  /** DSH session id (also the table key). */
  key: z.string().min(1),
  /** Grant keys (`<tool name>\u0000<requested sandbox mode or empty>`). */
  grants: z.array(z.string().min(1)),
  /** Epoch ms of the latest grant. */
  updatedAt: z.number().int().nonnegative(),
})

export type ApprovalGrantRecord = z.infer<typeof approvalGrantRecordSchema>

/** The question fields a settled card re-renders (the card's own button token is not kept). */
export const storedApprovalQuestionSchema = z.object({
  toolName: z.string().min(1),
  reason: z.string().optional(),
  command: z.string().optional(),
  arguments: z.string().optional(),
  escalateTo: z.string().optional(),
  adminOnly: z.boolean().optional(),
  timeoutMs: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
})

export type StoredApprovalQuestion = z.infer<typeof storedApprovalQuestionSchema>

/** Lifecycle of a stored approval card: undecided, or settled with a 「重新发起」 button. */
export type ApprovalCardRecordState = 'open' | 'expired' | 'interrupted'

export const approvalCardRecordSchema = z.object({
  /** Card message id (also the table key). */
  key: z.string().min(1),
  /** DSH session that asked. */
  sessionId: z.string().min(1),
  /** What the card asked. */
  question: storedApprovalQuestionSchema,
  state: z.enum(['open', 'expired', 'interrupted']),
  /** The process that opened the card; an `open` record of another process was interrupted. */
  instanceId: z.string().min(1),
  /** Epoch ms the card was delivered. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms the card expired or was interrupted. */
  settledAt: z.number().int().nonnegative().optional(),
})

export type ApprovalCardRecord = z.infer<typeof approvalCardRecordSchema>

/** Normalized table handle for the session grants (key = DSH session id). */
export interface ApprovalGrantsTable {
  get(key: string): ApprovalGrantRecord | undefined
  put(key: string, value: ApprovalGrantRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, ApprovalGrantRecord]>
}

/** Normalized table handle for the approval cards (key = card message id). */
export interface ApprovalCardsTable {
  get(key: string): ApprovalCardRecord | undefined
  put(key: string, value: ApprovalCardRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, ApprovalCardRecord]>
}

export interface ApprovalStoreDeps {
  /** The open domain's two approval tables; undefined while the channel is stopped. */
  tables(): { grants: ApprovalGrantsTable; cards: ApprovalCardsTable } | undefined
  /** Log a contained write failure. */
  warn(message: string, ...args: unknown[]): void
}

/** Durable session grants and approval cards (see the module comment). */
export class ApprovalStore {
  constructor(private readonly deps: ApprovalStoreDeps) {}

  /**
   * Whether a session holds a standing grant.
   * @param sessionId - the asking Session.
   * @param grantKey - the grant key of the request.
   * @returns true when the grant was recorded for that Session.
   */
  hasGrant(sessionId: string, grantKey: string): boolean {
    return this.deps.tables()?.grants.get(sessionId)?.grants.includes(grantKey) === true
  }

  /**
   * Record a standing grant for a session.
   * @param sessionId - the Session the grant belongs to.
   * @param grantKey - the grant key.
   */
  addGrant(sessionId: string, grantKey: string): void {
    const grants = this.deps.tables()?.grants
    if (grants === undefined) return
    const current = grants.get(sessionId)?.grants ?? []
    if (current.includes(grantKey)) return
    this.write(`grant for session ${sessionId}`, () =>
      grants.put(sessionId, { key: sessionId, grants: [...current, grantKey], updatedAt: Date.now() }))
  }

  /**
   * Record a delivered, undecided card.
   * @param record - the card record (`state: 'open'`).
   */
  openCard(record: ApprovalCardRecord): void {
    const cards = this.deps.tables()?.cards
    if (cards === undefined) return
    this.write(`approval card ${record.key}`, () => cards.put(record.key, record))
  }

  /**
   * Settle a stored card: keep it with a 「重新发起」 button (`expired`,
   * `interrupted`) or forget it (no state).
   * @param messageId - the card message id.
   * @param state - the retryable terminal state, or undefined to delete the record.
   */
  settleCard(messageId: string, state?: Exclude<ApprovalCardRecordState, 'open'>): void {
    const cards = this.deps.tables()?.cards
    const current = cards?.get(messageId)
    if (cards === undefined || current === undefined) return
    if (state === undefined) {
      this.write(`approval card ${messageId}`, () => cards.delete(messageId))
      return
    }
    this.write(`approval card ${messageId}`, () => cards.put(messageId, { ...current, state, settledAt: Date.now() }))
  }

  /**
   * The record behind a card's 「重新发起」 button.
   * @param messageId - the clicked card.
   * @returns the expired or interrupted record, or undefined when the card is not retryable.
   */
  retryable(messageId: string): ApprovalCardRecord | undefined {
    const record = this.deps.tables()?.cards.get(messageId)
    return record === undefined || record.state === 'open' ? undefined : record
  }

  /**
   * Open cards an earlier process left undecided.
   * @param instanceId - the current process's instance id.
   * @returns those records.
   */
  interruptedCards(instanceId: string): ApprovalCardRecord[] {
    const cards = this.deps.tables()?.cards
    if (cards === undefined) return []
    return [...cards.entries()]
      .map(([, record]) => record)
      .filter(record => record.state === 'open' && record.instanceId !== instanceId)
  }

  /**
   * Drop the grants of Sessions no route names and retry records past
   * {@link RETRY_WINDOW_MS}.
   * @param routed - whether a route still names a Session.
   * @param now - epoch ms of the sweep.
   * @returns how many records were removed.
   */
  prune(routed: (sessionId: string) => boolean, now: number): number {
    const tables = this.deps.tables()
    if (tables === undefined) return 0
    let removed = 0
    for (const [key] of [...tables.grants.entries()]) {
      if (routed(key)) continue
      this.write(`grants of session ${key}`, () => tables.grants.delete(key))
      removed++
    }
    for (const [key, record] of [...tables.cards.entries()]) {
      if (record.state === 'open' || now - (record.settledAt ?? record.createdAt) < RETRY_WINDOW_MS) continue
      this.write(`approval card ${key}`, () => tables.cards.delete(key))
      removed++
    }
    return removed
  }

  /** Run one write, logging (never throwing) a failure. */
  private write(label: string, run: () => Promise<unknown> | void): void {
    void (async () => {
      await run()
    })().catch((error: unknown) => {
      this.deps.warn('dsh-channels: storing %s failed: %s', label, String(error))
    })
  }
}
