/**
 * 「访问授权」tab：待处理申请（有才显示，置顶）、准入字段（调试模式 /
 * 管理员 / 申请有效期）与群、用户白名单。字段保存走全局 draft，白名单增删
 * 与申请处理是独立即时 mutation。
 *
 * `access.loaded === false`（飞书未连接、插件 storage 域未打开）时白名单与
 * 申请列表是「未知」而不是「空」，因此只渲染连接提示并禁用全部写操作。
 *
 * @module dsh-channels/client/panel/access-tab
 */

import { fillCopy, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type { AccessWire } from '../../settings/contract.ts'
import { Avatar } from '../avatar.tsx'
import type { ProfileView } from './profiles.ts'
import { FieldSections, NoticeBar, Row } from './shared.tsx'
import type { FormView } from './shared.tsx'
import { RequestList, Whitelist } from './whitelist.tsx'

export interface AccessTabProps {
  form: FormView
  profiles: ProfileView
  accessNotice: string | null
  accessError: string | null
  onAddGroup: (chatId: string, name: string) => Promise<boolean>
  onRemoveGroup: (chatId: string) => void
  onAddUser: (userId: string, name: string) => Promise<boolean>
  onRemoveUser: (userId: string) => void
  onResolveRequest: (token: string, decision: 'allow' | 'deny') => void
}

export function AccessTab(props: AccessTabProps): JSX.Element {
  const { form, profiles, accessNotice, accessError, onAddGroup, onRemoveGroup, onAddUser, onRemoveUser, onResolveRequest } = props
  const { access } = form.panel
  const working = form.busy === 'access'
  const disabled = form.busy !== null || form.locked || !access.loaded
  return (
    <div className="dsh-channels-cfg__tabBody">
      {accessNotice === null ? null : <NoticeBar kind="ok" text={accessNotice} />}
      {accessError === null ? null : <NoticeBar kind="error" text={accessError} />}
      {access.loaded && access.mode === 'guarded' && !access.admin.configured
        ? (
            <NoticeBar
              kind="error"
              text={access.admin.ownerLookupError === undefined
                ? PANEL_COPY.accessAdminMissingWarning
                : `${PANEL_COPY.accessAdminMissingWarning}（${access.admin.ownerLookupError}）`}
            />
          )
        : null}
      {profiles.warning === undefined ? null : <p className="dsh-channels-cfg__secFoot">{fillCopy(PANEL_COPY.profilesWarning, { reason: profiles.warning })}</p>}
      {access.loaded && access.requests.length > 0
        ? <RequestList requests={access.requests} profiles={profiles} disabled={disabled} working={working} onResolve={onResolveRequest} />
        : null}
      <FieldSections
        form={form}
        groups={TAB_FIELD_GROUPS.access}
        extra={{ access: <AdminRow admin={access.admin} profiles={profiles} /> }}
      />
      <Whitelist
        title={PANEL_COPY.accessGroupsTitle}
        entries={access.groups.map(group => ({
          id: group.chatId,
          name: profiles.chat(group.chatId)?.name ?? group.name,
          avatarUrl: profiles.chat(group.chatId)?.avatarUrl,
          source: group.source,
        }))}
        avatar="群"
        empty={PANEL_COPY.accessGroupsEmpty}
        loaded={access.loaded}
        addLabel={PANEL_COPY.accessAddGroup}
        idPlaceholder={PANEL_COPY.accessGroupChatIdPlaceholder}
        namePlaceholder={PANEL_COPY.accessGroupNamePlaceholder}
        disabled={disabled}
        working={working}
        onAdd={onAddGroup}
        onRemove={onRemoveGroup}
      />
      <Whitelist
        title={PANEL_COPY.accessUsersTitle}
        entries={access.users.map(user => ({
          id: user.userId,
          name: profiles.user(user.userId)?.name ?? user.name,
          avatarUrl: profiles.user(user.userId)?.avatarUrl,
          source: user.source,
        }))}
        empty={PANEL_COPY.accessUsersEmpty}
        loaded={access.loaded}
        addLabel={PANEL_COPY.accessAddUser}
        idPlaceholder={PANEL_COPY.accessUserIdPlaceholder}
        namePlaceholder={PANEL_COPY.accessUserNamePlaceholder}
        disabled={disabled}
        working={working}
        onAdd={onAddUser}
        onRemove={onRemoveUser}
      />
    </div>
  )
}

/** The effective administrator with their Feishu name and avatar; nothing while there is none. */
function AdminRow(props: { admin: AccessWire['admin']; profiles: ProfileView }): JSX.Element | null {
  const { admin, profiles } = props
  if (admin.userId === undefined) return null
  const profile = profiles.user(admin.userId)
  const name = profile?.name ?? admin.userId
  const source = admin.source === 'owner' ? PANEL_COPY.accessAdminSourceOwner : PANEL_COPY.accessAdminSourceConfig
  return (
    <Row
      leading={<Avatar text={name} url={profile?.avatarUrl} />}
      label={name}
      summary={<>{PANEL_COPY.accessAdminCurrent} · <span className="dsh-channels-cfg__mono">{admin.userId}</span> · {source}</>}
    />
  )
}
