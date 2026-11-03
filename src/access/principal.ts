/**
 * Caller identity of channel prompts.
 *
 * This channel submits every Feishu prompt through DSH's `session/prompt` as
 * an in-process Peer whose principal names the sender, so DSH itself records
 * the caller in the durable message source:
 * `{ kind: 'user', rpcId, principal }`, where `rpcId` is the request id this
 * channel minted and `principal` is one of the two kinds below. Readers of
 * the Session log (this channel's code-write gate, the Web UI, memory
 * plugins) therefore tell a Feishu user's turn from the Host owner's turn,
 * and from another Feishu user's turn, without any channel state.
 *
 * - A private chat acts for the person: `{ kind: 'feishu-user', userId }`.
 * - A group acts for the group, with the speaker recorded:
 *   `{ kind: 'feishu-group', chatId, userId }`.
 *
 * Principals carry Feishu ids only: they are persisted in Session logs, so
 * they hold no credential and no display name.
 *
 * @module dsh-channels/access/principal
 */

/** The DSH principal kind of a Feishu user speaking in a private chat. */
export const FEISHU_USER_PRINCIPAL_KIND = 'feishu-user'
/** The DSH principal kind of a Feishu group, with the member speaking in it. */
export const FEISHU_GROUP_PRINCIPAL_KIND = 'feishu-group'

/** Durable identity of one Feishu user, as a DSH principal. */
export interface FeishuUserPrincipal {
  readonly kind: typeof FEISHU_USER_PRINCIPAL_KIND
  /** Feishu user_id (tenant-scoped). */
  readonly userId: string
}

/** Durable identity of one Feishu group and the member speaking in it. */
export interface FeishuGroupPrincipal {
  readonly kind: typeof FEISHU_GROUP_PRINCIPAL_KIND
  /** Feishu chat_id of the group. */
  readonly chatId: string
  /** Feishu user_id of the member who sent the prompt. */
  readonly userId: string
}

/** Every principal this channel creates Peers for. */
export type ChannelPrincipal = FeishuUserPrincipal | FeishuGroupPrincipal

/**
 * The principal of one Feishu user in a private chat.
 * @param userId - Feishu user_id.
 * @returns the principal.
 */
export function feishuUserPrincipal(userId: string): FeishuUserPrincipal {
  return { kind: FEISHU_USER_PRINCIPAL_KIND, userId }
}

/**
 * The principal of one member speaking in a Feishu group.
 * @param chatId - Feishu chat_id of the group.
 * @param userId - Feishu user_id of the member.
 * @returns the principal.
 */
export function feishuGroupPrincipal(chatId: string, userId: string): FeishuGroupPrincipal {
  return { kind: FEISHU_GROUP_PRINCIPAL_KIND, chatId, userId }
}

/**
 * The principal a user acts under on one route: the person in a private
 * chat, the group (with the speaker) in a group chat.
 * @param route - chat type and chat id of the route.
 * @param userId - Feishu user_id of the actor.
 * @returns the principal.
 */
export function principalOnRoute(route: { readonly chatType: 'p2p' | 'group'; readonly chatId: string }, userId: string): ChannelPrincipal {
  return route.chatType === 'p2p' ? feishuUserPrincipal(userId) : feishuGroupPrincipal(route.chatId, userId)
}

/**
 * One Peer per principal value: the map key of a principal.
 * @param principal - the principal.
 * @returns a key equal for equal principals.
 */
export function principalKey(principal: ChannelPrincipal): string {
  switch (principal.kind) {
    case FEISHU_USER_PRINCIPAL_KIND:
      return `${principal.kind}:${principal.userId}`
    case FEISHU_GROUP_PRINCIPAL_KIND:
      return `${principal.kind}:${principal.chatId}:${principal.userId}`
    default:
      return assertNever(principal)
  }
}

/** A message source as read from a Session log: the kind plus whatever DSH recorded. */
export type LoggedSource = { readonly kind: string; readonly [key: string]: unknown }

/** Who submitted one user message, read from its durable source. */
export type PromptCaller =
  /** A Feishu user in a private chat, through this channel (or any surface writing the same principal). */
  | { readonly kind: 'feishu-user'; readonly userId: string }
  /** A member speaking in a Feishu group. */
  | { readonly kind: 'feishu-group'; readonly chatId: string; readonly userId: string }
  /** A caller other than a Feishu principal: a different principal kind, or a malformed one. */
  | { readonly kind: 'other-principal' }
  /** No principal: the Host owner, or Host code submitting on nobody's behalf (commands, jobs, subagent results). */
  | { readonly kind: 'none' }

/**
 * Read the caller of one message from its source. The source comes from a
 * Session log, so every field is validated.
 * @param source - `UserMessage.source`.
 * @returns the caller the source names.
 */
export function promptCallerOf(source: LoggedSource): PromptCaller {
  if (source.kind !== 'user' || !('principal' in source)) return { kind: 'none' }
  const principal = source.principal
  if (principal === undefined) return { kind: 'none' }
  if (typeof principal !== 'object' || principal === null || !('kind' in principal)) return { kind: 'other-principal' }
  const userId = 'userId' in principal && typeof principal.userId === 'string' && principal.userId !== '' ? principal.userId : undefined
  if (userId === undefined) return { kind: 'other-principal' }
  if (principal.kind === FEISHU_USER_PRINCIPAL_KIND) return { kind: 'feishu-user', userId }
  if (principal.kind === FEISHU_GROUP_PRINCIPAL_KIND) {
    const chatId = 'chatId' in principal && typeof principal.chatId === 'string' && principal.chatId !== '' ? principal.chatId : undefined
    return chatId === undefined ? { kind: 'other-principal' } : { kind: 'feishu-group', chatId, userId }
  }
  return { kind: 'other-principal' }
}

/**
 * The request id of a prompt submitted through `session/prompt`, as DSH
 * records it on the message source (`rpcId`). This channel correlates its
 * cards, restart snapshots and queued-card merges by it, because DSH mints
 * the message id itself.
 * @param source - `UserMessage.source`.
 * @returns the request id, or undefined for a message no Remote prompt created.
 */
export function promptRequestIdOf(source: LoggedSource): string | undefined {
  if (source.kind !== 'user' || !('rpcId' in source)) return undefined
  return typeof source.rpcId === 'string' && source.rpcId !== '' ? source.rpcId : undefined
}

function assertNever(value: never): never {
  throw new Error(`unexpected principal: ${JSON.stringify(value)}`)
}
