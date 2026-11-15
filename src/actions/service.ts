/**
 * Implementation of the `feishuActions` v1 service (`ctx.get('feishuActions')`).
 *
 * Validates `ActionProposalSpec`, enforces idempotency with SHA-256 content
 * fingerprinting, posts a standalone Card 2.0 proposal into the Session's
 * Feishu route, persists the durable `action_proposals` record, and
 * auto-supersedes any earlier proposal of the same Session that still carries
 * `pending` items (refreshing their cards asynchronously through the durable
 * outbox while preserving previously `triggered` selections).
 *
 * @module dsh-channels/actions/service
 */

import { z } from 'zod'
import { buildActionProposalCard } from '../cards/action-proposal.ts'
import type { FeishuDomainHandle } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { Outbox } from '../outbox.ts'
import type { RouteStore } from '../session/routes.ts'
import {
  actionProposalIdempotencyKeySchema,
  actionProposalSpecSchema,
  FEISHU_ACTIONS_VERSION,
  fingerprintProposalSpec,
} from './contract.ts'
import type {
  ActionProposalFailureCode,
  ActionProposalPostResult,
  ActionProposalSpec,
  FeishuActionsService,
  ValidatedActionProposalSpec,
} from './contract.ts'
import { proposalIdOfKey } from './store.ts'
import type { ActionProposalRecord, ActionProposalStore, ActionProposalStoredItem } from './store.ts'

interface PendingAccept {
  readonly fingerprint: string
  readonly result: Promise<ActionProposalPostResult>
}

export interface FeishuActionsDeps {
  started(): boolean
  channel(): FeishuChannel | undefined
  domain(): FeishuDomainHandle | undefined
  store: ActionProposalStore
  routes: RouteStore
  outbox: Outbox
  warn(message: string, ...args: unknown[]): void
  now?(): number
}

const MAX_SUPERSEDE_REASON_CHARS = 200

function refused(code: ActionProposalFailureCode, message: string): ActionProposalPostResult {
  return { ok: false, code, message }
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length === 0 ? 'spec' : issue.path.join('.')}: ${issue.message}`)
    .join('; ')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reusedKey(key: string): ActionProposalPostResult {
  return refused('invalid', `幂等键 ${key} 已被不同内容的动作提议占用`)
}

export class FeishuActions implements FeishuActionsService {
  readonly version = FEISHU_ACTIONS_VERSION
  /** Key → in-flight acceptance so concurrent identical retries share one send. */
  private readonly accepting = new Map<string, PendingAccept>()
  /** Session ID → tail promise so same-session proposals serialize cleanly. */
  private readonly sessionQueue = new Map<string, Promise<unknown>>()
  /** Proposal ID → tail promise so card patches for one proposal apply in order. */
  private readonly cardWrites = new Map<string, Promise<unknown>>()
  private admitting = false

  constructor(private readonly deps: FeishuActionsDeps) {}

  /** Admit proposals once the Feishu connection and storage domain are open. */
  open(): void {
    this.admitting = true
  }

  /** Refuse new proposals ahead of channel teardown. */
  close(): void {
    this.admitting = false
  }

  /** Wait for any in-flight proposal acceptances and card refreshes to settle. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.accepting.values()].map(entry => entry.result))
    await Promise.allSettled([...this.sessionQueue.values()])
    await Promise.allSettled([...this.cardWrites.values()])
  }

  async propose(spec: ActionProposalSpec): Promise<ActionProposalPostResult> {
    const parsed = actionProposalSpecSchema.safeParse(spec)
    if (!parsed.success) {
      return refused('invalid', `动作提议参数不合法：${issuesText(parsed.error)}`)
    }
    const valid = parsed.data
    const fingerprint = fingerprintProposalSpec(valid)
    const pending = this.accepting.get(valid.key)
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) return reusedKey(valid.key)
      const outcome = await pending.result
      return outcome.ok ? { ...outcome, replayed: true } : outcome
    }

    const result = this.serializeSession(valid.sessionId, () => this.accept(valid, fingerprint))
    this.accepting.set(valid.key, { fingerprint, result })
    try {
      return await result
    } finally {
      this.accepting.delete(valid.key)
    }
  }

  async supersede(key: string, reason?: string): Promise<void> {
    const parsedKey = actionProposalIdempotencyKeySchema.safeParse(key)
    if (!parsedKey.success) return
    const validKey = parsedKey.data
    const existing = this.deps.store.getByKey(validKey)
    if (existing === undefined) return
    const trimmedReason = reason?.trim().slice(0, MAX_SUPERSEDE_REASON_CHARS)
    await this.serializeSession(existing.sessionId, async () => {
      if (!this.admitting || !this.deps.started() || this.deps.domain() === undefined) return
      const updated = await this.deps.store.supersedeByKey(validKey, trimmedReason)
      if (updated === undefined) return
      await this.patchCardSerialized(updated.proposalId, updated.cardMessageId, buildActionProposalCard(updated))
    })
  }

  /** Serialize one proposal card update so out-of-order patches never regress UI state. */
  patchCardSerialized(proposalId: string, cardMessageId: string, card: object): Promise<void> {
    const prev = this.cardWrites.get(proposalId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.deps.outbox.patch(cardMessageId, card)
      })
      .catch((error: unknown) => {
        this.deps.warn('dsh-channels: patching action proposal card %s failed: %s', cardMessageId, String(error))
      })
    this.cardWrites.set(proposalId, next)
    void next.finally(() => {
      if (this.cardWrites.get(proposalId) === next) this.cardWrites.delete(proposalId)
    })
    return next
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private serializeSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionQueue.get(sessionId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.sessionQueue.set(sessionId, next)
    void next.then(
      () => { if (this.sessionQueue.get(sessionId) === next) this.sessionQueue.delete(sessionId) },
      () => { if (this.sessionQueue.get(sessionId) === next) this.sessionQueue.delete(sessionId) },
    )
    return next
  }

  private async accept(
    spec: ValidatedActionProposalSpec,
    fingerprint: string,
  ): Promise<ActionProposalPostResult> {
    const channel = this.deps.channel()
    const domain = this.deps.domain()
    if (!this.admitting || !this.deps.started() || channel === undefined || domain === undefined) {
      return refused('not-connected', '飞书渠道尚未连接，请稍后重试')
    }

    const stored = this.deps.store.getByKey(spec.key)
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint) return reusedKey(spec.key)
      return { ok: true, replayed: true, cardMessageId: stored.cardMessageId }
    }

    const route = this.deps.routes.findBySession(spec.sessionId)
    if (route === undefined) {
      return refused('unrouted-session', `会话 ${spec.sessionId} 当前未绑定有效的飞书路由`)
    }

    const proposalId = proposalIdOfKey(spec.key)
    const actions: ActionProposalStoredItem[] = spec.actions.map(item => ({
      id: item.id,
      label: item.label,
      style: item.style ?? 'default',
      requiredAccess: item.requiredAccess ?? 'chat',
      followUpPrompt: item.followUpPrompt,
      independent: item.independent ?? false,
      status: 'pending',
    }))

    const card = buildActionProposalCard({
      proposalId,
      sessionId: spec.sessionId,
      prompt: spec.prompt,
      actions,
    })

    let cardMessageId: string
    try {
      const sent = await channel.send(
        route.chatId,
        { card },
        { replyTo: route.cardMessageId, replyInThread: route.kind === 'thread' },
      )
      cardMessageId = sent.messageId
    } catch (error) {
      return refused('send-failed', `发送动作提议卡片失败：${messageOf(error)}`)
    }

    const record: ActionProposalRecord = {
      proposalId,
      key: spec.key,
      fingerprint,
      sessionId: spec.sessionId,
      routeKey: route.key,
      chatId: route.chatId,
      cardMessageId,
      prompt: spec.prompt,
      actions,
      createdAt: this.now(),
    }

    try {
      await this.deps.store.put(record)
    } catch (error) {
      this.deps.warn('dsh-channels: persisting action proposal %s failed: %s', proposalId, String(error))
      return refused('send-failed', `记录动作提议失败：${messageOf(error)}`)
    }

    // Auto-supersede prior proposals of the same Session that still have pending items,
    // preserving already triggered selections and refreshing old cards asynchronously.
    const superseded = await this.deps.store.supersedeSession(spec.sessionId, proposalId)
    for (const old of superseded) {
      void this.patchCardSerialized(old.proposalId, old.cardMessageId, buildActionProposalCard(old))
    }

    return { ok: true, replayed: false, cardMessageId }
  }
}
