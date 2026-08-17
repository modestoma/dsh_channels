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
import type { CardActionEvent, ChannelFactory, FeishuChannel, NormalizedMessage } from '../src/feishu-channel.ts'
import type { AgentHandle, ApprovalOutcome, SessionId } from '../src/dsh-types.ts'
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
    // GC disabled by default in tests: restart scenarios rely on routes
    // surviving, and GC tests opt in with explicit TTLs.
    routeTtlMs: 0,
    approvalTimeoutMs: 300_000,
    ...partial,
  }
}

interface Harness {
  service: FeishuService
  channel: FeishuChannel & {
    sent: unknown[]
    updated: unknown[]
    reactions: unknown[]
    removedReactions: unknown[]
    cardActionHandlers: Array<(event: CardActionEvent) => void | Promise<void>>
    fireCardAction: (event: CardActionEvent) => Promise<void>
  }
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

  it('handles unbound /health without creating a workspace or Session', async () => {
    const h = await setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_health', senderId: 'ou_alice',
      mentionedBot: false, messageId: 'om_health', content: '  /health  ',
    })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    expect(h.channel.sent).toHaveLength(1)
    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input)).toContain('SC-03')
    expect(h.channel.reactions).toEqual([
      { messageId: 'om_health', emojiType: 'Typing' },
      { messageId: 'om_health', emojiType: 'DONE' },
    ])
  })

  it('rejects an unknown slash command without creating a Session or model turn', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'p2p', senderId: 'ou_alice', content: '/foo' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(1)
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('未知命令')
    expect(json).toContain('/health')
  })

  it('executes a routed command once with one lifecycle pair and no followup', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_commands', senderId: 'ou_owner',
      messageId: 'om_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    mock(agent.followup).mockClear()

    const command = makeMessage({
      chatType: 'group', chatId: 'oc_commands', senderId: 'ou_owner',
      threadId: 'omt_1', messageId: 'om_status', mentionedBot: false, content: '/status',
    })
    await h.onMessage(command)
    await h.onMessage(command) // Feishu redelivery
    await waitUntil(() => expect(mock(h.ctxState.ctx.commands.execute)).toHaveBeenCalledTimes(1))

    expect(mock(h.ctxState.ctx.commands.execute)).toHaveBeenCalledTimes(1)
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(agent.session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(h.channel.sent).toHaveLength(2)
  })

  it('denies a non-owner before resume, command execution, or Session inspection', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_owned', senderId: 'ou_owner', messageId: 'om_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    mock(h.ctxState.ctx.commands.execute).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_owned', senderId: 'ou_intruder',
      threadId: 'omt_1', messageId: 'om_intruder', mentionedBot: false, content: '/status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(mock(h.ctxState.ctx.commands.execute)).not.toHaveBeenCalled()
    expect(h.ctxState.agents.resumed).toHaveLength(0)
    expect(agent.session.events).toHaveLength(0)
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('无权操作此会话')
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

  it('leaves preset composition bare but still mounts channel commands without a roster', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false, content: 'hi' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.agentPreset).toBeUndefined()
    expect(created.options.setup).toBeTypeOf('function')
    expect(created.setupCtx.commands.find(created.handle.agent, 'health')).toBeDefined()
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
    // Deterministic barrier: the route must be durable before the thread
    // message arrives — otherwise the message lands in the (legitimate)
    // "no route, no mention" drop window and the test flakes.
    await waitUntil(() => {
      const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
      expect(entries).toHaveLength(1)
    })

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
    // Deterministic barrier: wait for the chat-scoped route to be durable
    // before the follow-up message (same race as the thread test above).
    await waitUntil(() => {
      const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
      expect(entries[0]?.[0]).toBe('chat:group:oc_test_chat:ou_test_user')
    })

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

  // ---- in-flight turn snapshots (restart repair) -------------------------

  const inflightEntries = (h: Harness) =>
    [...(h.ctxState.domain.raw.table('inflight').entries() as IterableIterator<[string, unknown]>)]

  it('persists an in-flight snapshot on session start and retires it on turn end', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', mentionedBot: false, content: 'hi' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const entries = inflightEntries(h)
    expect(entries).toHaveLength(1)
    const [key, snapshot] = entries[0]!
    expect(key).toBe('om_1')
    expect(snapshot).toMatchObject({
      key: 'om_1',
      sessionId: h.ctxState.agents.created[0]!.options.sessionId,
      chatId: 'oc_p2p',
      triggerMessageId: msg.messageId,
      reactionId: 'react-1',
      cards: [{ messageId: 'om_1', mode: 'card' }],
      attempts: 0,
    })

    // The turn ends → the snapshot is retired.
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!
    listener(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
  })

  it('writes a fresh snapshot per turn (concurrent turns never overwrite each other)', async () => {
    const h = await setup()
    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: '一' })
    await h.onMessage(first)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    // Second message while the first turn is still "streaming" (never ended).
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', mentionedBot: false,
      threadId: 'omt_1', messageId: 'om_second_msg', content: '二',
    })
    await h.onMessage(second)
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(2))

    const entries = inflightEntries(h)
    const keys = entries.map(([key]) => key).sort()
    expect(keys).toEqual(['om_1', 'om_2'])
    const secondSnapshot = entries.find(([key]) => key === 'om_2')?.[1] as { triggerMessageId: string }
    expect(secondSnapshot.triggerMessageId).toBe('om_second_msg')
  })

  it('folds resolved segment card ids into the snapshot', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '长文' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!

    listener(agent.session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
    await waitUntil(() => {
      const entries = inflightEntries(h)
      expect(entries).toHaveLength(1)
      const snapshot = entries[0]![1] as { cards: Array<{ messageId: string; mode: string }> }
      expect(snapshot.cards).toEqual([
        { messageId: 'om_1', mode: 'card' },
        { messageId: 'om_2', mode: 'card' },
      ])
    })
  })

  it('clears the snapshot when session creation fails (card already final)', async () => {
    const h = await setup()
    h.ctxState.agents.registry.create = async () => {
      throw new Error('boom')
    }
    await h.onMessage(makeMessage({ chatType: 'p2p', content: 'x' }))
    await waitUntil(() => expect(h.channel.updated.length).toBeGreaterThan(0))
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
  })

  it('repairs an interrupted turn after restart: terminal card, Typing→DONE, snapshot retired', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hi' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    // Crash mid-turn: shutdown without the turn ever ending.
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    await waitUntil(() => expect(channel2.updated.length).toBeGreaterThan(0))

    const update = channel2.updated[0]!
    expect(update.messageId).toBe('om_1')
    expect(JSON.stringify(update.card)).toContain('服务已重启')
    expect(JSON.stringify(update.card)).toContain('请重新发送消息')

    // Typing removed and DONE added on the original trigger message.
    expect(channel2.removedReactions).toContainEqual({ messageId: msg.messageId, reactionId: 'react-1' })
    expect(channel2.reactions).toContainEqual({ messageId: msg.messageId, emojiType: 'DONE' })

    // Snapshot retired after the repair.
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
    await service2.shutdown()
  })

  it('retries a failed repair once, then retires the snapshot', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hi' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await h.service.shutdown()

    // First boot: every card patch fails → attempts 0→1, snapshot kept.
    const channel2 = makeChannel()
    mock(channel2.updateCard).mockRejectedValue(new Error('patch rejected'))
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    await waitUntil(() => {
      const entries = inflightEntries(h)
      expect(entries).toHaveLength(1)
      expect((entries[0]![1] as { attempts: number }).attempts).toBe(1)
    })
    await service2.shutdown()

    // Second boot: still failing → the attempts cap (2) retires the snapshot.
    const channel3 = makeChannel()
    mock(channel3.updateCard).mockRejectedValue(new Error('patch rejected'))
    const service3 = new FeishuService(h.ctxState.ctx, h.config, () => channel3)
    await service3.start()
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
    await service3.shutdown()
  })

  it('skips text-mode segment cards during repair (content already delivered)', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '长文' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent

    // Segment 2 lands as a text fallback, then the crash happens mid-turn.
    const originalSend = h.channel.send.bind(h.channel)
    ;(h.channel as unknown as { send: typeof h.channel.send }).send = async (chatId, input, options) => {
      if ('card' in input && h.channel.sent.length > 0) throw new Error('card rejected (230099)')
      return originalSend(chatId, input, options)
    }
    const listener = h.ctxState.sessionListeners[0]!
    listener(agent.session, {
      type: 'assistant/chunk', seq: 1,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } },
    })
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))
    await waitUntil(() => {
      const entries = inflightEntries(h)
      const snapshot = entries[0]?.[1] as { cards: Array<{ mode: string }> } | undefined
      expect(snapshot?.cards.some(card => card.mode === 'text')).toBe(true)
    })
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    await waitUntil(() => expect(channel2.updated.length).toBeGreaterThan(0))

    // Only the main card was patched; the text-mode segment message is untouched.
    const patchedIds = channel2.updated.map(update => update.messageId)
    expect(patchedIds).toContain('om_1')
    expect(patchedIds).not.toContain('om_2')
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
    await service2.shutdown()
  })

  // ---- establishment serialization (gap 5: concurrent first messages) ----

  it('a topic message racing the first message continues the establishing session (no duplicate, no drop)', async () => {
    const h = await setup()
    // Park the first card send so the second message lands mid-establishment
    // (before the route commit — the exact window that used to drop or fork).
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const originalSend = h.channel.send.bind(h.channel)
    let gated = false
    ;(h.channel as unknown as { send: typeof h.channel.send }).send = async (chatId, input, options) => {
      if (!gated) {
        gated = true
        await gate
      }
      return originalSend(chatId, input, options)
    }

    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: '开始' })
    await h.onMessage(first)
    await waitUntil(() => expect(gated).toBe(true))

    // Second message already inside the just-created topic, no mention.
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice',
      mentionedBot: false, threadId: 'omt_1', messageId: 'om_second', content: '继续',
    })
    await h.onMessage(second)

    releaseFirst()
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))

    // ONE session and ONE route: the racing message continued it, in-topic.
    expect(h.ctxState.agents.created).toHaveLength(1)
    const calls = mock(agent.followup).mock.calls
    expect((calls[1]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('继续')
    const sends = h.channel.sent as Array<{ options?: { replyTo?: string; replyInThread?: boolean } }>
    expect(sends).toHaveLength(2)
    expect(sends[1]?.options).toMatchObject({ replyTo: 'om_second', replyInThread: true })
    const routes = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(routes).toHaveLength(1)
  })

  it('serializes degraded (topic-less) first messages into one chat-scoped session', async () => {
    const h = await setup({}, { failReplyInThread: true })
    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: '一' })
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', messageId: 'om_second', content: '二',
    })
    await h.onMessage(first)
    await h.onMessage(second)

    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))

    expect(h.ctxState.agents.created).toHaveLength(1)
    expect((mock(agent.followup).mock.calls[1]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('二')
    const routes = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(routes).toHaveLength(1)
  })

  it('lets a concurrent message start its own session when the first establishment fails', async () => {
    const h = await setup()
    // Fail only the FIRST creation; the waiter's fall-through must succeed.
    const originalCreate = h.ctxState.agents.registry.create.bind(h.ctxState.agents.registry)
    let failFirst = true
    h.ctxState.agents.registry.create = async options => {
      if (failFirst) {
        failFirst = false
        throw new Error('boom')
      }
      return originalCreate(options)
    }

    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: '失败的首条' })
    await h.onMessage(first)
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', messageId: 'om_second', content: '重试',
    })
    await h.onMessage(second)

    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(1))
    expect((mock(agent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('重试')

    const routes = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(routes).toHaveLength(1)
  })

  it('starts a separate session for a concurrent chat-level message after establishment settles (serial semantics)', async () => {
    const h = await setup()
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const originalSend = h.channel.send.bind(h.channel)
    let gated = false
    ;(h.channel as unknown as { send: typeof h.channel.send }).send = async (chatId, input, options) => {
      if (!gated) {
        gated = true
        await gate
      }
      return originalSend(chatId, input, options)
    }

    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', content: '开始' })
    await h.onMessage(first)
    await waitUntil(() => expect(gated).toBe(true))

    // Concurrent message OUTSIDE the new topic (no threadId): it must wait
    // for the establishment, then start its own session — never hijack the
    // first one and never race the route write.
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'ou_alice', messageId: 'om_second', content: '旁路',
    })
    await h.onMessage(second)

    releaseFirst()
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    await waitUntil(() => expect(mock(h.ctxState.agents.created[1]!.handle.agent.followup)).toHaveBeenCalledTimes(1))

    const firstAgent = h.ctxState.agents.created[0]!.handle.agent
    const secondAgent = h.ctxState.agents.created[1]!.handle.agent
    expect((mock(secondAgent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('旁路')
    expect((mock(firstAgent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('开始')

    // Two topics → two thread routes, each owned by its own session.
    const routes = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(routes).toHaveLength(2)
    const routeKeys = routes.map(([key]) => key).sort()
    expect(routeKeys).toEqual(['omt_1', 'omt_2'])
  })

  // ---- route-table GC (gap 3) ----------------------------------------------

  const DAY_MS = 24 * 60 * 60 * 1000

  function seedRoute(
    raw: ReturnType<typeof makeHostContext>['domain']['raw'],
    key: string,
    lastActivityAt: number,
  ): Promise<unknown> {
    return raw.table('routes').put(key, {
      key,
      kind: 'thread',
      sessionId: `session-${key}`,
      chatId: 'oc_test_chat',
      chatType: 'group',
      senderOpenId: 'ou_test_user',
      workspacePath: '/tmp/ws',
      cardMessageId: `om_${key}`,
      createdAt: lastActivityAt,
      lastActivityAt,
    })
  }

  it('garbage-collects route records idle past routeTtlMs at startup', async () => {
    const ctxState = makeHostContext()
    await seedRoute(ctxState.domain.raw, 'omt_stale', Date.now() - 40 * DAY_MS)
    await seedRoute(ctxState.domain.raw, 'omt_fresh', Date.now())
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 30 * DAY_MS }), () => channel)
    await service.start()

    await waitUntil(() => {
      const entries = [...(ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
      expect(entries.map(([key]) => key).sort()).toEqual(['omt_fresh'])
    })
    await service.shutdown()
  })

  it('drops stale in-flight snapshots during GC without repairing them', async () => {
    const ctxState = makeHostContext()
    await ctxState.domain.raw.table('inflight').put('om_stale_card', {
      key: 'om_stale_card',
      sessionId: 'session-x',
      chatId: 'oc_test_chat',
      triggerMessageId: 'om_trigger',
      cards: [{ messageId: 'om_stale_card', mode: 'card' }],
      startedAt: Date.now() - 40 * DAY_MS,
      attempts: 0,
    })
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 30 * DAY_MS }), () => channel)
    await service.start()

    await waitUntil(() =>
      expect([...(ctxState.domain.raw.table('inflight').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(0))
    // The ancient card must NOT be patched — repairing it would surprise the
    // user; GC drops the snapshot silently.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(channel.updated).toHaveLength(0)
    expect(channel.reactions).toHaveLength(0)
    await service.shutdown()
  })

  it('keeps expired routes when routeTtlMs is 0 (GC disabled)', async () => {
    const ctxState = makeHostContext()
    await seedRoute(ctxState.domain.raw, 'omt_stale', Date.now() - 40 * DAY_MS)
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 0 }), () => channel)
    await service.start()

    await new Promise(resolve => setTimeout(resolve, 50))
    const entries = [...(ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
    expect(entries).toHaveLength(1)
    await service.shutdown()
  })

  it('a message in a GC-d topic starts a fresh session instead of resuming the old one', async () => {
    const ctxState = makeHostContext()
    await seedRoute(ctxState.domain.raw, 'omt_gc', Date.now() - 40 * DAY_MS)
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 30 * DAY_MS }), () => channel)
    await service.start()
    await waitUntil(() =>
      expect([...(ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(0))

    const registered = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '重新开始', threadId: 'omt_gc' }))

    await waitUntil(() => expect(ctxState.agents.created).toHaveLength(1))
    expect(ctxState.agents.resumed).toHaveLength(0)
    expect(ctxState.agents.created[0]!.options.sessionId).not.toBe('session-omt_gc')
    await service.shutdown()
  })

  // ---- message idempotency (gap 2: WS redelivery dedup) --------------------

  const processedEntries = (h: Harness) =>
    [...(h.ctxState.domain.raw.table('processed').entries() as IterableIterator<[string, unknown]>)]
  const settle = (ms = 50) => new Promise<void>(resolve => setTimeout(resolve, ms))

  it('ignores a redelivered first message (single session, single card)', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '你好' })
    await h.onMessage(msg)
    await h.onMessage(msg) // WS redelivery of the same event

    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await settle()
    expect(h.ctxState.agents.created).toHaveLength(1)
    expect(h.channel.sent).toHaveLength(1)
    expect(h.channel.reactions).toHaveLength(1)
    expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1)
    expect(processedEntries(h)).toHaveLength(1)
  })

  it('ignores a redelivered continuation message (no duplicate turn)', async () => {
    const h = await setup()
    const first = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '开始' })
    await h.onMessage(first)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => {
      const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
      expect(entries).toHaveLength(1)
    })

    const cont = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice',
      threadId: 'omt_1', messageId: 'om_cont', content: '继续',
    })
    await h.onMessage(cont)
    await h.onMessage(cont) // redelivery

    const agent = h.ctxState.agents.created[0]!.handle.agent
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))
    await settle()
    expect(mock(agent.followup)).toHaveBeenCalledTimes(2)
    expect(h.channel.sent).toHaveLength(2)
    expect(processedEntries(h).map(([key]) => key).sort()).toEqual([first.messageId, 'om_cont'].sort())
  })

  it('deduplicates across restarts through the persisted record', async () => {
    const h = await setup()
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '跨重启' })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(processedEntries(h)).toHaveLength(1))
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(msg) // same message id redelivered after restart

    await settle()
    expect(h.ctxState.agents.created).toHaveLength(1) // no second session
    expect(h.ctxState.agents.resumed).toHaveLength(0)  // not even a lazy resume
    expect(channel2.sent).toHaveLength(0)              // no reply card
    await service2.shutdown()
  })

  it('prunes old processed records in the GC sweep (unconditional, routeTtlMs: 0)', async () => {
    const ctxState = makeHostContext()
    const raw = ctxState.domain.raw
    await raw.table('processed').put('om_msg_old', { key: 'om_msg_old', processedAt: Date.now() - 25 * 3600 * 1000 })
    await raw.table('processed').put('om_msg_new', { key: 'om_msg_new', processedAt: Date.now() })
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 0 }), () => channel)
    await service.start()

    await waitUntil(() => {
      const entries = [...(raw.table('processed').entries() as IterableIterator<[string, unknown]>)]
      expect(entries.map(([key]) => key)).toEqual(['om_msg_new'])
    })
    await service.shutdown()
  })
})

describe('HITL approval wiring', () => {
  it('registers a prepend approval answerer and card-action routing', async () => {
    const h = await setup()
    expect(h.ctxState.approvalListeners).toHaveLength(1)
    expect(h.ctxState.approvalListeners[0]!.options).toEqual({ prepend: true })
    expect(h.channel.cardActionHandlers).toHaveLength(1)
    await h.service.shutdown()
  })

  it('answers a routed session\'s approval through a decision card, owner-gated', async () => {
    const h = await setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_approval', senderId: 'ou_owner', content: '审批一下',
    })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.approvalListeners[0]!
    const next = vi.fn(async () => 'unavailable' as ApprovalOutcome)
    const pending = listener({
      agent,
      toolName: 'bash',
      reason: '写入工作区之外的文件',
      signal: undefined,
    }, next)

    // The decision card lands as its own message (2nd send, after the stream card).
    await waitUntil(() => {
      const index = h.channel.sent.findIndex(s => {
        const input = (s as { input: object }).input
        return 'card' in input && JSON.stringify((input as { card: object }).card).includes('需要你的审批')
      })
      expect(index).toBeGreaterThanOrEqual(0)
    })
    const approvalIndex = h.channel.sent.findIndex(s => {
      const input = (s as { input: object }).input
      return 'card' in input && JSON.stringify((input as { card: object }).card).includes('需要你的审批')
    })
    expect(next).not.toHaveBeenCalled()
    const sentOptions = (h.channel.sent[approvalIndex] as { options?: { replyTo?: string; replyInThread?: boolean } }).options
    expect(sentOptions?.replyInThread).toBe(true)
    const approvalMessageId = `om_${approvalIndex + 1}`

    // A stranger's click changes nothing.
    await h.channel.fireCardAction({
      messageId: approvalMessageId,
      chatId: 'oc_approval',
      operator: { openId: 'ou_stranger' },
      action: { value: { decision: 'allow' }, tag: 'button' },
    })
    await flush()
    expect(h.channel.updated.some(update =>
      (update as { messageId: string }).messageId === approvalMessageId
      && JSON.stringify((update as { card: object }).card).includes('已允许执行'),
    )).toBe(false)

    // The owner's 允许 settles the question and patches the card terminal.
    await h.channel.fireCardAction({
      messageId: approvalMessageId,
      chatId: 'oc_approval',
      operator: { openId: 'ou_owner' },
      action: { value: { decision: 'allow' }, tag: 'button' },
    })
    await expect(pending).resolves.toBe('allowed-once')
    await waitUntil(() => expect(h.channel.updated.some(update =>
      (update as { messageId: string }).messageId === approvalMessageId
      && JSON.stringify((update as { card: object }).card).includes('已允许执行'),
    )).toBe(true))
    await h.service.shutdown()
  })

  it('delegates approval requests for sessions the channel does not route', async () => {
    const h = await setup()
    const { listener } = h.ctxState.approvalListeners[0]!
    const foreign = makeAgent(makeSession('sess-foreign'))
    const next = vi.fn(async () => 'unavailable' as ApprovalOutcome)
    await expect(listener({ agent: foreign, toolName: 'bash' }, next)).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalled()
    expect(h.channel.sent).toHaveLength(0)
    await h.service.shutdown()
  })

  it('withdraws in-flight approvals on shutdown', async () => {
    const h = await setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_shutdown', senderId: 'ou_owner', content: '先问后关',
    })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.approvalListeners[0]!
    const pending = listener({
      agent, toolName: 'bash', reason: '关机前问一句', signal: undefined,
    }, vi.fn(async () => 'unavailable' as ApprovalOutcome))
    await waitUntil(() => expect(h.channel.sent.length).toBe(2))
    await h.service.shutdown()
    await expect(pending).resolves.toBe('cancelled')
  })
})
