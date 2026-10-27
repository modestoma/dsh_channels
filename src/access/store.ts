/**
 * Durable access-control store.
 *
 * Reads come from in-memory maps (seeded once from the plugin's
 * `storageDomain` tables) so admission decisions stay synchronous and cheap;
 * every mutation writes through to the domain first and then updates memory,
 * matching the store patterns used for routes and inflight snapshots.
 *
 * The tables (`access_groups`, `access_users`, `access_requests`,
 * `access_wiki_users`) were added
 * without bumping the domain version on purpose: the JSON backend's `single`
 * layout refuses a stored-version mismatch, while unknown/missing tables are
 * simply empty on load (see `docs/access-control-design.md` §4.2).
 *
 * @module dsh-channels/access/store
 */

import type {
  AccessGroupRecord,
  AccessRequestRecord,
  AccessUserRecord,
  FeishuDomainHandle,
} from '../domain.ts'

export interface AccessStoreDeps {
  /** The open domain handle, or undefined before start / after shutdown. */
  domain(): FeishuDomainHandle | undefined
  warn(message: string, ...args: unknown[]): void
}

/** Read-only whitespace snapshot handed to the pure policy. */
export interface AccessStoreSnapshot {
  groups: ReadonlySet<string>
  users: ReadonlySet<string>
}

/** One settled authorization request (audit trail). */
export type AccessRequestStatus = AccessRequestRecord['status']

export class AccessStore {
  private readonly groups = new Map<string, AccessGroupRecord>()
  private readonly users = new Map<string, AccessUserRecord>()
  private readonly requests = new Map<string, AccessRequestRecord>()
  /** Wiki whitelist (`/auth wiki add`), independent of the user whitelist. */
  private readonly wikiUsers = new Map<string, AccessUserRecord>()
  /** Cached key sets so `snapshot()` can stay allocation-free per message. */
  private readonly groupKeys = new Set<string>()
  private readonly userKeys = new Set<string>()

  constructor(private readonly deps: AccessStoreDeps) {}

  /** Seed memory from the durable tables (called once after the domain opens). */
  load(): void {
    this.clear()
    const domain = this.deps.domain()
    if (domain === undefined) {
      this.deps.warn('dsh-channels: access tables unavailable; starting with an empty whitelist')
      return
    }
    for (const [key, record] of domain.accessGroups.entries()) {
      this.groups.set(key, record)
      this.groupKeys.add(key)
    }
    for (const [key, record] of domain.accessUsers.entries()) {
      this.users.set(key, record)
      this.userKeys.add(key)
    }
    for (const [key, record] of domain.accessRequests.entries()) {
      this.requests.set(key, record)
    }
    for (const [key, record] of domain.accessWikiUsers.entries()) {
      this.wikiUsers.set(key, record)
    }
  }

  /** Drop every in-memory record (shutdown). The domain owns durability. */
  clear(): void {
    this.groups.clear()
    this.users.clear()
    this.requests.clear()
    this.wikiUsers.clear()
    this.groupKeys.clear()
    this.userKeys.clear()
  }

  snapshot(): AccessStoreSnapshot {
    return { groups: this.groupKeys, users: this.userKeys }
  }

  hasGroup(chatId: string): boolean {
    return this.groupKeys.has(chatId)
  }

  hasUser(userId: string): boolean {
    return this.userKeys.has(userId)
  }

  getGroup(chatId: string): AccessGroupRecord | undefined {
    return this.groups.get(chatId)
  }

  getUser(userId: string): AccessUserRecord | undefined {
    return this.users.get(userId)
  }

  /** Every authorized group, oldest first. */
  groupRecords(): AccessGroupRecord[] {
    return [...this.groups.values()].sort((left, right) => left.addedAt - right.addedAt)
  }

  /** Every authorized user, oldest first. */
  userRecords(): AccessUserRecord[] {
    return [...this.users.values()].sort((left, right) => left.addedAt - right.addedAt)
  }

  async addGroup(record: AccessGroupRecord): Promise<AccessGroupRecord> {
    await this.requireDomain('add access group').accessGroups.put(record.chatId, record)
    this.groups.set(record.chatId, record)
    this.groupKeys.add(record.chatId)
    return record
  }

  async removeGroup(chatId: string): Promise<boolean> {
    if (!this.groups.has(chatId)) return false
    await this.requireDomain('remove access group').accessGroups.delete(chatId)
    this.groups.delete(chatId)
    this.groupKeys.delete(chatId)
    return true
  }

  async addUser(record: AccessUserRecord): Promise<AccessUserRecord> {
    await this.requireDomain('add access user').accessUsers.put(record.userId, record)
    this.users.set(record.userId, record)
    this.userKeys.add(record.userId)
    return record
  }

  async removeUser(userId: string): Promise<boolean> {
    if (!this.users.has(userId)) return false
    await this.requireDomain('remove access user').accessUsers.delete(userId)
    this.users.delete(userId)
    this.userKeys.delete(userId)
    return true
  }

  /** Whether `userId` is on the wiki whitelist (the administrator is not implied). */
  hasWikiUser(userId: string): boolean {
    return this.wikiUsers.has(userId)
  }

  /** Every wiki-whitelisted user, oldest first. */
  wikiUserRecords(): AccessUserRecord[] {
    return [...this.wikiUsers.values()].sort((left, right) => left.addedAt - right.addedAt)
  }

  async addWikiUser(record: AccessUserRecord): Promise<AccessUserRecord> {
    await this.requireDomain('add wiki user').accessWikiUsers.put(record.userId, record)
    this.wikiUsers.set(record.userId, record)
    return record
  }

  async removeWikiUser(userId: string): Promise<boolean> {
    if (!this.wikiUsers.has(userId)) return false
    await this.requireDomain('remove wiki user').accessWikiUsers.delete(userId)
    this.wikiUsers.delete(userId)
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

  /** The current pending request for one target, if any. */
  pendingRequestFor(kind: AccessRequestRecord['kind'], targetId: string): AccessRequestRecord | undefined {
    for (const record of this.requests.values()) {
      if (record.kind === kind && record.targetId === targetId && record.status === 'pending') {
        return record
      }
    }
    return undefined
  }

  /**
   * True when the same target was denied recently — used to keep a rejected
   * request from immediately re-notifying the administrator.
   */
  recentlyDenied(
    kind: AccessRequestRecord['kind'],
    targetId: string,
    windowMs: number,
    now = Date.now(),
  ): boolean {
    const cutoff = now - windowMs
    for (const record of this.requests.values()) {
      if (record.kind === kind && record.targetId === targetId
        && record.status === 'denied' && record.createdAt >= cutoff) {
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

  private requireDomain(action: string): FeishuDomainHandle {
    const domain = this.deps.domain()
    if (domain === undefined) throw new Error(`dsh-channels: access domain not open (${action})`)
    return domain
  }
}
