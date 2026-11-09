/**
 * 左侧栏「飞书渠道」主区页面：页面外壳把数据、草稿和写操作 hook 拼起来，渲染
 * 顶部状态头 / tab 导航 / 提示条 / 当前标签页 / 底部保存条。
 *
 * Host 交互分在四个 hook 里：`use-panel-data`（加载、轮询、刷新）、
 * `use-config-draft`（全局草稿与保存）、`use-connection-actions`（连接与凭据）、
 * `use-access-actions`（用户表与群权限）；tab 组件只接收渲染所需的数据与
 * 回调。页面不 import 任何 DSH 客户端包，只依赖 react 与 `main` 槽位。
 *
 * @module dsh-channels/client/panel
 */

import { useCallback, useMemo, useState } from 'react'
import { PANEL_COPY } from '../../settings/contract.ts'
import type { FieldIssueWire, PanelTabId } from '../../settings/contract.ts'
import type { PanelOps } from './actions.ts'
import { AccessTab } from './access-tab.tsx'
import { AdvancedTab } from './advanced-tab.tsx'
import { ConnectionTab } from './connection-tab.tsx'
import { FieldsTab } from './fields-tab.tsx'
import { GroupsTab } from './groups-tab.tsx'
import { PanelHeader, TabNav } from './header.tsx'
import { useFeishuProfiles } from './profiles.ts'
import { NoticeBar, SaveBar } from './shared.tsx'
import type { BusyAction, FormView, Notice } from './shared.tsx'
import { RecordsTab } from './records-tab.tsx'
import { useAccessActions } from './use-access-actions.ts'
import { useConfigDraft } from './use-config-draft.ts'
import { useConnectionActions } from './use-connection-actions.ts'
import { usePanelData } from './use-panel-data.ts'
import { WikiTab } from './wiki-tab.tsx'

/**
 * Main-column page for the `main` slot: a full-height scroll region with the
 * centered panel column. The slot passes no owner props.
 * @returns the page.
 */
export function FeishuChannelsPage(): JSX.Element {
  return (
    <section className="dsh-channels-page" aria-label={PANEL_COPY.title}>
      <div className="dsh-channels-page__content">
        <FeishuChannelsPanel />
      </div>
    </section>
  )
}

/** Panel shell: one panel payload, one status poll, one global config draft. */
function FeishuChannelsPanel(): JSX.Element | null {
  const data = usePanelData()
  const { load, panel, hostBusy } = data
  const [activeTab, setActiveTab] = useState<PanelTabId>('connection')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const ops = useMemo<PanelOps>(() => ({
    setBusy,
    setNotice,
    applyPanel: data.applyPanel,
    applyAccess: data.applyAccess,
    refreshStatus: data.refreshStatus,
    setActiveTab,
  }), [data.applyAccess, data.applyPanel, data.refreshStatus])

  const issues = useMemo<FieldIssueWire[]>(
    () => (notice?.kind === 'error' ? notice.issues ?? [] : []),
    [notice],
  )
  const config = useConfigDraft(panel, ops)
  const connection = useConnectionActions(ops, { running: data.running, issues, busy, locked: hostBusy })
  const access = useAccessActions(ops)
  const profiles = useFeishuProfiles(panel?.access ?? null)

  /** Full reload: drop the banner, the access result line, the draft and the credential inputs. */
  const reload = useCallback((): void => {
    setNotice(null)
    access.reset()
    config.reset()
    connection.resetCredentialInputs()
    void data.reload()
  }, [access, config, connection, data])

  /** Manual refresh keeps the dirty draft; a successful one clears the access result line. */
  const refresh = useCallback(async (): Promise<void> => {
    if (await data.refresh()) access.reset()
  }, [access, data])

  const form = useMemo<FormView | null>(() => {
    if (panel === null) return null
    return {
      panel,
      fields: config.fields,
      draft: config.draft,
      issues,
      busy,
      locked: hostBusy,
      onChange: config.update,
      onPickDirectory: config.pickDirectory,
    }
  }, [busy, config.draft, config.fields, config.pickDirectory, config.update, hostBusy, issues, panel])

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
            <button type="button" className="dsh-channels-cfg__btn" onClick={reload}>
              {PANEL_COPY.retry}
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (form === null) return null
  const current = data.status ?? load.panel.status

  return (
    <div className="dsh-channels-cfg">
      <PanelHeader
        status={current}
        pollError={data.pollError}
        busy={busy}
        locked={hostBusy}
        onRefresh={() => { void refresh() }}
      />
      <TabNav
        activeTab={activeTab}
        dirtyTabs={config.dirtyTabs}
        counts={{ access: load.panel.access.loaded ? load.panel.access.requests.length : 0 }}
        onChange={setActiveTab}
      />
      {load.panel.access.mode === 'open' ? <div className="dsh-channels-cfg__banner">{PANEL_COPY.debugModeWarning}</div> : null}
      {notice === null ? null : <NoticeBar kind={notice.kind} text={notice.text} />}
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
                credentials={connection.credentials}
                onReconnect={() => { void connection.reconnect() }}
                onTakeover={() => { void connection.takeover() }}
              />
            )
          : null}
        {activeTab === 'sessions' ? <FieldsTab form={form} tab="sessions" /> : null}
        {activeTab === 'records' ? <RecordsTab /> : null}
        {activeTab === 'model'
          ? <FieldsTab form={form} tab="model" note={config.catalogBusy ? PANEL_COPY.catalogLoading : undefined} />
          : null}
        {activeTab === 'attachments' ? <FieldsTab form={form} tab="attachments" /> : null}
        {activeTab === 'access'
          ? (
              <AccessTab
                form={form}
                profiles={profiles}
                accessNotice={access.notice}
                accessError={access.error}
                onAddUser={access.addUser}
                onRemoveUser={userId => { void access.removeUser(userId) }}
                onTogglePermission={(userId, permission, enabled) => { void access.togglePermission(userId, permission, enabled) }}
                onSetGitEmail={access.setGitEmail}
                onResolveRequest={(token, decision) => { void access.resolveRequest(token, decision) }}
              />
            )
          : null}
        {activeTab === 'groups'
          ? (
              <GroupsTab
                form={form}
                profiles={profiles}
                accessNotice={access.notice}
                accessError={access.error}
                onRemoveGroup={chatId => { void access.removeGroup(chatId) }}
                onTogglePermission={(chatId, permission, enabled) => { void access.toggleGroupPermission(chatId, permission, enabled) }}
              />
            )
          : null}
        {activeTab === 'wiki' ? <WikiTab form={form} profiles={profiles} /> : null}
        {activeTab === 'advanced'
          ? <AdvancedTab form={form} onClear={() => { void config.clearOverrides() }} />
          : null}
      </div>
      <SaveBar
        dirtyCount={config.dirtyCount}
        restartCount={config.restartCount}
        busy={busy}
        locked={hostBusy}
        onSave={() => { void config.save() }}
        onDiscard={config.discard}
      />
    </div>
  )
}
