/**
 * 「访问授权」tab：待处理申请（有才显示，置顶）、准入字段（调试模式 /
 * 申请有效期）与用户表（管理员是用户表里打开「管理员」的用户）。字段保存
 * 走全局 draft，用户表增删、开关与申请处理是独立即时 mutation。
 *
 * `access.loaded === false`（飞书未连接、插件 storage 域未打开）时用户表与
 * 申请列表是「未知」而不是「空」，因此只渲染连接提示并禁用全部写操作。
 *
 * @module dsh-channels/client/panel/access-tab
 */

import { fillCopy, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type { AccessPermissionWire } from '../../settings/contract.ts'
import type { ProfileView } from './profiles.ts'
import { FieldSections, NoticeBar } from './shared.tsx'
import type { FormView } from './shared.tsx'
import { RequestList, UserTable } from './whitelist.tsx'

export interface AccessTabProps {
  form: FormView
  profiles: ProfileView
  accessNotice: string | null
  accessError: string | null
  onAddUser: (userId: string, name: string) => Promise<boolean>
  onRemoveUser: (userId: string) => void
  onTogglePermission: (userId: string, permission: AccessPermissionWire, enabled: boolean) => void
  onSetGitEmail: (userId: string, gitEmail: string) => Promise<boolean>
  onResolveRequest: (token: string, decision: 'allow' | 'deny') => void
}

export function AccessTab(props: AccessTabProps): JSX.Element {
  const { form, profiles, accessNotice, accessError, onAddUser, onRemoveUser, onTogglePermission, onSetGitEmail, onResolveRequest } = props
  const { access } = form.panel
  const working = form.busy === 'access'
  const disabled = form.busy !== null || form.locked || !access.loaded
  return (
    <div className="dsh-channels-cfg__tabBody">
      {accessNotice === null ? null : <NoticeBar kind="ok" text={accessNotice} />}
      {accessError === null ? null : <NoticeBar kind="error" text={accessError} />}
      {access.loaded && access.mode === 'guarded' && !access.users.some(user => user.admin)
        ? <NoticeBar kind="error" text={PANEL_COPY.accessAdminMissingWarning} />
        : null}
      {profiles.warning === undefined ? null : <p className="dsh-channels-cfg__secFoot">{fillCopy(PANEL_COPY.profilesWarning, { reason: profiles.warning })}</p>}
      {access.loaded && access.requests.length > 0
        ? <RequestList requests={access.requests} profiles={profiles} disabled={disabled} working={working} onResolve={onResolveRequest} />
        : null}
      <FieldSections form={form} groups={TAB_FIELD_GROUPS.access} />
      <UserTable
        entries={access.users.map(user => ({
          user,
          name: profiles.user(user.userId)?.name ?? user.name,
          avatarUrl: profiles.user(user.userId)?.avatarUrl,
        }))}
        loaded={access.loaded}
        disabled={disabled}
        working={working}
        onAdd={onAddUser}
        onRemove={onRemoveUser}
        onToggle={onTogglePermission}
        onSetGitEmail={onSetGitEmail}
      />
    </div>
  )
}
