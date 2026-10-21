/**
 * Retention cleanup policy: pure planning and application over injected seams.
 *
 * Conversations produce files below two kinds of directories the host never
 * removes on its own:
 *
 * 1. **Per-topic session directories** (current layout): the effective working
 *    directory of one Feishu topic — `<user-workspace>/topics/<token>` or a Git
 *    worktree checkout. They are not registered workspaces, so their activity
 *    comes from route records/tombstones or from the directory's own `mtime`.
 * 2. **Legacy one-workspace-per-topic directories** written by older plugin
 *    versions (`<baseDir>/topics/...`). Those are still registered host
 *    workspaces and are unregistered when removed.
 *
 * User workspaces themselves (the durable project each user/chat is grouped
 * under) are never candidates. This module owns no I/O: every filesystem and
 * registry effect is injected through `CleanupDeps`, so the policy stays small
 * and testable while the dangerous half (recursive deletion + registry
 * unregistration) stays in the caller.
 *
 * Activity precedence:
 *
 * 1. the newest `lastActivityAt` among the active routes bound to the target;
 *    a target with a live Session is never offered for deletion,
 * 2. otherwise the newest tombstone that names it,
 * 3. otherwise the directory's own `mtime` (an orphan directory).
 *
 * A directory with no usable activity evidence at all (missing/unreadable) is
 * never offered for deletion: irreversible removal requires positive evidence.
 *
 * Scope boundary (attachment_pipeline_v2, decisions D6/D12): cleanup only
 * removes workspace / Agent-artifact directories. Inbound attachments are not
 * workspace files — the native backend keeps them in the DSH attachment
 * library, and the legacy `_staging` adoption area is explicitly excluded so a
 * pending one-time adoption can never be destroyed by a retention sweep.
 *
 * @module dsh-channels/cleanup
 */

import path from 'node:path'
import { legacyTopicWorkspaceRoot, stagingRoot } from './workspaces.ts'

/** Values the `workspaceRetention` config accepts. `off` disables cleanup. */
export const WORKSPACE_RETENTION_VALUES = ['off', '7d', '30d', '90d', '180d'] as const

/** One workspace-retention setting. */
export type WorkspaceRetention = (typeof WORKSPACE_RETENTION_VALUES)[number]

const DAY_MS = 24 * 60 * 60 * 1000

/** Days represented by every non-`off` retention value. */
const RETENTION_DAYS: Readonly<Record<Exclude<WorkspaceRetention, 'off'>, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '180d': 180,
}

/**
 * Convert a retention setting to its window in milliseconds.
 *
 * @param value - configured retention value.
 * @returns the window in milliseconds, or `undefined` when cleanup is off.
 */
export function retentionMs(value: WorkspaceRetention): number | undefined {
  return value === 'off' ? undefined : RETENTION_DAYS[value] * DAY_MS
}

/** Title prefixes `workspaces.ts` gives plugin-created workspaces. */
const PLUGIN_TITLE_PREFIXES = ['飞书私聊 ·', '飞书群聊 ·'] as const

/**
 * Whether a title was produced by this plugin (as opposed to a project the
 * operator registered by hand). Cleanup only ever touches plugin workspaces.
 */
function pluginWorkspaceTitle(title: string): boolean {
  return PLUGIN_TITLE_PREFIXES.some(prefix => title.startsWith(prefix))
}

/**
 * Whether `target` is strictly below `baseDir`.
 *
 * Both sides are normalized lexically (`path.resolve`), so a `..` segment or a
 * relative value cannot escape `baseDir`; the base directory itself and
 * siblings sharing a name prefix (e.g. `base-other`) are not "inside". The
 * check is lexical on purpose: this module owns no I/O. The caller's
 * `removeWorkspace` / `removeSessionDir` must still refuse symlinked escapes
 * with a realpath check before deleting.
 *
 * @param baseDir - directory the target must stay below.
 * @param target - candidate path.
 * @returns `true` when `target` is strictly inside `baseDir`.
 */
export function isPathInside(baseDir: string, target: string): boolean {
  const base = path.resolve(baseDir)
  const resolved = path.resolve(target)
  if (base === resolved) return false
  const relative = path.relative(base, resolved)
  if (relative === '' || path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/** Filesystem facts the caller measures for one candidate directory. */
export interface WorkspaceStats {
  /** Directory mtime in epoch ms — the activity fallback for orphan directories. */
  mtimeMs: number
  /** Total regular-file bytes below the directory. */
  bytes: number
  /** Regular-file count below the directory. */
  files: number
}

/** One registered host workspace (structurally `Workspace`). */
export interface CleanupWorkspace {
  /** Host workspace-registry id (needed to unregister the record). */
  readonly id: string
  /** Workspace directory. */
  readonly path: string
  /** Host display title; plugin-created workspaces use the `飞书…` prefixes. */
  readonly title: string
}

/** One active route record, reduced to the facts cleanup needs. */
export interface CleanupRoute {
  /** Route key (thread_id or `chat:<chatId>`). */
  readonly key: string
  /** `thread` for a real Feishu topic, `chat` for a degraded chat route. */
  readonly kind: 'thread' | 'chat'
  /** Workspace root this route's Session belongs to. */
  readonly workspacePath: string
  /** Effective working directory (topic dir / worktree); the workspace path on legacy routes. */
  readonly sessionDir?: string
  /** DSH session the route points at. */
  readonly sessionId: string
  /** Epoch ms of the last activity routed through the record. */
  readonly lastActivityAt: number
}

/**
 * One retired-route tombstone.
 *
 * Older plugin versions stored only route identity, so `workspacePath`,
 * `sessionDir`, and `lastActivityAt` stay optional and legacy tombstones
 * remain parseable.
 */
export interface CleanupTombstone {
  /** Route key the tombstone replaced. */
  readonly key: string
  /** Workspace the retired route belonged to; absent in legacy tombstones. */
  readonly workspacePath?: string
  /** Effective working directory of the retired route; absent in legacy tombstones. */
  readonly sessionDir?: string
  /** Epoch ms when the route was retired. */
  readonly expiredAt: number
  /** Epoch ms of the last activity before retirement; absent in legacy tombstones. */
  readonly lastActivityAt?: number
}

/**
 * One per-topic directory discovered on disk below a live user workspace.
 * Supplies the age evidence for directories whose route records are gone.
 */
export interface ScannedSessionDir {
  /** Absolute directory path. */
  readonly path: string
  /** Directory mtime in epoch ms. */
  readonly mtimeMs: number
}

/** A dependency seam that may be sync (registry tables) or async (filesystem). */
export type MaybePromise<T> = T | Promise<T>

/** What one cleanup candidate removes. */
export type CleanupTarget =
  | { readonly kind: 'workspace'; readonly workspace: CleanupWorkspace }
  | { readonly kind: 'session-dir'; readonly path: string }

/**
 * Every effect cleanup needs, injected so this module stays I/O-free.
 *
 * The service supplies the real implementations: the workspace registry for
 * `listWorkspaces`/`removeWorkspace`, the routing tables for
 * `activeRoutes`/`tombstones`, a scan of the live user workspaces for
 * `listSessionDirs`, the live-agent set for `isLive`, and filesystem walks for
 * `statWorkspace` plus the two removal operations.
 */
export interface CleanupDeps {
  /** Workspace root the plugin owns; candidates must be strictly inside it. */
  readonly baseDir: string
  /** Retention value from config (`off` disables planning). */
  readonly retention: WorkspaceRetention
  /** Every workspace currently registered with the host. */
  listWorkspaces(): MaybePromise<readonly CleanupWorkspace[]>
  /** Per-topic directories discovered below the live user workspaces. */
  listSessionDirs(): MaybePromise<readonly ScannedSessionDir[]>
  /** Every active route record. */
  activeRoutes(): MaybePromise<readonly CleanupRoute[]>
  /** Every retired-route tombstone. */
  tombstones(): MaybePromise<readonly CleanupTombstone[]>
  /** Whether a DSH session is still live; targets with live sessions are never offered. */
  isLive(sessionId: string): boolean
  /** Measure one directory; `undefined` when it cannot be read (missing, permission). */
  statWorkspace(directory: string): MaybePromise<WorkspaceStats | undefined>
  /** Delete one legacy workspace directory and unregister its registry record. */
  removeWorkspace(workspace: CleanupWorkspace): MaybePromise<void>
  /** Delete one per-topic session directory (no registry record exists). */
  removeSessionDir(directory: string): MaybePromise<void>
  /** Retire one active route into a tombstone (same bookkeeping as route TTL). */
  retireRoute(route: CleanupRoute): MaybePromise<void>
  /** Clock seam; defaults to `Date.now()`. */
  now?(): number
  /** Warning seam for best-effort failures; defaults to silence. */
  warn?(message: string): void
}

/** One directory old enough to delete, with its measured footprint. */
export interface CleanupCandidate {
  /** What gets removed and how. */
  readonly target: CleanupTarget
  /** Directory path (also the unit of failure). */
  readonly path: string
  /** Newest activity observed for the target (epoch ms). */
  readonly activityAt: number
  /** Regular-file bytes below the directory (0 when unreadable). */
  readonly bytes: number
  /** Regular-file count below the directory (0 when unreadable). */
  readonly files: number
  /** Active routes this candidate's directory owns (retired before removal). */
  readonly routes: readonly CleanupRoute[]
}

/** Result of one planning pass; nothing has been deleted yet. */
export interface CleanupPlan {
  /** Configured retention window in milliseconds. */
  readonly retentionMs: number
  /** Epoch ms cutoff: activity older than this is stale. */
  readonly cutoff: number
  /** Deletable candidates, oldest first. */
  readonly candidates: readonly CleanupCandidate[]
  /** Targets skipped because a Session using them is still live. */
  readonly skippedLive: number
}

/** One failed removal (the run continues with the remaining candidates). */
export interface CleanupFailure {
  /** Directory that could not be removed. */
  readonly path: string
  /** Human-readable reason. */
  readonly message: string
}

/** Aggregate outcome of one apply pass. */
export interface CleanupOutcome {
  /** Legacy registered workspaces whose directory and record were removed. */
  readonly deletedWorkspaces: number
  /** Per-topic session directories removed. */
  readonly deletedSessionDirs: number
  /** Active routes retired into tombstones. */
  readonly retiredRoutes: number
  /** Regular-file bytes reclaimed (measured before deletion). */
  readonly freedBytes: number
  /** Per-candidate failures; a failing candidate does not abort the run. */
  readonly failures: readonly CleanupFailure[]
}

// ---- planning -----------------------------------------------------------

/** Lexically compare two paths (both resolved) without touching the disk. */
function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

/** Whether a path is a filesystem root (never deletable). */
function isFilesystemRoot(target: string): boolean {
  const resolved = path.resolve(target)
  return path.parse(resolved).root === resolved
}

/** Newest value of a list, or `undefined` when empty. */
function newestActivity(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values)
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

async function readWorkspaceStats(
  deps: CleanupDeps,
  directory: string,
): Promise<WorkspaceStats | undefined> {
  try {
    return await deps.statWorkspace(directory)
  } catch (error) {
    deps.warn?.(`dsh-channels: cleanup stats unavailable for ${directory}: ${String(error)}`)
    return undefined
  }
}

function sessionIsLive(deps: CleanupDeps, sessionId: string): boolean {
  try {
    return deps.isLive(sessionId)
  } catch (error) {
    deps.warn?.(`dsh-channels: cleanup liveness probe failed for ${sessionId}: ${String(error)}`)
    return true
  }
}

function routesAreLive(deps: CleanupDeps, routes: readonly CleanupRoute[]): boolean {
  return routes.some(route => sessionIsLive(deps, route.sessionId))
}

/** Effective directory of one route (workspace path on legacy routes). */
function directoryOfRoute(route: CleanupRoute): string {
  return route.sessionDir ?? route.workspacePath
}

/**
 * Decide which directories are stale, without deleting anything.
 *
 * Only plugin-created targets strictly below `baseDir` are considered. User
 * workspaces are never candidates; legacy one-workspace-per-topic directories
 * are candidates only below `<baseDir>/topics/`.
 *
 * @param deps - injected effect seams (nothing is deleted here).
 * @returns the plan, or `undefined` when retention is off or the base
 * directory is unusable (filesystem root).
 */
export async function planWorkspaceCleanup(deps: CleanupDeps): Promise<CleanupPlan | undefined> {
  const window = retentionMs(deps.retention)
  if (window === undefined) return undefined

  const baseDir = path.resolve(deps.baseDir)
  if (isFilesystemRoot(baseDir)) {
    deps.warn?.('dsh-channels: retention cleanup disabled: baseDir is a filesystem root')
    return undefined
  }
  const legacyRoot = legacyTopicWorkspaceRoot(baseDir)
  const stagingDir = stagingRoot(baseDir)

  const now = deps.now?.() ?? Date.now()
  const cutoff = now - window
  const activeRoutes = await deps.activeRoutes()
  const tombstones = await deps.tombstones()
  const workspaces = await deps.listWorkspaces()
  const candidates: CleanupCandidate[] = []
  let skippedLive = 0

  // Paths of workspaces that are durable user projects (never deletable).
  const userWorkspacePaths = new Set<string>()
  for (const workspace of workspaces) {
    const resolved = path.resolve(workspace.path)
    if (!pluginWorkspaceTitle(workspace.title)) continue
    if (!isPathInside(baseDir, resolved)) continue
    if (isPathInside(legacyRoot, resolved)) continue
    userWorkspacePaths.add(resolved)
  }

  // 1) Legacy one-workspace-per-topic directories.
  for (const workspace of workspaces) {
    if (!pluginWorkspaceTitle(workspace.title)) continue
    const targetPath = path.resolve(workspace.path)
    if (!isPathInside(baseDir, targetPath)) continue
    if (!isPathInside(legacyRoot, targetPath)) continue

    const routes = activeRoutes.filter(route =>
      samePath(route.workspacePath, targetPath)
      && (route.sessionDir === undefined || samePath(route.sessionDir, targetPath)))
    if (routesAreLive(deps, routes)) {
      skippedLive++
      continue
    }
    let stats: WorkspaceStats | undefined
    let activityAt = newestActivity(routes.map(route => route.lastActivityAt))
    if (activityAt === undefined) {
      activityAt = newestActivity(
        tombstones
          .filter(tombstone => tombstone.workspacePath !== undefined
            && samePath(tombstone.workspacePath, targetPath)
            && (tombstone.sessionDir === undefined || samePath(tombstone.sessionDir, targetPath)))
          .map(tombstone => tombstone.lastActivityAt ?? tombstone.expiredAt),
      )
    }
    if (activityAt === undefined) {
      // Orphan workspace: the directory's own mtime is the only age evidence.
      stats = await readWorkspaceStats(deps, targetPath)
      activityAt = stats !== undefined && Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined
    }
    if (activityAt === undefined || activityAt >= cutoff) continue
    stats ??= await readWorkspaceStats(deps, targetPath)
    candidates.push({
      target: { kind: 'workspace', workspace },
      path: workspace.path,
      activityAt,
      bytes: stats === undefined ? 0 : nonNegative(stats.bytes),
      files: stats === undefined ? 0 : nonNegative(stats.files),
      routes,
    })
  }

  // 2) Per-topic session directories of the current layout: union of route
  //    records, tombstones, and directories discovered on disk.
  interface DirEvidence {
    routes: CleanupRoute[]
    tombstoneActivity: number[]
    mtimeMs?: number
  }
  const dirs = new Map<string, DirEvidence>()
  const evidenceFor = (directory: string): DirEvidence => {
    const key = path.resolve(directory)
    let evidence = dirs.get(key)
    if (evidence === undefined) {
      evidence = { routes: [], tombstoneActivity: [] }
      dirs.set(key, evidence)
    }
    return evidence
  }
  /** Whether a directory is a plausible per-topic dir (never a workspace root). */
  const acceptable = (directory: string): boolean => {
    const resolved = path.resolve(directory)
    if (isFilesystemRoot(resolved)) return false
    if (!isPathInside(baseDir, resolved)) return false
    if (resolved === legacyRoot || isPathInside(legacyRoot, resolved)) return false
    // Legacy pre-topic staging (one-time adoption area): never a cleanup target.
    if (resolved === stagingDir || isPathInside(stagingDir, resolved)) return false
    if (userWorkspacePaths.has(resolved)) return false
    return true
  }
  for (const route of activeRoutes) {
    if (route.sessionDir === undefined || samePath(route.sessionDir, route.workspacePath)) continue
    if (!acceptable(route.sessionDir)) continue
    evidenceFor(route.sessionDir).routes.push(route)
  }
  for (const tombstone of tombstones) {
    if (tombstone.sessionDir === undefined) continue
    if (tombstone.workspacePath !== undefined && samePath(tombstone.sessionDir, tombstone.workspacePath)) continue
    if (!acceptable(tombstone.sessionDir)) continue
    evidenceFor(tombstone.sessionDir).tombstoneActivity.push(
      tombstone.lastActivityAt ?? tombstone.expiredAt,
    )
  }
  for (const scanned of await deps.listSessionDirs()) {
    if (!acceptable(scanned.path)) continue
    evidenceFor(scanned.path).mtimeMs = scanned.mtimeMs
  }

  for (const [directory, evidence] of dirs) {
    if (routesAreLive(deps, evidence.routes)) {
      skippedLive++
      continue
    }
    let activityAt = newestActivity(evidence.routes.map(route => route.lastActivityAt))
    activityAt ??= newestActivity(evidence.tombstoneActivity)
    activityAt ??= evidence.mtimeMs
    if (activityAt === undefined || activityAt >= cutoff) continue
    const stats = await readWorkspaceStats(deps, directory)
    // Nothing left on disk and no active route to retire: nothing to do.
    if (stats === undefined && evidence.routes.length === 0) continue
    candidates.push({
      target: { kind: 'session-dir', path: directory },
      path: directory,
      activityAt,
      bytes: stats === undefined ? 0 : nonNegative(stats.bytes),
      files: stats === undefined ? 0 : nonNegative(stats.files),
      routes: evidence.routes,
    })
  }

  candidates.sort((left, right) =>
    left.activityAt - right.activityAt || left.path.localeCompare(right.path))
  return { retentionMs: window, cutoff, candidates, skippedLive }
}

// ---- application --------------------------------------------------------

/**
 * Apply a plan: retire the candidate's active routes, then remove its
 * directory (and, for legacy workspaces, the registry record).
 *
 * A candidate is the unit of failure: if retiring any of its routes fails, the
 * directory is left untouched (route bookkeeping must not point at a deleted
 * directory), the failure is collected, and the remaining candidates are still
 * processed. Paths are revalidated immediately before the destructive step, so
 * a stale or hand-built plan can never delete `baseDir` itself, a user
 * workspace, or something outside `baseDir`.
 *
 * @param deps - injected effect seams.
 * @param plan - plan produced by `planWorkspaceCleanup` (or an equivalent preview).
 * @returns aggregate counts plus per-target failures.
 */
export async function applyWorkspaceCleanup(
  deps: CleanupDeps,
  plan: CleanupPlan,
): Promise<CleanupOutcome> {
  const baseDir = path.resolve(deps.baseDir)
  const baseDirIsRoot = isFilesystemRoot(baseDir)
  const legacyRoot = legacyTopicWorkspaceRoot(baseDir)
  const stagingDir = stagingRoot(baseDir)
  const registered = new Set(
    (await deps.listWorkspaces())
      .filter(workspace => pluginWorkspaceTitle(workspace.title))
      .map(workspace => path.resolve(workspace.path)),
  )
  const failures: CleanupFailure[] = []
  let deletedWorkspaces = 0
  let deletedSessionDirs = 0
  let retiredRoutes = 0
  let freedBytes = 0

  for (const candidate of plan.candidates) {
    const target = candidate.target
    const targetPath = candidate.path
    // Defense in depth: never trust a plan object for the destructive step.
    const insideBase = !baseDirIsRoot && isPathInside(baseDir, targetPath)
    const inLegacyRoot = isPathInside(legacyRoot, targetPath)
    const inStaging = isPathInside(stagingDir, targetPath)
    const valid = target.kind === 'workspace'
      ? insideBase && inLegacyRoot
      : insideBase && !inLegacyRoot && !inStaging && !registered.has(path.resolve(targetPath))
    if (!valid) {
      failures.push({ path: targetPath, message: 'refused: path is not a cleanable plugin directory' })
      continue
    }
    try {
      for (const route of candidate.routes) {
        if (!samePath(directoryOfRoute(route), targetPath)) continue
        await deps.retireRoute(route)
        retiredRoutes++
      }
      if (target.kind === 'workspace') {
        await deps.removeWorkspace(target.workspace)
        deletedWorkspaces++
      } else {
        await deps.removeSessionDir(targetPath)
        deletedSessionDirs++
      }
      freedBytes += nonNegative(candidate.bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ path: targetPath, message })
      deps.warn?.(`dsh-channels: cleanup failed for ${targetPath}: ${message}`)
    }
  }

  return { deletedWorkspaces, deletedSessionDirs, retiredRoutes, freedBytes, failures }
}
