/**
 * The Feishu bridge service: inbound routing, workspace/session ownership,
 * topic creation, and streaming-card orchestration.
 *
 * Ownership model (one workspace per user × chat):
 *  - p2p:   one workspace per (bot, user), all of that user's sessions inside;
 *  - group: one workspace per (chat, user), sessions grouped per user.
 *
 * Routing model:
 *  - `thread_id` → bound session (no @ needed inside an owned topic);
 *  - degraded chat-scoped keys when Feishu refuses topic replies;
 *  - new topic + new session for an @-triggered message without a route.
 *
 * @module dsh-channels/service
 */

import { randomUUID } from 'node:crypto'
import type {
  Agent,
  AgentHandle,
  AgentPresets,
  AgentSetup,
  CredentialProvider,
  HostContext,
  LlmService,
  Session,
  SessionId,
  TokenMeter,
  UserMessage,
} from './dsh-types.ts'
import { buildCard } from './cards.ts'
import type { CardState } from './cards.ts'
import { chatRouteKey, feishuDomain } from './domain.ts'
import type { FeishuDomainGlobal, FeishuDomainHandle, RawDomainHandle, RouteRecord } from './domain.ts'
import type { ChannelFactory, FeishuChannel, NormalizedMessage } from './feishu-channel.ts'
import { ACTIVITY_BUILD_MARKER, TurnStreamer } from './streamer.ts'
import type { StreamerHooks } from './streamer.ts'
import { ensureWorkspace } from './workspaces.ts'
import type { FeishuConfig } from './config.ts'

/** Build one durable user message from inbound Feishu text (no host runtime import). */
export function feishuUserMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

interface LiveAgent {
  agent: Agent
  handle: AgentHandle
}

/**
 * Wrap a live agent owned by someone else (web UI api-remote resolver, a
 * previous plugin instance, a won cold-resume race). The borrow is fully
 * deliverable through `followup`, but `dispose` is a no-op — the real owner
 * retains the lifecycle, and shutting the plugin down must never kill it.
 */
function borrowLiveAgent(agent: Agent): LiveAgent {
  return { agent, handle: { agent, dispose: async () => {} } }
}

/** What `agents.create`/`resume` need to compose one agent from a preset. */
interface PresetComposition {
  /** Preset id recorded on the session header meta (absent without a roster). */
  agentPreset?: string
  /** Mounts the resolved preset inside the agent factory's setup. */
  setup?: AgentSetup
}

/** Wrap the host's storage facility open behind a stable local type. */
async function openFeishuDomain(ctx: HostContext): Promise<FeishuDomainHandle> {
  const domain = await ctx.storageDomain.open(feishuDomain) as unknown as RawDomainHandle
  const table = domain.table('routes')
  return {
    routes: {
      get: key => table.get(key) as RouteRecord | undefined,
      put: (key, value) => table.put(key, value),
      delete: key => table.delete(key),
      entries: () => table.entries() as IterableIterator<[string, RouteRecord]>,
    },
    getGlobal: () => (domain.global.get() ?? {}) as FeishuDomainGlobal,
    setGlobal: value => domain.global.set(value),
    close: () => domain.close(),
  }
}

/**
 * Resolve one credential reference through the host credentials seam.
 *
 * Precedence is owned by the provider (env > `$DSH_HOME/.credentials.yaml`
 * > `.env` fallbacks). Without a mounted seam the process environment is the
 * whole credential plane.
 */
async function resolveCredentialRef(ctx: HostContext, ref: string): Promise<string> {
  const provider = ctx.get?.('credentials') as CredentialProvider | undefined
  if (provider !== undefined) {
    const hit = await provider.resolve(ref)
    if (hit !== undefined) return hit.value
  } else {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient !== '') return ambient
  }
  throw new Error(
    `dsh-channels: credential "${ref}" is not configured; add it to $DSH_HOME/.credentials.yaml `
    + `(e.g. "${ref}: <value>") or export it in the launching environment`,
  )
}

export class FeishuService {
  private readonly ctx: HostContext
  private readonly config: FeishuConfig
  private readonly channelFactory: ChannelFactory
  private channel: FeishuChannel | undefined
  private streamer: TurnStreamer | undefined
  private domain: FeishuDomainHandle | undefined
  private readonly routeCache = new Map<string, RouteRecord>()
  private readonly live = new Map<string, LiveAgent>()
  private readonly pendingResume = new Map<string, Promise<LiveAgent>>()
  /** `<provider>/<model>` → context window (lazy async fill; sync reads). */
  private readonly contextWindows = new Map<string, number>()
  private readonly windowRequests = new Set<string>()
  private started = false
  private unlisten: (() => void) | undefined

  constructor(ctx: HostContext, config: FeishuConfig, channelFactory: ChannelFactory) {
    this.ctx = ctx
    this.config = config
    this.channelFactory = channelFactory
  }

  /** The live channel (created in `start()` once credentials resolve). */
  private requireChannel(): FeishuChannel {
    if (this.channel === undefined) throw new Error('dsh-channels: channel not started')
    return this.channel
  }

  /** Wire events and open the long connection. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // 1. Resolve credentials through the host seam (env > .credentials.yaml > .env).
    const appId = await resolveCredentialRef(this.ctx, this.config.appId)
    const appSecret = await resolveCredentialRef(this.ctx, this.config.appSecret)

    // 2. Build the channel with the resolved secrets.
    const channel = this.channelFactory({
      appId,
      appSecret,
      loggerLevel: this.config.loggerLevel,
      requireMention: this.config.requireMention,
      dmMode: this.config.dmMode,
    })
    this.channel = channel
    const hooks: StreamerHooks = {
      measureContext: session => this.measureContext(session),
      sessionLabel: sessionId => sessionId,
      onError: (_key, error) => {
        this.ctx.logger?.warn?.('dsh-channels stream error: %s', String(error))
      },
      onTurnFinalized: () => { /* reaction swap is handled per turn inside the streamer */ },
      sendSegmentCard: (sessionId, segment, card, fallbackText) =>
        this.sendSegmentCard(sessionId, segment, card, fallbackText),
    }
    this.streamer = new TurnStreamer(
      channel,
      this.config.refreshMs,
      hooks,
      this.config.statusRefreshMs,
    )

    this.domain = await openFeishuDomain(this.ctx)
    for (const [key, record] of this.domain.routes.entries()) {
      this.routeCache.set(key, record)
    }

    this.ctx.on('session/event', (session, event) => {
      this.streamer?.onSessionEvent(session, event)
    })
    this.unlisten = channel.onMessage(message => {
      void this.handleMessage(message).catch((error: unknown) => {
        this.ctx.logger?.warn?.('dsh-channels inbound error: %s', String(error))
        // User-facing safety net: never leave the user without a reply.
        void channel
          .send(message.chatId, { text: `dsh-channels 处理失败：${String(error)}` }, { replyTo: message.messageId })
          .catch(() => {})
      })
    })
    await channel.connect()
    this.ctx.logger?.info?.(
      'dsh-channels: feishu long connection established (bot open_id %s, %d route(s) loaded)',
      channel.botOpenId() ?? 'unknown',
      this.routeCache.size,
    )
    console.info('[dsh-channels] feishu long connection established, bot open_id:', channel.botOpenId())
    console.info('[dsh-channels] activity build:', ACTIVITY_BUILD_MARKER)
  }

  /** Tear down: close the connection and dispose all live agents. */
  async shutdown(): Promise<void> {
    this.unlisten?.()
    this.unlisten = undefined
    for (const { handle } of this.live.values()) {
      await handle.dispose().catch(() => {})
    }
    this.live.clear()
    this.pendingResume.clear()
    try {
      await this.channel?.disconnect()
    } catch {
      // Already disconnected is fine.
    }
    this.channel = undefined
    this.streamer = undefined
    await this.domain?.close()
    this.domain = undefined
    this.started = false
  }

  // ---- inbound routing -------------------------------------------------

  private async handleMessage(msg: NormalizedMessage): Promise<void> {
    const botId = this.requireChannel().botOpenId()
    if (botId !== undefined && msg.senderId === botId) return
    if (msg.chatType !== 'p2p' && msg.chatType !== 'group') return
    const content = (msg.content ?? '').trim()
    if (content === '') return

    if (msg.chatType === 'p2p' && this.config.dmMode === 'disabled') return

    // 1. Real topic route first (works without a mention, per product spec).
    if (msg.threadId !== undefined) {
      const record = this.lookupRoute(msg.threadId)
      if (record !== undefined) {
        await this.continueSession(msg, record)
        return
      }
    }

    // 2. Degraded chat-scoped route (topic-less fallback sessions).
    const chatKey = chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
    const chatRecord = this.lookupRoute(chatKey)
    if (chatRecord !== undefined) {
      await this.continueSession(msg, chatRecord)
      return
    }

    // 3. New session: groups require a mention (unless disabled).
    if (msg.chatType === 'group' && this.config.requireMention && !msg.mentionedBot) return

    await this.startSession(msg, content)
  }

  private lookupRoute(key: string): RouteRecord | undefined {
    const cached = this.routeCache.get(key)
    if (cached !== undefined) return cached
    const stored = this.domain?.routes.get(key)
    if (stored !== undefined) this.routeCache.set(key, stored)
    return stored
  }

  private async persistRoute(key: string, record: RouteRecord): Promise<void> {
    this.routeCache.set(key, record)
    await this.domain?.routes.put(key, record)
  }

  /** Find the route record owning a session (prefers the thread route). */
  private findRouteBySession(sessionId: string): RouteRecord | undefined {
    let fallback: RouteRecord | undefined
    for (const record of this.routeCache.values()) {
      if (record.sessionId !== sessionId) continue
      if (record.kind === 'thread') return record
      fallback ??= record
    }
    return fallback
  }

  /**
   * Send one body-segment continuation card into the session's topic (or, for
   * degraded chat-scoped routes, as a plain reply anchored to the main card).
   * When Feishu rejects the card (e.g. per-card table limit, error 11310) the
   * segment is re-delivered as a plain-text message so the content is never
   * lost — text messages carry no card constraints.
   */
  private async sendSegmentCard(
    sessionId: string,
    segment: number,
    card: object,
    fallbackText: string,
  ): Promise<{ messageId: string; mode: 'card' | 'text' }> {
    const record = this.findRouteBySession(sessionId)
    if (record === undefined) {
      throw new Error(`dsh-channels: no route record for session ${sessionId}; segment card not sent`)
    }
    const options = { replyTo: record.cardMessageId, replyInThread: record.kind === 'thread' }
    try {
      const res = await this.requireChannel().send(record.chatId, { card }, options)
      return { messageId: res.messageId, mode: 'card' }
    } catch (error) {
      this.ctx.logger?.warn?.(
        'dsh-channels: segment %d card for session %s rejected, falling back to plain text: %s',
        segment, sessionId, String(error),
      )
      const res = await this.requireChannel().send(record.chatId, {
        text: `📄 回复分段 ${segment}（卡片发送失败，已降级为纯文本）\n\n${fallbackText}`,
      }, options)
      return { messageId: res.messageId, mode: 'text' }
    }
  }

  // ---- session lifecycle ----------------------------------------------

  private agentOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {}
    if (this.config.provider !== undefined) options.provider = this.config.provider
    if (this.config.model !== undefined) options.model = this.config.model
    if (this.config.maxTokens !== undefined) options.maxTokens = this.config.maxTokens
    return options
  }

  /**
   * Resolve the agent-preset composition for sessions this plugin creates or
   * resumes.
   *
   * `agents.create()` never applies a preset on its own — the caller composes
   * the agent's world through the `setup` callback, which the factory awaits
   * before publishing the session. In web-profile deployments the model-facing
   * tools exist only inside agent presets (the host disables the tool rows at
   * the host layer), so sessions created without mounting one reach the model
   * with an empty tool list: the agent writes `<tool_calls>` as plain text and
   * stops. Web-UI sessions mount the default preset via `session.create`;
   * channels sessions must do the same through `setup`, and record the preset
   * id on the header meta exactly like the host's own `composeAgent` does.
   *
   * The id resolves BEFORE the session exists because the session boundary
   * snapshots `meta` before asynchronous setup begins. Mounting stays inside
   * `setup`, where a failure rolls the whole creation back rather than
   * publishing a session whose capabilities are half-installed.
   *
   * Deployments without a preset roster compose nothing: their tools live in
   * the host composition and the agent already sees them.
   */
  private async resolvePresetComposition(): Promise<PresetComposition> {
    // Read through ctx.get (safe lookup): only the web profile ships a roster,
    // and direct property access on a cordis context throws for services the
    // plugin did not inject.
    const presets = this.ctx.get?.('agentPresets') as AgentPresets | undefined
    if (presets === undefined) return {}
    const resolved = await presets.resolve(this.config.agentPreset)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  private async startSession(msg: NormalizedMessage, content: string): Promise<void> {
    // 1. "Typing" reaction immediately (id captured for the swap).
    const typingPromise = this.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)

    // 2. Workspace directory for this (user × chat) pair.
    const workspace = await ensureWorkspace(
      this.ctx, this.config.baseDir, msg.chatType, msg.chatId, msg.senderId,
    )

    const sessionId = randomUUID() as SessionId
    const initialStats = { sessionId, inputTokens: 0, outputTokens: 0 }

    // 3. First card frame — also creates the topic (reply_in_thread).
    const sent = await this.sendReplyCard(msg, this.initialCard(sessionId))
    const typingId = await typingPromise

    // 4. Create the agent/session bound to the workspace directory.
    let handle: AgentHandle
    try {
      const composition = await this.resolvePresetComposition()
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspace.path,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions: this.agentOptions(),
        setup: composition.setup,
      })
    } catch (error) {
      await this.requireChannel().updateCard(sent.messageId, buildCard({
        phase: 'done',
        reasoning: '',
        body: `会话创建失败：${String(error)}`,
        stats: { ...initialStats },
      })).catch(() => {})
      throw error
    }
    this.live.set(sessionId, { agent: handle.agent, handle })
    workspace.attachSession?.(sessionId)

    // 5. Persist the route (thread-scoped, or degraded chat-scoped).
    const key = sent.degraded || sent.threadId === undefined
      ? chatRouteKey(msg.chatType, msg.chatId, msg.senderId)
      : sent.threadId
    await this.persistRoute(key, {
      key,
      kind: sent.degraded || sent.threadId === undefined ? 'chat' : 'thread',
      sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderOpenId: msg.senderId,
      workspacePath: workspace.path,
      cardMessageId: sent.messageId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    })

    // 6. Stream into the card and hand the message to the driver.
    this.streamer?.attach(handle.agent.session, sent.messageId, msg.messageId, typingId)
    handle.agent.followup(feishuUserMessage(content))
  }

  private async continueSession(msg: NormalizedMessage, record: RouteRecord): Promise<void> {
    const typingPromise = this.requireChannel().addReaction(msg.messageId, 'Typing').catch(() => undefined)
    const live = await this.ensureLiveAgent(record)

    const sent = await this.sendReplyCard(msg, this.initialCard(record.sessionId as SessionId))
    const typingId = await typingPromise

    await this.persistRoute(record.key, {
      ...record,
      cardMessageId: sent.messageId,
      lastActivityAt: Date.now(),
    })
    this.streamer?.attach(live.agent.session, sent.messageId, msg.messageId, typingId)
    live.agent.followup(feishuUserMessage(msg.content))
  }

  private async ensureLiveAgent(record: RouteRecord): Promise<LiveAgent> {
    const live = this.live.get(record.sessionId)
    if (live !== undefined) return live

    // The session may already be live under another owner — the web UI's
    // api-remote resolver, a previous plugin instance whose shutdown is still
    // draining, or a concurrent cold resume that won the race. `agents.resume`
    // refuses a live session ("cannot prepare … while it is live"), so BORROW
    // the live agent instead: `followup` delivery works identically and the
    // owning side keeps the dispose responsibility.
    const foreign = this.ctx.agents.get(record.sessionId as SessionId)
    if (foreign !== undefined) return borrowLiveAgent(foreign)

    let pending = this.pendingResume.get(record.sessionId)
    if (pending === undefined) {
      // Compose the resumed world from the same preset resolution as creation
      // (config override or roster default). A session persisted before this
      // fix has no preset recorded on its header; re-resolving here is what
      // repairs it on the first resume after a restart.
      pending = this.resolvePresetComposition()
        .then(composition => this.ctx.agents.resume({
          resumeSessionId: record.sessionId as SessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        }))
        .then(handle => {
          if (!this.started) {
            // Shutdown raced this in-flight resume: dispose the just-published
            // agent so it cannot leak into the live registry of the next
            // instance (whose every resume would then fail as "while it is live").
            void handle.dispose().catch(() => {})
            throw new Error('dsh-channels: session resume aborted by shutdown')
          }
          const liveAgent: LiveAgent = { agent: handle.agent, handle }
          this.live.set(record.sessionId, liveAgent)
          return liveAgent
        })
        .catch((error: unknown) => {
          // Lost a cold-resume race: another owner published the session
          // while our resume was in flight. Borrow the winner instead of
          // failing the turn with "cannot prepare … while it is live".
          const winner = this.ctx.agents.get(record.sessionId as SessionId)
          if (winner !== undefined) return borrowLiveAgent(winner)
          throw error
        })
        .finally(() => {
          this.pendingResume.delete(record.sessionId)
        })
      this.pendingResume.set(record.sessionId, pending)
    }
    return await pending
  }

  // ---- outbound helpers ------------------------------------------------

  private initialCard(sessionId: SessionId): object {
    const state: CardState = {
      phase: 'thinking',
      reasoning: '',
      body: '',
      stats: { sessionId, inputTokens: 0, outputTokens: 0 },
    }
    return buildCard(state)
  }

  /**
   * Reply with the first card frame. Prefers topic replies (`reply_in_thread`)
   * — the documented way a bot creates a topic — and falls back to a plain
   * reply when Feishu refuses (degraded chat-scoped routing).
   */
  private async sendReplyCard(
    msg: NormalizedMessage,
    card: object,
  ): Promise<{ messageId: string; threadId?: string; degraded: boolean }> {
    try {
      const res = await this.requireChannel().send(
        msg.chatId,
        { card },
        { replyTo: msg.messageId, replyInThread: true },
      )
      const threadId = await this.requireChannel().threadIdOfMessage(res.messageId).catch(() => undefined)
      return { messageId: res.messageId, threadId, degraded: false }
    } catch (error) {
      if (this.config.threadFallback === 'strict') throw error
      const res = await this.requireChannel().send(msg.chatId, { card }, { replyTo: msg.messageId })
      return { messageId: res.messageId, degraded: true }
    }
  }

  /** Context pressure for the card's second info line (synchronous fold). */
  private measureContext(session: Session): { contextTokens?: number; contextWindow?: number } {
    let contextTokens: number | undefined
    try {
      // Optional peers are read through ctx.get (safe lookup); direct property
      // access on a cordis context throws for services the plugin did not inject.
      const meter = this.ctx.get?.('tokenMeter') as TokenMeter | undefined
      contextTokens = meter?.measure(session).totalTokens
    } catch {
      contextTokens = undefined
    }

    let contextWindow: number | undefined
    try {
      const headers = session.events.filter(event => event.type === 'request/header')
      const last = headers.at(-1)
      if (last !== undefined && last.type === 'request/header') {
        const config = last.data.header?.config as { provider?: unknown; model?: unknown } | undefined
        if (typeof config?.provider === 'string' && typeof config.model === 'string') {
          const routeKey = `${config.provider}/${config.model}`
          contextWindow = this.contextWindows.get(routeKey)
          if (contextWindow === undefined && !this.windowRequests.has(routeKey)) {
            this.windowRequests.add(routeKey)
            const llm = this.ctx.get?.('llm') as LlmService | undefined
            void llm?.resolveModelInfo(config.provider, config.model)
              .then(info => {
                if (info?.context?.contextWindow !== undefined) {
                  this.contextWindows.set(routeKey, info.context.contextWindow)
                }
              })
              .catch(() => {})
          }
        }
      }
    } catch {
      contextWindow = undefined
    }

    return { contextTokens, contextWindow }
  }
}
