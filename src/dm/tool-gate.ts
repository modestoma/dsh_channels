/**
 * Main-Session tool gate: a private-chat projects-mode main Session (and any
 * Session descending from it) may call only the tools named in
 * `dmMainTools` and its own topic tools (`feishu_topic_*`); every other call
 * is denied in `tools/pre-execute`, before it runs and whichever agent
 * preset is mounted. Other Sessions are never touched.
 *
 * @module dsh-channels/dm/tool-gate
 */

import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import type { PreToolDecision, PreToolExecution } from '../host/index.ts'
import type { SessionLineage } from '../access/lineage.ts'
import { DM_TOPIC_TOOL_NAMES } from './tools.ts'

export interface MainToolGateDeps {
  /** Live configuration (`dmMainTools`). */
  config(): Pick<FeishuConfig, 'dmMainTools'>
  /** The route that names a Session, if any. */
  routeOf(sessionId: string): RouteRecord | undefined
  /** Which routed Session each Session belongs to. */
  lineage: SessionLineage
}

export class MainToolGate {
  constructor(private readonly deps: MainToolGateDeps) {}

  /**
   * Decide one pending tool call.
   * @param exec - the pending call.
   * @returns `deny` with a model-readable reason, or undefined to delegate.
   */
  decide(exec: PreToolExecution): PreToolDecision | undefined {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const root = this.deps.lineage.rootOfCall(agent.session.id, agent.session.header.parentSession)
    if (root === undefined) return undefined
    if (this.deps.routeOf(root)?.dmRole !== 'main') return undefined
    if (this.deps.config().dmMainTools.includes(exec.name) || DM_TOPIC_TOOL_NAMES.includes(exec.name)) return undefined
    return {
      kind: 'deny',
      reason: `私聊主会话不能调用 ${exec.name}：主会话负责对话、阅读和分派，命令行、写文件和改代码等工作请用 feishu_topic_open 开一个话题去做。`,
    }
  }
}
