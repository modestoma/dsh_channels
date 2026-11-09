/**
 * Session lineage: which routed Feishu Session a Session belongs to. A
 * Session belongs to itself when a route names it, else to the routed
 * ancestor on its `parentSession` chain. Every descendant passed on the way
 * is remembered, which covers nested subagents because a child calls a tool
 * to spawn its own child. Descendants are kept in memory and end with the
 * process.
 *
 * @module dsh-channels/access/lineage
 */

import type { RouteRecord } from '../domain.ts'

/** Longest `parentSession` chain {@link SessionLineage.resolve} follows. */
const MAX_SESSION_DEPTH = 32

/** Descendant → routed ancestor map shared by the tool gates and Session events. */
export class SessionLineage {
  /** Descendant Session id → routed ancestor Session id. */
  private readonly roots = new Map<string, string>()

  /**
   * @param routeOf - the route that names a Session, if any.
   */
  constructor(private readonly routeOf: (sessionId: string) => RouteRecord | undefined) {}

  /**
   * The routed Session a tool call's Session belongs to, remembering it when
   * the parent's root is known.
   * @param sessionId - the calling Session.
   * @param parentSession - its header's parent Session.
   * @returns the routed Session, or undefined when the call is not Feishu's.
   */
  rootOfCall(sessionId: string, parentSession: string | undefined): string | undefined {
    const known = this.known(sessionId)
    if (known !== undefined || parentSession === undefined) return known
    const root = this.known(parentSession)
    if (root !== undefined) this.roots.set(sessionId, root)
    return root
  }

  /**
   * @param sessionId - the Session.
   * @returns itself when routed, else the routed ancestor already remembered.
   */
  known(sessionId: string): string | undefined {
    return this.routeOf(sessionId) !== undefined ? sessionId : this.roots.get(sessionId)
  }

  /**
   * The routed Session a Session belongs to: {@link known}, else the first
   * routed Session on its `parentSession` chain as `parentOf` reports it (the
   * live agent registry); every Session passed on the way is remembered. Used
   * by events that name a Session without a call, such as `access/authorize`
   * and `repo/commit-trailers`.
   * @param sessionId - the Session.
   * @param parentOf - parent of a live Session, or undefined when unknown or top-level.
   * @returns the routed Session, or undefined when Feishu routes none of the chain.
   */
  resolve(sessionId: string, parentOf: (sessionId: string) => string | undefined): string | undefined {
    const chain: string[] = []
    let current = sessionId
    let root = this.known(current)
    while (root === undefined) {
      if (chain.includes(current) || chain.length >= MAX_SESSION_DEPTH) return undefined
      chain.push(current)
      const parent = parentOf(current)
      if (parent === undefined) return undefined
      current = parent
      root = this.known(current)
    }
    for (const descendant of chain) this.roots.set(descendant, root)
    return root
  }

  /** Forget every descendant (shutdown). */
  clear(): void {
    this.roots.clear()
  }
}
