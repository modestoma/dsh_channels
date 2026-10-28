import { describe, expect, it } from 'vitest'
import {
  buildHealthCard, countFiberStates, foldHealthSnapshot, HEALTH_DEPENDENCY_NAMES, maskOpenIdTail,
} from '../src/health.ts'
import { CordisFiberState } from '../src/dsh-types.ts'
import type { HealthDependencyName } from '../src/health.ts'

function dependencies(missing?: HealthDependencyName): Record<HealthDependencyName, boolean> {
  return Object.fromEntries(HEALTH_DEPENDENCY_NAMES.map(name => [name, name !== missing])) as Record<HealthDependencyName, boolean>
}

describe('health snapshot', () => {
  it('folds all product-facing Cordis states and ignores disposed fibers', () => {
    expect(countFiberStates([
      { state: CordisFiberState.ACTIVE },
      { state: CordisFiberState.ACTIVE },
      { state: CordisFiberState.PENDING },
      { state: CordisFiberState.LOADING },
      { state: CordisFiberState.FAILED },
      { state: CordisFiberState.UNLOADING },
      { state: CordisFiberState.DISPOSED },
    ])).toEqual({ active: 2, pending: 1, loading: 1, failed: 1, unloading: 1 })
  })

  it.each([
    [{ state: 'connected', reconnectAttempts: 0 }, [], undefined, 'healthy'],
    [{ state: 'reconnecting', reconnectAttempts: 2 }, [], undefined, 'degraded'],
    [{ state: 'connected', reconnectAttempts: 0 }, [{ state: CordisFiberState.PENDING }], undefined, 'degraded'],
    [{ state: 'failed', reconnectAttempts: 5 }, [], undefined, 'unhealthy'],
    [{ state: 'connected', reconnectAttempts: 0 }, [{ state: CordisFiberState.FAILED }], undefined, 'unhealthy'],
    [{ state: 'connected', reconnectAttempts: 0 }, [], 'commands', 'unhealthy'],
  ] as const)('maps connection, fiber, and dependency signals to %s', (connection, fibers, missing, level) => {
    expect(foldHealthSnapshot({
      fibers,
      dependencies: dependencies(missing),
      connection,
      botOpenId: 'u_bot_12345678',
      started: true,
      routeCount: 2,
      liveAgentCount: 1,
      inflightTurnCount: 1,
    }).level).toBe(level)
  })

  it('explains a degraded level with the host-wide pending plugin names', () => {
    const snapshot = foldHealthSnapshot({
      fibers: [
        { state: CordisFiberState.ACTIVE, name: 'channels' },
        { state: CordisFiberState.PENDING, name: 'dsh-experimental-inspector' },
      ],
      dependencies: dependencies(),
      connection: { state: 'connected', reconnectAttempts: 0 },
      started: true,
      routeCount: 0,
      liveAgentCount: 0,
      inflightTurnCount: 0,
    })
    expect(snapshot.level).toBe('degraded')
    expect(snapshot.reasons).toEqual([
      '宿主其它插件仍有 1 个入口在等待依赖或加载/卸载（与飞书通道无关）：dsh-experimental-inspector',
    ])
    expect(snapshot.inactiveFibers).toEqual([{ state: 'pending', label: 'dsh-experimental-inspector' }])
    expect(snapshot.inactiveTotal).toBe(1)
  })

  it('keeps healthy snapshots reason-free and caps the listed inactive fibers', () => {
    const healthy = foldHealthSnapshot({
      fibers: [{ state: CordisFiberState.ACTIVE, name: 'channels' }],
      dependencies: dependencies(),
      connection: { state: 'connected', reconnectAttempts: 0 },
      started: true,
      routeCount: 0,
      liveAgentCount: 0,
      inflightTurnCount: 0,
    })
    expect(healthy.reasons).toEqual([])
    expect(healthy.inactiveFibers).toEqual([])

    const pendingFibers = Array.from({ length: 20 }, (_, index) => ({
      state: CordisFiberState.PENDING,
      name: `plugin-${index}`,
    }))
    const busy = foldHealthSnapshot({
      fibers: pendingFibers,
      dependencies: dependencies(),
      connection: { state: 'connected', reconnectAttempts: 0 },
      started: true,
      routeCount: 0,
      liveAgentCount: 0,
      inflightTurnCount: 0,
    })
    expect(busy.inactiveFibers).toHaveLength(12)
    expect(busy.inactiveTotal).toBe(20)
    expect(busy.reasons[0]).toContain('仍有 20 个入口')
    expect(busy.reasons[0]).toContain('等 20 个')
  })

  it('lists connection, dependency, and failure causes for unhealthy states', () => {
    const snapshot = foldHealthSnapshot({
      fibers: [
        { state: CordisFiberState.FAILED, name: 'broken-plugin' },
      ],
      dependencies: dependencies('commands'),
      connection: { state: 'failed', reconnectAttempts: 3 },
      started: true,
      routeCount: 0,
      liveAgentCount: 0,
      inflightTurnCount: 0,
    })
    expect(snapshot.level).toBe('unhealthy')
    expect(snapshot.reasons).toEqual(expect.arrayContaining([
      '主机服务未就绪：commands',
      '飞书长连接失败',
      '插件加载失败 1 个：broken-plugin',
    ]))
  })

  it('renders aggregate state without the full open_id, errors, or credential values', () => {
    const snapshot = foldHealthSnapshot({
      fibers: [{ state: CordisFiberState.ACTIVE }],
      dependencies: dependencies(),
      connection: {
        state: 'reconnecting', lastConnectTime: 100, nextConnectTime: 200, reconnectAttempts: 3,
      },
      botOpenId: 'u_secret_bot_12345678',
      started: true,
      routeCount: 4,
      liveAgentCount: 2,
      inflightTurnCount: 1,
    })
    const json = JSON.stringify(buildHealthCard(snapshot))

    expect(json).toContain('degraded')
    expect(json).toContain('reconnecting')
    expect(json).toContain('…5678')
    expect(json).toContain('持久化路由 4')
    expect(json).not.toContain('u_secret_bot_12345678')
    expect(json).not.toContain('secret-value')
    expect(json).not.toContain('appSecret')
    expect(json).not.toContain('stack')
  })

  it('never reveals an unusually short open_id', () => {
    expect(maskOpenIdTail('abcd')).toBeUndefined()
  })
})
