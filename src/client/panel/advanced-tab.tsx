/**
 * 「高级」tab：SDK 日志级别与 Web 覆盖文件（「恢复 profile 配置」删除整个
 * 覆盖层，不走 draft）。
 *
 * @module dsh-channels/client/panel/advanced-tab
 */

import { fillCopy, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { FieldSections, Row, Section } from './shared.tsx'
import type { FormView } from './shared.tsx'

export function AdvancedTab(props: {
  form: FormView
  onClear: () => void
}): JSX.Element {
  const { form, onClear } = props
  const { panel, busy, locked } = form
  const overridden = panel.config.overriddenKeys.length
  return (
    <div className="dsh-channels-cfg__tabBody">
      <FieldSections form={form} groups={TAB_FIELD_GROUPS.advanced} />
      <Section title={PANEL_COPY.overlayTitle}>
        <Row
          label={PANEL_COPY.overlayPath}
          summary={<span className="dsh-channels-cfg__mono">{panel.status.overlayPath}</span>}
          details={(
            <>
              {PANEL_COPY.overlayPathHelp}
              {' '}
              {overridden === 0 ? PANEL_COPY.noOverrides : fillCopy(PANEL_COPY.overlayCount, { n: overridden })}
            </>
          )}
          control={(
            <button
              type="button"
              className="dsh-channels-cfg__btn dsh-channels-cfg__btn--danger"
              onClick={onClear}
              disabled={overridden === 0 || busy !== null || locked}
            >
              {busy === 'clear' ? PANEL_COPY.clearing : PANEL_COPY.clear}
            </button>
          )}
        />
      </Section>
    </div>
  )
}
