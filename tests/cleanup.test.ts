import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceCleanup, isPathInside, planWorkspaceCleanup, retentionMs, WORKSPACE_RETENTION_VALUES,
} from '../src/cleanup.ts'
import type {
  CleanupCandidate, CleanupDeps, CleanupPlan, CleanupRoute, CleanupTarget, CleanupTombstone,
  CleanupWorkspace, ScannedSessionDir, WorkspaceStats,
} from '../src/cleanup.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_000 * DAY_MS
const BASE_DIR = '/srv/channels-data'
/** Legacy layout: one registered workspace per topic below `<baseDir>/topics/`. */
const LEGACY_WORKSPACE = `${BASE_DIR}/topics/groups/oc_1/ou_1/omt_old`
/** Durable user workspace; never a cleanup candidate. */
const USER_WORKSPACE = `${BASE_DIR}/p2p/ou_1`
/** Per-topic working directory of the current layout. */
const TOPIC_DIR = `${USER_WORKSPACE}/topics/omt_old`

function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  return value as T
}

function workspace(id: string, overrides: Partial<CleanupWorkspace> = {}): CleanupWorkspace {
  return { id, path: `${BASE_DIR}/topics/p2p/${id}`, title: `飞书私聊 · ${id}`, ...overrides }
}

function userWorkspace(id: string): CleanupWorkspace {
  return {
    id: `ws-user-${id}`,
    path: `${BASE_DIR}/p2p/${id}`,
    title: `飞书私聊 · ${id}`,
  }
}

function route(overrides: Partial<CleanupRoute> = {}): CleanupRoute {
  return {
    key: 'omt_1',
    kind: 'thread',
    workspacePath: USER_WORKSPACE,
    sessionId: 'session-1',
    lastActivityAt: NOW - 60 * DAY_MS,
    ...overrides,
  }
}

function stats(mtimeMs: number, bytes = 1024, files = 2): WorkspaceStats {
  return { mtimeMs, bytes, files }
}

interface HarnessOptions {
  workspaces?: readonly CleanupWorkspace[]
  sessionDirs?: readonly ScannedSessionDir[]
  routes?: readonly CleanupRoute[]
  tombstones?: readonly CleanupTombstone[]
  live?: readonly string[]
  stats?: (directory: string) => WorkspaceStats | undefined
  isLive?: (sessionId: string) => boolean
  now?: number
}

function harness(options: HarnessOptions = {}): {
  deps: CleanupDeps
  calls: string[]
  warnings: string[]
} {
  const calls: string[] = []
  const warnings: string[] = []
  const live = new Set(options.live ?? [])
  const deps: CleanupDeps = {
    baseDir: BASE_DIR,
    retention: '30d',
    listWorkspaces: () => options.workspaces ?? [],
    listSessionDirs: () => options.sessionDirs ?? [],
    activeRoutes: () => options.routes ?? [],
    tombstones: () => options.tombstones ?? [],
    isLive: options.isLive ?? (sessionId => live.has(sessionId)),
    statWorkspace: directory => options.stats === undefined ? stats(NOW) : options.stats(directory),
    removeWorkspace: async ws => { calls.push(`workspace:${ws.path}`) },
    removeSessionDir: async directory => { calls.push(`session-dir:${directory}`) },
    retireRoute: async activeRoute => { calls.push(`retire:${activeRoute.key}`) },
    now: () => options.now ?? NOW,
    warn: message => warnings.push(message),
  }
  return { deps, calls, warnings }
}

function candidateOf(target: CleanupTarget, overrides: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return {
    target,
    path: target.kind === 'workspace' ? target.workspace.path : target.path,
    activityAt: NOW - 60 * DAY_MS,
    bytes: 10,
    files: 1,
    routes: [],
    ...overrides,
  }
}

function workspaceCandidate(ws: CleanupWorkspace, overrides: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return candidateOf({ kind: 'workspace', workspace: ws }, overrides)
}

function planOf(...candidates: CleanupCandidate[]): CleanupPlan {
  const window = defined(retentionMs('30d'))
  return { retentionMs: window, cutoff: NOW - window, candidates, skippedLive: 0 }
}

describe('retention window', () => {
  it('maps every config value to its window and off to nothing', () => {
    expect(WORKSPACE_RETENTION_VALUES).toEqual(['off', '7d', '30d', '90d', '180d'])
    expect(retentionMs('off')).toBeUndefined()
    expect(retentionMs('7d')).toBe(7 * DAY_MS)
    expect(retentionMs('30d')).toBe(30 * DAY_MS)
    expect(retentionMs('90d')).toBe(90 * DAY_MS)
    expect(retentionMs('180d')).toBe(180 * DAY_MS)
  })
})

describe('cleanup planning', () => {
  it('returns undefined when retention is off, without touching any dependency', async () => {
    const h = harness()
    const deps: CleanupDeps = {
      ...h.deps,
      get retention() { return 'off' as const },
      listWorkspaces: () => { throw new Error('must not list workspaces') },
      listSessionDirs: () => { throw new Error('must not scan directories') },
      activeRoutes: () => { throw new Error('must not read routes') },
      tombstones: () => { throw new Error('must not read tombstones') },
    }
    await expect(planWorkspaceCleanup(deps)).resolves.toBeUndefined()
  })

  it('refuses a filesystem-root base directory', async () => {
    const h = harness()
    await expect(planWorkspaceCleanup({ ...h.deps, baseDir: '/' })).resolves.toBeUndefined()
    expect(h.warnings.join('\n')).toContain('filesystem root')
  })

  it('selects only stale legacy topic workspaces (never user workspaces)', async () => {
    const old = workspace('ou_old')
    const recent = workspace('ou_recent')
    const user = userWorkspace('ou_user')
    const h = harness({
      workspaces: [old, recent, user],
      stats: directory => stats(directory === recent.path ? NOW - DAY_MS : NOW - 60 * DAY_MS),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(candidate => candidate.path)).toEqual([old.path])
    expect(plan.candidates[0]?.target.kind).toBe('workspace')
    expect(plan.candidates[0]?.routes).toEqual([])
  })

  it('uses the newest route activity for a stale legacy workspace', async () => {
    const ws = workspace('ou_routed')
    const h = harness({
      workspaces: [ws],
      routes: [route({ key: 'omt_old', workspacePath: ws.path, lastActivityAt: NOW - 60 * DAY_MS })],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]?.activityAt).toBe(NOW - 60 * DAY_MS)
  })

  it('skips targets whose session is still live and counts them', async () => {
    const ws = workspace('ou_live')
    const h = harness({
      workspaces: [ws],
      routes: [route({ key: 'omt_live', workspacePath: ws.path })],
      live: ['session-1'],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
    expect(plan.skippedLive).toBe(1)
  })

  it('treats an unknown liveness result as live', async () => {
    const ws = workspace('ou_unknown')
    const h = harness({
      workspaces: [ws],
      routes: [route({ key: 'omt_unknown', workspacePath: ws.path })],
      isLive: () => { throw new Error('liveness unavailable') },
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
    expect(h.warnings.join('\n')).toContain('liveness')
  })

  it('attributes legacy tombstone activity when no active route remains', async () => {
    const eligible = workspace('ou_tomb_old')
    const kept = workspace('ou_tomb_new')
    const h = harness({
      workspaces: [eligible, kept],
      tombstones: [
        { key: 'omt_old', workspacePath: eligible.path, expiredAt: NOW - 40 * DAY_MS },
        { key: 'omt_new', workspacePath: kept.path, expiredAt: NOW - DAY_MS },
      ],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(candidate => candidate.path)).toEqual([eligible.path])
  })

  it('falls back to expiredAt for a tombstone without last activity', async () => {
    const ws = workspace('ou_tomb_expired')
    const h = harness({
      workspaces: [ws],
      tombstones: [{ key: 'omt_expired', workspacePath: ws.path, expiredAt: NOW - 40 * DAY_MS }],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toHaveLength(1)
  })

  it('cannot attribute legacy tombstones without a path and falls back to mtime', async () => {
    const ws = workspace('ou_legacy')
    const h = harness({
      workspaces: [ws],
      tombstones: [{ key: 'omt_legacy', expiredAt: NOW - 40 * DAY_MS }],
      stats: () => stats(NOW - 60 * DAY_MS),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]?.activityAt).toBe(NOW - 60 * DAY_MS)
  })

  it('never offers a workspace whose activity cannot be established', async () => {
    const h = harness({ workspaces: [workspace('ou_no_evidence')], stats: () => undefined })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
  })

  it('tolerates a throwing stat implementation', async () => {
    const h = harness({ workspaces: [workspace('ou_stat_throws')] })
    const deps: CleanupDeps = {
      ...h.deps,
      statWorkspace: () => { throw new Error('EACCES') },
    }
    await expect(planWorkspaceCleanup(deps)).resolves.toBeDefined()
    expect(h.warnings.join('\n')).toContain('stats unavailable')
  })

  it('plans a per-topic directory from route evidence and retires the route', async () => {
    const h = harness({ routes: [route({ sessionDir: TOPIC_DIR })] })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toHaveLength(1)
    const candidate = plan.candidates[0]!
    expect(candidate.target).toEqual({ kind: 'session-dir', path: TOPIC_DIR })
    expect(candidate.routes.map(entry => entry.key)).toEqual(['omt_1'])
  })

  it('skips a live Session topic directory', async () => {
    const h = harness({ routes: [route({ sessionDir: TOPIC_DIR })], live: ['session-1'] })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
    expect(plan.skippedLive).toBe(1)
  })

  it('plans orphan topic directories discovered on disk by their mtime', async () => {
    const h = harness({
      sessionDirs: [{ path: TOPIC_DIR, mtimeMs: NOW - 60 * DAY_MS }],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(candidate => candidate.path)).toEqual([TOPIC_DIR])
  })

  it('keeps a recently used orphan topic directory', async () => {
    const h = harness({ sessionDirs: [{ path: TOPIC_DIR, mtimeMs: NOW - DAY_MS }] })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
  })

  it('never treats a user workspace path as a topic directory', async () => {
    const h = harness({
      workspaces: [userWorkspace('ou_1')],
      sessionDirs: [{ path: USER_WORKSPACE, mtimeMs: NOW - 60 * DAY_MS }],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
  })

  it('does not resurrect a tombstoned topic dir that is already gone', async () => {
    const h = harness({
      tombstones: [{
        key: 'omt_gone', workspacePath: USER_WORKSPACE, sessionDir: TOPIC_DIR,
        expiredAt: NOW - 60 * DAY_MS,
      }],
      stats: directory => directory === TOPIC_DIR ? undefined : stats(NOW),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
  })

  it('cleans a tombstoned topic dir that still exists, using tombstone activity', async () => {
    const h = harness({
      tombstones: [{
        key: 'omt_still_there', workspacePath: USER_WORKSPACE, sessionDir: TOPIC_DIR,
        lastActivityAt: NOW - 50 * DAY_MS, expiredAt: NOW - 40 * DAY_MS,
      }],
      stats: () => stats(NOW - 3_650 * DAY_MS),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]?.activityAt).toBe(NOW - 50 * DAY_MS)
  })

  it('refuses directories outside baseDir or inside the legacy root', async () => {
    const h = harness({
      routes: [
        route({ sessionDir: '/etc/passwd' }),
        route({ key: 'omt_legacy_dir', sessionDir: LEGACY_WORKSPACE }),
      ],
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates).toEqual([])
  })

  it('sorts candidates oldest first and reports the budget', async () => {
    const older = workspace('ou_older')
    const newer = workspace('ou_newer')
    const h = harness({
      workspaces: [newer, older],
      stats: directory => stats(directory === older.path
        ? NOW - 90 * DAY_MS
        : NOW - 45 * DAY_MS),
    })
    const plan = defined(await planWorkspaceCleanup(h.deps))
    expect(plan.candidates.map(candidate => candidate.path)).toEqual([older.path, newer.path])
    expect(plan.retentionMs).toBe(30 * DAY_MS)
    expect(plan.cutoff).toBe(NOW - 30 * DAY_MS)
  })
})

describe('cleanup application', () => {
  it('retires routes, then removes a legacy workspace and its registry record', async () => {
    const ws = workspace('ou_old')
    const h = harness({ workspaces: [ws] })
    const outcome = await applyWorkspaceCleanup(h.deps, planOf(workspaceCandidate(ws, {
      routes: [route({ key: 'omt_ws', workspacePath: ws.path, sessionId: 'session-ws' })],
      bytes: 2048,
    })))
    expect(outcome.deletedWorkspaces).toBe(1)
    expect(outcome.deletedSessionDirs).toBe(0)
    expect(outcome.retiredRoutes).toBe(1)
    expect(outcome.freedBytes).toBe(2048)
    expect(outcome.failures).toEqual([])
    expect(h.calls).toEqual([
      'retire:omt_ws',
      `workspace:${ws.path}`,
    ])
  })

  it('removes a per-topic directory without unregistering any workspace', async () => {
    const h = harness({ workspaces: [userWorkspace('ou_1')] })
    const outcome = await applyWorkspaceCleanup(h.deps, planOf(candidateOf(
      { kind: 'session-dir', path: TOPIC_DIR },
      { bytes: 512, routes: [route({ sessionDir: TOPIC_DIR })] },
    )))
    expect(outcome.deletedWorkspaces).toBe(0)
    expect(outcome.deletedSessionDirs).toBe(1)
    expect(outcome.retiredRoutes).toBe(1)
    expect(outcome.freedBytes).toBe(512)
    expect(h.calls).toEqual(['retire:omt_1', `session-dir:${TOPIC_DIR}`])
  })

  it('refuses a session-dir target that is a registered workspace', async () => {
    const user = userWorkspace('ou_1')
    const h = harness({ workspaces: [user] })
    const outcome = await applyWorkspaceCleanup(h.deps, planOf(candidateOf(
      { kind: 'session-dir', path: user.path },
    )))
    expect(outcome.deletedSessionDirs).toBe(0)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]?.message).toContain('refused')
  })

  it('refuses paths outside baseDir and never trusts a stale plan', async () => {
    const h = harness({ workspaces: [workspace('ou_outside', { path: '/srv/outside/ws' })] })
    const plan = planOf(
      workspaceCandidate(workspace('ou_outside', { path: '/srv/outside/ws' })),
      candidateOf({ kind: 'session-dir', path: '/srv/outside/topic' }),
    )
    const outcome = await applyWorkspaceCleanup(h.deps, plan)
    expect(outcome.deletedWorkspaces).toBe(0)
    expect(outcome.deletedSessionDirs).toBe(0)
    expect(outcome.failures).toHaveLength(2)
    expect(h.calls).toEqual([])
  })

  it('keeps the directory when retiring a route fails', async () => {
    const ws = workspace('ou_retire_fail')
    const h = harness({ workspaces: [ws] })
    const deps: CleanupDeps = {
      ...h.deps,
      retireRoute: () => { throw new Error('retire failed') },
    }
    const outcome = await applyWorkspaceCleanup(deps, planOf(workspaceCandidate(ws, {
      routes: [route({ key: 'omt_fail', workspacePath: ws.path })],
    })))
    expect(outcome.deletedWorkspaces).toBe(0)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]?.message).toContain('retire failed')
    expect(h.calls).toEqual([])
    expect(h.warnings.join('\n')).toContain('cleanup failed')
  })

  it('continues with the remaining candidates after one failure', async () => {
    const broken = workspace('ou_broken')
    const healthy = workspace('ou_healthy')
    const h = harness({ workspaces: [broken, healthy] })
    const deps: CleanupDeps = {
      ...h.deps,
      removeWorkspace: async ws => {
        if (ws.path === broken.path) throw new Error('EBUSY')
        h.calls.push(`workspace:${ws.path}`)
      },
    }
    const outcome = await applyWorkspaceCleanup(deps, planOf(
      workspaceCandidate(broken, { routes: [route({ key: 'omt_broken', workspacePath: broken.path })] }),
      workspaceCandidate(healthy, { routes: [route({ key: 'omt_healthy', workspacePath: healthy.path })] }),
    ))
    expect(outcome.deletedWorkspaces).toBe(1)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]?.path).toBe(broken.path)
    expect(h.calls).toContain(`workspace:${healthy.path}`)
  })
})

describe('path containment', () => {
  it('never treats baseDir itself or a sibling prefix as inside', () => {
    expect(isPathInside(BASE_DIR, `${BASE_DIR}/p2p/ou_1`)).toBe(true)
    expect(isPathInside(BASE_DIR, BASE_DIR)).toBe(false)
    expect(isPathInside(BASE_DIR, `${BASE_DIR}/../outside`)).toBe(false)
    expect(isPathInside(BASE_DIR, `${BASE_DIR}-other/p2p/ou_1`)).toBe(false)
    expect(isPathInside('./channels-data', 'channels-data/p2p/ou_1')).toBe(true)
    expect(isPathInside('./channels-data', './channels-data-other/p2p/ou_1')).toBe(false)
  })
})
