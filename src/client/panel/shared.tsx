/**
 * 设置面板共享层：页面状态类型、Host 字段渲染原语（FieldRow / FieldsCard /
 * SaveBar）、生命周期徽标与纯格式化工具。
 *
 * 这一层不发请求、不持有页面状态，只把 Host 下发的 wire 数据渲染成控件；
 * 页面外壳在 `index.tsx`，各 tab 只组合这些原语。
 *
 * @module dsh-channels/client/panel/shared
 */

import { useState } from 'react'
import { FIELD_GROUP_LABELS, PANEL_COPY, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type {
  AccessWire,
  ChannelPhaseWire,
  ConfigValue,
  CredentialField,
  EditableFieldWire,
  EditableKey,
  EditableValues,
  FieldGroup,
  FieldIssueWire,
  PanelTabId,
  PanelWire,
} from '../../settings/contract.ts'
import {
  listIsFull,
  listItems,
  listRows,
  stringListDraftValue,
  withBlankListEntry,
  withListEntry,
  withoutListEntry,
} from '../string-list.ts'

/** Initial panel load: one request, retried from the error card. */
export type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; panel: PanelWire }

/** One transient banner above the tab body (save/credentials/reconnect/catalog). */
export interface Notice {
  kind: 'ok' | 'error'
  text: string
  /** Per-field validation failures rendered inline by FieldRow. */
  issues?: FieldIssueWire[]
}

/** One in-flight panel mutation (only one action runs at a time). */
export type BusyAction =
  | 'save'
  | 'clear'
  | 'reconnect'
  | 'credentials'
  | 'credentials-clear'
  | 'access'

/** Tone of a small badge; maps onto `dsh-channels-cfg__badge--*` classes. */
export type BadgeTone = 'ok' | 'warn' | 'bad' | 'muted'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Compact duration for the connection card. */
export function formatUptime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return PANEL_COPY.unknownValue
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${totalSeconds % 60} 秒`
  return `${totalSeconds} 秒`
}

/** Effective value for one key (falling back to the profile base). */
export function effectiveValue(panel: PanelWire, key: EditableKey): ConfigValue | undefined {
  return panel.config.effective[key] ?? panel.config.base[key]
}

/** Host label for one editable key; the raw key is the technical fallback. */
export function fieldLabel(fields: readonly EditableFieldWire[], key: EditableKey): string {
  return fields.find(field => field.key === key)?.label ?? key
}

/** Effective access-mode label, reusing the Host field options for consistency. */
export function accessModeLabel(panel: PanelWire, mode: AccessWire['mode']): string {
  const field = panel.config.fields.find(item => item.key === 'accessMode')
  return field?.options?.find(option => option.value === mode)?.label ?? mode
}

/** Numeric draft kept as the raw input string; parsed on save. */
function numericDraft(field: EditableFieldWire, raw: ConfigValue | undefined): number | undefined {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Turn the dirty draft into the wire payload, keeping the Host-descriptor
 * bounds check client-side. Field messages stay technical (the Host re-validates
 * every value on save).
 */
export function validateDraft(
  panel: PanelWire,
  draft: EditableValues,
): { values: EditableValues; issues: FieldIssueWire[] } {
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
    if (field.kind === 'string-list') {
      const list = stringListDraftValue(field, raw)
      if (list.ok) values[field.key] = list.value
      else issues.push(...list.issues)
      continue
    }
    values[field.key] = String(raw ?? '')
  }
  return { values, issues }
}

/** Header badge for the Host-derived lifecycle phase. */
export function phaseBadge(phase: ChannelPhaseWire): { text: string; tone: BadgeTone } {
  switch (phase) {
    case 'connected': return { text: PANEL_COPY.phaseConnected, tone: 'ok' }
    case 'connecting': return { text: PANEL_COPY.phaseConnecting, tone: 'warn' }
    case 'error': return { text: PANEL_COPY.phaseError, tone: 'bad' }
    case 'idle': return { text: PANEL_COPY.phaseIdle, tone: 'muted' }
    default: return { text: PANEL_COPY.phaseUnconfigured, tone: 'muted' }
  }
}

/** One-line explanation shown under the page title for the current phase. */
export function phaseSummary(phase: ChannelPhaseWire): string {
  switch (phase) {
    case 'connected': return PANEL_COPY.statusSummaryConnected
    case 'connecting': return PANEL_COPY.statusSummaryConnecting
    case 'error': return PANEL_COPY.statusSummaryError
    case 'idle': return PANEL_COPY.statusSummaryIdle
    default: return PANEL_COPY.statusSummaryUnconfigured
  }
}

/** Credential editor data owned by the page shell, rendered by the connection tab. */
export interface CredentialsView {
  appId: string
  appSecret: string
  issues: FieldIssueWire[]
  busy: BusyAction | null
  /** Host-side lifecycle busy (connecting/restarting): block writes. */
  locked: boolean
  onAppIdChange: (value: string) => void
  onAppSecretChange: (value: string) => void
  onSave: () => void
  onClear: (field: CredentialField) => void
}

/** Analyze API token editor data owned by the page shell, rendered by the sessions tab. */
export interface AnalyzeTokenView {
  value: string
  issues: FieldIssueWire[]
  busy: BusyAction | null
  /** Host-side lifecycle busy (connecting/restarting): block writes. */
  locked: boolean
  onChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

/** Everything a field-bearing tab needs from the page shell's single draft. */
export interface FormView {
  panel: PanelWire
  /** Host descriptors after the live selector catalog has been layered on. */
  fields: readonly EditableFieldWire[]
  draft: EditableValues
  issues: FieldIssueWire[]
  busy: BusyAction | null
  /** Host-side lifecycle busy (connecting/restarting): block writes. */
  locked: boolean
  dirtyCount: number
  onChange: (key: EditableKey, value: ConfigValue) => void
  onSave: () => void
  /** Drop only the draft keys owned by one tab. */
  onDiscardTab: (tab: PanelTabId) => void
  /**
   * Open the Host's native directory chooser and write the picked absolute
   * path into the draft (not saved until「保存更改」). Absent when the Host
   * cannot offer a native chooser.
   */
  onPickDirectory?: (key: EditableKey) => Promise<void>
}

/**
 * Text input paired with the host-native「选择目录…」button. The button owns
 * its own busy state: the OS dialog can stay open for a long time, so the
 * rest of the form stays usable while the operator browses.
 */
function DirectoryTextInput(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  inputClass: string
  disabled: boolean
  onChange: (key: EditableKey, value: ConfigValue) => void
  onPick: () => Promise<void>
}): JSX.Element {
  const { field, value, inputClass, disabled, onChange, onPick } = props
  const [picking, setPicking] = useState(false)
  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      await onPick()
    } finally {
      setPicking(false)
    }
  }
  return (
    <div className="dsh-channels-cfg__inputRow">
      <input
        type="text"
        className={inputClass}
        value={String(value ?? '')}
        placeholder={field.placeholder}
        aria-label={field.label}
        disabled={disabled || picking}
        onChange={event => onChange(field.key, event.target.value)}
      />
      <button
        type="button"
        className="dsh-channels-cfg__btn dsh-channels-cfg__btn--browse"
        disabled={disabled || picking}
        onClick={() => { void pick() }}
      >
        {picking ? PANEL_COPY.browsingDirectory : PANEL_COPY.browseDirectory}
      </button>
    </div>
  )
}

/**
 * `string-list` control: one single-line input per entry, each with a remove
 * button, and an add button below (disabled at `maxItems` inputs). An empty
 * list renders one blank input so the first entry can be typed directly.
 * Issues carrying an `index` mark that input and show the reason under it.
 */
function StringListInput(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  issues: readonly FieldIssueWire[]
  disabled: boolean
  onChange: (key: EditableKey, value: ConfigValue) => void
}): JSX.Element {
  const { field, value, issues, disabled, onChange } = props
  const empty = listItems(value).length === 0
  const rows = listRows(value)
  return (
    <div className="dsh-channels-cfg__list">
      {rows.map((item, index) => {
        const issue = issues.find(entry => entry.index === index)
        const position = PANEL_COPY.listEntry.replace('{n}', String(index + 1))
        // Entries have no identity beyond their position, so the index is the key.
        return (
          <div className="dsh-channels-cfg__listItem" key={index}>
            <div className="dsh-channels-cfg__inputRow">
              <input
                type="text"
                className={`dsh-channels-cfg__input${issue === undefined ? '' : ' dsh-channels-cfg__input--invalid'}`}
                value={item}
                placeholder={field.placeholder}
                aria-label={`${field.label} ${position}`}
                aria-invalid={issue === undefined ? undefined : true}
                disabled={disabled}
                onChange={event => onChange(field.key, withListEntry(rows, index, event.target.value))}
              />
              {empty
                ? null
                : (
                    <button
                      type="button"
                      className="dsh-channels-cfg__btn dsh-channels-cfg__btn--listRemove"
                      aria-label={`${PANEL_COPY.listRemove} ${position}`}
                      disabled={disabled}
                      onClick={() => onChange(field.key, withoutListEntry(rows, index))}
                    >
                      {PANEL_COPY.listRemove}
                    </button>
                  )}
            </div>
            {issue === undefined ? null : <span className="dsh-channels-cfg__fieldError">{issue.message}</span>}
          </div>
        )
      })}
      <div>
        <button
          type="button"
          className="dsh-channels-cfg__btn"
          disabled={disabled || listIsFull(field, rows)}
          onClick={() => onChange(field.key, withBlankListEntry(rows))}
        >
          {PANEL_COPY.listAdd}
        </button>
      </div>
    </div>
  )
}

/** One generic form control driven by the Host field descriptor. */
export function FieldRow(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  issues: FieldIssueWire[]
  disabled?: boolean
  onChange: (key: EditableKey, value: ConfigValue) => void
  /** Present only for `field.browse === 'directory'` rows the page can serve. */
  onPickDirectory?: () => Promise<void>
}): JSX.Element {
  const { field, value, issues, disabled = false, onChange, onPickDirectory } = props
  // Entry issues (`index` set) are rendered next to their input by StringListInput.
  const issue = issues.find(item => item.key === field.key && item.index === undefined)
  const entryIssues = issues.filter(item => item.key === field.key && item.index !== undefined)
  const inputClass = `dsh-channels-cfg__input${issue === undefined ? '' : ' dsh-channels-cfg__input--invalid'}`
  const fieldClass = `dsh-channels-cfg__field${field.wide === true ? ' dsh-channels-cfg__field--wide' : ''}`
  return (
    <div className={fieldClass}>
      <div className="dsh-channels-cfg__labelRow">
        <span className="dsh-channels-cfg__label">{field.label}</span>
        {field.restartRequired
          ? <span className="dsh-channels-cfg__tag dsh-channels-cfg__tag--restart">{PANEL_COPY.restartTag}</span>
          : null}
      </div>
      {field.kind === 'boolean'
        ? (
            <label className="dsh-channels-cfg__check">
              <input
                type="checkbox"
                className="dsh-channels-cfg__checkbox"
                checked={value === true}
                aria-label={field.label}
                disabled={disabled}
                onChange={event => onChange(field.key, event.target.checked)}
              />
              <span>{value === true ? PANEL_COPY.enabled : PANEL_COPY.disabled}</span>
            </label>
          )
        : null}
      {field.kind === 'select'
        ? (
            <select
              className={inputClass}
              value={String(value ?? '')}
              disabled={disabled || field.disabled === true}
              aria-label={field.label}
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
              aria-label={field.label}
              disabled={disabled}
              onChange={event => onChange(field.key, event.target.value)}
            />
          )
        : null}
      {field.kind === 'text'
        ? (field.browse === 'directory' && onPickDirectory !== undefined
            ? (
                <DirectoryTextInput
                  field={field}
                  value={value}
                  inputClass={inputClass}
                  disabled={disabled}
                  onChange={onChange}
                  onPick={onPickDirectory}
                />
              )
            : (
                <input
                  type="text"
                  className={inputClass}
                  value={String(value ?? '')}
                  placeholder={field.placeholder}
                  aria-label={field.label}
                  disabled={disabled}
                  onChange={event => onChange(field.key, event.target.value)}
                />
              ))
        : null}
      {field.kind === 'string-list'
        ? (
            <StringListInput
              field={field}
              value={value}
              issues={entryIssues}
              disabled={disabled}
              onChange={onChange}
            />
          )
        : null}
      {field.help === undefined ? null : <span className="dsh-channels-cfg__help">{field.help}</span>}
      {issue === undefined ? null : <span className="dsh-channels-cfg__fieldError">{issue.message}</span>}
    </div>
  )
}

/**
 * One tab's editable fields, partitioned by the Host field groups that the tab
 * owns (`TAB_FIELD_GROUPS`). Empty groups render nothing, so a Host that moves
 * every key out of a group does not leave a stray heading behind.
 */
export function FieldsCard(props: {
  form: FormView
  groups: readonly FieldGroup[]
}): JSX.Element | null {
  const { form, groups } = props
  const sections = groups
    .map(group => ({
      group,
      label: FIELD_GROUP_LABELS[group],
      fields: form.fields.filter(field => field.group === group),
    }))
    .filter(section => section.fields.length > 0)
  if (sections.length === 0) return null
  return (
    <section className="dsh-channels-cfg__card">
      {sections.map(section => (
        <div className="dsh-channels-cfg__group" key={section.group}>
          <div className="dsh-channels-cfg__labelRow">
            <span className="dsh-channels-cfg__cardTitle">{section.label}</span>
          </div>
          <div className="dsh-channels-cfg__grid">
            {section.fields.map((field) => {
              const onPick = form.onPickDirectory
              return (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={form.draft[field.key] ?? effectiveValue(form.panel, field.key)}
                  issues={form.issues}
                  disabled={form.locked}
                  onChange={form.onChange}
                  onPickDirectory={onPick === undefined ? undefined : () => onPick(field.key)}
                />
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}

/** The unified per-tab action bar: save every dirty field or drop the draft. */
export function SaveBar(props: { form: FormView; tab: PanelTabId }): JSX.Element {
  const { form, tab } = props
  const groups = new Set<string>(TAB_FIELD_GROUPS[tab])
  const pageDirty = form.fields.filter(field => groups.has(field.group) && field.key in form.draft).length
  // Saving submits the whole draft, so any dirty key (any tab) enables it;
  // discarding only clears this tab, so it follows this tab's own count.
  const dirty = form.dirtyCount > 0
  const disabled = !dirty || form.busy !== null || form.locked
  return (
    <div className="dsh-channels-cfg__footer">
      <button
        type="button"
        className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
        onClick={form.onSave}
        disabled={disabled}
      >
        {form.busy === 'save' ? PANEL_COPY.saving : PANEL_COPY.save}
      </button>
      <button
        type="button"
        className="dsh-channels-cfg__btn"
        onClick={() => form.onDiscardTab(tab)}
        disabled={pageDirty === 0 || form.busy !== null || form.locked}
      >
        {PANEL_COPY.discardTab}
      </button>
      <span className="dsh-channels-cfg__spacer" />
      {pageDirty > 0
        ? (
            <span className="dsh-channels-cfg__tag dsh-channels-cfg__tag--dirty">
              {PANEL_COPY.dirtyCount} {pageDirty}
            </span>
          )
        : dirty
          ? (
              <span className="dsh-channels-cfg__tag dsh-channels-cfg__tag--dirty">
                {PANEL_COPY.dirtyCount} {form.dirtyCount}（其他标签页）
              </span>
            )
          : null}
      <span className="dsh-channels-cfg__help">
        {dirty ? PANEL_COPY.saveHintDirty : PANEL_COPY.saveHintClean}
      </span>
    </div>
  )
}

/** Muted help paragraph introducing one tab. */
export function TabHelp(props: { text: string }): JSX.Element {
  return <p className="dsh-channels-cfg__tabHelp">{props.text}</p>
}

/** Transient page-level banner (save / credentials / reconnect / catalog). */
export function NoticeBar(props: { notice: Notice }): JSX.Element {
  const { notice } = props
  return (
    <div
      className={`dsh-channels-cfg__notice dsh-channels-cfg__notice--${notice.kind === 'ok' ? 'ok' : 'error'}`}
      role="status"
      aria-live="polite"
    >
      <span>{notice.text}</span>
    </div>
  )
}

/** Muted empty/blocked state (e.g. access lists before the channel connects). */
export function EmptyState(props: { text: string }): JSX.Element {
  return <div className="dsh-channels-cfg__emptyState">{props.text}</div>
}

/** Human label for the official SDK's WebSocket lifecycle state. */
export function connectionStateLabel(state: string | undefined): { text: string; tone: BadgeTone } {
  switch (state) {
    case 'connected': return { text: PANEL_COPY.phaseConnected, tone: 'ok' }
    case 'connecting': return { text: PANEL_COPY.phaseConnecting, tone: 'warn' }
    case 'reconnecting': return { text: PANEL_COPY.phaseConnecting, tone: 'warn' }
    case 'failed': return { text: PANEL_COPY.phaseError, tone: 'bad' }
    case 'idle': return { text: PANEL_COPY.phaseIdle, tone: 'muted' }
    default: return { text: state ?? PANEL_COPY.unknownValue, tone: 'muted' }
  }
}
