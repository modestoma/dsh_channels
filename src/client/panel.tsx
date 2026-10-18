/**
 * 设置 →「飞书渠道」页面。
 *
 * 数据全部来自 Host 的 `/dsh-channels/*` 路由：状态卡每 5 秒轮询一次，
 * 常用配置表单由 Host 下发的字段描述（`fields`）通用渲染，Host 是唯一的
 * 校验与持久化方。组件不 import 任何 DSH 客户端包，只依赖 react 与平台
 * 的 `settings.section` 槽位。
 *
 * @module dsh-channels/client/panel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PANEL_COPY } from '../settings/contract.ts'
import type {
  ChannelStatusWire,
  ConfigValue,
  CredentialField,
  CredentialRefWire,
  EditableFieldWire,
  EditableKey,
  EditableValues,
  FieldIssueWire,
  PanelWire,
} from '../settings/contract.ts'
import { clearConfig, clearCredential, fetchPanel, fetchStatus, reconnect, saveConfig, saveCredentials } from './api.ts'

/** Owner props handed to a `settings.section` contribution (unused beyond parity). */
export interface FeishuChannelsSectionProps {
  close?: () => void
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; panel: PanelWire }

type Notice = { kind: 'ok' | 'error'; text: string; issues?: FieldIssueWire[] }

const GROUP_ORDER = ['behavior', 'content', 'model', 'streaming'] as const
const GROUP_LABELS: Record<(typeof GROUP_ORDER)[number], string> = {
  behavior: '行为',
  content: '内容与图片',
  model: '模型',
  streaming: '流式卡片',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatUptime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${totalSeconds % 60} 秒`
  return `${totalSeconds} 秒`
}

function connectionLabel(state: string | undefined): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  switch (state) {
    case 'connected': return { text: '已连接', tone: 'ok' }
    case 'connecting': return { text: '连接中', tone: 'warn' }
    case 'reconnecting': return { text: '重连中', tone: 'warn' }
    case 'failed': return { text: '连接失败', tone: 'bad' }
    case 'idle': return { text: '未连接', tone: 'muted' }
    default: return { text: state ?? '未知', tone: 'muted' }
  }
}

function statusBadge(status: ChannelStatusWire): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (status.busy) return { text: '重连中', tone: 'warn' }
  if (!status.running) return { text: '未运行', tone: 'bad' }
  if (status.level === 'healthy') return { text: '运行中 · 健康', tone: 'ok' }
  if (status.level === 'degraded') return { text: '运行中 · 降级', tone: 'warn' }
  return { text: '运行中 · 异常', tone: 'bad' }
}

function fieldLabel(fields: readonly EditableFieldWire[], key: EditableKey): string {
  return fields.find(field => field.key === key)?.label ?? key
}

function effectiveValue(panel: PanelWire, key: EditableKey): ConfigValue | undefined {
  return panel.config.effective[key] ?? panel.config.base[key]
}

/** Numeric draft kept as the raw input string; parsed on save. */
function numericDraft(field: EditableFieldWire, raw: ConfigValue | undefined): number | undefined {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function validateDraft(panel: PanelWire, draft: EditableValues): { values: EditableValues; issues: FieldIssueWire[] } {
  const values: EditableValues = {}
  const issues: FieldIssueWire[] = []
  for (const field of panel.config.fields) {
    if (!(field.key in draft)) continue
    const raw = draft[field.key]
    if (field.kind === 'number') {
      const parsed = numericDraft(field, raw)
      if (parsed === undefined) {
        issues.push({ key: field.key, message: '请输入数字' })
        continue
      }
      if (field.min !== undefined && parsed < field.min) {
        issues.push({ key: field.key, message: `不得小于 ${field.min}` })
        continue
      }
      if (field.max !== undefined && parsed > field.max) {
        issues.push({ key: field.key, message: `不得大于 ${field.max}` })
        continue
      }
      values[field.key] = parsed
      continue
    }
    if (field.kind === 'boolean') {
      values[field.key] = raw === true
      continue
    }
    values[field.key] = String(raw ?? '')
  }
  return { values, issues }
}

/** One generic form control driven by the Host field descriptor. */
function FieldRow(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  issues: FieldIssueWire[]
  onChange: (key: EditableKey, value: ConfigValue) => void
}) {
  const { field, value, issues, onChange } = props
  const issue = issues.find(item => item.key === field.key)
  const inputClass = `dsh-channels-cfg__input${issue === undefined ? '' : ' dsh-channels-cfg__input--invalid'}`
  return (
    <div className="dsh-channels-cfg__field">
      <div className="dsh-channels-cfg__labelRow">
        <span className="dsh-channels-cfg__label">{field.label}</span>
        {field.restartRequired ? <span className="dsh-channels-cfg__tag dsh-channels-cfg__tag--restart">{PANEL_COPY.restartTag}</span> : null}
      </div>
      {field.kind === 'boolean'
        ? (
            <label className="dsh-channels-cfg__check">
              <input
                type="checkbox"
                className="dsh-channels-cfg__checkbox"
                checked={value === true}
                onChange={event => onChange(field.key, event.target.checked)}
              />
              <span>{value === true ? '已启用' : '已关闭'}</span>
            </label>
          )
        : null}
      {field.kind === 'select'
        ? (
            <select
              className={inputClass}
              value={String(value ?? '')}
              onChange={event => onChange(field.key, event.target.value)}
            >
              {(field.options ?? []).map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          )
        : null}
      {field.kind === 'number'
        ? (
            <input
              type="number"
              className={inputClass}
              value={value === undefined || value === '' ? '' : String(value)}
              min={field.min}
              max={field.max}
              step={field.step}
              onChange={event => onChange(field.key, event.target.value)}
            />
          )
        : null}
      {field.kind === 'text'
        ? (
            <input
              type="text"
              className={inputClass}
              value={String(value ?? '')}
              placeholder={field.placeholder}
              onChange={event => onChange(field.key, event.target.value)}
            />
          )
        : null}
      {field.help === undefined ? null : <span className="dsh-channels-cfg__help">{field.help}</span>}
      {issue === undefined ? null : <span className="dsh-channels-cfg__fieldError">{issue.message}</span>}
    </div>
  )
}

/** Status card: badge, connection facts, and the two panel actions. */
function StatusCard(props: {
  status: ChannelStatusWire
  pollError: string | null
  busy: string | null
  onRefresh: () => void
  onReconnect: () => void
}) {
  const { status, pollError, busy, onRefresh, onReconnect } = props
  const badge = statusBadge(status)
  const connection = connectionLabel(status.connection?.state)
  const facts = [
    { label: '飞书连接', value: status.connection === undefined ? '未知' : connection.text },
    { label: 'Bot open_id', value: status.botOpenIdTail ?? '—' },
    { label: '运行时长', value: formatUptime(status.uptimeMs) },
    { label: '话题路由', value: String(status.routeCount) },
    { label: '活动会话', value: String(status.liveAgentCount) },
    { label: '在途回复', value: String(status.inflightTurnCount) },
  ]
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.statusCard}</span>
        <span className={`dsh-channels-cfg__badge dsh-channels-cfg__badge--${badge.tone}`}>
          <span className="dsh-channels-cfg__dot" />
          {badge.text}
        </span>
        <span className="dsh-channels-cfg__cardMeta">每 5 秒自动刷新</span>
      </div>
      {status.lastStartError === undefined
        ? null
        : (
            <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--error">
              <strong>{PANEL_COPY.lastError}</strong>
              <span className="dsh-channels-cfg__mono">{status.lastStartError}</span>
            </div>
          )}
      <div className="dsh-channels-cfg__facts">
        {facts.map(fact => (
          <div className="dsh-channels-cfg__fact" key={fact.label}>
            <span className="dsh-channels-cfg__factLabel">{fact.label}</span>
            <span className="dsh-channels-cfg__factValue">{fact.value}</span>
          </div>
        ))}
      </div>
      {pollError === null ? null : <span className="dsh-channels-cfg__fieldError">状态刷新失败：{pollError}</span>}
      <div className="dsh-channels-cfg__actions">
        <button type="button" className="dsh-channels-cfg__btn" onClick={onRefresh} disabled={busy !== null}>
          {PANEL_COPY.refresh}
        </button>
        <button
          type="button"
          className="dsh-channels-cfg__btn dsh-channels-cfg__btn--danger"
          onClick={onReconnect}
          disabled={busy !== null}
        >
          {busy === 'reconnect' ? PANEL_COPY.reconnecting : PANEL_COPY.reconnect}
        </button>
        <span className="dsh-channels-cfg__help">{PANEL_COPY.restartWarning}</span>
      </div>
    </section>
  )
}

/** Credential editor: writes through the Host credentials seam, never echoes values. */
function CredentialsCard(props: {
  panel: PanelWire
  appId: string
  appSecret: string
  issues: FieldIssueWire[]
  busy: string | null
  onAppIdChange: (value: string) => void
  onAppSecretChange: (value: string) => void
  onSave: () => void
  onClear: (field: CredentialField) => void
}) {
  const { panel, appId, appSecret, issues, busy, onAppIdChange, onAppSecretChange, onSave, onClear } = props
  const appIdState = panel.config.credentials.appId
  const appSecretState = panel.config.credentials.appSecret
  const writable = appIdState.writable || appSecretState.writable
  const disabled = busy !== null || !writable
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
          {state.source === undefined ? '' : `（来源：${state.source}）`}
        </span>
        {issue === undefined ? null : <span className="dsh-channels-cfg__fieldError">{issue.message}</span>}
      </div>
    )
  }

  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.credentialsCard}</span>
        <span className="dsh-channels-cfg__cardMeta">DSH 凭据库</span>
      </div>
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
        <span className="dsh-channels-cfg__help">{PANEL_COPY.credentialsHelp}</span>
      </div>
    </section>
  )
}

/** Read-only card: credentials, storage layer, and advanced limits. */
function AdvancedCard(props: { panel: PanelWire }) {
  const { panel } = props
  const { readOnly } = panel.config
  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.advancedCard}</span>
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
          <span className="dsh-channels-cfg__help">可以直接编辑该 JSON 文件；面板保存会整体重写它，「清除 Web 覆盖」会删除它。</span>
        </div>
        <div className="dsh-channels-cfg__kv">
          <span className="dsh-channels-cfg__kvKey">{PANEL_COPY.version}</span>
          <span className="dsh-channels-cfg__kvValue dsh-channels-cfg__mono">{panel.status.version}</span>
        </div>
      </div>
    </section>
  )
}

/** The settings.section page: status card + generic config form + read-only facts. */
export function FeishuChannelsSection(_props: FeishuChannelsSectionProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [draft, setDraft] = useState<EditableValues>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<'save' | 'clear' | 'reconnect' | 'credentials' | 'credentials-clear' | null>(null)
  const [status, setStatus] = useState<ChannelStatusWire | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [appIdInput, setAppIdInput] = useState('')
  const [appSecretInput, setAppSecretInput] = useState('')
  const panel = load.phase === 'ready' ? load.panel : null
  const currentStatus = status ?? panel?.status ?? null

  const loadPanel = useCallback(async (): Promise<void> => {
    setLoad({ phase: 'loading' })
    setNotice(null)
    try {
      const next = await fetchPanel()
      setLoad({ phase: 'ready', panel: next })
      setStatus(next.status)
      setDraft({})
      setAppIdInput('')
      setAppSecretInput('')
    } catch (error) {
      setLoad({ phase: 'error', message: messageOf(error) })
    }
  }, [])

  useEffect(() => {
    void loadPanel()
  }, [loadPanel])

  useEffect(() => {
    if (load.phase !== 'ready') return undefined
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchStatus()
        if (cancelled) return
        setStatus(next)
        setPollError(null)
      } catch (error) {
        if (!cancelled) setPollError(messageOf(error))
      }
    }
    const timer = window.setInterval(() => { void tick() }, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [load.phase])

  const updateDraft = useCallback((key: EditableKey, value: ConfigValue) => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setNotice(null)
  }, [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchStatus()
      setStatus(next)
      setPollError(null)
    } catch (error) {
      setPollError(messageOf(error))
    }
  }, [])

  const onSave = useCallback(async (): Promise<void> => {
    if (panel === null) return
    const { values, issues } = validateDraft(panel, draft)
    if (issues.length > 0) {
      setNotice({ kind: 'error', text: '请先修正标红的配置项', issues })
      return
    }
    setBusy('save')
    setNotice(null)
    try {
      const result = await saveConfig(values)
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error, issues: result.issues })
        return
      }
      setLoad({ phase: 'ready', panel: result.panel })
      setStatus(result.panel.status)
      const cleared = result.clearedKeys.length === 0
        ? ''
        : `；已清除覆盖：${result.clearedKeys.map(key => fieldLabel(result.panel.config.fields, key)).join('、')}`
      setNotice({ kind: 'ok', text: `${PANEL_COPY.saved}${cleared}` })
      setDraft({})
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }, [draft, panel])

  const onClear = useCallback(async (): Promise<void> => {
    setBusy('clear')
    setNotice(null)
    try {
      const result = await clearConfig()
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error })
        return
      }
      setLoad({ phase: 'ready', panel: result.panel })
      setStatus(result.panel.status)
      setDraft({})
      setNotice({ kind: 'ok', text: PANEL_COPY.cleared })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }, [])

  const onReconnect = useCallback(async (): Promise<void> => {
    const confirmed = typeof window.confirm === 'function' ? window.confirm(PANEL_COPY.restartWarning) : true
    if (!confirmed) return
    setBusy('reconnect')
    setNotice(null)
    try {
      const result = await reconnect()
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error })
        await refreshStatus()
        return
      }
      setLoad({ phase: 'ready', panel: result.panel })
      setStatus(result.panel.status)
      setNotice({ kind: 'ok', text: '已重启飞书连接' })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      await refreshStatus()
    } finally {
      setBusy(null)
    }
  }, [refreshStatus])

  const onSaveCredentials = useCallback(async (): Promise<void> => {
    const values: { appId?: string; appSecret?: string } = {}
    if (appIdInput.trim() !== '') values.appId = appIdInput
    if (appSecretInput.trim() !== '') values.appSecret = appSecretInput
    if (values.appId === undefined && values.appSecret === undefined) return
    setBusy('credentials')
    setNotice(null)
    try {
      const result = await saveCredentials(values)
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error, issues: result.issues })
        return
      }
      setLoad({ phase: 'ready', panel: result.panel })
      setStatus(result.panel.status)
      setAppIdInput('')
      setAppSecretInput('')
      const base = result.reconnect === 'pending'
        ? PANEL_COPY.credentialSavedPending
        : result.reconnect === 'auto'
          ? PANEL_COPY.credentialSavedReconnected
          : PANEL_COPY.credentialSaved
      setNotice({
        kind: result.autoReconnectError === undefined ? 'ok' : 'error',
        text: result.autoReconnectError === undefined ? base : `${base}；自动重连失败：${result.autoReconnectError}`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }, [appIdInput, appSecretInput])

  const onClearCredential = useCallback(async (field: CredentialField): Promise<void> => {
    const label = field === 'appId' ? PANEL_COPY.appIdLabel : PANEL_COPY.appSecretLabel
    const confirmed = typeof window.confirm === 'function'
      ? window.confirm(`确定移除已存储的 ${label}？`)
      : true
    if (!confirmed) return
    setBusy('credentials-clear')
    setNotice(null)
    try {
      const result = await clearCredential(field)
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error, issues: result.issues })
        return
      }
      setLoad({ phase: 'ready', panel: result.panel })
      setStatus(result.panel.status)
      setNotice({
        kind: 'ok',
        text: result.reconnect === 'pending' ? PANEL_COPY.credentialRemovedPending : PANEL_COPY.credentialRemoved,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }, [])

  const groupedFields = useMemo(() => {
    if (panel === null) return []
    return GROUP_ORDER.map(group => ({
      group,
      label: GROUP_LABELS[group],
      fields: panel.config.fields.filter(field => field.group === group),
    })).filter(entry => entry.fields.length > 0)
  }, [panel])

  const dirty = Object.keys(draft).length > 0
  const issues = notice?.kind === 'error' ? notice.issues ?? [] : []

  if (load.phase === 'loading') {
    return <div className="dsh-channels-cfg__loading">{PANEL_COPY.loading}</div>
  }
  if (load.phase === 'error') {
    return (
      <div className="dsh-channels-cfg__error">
        <strong>{PANEL_COPY.loadFailed}</strong>
        <span>{load.message}</span>
        <div>
          <button type="button" className="dsh-channels-cfg__btn" onClick={() => { void loadPanel() }}>
            {PANEL_COPY.retry}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="dsh-channels-cfg">
      <header className="dsh-channels-cfg__head">
        <h2 className="dsh-channels-cfg__title">{PANEL_COPY.title}</h2>
        <p className="dsh-channels-cfg__desc">{PANEL_COPY.description}</p>
      </header>

      {currentStatus === null
        ? null
        : <StatusCard status={currentStatus} pollError={pollError} busy={busy} onRefresh={() => { void refreshStatus() }} onReconnect={() => { void onReconnect() }} />}

      {notice === null
        ? null
        : (
            <div className={`dsh-channels-cfg__notice dsh-channels-cfg__notice--${notice.kind === 'ok' ? 'ok' : 'error'}`}>
              <span>{notice.text}</span>
            </div>
          )}

      {panel === null
        ? null
        : (
            <CredentialsCard
              panel={panel}
              appId={appIdInput}
              appSecret={appSecretInput}
              issues={issues}
              busy={busy}
              onAppIdChange={setAppIdInput}
              onAppSecretChange={setAppSecretInput}
              onSave={() => { void onSaveCredentials() }}
              onClear={field => { void onClearCredential(field) }}
            />
          )}

      {panel === null
        ? null
        : (
            <>
              {panel.config.restartPendingKeys.length === 0
                ? null
                : (
                    <div className="dsh-channels-cfg__banner">
                      <span>
                        {PANEL_COPY.restartBanner}
                        {panel.config.restartPendingKeys.map(key => fieldLabel(panel.config.fields, key)).join('、')}
                      </span>
                      <button
                        type="button"
                        className="dsh-channels-cfg__btn dsh-channels-cfg__btn--danger"
                        onClick={() => { void onReconnect() }}
                        disabled={busy !== null}
                      >
                        {busy === 'reconnect' ? PANEL_COPY.reconnecting : PANEL_COPY.reconnect}
                      </button>
                    </div>
                  )}
              <section className="dsh-channels-cfg__card">
                <div className="dsh-channels-cfg__cardHead">
                  <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.configCard}</span>
                  <span className="dsh-channels-cfg__cardMeta">
                    {panel.config.overriddenKeys.length === 0
                      ? PANEL_COPY.inherited
                      : `${PANEL_COPY.overridden} ${panel.config.overriddenKeys.length} 项`}
                  </span>
                </div>
                {groupedFields.map(entry => (
                  <div key={entry.group}>
                    <div className="dsh-channels-cfg__cardHead">
                      <span className="dsh-channels-cfg__cardTitle">{entry.label}</span>
                    </div>
                    <div className="dsh-channels-cfg__grid">
                      {entry.fields.map(field => (
                        <FieldRow
                          key={field.key}
                          field={field}
                          value={draft[field.key] ?? effectiveValue(panel, field.key)}
                          issues={issues}
                          onChange={updateDraft}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className="dsh-channels-cfg__footer">
                  <button
                    type="button"
                    className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                    onClick={() => { void onSave() }}
                    disabled={!dirty || busy !== null}
                  >
                    {busy === 'save' ? PANEL_COPY.saving : PANEL_COPY.save}
                  </button>
                  <button
                    type="button"
                    className="dsh-channels-cfg__btn"
                    onClick={() => { void onClear() }}
                    disabled={panel.config.overriddenKeys.length === 0 || busy !== null}
                    title={panel.config.overriddenKeys.length === 0 ? PANEL_COPY.noOverrides : undefined}
                  >
                    {busy === 'clear' ? PANEL_COPY.clearing : PANEL_COPY.clear}
                  </button>
                  <span className="dsh-channels-cfg__spacer" />
                  <span className="dsh-channels-cfg__help">
                    {dirty ? '有未保存的修改' : '只保存改动过的字段'}
                  </span>
                </div>
              </section>
              <AdvancedCard panel={panel} />
            </>
          )}
    </div>
  )
}
