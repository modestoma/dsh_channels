/**
 * Target resolution for `/auth user add|remove`: the administrator names the
 * user either by a pasted `user_id` or by @-mentioning them in the command.
 *
 * Feishu replaces each mention in the text with `@<name>`, so the mentioned
 * user's `user_id` comes from the message's mention list, never from the text.
 *
 * @module dsh-channels/access/targets
 */

import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { FEISHU_USER_ID_PATTERN } from '../domain.ts'

/** Outcome of resolving one `/auth user` target. */
export type AuthUserTarget =
  | { ok: true; userId: string; name?: string }
  | { ok: false; reason: 'usage' | 'mention-missing' | 'mention-multiple' | 'mention-no-user-id' }

/** Input-error card text for each unresolved `/auth user` target. */
export const AUTH_USER_TARGET_ERRORS: Record<Extract<AuthUserTarget, { ok: false }>['reason'], string> = {
  'usage': '用法：/auth user add <@用户|user_id> 或 /auth user remove <@用户|user_id>（可用 /userid 查看 user_id）。',
  'mention-missing': '没有识别到被 @ 的用户。请在群里用 @ 选择成员，或改用 /auth user add <user_id>。',
  'mention-multiple': '一次只能 @ 一个用户，请分开发送。',
  'mention-no-user-id': '被 @ 的用户没有 user_id（外部用户、机器人，或应用缺少 contact:user.employee_id:readonly 权限），无法授权。',
}

/**
 * Resolve the user an `/auth user add|remove` command addresses.
 *
 * An argument starting with `@` selects the message's single non-bot mention
 * (the bot's own mention and `@所有人` never count); otherwise the first word
 * must be a valid `user_id`.
 *
 * @param argument Command text after `user add` / `user remove`.
 * @param mentions The message's mentions (`NormalizedMessage.mentions`).
 * @param botOpenId The bot's open_id, when known, to exclude its mention.
 * @returns the resolved user, or the reason it could not be resolved.
 */
export function resolveAuthUserTarget(
  argument: string,
  mentions: NormalizedMessage['mentions'],
  botOpenId?: string,
): AuthUserTarget {
  const text = argument.trim()
  if (text.startsWith('@')) {
    const users = mentions.filter(mention => mention.isBot !== true
      && (botOpenId === undefined || mention.openId !== botOpenId))
    if (users.length === 0) return { ok: false, reason: 'mention-missing' }
    if (users.length > 1) return { ok: false, reason: 'mention-multiple' }
    const [user] = users as [NormalizedMessage['mentions'][number]]
    if (user.userId === undefined || user.userId === '') return { ok: false, reason: 'mention-no-user-id' }
    return { ok: true, userId: user.userId, ...(user.name === undefined || user.name === '' ? {} : { name: user.name }) }
  }
  const userId = text.split(/\s+/u)[0] ?? ''
  return FEISHU_USER_ID_PATTERN.test(userId) ? { ok: true, userId } : { ok: false, reason: 'usage' }
}
