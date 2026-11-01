/**
 * Pure admission policy for inbound Feishu traffic.
 *
 * The policy has no I/O: it takes one normalized subject, the relevant
 * configuration slice, and a snapshot of the user table's `chat` switches, and
 * returns an allow/deny decision. The controller turns a denial into the
 * user-facing behavior (fixed private-chat notice, silent drop, authorization
 * request card), which keeps the security-critical matrix cheap to unit test.
 *
 * Access model (`guarded` mode):
 *  - the administrator may talk in any private chat or group;
 *  - a user-table user whose `chat` switch is on may talk in a private chat and in
 *    any group, including groups they added the bot to themselves;
 *  - everyone else is refused; in a group the refusal may ask the
 *    administrator to add the sender to the user table.
 *
 * @module dsh-channels/access/policy
 */

import type { FeishuConfig } from '../config.ts'

/** Chat kinds this policy decides about (matches the channel normalizer). */
export type AccessChatType = 'p2p' | 'group'

/** The security-relevant facts of one inbound message. */
export interface AccessSubject {
  chatType: AccessChatType
  senderId: string
}

/** Read-only view of the durable user table's `chat` switches. */
export interface AccessSnapshot {
  /** `user_id`s whose `chat` switch is on. */
  users: ReadonlySet<string>
}

/** Why access was denied; drives the controller's response. */
export type AccessDenyReason = 'admin-missing' | 'user-not-authorized'

/** Result of evaluating one inbound message. */
export type AccessDecision =
  | { readonly kind: 'allow'; readonly reason: 'open' | 'admin' | 'authorized-user' }
  | { readonly kind: 'deny'; readonly reason: AccessDenyReason }

/** The configuration slice admission reads (allows easy fakes in tests). */
export type AccessPolicyConfig = Pick<FeishuConfig, 'accessMode' | 'adminUserId'>

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
 * Evaluate the admission matrix for one message. Private chats and groups
 * follow the same rule; only the controller's reaction to a denial differs.
 *
 * `open` mode admits everyone (the SDK's app-availability scope is then the
 * only boundary) and exists for debugging only.
 */
export function decideAccess(
  subject: AccessSubject,
  config: AccessPolicyConfig,
  snapshot: AccessSnapshot,
): AccessDecision {
  if (config.accessMode === 'open') return { kind: 'allow', reason: 'open' }
  const admin = config.adminUserId?.trim()
  if (admin === undefined || admin === '') return { kind: 'deny', reason: 'admin-missing' }
  if (subject.senderId.trim() === admin) return { kind: 'allow', reason: 'admin' }
  if (snapshot.users.has(subject.senderId)) return { kind: 'allow', reason: 'authorized-user' }
  return { kind: 'deny', reason: 'user-not-authorized' }
}
