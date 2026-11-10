/**
 * 设置面板顶部：标题 / 连接阶段 / 版本与运行时长 / 刷新按钮，以及标签页导航
 * （每个标签页的未保存标记与待处理计数）。
 *
 * @module dsh-channels/client/panel/header
 */

import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { PANEL_COPY, PANEL_TABS } from '../../settings/contract.ts'
import type { ChannelStatusWire, PanelTabId } from '../../settings/contract.ts'
import { FeishuChannelsIcon } from '../icon.tsx'
import { RefreshIcon } from './records-icons.tsx'
import { formatUptime, phaseBadge, Pill } from './shared.tsx'
import type { BusyAction } from './shared.tsx'

/**
 * Page header: title, phase pill, version and uptime, refresh; visible on every tab.
 * @param props - the status, poll error and refresh control.
 * @returns the header.
 */
export function PanelHeader(props: {
  status: ChannelStatusWire
  pollError: string | null
  busy: BusyAction | null
  locked: boolean
  onRefresh: () => void
}): JSX.Element {
  const { status, pollError, busy, locked, onRefresh } = props
  const badge = phaseBadge(status.phase)
  return (
    <header className="dsh-channels-cfg__panelHead">
      <div className="dsh-channels-cfg__headRow">
        <span className="dsh-channels-cfg__logo"><FeishuChannelsIcon size={18} active={false} /></span>
        <h1 className="dsh-channels-cfg__title">{PANEL_COPY.title}</h1>
        <Pill tone={badge.tone} dot>{badge.text}</Pill>
        <span className="dsh-channels-cfg__meta dsh-channels-cfg__mono">v{status.version}</span>
        {status.uptimeMs === undefined
          ? null
          : <span className="dsh-channels-cfg__meta">· {PANEL_COPY.uptimePrefix} {formatUptime(status.uptimeMs)}</span>}
        <span className="dsh-channels-cfg__spacer" />
        <button
          type="button"
          className="dsh-channels-cfg__btn dsh-channels-cfg__btn--ghost"
          onClick={onRefresh}
          disabled={busy !== null || locked}
        >
          <RefreshIcon />
          {PANEL_COPY.refresh}
        </button>
      </div>
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

/**
 * Top-level tab navigation; the dirty dot keeps unsaved work visible per tab.
 * @param props - the active tab, dirty tabs and per-tab counts.
 * @returns the tab list.
 */
export function TabNav(props: {
  activeTab: PanelTabId
  dirtyTabs: ReadonlySet<PanelTabId>
  /** Items waiting for the operator per tab (pending access requests). */
  counts: Partial<Record<PanelTabId, number>>
  onChange: (tab: PanelTabId) => void
}): JSX.Element {
  const { activeTab, dirtyTabs, counts, onChange } = props
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
            {(counts[tab.id] ?? 0) > 0 ? <span className="dsh-channels-cfg__tabCount">{counts[tab.id]}</span> : null}
            {dirty
              ? (
                  <span
                    className="dsh-channels-cfg__tabDot"
                    aria-hidden="true"
                  />
                )
              : null}
          </button>
        )
      })}
    </nav>
  )
}
