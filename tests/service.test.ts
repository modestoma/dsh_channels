/**
 * FeishuService end-to-end tests over fakes: routing, workspace ownership,
 * topic replies, degradation, and lazy resume.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuService } from '../src/service.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { ChannelFactory, FeishuChannel, NormalizedMessage } from '../src/feishu-channel.ts'
import { makeHostContext, makeChannel, makeMessage } from './helpers.ts'

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    appId: 'FEISHU_APP_ID',
    appSecret: 'FEISHU_APP_SECRET',
    baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-channels-ws-')),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: undefined,
    refreshMs: 500,
    dmMode: 'open',
    requireMention: true,
    threadFallback: 'degrade',
    loggerLevel: 'info',
    ...partial,
  }
}

interface Harness {
  service: FeishuService
  channel: FeishuChannel & { sent: unknown[]; updated: unknown[]; reactions: unknown[]; removedReactions: unknown[] }
  factoryCalls: unknown[]
  onMessage: (msg: NormalizedMessage) => Promise<void>
  ctxState: ReturnType<typeof makeHostContext>
  config: FeishuConfig
}

async function setup(partial: Partial<FeishuConfig> = {}, channelOptions: Parameters<typeof makeChannel>[0] = {}): Promise<Harness> {
  const config = makeConfig(partial)
  const channel = makeChannel(channelOptions)
  const ctxState = makeHostContext()
  const factoryCalls: unknown[] = []
  const factory: ChannelFactory = options => {
    factoryCalls.push(options)
    return channel
  }
  const service = new FeishuService(ctxState.ctx, config, factory)
  await service.start()
  const registered = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
  const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
  const onMessage = (msg: NormalizedMessage) => Promise.resolve(handler(msg)).then(() => undefined)
  return { service, channel, factoryCalls, onMessage, ctxState, config }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
/** Positive assertions poll until the async pipeline settles (fs-safe). */
const waitUntil = async (assert: () => void) => {
  await vi.waitFor(assert, { timeout: 2000, interval: 5 })
}

/** Narrow a stub method back to its vitest mock for assertions. */
const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>

describe('FeishuService', () => {
  beforeEach(() => {})
  afterEach(async () => {})

  it('starts and connects the channel', async () => {
    const h = await setup()
    expect(mock(h.channel.connect)).toHaveBeenCalled()
    await h.service.shutdown()
    expect(mock(h.channel.disconnect)).toHaveBeenCalled()
  })

  it('resolves app credentials through the host credentials seam', async () => {
    const h = await setup()
    expect(h.factoryCalls[0]).toMatchObject({
      appId: 'cli_test_app',
      appSecret: 'test_secret',
    })
  })

  it('resolves credentials from the environment when the seam is absent', async () => {
    const ctxState = makeHostContext()
    ctxState.credentials.values = {}
    const get = ctxState.ctx.get!
    ctxState.ctx.get = (name: string) => (name === 'credentials' ? undefined : get(name))
    const channel = makeChannel()
    const factoryCalls: unknown[] = []
    const service = new FeishuService(ctxState.ctx, makeConfig(), options => {
      factoryCalls.push(options)
      return channel
    })
    const previousId = process.env.FEISHU_APP_ID
    const previousSecret = process.env.FEISHU_APP_SECRET
    process.env.FEISHU_APP_ID = 'cli_env_id'
    process.env.FEISHU_APP_SECRET = 'env_secret'
    try {
      await service.start()
    } finally {
      if (previousId === undefined) delete process.env.FEISHU_APP_ID
      else process.env.FEISHU_APP_ID = previousId
      if (previousSecret === undefined) delete process.env.FEISHU_APP_SECRET
      else process.env.FEISHU_APP_SECRET = previousSecret
      await service.shutdown()
    }
    expect(factoryCalls[0]).toMatchObject({ appId: 'cli_env_id', appSecret: 'env_secret' })
  })

  it('fails startup with a clear message when a credential is unconfigured', async () => {
    const ctxState = makeHostContext({ FEISHU_APP_ID: 'cli_test_app' }) // SECRET missing
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig(), () => channel)
    await expect(service.start()).rejects.toThrow(/FEISHU_APP_SECRET.*not configured/)
    expect(mock(channel.connect)).not.toHaveBeenCalled()
  })

  it('creates a topic + session for a p2p message: Typing reaction, workspace dir, route persisted', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', mentionedBot: false, content: '你好呀' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    // Typing reaction first.
    expect(h.channel.reactions).toContainEqual({ messageId: msg.messageId, emojiType: 'Typing' })

    // First card was sent as a topic reply (creates the topic).
    const firstSend = h.channel.sent[0] as { options?: { replyTo?: string; replyInThread?: boolean } }
    expect(firstSend?.options).toMatchObject({ replyTo: msg.messageId, replyInThread: true })

    // Agent created with the workspace directory.
    expect(h.ctxState.agents.created).toHaveLength(1)
    const created = h.ctxState.agents.created[0]!
    const workspacePath = path.join(h.config.baseDir, 'p2p', 'ou_alice')
    expect(created.options.meta?.cwd).toBe(workspacePath)
    expect(created.options.agentOptions).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    // Workspace registered and session attached.
    expect(h.ctxState.workspaces.workspaces.get(workspacePath)).toBeDefined()
    expect(mock(h.ctxState.workspaces.workspaces.get(workspacePath)!.attachSession)).toHaveBeenCalledWith(created.options.sessionId)

    // User message handed to the driver.
    expect(mock(created.handle.agent.followup)).toHaveBeenCalledTimes(1)
    const followupMessage = mock(created.handle.agent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> }
    expect(followupMessage.content[0]?.text).toBe('你好呀')

    // Route persisted under the thread id.
    const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.[0]).toBe('omt_1')
  })

  it('routes a thread continuation to the SAME session without a mention', async () => {
    const h = await setup()
    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: '开始' })
    await h.onMessage(first)
    await flush()

    const second = makeMessage({
      chatType: 'group',
      chatId: 'oc_grp',
      senderId: 'ou_alice',
      mentionedBot: false,
      threadId: 'omt_1',
      messageId: 'om_second',
      content: '继续',
    })
    await h.onMessage(second)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))

    // No new agent; the existing one received the follow-up.
    expect(h.ctxState.agents.created).toHaveLength(1)
    const calls = mock(agent.followup).mock.calls
    expect((calls[1]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('继续')

    // The continuation reply also lands in the thread.
    const sends = h.channel.sent as Array<{ options?: { replyTo?: string; replyInThread?: boolean } }>
    expect(sends[1]?.options).toMatchObject({ replyTo: 'om_second', replyInThread: true })
  })

  it('ignores group messages without a mention when requireMention is on', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'group', mentionedBot: false, content: '闲聊' })
    await h.onMessage(msg)
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.channel.reactions).toHaveLength(0)
  })

  it('answers group messages without a mention when requireMention is off', async () => {
    const h = await setup({ requireMention: false })
    const msg = makeMessage({ chatType: 'group', mentionedBot: false, content: '直接问' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
  })

  it('gives every group user their own workspace in the same chat', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: 'a' }))
    await h.onMessage(makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_bob', threadId: 'omt_2', content: 'b' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    const aliceDir = path.join(h.config.baseDir, 'groups', 'oc_grp', 'ou_alice')
    const bobDir = path.join(h.config.baseDir, 'groups', 'oc_grp', 'ou_bob')
    const cwds = h.ctxState.agents.created.map(entry => entry.options.meta?.cwd).sort()
    expect(cwds).toEqual([aliceDir, bobDir].sort())
  })

  it('ignores messages from the bot itself and empty content', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'bot-open-id', content: 'self echo' }))
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'ou_alice', content: '   ' }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(0)
  })

  it('degrades to a chat-scoped route when topic replies are refused', async () => {
    const h = await setup({}, { failReplyInThread: true })
    const msg = makeMessage({ chatType: 'group', content: '话题不支持' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const sends = h.channel.sent as Array<{ options?: { replyInThread?: boolean } }>
    expect(sends[0]?.options?.replyInThread).toBeUndefined()
    const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(entries[0]?.[0]).toBe('chat:group:oc_test_chat:ou_test_user')

    // A later mention in the same chat continues the same session.
    await h.onMessage(makeMessage({ chatType: 'group', content: '再来' }))
    await waitUntil(() => expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(2))
    expect(h.ctxState.agents.created).toHaveLength(1)
  })

  it('resumes the persisted session when the live agent is gone', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hello' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId

    // Simulate a restart: drop live agents, keep the route table.
    await h.service.shutdown()
    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '还在吗', threadId: 'omt_1' }))
    await waitUntil(() => expect(h.ctxState.agents.resumed).toHaveLength(1))
    expect(h.ctxState.agents.resumed[0]!.options.resumeSessionId).toBe(sessionId)
    await waitUntil(() => expect(mock(h.ctxState.agents.resumed[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1))
    await service2.shutdown()
  })

  it('reports session-creation failure on the card instead of crashing', async () => {
    const h = await setup()
    h.ctxState.agents.registry.create = async () => {
      throw new Error('boom')
    }
    await h.onMessage(makeMessage({ chatType: 'p2p', content: 'x' }))
    await waitUntil(() => expect(h.channel.updated.length).toBeGreaterThan(0))
    const update = h.channel.updated[0] as { card: object }
    expect(JSON.stringify(update.card)).toContain('会话创建失败')
  })
})
