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
 * - Driver: the Feishu user the claimed message's source names as its
 *   principal (see `./principal.ts`): the user of a private-chat principal, or
 *   the speaker of a group principal. The source is part of the durable
 *   message, so a prompt replayed after a restart still names its sender. A
 *   claimed message with no principal (the Host owner, slash-command
 *   expansions, subagent results, jobs, schedules) keeps the previous driver;
 *   before any claimed message the route owner drives. A message naming a
 *   principal other than a Feishu one makes the driver unknown: every gated
 *   call is denied until a message naming a Feishu principal is claimed.
 * - The check runs in `tools/pre-execute`, before the tool's own approval, so
 *   it holds whatever approval mode the tool's plugin uses.
 *
 * The same driver names the Feishu user in the `Feishu-User:` trailer of
 * commits the Session pushes (see {@link CodeWriteGate.driverOf}).
 *
 * Drivers and descendants are kept in memory and end with the process.
 *
 * @module dsh-channels/access/code-write
 */

import type { FeishuConfig } from '../config.ts'
import type { AccessPermission, RouteRecord } from '../domain.ts'
import type { PreToolDecision, PreToolExecution } from '../dsh-types.ts'
import type { UserMessage } from '../host/core.ts'
import { promptCallerOf } from './principal.ts'

/** Driver of a turn whose Feishu sender cannot be established. */
const UNKNOWN_SENDER = Symbol('unknown sender')
type Driver = string | typeof UNKNOWN_SENDER

export interface CodeWriteGateDeps {
  /** Live configuration (`codeWriteTools`). */
  config(): Pick<FeishuConfig, 'codeWriteTools'>
  /** The route that names a Session, if any. */
  routeOf(sessionId: string): RouteRecord | undefined
  /** Whether a user holds a permission switch (an administrator holds all). */
  mayUse(userId: string, permission: AccessPermission): boolean
}

export class CodeWriteGate {
  /** Routed Session id → user_id that drives its current turn. */
  private readonly drivers = new Map<string, Driver>()
  /** Descendant Session id → routed ancestor Session id. */
  private readonly roots = new Map<string, string>()

  constructor(private readonly deps: CodeWriteGateDeps) {}

  /**
   * A turn claimed an inbox message: the Feishu user its source names drives
   * the turn; a message without a principal keeps the previous driver; any
   * other principal makes the driver unknown.
   * @param sessionId - the claiming Session.
   * @param message - the claimed message.
   */
  onClaimed(sessionId: string, message: Pick<UserMessage, 'source'>): void {
    const caller = promptCallerOf(message.source)
    switch (caller.kind) {
      case 'feishu-user':
      case 'feishu-group':
        this.drivers.set(sessionId, caller.userId)
        return
      case 'other-principal':
        this.drivers.set(sessionId, UNKNOWN_SENDER)
        return
      case 'none':
        return
      default:
        assertNever(caller)
    }
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
    if (driver === undefined) return undefined
    if (driver === UNKNOWN_SENDER) {
      return {
        kind: 'deny',
        reason: `无法确认这一轮的飞书发言人（不是飞书用户发起的消息），不能调用 ${exec.name}。请告诉用户：重新发送一条消息后再试。`,
      }
    }
    if (this.deps.mayUse(driver, 'codeWrite')) return undefined
    return {
      kind: 'deny',
      reason: `飞书用户 ${driver} 没有代码改动权限，不能调用 ${exec.name}。请告诉用户：需要管理员在设置面板「访问授权」里打开该用户的「改代码」，或在飞书发送 /auth set code on @该用户；本地工作区里的修改不受影响。`,
    }
  }

  /**
   * The Feishu user driving the current turn of a routed Session or of a
   * descendant this gate has already seen a call from.
   * @param sessionId - the Session.
   * @returns the driver's user_id, or undefined when Feishu does not route the
   *   Session or the driver cannot be established.
   */
  driverOf(sessionId: string): string | undefined {
    const root = this.deps.routeOf(sessionId) !== undefined ? sessionId : this.roots.get(sessionId)
    const driver = root === undefined ? undefined : this.driverOfRoot(root)
    return driver === UNKNOWN_SENDER ? undefined : driver
  }

  private driverOfRoot(root: string): Driver | undefined {
    const route = this.deps.routeOf(root)
    return route === undefined ? undefined : this.drivers.get(root) ?? route.senderUserId
  }

  /** Drop every driver and descendant (shutdown). */
  clear(): void {
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

function assertNever(value: never): never {
  throw new Error(`unexpected prompt caller: ${JSON.stringify(value)}`)
}
