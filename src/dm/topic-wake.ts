/**
 * Waking a private-chat projects-mode main Session when its topics report.
 *
 * Without a wake, a topic's summary reaches the main Session only with the
 * person's next main-chat message, so the main chat stays silent after the
 * work the person asked for finished. {@link DmTopicWake.topicReported} is
 * called when a topic turn the main Session started settles, or a topic it
 * opened cannot start. After a short merge window, per person:
 *
 * - `dmTopicWake: agent`: the main Session gets every waiting summary as a
 *   `<dm_topic_updates>` turn of its own, submitted as the person through the
 *   main route's operation queue into a new card in the main chat, and the
 *   summaries are marked delivered. A main Session with a turn in flight is
 *   not interrupted: the wake runs after that turn settles
 *   ({@link DmTopicWake.mainTurnSettled}), and finds nothing to do when the
 *   person's own message already carried the summaries.
 * - `notice`, or `agent` after `dmTopicWakeLimit` wakes in a row without a
 *   message from the person ({@link DmTopicWake.personSpoke} resets the
 *   count): a card in the main chat lists the summaries; the main Session
 *   still receives them on the person's next message.
 * - `off`: nothing.
 *
 * Pending wakes and counts live in memory; after a restart, waiting summaries
 * go out with the person's next message as before.
 *
 * @module dsh-channels/dm/topic-wake
 */

import type { FeishuConfig } from '../config.ts'
import { feishuUserPrincipal } from '../access/principal.ts'
import { initialChatCard, initialStreamingCard } from '../cards/index.ts'
import { plainText, standaloneCard } from '../cards/primitives.ts'
import type { RouteOperationQueue } from '../commands.ts'
import { dmMainRouteKey } from '../domain.ts'
import type { RouteRecord } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { SessionManager } from '../session/manager.ts'
import { channelPrompt, storablePrompt } from '../session/prompt.ts'
import type { InflightRepair } from '../session/repair.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TurnSubmission } from '../session/submit.ts'
import { DM_TOPIC_STATUS_LABELS, topicUpdatesBlock } from './topic-directory.ts'
import type { DmTopicDirectory, DmTopicRecord } from './topic-directory.ts'

/** Merge window: reports of one person within it wake the main Session once. */
export const DM_TOPIC_WAKE_MERGE_MS = 3_000

/** Instruction appended to the summaries of a wake turn. */
export const DM_TOPIC_WAKE_INSTRUCTION = '（这条不是用户发的消息：上面的话题刚有了进展，用户还不知道。用一两句话在主聊天里告诉用户结果，以及需要他决定或去做的事；话题里已经发过的文件不要再发，也不要重复话题里的长内容。）'

/** Title of the notice card. */
const NOTICE_TITLE = '**📌 话题有进展**'

export interface DmTopicWakeDeps {
  /** Live configuration; read per wake. */
  config(): FeishuConfig
  started(): boolean
  channel(): FeishuChannel | undefined
  routes: RouteStore
  directory: DmTopicDirectory
  sessions: SessionManager
  /** Card-bound prompt submission. */
  prompts: TurnSubmission
  repair: InflightRepair
  /** Shared per-route FIFO, so a wake and the person's messages run one at a time. */
  queue: RouteOperationQueue
  /** Whether a Session has a turn in flight or queued. */
  busy(sessionId: string): boolean
  /** Whether the main Session's replies are chat cards. */
  chatReplies(): boolean
  warn(message: string, ...args: unknown[]): void
  /** Merge window override (tests); defaults to {@link DM_TOPIC_WAKE_MERGE_MS}. */
  mergeMs?: number
}

/** One person's main chat. */
interface Person {
  readonly userId: string
  readonly chatId: string
}

export class DmTopicWake {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** People whose wake waits for their main Session's running turn. */
  private readonly deferred = new Map<string, Person>()
  /** Wakes in a row per person without a message from them. */
  private readonly streaks = new Map<string, number>()
  private readonly running = new Set<Promise<void>>()

  constructor(private readonly deps: DmTopicWakeDeps) {}

  /**
   * A topic of `userId` reported for its main Session: schedule a wake.
   * @param userId - the person.
   * @param chatId - their private chat.
   */
  topicReported(userId: string, chatId: string): void {
    if (this.deps.config().dmTopicWake === 'off' || userId === '') return
    this.schedule({ userId, chatId })
  }

  /**
   * A turn of some Session settled; a wake deferred for it runs now.
   * @param route - the Session's route, when it has one.
   */
  mainTurnSettled(route: RouteRecord | undefined): void {
    if (route?.dmRole !== 'main' || route.senderUserId === undefined) return
    const person = this.deferred.get(route.senderUserId)
    if (person === undefined) return
    this.deferred.delete(route.senderUserId)
    this.schedule(person)
  }

  /**
   * The person wrote in their main chat: the wake count starts over.
   * @param userId - the person.
   */
  personSpoke(userId: string): void {
    this.streaks.delete(userId)
  }

  /** Cancel scheduled wakes and wait for wakes in flight (shutdown, after `started` turned false). */
  async drain(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.deferred.clear()
    await Promise.allSettled([...this.running])
  }

  private schedule(person: Person): void {
    const existing = this.timers.get(person.userId)
    if (existing !== undefined) clearTimeout(existing)
    this.timers.set(person.userId, setTimeout(() => {
      this.timers.delete(person.userId)
      const task = this.wake(person).catch((error: unknown) => {
        this.deps.warn('dsh-channels: waking the main Session of %s failed: %s', person.userId, String(error))
      }).finally(() => this.running.delete(task))
      this.running.add(task)
    }, this.deps.mergeMs ?? DM_TOPIC_WAKE_MERGE_MS))
  }

  private async wake(person: Person): Promise<void> {
    const mode = this.deps.config().dmTopicWake
    if (mode === 'off' || !this.deps.started()) return
    const main = this.deps.routes.get(dmMainRouteKey(person.chatId, person.userId))
    if (main === undefined) return
    if (this.deps.busy(main.sessionId)) {
      this.deferred.set(person.userId, person)
      return
    }
    const streak = this.streaks.get(person.userId) ?? 0
    if (mode === 'notice' || streak >= this.deps.config().dmTopicWakeLimit) {
      await this.notice(main, person.userId)
      return
    }
    await this.deps.queue.run(main.key, async () => {
      const current = this.deps.routes.get(main.key)
      const channel = this.deps.channel()
      // The person's own message or another wake may have taken the summaries meanwhile.
      const pending = this.deps.directory.pendingUpdates(person.userId)
      if (current === undefined || channel === undefined || !this.deps.started() || pending.length === 0) return
      if (this.deps.busy(current.sessionId)) {
        this.deferred.set(person.userId, person)
        return
      }
      const live = await this.deps.sessions.ensureLive(current)
      const block = topicUpdatesBlock(pending, record => this.deps.directory.statusOf(record))
      const prompt = channelPrompt(`${block}\n\n${DM_TOPIC_WAKE_INSTRUCTION}`, feishuUserPrincipal(person.userId))
      const card = await channel.send(current.chatId, { card: this.deps.chatReplies() ? initialChatCard() : initialStreamingCard(current.sessionId) })
      const stored = storablePrompt(prompt)
      await this.deps.repair.write({
        key: card.messageId,
        sessionId: current.sessionId,
        chatId: current.chatId,
        routeKey: current.key,
        ...(stored === undefined ? {} : { prompt: stored }),
        cards: [{ messageId: card.messageId, mode: 'card' }],
        startedAt: Date.now(),
        attempts: 0,
      })
      await this.deps.routes.put(current.key, { ...current, cardMessageId: card.messageId, lastActivityAt: Date.now() })
      const outcome = await this.deps.prompts.run(live.agent, prompt, { cardMessageId: card.messageId })
      if (!outcome.accepted) return
      this.streaks.set(person.userId, streak + 1)
      await this.deps.directory.markDelivered(pending.map(record => ({ key: record.key, reportedAt: record.reportedAt ?? 0 })))
    })
  }

  /** The notice card in the main chat; the summaries stay waiting for the main Session. */
  private async notice(main: RouteRecord, userId: string): Promise<void> {
    const pending = this.deps.directory.pendingUpdates(userId)
    const channel = this.deps.channel()
    if (pending.length === 0 || channel === undefined) return
    await channel.send(main.chatId, { card: noticeCard(pending, record => DM_TOPIC_STATUS_LABELS[this.deps.directory.statusOf(record)]) })
  }
}

/**
 * The notice card: one entry per topic, its title, status and summary as
 * plain text (summaries are model text).
 * @param records - topics with a waiting summary.
 * @param statusLabel - the topic's status label.
 * @returns the card.
 */
export function noticeCard(records: readonly DmTopicRecord[], statusLabel: (record: DmTopicRecord) => string): object {
  return standaloneCard(NOTICE_TITLE, records.map(record => plainText(
    `话题「${record.title}」（${statusLabel(record)}）\n${record.summary ?? ''}`.trim(),
  )))
}
