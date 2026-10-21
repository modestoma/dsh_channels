/**
 * Access runtime tests: AccessController admission behavior (private-chat
 * notice/cooldown, group silence + request hooks, command plane, route
 * ownership) and the AccessRequests lifecycle (bot-added cards, card actions,
 * panel settlement, expiry, restart persistence).
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
  groupRecord, makeAccessConfig, makeAccessDomain, requestRecord,
} from './access-fixtures.ts'
import { makeChannel, makeMessage } from './helpers.ts'
import type { FakeChannelOptions } from './helpers.ts'

const ADMIN = 'u_admin'
const DAY_MS = 86_400_000

type FakeChannel = ReturnType<typeof makeChannel>
type SentEntry = FakeChannel['sent'][number]

interface RuntimeOptions {
  config?: Partial<FeishuConfig>
  channel?: FakeChannelOptions
  /** Simulate the pre-startup window (no live channel). */
  noChannel?: boolean
  clock?: { now: number }
}

/** One controller + requests pair over fresh fakes. */
function setup(options: RuntimeOptions = {}) {
  // The partial override is applied after validation on purpose: a few tests
  // exercise config values the schema would reject (e.g. padded whitespace).
  const config: FeishuConfig = { ...makeAccessConfig(), ...options.config }
  const channel = makeChannel(options.channel)
  const liveChannel: FakeChannel | undefined = options.noChannel === true ? undefined : channel
  const domain = makeAccessDomain()
  const warn = vi.fn()
  const store = new AccessStore({ domain: () => domain.handle, warn })
  store.load()
  const clock = options.clock ?? { now: 1_000_000 }
  const onDeniedGroup = vi.fn()
  const onDeniedUser = vi.fn()
  const controller = new AccessController({
    config: () => config,
    store,
    channel: () => liveChannel,
    warn,
    onDeniedGroup,
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
  return { config, channel, domain, store, warn, clock, controller, requests, onDeniedGroup, onDeniedUser }
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

/** Create a pending group request through the bot-added path and return its token. */
async function pendingGroupCard(
  runtime: ReturnType<typeof setup>,
  chatId = 'oc_new',
): Promise<{ token: string; messageId: string }> {
  await runtime.requests.handleBotAdded(botAdded(chatId))
  const entry = runtime.channel.sent[0]
  if (entry === undefined) throw new Error('no card sent')
  const value = buttonValue(sentCard(entry), '授权本群')
  if (value === undefined) throw new Error('no authorize button on the group card')
  const record = runtime.store.pendingRequestFor('group', chatId)
  return { token: value.token, messageId: record?.messageId ?? 'om_1' }
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
    const runtime = setup({ config: { adminUserId: undefined }, clock })
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

  it('用户白名单在私聊仍然被拒（白名单只在群聊生效）', async () => {
    const runtime = setup()
    await runtime.store.addUser({ userId: 'u_alice', source: 'command', addedBy: ADMIN, addedAt: 1 })
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '你好',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
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
  it('未授权群里的普通闲聊静默丢弃，不触发任何申请', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_unauthorized', senderId: 'u_alice', mentionedBot: false, content: '随便聊聊',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
    expect(runtime.onDeniedGroup).not.toHaveBeenCalled()
    expect(runtime.onDeniedUser).not.toHaveBeenCalled()
  })

  it('未授权群被非管理员 @ 时静默并触发群授权申请钩子', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_unauthorized', senderId: 'u_alice', mentionedBot: true, content: '@机器人',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
    expect(runtime.onDeniedGroup).toHaveBeenCalledWith(msg)
    expect(runtime.onDeniedUser).not.toHaveBeenCalled()
  })

  it('未授权群里管理员被 @ 时直接放行，不触发授权申请', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_unauthorized', senderId: ADMIN, mentionedBot: true, content: '@机器人',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(true)
    expect(runtime.channel.sent).toEqual([])
    expect(runtime.onDeniedGroup).not.toHaveBeenCalled()
    expect(runtime.onDeniedUser).not.toHaveBeenCalled()
  })

  it('未授权群里命中已有话题（threadId）也算“对机器人说的”，触发群授权申请', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_unauthorized', senderId: 'u_alice',
      mentionedBot: false, threadId: 'omt_old', content: '继续',
    })
    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
    expect(runtime.onDeniedGroup).toHaveBeenCalledWith(msg)
  })

  it('已授权群里的未授权用户静默并触发用户授权申请钩子', async () => {
    const runtime = setup()
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_group' }))
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_stranger', mentionedBot: true, content: '@机器人',
    })

    await expect(runtime.controller.admit(msg)).resolves.toBe(false)
    expect(runtime.channel.sent).toEqual([])
    expect(runtime.onDeniedUser).toHaveBeenCalledWith(msg)
    expect(runtime.onDeniedGroup).not.toHaveBeenCalled()
  })

  it('已授权群里管理员与白名单用户放行', async () => {
    const runtime = setup()
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_group' }))
    await runtime.store.addUser({ userId: 'u_alice', source: 'command', addedBy: ADMIN, addedAt: 1 })

    for (const senderId of [ADMIN, 'u_alice']) {
      const msg = makeMessage({
        chatType: 'group', chatId: 'oc_group', senderId, mentionedBot: true, content: '你好',
      })
      await expect(runtime.controller.admit(msg)).resolves.toBe(true)
    }
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
    for (const config of [{}, { adminUserId: undefined }] as Partial<FeishuConfig>[]) {
      const runtime = setup({ config })
      const msg = makeMessage({
        chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '/userid',
      })
      await expect(runtime.controller.admitCommand(msg, 'userid')).resolves.toBe(true)
      expect(runtime.channel.sent).toEqual([])
    }
  })

  it('管理员未配置时私聊非管理员命令回配置引导文案', async () => {
    const runtime = setup({ config: { adminUserId: undefined } })
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '/help',
    })
    await expect(runtime.controller.admitCommand(msg, 'help')).resolves.toBe(false)
    expect(textSends(runtime.channel)).toEqual([DM_UNCONFIGURED_TEXT])
  })

  it('私聊非管理员的其他命令回固定提示并拒绝', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'p2p', chatId: 'oc_p2p_alice', senderId: 'u_alice', mentionedBot: false, content: '/help',
    })
    await expect(runtime.controller.admitCommand(msg, 'help')).resolves.toBe(false)
    expect(textSends(runtime.channel)).toEqual([DM_DENY_TEXT])
  })

  it('私聊管理员的所有命令放行', async () => {
    const runtime = setup()
    for (const name of ['help', 'auth', 'status', 'workspace', undefined]) {
      const msg = makeMessage({
        chatType: 'p2p', chatId: 'oc_p2p_admin', senderId: ADMIN, mentionedBot: false, content: '/help',
      })
      await expect(runtime.controller.admitCommand(msg, name)).resolves.toBe(true)
    }
    expect(runtime.channel.sent).toEqual([])
  })

  it('未授权群里管理员的所有命令放行（白名单不约束管理员）', async () => {
    const runtime = setup()
    for (const name of ['auth', 'groupid', 'help', 'health', 'status', undefined]) {
      const msg = makeMessage({
        chatType: 'group', chatId: 'oc_unauthorized', senderId: ADMIN, content: '/help',
      })
      await expect(runtime.controller.admitCommand(msg, name)).resolves.toBe(true)
    }
    expect(runtime.channel.sent).toEqual([])
  })

  it('未授权群里的非管理员命令一律静默拒绝（含 /auth）', async () => {
    const runtime = setup()
    for (const name of ['auth', 'groupid', 'help']) {
      const msg = makeMessage({
        chatType: 'group', chatId: 'oc_unauthorized', senderId: 'u_alice', content: `/${name}`,
      })
      await expect(runtime.controller.admitCommand(msg, name)).resolves.toBe(false)
    }
    expect(runtime.channel.sent).toEqual([])
  })

  it('已授权群按完整准入矩阵判定命令', async () => {
    const runtime = setup()
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_group' }))
    await runtime.store.addUser({ userId: 'u_alice', source: 'command', addedBy: ADMIN, addedAt: 1 })

    const authorize = (senderId: string) => makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId, content: '/help',
    })
    await expect(runtime.controller.admitCommand(authorize('u_alice'), 'help')).resolves.toBe(true)
    await expect(runtime.controller.admitCommand(authorize('u_stranger'), 'help')).resolves.toBe(false)
  })

  it('open 模式下所有命令直接放行', async () => {
    const runtime = setup({ config: { accessMode: 'open' } })
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_any', senderId: 'u_anyone', content: '/help',
    })
    await expect(runtime.controller.admitCommand(msg, 'help')).resolves.toBe(true)
  })
})

describe('AccessController.ownsRoute / isAdmin', () => {
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

  it('isAdmin 会裁剪配置与输入两侧的空白', () => {
    const runtime = setup({ config: { adminUserId: '  u_admin  ' } })
    expect(runtime.controller.isAdmin('u_admin')).toBe(true)
    expect(runtime.controller.isAdmin(' u_admin ')).toBe(true)
    expect(runtime.controller.isAdmin('u_other')).toBe(false)
    expect(runtime.controller.isAdmin(undefined)).toBe(false)
  })
})

describe('AccessRequests.handleBotAdded', () => {
  it('未授权群：私聊管理员群信息卡，记录 pending 并回写 messageId', async () => {
    const runtime = setup({ channel: {
      chatInfo: async () => ({
        chatId: 'oc_new', chatType: 'group', name: '产品群', memberCount: 12, ownerId: 'u_owner',
      }),
    } })

    await runtime.requests.handleBotAdded(botAdded('oc_new', 'u_inviter'))

    expect(runtime.channel.sent).toHaveLength(1)
    const [entry] = runtime.channel.sent
    expect(entry?.chatId).toBe(ADMIN)
    const json = JSON.stringify(sentCard(entry!))
    expect(json).toContain('群信息')
    expect(json).toContain('oc_new')
    expect(json).toContain('产品群')
    expect(json).toContain('u_inviter')
    expect(json).toContain('授权本群')

    const pending = runtime.store.pendingRequestFor('group', 'oc_new')
    expect(pending).toMatchObject({
      kind: 'group',
      targetId: 'oc_new',
      groupName: '产品群',
      requesterUserId: 'u_inviter',
      status: 'pending',
      messageId: 'om_1',
    })
    // 入群只发卡，不自动授权。
    expect(runtime.store.hasGroup('oc_new')).toBe(false)
  })

  it('同一群的重复入群事件只发一张卡（pending 去重）', async () => {
    const runtime = setup()
    await runtime.requests.handleBotAdded(botAdded('oc_new'))
    await runtime.requests.handleBotAdded(botAdded('oc_new'))
    await runtime.requests.handleBotAdded(botAdded('oc_new'))

    expect(runtime.channel.sent).toHaveLength(1)
    expect(runtime.store.pendingRequests(runtime.clock.now)).toHaveLength(1)
    expect(runtime.store.pendingRequests(runtime.clock.now)[0]?.targetId).toBe('oc_new')
  })

  it('管理员邀请机器人入群也不会自动授权', async () => {
    const runtime = setup()
    await runtime.requests.handleBotAdded(botAdded('oc_new', ADMIN))
    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.store.pendingRequestFor('group', 'oc_new')?.status).toBe('pending')
  })

  it('已授权群只发信息卡并标注已授权，不带授权按钮、不再建申请', async () => {
    const runtime = setup({ channel: {
      chatInfo: async chatId => ({ chatId, chatType: 'group', name: '老群' }),
    } })
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_existing', name: '老群' }))

    await runtime.requests.handleBotAdded(botAdded('oc_existing'))

    expect(runtime.channel.sent).toHaveLength(1)
    const card = sentCard(runtime.channel.sent[0]!)
    const json = JSON.stringify(card)
    expect(json).toContain('老群')
    expect(json).toContain('该群已授权')
    expect(json).not.toContain('授权本群')
    expect(buttonValue(card, '授权本群')).toBeUndefined()
    expect(runtime.store.pendingRequests(runtime.clock.now)).toEqual([])
  })

  it('管理员未配置时只 warn：不发卡、不建申请', async () => {
    const runtime = setup({ config: { adminUserId: undefined } })
    await runtime.requests.handleBotAdded(botAdded('oc_new'))

    expect(runtime.channel.sent).toEqual([])
    expect(runtime.store.pendingRequests(runtime.clock.now)).toEqual([])
    expect(runtime.warn).toHaveBeenCalledWith(expect.stringContaining('no administrator'), 'oc_new')
  })

  it('getChatInfo 失败时降级为只带可获取字段的卡（仍可授权）', async () => {
    const runtime = setup({ channel: {
      chatInfo: () => { throw new Error('no chat permission') },
    } })

    await runtime.requests.handleBotAdded(botAdded('oc_new'))

    expect(runtime.channel.sent).toHaveLength(1)
    const card = sentCard(runtime.channel.sent[0]!)
    expect(JSON.stringify(card)).toContain('oc_new')
    expect(JSON.stringify(card)).toContain('授权本群')
    expect(runtime.warn).toHaveBeenCalledWith(
      expect.stringContaining('reading chat info for %s failed'),
      'oc_new',
      expect.stringContaining('no chat permission'),
    )
    expect(runtime.store.pendingRequestFor('group', 'oc_new')?.status).toBe('pending')
  })
})

describe('AccessRequests.onCardAction', () => {
  it('非管理员点击不生效，且只提示一次“仅管理员可操作”', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)
    const event = cardAction('om_1', { token, action: 'allow' }, 'u_alice')

    await runtime.requests.onCardAction(event)
    await runtime.requests.onCardAction(event)

    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.store.getRequest(token)?.status).toBe('pending')
    expect(runtime.channel.updated).toEqual([])
    const notices = runtime.channel.sent.filter(entry => 'text' in entry.input)
    expect(notices).toHaveLength(1)
    expect(JSON.stringify(notices[0]?.input)).toContain('仅管理员可操作该授权卡片')
  })

  it('管理员点「授权本群」：群入白名单并 patch 卡片终态', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'allow' }))

    expect(runtime.store.hasGroup('oc_new')).toBe(true)
    expect(runtime.store.getGroup('oc_new')).toMatchObject({ source: 'card', addedBy: ADMIN })
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
    expect(runtime.channel.updated).toHaveLength(1)
    expect(runtime.channel.updated[0]?.messageId).toBe('om_1')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已授权')
  })

  it('管理员点「忽略」：不入白名单，只落 denied 终态', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'deny' }))

    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.store.getRequest(token)?.status).toBe('denied')
    expect(runtime.channel.updated).toHaveLength(1)
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已忽略')
  })

  it('重复点击已结算的 token 幂等：状态与白名单不再变化', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)
    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'allow' }))
    const updatesAfterFirst = runtime.channel.updated.length

    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'deny' }))
    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'allow' }))

    expect(runtime.store.hasGroup('oc_new')).toBe(true)
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
    // 旧卡点击只会把卡片重新 patch 成同一个终态。
    expect(runtime.channel.updated.length).toBeGreaterThanOrEqual(updatesAfterFirst)
    expect(JSON.stringify(runtime.channel.updated.at(-1)?.card)).toContain('已授权')
  })

  it('过期 token 不生效：落 expired 并 patch 为已过期', async () => {
    const runtime = setup()
    await runtime.store.putRequest(requestRecord({
      token: 'tok-expired', kind: 'group', targetId: 'oc_new',
      createdAt: 0, expiresAt: runtime.clock.now - 1, messageId: 'om_1',
    }))

    await runtime.requests.onCardAction(cardAction('om_1', { token: 'tok-expired', action: 'allow' }))

    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.store.getRequest('tok-expired')?.status).toBe('expired')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已过期')
  })

  it('未知 token 或畸形回调值被静默忽略', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    await runtime.requests.onCardAction(cardAction('om_1', { token: 'tok-unknown', action: 'allow' }))
    await runtime.requests.onCardAction(cardAction('om_1', { token, action: 'reset' }))
    await runtime.requests.onCardAction(cardAction('om_1', {}))
    await runtime.requests.onCardAction(cardAction('om_1', undefined))

    expect(runtime.store.getRequest(token)?.status).toBe('pending')
    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.channel.updated).toEqual([])
  })

  it('用户授权申请卡：授权后用户入白名单（全局生效）', async () => {
    const runtime = setup()
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_group', name: '产品群' }))
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob',
      senderName: 'Bob', mentionedBot: true, content: '@机器人 我能用吗',
    })

    await runtime.requests.ensureUserRequest(msg)

    expect(runtime.channel.sent).toHaveLength(1)
    expect(runtime.channel.sent[0]?.chatId).toBe(ADMIN)
    const card = sentCard(runtime.channel.sent[0]!)
    expect(JSON.stringify(card)).toContain('用户授权申请')
    expect(JSON.stringify(card)).toContain('u_bob')
    const value = buttonValue(card, '授权用户')
    expect(value).toBeDefined()

    await runtime.requests.onCardAction(cardAction('om_1', value!))

    expect(runtime.store.hasUser('u_bob')).toBe(true)
    expect(runtime.store.getUser('u_bob')).toMatchObject({ source: 'card', name: 'Bob' })
    expect(runtime.store.getRequest(value!.token)?.status).toBe('approved')
  })

  it('用户授权申请按同一用户去重', async () => {
    const runtime = setup()
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_group' }))
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', mentionedBot: true, content: '@机器人',
    })
    await runtime.requests.ensureUserRequest(msg)
    await runtime.requests.ensureUserRequest(msg)
    expect(runtime.channel.sent).toHaveLength(1)
    expect(runtime.store.pendingRequests(runtime.clock.now)).toHaveLength(1)
  })
})

describe('AccessRequests.resolve（面板与卡片共用路径）', () => {
  it('allow 写入白名单并 patch 卡片；与卡片路径结果一致', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    await expect(runtime.requests.resolve(token, 'allow', ADMIN)).resolves.toEqual({ ok: true })

    expect(runtime.store.hasGroup('oc_new')).toBe(true)
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已授权')
  })

  it('deny 只记录状态，不写白名单', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    await expect(runtime.requests.resolve(token, 'deny', ADMIN)).resolves.toEqual({ ok: true })

    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.store.getRequest(token)?.status).toBe('denied')
  })

  it('非管理员 actor 返回 ok:false 且状态不变', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    const result = await runtime.requests.resolve(token, 'allow', 'u_alice')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('仅管理员')
    expect(runtime.store.hasGroup('oc_new')).toBe(false)
    expect(runtime.store.getRequest(token)?.status).toBe('pending')
  })

  it('未知 token 与已结算 token 都返回 ok:false', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    const unknown = await runtime.requests.resolve('tok-unknown', 'allow', ADMIN)
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('不存在') })

    await runtime.requests.resolve(token, 'allow', ADMIN)
    const repeated = await runtime.requests.resolve(token, 'deny', ADMIN)
    expect(repeated).toMatchObject({ ok: false, error: expect.stringContaining('已处理') })
    expect(runtime.store.hasGroup('oc_new')).toBe(true)
  })

  it('过期 token 返回 ok:false 并落 expired', async () => {
    const runtime = setup()
    await runtime.store.putRequest(requestRecord({
      token: 'tok-expired', kind: 'group', targetId: 'oc_new',
      createdAt: 0, expiresAt: runtime.clock.now - 1, messageId: 'om_1',
    }))

    const result = await runtime.requests.resolve('tok-expired', 'allow', ADMIN)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('已过期') })
    expect(runtime.store.getRequest('tok-expired')?.status).toBe('expired')
    expect(runtime.store.hasGroup('oc_new')).toBe(false)
  })

  it('重启（内存清空后从 durable 表重新 load）仍可按 token 结算', async () => {
    const runtime = setup()
    const { token } = await pendingGroupCard(runtime)

    // 模拟重启：只保留 durable 存储，内存快照重建。
    runtime.store.clear()
    expect(runtime.store.getRequest(token)).toBeUndefined()
    runtime.store.load()
    expect(runtime.store.getRequest(token)?.status).toBe('pending')

    await expect(runtime.requests.resolve(token, 'allow', ADMIN)).resolves.toEqual({ ok: true })
    expect(runtime.store.hasGroup('oc_new')).toBe(true)
    expect(runtime.store.getRequest(token)?.status).toBe('approved')
  })
})

describe('AccessRequests.expirePending', () => {
  it('把到期的 pending 申请落为 expired 并 patch 卡片终态', async () => {
    const runtime = setup()
    await runtime.store.putRequest(requestRecord({
      token: 'tok-expired', kind: 'group', targetId: 'oc_new', groupName: '新群',
      createdAt: 0, expiresAt: runtime.clock.now - 1, messageId: 'om_card',
    }))

    await runtime.requests.expirePending()

    expect(runtime.store.getRequest('tok-expired')?.status).toBe('expired')
    expect(runtime.store.pendingRequests(runtime.clock.now)).toEqual([])
    expect(runtime.channel.updated).toHaveLength(1)
    expect(runtime.channel.updated[0]?.messageId).toBe('om_card')
    expect(JSON.stringify(runtime.channel.updated[0]?.card)).toContain('已过期')
  })
})

describe('AccessRequests.ensureGroupRequest（入群事件缺失时的兜底）', () => {
  it('未授权群首次被 @ 时补发群信息卡并去重', async () => {
    const runtime = setup()
    const msg = makeMessage({
      chatType: 'group', chatId: 'oc_fallback', senderId: 'u_alice', mentionedBot: true, content: '@机器人',
    })

    await runtime.requests.ensureGroupRequest(msg)
    await runtime.requests.ensureGroupRequest(msg)

    expect(runtime.channel.sent).toHaveLength(1)
    expect(runtime.channel.sent[0]?.chatId).toBe(ADMIN)
    expect(JSON.stringify(sentCard(runtime.channel.sent[0]!))).toContain('授权本群')
    expect(runtime.store.pendingRequests(runtime.clock.now)).toHaveLength(1)
  })

  it('已授权群与普通闲聊都不会补发申请卡', async () => {
    const runtime = setup()
    await runtime.store.addGroup(groupRecord({ chatId: 'oc_group' }))

    await runtime.requests.ensureGroupRequest(makeMessage({
      chatType: 'group', chatId: 'oc_group', senderId: 'u_bob', mentionedBot: true, content: '@机器人',
    }))
    await runtime.requests.ensureGroupRequest(makeMessage({
      chatType: 'group', chatId: 'oc_plain', senderId: 'u_bob', mentionedBot: false, content: '闲聊',
    }))

    expect(runtime.channel.sent).toEqual([])
    expect(runtime.store.pendingRequests(runtime.clock.now)).toEqual([])
  })
})
