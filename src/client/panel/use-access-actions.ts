/**
 * 用户表与群权限页的写操作：增删用户 / 群、切换权限、设置 git 邮箱、处理申请。
 * 每个写操作替换嵌入的访问快照，并在访问页自己的提示行里报告结果。
 *
 * @module dsh-channels/client/panel/use-access-actions
 */

import { useCallback, useState } from 'react'
import { PANEL_COPY } from '../../settings/contract.ts'
import type { AccessMutationResponse, AccessPermissionWire, GroupPermissionWire } from '../../settings/contract.ts'
import {
  addAccessUser,
  removeAccessGroup,
  removeAccessUser,
  resolveAccessRequest,
  setAccessGitEmail,
  setAccessPermission,
  setGroupPermission,
} from '../api.ts'
import type { PanelOps } from './actions.ts'
import { messageOf } from './shared.tsx'

/** Access writes and their result line. */
export interface AccessActions {
  notice: string | null
  error: string | null
  /** Clear the result line. */
  reset: () => void
  /** Resolves true when the input should clear. */
  addUser: (userId: string, name: string) => Promise<boolean>
  removeUser: (userId: string) => Promise<boolean>
  removeGroup: (chatId: string) => Promise<boolean>
  togglePermission: (userId: string, permission: AccessPermissionWire, enabled: boolean) => Promise<boolean>
  toggleGroupPermission: (chatId: string, permission: GroupPermissionWire, enabled: boolean) => Promise<boolean>
  /** Resolves true when the editor should close. */
  setGitEmail: (userId: string, gitEmail: string) => Promise<boolean>
  resolveRequest: (token: string, decision: 'allow' | 'deny') => Promise<boolean>
}

/**
 * Own the access pages' writes.
 * @param ops - the page-shell setters.
 * @returns the writes and the result line.
 */
export function useAccessActions(ops: PanelOps): AccessActions {
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { setBusy, applyAccess } = ops

  /** Run one access write; resolves whether it succeeded. */
  const run = useCallback(async (call: () => Promise<AccessMutationResponse>, done: string): Promise<boolean> => {
    setBusy('access')
    setError(null)
    setNotice(null)
    try {
      const result = await call()
      if (!result.ok) {
        setError(result.error)
        return false
      }
      applyAccess(result.access)
      setNotice(done)
      return true
    } catch (thrown) {
      setError(messageOf(thrown))
      return false
    } finally {
      setBusy(null)
    }
  }, [applyAccess, setBusy])

  const reset = useCallback((): void => {
    setNotice(null)
    setError(null)
  }, [])

  return {
    notice,
    error,
    reset,
    addUser: (userId, name) => run(() => addAccessUser(userId, name), PANEL_COPY.accessUserAdded),
    removeUser: userId => run(() => removeAccessUser(userId), PANEL_COPY.accessUserRemoved),
    removeGroup: chatId => run(() => removeAccessGroup(chatId), PANEL_COPY.groupRemoved),
    togglePermission: (userId, permission, enabled) =>
      run(() => setAccessPermission(userId, permission, enabled), PANEL_COPY.accessPermissionChanged),
    toggleGroupPermission: (chatId, permission, enabled) =>
      run(() => setGroupPermission(chatId, permission, enabled), PANEL_COPY.groupPermissionChanged),
    setGitEmail: (userId, gitEmail) => run(() => setAccessGitEmail(userId, gitEmail), PANEL_COPY.accessGitEmailChanged),
    resolveRequest: (token, decision) => run(
      () => resolveAccessRequest(token, decision),
      decision === 'allow' ? PANEL_COPY.accessRequestAllowed : PANEL_COPY.accessRequestDenied,
    ),
  }
}
