/** Panel profile lookup: which users and chats the access tab asks Feishu about. */

import { describe, expect, it } from 'vitest'
import { profileIds } from '../src/client/panel/profiles.ts'
import type { AccessWire } from '../src/settings/contract.ts'

describe('profileIds', () => {
  it('collects the user table (administrators included), the group table, and pending requests once each, sorted', () => {
    const access: AccessWire = {
      mode: 'guarded',
      loaded: true,
      users: [
        { userId: 'u_b', source: 'card', addedAt: 1, admin: false, chat: true, wikiRead: true, wikiWrite: false, codeWrite: false },
        { userId: 'u_admin', source: 'panel', addedAt: 1, admin: true, chat: true, wikiRead: false, wikiWrite: false, codeWrite: false },
      ],
      groups: [
        { chatId: 'oc_b', addedAt: 1, wikiRead: false, wikiWrite: false, codeWrite: false },
        { chatId: 'oc_a', addedAt: 1, wikiRead: false, wikiWrite: false, codeWrite: false },
      ],
      requests: [
        { token: 't1', targetId: 'u_c', chatId: 'oc_a', createdAt: 1, expiresAt: 2 },
        { token: 't2', targetId: 'u_a', createdAt: 1, expiresAt: 2 },
      ],
    }
    expect(profileIds(access)).toEqual({ users: ['u_a', 'u_admin', 'u_b', 'u_c'], chats: ['oc_a', 'oc_b'] })
  })
})
