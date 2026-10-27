/**
 * Tabs made only of Host fields (「会话」「模型」「附件与工具」): one titled
 * section per field group the tab owns (`TAB_FIELD_GROUPS`).
 *
 * @module dsh-channels/client/panel/fields-tab
 */

import type { ReactNode } from 'react'
import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type { FieldGroup, PanelTabId } from '../../settings/contract.ts'
import { FieldSections } from './shared.tsx'
import type { FormView } from './shared.tsx'

/** Footnotes under one group's section, per group. */
const FOOTNOTES: Partial<Record<FieldGroup, ReactNode>> = {
  model: PANEL_COPY.modelFootnote,
}

export function FieldsTab(props: { form: FormView; tab: PanelTabId; note?: string }): JSX.Element {
  const { form, tab, note } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      {note === undefined ? null : <p className="dsh-channels-cfg__secFoot">{note}</p>}
      <FieldSections form={form} groups={TAB_FIELD_GROUPS[tab]} footnotes={FOOTNOTES} />
    </div>
  )
}
