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

export interface HealthSnapshotInput {
  fibers: Iterable<CordisFiber>
  dependencies: Readonly<Record<HealthDependencyName, boolean>>
  connection?: FeishuConnectionStatus
  botOpenId?: string
  started: boolean
  routeCount: number
  liveAgentCount: number
  inflightTurnCount: number
}

export interface HealthSnapshot extends Omit<HealthSnapshotInput, 'fibers' | 'botOpenId'> {
  level: HealthLevel
  fibers: FiberHealthCounts
  /** Masked display only; the complete open_id never crosses this boundary. */
  botOpenIdTail?: string
}

/** Fold every non-disposed Cordis fiber into the five product-facing states. */
export function countFiberStates(fibers: Iterable<CordisFiber>): FiberHealthCounts {
  const counts: FiberHealthCounts = { active: 0, pending: 0, loading: 0, failed: 0, unloading: 0 }
  for (const fiber of fibers) {
    if (fiber.state === CordisFiberState.ACTIVE) counts.active++
    else if (fiber.state === CordisFiberState.PENDING) counts.pending++
    else if (fiber.state === CordisFiberState.LOADING) counts.loading++
    else if (fiber.state === CordisFiberState.FAILED) counts.failed++
    else if (fiber.state === CordisFiberState.UNLOADING) counts.unloading++
  }
  return counts
}

/** Reveal only the final four characters, and nothing for unusually short ids. */
export function maskOpenIdTail(openId?: string): string | undefined {
  if (openId === undefined || openId.length <= 4) return undefined
  return `…${openId.slice(-4)}`
}

/** One deterministic fold owns both the snapshot and its overall conclusion. */
export function foldHealthSnapshot(input: HealthSnapshotInput): HealthSnapshot {
  const fibers = countFiberStates(input.fibers)
  const dependencyMissing = HEALTH_DEPENDENCY_NAMES.some(name => !input.dependencies[name])
  const connectionState = input.connection?.state

  let level: HealthLevel
  if (!input.started || dependencyMissing || connectionState === 'failed' || fibers.failed > 0) {
    level = 'unhealthy'
  } else if (
    connectionState !== 'connected'
    || fibers.pending > 0
    || fibers.loading > 0
    || fibers.unloading > 0
  ) {
    level = 'degraded'
  } else {
    level = 'healthy'
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
  ])
}
