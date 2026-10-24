/**
 * Live Feishu names and avatars for every user and chat the access and wiki
 * tabs show. The page asks the Host once on entry and again whenever the set
 * of shown ids changes; a failed request keeps the previous answer.
 *
 * @module dsh-channels/client/panel/profiles
 */

import { useEffect, useMemo, useState } from 'react'
import type { AccessWire, FeishuProfilesWire, FeishuProfileWire } from '../../settings/contract.ts'
import { fetchFeishuProfiles } from '../api.ts'

/** Resolved profiles plus the reason some could not be read. */
export interface ProfileView {
  user: (userId: string) => FeishuProfileWire | undefined
  chat: (chatId: string) => FeishuProfileWire | undefined
  /** Feishu or request failure reason, when one lookup failed. */
  warning?: string
}

/**
 * The `user_id`s and `chat_id`s one access snapshot shows.
 * @param access - the panel's access snapshot.
 * @returns sorted, distinct ids per kind.
 */
export function profileIds(access: AccessWire): { users: string[]; chats: string[] } {
  const users = new Set<string>()
  const chats = new Set<string>()
  if (access.admin.userId !== undefined) users.add(access.admin.userId)
  for (const user of access.users) users.add(user.userId)
  for (const user of access.wikiUsers) users.add(user.userId)
  for (const group of access.groups) chats.add(group.chatId)
  for (const request of access.requests) {
    if (request.kind === 'user') users.add(request.targetId)
    else chats.add(request.targetId)
    if (request.chatId !== undefined) chats.add(request.chatId)
  }
  return { users: [...users].sort(), chats: [...chats].sort() }
}

/**
 * Profiles for one access snapshot; empty until the panel has loaded.
 * @param access - the panel's access snapshot, null while loading.
 * @returns lookups by id and the latest failure reason.
 */
export function useFeishuProfiles(access: AccessWire | null): ProfileView {
  const ids = useMemo(() => (access === null ? { users: [], chats: [] } : profileIds(access)), [access])
  const key = `${ids.users.join(',')}|${ids.chats.join(',')}`
  const [answer, setAnswer] = useState<FeishuProfilesWire>({ users: {}, chats: {} })
  const [requestError, setRequestError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (ids.users.length === 0 && ids.chats.length === 0) return
    let current = true
    fetchFeishuProfiles(ids.users, ids.chats).then(
      (next) => {
        if (!current) return
        setAnswer(next)
        setRequestError(undefined)
      },
      (error: unknown) => { if (current) setRequestError(error instanceof Error ? error.message : String(error)) },
    )
    return () => { current = false }
    // `key` carries `ids`: a new snapshot with the same ids does not re-ask.
  }, [key])
  return useMemo(() => {
    const warning = requestError ?? answer.warning
    return {
      user: (userId: string) => answer.users[userId],
      chat: (chatId: string) => answer.chats[chatId],
      ...(warning === undefined ? {} : { warning }),
    }
  }, [answer, requestError])
}
