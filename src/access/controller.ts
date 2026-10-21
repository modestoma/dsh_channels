/**
 * Inbound admission controller.
 *
 * Every inbound Feishu message passes this gate *before* any side effect
 * (Session creation, workspace, attachment archive, model call). The pure
 * matrix lives in `policy.ts`; this module owns the user-facing behavior on
 * denial:
 *
 *  - private chats: non-administrators get one fixed notice (10 s per-sender
 *    cooldown); with no administrator configured they get the bootstrap
 *    notice instead;
 *  - group chats: fully silent, except that addressed denials call back into
 *    the authorization-request lifecycle so the administrator can be asked;
 *  - slash commands: `/userid` stays available to every private sender, the
 *    administrator's commands always pass (including inside an unauthorized
 *    group), everything else must pass admission.
 *
 * The controller never creates a Session or a workspace.
 *
 * @module dsh-channels/access/controller
 */

import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import type { FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'
import { decideAccess, isAdminUserId } from './policy.ts'
import type { AccessDecision } from './policy.ts'
import type { AccessStore, AccessStoreSnapshot } from './store.ts'

/** Fixed private-chat notice for non-administrators (no model call). */
export const DM_DENY_TEXT = '非管理员禁用私聊功能哦～如需使用，请在管理员授权的群里 @ 我；或联系管理员把你的 user_id 加入白名单。'

/** Fixed private-chat notice while no administrator is configured. */
export const DM_UNCONFIGURED_TEXT = '机器人尚未配置管理员。发送 /userid 可查看你的 user_id，交给部署者配置后即可启用。'

/** Per-sender cooldown for the repeated private-chat notice (10 s). */
const DM_NOTICE_COOLDOWN_MS = 10_000

/** Collaborators of the admission gate. */
export interface AccessControllerDeps {
  /** Current plugin configuration (administrator id + access mode). */
  config(): FeishuConfig
  /** Durable whitelists (read through the in-memory snapshot). */
  store: AccessStore
  /** Live channel, undefined before startup / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Best-effort diagnostics; never rethrown. */
  warn(message: string, ...args: unknown[]): void
  /** Addressed message in an unauthorized group (request lifecycle hook). */
  onDeniedGroup?(msg: NormalizedMessage): void
  /** Addressed message from an unauthorized user in an authorized group. */
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

  /** True when `userId` is exactly the configured administrator. */
  isAdmin(userId?: string): boolean {
    return isAdminUserId(this.config(), userId)
  }

  /** Current whitelist snapshot used by the pure policy. */
  snapshot(): AccessStoreSnapshot {
    return this.deps.store.snapshot()
  }

  /** Evaluate the admission matrix for one message (pure; no side effects). */
  decide(msg: NormalizedMessage): AccessDecision {
    return decideAccess(
      { chatType: msg.chatType, chatId: msg.chatId, senderId: msg.senderId },
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
      if (decision.reason === 'dm-non-admin') {
        if (msg.chatType === 'p2p') await this.noticeDeniedDm(msg)
        return false
      }
      if (decision.reason === 'admin-missing') {
        // Private chats get the bootstrap instructions; groups stay silent.
        // Goes through the same per-sender cooldown as the regular notice so a
        // single sender cannot make the bot answer every message while the
        // deployment is unconfigured.
        if (msg.chatType === 'p2p') await this.noticeDeniedDm(msg)
        return false
      }
      // Group denials are silent. Only messages actually addressed to the bot
      // may trigger the (administrator-facing) authorization request.
      if (msg.chatType === 'group' && addressedToBot(msg)) {
        if (decision.reason === 'group-not-authorized') this.deps.onDeniedGroup?.(msg)
        else if (decision.reason === 'user-not-authorized') this.deps.onDeniedUser?.(msg)
      }
    } catch (error) {
      this.deps.warn('dsh-channels: admission side effect failed: %s', String(error))
    }
    return false
  }

  /**
   * Slash-command admission. Runs before any command card/topic/Session side
   * effect. `open` mode keeps the legacy behavior; otherwise private chats
   * stay administrator-only (with `/userid` as the bootstrap exception) and
   * group chats must pass the full admission matrix; the administrator is
   * never constrained by the whitelists, so all of their commands pass even
   * inside an unauthorized group (`/auth` is the in-conversation grant
   * entry).
   */
  async admitCommand(msg: NormalizedMessage, commandName: string | undefined): Promise<boolean> {
    if (this.config().accessMode === 'open') return true
    try {
      if (msg.chatType === 'p2p') {
        // `/userid` is the bootstrap entry for everyone: it only echoes the
        // sender's own user_id and has no storage/model side effect.
        if (commandName === 'userid') return true
        if (this.isAdmin(msg.senderId)) return true
        await this.noticeDeniedDm(msg)
        return false
      }
      if (this.isAdmin(msg.senderId) && (commandName === 'auth' || commandName === 'groupid')) {
        return true
      }
      return this.decide(msg).kind === 'allow'
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
    return record.senderUserId === msg.senderId && record.chatId === msg.chatId
  }

  /** Drop in-memory notices (shutdown; durable state lives in the store). */
  clear(): void {
    this.dmNoticeAt.clear()
  }

  // ---- internals -------------------------------------------------------

  /**
   * Deliver the fixed private-chat notice (cooled down). While no
   * administrator is configured the bootstrap text is used instead, so users
   * are never pointed at an administrator that does not exist yet.
   */
  private async noticeDeniedDm(msg: NormalizedMessage): Promise<void> {
    const now = this.now()
    const last = this.dmNoticeAt.get(msg.senderId)
    if (last !== undefined && now - last < DM_NOTICE_COOLDOWN_MS) return
    this.dmNoticeAt.set(msg.senderId, now)
    const text = this.config().adminUserId === undefined ? DM_UNCONFIGURED_TEXT : DM_DENY_TEXT
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
