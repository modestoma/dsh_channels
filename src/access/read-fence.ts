/**
 * Read fence: in a Feishu Session, a configured in-process file tool may only
 * read inside the route's topic directory and the deployment's shared
 * `readableRoots`.
 *
 * - Ownership: a call is fenced when its agent's Session is routed, or
 *   descends (through `parentSession`) from a routed Session; see
 *   `./lineage.ts`. Sessions the
 *   channel does not route are never touched.
 * - Paths: relative arguments resolve against the calling Session's effective
 *   working directory (header cwd when the host has no working-directory
 *   service), `~` against the Host user's home. The deepest existing ancestor
 *   of each path is resolved through symlinks, so a link planted inside the
 *   workspace cannot point the tool elsewhere. The topic directory is allowed
 *   only as a real directory: one replaced by a symlink grants nothing.
 * - A glob `pattern` is checked by its leading directories up to the first
 *   wildcard segment; a pattern with a `..` segment is denied.
 * - An omitted path argument is checked as the effective working directory,
 *   which tools search by default and a Session can move outside its
 *   workspace.
 * - The check runs in `tools/pre-execute`, so it holds for PTC sub-dispatches
 *   too. It does not cover tools that spawn processes (shell, terminal, code
 *   execution): their reads are confined by the sandbox runner.
 *
 * @module dsh-channels/access/read-fence
 */

import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { FeishuConfig } from '../config.ts'
import type { RouteRecord } from '../domain.ts'
import type { PreToolDecision, PreToolExecution, Session } from '../host/index.ts'
import type { SessionLineage } from './lineage.ts'

export interface ReadFenceDeps {
  /** Live configuration (`readFence`). */
  config(): Pick<FeishuConfig, 'readFence'>
  /** The route that names a Session, if any. */
  routeOf(sessionId: string): RouteRecord | undefined
  /** Which routed Session each Session belongs to. */
  lineage: SessionLineage
  /** The Session's effective working directory, when the host tracks one. */
  workingDirectory(session: Session): string | undefined
}

/** Characters that start a wildcard in a glob segment. */
const GLOB_MAGIC = /[*?[\]{}!()]/u

export class ReadFence {
  constructor(private readonly deps: ReadFenceDeps) {}

  /**
   * Decide one pending tool call.
   * @param exec - the pending call.
   * @returns `deny` with a model-readable reason, or undefined to delegate.
   */
  async decide(exec: PreToolExecution): Promise<PreToolDecision | undefined> {
    const agent = exec.agent
    if (agent === undefined) return undefined
    // Resolved before the tool check so every call remembers its Session's root.
    const root = this.deps.lineage.rootOfCall(agent.session.id, agent.session.header.parentSession)
    const fence = this.deps.config().readFence
    if (root === undefined || !fence.enabled) return undefined
    const argumentNames = Object.hasOwn(fence.tools, exec.name) ? fence.tools[exec.name] : undefined
    if (argumentNames === undefined) return undefined
    const route = this.deps.routeOf(root)
    if (route === undefined) return undefined
    const args = isRecord(exec.arguments) ? exec.arguments : {}
    const base = this.deps.workingDirectory(agent.session) ?? agent.session.header.cwd ?? route.workspacePath
    const allowed = await allowedRootsOf(route, fence.readableRoots)
    const resolvedBase = await resolveReal(path.resolve(expandHome(base)))
    for (const name of argumentNames) {
      const value = args[name]
      if (typeof value !== 'string' || value === '') {
        // An omitted path argument defaults to the effective working directory, which a Session can move.
        if (!allowed.some(rootPath => isInside(resolvedBase, rootPath))) return deny(exec.name, base, route)
        continue
      }
      const target = name === 'pattern' ? globBase(value, typeof args.path === 'string' && args.path !== '' ? args.path : base) : value
      if (target === undefined) return deny(exec.name, value, route)
      const resolved = await resolveReal(path.resolve(base, expandHome(target)))
      if (!allowed.some(rootPath => isInside(resolved, rootPath))) return deny(exec.name, value, route)
    }
    return undefined
  }
}

/**
 * The canonical directories one route's Sessions may read.
 *
 * The topic directory is judged without following a symlink at its own path,
 * because a Session that can write its parent could replace it with a link to
 * anywhere. The deployment's `readableRoots` are followed through symlinks.
 */
async function allowedRootsOf(route: RouteRecord, readableRoots: readonly string[]): Promise<string[]> {
  const roots = await Promise.all([ownedRoot(route.workspacePath), ...readableRoots.map(async root => await resolveReal(root))])
  return roots.filter((root): root is string => root !== undefined)
}

/**
 * Canonical path of a plugin-created directory: its parent resolved through
 * symlinks plus its own name.
 * @returns undefined when the directory itself is a symlink.
 */
async function ownedRoot(dir: string): Promise<string | undefined> {
  const absolute = path.resolve(dir)
  const canonical = path.join(await resolveReal(path.dirname(absolute)), path.basename(absolute))
  try {
    if ((await lstat(canonical)).isSymbolicLink()) return undefined
  } catch (error) {
    // A directory that does not exist yet cannot redirect anything; keep its canonical path.
    if (!isMissing(error)) return undefined
  }
  return canonical
}

function deny(toolName: string, value: string, route: RouteRecord): PreToolDecision {
  return {
    kind: 'deny',
    reason: `飞书会话只能读取自己的工作区（${route.workspacePath}）和部署允许的共享目录，${toolName} 的路径 ${value} 不在范围内，已拒绝。请改用工作区内的路径；需要的文件请让用户发到对话里。`,
  }
}

/**
 * The directory a glob pattern searches from: its leading segments up to the
 * first wildcard, against `searchPath` when relative.
 * @returns undefined when the pattern has a `..` segment.
 */
function globBase(pattern: string, searchPath: string): string | undefined {
  const segments = pattern.split(/[\\/]/u)
  if (segments.includes('..')) return undefined
  const firstMagic = segments.findIndex(segment => GLOB_MAGIC.test(segment))
  const fixed = (firstMagic === -1 ? segments.slice(0, -1) : segments.slice(0, firstMagic)).join('/')
  if (path.isAbsolute(pattern)) return fixed === '' ? '/' : fixed
  return path.join(expandHome(searchPath), fixed)
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the deepest existing ancestor of an absolute path through symlinks
 * and append the rest, so a path that does not exist yet is judged by where it
 * would be created.
 */
async function resolveReal(absolute: string): Promise<string> {
  const rest: string[] = []
  let current = path.resolve(absolute)
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest.reverse())
    } catch (error) {
      // ENOENT/ENOTDIR: climb to the parent; any other failure is judged lexically below.
      if (!isMissing(error)) return path.join(current, ...rest.reverse())
    }
    const parent = path.dirname(current)
    if (parent === current) return path.join(current, ...rest.reverse())
    rest.push(path.basename(current))
    current = parent
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
