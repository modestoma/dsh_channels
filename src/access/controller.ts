/**
 * Inbound admission controller.
 *
 * Every inbound Feishu message passes this gate *before* any side effect
 * (Session creation, workspace, attachment download, model call). The pure
 * matrix lives in `policy.ts`; this module owns the user-facing behavior on
 * denial:
 *
 *  - private chats: denied senders get one fixed notice (10 s per-sender
 *    cooldown); while the user table has no administrator they get the
 *    bootstrap notice instead;
 *  - group chats: fully silent, except that addressed denials call back into
 *    the authorization-request lifecycle so the administrators can be asked;
 *  - slash commands: `/userid` stays available to every private sender,
 *    everything else must pass admission.
 *
 * It also answers the per-user permission switches (knowledge base, code
 * write) for the tool gates: an administrator holds every switch.
 *
 * The controller never creates a Session or a workspace.
 *
 * @module dsh-channels/access/controller
 */

import type { FeishuConfig } from '../config.ts'
import type { AccessPermission, RouteRecord } from '../domain.ts'
import type { FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'
import { decideAccess } from './policy.ts'
import type { AccessDecision } from './policy.ts'
import type { AccessStore, AccessStoreSnapshot } from './store.ts'

/** Fixed private-chat notice for users without the conversation permission (no model call). */
export const DM_DENY_TEXT = '你还没有对话权限哦～发送 /userid 查看你的 user_id，请管理员把你加入用户表并打开对话准入后，就可以私聊或在群里 @ 我。'

/** Fixed private-chat notice while the user table has no administrator. */
export const DM_UNCONFIGURED_TEXT = '机器人还没有管理员。发送 /userid 可查看你的 user_id，交给部署者在设置面板的用户表里把你设为管理员后即可启用。'

/** Per-sender cooldown for the repeated private-chat notice (10 s). */
const DM_NOTICE_COOLDOWN_MS = 10_000

/** Collaborators of the admission gate. */
export interface AccessControllerDeps {
  /** Current plugin configuration (access mode). */
  config(): FeishuConfig
  /** Durable user table (read through the in-memory snapshot). */
  store: AccessStore
  /** Live channel, undefined before startup / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Best-effort diagnostics; never rethrown. */
  warn(message: string, ...args: unknown[]): void
  /** Addressed group message from a user without the conversation permission. */
  onDeniedUser?(msg: NormalizedMessage): void
  /** Clock seam for tests. */
  now?(): number
}

export class AccessController {
  /** sender user_id → last fixed-notice delivery instant (DM spam guard). */
  private readonly dmNoticeAt = new Map<string, number>()

  constructor(private readonly deps: AccessControllerDeps) {}

  private config(): FeishuConfig {
    return this.deps.config()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** True when `userId` is an administrator in the user table. */
  isAdmin(userId?: string): boolean {
    return userId !== undefined && this.deps.store.isAdmin(userId)
  }

  /**
   * Whether `userId` holds one permission switch: an administrator holds
   * every switch; anyone else needs the switch on in the user table (with
   * `chat` on). Independent of `accessMode`.
   * @param userId - Feishu user_id, or undefined when unknown.
   * @param permission - the switch to check.
   * @returns true when allowed.
   */
  mayUse(userId: string | undefined, permission: AccessPermission): boolean {
    if (userId === undefined) return false
    return this.isAdmin(userId) || this.deps.store.allows(userId, permission)
  }

  /** Current user-table snapshot used by the pure policy. */
  snapshot(): AccessStoreSnapshot {
    return this.deps.store.snapshot()
  }

  /** Evaluate the admission matrix for one message (pure; no side effects). */
  decide(msg: NormalizedMessage): AccessDecision {
    return decideAccess(
      { chatType: msg.chatType, senderId: msg.senderId },
      this.config(),
      this.deps.store.snapshot(),
    )
  }

  /**
   * Full channel-plane admission for one non-slash message. `false` means the
   * message has been handled (denied silently or with the fixed notice) and
   * the caller must stop before any side effect.
   */
  async admit(msg: NormalizedMessage): Promise<boolean> {
    const decision = this.decide(msg)
    if (decision.kind === 'allow') return true
    try {
      if (msg.chatType === 'p2p') {
        // Private chats get the fixed notice (or the bootstrap instructions
        // while no administrator exists), cooled down per sender.
        await this.noticeDeniedDm(msg)
        return false
      }
      // Group denials are silent. Only messages actually addressed to the bot
      // may trigger the (administrator-facing) authorization request.
      if (decision.reason === 'user-not-authorized' && addressedToBot(msg)) this.deps.onDeniedUser?.(msg)
    } catch (error) {
      this.deps.warn('dsh-channels: admission side effect failed: %s', String(error))
    }
    return false
  }

  /**
   * Slash-command admission. Runs before any command card/topic/Session side
   * effect. `open` mode admits every command; otherwise a command must pass
   * the admission matrix, with `/userid` in a private chat as the bootstrap
   * exception (it only echoes the sender's own user_id). A denied private
   * sender gets the fixed notice; a denied group sender stays silent.
   */
  async admitCommand(msg: NormalizedMessage, commandName: string | undefined): Promise<boolean> {
    if (this.config().accessMode === 'open') return true
    try {
      if (msg.chatType === 'p2p' && commandName === 'userid') return true
      if (this.decide(msg).kind === 'allow') return true
      if (msg.chatType === 'p2p') await this.noticeDeniedDm(msg)
      return false
    } catch (error) {
      this.deps.warn('dsh-channels: command admission failed: %s', String(error))
      return false
    }
  }

  /**
   * Topic/route ownership: a route belongs to the sender (and chat) that
   * created it. Used to reject foreign replies, attachments, and command
   * execution inside someone else's topic.
   */
  ownsRoute(msg: NormalizedMessage, record: RouteRecord): boolean {
    return this.mayActOnRoute(msg.senderId, msg.chatId, record)
  }

  /**
   * Whether `userId`, acting in `chatId`, may continue or decide for the
   * route's Session: the route owner, or, on a group-shared route
   * (`record.shared`), any user the admission matrix allows in that chat.
   * @param userId - Feishu user_id of the actor.
   * @param chatId - chat the action comes from (must be the route's chat).
   * @param record - the route acted on.
   * @returns true when the action is allowed.
   */
  mayActOnRoute(userId: string | undefined, chatId: string, record: RouteRecord): boolean {
    if (userId === undefined || record.chatId !== chatId) return false
    if (record.senderUserId === userId) return true
    if (record.shared !== true) return false
    return decideAccess(
      { chatType: record.chatType, senderId: userId },
      this.config(),
      this.deps.store.snapshot(),
    ).kind === 'allow'
  }

  /**
   * Whether a `feishuTopics` launch may start a topic for `requesterUserId`:
   * an administrator or a user with the conversation permission, or anyone
   * in `open` access mode. The target group itself is not checked.
   * @param requesterUserId - Feishu user_id the launch is for.
   * @returns true when the launch is permitted.
   */
  mayLaunchFor(requesterUserId: string): boolean {
    return decideAccess(
      { chatType: 'group', senderId: requesterUserId },
      this.config(),
      this.deps.store.snapshot(),
    ).kind === 'allow'
  }

  /** Drop in-memory notices (shutdown; durable state lives in the store). */
  clear(): void {
    this.dmNoticeAt.clear()
  }

  // ---- internals -------------------------------------------------------

  /**
   * Deliver the fixed private-chat notice (cooled down). While no
   * administrator exists the bootstrap text is used instead, so users
   * are never pointed at an administrator that does not exist yet.
   */
  private async noticeDeniedDm(msg: NormalizedMessage): Promise<void> {
    const now = this.now()
    const last = this.dmNoticeAt.get(msg.senderId)
    if (last !== undefined && now - last < DM_NOTICE_COOLDOWN_MS) return
    this.dmNoticeAt.set(msg.senderId, now)
    const text = this.deps.store.snapshot().admins.size === 0 ? DM_UNCONFIGURED_TEXT : DM_DENY_TEXT
    await this.sendText(msg.chatId, text, msg.messageId)
  }

  /** Best-effort fixed-text send; unavailable channel/failures only warn. */
  private async sendText(chatId: string, text: string, replyTo?: string): Promise<void> {
    const channel = this.deps.channel()
    if (channel === undefined) {
      this.deps.warn('dsh-channels: channel unavailable; admission notice not delivered')
      return
    }
    try {
      await channel.send(chatId, { text }, replyTo === undefined ? undefined : { replyTo })
    } catch (error) {
      this.deps.warn('dsh-channels: delivering the admission notice failed: %s', String(error))
    }
  }
}

/** Late-trigger condition: only messages addressed to the bot count. */
function addressedToBot(msg: NormalizedMessage): boolean {
  return msg.mentionedBot === true || msg.threadId !== undefined
}
