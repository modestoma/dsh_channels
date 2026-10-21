/**
 * 「工作区」tab：工作区根目录字段与保存栏。
 *
 * @module dsh-channels/client/panel/workspace-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { FormView } from './shared.tsx'

export interface WorkspaceTabProps {
  form: FormView
}

export function WorkspaceTab(props: WorkspaceTabProps): JSX.Element {
  const { form } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.workspaceTabHelp} />
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.workspace} />
      <SaveBar form={form} tab="workspace" />
    </div>
  )
}
