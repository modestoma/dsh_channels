/**
 * HITL approval decision cards (`approval/request`).
 *
 * @module dsh-channels/cards/approval
 */

import { columnSet, divider, markdown, note, standaloneCard, textButton } from './primitives.ts'

// ---- HITL approval decision cards ----------------------------------------

/**
 * Terminal states an approval decision card can settle into. `allowed-text`
 * and `denied-text` are decisions typed as a topic reply; `remembered` is the
 * "stop asking in this topic" decision; `superseded` is a non-keyword reply
 * that rejected the request and was queued as the next instruction.
 */
export type ApprovalCardState =
  | 'allowed'
  | 'allowed-text'
  | 'remembered'
  | 'denied'
  | 'denied-text'
  | 'superseded'
  | 'expired'
  | 'cancelled'

/** The question one approval decision card presents. */
export interface ApprovalQuestion {
  /** Opaque token binding the card to one pending approval (button value). */
  token: string
  /** Model-facing tool name asking for approval (e.g. `bash`). */
  toolName: string
  /** The asker's human-readable justification; clipped to a safe length. */
  reason?: string
  /** What the call will run: the bash command or the raw arguments JSON. */
  command?: string
  /** The sandbox mode the call asks to be raised to, when it asks. */
  escalateTo?: string
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

/** Cap on the rendered command so the card stays readable on a phone. */
const APPROVAL_COMMAND_MAX_CHARS = 600

/** Cap on the rendered reason so the card can never approach the size budget. */
const APPROVAL_REASON_MAX_CHARS = 1_000

/** The sandbox mode whose standing grant removes all confinement. */
const UNCONFINED_MODE = 'danger-full-access'

/** `⏱ 5 分钟内有效…` — human timeout label (whole minutes, min 1). */
function approvalTimeoutLabel(timeoutMs: number): string {
  return `${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟`
}

/** Clip to `max` chars and report how many were dropped. */
function clip(value: string, max: number): { shown: string; hidden: number } {
  return value.length <= max
    ? { shown: value, hidden: 0 }
    : { shown: value.slice(0, max), hidden: value.length - max }
}

/**
 * What a "stop asking in this topic" grant covers, as the card states it:
 * `bash 提升到 workspace-write` or the bare tool name.
 * @param question - the question whose grant scope is described.
 * @returns The scope phrase.
 */
export function approvalGrantScope(question: Pick<ApprovalQuestion, 'toolName' | 'escalateTo'>): string {
  return question.escalateTo === undefined
    ? `\`${question.toolName}\``
    : `\`${question.toolName}\` 提升到 \`${question.escalateTo}\``
}

type ApprovalDecision = 'allow' | 'always' | 'deny'

/** One approval decision button with its callback payload. */
function approvalButton(question: ApprovalQuestion, decision: ApprovalDecision): object {
  const label = decision === 'allow' ? '✅ 允许' : decision === 'always' ? '♾️ 本话题不再询问' : '❌ 拒绝'
  const type = decision === 'allow'
    ? 'primary'
    : decision === 'always'
      ? (question.escalateTo === UNCONFINED_MODE ? 'danger' : 'default')
      : 'danger'
  return textButton({
    label,
    type,
    width: 'fill',
    margin: decision === 'always' ? '8px 0 0 0' : '0px',
    value: { decision, token: question.token },
  })
}

/**
 * The decision controls: allow and deny side by side, then the full-width
 * "stop asking in this topic" button with the grant's scope under it.
 */
function approvalActions(question: ApprovalQuestion): object[] {
  const scope = question.escalateTo === UNCONFINED_MODE
    ? `之后本话题内 ${approvalGrantScope(question)} 都自动允许，等于完全不受沙箱限制`
    : `之后本话题内 ${approvalGrantScope(question)} 都自动允许`
  return [
    columnSet((['allow', 'deny'] as const).map(decision => approvalButton(question, decision))),
    approvalButton(question, 'always'),
    note(`♾️ ${scope}；/renew 或重启后恢复询问`),
  ]
}

/** The question summary shared by the pending and settled variants. */
function approvalQuestionElements(question: ApprovalQuestion): object[] {
  const elements: object[] = [
    markdown(question.escalateTo === undefined
      ? `工具 \`${question.toolName}\` 请求执行一个需要授权的操作。`
      : `工具 \`${question.toolName}\` 请求把本次调用提升到 \`${question.escalateTo}\` 权限。`),
  ]
  if (question.command !== undefined && question.command !== '') {
    const command = clip(question.command, APPROVAL_COMMAND_MAX_CHARS)
    elements.push(markdown(`**将执行**\n\`\`\`\n${command.shown.replace(/```/gu, '`​``')}\n\`\`\``))
    if (command.hidden > 0) elements.push(note(`已截断 ${command.hidden} 个字符`))
  }
  if (question.reason !== undefined && question.reason !== '') {
    const reason = clip(question.reason, APPROVAL_REASON_MAX_CHARS)
    elements.push(markdown(`> ${reason.shown.replace(/\s+/gu, ' ')}${reason.hidden > 0 ? '…' : ''}`))
  }
  return elements
}

/**
 * The pending approval decision card: question summary (with the command
 * when known), how to answer, and the enabled decision buttons. Sent as a NEW
 * standalone message anchored to the session's latest streaming card (never
 * embedded into the streamed card, whose full-replacement patches would
 * clobber the buttons).
 */
export function buildApprovalCard(question: ApprovalQuestion, options: ApprovalCardOptions = {}): object {
  const elements: object[] = [
    ...approvalQuestionElements(question),
    divider(),
    note(`⏱ ${approvalTimeoutLabel(question.timeoutMs)}内有效，超时自动拒绝 · 「允许」仅对本次生效`),
    note('💬 也可直接回复「允许」「拒绝」「全部允许」；回复其他内容视为拒绝，并作为下一条指令'),
  ]
  if (options.unauthorizedNote === true) {
    elements.push(note('ℹ️ 仅发起该会话的用户可操作此卡片'))
  }
  if (question.sessionId !== undefined) {
    elements.push(note(`🔑 ${question.sessionId}`))
  }
  elements.push(...approvalActions(question))
  return standaloneCard('**⚠️ 需要你的审批**', elements)
}

/** Settled-card status lines, one per terminal state. */
const APPROVAL_SETTLED_LINES: Record<ApprovalCardState, string> = {
  allowed: '✅ 已允许执行',
  'allowed-text': '✅ 已允许执行（文字回复）',
  remembered: '♾️ 已允许，本话题不再询问',
  denied: '❌ 已拒绝',
  'denied-text': '❌ 已拒绝（文字回复）',
  superseded: '❌ 已拒绝，你的新消息将作为下一条指令',
  expired: '⏱ 已超时未处理，自动拒绝',
  cancelled: '↩️ 请求已取消',
}

/**
 * The terminal replacement for a decision card after the question settles
 * (decision, timeout, or withdrawal). Keeps the question summary for context
 * and removes the decision controls entirely.
 */
export function buildApprovalSettledCard(question: ApprovalQuestion, state: ApprovalCardState): object {
  const elements = [...approvalQuestionElements(question), divider()]
  if (state === 'remembered') {
    elements.push(note(`本话题内 ${approvalGrantScope(question)} 将自动允许；/renew 或重启后恢复询问`))
  }
  return standaloneCard(`**${APPROVAL_SETTLED_LINES[state]}**`, elements)
}
