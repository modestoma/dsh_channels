/**
 * Access runtime tests: AccessController admission behavior (private-chat
 * notice/cooldown, group silence + request hook, command plane, route
 * ownership, permission switches) and the AccessRequests lifecycle (bot-added
 * cards, user requests, card actions, panel settlement, expiry, restart
 * persistence).
 *
 * These instantiate the real modules over the shared channel/domain fakes; no
 * FeishuService is involved.
 */

import { describe, expect, it, vi } from 'vitest'
import { AccessController, DM_DENY_TEXT, DM_UNCONFIGURED_TEXT } from '../src/access/controller.ts'
import { AccessRequests } from '../src/access/requests.ts'
import { AccessStore } from '../src/access/store.ts'
import type { FeishuConfig } from '../src/config.ts'
import type { RouteRecord } from '../src/domain.ts'
import type { CardActionEvent } from '../src/feishu-channel.ts'
import {
  adminRecord, makeAccessConfig, makeAccessDomain, requestRecord, userRecord,
} from './access-fixtures.ts'
import { makeChannel, makeMessage } from './helpers.ts'
import type { FakeChannelOptions } from './helpers.ts'

const ADMIN = 'u_admin'
const AS_ADMIN = { kind: 'admin', userId: ADMIN } as const
const DAY_MS = 86_400_000

type FakeChannel = ReturnType<typeof makeChannel>
type SentEntry = FakeChannel['sent'][number]

interface RuntimeOptions {
  config?: Partial<FeishuConfig>
  channel?: FakeChannelOptions
  /** Simulate the pre-startup window (no live channel). */
  noChannel?: boolean
  clock?: { now: number }
  /** Administrators seeded into the user table; default `u_admin`. */
  admins?: readonly string[]
}

/** One controller + requests pair over fresh fakes. */
function setup(options: RuntimeOptions = {}) {
  // The partial override is applied after validation on purpose: a few tests
  // exercise config values the schema would reject (e.g. padded whitespace).
  const config: FeishuConfig = { ...makeAccessConfig(), ...options.config }
  const channel = makeChannel(options.channel)
  const liveChannel: FakeChannel | undefined = options.noChannel === true ? undefined : channel
  const domain = makeAccessDomain()
  for (const admin of options.admins ?? [ADMIN]) void domain.handle.accessUsers.put(admin, adminRecord(admin))
  const warn = vi.fn()
  const store = new AccessStore({ domain: () => domain.handle, warn })
  store.load()
  const clock = options.clock ?? { now: 1_000_000 }
  const onDeniedUser = vi.fn()
  const controller = new AccessController({
    config: () => config,
    store,
    channel: () => liveChannel,
    warn,
    onDeniedUser,
    now: () => clock.now,
  })
  const requests = new AccessRequests({
    config: () => config,
    store,
    channel: () => liveChannel,
    warn,
    now: () => clock.now,
  })
  return { config, channel, domain, store, warn, clock, controller, requests, onDeniedUser }
}

/** JSON of every text send, for fixed-notice assertions. */
function textSends(channel: FakeChannel): string[] {
  return channel.sent
    .filter((entry): entry is SentEntry & { input: { text: string } } => 'text' in entry.input)
    .map(entry => entry.input.text)
}

/** Deep-search one card for a callback button with the given label. */
function buttonValue(card: object, label: string): { token: string; action: 'allow' | 'deny' } | undefined {
  const visit = (node: unknown): { token: string; action: 'allow' | 'deny' } | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (typeof node !== 'object' || node === null) return undefined
    const record = node as Record<string, unknown>
    if (record.tag === 'button') {
      const text = record.text as { content?: string } | undefined
      if (text?.content === label) {
        const behaviors = record.behaviors as Array<{ value?: unknown }> | undefined
        return behaviors?.[0]?.value as { token: string; action: 'allow' | 'deny' } | undefined
      }
    }
    for (const value of Object.values(record)) {
      const hit = visit(value)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return visit(card)
}

/** The card body of one sent entry. */
function sentCard(entry: SentEntry): object {
  const input = entry.input as { card?: object }
  if (input.card === undefined) throw new Error('send is not a card')
  return input.card
}

/** One card-action event from the administrator's DM card. */
function cardAction(messageId: string, value: unknown, userId = ADMIN): CardActionEvent {
  return {
    messageId,
    chatId: ADMIN,
    operator: { openId: 'ou_operator', userId },
    action: { value, tag: 'button' },
  }
}

/** One group-attributed bot-added event. */
function botAdded(chatId: string, operatorUserId = ADMIN) {
  return { chatId, operator: { openId: 'ou_operator', userId: operatorUserId } }
}

/** Create a pending user request (u_bob @-mentions the bot) and return its token. */
async function pendingUserCard(runtime: ReturnType<typeof setup>): Promise<{ token: string }> {
  await runtime.requests.ensureUserRequest(makeMessage({
    chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', senderName: 'Bob', mentionedBot: true, content: '@机器人',
  }))
  const entry = runtime.channel.sent[0]
  if (entry === undefined) throw new Error('no card sent')
  const value = buttonValue(sentCard(entry), '授权用户')
  if (value === undefined) throw new Error('no authorize button on the user card')
  return { token: value.token }
}

function routeRecord(partial: Partial<RouteRecord> = {}): RouteRecord {
  return {
    key: 'omt_topic',
    kind: 'thread',
    sessionId: 'session-a',
    chatId: 'oc_group',
    chatType: 'group',
    senderUserId: 'u_alice',
    workspacePath: '/workspace/alice',
    cardMessageId: 'om_card',
    createdAt: 1,
    lastActivityAt: 1,
    ...partial,
  }
}

describe('AccessController.admit：私聊', () => {
  it('非管理员私聊回固定提示，且只发一条文本', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '你好',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)

    expect(runtime.channel.sent).toHaveLength(1)
    const [entry] = runtime.channel.sent
    expect(entry?.chatId).toBe('oc_p2p_alice')
    expect(entry?.options).toEqual({ replyTo: msg.messageId })
    expect(textSends(runtime.channel)).toEqual([DM_DENY_TEXT])
  })

  it('同一发送者 10 秒冷却内不再重复发提示，冷却结束后再次提示', async () => {
    const clock = { now: 1_000_000 }
    const runtime = setup({ clock })
    const msg = () => makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '在吗',
    })

    await runtime.controller.admit(msg())
    expect(runtime.channel.sent).toHaveLength(1)

    clock.now += 9_999
    await runtime.controller.admit(msg())
    expect(runtime.channel.sent).toHaveLength(1)

    clock.now += 1
    await runtime.controller.admit(msg())
    expect(runtime.channel.sent).toHaveLength(2)
    expect(textSends(runtime.channel)).toEqual([DM_DENY_TEXT, DM_DENY_TEXT])
  })

  it('管理员私聊放行，不发任何提示', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN, mentionedBot: false, content: '你好',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(true)
    expect(runtime.channel.sent).toEqual([])
  })

  it('未配置管理员时私聊回引导文案（仍不建会话，且受同一冷却）', async () => {
    const clock = { now: 1_000_000 }
    const runtime = setup({ admins: [], clock })
    const msg = () => makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '你好',
    })

    await expect(runtime.controller.admit(msg())).resolves.toBe(false)
    expect(textSends(runtime.channel)).toEqual([DM_UNCONFIGURED_TEXT])

    // Same per-sender 10 s cooldown as the configured-administrator notice.
    clock.now += 5_000
    await runtime.controller.admit(msg())
    expect(textSends(runtime.channel)).toHaveLength(1)

    clock.now += 5_000
    await runtime.controller.admit(msg())
    expect(textSends(runtime.channel)).toHaveLength(2)
  })

  it('打开对话准入的用户可以私聊；停用的用户收到固定提示', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_alice' }))
    await runtime.store.putUser(userRecord({ userId: 'u_paused', chat: false }))
    const dm = (senderId: string) => makeMessage({
      chatType: 'p2p', chatId: `oc_p2p_${senderId}`, senderId, mentionedBot: false, content: '你好',
    })

    await expect(runtime.controller.admit(dm('u_alice'))).resolves.toBe(true)
    await expect(runtime.controller.admit(dm('u_paused'))).resolves.toBe(false)
    expect(textSends(runtime.channel)).toEqual([DM_DENY_TEXT])
  })

  it('channel 缺失时只 warn，不抛也不阻塞判定', async () => {
    const runtime = setup({ noChannel: true })
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '你好',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
    expect(runtime.warn).toHaveBeenCalledWith(expect.stringContaining('channel unavailable'))
  })
})

describe('AccessController.admit：群聊', () => {
  it('没有对话权限的人的普通闲聊静默丢弃，不触发申请', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_any', senderId: 'u_alice', mentionedBot: false, content: '随便聊聊',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
    expect(runtime.onDeniedUser).not.toHaveBeenCalled()
  })

  it('没有对话权限的人 @ 机器人（或在话题里回复）时静默并触发用户申请钩子', async () => {
    const runtime = setup()
    const mention = makeMessage({
      chatType: 'group', chatId: 'oc_any', senderId: 'u_alice', mentionedBot: true, content: '@机器人',
    })
    const reply = makeMessage({
      chatType: 'group', chatId: 'oc_any', senderId: 'u_alice', mentionedBot: false, threadId: 'omt_old', content: '继续',
    })

    await expect(runtime.controller.admit(mention)).resolves.toBe(false)
    await expect(runtime.controller.admit(reply)).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
    expect(runtime.onDeniedUser.mock.calls).toEqual([[mention], [reply]])
  })

  it('管理员与打开对话准入的用户在任何群放行；停用的用户被拒', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_alice' }))
    await runtime.store.putUser(userRecord({ userId: 'u_paused', chat: false }))

    for (const senderId of [ADMIN, 'u_alice']) {
      const msg = makeMessage({ chatType: 'group', chatId: 'oc_never_seen', senderId, mentionedBot: true, content: '你好' })
      await expect(runtime.controller.admit(msg)).resolves.toBe(true)
    }
    const paused = makeMessage({ chatType: 'group', chatId: 'oc_never_seen', senderId: 'u_paused', mentionedBot: true, content: '你好' })
    await expect(runtime.controller.admit(paused)).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
  })

  it('open 模式放行任何人且不发提示', async () => {
    const runtime = setup({ config: { accessMode: 'open' } })
    for (const msg of [
      makeMessage({ chatType: 'p2p', chatId: 'oc_p2p', senderId: 'u_anyone', mentionedBot: false, content: '1' }),
      makeMessage({ chatType: 'group', chatId: 'oc_any', senderId: 'u_anyone', content: '2' }),
    ]) {
      await expect(runtime.controller.admit(msg)).resolves.toBe(true)
    }
    expect(runtime.channel.sent).toEqual([])
  })
})

describe('AccessController.admitCommand', () => {
  it('私聊 /userid 对所有发送者放行（含管理员未配置时）', async () => {
    for (const admins of [[ADMIN], []]) {
      const runtime = setup({ admins })
      const msg = makeMessage({
        chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '/userid',
      })
      await expect(runtime.controller.admitCommand(msg, 'userid')).resolves.toBe(true)
      expect(runtime.channel.sent).toEqual([])
    }
  })

  it('管理员未配置时私聊命令回配置引导文案', async () => {
    const runtime = setup({ admins: [] })
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '/help',
    })
    await expect(runtime.controller.admitCommand(msg, 'help')).resolves.toBe(false)
    expect(textSends(runtime.channel)).toEqual([DM_UNCONFIGURED_TEXT])
  })

  it('私聊没有对话权限的人的其他命令回固定提示并拒绝', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '/help',
    })
    await expect(runtime.controller.admitCommand(msg, 'help')).resolves.toBe(false)
    expect(textSends(runtime.channel)).toEqual([DM_DENY_TEXT])
  })

  it('管理员的所有命令在私聊和任何群放行', async () => {
    const runtime = setup()
    for (const chatType of ['p2p', 'group'] as const) {
      for (const name of ['help', 'auth', 'groupid', 'status', undefined]) {
        const msg = makeMessage({ chatType, chatId: 'oc_any', senderId: ADMIN, mentionedBot: false, content: '/help' })
        await expect(runtime.controller.admitCommand(msg, name)).resolves.toBe(true)
      }
    }
    expect(runtime.channel.sent).toEqual([])
  })

  it('群里按准入矩阵判定命令，拒绝时静默', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_alice' }))
    const command = (senderId: string) => makeMessage({ chatType: 'group', chatId: 'oc_any', senderId, content: '/help' })
    await expect(runtime.controller.admitCommand(command('u_alice'), 'help')).resolves.toBe(true)
    await expect(runtime.controller.admitCommand(command('u_stranger'), 'auth')).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
  })

  it('open 模式下所有命令直接放行', async () => {
    const runtime = setup({ config: { accessMode: 'open' } })
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_any', senderId: 'u_anyone', content: '/help',
    })
    await expect(runtime.controller.admitCommand(msg, 'help')).resolves.toBe(true)
  })
})

describe('AccessController.ownsRoute / isAdmin / mayUse / mayUseOnRoute', () => {
  it('chatId 与 sender 双匹配才算话题拥有者', () => {
    const runtime = setup()
    const record = routeRecord({ senderUserId: 'u_alice', chatId: 'oc_group' })
    expect(runtime.controller.ownsRoute(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_alice', content: 'x',
    }), record)).toBe(true)
    expect(runtime.controller.ownsRoute(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', content: 'x',
    }), record)).toBe(false)
    expect(runtime.controller.ownsRoute(makeMessage({
      chatType: 'group', chatId: 'oc_other', senderId: 'u_alice', content: 'x',
    }), record)).toBe(false)
  })

  it('isAdmin 只认用户表里 admin 打开的用户', async () => {
    const runtime = setup({ admins: [ADMIN, 'u_admin2'] })
    await runtime.store.putUser(userRecord({ userId: 'u_alice', codeWrite: true }))
    expect(runtime.controller.isAdmin('u_admin')).toBe(true)
    expect(runtime.controller.isAdmin('u_admin2')).toBe(true)
    expect(runtime.controller.isAdmin('u_alice')).toBe(false)
    expect(runtime.controller.isAdmin(' u_admin ')).toBe(false)
    expect(runtime.controller.isAdmin(undefined)).toBe(false)
  })

  it('mayUse：管理员拥有全部开关；其他人按开关，停用后全部失效；与 open 模式无关', async () => {
    const runtime = setup({ config: { accessMode: 'open' } })
    await runtime.store.putUser(userRecord({ userId: 'u_alice', wikiRead: true, codeWrite: true }))
    expect(runtime.controller.mayUse(ADMIN, 'codeWrite')).toBe(true)
    expect(runtime.controller.mayUse('u_alice', 'wikiRead')).toBe(true)
    expect(runtime.controller.mayUse('u_alice', 'wikiWrite')).toBe(false)
    expect(runtime.controller.mayUse('u_stranger', 'wikiRead')).toBe(false)
    expect(runtime.controller.mayUse(undefined, 'chat')).toBe(false)
    await runtime.store.setPermission('u_alice', 'chat', false)
    expect(runtime.controller.mayUse('u_alice', 'codeWrite')).toBe(false)
  })

  it('mayLaunchFor：发起人需要对话权限（open 模式除外）', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_alice' }))
    expect(runtime.controller.mayLaunchFor('u_alice')).toBe(true)
    expect(runtime.controller.mayLaunchFor(ADMIN)).toBe(true)
    expect(runtime.controller.mayLaunchFor('u_stranger')).toBe(false)
    expect(setup({ config: { accessMode: 'open' } }).controller.mayLaunchFor('u_stranger')).toBe(true)
  })

  it('群路由（mode group 或旧 shared）：有对话权限的人都能继续；allows 只看准入矩阵', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_alice' }))
    await runtime.store.putUser(userRecord({ userId: 'u_bob' }))
    for (const record of [routeRecord({ mode: 'group' }), routeRecord({ shared: true })]) {
      expect(runtime.controller.mayActOnRoute('u_bob', 'oc_group', record)).toBe(true)
      expect(runtime.controller.mayActOnRoute(ADMIN, 'oc_group', record)).toBe(true)
      expect(runtime.controller.mayActOnRoute('u_stranger', 'oc_group', record)).toBe(false)
      expect(runtime.controller.mayActOnRoute('u_bob', 'oc_other', record)).toBe(false)
    }
    const msg = makeMessage({ chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', content: 'x' })
    expect(runtime.controller.allows(msg)).toBe(true)
    await runtime.store.setPermission('u_bob', 'chat', false)
    expect(runtime.controller.allows(msg)).toBe(false)
    expect(runtime.controller.mayActOnRoute('u_bob', 'oc_group', routeRecord({ mode: 'group' }))).toBe(false)
  })

  it('mayUseOnRoute：群路由按群权限表判权（未登记即无权限），其他路由按发起人开关', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_alice', codeWrite: true }))
    const legacy = routeRecord({ senderUserId: 'u_alice' })
    expect(runtime.controller.mayUseOnRoute(legacy, 'codeWrite')).toBe(true)
    expect(runtime.controller.mayUseOnRoute(legacy, 'wikiRead')).toBe(false)
    expect(runtime.controller.mayUseOnRoute(routeRecord({ chatType: 'p2p', chatId: 'oc_p2p', senderUserId: ADMIN }), 'wikiWrite')).toBe(true)
    const group = routeRecord({ mode: 'group', senderUserId: 'u_alice' })
    expect(runtime.controller.mayUseOnRoute(group, 'codeWrite')).toBe(false)
    await runtime.store.ensureGroup('oc_group', '研发群', 5)
    expect(runtime.controller.mayUseOnRoute(group, 'codeWrite')).toBe(false)
    await runtime.store.setGroupPermission('oc_group', 'codeWrite', true)
    expect(runtime.controller.mayUseOnRoute(group, 'codeWrite')).toBe(true)
    expect(runtime.controller.mayUseOnRoute(group, 'wikiRead')).toBe(false)
    expect(runtime.controller.mayUseOnRoute(routeRecord({ shared: true }), 'codeWrite')).toBe(true)
    await runtime.store.removeGroup('oc_group')
    expect(runtime.controller.mayUseOnRoute(group, 'codeWrite')).toBe(false)
  })
})

describe('AccessRequests.handleBotAdded', () => {
  it('邀请人没有对话权限：私聊管理员用户申请卡（带群名），记录 pending 并回写 messageId', async () => {
    const runtime = setup({ channel: {
      chatInfo: async () => ({ chatId: 'oc_new', chatType: 'group', name: '产品群', memberCount: 12 }),
    } })

    await runtime.requests.handleBotAdded(botAdded('oc_new', 'u_inviter'))

    expect(runtime.channel.sent).toHaveLength(1)
    const [entry] = runtime.channel.sent
    expect(entry?.chatId).toBe(ADMIN)
    const json = JSON.stringify(sentCard(entry!))
    expect(json).toContain('用户授权申请')
    expect(json).toContain('把我拉进了群')
    expect(json).toContain('产品群')
    expect(json).toContain('u_inviter')
    expect(buttonValue(sentCard(entry!), '授权用户')).toBeDefined()
    expect(runtime.store.pendingRequestFor('u_inviter')).toMatchObject({
      kind: 'user', targetId: 'u_inviter', chatId: 'oc_new', groupName: '产品群', status: 'pending', messageIds: ['om_1'],
    })
    expect(runtime.store.hasUser('u_inviter')).toBe(false)
  })

  it('同一邀请人的重复入群事件只发一张卡（pending 去重）', async () => {
    const runtime = setup()
    await runtime.requests.handleBotAdded(botAdded('oc_a', 'u_inviter'))
    await runtime.requests.handleBotAdded(botAdded('oc_b', 'u_inviter'))
    expect(runtime.channel.sent).toHaveLength(1)
    expect(runtime.store.pendingRequests(runtime.clock.now)).toHaveLength(1)
  })

  it('邀请人是管理员、有对话权限或已被停用：只发群信息卡，不带按钮、不建申请', async () => {
    const runtime = setup({ channel: {
      chatInfo: async chatId => ({ chatId, chatType: 'group', name: '老群' }),
    } })
    await runtime.store.putUser(userRecord({ userId: 'u_alice' }))
    await runtime.store.putUser(userRecord({ userId: 'u_paused', chat: false }))

    for (const inviter of [ADMIN, 'u_alice', 'u_paused']) await runtime.requests.handleBotAdded(botAdded('oc_existing', inviter))

    expect(runtime.channel.sent).toHaveLength(3)
    for (const entry of runtime.channel.sent) {
      const card = sentCard(entry)
      expect(JSON.stringify(card)).toContain('群信息')
      expect(JSON.stringify(card)).toContain('老群')
      expect(buttonValue(card, '授权用户')).toBeUndefined()
    }
    expect(JSON.stringify(sentCard(runtime.channel.sent[2]!))).toContain('邀请人没有对话权限')
    expect(runtime.store.pendingRequests(runtime.clock.now)).toEqual([])
  })

  it('管理员未配置时只 warn：不发卡、不建申请', async () => {
    const runtime = setup({ admins: [] })
    await runtime.requests.handleBotAdded(botAdded('oc_new', 'u_inviter'))

    expect(runtime.channel.sent).toEqual([])
    expect(runtime.store.pendingRequests(runtime.clock.now)).toEqual([])
    expect(runtime.warn).toHaveBeenCalledWith(expect.stringContaining('no administrator'), 'oc_new')
  })

  it('getChatInfo 失败时降级为只带群 ID 的卡（仍可授权）', async () => {
    const runtime = setup({ channel: {
      chatInfo: () => { throw new Error('no chat permission') },
    } })

    await runtime.requests.handleBotAdded(botAdded('oc_new', 'u_inviter'))

    const card = sentCard(runtime.channel.sent[0]!)
    expect(JSON.stringify(card)).toContain('oc_new')
    expect(buttonValue(card, '授权用户')).toBeDefined()
    expect(runtime.warn).toHaveBeenCalledWith(
      expect.stringContaining('reading chat info for %s failed'),
      'oc_new',
      expect.stringContaining('no chat permission'),
    )
  })
})

describe('AccessRequests.ensureUserRequest', () => {
  it('任何群里没有对话权限的人 @ 机器人：DM 管理员申请卡，按同一用户去重', async () => {
    const runtime = setup({ channel: {
      chatInfo: async chatId => ({ chatId, chatType: 'group', name: '产品群' }),
    } })
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', senderName: 'Bob', mentionedBot: true, content: '@机器人',
    })

    await runtime.requests.ensureUserRequest(msg)
    await runtime.requests.ensureUserRequest(msg)

    expect(runtime.channel.sent).toHaveLength(1)
    const json = JSON.stringify(sentCard(runtime.channel.sent[0]!))
    expect(json).toContain('Bob')
    expect(json).toContain('所在群')
    expect(json).toContain('产品群')
    expect(runtime.store.pendingRequests(runtime.clock.now)).toHaveLength(1)
  })

  it('用户表里已有的人（含停用）与普通闲聊都不会发申请', async () => {
    const runtime = setup()
    await runtime.store.putUser(userRecord({ userId: 'u_paused', chat: false }))
    await runtime.requests.ensureUserRequest(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_paused', mentionedBot: true, content: '@机器人',
    }))
    await runtime.requests.ensureUserRequest(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', mentionedBot: false, content: '闲聊',
    }))
    expect(runtime.channel.sent).toEqual([])
  })

  it('24 小时内被忽略过的人不再提醒', async () => {
    const runtime = setup()
    const msg = makeMessage({ chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', mentionedBot: true, content: '@机器人' })
    await runtime.requests.ensureUserRequest(msg)
    const token = runtime.store.pendingRequestFor('u_bob')!.token
    await runtime.requests.resolve(token, 'deny', AS_ADMIN)
    runtime.clock.now += 60_000
    await runtime.requests.ensureUserRequest(msg)
    expect(runtime.channel.sent).toHaveLength(1)
  })
})

describe('AccessRequests.onCardAction', () => {
  it('非管理员点击不生效，且只提示一次“仅管理员可操作”', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)
    const event = cardAction('om_1', { token, action: 'allow' }, 'u_alice')

    await runtime.requests.onCardAction(event)
    await runtime.requests.onCardAction(event)

    expect(runtime.store.hasUser('u_bob')).toBe(false)
    expect(runtime.store.getRequest(token)?.status).toBe('pending')
    expect(runtime.channel.updated).toEqual([])
    const notices = runtime.channel.sent.filter(entry => 'text' in entry.input)
    expect(notices).toHaveLength(1)
    expect(JSON.stringify(notices[0]?.input)).toContain('仅管理员可操作该授权卡片')
  })

  it('管理员点「授权用户」：用户只打开对话准入并 patch 卡片终态', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)

    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'allow' }))

    expect(runtime.store.getUser('u_bob')).toMatchObject({
      source: 'card', addedBy: ADMIN, name: 'Bob', chat: true, wikiRead: false, wikiWrite: false, codeWrite: false,
    })
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
    expect(runtime.channel.updated).toHaveLength(1)
    expect(runtime.channel.updated[0]?.messageId).toBe('om_1')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已授权')
  })

  it('管理员点「忽略」：不入用户表，只落 denied 终态', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)

    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'deny' }))

    expect(runtime.store.hasUser('u_bob')).toBe(false)
    expect(runtime.store.getRequest(token)?.status).toBe('denied')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已忽略')
  })

  it('重复点击已结算的 token 幂等：状态与用户表不再变化', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)
    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'allow' }))

    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'deny' }))

    expect(runtime.store.hasUser('u_bob')).toBe(true)
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
    expect(JSON.stringify(runtime.channel.updated.at(-1)?.card)).toContain('已授权')
  })

  it('过期 token 不生效：落 expired 并 patch 为已过期', async () => {
    const runtime = setup()
    await runtime.store.putRequest(requestRecord({
      token: 'tok-expired', targetId: 'u_bob', createdAt: 0, expiresAt: runtime.clock.now - 1, messageId: 'om_1',
    }))

    await runtime.requests.onCardAction(cardAction('om_1', { token: 'tok-expired', action: 'allow' }))

    expect(runtime.store.hasUser('u_bob')).toBe(false)
    expect(runtime.store.getRequest('tok-expired')?.status).toBe('expired')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已过期')
  })

  it('未知 token 或畸形回调值被静默忽略', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)

    await runtime.requests.onCardAction(cardAction('om_1', { token: 'tok-unknown', action: 'allow' }))
    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'reset' }))
    await runtime.requests.onCardAction(cardAction('om_1', {}))
    await runtime.requests.onCardAction(cardAction('om_1', undefined))

    expect(runtime.store.getRequest(token)?.status).toBe('pending')
    expect(runtime.channel.updated).toEqual([])
  })
})

describe('AccessRequests：多位管理员', () => {
  it('申请卡发给每位管理员；任一位处理后所有卡都更新，其他人再点只看到已处理', async () => {
    const runtime = setup({ admins: [ADMIN, 'u_admin2'] })
    const { token } = await pendingUserCard(runtime)
    expect(runtime.channel.sent.map(entry => entry.chatId)).toEqual([ADMIN, 'u_admin2'])
    const ids = runtime.store.getRequest(token)?.messageIds ?? []
    expect(ids).toHaveLength(2)

    await runtime.requests.onCardAction(cardAction(ids[1]!, { token, action: 'allow' }, 'u_admin2'))
    expect(runtime.store.getUser('u_bob')).toMatchObject({ chat: true, addedBy: 'u_admin2' })
    expect(runtime.channel.updated.map(entry => entry.messageId)).toEqual(ids)

    await runtime.requests.onCardAction(cardAction(ids[0]!, { token, action: 'deny' }))
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
    expect(runtime.channel.updated.map(entry => entry.messageId)).toEqual([...ids, ...ids])
  })

  it('入群通知发给每位管理员；面板处理申请记为 panel', async () => {
    const runtime = setup({ admins: [ADMIN, 'u_admin2'] })
    await runtime.requests.handleBotAdded(botAdded('oc_new', ADMIN))
    expect(runtime.channel.sent.map(entry => entry.chatId)).toEqual([ADMIN, 'u_admin2'])

    const other = setup({ admins: [ADMIN, 'u_admin2'] })
    const { token } = await pendingUserCard(other)
    await expect(other.requests.resolve(token, 'allow', { kind: 'panel' })).resolves.toEqual({ ok: true })
    expect(other.store.getUser('u_bob')).toMatchObject({ addedBy: 'panel' })
  })
})

describe('AccessRequests.resolve（面板与卡片共用路径）', () => {
  it('allow 写入用户表并 patch 卡片；deny 只记录状态', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)
    await expect(runtime.requests.resolve(token, 'allow', AS_ADMIN)).resolves.toEqual({ ok: true })
    expect(runtime.store.allows('u_bob', 'chat')).toBe(true)

    const other = setup()
    const pending = await pendingUserCard(other)
    await expect(other.requests.resolve(pending.token, 'deny', AS_ADMIN)).resolves.toEqual({ ok: true })
    expect(other.store.hasUser('u_bob')).toBe(false)
  })

  it('非管理员 actor、未知 token 与已结算 token 都返回 ok:false', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)

    const foreign = await runtime.requests.resolve(token, 'allow', { kind: 'admin', userId: 'u_alice' })
    expect(foreign.ok ? '' : foreign.error).toContain('仅管理员')
    expect(await runtime.requests.resolve('tok-unknown', 'allow', AS_ADMIN)).toMatchObject({ ok: false, error: expect.stringContaining('不存在') })
    await runtime.requests.resolve(token, 'allow', AS_ADMIN)
    expect(await runtime.requests.resolve(token, 'deny', AS_ADMIN)).toMatchObject({ ok: false, error: expect.stringContaining('已处理') })
  })

  it('过期 token 返回 ok:false 并落 expired', async () => {
    const runtime = setup()
    await runtime.store.putRequest(requestRecord({
      token: 'tok-expired', targetId: 'u_bob', createdAt: 0, expiresAt: runtime.clock.now - 1, messageId: 'om_1',
    }))
    const result = await runtime.requests.resolve('tok-expired', 'allow', AS_ADMIN)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('已过期') })
    expect(runtime.store.getRequest('tok-expired')?.status).toBe('expired')
  })

  it('重启（内存清空后从 durable 表重新 load）仍可按 token 结算', async () => {
    const runtime = setup()
    const { token } = await pendingUserCard(runtime)
    runtime.store.clear()
    runtime.store.load()
    expect(runtime.store.getRequest(token)?.status).toBe('pending')
    await expect(runtime.requests.resolve(token, 'allow', AS_ADMIN)).resolves.toEqual({ ok: true })
    expect(runtime.store.hasUser('u_bob')).toBe(true)
  })
})

describe('AccessRequests.expirePending', () => {
  it('把到期的 pending 申请落为 expired 并 patch 卡片终态', async () => {
    const runtime = setup()
    await runtime.store.putRequest(requestRecord({
      token: 'tok-expired', targetId: 'u_bob', createdAt: 0, expiresAt: runtime.clock.now - 1, messageId: 'om_card',
    }))

    await runtime.requests.expirePending()

    expect(runtime.store.getRequest('tok-expired')?.status).toBe('expired')
    expect(runtime.channel.updated).toHaveLength(1)
    expect(runtime.channel.updated[0]?.messageId).toBe('om_card')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已过期')
  })
})
