/**
 * FeishuService end-to-end tests over fakes: routing, workspace ownership,
 * topic replies, degradation, and lazy resume.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuService } from '../src/service.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { CardActionEvent, ChannelFactory, FeishuChannel, NormalizedMessage } from '../src/feishu-channel.ts'
import { CordisFiberState } from '../src/dsh-types.ts'
import type { AgentHandle, ApprovalOutcome, CordisPluginRuntime, SessionId, SessionProjections } from '../src/dsh-types.ts'
import type { RouteRecord } from '../src/domain.ts'
import { FEISHU_ATTACHMENTS_SECTION } from '../src/feishu/agent-context.ts'
import type { SessionExportBuilder } from '../src/session-export.ts'
import {
  dispatchAgentRequest, makeHostContext, makeChannel, makeMessage, makeAgentPresets, makeSession, makeAgent, promptSectionsOf, sessionEvents,
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
    questionTimeoutMs: 300_000,
    allowPermissionSwitch: false,
    // Tests exercise routing/hitl behavior; access control has its own tests.
    accessMode: 'open',
    authRequestTtlDays: 7,
    // Onboarding is opt-in per test: it adds a card that would shift send counts.
    welcomeOnboarding: false,
    acceptAttachments: true,
    workspaceRetention: 'off',
    workspaceRetentionAuto: false,
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
  sessionExportBuilder?: SessionExportBuilder,
  projections?: SessionProjections,
): Promise<Harness> {
  const config = makeConfig(partial)
  const channel = makeChannel(channelOptions)
  const ctxState = makeHostContext(
    undefined,
    presetOptions === undefined ? undefined : makeAgentPresets(presetOptions),
    agentsOptions,
    projections,
  )
  const factoryCalls: unknown[] = []
  const factory: ChannelFactory = options => {
    factoryCalls.push(options)
    return channel
  }
  const service = new FeishuService(ctxState.ctx, config, factory, sessionExportBuilder)
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
const gunzipBuffer = promisify(gunzip)

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
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('健康检查')
    expect(json).toContain('degraded')
    expect(json).not.toContain('bot-open-id')
    expect(json).toContain('…n-id')
    expect(h.channel.reactions).toEqual([
      { messageId: 'om_health', emojiType: 'Typing' },
      { messageId: 'om_health', emojiType: 'DONE' },
    ])
  })

  it('lists all supported commands for unbound /help without creating a workspace or Session', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false,
      messageId: 'om_help', content: '/help',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('斜杠命令帮助')
    expect(json).toContain('/help')
    expect(json).toContain('/health')
    expect(json).toContain('/status')
    expect(json).toContain('/workspace')
    expect(json).not.toContain('/work-dir')
    expect(json).toContain('/compact')
    expect(json).toContain('/renew')
    expect(json).toContain('/history')
    expect(json).toContain('/export')
    expect(h.channel.reactions).toEqual([
      { messageId: 'om_help', emojiType: 'Typing' },
      { messageId: 'om_help', emojiType: 'DONE' },
    ])
  })

  it('rejects /help arguments without creating a workspace or Session', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false,
      messageId: 'om_help_args', content: '/help extra',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input))
      .toContain('/help 不接受参数')
  })

  it('returns /userid only in a private chat without creating a workspace or Session', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_private', senderId: 'ou_alice', mentionedBot: false,
      messageId: 'om_userid', content: '/userid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('当前用户 ID')
    expect(json).toContain('ou_alice')
    expect(mock(h.channel.send)).toHaveBeenCalledTimes(1)
    expect((h.channel.sent[0] as { options?: object }).options).toEqual({ replyTo: 'om_userid' })
    expect(h.channel.reactions).toEqual([
      { messageId: 'om_userid', emojiType: 'Typing' },
      { messageId: 'om_userid', emojiType: 'DONE' },
    ])
  })

  it('returns /groupid in a group root when the bot is mentioned', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'ou_alice', mentionedBot: true,
      messageId: 'om_groupid', content: '/groupid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('当前群组 ID')
    expect(json).toContain('oc_group')
    expect(mock(h.channel.send)).toHaveBeenCalledTimes(1)
    expect((h.channel.sent[0] as { options?: object }).options).toEqual({ replyTo: 'om_groupid' })
    expect(h.channel.reactions).toEqual([
      { messageId: 'om_groupid', emojiType: 'Typing' },
      { messageId: 'om_groupid', emojiType: 'DONE' },
    ])
  })

  it.each(['userid', 'groupid'] as const)(
    'ignores unmentioned /%s in a group root when requireMention is enabled',
    async command => {
      const h = await setup()
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_group', senderId: 'ou_alice', mentionedBot: false,
        messageId: `om_${command}_unmentioned`, content: `/${command}`,
      }))
      await flush()

      expect(h.channel.sent).toHaveLength(0)
      expect(h.channel.reactions).toHaveLength(0)
      expect(h.ctxState.agents.created).toHaveLength(0)
      expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    },
  )

  it('returns /groupid without a repeated mention inside an existing topic', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_topic_group', senderId: 'ou_alice', mentionedBot: false,
      threadId: 'omt_existing', messageId: 'om_groupid_topic', content: '/groupid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input)).toContain('oc_topic_group')
    expect((h.channel.sent[0] as { options?: object }).options)
      .toEqual({ replyTo: 'om_groupid_topic' })
    expect(h.ctxState.agents.created).toHaveLength(0)
  })

  it('returns /groupid without a mention when requireMention is disabled', async () => {
    const h = await setup({ requireMention: false })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_open_group', senderId: 'ou_alice', mentionedBot: false,
      messageId: 'om_groupid_open', content: '/groupid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input)).toContain('oc_open_group')
    expect((h.channel.sent[0] as { options?: object }).options)
      .toEqual({ replyTo: 'om_groupid_open' })
  })

  it.each([
    ['userid', 'group', '命令 /userid 仅支持在私聊中使用。', 'ou_group_user'],
    ['groupid', 'p2p', '命令 /groupid 仅支持在群聊中使用。', 'oc_private_chat'],
  ] as const)('rejects /%s in the wrong chat type without exposing its ID', async (
    command, chatType, expected, hiddenId,
  ) => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType,
      chatId: chatType === 'group' ? 'oc_group_chat' : hiddenId,
      senderId: chatType === 'group' ? hiddenId : 'ou_private_user',
      mentionedBot: true,
      messageId: `om_${command}_wrong_chat`,
      content: `/${command}`,
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain(expected)
    expect(json).not.toContain(hiddenId)
    expect(mock(h.channel.send)).toHaveBeenCalledTimes(1)
    expect((h.channel.sent[0] as { options?: object }).options)
      .toEqual({ replyTo: `om_${command}_wrong_chat` })
  })

  it.each(['userid', 'groupid'] as const)('rejects /%s arguments without creating a Session', async command => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: command === 'userid' ? 'p2p' : 'group',
      mentionedBot: command === 'groupid',
      messageId: `om_${command}_args`,
      content: `/${command} extra`,
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input))
      .toContain(`/${command} 不接受参数`)
    expect(mock(h.channel.send)).toHaveBeenCalledTimes(1)
    expect((h.channel.sent[0] as { options?: object }).options)
      .toEqual({ replyTo: `om_${command}_args` })
  })

  it.each([
    ['connected', 'healthy'],
    ['reconnecting', 'degraded'],
    ['failed', 'unhealthy'],
  ] as const)('maps an unbound %s channel to %s health', async (state, level) => {
    const h = await setup({}, {
      connectionStatus: {
        state,
        lastConnectTime: 100,
        ...(state === 'reconnecting' ? { nextConnectTime: 200 } : {}),
        reconnectAttempts: state === 'connected' ? 0 : 2,
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false,
      messageId: `om_health_${state}`, content: '/health',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain(`整体结论：**${level}**`)
    expect(json).toContain(state)
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
  })

  it.each([
    [CordisFiberState.PENDING, 'degraded'],
    [CordisFiberState.FAILED, 'unhealthy'],
  ] as const)('includes Cordis fiber state %s in health as %s', async (fiberState, level) => {
    const h = await setup({}, {
      connectionStatus: { state: 'connected', lastConnectTime: 100, reconnectAttempts: 0 },
    })
    const runtimes = new Map<string, CordisPluginRuntime>([
      ['test', { fibers: [{ state: CordisFiberState.ACTIVE }, { state: fiberState }] }],
    ])
    h.ctxState.ctx.registry = { size: runtimes.size, values: () => runtimes.values() }

    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false,
      messageId: `om_health_fiber_${fiberState}`, content: '/health',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain(`整体结论：**${level}**`)
    expect(json).toContain(fiberState === CordisFiberState.PENDING ? 'pending 1' : 'failed 1')
  })

  it('reports a missing critical Host dependency as unhealthy without exposing details', async () => {
    const h = await setup({}, {
      connectionStatus: { state: 'connected', lastConnectTime: 100, reconnectAttempts: 0 },
    })
    const get = h.ctxState.ctx.get!
    h.ctxState.ctx.get = name => name === 'llm' ? undefined : get(name)

    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'ou_alice', mentionedBot: false,
      messageId: 'om_health_missing_llm', content: '/health',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('整体结论：**unhealthy**')
    expect(json).toContain('❌ llm')
    expect(json).not.toContain('stack')
    expect(json).not.toContain('cause')
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
    expect(mock(h.ctxState.ctx.commands.execute)).toHaveBeenCalledWith(
      agent, '/status', [], expect.any(AbortSignal),
    )
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(sessionEvents(agent.session).map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(h.channel.sent).toHaveLength(2)
  })

  it('switches, reports, and resets reasoning effort within the current Session', async () => {
    const h = await setup({ reasoningEffort: 'high' })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_effort', senderId: 'ou_owner',
      messageId: 'om_effort_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const created = h.ctxState.agents.created[0]!
    const agent = created.handle.agent
    const request = () => dispatchAgentRequest(created.setupCtx, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await expect(request()).resolves.toMatchObject({ reasoningEffort: 'high' })

    const command = async (messageId: string, content: string) => {
      const before = sessionEvents(agent.session).length
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_effort', senderId: 'ou_owner', threadId: 'omt_1',
        mentionedBot: false, messageId, content,
      }))
      await waitUntil(() => expect(sessionEvents(agent.session).length).toBe(before + 2))
    }

    await command('om_effort_tiny', '/effort tiny')
    await expect(request()).resolves.toMatchObject({ reasoningEffort: 'tiny' })
    expect(sessionEvents(agent.session).slice(-2)).toMatchObject([
      { type: 'command/run', data: { name: 'effort', args: ' tiny' } },
      { type: 'command/done', data: { kind: 'success' } },
    ])

    await command('om_effort_show', '/effort')
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('tiny')
    await expect(request()).resolves.toMatchObject({ reasoningEffort: 'tiny' })

    // Provider-owned ids stay opaque here; unsupported values fail on the next model turn.
    await command('om_effort_opaque', '/effort 123456')
    await expect(request()).resolves.toMatchObject({ reasoningEffort: '123456' })

    await command('om_effort_bad', '/effort tiny high')
    expect(sessionEvents(agent.session).at(-1)).toMatchObject({
      type: 'command/done', data: { kind: 'error' },
    })
    await expect(request()).resolves.toMatchObject({ reasoningEffort: '123456' })

    await command('om_effort_reset', '/effort reset')
    await expect(request()).resolves.toMatchObject({ reasoningEffort: 'high' })
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('配置默认')
  })

  it('restores a successful Session effort override after restart', async () => {
    const agentsOptions: FakeAgentsOptions = {}
    const h = await setup({ reasoningEffort: 'high' }, {}, undefined, agentsOptions)
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_effort_restore', senderId: 'ou_owner',
      messageId: 'om_effort_restore_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const original = h.ctxState.agents.created[0]!.handle.agent
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_effort_restore', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_effort_restore_set', content: '/effort tiny',
    }))
    await waitUntil(() => expect(sessionEvents(original.session)).toHaveLength(2))
    agentsOptions.resumeSession = original.session
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registrations = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const onMessage = registrations.at(-1)?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_effort_restore', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_effort_restore_show', content: '/effort',
    }))
    await waitUntil(() => expect(h.ctxState.agents.resumed).toHaveLength(1))
    const resumed = h.ctxState.agents.resumed[0]!
    await waitUntil(() => expect(sessionEvents(resumed.handle.agent.session)).toHaveLength(4))
    expect(JSON.stringify((channel2.sent.at(-1) as { input: object }).input)).toContain('tiny')
    await expect(dispatchAgentRequest(resumed.setupCtx, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })).resolves.toMatchObject({ reasoningEffort: 'tiny' })
    await service2.shutdown()
  })

  it('executes routed /health through the command lifecycle and sends the health card', async () => {
    const h = await setup({}, {
      connectionStatus: { state: 'connected', lastConnectTime: 100, reconnectAttempts: 0 },
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_health_route', senderId: 'ou_owner',
      messageId: 'om_health_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    mock(agent.followup).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_health_route', senderId: 'ou_owner',
      threadId: 'omt_1', messageId: 'om_health_bound', mentionedBot: false, content: '/health',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(sessionEvents(agent.session).map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('整体结论：**healthy**')
  })

  it('denies a non-owner /history before resume, command execution, or Session enumeration', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_owned', senderId: 'ou_owner', messageId: 'om_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    mock(h.ctxState.ctx.commands.execute).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_owned', senderId: 'ou_intruder',
      threadId: 'omt_1', messageId: 'om_intruder', mentionedBot: false, content: '/history',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(mock(h.ctxState.ctx.commands.execute)).not.toHaveBeenCalled()
    expect(h.ctxState.agents.resumed).toHaveLength(0)
    expect(sessionEvents(agent.session)).toHaveLength(0)
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('无权操作此会话')
    expect(json).not.toContain(route.sessionId)
  })

  it('renders /status from the complete durable Session log without starting a model turn', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_status', senderId: 'ou_owner', messageId: 'om_status_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const events = sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>
    events.push(
      { type: 'request/header', seq: 1, time: 100, data: { header: { config: {
        provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
      } } } },
      { type: 'step/start', seq: 2, time: 1_000, data: { turn: 1, step: 1 } },
      // The live stream is embedded in the settlement since session format v2
      // (there is no durable `assistant/chunk` event any more).
      { type: 'assistant/message', seq: 3, time: 2_400, data: {
        turn: 1, step: 1, message: {},
        stream: [{ type: 'text-chunks', time0: 1_400, index: 0, dt: [], texts: ['a'] }],
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 },
      } },
      { type: 'tool/call', seq: 5, time: 2_500, data: {
        turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"secret":"value"}',
      } },
      { type: 'tool/result', seq: 6, time: 3_000, data: {
        turn: 1, step: 1,
        message: {
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, text: 'private-output' }],
        },
      } },
    )
    mock(agent.followup).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_status', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_status_command', content: '/status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('Session 状态')
    expect(json).toContain('deepseek-official/deepseek-v4-pro')
    expect(json).toContain('90.0%')
    expect(json).toContain('1,234 / 128,000')
    expect(json).toContain('bash')
    expect(json).not.toContain('secret')
    expect(json).not.toContain('private-output')
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(sessionEvents(agent.session).slice(-2).map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it('returns /workspace only when Session header and route agree', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir', senderId: 'ou_owner', messageId: 'om_workdir_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cwd = agent.session.header.cwd
    expect(cwd).toBeDefined()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_workspace_command', content: '/workspace',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain(cwd)
  })

  it('rejects a mismatched /workspace and logs no path values', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir_bad', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const header = agent.session.header as unknown as { cwd: string }
    const routePath = header.cwd
    header.cwd = '/different/private/workspace'

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir_bad', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_workspace_bad_command', content: '/workspace',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('工作目录不一致')
    expect(json).not.toContain('/different/private/workspace')
    expect(json).not.toContain(routePath)
    const warnings = mock(h.ctxState.ctx.logger?.warn).mock.calls.flat().join(' ')
    expect(warnings).toContain('paths redacted')
    expect(warnings).not.toContain('/different/private/workspace')
    expect(warnings).not.toContain(routePath)
  })

  it('runs native /compact once and renders before/after context bars', async () => {
    const h = await setup()
    let tokens = 99_840
    h.ctxState.ctx.tokenMeter.measure = vi.fn(() => ({ totalTokens: tokens }))
    h.ctxState.ctx.commands.register({
      name: 'compact', description: 'Compact older conversation history',
      handler: () => {
        tokens = 39_680
        return { kind: 'success', text: 'Compacted 9 history items (~60,160 tokens).' }
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
    })
    mock(agent.followup).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_compact_command', content: '/compact',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('████████░░')
    expect(json).toContain('███░░░░░░░')
    expect(json).toContain('60,160 tokens')
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(sessionEvents(agent.session).slice(-2).map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it('renders a native no-history /compact as a zero-release comparison', async () => {
    const h = await setup()
    h.ctxState.ctx.tokenMeter.measure = vi.fn(() => ({ totalTokens: 500 }))
    h.ctxState.ctx.commands.register({
      name: 'compact', description: 'Compact older conversation history',
      handler: () => ({ kind: 'success', text: 'No compactable history yet.' }),
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact_empty', senderId: 'ou_owner',
      messageId: 'om_compact_empty_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact_empty', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_compact_empty_command', content: '/compact',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('No compactable history yet.')
    expect(json).toContain('压缩前  500 tokens')
    expect(json).toContain('压缩后  500 tokens')
    expect(json).toContain('释放    0 tokens')
  })

  it.each([
    ['Compaction is unavailable because this process has an active compaction, or the agent is not idle.', '会话正忙'],
    ['Compaction cancelled.', '命令暂不可用'],
    ['backend unavailable', '命令暂不可用'],
  ])('preserves native /compact error %s and reports unchanged context', async (text, title) => {
    const h = await setup()
    h.ctxState.ctx.commands.register({
      name: 'compact', description: 'Compact older conversation history',
      handler: () => ({ kind: 'error', text }),
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact_error', senderId: 'ou_owner',
      messageId: 'om_compact_error_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact_error', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_compact_error_command', content: '/compact',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain(text)
    expect(json).toContain(title)
    expect(json).toContain('上下文保持不变')
  })

  it('reports a missing native /compact deployment without executing a command lifecycle', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_no_compact', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_no_compact', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/compact',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('未挂载 Harness 原生 /compact')
    expect(sessionEvents(agent.session)).toHaveLength(0)
  })

  it('renews the topic atomically, preserves history, and routes the next message only to the new Session', async () => {
    const h = await setup({}, {}, { defaultId: 'standard' })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew', senderId: 'ou_owner',
      messageId: 'om_renew_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const old = h.ctxState.agents.created[0]!
    let disposedAfterCommandDone = false
    mock(old.handle.dispose).mockImplementationOnce(async () => {
      disposedAfterCommandDone = sessionEvents(old.handle.agent.session).at(-1)?.type === 'command/done'
      h.ctxState.agents.liveAgents.delete(old.options.sessionId)
    })
    ;(sessionEvents(old.handle.agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'agent-preset/selected', seq: 0, time: 1, data: { agentPreset: 'minimal' },
    })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_renew_command', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(route.sessionId).toBe(renewed.options.sessionId)
    expect(route.sessionHistory?.map(entry => entry.sessionId)).toEqual([
      old.options.sessionId, renewed.options.sessionId,
    ])
    expect(renewed.options.meta).toMatchObject({
      cwd: route.workspacePath,
      agentPreset: 'minimal',
    })
    expect(renewed.options.agentOptions).toEqual(old.handle.agent.options)
    expect(mock(old.handle.dispose)).toHaveBeenCalledTimes(1)
    expect(disposedAfterCommandDone).toBe(true)
    expect(sessionEvents(old.handle.agent.session).slice(-2).map(event => event.type)).toEqual([
      'command/run', 'command/done',
    ])
    expect(sessionEvents(old.handle.agent.session).at(-1)).toMatchObject({
      type: 'command/done', data: { kind: 'success' },
    })
    const workspace = h.ctxState.workspaces.workspaces.get(route.workspacePath)!
    expect(mock(workspace.attachSession)).toHaveBeenLastCalledWith(renewed.options.sessionId)

    const resultCard = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(resultCard).toContain(old.options.sessionId)
    expect(resultCard).toContain(renewed.options.sessionId)
    expect(resultCard).toContain(route.workspacePath)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_after_renew', content: '只进入新会话',
    }))
    await waitUntil(() => expect(mock(renewed.handle.agent.followup)).toHaveBeenCalledTimes(1))
    expect(mock(old.handle.agent.followup)).toHaveBeenCalledTimes(1)
  })

  it.each(['running', 'next-turn', 'next-step'] as const)(
    'rejects /renew while the old Agent has %s work without creating a Session',
    async busyKind => {
      const h = await setup()
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_renew_busy', senderId: 'ou_owner', content: '开始',
      }))
      await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
      const agent = h.ctxState.agents.created[0]!.handle.agent
      if (busyKind === 'running') Object.defineProperty(agent, 'status', { value: 'running' })
      if (busyKind === 'next-turn') (agent.inbox.nextTurn as unknown[]).push({ queued: true })
      if (busyKind === 'next-step') (agent.inbox.nextStep as unknown[]).push({ queued: true })

      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_renew_busy', senderId: 'ou_owner', threadId: 'omt_1',
        mentionedBot: false, content: '/renew',
      }))
      await waitUntil(() => expect(sessionEvents(agent.session).at(-1)).toMatchObject({
        type: 'command/done', data: { kind: 'error' },
      }))

      expect(h.ctxState.agents.created).toHaveLength(1)
      expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('会话正忙')
      expect(sessionEvents(agent.session).at(-1)).toMatchObject({
        type: 'command/done', data: { kind: 'error' },
      })
      expect(mock(h.ctxState.agents.created[0]!.handle.dispose)).not.toHaveBeenCalled()
    },
  )

  it('rolls back a failed renewed Agent creation and keeps the old route live', async () => {
    const agentsOptions: FakeAgentsOptions = {}
    const h = await setup({}, {}, undefined, agentsOptions)
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_create_fail', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const old = h.ctxState.agents.created[0]!
    agentsOptions.failCreate = new Error('simulated renewed create failure')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_create_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(sessionEvents(old.handle.agent.session).at(-1)).toMatchObject({
      type: 'command/done', data: { kind: 'error' },
    }))

    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(route.sessionId).toBe(old.options.sessionId)
    expect(h.ctxState.agents.created).toHaveLength(1)
    expect(mock(old.handle.dispose)).not.toHaveBeenCalled()
    expect(sessionEvents(old.handle.agent.session).at(-1)).toMatchObject({
      type: 'command/done', data: { kind: 'error' },
    })
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('原 Session 仍保持绑定')
  })

  it('rolls back workspace attachment and the new handle when route commit fails', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_route_fail', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const old = h.ctxState.agents.created[0]!
    mock(h.ctxState.domain.raw.table('routes').put).mockRejectedValueOnce(new Error('route write failed'))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_route_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const failed = h.ctxState.agents.created[1]!
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    const workspace = h.ctxState.workspaces.workspaces.get(route.workspacePath)!
    expect(route.sessionId).toBe(old.options.sessionId)
    expect(mock(failed.handle.dispose)).toHaveBeenCalledTimes(1)
    expect(mock(workspace.detachSession)).toHaveBeenCalledWith(failed.options.sessionId)
    expect(mock(old.handle.dispose)).not.toHaveBeenCalled()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_route_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '仍进入旧会话',
    }))
    await waitUntil(() => expect(mock(old.handle.agent.followup)).toHaveBeenCalledTimes(2))
  })

  it('keeps the renewed route usable when both result-card deliveries fail', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_card_fail', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const old = h.ctxState.agents.created[0]!
    h.channel.send = vi.fn(async () => { throw new Error('result delivery failed') })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_card_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(route.sessionId).toBe(renewed.options.sessionId)
    expect(mock(old.handle.dispose)).toHaveBeenCalledTimes(1)
    expect(h.ctxState.agents.liveAgents.get(renewed.options.sessionId)?.agent).toBe(renewed.handle.agent)
  })

  it('resumes the renewed Session with complete history after a restart', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_restart', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const oldSessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_restart', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    const renewedSessionId = h.ctxState.agents.created[1]!.options.sessionId
    await h.service.shutdown()

    const channel = makeChannel()
    const service = new FeishuService(h.ctxState.ctx, h.config, () => channel)
    await service.start()
    const handlers = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const onMessage = handlers.at(-1)?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_restart', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '重启后继续',
    }))
    await waitUntil(() => expect(h.ctxState.agents.resumed).toHaveLength(1))

    expect(h.ctxState.agents.resumed[0]!.options.resumeSessionId).toBe(renewedSessionId)
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(route.sessionHistory?.map(entry => entry.sessionId)).toEqual([oldSessionId, renewedSessionId])
    await service.shutdown()
  })

  it('renders newest-first /history consistently across restart without resuming historical Agents', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'ou_owner',
      messageId: 'om_history_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const firstSessionId = h.ctxState.agents.created[0]!.options.sessionId

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_history_renew_1', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    const secondSessionId = h.ctxState.agents.created[1]!.options.sessionId
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_history_renew_2', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(3))
    const current = h.ctxState.agents.created[2]!
    const currentSessionId = current.options.sessionId

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_history_before_restart', content: '/history',
    }))
    await waitUntil(() => expect(sessionEvents(current.handle.agent.session).at(-1)).toMatchObject({
      type: 'command/done', data: { kind: 'success' },
    }))

    const beforeRestart = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(beforeRestart).toContain('Session 历史')
    expect(beforeRestart).toContain('**总数**：3')
    expect(beforeRestart).toContain('**当前**')
    expect(beforeRestart.indexOf(currentSessionId)).toBeLessThan(beforeRestart.indexOf(secondSessionId))
    expect(beforeRestart.indexOf(secondSessionId)).toBeLessThan(beforeRestart.indexOf(firstSessionId))
    expect(mock(current.handle.agent.followup)).not.toHaveBeenCalled()
    expect(h.ctxState.agents.resumed).toHaveLength(0)

    await h.service.shutdown()
    const channel = makeChannel()
    const service = new FeishuService(h.ctxState.ctx, h.config, () => channel)
    await service.start()
    const handlers = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const onMessage = handlers.at(-1)?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_history_after_restart', content: '/history',
    }))
    await waitUntil(() => expect(channel.sent).toHaveLength(1))

    const afterRestart = JSON.stringify((channel.sent[0] as { input: object }).input)
    expect(afterRestart).toBe(beforeRestart)
    expect(h.ctxState.agents.resumed).toHaveLength(1)
    expect(h.ctxState.agents.resumed[0]!.options.resumeSessionId).toBe(currentSessionId)
    expect(h.ctxState.agents.resumed.some(entry => entry.options.resumeSessionId === firstSessionId)).toBe(false)
    expect(h.ctxState.agents.resumed.some(entry => entry.options.resumeSessionId === secondSessionId)).toBe(false)
    await service.shutdown()
  })

  it('exports one post-command logical snapshot to the owner topic and deduplicates redelivery', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export', senderId: 'ou_owner',
      messageId: 'om_export_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'turn/end', seq: 41, time: 1_000, data: { turn: 1, reason: 'complete' },
    })
    mock(agent.followup).mockClear()

    const command = makeMessage({
      chatType: 'group', chatId: 'oc_export', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_export_command', content: '/export',
    })
    await h.onMessage(command)
    await h.onMessage(command)
    await waitUntil(() => expect((h.channel.sent as Array<{ input: object }>).filter(
      entry => 'file' in entry.input,
    )).toHaveLength(1))

    const fileSends = (h.channel.sent as Array<{
      chatId: string
      input: { file?: { source: Buffer; fileName: string } }
      options?: { replyTo?: string; replyInThread?: boolean }
    }>).filter(entry => entry.input.file !== undefined)
    expect(fileSends).toHaveLength(1)
    const delivery = fileSends[0]!
    expect(delivery.chatId).toBe('oc_export')
    expect(delivery.options).toEqual({ replyTo: 'om_export_command', replyInThread: true })
    expect(delivery.input.file?.fileName).toBe(`dsh-session-${agent.session.id}.logical.jsonl.gz`)

    const jsonl = (await gunzipBuffer(delivery.input.file!.source)).toString('utf8').trimEnd()
    const lines = jsonl.split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({
      format: 'dsh-logical-session-jsonl', formatVersion: 1, logical: true,
      includes: { descendants: false, attachments: false, rawArtifacts: false },
      session: { id: agent.session.id, header: agent.session.header },
    })
    expect(lines.slice(1)).toEqual(sessionEvents(agent.session))
    expect(lines.slice(-2).map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(lines.at(-1)).toMatchObject({ type: 'command/done', data: { kind: 'success' } })
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(mock(h.ctxState.ctx.commands.execute)).toHaveBeenCalledTimes(1)
  })

  it('rejects /export arguments without sending a file', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_args', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_args', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_export_args', content: '/export extra',
    }))
    await waitUntil(() => expect(sessionEvents(agent.session).at(-1)).toMatchObject({
      type: 'command/done', data: { kind: 'error' },
    }))

    expect((h.channel.sent as Array<{ input: object }>).some(entry => 'file' in entry.input)).toBe(false)
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('命令格式不正确')
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('/export 不接受参数')
  })

  it('denies a non-owner /export before Session I/O and does not leak a file or Session id', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_owned', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    mock(h.ctxState.ctx.commands.execute).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_owned', senderId: 'ou_intruder', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_export_intruder', content: '/export',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(mock(h.ctxState.ctx.commands.execute)).not.toHaveBeenCalled()
    expect(sessionEvents(agent.session)).toHaveLength(0)
    expect((h.channel.sent as Array<{ input: object }>).some(entry => 'file' in entry.input)).toBe(false)
    const card = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(card).toContain('无权操作此会话')
    expect(card).not.toContain(agent.session.id)
  })

  it('reports gzip/serialization failure as an error card without claiming file delivery', async () => {
    const buildFailure = vi.fn<SessionExportBuilder>(async () => {
      throw new Error('simulated gzip failure')
    })
    const h = await setup({}, {}, undefined, {}, buildFailure)
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_gzip_fail', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_gzip_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_export_gzip_fail', content: '/export',
    }))
    await waitUntil(() => expect(buildFailure).toHaveBeenCalledTimes(1))

    expect(sessionEvents(agent.session).slice(-2).map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect((h.channel.sent as Array<{ input: object }>).some(entry => 'file' in entry.input)).toBe(false)
    const card = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(card).toContain('导出失败，未交付文件')
    expect(card).not.toContain('导出已请求')
    expect(card).not.toContain('simulated gzip failure')
  })

  it('attempts one file send and reports a Feishu upload failure separately', async () => {
    const h = await setup({}, { failFileSends: true })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_upload_fail', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_upload_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_export_upload_fail', content: '/export',
    }))
    await waitUntil(() => expect(JSON.stringify(h.channel.sent)).toContain('导出失败，未交付文件'))

    const fileAttempts = mock(h.channel.send).mock.calls.filter(call => {
      const input = call[1] as object
      return 'file' in input
    })
    expect(fileAttempts).toHaveLength(1)
    expect((h.channel.sent as Array<{ input: object }>).some(entry => 'file' in entry.input)).toBe(false)
    const card = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(card).toContain('命令执行失败')
    expect(card).toContain('未交付文件')
    expect(card).not.toContain('file upload failed')
  })

  // ---- SC-10 command-plane concurrency and recovery ---------------------

  it('serializes a routed command ahead of a concurrent ordinary message', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_serial', senderId: 'ou_owner',
      messageId: 'om_command_serial_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    mock(agent.followup).mockClear()

    const originalExecute = h.ctxState.ctx.commands.execute
    let releaseCommand: () => void = () => {}
    const commandGate = new Promise<void>(resolve => { releaseCommand = resolve })
    let markCommandStarted: () => void = () => {}
    const commandStarted = new Promise<void>(resolve => { markCommandStarted = resolve })
    mock(originalExecute).mockImplementationOnce(async (...args: Parameters<typeof originalExecute>) => {
      markCommandStarted()
      await commandGate
      return await originalExecute(...args)
    })

    const command = h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_serial', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_command_serial_status', content: '/status',
    }))
    await commandStarted
    const ordinary = h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_serial', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_command_serial_turn', content: '排在命令之后',
    }))
    await flush()

    expect(mock(agent.followup)).not.toHaveBeenCalled()
    expect(h.channel.sent).toHaveLength(1)

    releaseCommand()
    await Promise.all([command, ordinary])
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(1))

    expect(mock(agent.followup)).toHaveBeenCalledTimes(1)
    expect((mock(agent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> })
      .content[0]?.text).toBe('排在命令之后')
    expect(JSON.stringify((h.channel.sent[1] as { input: object }).input)).toContain('Session 状态')
    expect(h.channel.sent[2]).toMatchObject({
      options: { replyTo: 'om_command_serial_turn', replyInThread: true },
    })
  })

  it('deduplicates concurrent redelivery of /renew before any route side effect repeats', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_redelivery', senderId: 'ou_owner',
      messageId: 'om_renew_redelivery_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const old = h.ctxState.agents.created[0]!
    mock(h.ctxState.ctx.commands.execute).mockClear()

    const redelivery = makeMessage({
      chatType: 'group', chatId: 'oc_renew_redelivery', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_renew_redelivery_command', content: '/renew',
    })
    await Promise.all([h.onMessage(redelivery), h.onMessage(redelivery)])
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(h.ctxState.agents.created).toHaveLength(2)
    expect(mock(h.ctxState.ctx.commands.execute)).toHaveBeenCalledTimes(1)
    expect(mock(old.handle.dispose)).toHaveBeenCalledTimes(1)
    expect(route.sessionHistory).toHaveLength(2)
    expect(new Set(route.sessionHistory?.map(entry => entry.sessionId)).size).toBe(2)
  })

  it('aborts an in-flight command during shutdown without sending a late result card', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_shutdown', senderId: 'ou_owner',
      messageId: 'om_command_shutdown_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    let commandSignal: AbortSignal | undefined
    let markCommandStarted: () => void = () => {}
    const commandStarted = new Promise<void>(resolve => { markCommandStarted = resolve })
    mock(h.ctxState.ctx.commands.execute).mockImplementationOnce(async (_agent, _line, _images, signal) => {
      commandSignal = signal
      markCommandStarted()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return undefined
    })

    const command = h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_shutdown', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_command_shutdown_status', content: '/status',
    }))
    await commandStarted
    await h.service.shutdown()
    await expect(command).resolves.toBeUndefined()
    expect(h.channel.reactions).toContainEqual({
      messageId: 'om_command_shutdown_status', emojiType: 'DONE',
    })

    expect(commandSignal?.aborted).toBe(true)
    expect(h.channel.sent).toHaveLength(1)
    expect(JSON.stringify(h.channel.sent)).not.toContain('命令执行失败')
    expect(JSON.stringify(h.channel.sent)).not.toContain('处理失败')
  })

  it('keeps standalone command cards out of TurnStreamer and restart repair state', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_isolation', senderId: 'ou_owner',
      messageId: 'om_command_isolation_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!
    listener(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
    const streamedPatchCount = h.channel.updated.length

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_isolation', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_command_isolation_status', content: '/status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(inflightEntries(h)).toHaveLength(0)
    expect(h.channel.updated).toHaveLength(streamedPatchCount)
    expect(mock(agent.followup)).toHaveBeenCalledTimes(1)

    await h.service.shutdown()
    const channel = makeChannel()
    const service = new FeishuService(h.ctxState.ctx, h.config, () => channel)
    await service.start()
    await flush()
    expect(channel.updated).toHaveLength(0)
    await service.shutdown()
  })

  it('renews through a borrowed external Agent without disposing its owner handle', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_borrowed', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    await h.service.shutdown()

    const foreignDispose = vi.fn(async () => {})
    const foreignAgent = makeAgent(makeSession(route.sessionId, route.workspacePath), {
      provider: 'borrowed-provider', model: 'borrowed-model',
    })
    h.ctxState.agents.liveAgents.set(route.sessionId, { agent: foreignAgent, dispose: foreignDispose })

    const channel = makeChannel()
    const service = new FeishuService(h.ctxState.ctx, h.config, () => channel)
    await service.start()
    const handlers = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const onMessage = handlers.at(-1)?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_borrowed', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    expect(renewed.options.agentOptions).toEqual(foreignAgent.options)
    expect((h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord).sessionId)
      .toBe(renewed.options.sessionId)
    expect(foreignDispose).not.toHaveBeenCalled()
    await service.shutdown()
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
    const h = await setup({ reasoningEffort: 'tiny' }, {}, { reasoningEffort: 'high' })
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
    expect(created.options.agentOptions).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await expect(dispatchAgentRequest(created.setupCtx, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })).resolves.toMatchObject({ reasoningEffort: 'tiny' })

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

  it('borrows a live agent, prepends the configured effort, and releases only that policy', async () => {
    const h = await setup({ reasoningEffort: 'tiny' })
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: 'hello' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.service.shutdown()

    // The session stays live under a foreign owner (e.g. the web UI's
    // api-remote resolver resumed it right after the restart).
    const foreignAgent = makeAgent(makeSession(sessionId))
    foreignAgent.ctx.on('agent/request', async (_payload, next) => ({
      ...(await next()),
      reasoningEffort: 'high',
    }))
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
    await expect(dispatchAgentRequest(foreignAgent.ctx, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })).resolves.toMatchObject({ reasoningEffort: 'tiny' })

    // The reply card still lands in the topic as usual.
    const sends = channel2.sent as Array<{ options?: { replyInThread?: boolean } }>
    expect(sends[0]?.options?.replyInThread).toBe(true)

    // Borrowed ≠ owned: shutdown must not dispose the foreign owner's agent.
    await service2.shutdown()
    expect(foreignDispose).not.toHaveBeenCalled()
    await expect(dispatchAgentRequest(foreignAgent.ctx, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })).resolves.toMatchObject({ reasoningEffort: 'high' })
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

  it('routes a failed follow-up to a failure card and No without reusing the prior effort', async () => {
    const h = await setup()
    const first = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice',
      messageId: 'om_first_trigger', content: '第一轮',
    })
    await h.onMessage(first)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!
    listener(agent.session, {
      type: 'request/header', seq: 1,
      data: { header: { config: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'high',
      } } },
    })
    listener(agent.session, {
      type: 'assistant/message', seq: 2,
      data: {
        turn: 1, step: 1, message: {},
        usage: { inputTokens: 91, outputTokens: 89, cacheReadTokens: 20 },
      },
    })
    listener(agent.session, {
      type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } },
    })
    await waitUntil(() => expect(h.channel.reactions).toContainEqual({
      messageId: 'om_first_trigger', emojiType: 'DONE',
    }))

    const second = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice',
      threadId: 'omt_1', messageId: 'om_failed_trigger', content: '第二轮',
    })
    await h.onMessage(second)
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))

    listener(agent.session, {
      type: 'turn/end',
      seq: 4,
      data: {
        turn: 2,
        reason: {
          kind: 'error',
          error: {
            message: 'does not support reasoning effort "tiny"',
            code: 'UNSUPPORTED_REASONING_EFFORT',
          },
        },
      },
    })
    await waitUntil(() => expect(h.channel.reactions).toContainEqual({
      messageId: 'om_failed_trigger', emojiType: 'No',
    }))

    const failedCard = JSON.stringify((h.channel.updated.at(-1) as { card: object }).card)
    expect(failedCard).toContain('回复失败')
    expect(failedCard).toContain('UNSUPPORTED_REASONING_EFFORT')
    expect(failedCard).toContain('模型 —')
    expect(failedCard).not.toContain('(high)')
    expect(h.channel.reactions).not.toContainEqual({
      messageId: 'om_failed_trigger', emojiType: 'DONE',
    })
  })

  it('sends oversized body segments as continuation cards inside the topic', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '长文' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!
    const huge = 'x'.repeat(30_000)
    h.ctxState.assistantStreamListeners[0]!({ agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: huge } } })
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
    h.ctxState.assistantStreamListeners[0]!({ agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } } })
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
    h.ctxState.assistantStreamListeners[0]!({ agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } } })
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
        h.ctxState.assistantStreamListeners[0]!({ agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } } })
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
    partial: Partial<RouteRecord> = {},
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
      ...partial,
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
    expect([...(ctxState.domain.raw.table('expired_routes').entries() as IterableIterator<[string, unknown]>)]).toEqual([
      ['omt_stale', expect.objectContaining({ key: 'omt_stale', chatId: 'oc_test_chat' })],
    ])
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

  it('persists a tombstone and rejects messages in a GC-d topic without creating a Session', async () => {
    const ctxState = makeHostContext()
    await seedRoute(ctxState.domain.raw, 'omt_gc', Date.now() - 40 * DAY_MS)
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 30 * DAY_MS }), () => channel)
    await service.start()
    await waitUntil(() =>
      expect([...(ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(0))
    expect([...(ctxState.domain.raw.table('expired_routes').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(1)
    await service.shutdown()

    // A fresh service instance must load the tombstone from storage; this is
    // what prevents a process restart from re-enabling the old topic.
    const restartedChannel = makeChannel()
    const restarted = new FeishuService(
      ctxState.ctx,
      makeConfig({ routeTtlMs: 30 * DAY_MS }),
      () => restartedChannel,
    )
    await restarted.start()

    const registered = (restartedChannel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'ou_alice', content: '重新开始', threadId: 'omt_gc' }))

    await waitUntil(() => expect(restartedChannel.sent).toHaveLength(1))
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)
    expect(restartedChannel.sent).toHaveLength(1)
    expect(JSON.stringify(restartedChannel.sent[0]!.input)).toContain('话题已过期')
    expect(JSON.stringify(restartedChannel.sent[0]!.input)).toContain('不会在此话题创建新 Session')
    await restarted.shutdown()
  })

  it('retires an overdue topic at message admission before the periodic GC runs again', async () => {
    const ctxState = makeHostContext()
    const routeTtlMs = 100
    await seedRoute(ctxState.domain.raw, 'omt_admission_ttl', Date.now())
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs }), () => channel)
    await service.start()
    // The startup sweep saw a fresh route. Crossing TTL afterwards exercises
    // the per-message deadline check rather than the six-hour timer.
    await new Promise(resolve => setTimeout(resolve, routeTtlMs + 25))
    const registered = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'ou_test_user',
      content: '继续', threadId: 'omt_admission_ttl', mentionedBot: false,
    }))

    await waitUntil(() => expect(channel.sent).toHaveLength(1))
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)
    expect(JSON.stringify(channel.sent[0]!.input)).toContain('话题已过期')
    expect([...(ctxState.domain.raw.table('expired_routes').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(1)
    await service.shutdown()
  })

  it('rejects Session commands in an expired topic before Agent resume', async () => {
    const ctxState = makeHostContext()
    await ctxState.domain.raw.table('expired_routes').put('omt_expired_cmd', {
      key: 'omt_expired_cmd',
      chatId: 'oc_test_chat',
      chatType: 'group',
      senderOpenId: 'ou_test_user',
      expiredAt: Date.now(),
    })
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig(), () => channel)
    await service.start()
    const registered = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'ou_test_user',
      content: '/status', threadId: 'omt_expired_cmd', mentionedBot: false,
    }))

    await waitUntil(() => expect(channel.sent).toHaveLength(1))
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)
    expect(JSON.stringify(channel.sent[0]!.input)).toContain('话题已过期')

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'ou_test_user',
      content: '/health', threadId: 'omt_expired_cmd', mentionedBot: false,
      messageId: 'om_expired_health',
    }))
    await waitUntil(() => expect(channel.sent).toHaveLength(2))
    expect(JSON.stringify(channel.sent[1]!.input)).toContain('健康检查')
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'ou_test_user',
      content: '/help', threadId: 'omt_expired_cmd', mentionedBot: false,
      messageId: 'om_expired_help',
    }))
    await waitUntil(() => expect(channel.sent).toHaveLength(3))
    expect(JSON.stringify(channel.sent[2]!.input)).toContain('斜杠命令帮助')
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)
    await service.shutdown()
  })

  it('deletes an expired degraded chat route without creating a thread tombstone', async () => {
    const ctxState = makeHostContext()
    await seedRoute(ctxState.domain.raw, 'chat:p2p:oc_p2p:ou_alice', Date.now() - 40 * DAY_MS, {
      key: 'chat:p2p:oc_p2p:ou_alice',
      kind: 'chat',
      chatId: 'oc_p2p',
      chatType: 'p2p',
      senderOpenId: 'ou_alice',
    })
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig({ routeTtlMs: 30 * DAY_MS }), () => channel)
    await service.start()

    await waitUntil(() =>
      expect([...(ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(0))
    expect([...(ctxState.domain.raw.table('expired_routes').entries() as IterableIterator<[string, unknown]>)]).toHaveLength(0)
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

describe('/stop, structured questions, and host projections', () => {
  it('registers a prepend user-questions answerer and routes card actions to it', async () => {
    const h = await setup()
    expect(h.ctxState.questionListeners).toHaveLength(1)
    expect(h.ctxState.questionListeners[0]!.options).toEqual({ prepend: true })
    expect(h.channel.cardActionHandlers).toHaveLength(1)
    await h.service.shutdown()
  })

  it('answers a routed session\'s ask_user_question through a card, owner-gated', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_questions', senderId: 'ou_owner', content: '问一下',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.questionListeners[0]!
    const next = vi.fn(async () => ({ answers: [] }))
    const pending = listener({
      questions: [{
        id: 'q1', question: '今天吃什么？',
        options: [{ label: '面' }, { label: '饭' }],
      }],
      agent,
    }, next)

    await waitUntil(() => expect(h.channel.sent.some(s =>
      'card' in ((s as { input: object }).input)
      && JSON.stringify(((s as { input: { card: object } }).input.card)).includes('需要你的回答'),
    )).toBe(true))
    const index = h.channel.sent.findIndex(s =>
      'card' in ((s as { input: object }).input)
      && JSON.stringify(((s as { input: { card: object } }).input.card)).includes('需要你的回答'),
    )
    const messageId = `om_${index + 1}`
    const card = (h.channel.sent[index] as { input: { card: object } }).input.card
    const button = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements
      .find(element => element.tag === 'button'
        && (element.text as { content?: string } | undefined)?.content === '面')
    expect(button).toBeDefined()
    expect(next).not.toHaveBeenCalled()

    // A stranger's click is ignored (and notes the owner-only rule).
    const value = (button!.behaviors as Array<{ value: unknown }>)[0]!.value
    await h.channel.fireCardAction({
      messageId, chatId: 'oc_questions',
      operator: { openId: 'ou_stranger' },
      action: { value, tag: 'button' },
    })
    await flush()
    expect(h.channel.updated.some(update =>
      (update as { messageId: string }).messageId === messageId
      && JSON.stringify((update as { card: object }).card).includes('仅发起该会话的用户'),
    )).toBe(true)

    await h.channel.fireCardAction({
      messageId, chatId: 'oc_questions',
      operator: { openId: 'ou_owner' },
      action: { value, tag: 'button' },
    })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['面'] }] })
    await waitUntil(() => expect(h.channel.updated.some(update =>
      (update as { messageId: string }).messageId === messageId
      && JSON.stringify((update as { card: object }).card).includes('已回答'),
    )).toBe(true))
    await h.service.shutdown()
  })

  it('delegates user questions for sessions the channel does not route', async () => {
    const h = await setup()
    const { listener } = h.ctxState.questionListeners[0]!
    const foreign = makeAgent(makeSession('sess-question-foreign'))
    const next = vi.fn(async () => ({ answers: [{ id: 'q', selected: [] }] }))
    await expect(listener({ questions: [{ id: 'q', question: '?', options: [{ label: 'x' }] }], agent: foreign }, next))
      .resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
    expect(next).toHaveBeenCalled()
    expect(h.channel.sent).toHaveLength(0)
    await h.service.shutdown()
  })

  it('withdraws in-flight structured questions on shutdown', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_q_shutdown', senderId: 'ou_owner', content: '先问后关',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.questionListeners[0]!
    const pending = listener({
      questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }],
      agent,
    }, vi.fn(async () => ({ answers: [] })))
    await waitUntil(() => expect(h.channel.sent.length).toBe(2))
    await h.service.shutdown()
    await expect(pending).rejects.toThrow('插件已关闭')
  })

  it('cancels the running turn on /stop without starting a model turn', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop', senderId: 'ou_owner', messageId: 'om_stop_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cancel = vi.fn()
    ;(agent as unknown as { status: string }).status = 'running'
    ;(agent as unknown as { cancel: unknown }).cancel = cancel
    mock(agent.followup).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_stop_command', content: '/stop',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(cancel).toHaveBeenCalledWith({ kind: 'user' })
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('已请求停止当前回合')
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    // `/stop` is channel-plane: it must not cold-resume anything either.
    expect(h.ctxState.agents.resumed).toHaveLength(0)
    await h.service.shutdown()
  })

  it('reports /stop as a no-op when no turn is running', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop_idle', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cancel = vi.fn()
    ;(agent as unknown as { cancel: unknown }).cancel = cancel

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop_idle', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_stop_idle_command', content: '/stop',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('当前没有正在运行的回合')
    await h.service.shutdown()
  })

  it('renders card tokens from host projections when mounted', async () => {
    const projections: SessionProjections = {
      stateOf: (_session, key) => {
        if (key === 'tokenUsage') {
          return {
            totals: { uncachedInputTokens: 4_242, outputTokens: 777, cacheReadTokens: 0, cacheWriteTokens: 0 },
            last: { turn: 1, step: 1, buckets: { uncachedInputTokens: 4_242, outputTokens: 777, cacheReadTokens: 0, cacheWriteTokens: 0 } },
          }
        }
        if (key === 'contextPressure') return { contextWindow: 64_000 }
        return undefined
      },
    }
    const h = await setup({}, {}, undefined, {}, undefined, projections)
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_proj', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    // The window is turn-scoped on the card: a request header must exist for
    // this turn before the model line is rendered at all.
    h.ctxState.sessionListeners[0]!(agent.session, {
      type: 'request/header', seq: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
    })
    h.ctxState.assistantStreamListeners[0]!({
      agent,
      frame: {
        type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hi' },
      },
    })
    await waitUntil(() => {
      const json = JSON.stringify(h.channel.updated.map(update => (update as { card: object }).card))
      expect(json).toContain('4,242')
      expect(json).toContain('777')
      expect(json).toContain('64,000')
    })
    await h.service.shutdown()
  })

  it('drives the streamed card from agent/assistant-stream events', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stream', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    h.ctxState.assistantStreamListeners[0]!({
      agent,
      frame: {
        type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
        chunk: { type: 'text-delta', index: 0, text: '流式正文' },
      },
    })
    await waitUntil(() => {
      const json = JSON.stringify(h.channel.updated.map(update => (update as { card: object }).card))
      expect(json).toContain('流式正文')
    })
    await h.service.shutdown()
  })
})

describe('command registry dispatch', () => {
  it('resolves the /new alias to /renew end to end', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_alias', senderId: 'ou_owner',
      messageId: 'om_alias_start', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const old = h.ctxState.agents.created[0]!

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_alias', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_alias_new', content: '/new',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(route.sessionId).toBe(renewed.options.sessionId)
    // The alias executes the canonical command on the agent plane.
    expect(sessionEvents(old.handle.agent.session).slice(-2).map(event => event.type))
      .toEqual(['command/run', 'command/done'])
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('Session 已续建')
    await h.service.shutdown()
  })

  it('rejects an unknown command with the registry-derived supported list', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_unknown', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_unknown', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_unknown_cmd', content: '/nope',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('未找到命令 /nope')
    expect(json).toContain('/userid')
    await h.service.shutdown()
  })
})

describe('free-text question answers', () => {
  it('routes a plain reply into a pending structured question', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_qtext', senderId: 'ou_owner', content: '问一下',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.questionListeners[0]!
    const pending = listener({
      questions: [{ id: 'q1', question: '自由文本？' }],
      agent,
    }, vi.fn(async () => ({ answers: [] })))
    await waitUntil(() => expect(h.channel.sent.length).toBe(2))
    mock(agent.followup).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_qtext', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_qtext_answer', content: '这是答案',
    }))
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '这是答案' }],
    })
    // The answer is acknowledged without starting a model turn.
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    await waitUntil(() => expect(JSON.stringify(
      (h.channel.sent.at(-1) as { input: object }).input,
    )).toContain('已记录你的文字回答'))
    await h.service.shutdown()
  })
})

describe('/permissions and /status extras', () => {
  it('shows the current permission preset and the catalog read-only by default', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_perm_view', content: '/permissions',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('当前权限预设')
    expect(json).toContain('standard')
    expect(json).toContain('read-only')
    expect(json).toContain('仅支持查看')

    // Switching is refused while the deployment keeps the gate closed.
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_perm_set', content: '/permissions read-only',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(3))
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('未开启飞书侧权限切换')
    expect(h.ctxState.permissions.set).not.toHaveBeenCalled()
    await h.service.shutdown()
  })

  it('switches the permission preset when the deployment opts in', async () => {
    const h = await setup({ allowPermissionSwitch: true })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm_on', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm_on', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_perm_switch', content: '/permissions read-only',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(h.ctxState.permissions.set).toHaveBeenCalledWith(agent.session, 'read-only')
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('权限预设已切换')
    await h.service.shutdown()
  })

  it('renders permission/workspace/uptime extras on /status', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_status_extra', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord | undefined

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_status_extra', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_status_extra', content: '/status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('权限预设')
    expect(json).toContain('工作区')
    expect(json).toContain('插件运行时长')
    expect(route?.workspacePath).toBeDefined()
    await h.service.shutdown()
  })
})

describe('first-contact onboarding', () => {
  it('sends the onboarding card once per private chat and persists it', async () => {
    const h = await setup({ welcomeOnboarding: true })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_welcome', senderId: 'ou_new', messageId: 'om_w1', content: '你好',
    }))
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))

    const welcomes = () => h.channel.sent.filter(entry =>
      JSON.stringify((entry as { input: object }).input).includes('欢迎使用飞书 DSH'))
    expect(welcomes()).toHaveLength(1)
    const global = h.ctxState.domain.raw.global.get() as { welcomedChats?: string[] }
    expect(global.welcomedChats).toContain('oc_welcome')

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_welcome', senderId: 'ou_new', threadId: 'omt_1',
      messageId: 'om_w2', content: '再来一条',
    }))
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(3))
    expect(welcomes()).toHaveLength(1)
    await h.service.shutdown()
  })
})

describe('/model', () => {
  it('shows the current model and the advertised catalog', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_view', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_view', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_model_view', content: '/model',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('当前模型')
    expect(json).toContain('deepseek-v4-flash')
    expect(json).toContain('deepseek-v4-pro')
    await h.service.shutdown()
  })

  it('switches the model for subsequent requests', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_set', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const created = h.ctxState.agents.created[0]!
    const agent = created.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_set', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_model_set', content: '/model deepseek-v4-pro',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('已切换为')
    expect(sessionEvents(agent.session).slice(-2).map(event => event.type))
      .toEqual(['command/run', 'command/done'])

    // The persisted policy reaches the next model request.
    await expect(dispatchAgentRequest(created.setupCtx, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }))
      .resolves.toMatchObject({ model: 'deepseek-v4-pro' })
    await h.service.shutdown()
  })

  it('rejects a model the provider does not advertise', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_bad', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_bad', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_model_bad', content: '/model nope-model',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('未提供模型')
    expect(json).toContain('deepseek-v4-pro')
    await h.service.shutdown()
  })
})

describe('inbound attachments', () => {
  it('registers the attachment guidance with the session workspace path', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_guide', senderId: 'ou_owner',
      messageId: 'om_guide', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    const sections = promptSectionsOf(h.ctxState.agents.created[0]!.setupCtx)
    const guidance = sections.find(section => section.name === FEISHU_ATTACHMENTS_SECTION)
    expect(guidance?.text).toContain(`${record.workspacePath}/attachments/`)
    await h.service.shutdown()
  })

  it('archives an image-only message into the workspace without starting a turn', async () => {
    const h = await setup({}, {
      downloadResource: () => [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_image', senderId: 'ou_owner', messageId: 'om_image',
      content: '![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }))

    const dir = path.join(h.config.baseDir, 'groups', 'oc_image', 'ou_owner', 'attachments')
    const finalFiles = () => readdirSync(dir).filter(name => !name.startsWith('.tmp-'))
    await waitUntil(() => expect(finalFiles()).toHaveLength(1))
    const [name] = finalFiles()
    expect(name).toMatch(/\.png$/)
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.reactions).toEqual([{ messageId: 'om_image', emojiType: 'DONE' }])
    await h.service.shutdown()
  })

  it('archives a file message and keeps a following caption as the only prompt text', async () => {
    const h = await setup({}, {
      downloadResource: (_messageId, fileKey) => [new TextEncoder().encode(`bytes:${fileKey}`)],
    })
    const chatId = 'oc_file_chat'
    const senderId = 'ou_owner'
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, messageId: 'om_file',
      content: '<file key="file_1" name="report.pdf"/>',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'report.pdf' }] as never,
    }))
    const dir = path.join(h.config.baseDir, 'groups', chatId, senderId, 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))[0]).toMatch(/report\.pdf$/)
    expect(h.ctxState.agents.created).toHaveLength(0)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, messageId: 'om_prompt',
      content: '看 report.pdf 的第一页',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const message = mock(agent.followup).mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: '看 report.pdf 的第一页' }])
    await h.service.shutdown()
  })

  it('archives an expanded merged-forward record as text', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_forward', senderId: 'ou_owner', messageId: 'om_forward',
      content: '<forwarded_messages>\n[alice] 明天评审\n</forwarded_messages>',
      rawContentType: 'merge_forward',
    }))
    const dir = path.join(h.config.baseDir, 'groups', 'oc_forward', 'ou_owner', 'attachments')
    await waitUntil(() => expect(readdirSync(dir)).toHaveLength(1))
    const [name] = readdirSync(dir)
    expect(name).toMatch(/-forwarded-record\.txt$/)
    expect(readFileSync(path.join(dir, name!), 'utf8')).toContain('明天评审')
    expect(h.ctxState.agents.created).toHaveLength(0)
    await h.service.shutdown()
  })

  it('archives a file attached to a rich-text post and then processes its caption', async () => {
    const h = await setup({}, {
      downloadResource: () => [new TextEncoder().encode('zip-bytes')],
    })
    const raw = {
      message: {
        message_type: 'post',
        content: JSON.stringify({
          title: '',
          content: [[{ tag: 'text', text: '看一下这个文件的内容', style: [] }]],
          files: [{ file_key: 'file_v3_bugreport', file_name: 'bugreport-2025-11-04-141749.zip', is_folder: false }],
        }),
      },
    }
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_post_file', senderId: 'ou_owner', messageId: 'om_post_file',
      rawContentType: 'post', content: '看一下这个文件的内容', raw,
    }))
    const dir = path.join(h.config.baseDir, 'groups', 'oc_post_file', 'ou_owner', 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(readdirSync(dir)[0]).toMatch(/-bugreport-2025-11-04-141749\.zip$/)
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const message = mock(agent.followup).mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: '看一下这个文件的内容' }])
    await h.service.shutdown()
  })

  it('tells the user why an attachment could not be archived', async () => {
    const h = await setup({}, {
      downloadResource: () => {
        throw new Error('Request failed with status code 400')
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_post_fail', senderId: 'ou_owner', messageId: 'om_post_fail',
      rawContentType: 'post', content: '看一下这个文件的内容',
      raw: {
        message: {
          message_type: 'post',
          content: JSON.stringify({
            title: '',
            content: [[{ tag: 'text', text: '看一下这个文件的内容', style: [] }]],
            files: [{ file_key: 'file_v3_big', file_name: 'bugreport-2025-11-04-141749.zip', is_folder: false }],
          }),
        },
      },
    }))
    await waitUntil(() => {
      const texts = (h.channel.sent as Array<{ input: { text?: string } }>)
        .map(entry => entry.input.text)
        .filter((text): text is string => text !== undefined)
      expect(texts.some(text => text.includes('附件保存失败') && text.includes('100 MB'))).toBe(true)
    })
    await h.service.shutdown()
  })

  it('turns an image with a caption into one prompt carrying only the caption', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_caption', senderId: 'ou_owner', messageId: 'om_caption',
      content: '看这张图 ![image](img_1) 里有什么',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const message = mock(agent.followup).mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: '看这张图 里有什么' }])
    const dir = path.join(h.config.baseDir, 'groups', 'oc_caption', 'ou_owner', 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    await h.service.shutdown()
  })
})

describe('workspace retention cleanup', () => {
  const STALE = 10 * 24 * 60 * 60 * 1000

  it('previews and deletes a stale workspace while retiring its route', async () => {
    const h = await setup({ workspaceRetention: '7d' })
    const dir = path.join(h.config.baseDir, 'groups', 'oc_stale', 'ou_old')
    mkdirSync(path.join(dir, 'attachments'), { recursive: true })
    writeFileSync(path.join(dir, 'attachments', 'old.txt'), 'stale bytes')
    const old = new Date(Date.now() - STALE)
    utimesSync(dir, old, old)
    await h.ctxState.workspaces.registry.create(dir, '飞书群聊 · oc_stale · ou_old')
    const record: RouteRecord = {
      key: 'omt_stale',
      kind: 'thread',
      sessionId: 'session-stale',
      chatId: 'oc_stale',
      chatType: 'group',
      senderOpenId: 'ou_old',
      workspacePath: dir,
      cardMessageId: 'om_stale_card',
      createdAt: old.getTime(),
      lastActivityAt: old.getTime(),
      sessionHistory: [{ sessionId: 'session-stale', createdAt: old.getTime() }],
    }
    await h.ctxState.domain.raw.table('routes').put('omt_stale', record)

    const preview = await h.service.cleanupPreview()
    expect(preview.retention).toBe('7d')
    expect(preview.workspaces).toBe(1)
    expect(preview.candidates).toBe(1)
    expect(preview.candidateBytes).toBeGreaterThan(0)

    const result = await h.service.runWorkspaceCleanup()
    expect(result.ok).toBe(true)
    expect(result.deletedWorkspaces).toBe(1)
    expect(result.retiredRoutes).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(existsSync(dir)).toBe(false)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    expect(h.ctxState.domain.raw.table('routes').get('omt_stale')).toBeUndefined()
    expect(h.ctxState.domain.raw.table('expired_routes').get('omt_stale')).toMatchObject({
      workspacePath: dir,
    })
    await h.service.shutdown()
  })

  it('never offers a workspace whose session is still live', async () => {
    const h = await setup({ workspaceRetention: '7d' })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_live_ws', senderId: 'ou_owner',
      messageId: 'om_live_ws', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    const old = new Date(Date.now() - STALE)
    utimesSync(record.workspacePath, old, old)

    const preview = await h.service.cleanupPreview()
    expect(preview.candidates).toBe(0)
    const result = await h.service.runWorkspaceCleanup()
    expect(result.deletedWorkspaces).toBe(0)
    expect(existsSync(record.workspacePath)).toBe(true)
    await h.service.shutdown()
  })

  it('refuses to run while retention is off', async () => {
    const h = await setup({ workspaceRetention: 'off' })
    const preview = await h.service.cleanupPreview()
    expect(preview.candidates).toBe(0)
    expect(preview.thresholdMs).toBeUndefined()
    const result = await h.service.runWorkspaceCleanup()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('off')
    await h.service.shutdown()
  })
})

describe('/history enrichment', () => {
  it('annotates history entries with host titles', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_hist', content: '/history',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('Session 历史')
    expect(json).toContain('测试标题')
    expect(h.ctxState.sessionQuery.readTitleSnapshots).toHaveBeenCalled()
    await h.service.shutdown()
  })

  it('still renders history when the title lookup fails', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist_fail', senderId: 'ou_owner', content: '开始',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    h.ctxState.sessionQuery.readTitleSnapshots.mockRejectedValueOnce(new Error('query unavailable'))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist_fail', senderId: 'ou_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_hist_fail', content: '/history',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('Session 历史')
    expect(json).not.toContain('测试标题')
    const warnings = mock(h.ctxState.ctx.logger?.warn).mock.calls.flat().join(' ')
    expect(warnings).toContain('session title lookup failed')
    await h.service.shutdown()
  })
})
