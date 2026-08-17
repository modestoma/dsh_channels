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
      im: { v1: { message: { get: vi.fn(async () => ({ data: { items: [] } })) } } },
    },
  }
  return { channel, createLarkChannel: vi.fn(() => channel) }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: sdk.createLarkChannel,
  LoggerLevel: { debug: 0, info: 1, warn: 2, error: 3 },
}))

import { defaultChannelFactory } from '../src/feishu-channel.ts'
import type { FeishuConnectionStatus } from '../src/feishu-channel.ts'

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
