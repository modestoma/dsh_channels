/**
 * 「工作区」tab：工作区根目录 / 过期保留策略 / 自动清理字段 + 工作区清理卡。
 * 表单保存栏在字段卡正下方，清理卡（独立动作，不走 draft）在其后。
 *
 * @module dsh-channels/client/panel/workspace-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type { CleanupPreviewWire, CleanupRunWire } from '../../settings/contract.ts'
import { CleanupCard } from './cleanup-card.tsx'
import { FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { FormView } from './shared.tsx'

export interface WorkspaceTabProps {
  form: FormView
  cleanup: CleanupPreviewWire
  cleanupResult: CleanupRunWire | null
  cleanupError: string | null
  onRunCleanup: () => void
}

export function WorkspaceTab(props: WorkspaceTabProps): JSX.Element {
  const { form, cleanup, cleanupResult, cleanupError, onRunCleanup } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.workspaceTabHelp} />
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.workspace} />
      <SaveBar form={form} tab="workspace" />
      <CleanupCard
        panel={form.panel}
        cleanup={cleanup}
        busy={form.busy}
        locked={form.locked}
        result={cleanupResult}
        error={cleanupError}
        onRun={onRunCleanup}
      />
    </div>
  )
}
