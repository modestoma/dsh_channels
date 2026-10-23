/**
 * Guarded-mode end-to-end tests over the real FeishuService with fake host and
 * channel: admission before any side effect, authorization commands, the
 * bot-added card, topic ownership, revocation, persistence across restarts,
 * and the legacy `open` behavior.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FeishuConfig } from '../src/config.ts'
import { AppOwnerLookupError } from '../src/feishu-channel.ts'
import type { ChannelFactory, NormalizedMessage } from '../src/feishu-channel.ts'
import type { RouteRecord } from '../src/domain.ts'
import { ATTACHMENTS_DIR } from '../src/feishu/inbound-attachments.ts'
import { FeishuService } from '../src/service.ts'
import { makeAccessConfig } from './access-fixtures.ts'
import { makeChannel, makeHostContext, makeMessage, makeTempBaseDir } from './helpers.ts'

const ADMIN = 'u_admin'

type FakeChannel = ReturnType<typeof makeChannel>
type HarnessInput = Parameters<typeof makeChannel>[0]

/** One guarded config with isolated temp workspaces. */
function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
  return makeAccessConfig({
    baseDir: makeTempBaseDir(),
    // Effectively disables the streaming heartbeat in these real-timer tests.
    statusRefreshMs: 60_000,
    routeTtlMs: 0,
    welcomeOnboarding: false,
    ...partial,
  })
}

interface Harness {
  service: FeishuService
  channel: FakeChannel
  ctxState: ReturnType<typeof makeHostContext>
  config: FeishuConfig
  onMessage(msg: NormalizedMessage): Promise<void>
}

/** Start one service over the given host context + channel. */
async function boot(
  config: FeishuConfig,
  ctxState: ReturnType<typeof makeHostContext>,
  channel: FakeChannel,
): Promise<Harness> {
  const factory: ChannelFactory = () => channel
  const service = new FeishuService(ctxState.ctx, config, factory)
  await service.start()
  const registered = (channel.onMessage as unknown as ReturnType<typeof vi.fn>).mock.calls
  const handler = registered[registered.length - 1]?.[0] as (msg: NormalizedMessage) => Promise<void> | undefined
  return {
    service,
    channel,
    ctxState,
    config,
    onMessage: msg => Promise.resolve(handler?.(msg)).then(() => undefined),
  }
}

async function setup(
  partial: Partial<FeishuConfig> = {},
  channelOptions: HarnessInput = {},
): Promise<Harness> {
  const config = makeConfig(partial)
  const ctxState = makeHostContext()
  const channel = makeChannel(channelOptions)
  return await boot(config, ctxState, channel)
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const waitUntil = async (assert: () => void) => {
  await vi.waitFor(assert, { timeout: 2000, interval: 5 })
}
const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>

/** Narrow one fake channel's recorded sends by target chat. */
function sentTo(channel: FakeChannel, chatId: string): FakeChannel['sent'] {
  return channel.sent.filter(entry => entry.chatId === chatId)
}

/** Every sent payload serialized (text or card details live in the JSON). */
function sentJson(entry: FakeChannel['sent'][number]): string {
  return JSON.stringify(entry.input)
}

/** Durable route records from the fake domain. */
function routeRecords(harness: Harness): Array<[string, RouteRecord]> {
  const table = harness.ctxState.domain.raw.table('routes')
  return [...(table.entries() as IterableIterator<[string, RouteRecord]>)]
}

/**
 * Wait for one sender's route to be committed. Session creation precedes the
 * route write, so `agents.created` alone does not mean the route is readable.
 */
async function waitForRoute(harness: Harness, senderUserId: string): Promise<[string, RouteRecord]> {
  let found: [string, RouteRecord] | undefined
  await waitUntil(() => {
    found = routeRecords(harness).find(([, record]) => record.senderUserId === senderUserId)
    expect(found).toBeDefined()
  })
  return found!
}

/** Count the agent followups of the first created Session. */
function followupsOf(harness: Harness, index = 0): number {
  const created = harness.ctxState.agents.created[index]
  if (created === undefined) throw new Error(`no Session created at index ${index}`)
  return mock(created.handle.agent.followup).mock.calls.length
}

describe('guarded 模式：准入零副作用', () => {
  it('非管理员私聊：固定提示，不建 Session/工作区，也不调模型', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_dm_a', content: '你好',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    expect(sentJson(h.channel.sent[0]!)).toContain('非管理员禁用私聊功能')
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.agents.resumed).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    await h.service.shutdown()
  })

  it('非管理员私聊 /userid 例外：只回自己的 open_id，不建 Session', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_dm_userid', content: '/userid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    const json = sentJson(h.channel.sent[0]!)
    expect(json).toContain('当前用户 ID')
    expect(json).toContain('u_alice')
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    await h.service.shutdown()
  })

  it('管理员未配置时 fail closed：私聊固定引导、群聊静默、/userid 仍可用', async () => {
    const h = await setup({ adminUserId: undefined })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_missing_dm', content: '你好',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    expect(sentJson(h.channel.sent[0]!)).toContain('尚未配置管理员')
    expect(h.ctxState.agents.created).toHaveLength(0)

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_missing_userid', content: '/userid',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(sentJson(h.channel.sent[1]!)).toContain('u_alice')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_missing_group', senderId: 'u_alice',
      mentionedBot: true, messageId: 'om_missing_group', content: '@机器人',
    }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.channel.sent).toHaveLength(2)
    await h.service.shutdown()
  })

  it('管理员未配置时使用应用所有者兜底：所有者可私聊，面板与 /auth status 标注来源', async () => {
    const h = await setup({ adminUserId: undefined }, { appOwnerUserId: async () => 'u_owner' })
    expect(h.service.accessSnapshot().admin).toEqual({ userId: 'u_owner', source: 'owner', configured: true })
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_owner', senderId: 'u_owner',
      mentionedBot: false, messageId: 'om_owner_status', content: '/auth status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    expect(sentJson(h.channel.sent[0]!)).toContain('应用所有者，自动')
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_owner_other', content: '你好',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(sentJson(h.channel.sent[1]!)).toContain('非管理员禁用私聊')
    await h.service.shutdown()
  })

  it('显式配置的管理员优先于应用所有者；清空后回落到所有者', async () => {
    const h = await setup({ adminUserId: ADMIN }, { appOwnerUserId: async () => 'u_owner' })
    expect(h.service.accessSnapshot().admin).toEqual({ userId: ADMIN, source: 'config', configured: true })
    await flush()
    h.config.adminUserId = undefined
    expect(h.service.accessSnapshot().admin).toEqual({ userId: 'u_owner', source: 'owner', configured: true })
    await h.service.shutdown()
  })

  it('已配置管理员时所有者查询不阻塞连接，连接断开后迟到的结果被丢弃', async () => {
    let settle: (userId: string | undefined) => void = () => {}
    const h = await setup({ adminUserId: ADMIN }, {
      appOwnerUserId: () => new Promise<string | undefined>(resolve => { settle = resolve }),
    })
    expect(h.channel.connect).toHaveBeenCalledOnce()
    await h.service.shutdown()
    settle('u_owner')
    await flush()
    h.config.adminUserId = undefined
    expect(h.service.accessSnapshot().admin).toEqual({ configured: false })
  })

  it.each([
    ['接口报错', async (): Promise<string | undefined> => { throw new AppOwnerLookupError('code=99991672 Access denied', 99991672) }, 'code=99991672 Access denied'],
    ['非 AppOwnerLookupError', async (): Promise<string | undefined> => { throw new Error('boom') }, 'boom'],
    ['所有者非企业成员', async (): Promise<string | undefined> => undefined, '不是企业内成员'],
    ['返回 open_id', async (): Promise<string | undefined> => 'ou_owner', '不是企业内成员'],
  ])('应用所有者查询失败（%s）时 fail closed 并给出原因', async (_name, lookup, reason) => {
    const h = await setup({ adminUserId: undefined }, { appOwnerUserId: lookup })
    const admin = h.service.accessSnapshot().admin
    expect(admin.configured).toBe(false)
    expect(admin.ownerLookupError).toContain(reason)
    expect(mock(h.ctxState.ctx.logger?.warn).mock.calls)
      .toContainEqual(['dsh-channels: app owner fallback unavailable: %s', expect.stringContaining(reason)])
    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_owner_failed', content: '你好',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    expect(sentJson(h.channel.sent[0]!)).toContain('尚未配置管理员')
    await h.service.shutdown()
  })

  it('应用所有者查询超时后按未配置处理', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const config = makeConfig({ adminUserId: undefined })
      const channel = makeChannel({ appOwnerUserId: () => new Promise<string | undefined>(() => {}) })
      const service = new FeishuService(makeHostContext().ctx, config, () => channel)
      const started = service.start()
      await vi.advanceTimersByTimeAsync(10_000)
      await started
      expect(service.accessSnapshot().admin.ownerLookupError).toContain('超时')
      await service.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('未授权群 @（非管理员）：群内静默、不建 Session，管理员 DM 收到群信息/授权卡', async () => {
    const h = await setup()
    const chatId = 'oc_unauthorized_alice'
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId: 'u_alice', mentionedBot: true,
      messageId: 'om_group_alice', content: '@机器人 你好',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))

    const [entry] = h.channel.sent
    expect(entry?.chatId).toBe(ADMIN)
    expect(sentJson(entry!)).toContain('群信息')
    expect(sentJson(entry!)).toContain(chatId)
    expect(sentTo(h.channel, chatId)).toHaveLength(0)
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.ctxState.workspaces.workspaces.size).toBe(0)
    await h.service.shutdown()
  })

  it('未授权群 @（管理员）：直接建 Session（管理员不受白名单限制）', async () => {
    const h = await setup()
    const chatId = 'oc_unauthorized_admin'
    await h.onMessage(makeMessage({
      chatType: 'group', chatId, senderId: ADMIN, mentionedBot: true,
      messageId: 'om_group_admin', content: '@机器人 你好',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(followupsOf(h, 0)).toBe(1))
    expect(h.service.accessSnapshot().groups).toEqual([])
    await h.service.shutdown()
  })

  it('未授权群普通闲聊（没有 @）：完全静默，不发任何卡', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_plain_chat', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_plain', content: '随便聊聊',
    }))
    await flush()
    expect(h.channel.sent).toEqual([])
    expect(h.ctxState.agents.created).toHaveLength(0)
    await h.service.shutdown()
  })
})

describe('guarded 模式：已授权群', () => {
  it('管理员与用户白名单放行，未授权用户静默拒绝并给管理员推用户授权卡', async () => {
    const h = await setup()
    expect(await h.service.addAccessGroup('oc_group')).toMatchObject({ ok: true })
    expect(await h.service.addAccessUser('u_bob')).toMatchObject({ ok: true })

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN,
      mentionedBot: true, messageId: 'om_admin_open', content: '管理员来了',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(followupsOf(h, 0)).toBe(1))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_bob_open', content: '白名单用户来了',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    await waitUntil(() => expect(followupsOf(h, 1)).toBe(1))

    const groupSendsBefore = sentTo(h.channel, 'oc_group').length
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_carol',
      mentionedBot: true, messageId: 'om_carol_denied', content: '@机器人 你好',
    }))
    await waitUntil(() => expect(h.channel.sent.some(entry => sentJson(entry).includes('用户授权申请'))).toBe(true))

    expect(h.ctxState.agents.created).toHaveLength(2)
    expect(sentTo(h.channel, 'oc_group').length).toBe(groupSendsBefore)
    const requestCard = h.channel.sent.find(entry => sentJson(entry).includes('用户授权申请'))
    expect(requestCard?.chatId).toBe(ADMIN)
    expect(sentJson(requestCard!)).toContain('u_carol')
    // 用户申请进入管理员的待处理队列。
    expect(h.service.accessSnapshot().requests.map(request => request.targetId)).toContain('u_carol')
    await h.service.shutdown()
  })

  it('管理员在未授权群可直接对话；/auth allow 后白名单用户也可用', async () => {
    const h = await setup()
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_new_group', senderId: ADMIN,
      mentionedBot: true, messageId: 'om_admin_unauth', content: '先聊一下',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(followupsOf(h, 0)).toBe(1))

    expect(await h.service.addAccessUser('u_bob')).toMatchObject({ ok: true })
    // 群未授权：白名单用户仍不能对话。
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_new_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_bob_before_auth', content: '@机器人 你好',
    }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(1)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_new_group', senderId: ADMIN,
      mentionedBot: true, messageId: 'om_auth_allow', content: '/auth allow',
    }))
    await waitUntil(() => expect(sentTo(h.channel, 'oc_new_group').some(entry =>
      sentJson(entry).includes('已授权本群'))).toBe(true))
    expect(h.service.accessSnapshot().groups.map(group => group.chatId)).toContain('oc_new_group')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_new_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_bob_after_auth', content: '@机器人 你好',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    await waitUntil(() => expect(followupsOf(h, 1)).toBe(1))
    await h.service.shutdown()
  })

  it('非管理员的 /groupid、/auth 与普通命令在未授权群静默拒绝', async () => {
    const h = await setup()
    for (const [index, content] of ['/groupid', '/auth allow', '/auth status', '/help'].entries()) {
      await h.onMessage(makeMessage({
        chatType: 'group', chatId: 'oc_new_group', senderId: 'u_alice',
        mentionedBot: true, messageId: `om_denied_cmd_${index}`, content,
      }))
    }
    await flush()
    expect(h.channel.sent).toEqual([])
    expect(h.ctxState.agents.created).toHaveLength(0)
    expect(h.service.accessSnapshot().groups).toEqual([])
    await h.service.shutdown()
  })
})

describe('guarded 模式：/auth 用户管理', () => {
  it('/auth user add/remove/list/status 生效，重启后白名单仍在', async () => {
    const h = await setup()

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_auth_status', content: '/auth status',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    const statusJson = sentJson(h.channel.sent[0]!)
    expect(statusJson).toContain('访问授权状态')
    expect(statusJson).toContain('guarded')
    expect(statusJson).toContain(ADMIN)

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_auth_add_user', content: '/auth user add u_bob',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(sentJson(h.channel.sent[1]!)).toContain('已授权用户')
    expect(h.service.accessSnapshot().users.map(user => user.userId)).toEqual(['u_bob'])

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_auth_list', content: '/auth list',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(3))
    expect(sentJson(h.channel.sent[2]!)).toContain('u_bob')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN,
      mentionedBot: true, messageId: 'om_auth_allow_group', content: '/auth allow',
    }))
    await waitUntil(() => expect(h.service.accessSnapshot().groups.map(group => group.chatId))
      .toContain('oc_group'))

    await h.service.shutdown()

    // Restart over the same durable domain: both grants must reload.
    const restarted = await boot(h.config, h.ctxState, makeChannel())
    const snapshot = restarted.service.accessSnapshot()
    expect(snapshot.users.map(user => user.userId)).toEqual(['u_bob'])
    expect(snapshot.groups.map(group => group.chatId)).toEqual(['oc_group'])

    await restarted.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_after_restart', content: '重启后我还在吗',
    }))
    await waitUntil(() => expect(restarted.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(followupsOf(restarted, 0)).toBe(1))
    await restarted.service.shutdown()
  })

  it('/auth user add|remove @成员：取被 @ 用户的 user_id 并记下姓名，拒绝没有 user_id 的用户', async () => {
    const h = await setup()
    const bot = { key: '@_user_1', openId: 'bot-open-id', name: 'DSH', isBot: true }
    const carol = { key: '@_user_2', openId: 'ou_carol', userId: 'u_carol', name: 'Carol' }

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN, mentionedBot: true,
      mentions: [bot, carol], messageId: 'om_auth_add_mention', content: '/auth user add @Carol',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    expect(sentJson(h.channel.sent[0]!)).toContain('已授权用户 Carol')
    expect(h.service.accessSnapshot().users).toMatchObject([{ userId: 'u_carol', name: 'Carol' }])

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN, mentionedBot: true,
      mentions: [bot, { key: '@_user_3', openId: 'ou_guest', name: 'Guest' }],
      messageId: 'om_auth_add_external', content: '/auth user add @Guest',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(sentJson(h.channel.sent[1]!)).toContain('没有 user_id')
    expect(h.service.accessSnapshot().users).toHaveLength(1)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN, mentionedBot: true,
      mentions: [bot, carol], messageId: 'om_auth_remove_mention', content: '/auth user remove @Carol',
    }))
    await waitUntil(() => expect(h.service.accessSnapshot().users).toEqual([]))
    await h.service.shutdown()
  })

  it('/auth wiki add|remove 管理独立的知识库白名单，重启后仍在', async () => {
    const h = await setup()
    const bot = { key: '@_user_1', openId: 'bot-open-id', name: 'DSH', isBot: true }
    const carol = { key: '@_user_2', openId: 'ou_carol', userId: 'u_carol', name: 'Carol' }

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN, mentionedBot: true,
      mentions: [bot, carol], messageId: 'om_wiki_add', content: '/auth wiki add @Carol',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    expect(sentJson(h.channel.sent[0]!)).toContain('加入知识库白名单')
    // The wiki grant does not admit the user to conversations.
    expect(h.service.accessSnapshot().users).toEqual([])

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_wiki_usage', content: '/auth wiki',
    }))
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    expect(sentJson(h.channel.sent[1]!)).toContain('/auth wiki add')
    await h.service.shutdown()

    const restarted = await boot(h.config, h.ctxState, makeChannel())
    await restarted.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_wiki_list', content: '/auth list',
    }))
    await waitUntil(() => expect(restarted.channel.sent).toHaveLength(1))
    expect(sentJson(restarted.channel.sent[0]!)).toContain('知识库白名单（1）')
    expect(sentJson(restarted.channel.sent[0]!)).toContain('u_carol')

    await restarted.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_wiki_remove', content: '/auth wiki remove u_carol',
    }))
    await waitUntil(() => expect(restarted.channel.sent).toHaveLength(2))
    expect(sentJson(restarted.channel.sent[1]!)).toContain('移出知识库白名单')
    await restarted.service.shutdown()
  })

  it('设置面板增删知识库白名单，与用户白名单互不影响', async () => {
    const h = await setup()
    const added = await h.service.addWikiUser(' u_dave ', ' Dave ')
    expect(added).toMatchObject({ ok: true })
    if (!added.ok) return
    expect(added.access.wikiUsers).toEqual([{ userId: 'u_dave', name: 'Dave', source: 'panel', addedAt: expect.any(Number) }])
    expect(added.access.users).toEqual([])
    expect(await h.service.addWikiUser('u_dave')).toMatchObject({ ok: true, access: { wikiUsers: [{ name: 'Dave' }] } })
    expect(await h.service.addWikiUser('ou_dave')).toMatchObject({ ok: false })
    expect(await h.service.removeWikiUser('u_dave')).toMatchObject({ ok: true, access: { wikiUsers: [] } })
    expect(await h.service.removeWikiUser('bad id')).toMatchObject({ ok: false })
    await h.service.shutdown()
  })

  it('撤销用户与撤销群立即生效（非管理员被拒；管理员仍直通）', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.service.addAccessUser('u_bob')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_bob_before_revoke', content: '撤销前',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN,
      mentionedBot: false, messageId: 'om_auth_remove_user', content: '/auth user remove u_bob',
    }))
    await waitUntil(() => expect(h.service.accessSnapshot().users).toEqual([]))

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_bob_after_revoke', content: '撤销后',
    }))
    expect(h.ctxState.agents.created).toHaveLength(1)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN,
      mentionedBot: true, messageId: 'om_admin_after_group_revoke', content: '群还在吗',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))

    expect(await h.service.removeAccessGroup('oc_group')).toMatchObject({ ok: true })

    // 群撤销后管理员仍然直通（白名单只约束非管理员）。
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: ADMIN,
      mentionedBot: true, messageId: 'om_admin_after_group_revoke_2', content: '现在呢',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(3))

    // 非管理员（用户白名单已撤销 + 群未授权）仍被拒绝。
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob',
      mentionedBot: true, messageId: 'om_bob_after_group_revoke', content: '我还能说话吗',
    }))
    await flush()
    expect(h.ctxState.agents.created).toHaveLength(3)
    await h.service.shutdown()
  })
})

describe('guarded 模式：botAdded 群信息卡', () => {
  it('管理员已配置：未授权群 DM 授权卡，已授权群只发标注已授权的信息卡', async () => {
    const h = await setup({}, {
      chatInfo: async chatId => ({ chatId, chatType: 'group', name: `群-${chatId}`, memberCount: 8, ownerId: 'u_owner' }),
    })

    await h.channel.fireBotAdded({ chatId: 'oc_added', operator: { openId: 'ou_operator', userId: 'u_inviter' } })
    await waitUntil(() => expect(h.channel.sent).toHaveLength(1))
    const addedEntry = h.channel.sent[0]!
    expect(addedEntry.chatId).toBe(ADMIN)
    const addedJson = sentJson(addedEntry)
    expect(addedJson).toContain('群-oc_added')
    expect(addedJson).toContain('u_inviter')
    expect(addedJson).toContain('授权本群')
    expect(h.service.accessSnapshot().requests.map(request => request.targetId)).toContain('oc_added')
    expect(h.service.accessSnapshot().groups).toEqual([])

    expect(await h.service.addAccessGroup('oc_existing', '老群')).toMatchObject({ ok: true })
    await h.channel.fireBotAdded({ chatId: 'oc_existing', operator: { openId: 'ou_operator', userId: ADMIN } })
    await waitUntil(() => expect(h.channel.sent).toHaveLength(2))
    const existingJson = sentJson(h.channel.sent[1]!)
    expect(existingJson).toContain('该群已授权')
    expect(existingJson).not.toContain('授权本群')
    await h.service.shutdown()
  })
})

describe('guarded 模式：话题所有权', () => {
  it('非发起人无法续写话题、不落附件，话题 followup 不再调用', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    // 两个用户都在白名单里：B 被拦下只能是因为话题所有权，而不是准入。
    await h.service.addAccessUser('u_alice')
    await h.service.addAccessUser('u_bob')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_alice',
      mentionedBot: true, messageId: 'om_alice_topic', content: '我来开个话题',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const [threadKey, aliceRoute] = await waitForRoute(h, 'u_alice')
    expect(aliceRoute.kind).toBe('thread')
    expect(threadKey.length).toBeGreaterThan(0)

    // 同群白名单用户（准入通过）进入别人的话题：所有权校验必须拦下。
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', threadId: threadKey,
      mentionedBot: false, messageId: 'om_bob_intrude', content: '我也要聊',
      resources: [{ type: 'image', fileKey: 'img_intrude' }] as never,
    }))
    await flush()

    expect(h.ctxState.agents.created).toHaveLength(1)
    await waitUntil(() => expect(followupsOf(h, 0)).toBe(1))
    expect(h.ctxState.workspaces.workspaces.size).toBe(1)
    expect(existsSync(path.join(aliceRoute.workspacePath, ATTACHMENTS_DIR))).toBe(false)
    await h.service.shutdown()
  })

  it('非发起人回答不了别人的 pending question', async () => {
    const h = await setup()
    await h.service.addAccessGroup('oc_group')
    await h.service.addAccessUser('u_alice')
    await h.service.addAccessUser('u_bob')

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_alice',
      mentionedBot: true, messageId: 'om_alice_ask', content: '先开个话题',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    const agent = h.ctxState.agents.created[0]!.handle.agent
    const [threadKey] = await waitForRoute(h, 'u_alice')

    const { listener } = h.ctxState.questionListeners[0]!
    const next = vi.fn(async () => ({ answers: [] }))
    const pending = listener({
      questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }],
      agent,
    }, next)
    await waitUntil(() => expect(h.channel.sent.some(entry =>
      sentJson(entry).includes('需要你的回答'))).toBe(true))

    // 所有者 Alice 的 pending question 不能被同群其他白名单用户回答。
    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', threadId: threadKey,
      mentionedBot: false, messageId: 'om_bob_answer', content: '继续',
    }))
    await flush()
    expect(next).not.toHaveBeenCalled()
    expect(h.channel.sent.some(entry => sentJson(entry).includes('已记录你的文字回答'))).toBe(false)
    await waitUntil(() => expect(followupsOf(h, 0)).toBe(1))

    await h.service.shutdown()
    await expect(pending).rejects.toThrow('插件已关闭')
  })
})

describe('open 模式：兼容旧行为', () => {
  it('非管理员私聊与未授权群一样可以建会话、调模型', async () => {
    const h = await setup({ accessMode: 'open' })

    await h.onMessage(makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice',
      mentionedBot: false, messageId: 'om_open_dm', content: '你好',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(1))
    await waitUntil(() => expect(followupsOf(h, 0)).toBe(1))
    expect(h.channel.sent.some(entry => sentJson(entry).includes('非管理员禁用私聊功能'))).toBe(false)

    await h.onMessage(makeMessage({
      chatType: 'group', chatId: 'oc_any_group', senderId: 'u_stranger',
      mentionedBot: true, messageId: 'om_open_group', content: '@机器人 你好',
    }))
    await waitUntil(() => expect(h.ctxState.agents.created).toHaveLength(2))
    await waitUntil(() => expect(followupsOf(h, 1)).toBe(1))
    await h.service.shutdown()
  })
})
