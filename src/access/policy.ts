/**
 * Pure admission policy for inbound Feishu traffic.
 *
 * The policy deliberately has no I/O: it takes one normalized subject, the
 * relevant configuration slice, and a snapshot of the durable authorization
 * tables, and returns an allow/deny decision. The controller turns a denial
 * into the user-facing behavior (fixed private-chat notice, silent drop,
 * authorization request card), which keeps the security-critical matrix
 * cheap to unit test.
 *
 * Access model:
 *  - the administrator may start/continue a conversation in any private chat
 *    or any group, regardless of the whitelists;
 *  - private chats: non-administrators are refused, unless
 *    `dmAllowWhitelist` is on and their user_id is on the global user
 *    whitelist;
 *  - group chats: non-administrators need the group to be authorized AND
 *    their user_id to be on the global user whitelist.
 *
 * @module dsh-channels/access/policy
 */

import type { FeishuConfig } from '../config.ts'

/** Chat kinds this policy decides about (matches the channel normalizer). */
export type AccessChatType = 'p2p' | 'group'

/** The security-relevant facts of one inbound message. */
export interface AccessSubject {
  chatType: AccessChatType
  chatId: string
  senderId: string
}

/** Read-only view of the durable authorization tables. */
export interface AccessSnapshot {
  /** Authorized group `chat_id`s. */
  groups: ReadonlySet<string>
  /** Authorized user `user_id`s (global, across authorized groups). */
  users: ReadonlySet<string>
}

/** Why access was denied; drives the controller's response. */
export type AccessDenyReason =
  | 'admin-missing'
  | 'dm-non-admin'
  | 'group-not-authorized'
  | 'user-not-authorized'

/** Result of evaluating one inbound message. */
export type AccessDecision =
  | { readonly kind: 'allow'; readonly reason: 'open' | 'admin' | 'authorized-user' }
  | {
    readonly kind: 'deny'
    readonly reason: AccessDenyReason
    /** Which authorization request a denial may trigger, when applicable. */
    readonly request?: 'group' | 'user'
  }

/** The configuration slice admission reads (allows easy fakes in tests). */
export type AccessPolicyConfig = Pick<FeishuConfig, 'accessMode' | 'adminUserId' | 'dmAllowWhitelist'>

/** True when `userId` is exactly the configured administrator. */
export function isAdminUserId(
  config: Pick<FeishuConfig, 'adminUserId'>,
  userId: string | undefined,
): boolean {
  const admin = config.adminUserId?.trim()
  if (admin === undefined || admin === '') return false
  return userId !== undefined && userId.trim() === admin
}

/**
 * Evaluate the admission matrix for one message.
 *
 * `open` mode reproduces the legacy behavior (the SDK's app-availability scope
 * is then the only boundary) and exists for debugging/compatibility only.
 */
export function decideAccess(
  subject: AccessSubject,
  config: AccessPolicyConfig,
  snapshot: AccessSnapshot,
): AccessDecision {
  if (config.accessMode === 'open') return { kind: 'allow', reason: 'open' }

  const admin = config.adminUserId?.trim()
  if (admin === undefined || admin === '') return { kind: 'deny', reason: 'admin-missing' }

  // The administrator is never constrained by the whitelists: they may start
  // a conversation in any private chat or any group, even one that has not
  // been authorized yet. The group/user gates only restrict non-admins.
  if (subject.senderId.trim() === admin) return { kind: 'allow', reason: 'admin' }

  if (subject.chatType === 'p2p') {
    if (config.dmAllowWhitelist && snapshot.users.has(subject.senderId)) {
      return { kind: 'allow', reason: 'authorized-user' }
    }
    return { kind: 'deny', reason: 'dm-non-admin' }
  }

  // Non-admin group access needs both gates: the group must be authorized and
  // the sender must be on the global user whitelist.
  if (!snapshot.groups.has(subject.chatId)) {
    return { kind: 'deny', reason: 'group-not-authorized', request: 'group' }
  }
  if (snapshot.users.has(subject.senderId)) return { kind: 'allow', reason: 'authorized-user' }
  return { kind: 'deny', reason: 'user-not-authorized', request: 'user' }
}
