/**
 * AccessStore tests: hydration from the durable tables, the permission
 * switches, write-through cache, request bookkeeping (pending/denied/expiry),
 * and graceful degradation.
 */

import { describe, expect, it, vi } from 'vitest'
import { AccessStore } from '../src/access/store.ts'
import type { AccessStoreDeps } from '../src/access/store.ts'
import type { FeishuDomainHandle } from '../src/domain.ts'
import { makeAccessDomain, requestRecord, userRecord } from './access-fixtures.ts'

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
  table: 'access_users' | 'access_requests',
): Array<[string, unknown]> {
  const handle = domain.raw.table(table)
  return [...handle.entries()]
}

describe('AccessStore.load', () => {
  it('从 durable 表读入用户与申请；只有打开对话准入的用户进入准入快照', () => {
    const { store, domain } = makeStore()
    const alice = userRecord({ userId: 'u_a', addedAt: 10 })
    const suspended = userRecord({ userId: 'u_s', addedAt: 20, chat: false, codeWrite: true })
    const request = requestRecord({ token: 'tok-a', targetId: 'u_b' })
    void domain.handle.accessUsers.put(alice.userId, alice)
    void domain.handle.accessUsers.put(suspended.userId, suspended)
    void domain.handle.accessRequests.put(request.token, request)

    store.load()

    expect(store.hasUser('u_a')).toBe(true)
    expect(store.hasUser('u_s')).toBe(true)
    expect(store.getUser('u_a')).toEqual(alice)
    expect(store.getRequest('tok-a')).toEqual(request)
    expect(store.snapshot()).toEqual({ users: new Set(['u_a']) })
  })

  it('跳过旧版本写下的群申请记录', () => {
    const { store, domain } = makeStore()
    void domain.handle.accessRequests.put('tok-g', requestRecord({ token: 'tok-g', kind: 'group', targetId: 'oc_a' }))
    store.load()
    expect(store.getRequest('tok-g')).toBeUndefined()
    expect(store.pendingRequests(0)).toEqual([])
  })

  it('用户按 addedAt 从旧到新排序', () => {
    const { store, domain } = makeStore()
    void domain.handle.accessUsers.put('u_new', userRecord({ userId: 'u_new', addedAt: 300 }))
    void domain.handle.accessUsers.put('u_old', userRecord({ userId: 'u_old', addedAt: 100 }))
    store.load()
    expect(store.userRecords().map(record => record.userId)).toEqual(['u_old', 'u_new'])
  })

  it('domain 缺失时降级为空用户表并 warn（不抛）', () => {
    const { store, warn } = makeStore({ open: false })
    expect(() => store.load()).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access tables unavailable'))
    expect(store.snapshot().users.size).toBe(0)
    expect(store.pendingRequests(0)).toEqual([])
  })

  it('重复 load 会先清空内存（shutdown 后重开域不会残留旧授权）', () => {
    const { store, domain, state } = makeStore()
    void domain.handle.accessUsers.put('u_a', userRecord({ userId: 'u_a' }))
    store.load()
    expect(store.hasUser('u_a')).toBe(true)
    state.handle = undefined
    store.load()
    expect(store.hasUser('u_a')).toBe(false)
  })
})

describe('AccessStore 用户表写穿', () => {
  it('putUser 同时写 domain 表并刷新内存快照', async () => {
    const { store, domain } = makeStore()
    store.load()
    const record = userRecord({ userId: 'u_bob', name: 'Bob' })
    await store.putUser(record)
    expect(durableEntries(domain, 'access_users')).toEqual([['u_bob', record]])
    expect(store.snapshot().users.has('u_bob')).toBe(true)
  })

  it('setPermission 只改一个开关；关掉 chat 立即退出准入快照', async () => {
    const { store, domain } = makeStore()
    store.load()
    await store.putUser(userRecord({ userId: 'u_bob' }))

    const updated = await store.setPermission('u_bob', 'wikiRead', true)
    expect(updated).toMatchObject({ chat: true, wikiRead: true, wikiWrite: false, codeWrite: false })
    await store.setPermission('u_bob', 'chat', false)
    expect(store.snapshot().users.has('u_bob')).toBe(false)
    expect(new Map(durableEntries(domain, 'access_users')).get('u_bob')).toMatchObject({ chat: false, wikiRead: true })
    await expect(store.setPermission('u_missing', 'chat', true)).resolves.toBeUndefined()
  })

  it('setGitEmail 设置、清除 Git 邮箱，不影响开关；用户不在表中返回 undefined', async () => {
    const { store, domain } = makeStore()
    store.load()
    await store.putUser(userRecord({ userId: 'u_bob', codeWrite: true }))

    expect(await store.setGitEmail('u_bob', 'bob@example.com')).toMatchObject({ gitEmail: 'bob@example.com', codeWrite: true })
    expect(new Map(durableEntries(domain, 'access_users')).get('u_bob')).toMatchObject({ gitEmail: 'bob@example.com' })
    const cleared = await store.setGitEmail('u_bob', undefined)
    expect(cleared).not.toHaveProperty('gitEmail')
    expect(new Map(durableEntries(domain, 'access_users')).get('u_bob')).not.toHaveProperty('gitEmail')
    await expect(store.setGitEmail('u_missing', 'x@example.com')).resolves.toBeUndefined()
  })

  it('allows：chat 关闭时其他开关都视为关闭', async () => {
    const { store } = makeStore()
    store.load()
    await store.putUser(userRecord({ userId: 'u_bob', codeWrite: true, wikiRead: true }))
    expect(store.allows('u_bob', 'codeWrite')).toBe(true)
    expect(store.allows('u_bob', 'wikiWrite')).toBe(false)
    await store.setPermission('u_bob', 'chat', false)
    expect(store.allows('u_bob', 'codeWrite')).toBe(false)
    expect(store.allows('u_bob', 'chat')).toBe(false)
    expect(store.allows('u_missing', 'chat')).toBe(false)
  })

  it('同一用户的并发开关修改依次生效，后写不会还原先写', async () => {
    const { store } = makeStore()
    store.load()
    await store.putUser(userRecord({ userId: 'u_bob', codeWrite: true }))
    await Promise.all([
      store.setPermission('u_bob', 'codeWrite', false),
      store.setPermission('u_bob', 'wikiRead', true),
      store.grantChat(userRecord({ userId: 'u_bob' })),
    ])
    expect(store.getUser('u_bob')).toMatchObject({ chat: true, codeWrite: false, wikiRead: true })
  })

  it('grantChat 新增只开 chat 的用户，或只为已有用户打开 chat', async () => {
    const { store } = makeStore()
    store.load()
    await store.grantChat(userRecord({ userId: 'u_new', name: 'New' }))
    expect(store.allows('u_new', 'chat')).toBe(true)
    await store.putUser(userRecord({ userId: 'u_paused', chat: false, wikiWrite: true, name: 'Kept' }))
    const updated = await store.grantChat(userRecord({ userId: 'u_paused', name: 'Ignored' }))
    expect(updated).toMatchObject({ chat: true, wikiWrite: true, name: 'Kept' })
    await expect(store.grantChat(userRecord({ userId: 'u_paused' }))).resolves.toBe(updated)
  })

  it('一次写入失败只报给它的调用方，后续写入照常进行', async () => {
    const { store, state, domain } = makeStore()
    store.load()
    state.handle = undefined
    await expect(store.putUser(userRecord({ userId: 'u_a' }))).rejects.toThrow(/access domain not open/)
    state.handle = domain.handle
    await expect(store.putUser(userRecord({ userId: 'u_b' }))).resolves.toMatchObject({ userId: 'u_b' })
  })

  it('removeUser 持久删除并即时退出快照；不存在时返回 false', async () => {
    const { store, domain } = makeStore()
    store.load()
    await store.putUser(userRecord({ userId: 'u_a' }))
    await expect(store.removeUser('u_a')).resolves.toBe(true)
    expect(durableEntries(domain, 'access_users')).toEqual([])
    expect(store.snapshot()).toEqual({ users: new Set() })
    await expect(store.removeUser('u_missing')).resolves.toBe(false)
  })

  it('domain 缺失时写操作报错而不是静默成功', async () => {
    const { store } = makeStore({ open: false })
    await expect(store.putUser(userRecord())).rejects.toThrow(/access domain not open/)
    await expect(store.putRequest(requestRecord())).rejects.toThrow(/access domain not open/)
  })

  it('clear 只清内存，durable 数据在 load 后恢复', async () => {
    const { store, domain } = makeStore()
    store.load()
    await store.putUser(userRecord({ userId: 'u_a' }))
    store.clear()
    expect(store.hasUser('u_a')).toBe(false)
    expect(durableEntries(domain, 'access_users')).toHaveLength(1)
    store.load()
    expect(store.hasUser('u_a')).toBe(true)
  })
})

describe('AccessStore 申请查询', () => {
  const now = 10 * DAY_MS

  it('pendingRequestFor 只命中 pending 状态的同用户申请', async () => {
    const { store } = makeStore()
    const pending = requestRecord({
      token: 'tok-pending', targetId: 'u_a', createdAt: now, expiresAt: now + DAY_MS,
    })
    const denied = requestRecord({
      token: 'tok-denied', targetId: 'u_b', status: 'denied', createdAt: now,
    })
    await store.putRequest(pending)
    await store.putRequest(denied)

    expect(store.pendingRequestFor('u_a')?.token).toBe('tok-pending')
    // 已结算的同目标申请不再算“待处理”。
    expect(store.pendingRequestFor('u_b')).toBeUndefined()
    expect(store.pendingRequests(now).map(record => record.token)).toEqual(['tok-pending'])
  })

  it('pendingRequests 按 createdAt 从旧到新排序并排除已过期申请', async () => {
    const { store } = makeStore()
    await store.putRequest(requestRecord({
      token: 'tok-old', targetId: 'u_old', createdAt: 1, expiresAt: now + DAY_MS,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-new', targetId: 'u_new', createdAt: 2, expiresAt: now + DAY_MS,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-expired', targetId: 'u_expired', createdAt: 3, expiresAt: now - 1,
    }))

    expect(store.pendingRequests(now).map(record => record.token)).toEqual(['tok-old', 'tok-new'])
    expect(store.requestRecords().map(record => record.token))
      .toEqual(['tok-old', 'tok-new', 'tok-expired'])
  })

  it('recentlyDenied 只在时间窗内、且目标状态为 denied 时命中', async () => {
    const { store } = makeStore()
    await store.putRequest(requestRecord({
      token: 'tok-denied', targetId: 'u_a', status: 'denied', createdAt: now - 1_000,
    }))
    await store.putRequest(requestRecord({
      token: 'tok-approved', targetId: 'u_b', status: 'approved', createdAt: now - 1_000,
    }))

    expect(store.recentlyDenied('u_a', DAY_MS, now)).toBe(true)
    expect(store.recentlyDenied('u_a', 500, now)).toBe(false)
    expect(store.recentlyDenied('u_other', DAY_MS, now)).toBe(false)
    expect(store.recentlyDenied('u_b', DAY_MS, now)).toBe(false)
  })
})

describe('AccessStore.expireRequests', () => {
  const now = 10 * DAY_MS

  it('把到期 pending 申请标记为 expired 并持久化', async () => {
    const { store, domain } = makeStore()
    const expired = requestRecord({
      token: 'tok-expired', targetId: 'u_a', createdAt: 0, expiresAt: now - 1,
    })
    const live = requestRecord({
      token: 'tok-live', targetId: 'u_b', createdAt: 0, expiresAt: now + 1,
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
