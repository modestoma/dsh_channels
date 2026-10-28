/**
 * 「高级」tab：日志分析接口（开关 + 访问令牌凭据行）、SDK 日志级别
 * 与 Web 覆盖文件（「恢复 profile 配置」删除整个覆盖层，不走 draft）。
 *
 * @module dsh-channels/client/panel/advanced-tab
 */

import { fillCopy, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import { CredentialRow } from './credentials-card.tsx'
import { FieldSections, Row, Section } from './shared.tsx'
import type { AnalyzeTokenView, FormView } from './shared.tsx'

export function AdvancedTab(props: {
  form: FormView
  analyzeToken: AnalyzeTokenView
  onClear: () => void
}): JSX.Element {
  const { form, analyzeToken, onClear } = props
  const { panel, busy, locked } = form
  const tokenState = panel.config.credentials.analyzeToken
  const overridden = panel.config.overriddenKeys.length
  return (
    <div className="dsh-channels-cfg__tabBody">
      <FieldSections
        form={form}
        groups={TAB_FIELD_GROUPS.advanced}
        extra={{
          analyze: (
            <CredentialRow
              label={PANEL_COPY.analyzeTokenLabel}
              summary={PANEL_COPY.analyzeTokenSummary}
              state={tokenState}
              value={analyzeToken.value}
              secret
              placeholder={PANEL_COPY.analyzeTokenPlaceholder}
              issue={analyzeToken.issues.find(item => item.key === 'analyzeToken')}
              busy={analyzeToken.busy}
              disabled={analyzeToken.busy !== null || analyzeToken.locked || !tokenState.writable}
              onChange={analyzeToken.onChange}
              onSave={analyzeToken.onSave}
              onClear={analyzeToken.onClear}
            />
          ),
        }}
      />
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
