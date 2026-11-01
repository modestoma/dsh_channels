/**
 * Durable per-user model preferences (`user_llm`).
 *
 * Reads come from an in-memory map seeded once from the plugin's storage
 * domain, so resolving the model for a new Session stays synchronous; every
 * mutation writes through to the domain first and then updates memory, like
 * the access store. The table was added without bumping the domain version:
 * the JSON backend loads an absent table as empty.
 *
 * @module dsh-channels/llm/store
 */

import type { FeishuDomainHandle, PersonalLlm, UserLlmRecord } from '../domain.ts'

export interface UserLlmStoreDeps {
  /** The open domain handle, or undefined before start / after shutdown. */
  domain(): FeishuDomainHandle | undefined
  warn(message: string, ...args: unknown[]): void
}

/** A preference change; omitted fields keep their stored value. */
export interface UserLlmChange {
  source?: UserLlmRecord['source']
  /** `null` clears the stored model. */
  model?: string | null
  /** `null` clears the stored effort. */
  effort?: string | null
  /** `null` removes the personal endpoint (and falls back to `default`). */
  own?: PersonalLlm | null
}

export class UserLlmStore {
  private readonly records = new Map<string, UserLlmRecord>()

  constructor(private readonly deps: UserLlmStoreDeps) {}

  /** Seed memory from the durable table (called once after the domain opens). */
  load(): void {
    this.records.clear()
    const domain = this.deps.domain()
    if (domain === undefined) {
      this.deps.warn('dsh-channels: user_llm table unavailable; every user starts on the default model')
      return
    }
    for (const [key, record] of domain.userLlm.entries()) this.records.set(key, record)
  }

  /** Drop every in-memory record (shutdown). The domain owns durability. */
  clear(): void {
    this.records.clear()
  }

  get(userId: string): UserLlmRecord | undefined {
    return this.records.get(userId)
  }

  /** Every stored preference. */
  all(): UserLlmRecord[] {
    return [...this.records.values()]
  }

  /**
   * Apply one change to a user's preference, creating the record on first use.
   * @param userId - Feishu user_id.
   * @param change - fields to change.
   * @returns the stored record.
   */
  async update(userId: string, change: UserLlmChange): Promise<UserLlmRecord> {
    const current: UserLlmRecord = this.records.get(userId) ?? { userId, source: 'default', updatedAt: 0 }
    const next: UserLlmRecord = { ...current, updatedAt: Date.now() }
    if (change.source !== undefined) next.source = change.source
    if (change.model === null) delete next.model
    else if (change.model !== undefined) next.model = change.model
    if (change.effort === null) delete next.effort
    else if (change.effort !== undefined) next.effort = change.effort
    if (change.own === null) {
      delete next.own
      if (next.source === 'own') {
        next.source = 'default'
        delete next.model
        delete next.effort
      }
    } else if (change.own !== undefined) {
      next.own = change.own
    }
    const domain = this.deps.domain()
    if (domain === undefined) throw new Error('dsh-channels: storage domain is closed (put user_llm)')
    await domain.userLlm.put(userId, next)
    this.records.set(userId, next)
    return next
  }

  /**
   * Delete a user's preference record.
   * @param userId - Feishu user_id.
   * @returns the removed record, or undefined when none was stored.
   */
  async remove(userId: string): Promise<UserLlmRecord | undefined> {
    const current = this.records.get(userId)
    if (current === undefined) return undefined
    const domain = this.deps.domain()
    if (domain === undefined) throw new Error('dsh-channels: storage domain is closed (delete user_llm)')
    await domain.userLlm.delete(userId)
    this.records.delete(userId)
    return current
  }
}
