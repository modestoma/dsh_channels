/**
 * 「高级」tab：流式刷新等低层字段 + 只读部署信息（overlayPath / version /
 * 部署级参数）+ 「清除 Web 覆盖」。清除覆盖是整体动作，不走 draft。
 *
 * @module dsh-channels/client/panel/advanced-tab
 */

import { PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type { PanelWire } from '../../settings/contract.ts'
import { FieldsCard, SaveBar, TabHelp } from './shared.tsx'
import type { BusyAction, FormView } from './shared.tsx'

export function AdvancedTab(props: { form: FormView; onClear: () => void }): JSX.Element {
  const { form, onClear } = props
  return (
    <div className="dsh-channels-cfg__tabBody">
      <TabHelp text={PANEL_COPY.advancedTabHelp} />
      <FieldsCard form={form} groups={TAB_FIELD_GROUPS.advanced} />
      <SaveBar form={form} tab="advanced" />
      <AdvancedCard panel={form.panel} busy={form.busy} locked={form.locked} onClear={onClear} />
    </div>
  )
}

/** Read-only deployment facts; the only write action here drops the overlay file. */
function AdvancedCard(props: {
  panel: PanelWire
  busy: BusyAction | null
  locked: boolean
  onClear: () => void
}): JSX.Element {
  const { panel, busy, locked, onClear } = props
  const { readOnly } = panel.config
  const overridden = panel.config.overriddenKeys.length
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.advancedCard}</span>
        <span className="dsh-channels-cfg__cardMeta">
          {overridden === 0 ? PANEL_COPY.inherited : `${PANEL_COPY.overridden} ${overridden} 项`}
        </span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.advancedHelp}</span>
      <div className="dsh-channels-cfg__labelRow">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.readOnlyCard}</span>
      </div>
      <div className="dsh-channels-cfg__readOnly">
        {readOnly.map(field => (
          <div className="dsh-channels-cfg__kv" key={field.key}>
            <span className="dsh-channels-cfg__kvKey">{field.label}</span>
            <span className="dsh-channels-cfg__kvValue">{field.value}</span>
            {field.help === undefined ? null : <span className="dsh-channels-cfg__help">{field.help}</span>}
          </div>
        ))}
        <div className="dsh-channels-cfg__kv">
          <span className="dsh-channels-cfg__kvKey">{PANEL_COPY.overlayPath}</span>
          <span className="dsh-channels-cfg__kvValue dsh-channels-cfg__mono">{panel.status.overlayPath}</span>
          <span className="dsh-channels-cfg__help">{PANEL_COPY.overlayPathHelp}</span>
        </div>
        <div className="dsh-channels-cfg__kv">
          <span className="dsh-channels-cfg__kvKey">{PANEL_COPY.version}</span>
          <span className="dsh-channels-cfg__kvValue dsh-channels-cfg__mono">{panel.status.version}</span>
        </div>
      </div>
      <div className="dsh-channels-cfg__actions">
        <button
          type="button"
          className="dsh-channels-cfg__btn"
          onClick={onClear}
          disabled={overridden === 0 || busy !== null || locked}
        >
          {busy === 'clear' ? PANEL_COPY.clearing : PANEL_COPY.clear}
        </button>
        <span className="dsh-channels-cfg__help">
          {overridden === 0 ? PANEL_COPY.noOverrides : `${PANEL_COPY.overridden} ${overridden} 项`}
        </span>
      </div>
    </section>
  )
}
