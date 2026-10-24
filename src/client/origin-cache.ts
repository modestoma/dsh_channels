/**
 * 按会话缓存的飞书来源查询，会话头部入口与右侧栏标签页共用。
 *
 * @module dsh-channels/client/origin-cache
 */

import type { SessionOriginWire } from '../settings/contract.ts'
import { fetchSessionOrigin } from './api.ts'

/** One settled or pending origin lookup per Session; failures are not kept. */
const lookups = new Map<string, Promise<SessionOriginWire | null>>()

/**
 * Origin of one Session through the shared cache.
 * @param sessionId - DSH session id.
 * @param refresh - drop the cached answer and ask the Host again.
 * @returns the origin, or null for a Session Feishu never routed.
 */
export function loadSessionOrigin(sessionId: string, refresh = false): Promise<SessionOriginWire | null> {
  const cached = refresh ? undefined : lookups.get(sessionId)
  if (cached !== undefined) return cached
  const pending = fetchSessionOrigin(sessionId).then(response => response.origin)
  lookups.set(sessionId, pending)
  pending.catch(() => {
    if (lookups.get(sessionId) === pending) lookups.delete(sessionId)
  })
  return pending
}
