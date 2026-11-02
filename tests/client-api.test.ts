/**
 * Browser-half settings client: Host routes are addressed relative to the DSH
 * document so a prefix-mounted reverse proxy (`https://host/dsh/`) still
 * reaches them under the mount.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCatalog,
  fetchFeishuProfiles,
  fetchPanel,
  fetchSessionRecords,
  fetchWorkspaceFileBlob,
  fetchWorkspaceFilePreview,
  fetchWorkspaceFiles,
  removeAccessUser,
} from '../src/client/api.ts'
import { PROFILES_MAX_IDS } from '../src/settings/contract.ts'

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('settings client routes', () => {
  it('fetches Host routes relative to the document base', async () => {
    const fetcher = stubFetch()
    await fetchPanel()
    await fetchCatalog('deepseek', 'chat')
    await removeAccessUser('u1')
    await fetchFeishuProfiles(['u1', 'u2'], ['oc_1'])
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'api/dsh-channels.panel',
      'api/dsh-channels.catalog?provider=deepseek&model=chat',
      'api/dsh-channels.removeAccessUser',
      'api/dsh-channels.profiles?users=u1%2Cu2&chats=oc_1',
    ])
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ userId: 'u1' }) })
    for (const target of fetcher.mock.calls.map(call => String(call[0]))) {
      expect(new URL(target, 'https://example.com/dsh/').pathname.startsWith('/dsh/api/dsh-channels.')).toBe(true)
    }
  })
})

describe('fetchFeishuProfiles', () => {
  it('splits id lists over the route limit into several requests and merges the answers', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, 'https://example.com/').searchParams
      const users = (params.get('users') ?? '').split(',').filter(id => id !== '')
      return new Response(JSON.stringify({
        users: Object.fromEntries(users.map(id => [id, { name: id }])),
        chats: {},
        warning: 'code=1 denied',
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const ids = Array.from({ length: PROFILES_MAX_IDS + 1 }, (_, index) => `u_${index}`)
    const result = await fetchFeishuProfiles(ids, ['oc_1'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(`api/dsh-channels.profiles?users=u_${PROFILES_MAX_IDS}&chats=`)
    expect(Object.keys(result.users)).toHaveLength(PROFILES_MAX_IDS + 1)
    expect(result.warning).toBe('code=1 denied')
  })
})

describe('session records and workspace files', () => {
  it('addresses the records and file routes with the workspace root and relative path', async () => {
    const fetcher = stubFetch()
    await fetchSessionRecords()
    await fetchWorkspaceFiles('/ws/p2p/u_1', 'topics')
    await fetchWorkspaceFilePreview('/ws/p2p/u_1', 'topics/a b.md')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'api/dsh-channels.sessionRecords',
      'api/dsh-channels.workspaceFiles?workspace=%2Fws%2Fp2p%2Fu_1&path=topics',
      'api/dsh-channels.workspaceFilePreview?workspace=%2Fws%2Fp2p%2Fu_1&path=topics%2Fa+b.md',
    ])
  })

  it('returns downloaded bytes as a blob and surfaces the Host refusal message', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('csv,data', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const blob = await fetchWorkspaceFileBlob('/ws', 'a.csv')
    expect(await blob.text()).toBe('csv,data')
    expect(fetcher.mock.calls[0]?.[0]).toBe('api/dsh-channels.workspaceFileDownload?workspace=%2Fws&path=a.csv')
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: '目标位于工作区之外' }), { status: 403 }))
    await expect(fetchWorkspaceFileBlob('/ws', 'escape')).rejects.toThrow('目标位于工作区之外')
  })
})
