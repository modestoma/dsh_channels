/**
 * The channel's slash-command registry: one declarative source for the
 * command vocabulary, admission rules, `/help` rendering, and dispatch.
 *
 * Adding a command means adding one entry here (plus its handler): the
 * supported-name list, the help text, and the admission gate all derive from
 * this table.
 *
 * @module dsh-channels/commands/registry
 */

/** Help grouping, in render order. */
export const COMMAND_GROUPS = ['基础', '会话', '模型与上下文', '导出'] as const
export type CommandGroup = typeof COMMAND_GROUPS[number]

export interface ChannelCommandSpec {
  /** Canonical command name (without the leading slash). */
  readonly name: string
  readonly group: CommandGroup
  readonly description: string
  /** Argument hint shown in help, e.g. `[id|reset]`. */
  readonly usage?: string
  /** Answerable without any Session work (and inside a retired topic). */
  readonly routeFree?: boolean
  /** Answerable with or without a bound Session: bound runs on the command plane. */
  readonly sessionOptional?: boolean
  /** Unthreaded group messages require a bot mention before the command answers. */
  readonly mentionGate?: boolean
  /** Only usable in this chat type. */
  readonly chatType?: 'p2p' | 'group'
  /** Answer with a direct reply instead of creating a topic. */
  readonly directReply?: boolean
  /**
   * Answered by the channel itself (`/stop`), never through the agent command
   * plane, and never cold-resuming a Session just to answer.
   */
  readonly channelPlane?: boolean
  /**
   * Registered inside each Agent scope for the agent command plane. Defaults
   * to true; `false` for route-free commands, channel-plane commands, and the
   * native host `/compact`.
   */
  readonly agentScoped?: boolean
}

/** The complete command vocabulary. */
export const CHANNEL_COMMANDS = [
  {
    name: 'help', group: '基础', description: '显示当前支持的斜杠命令',
    routeFree: true, directReply: false,
  },
  {
    name: 'userid', group: '基础', description: '在私聊中显示当前用户 ID',
    routeFree: true, mentionGate: true, chatType: 'p2p', directReply: true, agentScoped: false,
  },
  {
    name: 'groupid', group: '基础', description: '在群聊中显示当前群组 ID',
    routeFree: true, mentionGate: true, chatType: 'group', directReply: true, agentScoped: false,
  },
  {
    name: 'health', group: '基础', description: '显示 Harness 与飞书通道健康状态',
    sessionOptional: true,
  },
  {
    name: 'status', group: '会话', description: '显示当前 Session 状态与性能指标',
  },
  {
    name: 'workspace', group: '会话', description: '显示当前 Session 工作目录',
  },
  {
    name: 'permissions', group: '会话', description: '查看（或按配置切换）当前 Session 权限预设',
    usage: '[name]', channelPlane: true, agentScoped: false,
  },
  {
    name: 'auth', group: '会话', description: '查看/管理访问授权（仅管理员）',
    usage: '[status|allow|revoke|list|user add <open_id>|user remove <open_id>]',
    routeFree: true, channelPlane: true, agentScoped: false,
  },
  {
    name: 'renew', group: '会话', description: '在当前话题创建并绑定新 Session',
  },
  {
    name: 'stop', group: '会话', description: '停止当前正在运行的回合',
    channelPlane: true, agentScoped: false,
  },
  {
    name: 'effort', group: '模型与上下文', description: '查看或切换当前 Session 推理强度',
    usage: '[id|reset]',
  },
  {
    name: 'model', group: '模型与上下文', description: '查看或切换当前 Session 模型',
    usage: '[id|provider/model|reset]',
  },
  {
    name: 'compact', group: '模型与上下文', description: '压缩当前 Session 上下文', agentScoped: false,
  },
  {
    name: 'history', group: '导出', description: '显示当前话题的 Session 历史',
  },
  {
    name: 'export', group: '导出', description: '导出当前 Session 的逻辑日志',
  },
] as const satisfies readonly ChannelCommandSpec[]

/** Canonical command name literal union. */
export type ChannelCommandName = typeof CHANNEL_COMMANDS[number]['name']

/** User-facing aliases, resolved to their canonical command. */
export const COMMAND_ALIASES = { new: 'renew' } as const
export type ChannelCommandAlias = keyof typeof COMMAND_ALIASES

/** Any command name a user may type. */
export type SupportedCommandName = ChannelCommandName | ChannelCommandAlias

const BY_NAME = new Map<string, ChannelCommandSpec>(
  CHANNEL_COMMANDS.map(spec => [spec.name, spec as ChannelCommandSpec]),
)

/** Resolve one typed name (canonical or alias) to its command spec. */
export function commandSpec(name: string): ChannelCommandSpec | undefined {
  const canonical = (COMMAND_ALIASES as Record<string, string>)[name] ?? name
  return BY_NAME.get(canonical)
}

/** Canonical command names, in registry order. */
export function commandNames(): readonly ChannelCommandName[] {
  return CHANNEL_COMMANDS.map(spec => spec.name)
}

/** Every typeable name (canonical + aliases), for the supported-name list. */
export function supportedCommandNames(): readonly SupportedCommandName[] {
  return [...commandNames(), ...Object.keys(COMMAND_ALIASES)] as SupportedCommandName[]
}

/** `用法：/effort [id|reset]` line, or undefined without a usage hint. */
export function commandUsage(spec: ChannelCommandSpec): string | undefined {
  if (spec.usage === undefined) return undefined
  return `/${spec.name} ${spec.usage}`
}

/** Grouped `/help` markdown, derived from the registry. */
export function groupedCommandHelp(): string {
  const sections: string[] = []
  const specs: readonly ChannelCommandSpec[] = CHANNEL_COMMANDS
  for (const group of COMMAND_GROUPS) {
    const lines = specs
      .filter(spec => spec.group === group)
      .map(spec => {
        const usage = commandUsage(spec)
        return `**/${spec.name}**${usage === undefined ? '' : ` ${spec.usage}`} — ${spec.description}`
      })
    if (lines.length > 0) sections.push(`**${group}**\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}
