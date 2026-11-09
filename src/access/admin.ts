/**
 * Access administration: the settings panel's user-table and group-permission
 * mutations and the administrator-only `/auth` command, over one access store.
 *
 * @module dsh-channels/access/admin
 */

import { standaloneInfoCard } from '../cards/index.ts'
import type { ParsedSlashCommand } from '../commands.ts'
import type { FeishuConfig } from '../config.ts'
import { ACCESS_PERMISSIONS, FEISHU_USER_ID_PATTERN } from '../domain.ts'
import type { AccessPermission, AccessSwitch, AccessUserRecord, GroupPermission } from '../domain.ts'
import type { CardDelivery } from '../feishu/delivery.ts'
import type { NormalizedMessage } from '../feishu-channel.ts'
import type { AccessMutationResponse, AccessRequestWire, AccessUserWire, AccessWire } from '../settings/contract.ts'
import type { AccessRequests } from './requests.ts'
import type { AccessStore } from './store.ts'
import { AUTH_USER_TARGET_ERRORS, resolveAuthUserTarget } from './targets.ts'

/** `/auth` usage line (input-error card). */
const AUTH_USAGE = '用法：/auth [status|list]；/auth add <@用户|user_id>；/auth remove <@用户|user_id>；/auth set <chat|wiki-read|wiki-write|code> <on|off> <@用户|user_id>'

/** `/auth set` switch names → permission switches. The administrator flag is set only in the Web panel. */
const AUTH_SWITCHES: Readonly<Record<string, AccessPermission>> = {
  'chat': 'chat',
  'wiki-read': 'wikiRead',
  'wiki-write': 'wikiWrite',
  'code': 'codeWrite',
}

/** Display label of each permission switch. */
const PERMISSION_LABELS: Readonly<Record<AccessPermission, string>> = {
  chat: '对话准入',
  wikiRead: '知识库读取',
  wikiWrite: '知识库写入',
  codeWrite: '代码改动',
}

/** `对话准入 · 知识库读取` list of the switches one user holds, `管理员（全部权限）`, or `（全部关闭）`. */
function permissionSummary(record: AccessUserRecord): string {
  if (record.admin) return '管理员（全部权限）'
  const held = ACCESS_PERMISSIONS.filter(permission => record[permission]).map(permission => PERMISSION_LABELS[permission])
  return held.length === 0 ? '（全部关闭）' : held.join(' · ')
}

/** One access-table user as the panel shows it. */
function userWire(record: AccessUserRecord): AccessUserWire {
  return {
    userId: record.userId,
    ...(record.name === undefined ? {} : { name: record.name }),
    source: record.source,
    addedAt: record.addedAt,
    admin: record.admin,
    chat: record.chat,
    wikiRead: record.wikiRead,
    wikiWrite: record.wikiWrite,
    codeWrite: record.codeWrite,
    ...(record.gitEmail === undefined ? {} : { gitEmail: record.gitEmail }),
  }
}

/**
 * Trim + validate one panel-supplied user id: at most 128 characters, no
 * control characters, and a Feishu `user_id`.
 */
function cleanUserId(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '' || value.length > 128) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined
  return FEISHU_USER_ID_PATTERN.test(value) ? value : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface AccessAdminDeps {
  config(): FeishuConfig
  store: AccessStore
  /** Whether the storage domain holding the tables is open. */
  loaded(): boolean
  /** Authorization requests, while the channel runs. */
  requests(): AccessRequests | undefined
  delivery: CardDelivery
  /** The bot's open_id, so `/auth` never targets the bot itself. */
  botOpenId(): string | undefined
  isAdmin(userId: string): boolean
  warn(message: string, ...args: unknown[]): void
}

/** Panel and `/auth` access administration. */
export class AccessAdmin {
  constructor(private readonly deps: AccessAdminDeps) {}

  /** @returns the user table, groups, and pending requests as the panel shows them. */
  snapshot(): AccessWire {
    const { store } = this.deps
    return {
      mode: this.deps.config().accessMode,
      // The user table lives in the storage domain, which is only open while the
      // channel runs; an unconnected panel must not present them as empty.
      loaded: this.deps.loaded(),
      users: store.userRecords().map(userWire),
      groups: store.groupRecords().map(record => ({
        chatId: record.chatId,
        ...(record.name === undefined ? {} : { name: record.name }),
        addedAt: record.addedAt,
        wikiRead: record.wikiRead,
        wikiWrite: record.wikiWrite,
        codeWrite: record.codeWrite,
      })),
      requests: store.pendingRequests().map(record => {
        const wire: AccessRequestWire = {
          token: record.token,
          targetId: record.targetId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        }
        if (record.requesterName !== undefined) wire.name = record.requesterName
        if (record.chatId !== undefined) wire.chatId = record.chatId
        if (record.groupName !== undefined) wire.groupName = record.groupName
        return wire
      }),
    }
  }

  /**
   * Add one user with only `chat` on, or turn `chat` back on for a user
   * already in the table.
   * @param userId - Feishu user_id.
   * @param name - optional display name for a new record.
   * @returns the refreshed snapshot, or the failure.
   */
  async addUser(userId: string, name?: string): Promise<AccessMutationResponse> {
    const id = cleanUserId(userId)
    if (id === undefined) return { ok: false, error: 'user_id 不合法（只能包含字母、数字、_ 和 -，不是 ou_ 开头的 open_id）' }
    return this.mutate('写入授权失败', () => this.grantChat(id, name?.trim(), 'panel', 'panel'))
  }

  /**
   * Remove one user (and every switch) from the table.
   * @param userId - Feishu user_id.
   * @returns the refreshed snapshot, or the failure.
   */
  async removeUser(userId: string): Promise<AccessMutationResponse> {
    const id = cleanUserId(userId)
    if (id === undefined) return { ok: false, error: 'user_id 不合法' }
    return this.mutate('撤销授权失败', () => this.deps.store.removeUser(id))
  }

  /**
   * Set the administrator flag or one permission switch of a user already in
   * the table. The panel may remove the last administrator; it is also the
   * way to add one back.
   * @param userId - Feishu user_id.
   * @param permission - the flag or switch.
   * @param enabled - new value.
   * @returns the refreshed snapshot, or the failure.
   */
  async setPermission(userId: string, permission: AccessSwitch, enabled: boolean): Promise<AccessMutationResponse> {
    const id = cleanUserId(userId)
    if (id === undefined) return { ok: false, error: 'user_id 不合法' }
    return this.mutate('写入授权失败', async () => {
      const updated = await this.deps.store.setPermission(id, permission, enabled)
      return updated === undefined ? '该用户不在用户表中，请先添加' : undefined
    })
  }

  /**
   * Set or clear the git email of a user already in the table.
   * @param userId - Feishu user_id.
   * @param gitEmail - validated email, or undefined to clear it.
   * @returns the refreshed snapshot, or the failure.
   */
  async setGitEmail(userId: string, gitEmail: string | undefined): Promise<AccessMutationResponse> {
    const id = cleanUserId(userId)
    if (id === undefined) return { ok: false, error: 'user_id 不合法' }
    return this.mutate('写入 Git 邮箱失败', async () => {
      const updated = await this.deps.store.setGitEmail(id, gitEmail)
      return updated === undefined ? '该用户不在用户表中，请先添加' : undefined
    })
  }

  /**
   * Set one permission switch of a registered group.
   * @param chatId - Feishu chat_id.
   * @param permission - the switch.
   * @param enabled - new value.
   * @returns the refreshed snapshot, or the failure.
   */
  async setGroupPermission(chatId: string, permission: GroupPermission, enabled: boolean): Promise<AccessMutationResponse> {
    return this.mutate('写入群权限失败', async () => {
      const updated = await this.deps.store.setGroupPermission(chatId, permission, enabled)
      return updated === undefined ? '该群还没有登记（机器人在群里开过话题后自动登记）' : undefined
    })
  }

  /**
   * Delete one group's permission record.
   * @param chatId - Feishu chat_id.
   * @returns the refreshed snapshot, or the failure.
   */
  async removeGroup(chatId: string): Promise<AccessMutationResponse> {
    return this.mutate('移除群失败', () => this.deps.store.removeGroup(chatId))
  }

  /**
   * Decide one pending authorization request (same path as the card).
   * @param token - the request token.
   * @param decision - allow or deny.
   * @returns the refreshed snapshot, or the failure.
   */
  async resolveRequest(token: string, decision: 'allow' | 'deny'): Promise<AccessMutationResponse> {
    const requests = this.deps.requests()
    if (requests === undefined) return { ok: false, error: '授权服务尚未启动' }
    return this.mutate('处理授权申请失败', async () => {
      const result = await requests.resolve(token, decision, { kind: 'panel' })
      return result.ok ? undefined : result.error
    })
  }

  /**
   * `/auth`: administrator-only management of the user table on the channel
   * plane. It never creates a Session or resumes an Agent; every reply is a
   * fixed card. A non-administrator gets no reply.
   * @param msg - the command message.
   * @param parsed - the parsed command.
   */
  async runCommand(msg: NormalizedMessage, parsed: ParsedSlashCommand): Promise<void> {
    const { store, delivery } = this.deps
    if (!this.deps.isAdmin(msg.senderId)) return
    const direct = { createThread: false }
    const words = parsed.rawInput.trim().split(/\s+/u).filter(word => word !== '')
    const action = words[0] ?? 'status'
    const reply = (kind: 'success' | 'unavailable' | 'input-error', text: string): Promise<void> =>
      delivery.commandCard(msg, { kind, command: 'auth', text }, direct)
    try {
      if (action === 'status') {
        const users = store.userRecords()
        const members = users.filter(user => !user.admin)
        const count = (permission: AccessPermission): number => members.filter(user => user.chat && user[permission]).length
        const admins = users.filter(user => user.admin).map(user => `${user.name ?? user.userId} \`${user.userId}\``)
        await delivery.standaloneReply(msg, standaloneInfoCard('**🔐 访问授权状态**', [
          `**准入模式**：\`${this.deps.config().accessMode}\``,
          `**管理员（${admins.length}）**：${admins.join('、')}`,
          `**其他用户**：${members.length} 人 · 对话准入 ${count('chat')} · 知识库读取 ${count('wikiRead')} · 知识库写入 ${count('wikiWrite')} · 代码改动 ${count('codeWrite')}`,
          `**待处理申请**：${store.pendingRequests().length} 个`,
          '添加：`/auth add @用户`；开关：`/auth set <chat|wiki-read|wiki-write|code> <on|off> @用户`；移除：`/auth remove @用户`。管理员只能在 Web 设置面板设置。',
        ]), direct)
        return
      }
      if (action === 'list') {
        const users = store.userRecords()
        const lines = users.length === 0
          ? ['（暂无）']
          : users.slice(0, 30).map(user => `- ${user.name ?? user.userId} \`${user.userId}\`：${permissionSummary(user)}`)
        await delivery.standaloneReply(msg, standaloneInfoCard('**🔐 用户表**', [
          `**用户（${users.length}）**`,
          ...lines,
          `**待处理申请**：${store.pendingRequests().length} 个（可在 Web 设置面板处理）`,
        ]), direct)
        return
      }
      const isSet = action === 'set'
      if (action !== 'add' && action !== 'remove' && !isSet) {
        await reply('input-error', AUTH_USAGE)
        return
      }
      const permission = isSet ? AUTH_SWITCHES[words[1] ?? ''] : undefined
      const state = isSet ? words[2] : undefined
      if (isSet && (permission === undefined || (state !== 'on' && state !== 'off'))) {
        await reply('input-error', AUTH_USAGE)
        return
      }
      const target = resolveAuthUserTarget(words.slice(isSet ? 3 : 1).join(' '), msg.mentions, this.deps.botOpenId())
      if (!target.ok) {
        await reply('input-error', target.reason === 'usage' ? AUTH_USAGE : AUTH_USER_TARGET_ERRORS[target.reason])
        return
      }
      const { userId } = target
      const label = target.name === undefined ? `\`${userId}\`` : `${target.name}（\`${userId}\`）`
      // Administrators are granted and removed only in the Web panel.
      if (action === 'remove' && store.isAdmin(userId)) {
        await reply('unavailable', `${label} 是管理员，只能在 Web 设置面板取消管理员或移出用户表。`)
        return
      }
      if (action === 'add') {
        await this.grantChat(userId, target.name, 'command', msg.senderId)
        await reply('success', `✅ 已把 ${label} 加入用户表并打开对话准入：可以私聊，也可以在任何群里 @ 我。`)
        return
      }
      if (action === 'remove') {
        const removed = await store.removeUser(userId)
        await reply(removed ? 'success' : 'unavailable', removed ? `已把 ${label} 移出用户表，立即生效。` : `用户 ${label} 不在用户表中。`)
        return
      }
      const updated = await store.setPermission(userId, permission!, state === 'on')
      if (updated === undefined) {
        await reply('unavailable', `用户 ${label} 不在用户表中，请先 /auth add。`)
        return
      }
      await reply('success', `已${state === 'on' ? '打开' : '关闭'} ${label} 的「${PERMISSION_LABELS[permission!]}」。当前：${permissionSummary(updated)}。`)
    } catch (error) {
      this.deps.warn('dsh-channels: /auth failed: %s', String(error))
      await reply('unavailable', `授权操作失败：${messageOf(error)}`).catch(() => {})
    }
  }

  /**
   * Run one panel mutation: a returned string is a refusal, a throw a
   * failure prefixed with `failure`; otherwise answer the refreshed snapshot.
   */
  private async mutate(failure: string, write: () => Promise<unknown>): Promise<AccessMutationResponse> {
    try {
      const refusal = await write()
      if (typeof refusal === 'string') return { ok: false, error: refusal }
      return { ok: true, access: this.snapshot() }
    } catch (error) {
      return { ok: false, error: `${failure}：${messageOf(error)}` }
    }
  }

  /** Add a user with only `chat` on, or turn `chat` on for an existing record. */
  private async grantChat(userId: string, name: string | undefined, source: AccessUserRecord['source'], admin: string): Promise<void> {
    await this.deps.store.grantChat({
      userId,
      ...(name === undefined || name === '' ? {} : { name }),
      source,
      addedBy: admin,
      addedAt: Date.now(),
      admin: false,
      chat: true,
      wikiRead: false,
      wikiWrite: false,
      codeWrite: false,
    })
  }
}
