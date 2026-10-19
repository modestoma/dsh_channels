import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceCleanup, isPathInside, planWorkspaceCleanup, retentionMs, WORKSPACE_RETENTION_VALUES,
} from '../src/cleanup.ts'
import type {
  CleanupCandidate, CleanupDeps, CleanupPlan, CleanupRoute, CleanupTombstone, CleanupWorkspace, WorkspaceStats,
} from '../src/cleanup.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_000 * DAY_MS
const BASE_DIR = '/srv/channels-data'

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value')
  return value
}

function workspace(id: string, overrides: Partial<CleanupWorkspace> = {}): CleanupWorkspace {
  return { id, path: `${BASE_DIR}/p2p/${id}`, title: `飞书私聊 · ${id}`, ...overrides }
}

function route(overrides: Partial<CleanupRoute> = {}): CleanupRoute {
  return {
    key: 'omt_route',
    kind: 'thread',
    workspacePath: `${BASE_DIR}/p2p/ou_1`,
    sessionId: 'session-1',
    lastActivityAt: NOW - 40 * DAY_MS,
    ...overrides,
  }
}

function stats(mtimeMs: number, bytes = 1024, files = 2): WorkspaceStats {
  return { mtimeMs, bytes, files }
}

interface HarnessOptions {
  workspaces?: readonly CleanupWorkspace[]
  routes?: readonly CleanupRoute[]
  tombstones?: readonly CleanupTombstone[]
  live?: readonly string[]
  stats?: (workspacePath: string) => WorkspaceStats | undefined
  retention?: CleanupDeps['retention']
}

interface Harness {
  deps: CleanupDeps
  calls: string[]
  warnings: string[]
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = []
  const warnings: string[] = []
  const live = new Set(options.live ?? [])
  const deps: CleanupDeps = {
    baseDir: BASE_DIR,
    retention: options.retention ?? '30d',
    listWorkspaces: () => options.workspaces ?? [],
    activeRoutes: () => options.routes ?? [],
    tombstones: () => options.tombstones ?? [],
    isLive: sessionId => live.has(sessionId),
    statWorkspace: workspacePath => options.stats?.(workspacePath),
    removeWorkspace: ws => { calls.push(`remove:${ws.path}`) },
    retireRoute: record => { calls.push(`retire:${record.key}`) },
    now: () => NOW,
    warn: message => { warnings.push(message) },
  }
  return { deps, calls, warnings }
}

function candidate(ws: CleanupWorkspace, overrides: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return { workspace: ws, activityAt: NOW - 90 * DAY_MS, bytes: 1024, files: 2, routes: [], ...overrides }
}

function planOf(...candidates: CleanupCandidate[]): CleanupPlan {
  return { retentionMs: 30 * DAY_MS, cutoff: NOW - 30 * DAY_MS, candidates, skippedLive: 0 }
}

describe('workspace retention window', () => {
  it('maps every config value to its window and off to nothing', () => {
    expect(WORKSPACE_RETENTION_VALUES).toEqual(['off', '7d', '30d', '90d', '180d'])
    expect(retentionMs('off')).toBeUndefined()
    expect(retentionMs('7d')).toBe(7 * DAY_MS)
    expect(retentionMs('30d')).toBe(30 * DAY_MS)
    expect(retentionMs('90d')).toBe(90 * DAY_MS)
    expect(retentionMs('180d')).toBe(180 * DAY_MS)
  })
})

describe('workspace cleanup planning', () => {
  it('returns undefined when retention is off, without touching any dependency', async () => {
    const h = harness()
    const deps: CleanupDeps = {
      ...h.deps,
      retention: 'off',
      listWorkspaces: () => { throw new Error('must not be called') },
    }
    expect(await planWorkspaceCleanup(deps)).toBeUndefined()
  })

  it('refuses a filesystem-root base directory', async () => {
    const h = harness()
    const deps: CleanupDeps = { ...h.deps, baseDir: '/' }
    expect(await planWorkspaceCleanup(deps)).toBeUndefined()
    expect(h.warnings.some(warning => warning.includes('filesystem root'))).toBe(true)
  })

  it('selects old plugin workspaces and keeps recent ones', async () => {
    const old = workspace('ou_old')
    const recent = workspace('ou_recent')
    const h = harness({
      workspaces: [old, recent],
      stats: workspacePath => workspacePath === old.path
        ? stats(NOW - 40 * DAY_MS, 4096, 3)
        : stats(NOW - DAY_MS, 10, 1),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.retentionMs).toBe(30 * DAY_MS)
    expect(plan.cutoff).toBe(NOW - 30 * DAY_MS)
    expect(plan.candidates.map(entry => entry.workspace.id)).toEqual(['ou_old'])
    expect(plan.candidates[0]).toMatchObject({
      activityAt: NOW - 40 * DAY_MS,
      bytes: 4096,
      files: 3,
      routes: [],
    })
    expect(plan.skippedLive).toBe(0)
  })

  it('uses the newest route activity for a workspace with active routes', async () => {
    const ws = workspace('ou_routed')
    const h = harness({
      workspaces: [ws],
      routes: [
        route({ key: 'omt_old', workspacePath: ws.path, lastActivityAt: NOW - 60 * DAY_MS }),
        route({ key: 'omt_new', workspacePath: ws.path, lastActivityAt: NOW - DAY_MS }),
      ],
    })
    expect(defined(await planWorkspaceCleanup(h.deps)).candidates).toEqual([])
  })

  it('skips workspaces whose route session is still live and counts them', async () => {
    const ws = workspace('ou_live')
    const h = harness({
      workspaces: [ws],
      routes: [route({
        workspacePath: ws.path,
        sessionId: 'session-live',
        lastActivityAt: NOW - 90 * DAY_MS,
      })],
      live: ['session-live'],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
    expect(plan.skippedLive).toBe(1)
  })

  it('treats an unknown liveness result as live and keeps the workspace', async () => {
    const ws = workspace('ou_unknown')
    const h = harness({
      workspaces: [ws],
      routes: [route({ workspacePath: ws.path, sessionId: 'session-unknown' })],
    })
    const deps: CleanupDeps = {
      ...h.deps,
      isLive: () => { throw new Error('host unavailable') },
    }
    const plan = defined(await planWorkspaceCleanup(deps))
    expect(plan.candidates).toEqual([])
    expect(plan.skippedLive).toBe(1)
    expect(h.warnings.some(warning => warning.includes('liveness check failed'))).toBe(true)
  })

  it('attributes tombstone activity when no active route remains', async () => {
    const eligible = workspace('ou_tomb_old')
    const kept = workspace('ou_tomb_new')
    const h = harness({
      workspaces: [eligible, kept],
      tombstones: [
        {
          key: 'omt_old',
          workspacePath: eligible.path,
          expiredAt: NOW - 5 * DAY_MS,
          lastActivityAt: NOW - 45 * DAY_MS,
        },
        {
          key: 'omt_new',
          workspacePath: kept.path,
          expiredAt: NOW - 2 * DAY_MS,
          lastActivityAt: NOW - 2 * DAY_MS,
        },
      ],
      // A recent mtime must not override attributed tombstone activity.
      stats: () => stats(NOW - DAY_MS),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(entry => entry.workspace.id)).toEqual(['ou_tomb_old'])
    expect(plan.candidates[0]?.activityAt).toBe(NOW - 45 * DAY_MS)
  })

  it('falls back to expiredAt for a tombstone without last activity', async () => {
    const ws = workspace('ou_tomb_expired')
    const h = harness({
      workspaces: [ws],
      tombstones: [{ key: 'omt_expired', workspacePath: ws.path, expiredAt: NOW - 40 * DAY_MS }],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(entry => entry.workspace.id)).toEqual(['ou_tomb_expired'])
    expect(plan.candidates[0]?.activityAt).toBe(NOW - 40 * DAY_MS)
  })

  it('cannot attribute legacy tombstones without a path and falls back to mtime', async () => {
    const ws = workspace('ou_legacy')
    const h = harness({
      workspaces: [ws],
      // Newer than the cutoff, but it carries no workspace identity.
      tombstones: [{ key: 'omt_legacy', expiredAt: NOW - DAY_MS }],
      stats: () => stats(NOW - 60 * DAY_MS, 2048, 4),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(entry => entry.workspace.id)).toEqual(['ou_legacy'])
    expect(plan.candidates[0]).toMatchObject({
      activityAt: NOW - 60 * DAY_MS,
      bytes: 2048,
      files: 4,
    })
  })

  it('never offers a workspace whose activity cannot be established', async () => {
    const h = harness({
      workspaces: [workspace('ou_stats_missing')],
      stats: () => undefined,
    })
    expect(defined(await planWorkspaceCleanup(h.deps)).candidates).toEqual([])
  })

  it('tolerates a throwing stat implementation', async () => {
    const h = harness({ workspaces: [workspace('ou_stat_throws')] })
    const deps: CleanupDeps = {
      ...h.deps,
      statWorkspace: (): WorkspaceStats => { throw new Error('EACCES') },
    }
    expect(defined(await planWorkspaceCleanup(deps)).candidates).toEqual([])
    expect(h.warnings.some(warning => warning.includes('stats unavailable'))).toBe(true)
  })

  it('still plans a route-evidenced candidate when only its size is unreadable', async () => {
    const ws = workspace('ou_route_stats_missing')
    const h = harness({
      workspaces: [ws],
      routes: [route({
        workspacePath: ws.path,
        sessionId: 'session-old',
        lastActivityAt: NOW - 90 * DAY_MS,
      })],
      stats: () => undefined,
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]).toMatchObject({ activityAt: NOW - 90 * DAY_MS, bytes: 0, files: 0 })
  })

  it('keeps activity exactly at the cutoff', async () => {
    const h = harness({
      workspaces: [workspace('ou_exactly_cutoff')],
      stats: () => stats(NOW - 30 * DAY_MS),
    })
    expect(defined(await planWorkspaceCleanup(h.deps)).candidates).toEqual([])
  })

  it('ignores non-plugin titles, the base directory itself, and paths outside it', async () => {
    const h = harness({
      workspaces: [
        workspace('ou_foreign', { title: '普通工作区' }),
        workspace('ou_base', { path: BASE_DIR }),
        workspace('ou_outside', { path: '/tmp/echo' }),
        workspace('ou_sibling', { path: `${BASE_DIR}-other/p2p/ou_sibling` }),
      ],
      stats: () => stats(NOW - 365 * DAY_MS),
    })
    expect(defined(await planWorkspaceCleanup(h.deps)).candidates).toEqual([])
  })

  it('orders candidates oldest activity first', async () => {
    const older = workspace('ou_older')
    const newer = workspace('ou_newer')
    const h = harness({
      workspaces: [newer, older],
      routes: [
        route({ key: 'omt_older', workspacePath: older.path, lastActivityAt: NOW - 90 * DAY_MS }),
        route({ key: 'omt_newer', workspacePath: newer.path, lastActivityAt: NOW - 45 * DAY_MS }),
      ],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(entry => entry.workspace.path)).toEqual([older.path, newer.path])
  })
})

describe('workspace cleanup application', () => {
  it('retires a stale workspace’s routes before removing its directory', async () => {
    const ws = workspace('ou_clean')
    const h = harness({
      workspaces: [ws],
      routes: [
        route({ key: 'omt_a', workspacePath: ws.path, lastActivityAt: NOW - 90 * DAY_MS }),
        route({ key: 'omt_b', workspacePath: ws.path, lastActivityAt: NOW - 80 * DAY_MS }),
      ],
      stats: () => stats(NOW - 90 * DAY_MS, 4096, 3),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    const outcome = await applyWorkspaceCleanup(h.deps, plan)
    expect(h.calls).toEqual(['retire:omt_a', 'retire:omt_b', `remove:${ws.path}`])
    expect(outcome).toEqual({ deletedWorkspaces: 1, retiredRoutes: 2, freedBytes: 4096, failures: [] })
  })

  it('records a removal failure and keeps processing later candidates', async () => {
    const broken = workspace('ou_broken_remove')
    const healthy = workspace('ou_healthy')
    const h = harness()
    const deps: CleanupDeps = {
      ...h.deps,
      removeWorkspace: async (ws) => {
        h.calls.push(`remove:${ws.path}`)
        if (ws.path === broken.path) throw new Error('EBUSY')
      },
    }
    const plan = planOf(
      candidate(broken, { bytes: 100, files: 1 }),
      candidate(healthy, { bytes: 200, files: 2 }),
    )
    const outcome = await applyWorkspaceCleanup(deps, plan)
    expect(h.calls).toEqual([`remove:${broken.path}`, `remove:${healthy.path}`])
    expect(outcome.deletedWorkspaces).toBe(1)
    expect(outcome.freedBytes).toBe(200)
    expect(outcome.failures).toEqual([{ path: broken.path, message: 'EBUSY' }])
    expect(h.warnings.some(warning => warning.includes('EBUSY'))).toBe(true)
  })

  it('leaves a workspace untouched when one of its routes cannot be retired', async () => {
    const broken = workspace('ou_broken_route')
    const healthy = workspace('ou_healthy_route')
    const h = harness()
    const deps: CleanupDeps = {
      ...h.deps,
      retireRoute: async (record) => {
        h.calls.push(`retire:${record.key}`)
        if (record.key === 'omt_broken') throw new Error('storage offline')
      },
    }
    const plan = planOf(
      candidate(broken, { routes: [route({ key: 'omt_broken', workspacePath: broken.path })] }),
      candidate(healthy, { routes: [route({ key: 'omt_healthy', workspacePath: healthy.path })] }),
    )
    const outcome = await applyWorkspaceCleanup(deps, plan)
    expect(h.calls).toEqual(['retire:omt_broken', 'retire:omt_healthy', `remove:${healthy.path}`])
    expect(outcome.deletedWorkspaces).toBe(1)
    expect(outcome.retiredRoutes).toBe(1)
    expect(outcome.failures).toEqual([{ path: broken.path, message: 'storage offline' }])
  })

  it('refuses hand-built candidates outside the base directory or at its root', async () => {
    const h = harness()
    const outside = workspace('ou_outside', { path: '/tmp/evil' })
    const baseItself = workspace('ou_base', { path: BASE_DIR })
    const plan = planOf(
      candidate(outside, { routes: [route({ key: 'omt_outside', workspacePath: outside.path })] }),
      candidate(baseItself),
    )
    const outcome = await applyWorkspaceCleanup(h.deps, plan)
    expect(h.calls).toEqual([])
    expect(outcome).toEqual({
      deletedWorkspaces: 0,
      retiredRoutes: 0,
      freedBytes: 0,
      failures: [
        { path: '/tmp/evil', message: 'refused: workspace path is outside the cleanup base directory' },
        { path: BASE_DIR, message: 'refused: workspace path is outside the cleanup base directory' },
      ],
    })
  })

  it('refuses every candidate when the base directory is a filesystem root', async () => {
    const h = harness()
    const deps: CleanupDeps = { ...h.deps, baseDir: '/' }
    const plan = planOf(candidate(workspace('ou_root', { path: '/p2p/ou_root' })))
    const outcome = await applyWorkspaceCleanup(deps, plan)
    expect(h.calls).toEqual([])
    expect(outcome.deletedWorkspaces).toBe(0)
    expect(outcome.failures).toHaveLength(1)
  })
})

describe('isPathInside', () => {
  it('accepts strictly nested paths', () => {
    expect(isPathInside(BASE_DIR, `${BASE_DIR}/p2p/ou_1`)).toBe(true)
    expect(isPathInside(BASE_DIR, `${BASE_DIR}/groups/oc_1/ou_1/attachments/a.txt`)).toBe(true)
  })

  it('rejects the base directory itself, name-prefix siblings, escapes, and outsiders', () => {
    expect(isPathInside(BASE_DIR, BASE_DIR)).toBe(false)
    expect(isPathInside(BASE_DIR, `${BASE_DIR}-other/p2p/ou_1`)).toBe(false)
    expect(isPathInside(BASE_DIR, `${BASE_DIR}/../evil`)).toBe(false)
    expect(isPathInside(BASE_DIR, '/tmp/evil')).toBe(false)
  })

  it('normalizes relative pairs against the same process cwd', () => {
    expect(isPathInside('./channels-data', 'channels-data/p2p/ou_1')).toBe(true)
    expect(isPathInside('./channels-data', './channels-data-other/p2p/ou_1')).toBe(false)
  })

  it('rejects empty and non-nested relative targets', () => {
    expect(isPathInside(BASE_DIR, '')).toBe(false)
    expect(isPathInside(BASE_DIR, 'child')).toBe(false)
  })
})
