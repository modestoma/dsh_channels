/**
 * Caller identity of channel prompts.
 *
 * Every prompt this channel submits for a Feishu user records that user in
 * its durable message source, in the same fields DSH writes for a prompt
 * submitted through `session/prompt` by a non-owner caller:
 * `{ kind: 'user', rpcId, principal: { kind: 'feishu-user', userId } }`.
 * Readers of the Session log (this channel's code-write gate, the Web UI,
 * memory plugins) therefore tell a Feishu user's turn from the Host owner's
 * turn, and from another Feishu user's turn, without any channel state.
 *
 * The principal names only the Feishu user_id: it is persisted in Session
 * logs, so it carries no credential and no display name.
 *
 * @module dsh-channels/access/principal
 */

import { randomUUID } from 'node:crypto'
import type { UserMessage } from '../host/core.ts'

/** The DSH principal kind of a Feishu user. */
export const FEISHU_USER_PRINCIPAL_KIND = 'feishu-user'

/** Durable identity of one Feishu user, as a DSH principal. */
export interface FeishuUserPrincipal {
  readonly kind: typeof FEISHU_USER_PRINCIPAL_KIND
  /** Feishu user_id (tenant-scoped). */
  readonly userId: string
}

/** Message source of a prompt one Feishu user submits through this channel. */
export interface FeishuPromptSource {
  readonly kind: 'user'
  /** Fresh per prompt; DSH correlates browser prompts by it and ignores unknown values. */
  readonly rpcId: string
  readonly principal: FeishuUserPrincipal
}

/**
 * The principal of one Feishu user.
 * @param userId - Feishu user_id.
 * @returns the principal value written to prompt sources.
 */
export function feishuUserPrincipal(userId: string): FeishuUserPrincipal {
  return { kind: FEISHU_USER_PRINCIPAL_KIND, userId }
}

/**
 * The message source of a prompt one Feishu user submits.
 * @param userId - Feishu user_id of the sender.
 * @returns a source with a fresh `rpcId`.
 */
export function feishuPromptSource(userId: string): FeishuPromptSource {
  return { kind: 'user', rpcId: randomUUID(), principal: feishuUserPrincipal(userId) }
}

/** Who submitted one user message, read from its durable source. */
export type PromptCaller =
  /** A Feishu user, through this channel (or any surface writing the same principal). */
  | { readonly kind: 'feishu-user'; readonly userId: string }
  /** A caller other than a Feishu user: a different principal kind, or a malformed one. */
  | { readonly kind: 'other-principal' }
  /** No principal: the Host owner, or Host code submitting on nobody's behalf (commands, jobs, subagent results). */
  | { readonly kind: 'none' }

/**
 * Read the caller of one message from its source. The source comes from a
 * Session log or a restart snapshot, so every field is validated.
 * @param source - `UserMessage.source`.
 * @returns the caller the source names.
 */
export function promptCallerOf(source: { readonly kind: string }): PromptCaller {
  if (source.kind !== 'user' || !('principal' in source)) return { kind: 'none' }
  const principal = source.principal
  if (principal === undefined) return { kind: 'none' }
  if (typeof principal !== 'object' || principal === null) return { kind: 'other-principal' }
  if (!('kind' in principal) || principal.kind !== FEISHU_USER_PRINCIPAL_KIND) return { kind: 'other-principal' }
  if (!('userId' in principal) || typeof principal.userId !== 'string' || principal.userId === '') return { kind: 'other-principal' }
  return { kind: 'feishu-user', userId: principal.userId }
}

/**
 * Build one prompt a Feishu user submits.
 * @param text - the prompt text.
 * @param senderUserId - Feishu user_id the turn acts for.
 * @returns a user message with a fresh id and the sender's principal.
 */
export function feishuUserMessage(text: string, senderUserId: string): UserMessage {
  return {
    id: randomUUID() as UserMessage['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: feishuPromptSource(senderUserId),
  }
}

/**
 * Give a prompt stored without a caller (a restart snapshot written before
 * prompts carried a principal) the sender recorded beside it. A prompt whose
 * source already names a caller is returned unchanged.
 * @param message - the stored prompt.
 * @param senderUserId - the sender recorded in the same snapshot.
 * @returns the prompt to replay.
 */
export function withFeishuSender(message: UserMessage, senderUserId: string): UserMessage {
  if (promptCallerOf(message.source).kind !== 'none' || message.source.kind !== 'user') return message
  return { ...message, source: feishuPromptSource(senderUserId) }
}
