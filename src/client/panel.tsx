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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PANEL_COPY } from '../settings/contract.ts'
import type {
  AccessGroupWire,
  AccessRequestWire,
  AccessUserWire,
  AccessWire,
  CatalogWire,
  ChannelStatusWire,
  CleanupPreviewWire,
  CleanupRunWire,
  ConfigValue,
  CredentialField,
  CredentialRefWire,
  EditableFieldWire,
  EditableKey,
  EditableValues,
  FieldIssueWire,
  PanelWire,
} from '../settings/contract.ts'
import {
  addAccessGroup,
  addAccessUser,
  clearConfig,
  clearCredential,
  fetchCatalog,
  fetchPanel,
  fetchStatus,
  reconnect,
  removeAccessGroup,
  removeAccessUser,
  resolveAccessRequest,
  runCleanup,
  saveConfig,
  saveCredentials,
} from './api.ts'
import { CATALOG_KEYS, applyCatalogFields, catalogFromFields } from './catalog.ts'

/** Owner props handed to a `settings.section` contribution (unused beyond parity). */
export interface FeishuChannelsSectionProps {
  close?: () => void
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; panel: PanelWire }

type Notice = { kind: 'ok' | 'error'; text: string; issues?: FieldIssueWire[] }

/** One in-flight panel mutation (only one button is disabled at a time). */
type BusyAction = 'save' | 'clear' | 'reconnect' | 'credentials' | 'credentials-clear' | 'cleanup' | 'access'

const GROUP_ORDER = ['workspace', 'behavior', 'content', 'model', 'streaming'] as const
const GROUP_LABELS: Record<(typeof GROUP_ORDER)[number], string> = {
  workspace: '工作区与文件',
  behavior: '行为',
  content: '内容与附件',
  model: '模型',
  streaming: '流式卡片',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Human-readable byte size for the cleanup preview/result (base-2 units). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit] ?? 'B'}`
}

/** Display label for the effective retention value, reusing the Host field options. */
function retentionLabel(panel: PanelWire, cleanup: CleanupPreviewWire): string {
  const field = panel.config.fields.find(item => item.key === 'workspaceRetention')
  return field?.options?.find(option => option.value === cleanup.retention)?.label
    ?? (cleanup.retention === 'off' ? PANEL_COPY.cleanupRetentionOff : cleanup.retention)
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

/** Local `YYYY-MM-DD HH:mm` rendering for authorization timestamps. */
function formatAccessDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Which authorization entry produced one grant. */
function accessSourceLabel(source: AccessGroupWire['source']): string {
  switch (source) {
    case 'command': return PANEL_COPY.accessSourceCommand
    case 'card': return PANEL_COPY.accessSourceCard
    default: return PANEL_COPY.accessSourcePanel
  }
}

/** Effective access-mode label, reusing the Host field options for consistency. */
function accessModeLabel(panel: PanelWire, mode: AccessWire['mode']): string {
  const field = panel.config.fields.find(item => item.key === 'accessMode')
  return field?.options?.find(option => option.value === mode)?.label ?? mode
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

function validateDraft(
  panel: PanelWire,
  draft: EditableValues,
  only?: ReadonlySet<EditableKey>,
): { values: EditableValues; issues: FieldIssueWire[] } {
  const values: EditableValues = {}
  const issues: FieldIssueWire[] = []
  for (const field of panel.config.fields) {
    if (!(field.key in draft)) continue
    if (only !== undefined && !only.has(field.key)) continue
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
  const fieldClass = `dsh-channels-cfg__field${field.wide === true ? ' dsh-channels-cfg__field--wide' : ''}`
  return (
    <div className={fieldClass}>
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
              disabled={field.disabled === true}
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
      {status.reasons.length === 0
        ? null
        : (
            <span className={`dsh-channels-cfg__help${status.level === 'unhealthy' ? ' dsh-channels-cfg__reasonBad' : ''}`}>
              健康判定：{status.reasons.join('；')}
            </span>
          )}
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

/** Workspace cleanup card: deletion preview + the irreversible manual action. */
function CleanupCard(props: {
  panel: PanelWire
  cleanup: CleanupPreviewWire
  busy: BusyAction | null
  result: CleanupRunWire | null
  error: string | null
  onRun: () => void
}) {
  const { panel, cleanup, busy, result, error, onRun } = props
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
    { label: PANEL_COPY.cleanupCandidates, value: `${cleanup.candidates} / ${cleanup.workspaces} 个` },
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
          disabled={running || busy !== null || blocked !== null}
        >
          {running ? PANEL_COPY.cleanupRunning : PANEL_COPY.cleanupNow}
        </button>
        <span className="dsh-channels-cfg__help">{PANEL_COPY.cleanupConfirmHint}</span>
      </div>
    </section>
  )
}

/** Access card: fail-closed warning, administrator, whitelists, pending requests. */
function AccessCard(props: {
  panel: PanelWire
  busy: BusyAction | null
  notice: string | null
  error: string | null
  onAddGroup: (chatId: string, name: string) => Promise<boolean>
  onRemoveGroup: (chatId: string) => void
  onAddUser: (openId: string, name: string) => Promise<boolean>
  onRemoveUser: (openId: string) => void
  onResolveRequest: (token: string, decision: 'allow' | 'deny') => void
}) {
  const { panel, busy, notice, error, onAddGroup, onRemoveGroup, onAddUser, onRemoveUser, onResolveRequest } = props
  const { access } = panel
  const [groupChatId, setGroupChatId] = useState('')
  const [groupName, setGroupName] = useState('')
  const [userOpenId, setUserOpenId] = useState('')
  const [userName, setUserName] = useState('')
  const groups: readonly AccessGroupWire[] = access.groups
  const users: readonly AccessUserWire[] = access.users
  const requests: readonly AccessRequestWire[] = access.requests
  const working = busy === 'access'
  const disabled = busy !== null

  const submitGroup = async (): Promise<void> => {
    if (groupChatId.trim() === '') return
    if (await onAddGroup(groupChatId, groupName)) {
      setGroupChatId('')
      setGroupName('')
    }
  }

  const submitUser = async (): Promise<void> => {
    if (userOpenId.trim() === '') return
    if (await onAddUser(userOpenId, userName)) {
      setUserOpenId('')
      setUserName('')
    }
  }

  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.accessCard}</span>
        <span className="dsh-channels-cfg__cardMeta">{accessModeLabel(panel, access.mode)}</span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.accessCardHelp}</span>

      {access.mode === 'guarded' && !access.admin.configured
        ? (
            <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--error">
              <strong>{PANEL_COPY.accessAdminMissingWarning}</strong>
            </div>
          )
        : null}
      {access.mode === 'open'
        ? <div className="dsh-channels-cfg__banner">{PANEL_COPY.accessModeOpenWarning}</div>
        : null}

      <div className="dsh-channels-cfg__kv">
        <span className="dsh-channels-cfg__kvKey">{PANEL_COPY.accessAdminLabel}</span>
        <span className={`dsh-channels-cfg__kvValue dsh-channels-cfg__mono${access.admin.configured ? '' : ' dsh-channels-cfg__reasonBad'}`}>
          {access.admin.openId ?? PANEL_COPY.accessAdminMissing}
        </span>
        <span className="dsh-channels-cfg__help">{PANEL_COPY.accessAdminHint}</span>
      </div>

      <div className="dsh-channels-cfg__accessSection">
        <div className="dsh-channels-cfg__labelRow">
          <span className="dsh-channels-cfg__label">{PANEL_COPY.accessGroupsTitle}</span>
          <span className="dsh-channels-cfg__cardMeta">{groups.length} 个</span>
        </div>
        {groups.length === 0
          ? <span className="dsh-channels-cfg__help">{PANEL_COPY.accessGroupsEmpty}</span>
          : (
              <ul className="dsh-channels-cfg__accessList">
                {groups.map(group => (
                  <li className="dsh-channels-cfg__accessRow" key={group.chatId}>
                    <span className="dsh-channels-cfg__accessMain">
                      <span>{group.name ?? group.chatId}</span>
                      <span className="dsh-channels-cfg__accessMeta">
                        <span className="dsh-channels-cfg__mono">{group.chatId}</span>
                        {` · ${accessSourceLabel(group.source)} · ${formatAccessDate(group.addedAt)}`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="dsh-channels-cfg__btn"
                      disabled={disabled}
                      onClick={() => onRemoveGroup(group.chatId)}
                    >
                      {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        <div className="dsh-channels-cfg__accessAdd">
          <input
            type="text"
            className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
            value={groupChatId}
            placeholder={PANEL_COPY.accessGroupChatIdPlaceholder}
            disabled={disabled}
            onChange={event => setGroupChatId(event.target.value)}
          />
          <input
            type="text"
            className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
            value={groupName}
            placeholder={PANEL_COPY.accessGroupNamePlaceholder}
            disabled={disabled}
            onChange={event => setGroupName(event.target.value)}
          />
          <button
            type="button"
            className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
            disabled={disabled || groupChatId.trim() === ''}
            onClick={() => { void submitGroup() }}
          >
            {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAddGroup}
          </button>
        </div>
      </div>

      <div className="dsh-channels-cfg__accessSection">
        <div className="dsh-channels-cfg__labelRow">
          <span className="dsh-channels-cfg__label">{PANEL_COPY.accessUsersTitle}</span>
          <span className="dsh-channels-cfg__cardMeta">{users.length} 个</span>
        </div>
        {users.length === 0
          ? <span className="dsh-channels-cfg__help">{PANEL_COPY.accessUsersEmpty}</span>
          : (
              <ul className="dsh-channels-cfg__accessList">
                {users.map(user => (
                  <li className="dsh-channels-cfg__accessRow" key={user.openId}>
                    <span className="dsh-channels-cfg__accessMain">
                      <span>{user.name ?? user.openId}</span>
                      <span className="dsh-channels-cfg__accessMeta">
                        <span className="dsh-channels-cfg__mono">{user.openId}</span>
                        {` · ${accessSourceLabel(user.source)} · ${formatAccessDate(user.addedAt)}`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="dsh-channels-cfg__btn"
                      disabled={disabled}
                      onClick={() => onRemoveUser(user.openId)}
                    >
                      {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        <div className="dsh-channels-cfg__accessAdd">
          <input
            type="text"
            className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
            value={userOpenId}
            placeholder={PANEL_COPY.accessUserOpenIdPlaceholder}
            disabled={disabled}
            onChange={event => setUserOpenId(event.target.value)}
          />
          <input
            type="text"
            className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
            value={userName}
            placeholder={PANEL_COPY.accessUserNamePlaceholder}
            disabled={disabled}
            onChange={event => setUserName(event.target.value)}
          />
          <button
            type="button"
            className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
            disabled={disabled || userOpenId.trim() === ''}
            onClick={() => { void submitUser() }}
          >
            {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAddUser}
          </button>
        </div>
      </div>

      <div className="dsh-channels-cfg__accessSection">
        <div className="dsh-channels-cfg__labelRow">
          <span className="dsh-channels-cfg__label">{PANEL_COPY.accessRequestsTitle}</span>
          <span className="dsh-channels-cfg__cardMeta">{requests.length} 条</span>
        </div>
        {requests.length === 0
          ? <span className="dsh-channels-cfg__help">{PANEL_COPY.accessRequestsEmpty}</span>
          : (
              <ul className="dsh-channels-cfg__accessList">
                {requests.map(request => (
                  <li className="dsh-channels-cfg__accessRow" key={request.token}>
                    <span className="dsh-channels-cfg__accessMain">
                      <span>
                        {request.kind === 'group' ? PANEL_COPY.accessRequestGroup : PANEL_COPY.accessRequestUser}
                        {'：'}
                        {request.name ?? request.targetId}
                      </span>
                      <span className="dsh-channels-cfg__accessMeta">
                        <span className="dsh-channels-cfg__mono">{request.targetId}</span>
                        {` · ${formatAccessDate(request.createdAt)} · ${PANEL_COPY.accessRequestExpires} ${formatAccessDate(request.expiresAt)}`}
                        {request.kind === 'user' && request.requester !== undefined
                          ? ` · ${PANEL_COPY.accessRequestRequester} ${request.requester}`
                          : ''}
                        {request.kind === 'user' && request.groupName !== undefined
                          ? ` · 群 ${request.groupName}`
                          : request.kind === 'user' && request.chatId !== undefined
                            ? ` · 群 ${request.chatId}`
                            : ''}
                      </span>
                    </span>
                    <span className="dsh-channels-cfg__accessActions">
                      <button
                        type="button"
                        className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                        disabled={disabled}
                        onClick={() => onResolveRequest(request.token, 'allow')}
                      >
                        {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAllow}
                      </button>
                      <button
                        type="button"
                        className="dsh-channels-cfg__btn"
                        disabled={disabled}
                        onClick={() => onResolveRequest(request.token, 'deny')}
                      >
                        {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessDeny}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </div>

      {notice === null ? null : (
        <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--ok">
          <span>{notice}</span>
        </div>
      )}
      {error === null ? null : <span className="dsh-channels-cfg__fieldError">{error}</span>}
      <span className="dsh-channels-cfg__help">{PANEL_COPY.accessHints}</span>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.accessChatIdHint}</span>
    </section>
  )
}

/** The settings.section page: status card + generic config form + read-only facts. */
export function FeishuChannelsSection(_props: FeishuChannelsSectionProps): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [draft, setDraft] = useState<EditableValues>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [status, setStatus] = useState<ChannelStatusWire | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [appIdInput, setAppIdInput] = useState('')
  const [appSecretInput, setAppSecretInput] = useState('')
  const [catalog, setCatalog] = useState<CatalogWire | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<CleanupRunWire | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [accessNotice, setAccessNotice] = useState<string | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)
  const catalogTicket = useRef(0)
  const panel = load.phase === 'ready' ? load.panel : null
  const currentStatus = status ?? panel?.status ?? null

  const loadPanel = useCallback(async (): Promise<void> => {
    setLoad({ phase: 'loading' })
    setNotice(null)
    setCleanupResult(null)
    setCleanupError(null)
    setAccessNotice(null)
    setAccessError(null)
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

  // The Host panel payload already carries options resolved for the effective
  // route; re-seed the local catalog whenever a fresh panel arrives (load/save).
  useEffect(() => {
    if (panel === null) {
      setCatalog(null)
      return
    }
    setCatalog(catalogFromFields(panel.config.fields))
    setCatalogBusy(false)
  }, [panel])

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

  /** Fetch the selector catalog for a draft route (latest request wins). */
  const refreshCatalog = useCallback(async (provider: string, model: string): Promise<void> => {
    catalogTicket.current += 1
    const ticket = catalogTicket.current
    setCatalogBusy(true)
    try {
      const next = await fetchCatalog(provider, model)
      if (catalogTicket.current === ticket) setCatalog(next)
    } catch {
      if (catalogTicket.current !== ticket) return
      // Never keep another route's options: degrade the dependent fields to the
      // free-text controls instead of offering stale values.
      setCatalog(previous => previous === null ? null : {
        provider: previous.provider,
        model: { selectable: false, options: [] },
        reasoningEffort: { selectable: false, options: [] },
        agentPreset: previous.agentPreset,
      })
      setNotice({ kind: 'error', text: PANEL_COPY.catalogFailed })
    } finally {
      if (catalogTicket.current === ticket) setCatalogBusy(false)
    }
  }, [])

  /** Current form values, used to keep unlisted configured values visible. */
  const currentValues = useMemo(() => {
    if (panel === null) return {}
    const valueOf = (key: EditableKey): string | undefined => {
      const raw = draft[key] ?? effectiveValue(panel, key)
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    }
    return {
      provider: valueOf('provider'),
      model: valueOf('model'),
      reasoningEffort: valueOf('reasoningEffort'),
      agentPreset: valueOf('agentPreset'),
    }
  }, [draft, panel])

  const renderedFields = useMemo(
    () => applyCatalogFields(panel?.config.fields ?? [], catalog, currentValues),
    [panel, catalog, currentValues],
  )

  /** Whether one selector currently renders as a dropdown for this form. */
  const isSelectField = useCallback(
    (key: EditableKey): boolean => renderedFields.some(field => field.key === key && field.kind === 'select'),
    [renderedFields],
  )

  const updateDraft = useCallback((key: EditableKey, value: ConfigValue) => {
    if (panel === null) return
    const providerNow = String(draft.provider ?? effectiveValue(panel, 'provider') ?? '')
    setNotice(null)
    if (key === 'provider') {
      // Changing the provider invalidates the model/effort below it. When the
      // selected provider is the configured one, keep showing its configured
      // model; otherwise fall back to the inherit choice.
      const nextProvider = String(value ?? '')
      const configuredProvider = String(effectiveValue(panel, 'provider') ?? '')
      const keepModel = nextProvider === configuredProvider
        ? String(effectiveValue(panel, 'model') ?? '')
        : ''
      setDraft(previous => ({ ...previous, provider: value, model: '', reasoningEffort: '' }))
      if (catalog !== null && isSelectField('provider')) void refreshCatalog(nextProvider, keepModel)
      return
    }
    if (key === 'model') {
      setDraft(previous => ({ ...previous, model: value, reasoningEffort: '' }))
      if (catalog !== null && isSelectField('model')) void refreshCatalog(providerNow, String(value ?? ''))
      return
    }
    setDraft(previous => ({ ...previous, [key]: value }))
  }, [catalog, draft.provider, isSelectField, panel, refreshCatalog])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchStatus()
      setStatus(next)
      setPollError(null)
    } catch (error) {
      setPollError(messageOf(error))
    }
  }, [])

  /**
   * Save one scope of the form. The global footer saves every draft key; the
   * model card's own button saves only the four model-facing keys, so editing
   * the model does not require scrolling to the bottom.
   */
  const onSave = useCallback(async (scope?: 'model'): Promise<void> => {
    if (panel === null) return
    const only = scope === 'model' ? new Set<EditableKey>(CATALOG_KEYS) : undefined
    const { values, issues } = validateDraft(panel, draft, only)
    if (issues.length > 0) {
      setNotice({ kind: 'error', text: '请先修正标红的配置项', issues })
      return
    }
    if (Object.keys(values).length === 0) return
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
      setCleanupResult(null)
      setCleanupError(null)
      const cleared = result.clearedKeys.length === 0
        ? ''
        : `；已清除覆盖：${result.clearedKeys.map(key => fieldLabel(result.panel.config.fields, key)).join('、')}`
      setNotice({
        kind: 'ok',
        text: `${scope === 'model' ? PANEL_COPY.savedModel : PANEL_COPY.saved}${cleared}`,
      })
      setDraft((previous) => {
        if (scope !== 'model') return {}
        const next = { ...previous }
        for (const key of CATALOG_KEYS) delete next[key]
        return next
      })
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
      setCleanupResult(null)
      setCleanupError(null)
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

  /**
   * Delete stale workspaces after an explicit confirmation. The Host refreshes
   * the panel in the same response, so the preview counts update immediately;
   * partial failures stay visible in the card instead of being swallowed.
   */
  const onRunCleanup = useCallback(async (): Promise<void> => {
    if (panel === null) return
    const { cleanup } = panel
    const confirmed = typeof window.confirm === 'function'
      ? window.confirm(
        `${PANEL_COPY.cleanupConfirm}\n本次将删除 ${cleanup.candidates} 个工作区，预计释放 ${formatBytes(cleanup.candidateBytes)}。`,
      )
      : true
    if (!confirmed) return
    setBusy('cleanup')
    setNotice(null)
    setCleanupResult(null)
    setCleanupError(null)
    try {
      const response = await runCleanup()
      if (!response.ok) {
        setCleanupError(response.error)
        return
      }
      setLoad({ phase: 'ready', panel: response.panel })
      setStatus(response.panel.status)
      setCleanupResult(response.result)
    } catch (error) {
      setCleanupError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [panel])

  /** Replace the embedded access snapshot after a whitelist mutation. */
  const applyAccess = useCallback((access: AccessWire): void => {
    setLoad(previous => previous.phase === 'ready'
      ? { phase: 'ready', panel: { ...previous.panel, access } }
      : previous)
  }, [])

  const onAddAccessGroup = useCallback(async (chatId: string, name: string): Promise<boolean> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await addAccessGroup(chatId, name)
      if (!result.ok) {
        setAccessError(result.error)
        return false
      }
      applyAccess(result.access)
      setAccessNotice(PANEL_COPY.accessGroupAdded)
      return true
    } catch (error) {
      setAccessError(messageOf(error))
      return false
    } finally {
      setBusy(null)
    }
  }, [applyAccess])

  const onRemoveAccessGroup = useCallback(async (chatId: string): Promise<void> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await removeAccessGroup(chatId)
      if (!result.ok) {
        setAccessError(result.error)
        return
      }
      applyAccess(result.access)
      setAccessNotice(PANEL_COPY.accessGroupRemoved)
    } catch (error) {
      setAccessError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [applyAccess])

  const onAddAccessUser = useCallback(async (openId: string, name: string): Promise<boolean> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await addAccessUser(openId, name)
      if (!result.ok) {
        setAccessError(result.error)
        return false
      }
      applyAccess(result.access)
      setAccessNotice(PANEL_COPY.accessUserAdded)
      return true
    } catch (error) {
      setAccessError(messageOf(error))
      return false
    } finally {
      setBusy(null)
    }
  }, [applyAccess])

  const onRemoveAccessUser = useCallback(async (openId: string): Promise<void> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await removeAccessUser(openId)
      if (!result.ok) {
        setAccessError(result.error)
        return
      }
      applyAccess(result.access)
      setAccessNotice(PANEL_COPY.accessUserRemoved)
    } catch (error) {
      setAccessError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [applyAccess])

  const onResolveAccessRequest = useCallback(async (token: string, decision: 'allow' | 'deny'): Promise<void> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await resolveAccessRequest(token, decision)
      if (!result.ok) {
        setAccessError(result.error)
        return
      }
      applyAccess(result.access)
      setAccessNotice(decision === 'allow' ? PANEL_COPY.accessRequestAllowed : PANEL_COPY.accessRequestDenied)
    } catch (error) {
      setAccessError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [applyAccess])

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
      fields: renderedFields.filter(field => field.group === group),
    })).filter(entry => entry.fields.length > 0)
  }, [panel, renderedFields])

  // Model selection owns its own card: it depends on live host services and is
  // the part users change most often, so it should not sit inside 常用配置.
  const modelEntries = groupedFields.filter(entry => entry.group === 'model')
  const configEntries = groupedFields.filter(entry => entry.group !== 'model')

  const dirty = Object.keys(draft).length > 0
  const modelDirty = CATALOG_KEYS.some(key => draft[key] !== undefined)
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
              {modelEntries.length === 0
                ? null
                : (
                    <section className="dsh-channels-cfg__card">
                      <div className="dsh-channels-cfg__cardHead">
                        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.modelCard}</span>
                        <span className="dsh-channels-cfg__cardMeta">
                          {catalogBusy ? PANEL_COPY.catalogLoading : '选项来自宿主机目录'}
                        </span>
                      </div>
                      <span className="dsh-channels-cfg__help">{PANEL_COPY.modelCardHelp}</span>
                      {modelEntries.map(entry => (
                        <div className="dsh-channels-cfg__grid" key={entry.group}>
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
                      ))}
                      <div className="dsh-channels-cfg__footer">
                        <button
                          type="button"
                          className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                          onClick={() => { void onSave('model') }}
                          disabled={!modelDirty || busy !== null}
                        >
                          {busy === 'save' ? PANEL_COPY.saving : PANEL_COPY.saveModel}
                        </button>
                        <span className="dsh-channels-cfg__spacer" />
                        <span className="dsh-channels-cfg__help">
                          {modelDirty ? '有未保存的模型修改' : PANEL_COPY.modelActionsHint}
                        </span>
                      </div>
                    </section>
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
                {configEntries.map(entry => (
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
              </section>
              <div className="dsh-channels-cfg__footer">
                <button
                  type="button"
                  className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                  onClick={() => { void onSave() }}
                  disabled={!dirty || busy !== null}
                >
                  {busy === 'save' ? PANEL_COPY.saving : PANEL_COPY.saveAll}
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
              <CleanupCard
                panel={panel}
                cleanup={panel.cleanup}
                busy={busy}
                result={cleanupResult}
                error={cleanupError}
                onRun={() => { void onRunCleanup() }}
              />
              <AccessCard
                panel={panel}
                busy={busy}
                notice={accessNotice}
                error={accessError}
                onAddGroup={onAddAccessGroup}
                onRemoveGroup={chatId => { void onRemoveAccessGroup(chatId) }}
                onAddUser={onAddAccessUser}
                onRemoveUser={openId => { void onRemoveAccessUser(openId) }}
                onResolveRequest={(token, decision) => { void onResolveAccessRequest(token, decision) }}
              />
              <AdvancedCard panel={panel} />
            </>
          )}
    </div>
  )
}
