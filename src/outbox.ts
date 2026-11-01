/**
 * Durable outbox for the terminal Feishu actions of a turn: the settled
 * patch of a streaming, approval, or question card, the Typing → DONE/No
 * reaction swap, and a continuation segment whose send failed.
 *
 * Each action is attempted at once. A failed one is stored in the `outbox`
 * table and retried with backoff (5 s doubling to 5 min) until it succeeds,
 * Feishu reports the message gone (recalled, or the bot left the chat), or
 * it is 24 h old; a restart resumes the stored actions once the instance
 * lock is held. A later patch of the same card replaces a stored one, so
 * only the newest content lands.
 *
 * @module dsh-channels/outbox
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FeishuApiError } from './feishu-channel.ts'
import type { FeishuChannel } from './feishu-channel.ts'

/** First retry delay. */
const FIRST_RETRY_MS = 5_000
/** Longest retry delay. */
const MAX_RETRY_MS = 300_000
/** Age after which a stored action is dropped. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Consecutive failures after which an action counts as failing in health. */
export const FAILING_ATTEMPTS = 3
/**
 * Feishu codes meaning the target message can never take the action:
 * 230002 the bot is not in the chat, 230011 the message was recalled.
 */
const GONE_CODES: ReadonlySet<number> = new Set([230002, 230011])

const metaFields = {
  /** Table key. */
  key: z.string().min(1),
  /** Epoch ms of the first attempt. */
  createdAt: z.number().int().nonnegative(),
  /** Failed attempts so far. */
  attempts: z.number().int().nonnegative(),
  /** Epoch ms of the next attempt. */
  nextAt: z.number().int().nonnegative(),
  /** Text of the last failure. */
  lastError: z.string().optional(),
}

export const outboxEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('card'),
    ...metaFields,
    /** Card message to patch. */
    messageId: z.string().min(1),
    /** Full card that replaces the message's content. */
    card: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('reaction'),
    ...metaFields,
    /** Message carrying the reactions. */
    messageId: z.string().min(1),
    /** Reaction to remove first; cleared once removed. */
    removeReactionId: z.string().min(1).optional(),
    /** Emoji type to add. */
    add: z.string().min(1),
  }),
  z.object({
    kind: z.literal('segment'),
    ...metaFields,
    /** Session whose route anchors the segment. */
    sessionId: z.string().min(1),
    /** 1-based segment number within the turn. */
    segment: z.number().int().positive(),
    /** Card to send. */
    card: z.record(z.string(), z.unknown()),
    /** Plain-text body for a rejected card. */
    text: z.string(),
  }),
])

/** One stored action. */
export type OutboxEntry = z.infer<typeof outboxEntrySchema>

/** The `outbox` table handle. */
export interface OutboxTable {
  get(key: string): OutboxEntry | undefined
  put(key: string, value: OutboxEntry): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, OutboxEntry]>
}

/** Collaborators of the outbox. */
export interface OutboxDeps {
  /** The table, or undefined before the domain opens / after it closes. */
  table(): OutboxTable | undefined
  /** The live channel, or undefined while disconnected. */
  channel(): FeishuChannel | undefined
  /** Send a continuation segment card through the session's route. */
  sendSegment(sessionId: string, segment: number, card: object, text: string): Promise<unknown>
  warn(message: string, ...args: unknown[]): void
  /** Current time; tests substitute it. */
  now?: () => number
}

/** Outbox counts for health. */
export interface OutboxHealth {
  /** Stored actions waiting for a retry. */
  pending: number
  /** Of those, the ones that failed at least {@link FAILING_ATTEMPTS} times. */
  failing: number
}

/** The Feishu error code of a failed call, when it carries one. */
export function feishuErrorCode(error: unknown): number | undefined {
  if (error instanceof FeishuApiError) return error.code
  const data = (error as { response?: { data?: { code?: unknown } } } | undefined)?.response?.data
  if (typeof data?.code === 'number') return data.code
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'number' ? code : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Retries terminal Feishu actions until they land. */
export class Outbox {
  private readonly now: () => number
  /** Per-key chains, so actions on one message run in order. */
  private readonly chains = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  /** @param deps - table, channel, segment sender, and logger. */
  constructor(private readonly deps: OutboxDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Patch a card to its settled content, retrying until it lands.
   * @param messageId - card message.
   * @param card - full replacement card.
   * @returns after the first attempt; never rejects.
   */
  patch(messageId: string, card: object): Promise<void> {
    const key = `card:${messageId}`
    return this.submit(key, { kind: 'card', key, messageId, card: card as Record<string, unknown>, ...this.fresh() })
  }

  /**
   * Swap a reaction: remove one (when given), then add another.
   * @param messageId - message carrying the reactions.
   * @param removeReactionId - reaction to remove, if any.
   * @param add - emoji type to add.
   * @returns after the first attempt; never rejects.
   */
  reaction(messageId: string, removeReactionId: string | undefined, add: string): Promise<void> {
    const key = `reaction:${messageId}`
    return this.submit(key, { kind: 'reaction', key, messageId, ...removeReactionId === undefined ? {} : { removeReactionId }, add, ...this.fresh() })
  }

  /**
   * Send a continuation segment that could not be sent during the turn.
   * @param sessionId - session whose route anchors it.
   * @param segment - 1-based segment number.
   * @param card - card to send.
   * @param text - plain-text body for a rejected card.
   * @returns after the first attempt; never rejects.
   */
  segment(sessionId: string, segment: number, card: object, text: string): Promise<void> {
    const key = `segment:${randomUUID()}`
    return this.submit(key, { kind: 'segment', key, sessionId, segment, card: card as Record<string, unknown>, text, ...this.fresh() })
  }

  /** Retry every stored action now, then keep retrying as they come due. */
  start(): void {
    this.running = true
    this.retryDue()
  }

  /**
   * Stop retrying and wait for attempts in flight; stored actions stay for
   * the next start.
   * @returns once no attempt is running.
   */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await Promise.all([...this.chains.values()])
  }

  /** @returns how many actions wait and how many keep failing. */
  health(): OutboxHealth {
    let pending = 0
    let failing = 0
    for (const [, entry] of this.deps.table()?.entries() ?? []) {
      pending++
      if (entry.attempts >= FAILING_ATTEMPTS) failing++
    }
    return { pending, failing }
  }

  private fresh(): Pick<OutboxEntry, 'createdAt' | 'attempts' | 'nextAt'> {
    const now = this.now()
    return { createdAt: now, attempts: 0, nextAt: now }
  }

  /** Queue an attempt behind earlier ones on the same key; a stored entry for the key is replaced. */
  private submit(key: string, entry: OutboxEntry): Promise<void> {
    const stored = this.deps.table()?.get(key)
    // A replaced card keeps its age, so a card that never lands still expires.
    const next = stored === undefined ? entry : { ...entry, createdAt: stored.createdAt, attempts: stored.attempts }
    return this.chain(key, () => this.attempt(next))
  }

  private chain(key: string, task: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(task)
    const settled = run.catch((error: unknown) => {
      // `attempt` contains its failures; a throw here is a table write failure.
      this.deps.warn('dsh-channels: outbox action %s failed to store: %s', key, errorText(error))
    })
    this.chains.set(key, settled)
    void settled.then(() => { if (this.chains.get(key) === settled) this.chains.delete(key) })
    return settled
  }

  /** Run one action; store it for a retry on failure, drop it when done, gone, or expired. */
  private async attempt(entry: OutboxEntry): Promise<void> {
    const table = this.deps.table()
    let progress: OutboxEntry = entry
    try {
      await this.run(entry, (next) => { progress = next })
      await table?.delete(entry.key)
    } catch (error) {
      const code = feishuErrorCode(error)
      const attempts = progress.attempts + 1
      const now = this.now()
      if ((code !== undefined && GONE_CODES.has(code)) || now - progress.createdAt >= MAX_AGE_MS || table === undefined) {
        if (table !== undefined) await table.delete(entry.key)
        this.deps.warn('dsh-channels: dropped Feishu %s action after %d attempts: %s', progress.kind, attempts, errorText(error))
        return
      }
      if (attempts === 1 || attempts === FAILING_ATTEMPTS) this.deps.warn('dsh-channels: Feishu %s action failed (attempt %d), retrying: %s', progress.kind, attempts, errorText(error))
      await table.put(entry.key, { ...progress, attempts, nextAt: now + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1)), lastError: errorText(error) })
      this.arm()
    }
  }

  /**
   * Perform one action.
   * @param entry - the action.
   * @param progressed - receives the entry after a completed step of a reaction swap.
   * @throws the Feishu failure.
   */
  private async run(entry: OutboxEntry, progressed: (next: OutboxEntry) => void): Promise<void> {
    if (entry.kind === 'segment') {
      await this.deps.sendSegment(entry.sessionId, entry.segment, entry.card, entry.text)
      return
    }
    const channel = this.deps.channel()
    if (channel === undefined) throw new Error('channel not connected')
    if (entry.kind === 'card') {
      await channel.updateCard(entry.messageId, entry.card)
      return
    }
    if (entry.removeReactionId !== undefined) {
      await channel.removeReaction(entry.messageId, entry.removeReactionId)
      const { removeReactionId: _removed, ...rest } = entry
      progressed(rest)
    }
    await channel.addReaction(entry.messageId, entry.add)
  }

  /** Arm the timer for the earliest stored action. */
  private arm(): void {
    if (!this.running) return
    let due = Number.POSITIVE_INFINITY
    for (const [, entry] of this.deps.table()?.entries() ?? []) due = Math.min(due, entry.nextAt)
    if (!Number.isFinite(due)) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.retryDue()
    }, Math.max(0, due - this.now()))
    this.timer.unref?.()
  }

  /** Attempt every stored action that is due, then re-arm. */
  private retryDue(): void {
    if (!this.running) return
    const now = this.now()
    for (const [key, entry] of [...this.deps.table()?.entries() ?? []]) {
      if (entry.nextAt <= now && !this.chains.has(key)) void this.chain(key, () => this.attempt(entry))
    }
    this.arm()
  }
}
