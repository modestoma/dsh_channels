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
import type { AgentHandle, SessionId } from '../src/dsh-types.ts'
import {
  makeHostContext, makeChannel, makeMessage, makeAgentPresets, makeSession, makeAgent,
} from './helpers.ts'
import type { FakeAgentPresets, FakeAgentPresetsOptions, FakeAgentsOptions } from './helpers.ts'

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    appId: 'FEISHU_APP_ID',
    appSecret: 'FEISHU_APP_SECRET',
    baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-channels-ws-')),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: undefined,
    refreshMs: 500,
    // Effectively disables the keep-alive heartbeat in service tests (real timers).
    statusRefreshMs: 60_000,
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

async function setup(
  partial: Partial<FeishuConfig> = {},
  channelOptions: Parameters<typeof makeChannel>[0] = {},
  presetOptions?: FakeAgentPresetsOptions,
  agentsOptions: FakeAgentsOptions = {},
): Promise<Harness> {
  const config = makeConfig(partial)
  const channel = makeChannel(channelOptions)
  const ctxState = makeHostContext(
    undefined,
    presetOptions === undefined ? undefined : makeAgentPresets(presetOptions),
    agentsOptions,
  )
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

  it('composes created sessions from the roster default preset (mount in setup + header meta)', async () => {
    const h = await setup({}, {}, {})
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false, content: 'hi' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.agentPreset).toBe('standard')
    expect(typeof created.options.setup).toBe('function')

    // The fake registry awaited setup before publishing, exactly like the host
    // factory, so the roster mount must have seen the unpublished agent scope.
    const presets = h.ctxState.ctx.get!('agentPresets') as FakeAgentPresets
    expect(presets.resolve).toHaveBeenCalledWith(undefined)
    expect(presets.mounts).toEqual([{ agentCtx: created.setupCtx, id: 'standard' }])
  })

  it('mounts the configured agentPreset id instead of the roster default', async () => {
    const h = await setup({ agentPreset: 'channels' }, {}, { defaultId: 'standard' })
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false, content: 'hi' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.agentPreset).toBe('channels')
    const presets = h.ctxState.ctx.get!('agentPresets') as FakeAgentPresets
    expect(presets.resolve).toHaveBeenCalledWith('channels')
    expect(presets.mounts).toEqual([{ agentCtx: created.setupCtx, id: 'channels' }])
  })

  it('leaves creation bare when no preset roster exists (headless deployments)', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false, content: 'hi' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.agentPreset).toBeUndefined()
    expect(created.options.setup).toBeUndefined()
  })

  it('reports preset resolution failure on the card instead of publishing a bare session', async () => {
    const h = await setup({}, {}, { failResolve: new Error('unknown preset') })
    await h.onMessage(makeMessage({ chatType: 'p2p', content: 'x' }))
    await waitUntil(() => expect(h.channel.updated.length).toBeGreaterThan(0))

    const update = h.channel.updated[0] as { card: object }
    expect(JSON.stringify(update.card)).toContain('会话创建失败')
    expect(h.ctxState.agents.created).toHaveLength(0)
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

  it('composes resumed sessions from the same preset resolution as creation', async () => {
    const h = await setup({}, {}, {})
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hello' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    // Simulate a restart: drop live agents, keep the route table.
    await h.service.shutdown()
    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '还在吗', threadId: 'omt_1' }))
    await waitUntil(() => expect(h.ctxState.agents.resumed).toHaveLength(1))

    const resumed = h.ctxState.agents.resumed[0]!
    expect(typeof resumed.options.setup).toBe('function')
    const presets = h.ctxState.ctx.get!('agentPresets') as FakeAgentPresets
    expect(presets.mounts).toEqual([
      { agentCtx: h.ctxState.agents.created[0]!.setupCtx, id: 'standard' },
      { agentCtx: resumed.setupCtx, id: 'standard' },
    ])
    await service2.shutdown()
  })

  it('borrows a live agent owned elsewhere instead of cold-resuming it', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hello' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.service.shutdown()

    // The session stays live under a foreign owner (e.g. the web UI's
    // api-remote resolver resumed it right after the restart).
    const foreignAgent = makeAgent(makeSession(sessionId))
    const foreignDispose = vi.fn(async () => {})
    h.ctxState.agents.liveAgents.set(sessionId, { agent: foreignAgent, dispose: foreignDispose })

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '还在吗', threadId: 'omt_1' }))

    // No cold resume: the borrowed agent received the followup directly.
    await waitUntil(() => expect(mock(foreignAgent.followup)).toHaveBeenCalledTimes(1))
    expect(h.ctxState.agents.resumed).toHaveLength(0)
    const calls = mock(foreignAgent.followup).mock.calls
    expect((calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('还在吗')

    // The reply card still lands in the topic as usual.
    const sends = channel2.sent as Array<{ options?: { replyInThread?: boolean } }>
    expect(sends[0]?.options?.replyInThread).toBe(true)

    // Borrowed ≠ owned: shutdown must not dispose the foreign owner's agent.
    await service2.shutdown()
    expect(foreignDispose).not.toHaveBeenCalled()
  })

  it('borrows the live winner when a concurrent cold resume wins the race', async () => {
    let sessionId: SessionId = '' as SessionId
    let winner: AgentHandle | undefined
    const h = await setup({}, {}, undefined, {
      failResume: new Error('cannot prepare session "x" while it is live'),
      onFailResume: () => {
        // The other cold resume published the session and then our resume lost.
        const agent = makeAgent(makeSession(sessionId))
        winner = { agent, dispose: vi.fn(async () => {}) }
        h.ctxState.agents.liveAgents.set(sessionId, winner)
      },
    })
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hello' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    sessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '还在吗', threadId: 'omt_1' }))

    await waitUntil(() => expect(winner).toBeDefined())
    await waitUntil(() => expect(mock(winner!.agent.followup)).toHaveBeenCalledTimes(1))
    expect((mock(winner!.agent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('还在吗')

    // The race must not surface to the user as a 处理失败 message.
    expect(JSON.stringify(channel2.sent)).not.toContain('处理失败')
    await service2.shutdown()
  })

  it('disposes an agent resumed during shutdown instead of leaking it live', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hello' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()

    // Gate the resume so the shutdown can run while it is in flight.
    let releaseResume: (handle: AgentHandle) => void = () => {}
    const gate = new Promise<AgentHandle>(resolve => { releaseResume = resolve })
    const resumeCalled = vi.fn(() => gate)
    h.ctxState.ctx.agents.resume = resumeCalled

    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    void handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '还在吗', threadId: 'omt_1' }))
    await waitUntil(() => expect(resumeCalled).toHaveBeenCalled())
    await service2.shutdown()

    // Release the in-flight resume: the just-published agent must be disposed
    // so it cannot poison the next instance's resumes ("while it is live").
    const lateAgent = makeAgent(makeSession(sessionId))
    const lateDispose = vi.fn(async () => {})
    releaseResume({ agent: lateAgent, dispose: lateDispose })
    await waitUntil(() => expect(lateDispose).toHaveBeenCalledTimes(1))
    expect(mock(lateAgent.followup)).not.toHaveBeenCalled()
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

  it('sends oversized body segments as continuation cards inside the topic', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '长文' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!
    const huge = 'x'.repeat(30_000)
    listener(agent.session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: huge } },
    })
    listener(agent.session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })

    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))
    const second = h.channel.sent[1] as {
      options?: { replyTo?: string; replyInThread?: boolean }
      input: { card: object }
    }
    expect(second.options).toMatchObject({ replyTo: 'om_1', replyInThread: true })
    expect(JSON.stringify(second.input.card).length).toBeLessThan(30_000)
  })

  it('falls back to plain text for a rejected segment while the initial card succeeded', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '长文' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent

    // Reject only subsequent card sends (the initial reply card already landed).
    const originalSend = h.channel.send.bind(h.channel)
    ;(h.channel as unknown as { send: typeof h.channel.send }).send = async (chatId, input, options) => {
      if ('card' in input) throw new Error('card rejected (230099)')
      return originalSend(chatId, input, options)
    }

    const listener = h.ctxState.sessionListeners[0]!
    listener(agent.session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
    listener(agent.session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })

    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))
    const second = h.channel.sent[1] as {
      options?: { replyTo?: string; replyInThread?: boolean }
      input: { text?: string }
    }
    expect(second.options).toMatchObject({ replyTo: 'om_1', replyInThread: true })
    expect(second.input.text).toContain('回复分段 2')
    expect(second.input.text).toContain('降级为纯文本')
    expect(second.input.text).toContain('xxx')
  })
})
