/**
 * Non-blocking follow-up action proposal cards (Feishu Card JSON 2.0).
 *
 * Displays `prompt` and any selected action labels strictly as `plain_text` so
 * untrusted caller or model text cannot inject Feishu Markdown or `@all`
 * mentions. Remaining `pending` actions render as callback buttons followed by
 * an automatic trailing grey (`default`) `'暂不处理'` button; terminal states
 * (`superseded`, `dismissed`, `expired`, `unbound`) retire the buttons while
 * keeping any previously triggered selections visible. A permission-denial
 * `notice` renders non-destructively at the bottom while leaving the `pending`
 * buttons clickable.
 *
 * @module dsh-channels/cards/action-proposal
 */

import { RESERVED_DISMISS_ACTION_ID } from '../actions/contract.ts'
import type { ActionProposalRecord, ActionProposalStoredItem } from '../actions/store.ts'
import { divider, note, plainText, standaloneCard, textButton } from './primitives.ts'

/** Callback discriminator carried by every button on an action proposal card. */
export const ACTION_PROPOSAL_DECISION = 'action-proposal' as const

/** Callback payload returned by Feishu `card.action.trigger` on a proposal button. */
export interface ActionProposalClick {
  readonly decision: typeof ACTION_PROPOSAL_DECISION
  readonly proposalId: string
  readonly actionId: string
}

/** Reason an otherwise-pending proposal card can no longer wake its Session. */
export type ActionProposalInvalidation = 'expired' | 'unbound'

/** Optional transient or invalidation modifiers when rendering a proposal card. */
export interface ActionProposalCardOptions {
  /** Retire all buttons because the 14-day TTL elapsed or the route changed Session. */
  readonly invalidation?: ActionProposalInvalidation
  /** Non-destructive bottom hint (e.g. insufficient permission); keeps pending buttons active. */
  readonly notice?: string
}

/** Minimal input required to render an action proposal card. */
export interface ActionProposalCardInput {
  readonly proposalId: string
  readonly sessionId: string
  readonly prompt: string
  readonly actions: readonly ActionProposalStoredItem[]
  readonly supersededReason?: string
}

/** Build the Card JSON 2.0 payload for an {@link ActionProposalRecord}. */
export function buildActionProposalCard(
  proposal: ActionProposalCardInput | ActionProposalRecord,
  options: ActionProposalCardOptions = {},
): object {
  const elements: object[] = [plainText(proposal.prompt)]

  const triggered = proposal.actions.filter(item => item.status === 'triggered')
  for (const item of triggered) {
    elements.push(plainText(`✅ 已选择：${item.label}`, { size: 'notation' }))
  }

  const pending = proposal.actions.filter(item => item.status === 'pending')
  const superseded = proposal.actions.some(item => item.status === 'superseded')

  if (options.invalidation === 'expired') {
    elements.push(plainText('该提议已过期，请直接在话题中输入指令', { size: 'notation', color: 'grey' }))
  } else if (options.invalidation === 'unbound') {
    elements.push(plainText('该话题已切换新会话或已结束，此动作提议已失效', { size: 'notation', color: 'grey' }))
  } else if (pending.length > 0) {
    for (const item of pending) {
      elements.push(textButton({
        label: item.label,
        type: item.style === 'primary' ? 'primary' : 'default',
        value: {
          decision: ACTION_PROPOSAL_DECISION,
          proposalId: proposal.proposalId,
          actionId: item.id,
        } satisfies ActionProposalClick,
      }))
    }
    elements.push(textButton({
      label: '暂不处理',
      type: 'default',
      value: {
        decision: ACTION_PROPOSAL_DECISION,
        proposalId: proposal.proposalId,
        actionId: RESERVED_DISMISS_ACTION_ID,
      } satisfies ActionProposalClick,
    }))
    const notice = options.notice?.trim()
    if (notice !== undefined && notice !== '') {
      elements.push(plainText(`⚠️ ${notice}`, { size: 'notation', color: 'grey' }))
    }
  } else if (superseded) {
    const reason = proposal.supersededReason?.trim()
    const text = reason !== undefined && reason !== ''
      ? `已被后续新提议替代：${reason}`
      : '已被后续新提议替代'
    elements.push(plainText(text, { size: 'notation', color: 'grey' }))
  } else if (triggered.length === 0) {
    elements.push(plainText('已暂不处理', { size: 'notation', color: 'grey' }))
  }

  elements.push(divider())
  elements.push(note(`🔑 ${proposal.sessionId}`))
  return standaloneCard('**💡 后续可选动作**', elements)
}

/** Fallback card shown when a click arrives after the durable record was pruned by GC (>14 days). */
export function buildPrunedActionProposalCard(): object {
  return standaloneCard('**💡 后续可选动作**', [
    plainText('该提议已过期，请直接在话题中输入指令', { size: 'notation', color: 'grey' }),
  ])
}

/** Parse a `card.action.trigger` value into an {@link ActionProposalClick}, or `undefined`. */
export function parseActionProposalClick(value: unknown): ActionProposalClick | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.decision !== ACTION_PROPOSAL_DECISION) return undefined
  const { proposalId, actionId } = record
  if (typeof proposalId !== 'string' || proposalId === '') return undefined
  if (typeof actionId !== 'string' || actionId === '') return undefined
  return { decision: ACTION_PROPOSAL_DECISION, proposalId, actionId }
}
