/**
 * TurnStreamer tests: chunk folding, 500 ms throttle, finalization and the
 * Typing → DONE/No reaction swap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DROPPED_NOTICE } from '../src/cards.ts'
import { TurnStreamer } from '../src/streamer.ts'
import type { AttachOptions } from '../src/streamer.ts'
import type { MessageId, Session, SessionEvent, SessionId, UserMessage } from '../src/dsh-types.ts'
import type { ChannelPrompt } from '../src/session/prompt.ts'
import type { FeishuChannel } from '../src/feishu-channel.ts'
import { FakeTurnDriver, makeSession, sessionEvents } from './helpers.ts'

/**
 * A message as the Agent loop claims it. A `user` message is one DSH created
 * for a channel prompt whose request id is `id` (`source.rpcId`); any other
 * kind is a host turn's message.
 */
function prompt(id: string, kind = 'user'): UserMessage {
  const source = kind === 'user'
    ? { kind, rpcId: id, principal: { kind: 'feishu-user', userId: 'u_test' } }
    : { kind }
  return { id: `msg-${id}` as MessageId, role: 'user', content: [{ type: 'text', text: id }], source }
}

/** The channel prompt DSH turned into `prompt(id)`. */
function promptOf(message: UserMessage): ChannelPrompt {
  const rpcId = (message.source as { rpcId?: string }).rpcId ?? message.id
  return { requestId: rpcId, principal: { kind: 'feishu-user', userId: 'u_test' }, content: [{ type: 'text', text: rpcId }] }
}

/** `steerTargetOf` / `mergeQueued` see the channel prompt of `prompt(id)`. */
function queuedPrompt(id: string): ChannelPrompt {
  return promptOf(prompt(id))
}

/**
 * A streamer driven the way the Agent loop drives it: every attached prompt
 * is a followup the fake loop claims as its own turn (at once when idle, after
 * the running turn's `turn/end` otherwise), and a merged prompt is steered.
 */
class DrivenStreamer extends TurnStreamer {
  private nextPrompt = 0
  private readonly attached = new Map<string, Session>()
  private readonly driver = new FakeTurnDriver((session, message, turn) => this.onInboxClaimed(session, message, turn))

  override attach(
    session: Session,
    cardMessageId: string,
    triggerMessageId: string,
    reactionId: string | undefined,
    options: Partial<AttachOptions> & { message?: UserMessage } = {},
  ): void {
    const { message: given, ...rest } = options
    const message = given ?? prompt(`auto-${++this.nextPrompt}`)
    this.attached.set(session.id, session)
    super.attach(session, cardMessageId, triggerMessageId, reactionId, { ...rest, prompt: rest.prompt ?? promptOf(message) })
    this.driver.followup(session, message)
  }

  /** Start a turn no Feishu message triggered (subagent, job, schedule). */
  hostTurn(session: Session, message: UserMessage): void {
    this.driver.followup(session, message)
  }

  override onSessionEvent(session: Session, event: SessionEvent): void {
    super.onSessionEvent(session, event)
    this.driver.observe(session, event)
  }

  override mergeQueued(messageId: string, steer: (sessionId: string, prompt: ChannelPrompt) => boolean): boolean {
    return super.mergeQueued(messageId, (sessionId, queued) => {
      const accepted = steer(sessionId, queued)
      const session = this.attached.get(sessionId)
      if (accepted && session !== undefined) this.driver.steered(session, prompt(queued.requestId))
      return accepted
    })
  }
}

function channel(): FeishuChannel & { updated: Array<{ messageId: string; card: object }> } {
  const updated: Array<{ messageId: string; card: object }> = []
  return {
    onMessage: vi.fn(() => () => {}),
    onCardAction: vi.fn(() => () => {}),
    onBotAdded: vi.fn(() => () => {}),
    getChatInfo: vi.fn(async () => ({ chatId: 'oc_chat', chatType: 'group' as const })),
    botOpenId: () => 'bot',
    getConnectionStatus: vi.fn(() => ({ state: 'connected' as const, reconnectAttempts: 0 })),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: 'om_1' })),
    replyMedia: vi.fn(async () => ({ messageId: 'om_1' })),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      updated.push({ messageId, card })
    }),
    addReaction: vi.fn(async () => 'react-1'),
    removeReaction: vi.fn(async () => {}),
    threadIdOfMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => (async function* (): AsyncGenerator<Uint8Array> {})()),
    updated,
  }
}

function hooks() {
  return {
    measureContext: () => ({ contextTokens: 1000, contextWindow: 64000 }),
    sessionLabel: (id: string) => id,
    onError: vi.fn(),
    onTurnFinalized: vi.fn(),
    onSegmentDelivered: vi.fn(),
    sendSegmentCard: vi.fn(async (
      _sessionId: string,
      segment: number,
      _card: object,
      _fallbackText: string,
    ) => ({ messageId: `om_seg_${segment}`, mode: 'card' as const })),
  }
}

/** A card's headline: its first markdown line naming the turn state. */
const HEADLINE = /^(⚙️|🧠|✍️|🔧|🤖|🧵|✋|❓|🗜|🔁|⚠️|✅|⏹|❌) /u

function elementsOf(card: object): Array<{ tag: string; content?: string; text_size?: string }> {
  return (card as { body: { elements: Array<{ tag: string; content?: string; text_size?: string }> } }).body.elements
}

/** The card's headline, or '' when it has none. */
function headlineOf(card: object): string {
  const first = elementsOf(card).find(element => element.tag === 'markdown' && element.text_size === undefined)
  return first?.content !== undefined && HEADLINE.test(first.content) ? first.content : ''
}

/** The card's elements after its headline. */
function contentOf(card: object): Array<{ tag: string; content?: string; text_size?: string }> {
  const elements = elementsOf(card)
  const headline = headlineOf(card)
  return headline === '' ? elements : elements.filter(element => element.content !== headline)
}

function markdownOf(card: object, index: number): string {
  return contentOf(card).filter(element => element.tag === 'markdown')[index]?.content ?? ''
}

describe('TurnStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes the first frame immediately, then throttles to refreshMs', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-stream')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    // First mark: patch fires after the 500 ms throttle.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } })
    expect(ch.updated.length).toBe(0)

    await vi.advanceTimersByTimeAsync(499)
    expect(ch.updated.length).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(ch.updated.length).toBe(1)
    expect(markdownOf(ch.updated[0]!.card, 0)).toContain('你好')

    // Subsequent deltas in the same window coalesce into one patch.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(ch.updated.length).toBe(2)
    expect(markdownOf(ch.updated[1]!.card, 0)).toContain('你好，世界')
  })

  it('collects reasoning deltas into the fold panel and flips the title on first text', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-reason')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先想想' } })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 1, text: '答' } })
    await vi.advanceTimersByTimeAsync(500)

    const card = ch.updated[0]!.card as {
      body: { elements: [{ tag: string }, {
        tag: string
        header: { title: { content: string } }
        elements: Array<{ content: string }>
      }] }
    }
    // The headline follows the stream; the panel only folds the reasoning away.
    expect(headlineOf(card)).toMatch(/^✍️ 输出中 · /u)
    const panel = card.body.elements[1]
    expect(panel?.header.title.content).toBe('思考过程')
    expect(panel?.elements[0]?.content).toContain('先想想')
  })

  it('finalizes on turn/end: settled card, final patch, and Typing→DONE swap', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-done')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onSessionEvent(session, {
      type: 'step/start', seq: 1, data: { turn: 1, step: 1 },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '完整回答' } })
    streamer.onSessionEvent(session, {
      type: 'assistant/message', seq: 3,
      data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 5 } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stop' } })

    // turn/end finalizes immediately without waiting for the throttle.
    const finalized = ch.updated.at(-1)!
    const elements = (finalized.card as {
      body: { elements: Array<{ tag: string; content?: string; text_size?: string }> }
    }).body.elements
    // No reasoning in this turn: no empty panel — the outcome headline, body,
    // divider and the two settled footer lines.
    expect(elements.map(element => element.tag)).toEqual(['markdown', 'markdown', 'hr', 'markdown', 'markdown'])
    expect(elements[0]?.content).toMatch(/^✅ 已完成 · 用时 /u)
    expect(elements[1]?.content).toContain('完整回答')
    expect(elements[3]?.text_size).toBe('notation')
    expect(elements[3]?.content).toContain('模型')
    expect(elements[3]?.content).toContain('推理 —')
    expect(elements[4]?.content).toContain('上下文')

    await vi.advanceTimersByTimeAsync(0)
    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('om_trigger', 'react-typing')
      expect(add).toHaveBeenCalledWith('om_trigger', 'DONE')
    })
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-done', 1, 'om_card')
  })

  it('skips removal when the Typing reaction was never added, still adds DONE', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-noreact')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })

    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(add).toHaveBeenCalledWith('om_trigger', 'DONE')
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it('renders a structured turn failure, isolates prior-turn effort, and swaps Typing→No', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-failed')
    // The preceding turn succeeded with high. The new turn fails before it can
    // emit request/header or usage, so none of these samples belong to it.
    ;(sessionEvents(session) as SessionEvent[]).push(
      {
        type: 'request/header',
        seq: 1,
        data: { header: { config: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash-vision-exp',
          reasoningEffort: 'high',
        } } },
      },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          turn: 1,
          step: 1,
          message: {},
          usage: { inputTokens: 91, outputTokens: 89, cacheReadTokens: 20 },
        },
      },
    )
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onSessionEvent(session, {
      type: 'turn/end',
      seq: 3,
      data: {
        turn: 2,
        reason: {
          kind: 'error',
          error: {
            message: 'provider "deepseek-official" model "deepseek-v4-flash-vision-exp" does not support reasoning effort "tiny"',
            code: 'UNSUPPORTED_REASONING_EFFORT',
          },
        },
      },
    })

    const finalized = ch.updated.at(-1)!.card as {
      body: { elements: Array<{ tag: string; content?: string; header?: { title: { content: string } } }> }
    }
    // The failure diagnostic renders once, in the body — the old duplicate
    // status line is gone, and no empty panel is left behind.
    const list = finalized.body.elements
    expect(list.map(element => element.tag)).toEqual(['markdown', 'markdown', 'hr', 'markdown', 'markdown'])
    expect(list[0]?.content).toMatch(/^❌ 失败 · /u)
    expect(list[1]?.content).toContain('本轮运行失败')
    const rendered = JSON.stringify(finalized)
    expect(rendered.match(/本轮运行失败/g)).toHaveLength(1)
    expect(rendered).toContain('UNSUPPORTED_REASONING_EFFORT')
    expect(rendered).toContain('does not support reasoning effort')
    expect(rendered).toContain('模型 —')
    expect(rendered).toContain('缓存命中 —')
    expect(rendered).not.toContain('(high)')

    const remove = ch.removeReaction as unknown as ReturnType<typeof vi.fn>
    const add = ch.addReaction as unknown as ReturnType<typeof vi.fn>
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('om_trigger', 'react-typing')
      expect(add).toHaveBeenCalledWith('om_trigger', 'No')
    })
    expect(add).not.toHaveBeenCalledWith('om_trigger', 'DONE')
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-failed', 2, 'om_card')
  })

  it('keeps session-cumulative token figures across turns', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-cum')
    // Historical usage already in the log before attach.
    ;(sessionEvents(session) as SessionEvent[]).push(
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 40 } } },
    )
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'assistant/message', seq: 2,
      data: { turn: 2, step: 1, message: {}, usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 45 } },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 3, data: { turn: 2, reason: 'stop' } })

    const card = ch.updated.at(-1)!.card as { body: { elements: Array<{ content?: string }> } }
    // headline, body, hr, model/session/reasoning line, usage line.
    const usageLine = card.body.elements[4]?.content ?? ''
    expect(usageLine).toContain('输入 130')
    expect(usageLine).toContain('输出 50')
    expect(usageLine).toContain('缓存命中 60.0%')
  })

  it('reports the accumulated reasoning time on the settled footer', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-reason-time')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // First reasoning phase: 3.0 s between the first reasoning delta and the
    // answer text.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })
    await vi.advanceTimersByTimeAsync(3_000)
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: '答' } })

    // Second step: another 2.0 s of reasoning, accumulated across phases.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 1, turn: 1, step: 2 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 3, chunk: { type: 'reasoning-delta', index: 0, text: '再想' } })
    await vi.advanceTimersByTimeAsync(2_000)
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 4, chunk: { type: 'text-delta', index: 0, text: '再答' } })
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a2', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 },
    })

    // Third step reasons for 4.0 s and ends in a tool call (no answer text):
    // the 30 s tool run afterwards must not count as reasoning time.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a3', revision: 1, turn: 1, step: 3 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a3', revision: 1, index: 0, time: 5, chunk: { type: 'reasoning-delta', index: 0, text: '还要查' } })
    await vi.advanceTimersByTimeAsync(4_000)
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a3', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 },
    })
    await vi.advanceTimersByTimeAsync(30_000)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a4', revision: 1, turn: 1, step: 4 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a4', revision: 1, index: 0, time: 7, chunk: { type: 'text-delta', index: 0, text: '最终答' } })

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    const json = JSON.stringify(ch.updated.at(-1)!.card)
    expect(json).toContain('会话 sess-reason-time')
    // 3.0 + 2.0 + 4.0 s of reasoning; the 30 s tool run is not counted.
    expect(json).toContain('推理 9.0s')
  })

  it('splits an oversized body into continuation segment cards, losing nothing', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-seg')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const huge = 'x'.repeat(30_000)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: huge } })

    // First flush: split + continuation send issued.
    await vi.advanceTimersByTimeAsync(500)
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    expect(sendSegment).toHaveBeenCalledTimes(1)
    expect(sendSegment.mock.calls[0]?.[1]).toBe(2)

    // Send resolves → the new card is patched; turn/end finalizes everything.
    await vi.advanceTimersByTimeAsync(500)
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    const headCard = ch.updated.filter(update => update.messageId === 'om_card').at(-1)
    const segCard = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)
    expect(headCard).toBeDefined()
    expect(segCard).toBeDefined()
    const headBody = markdownOf(headCard!.card, 0)
    const segBody = markdownOf(segCard!.card, 1)
    expect(headBody + segBody).toBe(huge)
  })

  it('finalizes continuation cards without repeating the main card footer', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-seg-done')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    const segCard = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)
    expect(segCard).toBeDefined()
    // The continuation card is just its segment header (no phase, no footer).
    const header = markdownOf(segCard!.card, 0)
    expect(header).toBe('📄 回复分段 2')
    expect(JSON.stringify(segCard!.card)).not.toContain('会话 sess-seg-done')

    // The main card carries the settled footer exactly once.
    const headCard = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
    expect(JSON.stringify(headCard)).toContain('会话 sess-seg-done')
  })

  it('splits a multi-table body into table-capped segments without losing content', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-tables')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const table = (n: number) => `| 列${n} | 值 |\n| --- | --- |\n| 行 | ${n} |`
    const tables = Array.from({ length: 7 }, (_, i) => table(i + 1)).join('\n\n')
    const body = `开头\n\n${tables}\n\n结尾`
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: body } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    // Final patch per message id, in first-seen order.
    const byId = new Map<string, object>()
    for (const update of ch.updated) {
      byId.set(update.messageId, update.card)
    }
    const bodies = [...byId.entries()].map(([messageId, card]) =>
      markdownOf(card, messageId === 'om_card' ? 0 : 1),
    )

    // Nothing lost (modulo blank-line separators at the cuts).
    const flat = (text: string) => text.replace(/\s+/g, '')
    expect(flat(bodies.join(''))).toBe(flat(body))
    // Every card carries at most 5 tables (3 pipe lines each).
    for (const content of bodies) {
      const pipeLines = (content.match(/^\s*\|[^\n]*\|/gm) ?? []).length
      expect(pipeLines).toBeLessThanOrEqual(15)
    }
  })

  it('reports segment deliveries to the hooks with the main card id', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-segdelivery')
    streamer.attach(session, 'om_main', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => {
      expect(hooksInstance.onSegmentDelivered).toHaveBeenCalledWith('om_main', 1, 'om_seg_2', 'card')
    })
  })

  it('stops streaming into a text-fallback segment and continues in a new one', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    sendSegment.mockResolvedValueOnce({ messageId: 'om_text', mode: 'text' })

    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-textmode')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)

    // One segment delivered as plain text (fallback).
    expect(sendSegment).toHaveBeenCalledTimes(1)
    expect(sendSegment.mock.calls[0]?.[3]).toContain('xxxx')
    // The text-mode card is never patched via updateCard.
    expect(ch.updated.some(update => update.messageId === 'om_text')).toBe(false)

    // More text arrives after the text-fallback delivery: it must NOT be lost
    // (it flows into a fresh segment card, never into the finished text one).
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '后续内容' } })
    await vi.advanceTimersByTimeAsync(500)

    // The follow-up content triggered its own segment send (card attempt).
    expect(sendSegment).toHaveBeenCalledTimes(2)
    expect(sendSegment.mock.calls[1]?.[1]).toBe(3)
  })

  it('throttles failed card updates with exponential backoff instead of per-flush spam', async () => {
    const ch = channel()
    ch.updateCard = vi.fn(async () => {
      throw new Error('card rejected')
    })
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-backoff')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Stream deltas for ~10 s; the rejected card must be retried at most a
    // handful of times (backoff), never once per flush.
    for (let i = 0; i < 20; i++) {
      streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: `行${i}\n` } })
      await vi.advanceTimersByTimeAsync(500)
    }
    const attempts = (ch.updateCard as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(attempts).toBeLessThanOrEqual(6)
    const onError = hooksInstance.onError as unknown as ReturnType<typeof vi.fn>
    expect(onError.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('gives up after retries when segment delivery keeps failing', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    sendSegment.mockRejectedValue(new Error('both card and text failed'))

    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-sendfail')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)
    // Retry backoffs: 1s + 2s.
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(sendSegment).toHaveBeenCalledTimes(3)
    const onError = hooksInstance.onError as unknown as ReturnType<typeof vi.fn>
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('TurnStreamer activity status + keep-alive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function markdownLines(card: object): string[] {
    const elements = (card as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements
    return elements.filter(element => element.tag === 'markdown').map(element => element.content ?? '')
  }

  function headCard(ch: ReturnType<typeof channel>): object {
    return ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
  }

  it('shows a tool call on the tool line and clears it on tool/result', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-tool')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    // Only the tool line renders (no status): the heartbeat fallback stays
    // hidden while a tool call already shows liveness.
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🔧 调用工具：bash')
    expect(markdownLines(headCard(ch)).join('\n')).toContain('已运行')
    expect(markdownLines(headCard(ch))).not.toContain('⏳ 处理中')

    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 2,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'ok' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('调用工具')
  })

  it('replaces the tool line with the approval wait while a card is undecided', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-approval-wait')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    streamer.setAwaitingApproval('sess-approval-wait', ['bash'])
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('✋ 等待审批：bash')
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('调用工具')

    streamer.setAwaitingApproval('sess-approval-wait', [])
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).not.toContain('等待审批')
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🔧 调用工具：bash')
  })

  it('shows the activity lines only on the card that is still streaming', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-active-card')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Overflow the first card so a continuation card becomes the active one.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)

    // The live tool line belongs to the active card only; the frozen main card
    // must not repeat a stale "调用工具" line.
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 3,
      data: { turn: 1, step: 2, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    await vi.advanceTimersByTimeAsync(500)

    const head = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
    const active = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)!.card
    expect(JSON.stringify(head)).not.toContain('调用工具')
    expect(JSON.stringify(active)).toContain('调用工具')
  })

  it('labels the subagent tool with its description argument', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-subagent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: {
        turn: 1, step: 1, callId: 'call-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检索实现方案', prompt: '去查资料', run_in_background: false }),
      },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🤖 调用子代理：检索实现方案')

    // Unparseable arguments fall back to the bare tool name.
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 2,
      data: { turn: 1, step: 1, callId: 'call-2', name: 'subagent', arguments: '{broken' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🤖 调用子代理：subagent')
  })

  it('keeps the workflow end status while a later tool call runs (two independent lines)', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-end-tool')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-start', seq: 1, data: { runId: 'run-1', name: 'audit' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-start', seq: 2,
      data: { runId: 'run-1', seq: 1, label: '检索代码', childId: 'child-1' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-end', seq: 3, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-end', seq: 4, data: { runId: 'run-1', stopReason: 'completed' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 5,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'done' } },
    })
    // The model follows up with a plain tool call — it must NOT supersede
    // the settled workflow status: both lines render together.
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 6,
      data: { turn: 1, step: 2, callId: 'call-2', name: 'bash', arguments: '{"command":"git log"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(headCard(ch))).toContain('🔧 调用工具：bash')
    expect(markdownLines(headCard(ch))[1]).toContain('🧵 工作流 audit 结束（完成）')

    // Tool settles, text starts: the workflow end status persists.
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 7,
      data: { turn: 1, step: 2, message: { type: 'text', text: 'ok' } },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 2 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '结论' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(headCard(ch))).toMatch(/^✍️ 输出中/u)
    expect(markdownLines(headCard(ch))[1]).toContain('工作流 audit 结束（完成）')

    // The settled card keeps the workflow conclusion; only the tool line
    // disappears.
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)
    const finalCard = headCard(ch)
    expect(headlineOf(finalCard)).toMatch(/^✅ 已完成/u)
    expect(markdownLines(finalCard)[1]).toContain('🧵 工作流 audit 结束（完成）')
    expect(markdownLines(finalCard).join('\n')).not.toContain('调用工具')
    // Settled main card: headline, status line, body, divider and the two footer lines.
    const elements = (finalCard as { body: { elements: unknown[] } }).body.elements
    expect(elements.length).toBe(6)
  })

  it('folds tool-workflow run events into a progress line with member counts', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-workflow')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-start', seq: 1, data: { runId: 'run-1', name: 'audit' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[1]).toContain('🧵 工作流 audit')
    expect(markdownLines(headCard(ch))[1]).toContain('0/0 子代理完成')

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-start', seq: 2,
      data: { runId: 'run-1', seq: 1, label: '检索代码', phase: '审查', childId: 'child-1' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const running = markdownLines(headCard(ch))[1]!
    expect(running).toContain('0/1 子代理完成')
    expect(running).toContain('阶段 审查')
    expect(running).toContain('检索代码')

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-end', seq: 3, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[1]).toContain('1/1 子代理完成')

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-end', seq: 4, data: { runId: 'run-1', stopReason: 'completed' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[1]).toContain('🧵 工作流 audit 结束（完成）')

    // The workflow tool's own tool/result must NOT erase the settled status.
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 5,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'done' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch))[1]).toContain('工作流 audit 结束（完成）')
  })

  it('heartbeats a silent turn: the headline elapsed counter appears and ticks every statusRefreshMs', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks(), 5_000)
    const session = makeSession('sess-heartbeat')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // No events at all: the slow heartbeat is what first patches the card.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(headCard(ch))).toBe('⚙️ 进行中 · 已运行 5s')

    // Still no events; the elapsed counter keeps ticking.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(headCard(ch))).toBe('⚙️ 进行中 · 已运行 10s')
  })

  it('settles the headline to the outcome once the turn ends', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks(), 5_000)
    const session = makeSession('sess-heartbeat-done')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(headCard(ch))).toContain('⚙️ 进行中')

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)

    const finalCard = headCard(ch)
    expect(headlineOf(finalCard)).toBe('✅ 已完成 · 用时 5s')
    // The settled card without activity: headline, body, divider and the two footer lines.
    const elements = (finalCard as { body: { elements: unknown[] } }).body.elements
    expect(elements.length).toBe(5)
  })
})

describe('TurnStreamer subagent child folding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeChildSession(id: string, parentId: string): Session {
    return {
      id: id as SessionId,
      header: {
        version: 0,
        id: id as SessionId,
        createdAt: Date.now(),
        parentSession: parentId as SessionId,
        origin: 'subagent',
        delegationDepth: 1,
      },
      events: [],
      firstLiveSeq: 0,
      snapshotEvents: () => [],
    } as unknown as Session
  }

  function markdownLines(card: object): string[] {
    const elements = (card as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements
    return elements.filter(element => element.tag === 'markdown').map(element => element.content ?? '')
  }

  function headCard(ch: ReturnType<typeof channel>): object {
    return ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card
  }

  /** The delegation status line: the first markdown line after the headline. */
  function activity(ch: ReturnType<typeof channel>): string {
    return markdownOf(headCard(ch), 0)
  }

  it('folds a child subagent\'s descriptor and tool calls into the parent card (status only)', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-parent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // The parent model called the subagent tool (label from description arg).
    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: {
        turn: 1, step: 1, callId: 'call-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检索实现方案', prompt: '…' }),
      },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownLines(headCard(ch)).join('\n')).toContain('🤖 调用子代理：检索实现方案')

    // The child session publishes its descriptor, then starts working.
    const child = makeChildSession('child-1', 'sess-parent')
    streamer.onSessionEvent(child, {
      type: 'subagent/descriptor', seq: 1,
      data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '检索实现方案' },
    })
    streamer.onSessionEvent(child, {
      type: 'tool/call', seq: 2,
      data: { turn: 1, step: 1, callId: 'c-call-1', name: 'read', arguments: '{"path":"src"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).toContain('🤖 子代理执行中：检索实现方案 (read)')

    // The child's tool result drops the tool suffix; its turn/end removes it
    // from the fold, falling back to the parent's own subagent tool line.
    streamer.onSessionEvent(child, {
      type: 'tool/result', seq: 3,
      data: { turn: 1, step: 1, message: { type: 'text', text: '…' } },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).toContain('🤖 子代理执行中：检索实现方案')
    expect(activity(ch)).not.toContain('(read)')

    streamer.onSessionEvent(child, { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).not.toContain('子代理执行中')
    // Parent's tool line remains until its own tool/result.
    expect(markdownLines(headCard(ch)).join('\n')).toContain('调用子代理：检索实现方案')
  })

  it('does not fold an ordinary fork that still carries parentSession into its source card', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-source')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const fork = makeChildSession('fork-1', 'sess-source')
    const header = { ...fork.header, origin: undefined }
    const historicalFork = { ...fork, header } as unknown as Session
    streamer.onSessionEvent(historicalFork, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'f-call-1', name: 'read', arguments: '{"path":"src"}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(ch.updated.filter(update => update.messageId === 'om_card').map(update => markdownLines(update.card).join('\n')).join('\n'))
      .not.toContain('子代理执行中')
  })

  it('summarizes finished subagents on the settled card (tool line disappears)', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-settled-sub')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool/call', seq: 1,
      data: {
        turn: 1, step: 1, callId: 'call-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检索实现方案', prompt: '…' }),
      },
    })
    const child = makeChildSession('child-1', 'sess-settled-sub')
    streamer.onSessionEvent(child, {
      type: 'subagent/descriptor', seq: 1,
      data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '检索实现方案' },
    })
    streamer.onSessionEvent(child, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    streamer.onSessionEvent(session, {
      type: 'tool/result', seq: 3,
      data: { turn: 1, step: 1, message: { type: 'text', text: 'done' } },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 2 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    const finalCard = headCard(ch)
    const lines = markdownLines(finalCard)
    expect(lines[1]).toContain('🤖 子代理完成：检索实现方案')
    expect(lines.join('\n')).not.toContain('调用子代理')
    expect(lines.join('\n')).not.toContain('子代理执行中')
  })

  it('counts parallel children and defaults the label to 子代理 before the descriptor', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-multi')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    const childA = makeChildSession('child-a', 'sess-multi')
    streamer.onSessionEvent(childA, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'a-1', name: 'bash', arguments: '{}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    // Descriptor not seen yet → placeholder label.
    expect(activity(ch)).toContain('🤖 子代理执行中：子代理 (bash)')

    const childB = makeChildSession('child-b', 'sess-multi')
    streamer.onSessionEvent(childB, {
      type: 'subagent/descriptor', seq: 1,
      data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '代码审查' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const line = activity(ch)
    expect(line).toContain('🤖 2 个子代理执行中')
    expect(line).toContain('子代理 (bash)')
    expect(line).toContain('代码审查')
  })

  it('ignores workflow member children (the workflow line already aggregates them)', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-wf-member')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-start', seq: 1, data: { runId: 'run-1', name: 'audit' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-start', seq: 2,
      data: { runId: 'run-1', seq: 1, label: '检索代码', childId: 'wf-child-1' },
    })
    const member = makeChildSession('wf-child-1', 'sess-wf-member')
    streamer.onSessionEvent(member, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'w-1', name: 'grep', arguments: '{}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    // While the run is live the workflow line has priority anyway; settle the
    // run and check the member never leaked into the generic children fold.
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/agent-end', seq: 3, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
    })
    streamer.onSessionEvent(session, {
      type: 'tool-workflow/run-end', seq: 4, data: { runId: 'run-1', stopReason: 'completed' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const line = activity(ch)
    expect(line).toContain('工作流 audit 结束（完成）')
    expect(line).not.toContain('(grep)')
    expect(line).not.toContain('子代理执行中')
  })

  it('ignores child sessions whose parent has no active turn', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-orphan-parent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Seed one patch so the card state is observable.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(headCard(ch))).toContain('🧠 思考中')

    // A child of some other session: must neither crash nor touch this card.
    const foreign = makeChildSession('child-x', 'unknown-session')
    streamer.onSessionEvent(foreign, {
      type: 'tool/call', seq: 1,
      data: { turn: 1, step: 1, callId: 'x-1', name: 'bash', arguments: '{}' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(activity(ch)).not.toContain('子代理')
  })
})

describe('TurnStreamer live assistant frames', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('streams text and reasoning deltas from agent/assistant-stream frames', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-live')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '你好' },
    })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '先想想' },
    })
    await vi.advanceTimersByTimeAsync(500)

    expect(ch.updated.length).toBe(1)
    expect(markdownOf(ch.updated[0]!.card, 0)).toContain('你好')
    const card = ch.updated[0]!.card as {
      body: { elements: Array<{ header: { title: { content: string } }; elements: Array<{ content: string }> }> }
    }
    expect(headlineOf(card)).toMatch(/^🧠 思考中/u)
    expect(card.body.elements[1]!.header.title.content).toBe('思考过程')
    expect(card.body.elements[1]!.elements[0]?.content).toContain('先想想')
  })

  it('rolls back an abandoned attempt and keeps a committed one', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-rollback')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    // Attempt 1 streams text, then abandons (retry / stream error): none of it
    // is model-visible history, so the card must drop it again.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '坏答案' },
    })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2,
      chunk: { type: 'reasoning-delta', index: 0, text: '坏推理' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownOf(ch.updated.at(-1)!.card, 0)).toContain('坏答案')

    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a1', revision: 1, index: 2, outcome: { kind: 'abandoned' },
    })
    await vi.advanceTimersByTimeAsync(500)
    const rolledBack = ch.updated.at(-1)!.card as {
      body: { elements: [{ elements: Array<{ content: string }> }, { content: string }] }
    }
    expect(JSON.stringify(rolledBack)).not.toContain('坏答案')
    expect(JSON.stringify(rolledBack)).not.toContain('坏推理')

    // Attempt 2 commits: its text stays.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 2, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 3,
      chunk: { type: 'text-delta', index: 0, text: '好答案' },
    })
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a2', revision: 2, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(markdownOf(ch.updated.at(-1)!.card, 0)).toContain('好答案')
  })

  it('keeps the card live through a model-request retry and drops the failed attempt', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance, 1_000)
    const session = makeSession('sess-retry')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')
    const text = (): string => JSON.stringify(ch.updated.at(-1)!.card)

    // Attempt 1 streams, then the request fails with a rate limit: the loop
    // settles it as `assistant/attempt` and dsh-llm-retry schedules a retry
    // inside the same turn.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '半截' },
    })
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a1', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 4 },
    })
    streamer.onSessionEvent(session, {
      type: 'llm/retry', seq: 5,
      data: {
        retryId: 'r1', turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'k',
        retry: 1, maxRetries: 5, delayMs: 3_000,
        failure: { message: 'Rate limit reached', code: 'RATE_LIMIT' },
      },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(text()).not.toContain('半截')
    expect(text()).toContain('⚠️ 模型请求失败（RATE_LIMIT），3 秒后第 1/5 次重试')
    expect(hooksInstance.onTurnFinalized).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(text()).toContain('2 秒后第 1/5 次重试')

    streamer.onSessionEvent(session, {
      type: 'llm/retry-started', seq: 6, data: { retryId: 'r1', turn: 1, step: 1, retry: 1 },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(text()).toContain('🔁 模型请求重试中（第 1/5 次）')

    // The retried request streams the reply; the retry line disappears.
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 2, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 2,
      chunk: { type: 'text-delta', index: 0, text: '完整答案' },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(text()).toContain('完整答案')
    expect(text()).not.toContain('重试')

    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a2', revision: 2, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledTimes(1)
    expect(text()).toContain('完整答案')
    expect(text()).not.toContain('半截')
    expect(ch.addReaction).toHaveBeenLastCalledWith('om_trigger', 'DONE')
  })

  it('reopens a writable card after rolling back a failed attempt that spilled into a continuation', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-retry-segment')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) },
    })
    // Flush splits the body and the continuation card is delivered.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hooksInstance.sendSegmentCard).toHaveBeenCalledTimes(1)

    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a1', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 4 },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 2, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 2,
      chunk: { type: 'text-delta', index: 0, text: '重试答案' },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)

    const head = JSON.stringify(ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card)
    const segment = JSON.stringify(ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)!.card)
    expect(head).not.toContain('xxxx')
    // The delivered continuation cannot be withdrawn: it is emptied and
    // carries the retried reply instead of the failed attempt's text.
    expect(segment).not.toContain('xxxx')
    expect(segment).toContain('重试答案')
  })

  it('streams the retry into the head card when the failed continuation was never sent', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-retry-unsent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) },
    })
    streamer.onAssistantFrame(session, {
      type: 'end', attemptId: 'a1', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 4 },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 2, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a2', revision: 2, index: 0, time: 2,
      chunk: { type: 'text-delta', index: 0, text: '重试答案' },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)

    const head = JSON.stringify(ch.updated.filter(update => update.messageId === 'om_card').at(-1)!.card)
    expect(head).toContain('重试答案')
    expect(head).not.toContain('xxxx')
    expect(hooksInstance.sendSegmentCard).not.toHaveBeenCalled()
  })

  it('reports the retry count when retries run out and the turn fails', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-retry-exhausted')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    for (const retry of [1, 2]) {
      streamer.onSessionEvent(session, {
        type: 'llm/retry', seq: retry * 2,
        data: {
          retryId: 'r1', turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'k',
          retry, maxRetries: 2, delayMs: 500,
          failure: { message: 'Rate limit reached', code: 'RATE_LIMIT' },
        },
      })
      streamer.onSessionEvent(session, {
        type: 'llm/retry-started', seq: retry * 2 + 1, data: { retryId: 'r1', turn: 1, step: 1, retry },
      })
    }
    streamer.onSessionEvent(session, {
      type: 'turn/end', seq: 9,
      data: { turn: 1, reason: { kind: 'error', error: { message: 'Rate limit reached', code: 'RATE_LIMIT' } } },
    })
    await vi.advanceTimersByTimeAsync(0)
    const card = JSON.stringify(ch.updated.at(-1)!.card)
    expect(card).toContain('本轮运行失败')
    expect(card).toContain('已自动重试 2 次')
    expect(card).not.toContain('🔁')
  })

  it('prefers host projection figures for tokens, cache and window', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, {
      ...hooksInstance,
      projectStats: () => ({ inputTokens: 111, outputTokens: 22, cacheHitPct: 0.5, contextWindow: 64_000 }),
    })
    const session = makeSession('sess-projected')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onSessionEvent(session, {
      type: 'request/header', seq: 1,
      data: { header: { config: { provider: 'p', model: 'm' } } },
    })
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    })
    await vi.advanceTimersByTimeAsync(500)

    // Figures live on the settled card's footer (not on live frames).
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)
    const json = JSON.stringify(ch.updated.at(-1)!.card)
    expect(json).toContain('输入 111')
    expect(json).toContain('输出 22')
    expect(json).toContain('64,000')
  })

  it('shows the series header on a later turn whose request logs no new request/header', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-series')
    // DSH logs request/header only when the envelope changes: the first turn
    // logged it, the second turn continues the same request series.
    ;(sessionEvents(session) as SessionEvent[]).push({
      type: 'request/header', seq: 1,
      data: { header: { config: { provider: 'p', model: 'deepseek-v4-pro', reasoningEffort: 'max' } } },
    })
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a2', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, {
      type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hi' },
    })
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)
    const json = JSON.stringify(ch.updated.at(-1)!.card)
    expect(json).toContain('模型 deepseek-v4-pro(max)')
    expect(json).toContain('64,000')
  })
})

describe('TurnStreamer stop button', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function buttonsOf(card: object): Array<{ text: { content: string }; disabled?: boolean }> {
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements
    return elements.filter(element => element.tag === 'button') as never
  }

  function streamText(streamer: TurnStreamer, session: Session, text: string): void {
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text } })
  }

  it('shows the button on the streaming card, then drops it when the turn settles', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-live')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, '进行中')
    await vi.advanceTimersByTimeAsync(500)
    expect(buttonsOf(ch.updated.at(-1)!.card).map(button => button.text.content)).toEqual(['⏹ 停止'])
    expect(streamer.stopTargetOf('om_card')).toBe('sess-stop-live')
    expect(streamer.stopTargetOf('om_other')).toBeUndefined()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(buttonsOf(ch.updated.at(-1)!.card)).toHaveLength(0)
    expect(JSON.stringify(ch.updated.at(-1)!.card)).not.toContain('已按请求停止')
    expect(streamer.stopTargetOf('om_card')).toBeUndefined()
  })

  it('moves the button to the newest segment card', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-seg')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, 'x'.repeat(30_000))
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    const main = ch.updated.filter(update => update.messageId === 'om_card').at(-1)!
    const segment = ch.updated.filter(update => update.messageId === 'om_seg_2').at(-1)!
    expect(buttonsOf(main.card)).toHaveLength(0)
    expect(buttonsOf(segment.card)).toHaveLength(1)
    expect(streamer.stopTargetOf('om_seg_2')).toBe('sess-stop-seg')
  })

  it('renders stopping and denied states, and settles an aborted turn as stopped', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-abort')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, '进行中')
    await vi.advanceTimersByTimeAsync(500)
    const patches = ch.updated.length

    streamer.markStopDenied('sess-stop-abort')
    streamer.markStopDenied('sess-stop-abort')
    await vi.advanceTimersByTimeAsync(500)
    expect(ch.updated).toHaveLength(patches + 1)
    expect(JSON.stringify(ch.updated.at(-1)!.card)).toContain('仅发起该会话的用户可停止')

    streamer.markStopping('sess-stop-abort')
    await vi.advanceTimersByTimeAsync(500)
    const [button] = buttonsOf(ch.updated.at(-1)!.card)
    expect(button?.text.content).toBe('正在停止…')
    expect(button?.disabled).toBe(true)

    streamer.onSessionEvent(session, {
      type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    const settled = JSON.stringify(ch.updated.at(-1)!.card)
    expect(headlineOf(ch.updated.at(-1)!.card)).toMatch(/^⏹ 已停止 · /u)
    expect(settled).not.toContain('正在停止')
    // Marks on a session without a live turn are no-ops.
    streamer.markStopping('sess-stop-abort')
    streamer.markStopping('sess-unknown')
  })

  it('offers the button only on the active turn, and moves it to the next queued turn', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-queue')
    streamer.attach(session, 'om_first', 'om_t1', undefined)
    streamer.attach(session, 'om_second', 'om_t2', undefined)
    await vi.advanceTimersByTimeAsync(500)
    const latest = (id: string) => ch.updated.filter(update => update.messageId === id).at(-1)
    expect(buttonsOf(latest('om_first')!.card)).toHaveLength(1)
    expect(latest('om_second')).toBeUndefined()
    expect(streamer.stopTargetOf('om_second')).toBeUndefined()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(500)
    expect(buttonsOf(latest('om_second')!.card)).toHaveLength(1)
    expect(streamer.stopTargetOf('om_second')).toBe('sess-stop-queue')
  })

  it('settles a cancellation it did not request as a normal end', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-stop-parent')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    streamText(streamer, session, '进行中')
    streamer.onSessionEvent(session, {
      type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } },
    })
    const settled = JSON.stringify(ch.updated.at(-1)!.card)
    expect(settled).not.toContain('已按请求停止')
    expect(buttonsOf(ch.updated.at(-1)!.card)).toHaveLength(0)
  })
})

describe('TurnStreamer queued turns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function queued(ch: ReturnType<typeof channel>, sessionId: string) {
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession(sessionId)
    streamer.attach(session, 'om_first', 'om_t1', 'react-1', { message: prompt('m1') })
    streamer.attach(session, 'om_second', 'om_t2', 'react-2', { message: prompt('m2') })
    return { streamer, session }
  }

  it('resolves only queued cards as steer targets', () => {
    const ch = channel()
    const { streamer, session } = queued(ch, 'sess-q')
    expect(streamer.hasLiveTurn('sess-q')).toBe(true)
    expect(streamer.hasLiveTurn('sess-other')).toBe(false)
    expect(streamer.steerTargetOf('om_first')).toBeUndefined()
    expect(streamer.steerTargetOf('om_second')).toEqual({ sessionId: 'sess-q', prompt: queuedPrompt('m2') })
  })

  it('merges a queued turn into the running one and settles both reactions together', async () => {
    const ch = channel()
    const { streamer, session } = queued(ch, 'sess-merge')
    const steer = vi.fn(() => true)
    expect(streamer.mergeQueued('om_second', steer)).toBe(true)
    expect(steer).toHaveBeenCalledWith('sess-merge', queuedPrompt('m2'))
    expect(JSON.stringify(ch.updated.find(update => update.messageId === 'om_second')!.card)).toContain('已补充到当前回复')
    expect(streamer.steerTargetOf('om_second')).toBeUndefined()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(500)
    expect(mockCalls(ch.removeReaction)).toEqual([['om_t1', 'react-1'], ['om_t2', 'react-2']])
    expect(mockCalls(ch.addReaction)).toEqual([['om_t1', 'DONE'], ['om_t2', 'DONE']])
    // The merged card never streams again and leaves no live turn behind.
    expect(ch.updated.filter(update => update.messageId === 'om_second')).toHaveLength(1)
    expect(streamer.hasLiveTurn('sess-merge')).toBe(false)
  })

  it('retries the merged card patch after a transient failure', async () => {
    const ch = channel()
    const errors = hooks()
    const streamer = new DrivenStreamer(ch, 500, errors)
    const session = makeSession('sess-merge-retry')
    streamer.attach(session, 'om_first', 'om_t1', undefined, { message: prompt('m1') })
    streamer.attach(session, 'om_second', 'om_t2', undefined, { message: prompt('m2') })
    mockFn(ch.updateCard).mockRejectedValueOnce(new Error('transient'))
    expect(streamer.mergeQueued('om_second', () => true)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(JSON.stringify(ch.updated.find(update => update.messageId === 'om_second')!.card)).toContain('已补充到当前回复')
    expect(errors.onError).not.toHaveBeenCalled()

    streamer.attach(session, 'om_third', 'om_t3', undefined, { message: prompt('m3') })
    mockFn(ch.updateCard).mockRejectedValue(new Error('down'))
    expect(streamer.mergeQueued('om_third', () => true)).toBe(true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(errors.onError).toHaveBeenCalledTimes(1)
  })

  it('refuses to merge while stopping, when the prompt was already claimed, or for unknown cards', () => {
    const ch = channel()
    const { streamer } = queued(ch, 'sess-refuse')
    expect(streamer.mergeQueued('om_second', () => false)).toBe(false)
    expect(streamer.mergeQueued('om_unknown', () => true)).toBe(false)
    streamer.markStopping('sess-refuse')
    const steer = vi.fn(() => true)
    expect(streamer.mergeQueued('om_second', steer)).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    expect(streamer.steerTargetOf('om_second')).toBeDefined()
  })

  it('renders the queued layout until the turn becomes the front', async () => {
    const ch = channel()
    const { streamer, session } = queued(ch, 'sess-layout')
    streamer.markQueuedDenied('om_second')
    streamer.markQueuedDenied('om_second')
    streamer.markQueuedDenied('om_first')
    await vi.advanceTimersByTimeAsync(500)
    const second = ch.updated.filter(update => update.messageId === 'om_second')
    expect(second).toHaveLength(1)
    expect(JSON.stringify(second[0]!.card)).toContain('仅发起该会话的用户可补充')

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(500)
    const active = JSON.stringify(ch.updated.filter(update => update.messageId === 'om_second').at(-1)!.card)
    expect(active).not.toContain('排队中')
    expect(active).toContain('⏹ 停止')
  })
})

function mockCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls
}

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>
}

describe('TurnStreamer headline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function latest(ch: ReturnType<typeof channel>, messageId = 'om_card'): object {
    return ch.updated.filter(update => update.messageId === messageId).at(-1)!.card
  }

  it('follows the stream: thinking, writing, back to in progress between steps', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-headline')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(latest(ch))).toBe('🧠 思考中 · 已运行 0s')

    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: '答' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(latest(ch))).toBe('✍️ 输出中 · 已运行 1s')

    streamer.onAssistantFrame(session, { type: 'end', attemptId: 'a1', revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(latest(ch))).toBe('⚙️ 进行中 · 已运行 1s')
  })

  it('shows the question wait and a running compaction', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-wait')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)

    streamer.setAwaitingAnswer('sess-wait', true)
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(latest(ch))).toBe('❓ 等待回答')
    streamer.setAwaitingAnswer('sess-wait', false)

    streamer.onSessionEvent(session, { type: 'compaction/start', seq: 1, data: { compactionId: 'c1', turn: 1 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(latest(ch))).toBe('🗜 正在压缩上下文 · 已运行 1s')
    streamer.onSessionEvent(session, { type: 'compaction/end', seq: 2, data: { compactionId: 'c1', turn: 1 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(headlineOf(latest(ch))).toBe('⚙️ 进行中 · 已运行 1s')
  })

  it('settles a queued card whose message left the inbox unclaimed', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-drop')
    streamer.attach(session, 'om_first', 'om_trigger_1', undefined, { message: prompt('m-1') })
    streamer.attach(session, 'om_queued', 'om_trigger_2', 'react-typing', { message: prompt('m-2') })

    // Another message id, or the running turn's prompt, changes nothing.
    streamer.onInboxDiscarded(session, prompt('m-other'))
    streamer.onInboxDiscarded(session, prompt('m-1'))
    expect(streamer.steerTargetOf('om_queued')).toEqual({ sessionId: 'sess-drop', prompt: queuedPrompt('m-2') })

    streamer.onInboxDiscarded(session, prompt('m-2'))
    expect(streamer.steerTargetOf('om_queued')).toBeUndefined()
    expect(latest(ch, 'om_queued')).toEqual({ schema: '2.0', config: { width_mode: 'fill' }, body: { elements: [{ tag: 'markdown', content: DROPPED_NOTICE }] } })
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-drop', 0, 'om_queued')
    await vi.waitFor(() => expect(ch.addReaction).toHaveBeenCalledWith('om_trigger_2', 'No'))
  })

  it('does not treat the steer button\'s inbox removal as a drop', async () => {
    const ch = channel()
    const streamer = new DrivenStreamer(ch, 500, hooks())
    const session = makeSession('sess-steer-drop')
    streamer.attach(session, 'om_first', 'om_trigger_1', undefined, { message: prompt('m-1') })
    streamer.attach(session, 'om_queued', 'om_trigger_2', undefined, { message: prompt('m-2') })
    const merged = streamer.mergeQueued('om_queued', (_sessionId, queued) => {
      streamer.onInboxDiscarded(session, prompt(queued.requestId))
      return true
    })
    expect(merged).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(ch.updated.filter(update => update.messageId === 'om_queued'))).not.toContain(DROPPED_NOTICE)
  })
})

describe('TurnStreamer host turns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function frame(streamer: TurnStreamer, session: Session, turn: number, text: string): void {
    streamer.onAssistantFrame(session, { type: 'start', attemptId: `a-${turn}`, revision: 1, turn, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: `a-${turn}`, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text } })
  }

  it('opens its own card for a host turn and keeps a queued Feishu card for the next turn', async () => {
    const ch = channel()
    const hooksInstance = { ...hooks(), hostTurnOrigin: vi.fn(() => '🤖 子代理已结束，继续处理') }
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-host')

    streamer.hostTurn(session, prompt('subagent-done', 'subagent-settled'))
    await vi.advanceTimersByTimeAsync(0)
    expect(hooksInstance.hostTurnOrigin).toHaveBeenCalledWith('sess-host', prompt('subagent-done', 'subagent-settled'))
    expect(hooksInstance.sendSegmentCard).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockFn(hooksInstance.sendSegmentCard).mock.calls[0]![2])).toContain('子代理已结束')

    // A Feishu message arriving meanwhile waits behind the host turn.
    streamer.attach(session, 'om_user', 'om_trigger', 'react-typing', { message: prompt('m-user') })
    expect(streamer.steerTargetOf('om_user')).toEqual({ sessionId: 'sess-host', prompt: queuedPrompt('m-user') })

    frame(streamer, session, 1, '子代理的结论')
    await vi.advanceTimersByTimeAsync(500)
    expect(JSON.stringify(ch.updated.filter(update => update.messageId === 'om_seg_1'))).toContain('子代理的结论')
    expect(JSON.stringify(ch.updated.filter(update => update.messageId === 'om_user'))).not.toContain('子代理的结论')

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    expect(hooksInstance.onTurnFinalized).toHaveBeenCalledWith('sess-host', 1, 'om_seg_1')
    // No Feishu trigger: the host turn swaps no reaction.
    expect(ch.addReaction).not.toHaveBeenCalled()

    // The queued message now runs as turn 2 and streams into its own card.
    expect(streamer.steerTargetOf('om_user')).toBeUndefined()
    frame(streamer, session, 2, '用户问题的回答')
    await vi.advanceTimersByTimeAsync(500)
    expect(JSON.stringify(ch.updated.filter(update => update.messageId === 'om_user').at(-1))).toContain('用户问题的回答')
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 2, reason: 'stop' } })
    await vi.waitFor(() => expect(ch.addReaction).toHaveBeenCalledWith('om_trigger', 'DONE'))
  })

  it('binds a turn to the Feishu card whose prompt follows injected next-step input in the same batch', async () => {
    const ch = channel()
    const hooksInstance = { ...hooks(), hostTurnOrigin: vi.fn(() => 'origin') }
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-batch')
    const feishu = prompt('m-feishu')
    streamer.attach(session, 'om_user', 'om_trigger', 'react-typing', { prompt: promptOf(feishu) })

    // DSH claims the workspace instructions (next-step) before the prompt.
    streamer.onInboxClaimed(session, prompt('instructions', 'agent-instructions'), 1)
    streamer.onInboxClaimed(session, feishu, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(hooksInstance.hostTurnOrigin).not.toHaveBeenCalled()
    expect(hooksInstance.sendSegmentCard).not.toHaveBeenCalled()

    frame(streamer, session, 1, '你好')
    await vi.advanceTimersByTimeAsync(500)
    expect(JSON.stringify(ch.updated.filter(update => update.messageId === 'om_user').at(-1))).toContain('你好')
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await vi.waitFor(() => expect(ch.addReaction).toHaveBeenCalledWith('om_trigger', 'DONE'))
  })

  it('tells a host-started running turn from one a channel prompt opened', async () => {
    const ch = channel()
    const streamer = new TurnStreamer(ch, 500, { ...hooks(), hostTurnOrigin: vi.fn(() => undefined) })
    const host = makeSession('sess-host-kind')
    const feishu = makeSession('sess-feishu-kind')
    expect(streamer.runsHostTurn('sess-host-kind')).toBe(false)
    streamer.onInboxClaimed(host, prompt('job-done', 'tool-jobs'), 1)
    expect(streamer.runsHostTurn('sess-host-kind')).toBe(true)
    // Still host-started once the turn rendered nowhere.
    await vi.advanceTimersByTimeAsync(0)
    expect(streamer.runsHostTurn('sess-host-kind')).toBe(true)
    streamer.onSessionEvent(host, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    expect(streamer.runsHostTurn('sess-host-kind')).toBe(false)

    const message = prompt('m-feishu-kind')
    streamer.attach(feishu, 'om_user', 'om_trigger', 'react-typing', { prompt: promptOf(message) })
    streamer.onInboxClaimed(feishu, message, 1)
    expect(streamer.runsHostTurn('sess-feishu-kind')).toBe(false)
  })

  it('takes a host card\'s origin from the batch\'s turn prompt, not injected next-step input', async () => {
    const ch = channel()
    const hooksInstance = { ...hooks(), hostTurnOrigin: vi.fn(() => 'origin') }
    const streamer = new TurnStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-batch-host')

    streamer.onInboxClaimed(session, prompt('instructions', 'agent-instructions'), 1)
    streamer.onInboxClaimed(session, prompt('job-done', 'tool-jobs'), 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(hooksInstance.hostTurnOrigin).toHaveBeenCalledTimes(1)
    expect(hooksInstance.hostTurnOrigin).toHaveBeenCalledWith('sess-batch-host', prompt('job-done', 'tool-jobs'))
    expect(hooksInstance.sendSegmentCard).toHaveBeenCalledTimes(1)
  })

  it('keeps output that arrived while a host card fell back to text', async () => {
    const ch = channel()
    let deliver: (() => void) | undefined
    const sendSegmentCard = vi.fn(async (_sessionId: string, segment: number, _card: object, fallbackText: string) => {
      if (segment === 1 && deliver === undefined) {
        await new Promise<void>(resolve => { deliver = resolve })
        return { messageId: 'om_text_1', mode: 'text' as const }
      }
      return { messageId: `om_seg_${segment}_${fallbackText.length}`, mode: 'card' as const }
    })
    const hooksInstance = { ...hooks(), sendSegmentCard, hostTurnOrigin: vi.fn(() => 'origin') }
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-fallback')

    streamer.hostTurn(session, prompt('job-done', 'tool-jobs'))
    await vi.advanceTimersByTimeAsync(0)
    frame(streamer, session, 1, '发送期间产生的回答')
    deliver!()
    await vi.advanceTimersByTimeAsync(500)

    expect(sendSegmentCard).toHaveBeenCalledTimes(2)
    expect(sendSegmentCard.mock.calls[0]![3]).toBe('')
    expect(JSON.stringify(sendSegmentCard.mock.calls[1]![2])).toContain('发送期间产生的回答')
  })

  it('renders a host turn nowhere when no origin is returned', async () => {
    const ch = channel()
    const hooksInstance = { ...hooks(), hostTurnOrigin: vi.fn(() => undefined) }
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const session = makeSession('sess-hidden')

    streamer.hostTurn(session, prompt('job-done', 'tool-jobs'))
    streamer.attach(session, 'om_user', 'om_trigger', undefined, { message: prompt('m-user') })
    expect(streamer.hasLiveTurn('sess-hidden')).toBe(true)
    // Steering needs a turn that renders somewhere.
    expect(streamer.mergeQueued('om_user', () => true)).toBe(false)

    frame(streamer, session, 1, '后台输出')
    await vi.advanceTimersByTimeAsync(500)
    expect(hooksInstance.sendSegmentCard).not.toHaveBeenCalled()
    expect(JSON.stringify(ch.updated)).not.toContain('后台输出')

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    frame(streamer, session, 2, '回答')
    await vi.advanceTimersByTimeAsync(500)
    expect(JSON.stringify(ch.updated.filter(update => update.messageId === 'om_user').at(-1))).toContain('回答')
  })

  it('ignores claims in subagent child sessions', () => {
    const ch = channel()
    const hooksInstance = { ...hooks(), hostTurnOrigin: vi.fn(() => 'origin') }
    const streamer = new DrivenStreamer(ch, 500, hooksInstance)
    const child = makeSession('sess-child')
    ;(child.header as { origin?: string }).origin = 'subagent'
    streamer.onInboxClaimed(child, prompt('task'), 1)
    expect(hooksInstance.hostTurnOrigin).not.toHaveBeenCalled()
    expect(streamer.hasLiveTurn('sess-child')).toBe(false)
  })
})

describe('TurnStreamer settle hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes the settled patch and the reaction swap through the settle hooks', async () => {
    const ch = channel()
    const settlePatch = vi.fn()
    const settleReaction = vi.fn()
    const streamer = new DrivenStreamer(ch, 500, { ...hooks(), settlePatch, settleReaction })
    const session = makeSession('sess-settle')
    streamer.attach(session, 'om_card', 'om_trigger', 'react-typing')
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } })
    await vi.advanceTimersByTimeAsync(500)
    const streamed = ch.updated.length
    expect(streamed).toBeGreaterThan(0)

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    expect(ch.updated.length).toBe(streamed)
    expect(settlePatch).toHaveBeenCalledWith('om_card', expect.any(Object))
    expect(headlineOf(settlePatch.mock.calls.at(-1)![1] as object)).toMatch(/^✅ /u)
    expect(settleReaction).toHaveBeenCalledWith('om_trigger', 'react-typing', 'DONE')
    expect(ch.addReaction).not.toHaveBeenCalled()
  })

  it('hands a segment that never landed to resendSegment once the turn settles', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    const resendSegment = vi.fn()
    const streamer = new DrivenStreamer(ch, 500, { ...hooksInstance, resendSegment })
    const session = makeSession('sess-resend')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    sendSegment.mockRejectedValue(new Error('send failed'))
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(resendSegment).not.toHaveBeenCalled()

    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)

    expect(resendSegment).toHaveBeenCalledTimes(1)
    const [sessionId, segment, card, text] = resendSegment.mock.calls[0]!
    expect(sessionId).toBe('sess-resend')
    expect(segment).toBe(2)
    expect(elementsOf(card as object).some(element => element.content?.includes('xxxx') === true)).toBe(true)
    expect(text as string).toMatch(/^x+$/u)
  })

  it('resends a segment whose last attempt fails after the turn settled', async () => {
    const ch = channel()
    const hooksInstance = hooks()
    const sendSegment = hooksInstance.sendSegmentCard as unknown as ReturnType<typeof vi.fn>
    const resendSegment = vi.fn()
    const streamer = new DrivenStreamer(ch, 500, { ...hooksInstance, resendSegment })
    const session = makeSession('sess-resend-late')
    streamer.attach(session, 'om_card', 'om_trigger', undefined)
    sendSegment.mockRejectedValue(new Error('send failed'))
    streamer.onAssistantFrame(session, { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 })
    streamer.onAssistantFrame(session, { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(30_000) } })
    await vi.advanceTimersByTimeAsync(500)
    streamer.onSessionEvent(session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'stop' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(resendSegment).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(resendSegment).toHaveBeenCalledTimes(1)
    expect(resendSegment.mock.calls[0]![1]).toBe(2)
  })
})
