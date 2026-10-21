/**
 * Pure admission policy matrix: open/guarded, administrator bootstrap, private
 * chats, authorized/unauthorized groups, user whitelist, and normalization.
 */

import { describe, expect, it } from 'vitest'
import { decideAccess, isAdminUserId } from '../src/access/policy.ts'
import type { AccessPolicyConfig, AccessSnapshot } from '../src/access/policy.ts'

const ADMIN = 'u_admin'

/** One whitelist snapshot built from plain lists. */
function snapshot(groups: string[] = [], users: string[] = []): AccessSnapshot {
  return { groups: new Set(groups), users: new Set(users) }
}

function config(partial: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return { accessMode: 'guarded', adminUserId: ADMIN, ...partial }
}

function p2p(senderId: string, chatId = 'oc_p2p'): Parameters<typeof decideAccess>[0] {
  return { chatType: 'p2p', chatId, senderId }
}

function group(senderId: string, chatId = 'oc_group'): Parameters<typeof decideAccess>[0] {
  return { chatType: 'group', chatId, senderId }
}

describe('isAdminUserId', () => {
  it('只认与配置完全一致的 open_id', () => {
    expect(isAdminUserId({ adminUserId: ADMIN }, ADMIN)).toBe(true)
    expect(isAdminUserId({ adminUserId: ADMIN }, 'u_other')).toBe(false)
    expect(isAdminUserId({ adminUserId: ADMIN }, undefined)).toBe(false)
  })

  it('未配置或空字符串时任何发送者都不是管理员', () => {
    expect(isAdminUserId({}, ADMIN)).toBe(false)
    expect(isAdminUserId({ adminUserId: '' }, '')).toBe(false)
    expect(isAdminUserId({ adminUserId: '   ' }, '   ')).toBe(false)
  })

  it('裁剪配置与输入两侧的空白后再比较', () => {
    expect(isAdminUserId({ adminUserId: '  u_admin  ' }, 'u_admin')).toBe(true)
    expect(isAdminUserId({ adminUserId: ADMIN }, '  u_admin ')).toBe(true)
  })

  it('open_id 区分大小写（不折叠大小写）', () => {
    expect(isAdminUserId({ adminUserId: ADMIN }, 'OU_ADMIN')).toBe(false)
    expect(isAdminUserId({ adminUserId: 'OU_ADMIN' }, ADMIN)).toBe(false)
  })
})

describe('decideAccess：open 模式', () => {
  it('放行任何私聊/群聊发送者并标记为 open', () => {
    for (const subject of [p2p('u_anyone'), group('u_anyone'), group(ADMIN)]) {
      expect(decideAccess(subject, config({ accessMode: 'open' }), snapshot())).toEqual({
        kind: 'allow', reason: 'open',
      })
    }
  })

  it('即便没有配置管理员也放行（兼容旧行为）', () => {
    expect(decideAccess(p2p('u_anyone'), config({ accessMode: 'open', adminUserId: undefined }), snapshot()))
      .toEqual({ kind: 'allow', reason: 'open' })
  })
})

describe('decideAccess：guarded 且未配置管理员', () => {
  it('任何聊天类型都拒绝（fail closed）并报告 admin-missing', () => {
    const missing = config({ adminUserId: undefined })
    const blank = config({ adminUserId: '   ' })
    for (const subject of [p2p('u_anyone'), p2p(ADMIN), group('u_anyone'), group(ADMIN)]) {
      expect(decideAccess(subject, missing, snapshot())).toEqual({ kind: 'deny', reason: 'admin-missing' })
      expect(decideAccess(subject, blank, snapshot())).toEqual({ kind: 'deny', reason: 'admin-missing' })
    }
  })
})

describe('decideAccess：私聊', () => {
  it('管理员放行', () => {
    expect(decideAccess(p2p(ADMIN), config(), snapshot())).toEqual({ kind: 'allow', reason: 'admin' })
  })

  it('非管理员一律拒绝，即便在用户白名单里（白名单只在群聊生效）', () => {
    for (const sender of ['u_alice', 'u_stranger']) {
      expect(decideAccess(p2p(sender), config(), snapshot([], [sender]))).toEqual({
        kind: 'deny', reason: 'dm-non-admin',
      })
    }
  })

  it('私聊拒绝不携带任何授权申请类型（私聊不推卡）', () => {
    const decision = decideAccess(p2p('u_alice'), config(), snapshot())
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' ? decision.request : undefined).toBeUndefined()
  })
})

describe('decideAccess：群聊', () => {
  it('未授权群：管理员不受白名单限制，直接放行', () => {
    expect(decideAccess(group(ADMIN), config(), snapshot())).toEqual({ kind: 'allow', reason: 'admin' })
    expect(decideAccess(group(ADMIN), config(), snapshot([], ['u_alice']))).toEqual({
      kind: 'allow', reason: 'admin',
    })
  })

  it('未授权群：非管理员拒绝，并标记需要群授权申请', () => {
    for (const sender of ['u_alice', 'u_stranger']) {
      expect(decideAccess(group(sender), config(), snapshot([], [sender]))).toEqual({
        kind: 'deny', reason: 'group-not-authorized', request: 'group',
      })
    }
  })

  it('已授权群：管理员放行', () => {
    expect(decideAccess(group(ADMIN), config(), snapshot(['oc_group']))).toEqual({
      kind: 'allow', reason: 'admin',
    })
  })

  it('已授权群：用户白名单放行，标记 authorized-user', () => {
    expect(decideAccess(group('u_alice'), config(), snapshot(['oc_group'], ['u_alice']))).toEqual({
      kind: 'allow', reason: 'authorized-user',
    })
  })

  it('已授权群：不在白名单的其他人拒绝，并标记需要用户授权申请', () => {
    expect(decideAccess(group('u_stranger'), config(), snapshot(['oc_group'], ['u_alice']))).toEqual({
      kind: 'deny', reason: 'user-not-authorized', request: 'user',
    })
  })

  it('群授权先于用户授权：未授权群里的白名单用户仍被拒', () => {
    expect(decideAccess(group('u_alice'), config(), snapshot([], ['u_alice']))).toEqual({
      kind: 'deny', reason: 'group-not-authorized', request: 'group',
    })
  })

  it('别的群已授权不影响本群', () => {
    expect(decideAccess(group('u_alice'), config(), snapshot(['oc_other'], ['u_alice']))).toEqual({
      kind: 'deny', reason: 'group-not-authorized', request: 'group',
    })
  })
})

describe('decideAccess：空白与大小写', () => {
  it('裁剪发送者与管理员配置两侧的空白', () => {
    expect(decideAccess(p2p('  u_admin '), config({ adminUserId: ' u_admin ' }), snapshot()))
      .toEqual({ kind: 'allow', reason: 'admin' })
  })

  it('已配置管理员但配置带空白时也不会误判为未配置', () => {
    expect(decideAccess(p2p('u_alice'), config({ adminUserId: '  u_admin  ' }), snapshot()))
      .toEqual({ kind: 'deny', reason: 'dm-non-admin' })
  })

  it('chat_id 与 open_id 都是大小写敏感的精确匹配', () => {
    expect(decideAccess(group('u_alice'), config(), snapshot(['OC_GROUP']))).toEqual({
      kind: 'deny', reason: 'group-not-authorized', request: 'group',
    })
    expect(decideAccess(group('OU_ALICE'), config(), snapshot(['oc_group'], ['u_alice']))).toEqual({
      kind: 'deny', reason: 'user-not-authorized', request: 'user',
    })
  })
})
