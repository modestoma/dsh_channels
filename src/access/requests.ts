/**
 * Authorization request lifecycle.
 *
 * Two fixed events can ask the administrator to grant access: the bot being
 * added to a group, and an unauthorized user mentioning the bot inside an
 * already-authorized group. Both create one durable
 * `AccessRequestRecord` (opaque token, TTL from `authRequestTtlDays`), deliver
 * a DM card carrying that token, and settle exactly once from the card or the
 * Web panel through the same `resolve()` path. Every network/persistence
 * failure degrades to a warning: admission must never throw because a card
 * could not be delivered.
 *
 * @module dsh-channels/access/requests
 */

import { randomUUID } from 'node:crypto'
import type { FeishuConfig } from '../config.ts'
import type { AccessRequestRecord } from '../domain.ts'
import type {
  BotAddedEvent,
  CardActionEvent,
  ChatInfo,
  FeishuChannel,
  NormalizedMessage,
} from '../feishu-channel.ts'
import { buildGroupInfoCard, buildRequestSettledCard, buildUserRequestCard } from './cards.ts'
import type { SettledRequestStatus } from './cards.ts'
import { isAdminUserId } from './policy.ts'
import type { AccessStore } from './store.ts'

/** Same-target re-notification cooldown after a request was denied (24 h). */
const DENIED_COOLDOWN_MS = 24 * 60 * 60 * 1000

const MS_PER_DAY = 86_400_000

/** Collaborators the request lifecycle needs, injected so tests stay offline. */
export interface AccessRequestsDeps {
  /** Current plugin configuration (administrator id + request TTL). */
  config(): FeishuConfig
  /** Durable whitelist/request store. */
  store: AccessStore
  /** Live channel, undefined before startup / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Best-effort diagnostics; never rethrown. */
  warn(message: string, ...args: unknown[]): void
  /** Clock seam for tests. */
  now?(): number
}

/** One decoded card callback value (the token is the only trusted input). */
interface CardDecisionValue {
  token: string
  action: 'allow' | 'deny'
}

/** Decode one button callback value; anything malformed is silently ignored. */
function decodeCardValue(value: unknown): CardDecisionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const token = record.token
  const action = record.action
  if (typeof token !== 'string' || token === '') return undefined
  if (action !== 'allow' && action !== 'deny') return undefined
  return { token, action }
}

/** Human label for a terminal request status (error messages and cards). */
function statusLabel(status: AccessRequestRecord['status']): string {
  switch (status) {
    case 'approved':
      return '已授权'
    case 'denied':
      return '已忽略'
    case 'expired':
      return '已过期'
    default:
      return '处理中'
  }
}

/** Map a settled record status to the card vocabulary (`pending` has no card). */
function settledStatus(status: AccessRequestRecord['status']): SettledRequestStatus | undefined {
  return status === 'pending' ? undefined : status
}

/**
 * Late-trigger condition: only messages addressed to the bot may create a
 * request. A plain group message in an unauthorized group stays silent.
 */
function addressedToBot(msg: NormalizedMessage): boolean {
  return msg.mentionedBot === true || msg.threadId !== undefined
}

export class AccessRequests {
  /** Targets with an in-flight create/deliver pass (avoids duplicate cards). */
  private readonly creating = new Set<string>()
  /** `${messageId}:${userId}` of non-administrator card clicks already answered. */
  private readonly unauthorizedNotified = new Set<string>()

  constructor(private readonly deps: AccessRequestsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private config(): FeishuConfig {
    return this.deps.config()
  }

  private adminUserId(): string | undefined {
    const admin = this.config().adminUserId?.trim()
    return admin === undefined || admin === '' ? undefined : admin
  }

  private ttlMs(): number {
    return this.config().authRequestTtlDays * MS_PER_DAY
  }

  /**
   * Bot added to a group (`im.chat.member.bot.added_v1`): DM the group
   * information card to the administrator. An authorized group only gets the
   * informational card; an unauthorized one gets an「授权本群 / 忽略」card
   * backed by a fresh pending request (deduplicated, 24 h deny cooldown).
   */
  async handleBotAdded(event: BotAddedEvent): Promise<void> {
    try {
      const admin = this.adminUserId()
      if (admin === undefined) {
        this.deps.warn(
          'dsh-channels: bot added to %s but no administrator user_id is configured; group card skipped',
          event.chatId,
        )
        return
      }
      const now = this.now()
      if (this.deps.store.hasGroup(event.chatId)) {
        const info = await this.chatInfo(event.chatId)
        await this.sendCard(admin, buildGroupInfoCard({
          chatId: event.chatId,
          ...(info?.name === undefined ? {} : { name: info.name }),
          ...(info?.memberCount === undefined ? {} : { memberCount: info.memberCount }),
          ...(info?.ownerId === undefined ? {} : { ownerId: info.ownerId }),
          ...(event.operator.userId === undefined ? {} : { inviterUserId: event.operator.userId }),
          authorized: true,
          now,
        }))
        return
      }
      if (!(await this.beginGroupRequest(event.chatId, event.operator.userId, now))) return
    } catch (error) {
      this.deps.warn('dsh-channels: bot-added group notice failed: %s', String(error))
    }
  }

  /**
   * Fallback trigger for an unauthorized group: the first *addressed* message
   * in it re-sends the group information/authorization card to the
   * administrator (used when the bot-added event is not subscribed).
   */
  async ensureGroupRequest(msg: NormalizedMessage): Promise<void> {
    if (!addressedToBot(msg) || msg.chatType !== 'group') return
    try {
      const admin = this.adminUserId()
      if (admin === undefined) {
        this.deps.warn(
          'dsh-channels: group %s needs authorization but no administrator user_id is configured',
          msg.chatId,
        )
        return
      }
      if (this.deps.store.hasGroup(msg.chatId)) return
      if (!(await this.beginGroupRequest(msg.chatId, msg.senderId, this.now()))) return
    } catch (error) {
      this.deps.warn('dsh-channels: group authorization request failed: %s', String(error))
    }
  }

  /**
   * Lazy trigger for an unauthorized user inside an authorized group: DM the
   * administrator a user-authorization request card (deduplicated, 24 h deny
   * cooldown). Never runs for unauthorized groups (the group gate is first).
   */
  async ensureUserRequest(msg: NormalizedMessage): Promise<void> {
    if (!addressedToBot(msg) || msg.chatType !== 'group') return
    try {
      const admin = this.adminUserId()
      if (admin === undefined) {
        this.deps.warn(
          'dsh-channels: user %s needs authorization but no administrator user_id is configured',
          msg.senderId,
        )
        return
      }
      const group = this.deps.store.getGroup(msg.chatId)
      if (group === undefined) return
      if (this.deps.store.hasUser(msg.senderId)) return
      await this.beginUserRequest(msg, group.name, this.now())
    } catch (error) {
      this.deps.warn('dsh-channels: user authorization request failed: %s', String(error))
    }
  }

  /**
   * Card button callback: administrator-only settlement. A stale card (already
   * settled or expired) is patched to its terminal state; a request that is
   * still pending goes through the same `resolve()` as the Web panel.
   */
  async onCardAction(event: CardActionEvent): Promise<void> {
    try {
      const decision = decodeCardValue(event.action?.value)
      if (decision === undefined) return
      const record = this.deps.store.getRequest(decision.token)
      if (record === undefined) return
      const actor = event.operator.userId
      if (actor === undefined || !isAdminUserId(this.config(), actor)) {
        await this.notifyUnauthorized(event)
        return
      }
      if (record.status !== 'pending') {
        await this.patchCard(record)
        return
      }
      if (record.expiresAt <= this.now()) {
        await this.settleExpired(record)
        return
      }
      const result = await this.resolve(decision.token, decision.action, actor)
      if (!result.ok) {
        this.deps.warn('dsh-channels: settling access request %s failed: %s', decision.token, result.error)
      }
    } catch (error) {
      this.deps.warn('dsh-channels: access card action failed: %s', String(error))
    }
  }

  /**
   * Settle one pending request: `allow` writes the group/user grant (source
   * `card`), `deny` only records the decision. Shared by the DM card and the
   * Web panel; every failure is reported in the return value, never thrown.
   */
  async resolve(
    token: string,
    decision: 'allow' | 'deny',
    actorUserId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isAdminUserId(this.config(), actorUserId)) return { ok: false, error: '仅管理员可处理授权申请' }
    const record = this.deps.store.getRequest(token)
    if (record === undefined) return { ok: false, error: '授权申请不存在' }
    if (record.status !== 'pending') {
      return { ok: false, error: `该申请已处理（${statusLabel(record.status)}）` }
    }
    const now = this.now()
    if (record.expiresAt <= now) {
      await this.settleExpired(record)
      return { ok: false, error: '授权申请已过期' }
    }
    const status = decision === 'allow' ? 'approved' : 'denied'
    try {
      if (decision === 'allow') await this.grant(record, actorUserId, now)
      await this.deps.store.putRequest({ ...record, status })
    } catch (error) {
      this.deps.warn('dsh-channels: persisting access request %s settlement failed: %s', token, String(error))
      return { ok: false, error: '保存授权结果失败' }
    }
    await this.patchCard({ ...record, status })
    return { ok: true }
  }

  /** Mark every pending request past its deadline as expired and patch its card. */
  async expirePending(): Promise<void> {
    try {
      const expired = await this.deps.store.expireRequests(this.now())
      for (const record of expired) await this.patchCard(record)
    } catch (error) {
      this.deps.warn('dsh-channels: expiring access requests failed: %s', String(error))
    }
  }

  /** Pending, not-yet-expired requests (the administrator's queue). */
  pending(): AccessRequestRecord[] {
    return this.deps.store.pendingRequests(this.now())
  }

  /** Drop in-memory dedupe guards (shutdown). Durable state lives in the store. */
  clear(): void {
    this.creating.clear()
    this.unauthorizedNotified.clear()
  }

  // ---- internals -------------------------------------------------------

  /** Create + DM one group request unless deduplicated/cooling down. */
  private async beginGroupRequest(chatId: string, inviterUserId: string | undefined, now: number): Promise<boolean> {
    const admin = this.adminUserId()
    if (admin === undefined) return false
    if (await this.hasLivePending('group', chatId, now)) return false
    if (this.deps.store.recentlyDenied('group', chatId, DENIED_COOLDOWN_MS, now)) return false
    const key = `group:${chatId}`
    if (this.creating.has(key)) return false
    this.creating.add(key)
    try {
      const info = await this.chatInfo(chatId)
      const record = this.newRecord({
        kind: 'group',
        targetId: chatId,
        chatId,
        ...(info?.name === undefined ? {} : { groupName: info.name }),
        ...(inviterUserId === undefined ? {} : { requesterUserId: inviterUserId }),
      })
      if (!(await this.persist(record))) return false
      await this.sendCard(admin, buildGroupInfoCard({
        chatId,
        ...(info?.name === undefined ? {} : { name: info.name }),
        ...(info?.memberCount === undefined ? {} : { memberCount: info.memberCount }),
        ...(info?.ownerId === undefined ? {} : { ownerId: info.ownerId }),
        ...(inviterUserId === undefined ? {} : { inviterUserId }),
        authorized: false,
        token: record.token,
        now,
      }), record)
      return true
    } finally {
      this.creating.delete(key)
    }
  }

  /** Create + DM one user request unless deduplicated/cooling down. */
  private async beginUserRequest(msg: NormalizedMessage, groupName: string | undefined, now: number): Promise<boolean> {
    const admin = this.adminUserId()
    if (admin === undefined) return false
    if (await this.hasLivePending('user', msg.senderId, now)) return false
    if (this.deps.store.recentlyDenied('user', msg.senderId, DENIED_COOLDOWN_MS, now)) return false
    const key = `user:${msg.senderId}`
    if (this.creating.has(key)) return false
    this.creating.add(key)
    try {
      const record = this.newRecord({
        kind: 'user',
        targetId: msg.senderId,
        chatId: msg.chatId,
        ...(groupName === undefined ? {} : { groupName }),
        requesterUserId: msg.senderId,
        ...(msg.senderName === undefined ? {} : { requesterName: msg.senderName }),
      })
      if (!(await this.persist(record))) return false
      await this.sendCard(admin, buildUserRequestCard({
        userId: msg.senderId,
        ...(msg.senderName === undefined ? {} : { name: msg.senderName }),
        chatId: msg.chatId,
        ...(groupName === undefined ? {} : { groupName }),
        ...(msg.senderName === undefined ? {} : { requesterName: msg.senderName }),
        token: record.token,
        now,
      }), record)
      return true
    } finally {
      this.creating.delete(key)
    }
  }

  /**
   * True when an unexpired request for this target is pending. An expired but
   * not-yet-swept record is settled as expired first so the new request is not
   * silently blocked by the stale one.
   */
  private async hasLivePending(
    kind: AccessRequestRecord['kind'],
    targetId: string,
    now: number,
  ): Promise<boolean> {
    const pending = this.deps.store.pendingRequestFor(kind, targetId)
    if (pending === undefined) return false
    if (pending.expiresAt > now) return true
    await this.settleExpired(pending)
    return false
  }

  /** Build one pending request record (token + TTL, status `pending`). */
  private newRecord(input: {
    kind: AccessRequestRecord['kind']
    targetId: string
    chatId?: string
    groupName?: string
    requesterUserId?: string
    requesterName?: string
  }): AccessRequestRecord {
    const now = this.now()
    return {
      token: randomUUID(),
      kind: input.kind,
      targetId: input.targetId,
      ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
      ...(input.groupName === undefined || input.groupName === '' ? {} : { groupName: input.groupName }),
      ...(input.requesterUserId === undefined ? {} : { requesterUserId: input.requesterUserId }),
      ...(input.requesterName === undefined || input.requesterName === '' ? {} : { requesterName: input.requesterName }),
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.ttlMs(),
    }
  }

  /** Persist a request; returns false (and warns) on failure. */
  private async persist(record: AccessRequestRecord): Promise<boolean> {
    try {
      await this.deps.store.putRequest(record)
      return true
    } catch (error) {
      this.deps.warn('dsh-channels: persisting access request %s failed: %s', record.token, String(error))
      return false
    }
  }

  /** DM one card to the administrator and remember its message id. */
  private async sendCard(to: string, card: object, record?: AccessRequestRecord): Promise<void> {
    if (to === '') return
    const channel = this.deps.channel()
    if (channel === undefined) {
      this.deps.warn('dsh-channels: channel unavailable; access card %s not delivered', record?.token ?? '(group info)')
      return
    }
    try {
      const result = await channel.send(to, { card })
      if (record === undefined) return
      const messageId = result?.messageId
      if (typeof messageId !== 'string' || messageId === '') return
      try {
        await this.deps.store.putRequest({ ...record, messageId })
      } catch (error) {
        this.deps.warn('dsh-channels: persisting card message id for %s failed: %s', record.token, String(error))
      }
    } catch (error) {
      this.deps.warn('dsh-channels: delivering access card %s failed: %s', record?.token ?? '(group info)', String(error))
    }
  }

  /** Group name/owner/member count, best-effort (missing permission → warn). */
  private async chatInfo(chatId: string): Promise<ChatInfo | undefined> {
    const channel = this.deps.channel()
    if (channel === undefined) return undefined
    try {
      return await channel.getChatInfo(chatId)
    } catch (error) {
      this.deps.warn('dsh-channels: reading chat info for %s failed: %s', chatId, String(error))
      return undefined
    }
  }

  /** Write the actual grant; throws so `resolve()` can report the failure. */
  private async grant(record: AccessRequestRecord, actorUserId: string, now: number): Promise<void> {
    if (record.kind === 'group') {
      await this.deps.store.addGroup({
        chatId: record.targetId,
        ...(record.groupName === undefined ? {} : { name: record.groupName }),
        source: 'card',
        addedBy: actorUserId,
        addedAt: now,
      })
      return
    }
    await this.deps.store.addUser({
      userId: record.targetId,
      ...(record.requesterName === undefined ? {} : { name: record.requesterName }),
      source: 'card',
      addedBy: actorUserId,
      addedAt: now,
    })
  }

  /** Persist the expired status (best-effort) then patch the DM card. */
  private async settleExpired(record: AccessRequestRecord): Promise<void> {
    const expired: AccessRequestRecord = { ...record, status: 'expired' }
    try {
      await this.deps.store.putRequest(expired)
    } catch (error) {
      this.deps.warn('dsh-channels: persisting expired access request %s failed: %s', record.token, String(error))
    }
    await this.patchCard(expired)
  }

  /** Replace the DM card with its terminal state; delivery failures only warn. */
  private async patchCard(record: AccessRequestRecord): Promise<void> {
    const status = settledStatus(record.status)
    if (status === undefined || record.messageId === undefined) return
    const channel = this.deps.channel()
    if (channel === undefined) return
    const targetName = record.kind === 'group' ? record.groupName : record.requesterName
    try {
      await channel.updateCard(record.messageId, buildRequestSettledCard({
        kind: record.kind,
        targetId: record.targetId,
        ...(targetName === undefined ? {} : { targetName }),
        status,
        now: this.now(),
      }))
    } catch (error) {
      this.deps.warn('dsh-channels: patching access card %s failed: %s', record.messageId, String(error))
    }
  }

  /** One control card is delivered once; non-administrator clicks get one notice. */
  private async notifyUnauthorized(event: CardActionEvent): Promise<void> {
    const key = `${event.messageId}:${event.operator.userId ?? event.operator.openId}`
    if (this.unauthorizedNotified.has(key)) return
    this.unauthorizedNotified.add(key)
    const channel = this.deps.channel()
    if (channel === undefined) return
    try {
      await channel.send(event.chatId, { text: '仅管理员可操作该授权卡片。' }, { replyTo: event.messageId })
    } catch (error) {
      this.deps.warn('dsh-channels: notifying a non-administrator card click failed: %s', String(error))
    }
  }
}
