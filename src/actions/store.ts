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

/** Unconfirmed in-flight click reservation awaiting turn acceptance or startup reconciliation. */
export const actionReservationSchema = z.object({
  requestId: z.string().min(1),
  actionId: z.string().min(1),
  changedIds: z.array(z.string().min(1)).min(1),
  createdAt: z.number().int().nonnegative(),
})

export type ActionReservation = z.infer<typeof actionReservationSchema>

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
  superseded: z.boolean().optional(),
  supersededReason: z.string().optional(),
  reservations: z.array(actionReservationSchema).optional(),
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

/** True when the record carries at least one unconfirmed in-flight click reservation. */
export function hasActiveReservations(record: Pick<ActionProposalRecord, 'reservations'>): boolean {
  return (record.reservations?.length ?? 0) > 0
}

function canSupersedeRecord(
  record: Pick<ActionProposalRecord, 'actions' | 'superseded' | 'reservations'>,
): boolean {
  return hasPendingActions(record) || (record.superseded !== true && hasActiveReservations(record))
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
    if (existing === undefined || existing.key !== key || !canSupersedeRecord(existing)) {
      return undefined
    }
    const cleanReason = reason?.trim()
    let updated: ActionProposalRecord | undefined
    try {
      await table.update(proposalId, (current) => {
        if (current.key !== key || !canSupersedeRecord(current)) return current
        const hadPending = hasPendingActions(current)
        const next: ActionProposalRecord = {
          ...current,
          superseded: true,
          ...(cleanReason !== undefined && cleanReason !== '' ? { supersededReason: cleanReason } : {}),
          actions: current.actions.map(item =>
            item.status === 'pending' ? { ...item, status: 'superseded' as const } : item),
        }
        if (hadPending) updated = next
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
   * `'superseded'` and mark any proposal with in-flight reservations as
   * `superseded: true` so a subsequent rollback never revives obsolete buttons.
   *
   * @returns Every record whose visible `'pending'` items transitioned, ready for async card refresh.
   */
  async supersedeSession(sessionId: string, exceptProposalId?: string): Promise<ActionProposalRecord[]> {
    const table = this.deps.table()
    if (table === undefined) return []
    const candidates: string[] = []
    for (const [proposalId, record] of table.entries()) {
      if (record.sessionId !== sessionId) continue
      if (exceptProposalId !== undefined && proposalId === exceptProposalId) continue
      if (!canSupersedeRecord(record)) continue
      candidates.push(proposalId)
    }
    const superseded: ActionProposalRecord[] = []
    for (const proposalId of candidates) {
      let updated: ActionProposalRecord | undefined
      try {
        await table.update(proposalId, (current) => {
          if (!canSupersedeRecord(current)) return current
          const hadPending = hasPendingActions(current)
          const next: ActionProposalRecord = {
            ...current,
            superseded: true,
            actions: current.actions.map(item =>
              item.status === 'pending' ? { ...item, status: 'superseded' as const } : item),
          }
          if (hadPending) updated = next
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
      if (current.superseded === true || !hasPendingActions(current)) return current
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
    requestId?: string,
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
      if (current.superseded === true || target === undefined || target.status !== 'pending') return current
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
      const nextReservations = requestId === undefined
        ? current.reservations
        : [
          ...(current.reservations ?? []).filter(entry => entry.requestId !== requestId),
          { requestId, actionId, changedIds: ids, createdAt: triggeredAt },
        ]
      const { reservations: _oldRes, ...base } = current
      const next: ActionProposalRecord = {
        ...base,
        actions: nextActions,
        ...(nextReservations !== undefined && nextReservations.length > 0 ? { reservations: nextReservations } : {}),
      }
      updatedRecord = next
      return next
    })
    if (triggeredItem === undefined || updatedRecord === undefined) return { changed: false }
    return { changed: true, record: updatedRecord, action: triggeredItem, changedIds }
  }

  /**
   * Confirm an in-flight {@link triggerAction} reservation once its follow-up
   * turn has been accepted by the Session.
   */
  async confirmTrigger(
    proposalId: string,
    requestId: string,
  ): Promise<ActionProposalRecord | undefined> {
    const table = this.deps.table()
    if (table === undefined) return undefined
    let updated: ActionProposalRecord | undefined
    try {
      await table.update(proposalId, (current) => {
        if (current.reservations === undefined || !current.reservations.some(r => r.requestId === requestId)) {
          updated = current
          return current
        }
        const remaining = current.reservations.filter(r => r.requestId !== requestId)
        const { reservations: _old, ...base } = current
        const next: ActionProposalRecord = {
          ...base,
          ...(remaining.length > 0 ? { reservations: remaining } : {}),
        }
        updated = next
        return next
      })
      return updated
    } catch (error) {
      this.deps.warn('dsh-channels: confirming action proposal %s failed: %s', proposalId, String(error))
      return undefined
    }
  }

  /**
   * Roll back a {@link triggerAction} reservation when sending the reply card
   * or submitting the follow-up turn fails before the Session accepts it, so
   * the user's button stays clickable for retry. If the proposal was superseded
   * while the click was in flight, transitions rolled-back items to
   * `'superseded'` instead of reviving obsolete `'pending'` buttons.
   */
  async revertTrigger(
    proposalId: string,
    changedIds: readonly string[],
    requestId?: string,
  ): Promise<ActionProposalRecord | undefined> {
    const table = this.deps.table()
    if (table === undefined || changedIds.length === 0) return undefined
    const targetIds = new Set(changedIds)
    let updated: ActionProposalRecord | undefined
    try {
      await table.update(proposalId, (current) => {
        const rollbackStatus: ActionProposalStatus = current.superseded === true ? 'superseded' : 'pending'
        let mutated = false
        const nextActions = current.actions.map((item): ActionProposalStoredItem => {
          if (!targetIds.has(item.id) || item.status === 'superseded' || item.status === 'pending') {
            return item
          }
          mutated = true
          const { triggeredBy: _by, triggeredAt: _at, ...rest } = item
          return { ...rest, status: rollbackStatus }
        })
        const remaining = requestId === undefined
          ? current.reservations
          : current.reservations?.filter(r => r.requestId !== requestId)
        const reservationRemoved = remaining?.length !== current.reservations?.length
        if (!mutated && !reservationRemoved) return current
        const { reservations: _old, ...base } = current
        const next: ActionProposalRecord = {
          ...base,
          actions: nextActions,
          ...(remaining !== undefined && remaining.length > 0 ? { reservations: remaining } : {}),
        }
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
   * Startup reconciliation pass: resolve any unconfirmed reservations left behind
   * if the previous process exited mid-click. Reservations whose `requestId` is
   * present in `recoverableRequestIds` (an active `inflight` snapshot that
   * `repairAll()` will recover) are confirmed; any reservation that crashed
   * before `repair.write()` completed is rolled back to `'pending'` (or
   * `'superseded'` if superseded) so the user's button is not permanently lost.
   */
  async reconcileReservations(recoverableRequestIds: ReadonlySet<string>): Promise<ActionProposalRecord[]> {
    const table = this.deps.table()
    if (table === undefined) return []
    const reconciled: ActionProposalRecord[] = []
    for (const [proposalId, record] of [...table.entries()]) {
      if (!hasActiveReservations(record)) continue
      let updated: ActionProposalRecord | undefined
      try {
        await table.update(proposalId, (current) => {
          if (!hasActiveReservations(current)) return current
          const rollbackIds = new Set<string>()
          for (const res of current.reservations ?? []) {
            if (!recoverableRequestIds.has(res.requestId)) {
              for (const id of res.changedIds) rollbackIds.add(id)
            }
          }
          const rollbackStatus: ActionProposalStatus = current.superseded === true ? 'superseded' : 'pending'
          const nextActions = rollbackIds.size === 0
            ? current.actions
            : current.actions.map((item): ActionProposalStoredItem => {
              if (!rollbackIds.has(item.id) || item.status === 'superseded' || item.status === 'pending') {
                return item
              }
              const { triggeredBy: _by, triggeredAt: _at, ...rest } = item
              return { ...rest, status: rollbackStatus }
            })
          const { reservations: _old, ...base } = current
          const next: ActionProposalRecord = {
            ...base,
            actions: nextActions,
          }
          updated = next
          return next
        })
        if (updated !== undefined) reconciled.push(updated)
      } catch (error) {
        this.deps.warn('dsh-channels: reconciling action proposal %s failed: %s', proposalId, String(error))
      }
    }
    return reconciled
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
