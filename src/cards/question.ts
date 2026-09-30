/**
 * Structured user-question cards (`user-questions/request`).
 *
 * @module dsh-channels/cards/question
 */

import { card, divider, markdown, note, standaloneCard, textButton } from './primitives.ts'

// ---- structured user-question cards --------------------------------------

/** Terminal states a user-question card can settle into. */
export type QuestionCardState = 'answered' | 'expired' | 'cancelled'

/** One question as rendered (options are always present after normalization). */
export interface QuestionCardItem {
  id: string
  question: string
  detail?: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  /** `plan-review` intent's approve label (presentation only). */
  intentApproved?: string
}

/** One pending question card's render input. */
export interface QuestionCardInput {
  /** Opaque token binding the card to one pending question set. */
  token: string
  questions: QuestionCardItem[]
  timeoutMs: number
  sessionId?: string
  /** Multi-select toggles accumulated so far, by question id. */
  selected?: Record<string, string[]>
  /** Question ids already answered (single-select picks). */
  answered?: readonly string[]
  /** Add the owner-only notice (a non-owner clicked and was ignored). */
  unauthorizedNote?: boolean
}

/** Cap on rendered strings so one question cannot approach the card budget. */
const QUESTION_TEXT_MAX_CHARS = 500
/** Cap on rendered options per question (excess is reported, not dropped silently). */
export const MAX_QUESTION_OPTIONS = 8

function clipQuestionText(text: string, max = QUESTION_TEXT_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function questionAnswered(input: QuestionCardInput, id: string): boolean {
  return (input.answered ?? []).includes(id)
}

function questionOptionButton(
  input: QuestionCardInput,
  question: QuestionCardItem,
  option: { label: string; description?: string },
): object {
  const isMulti = question.multiSelect
  const selected = (input.selected?.[question.id] ?? []).includes(option.label)
  const approved = question.intentApproved === option.label
  const answered = questionAnswered(input, question.id)
  const type = isMulti
    ? (selected ? 'primary' : 'default')
    : (approved ? 'primary' : 'default')
  const label = isMulti && selected ? `✅ ${option.label}` : option.label
  return textButton({
    label: clipQuestionText(label, 80),
    type: answered ? 'default' : type,
    width: 'fill',
    disabled: answered,
    value: {
      decision: isMulti ? 'question-toggle' : 'question-answer',
      token: input.token,
      id: question.id,
      value: option.label,
    },
  })
}

function questionElements(input: QuestionCardInput): object[] {
  const elements: object[] = [markdown('**❓ 需要你的回答**')]
  input.questions.forEach((question, index) => {
    const heading = question.header === undefined || question.header === ''
      ? `**问题 ${index + 1}**`
      : `**问题 ${index + 1} · ${clipQuestionText(question.header, 80)}**`
    elements.push(markdown(`${heading}\n${clipQuestionText(question.question)}`))
    if (question.detail !== undefined && question.detail !== '') {
      elements.push(markdown(`> ${clipQuestionText(question.detail, 1_200).replace(/\s+/gu, ' ')}`))
    }
    const options = question.options.slice(0, MAX_QUESTION_OPTIONS)
    for (const option of options) {
      elements.push(questionOptionButton(input, question, option))
    }
    if (question.options.length === 0) {
      elements.push(note('本题没有预设选项，请直接回复文字作答。'))
    } else if (question.options.length > options.length) {
      elements.push(note(`另有 ${question.options.length - options.length} 个选项未展示，请在 Web 端回答。`))
    }
    if (question.multiSelect) {
      const selected = input.selected?.[question.id] ?? []
      if (selected.length > 0 && !questionAnswered(input, question.id)) {
        elements.push(textButton({
          label: '提交本题选择',
          type: 'primary',
          value: { decision: 'question-submit', token: input.token, id: question.id },
        }))
      }
      elements.push(note(`本题为多选：点选后请点“提交本题选择”（已选 ${selected.length} 项）。`))
    }
  })
  elements.push(divider())
  elements.push(note(`⏱ ${Math.max(1, Math.round(input.timeoutMs / 60_000))} 分钟内有效，超时后本轮提问失败 · 仅发起该会话的用户可操作 · 也可直接回复文字作答`))
  if (input.sessionId !== undefined) elements.push(note(`🔑 ${input.sessionId}`))
  if (input.unauthorizedNote === true) elements.push(note('ℹ️ 仅发起该会话的用户可操作此卡片'))
  return elements
}

/** The pending structured-question card (one card carries every question). */
export function buildQuestionCard(input: QuestionCardInput): object {
  return card(questionElements(input))
}

const QUESTION_SETTLED_LINES: Record<QuestionCardState, string> = {
  answered: '✅ 已回答',
  expired: '⏱ 已超时未处理，本轮提问已失败',
  cancelled: '↩️ 提问已取消',
}

/** The terminal replacement after the question set settles; controls removed. */
export function buildQuestionSettledCard(input: QuestionCardInput, state: QuestionCardState): object {
  const elements: object[] = [
    ...input.questions.slice(0, 4).map((question, index) =>
      markdown(`**问题 ${index + 1}**：${clipQuestionText(question.question, 200)}`)),
    divider(),
  ]
  if (state === 'expired') {
    elements.push(note('提问窗口已关闭。可在下一条消息中要求模型重新提问。'))
  }
  return standaloneCard(`**${QUESTION_SETTLED_LINES[state]}**`, elements)
}
