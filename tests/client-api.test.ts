/**
 * Browser-half settings client: Host routes are addressed relative to the DSH
 * document so a prefix-mounted reverse proxy (`https://host/dsh/`) still
 * reaches them under the mount.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCatalog, fetchPanel, removeAccessUser } from '../src/client/api.ts'

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
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'dsh-channels/panel',
      'dsh-channels/catalog?provider=deepseek&model=chat',
      'dsh-channels/access/users',
    ])
    for (const target of fetcher.mock.calls.map(call => String(call[0]))) {
      expect(new URL(target, 'https://example.com/dsh/').pathname.startsWith('/dsh/dsh-channels/')).toBe(true)
    }
  })
})
