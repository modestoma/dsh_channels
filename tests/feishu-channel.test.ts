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
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
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
  contentRangeTotal, defaultChannelFactory, downloadResourceInRanges, RANGE_DOWNLOAD_CHUNK_BYTES,
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
