/**
 * Code-write gate: in a Feishu Session, a call to one of the configured
 * `codeWriteTools` runs only when the user who drives the current turn is the
 * administrator or holds the `codeWrite` switch.
 *
 * - Ownership: a call belongs to a Feishu route when its agent's Session is
 *   routed, or descends (through `parentSession`) from a routed Session.
 *   Every call remembers its Session's routed root, which covers nested
 *   subagents because a child must call a tool to spawn its own child. Calls
 *   of Sessions the channel does not route are never touched.
 * - Driver: the Feishu sender of the message the current turn claimed. Turns
 *   no Feishu message started (subagent results, jobs, schedules) keep the
 *   previous driver; before any claimed message the route owner drives.
 * - The check runs in `tools/pre-execute`, before the tool's own approval, so
 *   it holds whatever approval mode the tool's plugin uses.
 *
 * The same driver names the Feishu user in the `Feishu-User:` trailer of
 * commits the Session pushes (see {@link CodeWriteGate.driverOf}).
 *
 * State is in memory only and ends with the process.
 *
 * @module dsh-channels/access/code-write
 */

import type { FeishuConfig } from '../config.ts'
import type { AccessPermission, RouteRecord } from '../domain.ts'
import type { PreToolDecision, PreToolExecution } from '../dsh-types.ts'

/** Remembered message senders (bounded; oldest dropped first). */
const MAX_NOTED_MESSAGES = 2_000

export interface CodeWriteGateDeps {
  /** Live configuration (`codeWriteTools`). */
  config(): Pick<FeishuConfig, 'codeWriteTools'>
  /** The route that names a Session, if any. */
  routeOf(sessionId: string): RouteRecord | undefined
  /** Whether a user holds a permission switch (the administrator holds all). */
  mayUse(userId: string, permission: AccessPermission): boolean
}

export class CodeWriteGate {
  /** Feishu message id (DSH `UserMessage.id`) → sender user_id. */
  private readonly senders = new Map<string, string>()
  /** Routed Session id → user_id that drives its current turn. */
  private readonly drivers = new Map<string, string>()
  /** Descendant Session id → routed ancestor Session id. */
  private readonly roots = new Map<string, string>()

  constructor(private readonly deps: CodeWriteGateDeps) {}

  /**
   * Record who sent the prompt carried by one DSH user message.
   * @param messageId - the `UserMessage.id` submitted to the Agent.
   * @param userId - Feishu user_id of the sender.
   */
  noteMessage(messageId: string, userId: string): void {
    this.senders.set(messageId, userId)
    if (this.senders.size <= MAX_NOTED_MESSAGES) return
    const oldest = this.senders.keys().next().value
    if (oldest !== undefined) this.senders.delete(oldest)
  }

  /**
   * A turn claimed an inbox message: its sender, when known, drives the turn.
   * @param sessionId - the claiming Session.
   * @param messageId - the claimed `UserMessage.id`.
   */
  onClaimed(sessionId: string, messageId: string): void {
    const sender = this.senders.get(messageId)
    if (sender === undefined) return
    this.senders.delete(messageId)
    this.drivers.set(sessionId, sender)
  }

  /**
   * Decide one pending tool call.
   * @param exec - the pending call.
   * @returns `deny` with a model-readable reason, or undefined to delegate.
   */
  decide(exec: PreToolExecution): PreToolDecision | undefined {
    const agent = exec.agent
    if (agent === undefined) return undefined
    // Resolved before the tool check so every call remembers its Session's
    // root: a child spawns its own child through an ungated tool.
    const root = this.rootOf(agent.session.id, agent.session.header.parentSession)
    if (root === undefined || !this.deps.config().codeWriteTools.includes(exec.name)) return undefined
    const driver = this.driverOfRoot(root)
    if (driver === undefined || this.deps.mayUse(driver, 'codeWrite')) return undefined
    return {
      kind: 'deny',
      reason: `飞书用户 ${driver} 没有代码改动权限，不能调用 ${exec.name}。请告诉用户：需要管理员在设置面板「访问授权」里打开该用户的「改代码」，或在飞书发送 /auth set code on @该用户；本地工作区里的修改不受影响。`,
    }
  }

  /**
   * The Feishu user driving the current turn of a routed Session or of a
   * descendant this gate has already seen a call from.
   * @param sessionId - the Session.
   * @returns the driver's user_id, or undefined when Feishu does not route the Session.
   */
  driverOf(sessionId: string): string | undefined {
    const root = this.deps.routeOf(sessionId) !== undefined ? sessionId : this.roots.get(sessionId)
    return root === undefined ? undefined : this.driverOfRoot(root)
  }

  private driverOfRoot(root: string): string | undefined {
    const route = this.deps.routeOf(root)
    return route === undefined ? undefined : this.drivers.get(root) ?? route.senderUserId
  }

  /** Drop every remembered sender, driver, and descendant (shutdown). */
  clear(): void {
    this.senders.clear()
    this.drivers.clear()
    this.roots.clear()
  }

  /** The routed Session a call belongs to, remembering descendants. */
  private rootOf(sessionId: string, parentSession: string | undefined): string | undefined {
    if (this.deps.routeOf(sessionId) !== undefined) return sessionId
    const known = this.roots.get(sessionId)
    if (known !== undefined) return known
    if (parentSession === undefined) return undefined
    const root = this.deps.routeOf(parentSession) !== undefined ? parentSession : this.roots.get(parentSession)
    if (root !== undefined) this.roots.set(sessionId, root)
    return root
  }
}
