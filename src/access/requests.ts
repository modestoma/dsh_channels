/**
 * Authorization request lifecycle.
 *
 * Two fixed events can ask the administrator to add a user to the user
 * table: a user without the conversation permission adding the bot to a
 * group, and such a user mentioning the bot in any group. Users already in
 * the table (including suspended ones whose `chat` switch is off) never
 * trigger a request. Each request is one durable `AccessRequestRecord`
 * (opaque token, TTL from `authRequestTtlDays`), delivered as a DM card
 * carrying that token, and settles exactly once from the card or the Web
 * panel through the same `resolve()` path. An approval writes the user with
 * only `chat` on. Every network/persistence
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
  /** Durable user-table/request store. */
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
  /** User ids with an in-flight create/deliver pass (avoids duplicate cards). */
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
   * Bot added to a group (`im.chat.member.bot.added_v1`). An inviter without
   * the conversation permission (and not yet in the user table) gets a user
   * request card to the administrator (deduplicated, 24 h deny cooldown);
   * otherwise the administrator receives the group information card.
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
      const inviter = event.operator.userId
      const info = await this.chatInfo(event.chatId)
      const inviterMayChat = inviter !== undefined
        && (isAdminUserId(this.config(), inviter) || this.deps.store.snapshot().users.has(inviter))
      if (inviter !== undefined && !inviterMayChat && !this.deps.store.hasUser(inviter)) {
        await this.beginUserRequest({
          userId: inviter,
          chatId: event.chatId,
          ...(info?.name === undefined ? {} : { groupName: info.name }),
          trigger: 'invite',
        }, now)
        return
      }
      await this.sendCard(admin, buildGroupInfoCard({
        chatId: event.chatId,
        ...(info?.name === undefined ? {} : { name: info.name }),
        ...(info?.memberCount === undefined ? {} : { memberCount: info.memberCount }),
        ...(info?.ownerId === undefined ? {} : { ownerId: info.ownerId }),
        ...(inviter === undefined ? {} : { inviterUserId: inviter }),
        inviterMayChat,
        now,
      }))
    } catch (error) {
      this.deps.warn('dsh-channels: bot-added group notice failed: %s', String(error))
    }
  }

  /**
   * Lazy trigger for a user without the conversation permission who
   * addressed the bot in a group: DM the administrator a user request card
   * (deduplicated, 24 h deny cooldown). Users already in the table are never
   * requested again.
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
      if (this.deps.store.hasUser(msg.senderId)) return
      const now = this.now()
      if (!this.mayBegin(msg.senderId, now)) return
      // A live pending request needs no chat lookup; an expired one is swept in beginUserRequest.
      if ((this.deps.store.pendingRequestFor(msg.senderId)?.expiresAt ?? 0) > now) return
      const info = await this.chatInfo(msg.chatId)
      await this.beginUserRequest({
        userId: msg.senderId,
        ...(msg.senderName === undefined ? {} : { name: msg.senderName }),
        chatId: msg.chatId,
        ...(info?.name === undefined ? {} : { groupName: info.name }),
        trigger: 'mention',
      }, now)
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
   * Settle one pending request: `allow` adds the user with only `chat` on
   * (source `card`), `deny` only records the decision. Shared by the DM card and the
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

  /** Cheap synchronous pre-check: no request is being created for the user and none was denied recently. */
  private mayBegin(userId: string, now: number): boolean {
    return !this.creating.has(userId) && !this.deps.store.recentlyDenied(userId, DENIED_COOLDOWN_MS, now)
  }

  /** Create + DM one user request unless deduplicated/cooling down. */
  private async beginUserRequest(input: {
    userId: string
    name?: string
    chatId: string
    groupName?: string
    trigger: 'mention' | 'invite'
  }, now: number): Promise<boolean> {
    const admin = this.adminUserId()
    if (admin === undefined) return false
    if (await this.hasLivePending(input.userId, now)) return false
    if (!this.mayBegin(input.userId, now)) return false
    this.creating.add(input.userId)
    try {
      const record = this.newRecord(input)
      if (!(await this.persist(record))) return false
      await this.sendCard(admin, buildUserRequestCard({
        userId: input.userId,
        ...(input.name === undefined ? {} : { name: input.name }),
        chatId: input.chatId,
        ...(input.groupName === undefined ? {} : { groupName: input.groupName }),
        trigger: input.trigger,
        token: record.token,
        now,
      }), record)
      return true
    } finally {
      this.creating.delete(input.userId)
    }
  }

  /**
   * True when an unexpired request for this target is pending. An expired but
   * not-yet-swept record is settled as expired first so the new request is not
   * silently blocked by the stale one.
   */
  private async hasLivePending(userId: string, now: number): Promise<boolean> {
    const pending = this.deps.store.pendingRequestFor(userId)
    if (pending === undefined) return false
    if (pending.expiresAt > now) return true
    await this.settleExpired(pending)
    return false
  }

  /** Build one pending user request record (token + TTL, status `pending`). */
  private newRecord(input: {
    userId: string
    name?: string
    chatId: string
    groupName?: string
  }): AccessRequestRecord {
    const now = this.now()
    return {
      token: randomUUID(),
      kind: 'user',
      targetId: input.userId,
      chatId: input.chatId,
      ...(input.groupName === undefined || input.groupName === '' ? {} : { groupName: input.groupName }),
      requesterUserId: input.userId,
      ...(input.name === undefined || input.name === '' ? {} : { requesterName: input.name }),
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
    await this.deps.store.grantChat({
      userId: record.targetId,
      ...(record.requesterName === undefined ? {} : { name: record.requesterName }),
      source: 'card',
      addedBy: actorUserId,
      addedAt: now,
      chat: true,
      wikiRead: false,
      wikiWrite: false,
      codeWrite: false,
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
    try {
      await channel.updateCard(record.messageId, buildRequestSettledCard({
        targetId: record.targetId,
        ...(record.requesterName === undefined ? {} : { targetName: record.requesterName }),
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
