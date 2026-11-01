/**
 * 「知识库」tab：知识库工具字段（读取 / 编辑开关、可访问范围）与谁能用的
 * 汇总。按人授予读取 / 写入在「访问授权」tab 的用户表里完成。
 *
 * @module dsh-channels/client/panel/wiki-tab
 */

import { fillCopy, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type { ProfileView } from './profiles.ts'
import { EmptyRow, FieldSections, Section } from './shared.tsx'
import type { FormView } from './shared.tsx'

export interface WikiTabProps {
  form: FormView
  profiles: ProfileView
}

export function WikiTab(props: WikiTabProps): JSX.Element {
  const { form, profiles } = props
  const { access } = form.panel
  const active = access.users.filter(user => user.chat)
  return (
    <div className="dsh-channels-cfg__tabBody">
      {profiles.warning === undefined ? null : <p className="dsh-channels-cfg__secFoot">{fillCopy(PANEL_COPY.profilesWarning, { reason: profiles.warning })}</p>}
      <FieldSections form={form} groups={TAB_FIELD_GROUPS.wiki} />
      <Section title={PANEL_COPY.wikiUsersTitle} footnote={PANEL_COPY.wikiUsersHint}>
        <EmptyRow
          text={access.loaded
            ? fillCopy(PANEL_COPY.wikiUsersSummary, {
                read: active.filter(user => user.wikiRead).length,
                write: active.filter(user => user.wikiWrite).length,
              })
            : PANEL_COPY.accessNotLoaded}
        />
      </Section>
    </div>
  )
}
