/**
 * Wiki (知识库) authorization cards: the topic owner's consent before the
 * model opens, creates, or edits a wiki document.
 *
 * @module dsh-channels/cards/wiki
 */

import { columnSet, divider, markdown, note, standaloneCard, textButton } from './primitives.ts'

/** What one wiki consent covers. */
export type WikiConsentAction = 'read' | 'create' | 'edit'

/** Terminal states of a wiki consent card. */
export type WikiConsentCardState = 'allowed' | 'denied' | 'expired' | 'cancelled'

/** The question one wiki consent card presents. */
export interface WikiConsentQuestion {
  /** Opaque token binding the card to one pending consent (button value). */
  readonly token: string
  readonly action: WikiConsentAction
  /** Document title (create: the new title). */
  readonly title: string
  /** Document link (read/edit) or parent link (create), when known. */
  readonly url?: string
  /** Where the document lives or will live, e.g. `空间名 / 父节点`. */
  readonly location: string
  /** Extra lines: operations of an edit, the content preview of a create. */
  readonly details: readonly string[]
  /** Timeout window shown on the card (milliseconds). */
  readonly timeoutMs: number
}

/** Card rendering options. */
export interface WikiConsentCardOptions {
  /** Add the owner-only notice (someone else clicked and was ignored). */
  readonly unauthorizedNote?: boolean
}

/** Cap on one rendered detail block so the card stays readable on a phone. */
const DETAIL_MAX_CHARS = 800

const ACTION_LABELS: Readonly<Record<WikiConsentAction, string>> = {
  read: '读取文档',
  create: '新建文档',
  edit: '修改文档',
}

const SETTLED_LINES: Readonly<Record<WikiConsentCardState, string>> = {
  allowed: '✅ 已允许',
  denied: '❌ 已拒绝',
  expired: '⏱ 已超时未处理，自动拒绝',
  cancelled: '↩️ 请求已取消',
}

/** Clip one value to `max` characters, marking the cut. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…（已截断 ${value.length - max} 个字符）`
}

/** One line of Markdown text with link/markup characters neutralized. */
function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/([[\]()*_`~<>])/gu, '\\$1').trim()
}

/** The question summary shared by the pending and settled variants. */
function questionElements(question: WikiConsentQuestion): object[] {
  const title = question.title === '' ? '（无标题）' : plain(question.title)
  const titleLine = question.url === undefined || question.action === 'create'
    ? title
    : `[${title}](${question.url})`
  const elements: object[] = [
    markdown([
      `机器人请求以应用身份**${ACTION_LABELS[question.action]}**。`,
      `**文档**：${titleLine}`,
      `**位置**：${plain(question.location)}`,
    ].join('\n')),
  ]
  for (const detail of question.details) {
    elements.push(markdown(clip(detail, DETAIL_MAX_CHARS)))
  }
  return elements
}

function consentButton(question: WikiConsentQuestion, decision: 'allow' | 'deny'): object {
  return textButton({
    label: decision === 'allow' ? '✅ 允许' : '❌ 拒绝',
    type: decision === 'allow' ? 'primary' : 'danger',
    width: 'fill',
    value: { decision, token: question.token },
  })
}

/**
 * The pending consent card, sent as a reply in the session's topic.
 *
 * @param question The consent asked for.
 * @param options Rendering options.
 * @returns Card JSON 2.0.
 */
export function buildWikiConsentCard(question: WikiConsentQuestion, options: WikiConsentCardOptions = {}): object {
  const minutes = Math.max(1, Math.round(question.timeoutMs / 60_000))
  const scope = question.action === 'read'
    ? '允许后，本话题内再次读取这篇文档不再询问'
    : '仅对这一次操作生效'
  const elements: object[] = [
    ...questionElements(question),
    divider(),
    note(`⏱ ${minutes} 分钟内有效，超时自动拒绝 · ${scope}`),
  ]
  if (options.unauthorizedNote === true) elements.push(note('ℹ️ 仅发起该话题的用户可操作此卡片'))
  elements.push(columnSet([consentButton(question, 'allow'), consentButton(question, 'deny')]))
  return standaloneCard('**📚 知识库授权**', elements)
}

/**
 * The terminal replacement after the consent settles; no controls.
 *
 * @param question The consent that was asked for.
 * @param state How it settled.
 * @returns Card JSON 2.0.
 */
export function buildWikiConsentSettledCard(question: WikiConsentQuestion, state: WikiConsentCardState): object {
  return standaloneCard(`**${SETTLED_LINES[state]}**`, [...questionElements(question), divider(), note(`📚 知识库${ACTION_LABELS[question.action]}`)])
}
