/**
 * `/effort`: the Session's reasoning effort, shown, switched, or reset through
 * the agent command plane, and the picker card a bare `/effort` answers with.
 *
 * @module dsh-channels/commands/effort
 */

import { buildPickerCard } from '../cards/index.ts'
import type { EffortCommandAction } from '../commands.ts'
import type { RouteRecord } from '../domain.ts'
import type { CommandInvocation, CommandResult, HostContext, LlmModelInfo, LlmService } from '../host/index.ts'
import type { LiveAgent } from '../session/manager.ts'
import type { RequestPolicyController } from '../session/request-policy.ts'

/** The live Agent one Feishu `/effort` was admitted for, and its request policy. */
export interface EffortAdmission {
  live: LiveAgent
  controller: RequestPolicyController
}

/** The model route the next request of a Session uses, as far as it is known. */
function currentModelRoute(
  live: LiveAgent,
  controller: RequestPolicyController,
): { provider: string | undefined; model: string | undefined } {
  const state = controller.state
  const selected = live.agent.model?.current()
  const header = live.agent.session.requestHeader?.()?.config
  return {
    provider: state.configuredModel?.provider ?? selected?.provider
      ?? (typeof header?.provider === 'string' && header.provider !== '' ? header.provider : undefined),
    model: state.configuredModel?.model ?? selected?.model
      ?? (typeof header?.model === 'string' && header.model !== '' ? header.model : undefined),
  }
}

/**
 * `/effort` picker: the efforts the current model route advertises, or
 * undefined when the route is unknown or advertises none.
 */
export async function effortPicker(
  ctx: HostContext,
  current: RouteRecord,
  live: LiveAgent,
  admission: EffortAdmission,
  text: string,
): Promise<object | undefined> {
  const route = currentModelRoute(live, admission.controller)
  if (route.provider === undefined || route.model === undefined) return undefined
  let reasoning: LlmModelInfo['reasoning']
  try {
    const llm = ctx.get?.('llm') as LlmService | undefined
    reasoning = (await llm?.resolveModelInfo(route.provider, route.model))?.reasoning
  } catch (error) {
    ctx.logger?.warn?.('dsh-channels: effort catalog lookup failed: %s', String(error))
    return undefined
  }
  if (reasoning === undefined || reasoning.efforts.length === 0) return undefined
  const active = admission.controller.state.effectiveEffort ?? reasoning.defaultEffort
  return buildPickerCard({
    title: '💭 推理强度',
    command: 'effort',
    text,
    sessionId: current.sessionId,
    options: reasoning.efforts.map(effort => ({ label: effort.name || effort.id, arg: effort.id })),
    ...(active === undefined ? {} : { current: active }),
    reset: true,
  })
}

/** Authorized Session-level `/effort` view/switch operation. */
export function runEffortCommand(
  invocation: CommandInvocation,
  action: EffortCommandAction,
  admission: EffortAdmission,
): CommandResult {
  if (admission.live.agent !== invocation.agent) {
    return { kind: 'error', text: '/effort 只能通过已授权的飞书话题执行。' }
  }
  const state = admission.controller.state
  if (action.kind === 'show') {
    if (state.effortSource === 'session') {
      return { kind: 'success', text: `当前 Session 推理强度：\`${state.effectiveEffort}\`（Session 覆盖）。` }
    }
    if (state.effortSource === 'config') {
      return { kind: 'success', text: `当前 Session 推理强度：\`${state.effectiveEffort}\`（配置默认）。` }
    }
    return { kind: 'success', text: '当前 Session 未设置推理强度覆盖，使用模型适配器/provider 默认。' }
  }
  if (action.kind === 'reset') {
    return state.configuredEffort === undefined
      ? { kind: 'success', text: '已恢复模型适配器/provider 默认推理强度。' }
      : { kind: 'success', text: `已恢复配置默认推理强度：\`${state.configuredEffort}\`。` }
  }
  return { kind: 'success', text: `当前 Session 推理强度已切换为：\`${action.value}\`。` }
}
