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
import type {
  AgentHandle, AttachmentStore, ContentBlock, HostContext, SessionId, UserMessage, Workspace,
} from '../dsh-types.ts'
import type { AttachmentStoreMode, FeishuConfig } from '../config.ts'
import { buildCard, buildOnboardingCard, initialStreamingCard, queuedStreamingCard } from '../cards.ts'
import { RouteOperationQueue } from '../commands.ts'
import { chatRouteKey, sessionDirOf } from '../domain.ts'
import type { FeishuDomainHandle, RouteRecord } from '../domain.ts'
import type { CardDelivery } from '../feishu/delivery.ts'
import {
  adoptStagedAttachments, attachmentsDir, attachmentResources, hasAttachmentPayload,
  inboundAttachmentState, prefetchImageAttachments,
} from '../feishu/inbound-attachments.ts'
import type {
  AttachmentFailure, InboundAttachmentState,
} from '../feishu/inbound-attachments.ts'
import { buildFeishuContextBlock, manifestEntriesOfKnownMessage, triggerManifestAttachments } from '../feishu/manifest.ts'
import {
  InboundAttachmentStore, NativeAttachmentStore, effectiveAttachmentMode,
} from '../feishu/native-attachments.ts'
import type { InboundAttachmentStoreResult } from '../feishu/native-attachments.ts'
import type { KnownAttachmentMessageInput, KnownAttachmentSource } from '../feishu/tools.ts'
import type { FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'
import type { QuestionAnswerer } from '../interactions/questions.ts'
import type { ApprovalAnswerer, ApprovalTextResult } from '../interactions/approvals.ts'
import type { InflightRepair } from '../session/repair.ts'
import type { SessionManager } from '../session/manager.ts'
import type { RouteStore } from '../session/routes.ts'
import type { TurnStreamer } from '../streamer.ts'
import {
  enterTopic, placementServices, planTopic, restoreTopicDir,
} from '../session/isolation.ts'
import type { PlacementServices, TopicPlacement, TopicPlan } from '../session/isolation.ts'
import { ensureWorkspace, stagingPathFor, topicTokenFor } from '../workspaces.ts'

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

/**
 * Read-only message access the inbound turn assembly needs: the quoted message
 * of the triggering message and the bounded first-turn topic history.
 *
 * Both methods return `undefined` for "nothing to show" (no quoted message,
 * read failed, missing permission); implementations never throw for expected
 * failures, and a silently degraded read must never block the turn (AC6).
 */
export interface InboundMessageReadPort {
  /**
   * Resolve the message the triggering message replies to. The returned
   * `block` is the ready-to-inject `<feishu_quote>` prompt block and `message`
   * the quoted message's whitelist registration (merged-forward containers are
   * registered by container id).
   */
  quote(input: {
    messageId: string
    record: RouteRecord
  }): Promise<{ block: string; message?: KnownAttachmentMessageInput } | undefined>
  /**
   * Resolve the most recent topic messages for the first turn of a new
   * Session: the ready-to-inject `<feishu_history>` block plus the per-message
   * whitelist registrations in chronological order.
   */
  history(input: {
    record: RouteRecord
    limit: number
    excludeMessageIds: readonly string[]
  }): Promise<{ block: string; messages: readonly KnownAttachmentMessageInput[] } | undefined>
}

/** Live trigger-image prefetch policy (see `prefetchImages` config). */
export interface AttachmentPrefetchPolicy {
  readonly enabled: boolean
  readonly maxImageBytes: number
  readonly maxTotalBytes: number
  readonly timeoutMs: number
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
  /** Configured inbound attachment backend (`attachmentStore`). */
  attachmentMode(): AttachmentStoreMode
  /** Host-level native attachment library; undefined = not mounted. */
  nativeAttachments(): AttachmentStore | undefined
  /** Backend-selecting archive/fallback store (legacy workspace download). */
  attachmentStore: InboundAttachmentStore
  /**
   * Pre-authorize a message's attachments for `feishu_attachment_fetch`:
   * `trigger` (the triggering message) by default, `quote`/`history`/`recent`
   * for the messages this turn's excerpt, history and manifest blocks name.
   */
  noteKnownAttachments(
    record: RouteRecord,
    message: KnownAttachmentMessageInput,
    source?: KnownAttachmentSource,
  ): void
  /**
   * Read-only message access: quoted-message excerpt, first-turn topic
   * history, and recent attachment messages. Failures degrade silently to an
   * absent value (never a throw into the turn).
   */
  messageRead: InboundMessageReadPort
  /** Live image-prefetch policy for triggering messages. */
  prefetchImages(): AttachmentPrefetchPolicy
  /** Channel-plane access control (administrator + whitelist gates). */
  access: InboundAccessPort
  /** Shared per-route FIFO admission (commands and turns must not interleave). */
  queue: RouteOperationQueue
  streamer(): TurnStreamer | undefined
  questionAnswerer(): QuestionAnswerer | undefined
  approvalAnswerer(): ApprovalAnswerer | undefined
  commands: CommandPlanePort
}

/** Confirmation line for each keyword approval reply. */
const APPROVAL_TEXT_REPLIES: Record<Exclude<ApprovalTextResult, 'superseded'>, string> = {
  allowed: '已允许本次操作。',
  remembered: '已允许，本话题内同类操作不再询问。',
  denied: '已拒绝本次操作。',
}

/**
 * User-facing text for attachments that could not be archived. Delivered as a
 * plain reply (never a card) so the user learns why the Agent cannot read a
 * file instead of silently getting an answer about older attachments.
 */
export function buildAttachmentFailureNotice(failures: readonly AttachmentFailure[]): string {
  const lines = failures.map(failure => `• ${failure.name}：${failure.reason}`)
  return [
    '⚠️ 附件保存失败，Agent 无法读取：',
    ...lines,
    '可尝试压缩/拆分后重发，或把文件直接放到工作区目录。',
  ].join('\n')
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

/**
 * Whitelist registration input for one triggering message.
 *
 * The fetch tool requires explicit per-route authorization; the trigger
 * message is the one exception the admission layer can vouch for. Resources
 * are copied from the same normalization the manifest uses, and merged-forward
 * containers carry no direct resources (the tool expands them through the
 * container id, per the P0 rule).
 */
export function knownAttachmentMessageOf(msg: NormalizedMessage): KnownAttachmentMessageInput {
  const forwarded = msg.rawContentType === 'merge_forward'
  const resources = attachmentResources(msg).map(resource => ({
    type: resource.type,
    fileKey: resource.fileKey,
    ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
    ...(resource.folder === true ? { folder: true } : {}),
  }))
  return {
    messageId: msg.messageId,
    kind: forwarded ? 'merge_forward' : 'message',
    resources,
    senderUserId: msg.senderId,
  }
}

/** Feishu message-id shape accepted for quote resolution (`om_...`). */
const QUOTE_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/u

/** Read-only prompt context assembled for one turn (quote excerpt + history). */
interface TurnReadContext {
  /** Ready `<feishu_quote>` text block, when the message quotes something. */
  quoteBlock?: string
  /** Whitelist registration of the quoted message (manifest/discoverability). */
  quoteMessage?: KnownAttachmentMessageInput
  /** Ready `<feishu_history>` text block, first turn only. */
  historyBlock?: string
}

/** Per-turn inputs of the prompt assembly. */
interface TurnDeliveryOptions {
  /** New Session's first turn: attach the bounded topic history bootstrap. */
  firstTurn?: boolean
  /**
   * Message ids never shown in the history block or listed as recent
   * attachments (trigger + streaming card).
   */
  excludeMessageIds?: readonly string[]
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
  /**
   * route key → first-turn delivery gate. A new Session persists its route
   * before the prompt is assembled (image prefetch); a message that observes
   * the route in that window must wait for the first followup instead of
   * racing it, otherwise the topic's turns reach the model out of order.
   */
  private readonly firstDeliveries = new Map<string, { promise: Promise<void>; release(): void }>()

  constructor(private readonly deps: InboundDeps) {}

  private get ctx(): HostContext { return this.deps.ctx }
  private get config(): FeishuConfig { return this.deps.config }
  private get started(): boolean { return this.deps.started() }
  private get routes(): RouteStore { return this.deps.routes }
  private get repair(): InflightRepair { return this.deps.repair }
  private get delivery(): CardDelivery { return this.deps.delivery }
  private get sessions(): SessionManager { return this.deps.sessions }
  private get attachmentStore(): InboundAttachmentStore { return this.deps.attachmentStore }
  private get routeOperations(): RouteOperationQueue { return this.deps.queue }
  private get streamer(): TurnStreamer | undefined { return this.deps.streamer() }
  private get questionAnswerer(): QuestionAnswerer | undefined { return this.deps.questionAnswerer() }
  private get approvalAnswerer(): ApprovalAnswerer | undefined { return this.deps.approvalAnswerer() }
  private get domain(): FeishuDomainHandle | undefined { return this.deps.domain() }
  private get access(): InboundAccessPort { return this.deps.access }

  /** Retire dedup entries older than the retention cutoff (GC sweep). */
  pruneAccepted(cutoff: number): void {
    for (const [messageId, acceptedAt] of this.accepted) {
      if (acceptedAt < cutoff) this.accepted.delete(messageId)
    }
  }

  /**
   * Open the first-turn delivery gate of one route. Registered BEFORE the
   * route record is persisted, so any message that can observe the route also
   * observes its gate. The returned closer must be called exactly once.
   */
  private openDeliveryGate(key: string): () => void {
    let settle!: () => void
    const promise = new Promise<void>((resolve) => { settle = resolve })
    const release = (): void => {
      if (this.firstDeliveries.get(key)?.promise === promise) this.firstDeliveries.delete(key)
      settle()
    }
    this.firstDeliveries.set(key, { promise, release })
    return release
  }

  /** Wait for the in-flight first followup of a route, when one is pending. */
  private async awaitFirstDelivery(key: string): Promise<void> {
    const pending = this.firstDeliveries.get(key)
    if (pending !== undefined) await pending.promise.catch(() => undefined)
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
    // Resolve pending gates before dropping them so a message waiting on a
    // first-turn delivery never stays suspended across a teardown.
    for (const entry of [...this.firstDeliveries.values()]) entry.release()
    this.firstDeliveries.clear()
  }

  /** Entry point: one normalized inbound message. */
  async handle(msg: NormalizedMessage): Promise<void> {
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

    // Attachment admission. The effective backend selects between the legacy
    // synchronous workspace download (`attachmentStore: 'archive'`, or a
    // native deployment whose host does not mount the attachment service) and
    // the v2 lazy pipeline: no attachment bytes are downloaded before the
    // session/card exists, and files are never downloaded by admission at all.
    if (this.attachmentBackend() === 'archive') {
      // Attachments are archived before session work: an attachment-only
      // message produces no model turn, and a caption mixed with attachments
      // keeps only the caption as the prompt. The Agent reads the files on
      // demand later.
      const archived = await this.archiveAttachments(msg)
      if (archived !== undefined) {
        if (archived.failures.length > 0) {
          await this.delivery.noticeText(msg, buildAttachmentFailureNotice(archived.failures))
        }
        if (archived.attachmentOnly) return
        content = archived.text
        if (content === '') return
      }
    } else {
      // Native pipeline: classify without downloading. Attachment-only
      // messages and messages that cannot start a turn stay inert (no reply,
      // no reaction, no Session); a mixed caption becomes the prompt with its
      // placeholders stripped.
      const state = inboundAttachmentState(msg)
      if (state.hasPayload) {
        const resolution = this.resolveNativeAttachmentMessage(msg, state)
        if (resolution.kind === 'silent') return
        content = resolution.text
        if (content === '') return
      }
    }

    // A session blocked on an approval card reads the owner's reply as the
    // decision; any other text rejects the card and continues below as the
    // next instruction.
    if (await this.tryAnswerPendingApproval(msg, content)) return

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
        // The route may be durable while its first turn is still being
        // prepared (prefetch): stay behind that turn instead of racing it.
        await this.awaitFirstDelivery(record.key)
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
      await this.awaitFirstDelivery(chatRecord.key)
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
   * Legacy archive path: download every resource of one message into the
   * conversation workspace (or its pre-topic staging directory). Returns
   * `undefined` when the message carries no archivable payload; otherwise the
   * storage result whose `text` is the remaining prompt (possibly empty).
   *
   * Runs inside the same per-route FIFO as turns so a caption sent right after
   * a file is queued behind the file's download instead of racing it. Only the
   * `archive` effective backend calls this; the native pipeline never downloads
   * files during admission.
   */
  private async archiveAttachments(msg: NormalizedMessage): Promise<InboundAttachmentStoreResult | undefined> {
    if (!hasAttachmentPayload(msg)) return undefined

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
      return {
        mode: 'archive', saved: 0, failed: 0, failures: [], stored: [], attachmentOnly: true, text: '',
      }
    }

    return await this.routeOperations.run(record?.key ?? chatKey, async () => {
      if (!this.started) {
        return {
          mode: 'archive', saved: 0, failed: 0, failures: [], stored: [], attachmentOnly: true, text: '',
        } satisfies InboundAttachmentStoreResult
      }
      // An existing topic already has its own working directory; a
      // conversation without one stages files below baseDir until its first
      // Session creates the topic directory and adopts them.
      const directory = record === undefined
        ? stagingPathFor(this.config.baseDir, msg.chatType, msg.chatId, msg.senderId)
        : attachmentsDir(sessionDirOf(record))
      return await this.attachmentStore.store(msg, directory)
    })
  }

  /**
   * One-time legacy migration: move files older plugin versions staged below
   * `<baseDir>/_staging/...` into this conversation's topic directory.
   *
   * The v2 pipeline stores inbound attachments in the DSH native library and
   * never writes staging, so this path only adopts files left by a pre-v2
   * deployment. It is kept for one release cycle after attachment_pipeline_v2
   * ships and is then removed together with `stagingPathFor` (decisions D12).
   * A successful adoption logs one warning so operators can retire the old
   * data instead of relying on this compatibility path indefinitely.
   */
  private async adoptLegacyStagedAttachments(
    msg: NormalizedMessage,
    sessionDir: string,
    warn: (message: string, ...args: unknown[]) => void,
  ): Promise<void> {
    const adopted = await adoptStagedAttachments(
      stagingPathFor(this.config.baseDir, msg.chatType, msg.chatId, msg.senderId),
      sessionDir,
    ).catch((error: unknown) => {
      warn('dsh-channels: adopting staged attachments failed: %s', String(error))
      return 0
    })
    if (adopted > 0) {
      warn(
        'dsh-channels: adopted %d legacy staged attachment(s) into %s; the one-time _staging migration is deprecated and will be removed after one release cycle (decisions D12)',
        adopted,
        sessionDir,
      )
    }
  }

  /**
   * Effective inbound attachment backend for the live deployment.
   *
   * The lazy native pipeline can only deliver files through
   * `feishu_attachment_fetch`; with that tool disabled (or without the host
   * attachment library) the deployment falls back to the legacy archive
   * backend, where the Agent reads the downloaded workspace copies instead of
   * a manifest that would name an unavailable tool.
   */
  private attachmentBackend(): AttachmentStoreMode {
    return effectiveAttachmentMode(
      this.deps.attachmentMode(),
      this.deps.nativeAttachments(),
      this.config.feishuTools.attachmentFetch,
      this.config.acceptAttachments,
    )
  }

  /**
   * Native-pipeline attachment decision for one message, without downloading.
   *
   * Returns `{ kind: 'silent' }` when the message must stay inert (no reply,
   * no reaction, no Session, no download, no local state; a later turn finds
   * it through the recent-attachment read) and `{ kind: 'prompt', text }` when
   * a model turn starts with this text. The caller keeps the message flowing
   * through the normal route decision tree.
   */
  private resolveNativeAttachmentMessage(
    msg: NormalizedMessage,
    state: InboundAttachmentState,
  ): { kind: 'silent' } | { kind: 'prompt'; text: string } {
    if (state.attachmentOnly) return { kind: 'silent' }
    if (!this.config.acceptAttachments) return { kind: 'prompt', text: state.text }

    // Group messages without an @-mention (and without an already-bound topic)
    // never start a turn; their attachments stay discoverable from the topic a
    // later @-mentioned message creates (Roadmap AC-4).
    const threadRecord = msg.threadId === undefined ? undefined : this.routes.get(msg.threadId)
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const chatRecord = threadRecord === undefined ? this.routes.get(chatKey) : undefined
    const requiresMention = msg.chatType === 'group' && this.config.requireMention && !msg.mentionedBot
    const triggers = threadRecord !== undefined || chatRecord !== undefined
      || this.establishing.has(chatKey) || !requiresMention
    return triggers ? { kind: 'prompt', text: state.text } : { kind: 'silent' }
  }

  /**
   * Build the first-turn user message for the native pipeline: the caption
   * text, the quoted-message excerpt, the prefetched trigger images, the
   * `<feishu_context>` manifest block listing every attachment still unloaded,
   * and (first turn only) the `<feishu_history>` topic bootstrap. Optional
   * blocks are omitted entirely (no token cost) when empty.
   *
   * Runs after the session/card/route exist and before `followup`; only the
   * triggering message's images are prefetched (bounded and short-timeout),
   * files never are. Block order is stable: text, quote, images, manifest,
   * history.
   */
  private async nativeTurnMessage(
    msg: NormalizedMessage,
    record: RouteRecord,
    content: string,
    options: TurnDeliveryOptions,
  ): Promise<UserMessage> {
    const message = feishuUserMessage(content)
    const blocks: ContentBlock[] = content === '' ? [] : [{ type: 'text', text: content }]
    const state = inboundAttachmentState(msg)
    const attachmentPipeline = this.config.acceptAttachments

    // Authorize the trigger message before any prefetch attempt so the model
    // can fetch whatever the prefetch could not load.
    if (state.hasPayload && attachmentPipeline) {
      try {
        this.deps.noteKnownAttachments(record, knownAttachmentMessageOf(msg))
      } catch (error) {
        this.ctx.logger?.warn?.(
          'dsh-channels: authorizing trigger attachments of %s failed: %s',
          msg.messageId, String(error),
        )
      }
    }

    // Quote excerpt + first-turn history: read only after the trigger message
    // is durable and whitelisted (the record exists and the message is known),
    // so a quoted/earlier attachment can reference the trigger's route. The
    // read runs CONCURRENTLY with the bounded image prefetch below: neither
    // waits for the other, and a failed read degrades to its absence (AC6).
    const contextPromise = this.readTurnContext(msg, record, options)

    const loadedFileKeys = new Set<string>()
    const prefetchedBlocks: ContentBlock[] = []
    const policy = this.deps.prefetchImages()
    const images = state.resources.filter(resource => resource.type === 'image')
    if (state.hasPayload && attachmentPipeline && policy.enabled && images.length > 0) {
      const prefetched = await prefetchImageAttachments({
        msg,
        resources: images,
        channel: this.liveChannel(),
        maxImageBytes: policy.maxImageBytes,
        maxTotalBytes: policy.maxTotalBytes,
        timeoutMs: policy.timeoutMs,
        saveImage: async (bytes, name) => {
          const store = new NativeAttachmentStore({ service: () => this.deps.nativeAttachments() })
          const saved = await store.saveImage({ bytes, ...(name === undefined ? {} : { name }) })
          return saved.ok
            ? { ok: true, block: saved.value.block }
            : { ok: false, reason: saved.reason }
        },
        warn: (warning, ...args) => this.ctx.logger?.warn?.(warning, ...args),
      })
      // Spread each block into a plain object literal: the host `ContentBlock`
      // union carries an index signature that the named `ImageBlock` interface
      // does not declare, and the clone is structurally identical.
      prefetchedBlocks.push(...prefetched.blocks.map(block => ({ ...block })))
      for (const fileKey of prefetched.loadedFileKeys) loadedFileKeys.add(fileKey)
    }
    // Stable block order: text, quote, image blocks, manifest, history.
    const context = await contextPromise
    if (context.quoteBlock !== undefined) blocks.push({ type: 'text', text: context.quoteBlock })
    blocks.push(...prefetchedBlocks)

    const manifest = attachmentPipeline
      ? buildFeishuContextBlock({
        trigger: triggerManifestAttachments(msg, loadedFileKeys),
        // A quoted file must be DISCOVERABLE in the manifest (AC1): the quote
        // block names it, and this row carries the message_id/file_key the
        // model needs for feishu_attachment_fetch.
        ...(context.quoteMessage === undefined
          ? {}
          : { quote: manifestEntriesOfKnownMessage(context.quoteMessage) }),
      })
      : ''
    if (manifest !== '') blocks.push({ type: 'text', text: manifest })
    if (context.historyBlock !== undefined) blocks.push({ type: 'text', text: context.historyBlock })
    // A trigger always carries caption text, but keep the message well-formed
    // if a future call path ever reaches here with nothing to say.
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    message.content = blocks
    return message
  }

  /**
   * Deliver the prompt for one turn. The lazy native pipeline assembles the
   * attachment blocks + manifest; every other deployment keeps the plain text
   * prompt. Both backends still carry the quoted-message excerpt and (first
   * turn only) the bounded topic history: those are read-only text context and
   * remain useful without the lazy fetch tool.
   *
   * A failure in prompt assembly degrades to the plain text prompt (the turn
   * must run); a failed quote/history read degrades silently to its absence.
   */
  private async deliverTurnMessage(
    msg: NormalizedMessage,
    record: RouteRecord,
    content: string,
    options: TurnDeliveryOptions = {},
  ): Promise<UserMessage> {
    try {
      if (this.attachmentBackend() !== 'native') {
        return await this.textTurnMessage(msg, record, content, options)
      }
      return await this.nativeTurnMessage(msg, record, content, options)
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: assembling the attachment manifest for %s failed: %s',
        msg.messageId, String(error),
      )
      return feishuUserMessage(content)
    }
  }

  /**
   * Text-only turn prompt (archive/fallback deployments): the legacy single
   * text block, extended with the quote excerpt and the first-turn history
   * block when they exist. With nothing extra this is byte-identical to
   * {@link feishuUserMessage}.
   */
  private async textTurnMessage(
    msg: NormalizedMessage,
    record: RouteRecord,
    content: string,
    options: TurnDeliveryOptions,
  ): Promise<UserMessage> {
    const context = await this.readTurnContext(msg, record, options)
    if (context.quoteBlock === undefined && context.historyBlock === undefined) {
      return feishuUserMessage(content)
    }
    const blocks: ContentBlock[] = content === '' ? [] : [{ type: 'text', text: content }]
    if (context.quoteBlock !== undefined) blocks.push({ type: 'text', text: context.quoteBlock })
    if (context.historyBlock !== undefined) blocks.push({ type: 'text', text: context.historyBlock })
    const message = feishuUserMessage(content)
    message.content = blocks
    return message
  }

  /**
   * Read the read-only prompt context of one turn: the quoted-message excerpt
   * (every triggered message, per D3) and the bounded topic history (new
   * Session's first turn only). Both reads run concurrently and are bounded by
   * a short prompt budget, so a slow/stalled read can delay the turn by at
   * most {@link PROMPT_CONTEXT_TIMEOUT} — never by a model-tool timeout (AC4:
   * the first turn is not blocked by enrichment).
   */
  private async readTurnContext(
    msg: NormalizedMessage,
    record: RouteRecord,
    options: TurnDeliveryOptions,
  ): Promise<TurnReadContext> {
    const [quote, historyBlock] = await Promise.all([
      this.readQuoteBlock(msg, record),
      this.readHistoryBlock(record, options),
    ])
    return {
      ...(quote === undefined
        ? {}
        : {
          quoteBlock: quote.block,
          ...(quote.message === undefined ? {} : { quoteMessage: quote.message }),
        }),
      ...(historyBlock === undefined ? {} : { historyBlock }),
    }
  }

  /**
   * Resolve the quoted message into a `<feishu_quote>` block and register the
   * quoted message (including a merged-forward container, by container id) in
   * the route's attachment whitelist. Only messages that already triggered a
   * turn reach this point (D3: quoting the bot without @ never triggers).
   */
  private async readQuoteBlock(
    msg: NormalizedMessage,
    record: RouteRecord,
  ): Promise<{ block: string; message?: KnownAttachmentMessageInput } | undefined> {
    const messageId = msg.replyToMessageId
    if (messageId === undefined || !QUOTE_MESSAGE_ID.test(messageId)) return undefined
    try {
      const quote = await this.deps.messageRead.quote({ messageId, record })
      if (quote === undefined) return undefined
      if (quote.message !== undefined) {
        try {
          this.deps.noteKnownAttachments(record, quote.message, 'quote')
        } catch (error) {
          // Best-effort whitelist registration: the excerpt is still useful.
          this.ctx.logger?.debug?.(
            'dsh-channels: registering quoted attachments of %s failed: %s',
            messageId, String(error),
          )
        }
      }
      return quote.block === '' ? undefined : quote
    } catch (error) {
      // Missing read scope / deleted message / channel down: no excerpt.
      this.ctx.logger?.debug?.(
        'dsh-channels: reading quoted message %s failed: %s', messageId, String(error),
      )
      return undefined
    }
  }

  /**
   * Resolve the first-turn topic history into a `<feishu_history>` block and
   * register every message it shows in the route's attachment whitelist.
   * Disabled by `historyBootstrapLimit: 0`; continuations never read history.
   */
  private async readHistoryBlock(
    record: RouteRecord,
    options: TurnDeliveryOptions,
  ): Promise<string | undefined> {
    if (options.firstTurn !== true) return undefined
    const limit = this.config.historyBootstrapLimit
    if (!Number.isFinite(limit) || limit <= 0) return undefined
    try {
      const history = await this.deps.messageRead.history({
        record,
        limit,
        excludeMessageIds: options.excludeMessageIds ?? [],
      })
      if (history === undefined) return undefined
      for (const message of history.messages) {
        try {
          this.deps.noteKnownAttachments(record, message, 'history')
        } catch (error) {
          this.ctx.logger?.debug?.(
            'dsh-channels: registering history attachments of %s failed: %s',
            message.messageId, String(error),
          )
        }
      }
      return history.block === '' ? undefined : history.block
    } catch (error) {
      this.ctx.logger?.debug?.(
        'dsh-channels: reading topic history for %s failed: %s', record.key, String(error),
      )
      return undefined
    }
  }

  /** Live channel accessor for best-effort prefetch; undefined when gone. */
  private liveChannel(): FeishuChannel | undefined {
    try {
      return this.delivery.requireChannel()
    } catch {
      return undefined
    }
  }

  /**
   * Consume one plain reply as an approval decision. Only the topic owner's
   * replies in a session with an undecided approval card are intercepted.
   * @returns true when the reply was a keyword decision and is fully handled;
   * false when nothing was pending or the reply rejected the pending cards and
   * must still be delivered as the next instruction.
   */
  private async tryAnswerPendingApproval(msg: NormalizedMessage, content: string): Promise<boolean> {
    const answerer = this.approvalAnswerer
    if (answerer === undefined || answerer.pendingCount() === 0) return false
    const route = await this.commandRoute(msg)
    if (route === undefined || !this.access.ownsRoute(msg, route)) return false
    if (!answerer.hasPendingFor(route.sessionId)) return false
    const result = answerer.submitText(route.sessionId, content)
    if (result === undefined || result === 'superseded') return false
    await this.delivery.commandCard(msg, {
      kind: 'success', command: 'approval', sessionId: route.sessionId,
      text: APPROVAL_TEXT_REPLIES[result],
    }, { createThread: false })
    return true
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

    const sessionId = randomUUID() as SessionId
    const initialStats = { sessionId, inputTokens: 0, outputTokens: 0 }

    // 2. First card frame — also creates the topic (reply_in_thread). The
    //    topic identity is only known after Feishu answers, and it names the
    //    topic's private working directory inside the user's workspace.
    const sent = await this.delivery.replyFirstCard(msg, initialStreamingCard(sessionId))
    const typingId = await typingPromise
    const key = sent.degraded || sent.threadId === undefined ? chatKey : sent.threadId
    const kind = sent.degraded || sent.threadId === undefined ? 'chat' : 'thread'

    const topicToken = topicTokenFor(key, kind, sessionId)
    const services: PlacementServices = placementServices(this.ctx)
    const warn = (message: string, ...args: unknown[]): void => {
      this.ctx.logger?.warn?.(message, ...args)
    }
    /** Patch the streaming card to its terminal creation-failure state. */
    const failCreation = async (error: unknown): Promise<void> => {
      void this.repair.clear(sent.messageId)
      await this.delivery.requireChannel().updateCard(sent.messageId, buildCard({
        phase: 'done',
        reasoning: '',
        body: `会话创建失败：${String(error)}`,
        stats: { ...initialStats },
      })).catch(() => {})
    }

    // 3. User workspace (the durable project this Session is grouped under)
    //    plus the per-topic placement plan. No Agent exists yet; the plan
    //    materializes anything that must exist before creation.
    let workspace: Workspace
    let plan: TopicPlan
    try {
      workspace = await ensureWorkspace(
        this.ctx, this.config.baseDir, msg.chatType, msg.chatId, msg.senderId,
      )
      plan = await planTopic(services, this.config, workspace.path, topicToken, warn)
    } catch (error) {
      await failCreation(error)
      throw error
    }

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

    // 4. Create the Session (header cwd = user workspace when directories can
    //    be switched), then enter its own topic directory / worktree.
    let handle: AgentHandle | undefined
    let placement: TopicPlacement | undefined
    try {
      handle = await this.sessions.createSession(sessionId, plan.cwd)
      placement = await enterTopic(services, handle.agent, plan, workspace.path, topicToken, warn)
      // A workspace attachment only validates when the header cwd is the
      // workspace itself; the hard fallback (no workingDirectory service) must
      // skip it instead of logging a guaranteed failure.
      if (plan.cwd === workspace.path) {
        void Promise.resolve(workspace.attachSession(sessionId)).catch((error: unknown) => {
          warn('dsh-channels: attaching initial session %s to workspace failed: %s', sessionId, String(error))
        })
      }
      // Files staged before this topic existed by a pre-v2 deployment belong
      // to this conversation (one-time legacy adoption, see decisions D12).
      await this.adoptLegacyStagedAttachments(msg, placement.sessionDir, warn)
      await this.sessions.mountGuidance(handle.agent, placement.sessionDir)
    } catch (error) {
      // The card lands in a final failure state — no repair needed later. A
      // Session created just before the failure must not stay live unnoticed.
      await handle?.dispose().catch(() => {})
      await failCreation(error)
      throw error
    }
    if (handle === undefined || placement === undefined) {
      throw new Error('dsh-channels: session creation completed without a handle')
    }

    // 5. Persist the route (thread-scoped, or degraded chat-scoped).
    const createdAt = handle.agent.session.header.createdAt
    const record: RouteRecord = {
      key,
      kind,
      sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderUserId: msg.senderId,
      workspacePath: workspace.path,
      sessionDir: placement.sessionDir,
      ...(placement.worktreeBranch === undefined ? {} : { worktreeBranch: placement.worktreeBranch }),
      cardMessageId: sent.messageId,
      createdAt,
      lastActivityAt: createdAt,
      sessionHistory: [{ sessionId, createdAt }],
    }
    // The delivery gate is opened BEFORE the route becomes durable: a message
    // that can see the route must also wait for this Session's first followup
    // (the image prefetch below keeps the route-to-followup window open).
    const closeDeliveryGate = this.openDeliveryGate(key)
    try {
      await this.routes.put(key, record)

      // 6. Stream into the card and hand the message to the driver. The prompt
      //    is assembled only now (after the route is durable and tools are
      //    mounted): images may be prefetched, files stay lazy behind the
      //    manifest, and the (first turn only) bounded topic history plus the
      //    quoted-message excerpt are attached as text blocks. `routes.put` and
      //    `followup` stay synchronous with respect to other turns because
      //    later messages wait on the delivery gate.
      this.streamer?.attach(handle.agent.session, sent.messageId, msg.messageId, typingId)
      handle.agent.followup(await this.deliverTurnMessage(msg, record, content, {
        firstTurn: true,
        excludeMessageIds: [msg.messageId, sent.messageId],
      }))
    } finally {
      closeDeliveryGate()
    }
    return record
  }
  private async continueSession(msg: NormalizedMessage, record: RouteRecord, content: string): Promise<void> {
    // Defence in depth: every current caller checks this first, but a future
    // call path must not be able to continue another user's Session.
    if (!this.access.ownsRoute(msg, record)) return
    const services = placementServices(this.ctx)
    const warn = (message: string, ...args: unknown[]): void => {
      this.ctx.logger?.warn?.(message, ...args)
    }
    const typingPromise = this.delivery.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)
    const live = await this.sessions.ensureLive(record)
    // The topic directory can disappear independently of the Session (manual
    // deletion, external cleanup). Recreate it and re-align the effective
    // working directory so the turn never leaks into the shared workspace root.
    const placement = await restoreTopicDir(services, live.agent, {
      workspacePath: record.workspacePath,
      sessionDir: sessionDirOf(record),
      ...(record.worktreeBranch === undefined ? {} : { worktreeBranch: record.worktreeBranch }),
    }, warn)
    let current: RouteRecord = record
    if (placement.sessionDir !== sessionDirOf(record) || placement.worktreeBranch !== record.worktreeBranch) {
      current = { ...record, sessionDir: placement.sessionDir }
      delete current.worktreeBranch
      if (placement.worktreeBranch !== undefined) current = { ...current, worktreeBranch: placement.worktreeBranch }
    }
    // Files staged before this conversation's topic existed by a pre-v2
    // deployment follow its next turn (one-time legacy adoption, D12).
    await this.adoptLegacyStagedAttachments(msg, placement.sessionDir, warn)

    // A message behind a running turn opens as a queued card whose button can
    // move it into that turn instead (see `TurnStreamer.mergeQueued`).
    const firstCard = this.streamer?.hasLiveTurn(current.sessionId) === true
      ? queuedStreamingCard(current.sessionId)
      : initialStreamingCard(current.sessionId)
    const sent = await this.delivery.replyFirstCard(msg, firstCard)
    const typingId = await typingPromise

    // Repair snapshot first — same crash-window reasoning as `startSession`.
    await this.repair.write({
      key: sent.messageId,
      sessionId: current.sessionId,
      chatId: msg.chatId,
      triggerMessageId: msg.messageId,
      reactionId: typingId,
      cards: [{ messageId: sent.messageId, mode: 'card' }],
      startedAt: Date.now(),
      attempts: 0,
    })

    await this.routes.put(current.key, {
      ...current,
      cardMessageId: sent.messageId,
      lastActivityAt: Date.now(),
    })
    const message = await this.deliverTurnMessage(msg, current, content, {
      excludeMessageIds: [msg.messageId, sent.messageId],
    })
    this.streamer?.attach(live.agent.session, sent.messageId, msg.messageId, typingId, message)
    live.agent.followup(message)
  }
}
