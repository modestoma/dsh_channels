/**
 * Main-Session tool gate: a private-chat projects-mode main Session (and any
 * Session descending from it) may call only the tools named in
 * `dmMainTools` and its own topic tools (`feishu_topic_*`); every other call
 * is denied in `tools/pre-execute`, before it runs and whichever agent
 * preset is mounted. Other Sessions are never touched.
 *
 * In PTC mode the model calls tools only from a `run_code` program, and each
 * tool the program calls passes this gate on its own, so `run_code` itself is
 * allowed unless it asks for a wider sandbox. The program's direct Node file,
 * network and process operations are confined by the Session's OS sandbox,
 * not by this gate.
 *
 * @module dsh-channels/dm/tool-gate
 */

import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import type { PreToolDecision, PreToolExecution } from '../host/index.ts'
import type { SessionLineage } from '../access/lineage.ts'
import { DM_TOPIC_TOOL_NAMES } from './tools.ts'
import { RUN_CODE_TOOL } from './tool-catalog.ts'

export interface MainToolGateDeps {
  /** Live configuration (`dmMainTools`). */
  config(): Pick<FeishuConfig, 'dmMainTools'>
  /** The route that names a Session, if any. */
  routeOf(sessionId: string): RouteRecord | undefined
  /** Which routed Session each Session belongs to. */
  lineage: SessionLineage
}


/** Whether a `run_code` call asks to run its program under a wider sandbox mode. */
function asksEscalation(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false
  const mode = (args as { sandbox_permissions?: unknown }).sandbox_permissions
  return typeof mode === 'string' && mode !== ''
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
    if (exec.name === RUN_CODE_TOOL) {
      if (!asksEscalation(exec.arguments)) return undefined
      return {
        kind: 'deny',
        reason: '私聊主会话不能提升沙箱权限：需要写文件、跑命令或改代码的工作请用 feishu_topic_open 开一个话题去做。',
      }
    }
    return {
      kind: 'deny',
      reason: `私聊主会话不能调用 ${exec.name}：主会话负责对话、阅读和分派，命令行、写文件和改代码等工作请用 feishu_topic_open 开一个话题去做。`,
    }
  }
}
