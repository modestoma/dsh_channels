/**
 * In-flight turn snapshots and the startup repair pass.
 *
 * Every streaming turn records the credentials needed to settle its cards if
 * the process dies mid-turn (trigger message, Typing reaction, segment card
 * ids). The snapshot is keyed by the turn's MAIN card message id — unique per
 * turn — so overlapping turns never overwrite each other. On the next boot
 * `repairAll()` patches each interrupted card to its terminal state and drops
 * the snapshot.
 *
 * @module dsh-channels/session/repair
 */

import { buildInterruptionCard } from '../cards/streaming.ts'
import type { InflightSnapshot } from '../domain.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { FeishuDomainHandle } from '../domain.ts'

export interface InflightRepairDeps {
  /** The opened domain handle, or undefined before `start()` / after shutdown. */
  domain(): FeishuDomainHandle | undefined
  /** The live channel, or undefined before `start()` / after shutdown. */
  channel(): FeishuChannel | undefined
  /** Route retirement TTL; snapshots older than it are the GC pass's job. */
  ttlMs(): number
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
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
   * Startup repair pass: settle every card a previous instance left
   * mid-flight. Runs in the background right after the long connection is
   * established; each snapshot is independent and best-effort.
   *
   * Per snapshot: patch every `card`-mode card to the terminal interrupted
   * state (the partial body is gone with the old process; patch is full
   * replacement), best-effort swap Typing → DONE, then delete. A failed card
   * patch keeps the snapshot for one more attempt (capped at 2) so a
   * transient failure at boot does not lose the repair, while a medium that
   * permanently rejects the patch cannot trigger an endless retry loop.
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
    this.deps.info('dsh-channels: repairing %d interrupted turn(s)', due.length)
    for (const [key, snapshot] of due) {
      try {
        await this.repairSnapshot(snapshot)
        await table.delete(key)
        this.deps.info('dsh-channels: repaired interrupted turn card %s', key)
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

  /** Patch the cards of one interrupted turn to their terminal state. */
  private async repairSnapshot(snapshot: InflightSnapshot): Promise<void> {
    const channel = this.deps.channel()
    if (channel === undefined) throw new Error('dsh-channels: channel not started')
    for (const [index, card] of snapshot.cards.entries()) {
      if (card.mode !== 'card') continue
      // Full replacement: the interrupted card's streamed content lived only
      // in the previous process. Continuation cards keep their segment header.
      const options = index === 0 ? {} : { panel: false, segment: index + 1 }
      await channel.updateCard(card.messageId, buildInterruptionCard(options))
    }
    if (snapshot.reactionId !== undefined) {
      await channel.removeReaction(snapshot.triggerMessageId, snapshot.reactionId).catch(() => {})
    }
    await channel.addReaction(snapshot.triggerMessageId, 'DONE').catch(() => {})
  }
}
