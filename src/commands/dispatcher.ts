/**
 * The slash-command plane: admission of one command message, dispatch to the
 * route-free, channel-plane, or agent command plane, and rendering of each
 * settled result. Nothing here calls `agent.followup()`.
 *
 * @module dsh-channels/commands/dispatcher
 */

import type { AccessAdmin } from '../access/admin.ts'
import type { AccessController } from '../access/controller.ts'
import {
  armEffortCommand, armRenewCommand, commandResultCardKind, parseSlashCommand,
  registerEffortCommand, registerRenewCommand, supportedCommandHelp, supportedCommandList,
} from '../commands.ts'
import type { ParsedSlashCommand, RouteOperationQueue } from '../commands.ts'
import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import type { CardDelivery } from '../feishu/delivery.ts'
import type { NormalizedMessage } from '../feishu-channel.ts'
import { buildHealthCard } from '../health.ts'
import type { HealthSnapshot } from '../health.ts'
import type {
  CommandResult, HostContext, LlmService, PermissionPresets,
  Session, SessionId, SessionProjections, SessionQuery, TokenMeter,
} from '../host/index.ts'
import {
  buildCompactComparisonCard, buildRenewCard, buildSessionHistoryCard, buildSessionStatusCard, buildWorkDirCard,
  compactFailureContext, resolveWorkDir, SESSION_HISTORY_DISPLAY_LIMIT,
} from '../session-commands.ts'
import type { SessionHistoryAnnotation } from '../session-commands.ts'
import type { SessionExportBuilder } from '../session-export.ts'
import type { LiveAgent, SessionManager } from '../session/manager.ts'
import type { RouteStore } from '../session/routes.ts'
import { foldSessionStats, measureSessionContext } from '../stats.ts'
import type { ContextMeasurement, ContextServices } from '../stats.ts'
import { effortPicker, runEffortCommand } from './effort.ts'
import type { EffortAdmission } from './effort.ts'
import { runPermissionsCommand } from './permissions.ts'
import { commandSpec } from './registry.ts'
import { runRenewCommand } from './renew.ts'
import type { RenewAdmission } from './renew.ts'
import type { ChannelCommandSpec } from './registry.ts'


export interface CommandDispatcherDeps {
  ctx: HostContext
  config(): FeishuConfig
  /** Whether the channel runs; commands admitted after shutdown retire silently. */
  started(): boolean
  access: AccessController
  accessAdmin: AccessAdmin
  delivery: CardDelivery
  routes: RouteStore
  sessions: SessionManager
  queue: RouteOperationQueue
  /** The route a command message belongs to, when it has one. */
  resolveRoute(msg: NormalizedMessage): Promise<RouteRecord | undefined>
  /** Cancel a Session's live turn; true when one was running. */
  cancelTurn(sessionId: string): boolean
  health(): HealthSnapshot
  uptimeMs(): number | undefined
  /** Host projection registry, when mounted. */
  projections(): SessionProjections | undefined
  exportSession: SessionExportBuilder
}

/** Slash-command admission, dispatch, and result rendering. */
export class CommandDispatcher {
  /** Active Host command executions, aborted before shutdown tears peers down. */
  private readonly controllers = new Set<AbortController>()
  /** Whole command admissions, drained before channel/storage teardown. */
  private readonly operations = new Set<Promise<void>>()

  constructor(private readonly deps: CommandDispatcherDeps) {}

  /**
   * Abort every running Host command and wait for every admitted command to
   * settle (shutdown, after admission closed).
   */
  async drain(): Promise<void> {
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.operations])
    this.controllers.clear()
    this.operations.clear()
  }

  /**
   * Slash-command admission. The command vocabulary and its admission rules
   * come from the command registry; nothing here calls `agent.followup()`.
   */
  async handle(msg: NormalizedMessage, line: string): Promise<void> {
    if (!this.deps.started()) return
    const parsed = parseSlashCommand(line)
    // Channel-plane command admission runs before ANY card/topic/side effect:
    // denied senders get at most a fixed private-chat notice (or silence in
    // groups), never an unknown-command card or a command thread.
    if (!(await this.deps.access.admitCommand(msg, parsed?.name))) return
    if (parsed === undefined) {
      await this.deps.delivery.commandCard(msg, {
        kind: 'input-error',
        text: '命令名必须以小写字母开头，且只能包含小写字母、数字、下划线或连字符。',
        supported: supportedCommandList(),
      })
      return
    }
    const spec = commandSpec(parsed.name)
    if (spec === undefined) {
      await this.deps.delivery.commandCard(msg, {
        kind: 'unknown', command: parsed.name,
        text: `未找到命令 /${parsed.name}。`, supported: supportedCommandList(),
      })
      return
    }

    // `/auth` is administrator-only, route-free, and handled right here so it
    // works even inside an unauthorized group (that is the "authorize from
    // the conversation" entry point).
    if (spec.name === 'auth') {
      await this.deps.accessAdmin.runCommand(msg, parsed)
      return
    }

    // Route-free commands answer without any Session work.
    if (spec.routeFree === true) {
      await this.runRouteFreeCommand(spec, msg, parsed)
      return
    }

    // A TTL-retired topic is permanently closed except for session-optional
    // diagnostics (`/health`).
    const expiredRoute = msg.threadId === undefined ? undefined : this.deps.routes.expiredRoute(msg.threadId)
    if (expiredRoute !== undefined) {
      if (spec.sessionOptional === true) {
        await this.runRouteFreeCommand(spec, msg, parsed)
        return
      }
      await this.deps.delivery.expiredRouteCard(msg, parsed.name)
      return
    }

    const route = await this.deps.resolveRoute(msg)
    if (route === undefined) {
      if (spec.sessionOptional === true) {
        await this.runRouteFreeCommand(spec, msg, parsed)
        return
      }
      await this.deps.delivery.commandCard(msg, {
        kind: 'unbound', command: parsed.name,
        text: '当前话题尚未绑定 Session。请先发送普通消息创建会话，或使用 /health 检查通道。',
      })
      return
    }

    if (!this.deps.access.ownsRoute(msg, route)) {
      await this.deps.delivery.commandCard(msg, {
        kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
      })
      return
    }

    const operation = this.deps.queue.run(route.key, async () => {
      if (!this.deps.started()) return
      const current = this.deps.routes.get(route.key) ?? route
      if (!this.deps.access.ownsRoute(msg, current)) {
        await this.deps.delivery.commandCard(msg, {
          kind: 'forbidden', command: parsed.name, text: '无权操作此会话。',
        })
        return
      }
      await this.runRouteCommand(spec, msg, parsed, current)
    })
    this.operations.add(operation)
    try {
      await operation
    } finally {
      this.operations.delete(operation)
    }
  }

  /** Answer one command that needs no Session (help / userid / groupid / health). */
  private async runRouteFreeCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
  ): Promise<void> {
    const createThread = spec.directReply !== true
    if (parsed.rawInput.trim() !== '') {
      await this.deps.delivery.commandCard(msg, {
        kind: 'input-error', command: spec.name, text: `用法错误：/${spec.name} 不接受参数。`,
      }, { createThread })
      return
    }
    if (spec.mentionGate === true
      && msg.chatType === 'group'
      && msg.threadId === undefined
      && this.deps.config().requireMention
      && !msg.mentionedBot) {
      return
    }
    if (spec.chatType !== undefined && msg.chatType !== spec.chatType) {
      await this.deps.delivery.commandCard(msg, {
        kind: 'context-error', command: spec.name,
        text: spec.chatType === 'p2p'
          ? `命令 /${spec.name} 仅支持在私聊中使用。`
          : `命令 /${spec.name} 仅支持在群聊中使用。`,
      }, { createThread })
      return
    }
    await this.deps.delivery.withCommandReaction(msg, async () => {
      switch (spec.name) {
        case 'help':
          await this.deps.delivery.commandCard(msg, { kind: 'help', text: supportedCommandHelp() }, { createThread })
          return
        case 'userid':
          await this.deps.delivery.commandCard(msg, {
            kind: 'success', command: spec.name, text: `当前用户 ID：\`${msg.senderId}\``,
          }, { createThread })
          return
        case 'groupid':
          await this.deps.delivery.commandCard(msg, {
            kind: 'success', command: spec.name, text: `当前群组 ID：\`${msg.chatId}\``,
          }, { createThread })
          return
        case 'health':
          await this.deps.delivery.standaloneReply(msg, buildHealthCard(this.deps.health()), { createThread })
          return
        default:
          await this.deps.delivery.commandCard(msg, {
            kind: 'unavailable', command: spec.name, text: `命令 /${spec.name} 暂不可用。`,
          }, { createThread })
      }
    })
  }

  /** Answer one route-bound command inside the per-route admission queue. */
  private async runRouteCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    await this.deps.delivery.withCommandReaction(msg, async () => {
      try {
        if (spec.channelPlane === true) {
          await this.runChannelCommand(spec, msg, parsed, current)
          return
        }
        await this.runAgentCommand(spec, msg, parsed, current)
      } catch (error) {
        this.deps.ctx.logger?.warn?.(
          'dsh-channels: command /%s failed for session %s: %s',
          spec.name, current.sessionId, String(error),
        )
        await this.deps.delivery.commandCard(msg, {
          kind: 'internal-error', command: spec.name,
          text: '命令执行失败，请稍后重试；若持续发生，请查看 Harness 日志。',
          sessionId: current.sessionId,
        })
      }
    })
  }

  /**
   * Commands the channel answers itself. `/stop` aborts the live turn
   * directly and deliberately never cold-resumes a Session just to cancel
   * nothing.
   */
  private async runChannelCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    if (spec.name === 'permissions') {
      await runPermissionsCommand(this.deps, msg, parsed, current)
      return
    }
    if (spec.name === 'stop') {
      const running = this.deps.cancelTurn(current.sessionId)
      await this.deps.delivery.commandCard(msg, {
        kind: 'success', command: 'stop', sessionId: current.sessionId,
        text: running ? '已请求停止当前回合。' : '当前没有正在运行的回合。',
      })
      return
    }
    await this.deps.delivery.commandCard(msg, {
      kind: 'unavailable', command: spec.name, text: `命令 /${spec.name} 暂不可用。`,
      sessionId: current.sessionId,
    })
  }

  /**
   * Execute one command through the agent command plane: resolve the live
   * agent, mount borrowed channel commands when needed, arm the channel-scoped
   * `/renew` and `/effort` handlers, then render the settled result.
   */
  private async runAgentCommand(
    spec: ChannelCommandSpec,
    msg: NormalizedMessage,
    parsed: ParsedSlashCommand,
    current: RouteRecord,
  ): Promise<void> {
    // An alias (`/new`) resolves to this canonical spec; execute the canonical
    // line so the agent command plane finds the registered definition.
    const line = `/${spec.name}${parsed.rawInput}`
    const live = await this.deps.sessions.ensureLive(current)
    let definition = this.deps.ctx.commands.find(live.agent, spec.name)
    let unregisterBorrowedCommand: (() => void) | undefined
    if (definition === undefined && spec.name === 'renew') {
      unregisterBorrowedCommand = registerRenewCommand(live.agent.ctx.commands)
      definition = this.deps.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined && spec.name === 'effort') {
      unregisterBorrowedCommand = registerEffortCommand(live.agent.ctx.commands)
      definition = this.deps.ctx.commands.find(live.agent, spec.name)
    }
    if (definition === undefined) {
      unregisterBorrowedCommand?.()
      const text = spec.name === 'compact'
        ? '当前部署未挂载 Harness 原生 /compact 命令。'
        : `当前 Session 未挂载 /${spec.name} 命令。`
      await this.deps.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name, text, sessionId: current.sessionId,
      })
      return
    }
    const compactBefore = spec.name === 'compact'
      ? await this.measureCommandContext(live.agent.session)
      : undefined
    const controller = new AbortController()
    this.controllers.add(controller)
    const renewAdmission: RenewAdmission | undefined = spec.name === 'renew'
      ? { route: current, live }
      : undefined
    const effortAdmission: EffortAdmission | undefined = spec.name === 'effort'
      ? { live, controller: this.deps.sessions.requestPolicy(live.agent) }
      : undefined
    const disarmRenew = renewAdmission === undefined
      ? undefined
      : armRenewCommand(controller.signal, invocation => runRenewCommand(this.deps, invocation, renewAdmission))
    const disarmEffort = effortAdmission === undefined
      ? undefined
      : armEffortCommand(
          controller.signal,
          (invocation, action) => runEffortCommand(invocation, action, effortAdmission),
        )
    let execution
    try {
      execution = await this.deps.ctx.commands.execute(live.agent, line, [], controller.signal)
    } finally {
      this.controllers.delete(controller)
      disarmRenew?.()
      disarmEffort?.()
      unregisterBorrowedCommand?.()
      if (renewAdmission?.commit !== undefined) {
        await this.deps.sessions.releaseRenewed(renewAdmission.commit)
      }
    }
    if (controller.signal.aborted || !this.deps.started()) return
    if (execution === undefined) {
      await this.deps.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name,
        text: `当前 Session 无法执行 /${spec.name}。`, sessionId: current.sessionId,
      })
      return
    }
    await this.renderCommandResult({
      spec, msg, current, live,
      bare: parsed.rawInput.trim() === '',
      result: execution.result,
      compactBefore,
      renewAdmission,
      effortAdmission,
    })
  }

  /** Render one settled agent-plane command result. */
  private async renderCommandResult(input: {
    spec: ChannelCommandSpec
    msg: NormalizedMessage
    current: RouteRecord
    live: LiveAgent
    /** The command was typed without arguments. */
    bare: boolean
    result: CommandResult
    compactBefore: ContextMeasurement | undefined
    renewAdmission: RenewAdmission | undefined
    effortAdmission: EffortAdmission | undefined
  }): Promise<void> {
    const { spec, msg, current, live, result, compactBefore, renewAdmission, effortAdmission } = input
    // A settled switch (not a bare view) reconciles the Agent's selection even
    // when the folded policy looks unchanged, e.g. a reset after restart.
    effortAdmission?.controller.sync(
      live.agent.session.snapshotEvents(), live.agent, !input.bare && result.kind === 'success',
    )
    if (input.bare && result.kind === 'success' && effortAdmission !== undefined) {
      const picker = await effortPicker(this.deps.ctx, current, live, effortAdmission, result.text ?? '')
      if (picker !== undefined) {
        await this.deps.delivery.standaloneReply(msg, picker)
        return
      }
    }
    if (spec.name === 'renew' && result.kind === 'success' && renewAdmission?.commit !== undefined) {
      await this.deps.delivery.standaloneReply(msg, buildRenewCard({
        previousSessionId: renewAdmission.commit.previous.sessionId,
        currentSessionId: renewAdmission.commit.current.sessionId,
        sessionDir: renewAdmission.commit.current.workspacePath,
      }))
      return
    }
    if (spec.name === 'health' && result.kind === 'success') {
      await this.deps.delivery.standaloneReply(msg, buildHealthCard(this.deps.health()), { createThread: false })
      return
    }
    if (spec.name === 'status' && result.kind === 'success') {
      const session = live.agent.session
      const stats = foldSessionStats(session, this.deps.projections())
      const context = await measureSessionContext(
        session, this.commandContextServices(), stats.lastHeader,
      )
      await this.deps.delivery.standaloneReply(msg, buildSessionStatusCard({
        sessionId: current.sessionId,
        stats,
        context,
        extras: {
          permissionPreset: this.permissionPresetOf(session),
          sessionDir: current.workspacePath,
          uptimeMs: this.deps.uptimeMs(),
          liveAgents: this.deps.sessions.liveCount(),
          routeCount: this.deps.routes.size(),
        },
      }))
      return
    }
    if (spec.name === 'workspace' && result.kind === 'success') {
      const resolved = resolveWorkDir(live.agent.session.header.cwd, current)
      if (resolved.kind === 'success') {
        await this.deps.delivery.standaloneReply(msg, buildWorkDirCard(current.sessionId, resolved.path))
        return
      }
      if (resolved.kind === 'mismatch') {
        this.deps.ctx.logger?.warn?.(
          'dsh-channels: workspace mismatch for session %s (paths redacted)', current.sessionId,
        )
      }
      await this.deps.delivery.commandCard(msg, {
        kind: 'unavailable', command: spec.name,
        text: resolved.text, sessionId: current.sessionId,
      })
      return
    }
    if (spec.name === 'history' && result.kind === 'success') {
      await this.deps.delivery.standaloneReply(msg, buildSessionHistoryCard(
        current, await this.sessionHistoryAnnotations(current),
      ))
      return
    }
    if (spec.name === 'export' && result.kind === 'success') {
      try {
        const file = await this.deps.exportSession(live.agent.session)
        await this.deps.delivery.requireChannel().send(msg.chatId, { file }, {
          replyTo: msg.messageId,
          replyInThread: true,
        })
      } catch (error) {
        this.deps.ctx.logger?.warn?.(
          'dsh-channels: logical export delivery failed for session %s: %s',
          current.sessionId, String(error),
        )
        await this.deps.delivery.commandCard(msg, {
          kind: 'internal-error', command: spec.name,
          text: 'Session 逻辑日志导出失败，未交付文件；请稍后重试并查看 Harness 日志。',
          sessionId: current.sessionId,
        })
      }
      return
    }
    if (spec.name === 'compact' && compactBefore !== undefined) {
      const compactAfter = await this.measureCommandContext(live.agent.session)
      if (result.kind === 'success') {
        await this.deps.delivery.standaloneReply(msg, buildCompactComparisonCard({
          sessionId: current.sessionId,
          resultText: result.text ?? '命令已执行。',
          before: compactBefore,
          after: compactAfter,
        }))
        return
      }
      await this.deps.delivery.commandCard(msg, {
        kind: commandResultCardKind(result), command: spec.name,
        text: `${result.text}\n\n${compactFailureContext(compactBefore, compactAfter)}`,
        sessionId: current.sessionId,
      })
      return
    }
    await this.deps.delivery.commandCard(msg, {
      kind: commandResultCardKind(result), command: spec.name,
      text: result.text ?? '命令已执行。', sessionId: current.sessionId,
    })
  }

  /**
   * Annotate a route's session history with host-query facts: the latest
   * log-backed title per session and whether it is currently live. Both are
   * best-effort — a missing or failing `sessionQuery` only drops the titles.
   */
  private async sessionHistoryAnnotations(record: RouteRecord): Promise<Record<string, SessionHistoryAnnotation>> {
    const ids = record.sessionHistory
      .slice(-SESSION_HISTORY_DISPLAY_LIMIT)
      .map(entry => entry.sessionId)
    const annotations: Record<string, SessionHistoryAnnotation> = {}
    for (const id of ids) {
      annotations[id] = { live: this.deps.sessions.get(id) !== undefined || this.deps.ctx.agents.get(id as SessionId) !== undefined }
    }
    const query = this.deps.ctx.get?.('sessionQuery') as SessionQuery | undefined
    if (query === undefined) return annotations
    try {
      const results = await query.readTitleSnapshots(ids as SessionId[])
      for (const item of results) {
        if (item.status !== 'fulfilled' || item.value.title === undefined) continue
        annotations[item.sessionId] = { ...annotations[item.sessionId], title: item.value.title.title }
      }
    } catch (error) {
      this.deps.ctx.logger?.warn?.('dsh-channels: session title lookup failed: %s', String(error))
    }
    return annotations
  }

  /** Effective permission preset of one Session, when the service is mounted. */
  private permissionPresetOf(session: Session): string | undefined {
    const presets = this.deps.ctx.get?.('permissionPresets') as PermissionPresets | undefined
    try {
      return presets?.current(session)
    } catch {
      return undefined
    }
  }

  /** Optional diagnostic services resolved without topology-sensitive property access. */
  private commandContextServices(): ContextServices {
    return {
      tokenMeter: this.deps.ctx.get?.('tokenMeter') as TokenMeter | undefined,
      llm: this.deps.ctx.get?.('llm') as LlmService | undefined,
    }
  }

  /** Exact command-time measurement shared by `/status` and `/compact`. */
  private measureCommandContext(session: Session): Promise<ContextMeasurement> {
    return measureSessionContext(session, this.commandContextServices())
  }
}
