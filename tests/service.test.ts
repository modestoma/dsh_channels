/**
 * FeishuService end-to-end tests over fakes: routing, workspace ownership,
 * topic replies, degradation, and lazy resume.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuService } from '../src/service.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { FeishuConfig } from '../src/config.ts'
import type {
  CardActionEvent, ChannelFactory, FeishuChannel, NormalizedMessage, RawMessageListParams,
} from '../src/feishu-channel.ts'
import { CordisFiberState } from '../src/dsh-types.ts'
import type { AgentHandle, ApprovalOutcome, CordisPluginRuntime, SessionId, SessionProjections } from '../src/dsh-types.ts'
import type { RouteRecord } from '../src/domain.ts'
import { sessionDirOf } from '../src/domain.ts'
import { FEISHU_ATTACHMENTS_SECTION } from '../src/feishu/agent-context.ts'
import { ATTACHMENT_FETCH_TOOL_NAME, TOPIC_MESSAGES_TOOL_NAME } from '../src/feishu/tools.ts'
import { SEND_FILE_TOOL_NAME } from '../src/feishu/send-file.ts'
import type { SessionExportBuilder } from '../src/session-export.ts'
import {
  dispatchAgentRequest, makeHostContext, makeChannel, makeMessage, makeAgentPresets, makeSession, makeAgent,
  makeMessageGetResponse, makeMessageListResponse, makeRawMessage, promptSectionsOf, sessionEvents,
  followupMessagesOf, makeAttachmentStore, makeToolsRuntime,
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
    wikiRoots: [],
    allowPermissionSwitch: false,
    // Tests exercise routing/hitl behavior; access control has its own tests.
    accessMode: 'open',
    authRequestTtlDays: 7,
    // Onboarding is opt-in per test: it adds a card that would shift send counts.
    welcomeOnboarding: false,
    slashCommandPanel: false,
    acceptAttachments: true,
    attachmentStore: 'native',
    prefetchImages: true,
    prefetchImageMaxBytes: 20 * 1024 * 1024,
    prefetchTotalMaxBytes: 50 * 1024 * 1024,
    prefetchTimeoutMs: 10_000,
    // First-turn topic history bootstrap; 0 disables it (bounded, silent on failure).
    historyBootstrapLimit: 10,
    promptContextTimeoutMs: 3_000,
    feishuTools: {
      attachmentFetch: true,
      attachmentFetchMaxResources: 10,
      attachmentFetchMaxBytes: 100 * 1024 * 1024,
      attachmentFetchTimeoutMs: 120_000,
      topicMessages: true,
      topicMessagesTimeoutMs: 20_000,
      sendFile: true,
      wikiRead: false,
      wikiWrite: false,
    },
    topicIsolation: 'auto',
    analyzeToken: 'DSH_CHANNELS_ANALYZE_TOKEN',
    ...partial,
  }
}

interface Harness {
  service: FeishuService
  channel: FeishuChannel & {
    sent: unknown[]
    repliedMedia: unknown[]
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
  extraServices: Record<string, unknown> = {},
): Promise<Harness> {
  const config = makeConfig(partial)
  const channel = makeChannel(channelOptions)
  const ctxState = makeHostContext(
    undefined,
    presetOptions === undefined ? undefined : makeAgentPresets(presetOptions),
    agentsOptions,
    projections,
    extraServices,
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

/** The setup() harness's return value (host fakes + the wired service). */
type SetupResult = Awaited<ReturnType<typeof setup>>

/**
 * Session establishment hands the first prompt to the agent as its LAST step —
 * after the workspace, repair snapshot, route record, first card and streamer
 * attach. `agents.created` alone is therefore not a delivery barrier: on a slow
 * CI filesystem, reading the route or resetting the followup spy right after it
 * races that handoff. Waiting for the first `followup` is the deterministic
 * "session is established" signal.
 */
async function waitForEstablishedSession(h: SetupResult): Promise<void> {
  await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
  await waitUntil(() => expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalled())
}

/** Wait for the first prompt handoff, then reset the followup spy. */
async function resetFollowupAfterEstablishment(agent: { followup: unknown }): Promise<void> {
  await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalled())
  mock(agent.followup).mockClear()
}

/**
 * `/renew` creates the replacement agent before committing the route record;
 * waiting for the created agent is therefore not enough to read the route.
 * Wait until the commit actually points the topic at the new Session.
 */
async function waitForRenewedRoute(h: SetupResult, key: string, sessionId: string): Promise<void> {
  await waitUntil(() => {
    const route = h.ctxState.domain.raw.table('routes').get(key) as RouteRecord | undefined
    expect(route?.sessionId).toBe(sessionId)
  })
}

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
      chatType: 'group', chatId: 'oc_health', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_health', content: '  /health  ',
    })
    await h.onMessage(msg)
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    expect(h.channel.sent).toHaveLength(1)
    expect((h.channel.sent[0] as { options?: object }).options).toEqual({ replyTo: 'om_health' })
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('健康检查')
    expect(json).toContain('degraded')
    expect(json).not.toContain('bot-open-id')
    expect(json).toContain('…n-id')
  await waitUntil(() => {
      expect(h.channel.reactions).toEqual([
        { messageId: 'om_health', emojiType: 'Typing' },
        { messageId: 'om_health', emojiType: 'DONE' },
      ])
  })
  })

  it('lists all supported commands for unbound /help without creating a workspace or Session', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_help', content: '/help',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    expect((h.channel.sent[0] as { options?: object }).options).toEqual({ replyTo: 'om_help' })
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
  await waitUntil(() => {
      expect(h.channel.reactions).toEqual([
        { messageId: 'om_help', emojiType: 'Typing' },
        { messageId: 'om_help', emojiType: 'DONE' },
      ])
  })
  })

  it('answers /help directly in a plain group and inside an existing topic', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', senderId: 'u_alice', mentionedBot: true,
      messageId: 'om_help_group', content: '/help',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    expect((h.channel.sent[0] as { options?: object }).options).toEqual({ replyTo: 'om_help_group' })

    await h.onMessage(makeMessage({
      chatType: 'group', senderId: 'u_alice', mentionedBot: true, threadId: 'omt_help',
      messageId: 'om_help_topic', content: '/help',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect((h.channel.sent[1] as { options?: object }).options).toEqual({ replyTo: 'om_help_topic', replyInThread: true })
    expect(h.ctxState.agents.created).toHaveLength(0)
  })

  it('rejects /help arguments without creating a workspace or Session', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false,
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
      chatType: 'p2p', chatId: 'oc_private', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_userid', content: '/userid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    const json = JSON.stringify((h.channel.sent[0] as { input: object }).input)
    expect(json).toContain('当前用户 ID')
    expect(json).toContain('u_alice')
    expect(mock(h.channel.send)).toHaveBeenCalledTimes(1)
    expect((h.channel.sent[0] as { options?: object }).options).toEqual({ replyTo: 'om_userid' })
  await waitUntil(() => {
      expect(h.channel.reactions).toEqual([
        { messageId: 'om_userid', emojiType: 'Typing' },
        { messageId: 'om_userid', emojiType: 'DONE' },
      ])
  })
  })

  it('returns /groupid in a group root when the bot is mentioned', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_alice', mentionedBot: true,
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
  await waitUntil(() => {
      expect(h.channel.reactions).toEqual([
        { messageId: 'om_groupid', emojiType: 'Typing' },
        { messageId: 'om_groupid', emojiType: 'DONE' },
      ])
  })
  })

  it.each(['userid', 'groupid'] as const)(
    'ignores unmentioned /%s in a group root when requireMention is enabled',
    async command => {
      const h = await setup()
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_group', senderId: 'u_alice', mentionedBot: false,
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
      chatType: 'group', chatId: 'oc_topic_group', senderId: 'u_alice', mentionedBot: false,
      threadId: 'omt_existing', messageId: 'om_groupid_topic', content: '/groupid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input)).toContain('oc_topic_group')
    expect((h.channel.sent[0] as { options?: object }).options)
      .toEqual({ replyTo: 'om_groupid_topic', replyInThread: true })
    expect(h.ctxState.agents.created).toHaveLength(0)
  })

  it('returns /groupid without a mention when requireMention is disabled', async () => {
    const h = await setup({ requireMention: false })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_open_group', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_groupid_open', content: '/groupid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input)).toContain('oc_open_group')
    expect((h.channel.sent[0] as { options?: object }).options)
      .toEqual({ replyTo: 'om_groupid_open' })
  })

  it.each([
    ['userid', 'group', '命令 /userid 仅支持在私聊中使用。', 'u_group_user'],
    ['groupid', 'p2p', '命令 /groupid 仅支持在群聊中使用。', 'oc_private_chat'],
  ] as const)('rejects /%s in the wrong chat type without exposing its ID', async (
    command, chatType, expected, hiddenId,
  ) => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType,
      chatId: chatType === 'group' ? 'oc_group_chat' : hiddenId,
      senderId: chatType === 'group' ? hiddenId : 'u_private_user',
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
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false,
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
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false,
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
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false,
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
    const msg = makeMessage({ chatType: 'p2p', senderId: 'u_alice', content: '/foo' })
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
      chatType: 'group', chatId: 'oc_commands', senderId: 'u_owner',
      messageId: 'om_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await resetFollowupAfterEstablishment(agent)

    const command = makeMessage({
      chatType: 'group', chatId: 'oc_commands', senderId: 'u_owner',
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
      chatType: 'group', chatId: 'oc_effort', senderId: 'u_owner',
      messageId: 'om_effort_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const created = h.ctxState.agents.created[0]!
    const agent = created.handle.agent
    const request = () => dispatchAgentRequest(created.setupCtx, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    await expect(request()).resolves.toMatchObject({ reasoningEffort: 'high' })

    const command = async (messageId: string, content: string) => {
      const before = sessionEvents(agent.session).length
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_effort', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_effort_restore', senderId: 'u_owner',
      messageId: 'om_effort_restore_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const original = h.ctxState.agents.created[0]!.handle.agent
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_effort_restore', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_effort_restore', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_health_route', senderId: 'u_owner',
      messageId: 'om_health_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await resetFollowupAfterEstablishment(agent)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_health_route', senderId: 'u_owner',
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
      chatType: 'group', chatId: 'oc_owned', senderId: 'u_owner', messageId: 'om_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    mock(h.ctxState.ctx.commands.execute).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_owned', senderId: 'u_intruder',
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
      chatType: 'group', chatId: 'oc_status', senderId: 'u_owner', messageId: 'om_status_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
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
    await resetFollowupAfterEstablishment(agent)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_status', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_workdir', senderId: 'u_owner', messageId: 'om_workdir_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cwd = agent.session.header.cwd
    expect(cwd).toBeDefined()
    const route = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    // The header keeps the user workspace; the command shows the topic dir.
    expect(route.workspacePath).toBe(cwd)
    expect(sessionDirOf(route)).not.toBe(cwd)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_workspace_command', content: '/workspace',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const card = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(card).toContain(sessionDirOf(route))
    expect(card).not.toContain(`\"${cwd}\"`)
  })

  it('rejects a mismatched /workspace and logs no path values', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir_bad', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const header = agent.session.header as unknown as { cwd: string }
    const routePath = header.cwd
    header.cwd = '/different/private/workspace'

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_workdir_bad', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_compact', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
    })
    await resetFollowupAfterEstablishment(agent)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_compact_empty', senderId: 'u_owner',
      messageId: 'om_compact_empty_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact_empty', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_compact_error', senderId: 'u_owner',
      messageId: 'om_compact_error_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_compact_error', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_no_compact', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_no_compact', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/compact',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('未挂载 Harness 原生 /compact')
    expect(sessionEvents(agent.session)).toHaveLength(0)
  })

  it('renews the topic atomically, preserves history, and routes the next message only to the new Session', async () => {
    const h = await setup({}, {}, { defaultId: 'standard' })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew', senderId: 'u_owner',
      messageId: 'om_renew_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
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
      chatType: 'group', chatId: 'oc_renew', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_renew_command', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    await waitForRenewedRoute(h, 'omt_1', renewed.options.sessionId)
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
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
    // The renewed Session re-enters the same topic directory.
    expect(h.ctxState.workingDirectory.sets).toContainEqual({
      sessionId: renewed.options.sessionId, path: sessionDirOf(route),
    })

    const resultCard = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(resultCard).toContain(old.options.sessionId)
    expect(resultCard).toContain(renewed.options.sessionId)
    expect(resultCard).toContain(sessionDirOf(route))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_after_renew', content: '只进入新会话',
    }))
    await waitUntil(() => expect(mock(renewed.handle.agent.followup)).toHaveBeenCalledTimes(1))
    expect(mock(old.handle.agent.followup)).toHaveBeenCalledTimes(1)
  })

  it('records each Session\'s Feishu origin once and serves it with live names and avatars', async () => {
    const h = await setup({}, {
      chatProfile: async () => ({ name: '研发群', avatarUrl: 'https://cdn.example/chat.png' }),
      userProfiles: async ids => new Map(ids.filter(id => id === 'u_owner').map(id => [id, { name: '张三', avatarUrl: 'https://cdn.example/u.png' }])),
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_origin', senderId: 'u_owner', messageId: 'om_origin_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const old = h.ctxState.agents.created[0]!
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_origin', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_origin_renew', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    const renewed = h.ctxState.agents.created[1]!
    await waitForRenewedRoute(h, 'omt_1', renewed.options.sessionId)

    const origins = h.ctxState.domain.raw.table('session_origins')
    expect(origins.get(old.options.sessionId)).toMatchObject({
      routeKey: 'omt_1', kind: 'thread', chatId: 'oc_origin', chatType: 'group', senderUserId: 'u_owner',
    })
    expect(await h.service.sessionOrigin(renewed.options.sessionId)).toMatchObject({
      sessionId: renewed.options.sessionId,
      chatType: 'group',
      kind: 'thread',
      chatName: '研发群',
      chatAvatarUrl: 'https://cdn.example/chat.png',
      senderUserId: 'u_owner',
      senderName: '张三',
      senderAvatarUrl: 'https://cdn.example/u.png',
      shared: false,
      bound: true,
      chatLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_origin',
    })
    const previous = await h.service.sessionOrigin(old.options.sessionId)
    expect(previous).toMatchObject({ bound: false, chatName: '研发群', senderName: '张三' })
    expect(previous).not.toHaveProperty('lastActivityAt')
    // Profiles are cached briefly: one lookup serves both Sessions of the same chat and user.
    expect(mock(h.channel.chatProfile)).toHaveBeenCalledTimes(1)
    expect(mock(h.channel.userProfiles)).toHaveBeenCalledTimes(1)
    expect(await h.service.sessionOrigin('not-a-feishu-session')).toBeNull()
  })

  it('serves a private-chat origin without a chat name and with the user id when no name resolves', async () => {
    const h = await setup({}, {
      userProfiles: async () => new Map(),
      chatProfile: async () => ({ name: '不该查询' }),
      memberName: async () => '不该查询',
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_dm', senderId: 'u_dm', messageId: 'om_dm_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId
    const origin = await h.service.sessionOrigin(sessionId)
    expect(origin).toMatchObject({ chatType: 'p2p', senderUserId: 'u_dm', bound: true })
    expect(origin).not.toHaveProperty('chatName')
    expect(origin).not.toHaveProperty('senderName')
    expect(mock(h.channel.userProfiles)).toHaveBeenCalledWith(['u_dm'])
    expect(mock(h.channel.chatProfile)).not.toHaveBeenCalled()
    expect(mock(h.channel.memberName)).not.toHaveBeenCalled()
  })

  it('names a group sender from the chat member list when the contact profile is unavailable', async () => {
    const h = await setup({}, {
      userProfiles: async () => { throw new FeishuApiError('code=99991672 Access denied', 99991672) },
      chatProfile: async () => ({ name: '研发群' }),
      memberName: async (userId, chatId) => (userId === 'u_owner' && chatId === 'oc_member' ? '张三' : undefined),
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_member', senderId: 'u_owner', messageId: 'om_member_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const origin = await h.service.sessionOrigin(h.ctxState.agents.created[0]!.options.sessionId)
    expect(origin).toMatchObject({ chatName: '研发群', senderName: '张三' })
    expect(origin).not.toHaveProperty('senderAvatarUrl')
  })

  it('serves panel profiles through a short cache, skipping invalid ids and reporting lookup failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const h = await setup({}, {
        userProfiles: async ids => new Map(ids.filter(id => id !== 'u_unknown').map(id => [id, { name: `名-${id}` }])),
        chatProfile: async (chatId) => {
          if (chatId === 'oc_gone') throw new FeishuApiError('code=232011 not found', 232011)
          return { name: '研发群', avatarUrl: 'https://cdn.example/chat.png' }
        },
      })
      const first = await h.service.feishuProfiles(['u_a', 'u_unknown', 'ou_open', 'u_a'], ['oc_dev', 'oc_gone', 'bad id'])
      expect(first).toEqual({
        users: { u_a: { name: '名-u_a' } },
        chats: { oc_dev: { name: '研发群', avatarUrl: 'https://cdn.example/chat.png' } },
        warning: '读取群信息失败：code=232011 not found',
      })
      expect(mock(h.channel.userProfiles)).toHaveBeenCalledWith(['u_a', 'u_unknown'])
      await h.service.feishuProfiles(['u_a', 'u_unknown'], ['oc_dev'])
      expect(mock(h.channel.userProfiles)).toHaveBeenCalledTimes(1)
      expect(mock(h.channel.chatProfile)).toHaveBeenCalledTimes(2)
      // A failed chat is not cached; it is asked again on the next entry.
      await h.service.feishuProfiles([], ['oc_gone'])
      expect(mock(h.channel.chatProfile)).toHaveBeenCalledTimes(3)
      vi.setSystemTime(Date.now() + 30_000)
      await h.service.feishuProfiles(['u_a'], [])
      expect(mock(h.channel.userProfiles)).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('backfills origins for routes written before origins existed', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_backfill', senderId: 'u_owner', messageId: 'om_backfill', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.service.shutdown()
    await h.ctxState.domain.raw.table('session_origins').delete(sessionId)

    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => makeChannel())
    await service2.start()
    await waitUntil(() => expect(h.ctxState.domain.raw.table('session_origins').get(sessionId)).toMatchObject({
      chatId: 'oc_backfill', senderUserId: 'u_owner',
    }))
    expect(await service2.sessionOrigin(sessionId)).toMatchObject({ chatType: 'group', bound: true })
    await service2.shutdown()
  })

  it.each(['running', 'next-turn', 'next-step'] as const)(
    'rejects /renew while the old Agent has %s work without creating a Session',
    async busyKind => {
      const h = await setup()
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_renew_busy', senderId: 'u_owner', content: '开始',
      }))
      await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
      const agent = h.ctxState.agents.created[0]!.handle.agent
      if (busyKind === 'running') Object.defineProperty(agent, 'status', { value: 'running' })
      if (busyKind === 'next-turn') (agent.inbox.nextTurn as unknown[]).push({ queued: true })
      if (busyKind === 'next-step') (agent.inbox.nextStep as unknown[]).push({ queued: true })

      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_renew_busy', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_renew_create_fail', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const old = h.ctxState.agents.created[0]!
    agentsOptions.failCreate = new Error('simulated renewed create failure')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_create_fail', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_renew_route_fail', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const old = h.ctxState.agents.created[0]!
    mock(h.ctxState.domain.raw.table('routes').put).mockRejectedValueOnce(new Error('route write failed'))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_route_fail', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const failed = h.ctxState.agents.created[1]!
    await waitUntil(() => expect(mock(failed.handle.dispose)).toHaveBeenCalledTimes(1))
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    const workspace = h.ctxState.workspaces.workspaces.get(route.workspacePath)!
    expect(route.sessionId).toBe(old.options.sessionId)
    expect(mock(workspace.detachSession)).toHaveBeenCalledWith(failed.options.sessionId)
    expect(mock(old.handle.dispose)).not.toHaveBeenCalled()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_route_fail', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, content: '仍进入旧会话',
    }))
    await waitUntil(() => expect(mock(old.handle.agent.followup)).toHaveBeenCalledTimes(2))
  })

  it('keeps the renewed route usable when both result-card deliveries fail', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_card_fail', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const old = h.ctxState.agents.created[0]!
    h.channel.send = vi.fn(async () => { throw new Error('result delivery failed') })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_card_fail', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    await waitForRenewedRoute(h, 'omt_1', renewed.options.sessionId)
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(mock(old.handle.dispose)).toHaveBeenCalledTimes(1)
    expect(h.ctxState.agents.liveAgents.get(renewed.options.sessionId)?.agent).toBe(renewed.handle.agent)
  })

  it('resumes the renewed Session with complete history after a restart', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_restart', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const oldSessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_renew_restart', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_renew_restart', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_history', senderId: 'u_owner',
      messageId: 'om_history_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const firstSessionId = h.ctxState.agents.created[0]!.options.sessionId

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_history_renew_1', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    const secondSessionId = h.ctxState.agents.created[1]!.options.sessionId
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_history_renew_2', content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(3))
    const current = h.ctxState.agents.created[2]!
    const currentSessionId = current.options.sessionId

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_history', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_history', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_export', senderId: 'u_owner',
      messageId: 'om_export_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'turn/end', seq: 41, time: 1_000, data: { turn: 1, reason: 'complete' },
    })
    await resetFollowupAfterEstablishment(agent)

    const command = makeMessage({
      chatType: 'group', chatId: 'oc_export', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_export_args', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_args', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_export_owned', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    mock(h.ctxState.ctx.commands.execute).mockClear()

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_owned', senderId: 'u_intruder', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_export_gzip_fail', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_gzip_fail', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_export_upload_fail', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_export_upload_fail', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_command_serial', senderId: 'u_owner',
      messageId: 'om_command_serial_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await resetFollowupAfterEstablishment(agent)

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
      chatType: 'group', chatId: 'oc_command_serial', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_command_serial_status', content: '/status',
    }))
    await commandStarted
    const ordinary = h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_serial', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_renew_redelivery', senderId: 'u_owner',
      messageId: 'om_renew_redelivery_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const old = h.ctxState.agents.created[0]!
    mock(h.ctxState.ctx.commands.execute).mockClear()

    const redelivery = makeMessage({
      chatType: 'group', chatId: 'oc_renew_redelivery', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_renew_redelivery_command', content: '/renew',
    })
    await Promise.all([h.onMessage(redelivery), h.onMessage(redelivery)])
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    await waitUntil(() => {
      const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord | undefined
      expect(route?.sessionHistory).toHaveLength(2)
    })
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    expect(h.ctxState.agents.created).toHaveLength(2)
    expect(mock(h.ctxState.ctx.commands.execute)).toHaveBeenCalledTimes(1)
    expect(mock(old.handle.dispose)).toHaveBeenCalledTimes(1)
    expect(new Set(route.sessionHistory?.map(entry => entry.sessionId)).size).toBe(2)
  })

  it('aborts an in-flight command during shutdown without sending a late result card', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_shutdown', senderId: 'u_owner',
      messageId: 'om_command_shutdown_start', content: '开始',
    }))
    await waitForEstablishedSession(h)

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
      chatType: 'group', chatId: 'oc_command_shutdown', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_command_isolation', senderId: 'u_owner',
      messageId: 'om_command_isolation_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const listener = h.ctxState.sessionListeners[0]!
    listener(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await waitUntil(() => expect(inflightEntries(h)).toHaveLength(0))
    const streamedPatchCount = h.channel.updated.length

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_command_isolation', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_renew_borrowed', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
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
      chatType: 'group', chatId: 'oc_renew_borrowed', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, content: '/renew',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    expect(renewed.options.agentOptions).toEqual(foreignAgent.options)
    await waitForRenewedRoute(h, 'omt_1', renewed.options.sessionId)
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
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', mentionedBot: false, content: '你好呀' })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)

    // Typing reaction first.
    expect(h.channel.reactions).toContainEqual({ messageId: msg.messageId, emojiType: 'Typing' })

    // First card was sent as a topic reply (creates the topic).
    const firstSend = h.channel.sent[0] as { options?: { replyTo?: string; replyInThread?: boolean } }
    expect(firstSend?.options).toMatchObject({ replyTo: msg.messageId, replyInThread: true })

    // Agent created with the user workspace as header cwd (keeps the Session
    // grouped under the project) …
    expect(h.ctxState.agents.created).toHaveLength(1)
    const created = h.ctxState.agents.created[0]!
    const workspacePath = path.join(h.config.baseDir, 'p2p', 'u_alice')
    const sessionDir = path.join(workspacePath, 'topics', 'omt_1')
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

    // … and switched to its own topic directory inside that workspace.
    expect(h.ctxState.workingDirectory.sets).toContainEqual({
      sessionId: created.options.sessionId, path: sessionDir,
    })
    expect(h.ctxState.worktrees.created).toHaveLength(0)

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
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'u_alice', mentionedBot: false, content: 'hi' }))
    await waitForEstablishedSession(h)

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
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'u_alice', mentionedBot: false, content: 'hi' }))
    await waitForEstablishedSession(h)

    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.agentPreset).toBe('channels')
    const presets = h.ctxState.ctx.get!('agentPresets') as FakeAgentPresets
    expect(presets.resolve).toHaveBeenCalledWith('channels')
    expect(presets.mounts).toEqual([{ agentCtx: created.setupCtx, id: 'channels' }])
  })

  it('leaves preset composition bare but still mounts channel commands without a roster', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'u_alice', mentionedBot: false, content: 'hi' }))
    await waitForEstablishedSession(h)

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
    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: '开始' })
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
      senderId: 'u_alice',
      mentionedBot: false,
      threadId: 'omt_1',
      messageId: 'om_second',
      content: '继续',
    })
    await h.onMessage(second)
    await waitForEstablishedSession(h)
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
    await waitForEstablishedSession(h)
  })

  it('gives every group user their own workspace in the same chat', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: 'a' }))
    await h.onMessage(makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_bob', threadId: 'omt_2', content: 'b' }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    const cwds = h.ctxState.agents.created.map(entry => entry.options.meta?.cwd as string)
    expect(cwds).toHaveLength(2)
    const aliceWorkspace = path.join(h.config.baseDir, 'groups', 'oc_grp', 'u_alice')
    const bobWorkspace = path.join(h.config.baseDir, 'groups', 'oc_grp', 'u_bob')
    expect(new Set(cwds)).toEqual(new Set([aliceWorkspace, bobWorkspace]))
    // Each user's Session works in its own topic directory below its workspace.
    // The topic directory is entered after the Agent exists, so wait for both.
    await waitUntil(() => {
      const dirs = h.ctxState.workingDirectory.sets.map(entry => entry.path)
      expect(dirs).toContainEqual(path.join(aliceWorkspace, 'topics', 'omt_1'))
      expect(dirs).toContainEqual(path.join(bobWorkspace, 'topics', 'omt_2'))
    })
    expect(aliceWorkspace).not.toBe(bobWorkspace)
  })

  // Bot/app senders carry no user_id and are dropped by the channel adapter
  // (tests/feishu-channel.test.ts) before they reach the service.
  it('ignores empty content', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', senderId: 'u_alice', content: '   ' }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(0)
  })

  it('degrades to a chat-scoped route when topic replies are refused', async () => {
    const h = await setup({}, { failReplyInThread: true })
    const msg = makeMessage({ chatType: 'group', content: '话题不支持' })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)

    const sends = h.channel.sent as Array<{ options?: { replyInThread?: boolean } }>
    expect(sends[0]?.options?.replyInThread).toBeUndefined()
    // Deterministic barrier: wait for the chat-scoped route to be durable
    // before the follow-up message (same race as the thread test above).
    await waitUntil(() => {
      const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
      expect(entries[0]?.[0]).toBe('chat:group:oc_test_chat:u_test_user')
    })

    // A later mention in the same chat continues the same session.
    await h.onMessage(makeMessage({ chatType: 'group', content: '再来' }))
    await waitUntil(() => expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(2))
    expect(h.ctxState.agents.created).toHaveLength(1)
  })

  it('resumes the persisted session when the live agent is gone', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hello' }))
    // Establishment only completes once the first prompt reaches the agent;
    // by then the route record is durable, which the restart below relies on.
    await waitForEstablishedSession(h)
    const sessionId = h.ctxState.agents.created[0]!.options.sessionId

    // Simulate a restart: drop live agents, keep the route table.
    await h.service.shutdown()
    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '还在吗', threadId: 'omt_1' }))
    await waitUntil(() => expect(h.ctxState.agents.resumed).toHaveLength(1))
    expect(h.ctxState.agents.resumed[0]!.options.resumeSessionId).toBe(sessionId)
    await waitUntil(() => expect(mock(h.ctxState.agents.resumed[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1))
    await service2.shutdown()
  })

  it('composes resumed sessions from the same preset resolution as creation', async () => {
    const h = await setup({}, {}, {})
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hello' }))
    await waitForEstablishedSession(h)

    // Simulate a restart: drop live agents, keep the route table.
    await h.service.shutdown()
    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '还在吗', threadId: 'omt_1' }))
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
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hello' }))
    await waitForEstablishedSession(h)
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
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '还在吗', threadId: 'omt_1' }))

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
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hello' }))
    await waitForEstablishedSession(h)
    sessionId = h.ctxState.agents.created[0]!.options.sessionId
    await h.service.shutdown()

    const channel2 = makeChannel()
    const service2 = new FeishuService(h.ctxState.ctx, h.config, () => channel2)
    await service2.start()
    const registered = (channel2.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '还在吗', threadId: 'omt_1' }))

    await waitUntil(() => expect(winner).toBeDefined())
    await waitUntil(() => expect(mock(winner!.agent.followup)).toHaveBeenCalledTimes(1))
    expect((mock(winner!.agent.followup).mock.calls[0]?.[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe('还在吗')

    // The race must not surface to the user as a 处理失败 message.
    expect(JSON.stringify(channel2.sent)).not.toContain('处理失败')
    await service2.shutdown()
  })

  it('disposes an agent resumed during shutdown instead of leaking it live', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hello' }))
    await waitForEstablishedSession(h)
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
    void handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '还在吗', threadId: 'omt_1' }))
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
      chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice',
      messageId: 'om_first_trigger', content: '第一轮',
    })
    await h.onMessage(first)
    await waitForEstablishedSession(h)

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
      chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice',
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
    // The failure diagnostic appears once, in the body (the settled footer
    // still renders); there is no duplicated "回复失败" panel title/status line.
    expect(failedCard).toContain('本轮运行失败')
    expect(failedCard).toContain('UNSUPPORTED_REASONING_EFFORT')
    expect(failedCard).toContain('模型 —')
    expect(failedCard).not.toContain('(high)')
    expect(h.channel.reactions).not.toContainEqual({
      messageId: 'om_failed_trigger', emojiType: 'DONE',
    })
  })

  it('sends oversized body segments as continuation cards inside the topic', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '长文' }))
    await waitForEstablishedSession(h)

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
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '长文' }))
    await waitForEstablishedSession(h)
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
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', mentionedBot: false, content: 'hi' })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)

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
    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: '一' })
    await h.onMessage(first)
    await waitForEstablishedSession(h)

    // Second message while the first turn is still "streaming" (never ended).
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', mentionedBot: false,
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
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '长文' }))
    await waitForEstablishedSession(h)
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
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hi' })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)

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
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: 'hi' }))
    await waitForEstablishedSession(h)
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
    await h.onMessage(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '长文' }))
    await waitForEstablishedSession(h)
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

    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: '开始' })
    await h.onMessage(first)
    await waitUntil(() => expect(gated).toBe(true))

    // Second message already inside the just-created topic, no mention.
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice',
      mentionedBot: false, threadId: 'omt_1', messageId: 'om_second', content: '继续',
    })
    await h.onMessage(second)

    releaseFirst()
    await waitForEstablishedSession(h)
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
    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: '一' })
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', messageId: 'om_second', content: '二',
    })
    await h.onMessage(first)
    await h.onMessage(second)

    await waitForEstablishedSession(h)
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

    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: '失败的首条' })
    await h.onMessage(first)
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', messageId: 'om_second', content: '重试',
    })
    await h.onMessage(second)

    await waitForEstablishedSession(h)
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

    const first = makeMessage({ chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', content: '开始' })
    await h.onMessage(first)
    await waitUntil(() => expect(gated).toBe(true))

    // Concurrent message OUTSIDE the new topic (no threadId): it must wait
    // for the establishment, then start its own session — never hijack the
    // first one and never race the route write.
    const second = makeMessage({
      chatType: 'group', chatId: 'oc_grp', senderId: 'u_alice', messageId: 'om_second', content: '旁路',
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
      senderUserId: 'u_test_user',
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
    await handler(makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '重新开始', threadId: 'omt_gc' }))

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
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'u_test_user',
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
      senderUserId: 'u_test_user',
      expiredAt: Date.now(),
    })
    const channel = makeChannel()
    const service = new FeishuService(ctxState.ctx, makeConfig(), () => channel)
    await service.start()
    const registered = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'u_test_user',
      content: '/status', threadId: 'omt_expired_cmd', mentionedBot: false,
    }))

    await waitUntil(() => expect(channel.sent).toHaveLength(1))
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)
    expect(JSON.stringify(channel.sent[0]!.input)).toContain('话题已过期')

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'u_test_user',
      content: '/health', threadId: 'omt_expired_cmd', mentionedBot: false,
      messageId: 'om_expired_health',
    }))
    await waitUntil(() => expect(channel.sent).toHaveLength(2))
    expect(JSON.stringify(channel.sent[1]!.input)).toContain('健康检查')
    expect(ctxState.agents.created).toHaveLength(0)
    expect(ctxState.agents.resumed).toHaveLength(0)

    await handler(makeMessage({
      chatType: 'group', chatId: 'oc_test_chat', senderId: 'u_test_user',
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
    await seedRoute(ctxState.domain.raw, 'chat:p2p:oc_p2p:u_alice', Date.now() - 40 * DAY_MS, {
      key: 'chat:p2p:oc_p2p:u_alice',
      kind: 'chat',
      chatId: 'oc_p2p',
      chatType: 'p2p',
      senderUserId: 'u_alice',
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
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '你好' })
    await h.onMessage(msg)
    await h.onMessage(msg) // WS redelivery of the same event

    await waitForEstablishedSession(h)
    await settle()
    expect(h.ctxState.agents.created).toHaveLength(1)
    expect(h.channel.sent).toHaveLength(1)
    expect(h.channel.reactions).toHaveLength(1)
    expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1)
    expect(processedEntries(h)).toHaveLength(1)
  })

  it('ignores a redelivered continuation message (no duplicate turn)', async () => {
    const h = await setup()
    const first = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '开始' })
    await h.onMessage(first)
    await waitForEstablishedSession(h)
    await waitUntil(() => {
      const entries = [...(h.ctxState.domain.raw.table('routes').entries() as IterableIterator<[string, unknown]>)]
      expect(entries).toHaveLength(1)
    })

    const cont = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice',
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
    const msg = makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_alice', content: '跨重启' })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)
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
      chatType: 'group', chatId: 'oc_approval', senderId: 'u_owner', content: '审批一下',
    })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)

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
      operator: { openId: 'ou_operator', userId: 'u_stranger' },
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
      operator: { openId: 'ou_operator', userId: 'u_owner' },
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
      chatType: 'group', chatId: 'oc_shutdown', senderId: 'u_owner', content: '先问后关',
    })
    await h.onMessage(msg)
    await waitForEstablishedSession(h)
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
      chatType: 'group', chatId: 'oc_questions', senderId: 'u_owner', content: '问一下',
    }))
    await waitForEstablishedSession(h)
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
      operator: { openId: 'ou_operator', userId: 'u_stranger' },
      action: { value, tag: 'button' },
    })
    await flush()
    expect(h.channel.updated.some(update =>
      (update as { messageId: string }).messageId === messageId
      && JSON.stringify((update as { card: object }).card).includes('仅发起该会话的用户'),
    )).toBe(true)

    await h.channel.fireCardAction({
      messageId, chatId: 'oc_questions',
      operator: { openId: 'ou_operator', userId: 'u_owner' },
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
      chatType: 'group', chatId: 'oc_q_shutdown', senderId: 'u_owner', content: '先问后关',
    }))
    await waitForEstablishedSession(h)
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
      chatType: 'group', chatId: 'oc_stop', senderId: 'u_owner', messageId: 'om_stop_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cancel = vi.fn()
    ;(agent as unknown as { status: string }).status = 'running'
    ;(agent as unknown as { cancel: unknown }).cancel = cancel
    await resetFollowupAfterEstablishment(agent)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_stop_command', content: '/stop',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))

    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
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
      chatType: 'group', chatId: 'oc_stop_idle', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cancel = vi.fn()
    ;(agent as unknown as { cancel: unknown }).cancel = cancel

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop_idle', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_stop_idle_command', content: '/stop',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('当前没有正在运行的回合')
    await h.service.shutdown()
  })

  it('cancels the running turn from the streaming card stop button, owner only', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_stop_btn', senderId: 'u_owner', messageId: 'om_stop_btn_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const cancel = vi.fn()
    ;(agent as unknown as { status: string }).status = 'running'
    ;(agent as unknown as { cancel: unknown }).cancel = cancel
    // The first frame has no button; the active turn gains it on its first patch.
    expect(JSON.stringify((h.channel.sent[0] as { input: object }).input)).not.toContain('⏹ 停止')
    await waitUntil(() => expect(h.channel.updated.some(update =>
      JSON.stringify((update as { card: object }).card).includes('⏹ 停止'),
    )).toBe(true))
    const value = { decision: 'turn-stop' }

    // A stranger's click only adds the owner-only notice.
    await h.channel.fireCardAction({
      messageId: 'om_1', chatId: 'oc_stop_btn',
      operator: { openId: 'ou_x', userId: 'u_stranger' }, action: { value, tag: 'button' },
    })
    expect(cancel).not.toHaveBeenCalled()
    await waitUntil(() => expect(h.channel.updated.some(update =>
      JSON.stringify((update as { card: object }).card).includes('仅发起该会话的用户可停止'),
    )).toBe(true))

    // The owner's click from another chat (a forwarded card) is refused too.
    await h.channel.fireCardAction({
      messageId: 'om_1', chatId: 'oc_elsewhere',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value, tag: 'button' },
    })
    expect(cancel).not.toHaveBeenCalled()

    // Unknown cards are ignored.
    await h.channel.fireCardAction({
      messageId: 'om_unknown', chatId: 'oc_stop_btn',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value, tag: 'button' },
    })
    expect(cancel).not.toHaveBeenCalled()

    await h.channel.fireCardAction({
      messageId: 'om_1', chatId: 'oc_stop_btn',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value, tag: 'button' },
    })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await waitUntil(() => expect(h.channel.updated.some(update =>
      JSON.stringify((update as { card: object }).card).includes('正在停止'),
    )).toBe(true))
    // No reply card: the button answers on the streaming card itself.
    expect(h.channel.sent).toHaveLength(1)
    await h.service.shutdown()
  })

  it('queues a topic message behind the running turn and steers it in from its card, owner only', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_steer', senderId: 'u_owner', messageId: 'om_steer_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(agent as unknown as { status: string }).status = 'running'

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_steer', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_steer_more', content: '再补充一点',
    }))
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))
    const queuedCard = h.channel.sent[1] as { input: object }
    expect(JSON.stringify(queuedCard.input)).toContain('排队中')
    const message = mock(agent.followup).mock.calls[1]![0] as { id: string }
    const value = { decision: 'turn-steer' }

    // A stranger's click only adds the owner-only notice.
    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_steer',
      operator: { openId: 'ou_x', userId: 'u_stranger' }, action: { value, tag: 'button' },
    })
    expect(mock(agent.steer)).not.toHaveBeenCalled()
    await waitUntil(() => expect(h.channel.updated.some(update =>
      JSON.stringify((update as { card: object }).card).includes('仅发起该会话的用户可补充'),
    )).toBe(true))

    // The running turn's own card is not a queued card.
    await h.channel.fireCardAction({
      messageId: 'om_1', chatId: 'oc_steer',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value, tag: 'button' },
    })
    expect(mock(agent.steer)).not.toHaveBeenCalled()

    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_steer',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value, tag: 'button' },
    })
    expect(mock(agent.inbox.remove)).toHaveBeenCalledWith(message.id)
    expect(mock(agent.steer)).toHaveBeenCalledWith(message)
    await waitUntil(() => expect(h.channel.updated.some(update =>
      (update as { messageId: string }).messageId === 'om_2'
      && JSON.stringify((update as { card: object }).card).includes('已补充到当前回复'),
    )).toBe(true))
    expect(h.channel.sent).toHaveLength(2)
    await h.service.shutdown()
  })

  it('leaves a queued card alone when the agent is idle or the prompt was already claimed', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_steer_late', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_steer_late', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_steer_late', content: '补充',
    }))
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))
    const click = () => h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_steer_late',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value: { decision: 'turn-steer' }, tag: 'button' },
    })

    await click()
    expect(mock(agent.inbox.remove)).not.toHaveBeenCalled()

    ;(agent as unknown as { status: string }).status = 'running'
    mock(agent.inbox.remove).mockReturnValueOnce(false)
    await click()
    expect(mock(agent.inbox.remove)).toHaveBeenCalledTimes(1)
    expect(mock(agent.steer)).not.toHaveBeenCalled()
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
      chatType: 'group', chatId: 'oc_proj', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
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
    // The figures live on the settled footer, so the turn must end first.
    h.ctxState.sessionListeners[0]!(agent.session, {
      type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' },
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
      chatType: 'group', chatId: 'oc_stream', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
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
      chatType: 'group', chatId: 'oc_alias', senderId: 'u_owner',
      messageId: 'om_alias_start', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const old = h.ctxState.agents.created[0]!

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_alias', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_alias_new', content: '/new',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    const renewed = h.ctxState.agents.created[1]!
    await waitForRenewedRoute(h, 'omt_1', renewed.options.sessionId)
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord
    // The alias executes the canonical command on the agent plane.
    expect(sessionEvents(old.handle.agent.session).slice(-2).map(event => event.type))
      .toEqual(['command/run', 'command/done'])
    expect(JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)).toContain('Session 已续建')
    await h.service.shutdown()
  })

  it('rejects an unknown command with the registry-derived supported list', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_unknown', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_unknown', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_qtext', senderId: 'u_owner', content: '问一下',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.questionListeners[0]!
    const pending = listener({
      questions: [{ id: 'q1', question: '自由文本？' }],
      agent,
    }, vi.fn(async () => ({ answers: [] })))
    await waitUntil(() => expect(h.channel.sent.length).toBe(2))
    await resetFollowupAfterEstablishment(agent)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_qtext', senderId: 'u_owner', threadId: 'omt_1',
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

describe('typed approval replies', () => {
  async function pendingApproval(chatId: string) {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId: 'u_owner', content: '跑一下',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const { listener } = h.ctxState.approvalListeners[0]!
    const pending = listener({ agent, toolName: 'bash', reason: '需要提权' }, vi.fn(async () => 'unavailable' as const))
    await waitUntil(() => expect(h.channel.sent.length).toBe(2))
    await resetFollowupAfterEstablishment(agent)
    return { h, agent, pending }
  }

  it('a keyword reply decides the card without starting a model turn', async () => {
    const { h, agent, pending } = await pendingApproval('oc_atext')
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_atext', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_atext_allow', content: '允许',
    }))
    await expect(pending).resolves.toBe('allowed-once')
    expect(mock(agent.followup)).not.toHaveBeenCalled()
    await waitUntil(() => expect(JSON.stringify(
      (h.channel.sent.at(-1) as { input: object }).input,
    )).toContain('已允许本次操作'))
    await h.service.shutdown()
  })

  it('any other reply rejects the card and still reaches the agent', async () => {
    const { h, agent, pending } = await pendingApproval('oc_aother')
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_aother', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_aother', content: '别提权，换个目录写',
    }))
    await expect(pending).resolves.toBe('rejected')
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalled())
    await h.service.shutdown()
  })
})

describe('/permissions and /status extras', () => {
  it('shows the current permission preset and the catalog read-only by default', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_perm', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_perm_on', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_perm_on', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_status_extra', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const route = h.ctxState.domain.raw.table('routes').get('omt_1') as RouteRecord | undefined

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_status_extra', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_status_extra', content: '/status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('权限预设')
    expect(json).toContain('会话目录')
    expect(json).toContain('插件运行时长')
    expect(route?.workspacePath).toBeDefined()
    await h.service.shutdown()
  })
})

describe('first-contact onboarding', () => {
  it('sends the onboarding card once per private chat and persists it', async () => {
    const h = await setup({ welcomeOnboarding: true })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_welcome', senderId: 'u_new', messageId: 'om_w1', content: '你好',
    }))
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThanOrEqual(2))

    const welcomes = () => h.channel.sent.filter(entry =>
      JSON.stringify((entry as { input: object }).input).includes('欢迎使用飞书 DSH'))
    expect(welcomes()).toHaveLength(1)
    const global = h.ctxState.domain.raw.global.get() as { welcomedChats?: string[] }
    expect(global.welcomedChats).toContain('oc_welcome')

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_welcome', senderId: 'u_new', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_model_view', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_view', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_model_set', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const created = h.ctxState.agents.created[0]!
    const agent = created.handle.agent

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_set', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_model_bad', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    ;(sessionEvents(agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_model_bad', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_model_bad', content: '/model nope-model',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const json = JSON.stringify((h.channel.sent.at(-1) as { input: object }).input)
    expect(json).toContain('未提供模型')
    expect(json).toContain('deepseek-v4-pro')
    await h.service.shutdown()
  })
})

describe('command picker cards', () => {
  function buttonValues(card: object): Array<{ label: string; value: Record<string, unknown> }> {
    const out: Array<{ label: string; value: Record<string, unknown> }> = []
    const walk = (elements: Array<Record<string, unknown>>): void => {
      for (const element of elements) {
        if (element.tag === 'button') {
          out.push({
            label: (element.text as { content: string }).content,
            value: (element.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value,
          })
        }
        for (const column of (element.columns as Array<{ elements: Array<Record<string, unknown>> }> | undefined) ?? []) {
          walk(column.elements)
        }
      }
    }
    walk((card as { body: { elements: Array<Record<string, unknown>> } }).body.elements)
    return out
  }

  const lastCard = (h: SetupResult): object => (h.channel.sent.at(-1) as { input: { card: object } }).input.card
  const pickerUpdates = (h: SetupResult, messageId: string): object[] =>
    (h.channel.updated as Array<{ messageId: string; card: object }>)
      .filter(update => update.messageId === messageId).map(update => update.card)

  async function establishWithModel(h: SetupResult, chatId: string) {
    await h.onMessage(makeMessage({ chatType: 'group', chatId, senderId: 'u_owner', content: '开始' }))
    await waitForEstablishedSession(h)
    const created = h.ctxState.agents.created[0]!
    ;(sessionEvents(created.handle.agent.session) as unknown as Array<Record<string, unknown>>).push({
      type: 'request/header', seq: 1, time: 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    })
    return created
  }

  it('answers bare /model with model buttons and switches on an owner click', async () => {
    const h = await setup()
    const created = await establishWithModel(h, 'oc_pick_model')
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_pick_model', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_pick_model', content: '/model',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const buttons = buttonValues(lastCard(h))
    expect(buttons.map(button => button.label)).toEqual(['✅ deepseek-v4-flash', 'deepseek-v4-pro', '恢复默认'])
    const pro = buttons[1]!.value
    expect(pro).toEqual({
      decision: 'command-pick', command: 'model', arg: 'deepseek-v4-pro', sessionId: created.handle.agent.session.id,
    })

    // Strangers and forwarded copies are ignored without a reply.
    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_pick_model',
      operator: { openId: 'ou_x', userId: 'u_stranger' }, action: { value: pro, tag: 'button' },
    })
    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_other',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value: pro, tag: 'button' },
    })
    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_pick_model',
      operator: { openId: 'ou_o', userId: 'u_owner' },
      action: { value: { ...pro, sessionId: 'sess-stale' }, tag: 'button' },
    })
    await flush()
    expect(h.channel.sent).toHaveLength(2)

    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_pick_model',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value: pro, tag: 'button' },
    })
    await waitUntil(() => expect(pickerUpdates(h, 'om_2')).toHaveLength(1))
    expect(JSON.stringify(pickerUpdates(h, 'om_2')[0])).toContain('已切换为')
    expect(h.channel.sent).toHaveLength(2)
    await expect(dispatchAgentRequest(created.setupCtx, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }))
      .resolves.toMatchObject({ model: 'deepseek-v4-pro' })
    await h.service.shutdown()
  })

  it('answers bare /effort with the efforts the model advertises', async () => {
    const h = await setup({ reasoningEffort: 'high' })
    mock(h.ctxState.ctx.llm!.resolveModelInfo).mockResolvedValue({
      context: { contextWindow: 128000 },
      reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' },
    })
    const created = await establishWithModel(h, 'oc_pick_effort')
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_pick_effort', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_pick_effort', content: '/effort',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const buttons = buttonValues(lastCard(h))
    expect(buttons.map(button => button.label)).toEqual(['低', '✅ 高', '恢复默认'])

    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_pick_effort',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value: buttons[0]!.value, tag: 'button' },
    })
    await waitUntil(() => expect(pickerUpdates(h, 'om_2')).toHaveLength(1))
    const settled = JSON.stringify(pickerUpdates(h, 'om_2')[0])
    expect(settled).toContain('命令执行完成')
    expect(settled).not.toContain('command-pick')
    expect(h.channel.sent).toHaveLength(2)
    await expect(dispatchAgentRequest(created.setupCtx, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }))
      .resolves.toMatchObject({ reasoningEffort: 'low' })
    await h.service.shutdown()
  })

  it('keeps the text answer when the model advertises no efforts or the lookup fails', async () => {
    const h = await setup()
    await establishWithModel(h, 'oc_pick_effort_none')
    const command = async (messageId: string) => {
      const before = h.channel.sent.length
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_pick_effort_none', senderId: 'u_owner', threadId: 'omt_1',
        mentionedBot: false, messageId, content: '/effort',
      }))
      await waitUntil(() => expect(h.channel.sent).toHaveLength(before + 1))
    }
    await command('om_effort_none')
    expect(buttonValues(lastCard(h))).toHaveLength(0)
    mock(h.ctxState.ctx.llm!.resolveModelInfo).mockRejectedValue(new Error('offline'))
    await command('om_effort_fail')
    expect(buttonValues(lastCard(h))).toHaveLength(0)
    await h.service.shutdown()
  })

  it('answers bare /permissions with preset buttons only when switching is allowed', async () => {
    const h = await setup({ allowPermissionSwitch: true })
    await h.onMessage(makeMessage({ chatType: 'group', chatId: 'oc_pick_perm', senderId: 'u_owner', content: '开始' }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_pick_perm', senderId: 'u_owner', threadId: 'omt_1',
      mentionedBot: false, messageId: 'om_pick_perm', content: '/permissions',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const buttons = buttonValues(lastCard(h))
    expect(buttons.map(button => button.label)).toEqual(['Read only', '✅ Standard'])
    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_pick_perm',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value: buttons[0]!.value, tag: 'button' },
    })
    await waitUntil(() => expect(pickerUpdates(h, 'om_2')).toHaveLength(1))
    expect(JSON.stringify(pickerUpdates(h, 'om_2')[0])).toContain('权限预设已切换')
    expect(h.channel.sent).toHaveLength(2)
    expect(h.ctxState.permissions.set).toHaveBeenCalledWith(agent.session, 'read-only')

    // A refused patch falls back to replying under the picker card.
    mock(h.channel.updateCard).mockRejectedValueOnce(new Error('card expired'))
    await h.channel.fireCardAction({
      messageId: 'om_2', chatId: 'oc_pick_perm',
      operator: { openId: 'ou_o', userId: 'u_owner' }, action: { value: buttons[1]!.value, tag: 'button' },
    })
    await waitUntil(() => expect(h.channel.sent).toHaveLength(3))
    expect((h.channel.sent.at(-1) as { options: Record<string, unknown> }).options)
      .toMatchObject({ replyTo: 'om_2', replyInThread: true })
    await h.service.shutdown()
  })
})

describe('inbound attachments', () => {
  it('registers the attachment guidance with the session workspace path', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_guide', senderId: 'u_owner',
      messageId: 'om_guide', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    const sections = promptSectionsOf(h.ctxState.agents.created[0]!.setupCtx)
    const guidance = sections.find(section => section.name === FEISHU_ATTACHMENTS_SECTION)
    expect(guidance?.text).toContain(`${sessionDirOf(record)}/attachments`)
    await h.service.shutdown()
  })

  it('archives an image-only message into the workspace without starting a turn', async () => {
    const h = await setup({}, {
      downloadResource: () => [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_image', senderId: 'u_owner', messageId: 'om_image',
      content: '![image](img_1)',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }))

    const dir = path.join(h.config.baseDir, '_staging', 'group', 'oc_image', 'u_owner')
    const finalFiles = () => readdirSync(dir).filter(name => !name.startsWith('.tmp-'))
    await waitUntil(() => expect(finalFiles()).toHaveLength(1))
    const [name] = finalFiles()
    expect(name).toMatch(/\.png$/)
    expect(h.ctxState.agents.created).toHaveLength(0)
    await waitUntil(() => expect(h.channel.reactions).toEqual([{ messageId: 'om_image', emojiType: 'DONE' }]))
    await h.service.shutdown()
  })

  it('archives a file message and keeps a following caption as the only prompt text', async () => {
    const h = await setup({}, {
      downloadResource: (_messageId, fileKey) => [new TextEncoder().encode(`bytes:${fileKey}`)],
    })
    const chatId = 'oc_file_chat'
    const senderId = 'u_owner'
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, messageId: 'om_file',
      content: '<file key="file_1" name="report.pdf"/>',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'report.pdf' }] as never,
    }))
    const staging = path.join(h.config.baseDir, '_staging', 'group', chatId, senderId)
    await waitUntil(() => expect(readdirSync(staging).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(readdirSync(staging).filter(name => !name.startsWith('.tmp-'))[0]).toMatch(/report\.pdf$/)
    expect(h.ctxState.agents.created).toHaveLength(0)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, messageId: 'om_prompt',
      content: '看 report.pdf 的第一页',
    }))
    await waitForEstablishedSession(h)
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    const workspaceAttachments = path.join(sessionDirOf(record), 'attachments')
    await waitUntil(() => expect(readdirSync(workspaceAttachments).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(readdirSync(workspaceAttachments).filter(name => !name.startsWith('.tmp-'))[0]).toMatch(/report\.pdf$/)
    expect(readdirSync(staging)).toEqual([])
    // The one-time legacy adoption announces its own removal window (D12).
    expect(mock(h.ctxState.ctx.logger!.warn!).mock.calls.map(call => String(call[0])).join(' '))
      .toContain('_staging migration is deprecated')
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const message = mock(agent.followup).mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: '看 report.pdf 的第一页' }])
    await h.service.shutdown()
  })

  it('archives an expanded merged-forward record as text', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_forward', senderId: 'u_owner', messageId: 'om_forward',
      content: '<forwarded_messages>\n[alice] 明天评审\n</forwarded_messages>',
      rawContentType: 'merge_forward',
    }))
    const dir = path.join(h.config.baseDir, '_staging', 'group', 'oc_forward', 'u_owner')
    // The record file appears before its text is flushed: wait for the content.
    await waitUntil(() => {
      expect(readdirSync(dir)).toHaveLength(1)
      expect(readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8')).toContain('明天评审')
    })
    const [name] = readdirSync(dir)
    expect(name).toMatch(/-forwarded-record\.txt$/)
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
      chatType: 'group', chatId: 'oc_post_file', senderId: 'u_owner', messageId: 'om_post_file',
      rawContentType: 'post', content: '看一下这个文件的内容', raw,
    }))
    await waitForEstablishedSession(h)
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    const dir = path.join(sessionDirOf(record), 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(readdirSync(dir)[0]).toMatch(/-bugreport-2025-11-04-141749\.zip$/)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const message = mock(agent.followup).mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: '看一下这个文件的内容' }])
    await h.service.shutdown()
  })

  it('gives every new topic its own workspace and attachments directory', async () => {
    const h = await setup()
    const chatId = 'oc_iso'
    const senderId = 'u_owner'
    const routes = () => [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, messageId: 'om_iso_a', content: '开始 A',
    }))
    await waitForEstablishedSession(h)
    const routeA = routes()[0]!
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, threadId: routeA.key, mentionedBot: false,
      messageId: 'om_iso_a_img', content: '![image](img_a)',
      resources: [{ type: 'image', fileKey: 'img_a' }] as never,
    }))
    const dirA = path.join(sessionDirOf(routeA), 'attachments')
    await waitUntil(() => expect(readdirSync(dirA).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, messageId: 'om_iso_b', content: '开始 B',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    // The route record commits after the Agent is created.
    await waitUntil(() => expect(routes().some(route => route.sessionId !== routeA.sessionId)).toBe(true))
    const routeB = routes().find(route => route.sessionId !== routeA.sessionId)!
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId, threadId: routeB.key, mentionedBot: false,
      messageId: 'om_iso_b_img', content: '![image](img_b)',
      resources: [{ type: 'image', fileKey: 'img_b' }] as never,
    }))
    const dirB = path.join(sessionDirOf(routeB), 'attachments')
    await waitUntil(() => expect(readdirSync(dirB).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))

    // Both topics share the user workspace but own distinct working
    // directories named after their thread ids.
    expect(routeB.workspacePath).toBe(routeA.workspacePath)
    expect(sessionDirOf(routeB)).not.toBe(sessionDirOf(routeA))
    expect(path.basename(sessionDirOf(routeA))).toBe(routeA.key)
    expect(path.basename(sessionDirOf(routeB))).toBe(routeB.key)
    expect(readdirSync(dirA).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1)
    expect(readdirSync(dirB).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1)

    const guidanceB = promptSectionsOf(h.ctxState.agents.created[1]!.setupCtx)
      .find(section => section.name === FEISHU_ATTACHMENTS_SECTION)?.text ?? ''
    expect(guidanceB).toContain(dirB)
    expect(guidanceB).not.toContain(dirA)
    await h.service.shutdown()
  })

  it('uses a Git worktree per topic when the user workspace is a repository', async () => {
    const h = await setup({ topicIsolation: 'auto' })
    const workspaceDir = path.join(h.config.baseDir, 'p2p', 'u_alice')
    mkdirSync(path.join(workspaceDir, '.git'), { recursive: true })
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false, content: 'hi',
    }))
    await waitForEstablishedSession(h)

    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.cwd).toBe(workspaceDir)
    expect(h.ctxState.worktrees.created).toHaveLength(1)
    expect(h.ctxState.worktrees.created[0]?.name).toBe('feishu-omt_1')
    const expectedDir = path.join(workspaceDir, '.agents', 'worktrees', 'feishu-omt_1')
    const route = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    expect(route.workspacePath).toBe(workspaceDir)
    expect(route.sessionDir).toBe(expectedDir)
    expect(route.worktreeBranch).toBe('feishu-omt_1')
    // The Session stays grouped under the user workspace.
    expect(h.ctxState.workspaces.workspaces.get(workspaceDir)).toBeDefined()
    expect(mock(h.ctxState.workspaces.workspaces.get(workspaceDir)!.attachSession))
      .toHaveBeenCalledWith(created.options.sessionId)
    await h.service.shutdown()
  })

  it('falls back to a plain topic directory when worktree creation fails', async () => {
    const h = await setup({ topicIsolation: 'worktree' })
    h.ctxState.worktrees.failWith = new Error('git denied')
    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false, content: 'hi',
    }))
    await waitForEstablishedSession(h)

    const workspaceDir = path.join(h.config.baseDir, 'p2p', 'u_alice')
    const created = h.ctxState.agents.created[0]!
    expect(created.options.meta?.cwd).toBe(workspaceDir)
    const route = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    expect(route.workspacePath).toBe(workspaceDir)
    expect(route.sessionDir).toBe(path.join(workspaceDir, 'topics', 'omt_1'))
    expect(route.worktreeBranch).toBeUndefined()
    const logged = mock(h.ctxState.ctx.logger!.warn!).mock.calls.map(call => String(call[0]))
    expect(logged.some(line => line.includes('creating a worktree'))).toBe(true)
    await h.service.shutdown()
  })

  it('keeps the same topic directory across continued messages', async () => {
    const h = await setup()
    const first = makeMessage({
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false, content: '开始',
    })
    await h.onMessage(first)
    await waitForEstablishedSession(h)
    const created = h.ctxState.agents.created[0]!
    const route = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!

    await h.onMessage(makeMessage({
      chatType: 'p2p', senderId: 'u_alice', mentionedBot: false,
      threadId: route.key, messageId: 'om_continue', content: '继续',
    }))
    await waitUntil(() => expect(mock(created.handle.agent.followup)).toHaveBeenCalledTimes(2))

    const sets = h.ctxState.workingDirectory.sets
      .filter(entry => entry.sessionId === created.options.sessionId)
    expect(sets.map(entry => entry.path)).toEqual([sessionDirOf(route)])
    expect(h.ctxState.agents.created).toHaveLength(1)
    await h.service.shutdown()
  })

  it('tells the user why an attachment could not be archived', async () => {
    const h = await setup({}, {
      downloadResource: () => {
        throw new Error('Request failed with status code 400')
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_post_fail', senderId: 'u_owner', messageId: 'om_post_fail',
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
      expect(texts.some(text => text.includes('附件保存失败') && text.includes('bugreport'))).toBe(true)
    })
    await h.service.shutdown()
  })

  it('turns an image with a caption into one prompt carrying only the caption', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_caption', senderId: 'u_owner', messageId: 'om_caption',
      content: '看这张图 ![image](img_1) 里有什么',
      resources: [{ type: 'image', fileKey: 'img_1' }] as never,
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const message = mock(agent.followup).mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: '看这张图 里有什么' }])
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    const dir = path.join(sessionDirOf(record), 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    await h.service.shutdown()
  })
})

describe('native attachment pipeline', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03])
  const pngResources = [{ type: 'image', fileKey: 'img_1' }] as never
  const routesOf = (h: SetupResult): RouteRecord[] =>
    [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)
  const firstPromptOf = (h: SetupResult) =>
    followupMessagesOf(h.ctxState.agents.created[0]!.handle.agent)[0]!.content
  const textBlocksOf = (content: Array<{ type: string; text?: string }>): string[] =>
    content.filter(block => block.type === 'text').map(block => block.text ?? '')
  const manifestOf = (content: Array<{ type: string; text?: string }>): string =>
    textBlocksOf(content).find(text => text.includes('<feishu_context>')) ?? ''

  /** Native deployment: host attachments service + Agent tools/attachments scopes. */
  const setupNative = async (
    partial: Partial<FeishuConfig> = {},
    channelOptions: Parameters<typeof makeChannel>[0] = {},
    attachmentOptions: Parameters<typeof makeAttachmentStore>[0] = {},
  ) => {
    const attachments = makeAttachmentStore(attachmentOptions)
    const tools = makeToolsRuntime()
    const h = await setup(
      partial,
      channelOptions,
      undefined,
      { agentExtras: { attachments, tools } },
      undefined,
      undefined,
      { attachments },
    )
    return { h, attachments, tools }
  }

  it('creates the session and card before a slow image prefetch resolves (AC1)', async () => {
    let release!: (chunks: Uint8Array[]) => void
    const gate = new Promise<Uint8Array[]>(resolve => { release = resolve })
    const { h } = await setupNative({}, { downloadResource: () => gate })
    const handling = h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_slow', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_slow_image', content: '这是什么 ![image](img_1)', resources: pngResources,
    }))

    // Session, topic/card and route are durable while the image bytes are
    // still blocked in the download stub — the model turn has not started.
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThan(0))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(routesOf(h)).toHaveLength(1))
    expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).not.toHaveBeenCalled()

    release([PNG])
    await handling
    await waitForEstablishedSession(h)
    const prompt = firstPromptOf(h)
    expect(prompt[0]).toEqual({ type: 'text', text: '这是什么' })
    expect(prompt[1]).toMatchObject({ type: 'image', attachment: { mediaType: 'image/png' } })
    // The prefetched image is visible in the prompt, so it is not listed as unloaded.
    expect(manifestOf(prompt)).toBe('')
    await h.service.shutdown()
  })

  it('never downloads files before the turn and lists them in the manifest (AC1/AC5)', async () => {
    const downloads: string[] = []
    const { h, attachments, tools } = await setupNative({}, {
      downloadResource: (_messageId, fileKey) => {
        downloads.push(fileKey)
        return [new TextEncoder().encode('file-bytes')]
      },
    })
    const messageId = 'om_file_trigger'
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_lazy', senderId: 'u_alice', mentionedBot: false,
      messageId, content: '看下 <file key="file_1" name="report.pdf"/> 这个文件',
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'report.pdf' }] as never,
    }))
    await waitForEstablishedSession(h)

    expect(downloads).toEqual([])
    const prompt = firstPromptOf(h)
    expect(prompt[0]).toEqual({ type: 'text', text: '看下 这个文件' })
    const manifest = manifestOf(prompt)
    expect(manifest).toContain(`message_id=${messageId}`)
    expect(manifest).toContain('file_key=file_1')
    expect(manifest).toContain('type=file')
    expect(manifest).toContain('report.pdf')

    // Lazy fetch: only the model-driven tool call downloads and stores bytes.
    const definition = tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    expect(definition).toBeDefined()
    const result = await definition!.execute(
      { message_id: messageId },
      { signal: new AbortController().signal },
    ) as { ok: boolean; results: Array<{ ok: boolean; kind?: string }> }
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ ok: true, kind: 'file' })
    expect(downloads).toEqual(['file_1'])
    expect(attachments.savedFiles).toHaveLength(1)
    expect(new TextDecoder().decode(attachments.savedFiles[0]!.data)).toBe('file-bytes')
    const rendered = definition!.output.render({ message_id: messageId }, result)
    expect(rendered.some(block => block.type === 'text')).toBe(true)
    expect(rendered.some(block => block.type === 'file')).toBe(true)
    await h.service.shutdown()
  })

  it('prefetches trigger images into image blocks and omits them from the manifest (AC2/AC4)', async () => {
    const { h, attachments } = await setupNative({}, { downloadResource: () => [PNG] })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_prefetch', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_image_trigger', content: '这张图是什么 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(h)

    const prompt = firstPromptOf(h)
    expect(prompt).toHaveLength(2)
    expect(prompt[0]).toEqual({ type: 'text', text: '这张图是什么' })
    expect(prompt[1]).toMatchObject({ type: 'image' })
    expect(manifestOf(prompt)).toBe('')
    expect(attachments.savedImages).toHaveLength(1)
    await h.service.shutdown()
  })

  it('keeps native inbound attachments out of the workspace and staging (AC7)', async () => {
    const { h, attachments } = await setupNative({}, { downloadResource: () => [PNG] })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_native_cleanup', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_native_cleanup', content: '看这张图 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(h)
    expect(attachments.savedImages).toHaveLength(1)
    const topicDir = sessionDirOf(routesOf(h)[0]!)
    // The native pipeline writes only the native attachment library: no
    // workspace copy and no legacy staging.
    expect(existsSync(path.join(topicDir, 'attachments'))).toBe(false)
    expect(existsSync(path.join(h.config.baseDir, '_staging'))).toBe(false)
    await h.service.shutdown()
  })

  /** Recording `message.list` stub serving one scripted page per container type. */
  const scriptedHistory = (pages: { chat?: unknown[]; thread?: unknown[] }) => {
    const calls: RawMessageListParams[] = []
    const messageList = async (params: RawMessageListParams) => {
      calls.push(params)
      const items = params.container_id_type === 'chat' ? pages.chat : pages.thread
      return makeMessageListResponse(items ?? [])
    }
    return { calls, messageList }
  }

  it('keeps attachment-only and un-mentioned messages inert and out of later manifests (AC2/AC3)', async () => {
    const downloads: string[] = []
    // The main timeline still holds the earlier files: only a quote brings them in.
    const history = scriptedHistory({
      chat: [
        makeRawMessage({
          message_id: 'om_silent_image', msg_type: 'image', chat_id: 'oc_silent',
          sender_id: 'u_alice', content: { image_key: 'img_1' },
        }),
        makeRawMessage({
          message_id: 'om_group_silent', msg_type: 'file', chat_id: 'oc_group',
          sender_id: 'u_alice', content: { file_key: 'g1', file_name: 'a.txt' },
        }),
      ],
    })
    const { h } = await setupNative({}, {
      messageList: history.messageList,
      downloadResource: (_messageId, fileKey) => {
        downloads.push(fileKey)
        return [PNG]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_silent', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_silent_image', rawContentType: 'image', content: '![image](img_1)', resources: pngResources,
    }))
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_group_silent', rawContentType: 'file', content: '<file key="g1" name="a.txt"/>',
      resources: [{ type: 'file', fileKey: 'g1', fileName: 'a.txt' }] as never,
    }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.channel.reactions).toEqual([])
    expect(downloads).toEqual([])
    expect(routesOf(h)).toHaveLength(0)
    expect(history.calls).toEqual([])

    // A later un-quoted trigger never reads the main timeline for them.
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_silent', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_silent_text', content: '刚才那张图是什么',
    }))
    await waitForEstablishedSession(h)
    expect(manifestOf(firstPromptOf(h))).toBe('')
    expect(history.calls.filter(call => call.container_id_type === 'chat')).toEqual([])
    expect(downloads).toEqual([])
    await h.service.shutdown()
  })

  it('keeps a bound topic quiet for attachment-only messages but continues on text (AC3/AC6)', async () => {
    const history = scriptedHistory({})
    const { h } = await setupNative({}, { messageList: history.messageList, downloadResource: () => [PNG] })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_topic', senderId: 'u_alice', mentionedBot: true,
      messageId: 'om_topic_first', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const route = routesOf(h)[0]!
    expect(h.channel.sent).toHaveLength(1)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_topic', senderId: 'u_alice', mentionedBot: false,
      threadId: route.key, messageId: 'om_topic_silent', rawContentType: 'image', content: '![image](img_1)', resources: pngResources,
    }))
    // No second card, no reaction, no download, no new Session.
    expect(h.channel.sent).toHaveLength(1)
    expect(h.ctxState.agents.created).toHaveLength(1)
    expect(h.channel.reactions).toEqual([{ messageId: 'om_topic_first', emojiType: 'Typing' }])

    const callsBefore = history.calls.length
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_topic', senderId: 'u_alice', mentionedBot: false,
      threadId: route.key, messageId: 'om_topic_text', content: '刚才的图是什么',
    }))
    await waitUntil(() => expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(2))
    const followups = followupMessagesOf(h.ctxState.agents.created[0]!.handle.agent)
    // The silent image is reachable through a quote or feishu_topic_messages,
    // never through a history scan on the continuation turn.
    expect(manifestOf(followups[1]!.content)).toBe('')
    expect(history.calls).toHaveLength(callsBefore)
    await h.service.shutdown()
  })

  it('degrades failed, oversized, timed-out, or disabled image prefetch to the manifest (AC4)', async () => {
    // Storage failure: no image block, image listed as unloaded, turn proceeds.
    const failing = await setupNative({}, { downloadResource: () => [PNG] }, {
      failImage: new Error('fake store exploded'),
    })
    await failing.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_fail', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_fail_image', content: '看图 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(failing.h)
    const failedPrompt = firstPromptOf(failing.h)
    expect(failedPrompt.some(block => block.type === 'image')).toBe(false)
    expect(manifestOf(failedPrompt)).toContain('message_id=om_fail_image')
    await failing.h.service.shutdown()

    // Per-image cap: bytes exceed the configured cap, so the image stays lazy.
    const capped = await setupNative({ prefetchImageMaxBytes: 1 }, { downloadResource: () => [PNG] })
    await capped.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_cap', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_cap_image', content: '看图 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(capped.h)
    expect(firstPromptOf(capped.h).some(block => block.type === 'image')).toBe(false)
    await capped.h.service.shutdown()

    // Explicitly disabled prefetch: images always go through the tool.
    const disabled = await setupNative({ prefetchImages: false }, { downloadResource: () => [PNG] })
    await disabled.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_no_prefetch', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_no_prefetch', content: '看图 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(disabled.h)
    const disabledPrompt = firstPromptOf(disabled.h)
    expect(disabledPrompt.some(block => block.type === 'image')).toBe(false)
    expect(manifestOf(disabledPrompt)).toContain('file_key=img_1')
    expect(disabled.attachments.savedImages).toHaveLength(0)
    await disabled.h.service.shutdown()

    // Timeout: a stalled download must not hold the turn past the short budget.
    const stalled = await setupNative({ prefetchTimeoutMs: 100 }, {
      downloadResource: () => new Promise<Uint8Array[]>(() => {}),
    })
    await stalled.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_stall', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_stall_image', content: '看图 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(stalled.h)
    const stalledPrompt = firstPromptOf(stalled.h)
    expect(stalledPrompt.some(block => block.type === 'image')).toBe(false)
    expect(manifestOf(stalledPrompt)).toContain('message_id=om_stall_image')
    await stalled.h.service.shutdown()
  })

  it('turns no attachment into no manifest token (AC2)', async () => {
    const { h } = await setupNative()
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_plain', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_plain', content: '普通消息',
    }))
    await waitForEstablishedSession(h)
    expect(firstPromptOf(h)).toEqual([{ type: 'text', text: '普通消息' }])
    await h.service.shutdown()
  })

  it('keeps attachment-only messages inert when attachments are disabled (AC3/AC7)', async () => {
    const downloads: string[] = []
    const { h, tools } = await setupNative({ acceptAttachments: false }, {
      downloadResource: (_messageId, fileKey) => {
        downloads.push(fileKey)
        return [PNG]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_off', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_off_image', content: '![image](img_1)', resources: pngResources,
    }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(0)
    expect(h.channel.reactions).toEqual([])
    expect(downloads).toEqual([])

    // A text turn is still served, with the inert/archive guidance (attachments
    // are disabled, so the native manifest and fetch tool must not be advertised).
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_off', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_off_text', content: '你好',
    }))
    await waitForEstablishedSession(h)
    // Inert attachments: no attachment guidance section and no fetch tool.
    const guidance = promptSectionsOf(h.ctxState.agents.created[0]!.setupCtx)
      .find(section => section.name === FEISHU_ATTACHMENTS_SECTION)?.text
    expect(guidance).toBeUndefined()
    // The lazy fetch tool is not advertised; the read-only topic tool is
    // backend-independent and stays available (it self-gates on config).
    expect(tools.definitions.has(ATTACHMENT_FETCH_TOOL_NAME)).toBe(false)
    expect(tools.definitions.has(TOPIC_MESSAGES_TOOL_NAME)).toBe(true)
    await h.service.shutdown()
  })

  it('keeps the legacy archive behavior for explicit archive and missing-service deployments (AC7)', async () => {
    // Explicit archive wins even when the native library is mounted.
    const attachments = makeAttachmentStore()
    const archiveTools = makeToolsRuntime()
    const archived = await setup(
      { attachmentStore: 'archive' },
      { downloadResource: () => [PNG] },
      undefined,
      { agentExtras: { attachments, tools: archiveTools } },
      undefined,
      undefined,
      { attachments },
    )
    await archived.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_archive', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_archive_image', content: '![image](img_1)', resources: pngResources,
    }))
    const staging = path.join(archived.config.baseDir, '_staging', 'p2p', 'oc_archive', 'u_alice')
    await waitUntil(() => expect(readdirSync(staging).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(mock(archived.channel.downloadResource)).toHaveBeenCalled()
    expect(archived.ctxState.agents.created).toHaveLength(0)
    // A text turn in archive mode must not advertise the lazy fetch tool.
    await archived.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_archive', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_archive_text', content: '开始',
    }))
    await waitForEstablishedSession(archived)
    expect(archiveTools.definitions.has(ATTACHMENT_FETCH_TOOL_NAME)).toBe(false)
    expect(archiveTools.definitions.has(TOPIC_MESSAGES_TOOL_NAME)).toBe(true)
    await archived.service.shutdown()

    // Native configuration without the host service falls back to the legacy
    // synchronous download for the triggering message.
    const fallback = await setup({}, { downloadResource: () => [PNG] })
    await fallback.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_fallback', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_fallback_image', content: '看图 ![image](img_1)', resources: pngResources,
    }))
    await waitForEstablishedSession(fallback)
    expect(mock(fallback.channel.downloadResource)).toHaveBeenCalled()
    expect(firstPromptOf(fallback)).toEqual([{ type: 'text', text: '看图' }])
    const record = routesOf(fallback)[0]!
    const dir = path.join(sessionDirOf(record), 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    const fallbackWarnings = mock(fallback.ctxState.ctx.logger?.warn).mock.calls.flat().join(' ')
    expect(fallbackWarnings).toContain('宿主未挂载 ctx.attachments')
    await fallback.service.shutdown()
  })

  it('delivers the first topic turn before a message arriving during its prefetch (ordering)', async () => {
    let release!: (chunks: Uint8Array[]) => void
    const gate = new Promise<Uint8Array[]>(resolve => { release = resolve })
    const { h } = await setupNative({}, { downloadResource: () => gate })

    void h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_order', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_order_first', rawContentType: 'image',
      content: '看图 ![image](img_1)', resources: pngResources,
    }))
    await waitUntil(() => expect(routesOf(h)).toHaveLength(1))
    const route = routesOf(h)[0]!
    const firstAgent = h.ctxState.agents.created[0]!.handle.agent
    expect(mock(firstAgent.followup)).not.toHaveBeenCalled()

    // The route is durable while the first prompt is still assembling: a
    // second message in the topic must wait for the first followup.
    void h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_order', senderId: 'u_alice', mentionedBot: false,
      threadId: route.key, messageId: 'om_order_second', content: '第二句',
    }))
    await flush()
    await flush()
    expect(mock(firstAgent.followup)).not.toHaveBeenCalled()

    release([PNG])
    await waitUntil(() => expect(mock(firstAgent.followup)).toHaveBeenCalledTimes(2))
    const followups = followupMessagesOf(firstAgent)
    expect(followups[0]!.content[0]).toEqual({ type: 'text', text: '看图' })
    expect(followups[0]!.content[1]).toMatchObject({ type: 'image' })
    expect(followups[1]!.content).toEqual([{ type: 'text', text: '第二句' }])
    await h.service.shutdown()
  })

  it('never registers attachments of a foreign sender in a bound topic (AC3)', async () => {
    const downloads: string[] = []
    const { h } = await setupNative({}, {
      downloadResource: (_messageId, fileKey) => {
        downloads.push(fileKey)
        return [PNG]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_foreign', senderId: 'u_alice', mentionedBot: true,
      messageId: 'om_foreign_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const route = routesOf(h)[0]!
    const sentBefore = h.channel.sent.length
    const reactionsBefore = h.channel.reactions.length
    const processed = h.ctxState.domain.raw.table('processed')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_foreign', senderId: 'u_bob', mentionedBot: false,
      threadId: route.key, messageId: 'om_foreign_image', rawContentType: 'image',
      content: '![image](img_9)', resources: [{ type: 'image', fileKey: 'img_9' }] as never,
    }))
    await waitUntil(() => expect(processed.get('om_foreign_image')).toBeDefined())

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_foreign', senderId: 'u_bob', mentionedBot: false,
      threadId: route.key, messageId: 'om_foreign_mixed', rawContentType: 'image',
      content: '看这个 ![image](img_9)', resources: [{ type: 'image', fileKey: 'img_9' }] as never,
    }))
    await waitUntil(() => expect(processed.get('om_foreign_mixed')).toBeDefined())
    await flush()
    await flush()

    expect(h.ctxState.agents.created).toHaveLength(1)
    expect(h.channel.sent).toHaveLength(sentBefore)
    expect(h.channel.reactions).toHaveLength(reactionsBefore)
    expect(downloads).toEqual([])
    await h.service.shutdown()
  })

  it('keeps a denied sender\'s attachments inert (AC3)', async () => {
    const downloads: string[] = []
    const { h } = await setupNative({ accessMode: 'guarded', adminUserId: 'u_admin' }, {
      downloadResource: (_messageId, fileKey) => {
        downloads.push(fileKey)
        return [PNG]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_denied', senderId: 'u_mallory', mentionedBot: false,
      messageId: 'om_denied_image', rawContentType: 'image', content: '![image](img_x)',
      resources: [{ type: 'image', fileKey: 'img_x' }] as never,
    }))
    // A denied private chat gets the fixed notice; waiting for it proves the
    // message passed the admission gate and took the denial path.
    await waitUntil(() => expect(h.channel.sent.length).toBeGreaterThan(0))
    await flush()

    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.reactions).toEqual([])
    expect(downloads).toEqual([])
    await h.service.shutdown()
  })

  it('falls back to the archive backend when the fetch tool is disabled (AC7)', async () => {
    const attachments = makeAttachmentStore()
    const tools = makeToolsRuntime()
    const h = await setup(
      {
        feishuTools: {
          attachmentFetch: false,
          attachmentFetchMaxResources: 10,
          attachmentFetchMaxBytes: 100 * 1024 * 1024,
          attachmentFetchTimeoutMs: 120_000,
          topicMessages: true,
          topicMessagesTimeoutMs: 20_000,
          sendFile: true,
          wikiRead: false,
          wikiWrite: false,
        },
      },
      { downloadResource: () => [PNG] },
      undefined,
      { agentExtras: { attachments, tools } },
      undefined,
      undefined,
      { attachments },
    )
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_tool_off', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_tool_off', rawContentType: 'image', content: '看图 ![image](img_1)',
      resources: pngResources,
    }))
    await waitForEstablishedSession(h)

    expect(mock(h.channel.downloadResource)).toHaveBeenCalled()
    expect(firstPromptOf(h)).toEqual([{ type: 'text', text: '看图' }])
    // The bytes land in the legacy workspace archive, not the native library:
    // the archive guidance tells the model to read exactly that directory.
    const record = routesOf(h)[0]!
    const dir = path.join(sessionDirOf(record), 'attachments')
    await waitUntil(() => expect(readdirSync(dir).filter(name => !name.startsWith('.tmp-'))).toHaveLength(1))
    expect(attachments.savedImages).toHaveLength(0)
    // The lazy pipeline (and its fetch tool) is not advertised to the model.
    expect(tools.definitions.has(ATTACHMENT_FETCH_TOOL_NAME)).toBe(false)
    expect(tools.definitions.has(TOPIC_MESSAGES_TOOL_NAME)).toBe(true)
    const guidance = promptSectionsOf(h.ctxState.agents.created[0]!.setupCtx)
      .find(section => section.name === FEISHU_ATTACHMENTS_SECTION)?.text ?? ''
    expect(guidance).toContain('attachments/')
    expect(guidance).not.toContain('native attachment library')
    await h.service.shutdown()
  })

  it('mounts the native guidance only when the native library is effective (AC2/AC7)', async () => {
    const { h } = await setupNative()
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_guidance', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_guidance', content: '开始',
    }))
    await waitForEstablishedSession(h)
    const guidance = promptSectionsOf(h.ctxState.agents.created[0]!.setupCtx)
      .find(section => section.name === FEISHU_ATTACHMENTS_SECTION)?.text ?? ''
    expect(guidance).toContain('native attachment library')
    expect(guidance).toContain('feishu_attachment_fetch')
    expect(guidance).toContain('<feishu_context>')
    expect(guidance).not.toContain(`${sessionDirOf(routesOf(h)[0]!)}/attachments`)
    await h.service.shutdown()
  })
})


describe('quote excerpts and first-turn topic history', () => {
  const routesOf = (h: SetupResult): RouteRecord[] =>
    [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)
  const promptOf = (h: SetupResult, index = 0) =>
    followupMessagesOf(h.ctxState.agents.created[0]!.handle.agent)[index]!.content
  const textBlocksOf = (content: Array<{ type: string; text?: string }>): string[] =>
    content.filter(block => block.type === 'text').map(block => block.text ?? '')
  const blockWith = (content: Array<{ type: string; text?: string }>, marker: string): string =>
    textBlocksOf(content).find(text => text.includes(marker)) ?? ''
  /** Every outbound payload as JSON text (error-card / failure-notice scan). */
  const sentTextsOf = (h: SetupResult): string[] =>
    h.channel.sent.map(item => JSON.stringify((item as { input: object }).input))
  /** Native harness: host attachments library + Agent tools scope (both tools mount). */
  const setupTurnReader = async (
    partial: Partial<FeishuConfig> = {},
    channelOptions: Parameters<typeof makeChannel>[0] = {},
    attachmentOptions: Parameters<typeof makeAttachmentStore>[0] = {},
  ) => {
    const attachments = makeAttachmentStore(attachmentOptions)
    const tools = makeToolsRuntime()
    const h = await setup(
      partial,
      channelOptions,
      undefined,
      { agentExtras: { attachments, tools } },
      undefined,
      undefined,
      { attachments },
    )
    return { h, attachments, tools }
  }

  it('injects the quoted message as a feishu_quote block in the first prompt (AC1)', async () => {
    const { h } = await setupTurnReader({}, {
      messageGet: async messageId => messageId === 'om_quoted_text'
        ? makeMessageGetResponse([makeRawMessage({
          message_id: 'om_quoted_text', msg_type: 'text', chat_id: 'oc_quote_text',
          content: { text: '被引用的上一句话' },
        })])
        : makeMessageGetResponse([]),
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_quote_text', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_quote_trigger', replyToMessageId: 'om_quoted_text', content: '接着这个说',
    }))
    await waitForEstablishedSession(h)

    const prompt = promptOf(h)
    expect(prompt[0]).toEqual({ type: 'text', text: '接着这个说' })
    // Block order: caption, quote (no image / manifest / history extras here).
    const quote = blockWith(prompt, '<feishu_quote>')
    expect(quote).toContain('被引用的上一句话')
    expect(quote).toContain('</feishu_quote>')
    expect(textBlocksOf(prompt)).toHaveLength(2)
    await h.service.shutdown()
  })

  it('injects a quote excerpt on a continuation turn too (AC1)', async () => {
    const { h } = await setupTurnReader({}, {
      messageGet: async messageId => makeMessageGetResponse([makeRawMessage({
        message_id: messageId, msg_type: 'text', chat_id: 'oc_cont_quote',
        content: { text: messageId === 'om_cont_quote' ? '被引用的第二句' : '被引用的第一句' },
      })]),
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_cont_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_cont_trigger', replyToMessageId: 'om_first_quote', content: '第一轮',
    }))
    await waitForEstablishedSession(h)
    const agent = h.ctxState.agents.created[0]!.handle.agent
    expect(blockWith(promptOf(h), '<feishu_quote>')).toContain('被引用的第一句')

    const record = routesOf(h)[0]!
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_cont_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_cont_followup', threadId: record.key, replyToMessageId: 'om_cont_quote',
      content: '第二轮也引用',
    }))
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))
    const continuation = blockWith(promptOf(h, 1), '<feishu_quote>')
    expect(continuation).toContain('被引用的第二句')
    await h.service.shutdown()
  })

  it('authorizes a quoted file so the fetch tool can download it (AC1)', async () => {
    const downloads: Array<{ messageId: string; fileKey: string }> = []
    const { h, attachments, tools } = await setupTurnReader({}, {
      messageGet: async messageId => messageId === 'om_quoted_file'
        ? makeMessageGetResponse([makeRawMessage({
          message_id: 'om_quoted_file', msg_type: 'file', chat_id: 'oc_quote_file',
          content: { file_key: 'file_q1', file_name: 'quoted.pdf' },
        })])
        : makeMessageGetResponse([]),
      downloadResource: (messageId, fileKey) => {
        downloads.push({ messageId, fileKey })
        return [new TextEncoder().encode('quoted-file-bytes')]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_quote_file', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_quote_file_trigger', replyToMessageId: 'om_quoted_file', content: '看下引用的文件',
    }))
    await waitForEstablishedSession(h)
    expect(blockWith(promptOf(h), '<feishu_quote>')).toContain('quoted.pdf')

    // AC1 discoverability: the quoted file is listed in the manifest with a
    // real message_id/file_key, not just named in the excerpt. The model must
    // be able to reach it without the test hardcoding the id.
    const manifest = blockWith(promptOf(h), '<feishu_context>')
    expect(manifest).toContain('message_id=om_quoted_file')
    expect(manifest).toContain('file_key=file_q1')
    expect(manifest).toContain('name="quoted.pdf"')
    const discoveredId = /message_id=(om_[A-Za-z0-9_-]+)/u.exec(manifest)?.[1]
    expect(discoveredId).toBe('om_quoted_file')

    const definition = tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    expect(definition).toBeDefined()
    const result = await definition!.execute(
      { message_id: discoveredId },
      { signal: new AbortController().signal },
    ) as { ok: boolean; results: Array<{ ok: boolean; kind?: string }> }
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ ok: true, kind: 'file' })
    expect(downloads).toEqual([{ messageId: 'om_quoted_file', fileKey: 'file_q1' }])
    expect(attachments.savedFiles).toHaveLength(1)
    expect(new TextDecoder().decode(attachments.savedFiles[0]!.data)).toBe('quoted-file-bytes')
    await h.service.shutdown()
  })

  it('expands a quoted merged forward and downloads children through the container id (AC2)', async () => {
    const containerId = 'om_forward_container'
    const imageChildId = 'om_forward_image_child'
    const downloads: Array<{ messageId: string; fileKey: string }> = []
    const { h, tools } = await setupTurnReader({}, {
      messageGet: async messageId => messageId === containerId
        ? makeMessageGetResponse([
          makeRawMessage({
            message_id: containerId, msg_type: 'merge_forward', chat_id: 'oc_forward_quote',
          }),
          makeRawMessage({
            message_id: 'om_forward_text_child', msg_type: 'text', chat_id: 'oc_forward_quote',
            upper_message_id: containerId, content: { text: '转发里的讨论内容' },
          }),
          makeRawMessage({
            message_id: imageChildId, msg_type: 'image', chat_id: 'oc_forward_quote',
            upper_message_id: containerId, content: { image_key: 'img_forward_1' },
          }),
        ])
        : makeMessageGetResponse([]),
      downloadResource: (messageId, fileKey) => {
        downloads.push({ messageId, fileKey })
        return [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_forward_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_forward_trigger', replyToMessageId: containerId, content: '看下这条转发',
    }))
    await waitForEstablishedSession(h)

    const quote = blockWith(promptOf(h), '<feishu_quote>')
    expect(quote).toContain('转发里的讨论内容')
    expect(quote).toContain('合并转发')
    expect(quote).toContain(`message_id=${containerId}`)
    // AC2 discoverability: the container id is listed in the manifest and is
    // the id the fetch tool must download the children through.
    const manifest = blockWith(promptOf(h), '<feishu_context>')
    expect(manifest).toContain(`message_id=${containerId} type=merge_forward`)

    const definition = tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    const result = await definition!.execute(
      { message_id: containerId },
      { signal: new AbortController().signal },
    ) as { ok: boolean; results: Array<{ ok: boolean; kind?: string }> }
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ ok: true, kind: 'image' })
    // P0 rule: children download through the container's own message id.
    expect(downloads).toEqual([{ messageId: containerId, fileKey: 'img_forward_1' }])
    expect(downloads.some(entry => entry.messageId === imageChildId)).toBe(false)
    await h.service.shutdown()
  })

  it('attaches the bounded topic history to the first turn only (AC3/AC4)', async () => {
    const listCalls: RawMessageListParams[] = []
    const { h } = await setupTurnReader({}, {
      messageList: async params => {
        listCalls.push(params)
        const now = Date.now()
        return makeMessageListResponse([
          makeRawMessage({
            message_id: 'om_hist_newest', msg_type: 'text', create_time: now,
            content: { text: '最新一条讨论' },
          }),
          makeRawMessage({
            message_id: 'om_hist_older', msg_type: 'text', create_time: now - 60_000,
            content: { text: '更早的讨论' },
          }),
          // Excluded: the trigger itself and the streaming card the bot just sent.
          makeRawMessage({
            message_id: 'om_hist_trigger', msg_type: 'text', create_time: now - 120_000,
            content: { text: '当前问题' },
          }),
          makeRawMessage({
            message_id: 'om_1', msg_type: 'text', create_time: now - 180_000,
            content: { text: '流式卡片' },
          }),
        ])
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_history', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_trigger', content: '当前问题',
    }))
    await waitForEstablishedSession(h)

    const history = blockWith(promptOf(h), '<feishu_history>')
    expect(history).toContain('更早的讨论')
    expect(history).toContain('最新一条讨论')
    // Chronological order (oldest first) inside the block.
    expect(history.indexOf('更早的讨论')).toBeLessThan(history.indexOf('最新一条讨论'))
    expect(history).not.toContain('当前问题')
    expect(history).not.toContain('流式卡片')
    // One page sized for the bootstrap limit plus the two excluded ids.
    expect(listCalls[0]).toMatchObject({
      container_id_type: 'thread', page_size: 12, sort_type: 'ByCreateTimeDesc',
    })

    // Continuing the same topic must not inject the history again.
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const record = routesOf(h)[0]!
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_history', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_followup', threadId: record.key, content: '第二句',
    }))
    await waitUntil(() => expect(mock(agent.followup)).toHaveBeenCalledTimes(2))
    const followup = promptOf(h, 1)
    expect(textBlocksOf(followup)).toEqual(['第二句'])
    // Only the recent-attachment scans (one full page each) read again.
    expect(listCalls.filter(call => call.page_size === 12)).toHaveLength(1)
    await h.service.shutdown()
  })

  it('reads degraded chat-route history through message.list(chat) (AC3)', async () => {
    const listCalls: RawMessageListParams[] = []
    const { h } = await setupTurnReader({}, {
      // Feishu refuses the topic reply → degraded chat-scoped route.
      failReplyInThread: true,
      messageList: async params => {
        listCalls.push(params)
        return makeMessageListResponse([
          makeRawMessage({
            message_id: 'om_chat_hist', msg_type: 'text', chat_id: 'oc_chat_route',
            create_time: Date.now(), content: { text: '聊天主线上的历史' },
          }),
        ])
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_chat_route', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_chat_route_trigger', content: '降级会话',
    }))
    await waitForEstablishedSession(h)
    expect(routesOf(h)[0]!.kind).toBe('chat')
    expect(blockWith(promptOf(h), '<feishu_history>')).toContain('聊天主线上的历史')
    // A degraded (topic-less) route reads the chat main timeline.
    expect(listCalls[0]).toMatchObject({
      container_id_type: 'chat', container_id: 'oc_chat_route',
    })
    await h.service.shutdown()
  })

  it('authorizes attachments discovered in the history bootstrap (AC3)', async () => {
    const downloads: Array<{ messageId: string; fileKey: string }> = []
    const { h, attachments, tools } = await setupTurnReader({}, {
      messageList: async () => makeMessageListResponse([
        makeRawMessage({
          message_id: 'om_hist_file', msg_type: 'file', create_time: Date.now(),
          chat_id: 'oc_hist_file', content: { file_key: 'file_hist', file_name: 'earlier.pdf' },
        }),
      ]),
      downloadResource: (messageId, fileKey) => {
        downloads.push({ messageId, fileKey })
        return [new TextEncoder().encode('history-file-bytes')]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_hist_file', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_file_trigger', content: '之前那个文件是什么',
    }))
    await waitForEstablishedSession(h)
    const history = blockWith(promptOf(h), '<feishu_history>')
    expect(history).toContain('earlier.pdf')
    // AC3 discoverability: the history line carries the message id the model
    // needs to fetch the attachment later.
    expect(history).toContain('message_id=om_hist_file')
    const discoveredId = /message_id=(om_[A-Za-z0-9_-]+)/u.exec(history)?.[1]
    expect(discoveredId).toBe('om_hist_file')

    const definition = tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    const result = await definition!.execute(
      { message_id: discoveredId },
      { signal: new AbortController().signal },
    ) as { ok: boolean; results: Array<{ ok: boolean; kind?: string }> }
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ ok: true, kind: 'file' })
    expect(downloads).toEqual([{ messageId: 'om_hist_file', fileKey: 'file_hist' }])
    expect(attachments.savedFiles).toHaveLength(1)
    await h.service.shutdown()
  })

  it('caps passive reads with promptContextTimeoutMs, not the tool timeout (AC4/AC6)', async () => {
    const { h } = await setupTurnReader({ promptContextTimeoutMs: 50 }, {
      // The passive read never settles: only the short prompt budget may end it.
      messageList: async () => new Promise(() => {}),
    })
    const started = Date.now()
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_prompt_budget', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_prompt_budget', content: '历史读慢一点也没关系',
    }))
    await waitForEstablishedSession(h)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(1_000)
    expect(blockWith(promptOf(h), '<feishu_history>')).toBe('')
    expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1)
    await h.service.shutdown()
  })

  it('honors historyBootstrapLimit: 0 by never reading history (AC4)', async () => {
    const list = vi.fn(async (_params: RawMessageListParams) => makeMessageListResponse([]))
    const { h } = await setupTurnReader({ historyBootstrapLimit: 0 }, { messageList: list })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_hist_off', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_off', content: '不用历史',
    }))
    await waitForEstablishedSession(h)
    expect(blockWith(promptOf(h), '<feishu_history>')).toBe('')
    expect(list).not.toHaveBeenCalled()
    await h.service.shutdown()
  })

  it('marks oversized history lines as truncated (AC4)', async () => {
    const { h } = await setupTurnReader({}, {
      messageList: async () => makeMessageListResponse([
        makeRawMessage({
          message_id: 'om_hist_long', msg_type: 'text', create_time: Date.now(),
          content: { text: '甲'.repeat(600) },
        }),
      ]),
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_hist_long', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_long_trigger', content: '很长吗',
    }))
    await waitForEstablishedSession(h)
    expect(blockWith(promptOf(h), '<feishu_history>')).toContain('已截断')
    await h.service.shutdown()
  })

  it('degrades permission failures of the history read silently (AC6)', async () => {
    const denied = await setupTurnReader({}, {
      messageList: async () => {
        throw Object.assign(new Error('permission denied'), { status: 403 })
      },
    })
    await denied.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_hist_denied', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_denied', content: '还能继续吗',
    }))
    await waitForEstablishedSession(denied.h)
    expect(blockWith(promptOf(denied.h), '<feishu_history>')).toBe('')
    expect(mock(denied.h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1)
    expect(sentTextsOf(denied.h).some(text => text.includes('处理失败'))).toBe(false)
    // One audible warn per service lifetime makes a missing scope findable
    // without turning every degraded turn into log spam.
    const degradedWarn = mock(denied.h.ctxState.ctx.logger?.warn)
    expect(degradedWarn.mock.calls.some(call => String(call[0]).includes('静默降级'))).toBe(true)
    await denied.h.service.shutdown()

    // Feishu scope error code shape (`{ code: 99991672 }`).
    const missingScope = await setupTurnReader({}, {
      messageList: async () => {
        throw { code: 99991672, msg: 'no permission to read messages' }
      },
    })
    await missingScope.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_hist_scope', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_hist_scope', content: '也没有权限',
    }))
    await waitForEstablishedSession(missingScope.h)
    expect(blockWith(promptOf(missingScope.h), '<feishu_history>')).toBe('')
    expect(mock(missingScope.h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1)
    expect(sentTextsOf(missingScope.h).some(text => text.includes('处理失败'))).toBe(false)
    await missingScope.h.service.shutdown()
  })

  it('degrades a failed quote read silently and still runs the turn (AC6)', async () => {
    const { h } = await setupTurnReader({}, {
      messageGet: async () => {
        throw Object.assign(new Error('forbidden'), { status: 403 })
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_quote_denied', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_quote_denied_trigger', replyToMessageId: 'om_missing_quote', content: '引用读不到',
    }))
    await waitForEstablishedSession(h)
    expect(blockWith(promptOf(h), '<feishu_quote>')).toBe('')
    expect(mock(h.ctxState.agents.created[0]!.handle.agent.followup)).toHaveBeenCalledTimes(1)
    expect(sentTextsOf(h).some(text => text.includes('处理失败'))).toBe(false)
    await h.service.shutdown()
  })

  it('drops quoted messages that belong to another chat or topic (AC5)', async () => {
    const foreignChat = await setupTurnReader({}, {
      messageGet: async messageId => messageId === 'om_foreign_quote'
        ? makeMessageGetResponse([makeRawMessage({
          message_id: 'om_foreign_quote', msg_type: 'file', chat_id: 'oc_another_chat',
          content: { file_key: 'file_foreign', file_name: 'secret.pdf' },
        })])
        : makeMessageGetResponse([]),
    })
    await foreignChat.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_quote_guard', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_quote_guard_trigger', replyToMessageId: 'om_foreign_quote', content: '看引用',
    }))
    await waitForEstablishedSession(foreignChat.h)
    expect(blockWith(promptOf(foreignChat.h), '<feishu_quote>')).toBe('')
    const fetchTool = foreignChat.tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    const denied = await fetchTool!.execute(
      { message_id: 'om_foreign_quote' },
      { signal: new AbortController().signal },
    ) as { ok: boolean; summary: string }
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('授权范围')
    await foreignChat.h.service.shutdown()

    // Same chat, but the quoted message belongs to a *different* topic.
    const foreignThread = await setupTurnReader({}, {
      messageGet: async messageId => messageId === 'om_other_topic_quote'
        ? makeMessageGetResponse([makeRawMessage({
          message_id: 'om_other_topic_quote', msg_type: 'text', chat_id: 'oc_quote_guard_thread',
          thread_id: 'omt_other_topic', content: { text: '别的主题内容' },
        })])
        : makeMessageGetResponse([]),
    })
    await foreignThread.h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_quote_guard_thread', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_quote_guard_thread_trigger', replyToMessageId: 'om_other_topic_quote',
      content: '看引用',
    }))
    await waitForEstablishedSession(foreignThread.h)
    expect(blockWith(promptOf(foreignThread.h), '<feishu_quote>')).toBe('')
    await foreignThread.h.service.shutdown()
  })

  it('rejects a quoted topic message on a degraded chat route (AC6)', async () => {
    const { h, tools } = await setupTurnReader({}, {
      // Feishu refuses the topic reply → the session runs on a chat-scoped route.
      failReplyInThread: true,
      messageGet: async () => makeMessageGetResponse([makeRawMessage({
        message_id: 'om_degraded_quote', msg_type: 'file', chat_id: 'oc_degraded_quote',
        thread_id: 'omt_other_topic',
        content: { file_key: 'file_leak', file_name: 'leak.pdf' },
      })]),
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_degraded_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_degraded_trigger', replyToMessageId: 'om_degraded_quote', content: '看这个引用',
    }))
    await waitForEstablishedSession(h)
    expect(routesOf(h)[0]!.kind).toBe('chat')
    // A chat route must not pull another topic's message into the prompt...
    expect(blockWith(promptOf(h), '<feishu_quote>')).toBe('')
    // ...nor authorize its attachment for the fetch tool.
    const fetchTool = tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    const denied = await fetchTool!.execute(
      { message_id: 'om_degraded_quote' },
      { signal: new AbortController().signal },
    ) as { ok: boolean; summary: string }
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('授权范围')
    await h.service.shutdown()
  })

  it('drops a quoted message whose response has no chat id (fail closed)', async () => {
    const { h } = await setupTurnReader({}, {
      messageGet: async () => makeMessageGetResponse([makeRawMessage({
        message_id: 'om_no_chat_quote', msg_type: 'text', content: { text: '没有 chat id' },
      })]),
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_no_chat_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_no_chat_trigger', replyToMessageId: 'om_no_chat_quote', content: '看引用',
    }))
    await waitForEstablishedSession(h)
    expect(blockWith(promptOf(h), '<feishu_quote>')).toBe('')
    await h.service.shutdown()
  })

  it('mounts feishu_topic_messages and lets it authorize what it discovers (AC3/AC5)', async () => {
    const downloads: Array<{ messageId: string; fileKey: string }> = []
    const { h, attachments, tools } = await setupTurnReader({}, {
      messageList: async () => makeMessageListResponse([
        makeRawMessage({
          message_id: 'om_topic_file', msg_type: 'file', chat_id: 'oc_topic_tool',
          create_time: Date.now(),
          content: { file_key: 'file_topic', file_name: 'topic.pdf' },
        }),
        makeRawMessage({
          message_id: 'om_topic_text', msg_type: 'text', chat_id: 'oc_topic_tool',
          create_time: Date.now() - 1_000, content: { text: '更早的文本' },
        }),
      ]),
      downloadResource: (messageId, fileKey) => {
        downloads.push({ messageId, fileKey })
        return [new TextEncoder().encode('topic-file-bytes')]
      },
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_topic_tool', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_topic_tool_trigger', content: '看看话题历史',
    }))
    await waitForEstablishedSession(h)

    // The service wires the real runtime into the Agent tools scope.
    const topicTool = tools.definitions.get(TOPIC_MESSAGES_TOOL_NAME)
    expect(topicTool).toBeDefined()
    const listed = await topicTool!.execute(
      { limit: 5 },
      { signal: new AbortController().signal },
    ) as { ok: boolean; messages: Array<{ message_id: string }> }
    expect(listed.ok).toBe(true)
    expect(listed.messages.map(message => message.message_id))
      .toEqual(expect.arrayContaining(['om_topic_file', 'om_topic_text']))

    // Discovered resources become fetchable, but only for this route.
    const fetchTool = tools.definitions.get(ATTACHMENT_FETCH_TOOL_NAME)
    const fetched = await fetchTool!.execute(
      { message_id: 'om_topic_file' },
      { signal: new AbortController().signal },
    ) as { ok: boolean; results: Array<{ ok: boolean; kind?: string }> }
    expect(fetched.ok).toBe(true)
    expect(fetched.results[0]).toMatchObject({ ok: true, kind: 'file' })
    expect(downloads).toEqual([{ messageId: 'om_topic_file', fileKey: 'file_topic' }])
    expect(attachments.savedFiles).toHaveLength(1)
    await h.service.shutdown()
  })

  it('mounts feishu_send_file and sends a topic-directory file as a reply to the route card', async () => {
    const { h, tools } = await setupTurnReader({}, {})
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_send_file', senderId: 'u_owner',
      messageId: 'om_send_file_trigger', content: '生成一张图',
    }))
    await waitForEstablishedSession(h)
    const record = [...(h.ctxState.domain.raw.table('routes').entries() as Iterable<[string, RouteRecord]>)]
      .map(([, value]) => value)[0]!
    writeFileSync(path.join(sessionDirOf(record), 'chart.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    const sendTool = tools.definitions.get(SEND_FILE_TOOL_NAME)
    expect(sendTool).toBeDefined()
    const value = await sendTool!.execute({ path: 'chart.png' }, { signal: new AbortController().signal })
    expect(value).toMatchObject({ ok: true, kind: 'image' })
    expect(h.channel.repliedMedia).toEqual([{
      replyTo: record.cardMessageId,
      media: { kind: 'image', data: expect.any(Buffer) },
      options: { replyInThread: record.kind === 'thread' },
    }])
    await h.service.shutdown()
  })

  it('mounts the wiki tools, gates them on the wiki whitelist, and routes consent clicks', async () => {
    const node = {
      spaceId: '1', nodeToken: 'wikcnServiceDoc01', objToken: 'doc_1', objType: 'docx' as const,
      nodeType: 'origin' as const, title: '服务测试', hasChild: false,
    }
    const wiki = {
      getNode: vi.fn(async () => node),
      spaceName: vi.fn(async () => '空间'),
      listChildren: vi.fn(async () => ({ items: [] })),
      createNode: vi.fn(async () => node),
      documentRevision: vi.fn(async () => 1),
      fetchDocument: vi.fn(async () => ({ revisionId: 1, content: '正文' })),
      updateDocument: vi.fn(async () => ({ result: 'success', warnings: [] })),
    }
    const { h, tools } = await setupTurnReader({
      adminUserId: 'u_admin',
      wikiRoots: ['https://mi.feishu.cn/wiki/space/1'],
      feishuTools: { ...makeConfig().feishuTools, wikiRead: true },
    }, {})
    Object.assign(h.channel, { wiki })
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_wiki', senderId: 'u_owner',
      messageId: 'om_wiki_trigger', content: '读一下知识库',
    }))
    await waitForEstablishedSession(h)
    const readTool = tools.definitions.get('feishu_wiki_read')
    expect(tools.definitions.has('feishu_wiki_create')).toBe(false)
    expect(await readTool!.execute({ doc: 'wikcnServiceDoc01' }, { signal: new AbortController().signal }))
      .toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_admin', senderId: 'u_admin', mentionedBot: false,
      messageId: 'om_wiki_grant', content: '/auth wiki add u_owner',
    }))
    await waitUntil(() => expect(JSON.stringify(h.channel.sent)).toContain('加入知识库白名单'))
    const before = h.channel.sent.length
    const pending = readTool!.execute({ doc: 'wikcnServiceDoc01' }, { signal: new AbortController().signal })
    await waitUntil(() => expect(h.channel.sent).toHaveLength(before + 1))
    await h.channel.fireCardAction({
      messageId: `om_${h.channel.sent.length}`, chatId: 'oc_wiki',
      operator: { openId: 'ou_owner', userId: 'u_owner' }, action: { value: { decision: 'allow' }, tag: 'button' },
    })
    expect(await pending).toMatchObject({ ok: true, content: '正文' })
    await h.service.shutdown()
  })

  it('orders native blocks as text, quote, prefetched image, manifest, history (AC1/AC2/AC4)', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const { h } = await setupTurnReader({}, {
      messageGet: async messageId => messageId === 'om_order_quote'
        ? makeMessageGetResponse([makeRawMessage({
          message_id: 'om_order_quote', msg_type: 'text', chat_id: 'oc_order_quote',
          content: { text: '引用内容' },
        })])
        : makeMessageGetResponse([]),
      messageList: async () => makeMessageListResponse([makeRawMessage({
        message_id: 'om_order_hist', msg_type: 'text', create_time: Date.now(),
        chat_id: 'oc_order_quote', content: { text: '历史内容' },
      })]),
      downloadResource: () => [PNG],
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_order_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_order_trigger', replyToMessageId: 'om_order_quote',
      content: '图文一起看',
      resources: [
        { type: 'image', fileKey: 'img_order' },
        { type: 'file', fileKey: 'file_order', fileName: 'order.pdf' },
      ] as never,
    }))
    await waitForEstablishedSession(h)

    const prompt = promptOf(h)
    expect(prompt[0]).toEqual({ type: 'text', text: '图文一起看' })
    expect((prompt[1]?.text ?? '')).toContain('<feishu_quote>')
    expect(prompt[2]).toMatchObject({ type: 'image' })
    expect((prompt[3]?.text ?? '')).toContain('<feishu_context>')
    expect((prompt[4]?.text ?? '')).toContain('<feishu_history>')
    expect(prompt).toHaveLength(5)
    await h.service.shutdown()
  })

  it('injects quote and history text blocks in the archive backend too (AC1/AC4)', async () => {
    // No host attachments library mounted → effective backend is `archive`.
    const h = await setup({}, {
      messageGet: async messageId => messageId === 'om_arch_quote'
        ? makeMessageGetResponse([makeRawMessage({
          message_id: 'om_arch_quote', msg_type: 'text', chat_id: 'oc_archive_quote',
          content: { text: '归档模式引用' },
        })])
        : makeMessageGetResponse([]),
      messageList: async () => makeMessageListResponse([makeRawMessage({
        message_id: 'om_arch_hist', msg_type: 'text', create_time: Date.now(),
        chat_id: 'oc_archive_quote', content: { text: '归档模式历史' },
      })]),
    })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_archive_quote', senderId: 'u_alice', mentionedBot: false,
      messageId: 'om_arch_trigger', replyToMessageId: 'om_arch_quote', content: '归档模式',
    }))
    await waitForEstablishedSession(h)
    const blocks = textBlocksOf(promptOf(h))
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toBe('归档模式')
    expect(blocks[1]).toContain('<feishu_quote>')
    expect(blocks[2]).toContain('<feishu_history>')
    // Archive deployments mount no fetch tool: the passive blocks must not
    // advertise an operation that cannot work there.
    expect(blocks[1]).not.toContain('feishu_attachment_fetch')
    expect(blocks[2]).not.toContain('feishu_attachment_fetch')
    await h.service.shutdown()
  })
})

describe('/history enrichment', () => {
  it('annotates history entries with host titles', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist', senderId: 'u_owner', threadId: 'omt_1',
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
      chatType: 'group', chatId: 'oc_hist_fail', senderId: 'u_owner', content: '开始',
    }))
    await waitForEstablishedSession(h)
    h.ctxState.sessionQuery.readTitleSnapshots.mockRejectedValueOnce(new Error('query unavailable'))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_hist_fail', senderId: 'u_owner', threadId: 'omt_1',
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
