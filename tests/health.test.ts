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
      botOpenId: 'ou_bot_12345678',
      started: true,
      routeCount: 2,
      liveAgentCount: 1,
      inflightTurnCount: 1,
    }).level).toBe(level)
  })

  it('renders aggregate state without the full open_id, errors, or credential values', () => {
    const snapshot = foldHealthSnapshot({
      fibers: [{ state: CordisFiberState.ACTIVE }],
      dependencies: dependencies(),
      connection: {
        state: 'reconnecting', lastConnectTime: 100, nextConnectTime: 200, reconnectAttempts: 3,
      },
      botOpenId: 'ou_secret_bot_12345678',
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
    expect(json).not.toContain('ou_secret_bot_12345678')
    expect(json).not.toContain('secret-value')
    expect(json).not.toContain('appSecret')
    expect(json).not.toContain('stack')
  })

  it('never reveals an unusually short open_id', () => {
    expect(maskOpenIdTail('abcd')).toBeUndefined()
  })
})
