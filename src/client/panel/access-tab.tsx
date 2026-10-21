/**
 * 「访问授权」tab：准入与授权字段表单（管理员 user_id / 准入模式 /
 * 申请有效期）+ 白名单与待处理申请卡。表单保存走全局 draft，白名单
 * 增删是独立即时 mutation。
 *
 * @module dsh-channels/client/panel/access-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { AccessCard } from './access-card.tsx'
import { FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { FormView } from './shared.tsx'

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
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.accessTabHelp} />
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.access} />
      <SaveBar form={form} tab="access" />
      <AccessCard
        panel={form.panel}
        busy={form.busy}
        locked={form.locked}
        notice={accessNotice}
        error={accessError}
        onAddGroup={onAddGroup}
        onRemoveGroup={onRemoveGroup}
        onAddUser={onAddUser}
        onRemoveUser={onRemoveUser}
        onResolveRequest={onResolveRequest}
      />
    </div>
  )
}
