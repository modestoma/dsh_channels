/**
 * AccessStore tests: hydration from the durable tables, write-through cache,
 * request bookkeeping (pending/denied/expiry), and graceful degradation.
 */

import { describe, expect, it, vi } from 'vitest'
import { AccessStore } from '../src/access/store.ts'
import type { AccessStoreDeps } from '../src/access/store.ts'
import type { FeishuDomainHandle } from '../src/domain.ts'
import { groupRecord, makeAccessDomain, requestRecord, userRecord } from './access-fixtures.ts'

const DAY_MS = 86_400_000

/** One store over a fake domain whose openness can be toggled. */
function makeStore(options: { open?: boolean } = {}) {
  const domain = makeAccessDomain()
  const state: { handle: FeishuDomainHandle | undefined } = {
    handle: options.open === false ? undefined : domain.handle,
  }
  const warn = vi.fn()
  const store = new AccessStore({
    domain: () => state.handle,
    warn,
  } as AccessStoreDeps)
  return { store, warn, domain, state }
}

/** Read one raw access table back from the fake durable storage. */
function durableEntries(
  domain: ReturnType<typeof makeAccessDomain>,
  table: 'access_groups' | 'access_users' | 'access_requests',
): Array<[string, unknown]> {
  const handle = domain.raw.table(table)
  return [...handle.entries()]
}

describe('AccessStore.load', () => {
  it('从 durable 表读入群、用户与申请', () => {
    const { store, domain } = makeStore()
    const group = groupRecord({ chatId: 'oc_a', addedAt: 20 })
    const user = userRecord({ openId: 'ou_a', addedAt: 10 })
    const request = requestRecord({ token: 'tok-a', kind: 'user', targetId: 'ou_b' })
    void domain.handle.accessGroups.put(group.chatId, group)
    void domain.handle.accessUsers.put(user.openId, user)
    void domain.handle.accessRequests.put(request.token, request)

    store.load()

    expect(store.hasGroup('oc_a')).toBe(true)
    expect(store.hasUser('ou_a')).toBe(true)
    expect(store.getGroup('oc_a')).toEqual(group)
    expect(store.getUser('ou_a')).toEqual(user)
    expect(store.getRequest('tok-a')).toEqual(request)
    expect(store.snapshot()).toEqual({
      groups: new Set(['oc_a']),
      users: new Set(['ou_a']),
    })
  })

  it('群/用户记录按 addedAt 从旧到新排序', () => {
    const { store, domain } = makeStore()
    void domain.handle.accessGroups.put('oc_new', groupRecord({ chatId: 'oc_new', addedAt: 300 }))
    void domain.handle.accessGroups.put('oc_old', groupRecord({ chatId: 'oc_old', addedAt: 100 }))
    void domain.handle.accessUsers.put('ou_new', userRecord({ openId: 'ou_new', addedAt: 300 }))
    void domain.handle.accessUsers.put('ou_old', userRecord({ openId: 'ou_old', addedAt: 100 }))
    store.load()

    expect(store.groupRecords().map(record => record.chatId)).toEqual(['oc_old', 'oc_new'])
    expect(store.userRecords().map(record => record.openId)).toEqual(['ou_old', 'ou_new'])
  })

  it('domain 缺失时降级为空白名单并 warn（不抛）', () => {
    const { store, warn } = makeStore({ open: false })
    expect(() => store.load()).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access tables unavailable'))
    expect(store.snapshot().groups.size).toBe(0)
    expect(store.snapshot().users.size).toBe(0)
    expect(store.pendingRequests(0)).toEqual([])
  })

  it('重复 load 会先清空内存（shutdown 后重开域不会残留旧授权）', () => {
    const { store, domain, state } = makeStore()
    void domain.handle.accessGroups.put('oc_a', groupRecord({ chatId: 'oc_a' }))
    store.load()
    expect(store.hasGroup('oc_a')).toBe(true)

    state.handle = undefined
    store.load()
    expect(store.hasGroup('oc_a')).toBe(false)
  })
})

describe('AccessStore 授权写穿', () => {
  it('addGroup 同时写 domain 表并刷新内存快照', async () => {
    const { store, domain } = makeStore()
    store.load()
    const record = groupRecord({ chatId: 'oc_a', name: '产品群' })

    await store.addGroup(record)

    expect(durableEntries(domain, 'access_groups')).toEqual([['oc_a', record]])
    expect(store.hasGroup('oc_a')).toBe(true)
    expect(store.snapshot().groups.has('oc_a')).toBe(true)
    expect(store.getGroup('oc_a')?.name).toBe('产品群')
  })

  it('addUser 同时写 domain 表并刷新内存快照', async () => {
    const { store, domain } = makeStore()
    store.load()
    const record = userRecord({ openId: 'ou_bob', name: 'Bob' })

    await store.addUser(record)

    expect(durableEntries(domain, 'access_users')).toEqual([['ou_bob', record]])
    expect(store.hasUser('ou_bob')).toBe(true)
    expect(store.snapshot().users.has('ou_bob')).toBe(true)
  })

  it('removeGroup/removeUser 持久删除并即时退出快照；不存在时返回 false', async () => {
    const { store, domain } = makeStore()
    store.load()
    await store.addGroup(groupRecord({ chatId: 'oc_a' }))
    await store.addUser(userRecord({ openId: 'ou_a' }))

    await expect(store.removeGroup('oc_a')).resolves.toBe(true)
    await expect(store.removeUser('ou_a')).resolves.toBe(true)
    expect(durableEntries(domain, 'access_groups')).toEqual([])
    expect(durableEntries(domain, 'access_users')).toEqual([])
    expect(store.snapshot()).toEqual({ groups: new Set(), users: new Set() })

    await expect(store.removeGroup('oc_missing')).resolves.toBe(false)
    await expect(store.removeUser('ou_missing')).resolves.toBe(false)
  })

  it('domain 缺失时写操作报错而不是静默成功', async () => {
    const { store } = makeStore({ open: false })
    await expect(store.addGroup(groupRecord())).rejects.toThrow(/access domain not open/)
    await expect(store.addUser(userRecord())).rejects.toThrow(/access domain not open/)
    await expect(store.putRequest(requestRecord())).rejects.toThrow(/access domain not open/)
  })

  it('clear 只清内存，durable 数据在 load 后恢复', async () => {
    const { store, domain } = makeStore()
    store.load()
    await store.addGroup(groupRecord({ chatId: 'oc_a' }))
    await store.addUser(userRecord({ openId: 'ou_a' }))

    store.clear()
    expect(store.hasGroup('oc_a')).toBe(false)
    expect(store.hasUser('ou_a')).toBe(false)
    expect(durableEntries(domain, 'access_groups')).toHaveLength(1)

    store.load()
    expect(store.hasGroup('oc_a')).toBe(true)
    expect(store.hasUser('ou_a')).toBe(true)
  })
})

describe('AccessStore 申请查询', () => {
  const now = 10 * DAY_MS

  it('pendingRequestFor 只命中 pending 状态的同类型同目标申请', async () => {
    const { store } = makeStore()
    const pending = requestRecord({
      token: 'tok-pending', kind: 'group', targetId: 'oc_a', createdAt: now, expiresAt: now + DAY_MS,
    })
    const denied = requestRecord({
      token: 'tok-denied', kind: 'group', targetId: 'oc_b', status: 'denied', createdAt: now,
    })
    await store.putRequest(pending)
    await store.putRequest(denied)

    expect(store.pendingRequestFor('group', 'oc_a')?.token).toBe('tok-pending')
    // 已结算的同目标申请不再算“待处理”。
    expect(store.pendingRequestFor('group', 'oc_b')).toBeUndefined()
    // 同 chat_id 但类型不同也不互相影响。
    expect(store.pendingRequestFor('user', 'oc_a')).toBeUndefined()
    expect(store.pendingRequests(now).map(record => record.token)).toEqual(['tok-pending'])
  })

  it('pendingRequests 按 createdAt 从旧到新排序并排除已过期申请', async () => {
    const { store } = makeStore()
    await store.putRequest(requestRecord({
      token: 'tok-old', kind: 'group', targetId: 'oc_old', createdAt: 1, expiresAt: now + DAY_MS,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-new', kind: 'user', targetId: 'ou_new', createdAt: 2, expiresAt: now + DAY_MS,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-expired', kind: 'group', targetId: 'oc_expired', createdAt: 3, expiresAt: now - 1,
    }))

    expect(store.pendingRequests(now).map(record => record.token)).toEqual(['tok-old', 'tok-new'])
    expect(store.requestRecords().map(record => record.token))
      .toEqual(['tok-old', 'tok-new', 'tok-expired'])
  })

  it('recentlyDenied 只在时间窗内、且目标状态为 denied 时命中', async () => {
    const { store } = makeStore()
    await store.putRequest(requestRecord({
      token: 'tok-denied', kind: 'group', targetId: 'oc_a', status: 'denied', createdAt: now - 1_000,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-approved', kind: 'user', targetId: 'ou_a', status: 'approved', createdAt: now - 1_000,
    }))

    expect(store.recentlyDenied('group', 'oc_a', DAY_MS, now)).toBe(true)
    expect(store.recentlyDenied('group', 'oc_a', 500, now)).toBe(false)
    expect(store.recentlyDenied('group', 'oc_other', DAY_MS, now)).toBe(false)
    expect(store.recentlyDenied('user', 'ou_a', DAY_MS, now)).toBe(false)
  })
})

describe('AccessStore.expireRequests', () => {
  const now = 10 * DAY_MS

  it('把到期 pending 申请标记为 expired 并持久化', async () => {
    const { store, domain } = makeStore()
    const expired = requestRecord({
      token: 'tok-expired', kind: 'group', targetId: 'oc_a', createdAt: 0, expiresAt: now - 1,
    })
    const live = requestRecord({
      token: 'tok-live', kind: 'group', targetId: 'oc_b', createdAt: 0, expiresAt: now + 1,
    })
    await store.putRequest(expired)
    await store.putRequest(live)

    const settled = await store.expireRequests(now)

    expect(settled.map(record => record.token)).toEqual(['tok-expired'])
    expect(settled[0]?.status).toBe('expired')
    expect(store.getRequest('tok-expired')?.status).toBe('expired')
    expect(store.getRequest('tok-live')?.status).toBe('pending')
    const durable = new Map(durableEntries(domain, 'access_requests') as Array<[string, { status: string }]>)
    expect(durable.get('tok-expired')?.status).toBe('expired')
    expect(durable.get('tok-live')?.status).toBe('pending')
    expect(store.pendingRequests(now).map(record => record.token)).toEqual(['tok-live'])
  })

  it('已结算的申请不会被过期扫描改写', async () => {
    const { store } = makeStore()
    await store.putRequest(requestRecord({
      token: 'tok-approved', status: 'approved', expiresAt: now - 1,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-denied', status: 'denied', expiresAt: now - 1,
    }))

    await expect(store.expireRequests(now)).resolves.toEqual([])
    expect(store.getRequest('tok-approved')?.status).toBe('approved')
    expect(store.getRequest('tok-denied')?.status).toBe('denied')
  })

  it('第二次扫描不重复返回同一申请', async () => {
    const { store } = makeStore()
    await store.putRequest(requestRecord({ token: 'tok-expired', createdAt: 0, expiresAt: now - 1 }))
    await expect(store.expireRequests(now)).resolves.toHaveLength(1)
    await expect(store.expireRequests(now)).resolves.toEqual([])
  })
})
