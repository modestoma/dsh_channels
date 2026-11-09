/**
 * Card delivery for streaming turns: throttled patches, overflow splitting
 * into continuation segment cards, serialized segment sends with retries,
 * the settled patches and the trigger reaction swap.
 *
 * Patching is throttled to `refreshMs` and only runs when the content
 * changed. Segment sends are serialized per session so cards arrive in
 * order. Rendering a snapshot is delegated to the `render` callback, which
 * owns the card state composition (`TurnStreamer`).
 *
 * @module dsh-channels/turn/delivery
 */

import { buildCard, buildMergedCard, segmentCardContent, segmentCardOptions } from '../cards/index.ts'
import type { CardState } from '../cards/index.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import { freshSegment } from './state.ts'
import type { UserMessage } from '../host/index.ts'
import type { SegmentDelivery, TriggerReaction, TurnState } from './state.ts'

/** Delivery callbacks; documented on `StreamerHooks`, which extends this interface. */
export interface DeliveryHooks {
  /** Log a non-fatal streaming error. */
  onError(sessionId: string, error: unknown): void
  /**
   * Invoked when a continuation segment's message id resolves (delivery
   * succeeded). Lets the caller fold the resolved id into the turn's repair
   * snapshot. `segmentIndex` is the card index within the turn (`0` is the
   * main card; never reported).
   */
  onSegmentDelivered?(
    mainCardMessageId: string,
    segmentIndex: number,
    messageId: string,
    mode: SegmentDelivery['mode'],
  ): void
  /**
   * Send one continuation segment card for a turn (calls arrive in segment
   * order per session). Implementations may fall back to a plain-text message
   * (reporting `mode: 'text'`) when the card is rejected — e.g. Feishu's
   * per-card table limit (error 11310) — so the content always reaches the
   * user. `fallbackText` carries the raw segment body for that fallback.
   */
  sendSegmentCard(
    sessionId: string,
    segment: number,
    card: object,
    fallbackText: string,
  ): Promise<SegmentDelivery>
  /**
   * A host turn's main card was delivered (see `StreamerHooks.hostTurnOrigin`);
   * the returned promise settles before any later card of that turn is sent,
   * so a restart snapshot written here precedes its segment updates.
   */
  onHostCardDelivered?(sessionId: string, messageId: string, mode: 'card' | 'text', message: UserMessage): Promise<void>
  /**
   * Patch a card of a finalized turn to its settled content. Absent: one
   * `updateCard` attempt. Implementations retry until it lands.
   */
  settlePatch?(messageId: string, card: object): void
  /**
   * Swap the trigger message's reaction when a turn settles. Absent: one
   * attempt. Implementations retry until it lands.
   */
  settleReaction?(messageId: string, removeReactionId: string | undefined, add: string): void
  /**
   * Send a segment card of a finalized turn whose send failed (after the
   * in-turn retries), so its content still reaches the user. Absent: the
   * content is lost.
   */
  resendSegment?(sessionId: string, segment: number, card: object, fallbackText: string): void
}

/** Renders one card of a turn: `body` is the card's segment body, `index` its position. */
export type CardRenderer = (sessionId: string, state: TurnState, body: string, index: number) => CardState

export class CardDelivery {
  /** sessionId → serialized segment-send chain (keeps card order). */
  private readonly segmentChains = new Map<string, Promise<void>>()

  constructor(
    private readonly channel: FeishuChannel,
    private readonly refreshMs: number,
    private readonly hooks: DeliveryHooks,
    private readonly render: CardRenderer,
  ) {}

  /** Forget a session's segment-send chain. */
  forget(sessionId: string): void {
    this.segmentChains.delete(sessionId)
  }

  /** Schedule a throttled flush of the turn's cards. */
  markDirty(sessionId: string, state: TurnState): void {
    if (state.disposed) return
    state.dirty = true
    if (state.timer !== undefined) return
    const wait = state.lastPatchAt === 0
      ? this.refreshMs
      : Math.max(0, this.refreshMs - (Date.now() - state.lastPatchAt))
    state.timer = setTimeout(() => {
      state.timer = undefined
      this.flush(sessionId, state)
    }, wait)
  }

  /**
   * Deliver a settled turn: freeze the tail and spawn any remaining segment
   * cards, patch every card with its settled content (backoff is bypassed
   * once so the final state always lands; late-arriving sends are patched
   * when they resolve), hand never-delivered segments to `resendSegment`,
   * and swap the trigger reactions: Typing → DONE on success, Typing → No on
   * failure. A dropped message was never answered: it settles like a failure.
   */
  settle(sessionId: string, state: TurnState): void {
    this.splitOverflow(sessionId, state)
    for (const [index] of state.cards.entries()) {
      this.patchCard(sessionId, state, index, true, false)
      this.resend(sessionId, state, index)
    }
    const failed = state.phase === 'error' || state.dropped
    for (const trigger of [state, ...state.mergedTriggers]) void this.swapReaction(trigger, failed)
  }

  /**
   * Patch a merged queued card into its terminal notice, with up to two
   * retries (1s / 2s backoff) so a transient failure does not leave a stale
   * queued card whose button no longer acts.
   */
  async settleMergedCard(sessionId: string, messageId: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.channel.updateCard(messageId, buildMergedCard())
        return
      } catch (error) {
        lastError = error
        if (attempt < 2) await this.delay(1_000 * 2 ** attempt)
      }
    }
    this.hooks.onError(sessionId, lastError)
  }

  /**
   * Serialize one continuation-card send per session (order on Feishu), with
   * up to two retries (1s / 2s backoff) for transient failures. When delivery
   * resolves as a text fallback the segment is frozen and further growth
   * continues in a new segment — text messages cannot be patched afterwards.
   */
  sendSegment(sessionId: string, state: TurnState, index: number): void {
    const card = state.cards[index]
    if (card === undefined || card.failed || card.sending || state.disposed) return
    card.sending = true

    const previous = this.segmentChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const snapshot = buildCard(this.render(sessionId, state, card.body, index), segmentCardOptions(index))
          const sentBody = card.body
          const delivery = await this.hooks.sendSegmentCard(sessionId, index + 1, snapshot, sentBody)
          card.sending = false
          card.messageId = delivery.messageId
          card.mode = delivery.mode
          // A turn that settled before its card arrived needs no restart snapshot.
          if (index === 0 && state.origin !== undefined && state.message !== undefined && !state.finalized) {
            await this.hooks.onHostCardDelivered?.(sessionId, delivery.messageId, delivery.mode, state.message)
          }
          this.hooks.onSegmentDelivered?.(
            state.cards[0]?.messageId ?? '',
            index,
            delivery.messageId,
            delivery.mode,
          )
          if (delivery.mode === 'card') {
            card.dirty = true
            this.markDirty(sessionId, state)
          } else if (!card.frozen && !state.disposed) {
            // Text fallback: this card is final; keep streaming into a new one,
            // which also carries whatever arrived while the text was sent.
            card.frozen = true
            if (state.cards[state.cards.length - 1] === card) {
              const pending = card.body.startsWith(sentBody) ? card.body.slice(sentBody.length) : ''
              card.body = sentBody
              state.cards.push(freshSegment(pending))
            }
            this.markDirty(sessionId, state)
          }
          return
        } catch (error) {
          lastError = error
          if (attempt >= 2 || state.disposed) break
          await this.delay(1_000 * 2 ** attempt)
        }
      }
      card.sending = false
      card.failed = true
      this.hooks.onError(sessionId, lastError)
      if (state.finalized) this.resend(sessionId, state, index)
    })
    this.segmentChains.set(sessionId, next.then(() => {}, () => {}))
  }

  private flush(sessionId: string, state: TurnState): void {
    state.lastPatchAt = Date.now()
    const turnDirty = state.dirty
    if (state.dirty) {
      state.dirty = false
      this.splitOverflow(sessionId, state)
    }
    for (const [index] of state.cards.entries()) {
      this.patchCard(sessionId, state, index, false, turnDirty)
    }
  }

  /**
   * Freeze the newest card once its body stops fitting its budget (bytes or
   * the per-card table cap) and move the overflow into fresh segment cards
   * (their sends are chained in order).
   */
  private splitOverflow(sessionId: string, state: TurnState): void {
    for (;;) {
      const index = state.cards.length - 1
      const card = state.cards[index]
      if (card === undefined || card.frozen || card.mode === 'text') return

      const split = segmentCardContent(this.render(sessionId, state, card.body, index), segmentCardOptions(index))
      if (split.head === '') {
        // Degenerate budget (cannot happen with the real fixed overhead):
        // keep streaming into this card; buildCard's absolute clip still
        // guards the card size.
        return
      }
      if (split.tail === '') {
        card.body = split.head
        card.dirty = true
        // A card with content but no message id yet (e.g. the continuation of
        // a text-fallback segment) needs its own send, not just a patch.
        if (card.messageId === undefined && !card.sending && !card.failed && card.body !== '') {
          this.sendSegment(sessionId, state, index)
        }
        return
      }

      card.body = split.head
      card.frozen = true
      card.dirty = true
      state.cards.push(freshSegment(split.tail))
      this.sendSegment(sessionId, state, state.cards.length - 1)
    }
  }

  /** Patch one card when due; failed updates retry with exponential backoff
   *  (logged on the first failure and every 10th — no per-flush spam).
   *
   *  The patch gate covers both per-card body growth (`card.dirty`) and
   *  turn-scoped snapshot changes (`turnDirty`: phase, reasoning, activity
   *  line, session stats), so activity-only events still reach the card. */
  private patchCard(sessionId: string, state: TurnState, index: number, force: boolean, turnDirty: boolean): void {
    const card = state.cards[index]
    if (card === undefined || card.messageId === undefined || card.mode === 'text' || card.failed) return
    const now = Date.now()
    if (!force && !card.dirty && !turnDirty) return
    if (!force && card.nextRetryAt > now) return
    card.dirty = false
    const snapshot = buildCard(this.render(sessionId, state, card.body, index), segmentCardOptions(index))
    if (state.finalized && this.hooks.settlePatch !== undefined) {
      this.hooks.settlePatch(card.messageId, snapshot)
      return
    }
    this.channel.updateCard(card.messageId, snapshot).catch((error: unknown) => {
      card.dirty = true
      card.failures++
      card.nextRetryAt = Date.now() + Math.min(1_000 * 2 ** Math.min(card.failures, 6), 60_000)
      if (card.failures === 1 || card.failures % 10 === 0) {
        this.hooks.onError(sessionId, error)
      }
    })
  }

  /** Hand a finalized turn's never-delivered segment with content to `resendSegment`. */
  private resend(sessionId: string, state: TurnState, index: number): void {
    const card = state.cards[index]
    if (card === undefined || !card.failed || card.messageId !== undefined || card.body.trim() === '') return
    this.hooks.resendSegment?.(sessionId, index + 1, buildCard(this.render(sessionId, state, card.body, index), segmentCardOptions(index)), card.body)
  }

  private async swapReaction(trigger: TriggerReaction, failed: boolean): Promise<void> {
    if (trigger.triggerMessageId === undefined) return
    if (this.hooks.settleReaction !== undefined) {
      this.hooks.settleReaction(trigger.triggerMessageId, trigger.reactionId, failed ? 'No' : 'DONE')
      return
    }
    try {
      if (trigger.reactionId !== undefined) {
        await this.channel.removeReaction(trigger.triggerMessageId, trigger.reactionId)
      }
      await this.channel.addReaction(trigger.triggerMessageId, failed ? 'No' : 'DONE')
    } catch (error) {
      // Reaction failures are cosmetic: never surface them to the user.
      this.hooks.onError(trigger.triggerMessageId, error)
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
