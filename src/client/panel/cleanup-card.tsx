/**
 * 目录清理卡：展示清理预览（保留期 / 自动清理 / 候选数量与空间），
 * 执行前二次确认，结果与部分失败逐条展示。`cleanup.error` 非空时
 * （例如未连接、无法扫描工作区）按钮天然禁用并显示原因。
 *
 * @module dsh-channels/client/panel/cleanup-card
 */

import { PANEL_COPY } from '../../settings/contract.ts'
import type { CleanupPreviewWire, CleanupRunWire, PanelWire } from '../../settings/contract.ts'
import { formatBytes, retentionLabel } from './shared.tsx'
import type { BusyAction } from './shared.tsx'

export function CleanupCard(props: {
  panel: PanelWire
  cleanup: CleanupPreviewWire
  busy: BusyAction | null
  locked: boolean
  result: CleanupRunWire | null
  error: string | null
  onRun: () => void
}): JSX.Element {
  const { panel, cleanup, busy, locked, result, error, onRun } = props
  const autoText = cleanup.retention === 'off'
    ? PANEL_COPY.cleanupAutoInactive
    : cleanup.auto ? PANEL_COPY.cleanupAutoOn : PANEL_COPY.cleanupAutoOff
  const blocked = cleanup.error !== undefined
    ? `${PANEL_COPY.cleanupPreviewFailed}：${cleanup.error}`
    : cleanup.retention === 'off'
      ? PANEL_COPY.cleanupDisabledOff
      : cleanup.candidates === 0
        ? PANEL_COPY.cleanupDisabledEmpty
        : null
  const facts = [
    { label: PANEL_COPY.cleanupRetention, value: retentionLabel(panel, cleanup) },
    { label: PANEL_COPY.cleanupAutoLabel, value: autoText },
    { label: PANEL_COPY.cleanupCandidates, value: `${cleanup.candidates} 个` },
    { label: PANEL_COPY.cleanupWorkspaces, value: `${cleanup.workspaces} 个` },
    { label: PANEL_COPY.cleanupCandidateBytes, value: formatBytes(cleanup.candidateBytes) },
  ]
  const running = busy === 'cleanup'
  const failed = result !== null && (!result.ok || error !== null)
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.cleanupCard}</span>
        <span className="dsh-channels-cfg__cardMeta">{retentionLabel(panel, cleanup)}</span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.cleanupCardHelp}</span>
      <div className="dsh-channels-cfg__facts">
        {facts.map(fact => (
          <div className="dsh-channels-cfg__fact" key={fact.label}>
            <span className="dsh-channels-cfg__factLabel">{fact.label}</span>
            <span className="dsh-channels-cfg__factValue">{fact.value}</span>
          </div>
        ))}
      </div>
      {blocked === null ? null : <span className="dsh-channels-cfg__help">{blocked}</span>}
      {result === null
        ? null
        : (
            <div className={`dsh-channels-cfg__notice dsh-channels-cfg__notice--${failed ? 'error' : 'ok'}`}>
              {result.ok
                ? (
                    <span>
                      {PANEL_COPY.cleanupDone}：{PANEL_COPY.cleanupDeleted} {result.deletedWorkspaces} 个，
                      {PANEL_COPY.cleanupDeletedDirs} {result.deletedSessionDirs} 个，
                      {PANEL_COPY.cleanupRetired} {result.retiredRoutes} 条，
                      {PANEL_COPY.cleanupFreed} {formatBytes(result.freedBytes)}。
                    </span>
                  )
                : (
                    <span>
                      {PANEL_COPY.cleanupFailed}
                      {result.error === undefined ? '' : `：${result.error}`}
                    </span>
                  )}
              {result.failures.length === 0
                ? null
                : (
                    <>
                      <span>{PANEL_COPY.cleanupFailures}</span>
                      <ul className="dsh-channels-cfg__issues">
                        {result.failures.map((failure, index) => (
                          <li key={`${index}-${failure}`} className="dsh-channels-cfg__mono">{failure}</li>
                        ))}
                      </ul>
                    </>
                  )}
            </div>
          )}
      {error === null ? null : <span className="dsh-channels-cfg__fieldError">{error}</span>}
      <div className="dsh-channels-cfg__actions">
        <button
          type="button"
          className="dsh-channels-cfg__btn dsh-channels-cfg__btn--danger"
          onClick={onRun}
          disabled={running || busy !== null || locked || blocked !== null}
        >
          {running ? PANEL_COPY.cleanupRunning : PANEL_COPY.cleanupNow}
        </button>
        <span className="dsh-channels-cfg__help">{PANEL_COPY.cleanupConfirmHint}</span>
      </div>
    </section>
  )
}
