/**
 * `/auth user` target resolution: pasted user_id, @-mention, the bot's own
 * mention, multiple mentions, and mentioned users without a user_id.
 */

import { describe, expect, it } from 'vitest'
import { AUTH_USER_TARGET_ERRORS, resolveAuthUserTarget } from '../src/access/targets.ts'

const BOT = { key: '@_user_1', openId: 'ou_bot', name: 'DSH', isBot: true }
const ALICE = { key: '@_user_2', openId: 'ou_alice', userId: 'u_alice', name: 'Alice' }

describe('resolveAuthUserTarget', () => {
  it('纯 user_id 仍然可用，非法或缺失时给出用法', () => {
    expect(resolveAuthUserTarget(' u_bob ', [])).toEqual({ ok: true, userId: 'u_bob' })
    expect(resolveAuthUserTarget('ou_pasted_open_id', [])).toEqual({ ok: false, reason: 'usage' })
    expect(resolveAuthUserTarget('', [])).toEqual({ ok: false, reason: 'usage' })
  })

  it('@ 成员取 mention 里的 user_id 与姓名，忽略机器人自己的 @', () => {
    expect(resolveAuthUserTarget('@Alice', [BOT, ALICE])).toEqual({ ok: true, userId: 'u_alice', name: 'Alice' })
    // isBot 未标出时按 botOpenId 排除。
    expect(resolveAuthUserTarget('@Alice', [{ ...BOT, isBot: false }, ALICE], 'ou_bot'))
      .toEqual({ ok: true, userId: 'u_alice', name: 'Alice' })
    expect(resolveAuthUserTarget('@Alice', [{ ...ALICE, name: '' }])).toEqual({ ok: true, userId: 'u_alice' })
  })

  it('没有、多个或缺 user_id 的 @ 被拒绝', () => {
    expect(resolveAuthUserTarget('@所有人', [BOT])).toEqual({ ok: false, reason: 'mention-missing' })
    expect(resolveAuthUserTarget('@Alice @Bob', [ALICE, { key: '@_user_3', userId: 'u_bob', name: 'Bob' }]))
      .toEqual({ ok: false, reason: 'mention-multiple' })
    expect(resolveAuthUserTarget('@Guest', [{ key: '@_user_4', openId: 'ou_guest', name: 'Guest' }]))
      .toEqual({ ok: false, reason: 'mention-no-user-id' })
    expect(resolveAuthUserTarget('@Guest', [{ key: '@_user_4', userId: '', name: 'Guest' }]))
      .toEqual({ ok: false, reason: 'mention-no-user-id' })
    expect(AUTH_USER_TARGET_ERRORS['mention-no-user-id']).toContain('外部用户')
  })
})
