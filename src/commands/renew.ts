/**
 * `/renew`: replace the topic's Session with a new one in the same workspace,
 * run through the agent command plane only for an admitted Feishu route.
 *
 * @module dsh-channels/commands/renew
 */

import type { RouteRecord } from '../domain.ts'
import type { CommandInvocation, CommandResult, HostContext } from '../host/index.ts'
import type { LiveAgent, RenewCommit, SessionManager } from '../session/manager.ts'
import type { RouteStore } from '../session/routes.ts'

/** The route and live Agent one Feishu `/renew` was admitted for; `commit` is set once the renewal succeeded. */
export interface RenewAdmission {
  route: RouteRecord
  live: LiveAgent
  commit?: RenewCommit
}

export interface RenewCommandDeps {
  ctx: HostContext
  routes: RouteStore
  sessions: SessionManager
}

/**
 * Agent-scoped `/renew` handler. Only the Feishu admission path arms its
 * AbortSignal, preventing another Host client from switching a Feishu route
 * by invoking the scoped command out of band.
 */
export async function runRenewCommand(
  deps: RenewCommandDeps,
  invocation: CommandInvocation,
  admission: RenewAdmission,
): Promise<CommandResult> {
  if (admission.live.agent !== invocation.agent) {
    return { kind: 'error', text: '/renew 只能通过已授权的飞书话题执行。' }
  }
  const current = deps.routes.get(admission.route.key)
  if (current === undefined || current.sessionId !== admission.route.sessionId) {
    return { kind: 'error', text: '当前话题绑定已变化，请重试 /renew。' }
  }
  try {
    admission.commit = await deps.sessions.renew(current, admission.live)
    return { kind: 'success', text: '新 Session 已创建并绑定。' }
  } catch (error) {
    deps.ctx.logger?.warn?.(
      'dsh-channels: renew transaction failed for session %s: %s',
      current.sessionId, String(error),
    )
    return { kind: 'error', text: 'Session 续建失败，原 Session 仍保持绑定；请稍后重试。' }
  }
}
