/**
 * Durable `action_proposals` store: 14-day retention, atomic `table.update`
 * state transitions (`pending | triggered | dismissed | superseded`), and
 * same-session auto-supersede that preserves already-triggered actions.
 *
 * @module dsh-channels/actions/store
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DomainTable } from '../storage/table.ts'
import { actionAccessLevelSchema, actionButtonStyleSchema } from './contract.ts'

/** Default retention and click validity window for action proposals (14 days). */
export const ACTION_PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1_000

/** Settlement status of each action item inside a proposal card. */
export const actionProposalStatusSchema = z.enum([
  'pending',
  'triggered',
  'dismissed',
  'superseded',
])

export type ActionProposalStatus = z.infer<typeof actionProposalStatusSchema>

/** Durable representation of one action item inside an `action_proposals` row. */
export const actionProposalStoredItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  style: actionButtonStyleSchema.default('default'),
  requiredAccess: actionAccessLevelSchema.default('chat'),
  followUpPrompt: z.string().min(1),
  independent: z.boolean().default(false),
  status: actionProposalStatusSchema,
  triggeredBy: z.string().min(1).optional(),
  triggeredAt: z.number().int().nonnegative().optional(),
})

export type ActionProposalStoredItem = z.infer<typeof actionProposalStoredItemSchema>

/** Durable record stored in `feishuDomain.tables.action_proposals` (keyed by `proposalId`). */
export const actionProposalRecordSchema = z.object({
  proposalId: z.string().min(1),
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  sessionId: z.string().min(1),
  routeKey: z.string().min(1),
  chatId: z.string().min(1),
  cardMessageId: z.string().min(1),
  prompt: z.string().min(1),
  actions: z.array(actionProposalStoredItemSchema).min(1).max(4),
  supersededReason: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
})

export type ActionProposalRecord = z.infer<typeof actionProposalRecordSchema>

/** Derive a compact, deterministic 128-bit hex `proposalId` from an idempotency `key`. */
export function proposalIdOfKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

/** True when at least one action item on the record is still `'pending'`. */
export function hasPendingActions(record: Pick<ActionProposalRecord, 'actions'>): boolean {
  return record.actions.some(item => item.status === 'pending')
}

/** True when the proposal's 14-day validity window has elapsed at `now`. */
export function isActionProposalExpired(record: Pick<ActionProposalRecord, 'createdAt'>, now: number): boolean {
  return now - record.createdAt > ACTION_PROPOSAL_TTL_MS
}

export interface ActionProposalStoreDeps {
  table(): DomainTable<ActionProposalRecord> | undefined
  warn(message: string, ...args: unknown[]): void
}

export type TriggerActionResult =
  | {
    readonly changed: true
    readonly record: ActionProposalRecord
    readonly action: ActionProposalStoredItem
    readonly changedIds: readonly string[]
  }
  | {
    readonly changed: false
  }

/**
 * Typed facade over the `action_proposals` domain table.
 */
export class ActionProposalStore {
  constructor(private readonly deps: ActionProposalStoreDeps) {}

  /** Look up a proposal by its `proposalId` (used by card callbacks). */
  get(proposalId: string): ActionProposalRecord | undefined {
    return this.deps.table()?.get(proposalId)
  }

  /** Look up a proposal by its external idempotency `key`. */
  getByKey(key: string): ActionProposalRecord | undefined {
    const record = this.deps.table()?.get(proposalIdOfKey(key))
    return record?.key === key ? record : undefined
  }

  /** Persist a newly posted proposal record. */
  async put(record: ActionProposalRecord): Promise<void> {
    const table = this.deps.table()
    if (table === undefined) throw new Error('action_proposals table is not open')
    await table.put(record.proposalId, record)
  }

  /**
   * Atomically mark remaining `'pending'` actions of `key` as `'superseded'`,
   * preserving any already `'triggered'` or `'dismissed'` items.
   *
   * @returns The updated record when at least one `'pending'` item changed, or `undefined`.
   */
  async supersedeByKey(key: string, reason?: string): Promise<ActionProposalRecord | undefined> {
    const table = this.deps.table()
    if (table === undefined) return undefined
    const proposalId = proposalIdOfKey(key)
    const existing = table.get(proposalId)
    if (existing === undefined || existing.key !== key || !hasPendingActions(existing)) {
      return undefined
    }
    const cleanReason = reason?.trim()
    let updated: ActionProposalRecord | undefined
    try {
      await table.update(proposalId, (current) => {
        if (current.key !== key || !hasPendingActions(current)) return current
        const next: ActionProposalRecord = {
          ...current,
          ...(cleanReason !== undefined && cleanReason !== '' ? { supersededReason: cleanReason } : {}),
          actions: current.actions.map(item =>
            item.status === 'pending' ? { ...item, status: 'superseded' as const } : item),
        }
        updated = next
        return next
      })
      return updated
    } catch (error) {
      this.deps.warn('dsh-channels: superseding action proposal %s failed: %s', proposalId, String(error))
      return undefined
    }
  }

  /**
   * Same-session auto-supersede: transition remaining `'pending'` items on all
   * prior proposals of `sessionId` (excluding `exceptProposalId`) to
   * `'superseded'`, preserving `'triggered'` history items.
   *
   * @returns Every record that transitioned, ready for async card refresh.
   */
  async supersedeSession(sessionId: string, exceptProposalId?: string): Promise<ActionProposalRecord[]> {
    const table = this.deps.table()
    if (table === undefined) return []
    const candidates: string[] = []
    for (const [proposalId, record] of table.entries()) {
      if (record.sessionId !== sessionId) continue
      if (exceptProposalId !== undefined && proposalId === exceptProposalId) continue
      if (!hasPendingActions(record)) continue
      candidates.push(proposalId)
    }
    const superseded: ActionProposalRecord[] = []
    for (const proposalId of candidates) {
      let updated: ActionProposalRecord | undefined
      try {
        await table.update(proposalId, (current) => {
          if (!hasPendingActions(current)) return current
          const next: ActionProposalRecord = {
            ...current,
            actions: current.actions.map(item =>
              item.status === 'pending' ? { ...item, status: 'superseded' as const } : item),
          }
          updated = next
          return next
        })
        if (updated !== undefined) superseded.push(updated)
      } catch (error) {
        this.deps.warn('dsh-channels: auto-superseding action proposal %s failed: %s', proposalId, String(error))
      }
    }
    return superseded
  }

  /**
   * Atomically mark all remaining `'pending'` items on `proposalId` as `'dismissed'`
   * (triggered when the user clicks the trailing `'暂不处理'` button).
   */
  async dismissPending(proposalId: string): Promise<ActionProposalRecord | undefined> {
    const table = this.deps.table()
    if (table === undefined) return undefined
    const existing = table.get(proposalId)
    if (existing === undefined || !hasPendingActions(existing)) return undefined
    let updated: ActionProposalRecord | undefined
    await table.update(proposalId, (current) => {
      if (!hasPendingActions(current)) return current
      const next: ActionProposalRecord = {
        ...current,
        actions: current.actions.map(item =>
          item.status === 'pending' ? { ...item, status: 'dismissed' as const } : item),
      }
      updated = next
      return next
    })
    return updated
  }

  /**
   * Atomically transition `actionId` from `'pending'` to `'triggered'`.
   * When `independent !== true`, any other `'pending'` items on the same card
   * transition to `'dismissed'`. Concurrent duplicate clicks observe a
   * non-pending status and return `{ changed: false }`.
   */
  async triggerAction(
    proposalId: string,
    actionId: string,
    userId: string,
    triggeredAt: number,
  ): Promise<TriggerActionResult> {
    const table = this.deps.table()
    if (table === undefined) return { changed: false }
    const existing = table.get(proposalId)
    if (existing === undefined) return { changed: false }
    let triggeredItem: ActionProposalStoredItem | undefined
    let updatedRecord: ActionProposalRecord | undefined
    let changedIds: string[] = []
    await table.update(proposalId, (current) => {
      const target = current.actions.find(item => item.id === actionId)
      if (target === undefined || target.status !== 'pending') return current
      const closeOthers = !target.independent
      const ids: string[] = []
      const nextActions = current.actions.map((item): ActionProposalStoredItem => {
        if (item.id === actionId) {
          ids.push(item.id)
          const settled: ActionProposalStoredItem = {
            ...item,
            status: 'triggered',
            triggeredBy: userId,
            triggeredAt,
          }
          triggeredItem = settled
          return settled
        }
        if (closeOthers && item.status === 'pending') {
          ids.push(item.id)
          return { ...item, status: 'dismissed' }
        }
        return item
      })
      changedIds = ids
      const next: ActionProposalRecord = { ...current, actions: nextActions }
      updatedRecord = next
      return next
    })
    if (triggeredItem === undefined || updatedRecord === undefined) return { changed: false }
    return { changed: true, record: updatedRecord, action: triggeredItem, changedIds }
  }

  /**
   * Roll back a {@link triggerAction} reservation when sending the reply card
   * or submitting the follow-up turn fails before the Session accepts it, so
   * the user's button stays clickable for retry. Never revives items that were
   * `superseded` concurrently.
   */
  async revertTrigger(
    proposalId: string,
    changedIds: readonly string[],
  ): Promise<ActionProposalRecord | undefined> {
    const table = this.deps.table()
    if (table === undefined || changedIds.length === 0) return undefined
    const targetIds = new Set(changedIds)
    let updated: ActionProposalRecord | undefined
    try {
      await table.update(proposalId, (current) => {
        let mutated = false
        const nextActions = current.actions.map((item): ActionProposalStoredItem => {
          if (!targetIds.has(item.id) || item.status === 'superseded' || item.status === 'pending') {
            return item
          }
          mutated = true
          const { triggeredBy: _by, triggeredAt: _at, ...rest } = item
          return { ...rest, status: 'pending' }
        })
        if (!mutated) return current
        const next: ActionProposalRecord = { ...current, actions: nextActions }
        updated = next
        return next
      })
      return updated
    } catch (error) {
      this.deps.warn('dsh-channels: reverting action proposal %s failed: %s', proposalId, String(error))
      return undefined
    }
  }

  /**
   * Prune records older than {@link ACTION_PROPOSAL_TTL_MS} (14 days).
   * Per-key failures are logged and never abort the sweep.
   */
  async prune(now: number): Promise<number> {
    const table = this.deps.table()
    if (table === undefined) return 0
    let removed = 0
    for (const [key, record] of [...table.entries()]) {
      if (!isActionProposalExpired(record, now)) continue
      try {
        await table.delete(key)
        removed += 1
      } catch (error) {
        this.deps.warn('dsh-channels: GC of action proposal %s failed: %s', key, String(error))
      }
    }
    return removed
  }
}
