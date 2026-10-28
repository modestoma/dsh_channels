/**
 * Browser-half origin lookup shared by the session header entry and the
 * right-sidebar tab: one request per Session, failures retried, explicit
 * refresh re-asks the Host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSessionOrigin } from '../src/client/origin-cache.ts'
import type { SessionOriginWire } from '../src/settings/contract.ts'

const origin: SessionOriginWire = {
  sessionId: 's_1', chatType: 'p2p', kind: 'chat', chatId: 'oc_1', senderUserId: 'u_1',
  shared: false, createdAt: 1, bound: true, lastActivityAt: 2,
  chatLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
}

afterEach(() => { vi.unstubAllGlobals() })

describe('loadSessionOrigin', () => {
  it('asks the Host once per Session and again on refresh', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ origin }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(loadSessionOrigin('s_cache')).resolves.toEqual(origin)
    await expect(loadSessionOrigin('s_cache')).resolves.toEqual(origin)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('api/dsh-channels.sessionOrigin?sessionId=s_cache')
    await loadSessionOrigin('s_cache', true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('re-asks after a non-Feishu answer expires, since a new Session is listed before its route exists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ origin: null }), { status: 200 }))
        .mockResolvedValue(new Response(JSON.stringify({ origin }), { status: 200 }))
      vi.stubGlobal('fetch', fetch)
      await expect(loadSessionOrigin('s_early')).resolves.toBeNull()
      await expect(loadSessionOrigin('s_early')).resolves.toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 15_000)
      await expect(loadSessionOrigin('s_early')).resolves.toEqual(origin)
      vi.setSystemTime(Date.now() + 60_000)
      await expect(loadSessionOrigin('s_early')).resolves.toEqual(origin)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries after a failure', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: '未登录' }), { status: 401 }))
      .mockResolvedValue(new Response(JSON.stringify({ origin: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(loadSessionOrigin('s_retry')).rejects.toThrow('未登录')
    await expect(loadSessionOrigin('s_retry')).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
