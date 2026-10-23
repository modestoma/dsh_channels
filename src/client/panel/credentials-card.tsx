/**
 * 凭据行：值经 Host 的 DSH 凭据服务写入本机凭据库，面板只显示「已配置 /
 * 未配置」，两个方向都不回显已存值。已配置时只显示「更换 / 移除」，点「更换」
 * 才出现输入框。保存动作由页面外壳持有（凭据保存独立于配置 draft）。
 *
 * @module dsh-channels/client/panel/credentials-card
 */

import { useEffect, useRef, useState } from 'react'
import { PANEL_COPY } from '../../settings/contract.ts'
import type { CredentialRefWire, FieldIssueWire, PanelWire } from '../../settings/contract.ts'
import { Pill, Row, Section } from './shared.tsx'
import type { BusyAction, CredentialsView } from './shared.tsx'

/** One credential slot as a setting row with its own input and actions. */
export function CredentialRow(props: {
  label: string
  summary?: string
  state: CredentialRefWire
  value: string
  secret: boolean
  placeholder: string
  issue?: FieldIssueWire
  busy: BusyAction | null
  disabled: boolean
  onChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}): JSX.Element {
  const { label, summary, state, value, secret, placeholder, issue, busy, disabled, onChange, onSave, onClear } = props
  const [editing, setEditing] = useState(false)
  // Close the replace input once a credential save finishes (the shell clears the value).
  const previousBusy = useRef(busy)
  useEffect(() => {
    if (previousBusy.current === 'credentials' && busy === null) setEditing(false)
    previousBusy.current = busy
  }, [busy])
  const showInput = !state.configured || editing || value !== ''
  const source = `${PANEL_COPY.credentialStore} · ${state.ref}${state.source === undefined ? '' : ` · ${state.source}`}`
  return (
    <Row
      label={label}
      tags={(
        <Pill tone={state.configured ? 'ok' : 'muted'}>
          {state.configured ? PANEL_COPY.credentialConfigured : PANEL_COPY.credentialMissing}
        </Pill>
      )}
      summary={summary === undefined ? <span className="dsh-channels-cfg__mono">{source}</span> : summary}
      error={issue?.message ?? (state.writable ? undefined : PANEL_COPY.credentialReadOnly)}
      control={showInput
        ? (
            <div className="dsh-channels-cfg__inputRow">
              <input
                type={secret ? 'password' : 'text'}
                className={`dsh-channels-cfg__input dsh-channels-cfg__input--text${issue === undefined ? '' : ' dsh-channels-cfg__input--invalid'}`}
                value={value}
                placeholder={placeholder}
                autoComplete="new-password"
                aria-label={label}
                disabled={disabled}
                onChange={event => onChange(event.target.value)}
              />
              <button
                type="button"
                className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                disabled={disabled || value.trim() === ''}
                onClick={onSave}
              >
                {busy === 'credentials' ? PANEL_COPY.savingCredentials : PANEL_COPY.saveCredentials}
              </button>
              {state.configured
                ? (
                    <button
                      type="button"
                      className="dsh-channels-cfg__btn dsh-channels-cfg__btn--ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setEditing(false)
                        onChange('')
                      }}
                    >
                      {PANEL_COPY.cancel}
                    </button>
                  )
                : null}
            </div>
          )
        : (
            <div className="dsh-channels-cfg__inputRow">
              <button type="button" className="dsh-channels-cfg__btn" disabled={disabled} onClick={() => setEditing(true)}>
                {PANEL_COPY.replaceCredential}
              </button>
              <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--remove" disabled={disabled} onClick={onClear}>
                {busy === 'credentials-clear' ? PANEL_COPY.removingCredential : PANEL_COPY.removeCredential}
              </button>
            </div>
          )}
    />
  )
}

/** The Feishu application pair (App ID / App Secret). */
export function CredentialsSection(props: {
  panel: PanelWire
  credentials: CredentialsView
}): JSX.Element {
  const { panel, credentials } = props
  const { appId, appSecret, issues, busy, locked, onAppIdChange, onAppSecretChange, onSave, onClear } = credentials
  const appIdState = panel.config.credentials.appId
  const appSecretState = panel.config.credentials.appSecret
  return (
    <Section title={PANEL_COPY.credentialsTitle} footnote={PANEL_COPY.credentialsHint}>
      <CredentialRow
        label={PANEL_COPY.appIdLabel}
        state={appIdState}
        value={appId}
        secret={false}
        placeholder={PANEL_COPY.appIdPlaceholder}
        issue={issues.find(item => item.key === 'appId')}
        busy={busy}
        disabled={busy !== null || locked || !appIdState.writable}
        onChange={onAppIdChange}
        onSave={onSave}
        onClear={() => onClear('appId')}
      />
      <CredentialRow
        label={PANEL_COPY.appSecretLabel}
        state={appSecretState}
        value={appSecret}
        secret
        placeholder={PANEL_COPY.appSecretPlaceholder}
        issue={issues.find(item => item.key === 'appSecret')}
        busy={busy}
        disabled={busy !== null || locked || !appSecretState.writable}
        onChange={onAppSecretChange}
        onSave={onSave}
        onClear={() => onClear('appSecret')}
      />
    </Section>
  )
}
