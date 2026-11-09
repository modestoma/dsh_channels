/**
 * Workspace directory resolution: one DSH workspace per Feishu topic.
 *
 * - p2p:   `<baseDir>/p2p/<user_id>/<topic>/`
 * - group: `<baseDir>/groups/<chat_id>/<topic>/`
 *
 * The topic directory is the Session header cwd: the sandbox write boundary,
 * the read fence, the confine runner's writable root, and the workspace the
 * Session is grouped under in the GUI are all this one directory, so topics
 * of the same person or group never see each other's files and no working
 * directory is ever switched. The GUI lists topics flat; the records tab
 * groups them by group and person.
 *
 * Older versions placed topics inside one shared workspace per user
 * (`<baseDir>/p2p/<user_id>/topics/<topic>/`, `<baseDir>/groups/<chat_id>/<user_id>/…`)
 * or registered one workspace per topic under `<baseDir>/topics/`; those
 * directories are kept verbatim for their routes and never migrated. The plugin
 * never deletes topic directories; operators remove stale ones by hand.
 *
 * Inbound attachments never land in these directories: they are stored in
 * the DSH native attachment library (see `./feishu/native-attachments.ts`).
 *
 * Feishu ids (`user_id`, `oc_…`, `omt_…`) are safe path segments, but they
 * are validated anyway so a hostile id can never escape `baseDir`.
 *
 * @module dsh-channels/workspaces
 */

import { constants } from 'node:fs'
import { access, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HostContext, Workspace } from './host/index.ts'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * Names and registration of the places topics open in, resolved by the
 * service (Feishu profiles, the access store). Every name read is best
 * effort: `undefined` when Feishu cannot name the id.
 */
export interface TopicLocationPort {
  /** Display name of a group chat. */
  groupName(chatId: string): Promise<string | undefined>
  /** Display name of a person (contact profile). */
  userName(userId: string): Promise<string | undefined>
  /**
   * Register a group's permission record the first time a topic opens in it
   * (every switch off; an existing record is kept, its name refreshed).
   */
  registerGroup(chatId: string, name: string | undefined): Promise<void>
}

/** Upper bound for a panel-supplied workspace root (filesystem path limit headroom). */
const MAX_BASE_DIR_LENGTH = 4096

/** Longest topic title kept in a workspace title. */
const TOPIC_TITLE_MAX = 40

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
 * The workspace directory of one topic: the private chat's person or the
 * group, then the topic token.
 *
 * - p2p:   `<baseDir>/p2p/<user_id>/<topic>/`
 * - group: `<baseDir>/groups/<chat_id>/<topic>/`
 *
 * @param baseDir - the channel's workspace root.
 * @param chatType - `p2p` or `group`.
 * @param chatId - Feishu chat id (used for groups).
 * @param userId - Feishu user_id (used for private chats).
 * @param topicToken - {@link topicTokenFor} of the topic.
 * @returns the absolute topic directory.
 */
export function topicWorkspacePathFor(
  baseDir: string,
  chatType: 'p2p' | 'group',
  chatId: string,
  userId: string,
  topicToken: string,
): string {
  const topic = safeSegment(topicToken, 'topic token')
  if (chatType === 'p2p') return path.join(baseDir, 'p2p', safeSegment(userId, 'user id'), topic)
  return path.join(baseDir, 'groups', safeSegment(chatId, 'chatId'), topic)
}

/**
 * The topic title shown in a workspace title: the first non-empty line of the
 * text that opened the topic, trimmed to {@link TOPIC_TITLE_MAX} characters.
 * @param text - the opening message, launch card title, or undefined.
 * @returns the title, or `话题` when nothing usable is given.
 */
export function topicTitleOf(text: string | undefined): string {
  const line = text?.split(/\r?\n/u).map(part => part.trim()).find(part => part !== '')
  if (line === undefined) return '话题'
  const chars = [...line.replace(/\s+/gu, ' ')]
  return chars.length > TOPIC_TITLE_MAX ? `${chars.slice(0, TOPIC_TITLE_MAX).join('')}…` : line
}

/**
 * Workspace title shown in the DSH workspace list: `<owner> · <topic>`, where
 * the owner is the group's name or the person's name (their id when the name
 * cannot be read).
 * @param ownerName - group name, person name, or id.
 * @param topicTitle - {@link topicTitleOf} of the topic.
 * @returns the title.
 */
export function workspaceTitleFor(ownerName: string, topicTitle: string): string {
  return `${ownerName} · ${topicTitle}`
}

/**
 * Ensure one topic directory exists and is registered with the host's
 * workspace registry. Idempotent: repeated calls return the same record, and
 * an existing record keeps its title (retitle it with `Workspace.setTitle`).
 * @param ctx - host context (workspace registry).
 * @param dir - the topic directory ({@link topicWorkspacePathFor}).
 * @param title - title for a newly registered workspace.
 * @returns the registered workspace.
 */
export async function ensureTopicWorkspace(ctx: HostContext, dir: string, title: string): Promise<Workspace> {
  await mkdir(dir, { recursive: true })
  return ctx.workspaceRegistry.create(dir, title)
}
