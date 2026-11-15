/**
 * Card button clicks: one dispatch over every card's handler, and the
 * handlers for the buttons on a turn's own cards (stop, steer a queued
 * message, continue an interrupted turn, retry an ended approval, pick an
 * option of a picker card).
 *
 * @module dsh-channels/routing/card-actions
 */

import { mkdir } from 'node:fs/promises'
import type { AccessController } from '../access/controller.ts'
import { principalOnRoute } from '../access/principal.ts'
import { RESERVED_DISMISS_ACTION_ID } from '../actions/contract.ts'
import { hasPendingActions, isActionProposalExpired } from '../actions/store.ts'
import type { ActionProposalStore } from '../actions/store.ts'
import {
  buildActionProposalCard, buildApprovalSettledCard, buildPrunedActionProposalCard, initialStreamingCard,
  parseActionProposalClick, parseApprovalRetryAction, parsePickAction, parseResumeAction,
  queuedStreamingCard, STEER_ACTION, STOP_ACTION,
} from '../cards/index.ts'
import type { RouteOperationQueue } from '../commands.ts'
import { isGroupRoute } from '../domain.ts'
import type { CardDelivery } from '../feishu/delivery.ts'
import type { CardActionEvent, FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'
import type { HostContext, SessionId } from '../host/index.ts'
import { approvalRetryPrompt } from '../interactions/approvals.ts'
import type { ApprovalCardRecord, ApprovalStore } from '../interactions/approval-store.ts'
import type { Outbox } from '../outbox.ts'
import type { SessionManager } from '../session/manager.ts'
import { channelPrompt, storablePrompt } from '../session/prompt.ts'
import type { ChannelPrompt } from '../session/prompt.ts'
import type { InflightRepair } from '../session/repair.ts'
import type { RouteStore } from '../session/routes.ts'
import { steerQueued } from '../session/submit.ts'
import type { SubmissionOutcome, TurnCard } from '../session/submit.ts'
import type { Agent } from '../host/index.ts'
import type { TurnStreamer } from '../turn/streamer.ts'

/** Prompt of the turn an interrupted card's continue button starts. */
export const RESUME_PROMPT = '服务重启打断了上一轮回复。继续前先核对实际状态：工作目录里的文件和 git 状态、远端分支和 MR、已经发出的消息或文件。已经完成的对外操作不要重做，包括推送、创建或评论 MR、发送文件、写知识库；结果不确定的先查清楚。确认后从中断处继续完成上一轮的任务。'

/** One card's click handler; it ignores clicks that are not its card's. */
export interface CardActionHandler {
  /** Names the handler in the failure log. */
  readonly label: string
  handle(event: CardActionEvent): unknown
}

/**
 * Offer one click to every handler. A handler that throws or rejects is
 * logged and never keeps the others from seeing the click.
 * @param event - the click.
 * @param handlers - every card's handler.
 * @param warn - failure log.
 */
export function dispatchCardAction(
  event: CardActionEvent,
  handlers: readonly CardActionHandler[],
  warn: (message: string, ...args: unknown[]) => void,
): void {
  for (const handler of handlers) {
    const fail = (error: unknown): void => { warn('dsh-channels: %s action failed: %s', handler.label, String(error)) }
    try {
      const result = handler.handle(event)
      if (result instanceof Promise) result.catch(fail)
    } catch (error) {
      fail(error)
    }
  }
}

export interface TurnCardActionsDeps {
  ctx: HostContext
  started(): boolean
  channel(): FeishuChannel | undefined
  streamer(): TurnStreamer | undefined
  routes: RouteStore
  access: AccessController
  sessions: SessionManager
  repair: InflightRepair
  approvals: ApprovalStore
  actionProposals: ActionProposalStore
  patchProposalCard?(proposalId: string, cardMessageId: string, card: object): Promise<void>
  outbox: Outbox
  delivery: CardDelivery
  queue: RouteOperationQueue
  /** Bind a card to the turn a prompt starts and submit the prompt. */
  runTurn(agent: Agent, prompt: ChannelPrompt, card: TurnCard): Promise<SubmissionOutcome>
  /** Run one slash-command line as if the operator had typed it. */
  runCommand(msg: NormalizedMessage, line: string): Promise<void>
  now?(): number
}

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Assemble the model-facing user text produced when an action proposal button is selected. */
export function formatActionSelectedPrompt(id: string, label: string, followUpPrompt: string): string {
  return `<feishu_action_selected id="${escapeXmlAttr(id)}" label="${escapeXmlAttr(label)}"/>\n\n${followUpPrompt}`
}

/** Buttons on a turn's own cards. */
export class TurnCardActions {
  /** Interrupted cards whose continue button already started a turn. */
  private readonly resumedCards = new Set<string>()
  /** Approval cards whose 「重新发起」 click is being handled or was handled (once per card). */
  private readonly retriedApprovalCards = new Set<string>()
  /** `<proposalId>:<actionId>` clicks currently running through the route queue. */
  private readonly inFlightProposalClicks = new Set<string>()

  constructor(private readonly deps: TurnCardActionsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** @returns one handler per button kind, for {@link dispatchCardAction}. */
  handlers(): CardActionHandler[] {
    return [
      { label: 'stop', handle: event => this.onStopAction(event) },
      { label: 'steer', handle: event => this.onSteerAction(event) },
      { label: 'continue', handle: event => this.onResumeAction(event) },
      { label: 'approval retry', handle: event => this.onApprovalRetryAction(event) },
      { label: 'picker card', handle: event => this.onPickAction(event) },
      { label: 'action proposal', handle: event => this.onActionProposalClick(event) },
    ]
  }

  /**
   * Cancel one Session's live turn without resuming anything. Queued
   * messages stay in the inbox: each already has its own streaming card and
   * runs next.
   * @param sessionId The Session to cancel.
   * @returns Whether a turn was running.
   */
  cancelTurn(sessionId: string): boolean {
    const agent = this.deps.sessions.get(sessionId)?.agent
      ?? this.deps.ctx.agents.get(sessionId as SessionId)
    const running = agent?.status === 'running'
    agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
    if (running) this.deps.streamer()?.markStopping(sessionId)
    return running
  }

  /**
   * Streaming-card stop button. Only the session owner, clicking inside the
   * session's own chat, cancels the turn; another operator gets the
   * owner-only notice on the card instead.
   */
  private onStopAction(event: CardActionEvent): void {
    if (!this.deps.started()) return
    if ((event.action.value as { decision?: unknown } | undefined)?.decision !== STOP_ACTION) return
    const sessionId = this.deps.streamer()?.stopTargetOf(event.messageId)
    if (sessionId === undefined) return
    const route = this.deps.routes.findBySession(sessionId)
    if (route === undefined) return
    if (!this.deps.access.mayActOnRoute(event.operator.userId, event.chatId, route)) {
      this.deps.streamer()?.markStopDenied(sessionId)
      return
    }
    this.cancelTurn(sessionId)
  }

  /**
   * Queued-card steer button: a user who may act on the route (the owner, or
   * any admitted member of a group-shared route), clicking inside the
   * session's own chat, moves the queued message out of the next-turn queue
   * and into the running turn's next step; another operator gets the
   * owner-only notice instead. A message the driver already claimed (its turn
   * started) or a turn that is stopping leaves the card to its own turn.
   */
  private onSteerAction(event: CardActionEvent): void {
    if (!this.deps.started()) return
    if ((event.action.value as { decision?: unknown } | undefined)?.decision !== STEER_ACTION) return
    const target = this.deps.streamer()?.steerTargetOf(event.messageId)
    if (target === undefined) return
    const route = this.deps.routes.findBySession(target.sessionId)
    if (route === undefined) return
    if (!this.deps.access.mayActOnRoute(event.operator.userId, event.chatId, route)) {
      this.deps.streamer()?.markQueuedDenied(event.messageId)
      return
    }
    const agent = this.deps.sessions.get(target.sessionId)?.agent
      ?? this.deps.ctx.agents.get(target.sessionId as SessionId)
    if (agent?.status !== 'running') return
    const merged = this.deps.streamer()?.mergeQueued(event.messageId, (_sessionId, prompt) => steerQueued(agent, prompt.requestId)) === true
    // The queued card no longer owns a turn: retire its restart-repair snapshot.
    if (merged) void this.deps.repair.clear(event.messageId)
  }

  /**
   * Interrupted-card continue button: a user who may act on the route,
   * clicking inside the session's own chat, starts a turn that continues the
   * interrupted work, streaming into the clicked card. Each card continues
   * at most once.
   */
  private async onResumeAction(event: CardActionEvent): Promise<void> {
    if (!this.deps.started()) return
    const target = parseResumeAction(event.action.value)
    if (target === undefined || this.resumedCards.has(event.messageId)) return
    const route = this.deps.routes.findBySession(target.sessionId)
    if (route === undefined) return
    const operator = event.operator.userId
    if (operator === undefined || !this.deps.access.mayActOnRoute(operator, event.chatId, route)) return
    this.resumedCards.add(event.messageId)
    try {
      const live = await this.deps.sessions.ensureLive(route)
      const prompt = channelPrompt(RESUME_PROMPT, principalOnRoute(route, operator))
      const stored = storablePrompt(prompt)
      await this.deps.repair.write({
        key: event.messageId,
        sessionId: route.sessionId,
        chatId: route.chatId,
        ...(target.triggerMessageId === undefined ? {} : { triggerMessageId: target.triggerMessageId }),
        routeKey: route.key,
        ...(stored === undefined ? {} : { prompt: stored }),
        cards: [{ messageId: event.messageId, mode: 'card' }],
        startedAt: Date.now(),
        attempts: 0,
      })
      await this.deps.runTurn(live.agent, prompt, {
        cardMessageId: event.messageId,
        ...(target.triggerMessageId === undefined ? {} : { triggerMessageId: target.triggerMessageId }),
      })
    } catch (error) {
      this.resumedCards.delete(event.messageId)
      throw error
    }
  }

  /**
   * 「重新发起」 click on an expired or interrupted approval card: a user who
   * may act on the route starts a turn that re-checks the current state and
   * retries the step, streaming into a new card under the clicked one. Each
   * card retries at most once; the clicked card then shows 已重新发起.
   */
  private async onApprovalRetryAction(event: CardActionEvent): Promise<void> {
    if (!this.deps.started()) return
    const target = parseApprovalRetryAction(event.action.value)
    if (target === undefined || this.retriedApprovalCards.has(event.messageId)) return
    const record: ApprovalCardRecord | undefined = this.deps.approvals.retryable(event.messageId)
    if (record === undefined || record.sessionId !== target.sessionId || record.state === 'open') return
    const ended = record.state
    const bound = this.deps.routes.findBySession(record.sessionId)
    const operator = event.operator.userId
    if (bound === undefined || operator === undefined) return
    this.retriedApprovalCards.add(event.messageId)
    let accepted = false
    try {
      // Serialized with `/renew` and the topic's other route changes: the
      // retry runs only while the topic still binds the card's Session.
      accepted = await this.deps.queue.run(bound.key, async () => {
        const route = this.deps.routes.get(bound.key)
        const channel = this.deps.channel()
        if (!this.deps.started() || channel === undefined || route === undefined || route.sessionId !== record.sessionId
          || !this.deps.access.mayActOnRoute(operator, event.chatId, route)) return false
        const live = await this.deps.sessions.ensureLive(route)
        const firstCard = this.deps.streamer()?.hasLiveTurn(route.sessionId) === true
          ? queuedStreamingCard(route.sessionId)
          : initialStreamingCard(route.sessionId)
        const sent = await channel.send(route.chatId, { card: firstCard }, {
          replyTo: event.messageId,
          replyInThread: route.kind === 'thread',
        })
        const prompt = channelPrompt(approvalRetryPrompt(record.question, ended), principalOnRoute(route, operator))
        const stored = storablePrompt(prompt)
        await this.deps.repair.write({
          key: sent.messageId,
          sessionId: route.sessionId,
          chatId: route.chatId,
          routeKey: route.key,
          ...(stored === undefined ? {} : { prompt: stored }),
          cards: [{ messageId: sent.messageId, mode: 'card' }],
          startedAt: Date.now(),
          attempts: 0,
        })
        await this.deps.routes.put(route.key, { ...route, cardMessageId: sent.messageId, lastActivityAt: Date.now() })
        return (await this.deps.runTurn(live.agent, prompt, { cardMessageId: sent.messageId })).accepted
      })
    } finally {
      if (!accepted) this.retriedApprovalCards.delete(event.messageId)
    }
    if (!accepted) return
    this.deps.approvals.settleCard(event.messageId)
    void this.deps.outbox.patch(event.messageId, buildApprovalSettledCard(record.question, 'retried'))
  }

  /**
   * Picker-card click: run the chosen `/<command> <arg>` exactly as if the
   * operator had typed it under the picker card, so access admission, route
   * ownership and validation are the typed command's. The result replaces
   * the picker card in place instead of arriving as a new card. Stale pickers (the
   * topic was rebound, or the card was forwarded elsewhere) and non-owner
   * clicks are ignored.
   */
  private async onPickAction(event: CardActionEvent): Promise<void> {
    if (!this.deps.started()) return
    const action = parsePickAction(event.action.value)
    if (action === undefined) return
    const route = this.deps.routes.findBySession(action.sessionId)
    const userId = event.operator.userId
    if (route === undefined || userId === undefined
      || !this.deps.access.mayActOnRoute(userId, event.chatId, route)) return
    const line = `/${action.command} ${action.arg}`
    await this.deps.delivery.replacingCard(event.messageId, () => this.deps.runCommand({
      messageId: event.messageId,
      chatId: route.chatId,
      chatType: route.chatType,
      senderId: userId,
      content: line,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      ...(route.kind === 'thread' ? { threadId: route.key } : {}),
      createTime: Date.now(),
    }, line))
  }

  /**
   * Non-blocking action proposal button click (`feishuActions` / `propose_actions`):
   * validates the 14-day TTL, route binding, channel ownership and `requiredAccess`
   * (patching a non-destructive Chinese hint on permission denial without consuming
   * pending buttons), atomically transitions the selected action to `triggered`
   * (or remaining pending items to `dismissed` for 「暂不处理」), and wakes the
   * Session with a streaming card and follow-up turn as the clicker's principal.
   */
  private async onActionProposalClick(event: CardActionEvent): Promise<void> {
    if (!this.deps.started()) return
    const click = parseActionProposalClick(event.action.value)
    if (click === undefined) return
    const clickKey = `${click.proposalId}:${click.actionId}`
    if (this.inFlightProposalClicks.has(clickKey)) return

    const initial = this.deps.actionProposals.get(click.proposalId)
    if (initial === undefined) {
      void this.deps.outbox.patch(event.messageId, buildPrunedActionProposalCard())
      return
    }
    if (initial.cardMessageId !== event.messageId || initial.chatId !== event.chatId) return

    const patchProposal = (card: object): void => {
      if (this.deps.patchProposalCard !== undefined) {
        void this.deps.patchProposalCard(initial.proposalId, event.messageId, card)
      } else {
        void this.deps.outbox.patch(event.messageId, card)
      }
    }

    if (isActionProposalExpired(initial, this.now())) {
      patchProposal(buildActionProposalCard(initial, { invalidation: 'expired' }))
      return
    }

    const bound = this.deps.routes.get(initial.routeKey)
    if (bound === undefined || bound.sessionId !== initial.sessionId) {
      patchProposal(buildActionProposalCard(initial, { invalidation: 'unbound' }))
      return
    }

    this.inFlightProposalClicks.add(clickKey)
    try {
      await this.deps.queue.run(bound.key, async () => {
        const channel = this.deps.channel()
        if (!this.deps.started() || channel === undefined) return
        const proposal = this.deps.actionProposals.get(click.proposalId)
        if (proposal === undefined) {
          void this.deps.outbox.patch(event.messageId, buildPrunedActionProposalCard())
          return
        }
        if (proposal.cardMessageId !== event.messageId || proposal.chatId !== event.chatId) return

        if (isActionProposalExpired(proposal, this.now())) {
          patchProposal(buildActionProposalCard(proposal, { invalidation: 'expired' }))
          return
        }

        const route = this.deps.routes.get(proposal.routeKey)
        if (route === undefined || route.sessionId !== proposal.sessionId) {
          patchProposal(buildActionProposalCard(proposal, { invalidation: 'unbound' }))
          return
        }

        if (!hasPendingActions(proposal)) {
          patchProposal(buildActionProposalCard(proposal))
          return
        }

        if (click.actionId === RESERVED_DISMISS_ACTION_ID) {
          const refusal = this.deps.access.actionProposalRefusal(event.operator.userId, event.chatId, route, 'chat')
          if (refusal !== undefined) {
            patchProposal(buildActionProposalCard(proposal, { notice: refusal }))
            return
          }
          const dismissed = await this.deps.actionProposals.dismissPending(proposal.proposalId)
          if (dismissed !== undefined) {
            patchProposal(buildActionProposalCard(dismissed))
          }
          return
        }

        const target = proposal.actions.find(item => item.id === click.actionId)
        if (target === undefined || target.status !== 'pending') return

        const refusal = this.deps.access.actionProposalRefusal(
          event.operator.userId,
          event.chatId,
          route,
          target.requiredAccess,
        )
        if (refusal !== undefined) {
          patchProposal(buildActionProposalCard(proposal, { notice: refusal }))
          return
        }

        const clickerUserId = event.operator.userId!
        const live = await this.deps.sessions.ensureLive(route)
        await mkdir(route.workspacePath, { recursive: true }).catch((error: unknown) => {
          this.deps.ctx.logger?.warn?.(
            'dsh-channels: recreating topic directory %s failed: %s',
            route.workspacePath, String(error),
          )
        })

        const liveChannel = this.deps.channel()
        if (!this.deps.started() || liveChannel === undefined) return

        const now = this.now()
        const text = formatActionSelectedPrompt(
          target.id,
          target.label,
          target.followUpPrompt,
        )
        const prompt = channelPrompt(text, principalOnRoute(route, clickerUserId))

        const triggered = await this.deps.actionProposals.triggerAction(
          proposal.proposalId,
          click.actionId,
          clickerUserId,
          now,
          prompt.requestId,
        )
        if (!triggered.changed) return

        let accepted = false
        let repairCardMessageId: string | undefined
        try {
          const firstCard = this.deps.streamer()?.hasLiveTurn(route.sessionId) === true
            ? queuedStreamingCard(route.sessionId)
            : initialStreamingCard(route.sessionId)
          const sent = await liveChannel.send(route.chatId, { card: firstCard }, {
            replyTo: event.messageId,
            replyInThread: route.kind === 'thread',
          })

          const stored = storablePrompt(prompt)
          repairCardMessageId = sent.messageId
          await this.deps.repair.write({
            key: sent.messageId,
            sessionId: route.sessionId,
            chatId: route.chatId,
            triggerMessageId: event.messageId,
            routeKey: route.key,
            ...(stored === undefined ? {} : { prompt: stored }),
            cards: [{ messageId: sent.messageId, mode: 'card' }],
            startedAt: now,
            attempts: 0,
          })
          await this.deps.routes.put(route.key, {
            ...route,
            cardMessageId: sent.messageId,
            lastActivityAt: now,
            ...(isGroupRoute(route) ? { lastSpeakerUserId: clickerUserId } : {}),
          })
          const outcome = await this.deps.runTurn(live.agent, prompt, { cardMessageId: sent.messageId })
          accepted = outcome.accepted
        } finally {
          if (!accepted) {
            if (repairCardMessageId !== undefined) {
              await this.deps.repair.clear(repairCardMessageId).catch((error: unknown) => {
                this.deps.ctx.logger?.warn?.(
                  'dsh-channels: clearing failed action repair snapshot %s failed: %s',
                  repairCardMessageId, String(error),
                )
              })
            }
            const reverted = await this.deps.actionProposals.revertTrigger(
              proposal.proposalId,
              triggered.changedIds,
              prompt.requestId,
            )
            if (reverted?.superseded === true) {
              patchProposal(buildActionProposalCard(reverted))
            }
          }
        }
        if (!accepted) return
        const confirmed = await this.deps.actionProposals.confirmTrigger(proposal.proposalId, prompt.requestId)
        patchProposal(buildActionProposalCard(
          confirmed ?? this.deps.actionProposals.get(proposal.proposalId) ?? triggered.record,
        ))
      })
    } finally {
      this.inFlightProposalClicks.delete(clickKey)
    }
  }
}
