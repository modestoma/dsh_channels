/**
 * Durable route store: thread/chat keys → bound DSH session records.
 *
 * Owns the hot cache over the `channels_routes` domain tables, the TTL
 * retirement that leaves a persistent tombstone, session → route lookup, and
 * the durable session → Feishu origin records every route write feeds.
 * The domain handle is late-bound (`domain()`), because the service opens it
 * during `start()` while the store is constructed earlier.
 *
 * @module dsh-channels/session/routes
 */

import type { ExpiredRouteRecord, FeishuDomainHandle, RouteRecord, SessionOriginRecord } from '../domain.ts'
import { normalizeRouteRecord, normalizeSessionHistory } from '../domain.ts'

export interface RouteStoreDeps {
  /** The opened domain handle, or undefined before `start()` / after shutdown. */
  domain(): FeishuDomainHandle | undefined
  /** Route retirement TTL in milliseconds; `0` disables retirement. */
  ttlMs(): number
  /** Structured warning sink (never throws). */
  warn(message: string, ...args: unknown[]): void
}

export class RouteStore {
  /** Active route records, hydrated once and kept in sync with writes. */
  private readonly active = new Map<string, RouteRecord>()
  /** Thread ids retired by TTL; retained so later messages cannot fork context. */
  private readonly expired = new Map<string, ExpiredRouteRecord>()

  constructor(private readonly deps: RouteStoreDeps) {}

  /**
   * Hydrate the caches from the opened domain. A tombstone wins over an active
   * row left behind by an interrupted or failed delete: expired Sessions must
   * not remain approval-routable.
   */
  load(): void {
    const domain = this.deps.domain()
    if (domain === undefined) return
    for (const [key, record] of domain.routes.entries()) {
      this.active.set(key, normalizeRouteRecord(record))
    }
    for (const [key, record] of domain.expiredRoutes.entries()) {
      this.expired.set(key, record)
      this.active.delete(key)
    }
    // Routes written before origins existed get theirs now; a failure only
    // leaves those Sessions without a Web origin view.
    for (const record of this.active.values()) {
      void this.recordOrigins(record)
    }
  }

  /** One active route by key (cache-first, normalized). */
  get(key: string): RouteRecord | undefined {
    const cached = this.active.get(key)
    if (cached !== undefined) return cached
    const stored = this.deps.domain()?.routes.get(key)
    if (stored === undefined) return undefined
    const normalized = normalizeRouteRecord(stored)
    this.active.set(key, normalized)
    return normalized
  }

  /** One durable tombstone by expired thread id. */
  expiredRoute(key: string): ExpiredRouteRecord | undefined {
    const cached = this.expired.get(key)
    if (cached !== undefined) return cached
    const stored = this.deps.domain()?.expiredRoutes.get(key)
    if (stored === undefined) return undefined
    this.expired.set(key, stored)
    return stored
  }

  /** Persist one active route and refresh the cache. */
  async put(key: string, record: RouteRecord): Promise<void> {
    await this.deps.domain()?.routes.put(key, record)
    const normalized = normalizeRouteRecord(record)
    this.active.set(key, normalized)
    await this.recordOrigins(normalized)
  }

  /** Every recorded Session origin, retired routes included. */
  origins(): SessionOriginRecord[] {
    const table = this.deps.domain()?.sessionOrigins
    return table === undefined ? [] : [...table.entries()].map(([, record]) => record)
  }

  /** Feishu origin of one Session any route ever named, retired routes included. */
  origin(sessionId: string): SessionOriginRecord | undefined {
    return this.deps.domain()?.sessionOrigins.get(sessionId)
  }

  /** Delete one active route from the medium and the cache. */
  async remove(key: string): Promise<void> {
    await this.deps.domain()?.routes.delete(key)
    this.active.delete(key)
  }

  /** Drop one key from the cache only (used when a tombstone takes over). */
  forget(key: string): void {
    this.active.delete(key)
  }

  /** Find the route record owning a session (a thread route wins). */
  findBySession(sessionId: string): RouteRecord | undefined {
    let fallback: RouteRecord | undefined
    for (const record of this.active.values()) {
      if (record.sessionId !== sessionId) continue
      if (record.kind === 'thread') return record
      fallback ??= record
    }
    return fallback
  }

  size(): number {
    return this.active.size
  }

  /** Every active route record. */
  records(): RouteRecord[] {
    return [...this.active.values()]
  }

  clear(): void {
    this.active.clear()
    this.expired.clear()
  }

  /**
   * Write an origin for every Session in the route's history that has none.
   * Existing origins are never rewritten: the first route naming a Session
   * is where it started. Failures are logged and never fail the route write.
   */
  private async recordOrigins(record: RouteRecord): Promise<void> {
    const table = this.deps.domain()?.sessionOrigins
    if (table === undefined) return
    for (const entry of normalizeSessionHistory(record)) {
      if (table.get(entry.sessionId) !== undefined) continue
      const origin: SessionOriginRecord = {
        key: entry.sessionId,
        routeKey: record.key,
        kind: record.kind,
        chatId: record.chatId,
        chatType: record.chatType,
        senderUserId: record.senderUserId,
        createdAt: entry.createdAt,
        ...(record.shared === true ? { shared: true as const } : {}),
      }
      try {
        await table.put(entry.sessionId, origin)
      } catch (error) {
        this.deps.warn('dsh-channels: recording the origin of session %s failed: %s', entry.sessionId, String(error))
      }
    }
  }

  /** Whether one active route has crossed the configured inactivity deadline. */
  private hasExpired(record: RouteRecord, now: number): boolean {
    const ttlMs = this.deps.ttlMs()
    return ttlMs > 0 && record.lastActivityAt < now - ttlMs
  }

  /**
   * Resolve or create the persistent tombstone for a thread whose active route
   * has crossed TTL. Tombstone publication comes first and wins even if the
   * best-effort active-route delete fails.
   */
  async expireThread(key: string, now = Date.now()): Promise<ExpiredRouteRecord | undefined> {
    const existing = this.expiredRoute(key)
    if (existing !== undefined) {
      this.active.delete(key)
      if (this.deps.domain()?.routes.get(key) !== undefined) {
        try {
          await this.deps.domain()?.routes.delete(key)
        } catch (error) {
          this.deps.warn('dsh-channels: deleting tombstoned route %s failed: %s', key, String(error))
        }
      }
      return existing
    }
    const record = this.get(key)
    if (record === undefined || record.kind !== 'thread' || !this.hasExpired(record, now)) return undefined
    return await this.retire(key, now)
  }

  /**
   * Retire one active thread route into a persistent tombstone regardless of
   * the configured TTL.
   */
  async retire(key: string, now = Date.now()): Promise<ExpiredRouteRecord | undefined> {
    const record = this.get(key)
    if (record === undefined) return this.expiredRoute(key)
    const tombstone: ExpiredRouteRecord = {
      key,
      chatId: record.chatId,
      chatType: record.chatType,
      senderUserId: record.senderUserId,
      expiredAt: now,
      workspacePath: record.workspacePath,
      ...(record.sessionDir === undefined ? {} : { sessionDir: record.sessionDir }),
      ...(record.worktreeBranch === undefined ? {} : { worktreeBranch: record.worktreeBranch }),
      lastActivityAt: record.lastActivityAt,
    }
    await this.deps.domain()?.expiredRoutes.put(key, tombstone)
    this.expired.set(key, tombstone)
    this.active.delete(key)
    try {
      await this.deps.domain()?.routes.delete(key)
    } catch (error) {
      // The durable tombstone already makes expiry fail-closed. Keep serving
      // the explicit rejection and let a later sweep retry the stale delete.
      this.deps.warn('dsh-channels: deleting retired route %s failed: %s', key, String(error))
    }
    return tombstone
  }
}
