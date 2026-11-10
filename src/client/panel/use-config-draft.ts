/**
 * 设置面板的全局配置草稿：字段编辑（provider → model → 推理档位级联与目录
 * 刷新）、目录选择、保存 / 放弃 / 清除覆盖，以及每个标签页的未保存标记。
 *
 * @module dsh-channels/client/panel/use-config-draft
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PANEL_COPY, PANEL_TABS, TAB_FIELD_GROUPS } from '../../settings/contract.ts'
import type {
  CatalogWire,
  ConfigValue,
  EditableFieldWire,
  EditableKey,
  EditableValues,
  PanelTabId,
  PanelWire,
} from '../../settings/contract.ts'
import { clearConfig, fetchCatalog, pickDirectory as requestDirectoryPicker, saveConfig } from '../api.ts'
import { applyCatalogFields, catalogFromFields } from '../catalog.ts'
import { confirmAction, runPanelAction } from './actions.ts'
import type { PanelOps } from './actions.ts'
import { fieldLabel, messageOf, validateDraft } from './shared.tsx'

/** The draft, its rendered fields and its write operations. */
export interface ConfigDraft {
  draft: EditableValues
  /** Host descriptors after the live selector catalog has been layered on. */
  fields: readonly EditableFieldWire[]
  catalogBusy: boolean
  dirtyCount: number
  /** Dirty keys whose change needs a reconnect. */
  restartCount: number
  /** Which tabs currently own a dirty key (the dot is per tab, not global). */
  dirtyTabs: ReadonlySet<PanelTabId>
  update: (key: EditableKey, value: ConfigValue) => void
  pickDirectory: (key: EditableKey) => Promise<void>
  save: () => Promise<void>
  /** Drop the whole draft (nothing is written). */
  discard: () => void
  /** Drop every Web override after confirmation. */
  clearOverrides: () => Promise<void>
  /** Empty the draft without touching the catalog (panel reload). */
  reset: () => void
}

/**
 * Own the panel's single config draft.
 * @param panel - the ready panel, or null.
 * @param ops - the page-shell setters.
 * @returns the draft and its operations.
 */
export function useConfigDraft(panel: PanelWire | null, ops: PanelOps): ConfigDraft {
  const [draft, setDraft] = useState<EditableValues>({})
  const [catalog, setCatalog] = useState<CatalogWire | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const catalogTicket = useRef(0)
  const { setNotice } = ops

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
  }, [setNotice])

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

  const fields = useMemo(
    () => applyCatalogFields(panel?.config.fields ?? [], catalog, currentValues),
    [panel, catalog, currentValues],
  )

  /** Whether one selector currently renders as a dropdown for this form. */
  const isSelectField = useCallback(
    (key: EditableKey): boolean => fields.some(field => field.key === key && field.kind === 'select'),
    [fields],
  )

  /** Draft one field, cascading provider → model → effort like the Host catalog. */
  const update = useCallback((key: EditableKey, value: ConfigValue) => {
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
  }, [catalog, draft.provider, isSelectField, panel, refreshCatalog, setNotice])

  /**
   * Open the host's native directory chooser (workspace root「选择目录…」) and
   * stage the picked absolute path as a draft value. Nothing is persisted until
   *「保存更改」; a canceled dialog is a no-op, not an error.
   */
  const pickDirectory = useCallback(async (key: EditableKey): Promise<void> => {
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
  }, [setNotice])

  /** Submit every dirty field at once; the Host persists and re-validates. */
  const save = useCallback(async (): Promise<void> => {
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
    await runPanelAction(ops, 'save', async () => {
      const result = await saveConfig(values)
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error, issues: result.issues })
        return
      }
      ops.applyPanel(result.panel)
      // Clear only the submitted keys: edits typed while the request was in
      // flight stay in the draft instead of being silently discarded.
      setDraft(previous => {
        const next = { ...previous }
        for (const key of Object.keys(values) as EditableKey[]) delete next[key]
        return next
      })
      setNotice({ kind: 'ok', text: PANEL_COPY.saved })
    })
  }, [draft, ops, panel, setNotice])

  const discard = useCallback((): void => {
    if (panel === null) return
    setDraft({})
    setNotice(null)
    catalogTicket.current += 1
    setCatalog(catalogFromFields(panel.config.fields))
    setCatalogBusy(false)
  }, [panel, setNotice])

  const clearOverrides = useCallback(async (): Promise<void> => {
    if (!confirmAction(PANEL_COPY.clearConfirm)) return
    await runPanelAction(ops, 'clear', async () => {
      const result = await clearConfig()
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error })
        return
      }
      ops.applyPanel(result.panel)
      setDraft({})
      setNotice({ kind: 'ok', text: PANEL_COPY.cleared })
    })
  }, [ops, setNotice])

  const reset = useCallback((): void => setDraft({}), [])

  const dirtyCount = Object.keys(draft).length
  const restartCount = useMemo(
    () => (panel?.config.fields ?? []).filter(field => field.restartRequired && field.key in draft).length,
    [draft, panel],
  )
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

  return {
    draft,
    fields,
    catalogBusy,
    dirtyCount,
    restartCount,
    dirtyTabs,
    update,
    pickDirectory,
    save,
    discard,
    clearOverrides,
    reset,
  }
}
