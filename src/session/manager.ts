/**
 * Agent/session lifecycle for this channel.
 *
 * Owns the live-agent registry (including agents BORROWED from another owner),
 * cold resume serialization, agent-preset composition, the per-session
 * reasoning-effort policy, and the `/renew` transaction that atomically binds
 * a new Session to an existing Feishu route.
 *
 * `agents.create()` never applies a preset on its own — the caller composes
 * the agent's world through the `setup` callback, which the factory awaits
 * before publishing the session. In web-profile deployments the model-facing
 * tools exist only inside agent presets (the host disables the tool rows at
 * the host layer), so sessions created without mounting one reach the model
 * with an empty tool list: the agent writes `<tool_calls>` as plain text and
 * stops. Web-UI sessions mount the default preset via `session.create`;
 * channels sessions must do the same through `setup`, and record the preset id
 * on the header meta exactly like the host's own `composeAgent` does.
 *
 * @module dsh-channels/session/manager
 */

import { randomUUID } from 'node:crypto'
import type {
  Agent, AgentContext, AgentHandle, AgentPresets, AgentSetup, HostContext, Session, SessionId,
} from '../dsh-types.ts'
import type { FeishuConfig } from '../config.ts'
import { mountChannelCommands } from '../commands.ts'
import { appendSessionHistory } from '../domain.ts'
import type { RouteRecord } from '../domain.ts'
import { mountChannelGuidance } from '../feishu/agent-context.ts'
import { installRequestPolicy } from './request-policy.ts'
import type { RequestPolicyController } from './request-policy.ts'
import { workspaceTitleFor } from '../workspaces.ts'

/** One live agent plus this plugin's ownership handle. */
export interface LiveAgent {
  agent: Agent
  handle: AgentHandle
}

/** A committed `/renew`: the old and new route records plus the old handle. */
export interface RenewCommit {
  previous: RouteRecord
  current: RouteRecord
  oldLive: LiveAgent
}

/** What `agents.create`/`resume` need to compose one agent from a preset. */
export interface PresetComposition {
  /** Preset id recorded on the session header meta (absent without a roster). */
  agentPreset?: string
  /** Mounts the resolved preset inside the agent factory's setup. */
  setup?: AgentSetup
}

export interface SessionManagerDeps {
  ctx: HostContext
  config: FeishuConfig
  /** Persist one route record (the `/renew` commit writes the new binding). */
  persistRoute(key: string, record: RouteRecord): Promise<void>
  /** Whether the service still accepts work (shutdown race guard). */
  started(): boolean
  /** Drop streamer state for a session whose owner handle is being released. */
  detachStream(sessionId: string): void
  warn(message: string, ...args: unknown[]): void
}

/**
 * Wrap a live agent owned by someone else (web UI api-remote resolver, a
 * previous plugin instance, a won cold-resume race). The borrow is fully
 * deliverable through `followup`; disposal releases only the channel-owned
 * scoped policy and never the foreign Agent itself.
 */
function borrowLiveAgent(agent: Agent, release: () => void = () => {}): LiveAgent {
  return { agent, handle: { agent, dispose: async () => { release() } } }
}

export class SessionManager {
  private readonly live = new Map<string, LiveAgent>()
  private readonly pendingResume = new Map<string, Promise<LiveAgent>>()
  private readonly policies = new WeakMap<AgentContext, RequestPolicyController>()

  constructor(private readonly deps: SessionManagerDeps) {}

  /** Live agent entry for a session, when this plugin holds one. */
  get(sessionId: string): LiveAgent | undefined {
    return this.live.get(sessionId)
  }

  /** Number of live agent entries this plugin owns or borrows. */
  liveCount(): number {
    return this.live.size
  }

  /** Provider/model/token caps sessions this plugin creates. */
  agentOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {}
    const { provider, model, maxTokens } = this.deps.config
    if (provider !== undefined) options.provider = provider
    if (model !== undefined) options.model = model
    if (maxTokens !== undefined) options.maxTokens = maxTokens
    return options
  }

  /**
   * Create the root agent for one freshly routed session and register it live.
   * The caller owns the workspace attachment and the failure card.
   */
  async createSession(
    sessionId: SessionId,
    cwd: string,
    agentOptions: Record<string, unknown> = this.agentOptions(),
  ): Promise<AgentHandle> {
    const composition = await this.presetComposition(undefined, true, cwd)
    const handle = await this.deps.ctx.agents.create({
      sessionId,
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      agentOptions,
      setup: composition.setup,
    })
    this.requestPolicy(handle.agent)
    this.live.set(sessionId, { agent: handle.agent, handle })
    return handle
  }

  /**
   * Live agent for a route: this plugin's own → a foreign live agent (borrow)
   * → a serialized cold resume.
   *
   * The session may already be live under another owner — the web UI's
   * api-remote resolver, a previous plugin instance whose shutdown is still
   * draining, or a concurrent cold resume that won the race. `agents.resume`
   * refuses a live session ("cannot prepare … while it is live"), so BORROW
   * the live agent instead: `followup` delivery works identically and the
   * owning side keeps the dispose responsibility.
   */
  async ensureLive(record: RouteRecord): Promise<LiveAgent> {
    const sessionId = record.sessionId
    const own = this.live.get(sessionId)
    if (own !== undefined) return own

    const foreign = this.deps.ctx.agents.get(sessionId as SessionId)
    if (foreign !== undefined) return this.borrow(sessionId, foreign)

    let pending = this.pendingResume.get(sessionId)
    if (pending === undefined) {
      pending = this.resume(record).finally(() => {
        this.pendingResume.delete(sessionId)
      })
      this.pendingResume.set(sessionId, pending)
    }
    return await pending
  }

  /** Borrow one foreign live agent and mount this channel's scoped policy. */
  private borrow(sessionId: string, agent: Agent): LiveAgent {
    const borrowed = borrowLiveAgent(agent, this.mountRequestPolicy(agent.ctx, agent.session))
    this.live.set(sessionId, borrowed)
    return borrowed
  }

  /** Cold-resume one persisted session, losing a resume race gracefully. */
  private async resume(record: RouteRecord): Promise<LiveAgent> {
    const sessionId = record.sessionId as SessionId
    try {
      // Compose the resumed world from the same preset resolution as creation
      // (config override or roster default). A session persisted before the
      // preset fix has no preset recorded on its header; re-resolving here is
      // what repairs it on the first resume after a restart.
      const composition = await this.presetComposition(undefined, true, record.workspacePath)
      const handle = await this.deps.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: composition.setup,
      })
      if (!this.deps.started()) {
        // Shutdown raced this in-flight resume: dispose the just-published
        // agent so it cannot leak into the live registry of the next instance
        // (whose every resume would then fail as "while it is live").
        void handle.dispose().catch(() => {})
        throw new Error('dsh-channels: session resume aborted by shutdown')
      }
      this.requestPolicy(handle.agent)
      const liveAgent: LiveAgent = { agent: handle.agent, handle }
      this.live.set(sessionId, liveAgent)
      return liveAgent
    } catch (error) {
      // Lost a cold-resume race: another owner published the session while our
      // resume was in flight. Borrow the winner instead of failing the turn.
      const winner = this.deps.ctx.agents.get(sessionId)
      if (winner !== undefined) return this.borrow(sessionId, winner)
      throw error
    }
  }

  /** Mount one mutable Session-aware request policy outside every other wrapper. */
  mountRequestPolicy(agentCtx: AgentContext, session?: Session): () => void {
    const controller = installRequestPolicy(agentCtx, {
      effort: this.deps.config.reasoningEffort,
      provider: this.deps.config.provider,
      model: this.deps.config.model,
    })
    if (session !== undefined) controller.sync(session.snapshotEvents())
    this.policies.set(agentCtx, controller)
    return () => {
      controller.dispose()
      if (this.policies.get(agentCtx) === controller) this.policies.delete(agentCtx)
    }
  }

  /** Resolve and synchronize the policy composed for this exact Agent scope. */
  requestPolicy(agent: Agent): RequestPolicyController {
    const controller = this.policies.get(agent.ctx)
    if (controller === undefined) {
      throw new Error('dsh-channels: request policy is not mounted for this Agent')
    }
    controller.sync(agent.session.snapshotEvents())
    return controller
  }

  /** Create, workspace-attach, and atomically publish one renewed route. */
  async renew(record: RouteRecord, oldLive: LiveAgent): Promise<RenewCommit> {
    const sessionId = randomUUID() as SessionId
    const preset = this.effectivePreset(oldLive.agent.session)
    const composition = await this.presetComposition(preset, false, record.workspacePath)
    const workspace = await this.deps.ctx.workspaceRegistry.create(
      record.workspacePath,
      workspaceTitleFor(record.chatType, record.chatId, record.senderOpenId),
    )

    let newHandle: AgentHandle | undefined
    let attached = false
    try {
      newHandle = await this.deps.ctx.agents.create({
        sessionId,
        meta: {
          cwd: record.workspacePath,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { ...oldLive.agent.options },
        setup: composition.setup,
      })
      this.requestPolicy(newHandle.agent)
      await workspace.attachSession(sessionId)
      attached = true
      const createdAt = newHandle.agent.session.header.createdAt

      const current: RouteRecord = {
        ...record,
        sessionId,
        sessionHistory: appendSessionHistory(record, sessionId, createdAt),
        lastActivityAt: Date.now(),
      }
      await this.deps.persistRoute(record.key, current)
      this.live.set(sessionId, { agent: newHandle.agent, handle: newHandle })
      return { previous: record, current, oldLive }
    } catch (error) {
      if (attached) {
        await Promise.resolve(workspace.detachSession(sessionId)).catch((detachError: unknown) => {
          this.deps.warn(
            'dsh-channels: rolling back workspace attachment for session %s failed: %s',
            sessionId, String(detachError),
          )
        })
      }
      await newHandle?.dispose().catch(() => {})
      throw error
    }
  }

  /** Release only this plugin's old handle, after `command/done` has landed. */
  async releaseRenewed(commit: RenewCommit): Promise<void> {
    const oldSessionId = commit.previous.sessionId
    if (this.live.get(oldSessionId) === commit.oldLive) {
      this.live.delete(oldSessionId)
      this.deps.detachStream(oldSessionId)
    }
    try {
      await commit.oldLive.handle.dispose()
    } catch (error) {
      this.deps.warn(
        'dsh-channels: releasing renewed session %s handle failed: %s',
        oldSessionId, String(error),
      )
    }
  }

  /** Stop and dispose every live agent this plugin owns. */
  async disposeAll(): Promise<void> {
    for (const { handle } of this.live.values()) {
      await handle.dispose().catch(() => {})
    }
    this.live.clear()
    this.pendingResume.clear()
  }

  /**
   * Resolve the agent-preset composition for sessions this plugin creates or
   * resumes. The id resolves BEFORE the session exists because the session
   * boundary snapshots `meta` before asynchronous setup begins; mounting stays
   * inside `setup`, where a failure rolls the whole creation back.
   */
  private async presetComposition(
    requestedPreset: string | undefined = this.deps.config.agentPreset,
    useRosterDefault = true,
    workspacePath?: string,
  ): Promise<PresetComposition> {
    // Read through ctx.get (safe lookup): only the web profile ships a roster,
    // and direct property access on a cordis context throws for services the
    // plugin did not inject.
    const presets = this.deps.ctx.get?.('agentPresets') as AgentPresets | undefined
    const channelCommandsOnly = async (agentCtx: AgentContext): Promise<void> => {
      // `prepend` is essential: standing preset listeners may have been
      // mounted before this Agent existed, so setup registration order alone
      // cannot guarantee that the explicit channel value wins.
      this.mountRequestPolicy(agentCtx)
      await mountChannelCommands(agentCtx)
      await mountChannelGuidance(agentCtx, workspacePath)
    }
    if (presets === undefined || (requestedPreset === undefined && !useRosterDefault)) {
      return { setup: channelCommandsOnly }
    }
    const resolved = await presets.resolve(requestedPreset)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        this.mountRequestPolicy(agentCtx)
        await presets.mount(agentCtx, resolved.id)
        await mountChannelCommands(agentCtx)
        await mountChannelGuidance(agentCtx, workspacePath)
      },
    }
  }

  /** Effective preset after folding any durable runtime preset switch. */
  private effectivePreset(session: Session): string | undefined {
    let selected = session.header.agentPreset
    for (const event of session.snapshotEvents()) {
      if (event.type === 'agent-preset/selected') selected = event.data.agentPreset
    }
    return selected
  }
}
