/**
 * `/permissions`: show the Session's effective sandbox and approval preset
 * and the selectable catalog; an administrator switches it when the
 * deployment allows switching.
 *
 * @module dsh-channels/commands/permissions
 */

import type { AccessController } from '../access/controller.ts'
import { buildPickerCard, standaloneInfoCard } from '../cards/index.ts'
import type { PickerOption } from '../cards/index.ts'
import type { ParsedSlashCommand } from '../commands.ts'
import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import type { CardDelivery } from '../feishu/delivery.ts'
import type { NormalizedMessage } from '../feishu-channel.ts'
import type { HostContext, PermissionPresets } from '../host/index.ts'
import type { SessionManager } from '../session/manager.ts'

export interface PermissionsCommandDeps {
  ctx: HostContext
  config(): FeishuConfig
  access: AccessController
  delivery: CardDelivery
  sessions: SessionManager
}

/**
 * `/permissions`: show this Session's effective sandbox+approval preset and
 * the selectable catalog; switch only when the deployment opted in.
 */
export async function runPermissionsCommand(
  deps: PermissionsCommandDeps,
  msg: NormalizedMessage,
  parsed: ParsedSlashCommand,
  current: RouteRecord,
): Promise<void> {
  const presets = deps.ctx.get?.('permissionPresets') as PermissionPresets | undefined
  if (presets === undefined) {
    await deps.delivery.commandCard(msg, {
      kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
      text: '当前部署未挂载 permissionPresets 服务，无法查看权限预设。',
    })
    return
  }
  const live = await deps.sessions.ensureLive(current)
  let active: string | undefined
  let catalogLine = ''
  let choices: PickerOption[] = []
  try {
    active = presets.current(live.agent.session)
    const catalog = presets.catalog()
    catalogLine = catalog.options.map(option => `\`${option.value}\``).join('、')
    choices = catalog.options.map(option => ({ label: option.name || option.value, arg: option.value }))
  } catch {
    active = undefined
  }
  const requested = parsed.rawInput.trim()
  // Presets can lift the sandbox and the approval prompts, which only an administrator may grant.
  const maySwitch = deps.config().allowPermissionSwitch && deps.access.isAdmin(msg.senderId)
  if (requested === '' && maySwitch && choices.length > 0) {
    await deps.delivery.standaloneReply(msg, buildPickerCard({
      title: '🔐 权限预设',
      command: 'permissions',
      text: `**当前权限预设**：${active === undefined ? '暂无数据' : `\`${active}\``}\n切换会同时调整沙箱与审批策略。`,
      sessionId: current.sessionId,
      options: choices,
      ...(active === undefined ? {} : { current: active }),
    }))
    return
  }
  if (requested === '') {
    const lines = [
      `**当前权限预设**：${active === undefined ? '暂无数据' : `\`${active}\``}`,
      ...(catalogLine === '' ? [] : [`**可选预设**：${catalogLine}`]),
      ...(maySwitch
        ? ['使用 `/permissions <name>` 切换；切换会同时调整沙箱与审批策略。']
        : deps.config().allowPermissionSwitch
          ? ['只有管理员可以在飞书里切换权限预设，你可以查看。']
          : ['当前部署未开启飞书侧切换（`allowPermissionSwitch: false`），仅支持查看。']),
    ]
    await deps.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 权限预设**', lines))
    return
  }
  if (!deps.config().allowPermissionSwitch) {
    await deps.delivery.commandCard(msg, {
      kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
      text: '当前部署未开启飞书侧权限切换，仅支持 /permissions 查看。',
    })
    return
  }
  if (!maySwitch) {
    await deps.delivery.commandCard(msg, {
      kind: 'unavailable', command: 'permissions', sessionId: current.sessionId,
      text: '只有管理员可以在飞书里切换权限预设（它会放宽沙箱和审批），你可以用 /permissions 查看。',
    })
    return
  }
  try {
    presets.set(live.agent.session, requested)
    await deps.delivery.standaloneReply(msg, standaloneInfoCard('**🔐 权限预设已切换**', [
      `**当前权限预设**：\`${requested}\``,
      '沙箱模式与审批策略已按该预设更新。',
    ]))
  } catch (error) {
    deps.ctx.logger?.warn?.(
      'dsh-channels: permission switch for session %s failed: %s', current.sessionId, String(error),
    )
    await deps.delivery.commandCard(msg, {
      kind: 'input-error', command: 'permissions', sessionId: current.sessionId,
      text: `未知或不可用的权限预设：\`${requested}\`。可用：${catalogLine === '' ? '暂无数据' : catalogLine}`,
    })
  }
}
