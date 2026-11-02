/**
 * HITL approval decision cards (`approval/request`).
 *
 * @module dsh-channels/cards/approval
 */

import { columnSet, divider, foldPanelOf, markdown, note, plainText, standaloneCard, textButton } from './primitives.ts'
import { PANEL_CHEVRON_TOKEN } from './streaming.ts'

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
  /**
   * What the asker says the call will do; clipped to a safe length. Rendered
   * line by line as the card's main content: `标签：value` (or `Label: value`)
   * lines become label/value rows, indented lines a list under them.
   */
  reason?: string
  /** The shell command the call will run (tools with a string `command` argument). */
  command?: string
  /**
   * The call's other arguments as `name: value` lines (or the raw text when
   * they are not a JSON object). Folded away when `reason` or `command`
   * already says what will happen.
   */
  arguments?: string
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

/** Caps on the rendered reason so the card can never approach the size budget. */
const APPROVAL_REASON_MAX_CHARS = 4_000
const APPROVAL_REASON_MAX_LINES = 30

/** Cap on the rendered arguments text. */
const APPROVAL_ARGUMENTS_MAX_CHARS = 4_000

/** A `label：value` reason line: a short label without spaces, then a full-width colon or `: `. */
const LABEL_LINE = /^([^\s:：]{1,16})(?:：|: )(.*)$/u

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

/** One label/value row of the reason: grey label, wrapping value. */
function labelRow(label: string, value: string): object {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    margin: '0px',
    columns: [
      { tag: 'column', width: 'auto', elements: [plainText(label, { color: 'grey' })] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [plainText(value)] },
    ],
  }
}

/**
 * The reason, line by line: plain lines as text, `label：value` lines as
 * label/value rows, and runs of indented lines as one list block. Nothing is
 * read as markdown, so paths and identifiers show exactly as given.
 */
function reasonElements(reason: string): object[] {
  const clipped = clip(reason, APPROVAL_REASON_MAX_CHARS)
  const lines = clipped.shown.split('\n')
  const shown = lines.slice(0, APPROVAL_REASON_MAX_LINES)
  const elements: object[] = []
  let indented: string[] = []
  const flush = (): void => {
    if (indented.length > 0) elements.push(plainText(indented.join('\n')))
    indented = []
  }
  for (const line of shown) {
    if (line.trim() === '') continue
    if (/^\s/u.test(line)) {
      indented.push(`· ${line.trim()}`)
      continue
    }
    flush()
    const label = LABEL_LINE.exec(line)
    elements.push(label === null ? plainText(line) : labelRow(label[1]!, label[2]!))
  }
  flush()
  const hiddenLines = lines.length - shown.length
  if (hiddenLines > 0 || clipped.hidden > 0) {
    elements.push(note(hiddenLines > 0 ? `另有 ${hiddenLines} 行未显示` : `已截断 ${clipped.hidden} 个字符`))
  }
  return elements
}

/** The question summary shared by the pending and settled variants. */
function approvalQuestionElements(question: ApprovalQuestion): object[] {
  const elements: object[] = []
  const hasReason = question.reason !== undefined && question.reason.trim() !== ''
  const hasCommand = question.command !== undefined && question.command !== ''
  if (question.escalateTo !== undefined) {
    elements.push(markdown(`工具 \`${question.toolName}\` 请求把本次调用提升到 \`${question.escalateTo}\` 权限。`))
  } else if (!hasReason && !hasCommand) {
    elements.push(markdown(`工具 \`${question.toolName}\` 请求执行一个需要授权的操作。`))
  }
  if (hasReason) elements.push(...reasonElements(question.reason!))
  if (hasCommand) {
    const command = clip(question.command!, APPROVAL_COMMAND_MAX_CHARS)
    elements.push(markdown(`**将执行**\n\`\`\`\n${command.shown.replace(/```/gu, '`\u200b``')}\n\`\`\``))
    if (command.hidden > 0) elements.push(note(`已截断 ${command.hidden} 个字符`))
  }
  if (question.arguments !== undefined && question.arguments !== '') {
    const args = clip(question.arguments, APPROVAL_ARGUMENTS_MAX_CHARS)
    const body = [plainText(args.shown, { size: 'notation' })]
    if (args.hidden > 0) body.push(note(`已截断 ${args.hidden} 个字符`))
    // The arguments are the only description when nothing else says what will happen.
    if (hasReason || hasCommand) elements.push(foldPanelOf('调用参数', body, PANEL_CHEVRON_TOKEN))
    else elements.push(markdown('**调用参数**'), ...body)
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
  return standaloneCard(`**⚠️ 需要你的审批 · \`${question.toolName}\`**`, elements)
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
  return standaloneCard(`**${APPROVAL_SETTLED_LINES[state]} · \`${question.toolName}\`**`, elements)
}
