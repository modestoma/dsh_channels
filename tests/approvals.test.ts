/**
 * ApprovalAnswerer tests: ownership delegation, decision-card delivery,
 * owner-gated clicks, timeout fail-closed, abort withdrawal, delivery
 * failure, and shutdown disposal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalAnswerer, classifyApprovalReply } from '../src/approvals.ts'
import type { ApprovalRoute } from '../src/approvals.ts'
import type { ApprovalOutcome, ApprovalRequest } from '../src/dsh-types.ts'
import type { CardActionEvent, FeishuChannel, SendResult } from '../src/feishu-channel.ts'
import { makeAgent, makeChannel, makeSession } from './helpers.ts'

const TIMEOUT = 60_000

const ROUTE: ApprovalRoute = {
  chatId: 'oc_test_chat',
  cardMessageId: 'om_main_card',
  inThread: true,
  senderUserId: 'u_owner',
}

function makeRequest(sessionId = 'sess-approval', overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    agent: makeAgent(makeSession(sessionId)),
    toolName: 'bash',
    reason: '需要写入工作区之外的文件',
    ...overrides,
  }
}

function clickEvent(messageId: string, decision: unknown, userId = ROUTE.senderUserId): CardActionEvent {
  return {
    messageId,
    chatId: ROUTE.chatId,
    operator: { openId: 'ou_operator', userId },
    action: { value: { decision }, tag: 'button' },
  }
}

/** Narrow one recorded updateCard payload for assertions. */
interface PatchedCard {
  body: { elements: Array<{ tag: string; content?: string; columns?: Array<{ elements: Array<{ tag: string }> }> }> }
}

function patchedOf(channel: { updated: Array<{ messageId: string; card: object }> }, index = 0): PatchedCard {
  return channel.updated[index]!.card as unknown as PatchedCard
}

const firstMarkdown = (card: PatchedCard): string => card.body.elements[0]!.content ?? ''
const buttonsOf = (card: PatchedCard): Array<{ tag: string }> =>
  card.body.elements.flatMap(element => element.columns?.flatMap(column => column.elements) ?? [])
    .filter(element => element.tag === 'button')


function makeEnv(timeoutMs = TIMEOUT) {
  const channel = makeChannel()
  const routeFor = vi.fn<(sessionId: string) => ApprovalRoute | undefined>(() => ROUTE)
  const onError = vi.fn()
  const answerer = new ApprovalAnswerer(channel, { routeFor, onError }, timeoutMs)
  return { channel, routeFor, onError, answerer }
}

const nextOf = (outcome: ApprovalOutcome) => vi.fn(async () => outcome)
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('ApprovalAnswerer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delegates through next() for sessions the channel does not route', async () => {
    const { channel, routeFor, answerer } = makeEnv()
    routeFor.mockReturnValue(undefined)
    const next = nextOf('unavailable')
    await expect(answerer.onRequest(makeRequest(), next)).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalled()
    expect(channel.sent).toHaveLength(0)
    expect(answerer.pendingCount()).toBe(0)
  })

  it('settles an already-aborted ask synchronously without sending a card', async () => {
    const { channel, answerer } = makeEnv()
    const controller = new AbortController()
    controller.abort()
    await expect(answerer.onRequest(makeRequest('s', { signal: controller.signal }), nextOf('unavailable')))
      .resolves.toBe('cancelled')
    await flush()
    expect(channel.sent).toHaveLength(0)
    expect(answerer.pendingCount()).toBe(0)
  })

  it('sends a standalone decision card anchored to the streaming card and waits', async () => {
    const { channel, routeFor, answerer } = makeEnv()
    let settled = false
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable')).then(
      outcome => { settled = true; return outcome },
    )
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    expect(routeFor).toHaveBeenCalledWith('sess-approval')
    expect(channel.sent[0]).toMatchObject({
      chatId: ROUTE.chatId,
      options: { replyTo: ROUTE.cardMessageId, replyInThread: true },
    })
    expect(answerer.pendingCount()).toBe(1)
    // The question is still open — the promise has not settled.
    await flush()
    expect(settled).toBe(false)
    answerer.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('allows on the owner\'s 允许 click and patches the card to the allowed state', async () => {
    const { channel, answerer } = makeEnv()
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    // The stub channel numbers messages from om_1.
    answerer.onCardAction(clickEvent('om_1', 'allow'))
    await expect(pending).resolves.toBe('allowed-once')
    expect(answerer.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(channel.updated).toHaveLength(1))
    expect(firstMarkdown(patchedOf(channel))).toContain('已允许执行')
    expect(buttonsOf(patchedOf(channel))).toHaveLength(0)
  })

  it('rejects on the owner\'s 拒绝 click and patches the card to the denied state', async () => {
    const { channel, answerer } = makeEnv()
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    answerer.onCardAction(clickEvent('om_1', 'deny'))
    await expect(pending).resolves.toBe('rejected')
    await vi.waitFor(() => expect(channel.updated).toHaveLength(1))
    expect(firstMarkdown(patchedOf(channel))).toContain('已拒绝')
  })

  it('ignores non-owner clicks and notes the card once', async () => {
    const { channel, answerer } = makeEnv()
    let settled = false
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable')).then(
      outcome => { settled = true; return outcome },
    )
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    answerer.onCardAction(clickEvent('om_1', 'allow', 'u_stranger'))
    await flush()
    expect(settled).toBe(false)
    expect(answerer.pendingCount()).toBe(1)
    await vi.waitFor(() => expect(channel.updated).toHaveLength(1))
    const notices = patchedOf(channel).body.elements.filter(
      element => element.tag === 'markdown' && element.content?.includes('仅发起该会话的用户'),
    )
    expect(notices).toHaveLength(1)
    // Second stranger click does not re-patch.
    answerer.onCardAction(clickEvent('om_1', 'allow', 'u_stranger'))
    await flush()
    expect(channel.updated).toHaveLength(1)
    answerer.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('lets the shared-route gate decide who may click instead of the owner check', async () => {
    const channel = makeChannel()
    const mayDecide = vi.fn((userId: string) => userId === 'u_member')
    const answerer = new ApprovalAnswerer(channel, {
      routeFor: () => ({ ...ROUTE, mayDecide }),
      onError: vi.fn(),
    }, TIMEOUT)
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    answerer.onCardAction(clickEvent('om_1', 'allow', 'u_outsider'))
    await flush()
    expect(answerer.pendingCount()).toBe(1)
    answerer.onCardAction(clickEvent('om_1', 'allow', 'u_member'))
    await expect(pending).resolves.toBe('allowed-once')
    expect(mayDecide).toHaveBeenCalledWith('u_member')
  })

  it('ignores clicks with an unknown message id or an unknown decision value', async () => {
    const { channel, answerer } = makeEnv()
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    answerer.onCardAction(clickEvent('om_unknown', 'allow'))
    answerer.onCardAction(clickEvent('om_1', 'maybe'))
    answerer.onCardAction(clickEvent('om_1', undefined))
    await flush()
    expect(answerer.pendingCount()).toBe(1)
    answerer.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('fails closed (rejected) on timeout and patches the card expired', async () => {
    vi.useFakeTimers()
    const { channel, answerer } = makeEnv(20)
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(20)
    await expect(pending).resolves.toBe('rejected')
    expect(answerer.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(channel.updated).toHaveLength(1))
    expect(firstMarkdown(patchedOf(channel))).toContain('已超时')
  })

  it('a click after the timeout does not settle twice', async () => {
    vi.useFakeTimers()
    const { channel, answerer } = makeEnv(20)
    const pending = answerer.onRequest(makeRequest(), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(20)
    await expect(pending).resolves.toBe('rejected')
    answerer.onCardAction(clickEvent('om_1', 'allow'))
    await vi.advanceTimersByTimeAsync(0)
    // Only the expired patch was applied — the late click changed nothing.
    expect(channel.updated).toHaveLength(1)
  })

  it('withdraws on the ask\'s abort signal and patches the card cancelled', async () => {
    const { channel, answerer } = makeEnv()
    const controller = new AbortController()
    const pending = answerer.onRequest(makeRequest('sess-abort', { signal: controller.signal }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(answerer.pendingCount()).toBe(0)
    await vi.waitFor(() => expect(channel.updated).toHaveLength(1))
    expect(firstMarkdown(patchedOf(channel))).toContain('已取消')
  })

  it('patches the card cancelled when the abort wins the race against delivery', async () => {
    let resolveSend: (result: SendResult) => void = () => {}
    const sendPromise = new Promise<SendResult>(resolve => { resolveSend = resolve })
    const updates: Array<{ messageId: string }> = []
    const slowChannel = {
      send: vi.fn(async () => sendPromise),
      updateCard: vi.fn(async (messageId: string) => { updates.push({ messageId }) }),
    } as unknown as FeishuChannel & { send: ReturnType<typeof vi.fn> }
    const answerer = new ApprovalAnswerer(
      slowChannel,
      { routeFor: () => ROUTE, onError: vi.fn() },
      TIMEOUT,
    )
    const controller = new AbortController()
    const pending = answerer.onRequest(makeRequest('sess-slow', { signal: controller.signal }), nextOf('unavailable'))
    await vi.waitFor(() => expect(slowChannel.send).toHaveBeenCalled())
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(answerer.pendingCount()).toBe(0)
    // The card lands after the withdrawal: it must not stay answerable.
    resolveSend({ messageId: 'om_late' })
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]!.messageId).toBe('om_late')
  })

  it('fails closed (unavailable) when the card cannot be delivered', async () => {
    const channel = makeChannel({ failCardSends: true })
    const onError = vi.fn()
    const answerer = new ApprovalAnswerer(channel, { routeFor: () => ROUTE, onError }, TIMEOUT)
    await expect(answerer.onRequest(makeRequest(), nextOf('unavailable'))).resolves.toBe('unavailable')
    expect(onError).toHaveBeenCalled()
    expect(answerer.pendingCount()).toBe(0)
  })

  it('dispose withdraws every in-flight question', async () => {
    const { channel, answerer } = makeEnv()
    const a = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    const b = answerer.onRequest(makeRequest('sess-b'), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2))
    answerer.dispose()
    await expect(a).resolves.toBe('cancelled')
    await expect(b).resolves.toBe('cancelled')
    expect(answerer.pendingCount()).toBe(0)
  })

  it('parallel questions stay independent (own cards, own decisions)', async () => {
    const { channel, answerer } = makeEnv()
    const a = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    const b = answerer.onRequest(makeRequest('sess-b'), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2))
    answerer.onCardAction(clickEvent('om_2', 'deny'))
    await expect(b).resolves.toBe('rejected')
    expect(answerer.pendingCount()).toBe(1)
    answerer.onCardAction(clickEvent('om_1', 'allow'))
    await expect(a).resolves.toBe('allowed-once')
    expect(answerer.pendingCount()).toBe(0)
  })
})

describe('ApprovalAnswerer display reason', () => {
  it('prefers the localized displayReason over the audit reason', async () => {
    const { answerer, channel } = makeEnv()
    const request = makeRequest('sess-display', {
      reason: 'audit-trail reason',
      displayReason: { en: 'English display', zh: '中文展示文本' },
    })
    const pending = answerer.onRequest(request, async () => 'unavailable')
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    const card = (channel.sent[0] as { input: { card: object } }).input.card
    const json = JSON.stringify(card)
    expect(json).toContain('中文展示文本')
    expect(json).not.toContain('audit-trail reason')
    answerer.dispose()
    await pending
  })
})

describe('ApprovalAnswerer usability', () => {
  const toolCall = (callId: string, args: object | string, turn = 1) => ({
    type: 'tool/call' as const,
    seq: 1,
    data: { turn, step: 1, callId, name: 'bash', arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  })
  const sentCard = (channel: ReturnType<typeof makeChannel>, index = 0) =>
    JSON.stringify((channel.sent[index] as { input: { card: object } }).input.card)

  it('shows the recorded command and escalation target of the asked call', async () => {
    const { channel, answerer } = makeEnv()
    answerer.onSessionEvent('sess-approval', toolCall('call-1', {
      command: 'git push origin main', sandbox_permissions: 'danger-full-access', justification: 'push',
    }))
    const pending = answerer.onRequest(makeRequest('sess-approval', { callId: 'call-1' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    expect(sentCard(channel)).toContain('git push origin main')
    expect(sentCard(channel)).toContain('提升到 `danger-full-access`')
    answerer.dispose()
    await pending
  })

  it('forgets a turn\'s calls at turn end and falls back to the summary', async () => {
    const { channel, answerer } = makeEnv()
    answerer.onSessionEvent('sess-approval', toolCall('call-1', { command: 'echo old' }))
    answerer.onSessionEvent('sess-approval', { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } } as never)
    const pending = answerer.onRequest(makeRequest('sess-approval', { callId: 'call-1' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    expect(sentCard(channel)).not.toContain('echo old')
    expect(sentCard(channel)).not.toContain('将执行')
    answerer.dispose()
    await pending
  })

  it('shows raw arguments for non-bash tools and unparseable JSON verbatim', async () => {
    const { channel, answerer } = makeEnv()
    answerer.onSessionEvent('sess-approval', { ...toolCall('call-1', '{not json'), data: { ...toolCall('call-1', '{not json').data, name: 'edit' } })
    answerer.onSessionEvent('sess-approval', { ...toolCall('call-2', { path: 'a.txt' }), data: { ...toolCall('call-2', { path: 'a.txt' }).data, name: 'edit' } })
    const a = answerer.onRequest(makeRequest('sess-approval', { toolName: 'edit', callId: 'call-1' }), nextOf('unavailable'))
    const b = answerer.onRequest(makeRequest('sess-approval', { toolName: 'edit', callId: 'call-2' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2))
    expect(sentCard(channel, 0)).toContain('{not json')
    expect(sentCard(channel, 1)).toContain('a.txt')
    answerer.dispose()
    await Promise.all([a, b])
  })

  it('stop-asking grants the same tool + mode in the same session only', async () => {
    const { channel, answerer } = makeEnv()
    answerer.onSessionEvent('sess-a', toolCall('call-1', { command: 'ls', sandbox_permissions: 'workspace-write' }))
    const first = answerer.onRequest(makeRequest('sess-a', { callId: 'call-1' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    answerer.onCardAction(clickEvent('om_1', 'always'))
    await expect(first).resolves.toBe('allowed-once')
    await vi.waitFor(() => expect(channel.updated).toHaveLength(1))
    expect(firstMarkdown(patchedOf(channel))).toContain('本话题不再询问')

    // Same tool + mode in the same session: answered without a card.
    answerer.onSessionEvent('sess-a', toolCall('call-2', { command: 'pwd', sandbox_permissions: 'workspace-write' }))
    await expect(answerer.onRequest(makeRequest('sess-a', { callId: 'call-2' }), nextOf('unavailable')))
      .resolves.toBe('allowed-once')
    expect(channel.sent).toHaveLength(1)

    // A wider mode, or another session, still asks.
    answerer.onSessionEvent('sess-a', toolCall('call-3', { command: 'rm x', sandbox_permissions: 'danger-full-access' }))
    const wider = answerer.onRequest(makeRequest('sess-a', { callId: 'call-3' }), nextOf('unavailable'))
    answerer.onSessionEvent('sess-b', toolCall('call-1', { command: 'ls', sandbox_permissions: 'workspace-write' }))
    const other = answerer.onRequest(makeRequest('sess-b', { callId: 'call-1' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(3))
    answerer.dispose()
    await expect(wider).resolves.toBe('cancelled')
    await expect(other).resolves.toBe('cancelled')
  })

  it('stop-asking also allows the other pending cards it covers', async () => {
    const { channel, answerer } = makeEnv()
    const a = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    const b = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    const c = answerer.onRequest(makeRequest('sess-a', { toolName: 'edit' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(3))
    answerer.onCardAction(clickEvent('om_2', 'always'))
    await expect(a).resolves.toBe('allowed-once')
    await expect(b).resolves.toBe('allowed-once')
    expect(answerer.pendingCount()).toBe(1)
    answerer.dispose()
    await expect(c).resolves.toBe('cancelled')
  })

  it('typed keywords decide the newest pending card', async () => {
    const { channel, answerer } = makeEnv()
    const older = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    const newer = answerer.onRequest(makeRequest('sess-a', { toolName: 'edit' }), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2))
    expect(answerer.submitText('sess-a', '允许！')).toBe('allowed')
    await expect(newer).resolves.toBe('allowed-once')
    expect(answerer.submitText('sess-a', 'N')).toBe('denied')
    await expect(older).resolves.toBe('rejected')
    expect(answerer.submitText('sess-a', '允许')).toBeUndefined()
    await vi.waitFor(() => expect(channel.updated).toHaveLength(2))
    expect(channel.updated.map(update => JSON.stringify(update.card)).join('\n')).toContain('文字回复')
  })

  it('a typed 全部允许 records the stop-asking grant', async () => {
    const { channel, answerer } = makeEnv()
    const pending = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    expect(answerer.submitText('sess-a', '全部允许')).toBe('remembered')
    await expect(pending).resolves.toBe('allowed-once')
    await expect(answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))).resolves.toBe('allowed-once')
  })

  it('any other text rejects every pending card of the session as superseded', async () => {
    const { channel, answerer } = makeEnv()
    const a = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    const b = answerer.onRequest(makeRequest('sess-a', { toolName: 'edit' }), nextOf('unavailable'))
    const other = answerer.onRequest(makeRequest('sess-b'), nextOf('unavailable'))
    await vi.waitFor(() => expect(channel.sent).toHaveLength(3))
    expect(answerer.hasPendingFor('sess-a')).toBe(true)
    expect(answerer.submitText('sess-a', '先别删，改用 git mv')).toBe('superseded')
    await expect(a).resolves.toBe('rejected')
    await expect(b).resolves.toBe('rejected')
    expect(answerer.hasPendingFor('sess-a')).toBe(false)
    expect(answerer.hasPendingFor('sess-b')).toBe(true)
    await vi.waitFor(() => expect(channel.updated).toHaveLength(2))
    expect(JSON.stringify(channel.updated[0]!.card)).toContain('下一条指令')
    answerer.dispose()
    await other
  })

  it('reports the session\'s waiting tools on open and settle', async () => {
    const channel = makeChannel()
    const onWaitingChange = vi.fn()
    const answerer = new ApprovalAnswerer(channel, { routeFor: () => ROUTE, onError: vi.fn(), onWaitingChange }, TIMEOUT)
    const pending = answerer.onRequest(makeRequest('sess-a'), nextOf('unavailable'))
    expect(onWaitingChange).toHaveBeenLastCalledWith('sess-a', ['bash'])
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1))
    answerer.onCardAction(clickEvent('om_1', 'allow'))
    await pending
    expect(onWaitingChange).toHaveBeenLastCalledWith('sess-a', [])
  })
})

describe('classifyApprovalReply', () => {
  it.each([
    ['允许', 'allow'], ['好的。', 'allow'], ['OK', 'allow'], ['y', 'allow'],
    ['拒绝', 'deny'], ['不行', 'deny'], ['No!', 'deny'],
    ['全部允许', 'always'], ['allow all', 'always'],
    ['允许删除 build 目录', undefined], ['', undefined],
  ] as const)('%s → %s', (text, expected) => {
    expect(classifyApprovalReply(text)).toBe(expected)
  })
})
