/**
 * Shared fakes for the access-control tests: a full validated config with the
 * guarded defaults, a storage domain exposing the three authorization tables,
 * and record builders.
 *
 * @module tests/access-fixtures
 */

import { resolveConfig } from '../src/config.ts'
import type { FeishuConfig } from '../src/config.ts'
import type {
  AccessGroupRecord, AccessRequestRecord, AccessUserRecord, FeishuDomainHandle,
} from '../src/domain.ts'
import { makeDomain } from './helpers.ts'

/** One validated config with admission control enabled and an administrator. */
export function makeAccessConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return resolveConfig({
    appId: 'FEISHU_APP_ID',
    appSecret: 'FEISHU_APP_SECRET',
    accessMode: 'guarded',
    adminUserId: 'u_admin',
    ...partial,
  })
}

/** Normalized access table facade over one fake raw table. */
function tableOf<T>(raw: ReturnType<typeof makeDomain>['raw'], name: string) {
  const table = raw.table(name)
  return {
    get: (key: string) => table.get(key) as T | undefined,
    put: (key: string, value: T) => table.put(key, value),
    delete: (key: string) => table.delete(key),
    entries: () => table.entries() as IterableIterator<[string, T]>,
  }
}

/**
 * A domain handle exposing the three authorization tables over the shared
 * fake raw storage (the routing tables are not needed by the access modules).
 */
export function makeAccessDomain(): {
  handle: FeishuDomainHandle
  raw: ReturnType<typeof makeDomain>['raw']
} {
  const { raw } = makeDomain()
  const handle = {
    accessGroups: tableOf<AccessGroupRecord>(raw, 'access_groups'),
    accessUsers: tableOf<AccessUserRecord>(raw, 'access_users'),
    accessRequests: tableOf<AccessRequestRecord>(raw, 'access_requests'),
    accessWikiUsers: tableOf<AccessUserRecord>(raw, 'access_wiki_users'),
  } as unknown as FeishuDomainHandle
  return { handle, raw }
}

/** One authorized-group record. */
export function groupRecord(partial: Partial<AccessGroupRecord> = {}): AccessGroupRecord {
  return {
    chatId: 'oc_group',
    source: 'command',
    addedBy: 'u_admin',
    addedAt: 1_000,
    ...partial,
  }
}

/** One authorized-user record. */
export function userRecord(partial: Partial<AccessUserRecord> = {}): AccessUserRecord {
  return {
    userId: 'u_alice',
    source: 'command',
    addedBy: 'u_admin',
    addedAt: 1_000,
    ...partial,
  }
}

/** One authorization-request record (pending unless overridden). */
export function requestRecord(partial: Partial<AccessRequestRecord> = {}): AccessRequestRecord {
  return {
    token: 'tok-default',
    kind: 'group',
    targetId: 'oc_group',
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 1_000 + 7 * 86_400_000,
    ...partial,
  }
}
