/**
 * In-flight turn snapshots and the startup recovery pass.
 *
 * Every streaming turn records the credentials needed to settle its cards if
 * the process dies mid-turn (trigger message, Typing reaction, segment card
 * ids), plus its route and prompt. The snapshot is keyed by the turn's MAIN
 * card message id — unique per turn — so overlapping turns never overwrite
 * each other. On the next boot `repairAll()` resumes each snapshot's Session
 * and reads its log to decide, per turn:
 *
 * - the Agent never claimed the prompt (it was still queued): replay it into
 *   the same card, at most once (`replay.pending`);
 * - the turn completed but its card never received the final patch: render
 *   the final reply from the log;
 * - the turn was cut off: patch the cards to the interrupted state, with a
 *   continue button on the main card (`replay.interrupted: 'ask'`).
 *
 * A snapshot whose Session cannot be resumed settles as interrupted without a
 * continue button.
 *
 * @module dsh-channels/session/repair
 */

import { buildInterruptionCard, buildRecoveredReplyCards, segmentCardOptions } from '../cards/streaming.ts'
import type { InflightSnapshot } from '../domain.ts'
import { INFLIGHT_PROMPT_MAX_BYTES } from '../domain.ts'
import type { Agent, SessionEvent, UserMessage } from '../dsh-types.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { FeishuDomainHandle } from '../domain.ts'

/** What the Session log says about one snapshot's turn. */
export type InterruptedTurnState =
  /** The prompt never reached the model (no `user/message` with its id). */
  | { kind: 'pending' }
  /** The turn ended normally; `text` is its reply. */
  | { kind: 'completed'; text: string }
  /** The turn started but did not finish (cut off, failed, or stopped). */
  | { kind: 'interrupted' }

/**
 * Classify one turn from its Session log.
 * @param events - the Session log (after cold resume, which closes the
 *   unfinished turn with `turn/end {kind: 'interrupted'}`).
 * @param messageId - id of the prompt the turn was started with.
 * @returns the turn's state.
 */
export function classifyTurn(events: readonly SessionEvent[], messageId: string): InterruptedTurnState {
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
  if (start < 0) return { kind: 'pending' }
  const texts: string[] = []
  for (const event of events.slice(start + 1)) {
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data.message)
      if (text !== '') texts.push(text)
    } else if (event.type === 'turn/end') {
      return completedReason(event.data.reason) ? { kind: 'completed', text: texts.join('\n\n') } : { kind: 'interrupted' }
    }
  }
  return { kind: 'interrupted' }
}

/** The text blocks of a logged assistant message, joined. */
function assistantText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/** Whether a `turn/end` reason means the reply is complete. */
function completedReason(reason: unknown): boolean {
  if (typeof reason === 'string') return !['interrupted', 'aborted', 'error'].includes(reason)
  if (typeof reason !== 'object' || reason === null) return false
  const kind = (reason as { kind?: unknown }).kind
  return kind === 'completed' || kind === 'max-tokens'
}

/**
 * The prompt as stored in a snapshot, or undefined when its JSON exceeds
 * `INFLIGHT_PROMPT_MAX_BYTES` (restart recovery then cannot replay it).
 * @param message - the prompt handed to `followup()`.
 * @returns the snapshot field value.
 */
export function storableMessage(message: UserMessage): InflightSnapshot['message'] {
  const stored = {
    id: message.id,
    role: 'user' as const,
    content: message.content.map(block => ({ ...block })),
    source: { ...message.source },
  }
  return Buffer.byteLength(JSON.stringify(stored)) <= INFLIGHT_PROMPT_MAX_BYTES ? stored : undefined
}

/** Restart recovery policy (`config.replay`). */
export interface RecoveryPolicy {
  /** Replay a prompt the Agent never claimed. */
  pending: boolean
  /** `ask`: an interrupted turn's card offers a continue button; `notify`: notice only. */
  interrupted: 'ask' | 'notify'
}

/** The Session side of restart recovery, provided by the service. */
export interface InflightRecovery {
  policy(): RecoveryPolicy
  /**
   * The snapshot's Agent, cold-resumed when not live; undefined when its route
   * is gone or the resume failed.
   */
  liveAgent(snapshot: InflightSnapshot): Promise<Agent | undefined>
  /**
   * Run `message` again as a new turn streaming into the snapshot's main card.
   * The snapshot stays and is retired when that turn settles.
   */
  replay(agent: Agent, snapshot: InflightSnapshot, message: UserMessage): void
}

export interface InflightRepairDeps {
  /** The opened domain handle, or undefined before `start()` / after shutdown. */
  domain(): FeishuDomainHandle | undefined
  /** The live channel, or undefined before `start()` / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Route retirement TTL; snapshots older than it are the GC pass's job. */
  ttlMs(): number
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  /** Session-aware recovery; absent → every snapshot settles as interrupted. */
  recovery?: InflightRecovery
}

export class InflightRepair {
  constructor(private readonly deps: InflightRepairDeps) {}

  /** Write the turn's repair snapshot. Keyed by the main card message id. */
  async write(snapshot: InflightSnapshot): Promise<void> {
    await this.deps.domain()?.inflight.put(snapshot.key, snapshot)
  }

  /** Retire a snapshot (turn finalized / creation failed). Never throws. */
  async clear(key: string): Promise<void> {
    if (key === '') return
    try {
      await this.deps.domain()?.inflight.delete(key)
    } catch (error) {
      this.deps.warn('dsh-channels: clearing inflight snapshot %s failed: %s', key, String(error))
    }
  }

  /** Outstanding repair snapshots (health diagnostics). */
  count(): number {
    let total = 0
    try {
      const table = this.deps.domain()?.inflight
      if (table !== undefined) for (const _entry of table.entries()) total++
    } catch {
      // The storage dependency is reported separately; never expose details.
    }
    return total
  }

  /**
   * Store the prompt of a turn whose snapshot was written before the prompt
   * was assembled. A missing snapshot (the turn already settled) is skipped.
   */
  async recordMessage(key: string, message: UserMessage): Promise<void> {
    const stored = storableMessage(message)
    if (stored === undefined) return
    try {
      await this.deps.domain()?.inflight.update(key, snapshot => ({ ...snapshot, message: stored }))
    } catch (error) {
      this.deps.warn('dsh-channels: storing the prompt of inflight snapshot %s failed: %s', key, String(error))
    }
  }

  /**
   * Fold a resolved segment card id into the turn's snapshot (atomic
   * read-modify-write). A missing snapshot means the turn already finalized
   * (the finalize delete won the race) — silently skipped.
   */
  async recordSegment(
    mainCardMessageId: string,
    segmentIndex: number,
    messageId: string,
    mode: 'card' | 'text',
  ): Promise<void> {
    if (mainCardMessageId === '') return
    try {
      await this.deps.domain()?.inflight.update(mainCardMessageId, snapshot => {
        // The snapshot starts with only the main card; segment sends are
        // serialized in order, so a delivery for index `cards.length` is the
        // next segment (append), anything below replaces, and a gap beyond
        // the tail cannot happen under the serialized chain (ignored).
        const cards = [...snapshot.cards]
        if (segmentIndex === cards.length) {
          cards.push({ messageId, mode })
        } else if (segmentIndex >= 0 && segmentIndex < cards.length) {
          cards[segmentIndex] = { messageId, mode }
        } else {
          return snapshot
        }
        return { ...snapshot, cards }
      })
    } catch (error) {
      this.deps.warn(
        'dsh-channels: updating inflight snapshot %s failed: %s', mainCardMessageId, String(error),
      )
    }
  }

  /**
   * Startup recovery pass: settle every card a previous instance left
   * mid-flight. Runs in the background right after the long connection is
   * established; each snapshot is independent and best-effort.
   *
   * A replayed snapshot stays until its new turn settles. Any other snapshot
   * is deleted once its cards are patched. A failed patch keeps the snapshot
   * for one more attempt (capped at 2) so a transient failure at boot does not
   * lose the repair, while a medium that permanently rejects the patch cannot
   * trigger an endless retry loop.
   */
  async repairAll(): Promise<void> {
    const table = this.deps.domain()?.inflight
    if (table === undefined) return
    const snapshots = [...table.entries()]
    if (snapshots.length === 0) return
    // With GC enabled, snapshots older than the TTL are the GC pass's job:
    // repairing an ancient card would surprise the user, so repair skips
    // them and lets the GC drop them silently (both passes run at boot).
    const ttlMs = this.deps.ttlMs()
    const cutoff = ttlMs === 0 ? undefined : Date.now() - ttlMs
    const due = snapshots.filter(([, snapshot]) => cutoff === undefined || snapshot.startedAt >= cutoff)
    if (due.length === 0) return
    this.deps.info('dsh-channels: recovering %d interrupted turn(s)', due.length)
    for (const [key, snapshot] of due) {
      try {
        const outcome = await this.recover(snapshot)
        if (outcome !== 'replayed') await table.delete(key)
        this.deps.info('dsh-channels: turn card %s recovered (%s)', key, outcome)
      } catch (error) {
        this.deps.warn('dsh-channels: repair of turn card %s failed: %s', key, String(error))
        const attempts = snapshot.attempts + 1
        try {
          if (attempts >= 2) {
            await table.delete(key)
          } else {
            await table.put(key, { ...snapshot, attempts })
          }
        } catch {
          // The domain may already be closing (shutdown raced the repair).
        }
      }
    }
  }

  /** Decide and apply one snapshot's recovery. */
  private async recover(snapshot: InflightSnapshot): Promise<'replayed' | 'completed' | 'interrupted'> {
    const recovery = this.deps.recovery
    const agent = recovery === undefined ? undefined : await recovery.liveAgent(snapshot)
    if (recovery === undefined || agent === undefined) {
      await this.settleInterrupted(snapshot, false)
      return 'interrupted'
    }
    const policy = recovery.policy()
    const state = snapshot.message === undefined
      ? { kind: 'interrupted' as const }
      : classifyTurn(agent.session.snapshotEvents(), snapshot.message.id)
    // A replay streams into the main card, so that card must still be patchable.
    if (state.kind === 'pending' && snapshot.message !== undefined && policy.pending
      && (snapshot.replays ?? 0) < 1 && snapshot.cards[0]?.mode === 'card') {
      await this.deps.domain()?.inflight.put(snapshot.key, { ...snapshot, replays: (snapshot.replays ?? 0) + 1, attempts: 0 })
      recovery.replay(agent, snapshot, userMessageOf(snapshot.message))
      return 'replayed'
    }
    if (state.kind === 'completed') {
      await this.settleCompleted(snapshot, state.text)
      return 'completed'
    }
    await this.settleInterrupted(snapshot, policy.interrupted === 'ask')
    return 'interrupted'
  }

  private requireChannel(): FeishuChannel {
    const channel = this.deps.channel()
    if (channel === undefined) throw new Error('dsh-channels: channel not started')
    return channel
  }

  /** Patch the cards of a cut-off turn to the interrupted state. */
  private async settleInterrupted(snapshot: InflightSnapshot, offerResume: boolean): Promise<void> {
    const channel = this.requireChannel()
    const resume = offerResume
      ? { sessionId: snapshot.sessionId, ...(snapshot.triggerMessageId === undefined ? {} : { triggerMessageId: snapshot.triggerMessageId }) }
      : undefined
    for (const [index, card] of snapshot.cards.entries()) {
      if (card.mode !== 'card') continue
      // Full replacement: the interrupted card's streamed content lived only
      // in the previous process. Continuation cards keep their segment header.
      await channel.updateCard(card.messageId, buildInterruptionCard(segmentCardOptions(index), resume))
    }
    await this.settleReaction(channel, snapshot)
  }

  /** Patch the cards of a turn that completed unseen with its final reply. */
  private async settleCompleted(snapshot: InflightSnapshot, text: string): Promise<void> {
    const channel = this.requireChannel()
    const cards = buildRecoveredReplyCards(text, snapshot.cards.length)
    for (const [index, card] of snapshot.cards.entries()) {
      if (card.mode !== 'card') continue
      await channel.updateCard(card.messageId, cards[index]!)
    }
    await this.settleReaction(channel, snapshot)
  }

  /** Swap the trigger's Typing reaction to DONE (best-effort). */
  private async settleReaction(channel: FeishuChannel, snapshot: InflightSnapshot): Promise<void> {
    const trigger = snapshot.triggerMessageId
    if (trigger === undefined) return
    if (snapshot.reactionId !== undefined) {
      await channel.removeReaction(trigger, snapshot.reactionId).catch(() => {})
    }
    await channel.addReaction(trigger, 'DONE').catch(() => {})
  }
}

/** Rebuild the prompt stored in a snapshot. */
function userMessageOf(stored: NonNullable<InflightSnapshot['message']>): UserMessage {
  return {
    id: stored.id as UserMessage['id'],
    role: 'user',
    content: stored.content,
    source: stored.source,
  }
}
