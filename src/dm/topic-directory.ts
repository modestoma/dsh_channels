/**
 * The topic directory of private-chat projects mode: one durable record per
 * topic a person has, whether the main Session opened it
 * (`feishu_topic_open`) or the person did (a reply in a topic).
 *
 * After each topic turn the record keeps the turn's outcome, its last replies
 * (for `feishu_topic_read`), and the summary {@link extractTopicReport} reads
 * from the reply. A summary newer than the record's `deliveredAt` is waiting
 * for the main Session: the person's next main-chat message carries every
 * waiting summary as a `<dm_topic_updates>` block ({@link topicUpdatesBlock}),
 * and {@link DmTopicDirectory.markDelivered} records that it went out. The
 * main Session is never woken for a summary.
 *
 * Records outlive their routes: a topic whose route expired is listed as
 * closed.
 *
 * @module dsh-channels/dm/topic-directory
 */

import { z } from 'zod'
import type { RouteRecord } from '../domain.ts'
import type { DomainTable } from '../storage/table.ts'
import { clip, extractTopicReport } from './report.ts'

/** Replies kept per topic for `feishu_topic_read`. */
export const DM_TOPIC_REPLIES_KEPT = 5

/** Longest reply kept per turn, in characters. */
export const DM_TOPIC_REPLY_MAX_CHARS = 4_000

/** Longest hand-over kept for the root card, in characters. */
export const DM_TOPIC_BRIEF_MAX_CHARS = 300

/** Longest topic title, in characters. */
export const DM_TOPIC_TITLE_MAX_CHARS = 30

/** One kept reply of a topic turn. */
export const dmTopicReplySchema = z.object({
  /** Epoch ms when the turn settled. */
  at: z.number().int().nonnegative(),
  /** How the turn settled. */
  outcome: z.enum(['done', 'stopped', 'error']),
  /** The reply text, cut to {@link DM_TOPIC_REPLY_MAX_CHARS}. */
  text: z.string(),
})

export type DmTopicReply = z.infer<typeof dmTopicReplySchema>

/** One topic of a person's projects-mode private chat, keyed by its Feishu thread id. */
export const dmTopicRecordSchema = z.object({
  /** Feishu thread id: the topic route's key and the table key. */
  key: z.string().min(1),
  /** The person the topic belongs to. */
  userId: z.string().min(1),
  /** The private chat. */
  chatId: z.string().min(1),
  /** Short title shown in lists and updates. */
  title: z.string().min(1),
  /** `main`: opened by the main Session; `user`: the person replied in a topic. */
  openedBy: z.enum(['main', 'user']),
  /** Epoch ms when the topic was opened. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms of the last change. */
  updatedAt: z.number().int().nonnegative(),
  /** Root card message of a topic the main Session opened. */
  rootMessageId: z.string().min(1).optional(),
  /** The hand-over the main Session gave, redrawn on the root card. */
  brief: z.string().optional(),
  /** Why the topic could not be started; such a topic has no route. */
  failedReason: z.string().min(1).optional(),
  /** How the last turn settled. */
  lastOutcome: z.enum(['done', 'stopped', 'error']).optional(),
  /** Summary of the last turn (or the start failure). */
  summary: z.string().optional(),
  /** Whether the last summary asks the person for something. */
  needsYou: z.boolean().optional(),
  /** Epoch ms of {@link summary}. */
  reportedAt: z.number().int().nonnegative().optional(),
  /** Epoch ms when the main Session last received this topic's summary. */
  deliveredAt: z.number().int().nonnegative().optional(),
  /** The last turns' replies, oldest first, at most {@link DM_TOPIC_REPLIES_KEPT}. */
  replies: z.array(dmTopicReplySchema).default([]),
})

export type DmTopicRecord = z.infer<typeof dmTopicRecordSchema>

/**
 * Status of a topic as the main Session sees it.
 * - `running`: a turn is in flight.
 * - `waiting`: a turn waits for an approval or an answer, or the last summary asks the person for something.
 * - `idle`: the last turn settled and nothing is asked.
 * - `failed`: the topic could not be started.
 * - `closed`: the topic's route expired or was removed.
 */
export type DmTopicStatus = 'running' | 'waiting' | 'idle' | 'failed' | 'closed'

/** Chinese label of each status. */
export const DM_TOPIC_STATUS_LABELS: Readonly<Record<DmTopicStatus, string>> = {
  running: '进行中',
  waiting: '等你处理',
  idle: '空闲',
  failed: '未能开始',
  closed: '已过期',
}

/** What a new topic record names. */
export interface DmTopicOpening {
  readonly key: string
  readonly userId: string
  readonly chatId: string
  readonly title: string
  readonly openedBy: DmTopicRecord['openedBy']
  readonly rootMessageId?: string
  readonly brief?: string
}

export interface DmTopicDirectoryDeps {
  /** The `dm_topics` table; undefined while the domain is closed. */
  table(): DomainTable<DmTopicRecord> | undefined
  /** The active route of a topic, if any. */
  route(key: string): RouteRecord | undefined
  /** Whether a Session has a turn in flight or queued. */
  busy(sessionId: string): boolean
  /** Whether a Session waits for an approval decision or a question answer. */
  waiting(sessionId: string): boolean
  warn(message: string, ...args: unknown[]): void
  /** Clock seam (tests). */
  now?(): number
}

export class DmTopicDirectory {
  constructor(private readonly deps: DmTopicDirectoryDeps) {}

  /**
   * One topic record.
   * @param key - the topic's thread id.
   * @returns the record, if any.
   */
  get(key: string): DmTopicRecord | undefined {
    return this.deps.table()?.get(key)
  }

  /**
   * Record a new topic. An existing record of the same key is kept.
   * @param opening - the topic.
   * @returns the stored record (undefined while the domain is closed).
   */
  async register(opening: DmTopicOpening): Promise<DmTopicRecord | undefined> {
    const table = this.deps.table()
    if (table === undefined) return undefined
    const existing = table.get(opening.key)
    if (existing !== undefined) return existing
    const now = this.now()
    const record: DmTopicRecord = {
      key: opening.key,
      userId: opening.userId,
      chatId: opening.chatId,
      title: topicTitle(opening.title),
      openedBy: opening.openedBy,
      createdAt: now,
      updatedAt: now,
      ...(opening.rootMessageId === undefined ? {} : { rootMessageId: opening.rootMessageId }),
      ...(opening.brief === undefined ? {} : { brief: clip(opening.brief.trim(), DM_TOPIC_BRIEF_MAX_CHARS) }),
      replies: [],
    }
    await table.put(opening.key, record)
    return record
  }

  /**
   * Record that a topic could not be started; the failure is reported to the
   * main Session like a summary.
   * @param key - the topic's thread id.
   * @param reason - the readable reason.
   */
  async markFailed(key: string, reason: string): Promise<void> {
    const now = this.now()
    await this.change(key, record => ({
      ...record, failedReason: reason, summary: `未能开始：${reason}`, needsYou: false, reportedAt: now, updatedAt: now,
    }))
  }

  /**
   * Record one settled topic turn: its outcome, its reply, and its summary.
   * @param key - the topic's thread id.
   * @param outcome - how the turn settled.
   * @param reply - the reply text of the turn.
   * @param reportChars - longest summary kept.
   */
  async recordTurn(key: string, outcome: DmTopicReply['outcome'], reply: string, reportChars: number): Promise<void> {
    const now = this.now()
    const report = extractTopicReport(reply, reportChars)
    const summary = report?.summary ?? OUTCOME_WITHOUT_REPLY[outcome]
    await this.change(key, record => ({
      ...record,
      lastOutcome: outcome,
      summary,
      needsYou: report?.needsYou ?? false,
      reportedAt: now,
      updatedAt: now,
      replies: [...record.replies, { at: now, outcome, text: clip(reply.trim(), DM_TOPIC_REPLY_MAX_CHARS) }].slice(-DM_TOPIC_REPLIES_KEPT),
    }))
  }

  /**
   * Every topic of one person, most recently changed first.
   * @param userId - the person.
   * @returns the records.
   */
  topicsOf(userId: string): DmTopicRecord[] {
    const table = this.deps.table()
    if (table === undefined) return []
    return [...table.entries()]
      .map(([, record]) => record)
      .filter(record => record.userId === userId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * The live status of one topic.
   * @param record - the topic.
   * @returns its status.
   */
  statusOf(record: DmTopicRecord): DmTopicStatus {
    if (record.failedReason !== undefined) return 'failed'
    const route = this.deps.route(record.key)
    if (route === undefined) return 'closed'
    if (this.deps.waiting(route.sessionId)) return 'waiting'
    if (this.deps.busy(route.sessionId)) return 'running'
    return record.needsYou === true ? 'waiting' : 'idle'
  }

  /**
   * How many topics the person's main Session opened that still have a turn in flight.
   * @param userId - the person.
   * @returns the count.
   */
  runningOpenedByMain(userId: string): number {
    return this.topicsOf(userId).filter(record => record.openedBy === 'main' && this.hasLiveTurn(record)).length
  }

  /**
   * Whether a topic has a turn in flight or queued, including one waiting for an approval or an answer.
   * @param record - the topic.
   * @returns whether it has a live turn.
   */
  hasLiveTurn(record: DmTopicRecord): boolean {
    if (record.failedReason !== undefined) return false
    const route = this.deps.route(record.key)
    return route !== undefined && this.deps.busy(route.sessionId)
  }

  /**
   * Topics of one person whose latest summary the main Session has not received, oldest summary first.
   * @param userId - the person.
   * @returns the records.
   */
  pendingUpdates(userId: string): DmTopicRecord[] {
    return this.topicsOf(userId)
      .filter(record => record.reportedAt !== undefined && record.reportedAt > (record.deliveredAt ?? -1))
      .sort((left, right) => (left.reportedAt ?? 0) - (right.reportedAt ?? 0))
  }

  /**
   * Record that the main Session received the given summaries. A summary
   * reported after `reportedAt` stays pending.
   * @param delivered - each topic and the `reportedAt` of the summary that went out.
   */
  async markDelivered(delivered: ReadonlyArray<{ key: string; reportedAt: number }>): Promise<void> {
    for (const { key, reportedAt } of delivered) {
      await this.change(key, record => (record.deliveredAt !== undefined && record.deliveredAt >= reportedAt
        ? record
        : { ...record, deliveredAt: reportedAt }))
    }
  }

  /** Apply one change to an existing record; a missing record or a closed domain is skipped with a warning. */
  private async change(key: string, fn: (record: DmTopicRecord) => DmTopicRecord): Promise<void> {
    const table = this.deps.table()
    if (table === undefined || table.get(key) === undefined) {
      this.deps.warn('dsh-channels: no topic record %s to update', key)
      return
    }
    await table.update(key, fn)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** Summary of a turn that produced no reply text. */
const OUTCOME_WITHOUT_REPLY: Readonly<Record<DmTopicReply['outcome'], string>> = {
  done: '本轮结束，没有文字回复。',
  stopped: '本轮被停止。',
  error: '本轮出错结束。',
}

/**
 * A topic title: the first line of `text`, cut to {@link DM_TOPIC_TITLE_MAX_CHARS}.
 * @param text - a title or an opening message.
 * @returns the title (`新话题` for blank text).
 */
export function topicTitle(text: string): string {
  const line = text.split(/\r?\n/u).map(part => part.trim()).find(part => part !== '') ?? ''
  return line === '' ? '新话题' : clip(line, DM_TOPIC_TITLE_MAX_CHARS)
}

/**
 * The `<dm_topic_updates>` block of the main Session's next turn.
 * @param records - topics with a pending summary ({@link DmTopicDirectory.pendingUpdates}).
 * @param statusOf - live status of a topic.
 * @returns the block, or an empty string without records.
 */
export function topicUpdatesBlock(records: readonly DmTopicRecord[], statusOf: (record: DmTopicRecord) => DmTopicStatus): string {
  if (records.length === 0) return ''
  const entries = records.map(record => [
    `话题「${record.title}」（topic_id: ${record.key}，${DM_TOPIC_STATUS_LABELS[statusOf(record)]}）`,
    record.summary ?? '',
  ].join('\n').trim())
  return ['<dm_topic_updates>', '自上次以来这些话题有了进展：', '', entries.join('\n\n'), '</dm_topic_updates>'].join('\n')
}
