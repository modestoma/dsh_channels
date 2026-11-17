/**
 * Private-chat projects mode: the person's directory and the directories of
 * the Sessions inside it.
 *
 * ```
 * <baseDir>/p2p/<user_id>/        the person's DSH workspace, header cwd of every projects-mode Session
 *   main/                         the main Session's working directory
 *   topics/<topic>/               one topic Session's working directory
 *   shared/                       files every Session of the person may read and write
 * ```
 *
 * The host groups a Session under a workspace only when its header cwd equals
 * the workspace path, so every projects-mode Session starts in the person's
 * directory and is then moved to its own directory through the host's
 * working-directory service. Reads are limited per Session by
 * {@link readRootsOf}: the main Session reads `main/` and `shared/`, a topic
 * Session its own directory and `shared/`. Topic-mode topics of the same
 * person stay in `<baseDir>/p2p/<user_id>/<topic>/` with their own workspace;
 * their directory names are Feishu thread ids or Session ids and never collide
 * with `main`, `topics` or `shared`.
 *
 * @module dsh-channels/dm/layout
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { RouteRecord } from '../domain.ts'
import type { Agent, HostContext, Workspace } from '../host/index.ts'
import { workingDirectoryService } from '../host/index.ts'
import { safeSegment } from '../workspaces.ts'
import type { TopicLocationPort } from '../workspaces.ts'

/** Name of the main Session's directory inside the person's directory. */
export const DM_MAIN_DIR = 'main'
/** Name of the directory holding topic directories. */
export const DM_TOPICS_DIR = 'topics'
/** Name of the shared-files directory. */
export const DM_SHARED_DIR = 'shared'

/**
 * The person's directory: the projects-mode workspace.
 * @param baseDir - the channel's workspace root.
 * @param userId - Feishu user_id of the person.
 * @returns `<baseDir>/p2p/<user_id>`.
 */
export function dmProjectRoot(baseDir: string, userId: string): string {
  return path.join(baseDir, 'p2p', safeSegment(userId, 'user id'))
}

/**
 * The working directory of one projects-mode Session.
 * @param root - the person's directory ({@link dmProjectRoot}).
 * @param role - main Session or topic.
 * @param topicToken - the topic's directory name (Feishu thread id); topics only.
 * @returns `main/` or `topics/<topic>/` below `root`.
 */
export function dmSessionDir(root: string, role: 'main' | 'topic', topicToken?: string): string {
  if (role === 'main') return path.join(root, DM_MAIN_DIR)
  if (topicToken === undefined) throw new Error('dsh-channels: a projects-mode topic needs its topic token')
  return path.join(root, DM_TOPICS_DIR, safeSegment(topicToken, 'topic token'))
}

/**
 * The shared-files directory of the person a projects-mode route belongs to.
 * @param root - the person's directory.
 * @returns `shared/` below `root`.
 */
export function dmSharedDir(root: string): string {
  return path.join(root, DM_SHARED_DIR)
}

/**
 * Create the person's directory with `main/`, `topics/` and `shared/`, and
 * register it with the host workspace registry. Idempotent: an existing
 * registration keeps its title.
 * @param ctx - host context (workspace registry).
 * @param location - person names.
 * @param baseDir - the channel's workspace root.
 * @param userId - Feishu user_id of the person.
 * @returns the person's workspace.
 */
export async function ensureDmProject(ctx: HostContext, location: TopicLocationPort, baseDir: string, userId: string): Promise<Workspace> {
  const root = dmProjectRoot(baseDir, userId)
  await Promise.all([DM_MAIN_DIR, DM_TOPICS_DIR, DM_SHARED_DIR].map(async name => await mkdir(path.join(root, name), { recursive: true })))
  const name = await location.userName(userId)
  return ctx.workspaceRegistry.create(root, `${name ?? userId} · 私聊`)
}

/**
 * The directory a route's Session works in: `currentDir` for projects-mode
 * routes, else the topic workspace.
 * @param route - the route.
 * @returns an absolute directory.
 */
export function routeWorkDir(route: Pick<RouteRecord, 'workspacePath' | 'currentDir'>): string {
  return route.currentDir ?? route.workspacePath
}

/**
 * The directories a route's Sessions may read, before the deployment's
 * shared `readableRoots`: the working directory plus `shared/` for a
 * projects-mode route, the topic workspace otherwise.
 * @param route - the route.
 * @returns absolute directories.
 */
export function readRootsOf(route: Pick<RouteRecord, 'workspacePath' | 'currentDir' | 'dmRole'>): string[] {
  if (route.dmRole === undefined) return [route.workspacePath]
  return [routeWorkDir(route), dmSharedDir(route.workspacePath)]
}

/**
 * Move a projects-mode Session to its own directory. Without the host's
 * working-directory service the Session keeps working in the person's
 * directory; reads stay limited by the read fence either way.
 * @param ctx - host context.
 * @param agent - the Session's Agent.
 * @param dir - its working directory.
 * @param warn - logger for a missing service or a failed switch.
 */
export async function enterSessionDir(ctx: HostContext, agent: Agent, dir: string, warn: (message: string, ...args: unknown[]) => void): Promise<void> {
  await mkdir(dir, { recursive: true })
  const service = workingDirectoryService(ctx)
  if (service === undefined) {
    warn('dsh-channels: no working-directory service; session %s keeps working in its workspace root', agent.id)
    return
  }
  await service.set(agent, dir)
}
