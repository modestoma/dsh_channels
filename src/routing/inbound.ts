/**
 * Inbound routing: dedup, admission, the route decision tree, and the
 * session-establishment / continuation flow.
 *
 * Everything here is channel-plane policy; the command plane (slash commands)
 * and the answerers stay in the service and are reached through narrow ports.
 * Dependency reads go through accessors so the moved logic stays readable.
 *
 * @module dsh-channels/routing/inbound
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle, HostContext, SessionId, UserMessage } from '../dsh-types.ts'
import type { FeishuConfig } from '../config.ts'
import { buildCard, buildOnboardingCard, initialStreamingCard } from '../cards.ts'
import { RouteOperationQueue } from '../commands.ts'
import { chatRouteKey } from '../domain.ts'
import type { FeishuDomainHandle, RouteRecord } from '../domain.ts'
import type { CardDelivery } from '../feishu/delivery.ts'
import { AttachmentIntake } from '../feishu/inbound-attachments.ts'
import type { AttachmentArchiveResult } from '../feishu/inbound-attachments.ts'
import type { NormalizedMessage } from '../feishu-channel.ts'
import type { QuestionAnswerer } from '../interactions/questions.ts'
import type { InflightRepair } from '../session/repair.ts'
import type { SessionManager } from '../session/manager.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TurnStreamer } from '../streamer.ts'
import { ensureWorkspace } from '../workspaces.ts'

/** The command plane the inbound router delegates admission-time work to. */
export interface CommandPlanePort {
  /** Slash-command admission + dispatch. */
  handleSlash(msg: NormalizedMessage, line: string): Promise<void>
}

/**
 * Channel-plane admission port (structurally satisfied by the access
 * controller). Kept as a local interface so routing has no dependency on the
 * access module's implementation details.
 */
export interface InboundAccessPort {
  /** Full admission for a non-slash message; false = handled (deny/notice). */
  admit(msg: NormalizedMessage): Promise<boolean>
  /**
   * Route ownership: only the sender who created a topic may continue it.
   * Also guards against cross-chat id confusion.
   */
  ownsRoute(msg: NormalizedMessage, record: RouteRecord): boolean
}

export interface InboundDeps {
  ctx: HostContext
  config: FeishuConfig
  started(): boolean
  domain(): FeishuDomainHandle | undefined
  routes: RouteStore
  repair: InflightRepair
  delivery: CardDelivery
  sessions: SessionManager
  attachments: AttachmentIntake
  /** Channel-plane access control (administrator + whitelist gates). */
  access: InboundAccessPort
  /** Shared per-route FIFO admission (commands and turns must not interleave). */
  queue: RouteOperationQueue
  streamer(): TurnStreamer | undefined
  questionAnswerer(): QuestionAnswerer | undefined
  commands: CommandPlanePort
}

/** Build one durable user message from inbound Feishu text. */
export function feishuUserMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

export class InboundRouter {
  /**
   * In-process dedup guard: message id → accept timestamp. Set synchronously
   * at acceptance so a same-process redelivery can never slip through the
   * window between the persisted dedup check and its `put` landing.
   */
  private readonly accepted = new Map<string, number>()
  /**
   * chat-scoped key → in-flight session establishment. Concurrent first
   * messages of one (chat, user) pair all observe the same promise: they wait
   * for the establishment to settle, then either continue the just-created
   * session (same topic, or degraded chat route) or fall through to start
   * their own — never racing each other into duplicate sessions, route
   * overwrites, or the "no route, no mention" drop window.
   */
  private readonly establishing = new Map<string, Promise<RouteRecord>>()

  constructor(private readonly deps: InboundDeps) {}

  private get ctx(): HostContext { return this.deps.ctx }
  private get config(): FeishuConfig { return this.deps.config }
  private get started(): boolean { return this.deps.started() }
  private get routes(): RouteStore { return this.deps.routes }
  private get repair(): InflightRepair { return this.deps.repair }
  private get delivery(): CardDelivery { return this.deps.delivery }
  private get sessions(): SessionManager { return this.deps.sessions }
  private get attachments(): AttachmentIntake { return this.deps.attachments }
  private get routeOperations(): RouteOperationQueue { return this.deps.queue }
  private get streamer(): TurnStreamer | undefined { return this.deps.streamer() }
  private get questionAnswerer(): QuestionAnswerer | undefined { return this.deps.questionAnswerer() }
  private get domain(): FeishuDomainHandle | undefined { return this.deps.domain() }
  private get access(): InboundAccessPort { return this.deps.access }

  /** Retire dedup entries older than the retention cutoff (GC sweep). */
  pruneAccepted(cutoff: number): void {
    for (const [messageId, acceptedAt] of this.accepted) {
      if (acceptedAt < cutoff) this.accepted.delete(messageId)
    }
  }

/**
   * Send the one-time onboarding card for a private chat, then remember the
   * chat in the domain global. Best-effort: a storage failure only risks a
   * repeated card, never a blocked session.
   */
  private async sendOnboardingCard(msg: NormalizedMessage): Promise<void> {
    const domain = this.domain
    if (domain === undefined) return
    try {
      const global = domain.getGlobal()
      const welcomed = global.welcomedChats ?? []
      if (welcomed.includes(msg.chatId)) return
      await this.delivery.standaloneReply(msg, buildOnboardingCard(), { createThread: false })
      // Bounded: keep the most recent 500 chats.
      const next = [...welcomed, msg.chatId].slice(-500)
      await domain.setGlobal({ ...global, welcomedChats: next })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-channels: onboarding card failed: %s', String(error))
    }
  }

  /** Drop all in-memory routing state (shutdown). */
  clear(): void {
    this.accepted.clear()
    this.establishing.clear()
  }

  /** Entry point: one normalized inbound message. */
  async handle(msg: NormalizedMessage): Promise<void> {
    const botId = this.delivery.requireChannel().botOpenId()
    if (botId !== undefined && msg.senderId === botId) return
    if (msg.chatType !== 'p2p' && msg.chatType !== 'group') return
    let content = (msg.content ?? '').trim()
    if (content === '') return

    if (msg.chatType === 'p2p' && this.config.dmMode === 'disabled') return

    // 0. Idempotency gate: Feishu redelivers un-acked events on WS reconnect.
    //    The in-process guard closes the window between the persisted check
    //    and its `put` landing; the durable record covers restarts. Recording
    //    happens BEFORE any side effect so a redelivery is dropped, never
    //    double-processed (at-most-once per message id).
    if (this.accepted.has(msg.messageId)) return
    if (this.domain?.processed.get(msg.messageId) !== undefined) return
    this.accepted.set(msg.messageId, Date.now())
    try {
      await this.domain?.processed.put(msg.messageId, {
        key: msg.messageId,
        processedAt: Date.now(),
      })
      this.accepted.delete(msg.messageId)
    } catch (error) {
      // Best-effort: the memory guard still covers this process; the failed
      // record only widens the crash window (pruned by the GC sweep later).
      this.ctx.logger?.warn?.('dsh-channels: recording processed message %s failed: %s', msg.messageId, String(error))
    }

    // Slash admission stays behind message-id dedup but ahead of every route,
    // mention, workspace, Session, card-stream, and model side effect. The
    // command plane applies its own administrator/bootstrap rules.
    if (content.startsWith('/')) {
      await this.deps.commands.handleSlash(msg, content)
      return
    }

    // Channel-plane admission (administrator / group whitelist / user
    // whitelist). Nothing below this point may run for a denied sender: no
    // TTL tombstone, attachment archive, workspace, Session, or model call.
    if (!(await this.access.admit(msg))) return

    // Enforce TTL at admission as well as in the periodic sweep. A message that
    // arrives after the deadline must not get one chance to revive the route
    // merely because the background GC has not run yet.
    const expiredThread = msg.threadId === undefined
      ? undefined
      : await this.routes.expireThread(msg.threadId)

    // A TTL-retired topic is permanently closed on the channel plane. Keeping
    // a durable tombstone avoids silently forking a fresh Session in a topic
    // whose visible history still belongs to the old Session.
    if (expiredThread !== undefined) {
      await this.delivery.expiredRouteCard(msg)
      return
    }

    // Attachments are archived before session work: an attachment-only message
    // produces no model turn, and a caption mixed with attachments keeps only
    // the caption as the prompt. The Agent reads the files on demand later.
    const archived = await this.archiveAttachments(msg)
    if (archived !== undefined) {
      if (archived.attachmentOnly) return
      content = archived.text
      if (content === '') return
    }

    // A session blocked on `ask_user_question` has no other use for an inbound
    // text message: the next reply becomes the free-text answer.
    if (await this.tryAnswerPendingQuestion(msg, content)) return

    // 1. Real topic route first (works without a mention, per product spec).
    if (msg.threadId !== undefined) {
      const record = this.routes.get(msg.threadId)
      if (record !== undefined) {
        // Only the topic creator may continue its Session (admission already
        // passed, but another authorized user could be in the same group).
        if (!this.access.ownsRoute(msg, record)) return
        await this.routeOperations.run(record.key, () => {
          if (!this.started) return
          return this.continueSession(msg, this.routes.get(record.key) ?? record, content)
        })
        return
      }
    }

    // 2. Degraded chat-scoped route (topic-less fallback sessions).
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const chatRecord = this.routes.get(chatKey)
    if (chatRecord !== undefined) {
      if (!this.access.ownsRoute(msg, chatRecord)) return
      await this.routeOperations.run(chatRecord.key, () => {
        if (!this.started) return
        return this.continueSession(msg, this.routes.get(chatRecord.key) ?? chatRecord, content)
      })
      return
    }

    // 3. In-flight establishment for this (chat, user) pair: wait for it and
    //    re-route with serial semantics (see the `establishing` field docs).
    const pending = this.establishing.get(chatKey)
    if (pending !== undefined) {
      const record = await pending.catch(() => undefined)
      if (record !== undefined
        && (record.kind === 'chat' || (msg.threadId !== undefined && msg.threadId === record.key))) {
        await this.routeOperations.run(record.key, () => {
          if (!this.started) return
          return this.continueSession(msg, this.routes.get(record.key) ?? record, content)
        })
        return
      }
      // Thread-scoped record but this message is not in that topic (or the
      // establishment failed): fall through — a fresh session is what the
      // serial order would have produced too.
    }

    // 4. New session: groups require a mention (unless disabled).
    if (msg.chatType === 'group' && this.config.requireMention && !msg.mentionedBot) return

    await this.startSession(msg, content)
  }

  /**
   * Archive the attachment payload of one message, if any. Returns `undefined`
   * when the message carries no archivable payload; otherwise the archive
   * result whose `text` is the remaining prompt (possibly empty).
   *
   * Runs inside the same per-route FIFO as turns so a caption sent right after
   * a file is queued behind the file's download instead of racing it.
   */
  private async archiveAttachments(msg: NormalizedMessage): Promise<AttachmentArchiveResult | undefined> {
    const hasResources = (msg.resources ?? []).some(
      resource => resource.type === 'image' || resource.type === 'file',
    )
    if (!hasResources && msg.rawContentType !== 'merge_forward') return undefined

    const threadRecord = msg.threadId === undefined ? undefined : this.routes.get(msg.threadId)
    // A foreign topic must never receive this sender's attachments: the
    // archive path resolves the workspace from the route record.
    if (threadRecord !== undefined && !this.access.ownsRoute(msg, threadRecord)) return undefined
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const record = threadRecord ?? this.routes.get(chatKey)
    // A brand-new group conversation still needs a mention; a topic the bot
    // already owns does not.
    if (record === undefined && msg.chatType === 'group'
      && this.config.requireMention && !msg.mentionedBot) {
      return { saved: 0, failed: 0, attachmentOnly: true, text: '' }
    }

    return await this.routeOperations.run(record?.key ?? chatKey, async () => {
      if (!this.started) return { saved: 0, failed: 0, attachmentOnly: true, text: '' }
      const workspacePath = record?.workspacePath
        ?? (await ensureWorkspace(
          this.ctx, this.config.baseDir, msg.chatType, msg.chatId, msg.senderId,
        )).path
      return await this.attachments.archive(msg, workspacePath)
    })
  }
  /**
   * Consume one plain reply as an `ask_user_question` free-text answer.
   *
   * Only sessions with a pending question are intercepted, so ordinary
   * conversation and commands are untouched.
   */
  private async tryAnswerPendingQuestion(msg: NormalizedMessage, content: string): Promise<boolean> {
    const answerer = this.questionAnswerer
    if (answerer === undefined || answerer.pendingCount() === 0) return false
    const route = await this.commandRoute(msg)
    if (route === undefined || !this.access.ownsRoute(msg, route)) return false
    if (!answerer.hasPendingFor(route.sessionId)) return false
    if (!answerer.submitText(route.sessionId, content)) return false
    await this.delivery.commandCard(msg, {
      kind: 'success', command: 'ask_user_question', sessionId: route.sessionId,
      text: '已记录你的文字回答。',
    }, { createThread: false })
    return true
  }
  /** Resolve the route visible to one command without creating a Session. */
  /** Public read-only route resolution (used by the command plane too). */
  async resolveRoute(msg: NormalizedMessage): Promise<RouteRecord | undefined> {
    return await this.commandRoute(msg)
  }

  private async commandRoute(msg: NormalizedMessage): Promise<RouteRecord | undefined> {
    if (msg.threadId !== undefined) {
      const threaded = this.routes.get(msg.threadId)
      if (threaded !== undefined) return threaded
    }
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const degraded = this.routes.get(chatKey)
    if (degraded !== undefined) return degraded
    const pending = this.establishing.get(chatKey)
    if (pending === undefined) return undefined
    const record = await pending.catch(() => undefined)
    if (record?.kind === 'chat') return record
    if (record !== undefined && msg.threadId === record.key) return record
    return undefined
  }
  /**
   * Serialize session establishment per (chat, user) pair. The promise is
   * registered under the chat-scoped key SYNCHRONOUSLY (the key is known
   * before any network op), so concurrent first messages all observe the same
   * in-flight establishment instead of racing each other. The entry lives
   * exactly as long as the establishment; waiters holding the promise still
   * see the settled record after the entry is gone.
   */
  private startSession(msg: NormalizedMessage, content: string): Promise<RouteRecord> {
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const existing = this.establishing.get(chatKey)
    if (existing !== undefined) return existing
    const promise = this.establishSession(msg, content, chatKey)
    this.establishing.set(chatKey, promise)
    void promise.then(
      () => { this.establishing.delete(chatKey) },
      () => { this.establishing.delete(chatKey) },
    )
    return promise
  }
  private async establishSession(msg: NormalizedMessage, content: string, chatKey: string): Promise<RouteRecord> {
    // 0. One-time onboarding for a private chat (persisted, never repeats).
    if (this.config.welcomeOnboarding && msg.chatType === 'p2p') {
      await this.sendOnboardingCard(msg)
    }

    // 1. "Typing" reaction immediately (id captured for the swap).
    const typingPromise = this.delivery.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)

    // 2. Workspace directory for this (user × chat) pair.
    const workspace = await ensureWorkspace(
      this.ctx, this.config.baseDir, msg.chatType, msg.chatId, msg.senderId,
    )

    const sessionId = randomUUID() as SessionId
    const initialStats = { sessionId, inputTokens: 0, outputTokens: 0 }

    // 3. First card frame — also creates the topic (reply_in_thread).
    const sent = await this.delivery.replyFirstCard(msg, initialStreamingCard(sessionId))
    const typingId = await typingPromise

    // 3.5 Repair snapshot FIRST (before the route record and the agent):
    // the crash window between the two writes then degrades to an orphan
    // snapshot — which startup repair handles safely — instead of a zombie
    // streaming card with no snapshot at all.
    await this.repair.write({
      key: sent.messageId,
      sessionId,
      chatId: msg.chatId,
      triggerMessageId: msg.messageId,
      reactionId: typingId,
      cards: [{ messageId: sent.messageId, mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
    })

    // 4. Create the agent/session bound to the workspace directory.
    let handle: AgentHandle
    try {
      handle = await this.sessions.createSession(sessionId, workspace.path)
    } catch (error) {
      // The card lands in a final failure state — no repair needed later.
      void this.repair.clear(sent.messageId)
      await this.delivery.requireChannel().updateCard(sent.messageId, buildCard({
        phase: 'done',
        reasoning: '',
        body: `会话创建失败：${String(error)}`,
        stats: { ...initialStats },
      })).catch(() => {})
      throw error
    }
    void Promise.resolve(workspace.attachSession(sessionId)).catch(error => {
      this.ctx.logger?.warn?.(
        'dsh-channels: attaching initial session %s to workspace failed: %s',
        sessionId, String(error),
      )
    })

    // 5. Persist the route (thread-scoped, or degraded chat-scoped).
    const key = sent.degraded || sent.threadId === undefined ? chatKey : sent.threadId
    const createdAt = handle.agent.session.header.createdAt
    const record: RouteRecord = {
      key,
      kind: sent.degraded || sent.threadId === undefined ? 'chat' : 'thread',
      sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderOpenId: msg.senderId,
      workspacePath: workspace.path,
      cardMessageId: sent.messageId,
      createdAt,
      lastActivityAt: createdAt,
      sessionHistory: [{ sessionId, createdAt }],
    }
    await this.routes.put(key, record)

    // 6. Stream into the card and hand the message to the driver.
    this.streamer?.attach(handle.agent.session, sent.messageId, msg.messageId, typingId)
    handle.agent.followup(feishuUserMessage(content))
    return record
  }
  private async continueSession(msg: NormalizedMessage, record: RouteRecord, content: string): Promise<void> {
    // Defence in depth: every current caller checks this first, but a future
    // call path must not be able to continue another user's Session.
    if (!this.access.ownsRoute(msg, record)) return
    const typingPromise = this.delivery.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)
    const live = await this.sessions.ensureLive(record)

    const sent = await this.delivery.replyFirstCard(msg, initialStreamingCard(record.sessionId))
    const typingId = await typingPromise

    // Repair snapshot first — same crash-window reasoning as `startSession`.
    await this.repair.write({
      key: sent.messageId,
      sessionId: record.sessionId,
      chatId: msg.chatId,
      triggerMessageId: msg.messageId,
      reactionId: typingId,
      cards: [{ messageId: sent.messageId, mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
    })

    await this.routes.put(record.key, {
      ...record,
      cardMessageId: sent.messageId,
      lastActivityAt: Date.now(),
    })
    this.streamer?.attach(live.agent.session, sent.messageId, msg.messageId, typingId)
    live.agent.followup(feishuUserMessage(content))
  }
}
