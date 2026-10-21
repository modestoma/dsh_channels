/**
 * 设置 →「飞书渠道」页面：数据加载、5 秒状态轮询、全局 draft 与顶部状态头 /
 * tab 导航的外壳。
 *
 * 所有 Host 交互（panel / status / catalog / config / credentials / access /
 * pick-directory）都集中在这里；tab 组件只接收渲染所需的数据与
 * 回调。页面不 import 任何 DSH 客户端包，只依赖 react 与 `settings.section`
 * 槽位。
 *
 * @module dsh-channels/client/panel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { PANEL_COPY, PANEL_TABS, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type {
  AccessWire,
  CatalogWire,
  ChannelStatusWire,
  ConfigValue,
  CredentialField,
  EditableKey,
  EditableValues,
  FieldIssueWire,
  PanelTabId,
  PanelWire,
} from '../../settings/contract.ts'
import {
  addAccessGroup,
  addAccessUser,
  clearConfig,
  clearCredential,
  fetchCatalog,
  fetchPanel,
  fetchStatus,
  pickDirectory as requestDirectoryPicker,
  reconnect,
  removeAccessGroup,
  removeAccessUser,
  resolveAccessRequest,
  saveConfig,
  saveCredentials,
} from '../api.ts'
import { applyCatalogFields, catalogFromFields } from '../catalog.ts'
import { AccessTab } from './access-tab.tsx'
import { AdvancedTab } from './advanced-tab.tsx'
import { ConnectionTab } from './connection-tab.tsx'
import { ModelTab } from './model-tab.tsx'
import { SessionsTab } from './sessions-tab.tsx'
import {
  fieldLabel,
  messageOf,
  NoticeBar,
  phaseBadge,
  phaseSummary,
  validateDraft,
} from './shared.tsx'
import type {
  BusyAction,
  CredentialsView,
  FormView,
  LoadState,
  Notice,
} from './shared.tsx'
import { WorkspaceTab } from './workspace-tab.tsx'

/** Owner props handed to a `settings.section` contribution (unused beyond parity). */
export interface FeishuChannelsSectionProps {
  close?: () => void
}

/** Page shell: one panel payload, one status poll, one global config draft. */
export function FeishuChannelsSection(_props: FeishuChannelsSectionProps): JSX.Element | null {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [activeTab, setActiveTab] = useState<PanelTabId>('connection')
  const [draft, setDraft] = useState<EditableValues>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [status, setStatus] = useState<ChannelStatusWire | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [appIdInput, setAppIdInput] = useState('')
  const [appSecretInput, setAppSecretInput] = useState('')
  const [catalog, setCatalog] = useState<CatalogWire | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [accessNotice, setAccessNotice] = useState<string | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)
  const catalogTicket = useRef(0)
  /** Latest ready panel, read from the poll loop without restarting it. */
  const panelRef = useRef<PanelWire | null>(null)
  const panel = load.phase === 'ready' ? load.panel : null
  /** Host-side lifecycle busy: connecting/restarting blocks every panel write. */
  const hostBusy = (status ?? panel?.status)?.busy === true
  useEffect(() => {
    panelRef.current = panel
  }, [panel])

  const loadPanel = useCallback(async (): Promise<void> => {
    setLoad({ phase: 'loading' })
    setNotice(null)
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
        const previousPhase = panelRef.current?.status.phase
        const next = await fetchStatus()
        if (cancelled) return
        setStatus(next)
        setPollError(null)
        // A phase transition changes what the panel payload can offer: the
        // storage domain opens/closes with the connection, so the access
        // whitelists go stale. Re-read the panel but
        // never touch the dirty draft.
        if (previousPhase !== undefined && previousPhase !== next.phase) {
          try {
            const refreshed = await fetchPanel()
            if (!cancelled) {
              setLoad({ phase: 'ready', panel: refreshed })
              setStatus(refreshed.status)
            }
          } catch {
            // Keep the status-only update; the next manual refresh retries.
          }
        }
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
      const raw = draft[key] ?? panel.config.effective[key] ?? panel.config.base[key]
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

  /** Draft one field, cascading provider → model → effort like the Host catalog. */
  const updateDraft = useCallback((key: EditableKey, value: ConfigValue) => {
    if (panel === null) return
    const providerNow = String(
      draft.provider ?? panel.config.effective.provider ?? panel.config.base.provider ?? '',
    )
    setNotice(null)
    if (key === 'provider') {
      // Changing the provider invalidates the model/effort below it. When the
      // selected provider is the configured one, keep showing its configured
      // model; otherwise fall back to the inherit choice.
      const nextProvider = String(value ?? '')
      const configuredProvider = String(
        panel.config.effective.provider ?? panel.config.base.provider ?? '',
      )
      const keepModel = nextProvider === configuredProvider
        ? String(panel.config.effective.model ?? panel.config.base.model ?? '')
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
   * Manual refresh: reload the whole panel payload so access lists and
   * `restartPendingKeys` catch up with the Host. The dirty draft is
   * deliberately preserved — refreshing never discards user input.
   */
  const onRefresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchPanel()
      setLoad({ phase: 'ready', panel: next })
      setStatus(next.status)
      setPollError(null)
      setAccessNotice(null)
      setAccessError(null)
    } catch (error) {
      setPollError(messageOf(error))
    }
  }, [])

  /** Submit every dirty field at once; the Host persists and re-validates. */
  const onSave = useCallback(async (): Promise<void> => {
    if (panel === null) return
    const { values, issues } = validateDraft(panel, draft)
    if (issues.length > 0) {
      // Name the offending fields: with one draft shared by every tab, the
      // user may be looking at a different tab than the invalid field.
      const detail = issues
        .map(issue => `${fieldLabel(panel.config.fields, issue.key as EditableKey)} ${issue.message}`)
        .join('；')
      setNotice({ kind: 'error', text: `${PANEL_COPY.saveInvalid}：${detail}`, issues })
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
      // Clear only the submitted keys: edits typed while the request was in
      // flight stay in the draft instead of being silently discarded.
      setDraft(previous => {
        const next = { ...previous }
        for (const key of Object.keys(values) as EditableKey[]) delete next[key]
        return next
      })
      setNotice({ kind: 'ok', text: PANEL_COPY.saved })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }, [draft, panel])

  /** Drop the draft keys owned by one tab (nothing is written). */
  const discardTab = useCallback((tab: PanelTabId): void => {
    if (panel === null) return
    const groups = new Set<string>(TAB_FIELD_GROUPS[tab])
    const keys = new Set(
      panel.config.fields.filter(field => groups.has(field.group)).map(field => field.key),
    )
    setDraft((previous) => {
      const next = { ...previous }
      for (const key of keys) delete next[key]
      return next
    })
    setNotice(null)
    if (tab === 'model') {
      catalogTicket.current += 1
      setCatalog(catalogFromFields(panel.config.fields))
      setCatalogBusy(false)
    }
  }, [panel])

  /**
   * Open the host's native directory chooser (workspace root「选择目录…」) and
   * stage the picked absolute path as a draft value. Nothing is persisted until
   *「保存更改」; a canceled dialog is a no-op, not an error.
   */
  const onPickDirectory = useCallback(async (key: EditableKey): Promise<void> => {
    setNotice(null)
    try {
      const result = await requestDirectoryPicker()
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error })
        return
      }
      if ('canceled' in result) return
      setDraft(previous => ({ ...previous, [key]: result.path }))
      setNotice({ kind: 'ok', text: `${PANEL_COPY.directoryPicked}：${result.path}` })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    }
  }, [])

  /** Drop every Web override and return the refreshed panel. */
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

  const running = (status ?? panel?.status)?.running === true

  /**
   * The single connect/reconnect action: open a stopped channel or restart a
   * running one. Only a restart interrupts live replies, so only it confirms.
   */
  const onReconnect = useCallback(async (): Promise<void> => {
    if (running) {
      const confirmed = typeof window.confirm === 'function'
        ? window.confirm(PANEL_COPY.restartWarning)
        : true
      if (!confirmed) return
    }
    setBusy('reconnect')
    setNotice(null)
    try {
      const result = await reconnect()
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error })
        // Incomplete credentials: send the user back to the onboarding form.
        if (result.unconfigured === true) setActiveTab('connection')
        await refreshStatus()
        return
      }
      setLoad({ phase: 'ready', panel: result.panel })
      setStatus(result.panel.status)
      setNotice({ kind: 'ok', text: running ? PANEL_COPY.reconnectDone : PANEL_COPY.connectDone })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      await refreshStatus()
    } finally {
      setBusy(null)
    }
  }, [refreshStatus, running])

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

  const onAddAccessUser = useCallback(async (userId: string, name: string): Promise<boolean> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await addAccessUser(userId, name)
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

  const onRemoveAccessUser = useCallback(async (userId: string): Promise<void> => {
    setBusy('access')
    setAccessError(null)
    setAccessNotice(null)
    try {
      const result = await removeAccessUser(userId)
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

  /** Save provided credential values; the Host reconnects automatically when ready. */
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
          : result.reconnect === 'unconfigured'
            ? PANEL_COPY.credentialSavedUnconfigured
            : result.reconnect === 'failed'
              ? PANEL_COPY.credentialAutoConnectFailed
              : PANEL_COPY.credentialSaved
      setNotice({
        kind: result.reconnect === 'failed' || result.autoReconnectError !== undefined ? 'error' : 'ok',
        text: result.autoReconnectError === undefined
          ? base
          : `${base}：${result.autoReconnectError}`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }, [appIdInput, appSecretInput])

  const onClearCredential = useCallback(async (field: CredentialField): Promise<void> => {
    const confirmed = typeof window.confirm === 'function'
      ? window.confirm(PANEL_COPY.credentialRemoveConfirm)
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

  const issues = useMemo<FieldIssueWire[]>(
    () => (notice?.kind === 'error' ? notice.issues ?? [] : []),
    [notice],
  )
  const dirtyCount = Object.keys(draft).length

  /** Which tabs currently own a dirty key (the dot is per tab, not global). */
  const dirtyTabs = useMemo<ReadonlySet<PanelTabId>>(() => {
    const tabs = new Set<PanelTabId>()
    if (panel === null || dirtyCount === 0) return tabs
    const groupOf = new Map(panel.config.fields.map(field => [field.key, field.group]))
    for (const key of Object.keys(draft)) {
      const group = groupOf.get(key as EditableKey)
      if (group === undefined) continue
      for (const tab of PANEL_TABS) {
        if (TAB_FIELD_GROUPS[tab.id].includes(group)) tabs.add(tab.id)
      }
    }
    return tabs
  }, [dirtyCount, draft, panel])

  const form = useMemo<FormView | null>(() => {
    if (panel === null) return null
    return {
      panel,
      fields: renderedFields,
      draft,
      issues,
      busy,
      locked: hostBusy,
      dirtyCount,
      onChange: updateDraft,
      onSave: () => { void onSave() },
      onDiscardTab: discardTab,
      onPickDirectory,
    }
  }, [busy, discardTab, dirtyCount, draft, hostBusy, issues, onPickDirectory, onSave, panel, renderedFields, updateDraft])

  const credentials = useMemo<CredentialsView>(() => ({
    appId: appIdInput,
    appSecret: appSecretInput,
    issues,
    busy,
    locked: hostBusy,
    onAppIdChange: setAppIdInput,
    onAppSecretChange: setAppSecretInput,
    onSave: () => { void onSaveCredentials() },
    onClear: (field: CredentialField) => { void onClearCredential(field) },
  }), [appIdInput, appSecretInput, busy, hostBusy, issues, onClearCredential, onSaveCredentials])

  if (load.phase === 'loading') {
    return (
      <div className="dsh-channels-cfg">
        <div className="dsh-channels-cfg__loading">{PANEL_COPY.loading}</div>
      </div>
    )
  }
  if (load.phase === 'error') {
    return (
      <div className="dsh-channels-cfg">
        <div className="dsh-channels-cfg__error">
          <strong>{PANEL_COPY.loadFailed}</strong>
          <span>{load.message}</span>
          <div>
            <button type="button" className="dsh-channels-cfg__btn" onClick={() => { void loadPanel() }}>
              {PANEL_COPY.retry}
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (form === null) return null
  const current = status ?? load.panel.status

  return (
    <div className="dsh-channels-cfg">
      <PanelHeader
        status={current}
        pollError={pollError}
        busy={busy}
        locked={hostBusy}
        onRefresh={() => { void onRefresh() }}
      />
      <TabNav activeTab={activeTab} dirtyTabs={dirtyTabs} onChange={setActiveTab} />
      {notice === null ? null : <NoticeBar notice={notice} />}
      <div
        role="tabpanel"
        id={`dsh-channels-tabpanel-${activeTab}`}
        aria-labelledby={`dsh-channels-tab-${activeTab}`}
      >
        {activeTab === 'connection'
          ? (
              <ConnectionTab
                panel={form.panel}
                status={current}
                busy={busy}
                credentials={credentials}
                onReconnect={() => { void onReconnect() }}
              />
            )
          : null}
        {activeTab === 'sessions' ? <SessionsTab form={form} /> : null}
        {activeTab === 'model' ? <ModelTab form={form} catalogBusy={catalogBusy} /> : null}
        {activeTab === 'workspace'
          ? (
              <WorkspaceTab form={form} />
            )
          : null}
        {activeTab === 'access'
          ? (
              <AccessTab
                form={form}
                accessNotice={accessNotice}
                accessError={accessError}
                onAddGroup={onAddAccessGroup}
                onRemoveGroup={chatId => { void onRemoveAccessGroup(chatId) }}
                onAddUser={onAddAccessUser}
                onRemoveUser={userId => { void onRemoveAccessUser(userId) }}
                onResolveRequest={(token, decision) => { void onResolveAccessRequest(token, decision) }}
              />
            )
          : null}
        {activeTab === 'advanced'
          ? <AdvancedTab form={form} onClear={() => { void onClear() }} />
          : null}
      </div>
    </div>
  )
}

/** Page header: title + phase badge + refresh, visible on every tab. */
function PanelHeader(props: {
  status: ChannelStatusWire
  pollError: string | null
  busy: BusyAction | null
  locked: boolean
  onRefresh: () => void
}): JSX.Element {
  const { status, pollError, busy, locked, onRefresh } = props
  const badge = phaseBadge(status.phase)
  return (
    <header className="dsh-channels-cfg__panelHead" title={PANEL_COPY.description}>
      <div className="dsh-channels-cfg__headRow">
        <h2 className="dsh-channels-cfg__title">{PANEL_COPY.title}</h2>
        <span className={`dsh-channels-cfg__badge dsh-channels-cfg__badge--${badge.tone}`}>
          <span className="dsh-channels-cfg__dot" />
          {badge.text}
        </span>
        <span className="dsh-channels-cfg__spacer" />
        <button
          type="button"
          className="dsh-channels-cfg__btn"
          onClick={onRefresh}
          disabled={busy !== null || locked}
        >
          {PANEL_COPY.refresh}
        </button>
      </div>
      <p className="dsh-channels-cfg__summary">{phaseSummary(status.phase)}</p>
      {pollError === null
        ? null
        : (
            <span className="dsh-channels-cfg__fieldError" role="status" aria-live="polite">
              {PANEL_COPY.pollFailed}：{pollError}
            </span>
          )}
    </header>
  )
}

/** Top-level tab navigation; the dirty dot keeps unsaved work visible per tab. */
function TabNav(props: {
  activeTab: PanelTabId
  dirtyTabs: ReadonlySet<PanelTabId>
  onChange: (tab: PanelTabId) => void
}): JSX.Element {
  const { activeTab, dirtyTabs, onChange } = props
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  /** Roving-focus keyboard navigation between tabs (WAI-ARIA tabs pattern). */
  const onKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    const last = PANEL_TABS.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = index === last ? 0 : index + 1; break
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break
      case 'Home': next = 0; break
      case 'End': next = last; break
      default: return
    }
    event.preventDefault()
    onChange(PANEL_TABS[next]!.id)
    refs.current[next]?.focus()
  }

  return (
    <nav className="dsh-channels-cfg__tabs" role="tablist" aria-label={PANEL_COPY.title}>
      {PANEL_TABS.map((tab, index) => {
        const selected = tab.id === activeTab
        const dirty = dirtyTabs.has(tab.id)
        return (
          <button
            key={tab.id}
            ref={(node) => { refs.current[index] = node }}
            type="button"
            role="tab"
            id={`dsh-channels-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={selected ? `dsh-channels-tabpanel-${tab.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            className="dsh-channels-cfg__tab"
            onClick={() => onChange(tab.id)}
            onKeyDown={event => onKeyDown(index, event)}
          >
            {tab.label}
            {dirty
              ? (
                  <span
                    className="dsh-channels-cfg__tabDot"
                    title={PANEL_COPY.dirtyCount}
                    aria-label={PANEL_COPY.dirtyCount}
                  />
                )
              : null}
          </button>
        )
      })}
    </nav>
  )
}
