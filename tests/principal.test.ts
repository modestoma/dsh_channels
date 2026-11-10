/**
 * Channel principals: the two kinds, which one a route uses, the Peer map
 * key, and the readers of a logged message source.
 */

import { describe, expect, it } from 'vitest'
import {
  feishuGroupPrincipal, feishuUserPrincipal, principalKey, principalOnRoute, promptCallerOf, promptRequestIdOf,
} from '../src/access/principal.ts'

describe('channel principals', () => {
  it('acts as the person in a private chat and as the group, with the speaker, in a group', () => {
    expect(principalOnRoute({ chatType: 'p2p', chatId: 'oc_dm' }, 'u_1')).toEqual(feishuUserPrincipal('u_1'))
    expect(principalOnRoute({ chatType: 'group', chatId: 'oc_g' }, 'u_1')).toEqual(feishuGroupPrincipal('oc_g', 'u_1'))
    expect(feishuGroupPrincipal('oc_g', 'u_1')).toEqual({ kind: 'feishu-group', chatId: 'oc_g', userId: 'u_1' })
  })

  it('keys one Peer per principal value', () => {
    expect(principalKey(feishuUserPrincipal('u_1'))).toBe('feishu-user:u_1')
    expect(principalKey(feishuGroupPrincipal('oc_g', 'u_1'))).toBe('feishu-group:oc_g:u_1')
    expect(principalKey(feishuGroupPrincipal('oc_g', 'u_2'))).not.toBe(principalKey(feishuGroupPrincipal('oc_g', 'u_1')))
  })

  it('reads both kinds back from a logged source and fails closed on anything else', () => {
    expect(promptCallerOf({ kind: 'user', rpcId: 'r', principal: { kind: 'feishu-user', userId: 'u_1' } })).toEqual({ kind: 'feishu-user', userId: 'u_1' })
    expect(promptCallerOf({ kind: 'user', rpcId: 'r', principal: { kind: 'feishu-group', chatId: 'oc_g', userId: 'u_1' } }))
      .toEqual({ kind: 'feishu-group', chatId: 'oc_g', userId: 'u_1' })
    expect(promptCallerOf({ kind: 'user', rpcId: 'r' })).toEqual({ kind: 'none' })
    expect(promptCallerOf({ kind: 'tool-jobs' })).toEqual({ kind: 'none' })
    for (const principal of [
      { kind: 'share-viewer', shareId: 's' },
      { kind: 'feishu-user', userId: '' },
      { kind: 'feishu-group', userId: 'u_1' },
      { kind: 'feishu-group', chatId: '', userId: 'u_1' },
      { kind: 'feishu-group', chatId: 'oc_g' },
      'u_1',
      null,
      7,
    ]) {
      expect(promptCallerOf({ kind: 'user', rpcId: 'r', principal })).toEqual({ kind: 'other-principal' })
    }
  })

  it('reads the request id only from a prompt DSH created for a Remote call', () => {
    expect(promptRequestIdOf({ kind: 'user', rpcId: 'r-1' })).toBe('r-1')
    expect(promptRequestIdOf({ kind: 'user' })).toBeUndefined()
    expect(promptRequestIdOf({ kind: 'user', rpcId: '' })).toBeUndefined()
    expect(promptRequestIdOf({ kind: 'user', rpcId: 7 })).toBeUndefined()
    expect(promptRequestIdOf({ kind: 'command', rpcId: 'r-1' })).toBeUndefined()
  })
})
