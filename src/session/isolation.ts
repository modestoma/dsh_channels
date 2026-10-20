/**
 * Per-topic Session placement: which directory each Feishu conversation works
 * in, without growing the host workspace list with every topic.
 *
 * A Session's **header cwd** is fixed at creation and decides two things:
 * its workspace-registry membership (the GUI project it is grouped under) and
 * the sandbox write boundary. The **effective working directory** is a mutable
 * Session projection (`ctx.workingDirectory`), persisted in the Session log
 * and restored on resume; the bash/fs/terminal tools resolve it before every
 * call.
 *
 * This module plans one topic's placement:
 *
 * - `subdir`: `<workspace>/topics/<token>` — a plain directory switched to via
 *   `workingDirectory.set`.
 * - `worktree`: a Git worktree created through `ctx.worktrees` (branch
 *   `feishu-<token>`), used when the workspace is a Git repository or when the
 *   deployment forces it.
 *
 * Both modes keep the Session's header cwd on the workspace root, so the
 * Session stays grouped under the user's project. When the host exposes no
 * `workingDirectory` service (unusual: it ships with `dsh-base`), the Session
 * is created directly in the topic directory instead — file isolation still
 * holds, but the Session can no longer be attached to the workspace.
 *
 * @module dsh-channels/session/isolation
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Agent, HostContext, Session } from '../dsh-types.ts'
import type { FeishuConfig } from '../config.ts'
import { topicDirFor, worktreeBranchFor } from '../workspaces.ts'

// ---- Host service slices (structural, resolved through ctx.get) ----------

/**
 * The effective-directory service (`@deepseek-ai/dsh-working-directory`,
 * mounted by every base-backed profile). `set` appends a durable
 * `working-directory/change` event and queues a user-context notice.
 */
export interface WorkingDirectoryService {
  get(session: Session): string
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

/** One created Git worktree checkout (`ctx.worktrees.create` result). */
export interface CreatedWorktree {
  path: string
  branch: string
  baseCommit: string
  repositoryRoot: string
}

/**
 * The optional Git-worktree service (`@deepseek-ai/dsh-experimental-worktree`).
 * It is not mounted everywhere, so every use is guarded.
 */
export interface WorktreeService {
  create(
    agent: Agent,
    request?: { name?: string; from?: string },
    signal?: AbortSignal,
  ): Promise<CreatedWorktree>
}

/** Placement capabilities resolved once per call site. */
export interface PlacementServices {
  workingDirectory?: WorkingDirectoryService
  worktrees?: WorktreeService
}

/** Resolve the placement capabilities from the host context (all optional). */
export function placementServices(ctx: HostContext): PlacementServices {
  const get = <T>(name: string): T | undefined => ctx.get?.(name) as T | undefined
  return {
    workingDirectory: get<WorkingDirectoryService>('workingDirectory'),
    worktrees: get<WorktreeService>('worktrees'),
  }
}

/** Isolation mode actually used for one topic. */
export type TopicMode = 'subdir' | 'worktree'

/** What the caller needs before creating the Session. */
export interface TopicPlan {
  /** Isolation mode chosen for this topic. */
  readonly mode: TopicMode
  /** Directory to pass as `meta.cwd` (the Session header cwd). */
  readonly cwd: string
  /** Topic directory for `subdir` mode (already created). */
  readonly subdir?: string
  /** Whether the deployment can switch the Session's working directory. */
  readonly switchable: boolean
}

/** Where one topic's Session actually works. */
export interface TopicPlacement {
  /** Effective working directory (`working-directory` projection value). */
  readonly sessionDir: string
  /** Git branch owning `sessionDir` when it is a worktree checkout. */
  readonly worktreeBranch?: string
}

/** Structured logger slice; best-effort warnings never throw. */
export type PlacementWarn = (message: string, ...args: unknown[]) => void

/** Whether the workspace directory is itself a Git working tree. */
export async function workspaceHasGitRepository(workspacePath: string): Promise<boolean> {
  try {
    const info = await stat(path.join(workspacePath, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * Pick the isolation mode for one topic. `auto` upgrades to a worktree only
 * when both the capability and a Git repository are present; an explicit
 * `worktree` preference still falls back (with a warning) when unavailable.
 */
async function chooseTopicMode(
  services: PlacementServices,
  config: FeishuConfig,
  workspacePath: string,
  warn: PlacementWarn,
): Promise<TopicMode> {
  const requested = config.topicIsolation
  if (requested === 'subdir') return 'subdir'
  const capable = services.workingDirectory !== undefined && services.worktrees !== undefined
  if (!capable) {
    if (requested === 'worktree') {
      warn('dsh-channels: topicIsolation=worktree needs the workingDirectory and worktrees host services; using a plain topic directory')
    }
    return 'subdir'
  }
  if (requested === 'worktree') return 'worktree'
  return await workspaceHasGitRepository(workspacePath) ? 'worktree' : 'subdir'
}

/**
 * Decide how a new Session is placed and materialize everything that must
 * exist before the Session is created.
 *
 * The returned `cwd` is the header cwd: the workspace root when the runtime
 * can switch directories (so the Session is grouped under the user's project),
 * otherwise the topic directory itself.
 */
export async function planTopic(
  services: PlacementServices,
  config: FeishuConfig,
  workspacePath: string,
  topicToken: string,
  warn: PlacementWarn,
): Promise<TopicPlan> {
  const mode = await chooseTopicMode(services, config, workspacePath, warn)
  if (services.workingDirectory !== undefined) {
    const subdir = mode === 'subdir' ? topicDirFor(workspacePath, topicToken) : undefined
    if (subdir !== undefined) await mkdir(subdir, { recursive: true })
    return {
      mode,
      cwd: workspacePath,
      ...(subdir === undefined ? {} : { subdir }),
      switchable: true,
    }
  }
  // No effective-directory service: create the Session inside the topic
  // directory itself. Isolation is preserved; workspace membership is lost.
  const subdir = topicDirFor(workspacePath, topicToken)
  await mkdir(subdir, { recursive: true })
  return { mode: 'subdir', cwd: subdir, subdir, switchable: false }
}

/** Enter the planned topic directory once the Session (and its Agent) exists. */
export async function enterTopic(
  services: PlacementServices,
  agent: Agent,
  plan: TopicPlan,
  workspacePath: string,
  topicToken: string,
  warn: PlacementWarn,
): Promise<TopicPlacement> {
  if (plan.mode === 'worktree' && services.worktrees !== undefined) {
    try {
      const created = await services.worktrees.create(agent, { name: worktreeBranchFor(topicToken) })
      return { sessionDir: created.path, worktreeBranch: created.branch }
    } catch (error) {
      warn(
        'dsh-channels: creating a worktree for topic %s failed, using a plain topic directory instead: %s',
        topicToken, String(error),
      )
    }
  }
  const dir = plan.subdir ?? topicDirFor(workspacePath, topicToken)
  await mkdir(dir, { recursive: true })
  if (plan.switchable) await alignWorkingDirectory(services, agent, dir, warn)
  return { sessionDir: dir }
}

/**
 * Align one live Session with its recorded topic directory: make sure the
 * directory exists, recreate it (or a fresh worktree) when it disappeared,
 * and restore the effective working directory the route expects.
 *
 * The returned placement may carry a new directory/branch after recovery; the
 * caller persists it back into the route record.
 */
export async function restoreTopicDir(
  services: PlacementServices,
  agent: Agent,
  input: {
    readonly workspacePath: string
    readonly sessionDir: string
    readonly worktreeBranch?: string
  },
  warn: PlacementWarn,
): Promise<TopicPlacement> {
  const { sessionDir, worktreeBranch } = input
  if (await isDirectory(sessionDir)) {
    await alignWorkingDirectory(services, agent, sessionDir, warn)
    return worktreeBranch === undefined ? { sessionDir } : { sessionDir, worktreeBranch }
  }
  // The directory is gone (manual deletion, external cleanup, lost host):
  // give the Session a fresh directory so it never silently falls back to the
  // shared workspace root.
  if (worktreeBranch !== undefined
    && services.worktrees !== undefined
    && services.workingDirectory !== undefined) {
    try {
      const created = await services.worktrees.create(agent, {
        name: `${worktreeBranch}-r${randomUUID().slice(0, 8)}`,
      })
      return { sessionDir: created.path, worktreeBranch: created.branch }
    } catch (error) {
      warn(
        'dsh-channels: recreating the worktree for session %s failed, using a plain directory: %s',
        agent.id, String(error),
      )
    }
  }
  await mkdir(sessionDir, { recursive: true })
  await alignWorkingDirectory(services, agent, sessionDir, warn)
  return { sessionDir }
}

/** Best-effort check used only for placement decisions, never for security. */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Point the Session's effective working directory at `dir`. */
async function alignWorkingDirectory(
  services: PlacementServices,
  agent: Agent,
  dir: string,
  warn: PlacementWarn,
): Promise<void> {
  const workingDirectory = services.workingDirectory
  if (workingDirectory === undefined) return
  try {
    if (workingDirectory.get(agent.session) === dir) return
    await workingDirectory.set(agent, dir)
  } catch (error) {
    // The durable Session keeps its previous directory; the caller cannot do
    // better than warning because the turn is still deliverable.
    warn(
      'dsh-channels: switching session %s to its topic directory failed: %s',
      agent.id, String(error),
    )
  }
}
