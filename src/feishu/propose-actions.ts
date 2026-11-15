/**
 * Model-facing `propose_actions` tool: lets a Feishu-routed root Agent
 * (`delegationDepth === 0`) post a non-blocking follow-up action proposal card
 * into its current conversation at the end of a turn.
 *
 * Guardrails:
 * - Gated by `feishuTools.proposeActions` (default `true`).
 * - Mounted and executable ONLY on root sessions (`delegationDepth === 0`, no
 *   `parentSession`); subagent calls are refused.
 * - At most 1 successful proposal per turn per session.
 * - Politely skipped (without error or card send) when the session's inbox
 *   already holds a queued user message waiting for the next turn.
 *
 * @module dsh-channels/feishu/propose-actions
 */

import { randomUUID } from 'node:crypto'
import {
  ACTION_ACCESS_LEVELS,
  proposeActionsInputSchema,
  RESERVED_DISMISS_ACTION_ID,
} from '../actions/contract.ts'
import type { FeishuActionsService } from '../actions/contract.ts'
import type { FeishuConfig } from '../config.ts'
import type {
  Agent,
  AgentContext,
  PreToolDecision,
  PreToolExecution,
  Session,
  SessionEvent,
  ToolContentBlock,
  ToolDefinition,
  ToolExecution,
} from '../host/index.ts'
import { AgentToolMount } from './tool-mount.ts'

/** Stable model-facing tool name. */
export const PROPOSE_ACTIONS_TOOL_NAME = 'propose_actions'

const PROPOSE_ACTIONS_DESCRIPTION =
  '在当前飞书话题或会话末尾发送一张独立的非阻塞「后续可选动作」按钮卡片，不会挂起或阻塞当前回合。'
  + '当本轮回复已经给出完整结论，同时存在 1–4 个明确的后续可选执行动作供用户按需点选时使用；系统会自动在末尾追加灰色的「暂不处理」按钮。'
  + '每个动作需提供唯一短标识 id（禁止使用保留字 dismiss）、按钮文案 label（1–32 字）以及点击后作为新回合指令提交的自包含 followUpPrompt（1–8000 字）；'
  + '可按需声明 requiredAccess（chat / code-write / wiki-write / admin）和 independent（默认 false 表示点选任一动作后关闭其余按钮，true 表示支持先后分别点选多项）。'
  + '限制：仅飞书主会话可用（子代理禁止调用）；单回合最多成功调用 1 次；若收件箱已有排队中的下一条用户消息会自动跳过发卡。'

/** JSON Schema advertised to the model for `propose_actions`. */
export const PROPOSE_ACTIONS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: '卡片动作区的一句话纯文本引导语（trim 后 1–120 字）。',
    },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: '可选动作按钮列表（1–4 项；渠道自动追加末尾「暂不处理」按钮）。',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: `动作在本次提议内的唯一可见 ASCII 短标识（禁止使用保留字 "${RESERVED_DISMISS_ACTION_ID}"）。`,
          },
          label: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            description: '按钮显示文案（trim 后 1–32 字）。',
          },
          style: {
            type: 'string',
            enum: ['primary', 'default'],
            description: '按钮视觉样式：primary 强调推荐项，default 普通项（默认）。',
          },
          requiredAccess: {
            type: 'string',
            enum: [...ACTION_ACCESS_LEVELS],
            description: '点击按钮所需的渠道权限级别（默认 chat；涉及改代码填 code-write，写知识库填 wiki-write，仅限私聊管理员填 admin）。',
          },
          followUpPrompt: {
            type: 'string',
            minLength: 1,
            maxLength: 8_000,
            description: '用户点击该按钮后作为新回合跟进消息提交进当前会话的自包含完整指令文本（1–8000 字）。',
          },
          independent: {
            type: 'boolean',
            description: '是否允许与其他按钮先后独立点击；默认 false（点击后其余待选按钮一并关闭），true 支持多选独立结算。',
          },
        },
        required: ['id', 'label', 'followUpPrompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['prompt', 'actions'],
  additionalProperties: false,
}

export type ProposeActionsFailureCode =
  | 'TOOL_DISABLED'
  | 'SUBAGENT_FORBIDDEN'
  | 'TURN_LIMIT_EXCEEDED'
  | 'ROUTE_NOT_FOUND'
  | 'CHANNEL_UNAVAILABLE'
  | 'INVALID_PROPOSAL'
  | 'SEND_FAILED'
  | 'ABORTED'

export type ProposeActionsValue =
  | {
    readonly ok: true
    readonly skipped: false
    readonly summary: string
    readonly card_message_id: string
    readonly action_count: number
  }
  | {
    readonly ok: true
    readonly skipped: true
    readonly summary: string
  }
  | {
    readonly ok: false
    readonly code: ProposeActionsFailureCode
    readonly reason: string
  }

export const PROPOSE_ACTIONS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    skipped: { type: 'boolean' },
    summary: { type: 'string' },
    card_message_id: { type: 'string' },
    action_count: { type: 'integer' },
    code: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['ok'],
}

const SUBAGENT_REFUSAL_REASON = 'propose_actions 仅允许飞书活动路由的主会话（delegationDepth === 0）调用，子代理不可调用'

type TurnToken = number | 'unnumbered'

export interface ProposeActionsRuntimeDeps {
  config(): FeishuConfig
  actions: FeishuActionsService
  /** Live Agent bound to `sessionId`, when published. */
  agentOfSession(sessionId: string): Agent | undefined
  /** Whether `sessionId` currently owns an active Feishu route. */
  isRoutedSession(sessionId: string): boolean
  warn(message: string, ...args: unknown[]): void
}

function isRootSessionHeader(session: Session | undefined): boolean {
  if (session === undefined) return true
  return (session.header.delegationDepth ?? 0) === 0 && session.header.parentSession === undefined
}

function latestOpenTurnFromLog(session: Session | undefined): number | undefined {
  if (session === undefined) return undefined
  const total = session.snapshotEvents().length
  const events = session.snapshotEvents(Math.max(0, total - 32), total)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') return undefined
    if ((event.type === 'step/start' || event.type === 'tool/call') && typeof event.data.turn === 'number') {
      return event.data.turn
    }
  }
  return undefined
}

export class ProposeActionsToolRuntime {
  /** Session ID → active turn number observed from host events. */
  private readonly activeTurns = new Map<string, number>()
  /** Session ID → turn token in which `propose_actions` already succeeded. */
  private readonly consumedTurns = new Map<string, TurnToken>()
  /** Session IDs currently executing `propose_actions` (prevents concurrent double-send). */
  private readonly inFlightSessions = new Set<string>()

  private readonly toolMount = new AgentToolMount({
    label: PROPOSE_ACTIONS_TOOL_NAME,
    enabled: () => this.enabled(),
    definitions: sessionId => (this.canMountFor(sessionId) ? [this.definitionFor(sessionId)] : []),
    describeError: error => (error instanceof Error ? error.message : String(error)),
    warn: (message, ...args) => this.deps.warn(message, ...args),
  })

  constructor(private readonly deps: ProposeActionsRuntimeDeps) {}

  enabled(): boolean {
    return this.deps.config().feishuTools.proposeActions
  }

  private canMountFor(sessionId: string): boolean {
    if (!this.enabled()) return false
    const agent = this.deps.agentOfSession(sessionId)
    return isRootSessionHeader(agent?.session)
  }

  /** Mount `propose_actions` into one root Feishu Agent scope. */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    if (!this.canMountFor(sessionId)) return
    await this.toolMount.mount(agentCtx, sessionId)
  }

  /** Track turn boundaries so the 1-per-turn quota resets cleanly on every new turn. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/end') {
      this.activeTurns.delete(session.id)
      this.consumedTurns.delete(session.id)
      return
    }
    if ((event.type === 'step/start' || event.type === 'tool/call') && typeof event.data.turn === 'number') {
      const prev = this.activeTurns.get(session.id)
      if (prev !== event.data.turn) {
        this.activeTurns.set(session.id, event.data.turn)
        if (this.consumedTurns.get(session.id) !== event.data.turn) {
          this.consumedTurns.delete(session.id)
        }
      }
    }
  }

  /** Record the turn number opened when an inbox message is claimed. */
  onInboxClaimed(sessionId: string, turn: number): void {
    this.activeTurns.set(sessionId, turn)
    if (this.consumedTurns.get(sessionId) !== turn) {
      this.consumedTurns.delete(sessionId)
    }
  }

  /** Defence-in-depth `tools/pre-execute` gate refusing subagent calls. */
  decidePreExecute(exec: PreToolExecution): PreToolDecision | undefined {
    if (exec.name !== PROPOSE_ACTIONS_TOOL_NAME) return undefined
    if (exec.agent !== undefined && !isRootSessionHeader(exec.agent.session)) {
      return { kind: 'deny', reason: SUBAGENT_REFUSAL_REASON }
    }
    return undefined
  }

  /** Drop ephemeral turn-tracking state on channel shutdown. */
  clear(): void {
    this.activeTurns.clear()
    this.consumedTurns.clear()
    this.inFlightSessions.clear()
  }

  private definitionFor(sessionId: string): ToolDefinition {
    return {
      name: PROPOSE_ACTIONS_TOOL_NAME,
      description: PROPOSE_ACTIONS_DESCRIPTION,
      parameters: PROPOSE_ACTIONS_PARAMETERS,
      output: {
        schema: PROPOSE_ACTIONS_OUTPUT_SCHEMA,
        render: (_args, value) => renderProposeActionsResult(value),
      },
      execute: async (rawArgs, exec) => await this.execute(sessionId, rawArgs, exec),
      presentCall: args => presentProposeActionsCall(args),
      presentResult: (_args, value) => presentProposeActionsResult(value),
      isConcurrencySafe: () => false,
    }
  }

  private currentTurnToken(sessionId: string, agent: Agent | undefined): TurnToken {
    return this.activeTurns.get(sessionId)
      ?? latestOpenTurnFromLog(agent?.session)
      ?? 'unnumbered'
  }

  private async execute(
    sessionId: string,
    rawArgs: Record<string, unknown>,
    exec: ToolExecution,
  ): Promise<ProposeActionsValue> {
    const parsed = proposeActionsInputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.')
      throw new Error(`${PROPOSE_ACTIONS_TOOL_NAME}: invalid ${where}: ${issue?.message ?? 'invalid arguments'}`)
    }
    const args = parsed.data

    if (!this.enabled()) {
      return { ok: false, code: 'TOOL_DISABLED', reason: 'propose_actions 已在插件配置中关闭' }
    }

    const execAgent = (exec as { readonly agent?: Agent }).agent
    const boundAgent = this.deps.agentOfSession(sessionId)
    if (
      (execAgent !== undefined && (!isRootSessionHeader(execAgent.session) || execAgent.session.id !== sessionId))
      || !isRootSessionHeader(boundAgent?.session)
    ) {
      return { ok: false, code: 'SUBAGENT_FORBIDDEN', reason: SUBAGENT_REFUSAL_REASON }
    }

    if (!this.deps.isRoutedSession(sessionId)) {
      return { ok: false, code: 'ROUTE_NOT_FOUND', reason: '当前会话未绑定有效的飞书活动路由，无法发送动作提议卡片' }
    }

    const agent = execAgent ?? boundAgent
    const turnToken = this.currentTurnToken(sessionId, agent)
    const consumed = this.consumedTurns.get(sessionId)
    if (this.inFlightSessions.has(sessionId) || (consumed !== undefined && (consumed === turnToken || turnToken === 'unnumbered'))) {
      return {
        ok: false,
        code: 'TURN_LIMIT_EXCEEDED',
        reason: '当前回合已成功发起过一次后续动作提议；单回合最多成功调用 1 次 propose_actions',
      }
    }

    if ((agent?.inbox.nextTurn.length ?? 0) > 0 || (agent?.inbox.nextStep.length ?? 0) > 0) {
      return {
        ok: true,
        skipped: true,
        summary: '当前会话收件箱已有排队等待处理的用户消息，已礼貌跳过发送动作提议卡片。',
      }
    }

    if (exec.signal.aborted) {
      return { ok: false, code: 'ABORTED', reason: '调用已取消' }
    }

    this.inFlightSessions.add(sessionId)
    try {
      const key = `tool:${sessionId}:${randomUUID()}`
      const result = await this.deps.actions.propose({
        key,
        sessionId,
        prompt: args.prompt,
        actions: args.actions,
      })
      if (!result.ok) {
        return {
          ok: false,
          code: mapServiceFailure(result.code),
          reason: result.message,
        }
      }
      this.consumedTurns.set(sessionId, turnToken)
      return {
        ok: true,
        skipped: false,
        summary: `已发送后续动作提议卡片（${args.actions.length} 个可选动作，消息 ID ${result.cardMessageId}）`,
        card_message_id: result.cardMessageId,
        action_count: args.actions.length,
      }
    } finally {
      this.inFlightSessions.delete(sessionId)
    }
  }
}

function mapServiceFailure(
  code: 'invalid' | 'not-connected' | 'unrouted-session' | 'send-failed',
): ProposeActionsFailureCode {
  switch (code) {
    case 'invalid':
      return 'INVALID_PROPOSAL'
    case 'not-connected':
      return 'CHANNEL_UNAVAILABLE'
    case 'unrouted-session':
      return 'ROUTE_NOT_FOUND'
    case 'send-failed':
      return 'SEND_FAILED'
  }
}

function isProposeActionsValue(value: unknown): value is ProposeActionsValue {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}

export function renderProposeActionsResult(value: unknown): readonly ToolContentBlock[] {
  return [{ type: 'text', text: presentProposeActionsResult(value) }]
}

export function presentProposeActionsCall(args: Record<string, unknown>): string {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 60) : ''
  const count = Array.isArray(args.actions) ? args.actions.length : 0
  return prompt === '' ? `发起动作提议（${count} 项）` : `发起动作提议：${prompt}`
}

export function presentProposeActionsResult(value: unknown): string {
  if (!isProposeActionsValue(value)) return '动作提议结果不可用'
  if (value.ok) return value.summary
  return `动作提议未发送（${value.code}）：${value.reason}`
}
