/**
 * Workspace directory resolution: one DSH workspace per (user × chat).
 *
 * Every Feishu topic gets its own workspace, grouped by the (chat, user) pair:
 * - p2p:    `<baseDir>/p2p/<open_id>/<topic>/`
 * - group:  `<baseDir>/groups/<chat_id>/<open_id>/<topic>/`
 *
 * Attachments received before a topic exists are staged below
 * `<baseDir>/_staging/<chatType>/<chat_id>/<open_id>/` and adopted into the
 * topic workspace once its first Session is created.
 *
 * Feishu ids (`ou_…`, `oc_…`) are safe path segments, but they are validated
 * anyway so a hostile id can never escape `baseDir`.
 *
 * @module dsh-channels/workspaces
 */

import { constants } from 'node:fs'
import { access, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HostContext, Workspace } from './dsh-types.ts'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/** Upper bound for a panel-supplied workspace root (filesystem path limit headroom). */
const MAX_BASE_DIR_LENGTH = 4096

/** Lexical validation result for a workspace root. */
export type BaseDirCheck =
  | { ok: true; value: string }
  | { ok: false; message: string }

/**
 * Validate and normalize a workspace root supplied by the settings panel.
 *
 * The profile layer keeps accepting whatever the deployment wrote (including
 * the historical relative default), but a value *typed into the Web panel*
 * must name an unambiguous location: a relative path would resolve against
 * the host process's unpredictable cwd. `~` is expanded for convenience and
 * the result is normalized; the root itself is rejected because workspace
 * directories are appended to it.
 *
 * @param raw - untrusted panel value.
 * @param home - home directory seam (tests pin it; production uses `homedir()`).
 * @returns the normalized absolute path, or a user-facing message.
 */
export function normalizeWorkspaceBaseDir(raw: unknown, home: string = homedir()): BaseDirCheck {
  if (typeof raw !== 'string') return { ok: false, message: '必须是字符串' }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, message: '不能为空' }
  if (trimmed.length > MAX_BASE_DIR_LENGTH) {
    return { ok: false, message: `路径长度不得超过 ${MAX_BASE_DIR_LENGTH} 个字符` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, message: '包含非法控制字符' }
  let expanded = trimmed
  if (expanded === '~') {
    expanded = home
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(2))
  }
  // Check absoluteness before resolving: `path.resolve` would silently turn a
  // relative panel value into a cwd-dependent absolute path.
  if (!path.isAbsolute(expanded)) {
    return { ok: false, message: '必须是绝对路径（例如 /Users/you/.dsh/dsh-channels/workspaces）' }
  }
  const normalized = path.resolve(expanded)
  if (path.parse(normalized).root === normalized) {
    return { ok: false, message: '不能使用文件系统根目录' }
  }
  return { ok: true, value: normalized }
}

/**
 * Materialize one panel-supplied workspace root and prove it is usable.
 *
 * Called when the panel saves `baseDir` so an unusable location fails at save
 * time instead of surfacing later as "会话创建失败" inside a Feishu chat.
 * The directory is created here (the same `mkdir -p` the first session would
 * perform); an existing non-directory is refused.
 *
 * @returns an error message, or `undefined` when the directory is writable.
 */
export async function prepareWorkspaceBaseDir(dir: string): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    return `无法创建工作区目录：${String(error)}`
  }
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return '该路径已存在但不是目录'
  } catch (error) {
    return `无法读取工作区目录：${String(error)}`
  }
  try {
    await access(dir, constants.W_OK)
  } catch {
    return '工作区目录不可写'
  }
  return undefined
}

export function safeSegment(raw: string, what: string): string {
  const segment = raw.replace(/^\/+|\/+$/g, '')
  if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`dsh-channels: unsafe ${what} for workspace path: ${JSON.stringify(raw)}`)
  }
  return segment
}

/**
 * Stable, filesystem-safe token for one Feishu conversation: a real topic uses
 * its thread id, while a degraded chat-scoped conversation uses the Session id
 * that owns it (there is no topic boundary to key on).
 */
export function topicTokenFor(
  routeKey: string,
  kind: 'thread' | 'chat',
  sessionId: string,
): string {
  return kind === 'thread' ? safeSegment(routeKey, 'route key') : safeSegment(sessionId, 'session id')
}

/**
 * Deterministic workspace directory for one Feishu topic: every route gets its
 * own workspace below its (user × chat) grouping directory.
 *
 * - p2p:   `<baseDir>/topics/p2p/<open_id>/<topic>/`
 * - group: `<baseDir>/topics/groups/<chat_id>/<open_id>/<topic>/`
 *
 * A separate `topics/` root keeps new workspaces out of the legacy (user ×
 * chat) workspace directories left by older versions, so cleaning one can
 * never delete the other.
 */
export function workspacePathFor(
  baseDir: string,
  chatType: 'p2p' | 'group',
  chatId: string,
  senderOpenId: string,
  topicToken: string,
): string {
  const chat = safeSegment(chatId, 'chatId')
  const user = safeSegment(senderOpenId, 'senderOpenId')
  const topic = safeSegment(topicToken, 'topic token')
  return chatType === 'p2p'
    ? path.join(baseDir, 'topics', 'p2p', user, topic)
    : path.join(baseDir, 'topics', 'groups', chat, user, topic)
}

/**
 * Staging directory for attachments that arrive before their topic (and so
 * its workspace) exists. Not a registered workspace: files move into the real
 * workspace as soon as the first Session of that topic is created.
 */
export function stagingPathFor(
  baseDir: string,
  chatType: 'p2p' | 'group',
  chatId: string,
  senderOpenId: string,
): string {
  const chat = safeSegment(chatId, 'chatId')
  const user = safeSegment(senderOpenId, 'senderOpenId')
  return path.join(baseDir, '_staging', chatType, chat, user)
}

/** Human-friendly workspace title shown in the DSH workspace list. */
export function workspaceTitleFor(
  chatType: 'p2p' | 'group',
  chatId: string,
  senderOpenId: string,
  topicToken?: string,
): string {
  const base = chatType === 'p2p'
    ? `飞书私聊 · ${senderOpenId}`
    : `飞书群聊 · ${chatId} · ${senderOpenId}`
  return topicToken === undefined ? base : `${base} · ${topicToken}`
}

/**
 * Ensure one topic's workspace directory exists and is registered with the
 * host's workspace registry. Idempotent: repeated calls return the same record.
 */
export async function ensureWorkspace(
  ctx: HostContext,
  baseDir: string,
  chatType: 'p2p' | 'group',
  chatId: string,
  senderOpenId: string,
  topicToken: string,
): Promise<Workspace> {
  const dir = workspacePathFor(baseDir, chatType, chatId, senderOpenId, topicToken)
  await mkdir(dir, { recursive: true })
  return ctx.workspaceRegistry.create(
    dir,
    workspaceTitleFor(chatType, chatId, senderOpenId, topicToken),
  )
}
