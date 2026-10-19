/**
 * 飞书应用凭据编辑器：值经 Host 的 DSH 凭据服务写入本机凭据库，面板只显示
 * 「已配置 / 未配置」，两个方向都不回显已存值。保存动作由页面外壳持有
 * （凭据保存独立于配置 draft）。
 *
 * @module dsh-channels/client/panel/credentials-card
 */

import { PANEL_COPY } from '../../settings/contract.ts'
import type { CredentialField, CredentialRefWire, PanelWire } from '../../settings/contract.ts'
import type { CredentialsView } from './shared.tsx'

export function CredentialsCard(props: {
  panel: PanelWire
  credentials: CredentialsView
}): JSX.Element {
  const { panel, credentials } = props
  const { appId, appSecret, issues, busy, locked, onAppIdChange, onAppSecretChange, onSave, onClear } = credentials
  const appIdState = panel.config.credentials.appId
  const appSecretState = panel.config.credentials.appSecret
  const configured = appIdState.configured && appSecretState.configured
  const writable = appIdState.writable || appSecretState.writable
  const disabled = busy !== null || locked || !writable
  const pending = appId.trim() !== '' || appSecret.trim() !== ''

  const row = (
    field: CredentialField,
    label: string,
    state: CredentialRefWire,
    value: string,
    type: 'text' | 'password',
    placeholder: string,
    onChange: (next: string) => void,
  ): JSX.Element => {
    const issue = issues.find(item => item.key === field)
    const inputClass = `dsh-channels-cfg__input${issue === undefined ? '' : ' dsh-channels-cfg__input--invalid'}`
    return (
      <div className="dsh-channels-cfg__field" key={field}>
        <div className="dsh-channels-cfg__labelRow">
          <span className="dsh-channels-cfg__label">{label}</span>
          <span className={`dsh-channels-cfg__badge dsh-channels-cfg__badge--${state.configured ? 'ok' : 'bad'}`}>
            {state.configured ? PANEL_COPY.credentialConfigured : PANEL_COPY.credentialMissing}
          </span>
        </div>
        <div className="dsh-channels-cfg__cred">
          <input
            type={type}
            className={inputClass}
            value={value}
            placeholder={placeholder}
            autoComplete="new-password"
            aria-label={label}
            disabled={disabled}
            onChange={event => onChange(event.target.value)}
          />
          {state.configured
            ? (
                <button
                  type="button"
                  className="dsh-channels-cfg__btn"
                  disabled={disabled}
                  onClick={() => onClear(field)}
                >
                  {busy === 'credentials-clear' ? PANEL_COPY.removingCredential : PANEL_COPY.removeCredential}
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
    )
  }

  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.credentialsCard}</span>
        <span className={`dsh-channels-cfg__badge dsh-channels-cfg__badge--${configured ? 'ok' : 'muted'}`}>
          {configured ? PANEL_COPY.configuredBadge : PANEL_COPY.unconfiguredBadge}
        </span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.credentialsCardHelp}</span>
      {row('appId', PANEL_COPY.appIdLabel, appIdState, appId, 'text', PANEL_COPY.appIdPlaceholder, onAppIdChange)}
      {row('appSecret', PANEL_COPY.appSecretLabel, appSecretState, appSecret, 'password', PANEL_COPY.appSecretPlaceholder, onAppSecretChange)}
      {writable ? null : <span className="dsh-channels-cfg__fieldError">{PANEL_COPY.credentialReadOnly}</span>}
      <div className="dsh-channels-cfg__footer">
        <button
          type="button"
          className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
          onClick={onSave}
          disabled={disabled || !pending}
        >
          {busy === 'credentials' ? PANEL_COPY.savingCredentials : PANEL_COPY.saveCredentials}
        </button>
        <span className="dsh-channels-cfg__spacer" />
        <span className="dsh-channels-cfg__help">{PANEL_COPY.credentialsPendingHint}</span>
      </div>
    </section>
  )
}
