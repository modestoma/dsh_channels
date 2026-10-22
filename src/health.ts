/**
 * Privacy-preserving health snapshot and Feishu card rendering.
 *
 * The fold consumes only aggregate lifecycle and service-presence signals.
 * It never accepts configuration values, credentials, fiber errors, or stack
 * traces, which keeps accidental disclosure out of the rendering boundary.
 *
 * @module dsh-channels/health
 */

import { CordisFiberState } from './dsh-types.ts'
import type { CordisFiber } from './dsh-types.ts'
import type { FeishuConnectionStatus } from './feishu-channel.ts'
import { standaloneCard } from './cards/primitives.ts'

export const HEALTH_DEPENDENCY_NAMES = [
  'agents',
  'commands',
  'workspace',
  'storage',
  'credentials',
  'llm',
  'token-meter',
] as const

export type HealthDependencyName = typeof HEALTH_DEPENDENCY_NAMES[number]
export type HealthLevel = 'healthy' | 'degraded' | 'unhealthy'

export interface FiberHealthCounts {
  active: number
  pending: number
  loading: number
  failed: number
  unloading: number
}

/** States that make the Fold report something other than healthy. */
export type FiberIssueState = 'pending' | 'loading' | 'unloading' | 'failed'

/** One non-active fiber with a best-effort plugin name (no errors/stacks). */
export interface FiberHealthIssue {
  state: FiberIssueState
  label: string
}

/** Upper bound on the diagnostic list; counts still include every fiber. */
const MAX_INACTIVE_FIBERS = 12

export interface HealthSnapshotInput {
  fibers: Iterable<CordisFiber>
  dependencies: Readonly<Record<HealthDependencyName, boolean>>
  connection?: FeishuConnectionStatus
  botOpenId?: string
  started: boolean
  routeCount: number
  liveAgentCount: number
  inflightTurnCount: number
  /** Why the configured analyze listener could not bind; absent when it is bound or not configured. */
  analyzeListenError?: string
}

export interface HealthSnapshot extends Omit<HealthSnapshotInput, 'fibers' | 'botOpenId'> {
  level: HealthLevel
  fibers: FiberHealthCounts
  /** Masked display only; the complete open_id never crosses this boundary. */
  botOpenIdTail?: string
  /** Non-active plugin fibers (capped at MAX_INACTIVE_FIBERS), diagnostics only. */
  inactiveFibers: FiberHealthIssue[]
  /** Total non-active fibers, including those beyond the capped list. */
  inactiveTotal: number
  /** Human-readable explanation of `level`; empty when healthy. */
  reasons: string[]
}

/** Best-effort label for a fiber: Cordis exposes the plugin display name on the fiber. */
function fiberLabel(fiber: CordisFiber): string {
  const name = fiber.name?.trim()
  return name !== undefined && name !== '' ? name : '(未命名插件)'
}

/** One pass over the fiber table: state counts plus the non-active diagnostics. */
function foldFiberStates(fibers: Iterable<CordisFiber>): {
  counts: FiberHealthCounts
  inactive: FiberHealthIssue[]
  inactiveTotal: number
} {
  const counts: FiberHealthCounts = { active: 0, pending: 0, loading: 0, failed: 0, unloading: 0 }
  const inactive: FiberHealthIssue[] = []
  let inactiveTotal = 0
  for (const fiber of fibers) {
    const issueState: FiberIssueState | undefined =
      fiber.state === CordisFiberState.PENDING ? 'pending'
        : fiber.state === CordisFiberState.LOADING ? 'loading'
          : fiber.state === CordisFiberState.UNLOADING ? 'unloading'
            : fiber.state === CordisFiberState.FAILED ? 'failed'
              : undefined
    if (fiber.state === CordisFiberState.ACTIVE) {
      counts.active++
      continue
    }
    if (issueState === undefined) continue // disposed fibers are not health signals
    counts[issueState === 'pending' ? 'pending' : issueState === 'loading' ? 'loading' : issueState === 'unloading' ? 'unloading' : 'failed']++
    inactiveTotal++
    if (inactive.length < MAX_INACTIVE_FIBERS) inactive.push({ state: issueState, label: fiberLabel(fiber) })
  }
  return { counts, inactive, inactiveTotal }
}

/** Fold every non-disposed Cordis fiber into the five product-facing states. */
export function countFiberStates(fibers: Iterable<CordisFiber>): FiberHealthCounts {
  return foldFiberStates(fibers).counts
}

/** Human-readable connection state for diagnostics (keeps raw states visible). */
function connectionReason(state: string | undefined): string {
  switch (state) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中'
    case 'reconnecting': return '重连中'
    case 'failed': return '连接失败'
    case 'idle': return '空闲（未连接）'
    default: return state ?? '未知'
  }
}

function labelList(labels: readonly string[], total: number, max = 6): string {
  if (labels.length === 0) return ''
  const shown = labels.slice(0, max).join('、')
  return total > Math.min(labels.length, max) ? `${shown} 等 ${total} 个` : shown
}

/** Reveal only the final four characters, and nothing for unusually short ids. */
export function maskOpenIdTail(openId?: string): string | undefined {
  if (openId === undefined || openId.length <= 4) return undefined
  return `…${openId.slice(-4)}`
}

/** One deterministic fold owns both the snapshot and its overall conclusion. */
export function foldHealthSnapshot(input: HealthSnapshotInput): HealthSnapshot {
  const { counts: fibers, inactive, inactiveTotal } = foldFiberStates(input.fibers)
  const missingDependencies = HEALTH_DEPENDENCY_NAMES.filter(name => !input.dependencies[name])
  const dependencyMissing = missingDependencies.length > 0
  const connectionState = input.connection?.state

  let level: HealthLevel
  if (!input.started || dependencyMissing || connectionState === 'failed' || fibers.failed > 0) {
    level = 'unhealthy'
  } else if (
    connectionState !== 'connected'
    || fibers.pending > 0
    || fibers.loading > 0
    || fibers.unloading > 0
    || input.analyzeListenError !== undefined
  ) {
    level = 'degraded'
  } else {
    level = 'healthy'
  }

  const reasons: string[] = []
  if (!input.started) reasons.push('飞书通道尚未启动')
  if (dependencyMissing) reasons.push(`主机服务未就绪：${missingDependencies.join('、')}`)
  if (input.connection === undefined) reasons.push('飞书长连接尚未建立')
  else if (connectionState === 'failed') reasons.push('飞书长连接失败')
  else if (connectionState !== 'connected') reasons.push(`飞书长连接状态：${connectionReason(connectionState)}`)

  const failedLabels = inactive.filter(issue => issue.state === 'failed').map(issue => issue.label)
  if (fibers.failed > 0) {
    reasons.push(`插件加载失败 ${fibers.failed} 个${failedLabels.length === 0 ? '' : `：${labelList(failedLabels, fibers.failed)}`}`)
  }
  const stalled = fibers.pending + fibers.loading + fibers.unloading
  if (stalled > 0) {
    const stalledLabels = inactive
      .filter(issue => issue.state === 'pending' || issue.state === 'loading' || issue.state === 'unloading')
      .map(issue => issue.label)
    reasons.push(
      `宿主其它插件仍有 ${stalled} 个入口在等待依赖或加载/卸载（与飞书通道无关）`
      + (stalledLabels.length === 0 ? '' : `：${labelList(stalledLabels, stalled)}`),
    )
  }

  if (input.analyzeListenError !== undefined) {
    reasons.push(`日志分析接口监听失败：${input.analyzeListenError}`)
  }

  return {
    level,
    fibers,
    dependencies: input.dependencies,
    connection: input.connection,
    botOpenIdTail: maskOpenIdTail(input.botOpenId),
    started: input.started,
    routeCount: input.routeCount,
    liveAgentCount: input.liveAgentCount,
    inflightTurnCount: input.inflightTurnCount,
    ...(input.analyzeListenError === undefined ? {} : { analyzeListenError: input.analyzeListenError }),
    inactiveFibers: inactive,
    inactiveTotal,
    reasons,
  }
}

const LEVEL_PRESENTATION: Record<HealthLevel, { icon: string; title: string }> = {
  healthy: { icon: '✅', title: '运行健康' },
  degraded: { icon: '⚠️', title: '运行降级' },
  unhealthy: { icon: '❌', title: '运行异常' },
}

function formatTimestamp(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString()
}

/** Render a standalone non-streaming health card from the sanitized snapshot. */
export function buildHealthCard(snapshot: HealthSnapshot): object {
  const presentation = LEVEL_PRESENTATION[snapshot.level]
  const dependencyLine = HEALTH_DEPENDENCY_NAMES
    .map(name => `${snapshot.dependencies[name] ? '✅' : '❌'} ${name}`)
    .join(' · ')
  const connection = snapshot.connection
  const connectionState = connection?.state ?? 'unknown'

  return standaloneCard(`**${presentation.icon} 健康检查 · ${presentation.title}**`, [
    { tag: 'markdown', content: `整体结论：**${snapshot.level}**` },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**Harness fibers**\nactive ${snapshot.fibers.active} · pending ${snapshot.fibers.pending} · loading ${snapshot.fibers.loading} · failed ${snapshot.fibers.failed} · unloading ${snapshot.fibers.unloading}`,
    },
    { tag: 'markdown', content: `**关键依赖**\n${dependencyLine}` },
    {
      tag: 'markdown',
      content: `**飞书 WebSocket**\n${connectionState} · 最近连接 ${formatTimestamp(connection?.lastConnectTime)} · 下次重连 ${formatTimestamp(connection?.nextConnectTime)} · 重连次数 ${connection?.reconnectAttempts ?? 0} · bot open_id ${snapshot.botOpenIdTail ?? '—'}`,
    },
    {
      tag: 'markdown',
      content: `**dsh-channels**\n${snapshot.started ? 'started' : 'stopped'} · 持久化路由 ${snapshot.routeCount} · live Agent ${snapshot.liveAgentCount} · in-flight turn ${snapshot.inflightTurnCount}`,
    },
    ...(snapshot.analyzeListenError === undefined ? [] : [{
      tag: 'markdown',
      content: `**日志分析接口**\n❌ 监听失败：${snapshot.analyzeListenError}`,
    }]),
  ])
}
