/**
 * Pure result rendering and validation for Session-scoped slash commands.
 *
 * @module dsh-channels/session-commands
 */

import path from 'node:path'
import { standaloneCard } from './cards/primitives.ts'
import type { RouteRecord, SessionHistoryEntry } from './domain.ts'
import { normalizeSessionHistory } from './domain.ts'
import type { ContextMeasurement, StatsFold, ToolEventSample } from './stats.ts'
import {
  averageDecodeTokensPerSecond, averageTtftMs, cacheHitPct,
} from './stats.ts'

function fmtCount(value: number): string {
  return value.toLocaleString('en-US')
}

function fmtDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '暂无数据'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2)} s`
}

function fmtPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '暂无数据' : `${(value * 100).toFixed(1)}%`
}

function fmtRate(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '暂无数据' : `${value.toFixed(1)} tokens/s`
}

function contextLine(measurement: ContextMeasurement): string {
  const tokens = measurement.contextTokens
  const window = measurement.contextWindow
  if (tokens === undefined) return '暂无数据'
  if (window === undefined) return `${fmtCount(tokens)} tokens`
  return `${fmtCount(tokens)} / ${fmtCount(window)} (${(tokens / window * 100).toFixed(1)}%)`
}

function escapeInlineCode(value: string): string {
  return value.replaceAll('`', '\\`')
}

function toolLine(sample: ToolEventSample): string {
  const status = sample.status === 'running' ? '运行中' : sample.status === 'success' ? '成功' : '失败'
  const duration = sample.status === 'running' ? '尚未完成' : fmtDuration(sample.durationMs)
  return `- \`${escapeInlineCode(sample.name)}\` · ${status} · ${duration}`
}

export interface SessionStatusCardInput {
  sessionId: string
  stats: StatsFold
  context: ContextMeasurement
  /** Optional operational extras (permission preset, workspace, uptime, …). */
  extras?: SessionStatusExtras
}

/** Operational extras appended to the `/status` card when available. */
export interface SessionStatusExtras {
  /** Effective permission preset of this Session (`ctx.permissionPresets`). */
  permissionPreset?: string
  /** Effective working directory of this Session (its topic directory). */
  sessionDir?: string
  /** Plugin uptime in milliseconds. */
  uptimeMs?: number
  /** Live agent entries this channel owns/borrows. */
  liveAgents?: number
  /** Persisted route records. */
  routeCount?: number
}

/** Render the complete `/status` snapshot without exposing tool arguments or results. */
export function buildSessionStatusCard(input: SessionStatusCardInput): object {
  const { stats } = input
  const model = stats.lastHeader === undefined
    ? '尚未产生模型请求'
    : `${stats.lastHeader.provider}/${stats.lastHeader.model}`
  const effort = stats.lastHeader?.effort ?? '暂无数据'
  const tools = stats.recentTools.length === 0
    ? '暂无工具事件'
    : [...stats.recentTools].reverse().map(toolLine).join('\n')
  const pendingNames = [...stats.pendingTools.values()].slice(-5).map(tool => `\`${escapeInlineCode(tool.name)}\``)
  const hiddenPending = stats.pendingTools.size - pendingNames.length
  const pending = pendingNames.length === 0
    ? '无'
    : `${pendingNames.join('、')}${hiddenPending > 0 ? `，另有 ${hiddenPending} 个` : ''}`
  const tokenSummary = stats.usageSamples === 0
    ? '暂无数据'
    : `输入 ${fmtCount(stats.totals.inputTokens)} · 输出 ${fmtCount(stats.totals.outputTokens)} · 推理 ${fmtCount(stats.totals.reasoningTokens)}`
  const cacheSummary = stats.usageSamples === 0
    ? '暂无数据'
    : `读取 ${fmtCount(stats.totals.cacheReadTokens)} · 写入 ${fmtCount(stats.totals.cacheWriteTokens)} · 最近命中率 ${fmtPercent(cacheHitPct(stats.lastUsage))}`

  return standaloneCard('**📊 Session 状态**', [
    { tag: 'markdown', content: `**模型**：${model}\n**推理强度**：${effort}` },
    {
      tag: 'markdown',
      content: `**Token 累计**：${tokenSummary}\n`
        + `**缓存**：${cacheSummary}\n`
        + `**上下文**：${contextLine(input.context)}`,
    },
    {
      tag: 'markdown',
      content: `**LLM 时间**：${fmtDuration(stats.llmSteps === 0 ? undefined : stats.llmMs)}\n`
        + `**工具时间**：${fmtDuration(stats.toolTimedCalls === 0 ? undefined : stats.toolMs)}\n`
        + `**平均首 token**：${fmtDuration(averageTtftMs(stats))}\n`
        + `**平均生成速度**：${fmtRate(averageDecodeTokensPerSecond(stats))}`,
    },
    {
      tag: 'markdown',
      content: `**工具调用**：累计 ${fmtCount(stats.toolCalls)} · 未完成 ${fmtCount(stats.pendingTools.size)}（${pending}）\n`
        + `**最近工具事件（最多 5 条）**\n${tools}`,
    },
    ...statusExtrasElements(input.extras),
    { tag: 'markdown', content: input.sessionId, text_size: 'notation' },
  ])
}

/** Render the optional operational lines, omitting unavailable ones. */
function statusExtrasElements(extras: SessionStatusExtras | undefined): object[] {
  if (extras === undefined) return []
  const lines: string[] = []
  if (extras.permissionPreset !== undefined) lines.push(`**权限预设**：\`${escapeInlineCode(extras.permissionPreset)}\``)
  if (extras.sessionDir !== undefined) lines.push(`**会话目录**：\`${escapeInlineCode(extras.sessionDir)}\``)
  if (extras.uptimeMs !== undefined) lines.push(`**插件运行时长**：${fmtUptime(extras.uptimeMs)}`)
  if (extras.liveAgents !== undefined || extras.routeCount !== undefined) {
    const parts: string[] = []
    if (extras.liveAgents !== undefined) parts.push(`live Agent ${fmtCount(extras.liveAgents)}`)
    if (extras.routeCount !== undefined) parts.push(`持久化路由 ${fmtCount(extras.routeCount)}`)
    lines.push(`**通道**：${parts.join(' · ')}`)
  }
  return lines.length === 0 ? [] : [{ tag: 'markdown', content: lines.join('\n') }]
}

/** `2 小时 5 分` / `45 秒` — coarse human uptime. */
function fmtUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours === 0 ? `${minutes} 分` : `${hours} 小时 ${minutes} 分`
}

export type WorkDirResolution =
  | { kind: 'success'; path: string }
  | { kind: 'missing'; text: string }
  | { kind: 'mismatch'; text: string }

/** The durable route facts needed to verify a Session's working directory. */
export interface WorkDirRoute {
  /** Workspace root owning the Session (its header cwd when grouped). */
  readonly workspacePath: string
  /** Effective working directory (topic directory / worktree); absent on v1 routes. */
  readonly sessionDir?: string
}

/**
 * Validate the Session header cwd against the plugin's durable route and
 * return the Session's effective working directory.
 *
 * The header cwd is normally the workspace root (the Session stays grouped
 * under the user's project while working in a per-topic directory). In the
 * degraded placement used when the host exposes no `workingDirectory` service,
 * the header cwd is the topic directory itself.
 */
export function resolveWorkDir(
  headerCwd: string | undefined,
  route: WorkDirRoute,
): WorkDirResolution {
  if (headerCwd === undefined || headerCwd === '' || !path.isAbsolute(headerCwd)) {
    return {
      kind: 'missing',
      text: '当前 Session header 未记录可用的绝对工作目录；请检查 Session 创建或恢复配置。',
    }
  }
  if (!path.isAbsolute(route.workspacePath)) {
    return {
      kind: 'missing',
      text: '当前飞书路由未记录可用的工作区目录；请检查路由持久化状态。',
    }
  }
  if (route.sessionDir !== undefined && !path.isAbsolute(route.sessionDir)) {
    return {
      kind: 'missing',
      text: '当前飞书路由未记录可用的会话目录；请检查路由持久化状态。',
    }
  }
  const expected = route.sessionDir ?? route.workspacePath
  if (headerCwd !== route.workspacePath && headerCwd !== expected) {
    return {
      kind: 'mismatch',
      text: 'Session header 与飞书路由记录的工作目录不一致；为避免返回错误目录，已拒绝显示。',
    }
  }
  return { kind: 'success', path: expected }
}

/** Render one verified absolute working directory. */
export function buildWorkDirCard(sessionId: string, sessionDir: string): object {
  return standaloneCard('**📁 当前工作目录**', [
    { tag: 'markdown', content: `\`${escapeInlineCode(sessionDir)}\`` },
    { tag: 'markdown', content: sessionId, text_size: 'notation' },
  ])
}

export interface RenewCardInput {
  previousSessionId: string
  currentSessionId: string
  /** Topic directory that the renewed Session reuses. */
  sessionDir: string
}

/** Render the committed route switch without implying that the old log was deleted. */
export function buildRenewCard(input: RenewCardInput): object {
  return standaloneCard('**🔄 Session 已续建**', [
    {
      tag: 'markdown',
      content: `**旧 Session**：${input.previousSessionId}\n`
        + `**新 Session**：${input.currentSessionId}\n`
        + `**复用目录**：\`${escapeInlineCode(input.sessionDir)}\``,
    },
    { tag: 'markdown', content: '旧 Session 及其日志仍由 Harness 保留。', text_size: 'notation' },
  ])
}

export const SESSION_HISTORY_DISPLAY_LIMIT = 20

export interface SessionHistoryItem extends SessionHistoryEntry {
  current: boolean
}

export interface SessionHistoryView {
  total: number
  items: SessionHistoryItem[]
  hidden: number
}

/** Read one route's normalized history without consulting the Session repository. */
export function querySessionHistory(record: RouteRecord): SessionHistoryView {
  const history = normalizeSessionHistory(record)
  const items = history
    .slice(-SESSION_HISTORY_DISPLAY_LIMIT)
    .reverse()
    .map(entry => ({ ...entry, current: entry.sessionId === record.sessionId }))
  return {
    total: history.length,
    items,
    hidden: Math.max(0, history.length - items.length),
  }
}

/** Optional per-session facts folded from the host session query. */
export interface SessionHistoryAnnotation {
  /** Latest log-backed session title, when one exists. */
  title?: string
  /** Whether the session is currently live (held by any owner). */
  live?: boolean
}

function historyLine(
  item: SessionHistoryItem,
  index: number,
  annotation: SessionHistoryAnnotation | undefined,
): string {
  const markers = [
    ...(item.current ? ['**当前**'] : []),
    ...(annotation?.live === true && !item.current ? ['live'] : []),
  ]
  const marker = markers.length === 0 ? '' : ` · ${markers.join(' · ')}`
  const title = annotation?.title === undefined || annotation.title === ''
    ? ''
    : `\n   标题：${escapeInlineCode(annotation.title)}`
  return `${index + 1}. \`${escapeInlineCode(item.sessionId)}\`${marker}${title}\n`
    + `   创建时间：${new Date(item.createdAt).toISOString()}`
}

/** Render the newest route-local Session history with host-query annotations. */
export function buildSessionHistoryCard(
  record: RouteRecord,
  annotations: Readonly<Record<string, SessionHistoryAnnotation>> = {},
): object {
  const view = querySessionHistory(record)
  const elements: object[] = [
    { tag: 'markdown', content: `**总数**：${fmtCount(view.total)}\n**当前 Session**：\`${escapeInlineCode(record.sessionId)}\`` },
    { tag: 'markdown', content: view.items.map((item, index) => historyLine(item, index, annotations[item.sessionId])).join('\n') },
  ]
  if (view.hidden > 0) {
    elements.push({ tag: 'markdown', content: `另有 ${fmtCount(view.hidden)} 条未展示。`, text_size: 'notation' })
  }
  return standaloneCard('**🕘 Session 历史**', elements)
}

function comparisonLine(label: string, tokens: number | undefined, window: number | undefined): string {
  if (tokens === undefined) return `${label}  暂无数据`
  if (window === undefined) return `${label}  ${fmtCount(tokens)} tokens`
  const ratio = tokens / window
  const filled = Math.min(10, Math.max(0, Math.round(ratio * 10)))
  return `${label}  ${'█'.repeat(filled)}${'░'.repeat(10 - filled)}  ${(ratio * 100).toFixed(0)}%  ${fmtCount(tokens)} / ${fmtCount(window)}`
}

export interface CompactComparisonInput {
  sessionId: string
  resultText: string
  before: ContextMeasurement
  after: ContextMeasurement
}

/** Render successful and no-op compaction outcomes with one shared 10-cell scale. */
export function buildCompactComparisonCard(input: CompactComparisonInput): object {
  const window = input.after.contextWindow ?? input.before.contextWindow
  const beforeTokens = input.before.contextTokens
  const afterTokens = input.after.contextTokens
  const released = beforeTokens === undefined || afterTokens === undefined
    ? undefined
    : Math.max(0, beforeTokens - afterTokens)
  return standaloneCard('**🗜️ 上下文压缩完成**', [
    { tag: 'markdown', content: input.resultText },
    {
      tag: 'markdown',
      content: `${comparisonLine('压缩前', beforeTokens, window)}\n`
        + `${comparisonLine('压缩后', afterTokens, window)}\n`
        + `释放    ${released === undefined ? '暂无数据' : `${fmtCount(released)} tokens`}`,
    },
    { tag: 'markdown', content: input.sessionId, text_size: 'notation' },
  ])
}

/** Describe whether a failed compaction left the measured surface unchanged. */
export function compactFailureContext(before: ContextMeasurement, after: ContextMeasurement): string {
  if (before.contextTokens === undefined || after.contextTokens === undefined) return '上下文状态：暂无可用测量数据。'
  if (before.contextTokens === after.contextTokens) {
    return `上下文保持不变：${fmtCount(before.contextTokens)} tokens。`
  }
  return `上下文状态可能已变化：执行前 ${fmtCount(before.contextTokens)} tokens，当前 ${fmtCount(after.contextTokens)} tokens；请检查 Session 后再重试。`
}
