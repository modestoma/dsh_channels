/**
 * 设置面板外壳与各 hook 共用的写操作原语：页面级回调集合、单个写操作的
 * busy / 提示 / 异常处理，以及二次确认。
 *
 * @module dsh-channels/client/panel/actions
 */

import type { Dispatch, SetStateAction } from 'react'
import type { AccessWire, PanelTabId, PanelWire } from '../../settings/contract.ts'
import { messageOf } from './shared.tsx'
import type { BusyAction, Notice } from './shared.tsx'

/** Page-shell state setters a write action reports through. */
export interface PanelOps {
  setBusy: Dispatch<SetStateAction<BusyAction | null>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  /** Adopt a panel payload a write returned (panel and status together). */
  applyPanel: (panel: PanelWire) => void
  /** Replace the embedded access snapshot after a user-table mutation. */
  applyAccess: (access: AccessWire) => void
  /** Re-read the status only; failures land in the poll error line. */
  refreshStatus: () => Promise<void>
  setActiveTab: Dispatch<SetStateAction<PanelTabId>>
}

/**
 * Run one panel write: mark it busy, clear the banner, and turn a thrown
 * request into an error banner. `run` handles the response itself; `onThrow`
 * runs after a thrown request (e.g. to re-read the status).
 * @param ops - the page-shell setters.
 * @param busy - the busy marker shown while the write runs.
 * @param run - the request and its response handling.
 * @param onThrow - follow-up after a thrown request.
 */
export async function runPanelAction(
  ops: PanelOps,
  busy: BusyAction,
  run: () => Promise<void>,
  onThrow?: () => Promise<void>,
): Promise<void> {
  ops.setBusy(busy)
  ops.setNotice(null)
  try {
    await run()
  } catch (error) {
    ops.setNotice({ kind: 'error', text: messageOf(error) })
    await onThrow?.()
  } finally {
    ops.setBusy(null)
  }
}

/**
 * Ask the operator to confirm a disruptive action. Environments without
 * `window.confirm` proceed.
 * @param text - the confirmation question.
 * @returns whether to proceed.
 */
export function confirmAction(text: string): boolean {
  return typeof window.confirm === 'function' ? window.confirm(text) : true
}
