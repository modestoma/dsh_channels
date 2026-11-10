/**
 * The settings panel's read views over Feishu-routed Sessions: one Session's
 * Feishu origin, every routed Session grouped by chat and user, and the
 * workspace file routes restricted to those Sessions' roots.
 *
 * @module dsh-channels/settings/records
 */

import { isGroupRoute } from '../domain.ts'
import type { RouteRecord, SessionOriginRecord } from '../domain.ts'
import type { ProfileDirectory } from '../feishu/profiles.ts'
import type { SessionId, SessionQuery } from '../host/index.ts'
import type { RouteStore } from '../session/routes.ts'
import { listWorkspaceDirectory, previewWorkspaceFile, readWorkspaceFile, WorkspaceFileError } from '../workspace-files.ts'
import type { WorkspaceDownload } from '../workspace-files.ts'
import type {
  SessionOriginWire, SessionRecordGroupWire, SessionRecordsWire, SessionRecordUserWire, SessionRecordWire,
  WorkspaceListingWire, WorkspacePreviewWire,
} from './contract.ts'

export interface SessionRecordsDeps {
  routes: RouteStore
  profiles: ProfileDirectory
  /** The host's session query service, when mounted (titles and roots). */
  sessionQuery(): SessionQuery | undefined
  /** Whether a Session has a live Agent. */
  isLive(sessionId: string): boolean
  warn(message: string, ...args: unknown[]): void
}

/** Who started a Session: a Feishu user, or an external requester's display text. */
interface Who {
  readonly userId?: string
  readonly label?: string
}

/** One records-view member and its Sessions. */
interface Member {
  readonly who: Who
  readonly records: SessionRecordWire[]
}

/** Panel views over Feishu-routed Sessions. */
export class SessionRecords {
  /** Workspace roots of Feishu-routed Sessions seen by the last records read; file routes serve only these and active routes' roots. */
  private workspaces = new Set<string>()

  constructor(private readonly deps: SessionRecordsDeps) {}

  /**
   * @param sessionId - the Session.
   * @returns its Feishu origin, or null when Feishu never routed it.
   */
  async origin(sessionId: string): Promise<SessionOriginWire | null> {
    const { routes, profiles } = this.deps
    const origin = routes.origin(sessionId)
    if (origin === undefined) return null
    const route = routes.findBySession(sessionId)
    const bound = route !== undefined
    const group = origin.chatType === 'group'
    const senderUserId = origin.senderUserId
    const found = await profiles.lookup(senderUserId === undefined ? [] : [senderUserId], group ? [origin.chatId] : [])
    const chat = found.chats[origin.chatId] ?? {}
    const sender = senderUserId === undefined ? {} : found.users[senderUserId] ?? {}
    const senderName = sender.name ?? (group && senderUserId !== undefined ? await profiles.memberName(senderUserId, origin.chatId) : undefined)
    return {
      sessionId,
      chatType: origin.chatType,
      kind: origin.kind,
      chatId: origin.chatId,
      ...(chat.name === undefined ? {} : { chatName: chat.name }),
      ...(chat.avatarUrl === undefined ? {} : { chatAvatarUrl: chat.avatarUrl }),
      ...(senderUserId === undefined ? {} : { senderUserId }),
      ...(origin.senderLabel === undefined ? {} : { senderLabel: origin.senderLabel }),
      ...(senderName === undefined ? {} : { senderName }),
      ...(sender.avatarUrl === undefined ? {} : { senderAvatarUrl: sender.avatarUrl }),
      shared: isGroupRoute(origin),
      createdAt: origin.createdAt,
      bound,
      ...(bound ? { lastActivityAt: route.lastActivityAt } : {}),
      chatLink: `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(origin.chatId)}`,
    }
  }

  /**
   * Every Feishu-routed Session, grouped by group chat → user and by
   * private-chat user, with live names, log-backed titles and workspace roots.
   * Titles and roots come from `sessionQuery`; without it, roots fall back to
   * the active route's workspace and titles are absent.
   * @returns the grouped records, most recently active first at every level.
   */
  async list(): Promise<SessionRecordsWire> {
    const { routes, profiles } = this.deps
    const origins = routes.origins()
    const sessions = await this.facts(origins)
    const userIds = new Set<string>()
    const chatIds = new Set<string>()
    for (const origin of origins) {
      if (origin.senderUserId !== undefined) userIds.add(origin.senderUserId)
      if (origin.chatType === 'group') chatIds.add(origin.chatId)
    }
    const found = await profiles.lookup([...userIds], [...chatIds])
    const activity = (record: SessionRecordWire): number => record.lastActivityAt ?? record.createdAt
    const byActivity = (a: SessionRecordWire, b: SessionRecordWire): number => activity(b) - activity(a)
    const latest = (user: SessionRecordUserWire): number => activity(user.sessions[0]!)
    const groupMembers = new Map<string, Map<string, Member>>()
    const directMembers = new Map<string, Member>()
    const add = (members: Map<string, Member>, who: Who, record: SessionRecordWire): void => {
      const key = who.userId === undefined ? `label:${who.label ?? ''}` : `user:${who.userId}`
      const member = members.get(key) ?? { who, records: [] }
      member.records.push(record)
      members.set(key, member)
    }
    origins.forEach((origin, index) => {
      const record = sessions[index]!
      const who: Who = origin.senderUserId === undefined ? { label: origin.senderLabel } : { userId: origin.senderUserId }
      if (origin.chatType === 'group') {
        const members = groupMembers.get(origin.chatId) ?? new Map<string, Member>()
        groupMembers.set(origin.chatId, members)
        add(members, who, record)
      } else {
        add(directMembers, who, record)
      }
    })
    const userEntry = async ({ who, records }: Member, chatId?: string): Promise<SessionRecordUserWire> => {
      records.sort(byActivity)
      const userId = who.userId
      const profile = userId === undefined ? {} : found.users[userId] ?? {}
      const name = profile.name ?? (chatId === undefined || userId === undefined ? undefined : await profiles.memberName(userId, chatId))
      const workspaces = [...new Set(records.flatMap(record => (record.workspace === undefined ? [] : [record.workspace])))]
      return {
        ...(userId === undefined ? {} : { userId }),
        ...(who.label === undefined ? {} : { label: who.label }),
        ...(name === undefined ? {} : { name }),
        ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
        workspaces,
        sessions: records,
      }
    }
    const groups = await Promise.all([...groupMembers].map(async ([chatId, members]): Promise<SessionRecordGroupWire> => {
      const users = await Promise.all([...members.values()].map(member => userEntry(member, chatId)))
      users.sort((a, b) => latest(b) - latest(a))
      const chat = found.chats[chatId] ?? {}
      return {
        chatId,
        ...(chat.name === undefined ? {} : { chatName: chat.name }),
        ...(chat.avatarUrl === undefined ? {} : { chatAvatarUrl: chat.avatarUrl }),
        users,
      }
    }))
    groups.sort((a, b) => latest(b.users[0]!) - latest(a.users[0]!))
    const directs = await Promise.all([...directMembers.values()].map(member => userEntry(member)))
    directs.sort((a, b) => latest(b) - latest(a))
    return {
      groups,
      directs,
      ...(found.warning === undefined ? {} : { warning: found.warning }),
    }
  }

  /**
   * List one directory of a Feishu workspace.
   * @param workspace - a Feishu-routed Session's root.
   * @param path - directory relative to it.
   * @returns the listing.
   */
  async files(workspace: string, path: string | undefined): Promise<WorkspaceListingWire> {
    return listWorkspaceDirectory(await this.browsable(workspace), path)
  }

  /**
   * Preview one file of a Feishu workspace.
   * @param workspace - a Feishu-routed Session's root.
   * @param path - file relative to it.
   * @returns the preview.
   */
  async preview(workspace: string, path: string | undefined): Promise<WorkspacePreviewWire> {
    return previewWorkspaceFile(await this.browsable(workspace), path)
  }

  /**
   * Read one file of a Feishu workspace for download.
   * @param workspace - a Feishu-routed Session's root.
   * @param path - file relative to it.
   * @returns the file.
   */
  async download(workspace: string, path: string | undefined): Promise<WorkspaceDownload> {
    return readWorkspaceFile(await this.browsable(workspace), path)
  }

  /**
   * One records-view entry per origin (same order), and refresh the set of
   * browsable workspace roots from them.
   */
  private async facts(origins: readonly SessionOriginRecord[]): Promise<SessionRecordWire[]> {
    const { routes } = this.deps
    const bound = new Map<string, RouteRecord>()
    for (const record of routes.records()) bound.set(record.sessionId, record)
    const titles = new Map<string, string>()
    const roots = new Map<string, string>()
    const query = this.deps.sessionQuery()
    if (query !== undefined && origins.length > 0) {
      try {
        for (const item of await query.readTitleSnapshots(origins.map(origin => origin.key as SessionId))) {
          if (item.status !== 'fulfilled') continue
          if (item.value.title !== undefined) titles.set(item.sessionId, item.value.title.title)
          const cwd = item.value.session?.cwd
          if (cwd !== undefined && cwd !== '') roots.set(item.sessionId, cwd)
        }
      } catch (error) {
        this.deps.warn('dsh-channels: session records lookup failed: %s', String(error))
      }
    }
    const records = origins.map((origin): SessionRecordWire => {
      const id = origin.key
      const route = bound.get(id)
      const title = titles.get(id)
      const workspace = roots.get(id) ?? route?.workspacePath
      return {
        sessionId: id,
        ...(title === undefined ? {} : { title }),
        kind: origin.kind,
        shared: isGroupRoute(origin),
        createdAt: origin.createdAt,
        bound: route !== undefined,
        ...(route === undefined ? {} : { lastActivityAt: route.lastActivityAt }),
        live: this.deps.isLive(id),
        ...(workspace === undefined ? {} : { workspace }),
      }
    })
    this.workspaces = new Set(records.flatMap(record => (record.workspace === undefined ? [] : [record.workspace])))
    return records
  }

  /**
   * A workspace root the file routes may serve: a root of some Feishu-routed
   * Session. An unknown root re-reads the records once (the page may outlive
   * a restart) before it is refused.
   * @throws {WorkspaceFileError} 403 for any other directory.
   */
  private async browsable(workspace: string): Promise<string> {
    const { routes } = this.deps
    const known = (): boolean => this.workspaces.has(workspace)
      || routes.records().some(record => record.workspacePath === workspace)
    if (!known()) await this.facts(routes.origins())
    if (!known()) throw new WorkspaceFileError(403, '该目录不是飞书会话的工作区')
    return workspace
  }
}
