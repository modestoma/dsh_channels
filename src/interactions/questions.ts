/**
 * HITL structured-question answerer: turns the host's
 * `user-questions/request` waterfall events (the model's `ask_user_question`
 * tool) into standalone Feishu cards.
 *
 * The host's only shipped answerer is the Web client, so a Feishu-only
 * session otherwise fails every `ask_user_question` call with `NO_PROVIDER`.
 * This answerer is registered with `prepend: true` on the plugin context:
 * requests for a session this channel routes are claimed here, everything else
 * delegates through `next()`.
 *
 * Rendering lives in `cards/question.ts`; the shared pending-card lifecycle
 * lives in `interactions/pending.ts`.
 *
 * Deliberately unsupported in v1: questions that declare no options (a card
 * cannot ask for them); such a request fails with an explicit error instead of
 * hanging.
 *
 * @module dsh-channels/interactions/questions
 */

import { randomUUID } from 'node:crypto'
import { buildQuestionCard, buildQuestionSettledCard } from '../cards/question.ts'
import type { QuestionCardInput, QuestionCardItem, QuestionCardState } from '../cards/question.ts'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent } from '../dsh-types.ts'
import type { CardActionEvent, FeishuChannel } from '../feishu-channel.ts'
import { PendingCardTable } from './pending.ts'
import type { InteractionRoute, PendingCardEntry } from './pending.ts'

export interface QuestionHooks {
  /**
   * Resolve the Feishu placement for a session. `undefined` means the session
   * is not owned by this channel — the answerer delegates through `next()`.
   */
  routeFor(sessionId: string): InteractionRoute | undefined
  /** Log a non-fatal error (delivery/update failures). */
  onError(sessionId: string, error: unknown): void
}

/** One in-flight question set: card content, partial answers, resolver. */
interface PendingQuestions extends PendingCardEntry {
  questions: QuestionCardItem[]
  /** Multi-select toggles not yet submitted, by question id. */
  selected: Map<string, string[]>
  /** Committed answers, by question id. */
  answered: Map<string, string[]>
  /** Free-text answers supplied by a plain reply, by question id. */
  custom: Map<string, string>
  /** Host owns the deadline (timed wait): no local timer is armed. */
  hostTimed: boolean
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
}

/** Normalize one host question into its renderable form. */
function normalizeQuestion(item: AskUserQuestionItem): QuestionCardItem {
  const intent = item.intent
  return {
    id: item.id,
    question: item.question,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.header === undefined ? {} : { header: item.header }),
    options: (item.options ?? []).map(option => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    multiSelect: item.multiSelect === true,
    ...(intent?.kind === 'plan-review' ? { intentApproved: intent.approve } : {}),
  }
}

export class QuestionAnswerer {
  private readonly table: PendingCardTable<PendingQuestions>

  constructor(
    channel: FeishuChannel,
    private readonly hooks: QuestionHooks,
    private readonly timeoutMs: number,
  ) {
    this.table = new PendingCardTable(channel, hooks.onError)
  }

  /** In-flight question-set count (diagnostics/tests). */
  pendingCount(): number {
    return this.table.count()
  }

  /**
   * The `user-questions/request` waterfall listener. Non-owned sessions and
   * questions without options delegate through `next()`.
   */
  onRequest(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (agent === undefined) return next()
    const route = this.hooks.routeFor(agent.session.id)
    if (route === undefined) return next()

    const questions = request.questions.map(normalizeQuestion)
    if (questions.length === 0) return next()

    const token = randomUUID()
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const entry: PendingQuestions = {
        token,
        sessionId: agent.session.id,
        route,
        messageId: undefined,
        settled: false,
        timer: undefined,
        signal: request.signal,
        onAbort: undefined,
        unauthorizedNoted: false,
        questions,
        selected: new Map(),
        answered: new Map(),
        custom: new Map(),
        hostTimed: request.wait?.timed === true,
        resolve,
        reject,
      }
      const onAbort = (): void => {
        const reason = request.signal?.reason
        entry.reject(reason instanceof Error ? reason : new Error('dsh-channels: 提问已被取消。'))
        this.close(entry, 'cancelled')
      }
      entry.onAbort = onAbort
      if (request.signal?.aborted === true) {
        reject(new Error('dsh-channels: 提问已被取消。'))
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.table.add(entry)
      void this.table.deliver(entry, {
        card: buildQuestionCard(this.cardInput(entry)),
        onWithdrawn: e => this.table.patch(e, buildQuestionSettledCard(this.cardInput(e), 'cancelled')),
        // A timed wait is owned by the host: its signal settles the request at
        // the deadline (rejection with ASK_TIMED_OUT becomes a continued
        // question). Only blocking asks need a local timer.
        onDelivered: e => {
          if (e.hostTimed) return
          this.table.armTimeout(e, this.timeoutMs, () => {
            e.reject(new Error('dsh-channels: ask_user_question 等待超时，未收到回答。'))
            this.close(e, 'expired')
          })
        },
        onFailure: (e, error) => {
          this.table.close(e, () => {})
          e.reject(error instanceof Error ? error : new Error(String(error)))
        },
      })
    })
  }

  /** Snapshot the current selections for rendering. */
  private cardInput(entry: PendingQuestions): QuestionCardInput {
    const selected: Record<string, string[]> = {}
    for (const [id, labels] of entry.selected) selected[id] = [...labels]
    return {
      token: entry.token,
      questions: entry.questions,
      timeoutMs: this.timeoutMs,
      sessionId: entry.sessionId,
      selected,
      answered: [...entry.answered.keys()],
      ...(entry.unauthorizedNoted ? { unauthorizedNote: true } : {}),
    }
  }

  /**
   * Route one card button-callback event to its pending question set.
   * Unknown cards and non-owner operators are ignored (a non-owner click adds
   * the owner-only notice once); owner decisions settle the request.
   */
  onCardAction(event: CardActionEvent): void {
    const entry = this.table.resolveAction(event, candidate => {
      if (candidate.unauthorizedNoted) return
      candidate.unauthorizedNoted = true
      this.table.patch(candidate, buildQuestionCard(this.cardInput(candidate)))
    })
    if (entry === undefined) return
    const value = event.action.value as
      | { decision?: unknown; id?: unknown; value?: unknown }
      | undefined
    const decision = value?.decision
    const id = typeof value?.id === 'string' ? value.id : undefined
    const option = typeof value?.value === 'string' ? value.value : undefined
    if (id === undefined) return
    const question = entry.questions.find(item => item.id === id)
    if (question === undefined || entry.answered.has(id)) return

    if (decision === 'question-answer' && option !== undefined) {
      entry.answered.set(id, [option])
      this.table.patch(entry, buildQuestionCard(this.cardInput(entry)))
      this.resolveIfComplete(entry)
      return
    }
    if (decision === 'question-toggle' && option !== undefined) {
      const current = new Set(entry.selected.get(id) ?? [])
      if (current.has(option)) current.delete(option)
      else current.add(option)
      entry.selected.set(id, [...current])
      this.table.patch(entry, buildQuestionCard(this.cardInput(entry)))
      return
    }
    if (decision === 'question-submit') {
      const chosen = entry.selected.get(id) ?? []
      if (chosen.length === 0) return
      entry.answered.set(id, [...chosen])
      this.table.patch(entry, buildQuestionCard(this.cardInput(entry)))
      this.resolveIfComplete(entry)
    }
  }

  /** Complete the waterfall once every question has a committed answer. */
  private resolveIfComplete(entry: PendingQuestions): void {
    if (entry.questions.some(question => !entry.answered.has(question.id))) return
    const answer: AskUserQuestionAnswer = {
      answers: entry.questions.map(question => ({
        id: question.id,
        selected: entry.answered.get(question.id) ?? [],
        ...(entry.custom.has(question.id) ? { custom: entry.custom.get(question.id) } : {}),
      })),
    }
    const closed = this.table.close(entry, () => {
      this.table.patch(entry, buildQuestionSettledCard(this.cardInput(entry), 'answered'))
    })
    if (closed) entry.resolve(answer)
  }

  /**
   * Feed one plain reply as a free-text answer.
   *
   * A session blocked on `ask_user_question` has no other use for an inbound
   * text message, so the next unanswered question consumes it as its "Other"
   * answer. Returns false when the session has no pending question.
   */
  submitText(sessionId: string, text: string): boolean {
    const trimmed = text.trim()
    if (trimmed === '') return false
    const entry = [...this.table.values()].find(candidate =>
      candidate.sessionId === sessionId && !candidate.settled)
    if (entry === undefined) return false
    const question = entry.questions.find(candidate => !entry.answered.has(candidate.id))
    if (question === undefined) return false
    entry.answered.set(question.id, [])
    entry.custom.set(question.id, trimmed)
    this.table.patch(entry, buildQuestionCard(this.cardInput(entry)))
    this.resolveIfComplete(entry)
    return true
  }

  /** Whether a session currently has an unanswered question set. */
  hasPendingFor(sessionId: string): boolean {
    return [...this.table.values()].some(candidate => candidate.sessionId === sessionId && !candidate.settled)
  }

  /** Withdraw every in-flight question (plugin shutdown). */
  dispose(): void {
    this.table.withdrawAll(entry => {
      entry.reject(new Error('dsh-channels: 插件已关闭，提问未完成。'))
      this.close(entry, 'cancelled')
    })
  }

  /** Settle once and patch the card to its terminal state. */
  private close(entry: PendingQuestions, state: QuestionCardState): void {
    this.table.close(entry, () => {
      this.table.patch(entry, buildQuestionSettledCard(this.cardInput(entry), state))
    })
  }
}
