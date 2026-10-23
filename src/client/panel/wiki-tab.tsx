/**
 * 「知识库」tab：知识库工具字段表单（读取/写入开关、知识库范围）+ 知识库
 * 白名单卡。表单保存走全局 draft，白名单增删是独立即时 mutation。
 *
 * @module dsh-channels/client/panel/wiki-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { UserWhitelist } from './access-card.tsx'
import { EmptyState, FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { FormView } from './shared.tsx'

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
      <TabHelp text={PANEL_COPY.wikiTabHelp} />
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.wiki} />
      <SaveBar form={form} tab="wiki" />
      <section className="dsh-channels-cfg__card">
        <div className="dsh-channels-cfg__cardHead">
          <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.wikiUsersCard}</span>
        </div>
        <span className="dsh-channels-cfg__help">{PANEL_COPY.wikiUsersHelp}</span>
        {!access.loaded
          ? <EmptyState text={PANEL_COPY.accessNotLoaded} />
          : (
              <UserWhitelist
                title={PANEL_COPY.wikiUsersCard}
                empty={PANEL_COPY.wikiUsersEmpty}
                addLabel={PANEL_COPY.accessAddUser}
                users={access.wikiUsers}
                disabled={disabled}
                working={form.busy === 'access'}
                onAdd={onAddUser}
                onRemove={onRemoveUser}
              />
            )}
        {accessNotice === null
          ? null
          : (
              <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--ok" role="status" aria-live="polite">
                <span>{accessNotice}</span>
              </div>
            )}
        {accessError === null
          ? null
          : <span className="dsh-channels-cfg__fieldError" role="alert">{accessError}</span>}
      </section>
    </div>
  )
}
