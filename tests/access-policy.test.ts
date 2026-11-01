/**
 * Pure admission policy matrix: open/guarded, administrator bootstrap, the
 * user table's `chat` switch, private chats and groups, and normalization.
 */

import { describe, expect, it } from 'vitest'
import { decideAccess, isAdminUserId } from '../src/access/policy.ts'
import type { AccessPolicyConfig, AccessSnapshot } from '../src/access/policy.ts'

const ADMIN = 'u_admin'

/** One snapshot of users whose `chat` switch is on. */
function snapshot(users: string[] = []): AccessSnapshot {
  return { users: new Set(users) }
}

function config(partial: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return { accessMode: 'guarded', adminUserId: ADMIN, ...partial }
}

function p2p(senderId: string): Parameters<typeof decideAccess>[0] {
  return { chatType: 'p2p', senderId }
}

function group(senderId: string): Parameters<typeof decideAccess>[0] {
  return { chatType: 'group', senderId }
}

describe('isAdminUserId', () => {
  it('只认与配置完全一致的 user_id', () => {
    expect(isAdminUserId({ adminUserId: ADMIN }, ADMIN)).toBe(true)
    expect(isAdminUserId({ adminUserId: ADMIN }, 'u_other')).toBe(false)
    expect(isAdminUserId({ adminUserId: ADMIN }, undefined)).toBe(false)
  })

  it('未配置或空字符串时任何发送者都不是管理员', () => {
    expect(isAdminUserId({}, ADMIN)).toBe(false)
    expect(isAdminUserId({ adminUserId: '' }, '')).toBe(false)
    expect(isAdminUserId({ adminUserId: '   ' }, '   ')).toBe(false)
  })

  it('裁剪配置与输入两侧的空白后再比较，且区分大小写', () => {
    expect(isAdminUserId({ adminUserId: '  u_admin  ' }, 'u_admin')).toBe(true)
    expect(isAdminUserId({ adminUserId: ADMIN }, '  u_admin ')).toBe(true)
    expect(isAdminUserId({ adminUserId: ADMIN }, 'U_ADMIN')).toBe(false)
  })
})

describe('decideAccess：open 模式', () => {
  it('放行任何发送者（即便没有管理员）并标记为 open', () => {
    for (const subject of [p2p('u_anyone'), group('u_anyone'), group(ADMIN)]) {
      expect(decideAccess(subject, config({ accessMode: 'open' }), snapshot())).toEqual({ kind: 'allow', reason: 'open' })
      expect(decideAccess(subject, config({ accessMode: 'open', adminUserId: undefined }), snapshot()))
        .toEqual({ kind: 'allow', reason: 'open' })
    }
  })
})

describe('decideAccess：guarded 且未配置管理员', () => {
  it('任何聊天类型都拒绝（fail closed），即便用户在表里', () => {
    for (const adminUserId of [undefined, '   ']) {
      for (const subject of [p2p('u_alice'), p2p(ADMIN), group('u_alice'), group(ADMIN)]) {
        expect(decideAccess(subject, config({ adminUserId }), snapshot(['u_alice'])))
          .toEqual({ kind: 'deny', reason: 'admin-missing' })
      }
    }
  })
})

describe('decideAccess：私聊与群聊同一规则', () => {
  it('管理员在私聊和任何群都放行', () => {
    expect(decideAccess(p2p(ADMIN), config(), snapshot())).toEqual({ kind: 'allow', reason: 'admin' })
    expect(decideAccess(group(ADMIN), config(), snapshot())).toEqual({ kind: 'allow', reason: 'admin' })
  })

  it('打开对话准入的用户在私聊和任何群都放行', () => {
    expect(decideAccess(p2p('u_alice'), config(), snapshot(['u_alice']))).toEqual({ kind: 'allow', reason: 'authorized-user' })
    expect(decideAccess(group('u_alice'), config(), snapshot(['u_alice']))).toEqual({ kind: 'allow', reason: 'authorized-user' })
  })

  it('其他人在私聊和群里都拒绝', () => {
    expect(decideAccess(p2p('u_stranger'), config(), snapshot(['u_alice']))).toEqual({ kind: 'deny', reason: 'user-not-authorized' })
    expect(decideAccess(group('u_stranger'), config(), snapshot(['u_alice']))).toEqual({ kind: 'deny', reason: 'user-not-authorized' })
  })

  it('裁剪管理员与发送者两侧空白；user_id 区分大小写', () => {
    expect(decideAccess(p2p('  u_admin '), config({ adminUserId: ' u_admin ' }), snapshot())).toEqual({ kind: 'allow', reason: 'admin' })
    expect(decideAccess(group('U_ALICE'), config(), snapshot(['u_alice']))).toEqual({ kind: 'deny', reason: 'user-not-authorized' })
  })
})
