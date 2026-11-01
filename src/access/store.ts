/**
 * Durable access-control store: the flat user table with its permission
 * switches, and the authorization requests.
 *
 * Reads come from in-memory maps (seeded once from the plugin's
 * `storageDomain` tables) so admission decisions stay synchronous and cheap;
 * every mutation writes through to the domain first and then updates memory,
 * matching the store patterns used for routes and inflight snapshots.
 *
 * The tables (`access_users`, `access_requests`) were added without bumping
 * the domain version on purpose: the JSON backend's `single` layout refuses a
 * stored-version mismatch, while unknown/missing tables are simply empty on
 * load (see `docs/access-control-design.md`). Request records of the retired
 * `group` kind are skipped on load.
 *
 * @module dsh-channels/access/store
 */

import type {
  AccessPermission,
  AccessRequestRecord,
  AccessUserRecord,
  FeishuDomainHandle,
} from '../domain.ts'

export interface AccessStoreDeps {
  /** The open domain handle, or undefined before start / after shutdown. */
  domain(): FeishuDomainHandle | undefined
  warn(message: string, ...args: unknown[]): void
}

/** Read-only snapshot handed to the pure policy. */
export interface AccessStoreSnapshot {
  /** Users whose `chat` switch is on. */
  users: ReadonlySet<string>
}

/** One settled authorization request (audit trail). */
export type AccessRequestStatus = AccessRequestRecord['status']

export class AccessStore {
  private readonly users = new Map<string, AccessUserRecord>()
  private readonly requests = new Map<string, AccessRequestRecord>()
  /** Cached `chat`-enabled keys so `snapshot()` stays allocation-free per message. */
  private readonly chatKeys = new Set<string>()

  constructor(private readonly deps: AccessStoreDeps) {}

  /** Seed memory from the durable tables (called once after the domain opens). */
  load(): void {
    this.clear()
    const domain = this.deps.domain()
    if (domain === undefined) {
      this.deps.warn('dsh-channels: access tables unavailable; starting with an empty user table')
      return
    }
    for (const [key, record] of domain.accessUsers.entries()) this.remember(key, record)
    for (const [key, record] of domain.accessRequests.entries()) {
      if (record.kind === 'user') this.requests.set(key, record)
    }
  }

  /** Drop every in-memory record (shutdown). The domain owns durability. */
  clear(): void {
    this.users.clear()
    this.requests.clear()
    this.chatKeys.clear()
  }

  snapshot(): AccessStoreSnapshot {
    return { users: this.chatKeys }
  }

  /** Whether `userId` has a record in the user table (any switch state). */
  hasUser(userId: string): boolean {
    return this.users.has(userId)
  }

  getUser(userId: string): AccessUserRecord | undefined {
    return this.users.get(userId)
  }

  /**
   * Whether `userId` holds one permission switch. `chat` off suspends the
   * user, so every other switch then reads as off.
   * @param userId - Feishu user_id.
   * @param permission - the switch to read.
   * @returns true when the user exists, may chat, and holds the switch.
   */
  allows(userId: string, permission: AccessPermission): boolean {
    const record = this.users.get(userId)
    return record !== undefined && record.chat && record[permission]
  }

  /** Every user, oldest first. */
  userRecords(): AccessUserRecord[] {
    return [...this.users.values()].sort((left, right) => left.addedAt - right.addedAt)
  }

  /** Insert or replace one user record. */
  async putUser(record: AccessUserRecord): Promise<AccessUserRecord> {
    await this.requireDomain('put access user').accessUsers.put(record.userId, record)
    this.remember(record.userId, record)
    return record
  }

  /**
   * Set one permission switch of an existing user.
   * @param userId - Feishu user_id.
   * @param permission - the switch to set.
   * @param enabled - new value.
   * @returns the updated record, or undefined when the user is not in the table.
   */
  async setPermission(userId: string, permission: AccessPermission, enabled: boolean): Promise<AccessUserRecord | undefined> {
    const current = this.users.get(userId)
    if (current === undefined) return undefined
    if (current[permission] === enabled) return current
    return await this.putUser({ ...current, [permission]: enabled })
  }

  async removeUser(userId: string): Promise<boolean> {
    if (!this.users.has(userId)) return false
    await this.requireDomain('remove access user').accessUsers.delete(userId)
    this.users.delete(userId)
    this.chatKeys.delete(userId)
    return true
  }

  /** Every authorization request, including settled ones (audit). */
  requestRecords(): AccessRequestRecord[] {
    return [...this.requests.values()].sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * Pending, not-yet-expired requests. Expired-but-unsettled records are
   * excluded here; `expireRequests()` is the sweep that persists the terminal
   * state (and lets the card surface patch the DM card).
   */
  pendingRequests(now = Date.now()): AccessRequestRecord[] {
    return this.requestRecords().filter(
      record => record.status === 'pending' && record.expiresAt > now,
    )
  }

  getRequest(token: string): AccessRequestRecord | undefined {
    return this.requests.get(token)
  }

  /** The current pending request for one user, if any. */
  pendingRequestFor(userId: string): AccessRequestRecord | undefined {
    for (const record of this.requests.values()) {
      if (record.targetId === userId && record.status === 'pending') return record
    }
    return undefined
  }

  /**
   * True when the same user was denied recently — used to keep a rejected
   * request from immediately re-notifying the administrator.
   */
  recentlyDenied(userId: string, windowMs: number, now = Date.now()): boolean {
    const cutoff = now - windowMs
    for (const record of this.requests.values()) {
      if (record.targetId === userId && record.status === 'denied' && record.createdAt >= cutoff) {
        return true
      }
    }
    return false
  }

  async putRequest(record: AccessRequestRecord): Promise<AccessRequestRecord> {
    await this.requireDomain('put access request').accessRequests.put(record.token, record)
    this.requests.set(record.token, record)
    return record
  }

  /**
   * Mark every pending request past its deadline as expired. Returns the
   * settled records so the caller can patch stale DM cards.
   */
  async expireRequests(now = Date.now()): Promise<AccessRequestRecord[]> {
    const expired: AccessRequestRecord[] = []
    for (const record of [...this.requests.values()]) {
      if (record.status !== 'pending' || record.expiresAt > now) continue
      const next: AccessRequestRecord = { ...record, status: 'expired' }
      try {
        await this.requireDomain('expire access request').accessRequests.put(next.token, next)
      } catch (error) {
        this.deps.warn('dsh-channels: persisting expired access request %s failed: %s', next.token, String(error))
      }
      this.requests.set(next.token, next)
      expired.push(next)
    }
    return expired
  }

  private remember(key: string, record: AccessUserRecord): void {
    this.users.set(key, record)
    if (record.chat) this.chatKeys.add(key)
    else this.chatKeys.delete(key)
  }

  private requireDomain(action: string): FeishuDomainHandle {
    const domain = this.deps.domain()
    if (domain === undefined) throw new Error(`dsh-channels: access domain not open (${action})`)
    return domain
  }
}
