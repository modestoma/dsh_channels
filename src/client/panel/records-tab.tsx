/**
 * 「会话记录」tab：飞书发起的全部会话，群聊按「群 → 用户 → 会话」、私聊按
 * 「用户 → 会话」分组，名字与头像来自飞书。会话行点击即在主区打开对应对话；
 * 用户行的「文件」进入该用户工作区的只读文件浏览（`./workspace-browser.tsx`）。
 *
 * 数据来自 Host 的 `sessionRecords` 路由；打开会话走 DSH Web 壳的
 * `uiWorkspace` 服务（见 `../navigation.ts`），壳不提供时会话行不可点击。
 *
 * @module dsh-channels/client/panel/records-tab
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fillCopy, PANEL_COPY } from '../../settings/contract.ts'
import type {
  SessionRecordGroupWire,
  SessionRecordsWire,
  SessionRecordUserWire,
  SessionRecordWire,
} from '../../settings/contract.ts'
import { fetchSessionRecords } from '../api.ts'
import { Avatar } from '../avatar.tsx'
import { useSessionNavigator } from '../navigation.ts'
import type { SessionNavigator } from '../navigation.ts'
import { filterRecords, formatRelativeTime, formatTime, latestOf, recordTotals } from './records-format.ts'
import { ChevronIcon, FolderIcon, OpenIcon, RefreshIcon, SearchIcon } from './records-icons.tsx'
import { messageOf } from './shared.tsx'
import { WorkspaceBrowser } from './workspace-browser.tsx'
import type { BrowserTarget } from './workspace-browser.tsx'

/** Tab copy. */
export const RECORDS_COPY = {
  groupsTitle: '群聊',
  directsTitle: '私聊',
  loading: '正在读取会话记录…',
  loadFailed: '读取会话记录失败',
  retry: '重试',
  refresh: '刷新',
  searchPlaceholder: '搜索群、用户或会话标题',
  totals: '{groups} 个群 · {users} 位用户 · {sessions} 个会话',
  emptyAll: '还没有从飞书发起的会话。在飞书里私聊机器人，或在群里 @ 它，会话就会出现在这里。',
  emptyGroups: '还没有从群聊发起的会话',
  emptyDirects: '还没有从私聊发起的会话',
  noMatch: '没有匹配「{query}」的群、用户或会话',
  groupMeta: '{users} 位用户 · {sessions} 个会话',
  userMeta: '{sessions} 个会话',
  untitled: '未命名会话',
  bound: '当前话题',
  boundHint: '飞书里的这个话题仍然接着这个会话',
  unboundHint: '飞书侧已切换到新会话或已过期',
  shared: '群共享',
  sessionTooltip: '开始于 {started} · 最近活跃 {active}\n{sessionId}',
  openHint: '在主区打开这个会话',
  openUnavailable: '当前 Web 界面不支持从插件打开会话',
  files: '文件',
  filesHint: '浏览这个用户的工作区文件',
  noWorkspace: '没有可浏览的工作区',
  expand: '展开',
  collapse: '收起',
} as const

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; records: SessionRecordsWire }

/** Rows share these: the expanded keys (all open while searching), the toggle and the files entry. */
interface TreeProps {
  isOpen: (key: string) => boolean
  onToggle: (key: string) => void
  onFiles: (target: BrowserTarget) => void
}

/**
 * The 「会话记录」 tab body.
 * @returns the grouped Session list, or the file browser of one user's workspace.
 */
export function RecordsTab(): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [browsing, setBrowsing] = useState<BrowserTarget | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      setLoad({ phase: 'ready', records: await fetchSessionRecords() })
    } catch (error) {
      setLoad({ phase: 'error', message: messageOf(error) })
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const onToggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const records = load.phase === 'ready' ? load.records : undefined
  const visible = useMemo(() => (records === undefined ? undefined : filterRecords(records, query)), [records, query])

  if (browsing !== null) {
    return <WorkspaceBrowser target={browsing} onBack={() => setBrowsing(null)} />
  }
  if (load.phase === 'loading') {
    return <div className="dsh-channels-cfg__tabBody"><div className="dsh-channels-cfg__loading">{RECORDS_COPY.loading}</div></div>
  }
  if (load.phase === 'error') {
    return (
      <div className="dsh-channels-cfg__tabBody">
        <div className="dsh-channels-cfg__error">
          <strong>{RECORDS_COPY.loadFailed}</strong>
          <span>{load.message}</span>
          <div>
            <button type="button" className="dsh-channels-cfg__btn" disabled={refreshing} onClick={() => { void reload() }}>
              {RECORDS_COPY.retry}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const totals = recordTotals(load.records)
  const searching = query.trim() !== ''
  const tree: TreeProps = {
    isOpen: key => searching || expanded.has(key),
    onToggle,
    onFiles: setBrowsing,
  }
  const { groups, directs } = visible!
  const nothingAtAll = totals.sessions === 0
  const nothingMatched = searching && groups.length === 0 && directs.length === 0

  return (
    <div className="dsh-channels-cfg__tabBody dsh-channels-rec">
      <div className="dsh-channels-rec__toolbar">
        <label className="dsh-channels-rec__search">
          <SearchIcon />
          <input
            type="search"
            className="dsh-channels-rec__searchInput"
            placeholder={RECORDS_COPY.searchPlaceholder}
            aria-label={RECORDS_COPY.searchPlaceholder}
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <span className="dsh-channels-rec__totals">
          {fillCopy(RECORDS_COPY.totals, { groups: String(totals.groups), users: String(totals.users), sessions: String(totals.sessions) })}
        </span>
        <button
          type="button"
          className="dsh-channels-rec__iconBtn"
          aria-label={RECORDS_COPY.refresh}
          title={RECORDS_COPY.refresh}
          disabled={refreshing}
          onClick={() => { void reload() }}
        >
          <RefreshIcon className={refreshing ? 'dsh-channels-rec__spin' : undefined} />
        </button>
      </div>
      {load.records.warning === undefined
        ? null
        : <p className="dsh-channels-cfg__secFoot">{fillCopy(PANEL_COPY.profilesWarning, { reason: load.records.warning })}</p>}
      {nothingAtAll ? <div className="dsh-channels-rec__empty">{RECORDS_COPY.emptyAll}</div> : null}
      {nothingMatched ? <div className="dsh-channels-rec__empty">{fillCopy(RECORDS_COPY.noMatch, { query: query.trim() })}</div> : null}
      {nothingAtAll || nothingMatched
        ? null
        : (
            <>
              {searching && groups.length === 0
                ? null
                : (
                    <section className="dsh-channels-cfg__sec">
                      <h3 className="dsh-channels-cfg__secTitle dsh-channels-rec__secTitle">
                        {RECORDS_COPY.groupsTitle}
                        <span className="dsh-channels-rec__secCount">{groups.length}</span>
                      </h3>
                      {groups.length === 0 ? <div className="dsh-channels-rec__card dsh-channels-rec__muted">{RECORDS_COPY.emptyGroups}</div> : null}
                      {groups.map(group => <GroupCard key={group.chatId} group={group} tree={tree} />)}
                    </section>
                  )}
              {searching && directs.length === 0
                ? null
                : (
                    <section className="dsh-channels-cfg__sec">
                      <h3 className="dsh-channels-cfg__secTitle dsh-channels-rec__secTitle">
                        {RECORDS_COPY.directsTitle}
                        <span className="dsh-channels-rec__secCount">{directs.length}</span>
                      </h3>
                      <div className="dsh-channels-rec__card">
                        {directs.length === 0 ? <div className="dsh-channels-rec__muted">{RECORDS_COPY.emptyDirects}</div> : null}
                        {directs.map(user => <UserBlock key={user.userId} user={user} toggleKey={`p2p:${user.userId}`} tree={tree} />)}
                      </div>
                    </section>
                  )}
            </>
          )}
    </div>
  )
}

function GroupCard(props: { group: SessionRecordGroupWire; tree: TreeProps }): JSX.Element {
  const { group, tree } = props
  const key = `group:${group.chatId}`
  const open = tree.isOpen(key)
  const title = group.chatName ?? group.chatId
  const sessions = group.users.reduce((sum, user) => sum + user.sessions.length, 0)
  const latest = Math.max(...group.users.map(latestOf))
  return (
    <div className={`dsh-channels-rec__card${open ? ' dsh-channels-rec__card--open' : ''}`}>
      <button
        type="button"
        className="dsh-channels-rec__head dsh-channels-rec__head--group"
        aria-expanded={open}
        aria-label={`${open ? RECORDS_COPY.collapse : RECORDS_COPY.expand} ${title}`}
        onClick={() => tree.onToggle(key)}
      >
        <ChevronIcon className="dsh-channels-rec__chevron" />
        <Avatar text={title} url={group.chatAvatarUrl} size={32} />
        <span className="dsh-channels-rec__headText">
          <span className="dsh-channels-rec__name">{title}</span>
          <span className="dsh-channels-rec__meta">
            {fillCopy(RECORDS_COPY.groupMeta, { users: String(group.users.length), sessions: String(sessions) })}
          </span>
        </span>
        <span className="dsh-channels-rec__time" title={formatTime(latest)}>{formatRelativeTime(latest)}</span>
      </button>
      {open
        ? (
            <div className="dsh-channels-rec__members">
              {group.users.map(user => (
                <UserBlock key={user.userId} user={user} groupName={title} toggleKey={`${key}:${user.userId}`} tree={tree} />
              ))}
            </div>
          )
        : null}
    </div>
  )
}

function UserBlock(props: {
  user: SessionRecordUserWire
  /** Group display name when the user sits under a group. */
  groupName?: string
  toggleKey: string
  tree: TreeProps
}): JSX.Element {
  const { user, groupName, toggleKey, tree } = props
  const navigator = useSessionNavigator()
  const open = tree.isOpen(toggleKey)
  const title = user.name ?? user.userId
  const hasWorkspace = user.workspaces.length > 0
  const latest = latestOf(user)
  return (
    <div className="dsh-channels-rec__user">
      <div className="dsh-channels-rec__userRow">
        <button
          type="button"
          className="dsh-channels-rec__head"
          aria-expanded={open}
          aria-label={`${open ? RECORDS_COPY.collapse : RECORDS_COPY.expand} ${title}`}
          onClick={() => tree.onToggle(toggleKey)}
        >
          <ChevronIcon className="dsh-channels-rec__chevron" />
          <Avatar text={title} url={user.avatarUrl} size={26} />
          <span className="dsh-channels-rec__headText">
            <span className="dsh-channels-rec__name">{title}</span>
            <span className="dsh-channels-rec__meta">{fillCopy(RECORDS_COPY.userMeta, { sessions: String(user.sessions.length) })}</span>
          </span>
          <span className="dsh-channels-rec__time" title={formatTime(latest)}>{formatRelativeTime(latest)}</span>
        </button>
        <button
          type="button"
          className="dsh-channels-rec__filesBtn"
          disabled={!hasWorkspace}
          title={hasWorkspace ? RECORDS_COPY.filesHint : RECORDS_COPY.noWorkspace}
          onClick={() => tree.onFiles({
            title,
            ...(groupName === undefined ? {} : { subtitle: groupName }),
            ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }),
            workspaces: user.workspaces,
          })}
        >
          <FolderIcon />
          {RECORDS_COPY.files}
        </button>
      </div>
      {open
        ? (
            <ul className="dsh-channels-rec__sessions">
              {user.sessions.map(record => <SessionRow key={record.sessionId} record={record} navigator={navigator} />)}
            </ul>
          )
        : null}
    </div>
  )
}

function SessionRow(props: { record: SessionRecordWire; navigator: SessionNavigator | undefined }): JSX.Element {
  const { record, navigator } = props
  const active = record.lastActivityAt ?? record.createdAt
  const tooltip = fillCopy(RECORDS_COPY.sessionTooltip, {
    started: formatTime(record.createdAt),
    active: formatTime(active),
    sessionId: record.sessionId,
  })
  return (
    <li>
      <button
        type="button"
        className="dsh-channels-rec__session"
        disabled={navigator === undefined}
        title={navigator === undefined ? RECORDS_COPY.openUnavailable : tooltip}
        aria-label={`${RECORDS_COPY.openHint}：${record.title ?? RECORDS_COPY.untitled}`}
        onClick={() => navigator?.openSession(record.sessionId)}
      >
        <span
          className={`dsh-channels-rec__status${record.bound ? ' dsh-channels-rec__status--bound' : ''}`}
          title={record.bound ? RECORDS_COPY.boundHint : RECORDS_COPY.unboundHint}
        />
        <span className={`dsh-channels-rec__sessionTitle${record.title === undefined ? ' dsh-channels-rec__sessionTitle--untitled' : ''}`}>
          {record.title ?? RECORDS_COPY.untitled}
        </span>
        {record.bound ? <span className="dsh-channels-rec__chip dsh-channels-rec__chip--ok">{RECORDS_COPY.bound}</span> : null}
        {record.shared ? <span className="dsh-channels-rec__chip">{RECORDS_COPY.shared}</span> : null}
        <span className="dsh-channels-rec__time">{formatRelativeTime(active)}</span>
        <span className="dsh-channels-rec__open"><OpenIcon /></span>
      </button>
    </li>
  )
}
