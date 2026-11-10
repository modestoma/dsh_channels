/**
 * The `remoteAccess` policies of this channel's principals: which Sessions a
 * private-chat user or a group member may prompt, derived from the route
 * table through the channel-plane rule.
 */

import { describe, expect, it, vi } from 'vitest'
import { feishuGroupPrincipal, feishuUserPrincipal } from '../src/access/principal.ts'
import { CHANNEL_PROMPT_ROLE, channelAccessBindings, registerChannelAccessPolicies, ROUTE_NOT_PERMITTED } from '../src/access/remote-policy.ts'
import type { RouteRecord } from '../src/domain.ts'
import { makeRemoteServices } from './helpers.ts'

function route(partial: Partial<RouteRecord> & Pick<RouteRecord, 'sessionId' | 'chatId' | 'chatType' | 'senderUserId'>): RouteRecord {
  return {
    key: `key-${partial.sessionId}`, kind: 'thread', workspacePath: '/w', cardMessageId: 'om_1',
    createdAt: 1, lastActivityAt: 1, sessionHistory: [], ...partial,
  }
}

const routes: RouteRecord[] = [
  route({ sessionId: 's_dm_alice', chatId: 'oc_dm_alice', chatType: 'p2p', senderUserId: 'u_alice' }),
  route({ sessionId: 's_dm_bob', chatId: 'oc_dm_bob', chatType: 'p2p', senderUserId: 'u_bob' }),
  route({ sessionId: 's_group_alice', chatId: 'oc_group', chatType: 'group', senderUserId: 'u_alice' }),
  route({ sessionId: 's_group_bob', chatId: 'oc_group', chatType: 'group', senderUserId: 'u_bob' }),
  route({ sessionId: 's_other_group', chatId: 'oc_other', chatType: 'group', senderUserId: 'u_alice' }),
]

/** The channel-plane rule: the person of a private chat, or any admitted member of a group (u_carol is not admitted). */
const mayActOnRoute = (userId: string, chatId: string, record: RouteRecord): boolean =>
  record.chatId === chatId && (record.chatType === 'group' ? userId !== 'u_carol' : record.senderUserId === userId)

const deps = { routes: () => routes, mayActOnRoute }

describe('channel access bindings', () => {
  it('binds a private-chat user to the Sessions of the private-chat routes they own', () => {
    expect(channelAccessBindings(deps, feishuUserPrincipal('u_alice'))).toEqual([
      { role: CHANNEL_PROMPT_ROLE, resource: { kind: 'session', id: 's_dm_alice' } },
    ])
    expect(channelAccessBindings(deps, feishuUserPrincipal('u_carol'))).toEqual([])
  })

  it('binds an admitted group member to that group\'s routes, never to another group', () => {
    const ids = (userId: string, chatId = 'oc_group') =>
      channelAccessBindings(deps, feishuGroupPrincipal(chatId, userId)).map(binding => binding.resource.id)
    expect(ids('u_alice')).toEqual(['s_group_alice', 's_group_bob'])
    expect(ids('u_bob')).toEqual(['s_group_alice', 's_group_bob'])
    expect(ids('u_carol')).toEqual([])
    expect(ids('u_alice', 'oc_other')).toEqual(['s_other_group'])
    // The group principal never reaches private-chat Sessions.
    expect(ids('u_alice', 'oc_dm_alice')).toEqual([])
  })

  it('names only session/prompt', () => {
    expect(CHANNEL_PROMPT_ROLE).toEqual({ name: 'dsh-channels:prompt', resource: 'session', actions: ['session/prompt'] })
  })
})

describe('registerChannelAccessPolicies', () => {
  it('registers one policy per kind, answering from the live route table, and removes both on dispose', () => {
    const remote = makeRemoteServices({
      agents: { get: () => undefined } as never,
      attachments: {} as never,
      llm: { resolveModelInfo: vi.fn(async () => ({})) },
    })
    const live = [...routes]
    const dispose = registerChannelAccessPolicies(remote.remoteAccess, { routes: () => live, mayActOnRoute })
    expect([...remote.remoteAccess.policies.keys()].sort()).toEqual(['feishu-group', 'feishu-user'])
    expect(remote.remoteAccess.decide(feishuUserPrincipal('u_alice'), 's_dm_alice')).toEqual({ kind: 'allow' })
    expect(remote.remoteAccess.decide(feishuGroupPrincipal('oc_group', 'u_bob'), 's_group_alice')).toEqual({ kind: 'allow' })
    expect(remote.remoteAccess.decide(feishuGroupPrincipal('oc_group', 'u_carol'), 's_group_alice')).toEqual({ kind: 'deny', reason: ROUTE_NOT_PERMITTED })
    // A route removed later is refused at the next decision.
    live.splice(0, 1)
    expect(remote.remoteAccess.decide(feishuUserPrincipal('u_alice'), 's_dm_alice')).toEqual({ kind: 'deny', reason: ROUTE_NOT_PERMITTED })

    dispose()
    expect(remote.remoteAccess.policies.size).toBe(0)
    expect(remote.remoteAccess.decide(feishuUserPrincipal('u_bob'), 's_dm_bob')).toEqual({ kind: 'deny', reason: 'no-allow' })
    // Registering again after disposal is allowed; registering twice is not.
    const again = registerChannelAccessPolicies(remote.remoteAccess, { routes: () => live, mayActOnRoute })
    expect(() => registerChannelAccessPolicies(remote.remoteAccess, { routes: () => live, mayActOnRoute })).toThrow(/already registered/)
    again()
  })
})
