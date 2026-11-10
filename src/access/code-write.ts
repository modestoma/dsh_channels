/**
 * Code-write gate: in a Feishu Session, a call to one of the configured
 * `codeWriteTools` runs only when the Session's location holds the
 * `codeWrite` switch: the person of a private-chat topic (an administrator
 * holds every switch) or the group's permission record of a group route
 * (see `AccessController.mayUseOnRoute`). Who speaks in the turn does not change
 * the decision.
 *
 * - Ownership: a call belongs to a Feishu route when its agent's Session is
 *   routed, or descends (through `parentSession`) from a routed Session.
 *   See `./lineage.ts`. Calls of Sessions the channel does not route are
 *   never touched.
 * - The check runs in `tools/pre-execute`, before the tool's own approval, so
 *   it holds whatever approval mode the tool's plugin uses.
 *
 * The gate also tracks the **speaker** of each routed Session's current turn
 * for the `Feishu-User:` trailer of commits the Session pushes (see
 * {@link CodeWriteGate.speakerOf}): the Feishu user the claimed message's
 * source names as its principal (see `./principal.ts`). A claimed message
 * with no principal (the Host owner, slash-command expansions, subagent
 * results, jobs, schedules) keeps the previous speaker; a message naming a
 * principal other than a Feishu one makes the speaker unknown until a Feishu
 * message is claimed. Before any claimed message the route's last recorded
 * speaker, else the user who opened it, is the speaker. Speakers are kept
 * in memory and end with the process.
 *
 * @module dsh-channels/access/code-write
 */

import type { FeishuConfig } from '../config.ts'
import { isGroupRoute } from '../domain.ts'
import type { RouteRecord } from '../domain.ts'
import type { PreToolDecision, PreToolExecution } from '../host/index.ts'
import type { UserMessage } from '../host/core.ts'
import type { SessionLineage } from './lineage.ts'
import { promptCallerOf } from './principal.ts'

/** Speaker of a turn whose Feishu sender cannot be established. */
const UNKNOWN_SENDER = Symbol('unknown sender')

type Speaker = string | typeof UNKNOWN_SENDER

export interface CodeWriteGateDeps {
  /** Live configuration (`codeWriteTools`). */
  config(): Pick<FeishuConfig, 'codeWriteTools'>
  /** The route that names a Session, if any. */
  routeOf(sessionId: string): RouteRecord | undefined
  /** Which routed Session each Session belongs to. */
  lineage: SessionLineage
  /** Whether the route's location holds the `codeWrite` switch. */
  mayWrite(route: RouteRecord): boolean
}

export class CodeWriteGate {
  /** Routed Session id → user_id that speaks in its current turn. */
  private readonly speakers = new Map<string, Speaker>()
  constructor(private readonly deps: CodeWriteGateDeps) {}

  /**
   * A turn claimed an inbox message: the Feishu user its source names speaks
   * in the turn; a message without a principal keeps the previous speaker;
   * any other principal makes the speaker unknown.
   * @param sessionId - the claiming Session.
   * @param message - the claimed message.
   */
  onClaimed(sessionId: string, message: Pick<UserMessage, 'source'>): void {
    const caller = promptCallerOf(message.source)
    switch (caller.kind) {
      case 'feishu-user':
      case 'feishu-group':
        this.speakers.set(sessionId, caller.userId)
        return
      case 'other-principal':
        this.speakers.set(sessionId, UNKNOWN_SENDER)
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
    const root = this.deps.lineage.rootOfCall(agent.session.id, agent.session.header.parentSession)
    if (root === undefined || !this.deps.config().codeWriteTools.includes(exec.name)) return undefined
    const route = this.deps.routeOf(root)
    if (route === undefined || this.deps.mayWrite(route)) return undefined
    return {
      kind: 'deny',
      reason: isGroupRoute(route)
        ? `本群没有代码改动权限，不能调用 ${exec.name}。请告诉用户：需要管理员在设置面板「群权限」里打开本群的「改代码」；本地工作区里的修改不受影响。`
        : `飞书用户 ${route.senderUserId} 没有代码改动权限，不能调用 ${exec.name}。请告诉用户：需要管理员在设置面板「访问授权」里打开该用户的「改代码」，或在飞书发送 /auth set code on @该用户；本地工作区里的修改不受影响。`,
    }
  }

  /**
   * The Feishu user speaking in the current turn of a routed Session or of a
   * descendant this gate has already seen a call from.
   * @param sessionId - the Session.
   * @returns the speaker's user_id, or undefined when Feishu does not route
   *   the Session or the speaker cannot be established.
   */
  speakerOf(sessionId: string): string | undefined {
    const root = this.deps.lineage.known(sessionId)
    const route = root === undefined ? undefined : this.deps.routeOf(root)
    if (root === undefined || route === undefined) return undefined
    const speaker = this.speakers.get(root) ?? route.lastSpeakerUserId ?? route.senderUserId
    return speaker === UNKNOWN_SENDER ? undefined : speaker
  }

  /** Drop every speaker (shutdown). */
  clear(): void {
    this.speakers.clear()
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected prompt caller: ${JSON.stringify(value)}`)
}
