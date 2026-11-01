/**
 * Access-control cards: the bot-added group information card, the
 * administrator's user authorization request card, and its terminal state.
 *
 * The request cards carry an opaque token in the button callback value; the
 * token is resolved server-side against the durable request table, so a card
 * can never grant anything by itself (see `docs/access-control-design.md`
 * §5.7/§5.8).
 *
 * @module dsh-channels/access/cards
 */

import { columnSet, divider, markdown, note, standaloneCard, textButton } from '../cards/primitives.ts'

/** Terminal status of one settled authorization request. */
export type SettledRequestStatus = 'approved' | 'denied' | 'expired'

/** Inputs of the group-information card sent to the administrator. */
export interface GroupInfoCardInput {
  /** Feishu `chat_id` of the group the bot was added to (or was seen in). */
  chatId: string
  /** Group name, when `getChatInfo()` could read it. */
  name?: string
  /** Member count, when available. */
  memberCount?: number
  /** Group owner `open_id`, when available. */
  ownerId?: string
  /** `user_id` of whoever invited the bot. */
  inviterUserId?: string
  /** Whether the inviter may talk to the bot (administrator or `chat` switch on). */
  inviterMayChat: boolean
  /** Render timestamp (defaults to now). */
  now?: number
}

/** Inputs of the user-authorization request card sent to the administrator. */
export interface UserRequestCardInput {
  /** `user_id` of the user asking for access. */
  userId: string
  /** Display name of that user, when known. */
  name?: string
  /** Chat the request originated from. */
  chatId?: string
  /** Name of that group, when known. */
  groupName?: string
  /** What made the user ask: @-mentioning the bot, or adding it to the group. */
  trigger: 'mention' | 'invite'
  /** Opaque request token. */
  token: string
  /** Render timestamp (defaults to now). */
  now?: number
}

/** Inputs of the terminal replacement card. */
export interface RequestSettledCardInput {
  /** `user_id` the request targeted. */
  targetId: string
  /** Human-readable target name, when known. */
  targetName?: string
  /** Settled state; pending requests never use this card. */
  status: SettledRequestStatus
  /** Render timestamp (defaults to now). */
  now?: number
}

/** Truncate one display string so the card stays far below the size budget. */
function clip(value: string, max = 120): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** Render one epoch-ms instant as a stable UTC `YYYY-MM-DD HH:mm` string. */
function formatTime(timestamp?: number): string {
  const value = timestamp ?? Date.now()
  if (!Number.isFinite(value)) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`
}

/** Two side-by-side decision buttons carrying the opaque request token. */
function decisionButtons(token: string, allowLabel: string, denyLabel: string): object {
  return columnSet([
    textButton({
      label: allowLabel,
      type: 'primary',
      width: 'fill',
      margin: '0px',
      value: { token, action: 'allow' },
    }),
    textButton({
      label: denyLabel,
      type: 'danger',
      width: 'fill',
      margin: '0px',
      value: { token, action: 'deny' },
    }),
  ])
}

/** `**字段**：值` line used across both request cards. */
function field(label: string, value: string): object {
  return markdown(`**${label}**：${value}`)
}

/**
 * The group-information card the administrator receives when the bot joins a
 * group. It carries no buttons: a group needs no grant, and an inviter
 * without the conversation permission gets a user request card instead.
 */
export function buildGroupInfoCard(input: GroupInfoCardInput): object {
  const name = input.name === undefined ? undefined : clip(input.name)
  const elements: object[] = []
  elements.push(field('群名', name === undefined || name === '' ? '（未知）' : name))
  elements.push(field('群 ID', `\`${input.chatId}\``))
  if (input.memberCount !== undefined) elements.push(field('成员数', String(input.memberCount)))
  if (input.ownerId !== undefined && input.ownerId !== '') {
    elements.push(field('群主', `\`${input.ownerId}\``))
  }
  if (input.inviterUserId !== undefined && input.inviterUserId !== '') {
    elements.push(field('邀请人', `\`${input.inviterUserId}\``))
  }
  elements.push(field('加入时间', formatTime(input.now)))
  elements.push(divider())
  elements.push(note(input.inviterMayChat
    ? '群里只有打开了对话准入的用户能与我对话，其他成员 @ 我不会得到回复。'
    : '邀请人没有对话权限；群里只有打开了对话准入的用户能与我对话。'))
  return standaloneCard('**📋 群信息**', elements)
}

/**
 * The user authorization request card: a user without the conversation
 * permission mentioned the bot in a group or added it to one, so the
 * administrator can add that `user_id` to the user table from the DM card.
 */
export function buildUserRequestCard(input: UserRequestCardInput): object {
  const display = clip(input.name ?? '')
  const groupName = input.groupName === undefined ? undefined : clip(input.groupName)
  const elements: object[] = [
    field('用户', display === '' ? '（未知昵称）' : display),
    field('user_id', `\`${input.userId}\``),
  ]
  const groupLabel = input.trigger === 'invite' ? '把我拉进了群' : '所在群'
  if (groupName !== undefined && groupName !== '') {
    const group = input.chatId === undefined ? groupName : `${groupName}（\`${input.chatId}\`）`
    elements.push(field(groupLabel, group))
  } else if (input.chatId !== undefined && input.chatId !== '') {
    elements.push(field(groupLabel, `\`${input.chatId}\``))
  }
  elements.push(field('申请时间', formatTime(input.now)))
  elements.push(divider())
  elements.push(note('授权后该用户进入用户表并打开对话准入：可以私聊，也可以在任何群里 @ 我。知识库与代码改动权限默认关闭，可在 Web 设置面板或用 /auth 打开。'))
  elements.push(decisionButtons(input.token, '授权用户', '忽略'))
  return standaloneCard('**🙋 用户授权申请**', elements)
}

/** Title/description pairs for the three settled states. */
const SETTLED_PRESENTATION: Record<SettledRequestStatus, { title: string; line: string }> = {
  approved: { title: '✅ 已授权', line: '授权已生效。' },
  denied: { title: '❌ 已忽略', line: '本次申请已被忽略。' },
  expired: { title: '⏱ 已过期', line: '申请超过有效期，已自动失效。' },
}

/**
 * The terminal replacement for a request card (decision or expiry). Carries
 * no buttons: the request token can settle exactly once.
 */
export function buildRequestSettledCard(input: RequestSettledCardInput): object {
  const presentation = SETTLED_PRESENTATION[input.status]
  const name = input.targetName === undefined ? undefined : clip(input.targetName)
  const target = name === undefined || name === '' ? `\`${input.targetId}\`` : `${name}（\`${input.targetId}\`）`
  const elements: object[] = [
    field('用户', target),
    field('处理时间', formatTime(input.now)),
    note(presentation.line),
  ]
  return standaloneCard(`**${presentation.title}**`, elements)
}
