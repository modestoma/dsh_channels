/**
 * Restart recovery helpers: turn classification from the Session log, the
 * stored prompt cap, and the recovered/interrupted card builders.
 */

import { describe, expect, it } from 'vitest'
import {
  buildInterruptionCard, buildRecoveredReplyCards, cardJsonBytes, CARD_MAX_BYTES, parseResumeAction, RESUME_ACTION,
} from '../src/cards.ts'
import type { MessageId, SessionEvent, TurnEndReason, UserMessage } from '../src/dsh-types.ts'
import { classifyTurn, storableMessage } from '../src/session/repair.ts'

function prompt(id: string, text = 'hi'): UserMessage {
  return { id: id as MessageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function reply(text: string, seq: number): SessionEvent {
  return { type: 'assistant/message', seq, data: { turn: 1, step: seq, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

describe('classifyTurn', () => {
  it('reports a prompt missing from the log as pending', () => {
    expect(classifyTurn([{ type: 'user/message', seq: 0, data: prompt('other') }], 'm1')).toEqual({ kind: 'pending' })
  })

  it('joins the reply text of a completed turn across steps', () => {
    const events: SessionEvent[] = [
      { type: 'user/message', seq: 0, data: prompt('m1') },
      reply('第一步', 1),
      reply('第二步', 2),
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      reply('下一轮', 4),
    ]
    expect(classifyTurn(events, 'm1')).toEqual({ kind: 'completed', text: '第一步\n\n第二步' })
  })

  it.each<[TurnEndReason]>([
    [{ kind: 'interrupted' }],
    [{ kind: 'error', error: { message: 'x', code: 'X' } }],
    [{ kind: 'aborted', reason: 'user' }],
    ['interrupted'],
  ])('treats turn/end %j as interrupted', (reason) => {
    const events: SessionEvent[] = [
      { type: 'user/message', seq: 0, data: prompt('m1') },
      { type: 'turn/end', seq: 1, data: { turn: 1, reason } },
    ]
    expect(classifyTurn(events, 'm1')).toEqual({ kind: 'interrupted' })
  })

  it('treats a turn without turn/end as interrupted', () => {
    expect(classifyTurn([{ type: 'user/message', seq: 0, data: prompt('m1') }, reply('半截', 1)], 'm1')).toEqual({ kind: 'interrupted' })
  })
})

describe('storableMessage', () => {
  it('keeps a prompt within the cap and drops a larger one', () => {
    expect(storableMessage(prompt('m1'))).toEqual({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(storableMessage(prompt('m2', 'x'.repeat(300 * 1024)))).toBeUndefined()
  })
})

describe('recovery cards', () => {
  it('spreads a long recovered reply over the existing cards and clips the rest', () => {
    const text = Array.from({ length: 400 }, (_, i) => `第 ${i} 段：${'内容'.repeat(60)}`).join('\n\n')
    const cards = buildRecoveredReplyCards(text, 2)
    expect(cards).toHaveLength(2)
    for (const card of cards) expect(cardJsonBytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES)
    expect(JSON.stringify(cards[0])).toContain('服务重启前已完成')
    expect(JSON.stringify(cards[1])).toContain('回复分段 2')
    expect(JSON.stringify(cards[1])).toContain('完整内容请在 dsh 客户端查看')
  })

  it('fills later cards with a placeholder when the reply fits the first', () => {
    const cards = buildRecoveredReplyCards('短回答', 3)
    expect(cards).toHaveLength(3)
    expect(JSON.stringify(cards[0])).toContain('短回答')
    expect(JSON.stringify(cards[2])).toContain('已合并到上一张卡片')
  })

  it('round-trips the continue button value', () => {
    const card = JSON.stringify(buildInterruptionCard({}, { sessionId: 's1', triggerMessageId: 'om_t' }))
    expect(card).toContain(RESUME_ACTION)
    expect(parseResumeAction({ decision: RESUME_ACTION, sessionId: 's1', trigger: 'om_t' })).toEqual({ sessionId: 's1', triggerMessageId: 'om_t' })
    expect(parseResumeAction({ decision: RESUME_ACTION, sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(parseResumeAction({ decision: 'turn-stop' })).toBeUndefined()
    // Continuation cards never carry the button.
    expect(JSON.stringify(buildInterruptionCard({ segment: 2 }, { sessionId: 's1' }))).not.toContain(RESUME_ACTION)
  })
})
