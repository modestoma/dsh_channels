/**
 * QuestionAnswerer tests: ownership delegation, option/multi-select answering,
 * owner gating, timeout, abort, and shutdown withdrawal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionAnswerer } from '../src/questions.ts'
import type { ApprovalRoute } from '../src/approvals.ts'
import type { CardActionEvent } from '../src/feishu-channel.ts'
import { makeAgent, makeChannel, makeSession } from './helpers.ts'

const ROUTE: ApprovalRoute = {
  chatId: 'oc_test_chat',
  cardMessageId: 'om_main',
  inThread: true,
  senderOpenId: 'ou_owner',
}

function makeAnswerer(overrides: Partial<ApprovalRoute> = {}): {
  answerer: QuestionAnswerer
  channel: ReturnType<typeof makeChannel>
  routeFor: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  const channel = makeChannel()
  const routeFor = vi.fn((sessionId: string) => sessionId === 's1' ? { ...ROUTE, ...overrides } : undefined)
  const onError = vi.fn()
  const answerer = new QuestionAnswerer(channel, { routeFor, onError }, 60_000)
  // The service wires card actions to the answerer; mirror that here.
  channel.onCardAction(event => answerer.onCardAction(event))
  return { answerer, channel, routeFor, onError }
}

/** The callback value of the button rendered with one exact label. */
function actionValue(card: object, label: string): Record<string, unknown> {
  const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements
  for (const element of elements) {
    if (element.tag !== 'button') continue
    const text = element.text as { content?: string } | undefined
    if (text?.content !== label) continue
    const behaviors = element.behaviors as Array<{ value: Record<string, unknown> }> | undefined
    const value = behaviors?.[0]?.value
    if (value !== undefined) return value
  }
  throw new Error(`no button labelled ${label}`)
}

function click(channel: ReturnType<typeof makeChannel>, messageId: string, value: Record<string, unknown>, openId = 'ou_owner'): Promise<void> {
  const event: CardActionEvent = {
    messageId,
    chatId: 'oc_test_chat',
    operator: { openId },
    action: { value, tag: 'button' },
  }
  return channel.fireCardAction(event)
}

function questionCardOf(channel: ReturnType<typeof makeChannel>): object {
  const sent = channel.sent.find(entry => 'card' in entry.input)
  if (sent === undefined) throw new Error('question card not sent')
  return (sent.input as { card: object }).card
}

describe('QuestionAnswerer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('claims an owned session, sends one card, and resolves on an option click', async () => {
    const { answerer, channel } = makeAnswerer()
    const agent = makeAgent(makeSession('s1'))
    const next = vi.fn(async () => ({ answers: [] }))
    const pending = answerer.onRequest({
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
      agent,
    }, next)

    await vi.advanceTimersByTimeAsync(0)
    expect(next).not.toHaveBeenCalled()
    expect(channel.sent).toHaveLength(1)
    expect(JSON.stringify(questionCardOf(channel))).toContain('需要你的回答')

    await click(channel, 'om_1', actionValue(questionCardOf(channel), 'B'))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
    expect(answerer.pendingCount()).toBe(0)
    // The terminal patch removes the controls.
    const settled = channel.updated.at(-1)!.card
    expect(JSON.stringify(settled)).toContain('已回答')
    expect(JSON.stringify(settled)).not.toContain('behaviors')
  })

  it('delegates through next() for unowned sessions', async () => {
    const { answerer, channel } = makeAnswerer()
    const next = vi.fn(async () => ({ answers: [{ id: 'q', selected: ['x'] }] }))
    const foreign = makeAgent(makeSession('foreign'))
    await expect(answerer.onRequest({
      questions: [{ id: 'q', question: '?', options: [{ label: 'x' }] }], agent: foreign,
    }, next)).resolves.toEqual({ answers: [{ id: 'q', selected: ['x'] }] })
    expect(next).toHaveBeenCalledTimes(1)
    expect(channel.sent).toHaveLength(0)
  })

  it('asks option-less questions as free text and resolves on a plain reply', async () => {
    const { answerer, channel } = makeAnswerer()
    const owned = makeAgent(makeSession('s1'))
    const pending = answerer.onRequest({
      questions: [{ id: 'q1', question: '自由作答？' }], agent: owned,
    }, vi.fn(async () => ({ answers: [] })))
    await vi.advanceTimersByTimeAsync(0)

    expect(answerer.hasPendingFor('s1')).toBe(true)
    expect(JSON.stringify(channel.sent[0]!.input)).toContain('请直接回复文字作答')

    expect(answerer.submitText('s1', '  我的答案  ')).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '我的答案' }] })
    expect(answerer.hasPendingFor('s1')).toBe(false)
  })

  it('ignores text for sessions without a pending question', async () => {
    const { answerer } = makeAnswerer()
    expect(answerer.submitText('s1', 'no question')).toBe(false)
    expect(answerer.submitText('foreign', 'no session')).toBe(false)
  })

  it('collects multi-select toggles until submit', async () => {
    const { answerer, channel } = makeAnswerer()
    const agent = makeAgent(makeSession('s1'))
    const pending = answerer.onRequest({
      questions: [{
        id: 'q1', question: '多选', multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
      agent,
    }, vi.fn(async () => ({ answers: [] })))
    await vi.advanceTimersByTimeAsync(0)

    await click(channel, 'om_1', actionValue(questionCardOf(channel), 'A'))
    await click(channel, 'om_1', actionValue(questionCardOf(channel), 'B'))
    // Both toggles are reflected in the latest patch.
    expect(JSON.stringify(channel.updated.at(-1)!.card)).toContain('✅ A')
    const refreshed = channel.updated.at(-1)!.card
    await click(channel, 'om_1', actionValue(refreshed, '提交本题选择'))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A', 'B'] }] })
  })

  it('ignores a non-owner click and notes the owner-only rule once', async () => {
    const { answerer, channel } = makeAnswerer()
    const agent = makeAgent(makeSession('s1'))
    let settled: unknown
    const pending = answerer.onRequest({
      questions: [{ id: 'q1', question: '选？', options: [{ label: 'A' }] }], agent,
    }, vi.fn(async () => ({ answers: [] }))).then(value => { settled = value })

    await vi.advanceTimersByTimeAsync(0)
    await click(channel, 'om_1', actionValue(questionCardOf(channel), 'A'), 'ou_stranger')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBeUndefined()
    expect(JSON.stringify(channel.updated.at(-1)!.card)).toContain('仅发起该会话的用户')
    expect(answerer.pendingCount()).toBe(1)

    await click(channel, 'om_1', actionValue(questionCardOf(channel), 'A'))
    await pending
    expect(settled).toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('fails closed on the local timeout and leaves the controls removed', async () => {
    const { answerer, channel } = makeAnswerer()
    const agent = makeAgent(makeSession('s1'))
    const pending = answerer.onRequest({
      questions: [{ id: 'q1', question: '还在吗？', options: [{ label: '在' }] }], agent,
    }, vi.fn(async () => ({ answers: [] })))
    await vi.advanceTimersByTimeAsync(0)

    const rejection = expect(pending).rejects.toThrow('等待超时')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejection
    expect(answerer.pendingCount()).toBe(0)
    expect(JSON.stringify(channel.updated.at(-1)!.card)).toContain('已超时未处理')
  })

  it('lets the host timed wait own the deadline and forwards its reason', async () => {
    const { answerer, channel } = makeAnswerer()
    const agent = makeAgent(makeSession('s1'))
    const controller = new AbortController()
    const pending = answerer.onRequest({
      questions: [{ id: 'q1', question: '计时提问', options: [{ label: 'A' }] }],
      agent,
      signal: controller.signal,
      wait: { callId: 'c1', timed: true },
    }, vi.fn(async () => ({ answers: [] })))
    await vi.advanceTimersByTimeAsync(0)

    // No local timer is armed for a timed wait: the host decides.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(answerer.pendingCount()).toBe(1)
    controller.abort(new Error('ASK_TIMED_OUT'))
    await expect(pending).rejects.toThrow('ASK_TIMED_OUT')
    expect(answerer.pendingCount()).toBe(0)
    expect(JSON.stringify(channel.updated.at(-1)!.card)).toContain('已取消')
  })

  it('withdraws every in-flight question on dispose', async () => {
    const { answerer, channel } = makeAnswerer()
    const agent = makeAgent(makeSession('s1'))
    const pending = answerer.onRequest({
      questions: [{ id: 'q1', question: '问', options: [{ label: 'A' }] }], agent,
    }, vi.fn(async () => ({ answers: [] })))
    await vi.advanceTimersByTimeAsync(0)
    answerer.dispose()
    await expect(pending).rejects.toThrow('插件已关闭')
    expect(answerer.pendingCount()).toBe(0)
    expect(channel.updated.length).toBeGreaterThan(0)
  })

  it('fails closed when the card cannot be delivered', async () => {
    const channel = makeChannel({ failCardSends: true })
    const routeFor = vi.fn(() => ROUTE)
    const onError = vi.fn()
    const answerer = new QuestionAnswerer(channel, { routeFor, onError }, 60_000)
    const agent = makeAgent(makeSession('s1'))
    await expect(answerer.onRequest({
      questions: [{ id: 'q1', question: '问', options: [{ label: 'A' }] }], agent,
    }, vi.fn(async () => ({ answers: [] })))).rejects.toThrow('card rejected')
    expect(onError).toHaveBeenCalled()
  })
})
