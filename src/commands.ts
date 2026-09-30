/**
 * Feishu slash-command admission primitives.
 *
 * This module deliberately contains no channel or Host I/O. It owns the
 * product command vocabulary, exact parsing, agent-scoped registrations,
 * per-route admission serialization, and standalone result-card rendering.
 * Command-specific folds and side effects are added by the later SC tasks.
 *
 * @module dsh-channels/commands
 */

import type {
  AgentContext, CommandDefinition, CommandDescriptor, CommandResult, CommandRuntime,
} from './dsh-types.ts'
import { card } from './cards/primitives.ts'

import {
  CHANNEL_COMMANDS, commandNames, groupedCommandHelp, commandSpec, supportedCommandNames,
} from './commands/registry.ts'
import type { ChannelCommandSpec, SupportedCommandName } from './commands/registry.ts'

/** Canonical channel command names, in registry order (agent-scoped ones included). */
export const CHANNEL_COMMAND_NAMES = commandNames()

/** Every typeable command name (canonical + aliases). */
export const SUPPORTED_COMMAND_NAMES = supportedCommandNames()

export type { SupportedCommandName }

export interface ParsedSlashCommand {
  readonly name: string
  /** Exact text following the command name, including separator whitespace. */
  readonly rawInput: string
}

/** Match Harness' lowercase command grammar without normalizing arguments. */
export function parseSlashCommand(line: string): ParsedSlashCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, rawInput: line.slice(match[0].length) }
}

export function isSupportedCommand(name: string): name is SupportedCommandName {
  return commandSpec(name) !== undefined
}

/** Stable display used by unknown-command and deployment diagnostics. */
export function supportedCommandList(): string {
  return SUPPORTED_COMMAND_NAMES.map(name => `/${name}`).join('、')
}

/** Markdown help, grouped and generated from the command registry. */
export function supportedCommandHelp(): string {
  return groupedCommandHelp()
}

/** Commands registered inside each Agent scope (route-free ones are excluded). */
const ALL_COMMANDS: readonly ChannelCommandSpec[] = CHANNEL_COMMANDS
const AGENT_SCOPED_COMMANDS = ALL_COMMANDS.filter(spec => spec.agentScoped !== false)

const DESCRIPTORS: ReadonlyArray<CommandDescriptor> = AGENT_SCOPED_COMMANDS.map(spec => ({
  name: spec.name,
  description: spec.description,
  ...(spec.usage === undefined ? {} : { input: { hint: spec.usage } }),
}))

function pendingHandler(name: string): CommandDefinition['handler'] {
  return ({ rawInput }): CommandResult => {
    if (rawInput.trim() !== '') {
      return { kind: 'error', text: `用法错误：/${name} 不接受参数。` }
    }
    return { kind: 'error', text: `命令 /${name} 的功能将在后续实施任务中启用。` }
  }
}

function readyHandler(name: string, text: string): CommandDefinition['handler'] {
  return ({ rawInput }): CommandResult => {
    if (rawInput.trim() !== '') {
      return { kind: 'error', text: `用法错误：/${name} 不接受参数。` }
    }
    return { kind: 'success', text }
  }
}

const healthHandler: CommandDefinition['handler'] = ({ rawInput }): CommandResult => {
  if (rawInput.trim() !== '') {
    return { kind: 'error', text: '用法错误：/health 不接受参数。' }
  }
  return { kind: 'success', text: '健康检查已完成。' }
}

type RenewOperation = (invocation: Parameters<CommandDefinition['handler']>[0]) =>
  ReturnType<CommandDefinition['handler']>

export type EffortCommandAction =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'reset' }

type EffortOperation = (
  invocation: Parameters<CommandDefinition['handler']>[0],
  action: EffortCommandAction,
) => ReturnType<CommandDefinition['handler']>

/** One armed `/model` execution: lists, validates, and switches models. */
export type ModelOperation = (
  invocation: Parameters<CommandDefinition['handler']>[0],
  rawInput: string,
) => ReturnType<CommandDefinition['handler']>

/** Per-execution authority: handlers stay instance-neutral when an Agent is borrowed. */
const RENEW_OPERATIONS = new WeakMap<AbortSignal, RenewOperation>()
const EFFORT_OPERATIONS = new WeakMap<AbortSignal, EffortOperation>()
const MODEL_OPERATIONS = new WeakMap<AbortSignal, ModelOperation>()

function parseEffortAction(rawInput: string): EffortCommandAction | undefined {
  const value = rawInput.trim()
  if (value === '') return { kind: 'show' }
  if (/\s/u.test(value)) return undefined
  return value === 'reset' ? { kind: 'reset' } : { kind: 'set', value }
}

const effortHandler: CommandDefinition['handler'] = invocation => {
  const action = parseEffortAction(invocation.rawInput)
  if (action === undefined) {
    return { kind: 'error', text: '用法错误：/effort [档位-id|reset]。' }
  }
  if (action.kind !== 'show' && (
    invocation.agent.status !== 'idle'
    || invocation.agent.inbox.nextTurn.length > 0
    || invocation.agent.inbox.nextStep.length > 0
  )) {
    return { kind: 'error', text: '当前 Session 正忙或仍有排队消息，暂时不能切换推理强度。' }
  }
  const operation = EFFORT_OPERATIONS.get(invocation.signal)
  if (operation === undefined) {
    return { kind: 'error', text: '/effort 只能通过已授权的飞书话题执行。' }
  }
  return operation(invocation, action)
}

const modelHandler: CommandDefinition['handler'] = invocation => {
  const rawInput = invocation.rawInput.trim()
  if (/\s/u.test(rawInput)) {
    return { kind: 'error', text: '用法错误：/model [模型-id|provider/model|reset]。' }
  }
  if (invocation.agent.status !== 'idle'
    || invocation.agent.inbox.nextTurn.length > 0
    || invocation.agent.inbox.nextStep.length > 0) {
    return { kind: 'error', text: '当前 Session 正忙或仍有排队消息，暂时不能切换模型。' }
  }
  const operation = MODEL_OPERATIONS.get(invocation.signal)
  if (operation === undefined) {
    return { kind: 'error', text: '/model 只能通过已授权的飞书话题执行。' }
  }
  return operation(invocation, rawInput)
}

const renewHandler: CommandDefinition['handler'] = invocation => {
  if (invocation.rawInput.trim() !== '') {
    return { kind: 'error', text: '用法错误：/renew 不接受参数。' }
  }
  if (invocation.agent.status !== 'idle'
    || invocation.agent.inbox.nextTurn.length > 0
    || invocation.agent.inbox.nextStep.length > 0) {
    return { kind: 'error', text: '当前 Session 正忙或仍有排队消息，暂时不能续建。' }
  }
  const operation = RENEW_OPERATIONS.get(invocation.signal)
  if (operation === undefined) {
    return { kind: 'error', text: '/renew 只能通过已授权的飞书话题执行。' }
  }
  return operation(invocation)
}

const READY_HANDLERS: Readonly<Record<string, CommandDefinition['handler']>> = {
  help: readyHandler('help', supportedCommandHelp()),
  health: healthHandler,
  status: readyHandler('status', 'Session 状态已读取。'),
  workspace: readyHandler('workspace', '工作目录已读取。'),
  effort: effortHandler,
  model: modelHandler,
  renew: renewHandler,
  history: readyHandler('history', 'Session 历史已读取。'),
  export: readyHandler('export', '导出已请求。'),
}

/** Arm exactly one Feishu-issued `/renew` execution, then return its disarmer. */
export function armRenewCommand(signal: AbortSignal, operation: RenewOperation): () => void {
  RENEW_OPERATIONS.set(signal, operation)
  return () => { RENEW_OPERATIONS.delete(signal) }
}

/** Arm exactly one Feishu-issued `/effort` execution, then return its disarmer. */
export function armEffortCommand(signal: AbortSignal, operation: EffortOperation): () => void {
  EFFORT_OPERATIONS.set(signal, operation)
  return () => { EFFORT_OPERATIONS.delete(signal) }
}

/** Arm exactly one Feishu-issued `/model` execution, then return its disarmer. */
export function armModelCommand(signal: AbortSignal, operation: ModelOperation): () => void {
  MODEL_OPERATIONS.set(signal, operation)
  return () => { MODEL_OPERATIONS.delete(signal) }
}

/** Install only `/model` into a borrowed Agent scope that lacks channel commands. */
export function registerModelCommand(commands: CommandRuntime): () => void {
  const descriptor = DESCRIPTORS.find(entry => entry.name === 'model')!
  return commands.register({ ...descriptor, handler: modelHandler })
}

/** Install only `/renew` into a borrowed Agent scope that lacks channel commands. */
export function registerRenewCommand(commands: CommandRuntime): () => void {
  const descriptor = DESCRIPTORS.find(entry => entry.name === 'renew')!
  return commands.register({ ...descriptor, handler: renewHandler })
}

/** Install only `/effort` into a borrowed Agent scope that lacks channel commands. */
export function registerEffortCommand(commands: CommandRuntime): () => void {
  const descriptor = DESCRIPTORS.find(entry => entry.name === 'effort')!
  return commands.register({ ...descriptor, handler: effortHandler })
}

/**
 * Register this channel's commands inside one agent scope. `/compact` stays
 * global and is intentionally not registered here.
 */
export function registerChannelCommands(commands: CommandRuntime): void {
  for (const descriptor of DESCRIPTORS) {
    commands.register({
      ...descriptor,
      handler: READY_HANDLERS[descriptor.name] ?? pendingHandler(descriptor.name),
    })
  }
}

function registerScopedChannelCommands(ctx: AgentContext): void {
  registerChannelCommands(ctx.commands)
}

/**
 * Mount channel commands through an Agent child plugin that explicitly
 * injects the command service. The Agent scope is minted by `agent-loop`, so
 * it does not inherit this package's top-level dependency declaration.
 */
export async function mountChannelCommands(agentCtx: AgentContext): Promise<void> {
  await agentCtx.inject(['commands'], registerScopedChannelCommands)
}

/**
 * FIFO admission queue keyed by the durable route key. Failures never poison
 * the tail, and an idle key is retired so the map remains bounded.
 */
export class RouteOperationQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const tail = result.then(() => {}, () => {})
    this.tails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  clear(): void {
    this.tails.clear()
  }
}

export type CommandCardKind =
  | 'success'
  | 'help'
  | 'context-error'
  | 'input-error'
  | 'unknown'
  | 'unbound'
  | 'expired'
  | 'forbidden'
  | 'busy'
  | 'unavailable'
  | 'internal-error'

export interface CommandCardState {
  readonly kind: CommandCardKind
  readonly command?: string
  readonly text: string
  readonly supported?: string
  readonly sessionId?: string
}

/** Map stable command outcomes onto the shared result-card vocabulary. */
export function commandResultCardKind(result: CommandResult): CommandCardKind {
  if (result.kind === 'success') return 'success'
  if (/^(?:用法错误：|Usage:)/u.test(result.text)) return 'input-error'
  if (/\b(?:active compaction|not idle|busy)\b|正忙|正在运行/iu.test(result.text)) return 'busy'
  return 'unavailable'
}

const CARD_TITLES: Record<CommandCardKind, string> = {
  success: '✅ 命令执行完成',
  help: '📖 斜杠命令帮助',
  'context-error': '⚠️ 使用场景不匹配',
  'input-error': '⚠️ 命令格式不正确',
  unknown: '❓ 未知命令',
  unbound: '🔗 尚未绑定会话',
  expired: '⌛ 话题已过期',
  forbidden: '🔒 无权操作此会话',
  busy: '⏳ 会话正忙',
  unavailable: '🧩 命令暂不可用',
  'internal-error': '❌ 命令执行失败',
}

/** Render a small, non-streaming Feishu card that never contains raw errors. */
export function buildCommandResultCard(state: CommandCardState): object {
  const elements: object[] = [
    { tag: 'markdown', content: `**${CARD_TITLES[state.kind]}**` },
    { tag: 'markdown', content: state.text },
  ]
  if (state.supported !== undefined) {
    elements.push({ tag: 'markdown', content: `可用命令：${state.supported}`, text_size: 'notation' })
  }
  if (state.command !== undefined || state.sessionId !== undefined) {
    const trace = [
      state.command === undefined ? undefined : `/${state.command}`,
      state.sessionId,
    ].filter((value): value is string => value !== undefined).join(' · ')
    elements.push({ tag: 'markdown', content: trace, text_size: 'notation' })
  }
  return card(elements)
}
