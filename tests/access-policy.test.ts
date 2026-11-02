/**
 * Pure admission policy matrix: open/guarded, administrator bootstrap, the
 * user table's `admin` flags and `chat` switch, private chats and groups.
 */

import { describe, expect, it } from 'vitest'
import { decideAccess } from '../src/access/policy.ts'
import type { AccessPolicyConfig, AccessSnapshot } from '../src/access/policy.ts'

const ADMIN = 'u_admin'

/** One snapshot of users whose `chat` switch is on and of administrators. */
function snapshot(users: string[] = [], admins: string[] = [ADMIN]): AccessSnapshot {
  return { users: new Set(users), admins: new Set(admins) }
}

function config(partial: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return { accessMode: 'guarded', ...partial }
}

function p2p(senderId: string): Parameters<typeof decideAccess>[0] {
  return { chatType: 'p2p', senderId }
}

function group(senderId: string): Parameters<typeof decideAccess>[0] {
  return { chatType: 'group', senderId }
}

describe('decideAccess：open 模式', () => {
  it('放行任何发送者（即便没有管理员）并标记为 open', () => {
    for (const subject of [p2p('u_anyone'), group('u_anyone'), group(ADMIN)]) {
      expect(decideAccess(subject, config({ accessMode: 'open' }), snapshot())).toEqual({ kind: 'allow', reason: 'open' })
      expect(decideAccess(subject, config({ accessMode: 'open' }), snapshot([], []))).toEqual({ kind: 'allow', reason: 'open' })
    }
  })
})

describe('decideAccess：guarded 且用户表没有管理员', () => {
  it('任何聊天类型都拒绝（fail closed），即便用户在表里', () => {
    for (const subject of [p2p('u_alice'), p2p(ADMIN), group('u_alice'), group(ADMIN)]) {
      expect(decideAccess(subject, config(), snapshot(['u_alice', ADMIN], [])))
        .toEqual({ kind: 'deny', reason: 'admin-missing' })
    }
  })
})

describe('decideAccess：私聊与群聊同一规则', () => {
  it('每位管理员在私聊和任何群都放行，与对话开关无关', () => {
    for (const admin of [ADMIN, 'u_admin2']) {
      expect(decideAccess(p2p(admin), config(), snapshot([], [ADMIN, 'u_admin2']))).toEqual({ kind: 'allow', reason: 'admin' })
      expect(decideAccess(group(admin), config(), snapshot([], [ADMIN, 'u_admin2']))).toEqual({ kind: 'allow', reason: 'admin' })
    }
  })

  it('打开对话准入的用户在私聊和任何群都放行', () => {
    expect(decideAccess(p2p('u_alice'), config(), snapshot(['u_alice']))).toEqual({ kind: 'allow', reason: 'authorized-user' })
    expect(decideAccess(group('u_alice'), config(), snapshot(['u_alice']))).toEqual({ kind: 'allow', reason: 'authorized-user' })
  })

  it('其他人在私聊和群里都拒绝；user_id 区分大小写', () => {
    expect(decideAccess(p2p('u_stranger'), config(), snapshot(['u_alice']))).toEqual({ kind: 'deny', reason: 'user-not-authorized' })
    expect(decideAccess(group('u_stranger'), config(), snapshot(['u_alice']))).toEqual({ kind: 'deny', reason: 'user-not-authorized' })
    expect(decideAccess(group('U_ALICE'), config(), snapshot(['u_alice']))).toEqual({ kind: 'deny', reason: 'user-not-authorized' })
  })
})
