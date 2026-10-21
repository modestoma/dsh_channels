/** Official Lark high-level adapter contract: connection diagnostics and files. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  const channel = {
    on: vi.fn(() => () => {}),
    botIdentity: { openId: 'ou_bot' },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnectionStatus: vi.fn((): unknown => undefined),
    send: vi.fn(async () => ({ messageId: 'om_file' })),
    updateCard: vi.fn(async () => {}),
    addReaction: vi.fn(async () => 'reaction-1'),
    removeReaction: vi.fn(async () => {}),
    rawClient: {
      application: {
        v6: {
          application: { get: vi.fn(async (): Promise<unknown> => ({ code: 0, data: {} })) },
          scope: { list: vi.fn(async (): Promise<unknown> => ({ code: 0, data: {} })) },
        },
      },
      request: vi.fn(async (): Promise<unknown> => ({ data: { items: [] } })),
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
            list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
          },
          messageResource: { get: vi.fn() },
        },
      },
    },
  }
  return { channel, createLarkChannel: vi.fn(() => channel) }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: sdk.createLarkChannel,
  LoggerLevel: { debug: 0, info: 1, warn: 2, error: 3 },
}))

import { Readable } from 'node:stream'
import {
  AppOwnerLookupError, contentRangeTotal, FeishuApiError, defaultChannelFactory, downloadResourceInRanges, RANGE_DOWNLOAD_CHUNK_BYTES,
} from '../src/feishu-channel.ts'
import type { FeishuConnectionStatus, ResourceChunkStream } from '../src/feishu-channel.ts'

/** Fake SDK resource response: one byte stream plus optional headers. */
function resourceResponse(chunks: string[], headers?: Record<string, string>) {
  return {
    getReadableStream: () => Readable.from(chunks.map(chunk => Buffer.from(chunk))),
    headers: headers ?? {},
  }
}

async function collect(stream: ResourceChunkStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const options = {
  appId: 'cli_test',
  appSecret: 'secret',
  loggerLevel: 'info' as const,
  requireMention: true,
  dmMode: 'open' as const,
}

describe('LarkChannelAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('grantedScopes', () => {
    const list = () => sdk.channel.rawClient.application.v6.scope.list

    it('maps grant_status 1 to granted and keeps the scope type', async () => {
      list().mockResolvedValueOnce({ code: 0, data: { scopes: [
        { scope_name: 'im:message', grant_status: 1, scope_type: 'tenant' },
        { scope_name: 'im:chat:readonly', grant_status: 2 },
      ] } })
      await expect(defaultChannelFactory(options).grantedScopes?.()).resolves.toEqual([
        { name: 'im:message', granted: true, type: 'tenant' },
        { name: 'im:chat:readonly', granted: false },
      ])
      list().mockResolvedValueOnce({ code: 0 })
      await expect(defaultChannelFactory(options).grantedScopes?.()).resolves.toEqual([])
    })

    it('rejects a non-zero code and maps thrown errors', async () => {
      list().mockResolvedValueOnce({ code: 99991672, msg: 'denied' })
      const error = await defaultChannelFactory(options).grantedScopes?.().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FeishuApiError)
      expect(error).toMatchObject({ code: 99991672, detail: 'code=99991672 denied' })
      list().mockResolvedValueOnce({ code: 5 })
      await expect(defaultChannelFactory(options).grantedScopes?.()).rejects.toMatchObject({ detail: 'code=5' })
      list().mockRejectedValueOnce(Object.assign(new Error('400'), { response: { data: { msg: 'bad' } } }))
      await expect(defaultChannelFactory(options).grantedScopes?.()).rejects.toMatchObject({ detail: 'bad' })
      list().mockRejectedValueOnce('down')
      await expect(defaultChannelFactory(options).grantedScopes?.()).rejects.toMatchObject({ detail: 'down' })
    })
  })

  describe('slashCommands', () => {
    const request = () => sdk.channel.rawClient.request
    const base = '/open-apis/application/v7/app_slash_commands'

    it('lists commands and skips rows without an id or name', async () => {
      request().mockResolvedValueOnce({ code: 0, data: { items: [
        { command_id: 'c1', command: 'help', description: { default_value: 'h' } },
        { command: 'orphan' },
        { command_id: 'c2', command: 'stop' },
      ] } })
      await expect(defaultChannelFactory(options).slashCommands?.list()).resolves.toEqual([
        { id: 'c1', command: 'help', description: 'h' },
        { id: 'c2', command: 'stop', description: '' },
      ])
      expect(request()).toHaveBeenLastCalledWith({ method: 'GET', url: base })
    })

    it('creates, patches, and deletes by encoded id', async () => {
      const api = defaultChannelFactory(options).slashCommands
      const description = { default_value: '帮助', i18n: { zh_cn: '帮助' } }
      await api?.create({ command: 'help', description: '帮助' })
      expect(request()).toHaveBeenLastCalledWith({ method: 'POST', url: base, data: { command: 'help', description } })
      await api?.update('a/b', { command: 'help', description: '帮助' })
      expect(request()).toHaveBeenLastCalledWith({ method: 'PATCH', url: `${base}/a%2Fb`, data: { description } })
      await api?.delete('a/b')
      expect(request()).toHaveBeenLastCalledWith({ method: 'DELETE', url: `${base}/a%2Fb` })
    })

    it('maps non-zero codes and thrown errors to FeishuApiError', async () => {
      const api = defaultChannelFactory(options).slashCommands
      request().mockResolvedValueOnce({ code: 99991672, msg: 'denied' })
      await expect(api?.list()).rejects.toMatchObject({ code: 99991672, detail: 'code=99991672 denied' })
      request().mockRejectedValueOnce(Object.assign(new Error('400'), { response: { data: { code: 40000000, msg: 'exists' } } }))
      await expect(api?.create({ command: 'help', description: 'h' })).rejects.toBeInstanceOf(FeishuApiError)
    })
  })

  describe('appOwnerUserId', () => {
    const get = () => sdk.channel.rawClient.application.v6.application.get

    it('queries the own app with user_id and returns a tenant-member owner', async () => {
      get().mockResolvedValueOnce({ code: 0, data: { app: { owner: { type: 2, owner_id: ' u_owner ' } } } })
      await expect(defaultChannelFactory(options).appOwnerUserId?.()).resolves.toBe('u_owner')
      expect(get()).toHaveBeenCalledWith({
        path: { app_id: 'cli_test' },
        params: { lang: 'zh_cn', user_id_type: 'user_id' },
      })
    })

    it.each([
      { app: { owner: { type: 0, owner_id: 'u_feishu' } } },
      { app: { owner: { type: 2, owner_id: '  ' } } },
      { app: {} },
    ])('returns undefined without a tenant-member owner id (%j)', async (data) => {
      get().mockResolvedValueOnce({ code: 0, data })
      await expect(defaultChannelFactory(options).appOwnerUserId?.()).resolves.toBeUndefined()
    })

    it('rejects a non-zero API code with its code and msg', async () => {
      get().mockResolvedValueOnce({ code: 99991672, msg: 'Access denied' })
      const error = await defaultChannelFactory(options).appOwnerUserId?.().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AppOwnerLookupError)
      expect(error).toMatchObject({ code: 99991672, detail: 'code=99991672 Access denied' })
    })

    it('maps a thrown HTTP error body and a bare error', async () => {
      get().mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
        response: { data: { code: 99991672, msg: 'scope required' } },
      }))
      await expect(defaultChannelFactory(options).appOwnerUserId?.())
        .rejects.toMatchObject({ code: 99991672, detail: 'code=99991672 scope required' })
      get().mockRejectedValueOnce(new Error('socket hang up'))
      await expect(defaultChannelFactory(options).appOwnerUserId?.())
        .rejects.toMatchObject({ detail: 'socket hang up' })
    })
  })

  it.each<FeishuConnectionStatus>([
    { state: 'connected', lastConnectTime: 100, reconnectAttempts: 0 },
    { state: 'reconnecting', lastConnectTime: 100, nextConnectTime: 200, reconnectAttempts: 2 },
    { state: 'failed', lastConnectTime: 100, reconnectAttempts: 5 },
  ])('exposes the SDK $state connection status', (status) => {
    sdk.channel.getConnectionStatus.mockReturnValue(status)
    const channel = defaultChannelFactory(options)

    expect(channel.getConnectionStatus()).toEqual(status)
    expect(sdk.channel.getConnectionStatus).toHaveBeenCalledOnce()
  })

  it('disables SDK debounce merging so a burst never collapses into the last sender', () => {
    defaultChannelFactory(options)

    expect(sdk.createLarkChannel).toHaveBeenCalledWith(expect.objectContaining({
      safety: { batch: { text: { delayMs: 0 } } },
    }))
  })

  it('identifies message senders by user_id and drops senders without one', async () => {
    const channel = defaultChannelFactory(options)
    const received: unknown[] = []
    channel.onMessage(message => { received.push(message) })
    const calls = sdk.channel.on.mock.calls as unknown as Array<[string, (message: object) => unknown]>
    const listener = calls.find(([event]) => event === 'message')?.[1]
    expect(listener).toBeDefined()
    const base = { messageId: 'om_1', chatId: 'oc_chat', chatType: 'p2p', senderId: 'ou_sender' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await listener?.({ ...base, raw: { sender: { sender_id: { open_id: 'ou_sender', user_id: 'u_sender' } } } })
      await listener?.({ ...base, raw: { sender: { sender_id: { open_id: 'ou_bot' } } } })
      await listener?.({ ...base, raw: undefined })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }

    expect(received).toEqual([expect.objectContaining({ messageId: 'om_1', senderId: 'u_sender' })])
  })

  it('passes a Buffer-backed file payload to the official SDK', async () => {
    const channel = defaultChannelFactory(options)
    const source = Buffer.from('{"session":"test"}\n')

    await expect(channel.send('oc_chat', {
      file: { source, fileName: 'session.jsonl.gz' },
    }, { replyTo: 'om_trigger', replyInThread: true })).resolves.toEqual({ messageId: 'om_file' })

    expect(sdk.channel.send).toHaveBeenCalledWith(
      'oc_chat',
      { file: { source, fileName: 'session.jsonl.gz' } },
      { replyTo: 'om_trigger', replyInThread: true },
    )
  })

  it('exposes the raw message get/list read wrappers', async () => {
    const channel = defaultChannelFactory(options)
    await channel.messageGet?.('om_1')
    expect(sdk.channel.rawClient.im.v1.message.get).toHaveBeenCalledWith({
      path: { message_id: 'om_1' },
      params: { user_id_type: 'user_id' },
    })

    const params = {
      container_id_type: 'thread' as const,
      container_id: 'omt_1',
      page_size: 10,
      sort_type: 'ByCreateTimeDesc' as const,
    }
    await channel.messageList?.(params)
    expect(sdk.channel.rawClient.im.v1.message.list).toHaveBeenCalledWith({ params })
  })

  it('batches message.mget with repeated query params (SDK 1.76 has no typed mget)', async () => {
    const channel = defaultChannelFactory(options)
    await channel.messageMget?.(['om_a', 'om_b'])
    expect(sdk.channel.rawClient.request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/im/v1/messages/mget?message_ids=om_a&message_ids=om_b&card_msg_content_type=raw_card_content&user_id_type=user_id',
    })

    await expect(channel.messageMget?.([])).rejects.toThrow(/1-50/)
    await expect(channel.messageMget?.(Array.from({ length: 51 }, (_, index) => `om_${index}`)))
      .rejects.toThrow(/1-50/)
  })
})


describe('large-file ranged download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses the total from a Content-Range header', () => {
    expect(contentRangeTotal({ 'content-range': 'bytes 0-0/141405944' })).toBe(141405944)
    expect(contentRangeTotal({ 'Content-Range': 'bytes 0-1023/63456825' })).toBe(63456825)
    expect(contentRangeTotal(new Map([['content-range', 'bytes 0-0/9']]))).toBe(9)
    expect(contentRangeTotal({})).toBeUndefined()
    expect(contentRangeTotal(undefined)).toBeUndefined()
    expect(contentRangeTotal({ 'content-range': 'bytes 0-0/not-a-number' })).toBeUndefined()
  })

  it('walks bounded ranges and yields every byte exactly once', async () => {
    const payload = Buffer.from('abcdefghij')
    const fetcher = vi.fn(async (range: string) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range)!
      const start = Number(match[1])
      const end = Number(match[2])
      return { headers: {}, stream: Readable.from([payload.subarray(start, end + 1)]) }
    })
    expect(await collect(downloadResourceInRanges(fetcher, payload.length, 4))).toEqual(payload)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'bytes=0-3', 'bytes=4-7', 'bytes=8-9',
    ])
  })

  it('rejects a stalled range instead of silently truncating the file', async () => {
    const fetcher = vi.fn(async () => ({ headers: {}, stream: Readable.from([]) }))
    await expect(collect(downloadResourceInRanges(fetcher, 10, 4))).rejects.toThrow(/stalled/)
  })

  it('probing a large file then downloads it in chunks', async () => {
    const get = sdk.channel.rawClient.im.v1.messageResource.get
    get.mockImplementation(async (_payload: unknown, options?: { headers?: { Range?: string } }) => {
      const range = options?.headers?.Range
      if (range === 'bytes=0-0') return resourceResponse(['X'], { 'content-range': 'bytes 0-0/10' })
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? '')!
      const start = Number(match[1])
      const end = Number(match[2])
      const payload = Buffer.from('abcdefghij').subarray(start, end + 1)
      return resourceResponse([payload.toString()], { 'content-range': `bytes ${start}-${end}/10` })
    })
    const channel = defaultChannelFactory(options)

    expect(await collect(await channel.downloadResource('om_big', 'file_key', 'file'))).
      toEqual(Buffer.from('abcdefghij'))
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[0]![1]).toEqual({ headers: { Range: 'bytes=0-0' } })
    expect(get.mock.calls[1]![1]).toEqual({ headers: { Range: 'bytes=0-9' } })
    expect(RANGE_DOWNLOAD_CHUNK_BYTES).toBe(32 * 1024 * 1024)
  })

  it('keeps images on the single-response path', async () => {
    const get = sdk.channel.rawClient.im.v1.messageResource.get
    get.mockResolvedValueOnce(resourceResponse(['image-bytes']))
    const channel = defaultChannelFactory(options)

    expect(await collect(await channel.downloadResource('om_img', 'img_key', 'image'))).
      toEqual(Buffer.from('image-bytes'))
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]![1]).toBeUndefined()
  })
})
