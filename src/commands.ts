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
  CommandDefinition, CommandDescriptor, CommandResult, CommandRuntime,
} from './dsh-types.ts'

export const CHANNEL_COMMAND_NAMES = [
  'health',
  'status',
  'work-dir',
  'renew',
  'history',
  'export',
] as const

export const SUPPORTED_COMMAND_NAMES = [
  'health',
  'status',
  'work-dir',
  'compact',
  'renew',
  'history',
  'export',
] as const

export type SupportedCommandName = typeof SUPPORTED_COMMAND_NAMES[number]

const SUPPORTED_NAMES = new Set<string>(SUPPORTED_COMMAND_NAMES)

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
  return SUPPORTED_NAMES.has(name)
}

/** Stable display used by unknown-command and deployment diagnostics. */
export function supportedCommandList(): string {
  return SUPPORTED_COMMAND_NAMES.map(name => `/${name}`).join('、')
}

const DESCRIPTORS: ReadonlyArray<CommandDescriptor> = [
  { name: 'health', description: '显示 Harness 与飞书通道健康状态' },
  { name: 'status', description: '显示当前 Session 状态与性能指标' },
  { name: 'work-dir', description: '显示当前 Session 工作目录' },
  { name: 'renew', description: '在当前话题创建并绑定新 Session' },
  { name: 'history', description: '显示当前话题的 Session 历史' },
  { name: 'export', description: '导出当前 Session 的逻辑日志' },
]

function pendingHandler(name: string): CommandDefinition['handler'] {
  return ({ rawInput }): CommandResult => {
    if (rawInput.trim() !== '') {
      return { kind: 'error', text: `用法错误：/${name} 不接受参数。` }
    }
    return { kind: 'error', text: `命令 /${name} 的功能将在后续实施任务中启用。` }
  }
}

/**
 * Register this channel's commands inside one agent scope. `/compact` stays
 * global and is intentionally not registered here.
 */
export function registerChannelCommands(commands: CommandRuntime): void {
  for (const descriptor of DESCRIPTORS) {
    commands.register({ ...descriptor, handler: pendingHandler(descriptor.name) })
  }
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
  | 'input-error'
  | 'unknown'
  | 'unbound'
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
  'input-error': '⚠️ 命令格式不正确',
  unknown: '❓ 未知命令',
  unbound: '🔗 尚未绑定会话',
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
  return { schema: '2.0', config: { width_mode: 'fill' }, body: { elements } }
}
