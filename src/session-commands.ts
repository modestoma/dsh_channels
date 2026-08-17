/**
 * Pure result rendering and validation for Session-scoped slash commands.
 *
 * @module dsh-channels/session-commands
 */

import path from 'node:path'
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

function standaloneCard(title: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: {
      elements: [
        { tag: 'markdown', content: title },
        ...elements,
      ],
    },
  }
}

export interface SessionStatusCardInput {
  sessionId: string
  stats: StatsFold
  context: ContextMeasurement
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
    { tag: 'markdown', content: input.sessionId, text_size: 'notation' },
  ])
}

export type WorkDirResolution =
  | { kind: 'success'; path: string }
  | { kind: 'missing'; text: string }
  | { kind: 'mismatch'; text: string }

/** Validate the Session header cwd against the plugin's durable route. */
export function resolveWorkDir(headerCwd: string | undefined, routeWorkspacePath: string): WorkDirResolution {
  if (headerCwd === undefined || headerCwd === '' || !path.isAbsolute(headerCwd)) {
    return {
      kind: 'missing',
      text: '当前 Session header 未记录可用的绝对工作目录；请检查 Session 创建或恢复配置。',
    }
  }
  if (!path.isAbsolute(routeWorkspacePath)) {
    return {
      kind: 'missing',
      text: '当前飞书路由未记录可用的绝对工作目录；请检查路由持久化状态。',
    }
  }
  if (headerCwd !== routeWorkspacePath) {
    return {
      kind: 'mismatch',
      text: 'Session header 与飞书路由记录的工作目录不一致；为避免返回错误目录，已拒绝显示。',
    }
  }
  return { kind: 'success', path: headerCwd }
}

/** Render one verified absolute workspace path. */
export function buildWorkDirCard(sessionId: string, workspacePath: string): object {
  return standaloneCard('**📁 当前工作目录**', [
    { tag: 'markdown', content: `\`${escapeInlineCode(workspacePath)}\`` },
    { tag: 'markdown', content: sessionId, text_size: 'notation' },
  ])
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
