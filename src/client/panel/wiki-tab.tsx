/**
 * 「知识库」tab：知识库工具字段（读取 / 编辑开关、可访问范围）+ 知识库
 * 白名单（「可使用的人」）。字段保存走全局 draft，白名单增删是独立即时
 * mutation。
 *
 * @module dsh-channels/client/panel/wiki-tab
 */

import { fillCopy, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { FieldSections, NoticeBar } from './shared.tsx'
import type { FormView } from './shared.tsx'
import { Whitelist } from './whitelist.tsx'

export interface WikiTabProps {
  form: FormView
  accessNotice: string | null
  accessError: string | null
  onAddUser: (userId: string, name: string) => Promise<boolean>
  onRemoveUser: (userId: string) => void
}

export function WikiTab(props: WikiTabProps): JSX.Element {
  const { form, accessNotice, accessError, onAddUser, onRemoveUser } = props
  const { access } = form.panel
  const disabled = form.busy !== null || form.locked || !access.loaded
  return (
    <div className="dsh-channels-cfg__tabBody">
      {accessNotice === null ? null : <NoticeBar kind="ok" text={accessNotice} />}
      {accessError === null ? null : <NoticeBar kind="error" text={accessError} />}
      <FieldSections form={form} groups={TAB_FIELD_GROUPS.wiki} />
      <Whitelist
        title={PANEL_COPY.wikiUsersTitle}
        countLabel={fillCopy(PANEL_COPY.wikiUsersAdminPlus, { n: access.wikiUsers.length })}
        entries={access.wikiUsers.map(user => ({ id: user.userId, name: user.name, source: user.source }))}
        empty={PANEL_COPY.wikiUsersEmpty}
        loaded={access.loaded}
        addLabel={PANEL_COPY.accessAddUser}
        idPlaceholder={PANEL_COPY.accessUserIdPlaceholder}
        namePlaceholder={PANEL_COPY.accessUserNamePlaceholder}
        footnote={PANEL_COPY.wikiUsersHint}
        disabled={disabled}
        working={form.busy === 'access'}
        onAdd={onAddUser}
        onRemove={onRemoveUser}
      />
    </div>
  )
}
