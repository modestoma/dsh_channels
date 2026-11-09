/**
 * HITL approval answerer: turns the host's `approval/request` waterfall
 * events into standalone Feishu decision cards.
 *
 * The answerer is registered with `prepend: true` on the plugin context so it
 * runs BEFORE generic answerers: a request for a session this channel routes
 * is claimed here, and the decision card (or a typed topic reply) becomes the
 * only way to answer. Requests for sessions the channel does NOT route
 * delegate through `next()`.
 *
 * The host request carries no tool arguments, so the answerer keeps the
 * current turn's `tool/call` arguments per session (fed from `session/event`)
 * and looks the asked call up by `callId` to show what will run. Standing
 * "stop asking in this topic" grants are keyed by session, tool name, and
 * requested sandbox mode, and are stored (`ApprovalStore`) so they survive a
 * restart; they end with the session (`/renew`) or the topic.
 *
 * Timing: a turn a Feishu message started waits `timeoutMs` (24 h by
 * default), a turn the host started (subagent, background job, schedule,
 * PR/MR activity) waits `backgroundTimeoutMs`. A private-chat card that is
 * still undecided after `reminderMs` gets one reminder reply under it; group
 * cards never do. An expired card, and a card a restart left undecided, carry
 * a 「重新发起」 button whose click the service turns into a new turn.
 *
 * Rendering lives in `cards/approval.ts`; the shared pending-card lifecycle
 * (delivery, owner gating, timeout, settle-once, withdrawal) lives in
 * `interactions/pending.ts`.
 *
 * @module dsh-channels/interactions/approvals
 */

import { randomUUID } from 'node:crypto'
import { approvalDurationLabel, buildApprovalCard, buildApprovalSettledCard, UNCONFINED_MODE } from '../cards/approval.ts'
import type { ApprovalCardState, ApprovalQuestion, SettledApprovalQuestion } from '../cards/approval.ts'
import type { ApprovalOutcome, ApprovalRequest, SessionEvent } from '../host/index.ts'
import type { CardActionEvent, FeishuChannel } from '../feishu-channel.ts'
import type { ApprovalStore } from './approval-store.ts'
import { PendingCardTable } from './pending.ts'
import type { InteractionRoute, PendingCardEntry } from './pending.ts'

/** Feishu placement of one session's approval cards. */
export interface ApprovalRoute extends InteractionRoute {
  /** `p2p` routes get the undecided-card reminder; `group` routes never do. */
  chatType: 'p2p' | 'group'
}

/** Approval windows, read when each card opens. */
export interface ApprovalTimings {
  /** Window of a card asked by a turn a Feishu message started. */
  timeoutMs: number
  /** Window of a card asked by a turn the host started. */
  backgroundTimeoutMs: number
  /** Delay of the one private-chat reminder; `0` disables it. */
  reminderMs: number
}

export interface ApprovalHooks {
  /**
   * Resolve the Feishu placement for a session. `undefined` means the session
   * is not owned by this channel — the answerer delegates through `next()`.
   */
  routeFor(sessionId: string): ApprovalRoute | undefined
  /** Log a non-fatal error (delivery/update failures). */
  onError(sessionId: string, error: unknown): void
  /** Whether a user is an administrator: only administrators may allow an escalation to unconfined access. */
  isAdmin(userId: string): boolean
  /**
   * The tool names a session is currently waiting on for approval (empty when
   * none), called on every open and settle so the streaming card can show it.
   */
  onWaitingChange?(sessionId: string, toolNames: readonly string[]): void
  /**
   * Durable card patch (the outbox), retried until it lands. Absent = each
   * patch is attempted once.
   */
  patchCard?(messageId: string, card: object): Promise<void>
  /**
   * Whether the session's running turn was started by the host rather than
   * a Feishu message; such a card waits `backgroundTimeoutMs`. Absent =
   * every card waits `timeoutMs`.
   */
  backgroundTurn?(sessionId: string): boolean
  /**
   * Durable grants and card records. Absent = grants live in memory only and
   * settled cards carry no 「重新发起」 button.
   */
  store?: ApprovalStore
}

/**
 * How one typed topic reply was consumed by {@link ApprovalAnswerer.submitText}:
 * a keyword decision (`allowed`, `remembered`, `denied`), or any other text
 * that rejected every pending request of the session (`superseded`) and must
 * still be delivered as the next instruction. `admin-required`: a
 * non-administrator tried to allow a request only an administrator may allow;
 * nothing was decided.
 */
export type ApprovalTextResult = 'allowed' | 'remembered' | 'denied' | 'superseded' | 'admin-required'

/** One in-flight approval question: its card content and its resolver. */
interface Pending extends PendingCardEntry {
  question: ApprovalQuestion
  /** Standing-grant key for "stop asking in this topic". */
  grantKey: string
  /** Open order, so a typed reply answers the newest card. */
  openedAt: number
  /** The administrator-only notice was already added to the card. */
  adminNoted: boolean
  /** Pending private-chat reminder, cleared on settle. */
  reminder: ReturnType<typeof setTimeout> | undefined
  resolve(outcome: ApprovalOutcome): void
}

/** One recorded `tool/call` of a session's current turn. */
interface RecordedCall {
  turn: number
  name: string
  arguments: string
}

/** Start of the audit reason DSH's sandbox escalation asks carry, followed by the target mode and `:`. */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to '

const ALLOW_WORDS = new Set(['允许', '同意', '可以', '好', '好的', '行', '确认', 'y', 'yes', 'ok', 'allow', 'approve'])
const DENY_WORDS = new Set(['拒绝', '不允许', '不行', '不', '否', '不同意', 'n', 'no', 'deny', 'reject'])
const ALWAYS_WORDS = new Set(['全部允许', '都允许', '允许所有', '允许全部', '总是允许', '始终允许', 'allow all', 'always'])

/** Cap on the command quoted in a 「重新发起」 prompt. */
const RETRY_PROMPT_COMMAND_MAX_CHARS = 600

/**
 * Prompt of the turn a 「重新发起」 click starts: what was asked, why it did
 * not run, and an instruction to check the current state before retrying.
 * @param question - the stored question of the clicked card.
 * @param state - how the card ended.
 * @returns the prompt text.
 */
export function approvalRetryPrompt(question: SettledApprovalQuestion, state: 'expired' | 'interrupted'): string {
  const cause = state === 'expired' ? '超时没有处理，被自动拒绝' : '因为服务重启中断了，没有得到答复'
  const target = question.escalateTo === undefined
    ? `工具 \`${question.toolName}\``
    : `工具 \`${question.toolName}\` 提升到 \`${question.escalateTo}\` 权限`
  const command = question.command === undefined
    ? ''
    : `当时要执行的命令：\n\`\`\`\n${question.command.slice(0, RETRY_PROMPT_COMMAND_MAX_CHARS)}\n\`\`\`\n`
  return `之前一次请求执行${target}的审批${cause}，用户点了「重新发起」。\n${command}`
    + '先核对实际状态：工作目录里的文件和 git 状态、远端分支和 MR、已经发出的消息或文件。已经完成的对外操作不要重做；'
    + '如果那一步仍然需要，就重新执行，需要授权时会再次发起审批。'
}

/**
 * Classify one typed reply. Trailing punctuation and case are ignored; the
 * whole message must be the keyword so ordinary sentences never match.
 * @param text - the reply text with mentions already stripped.
 * @returns The keyword decision, or `undefined` for any other text.
 */
export function classifyApprovalReply(text: string): 'allow' | 'always' | 'deny' | undefined {
  const word = text.trim().toLowerCase().replace(/[\s。.!！~～]+$/u, '')
  if (ALWAYS_WORDS.has(word)) return 'always'
  if (ALLOW_WORDS.has(word)) return 'allow'
  if (DENY_WORDS.has(word)) return 'deny'
  return undefined
}

/**
 * Read what a call will run and the sandbox mode it asks for. A string
 * `command` argument is the command; the other arguments become `name: value`
 * lines (strings verbatim, other values as JSON). Arguments are
 * model-produced JSON, so a parse failure shows the raw text.
 */
function describeCall(call: RecordedCall | undefined): { command?: string; arguments?: string; escalateTo?: string } {
  if (call === undefined) return {}
  let args: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch {
    // Unparseable arguments: shown verbatim below.
  }
  if (args === undefined) return call.arguments === '' ? {} : { arguments: call.arguments }
  const escalateTo = typeof args.sandbox_permissions === 'string' && args.sandbox_permissions !== ''
    ? args.sandbox_permissions
    : undefined
  const command = typeof args.command === 'string' && args.command !== '' ? args.command : undefined
  const rest = Object.entries(args)
    .filter(([name]) => !(name === 'command' && command !== undefined) && !(name === 'sandbox_permissions' && escalateTo !== undefined))
    .map(([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return {
    ...(command === undefined ? {} : { command }),
    ...(rest.length === 0 ? {} : { arguments: rest.join('\n') }),
    ...(escalateTo === undefined ? {} : { escalateTo }),
  }
}

export class ApprovalAnswerer {
  private readonly table: PendingCardTable<Pending>
  /** sessionId → callId → the current turn's recorded tool calls. */
  private readonly calls = new Map<string, Map<string, RecordedCall>>()
  /** sessionId → standing "stop asking in this topic" grant keys (mirrors the store). */
  private readonly grants = new Map<string, Set<string>>()
  /** Marks this process's stored card records; another instance's open records were interrupted. */
  private readonly instanceId = randomUUID()
  private opened = 0

  /**
   * @param channel - channel that sends the cards and reminders.
   * @param hooks - routing, permissions, durable patching, and storage.
   * @param timings - the approval windows, read when each card opens.
   */
  constructor(
    private readonly channel: FeishuChannel,
    private readonly hooks: ApprovalHooks,
    private readonly timings: () => ApprovalTimings,
  ) {
    this.table = new PendingCardTable(channel, hooks.onError, hooks.patchCard?.bind(hooks))
  }

  /** In-flight question count (diagnostics/tests). */
  pendingCount(): number {
    return this.table.count()
  }

  /** Whether a session currently has an undecided approval card. */
  hasPendingFor(sessionId: string): boolean {
    return this.pendingOf(sessionId).length > 0
  }

  /**
   * Track the current turn's tool calls so a later approval can show what it
   * approves. Only `tool/call` and `turn/end` are read; nothing earlier than
   * the current turn is kept.
   */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === 'tool/call') {
      let calls = this.calls.get(sessionId)
      if (calls === undefined) {
        calls = new Map()
        this.calls.set(sessionId, calls)
      }
      calls.set(event.data.callId, { turn: event.data.turn, name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'turn/end') {
      const calls = this.calls.get(sessionId)
      if (calls === undefined) return
      for (const [callId, call] of calls) {
        if (call.turn <= event.data.turn) calls.delete(callId)
      }
      if (calls.size === 0) this.calls.delete(sessionId)
    }
  }

  /**
   * The `approval/request` waterfall listener. Never rejects: the host service
   * already contains answerer failures to the fail-closed `'unavailable'`.
   */
  onRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = req.agent.session.id
    const route = this.hooks.routeFor(sessionId)
    if (route === undefined) return next()
    // The abort window between the service's own signal check and this
    // listener is closed by settling synchronously: an aborted ask never
    // opens a question.
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')

    const call = req.callId === undefined ? undefined : this.calls.get(sessionId)?.get(req.callId)
    const recorded = describeCall(call)
    // DSH's escalation asks state the target mode in their audit reason, which
    // also covers a call this answerer did not record (a PTC sub-dispatch).
    const asksUnconfined = req.reason?.startsWith(`${ESCALATION_REASON_PREFIX}${UNCONFINED_MODE}:`) === true
    const described = asksUnconfined ? { ...recorded, escalateTo: UNCONFINED_MODE } : recorded
    const adminOnly = described.escalateTo === UNCONFINED_MODE
    const grantKey = `${req.toolName}\u0000${described.escalateTo ?? ''}`
    if (this.hasGrant(sessionId, grantKey)) return Promise.resolve('allowed-once')
    const timings = this.timings()
    const timeoutMs = this.hooks.backgroundTurn?.(sessionId) === true ? timings.backgroundTimeoutMs : timings.timeoutMs

    const token = randomUUID()
    // `displayReason` (DSH 0.2.0) is presentation-only and locale-aware;
    // `reason` remains the audit-trail fallback.
    const displayReason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
    const question: ApprovalQuestion = {
      token,
      toolName: req.toolName,
      ...(displayReason === undefined ? {} : { reason: displayReason }),
      ...described,
      ...(adminOnly ? { adminOnly } : {}),
      timeoutMs,
      sessionId,
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: Pending = {
        token,
        sessionId,
        route,
        messageId: undefined,
        settled: false,
        timer: undefined,
        signal: req.signal,
        onAbort: undefined,
        unauthorizedNoted: false,
        adminNoted: false,
        reminder: undefined,
        question,
        grantKey,
        openedAt: ++this.opened,
        resolve,
      }
      const onAbort = (): void => {
        this.settle(entry, 'cancelled', 'cancelled')
      }
      entry.onAbort = onAbort
      // Registered synchronously at promise creation so no abort can slip
      // between the ownership check and the card delivery; a residual abort
      // in the tiny window before addEventListener is still covered because
      // the host's decide() races the signal against this promise and
      // discards a late resolution (worst case: the card times out).
      req.signal?.addEventListener('abort', onAbort, { once: true })
      this.table.add(entry)
      this.notifyWaiting(sessionId)
      void this.table.deliver(entry, {
        card: buildApprovalCard(question),
        onWithdrawn: e => this.table.patch(e, buildApprovalSettledCard(e.question, 'cancelled')),
        onDelivered: e => this.onDelivered(e, route, timings.reminderMs),
        // No card → no human answerer → fail closed.
        onFailure: e => {
          this.table.close(e, () => {})
          this.notifyWaiting(e.sessionId)
          e.resolve('unavailable')
        },
      })
    })
  }

  /**
   * Route one card button-callback event to its pending question. Unknown
   * cards and non-owner operators are ignored (a non-owner click adds the
   * owner-only notice to the card once); owner decisions settle the question.
   */
  onCardAction(event: CardActionEvent): void {
    const entry = this.table.resolveAction(event, candidate => {
      if (candidate.unauthorizedNoted) return
      candidate.unauthorizedNoted = true
      this.patchPending(candidate)
    }, (candidate, operator) => candidate.question.adminOnly === true && this.hooks.isAdmin(operator))
    if (entry === undefined) return
    const decision = (event.action.value as { decision?: unknown } | undefined)?.decision
    if ((decision === 'allow' || decision === 'always') && !this.mayAllow(entry, event.operator.userId)) {
      if (!entry.adminNoted) {
        entry.adminNoted = true
        this.patchPending(entry)
      }
      return
    }
    if (decision === 'allow') this.settle(entry, 'allowed-once', 'allowed')
    else if (decision === 'always') this.remember(entry)
    else if (decision === 'deny') this.settle(entry, 'rejected', 'denied')
  }

  /**
   * Answer a session's pending approvals with one typed topic reply. The
   * caller has already checked that the sender owns the topic. A keyword
   * decides the newest card; any other text rejects every pending card of the
   * session and is reported as `superseded` so the caller still delivers it.
   * A keyword allowing an admin-only card from a non-administrator decides
   * nothing and is reported as `admin-required`.
   * @param sessionId - the session the reply was routed to.
   * @param text - the reply text.
   * @param senderUserId - Feishu user_id of the reply's sender.
   * @returns How the reply was consumed, or `undefined` when nothing is pending.
   */
  submitText(sessionId: string, text: string, senderUserId: string): ApprovalTextResult | undefined {
    const pending = this.pendingOf(sessionId)
    const newest = pending.at(-1)
    if (newest === undefined) return undefined
    const keyword = classifyApprovalReply(text)
    if ((keyword === 'allow' || keyword === 'always') && !this.mayAllow(newest, senderUserId)) return 'admin-required'
    switch (keyword) {
      case 'allow':
        this.settle(newest, 'allowed-once', 'allowed-text')
        return 'allowed'
      case 'always':
        this.remember(newest)
        return 'remembered'
      case 'deny':
        this.settle(newest, 'rejected', 'denied-text')
        return 'denied'
      case undefined:
        for (const entry of pending) this.settle(entry, 'rejected', 'superseded')
        return 'superseded'
    }
  }

  /**
   * Withdraw every in-flight question (plugin shutdown or restart). With a
   * store, each delivered card becomes interrupted with a 「重新发起」 button;
   * the host settles the questions cancelled either way.
   */
  dispose(): void {
    this.table.withdrawAll(entry => this.settle(entry, 'cancelled', this.hooks.store === undefined ? undefined : 'interrupted'))
    this.calls.clear()
    this.grants.clear()
  }

  /**
   * Turn the cards an earlier process left undecided (a crash or kill
   * skipped `dispose`) into interrupted cards with a 「重新发起」 button.
   * Call once the outbox can patch.
   * @returns how many cards were recovered.
   */
  recoverInterrupted(): number {
    const store = this.hooks.store
    if (store === undefined) return 0
    const records = store.interruptedCards(this.instanceId)
    for (const record of records) {
      store.settleCard(record.key, 'interrupted')
      this.table.patchMessage(record.sessionId, record.key,
        buildApprovalSettledCard(record.question, 'interrupted', { retry: { sessionId: record.sessionId } }))
    }
    return records.length
  }

  /** Whether a session holds a standing grant (memory first, then the store). */
  private hasGrant(sessionId: string, grantKey: string): boolean {
    return this.grants.get(sessionId)?.has(grantKey) === true || this.hooks.store?.hasGrant(sessionId, grantKey) === true
  }

  /**
   * The card landed: store it, arm its deadline, and arm the private-chat
   * reminder when it would fire before the deadline.
   */
  private onDelivered(entry: Pending, route: ApprovalRoute, reminderMs: number): void {
    const { token: _token, ...stored } = entry.question
    this.hooks.store?.openCard({
      key: entry.messageId!,
      sessionId: entry.sessionId,
      question: stored,
      state: 'open',
      instanceId: this.instanceId,
      createdAt: Date.now(),
    })
    this.table.armTimeout(entry, entry.question.timeoutMs, () => {
      this.settle(entry, 'rejected', 'expired')
    })
    if (route.chatType !== 'p2p' || reminderMs <= 0 || reminderMs >= entry.question.timeoutMs) return
    entry.reminder = setTimeout(() => {
      entry.reminder = undefined
      this.remind(entry)
    }, reminderMs)
    entry.reminder.unref?.()
  }

  /** Send the one reminder reply under a still-undecided card. */
  private remind(entry: Pending): void {
    if (entry.settled || entry.messageId === undefined) return
    const text = `⏰ 还有一个审批在等你处理：\`${entry.question.toolName}\`。处理之前这一轮回复会一直暂停，`
      + `卡片 ${approvalDurationLabel(entry.question.timeoutMs)}内有效，超时自动拒绝。`
    void this.channel.send(entry.route.chatId, { text }, { replyTo: entry.messageId, replyInThread: entry.route.inThread })
      .catch((error: unknown) => { this.hooks.onError(entry.sessionId, error) })
  }

  /** Undecided entries of one session, oldest first. */
  private pendingOf(sessionId: string): Pending[] {
    return [...this.table.values()]
      .filter(entry => entry.sessionId === sessionId && !entry.settled)
      .sort((left, right) => left.openedAt - right.openedAt)
  }

  /**
   * Record a standing grant for the entry's tool + mode, allow it, and allow
   * every other pending card of the session the grant now covers.
   */
  private remember(entry: Pending): void {
    let grants = this.grants.get(entry.sessionId)
    if (grants === undefined) {
      grants = new Set()
      this.grants.set(entry.sessionId, grants)
    }
    grants.add(entry.grantKey)
    this.hooks.store?.addGrant(entry.sessionId, entry.grantKey)
    for (const candidate of this.pendingOf(entry.sessionId)) {
      if (candidate.grantKey === entry.grantKey) this.settle(candidate, 'allowed-once', 'remembered')
    }
  }

  /** Whether a user may allow one entry: anyone who may decide it, or only an administrator for an admin-only entry. */
  private mayAllow(entry: Pending, userId: string | undefined): boolean {
    return entry.question.adminOnly !== true || (userId !== undefined && this.hooks.isAdmin(userId))
  }

  /** Re-render a pending card with the notices it has earned. */
  private patchPending(entry: Pending): void {
    this.table.patch(entry, buildApprovalCard(entry.question, {
      unauthorizedNote: entry.unauthorizedNoted,
      adminOnlyNote: entry.adminNoted,
    }))
  }

  /** Report the session's remaining waits to the streaming card. */
  private notifyWaiting(sessionId: string): void {
    this.hooks.onWaitingChange?.(sessionId, this.pendingOf(sessionId).map(entry => entry.question.toolName))
  }

  /**
   * Settle once, then patch the card to its terminal state. With a store, an
   * expired or interrupted card keeps its record and gets the 「重新发起」
   * button; any other ending forgets the record.
   */
  private settle(entry: Pending, outcome: ApprovalOutcome, cardState?: ApprovalCardState): void {
    const closed = this.table.close(entry, () => {
      if (entry.reminder !== undefined) clearTimeout(entry.reminder)
      entry.reminder = undefined
      const store = this.hooks.store
      const retryable = store !== undefined && (cardState === 'expired' || cardState === 'interrupted')
      if (store !== undefined && entry.messageId !== undefined) {
        store.settleCard(entry.messageId, retryable ? cardState : undefined)
      }
      if (cardState !== undefined) {
        this.table.patch(entry, buildApprovalSettledCard(entry.question, cardState,
          retryable ? { retry: { sessionId: entry.sessionId } } : {}))
      }
    })
    if (!closed) return
    this.notifyWaiting(entry.sessionId)
    entry.resolve(outcome)
  }
}
