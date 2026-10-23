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
import { FieldSections, NoticeBar } from './shared.tsx'
import type { FormView } from './shared.tsx'
import { RequestList, Whitelist } from './whitelist.tsx'

export interface AccessTabProps {
  form: FormView
  accessNotice: string | null
  accessError: string | null
  onAddGroup: (chatId: string, name: string) => Promise<boolean>
  onRemoveGroup: (chatId: string) => void
  onAddUser: (userId: string, name: string) => Promise<boolean>
  onRemoveUser: (userId: string) => void
  onResolveRequest: (token: string, decision: 'allow' | 'deny') => void
}

export function AccessTab(props: AccessTabProps): JSX.Element {
  const { form, accessNotice, accessError, onAddGroup, onRemoveGroup, onAddUser, onRemoveUser, onResolveRequest } = props
  const { access } = form.panel
  const working = form.busy === 'access'
  const disabled = form.busy !== null || form.locked || !access.loaded
  // The administrator row says who is in charge right now when the owner fallback applies.
  const ownerAdmin = access.mode === 'guarded' && access.admin.source === 'owner' ? access.admin.userId : undefined
  const fields = ownerAdmin === undefined
    ? form.fields
    : form.fields.map(field => field.key === 'adminUserId'
      ? { ...field, summary: fillCopy(PANEL_COPY.accessAdminOwnerSummary, { id: ownerAdmin }) }
      : field)
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
      {access.loaded && access.requests.length > 0
        ? <RequestList requests={access.requests} disabled={disabled} working={working} onResolve={onResolveRequest} />
        : null}
      <FieldSections form={{ ...form, fields }} groups={TAB_FIELD_GROUPS.access} />
      <Whitelist
        title={PANEL_COPY.accessGroupsTitle}
        entries={access.groups.map(group => ({ id: group.chatId, name: group.name, source: group.source }))}
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
        entries={access.users.map(user => ({ id: user.userId, name: user.name, source: user.source }))}
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
