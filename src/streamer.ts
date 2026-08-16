/**
 * Per-turn streaming card state: folds live session events into card snapshots
 * and patches the Feishu card on a fixed refresh interval (default 500 ms).
 *
 * Lifecycle per (session, user message):
 *  1. `attach()` — the reply card was just sent; bind it to the session.
 *  2. `session/event` consumption — text deltas fill the body, reasoning
 *     deltas fill the fold panel, usage/header events advance the stats fold.
 *  3. `turnEnded(turn)` — finalize that turn's card (`回复结束`) and request
 *     the Typing → DONE reaction swap on the triggering message.
 *
 * The first visible text delta flips the panel title 推理中 → 回复中; the
 * final patch flips it to 回复结束. Patching is throttled to `refreshMs` and
 * only runs when the content actually changed.
 *
 * @module dsh-channels/streamer
 */

import type { Session, SessionEvent } from './dsh-types.ts'
import { buildCard } from './cards.ts'
import type { CardState } from './cards.ts'
import type { FeishuChannel } from './feishu-channel.ts'
import { cacheHitPct, foldAll, foldEvent } from './stats.ts'
import type { StatsFold } from './stats.ts'

export interface StreamerHooks {
  /** Fetch current context pressure for one session (may be expensive → cached by caller). */
  measureContext(session: Session): { contextTokens?: number; contextWindow?: number }
  /** Resolve the session id label shown on the card. */
  sessionLabel(sessionId: string): string
  /** Log a non-fatal streaming error. */
  onError(sessionId: string, error: unknown): void
  /** Invoked once when a turn's card reaches its final state. */
  onTurnFinalized(sessionId: string, turn: number): void
}

interface TurnState {
  /** Turn number once known; undefined until the first `step/start`. */
  turn: number | undefined
  /** The card message this turn streams into. */
  cardMessageId: string
  /** Message whose reaction carries Typing → DONE. */
  triggerMessageId: string
  /** Reaction id of the Typing reaction (undefined when the add failed). */
  reactionId: string | undefined
  phase: CardState['phase']
  reasoning: string
  body: string
  dirty: boolean
  lastPatchAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  finalized: boolean
}

export class TurnStreamer {
  private readonly channel: FeishuChannel
  private readonly refreshMs: number
  private readonly hooks: StreamerHooks
  /** sessionId → queue of turn states (FIFO consumption of the driver). */
  private readonly bySession = new Map<string, TurnState[]>()
  /** sessionId → session-log stats fold (session cumulative). */
  private readonly folds = new Map<string, StatsFold>()
  /** sessionId → the Session object for context measurement. */
  private readonly sessions = new Map<string, Session>()
  /** sessionId → context pressure cache (refreshed every N patches). */
  private readonly contextCache = new Map<string, { contextTokens?: number; contextWindow?: number }>()

  constructor(channel: FeishuChannel, refreshMs: number, hooks: StreamerHooks) {
    this.channel = channel
    this.refreshMs = refreshMs
    this.hooks = hooks
  }

  /** Bind a freshly sent reply card to a session; seeds the stats fold from the log. */
  attach(session: Session, cardMessageId: string, triggerMessageId: string, reactionId: string | undefined): void {
    this.sessions.set(session.id, session)
    let fold = this.folds.get(session.id)
    if (fold === undefined) {
      fold = foldAll(session.events)
      this.folds.set(session.id, fold)
    }
    const queue = this.bySession.get(session.id) ?? []
    queue.push({
      turn: undefined,
      cardMessageId,
      triggerMessageId,
      reactionId,
      phase: 'thinking',
      reasoning: '',
      body: '',
      dirty: true,
      lastPatchAt: 0,
      timer: undefined,
      finalized: false,
    })
    this.bySession.set(session.id, queue)
  }

  /** Drop all state for a session (agent disposed / route removed). */
  detach(sessionId: string): void {
    const queue = this.bySession.get(sessionId) ?? []
    for (const state of queue) {
      if (state.timer !== undefined) clearTimeout(state.timer)
    }
    this.bySession.delete(sessionId)
    this.folds.delete(sessionId)
    this.sessions.delete(sessionId)
    this.contextCache.delete(sessionId)
  }

  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  /** The front (oldest unfinished) turn state of a session. */
  private front(sessionId: string): TurnState | undefined {
    const queue = this.bySession.get(sessionId)
    if (queue === undefined || queue.length === 0) return undefined
    for (const state of queue) {
      if (!state.finalized) return state
    }
    return undefined
  }

  /** Consume one appended session event. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const fold = this.folds.get(session.id)
    if (fold !== undefined) foldEvent(fold, event)
    this.sessions.set(session.id, session)

    const state = this.front(session.id)
    if (state === undefined) return

    switch (event.type) {
      case 'step/start': {
        if (state.turn === undefined) {
          state.turn = event.data.turn
          this.markDirty(session.id, state)
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (state.turn === undefined) state.turn = event.data.turn
        switch (chunk.type) {
          case 'text-delta': {
            state.body += chunk.text
            if (state.phase === 'thinking') state.phase = 'replying'
            this.markDirty(session.id, state)
            break
          }
          case 'reasoning-delta': {
            state.reasoning += chunk.text
            this.markDirty(session.id, state)
            break
          }
          default:
            break
        }
        break
      }
      case 'turn/end': {
        // The ended turn belongs to the front state: assign it if a turn was
        // rejected/emptied before any step started.
        if (state.turn === undefined) state.turn = event.data.turn
        this.finalize(session.id, state)
        break
      }
      default:
        break
    }
  }

  private markDirty(sessionId: string, state: TurnState): void {
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

  private statsFor(sessionId: string): CardState['stats'] {
    const fold = this.folds.get(sessionId)
    const lastUsage = fold?.lastUsage
    const header = fold?.lastHeader
    const cached = this.contextCache.get(sessionId)
    const session = this.sessions.get(sessionId)
    let context = cached
    if (session !== undefined) {
      try {
        context = this.hooks.measureContext(session)
        this.contextCache.set(sessionId, context)
      } catch {
        context = cached
      }
    }
    return {
      sessionId: this.hooks.sessionLabel(sessionId),
      inputTokens: fold?.totals.inputTokens ?? 0,
      outputTokens: fold?.totals.outputTokens ?? 0,
      cacheHitPct: cacheHitPct(lastUsage),
      contextTokens: context?.contextTokens,
      contextWindow: context?.contextWindow,
      model: header?.model,
      effort: header?.effort,
    }
  }

  private flush(sessionId: string, state: TurnState): void {
    state.lastPatchAt = Date.now()
    if (!state.dirty) return
    state.dirty = false
    const card = buildCard({
      phase: state.phase,
      reasoning: state.reasoning,
      body: state.body,
      stats: this.statsFor(sessionId),
    })
    this.channel.updateCard(state.cardMessageId, card).catch((error: unknown) => {
      this.hooks.onError(sessionId, error)
    })
  }

  private finalize(sessionId: string, state: TurnState): void {
    if (state.finalized) return
    state.finalized = true
    state.phase = 'done'
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    // Final patch with the settled content and stats.
    const card = buildCard({
      phase: 'done',
      reasoning: state.reasoning,
      body: state.body,
      stats: this.statsFor(sessionId),
    })
    this.channel.updateCard(state.cardMessageId, card).catch((error: unknown) => {
      this.hooks.onError(sessionId, error)
    })

    // Reaction swap: Typing → DONE on the triggering message.
    void this.swapReaction(state)

    // Prune the finalized state lazily (kept until the next attach so the
    // front-scan skips it, then removed).
    void Promise.resolve().then(() => {
      const queue = this.bySession.get(sessionId)
      if (queue === undefined) return
      const index = queue.indexOf(state)
      if (index >= 0) queue.splice(index, 1)
    })

    this.hooks.onTurnFinalized(sessionId, state.turn ?? 0)
  }

  private async swapReaction(state: TurnState): Promise<void> {
    try {
      if (state.reactionId !== undefined) {
        await this.channel.removeReaction(state.triggerMessageId, state.reactionId)
      }
      await this.channel.addReaction(state.triggerMessageId, 'DONE')
    } catch (error) {
      // Reaction failures are cosmetic: never surface them to the user.
      this.hooks.onError(state.triggerMessageId, error)
    }
  }
}
