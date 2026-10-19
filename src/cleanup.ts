/**
 * Stale workspace cleanup: pure planning and application policy.
 *
 * The plugin creates one host workspace per (user × chat) pair below its
 * configured `baseDir` (see `workspaces.ts`). The host never removes those
 * directories on its own, so a long-running deployment slowly accumulates
 * attachments and agent output for conversations nobody uses anymore. This
 * module decides which plugin-created workspaces are stale and applies the
 * removal while deliberately owning no I/O: every filesystem and registry
 * effect is injected through `CleanupDeps`, which keeps the policy small and
 * testable and keeps the dangerous half (recursive deletion + registry
 * unregistration) in the caller.
 *
 * Activity precedence for one workspace:
 *
 * 1. the newest `lastActivityAt` among its active routes; a workspace with a
 *    live session is never offered for deletion,
 * 2. otherwise the newest tombstone that names the workspace
 *    (`lastActivityAt`, falling back to `expiredAt` for tombstones written
 *    before routes recorded their workspace path),
 * 3. otherwise the directory's own `mtime` (an orphan workspace).
 *
 * Tombstones written before this feature carry neither `workspacePath` nor
 * `lastActivityAt`, so they cannot be attributed to a workspace; such a
 * workspace falls through to the `mtime` rule instead. A workspace with no
 * usable activity evidence at all (missing or unreadable directory) is never
 * offered for deletion: irreversible removal requires positive evidence.
 *
 * @module dsh-channels/cleanup
 */

import path from 'node:path'

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
 * Whether `target` is strictly below `baseDir`.
 *
 * Both sides are normalized lexically (`path.resolve`), so a `..` segment or a
 * relative value cannot escape `baseDir`; the base directory itself and
 * siblings sharing a name prefix (e.g. `base-other`) are not "inside". The
 * check is lexical on purpose: this module owns no I/O. The caller's
 * `removeWorkspace` should still refuse symlinked escapes with a realpath
 * check before deleting.
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

/** Filesystem facts the caller measures for one workspace candidate. */
export interface WorkspaceStats {
  /** Directory mtime in epoch ms — the activity fallback for orphan workspaces. */
  mtimeMs: number
  /** Total regular-file bytes below the directory. */
  bytes: number
  /** Regular-file count below the directory. */
  files: number
}

/** Minimal workspace shape passed around by plan/apply (structurally `Workspace`). */
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
  /** Workspace directory this route's session works in. */
  readonly workspacePath: string
  /** DSH session the route points at. */
  readonly sessionId: string
  /** Epoch ms of the last activity routed through the record. */
  readonly lastActivityAt: number
}

/**
 * One retired-route tombstone.
 *
 * Older plugin versions stored only route identity, so `workspacePath` and
 * `lastActivityAt` stay optional and legacy tombstones remain parseable.
 */
export interface CleanupTombstone {
  /** Route key the tombstone replaced. */
  readonly key: string
  /** Workspace the retired route belonged to; absent in legacy tombstones. */
  readonly workspacePath?: string
  /** Epoch ms when the route was retired. */
  readonly expiredAt: number
  /** Epoch ms of the last activity before retirement; absent in legacy tombstones. */
  readonly lastActivityAt?: number
}

/** A dependency seam that may be sync (registry tables) or async (filesystem). */
export type MaybePromise<T> = T | Promise<T>

/**
 * Every effect cleanup needs, injected so this module stays I/O-free.
 *
 * The service supplies the real implementations: the workspace registry for
 * `listWorkspaces`/`removeWorkspace`, the routing tables for
 * `activeRoutes`/`tombstones`, the live-agent set for `isLive`, and a
 * filesystem walk for `statWorkspace`.
 */
export interface CleanupDeps {
  /** Workspace root the plugin owns; candidates must be strictly inside it. */
  readonly baseDir: string
  /** Retention value from config (`off` disables planning). */
  readonly retention: WorkspaceRetention
  /** Every workspace currently registered with the host. */
  listWorkspaces(): MaybePromise<readonly CleanupWorkspace[]>
  /** Every active route record. */
  activeRoutes(): MaybePromise<readonly CleanupRoute[]>
  /** Every retired-route tombstone. */
  tombstones(): MaybePromise<readonly CleanupTombstone[]>
  /** Whether a DSH session is still live; live workspaces are never offered. */
  isLive(sessionId: string): boolean
  /** Measure one directory; `undefined` when it cannot be read (missing, permission). */
  statWorkspace(workspacePath: string): MaybePromise<WorkspaceStats | undefined>
  /** Delete one workspace directory and unregister its registry record. */
  removeWorkspace(workspace: CleanupWorkspace): MaybePromise<void>
  /** Retire one active route into a tombstone (same bookkeeping as route TTL). */
  retireRoute(route: CleanupRoute): MaybePromise<void>
  /** Clock seam; defaults to `Date.now()`. */
  now?(): number
  /** Warning seam for best-effort failures; defaults to silence. */
  warn?(message: string): void
}

/** One workspace old enough to delete, with its measured footprint. */
export interface CleanupCandidate {
  /** Workspace to delete. */
  readonly workspace: CleanupWorkspace
  /** Newest activity observed for the workspace (epoch ms). */
  readonly activityAt: number
  /** Regular-file bytes below the directory (0 when unreadable). */
  readonly bytes: number
  /** Regular-file count below the directory (0 when unreadable). */
  readonly files: number
  /** Active routes still pointing at the workspace; retired before removal. */
  readonly routes: readonly CleanupRoute[]
}

/** Result of one dry-run planning pass. */
export interface CleanupPlan {
  /** Retention window used for this plan, in milliseconds. */
  readonly retentionMs: number
  /** Activity cutoff (epoch ms); workspaces at or after it were kept. */
  readonly cutoff: number
  /** Eligible workspaces, oldest activity first. */
  readonly candidates: readonly CleanupCandidate[]
  /** Plugin workspaces kept because a live session still uses them. */
  readonly skippedLive: number
}

/** One failed removal; the pass continues with the remaining candidates. */
export interface CleanupFailure {
  /** Workspace directory the failure belongs to. */
  readonly path: string
  /** Human-readable reason. */
  readonly message: string
}

/** Result of one apply pass. */
export interface CleanupOutcome {
  /** Workspaces whose directory was removed and registry record deleted. */
  readonly deletedWorkspaces: number
  /** Active routes retired before their workspace was removed. */
  readonly retiredRoutes: number
  /** Measured bytes of the deleted workspaces. */
  readonly freedBytes: number
  /** Per-workspace failures; other candidates were still processed. */
  readonly failures: readonly CleanupFailure[]
}

/** Whether a host workspace title marks the workspace as plugin-created. */
function pluginWorkspaceTitle(title: string): boolean {
  return PLUGIN_TITLE_PREFIXES.some(prefix => title.startsWith(prefix))
}

/** Lexical path equality (both sides resolved the same way as `isPathInside`). */
function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

/** Newest finite timestamp of a list, or `undefined` when none is usable. */
function newestActivity(values: readonly number[]): number | undefined {
  let newest: number | undefined
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (newest === undefined || value > newest) newest = value
  }
  return newest
}

/** Count/byte values never go negative or non-finite on the outcome path. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Best-effort error text (never a stack trace). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A filesystem root must never become the cleanup base directory. */
function isFilesystemRoot(dir: string): boolean {
  return path.parse(dir).root === dir
}

/** Liveness probe that fails safe: an unknowable session counts as live. */
function sessionIsLive(deps: CleanupDeps, sessionId: string): boolean {
  try {
    return deps.isLive(sessionId)
  } catch (error) {
    deps.warn?.(`dsh-channels: workspace cleanup liveness check failed for ${sessionId}: ${errorMessage(error)}`)
    return true
  }
}

/** Measure one directory, tolerating a throwing or absent implementation. */
async function readWorkspaceStats(
  deps: CleanupDeps,
  workspacePath: string,
): Promise<WorkspaceStats | undefined> {
  try {
    return await deps.statWorkspace(workspacePath)
  } catch (error) {
    deps.warn?.(`dsh-channels: workspace stats unavailable for ${workspacePath}: ${errorMessage(error)}`)
    return undefined
  }
}

/**
 * Build the dry-run cleanup plan for the configured retention window.
 *
 * Only plugin-created workspaces (`飞书私聊 ·` / `飞书群聊 ·` titles) strictly
 * below `baseDir` are considered. A workspace is a candidate when its newest
 * activity is older than the cutoff; its footprint is measured for the panel
 * preview and for `freedBytes` reporting.
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
    deps.warn?.('dsh-channels: workspace cleanup disabled: baseDir is a filesystem root')
    return undefined
  }

  const now = deps.now?.() ?? Date.now()
  const cutoff = now - window
  const activeRoutes = await deps.activeRoutes()
  const tombstones = await deps.tombstones()
  const candidates: CleanupCandidate[] = []
  let skippedLive = 0

  for (const workspace of await deps.listWorkspaces()) {
    if (!pluginWorkspaceTitle(workspace.title)) continue
    if (!isPathInside(baseDir, workspace.path)) continue

    const routes = activeRoutes.filter(route => samePath(route.workspacePath, workspace.path))
    if (routes.some(route => sessionIsLive(deps, route.sessionId))) {
      skippedLive++
      continue
    }

    let stats: WorkspaceStats | undefined
    let activityAt = newestActivity(routes.map(route => route.lastActivityAt))
    if (activityAt === undefined) {
      activityAt = newestActivity(
        tombstones
          .filter(tombstone => tombstone.workspacePath !== undefined
            && samePath(tombstone.workspacePath, workspace.path))
          .map(tombstone => tombstone.lastActivityAt ?? tombstone.expiredAt),
      )
    }
    if (activityAt === undefined) {
      // Orphan workspace: the directory's own mtime is the only age evidence.
      stats = await readWorkspaceStats(deps, workspace.path)
      activityAt = stats !== undefined && Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined
    }
    if (activityAt === undefined || activityAt >= cutoff) continue

    stats ??= await readWorkspaceStats(deps, workspace.path)
    candidates.push({
      workspace,
      activityAt,
      bytes: stats === undefined ? 0 : nonNegative(stats.bytes),
      files: stats === undefined ? 0 : nonNegative(stats.files),
      routes,
    })
  }

  candidates.sort((left, right) =>
    left.activityAt - right.activityAt || left.workspace.path.localeCompare(right.workspace.path))
  return { retentionMs: window, cutoff, candidates, skippedLive }
}

/**
 * Apply a plan: retire the candidate's active routes, then remove the
 * workspace directory and its registry record.
 *
 * A candidate is the unit of failure: if retiring any of its routes fails, the
 * workspace is left untouched (route bookkeeping must not point at a deleted
 * directory), the failure is collected, and the remaining candidates are still
 * processed. Paths are revalidated immediately before the destructive step, so
 * a stale or hand-built plan can never delete something outside `baseDir` (or
 * `baseDir` itself).
 *
 * @param deps - injected effect seams.
 * @param plan - plan produced by `planWorkspaceCleanup` (or an equivalent preview).
 * @returns aggregate counts plus per-workspace failures.
 */
export async function applyWorkspaceCleanup(
  deps: CleanupDeps,
  plan: CleanupPlan,
): Promise<CleanupOutcome> {
  const baseDir = path.resolve(deps.baseDir)
  const baseDirIsRoot = isFilesystemRoot(baseDir)
  const failures: CleanupFailure[] = []
  let deletedWorkspaces = 0
  let retiredRoutes = 0
  let freedBytes = 0

  for (const candidate of plan.candidates) {
    const target = candidate.workspace.path
    // Defense in depth: never trust a plan object for the destructive step.
    if (baseDirIsRoot || !isPathInside(baseDir, target)) {
      failures.push({ path: target, message: 'refused: workspace path is outside the cleanup base directory' })
      continue
    }
    try {
      for (const route of candidate.routes) {
        if (!samePath(route.workspacePath, target)) continue
        await deps.retireRoute(route)
        retiredRoutes++
      }
      await deps.removeWorkspace(candidate.workspace)
      deletedWorkspaces++
      freedBytes += nonNegative(candidate.bytes)
    } catch (error) {
      const message = errorMessage(error)
      failures.push({ path: target, message })
      deps.warn?.(`dsh-channels: workspace cleanup failed for ${target}: ${message}`)
    }
  }

  return { deletedWorkspaces, retiredRoutes, freedBytes, failures }
}
