/**
 * 设置面板的数据：首次加载、5 秒状态轮询（连接阶段变化时重读面板）、手动刷新，
 * 以及写操作返回后的面板 / 访问快照替换。
 *
 * @module dsh-channels/client/panel/use-panel-data
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccessWire, ChannelStatusWire, PanelWire } from '../../settings/contract.ts'
import { fetchPanel, fetchStatus } from '../api.ts'
import { messageOf } from './shared.tsx'
import type { LoadState } from './shared.tsx'

/** Panel payload, live status and their refresh operations. */
export interface PanelData {
  load: LoadState
  /** The ready panel, or null while loading or failed. */
  panel: PanelWire | null
  /** Latest polled status, or null before the first poll. */
  status: ChannelStatusWire | null
  pollError: string | null
  /** Host-side lifecycle busy: connecting/restarting blocks every panel write. */
  hostBusy: boolean
  /** Whether the channel is connected. */
  running: boolean
  /** Full reload through the loading state (initial load and retry). */
  reload: () => Promise<void>
  /** Re-read the panel without the loading state; resolves whether it succeeded. */
  refresh: () => Promise<boolean>
  refreshStatus: () => Promise<void>
  applyPanel: (panel: PanelWire) => void
  applyAccess: (access: AccessWire) => void
}

/**
 * Load the panel once on mount and poll its status every 5 seconds while it
 * is ready.
 * @returns the panel data.
 */
export function usePanelData(): PanelData {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [status, setStatus] = useState<ChannelStatusWire | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  /** Latest ready panel, read from the poll loop without restarting it. */
  const panelRef = useRef<PanelWire | null>(null)
  const panel = load.phase === 'ready' ? load.panel : null
  useEffect(() => {
    panelRef.current = panel
  }, [panel])

  const applyPanel = useCallback((next: PanelWire): void => {
    setLoad({ phase: 'ready', panel: next })
    setStatus(next.status)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoad({ phase: 'loading' })
    try {
      applyPanel(await fetchPanel())
    } catch (error) {
      setLoad({ phase: 'error', message: messageOf(error) })
    }
  }, [applyPanel])

  useEffect(() => {
    void reload()
  }, [reload])

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
            if (!cancelled) applyPanel(refreshed)
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
  }, [applyPanel, load.phase])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchStatus())
      setPollError(null)
    } catch (error) {
      setPollError(messageOf(error))
    }
  }, [])

  /**
   * Manual refresh: reload the whole panel payload so access lists and
   * `restartPendingKeys` catch up with the Host. The dirty draft lives
   * outside this hook, so refreshing never discards user input.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      applyPanel(await fetchPanel())
      setPollError(null)
      return true
    } catch (error) {
      setPollError(messageOf(error))
      return false
    }
  }, [applyPanel])

  const applyAccess = useCallback((access: AccessWire): void => {
    setLoad(previous => previous.phase === 'ready'
      ? { phase: 'ready', panel: { ...previous.panel, access } }
      : previous)
  }, [])

  const current = status ?? panel?.status
  return {
    load,
    panel,
    status,
    pollError,
    hostBusy: current?.busy === true,
    running: current?.running === true,
    reload,
    refresh,
    refreshStatus,
    applyPanel,
    applyAccess,
  }
}
