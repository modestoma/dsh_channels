/**
 * 连接标签页的写操作：连接 / 重连、接管另一个进程的连接，以及 App ID /
 * App Secret 输入框与凭据的保存、移除。
 *
 * @module dsh-channels/client/panel/use-connection-actions
 */

import { useCallback, useMemo, useState } from 'react'
import { PANEL_COPY } from '../../settings/contract.ts'
import type { CredentialField, FieldIssueWire, ReconnectResponse } from '../../settings/contract.ts'
import { clearCredential, reconnect, saveCredentials, takeover } from '../api.ts'
import { confirmAction, runPanelAction } from './actions.ts'
import type { PanelOps } from './actions.ts'
import type { BusyAction, CredentialsView } from './shared.tsx'

/** Connection writes and the credential editor. */
export interface ConnectionActions {
  /** Open a stopped channel or restart a running one. */
  reconnect: () => Promise<void>
  /** Take the connection over from the other dsh process. */
  takeover: () => Promise<void>
  credentials: CredentialsView
  /** Empty the credential inputs (panel reload). */
  resetCredentialInputs: () => void
}

/**
 * Own the connection tab's writes and credential inputs.
 * @param ops - the page-shell setters.
 * @param view - render inputs of the credential editor.
 * @returns the actions and the credential editor view.
 */
export function useConnectionActions(
  ops: PanelOps,
  view: { running: boolean; issues: FieldIssueWire[]; busy: BusyAction | null; locked: boolean },
): ConnectionActions {
  const [appIdInput, setAppIdInput] = useState('')
  const [appSecretInput, setAppSecretInput] = useState('')
  const { running, issues, busy, locked } = view

  /** Run a reconnect-style write: unconfigured credentials send the user back to the connection tab. */
  const lifecycle = useCallback(async (
    marker: 'reconnect' | 'takeover',
    call: () => Promise<ReconnectResponse>,
    done: string,
  ): Promise<void> => {
    await runPanelAction(ops, marker, async () => {
      const result = await call()
      if (!result.ok) {
        ops.setNotice({ kind: 'error', text: result.error })
        if (result.unconfigured === true) ops.setActiveTab('connection')
        await ops.refreshStatus()
        return
      }
      ops.applyPanel(result.panel)
      ops.setNotice({ kind: 'ok', text: done })
    }, ops.refreshStatus)
  }, [ops])

  /** Only a restart interrupts live replies, so only it confirms. */
  const onReconnect = useCallback(async (): Promise<void> => {
    if (running && !confirmAction(PANEL_COPY.restartWarning)) return
    await lifecycle('reconnect', reconnect, running ? PANEL_COPY.reconnectDone : PANEL_COPY.connectDone)
  }, [lifecycle, running])

  /** Taking over interrupts the other process's replies. */
  const onTakeover = useCallback(async (): Promise<void> => {
    if (!confirmAction(PANEL_COPY.takeoverWarning)) return
    await lifecycle('takeover', takeover, PANEL_COPY.takeoverDone)
  }, [lifecycle])

  /** Save provided credential values; the Host reconnects automatically when ready. */
  const onSaveCredentials = useCallback(async (): Promise<void> => {
    const values: { appId?: string; appSecret?: string } = {}
    if (appIdInput.trim() !== '') values.appId = appIdInput
    if (appSecretInput.trim() !== '') values.appSecret = appSecretInput
    if (values.appId === undefined && values.appSecret === undefined) return
    await runPanelAction(ops, 'credentials', async () => {
      const result = await saveCredentials(values)
      if (!result.ok) {
        ops.setNotice({ kind: 'error', text: result.error, issues: result.issues })
        return
      }
      ops.applyPanel(result.panel)
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
      ops.setNotice({
        kind: result.reconnect === 'failed' || result.autoReconnectError !== undefined ? 'error' : 'ok',
        text: result.autoReconnectError === undefined
          ? base
          : `${base}：${result.autoReconnectError}`,
      })
    })
  }, [appIdInput, appSecretInput, ops])

  const onClearCredential = useCallback(async (field: CredentialField): Promise<void> => {
    if (!confirmAction(PANEL_COPY.credentialRemoveConfirm)) return
    await runPanelAction(ops, 'credentials-clear', async () => {
      const result = await clearCredential(field)
      if (!result.ok) {
        ops.setNotice({ kind: 'error', text: result.error, issues: result.issues })
        return
      }
      ops.applyPanel(result.panel)
      ops.setNotice({
        kind: 'ok',
        text: result.reconnect === 'pending' ? PANEL_COPY.credentialRemovedPending : PANEL_COPY.credentialRemoved,
      })
    })
  }, [ops])

  const credentials = useMemo<CredentialsView>(() => ({
    appId: appIdInput,
    appSecret: appSecretInput,
    issues,
    busy,
    locked,
    onAppIdChange: setAppIdInput,
    onAppSecretChange: setAppSecretInput,
    onSave: () => { void onSaveCredentials() },
    onClear: (field: CredentialField) => { void onClearCredential(field) },
  }), [appIdInput, appSecretInput, busy, issues, locked, onClearCredential, onSaveCredentials])

  const resetCredentialInputs = useCallback((): void => {
    setAppIdInput('')
    setAppSecretInput('')
  }, [])

  return { reconnect: onReconnect, takeover: onTakeover, credentials, resetCredentialInputs }
}
