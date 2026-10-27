/**
 * 设置面板共享层：页面状态类型、Host 字段渲染原语（SettingRow /
 * FieldSections / SaveBar）、分区与列表原语、生命周期徽标与纯格式化工具。
 *
 * 这一层不发请求、不持有页面状态，只把 Host 下发的 wire 数据渲染成控件；
 * 页面外壳在 `index.tsx`，各 tab 只组合这些原语。
 *
 * @module dsh-channels/client/panel/shared
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  BYTES_UNIT,
  COLLAPSED_FIELD_GROUPS,
  FIELD_GROUP_LABELS,
  fillCopy,
  PANEL_COPY,
} from '../../settings/contract.ts'
import type {
  ChannelPhaseWire,
  ConfigValue,
  CredentialField,
  EditableFieldWire,
  EditableKey,
  EditableValues,
  FieldGroup,
  FieldIssueWire,
  PanelWire,
} from '../../settings/contract.ts'
import { bytesReading, numberDraftValue, numberInputStep, numberInputValue } from '../number-field.ts'
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
  /** Per-field validation failures rendered inline by SettingRow. */
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

/** Tone of a small pill; maps onto `dsh-channels-cfg__pill--*` classes. */
export type BadgeTone = 'ok' | 'warn' | 'bad' | 'muted'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Compact duration for the page header. */
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

/**
 * Turn the dirty draft into the wire payload, keeping the Host-descriptor
 * bounds check client-side (the Host re-validates every value on save).
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
      const parsed = numberDraftValue(field, raw)
      if (parsed.ok) values[field.key] = parsed.value
      else issues.push({ key: field.key, message: parsed.message })
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

/** Header pill for the Host-derived lifecycle phase. */
export function phaseBadge(phase: ChannelPhaseWire): { text: string; tone: BadgeTone } {
  switch (phase) {
    case 'connected': return { text: PANEL_COPY.phaseConnected, tone: 'ok' }
    case 'connecting': return { text: PANEL_COPY.phaseConnecting, tone: 'warn' }
    case 'error': return { text: PANEL_COPY.phaseError, tone: 'bad' }
    case 'idle': return { text: PANEL_COPY.phaseIdle, tone: 'muted' }
    default: return { text: PANEL_COPY.phaseUnconfigured, tone: 'muted' }
  }
}

/** One-line explanation of the current phase (connection tab status block). */
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

/** Analyze API token editor data owned by the page shell, rendered by the advanced tab. */
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
  onChange: (key: EditableKey, value: ConfigValue) => void
  /**
   * Open the Host's native directory chooser and write the picked absolute
   * path into the draft (not saved until「保存」). Absent when the Host
   * cannot offer a native chooser.
   */
  onPickDirectory?: (key: EditableKey) => Promise<void>
}

/** Small rounded status pill. */
export function Pill(props: { tone: BadgeTone; dot?: boolean; children: ReactNode }): JSX.Element {
  return (
    <span className={`dsh-channels-cfg__pill dsh-channels-cfg__pill--${props.tone}`}>
      {props.dot === true ? <span className="dsh-channels-cfg__dot" /> : null}
      {props.children}
    </span>
  )
}

/** One titled section: a muted heading above a bordered row list. */
export function Section(props: {
  title: ReactNode
  footnote?: ReactNode
  tone?: 'warn'
  children: ReactNode
}): JSX.Element {
  const { title, footnote, tone, children } = props
  return (
    <section className="dsh-channels-cfg__sec">
      <h3 className="dsh-channels-cfg__secTitle">{title}</h3>
      <div className={`dsh-channels-cfg__list${tone === 'warn' ? ' dsh-channels-cfg__list--warn' : ''}`}>
        {children}
      </div>
      {footnote === undefined ? null : <p className="dsh-channels-cfg__secFoot">{footnote}</p>}
    </section>
  )
}

/**
 * One setting row: label (with tags and the「详情」toggle) and a one-line
 * summary on the left, the control on the right. `details` renders below the
 * row once expanded; `wide` puts the control under the text.
 */
export function Row(props: {
  label: ReactNode
  tags?: ReactNode
  summary?: ReactNode
  details?: ReactNode
  control?: ReactNode
  error?: ReactNode
  wide?: boolean
  leading?: ReactNode
}): JSX.Element {
  const { label, tags, summary, details, control, error, wide = false, leading } = props
  const [open, setOpen] = useState(false)
  return (
    <div className="dsh-channels-cfg__rowWrap">
      <div className={`dsh-channels-cfg__row${wide ? ' dsh-channels-cfg__row--wide' : ''}`}>
        {leading}
        <div className="dsh-channels-cfg__rowText">
          <div className="dsh-channels-cfg__rowLabel">
            <span>{label}</span>
            {tags}
            {details === undefined
              ? null
              : (
                  <button
                    type="button"
                    className="dsh-channels-cfg__more"
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                  >
                    {PANEL_COPY.details}
                  </button>
                )}
          </div>
          {summary === undefined ? null : <div className="dsh-channels-cfg__rowSummary">{summary}</div>}
        </div>
        {control === undefined ? null : <div className="dsh-channels-cfg__rowCtl">{control}</div>}
      </div>
      {open && details !== undefined ? <div className="dsh-channels-cfg__details">{details}</div> : null}
      {error === undefined || error === null ? null : <div className="dsh-channels-cfg__rowError">{error}</div>}
    </div>
  )
}

/** Accessible on/off switch. */
export function Switch(props: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  const { checked, label, disabled = false, onChange } = props
  return (
    <button
      type="button"
      role="switch"
      className="dsh-channels-cfg__switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
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
        className="dsh-channels-cfg__btn"
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
 * button, and an add link below (disabled at `maxItems` inputs). An empty
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
    <div className="dsh-channels-cfg__stringList">
      {rows.map((item, index) => {
        const issue = issues.find(entry => entry.index === index)
        const position = PANEL_COPY.listEntry.replace('{n}', String(index + 1))
        // Entries have no identity beyond their position, so the index is the key.
        return (
          <div className="dsh-channels-cfg__stringListItem" key={index}>
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
                      className="dsh-channels-cfg__btn dsh-channels-cfg__btn--remove"
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
          className="dsh-channels-cfg__link"
          disabled={disabled || listIsFull(field, rows)}
          onClick={() => onChange(field.key, withBlankListEntry(rows))}
        >
          ＋ {PANEL_COPY.listAdd}
        </button>
      </div>
    </div>
  )
}

/** Number input with its unit (and a MiB reading for byte counts). */
function NumberInput(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  inputClass: string
  disabled: boolean
  onChange: (key: EditableKey, value: ConfigValue) => void
}): JSX.Element {
  const { field, value, inputClass, disabled, onChange } = props
  const text = numberInputValue(field, value)
  const reading = field.unit === BYTES_UNIT ? bytesReading(text) : undefined
  return (
    <div className="dsh-channels-cfg__inputRow">
      {reading === undefined ? null : <span className="dsh-channels-cfg__bytes">{reading}</span>}
      <input
        type="number"
        className={`${inputClass} dsh-channels-cfg__input--num`}
        value={text}
        placeholder={field.placeholder}
        step={numberInputStep(field)}
        aria-label={field.label}
        disabled={disabled}
        onChange={event => onChange(field.key, event.target.value)}
      />
      {field.unit === undefined ? null : <span className="dsh-channels-cfg__unit">{field.unit}</span>}
    </div>
  )
}

/** The control for one Host field descriptor. */
function FieldControl(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  issues: readonly FieldIssueWire[]
  invalid: boolean
  disabled: boolean
  onChange: (key: EditableKey, value: ConfigValue) => void
  onPickDirectory?: () => Promise<void>
}): JSX.Element | null {
  const { field, value, issues, invalid, disabled, onChange, onPickDirectory } = props
  const inputClass = `dsh-channels-cfg__input${invalid ? ' dsh-channels-cfg__input--invalid' : ''}`
  switch (field.kind) {
    case 'boolean':
      return <Switch checked={value === true} label={field.label} disabled={disabled} onChange={next => onChange(field.key, next)} />
    case 'select': {
      const toggle = field.toggle
      if (toggle !== undefined) {
        return (
          <Switch
            checked={value === toggle.on}
            label={field.label}
            disabled={disabled}
            onChange={next => onChange(field.key, next ? toggle.on : toggle.off)}
          />
        )
      }
      return (
        <select
          className={`${inputClass} dsh-channels-cfg__select`}
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
    }
    case 'number':
      return <NumberInput field={field} value={value} inputClass={inputClass} disabled={disabled} onChange={onChange} />
    case 'text':
      return field.browse === 'directory' && onPickDirectory !== undefined
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
              className={`${inputClass}${field.wide === true ? '' : ' dsh-channels-cfg__input--text'}`}
              value={String(value ?? '')}
              placeholder={field.placeholder}
              aria-label={field.label}
              disabled={disabled}
              onChange={event => onChange(field.key, event.target.value)}
            />
          )
    case 'string-list':
      return <StringListInput field={field} value={value} issues={issues} disabled={disabled} onChange={onChange} />
    default:
      // Unknown kinds come from a newer Host; render nothing instead of a broken control.
      return null
  }
}

/** One Host field rendered as a setting row. */
export function SettingRow(props: {
  field: EditableFieldWire
  value: ConfigValue | undefined
  issues: readonly FieldIssueWire[]
  disabled?: boolean
  onChange: (key: EditableKey, value: ConfigValue) => void
  /** Present only for `field.browse === 'directory'` rows the page can serve. */
  onPickDirectory?: () => Promise<void>
}): JSX.Element {
  const { field, value, issues, disabled = false, onChange, onPickDirectory } = props
  // Entry issues (`index` set) are rendered next to their input by StringListInput.
  const issue = issues.find(item => item.key === field.key && item.index === undefined)
  const entryIssues = issues.filter(item => item.key === field.key && item.index !== undefined)
  return (
    <Row
      label={field.label}
      tags={field.restartRequired ? <span className="dsh-channels-cfg__tag">{PANEL_COPY.restartTag}</span> : undefined}
      summary={field.summary}
      details={field.help}
      wide={field.wide === true}
      error={issue?.message}
      control={(
        <FieldControl
          field={field}
          value={value}
          issues={entryIssues}
          invalid={issue !== undefined}
          disabled={disabled}
          onChange={onChange}
          onPickDirectory={onPickDirectory}
        />
      )}
    />
  )
}

/** Rows for every field of one group. */
function GroupRows(props: { form: FormView; fields: readonly EditableFieldWire[] }): JSX.Element {
  const { form, fields } = props
  return (
    <>
      {fields.map((field) => {
        const onPick = form.onPickDirectory
        return (
          <SettingRow
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
    </>
  )
}

/**
 * A group of rarely changed fields behind one summary row. It opens on its
 * own when one of its fields has a validation issue.
 */
function CollapsedGroup(props: { form: FormView; fields: readonly EditableFieldWire[] }): JSX.Element {
  const { form, fields } = props
  const [open, setOpen] = useState(false)
  const keys = new Set<string>(fields.map(field => field.key))
  const changed = fields.filter(field =>
    form.panel.config.overriddenKeys.includes(field.key) || field.key in form.draft).length
  const expanded = open || form.issues.some(issue => keys.has(issue.key))
  return (
    <>
      <Row
        label={fillCopy(PANEL_COPY.collapsedCount, { n: fields.length })}
        summary={changed === 0 ? PANEL_COPY.collapsedClean : fillCopy(PANEL_COPY.collapsedChanged, { n: changed })}
        control={(
          <button type="button" className="dsh-channels-cfg__more" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            {expanded ? PANEL_COPY.collapse : PANEL_COPY.expand}
          </button>
        )}
      />
      {expanded ? <GroupRows form={form} fields={fields} /> : null}
    </>
  )
}

/**
 * One tab's editable fields as titled sections, one per Host field group, in
 * the given order. Empty groups render nothing, so a Host that moves every key
 * out of a group does not leave a stray heading behind. `extra` appends rows
 * that are not Host fields (e.g. a credential) to one group's list.
 */
export function FieldSections(props: {
  form: FormView
  groups: readonly FieldGroup[]
  extra?: Partial<Record<FieldGroup, ReactNode>>
  footnotes?: Partial<Record<FieldGroup, ReactNode>>
}): JSX.Element {
  const { form, groups, extra = {}, footnotes = {} } = props
  return (
    <>
      {groups.map((group) => {
        const fields = form.fields.filter(field => field.group === group)
        const more = extra[group]
        if (fields.length === 0 && more === undefined) return null
        return (
          <Section key={group} title={FIELD_GROUP_LABELS[group]} footnote={footnotes[group]}>
            {COLLAPSED_FIELD_GROUPS.includes(group)
              ? <CollapsedGroup form={form} fields={fields} />
              : <GroupRows form={form} fields={fields} />}
            {more}
          </Section>
        )
      })}
    </>
  )
}

/**
 * Sticky bar shown only while the draft has unsaved keys. Saving submits the
 * whole draft (every tab); discarding drops it.
 */
export function SaveBar(props: {
  dirtyCount: number
  restartCount: number
  busy: BusyAction | null
  locked: boolean
  onSave: () => void
  onDiscard: () => void
}): JSX.Element | null {
  const { dirtyCount, restartCount, busy, locked, onSave, onDiscard } = props
  if (dirtyCount === 0) return null
  const disabled = busy !== null || locked
  return (
    <div className="dsh-channels-cfg__saveBar" role="region" aria-label={PANEL_COPY.save}>
      <span className="dsh-channels-cfg__saveMsg">
        {fillCopy(PANEL_COPY.dirtyCount, { n: dirtyCount })}
        {restartCount === 0 ? '' : fillCopy(PANEL_COPY.dirtyRestart, { n: restartCount })}
      </span>
      <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--ghost" onClick={onDiscard} disabled={disabled}>
        {PANEL_COPY.discard}
      </button>
      <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary" onClick={onSave} disabled={disabled}>
        {busy === 'save' ? PANEL_COPY.saving : PANEL_COPY.save}
      </button>
    </div>
  )
}

/** Transient banner (save / credentials / reconnect / catalog / access). */
export function NoticeBar(props: { kind: 'ok' | 'error'; text: string }): JSX.Element {
  const { kind, text } = props
  return (
    <div
      className={`dsh-channels-cfg__notice dsh-channels-cfg__notice--${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {text}
    </div>
  )
}

/** Muted row inside a list (empty or not-yet-loaded state). */
export function EmptyRow(props: { text: string }): JSX.Element {
  return <div className="dsh-channels-cfg__emptyRow">{props.text}</div>
}
