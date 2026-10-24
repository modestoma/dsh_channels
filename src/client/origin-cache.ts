/**
 * 按会话缓存的飞书来源查询，会话头部入口与右侧栏标签页共用。
 *
 * @module dsh-channels/client/origin-cache
 */

import type { SessionOriginWire } from '../settings/contract.ts'
import { fetchSessionOrigin } from './api.ts'

/**
 * How long a "not from Feishu" answer is reused. A Session shows up in the
 * Web list before its Feishu route is written, so an early null must expire.
 */
const NULL_ORIGIN_TTL_MS = 15_000

interface Lookup {
  pending: Promise<SessionOriginWire | null>
  /** Epoch ms when the Host answered null; absent while pending or for an origin. */
  nullAt?: number
}

/** One settled or pending origin lookup per Session; failures are not kept. */
const lookups = new Map<string, Lookup>()

/**
 * Origin of one Session through the shared cache. An origin is kept for the
 * page's lifetime; a null answer only for {@link NULL_ORIGIN_TTL_MS}.
 * @param sessionId - DSH session id.
 * @param refresh - drop the cached answer and ask the Host again.
 * @returns the origin, or null for a Session Feishu never routed.
 */
export function loadSessionOrigin(sessionId: string, refresh = false): Promise<SessionOriginWire | null> {
  const cached = refresh ? undefined : lookups.get(sessionId)
  if (cached !== undefined && (cached.nullAt === undefined || Date.now() - cached.nullAt < NULL_ORIGIN_TTL_MS)) {
    return cached.pending
  }
  const pending = fetchSessionOrigin(sessionId).then(response => response.origin)
  const lookup: Lookup = { pending }
  lookups.set(sessionId, lookup)
  pending.then(
    (origin) => { if (origin === null) lookup.nullAt = Date.now() },
    () => { if (lookups.get(sessionId) === lookup) lookups.delete(sessionId) },
  )
  return pending
}
