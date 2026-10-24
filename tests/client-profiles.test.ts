/** Panel profile lookup: which users and chats the access and wiki tabs ask Feishu about. */

import { describe, expect, it } from 'vitest'
import { profileIds } from '../src/client/panel/profiles.ts'
import type { AccessWire } from '../src/settings/contract.ts'

describe('profileIds', () => {
  it('collects the administrator, whitelists, and pending requests once each, sorted', () => {
    const access: AccessWire = {
      mode: 'guarded',
      admin: { userId: 'u_admin', source: 'owner', configured: true },
      loaded: true,
      groups: [{ chatId: 'oc_b', source: 'panel', addedAt: 1 }],
      users: [{ userId: 'u_b', source: 'card', addedAt: 1 }, { userId: 'u_admin', source: 'panel', addedAt: 1 }],
      wikiUsers: [{ userId: 'u_a', source: 'command', addedAt: 1 }],
      requests: [
        { token: 't1', kind: 'user', targetId: 'u_c', chatId: 'oc_a', createdAt: 1, expiresAt: 2 },
        { token: 't2', kind: 'group', targetId: 'oc_c', createdAt: 1, expiresAt: 2 },
      ],
    }
    expect(profileIds(access)).toEqual({ users: ['u_a', 'u_admin', 'u_b', 'u_c'], chats: ['oc_a', 'oc_b', 'oc_c'] })
  })
})
