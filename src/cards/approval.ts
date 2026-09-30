/**
 * HITL approval decision cards (`approval/request`).
 *
 * @module dsh-channels/cards/approval
 */

import { columnSet, divider, markdown, note, standaloneCard, textButton } from './primitives.ts'

// ---- HITL approval decision cards ----------------------------------------

/** Terminal states an approval decision card can settle into. */
export type ApprovalCardState = 'allowed' | 'denied' | 'expired' | 'cancelled'

/** The question one approval decision card presents. */
export interface ApprovalQuestion {
  /** Opaque token binding the card to one pending approval (button value). */
  token: string
  /** Model-facing tool name asking for approval (e.g. `bash`). */
  toolName: string
  /** The asker's human-readable justification; clipped to a safe length. */
  reason?: string
  /** Timeout window shown on the card (milliseconds). */
  timeoutMs: number
  /** Session id trace line (omitted when absent). */
  sessionId?: string
}

/** Approval card rendering options. */
export interface ApprovalCardOptions {
  /** Add the owner-only notice (a non-owner clicked and was ignored). */
  unauthorizedNote?: boolean
}

/** Cap on the rendered reason so the card can never approach the size budget. */
const APPROVAL_REASON_MAX_CHARS = 1_000

/** `⏱ 5 分钟内有效…` — human timeout label (whole minutes, min 1). */
function approvalTimeoutLabel(timeoutMs: number): string {
  return `${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟`
}

/** One approval decision button with its callback payload. */
function approvalButton(question: ApprovalQuestion, decision: 'allow' | 'deny'): object {
  const allow = decision === 'allow'
  return textButton({
    label: allow ? '✅ 允许' : '❌ 拒绝',
    type: allow ? 'primary' : 'danger',
    width: 'fill',
    margin: '0px',
    value: { decision, token: question.token },
  })
}

/** Two-column row that keeps both decisions side by side. */
function approvalActions(question: ApprovalQuestion): object {
  return columnSet((['allow', 'deny'] as const).map(decision => approvalButton(question, decision)))
}

/** The question summary shared by the pending and settled variants. */
function approvalQuestionElements(question: ApprovalQuestion): object[] {
  const elements: object[] = [
    markdown(`工具 \`${question.toolName}\` 请求执行一个需要授权的操作。`),
  ]
  if (question.reason !== undefined && question.reason !== '') {
    const clipped = question.reason.length > APPROVAL_REASON_MAX_CHARS
      ? `${question.reason.slice(0, APPROVAL_REASON_MAX_CHARS)}…`
      : question.reason
    elements.push(markdown(`> ${clipped.replace(/\s+/gu, ' ')}`))
  }
  return elements
}

/**
 * The pending approval decision card: question summary, timeout note, and the
 * enabled allow/deny buttons. Sent as a NEW standalone message anchored to
 * the session's latest streaming card (never embedded into the streamed
 * card, whose full-replacement patches would clobber the buttons).
 */
export function buildApprovalCard(question: ApprovalQuestion, options: ApprovalCardOptions = {}): object {
  const elements: object[] = [
    ...approvalQuestionElements(question),
    divider(),
    note(`⏱ ${approvalTimeoutLabel(question.timeoutMs)}内有效，超时自动拒绝 · 允许仅对本次动作生效`),
  ]
  if (options.unauthorizedNote === true) {
    elements.push(note('ℹ️ 仅发起该会话的用户可操作此卡片'))
  }
  if (question.sessionId !== undefined) {
    elements.push(note(`🔑 ${question.sessionId}`))
  }
  elements.push(approvalActions(question))
  return standaloneCard('**⚠️ 需要你的审批**', elements)
}

/** Settled-card status lines, one per terminal state. */
const APPROVAL_SETTLED_LINES: Record<ApprovalCardState, string> = {
  allowed: '✅ 已允许执行',
  denied: '❌ 已拒绝',
  expired: '⏱ 已超时未处理，自动拒绝',
  cancelled: '↩️ 请求已取消',
}

/**
 * The terminal replacement for a decision card after the question settles
 * (decision, timeout, or withdrawal). Keeps the question summary for context
 * and removes the decision controls entirely.
 */
export function buildApprovalSettledCard(question: ApprovalQuestion, state: ApprovalCardState): object {
  return standaloneCard(`**${APPROVAL_SETTLED_LINES[state]}**`, [
    ...approvalQuestionElements(question),
    divider(),
  ])
}

