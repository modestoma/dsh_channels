/**
 * 日志分析接口令牌编辑器：值经 Host 的 DSH 凭据服务写入本机凭据库，面板只显示
 * 「已配置 / 未配置」，不回显已存值；保存或移除后下一次接口请求即生效，不触发重连。
 *
 * @module dsh-channels/client/panel/analyze-token-card
 */

import { PANEL_COPY } from '../../settings/contract.ts'
import type { PanelWire } from '../../settings/contract.ts'
import type { AnalyzeTokenView } from './shared.tsx'

export function AnalyzeTokenCard(props: {
  panel: PanelWire
  token: AnalyzeTokenView
}): JSX.Element {
  const { panel, token } = props
  const state = panel.config.credentials.analyzeToken
  const disabled = token.busy !== null || token.locked || !state.writable
  const issue = token.issues.find(item => item.key === 'analyzeToken')
  const inputClass = `dsh-channels-cfg__input${issue === undefined ? '' : ' dsh-channels-cfg__input--invalid'}`
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.analyzeTokenCard}</span>
        <span className={`dsh-channels-cfg__badge dsh-channels-cfg__badge--${state.configured ? 'ok' : 'muted'}`}>
          {state.configured ? PANEL_COPY.credentialConfigured : PANEL_COPY.credentialMissing}
        </span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.analyzeTokenCardHelp}</span>
      <div className="dsh-channels-cfg__field">
        <span className="dsh-channels-cfg__label">{PANEL_COPY.analyzeTokenLabel}</span>
        <div className="dsh-channels-cfg__cred">
          <input
            type="password"
            className={inputClass}
            value={token.value}
            placeholder={PANEL_COPY.analyzeTokenPlaceholder}
            autoComplete="new-password"
            aria-label={PANEL_COPY.analyzeTokenLabel}
            disabled={disabled}
            onChange={event => token.onChange(event.target.value)}
          />
          {state.configured
            ? (
                <button type="button" className="dsh-channels-cfg__btn" disabled={disabled} onClick={token.onClear}>
                  {token.busy === 'credentials-clear' ? PANEL_COPY.removingCredential : PANEL_COPY.removeCredential}
                </button>
              )
            : null}
        </div>
        <span className="dsh-channels-cfg__help">
          {PANEL_COPY.credentialsRef}：<span className="dsh-channels-cfg__mono">{state.ref}</span>
          {state.source === undefined ? '' : ` · ${state.source}`}
        </span>
        {issue === undefined ? null : <span className="dsh-channels-cfg__fieldError">{issue.message}</span>}
      </div>
      {state.writable ? null : <span className="dsh-channels-cfg__fieldError">{PANEL_COPY.credentialReadOnly}</span>}
      <div className="dsh-channels-cfg__footer">
        <button
          type="button"
          className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
          onClick={token.onSave}
          disabled={disabled || token.value.trim() === ''}
        >
          {token.busy === 'credentials' ? PANEL_COPY.savingCredentials : PANEL_COPY.saveAnalyzeToken}
        </button>
      </div>
    </section>
  )
}
