/**
 * Live Feishu user and chat profiles (names, avatars) behind a short cache,
 * shared by the settings panel, the session-origin view, topic titles, and
 * commit trailers.
 *
 * @module dsh-channels/feishu/profiles
 */

import { FEISHU_USER_ID_PATTERN } from '../domain.ts'
import { FeishuApiError } from '../feishu-channel.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { FeishuProfilesWire, FeishuProfileWire } from '../settings/contract.ts'

/**
 * How long one resolved user or chat profile is reused. Short enough that
 * every page entry shows current Feishu data; long enough that the session
 * header and its sidebar tab opening together cost one lookup.
 */
const PROFILE_TTL_MS = 30 * 1000

/** Feishu `chat_id`s the profile lookup accepts. */
const FEISHU_CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]+$/u

/** The Feishu `code=<n> <msg>` of a failed API call, else the error text. */
export function feishuReason(error: unknown): string {
  if (error instanceof FeishuApiError) return error.detail
  return error instanceof Error ? error.message : String(error)
}

/** A name as commits record it: no `<`, `>`, or control characters, at most 80 characters. */
function commitSafe(raw: string): string | undefined {
  const name = raw.replace(/[<>]/gu, '').replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 80)
  return name === '' ? undefined : name
}

export interface ProfileDirectoryDeps {
  /** The live channel; lookups resolve nothing while it is absent. */
  channel(): FeishuChannel | undefined
  /** Name the access table recorded for a user, the commit-name fallback. */
  tableName(userId: string): string | undefined
  debug(message: string, ...args: unknown[]): void
}

/** Cached Feishu profile lookups. */
export class ProfileDirectory {
  /** Resolved profiles by `user:`/`chat:`/`member:` key; misses are kept as `{}`. */
  private readonly cache = new Map<string, { profile: FeishuProfileWire; at: number }>()

  constructor(private readonly deps: ProfileDirectoryDeps) {}

  /**
   * Live names and avatars through a {@link PROFILE_TTL_MS} cache. Ids that
   * are not Feishu `user_id`s / `chat_id`s are skipped; a disconnected
   * channel and failed lookups leave ids absent, and failures are reported in
   * `warning` and not cached.
   * @param userIds - user `user_id`s to resolve.
   * @param chatIds - chat `chat_id`s to resolve.
   * @returns the resolved profiles by id.
   */
  async lookup(userIds: readonly string[], chatIds: readonly string[]): Promise<FeishuProfilesWire> {
    const result: FeishuProfilesWire = { users: {}, chats: {} }
    const warnings: string[] = []
    const now = Date.now()
    for (const [key, cached] of this.cache) {
      if (now - cached.at >= PROFILE_TTL_MS) this.cache.delete(key)
    }
    const fresh = (key: string): FeishuProfileWire | undefined => this.cache.get(key)?.profile
    const keep = (target: Record<string, FeishuProfileWire>, id: string, profile: FeishuProfileWire): void => {
      if (profile.name !== undefined || profile.avatarUrl !== undefined) target[id] = profile
    }
    const users = [...new Set(userIds)].filter(id => FEISHU_USER_ID_PATTERN.test(id))
    const chats = [...new Set(chatIds)].filter(id => FEISHU_CHAT_ID_PATTERN.test(id))
    const missingUsers: string[] = []
    for (const id of users) {
      const cached = fresh(`user:${id}`)
      if (cached === undefined) missingUsers.push(id)
      else keep(result.users, id, cached)
    }
    const missingChats: string[] = []
    for (const id of chats) {
      const cached = fresh(`chat:${id}`)
      if (cached === undefined) missingChats.push(id)
      else keep(result.chats, id, cached)
    }
    const channel = this.deps.channel()
    if (channel === undefined) return result
    const lookups: Array<Promise<void>> = []
    if (missingUsers.length > 0 && channel.userProfiles !== undefined) {
      lookups.push(channel.userProfiles(missingUsers).then(
        (found) => {
          for (const id of missingUsers) {
            const profile = found.get(id) ?? {}
            this.cache.set(`user:${id}`, { profile, at: now })
            keep(result.users, id, profile)
          }
        },
        (error: unknown) => { warnings.push(`读取用户资料失败：${feishuReason(error)}`) },
      ))
    }
    const chatProfile = channel.chatProfile?.bind(channel)
    if (chatProfile !== undefined) {
      let chatError: string | undefined
      for (const id of missingChats) {
        lookups.push(chatProfile(id).then(
          (profile) => {
            this.cache.set(`chat:${id}`, { profile, at: now })
            keep(result.chats, id, profile)
          },
          (error: unknown) => {
            if (chatError !== undefined) return
            chatError = `读取群信息失败：${feishuReason(error)}`
            warnings.push(chatError)
          },
        ))
      }
    }
    await Promise.all(lookups)
    if (warnings.length > 0) {
      result.warning = warnings.join('；')
      this.deps.debug('dsh-channels: Feishu profile lookup: %s', result.warning)
    }
    return result
  }

  /**
   * @param userId - Feishu user_id.
   * @returns the contact name, or undefined.
   */
  async userName(userId: string): Promise<string | undefined> {
    return (await this.lookup([userId], [])).users[userId]?.name
  }

  /**
   * @param chatId - Feishu chat_id.
   * @returns the chat name, or undefined.
   */
  async groupName(chatId: string): Promise<string | undefined> {
    return (await this.lookup([], [chatId])).chats[chatId]?.name
  }

  /**
   * Chat-member-list name for a user the contact profile cannot name.
   * @param userId - Feishu user_id.
   * @param chatId - the chat whose member list to read.
   * @returns the member name, or undefined.
   */
  async memberName(userId: string, chatId: string): Promise<string | undefined> {
    const key = `member:${chatId}:${userId}`
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile.name
    const name = await this.deps.channel()?.memberName?.(userId, chatId)
    this.cache.set(key, { profile: name === undefined ? {} : { name }, at: Date.now() })
    return name
  }

  /**
   * Name of a Feishu user as commits record it: the contact name, else the
   * name in the access table, without `<`, `>`, or control characters, cut to
   * 80 characters.
   * @param userId - Feishu user_id.
   * @returns the name, or undefined when neither source has one.
   */
  async commitUserName(userId: string): Promise<string | undefined> {
    return commitSafe((await this.userName(userId)) ?? this.deps.tableName(userId) ?? '')
  }

  /**
   * Name of a group as commits record it (same cleaning as {@link commitUserName}).
   * @param chatId - Feishu chat_id.
   * @returns the name, or undefined when the profile has none.
   */
  async commitChatName(chatId: string): Promise<string | undefined> {
    return commitSafe((await this.groupName(chatId)) ?? '')
  }
}
