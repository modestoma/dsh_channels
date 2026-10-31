/**
 * 「会话记录」tab：飞书发起的全部会话，群聊按「群 → 用户 → 会话」、私聊按
 * 「用户 → 会话」分组，名字与头像来自飞书。会话行可在主区打开对应对话；
 * 用户行的「工作区文件」进入该用户工作区的只读文件浏览。
 *
 * 数据来自 Host 的 `sessionRecords` / `workspaceFiles` 路由；打开会话走 DSH
 * Web 壳的 `uiWorkspace` 服务（见 `../navigation.ts`），壳不提供时按钮禁用。
 *
 * @module dsh-channels/client/panel/records-tab
 */

import { useCallback, useEffect, useState } from 'react'
import { fillCopy, PANEL_COPY } from '../../settings/contract.ts'
import type {
  SessionRecordGroupWire,
  SessionRecordsWire,
  SessionRecordUserWire,
  SessionRecordWire,
  WorkspaceEntryWire,
  WorkspaceListingWire,
  WorkspacePreviewWire,
} from '../../settings/contract.ts'
import { fetchSessionRecords, fetchWorkspaceFileBlob, fetchWorkspaceFilePreview, fetchWorkspaceFiles } from '../api.ts'
import { Avatar } from '../avatar.tsx'
import { useSessionNavigator } from '../navigation.ts'
import { EmptyRow, messageOf, NoticeBar } from './shared.tsx'

/** Tab copy (Chinese UI, sentence case for any English). */
export const RECORDS_COPY = {
  groupsTitle: '群聊',
  directsTitle: '私聊',
  loading: '正在读取会话记录…',
  loadFailed: '读取会话记录失败',
  retry: '重试',
  refresh: '刷新',
  emptyGroups: '还没有从群聊发起的会话',
  emptyDirects: '还没有从私聊发起的会话',
  groupSummary: '{users} 位用户 · {sessions} 个会话 · 最近活跃 {time}',
  userSummary: '{sessions} 个会话 · 最近活跃 {time}',
  untitled: '未命名会话',
  bound: '当前',
  boundHint: '飞书里的这个话题仍然接着这个会话',
  shared: '群共享',
  started: '开始于 {time}',
  lastActive: '最近活跃 {time}',
  open: '打开',
  openUnavailable: '当前 Web 界面不支持从插件打开会话',
  files: '工作区文件',
  noWorkspace: '没有可浏览的工作区',
  expand: '展开',
  collapse: '收起',
  back: '返回会话记录',
  workspaceLabel: '工作区',
  rootCrumb: '工作区根目录',
  filesLoading: '正在读取目录…',
  filesEmpty: '目录为空',
  filesTruncated: '目录内容过多，只显示前 {count} 项',
  previewLoading: '正在读取文件…',
  previewBinary: '这个文件无法在面板中预览，可以下载后查看',
  previewTruncated: '文件较大，只显示开头部分',
  download: '下载',
  downloading: '下载中…',
  symlink: '符号链接',
} as const

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Human-readable byte count.
 * @param bytes - size in bytes.
 * @returns e.g. `812 B`, `3.4 KB`, `12.0 MB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Hand one fetched file to the browser as a saved download. */
async function downloadWorkspaceFile(workspace: string, path: string, name: string): Promise<void> {
  const url = URL.createObjectURL(await fetchWorkspaceFileBlob(workspace, path))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Kept briefly so the download manager can still read the blob after the click.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

function activityOf(record: SessionRecordWire): number {
  return record.lastActivityAt ?? record.createdAt
}

/** Latest activity of one user entry (sessions arrive most recent first). */
function latestOf(user: SessionRecordUserWire): number {
  return user.sessions.length === 0 ? 0 : activityOf(user.sessions[0]!)
}

/** The owner whose workspace the files view shows. */
interface FilesTarget {
  title: string
  subtitle?: string
  avatarUrl?: string
  workspaces: string[]
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; records: SessionRecordsWire }

/**
 * The 「会话记录」 tab body.
 * @returns the grouped Session list, or the files view of one user's workspace.
 */
export function RecordsTab(): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [files, setFiles] = useState<FilesTarget | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

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

  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  if (files !== null) {
    return <WorkspaceFiles target={files} onBack={() => setFiles(null)} />
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
  const { groups, directs, warning } = load.records
  return (
    <div className="dsh-channels-cfg__tabBody">
      <div className="dsh-channels-rec__toolbar">
        {warning === undefined
          ? <span className="dsh-channels-cfg__spacer" />
          : <p className="dsh-channels-cfg__secFoot dsh-channels-cfg__spacer">{fillCopy(PANEL_COPY.profilesWarning, { reason: warning })}</p>}
        <button type="button" className="dsh-channels-cfg__btn" disabled={refreshing} onClick={() => { void reload() }}>
          {RECORDS_COPY.refresh}
        </button>
      </div>
      <section className="dsh-channels-cfg__sec">
        <h3 className="dsh-channels-cfg__secTitle">{RECORDS_COPY.groupsTitle}</h3>
        <div className="dsh-channels-cfg__list">
          {groups.length === 0 ? <EmptyRow text={RECORDS_COPY.emptyGroups} /> : null}
          {groups.map(group => (
            <GroupBlock key={group.chatId} group={group} expanded={expanded} onToggle={toggle} onFiles={setFiles} />
          ))}
        </div>
      </section>
      <section className="dsh-channels-cfg__sec">
        <h3 className="dsh-channels-cfg__secTitle">{RECORDS_COPY.directsTitle}</h3>
        <div className="dsh-channels-cfg__list">
          {directs.length === 0 ? <EmptyRow text={RECORDS_COPY.emptyDirects} /> : null}
          {directs.map(user => (
            <UserBlock
              key={user.userId}
              user={user}
              toggleKey={`p2p:${user.userId}`}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              onFiles={setFiles}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

/** Disclosure chevron; rotates while expanded. */
function Chevron(props: { open: boolean }): JSX.Element {
  return (
    <svg
      className={`dsh-channels-rec__chevron${props.open ? ' dsh-channels-rec__chevron--open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One expandable row: chevron, avatar, label and summary; `control` sits on the right. */
function DisclosureRow(props: {
  open: boolean
  onToggle: () => void
  depth: number
  avatar: JSX.Element
  label: string
  summary: string
  control?: JSX.Element
}): JSX.Element {
  const { open, onToggle, depth, avatar, label, summary, control } = props
  return (
    <div className={`dsh-channels-cfg__row dsh-channels-rec__row dsh-channels-rec__depth${depth}`}>
      <button
        type="button"
        className="dsh-channels-rec__toggle"
        aria-expanded={open}
        aria-label={`${open ? RECORDS_COPY.collapse : RECORDS_COPY.expand} ${label}`}
        onClick={onToggle}
      >
        <Chevron open={open} />
        {avatar}
        <span className="dsh-channels-cfg__rowText">
          <span className="dsh-channels-cfg__rowLabel">{label}</span>
          <span className="dsh-channels-cfg__rowSummary">{summary}</span>
        </span>
      </button>
      {control === undefined ? null : <div className="dsh-channels-cfg__rowCtl">{control}</div>}
    </div>
  )
}

function GroupBlock(props: {
  group: SessionRecordGroupWire
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  onFiles: (target: FilesTarget) => void
}): JSX.Element {
  const { group, expanded, onToggle, onFiles } = props
  const key = `group:${group.chatId}`
  const open = expanded.has(key)
  const title = group.chatName ?? group.chatId
  const sessions = group.users.reduce((sum, user) => sum + user.sessions.length, 0)
  const latest = Math.max(...group.users.map(latestOf))
  return (
    <>
      <DisclosureRow
        open={open}
        onToggle={() => onToggle(key)}
        depth={0}
        avatar={<Avatar text={title} url={group.chatAvatarUrl} />}
        label={title}
        summary={fillCopy(RECORDS_COPY.groupSummary, { users: String(group.users.length), sessions: String(sessions), time: formatTime(latest) })}
      />
      {open
        ? group.users.map(user => (
            <UserBlock
              key={user.userId}
              user={user}
              groupName={title}
              toggleKey={`${key}:${user.userId}`}
              depth={1}
              expanded={expanded}
              onToggle={onToggle}
              onFiles={onFiles}
            />
          ))
        : null}
    </>
  )
}

function UserBlock(props: {
  user: SessionRecordUserWire
  /** Group display name when the user sits under a group. */
  groupName?: string
  toggleKey: string
  depth: 0 | 1
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  onFiles: (target: FilesTarget) => void
}): JSX.Element {
  const { user, groupName, toggleKey, depth, expanded, onToggle, onFiles } = props
  const open = expanded.has(toggleKey)
  const title = user.name ?? user.userId
  const hasWorkspace = user.workspaces.length > 0
  return (
    <>
      <DisclosureRow
        open={open}
        onToggle={() => onToggle(toggleKey)}
        depth={depth}
        avatar={<Avatar text={title} url={user.avatarUrl} size={depth === 0 ? 26 : 22} />}
        label={title}
        summary={fillCopy(RECORDS_COPY.userSummary, { sessions: String(user.sessions.length), time: formatTime(latestOf(user)) })}
        control={(
          <button
            type="button"
            className="dsh-channels-cfg__btn"
            disabled={!hasWorkspace}
            title={hasWorkspace ? undefined : RECORDS_COPY.noWorkspace}
            onClick={() => onFiles({
              title,
              ...(groupName === undefined ? {} : { subtitle: groupName }),
              ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }),
              workspaces: user.workspaces,
            })}
          >
            {RECORDS_COPY.files}
          </button>
        )}
      />
      {open ? user.sessions.map(record => <SessionRow key={record.sessionId} record={record} depth={depth + 1} />) : null}
    </>
  )
}

function SessionRow(props: { record: SessionRecordWire; depth: number }): JSX.Element {
  const { record, depth } = props
  const navigator = useSessionNavigator()
  const times = [fillCopy(RECORDS_COPY.started, { time: formatTime(record.createdAt) })]
  if (record.lastActivityAt !== undefined) times.push(fillCopy(RECORDS_COPY.lastActive, { time: formatTime(record.lastActivityAt) }))
  return (
    <div className={`dsh-channels-cfg__row dsh-channels-rec__row dsh-channels-rec__session dsh-channels-rec__depth${depth}`}>
      <div className="dsh-channels-cfg__rowText">
        <div className="dsh-channels-cfg__rowLabel">
          <span>{record.title ?? RECORDS_COPY.untitled}</span>
          {record.bound ? <span className="dsh-channels-cfg__tag dsh-channels-rec__tag--ok" title={RECORDS_COPY.boundHint}>{RECORDS_COPY.bound}</span> : null}
          {record.shared ? <span className="dsh-channels-cfg__tag">{RECORDS_COPY.shared}</span> : null}
        </div>
        <div className="dsh-channels-cfg__rowSummary">
          {times.join(' · ')}
          {' · '}
          <span className="dsh-channels-cfg__mono">{record.sessionId}</span>
        </div>
      </div>
      <div className="dsh-channels-cfg__rowCtl">
        <button
          type="button"
          className="dsh-channels-cfg__btn"
          disabled={navigator === undefined}
          title={navigator === undefined ? RECORDS_COPY.openUnavailable : undefined}
          onClick={() => navigator?.openSession(record.sessionId)}
        >
          {RECORDS_COPY.open}
        </button>
      </div>
    </div>
  )
}

type ListingState =
  | { phase: 'loading'; path: string }
  | { phase: 'error'; path: string; message: string }
  | { phase: 'ready'; listing: WorkspaceListingWire }

type PreviewState =
  | { phase: 'loading'; path: string }
  | { phase: 'error'; path: string; message: string }
  | { phase: 'ready'; preview: WorkspacePreviewWire }

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/**
 * Read-only browser over one user's workspace: breadcrumb, directory list and
 * a preview of the selected file.
 */
function WorkspaceFiles(props: { target: FilesTarget; onBack: () => void }): JSX.Element {
  const { target, onBack } = props
  const [workspace, setWorkspace] = useState(target.workspaces[0]!)
  const [listing, setListing] = useState<ListingState>({ phase: 'loading', path: '' })
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const openDir = useCallback(async (dir: string): Promise<void> => {
    setListing({ phase: 'loading', path: dir })
    setPreview(null)
    try {
      setListing({ phase: 'ready', listing: await fetchWorkspaceFiles(workspace, dir) })
    } catch (error) {
      setListing({ phase: 'error', path: dir, message: messageOf(error) })
    }
  }, [workspace])

  useEffect(() => { void openDir('') }, [openDir])

  const openFile = async (file: string): Promise<void> => {
    setPreview({ phase: 'loading', path: file })
    setDownloadError(null)
    try {
      setPreview({ phase: 'ready', preview: await fetchWorkspaceFilePreview(workspace, file) })
    } catch (error) {
      setPreview({ phase: 'error', path: file, message: messageOf(error) })
    }
  }

  const download = async (file: string): Promise<void> => {
    setDownloading(true)
    setDownloadError(null)
    try {
      await downloadWorkspaceFile(workspace, file, file.split('/').pop() ?? file)
    } catch (error) {
      setDownloadError(messageOf(error))
    } finally {
      setDownloading(false)
    }
  }

  const currentDir = listing.phase === 'ready' ? listing.listing.path : listing.path
  const segments = currentDir === '' ? [] : currentDir.split('/')
  const selected = preview === null ? undefined : (preview.phase === 'ready' ? preview.preview.path : preview.path)

  const onEntry = (entry: WorkspaceEntryWire): void => {
    const entryPath = joinPath(currentDir, entry.name)
    if (entry.kind === 'dir') void openDir(entryPath)
    else void openFile(entryPath)
  }

  return (
    <div className="dsh-channels-cfg__tabBody">
      <div className="dsh-channels-rec__toolbar">
        <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--ghost" onClick={onBack}>
          {`‹ ${RECORDS_COPY.back}`}
        </button>
      </div>
      <div className="dsh-channels-rec__owner">
        <Avatar text={target.title} url={target.avatarUrl} size={32} />
        <div className="dsh-channels-cfg__rowText">
          <strong>{target.subtitle === undefined ? target.title : `${target.subtitle} · ${target.title}`}</strong>
          {target.workspaces.length > 1
            ? (
                <select
                  className="dsh-channels-cfg__input dsh-channels-cfg__select dsh-channels-rec__workspaceSelect"
                  aria-label={RECORDS_COPY.workspaceLabel}
                  value={workspace}
                  onChange={event => setWorkspace(event.target.value)}
                >
                  {target.workspaces.map(dir => <option key={dir} value={dir}>{dir}</option>)}
                </select>
              )
            : <span className="dsh-channels-cfg__rowSummary dsh-channels-cfg__mono">{workspace}</span>}
        </div>
      </div>
      <nav className="dsh-channels-rec__crumbs" aria-label={RECORDS_COPY.workspaceLabel}>
        <button type="button" className="dsh-channels-cfg__link" onClick={() => { void openDir('') }}>{RECORDS_COPY.rootCrumb}</button>
        {segments.map((segment, index) => {
          const dir = segments.slice(0, index + 1).join('/')
          const last = index === segments.length - 1
          return (
            <span key={dir} className="dsh-channels-rec__crumb">
              <span aria-hidden="true">/</span>
              {last
                ? <span aria-current="page">{segment}</span>
                : <button type="button" className="dsh-channels-cfg__link" onClick={() => { void openDir(dir) }}>{segment}</button>}
            </span>
          )
        })}
      </nav>
      <div className="dsh-channels-cfg__list dsh-channels-rec__files">
        {listing.phase === 'loading' ? <EmptyRow text={RECORDS_COPY.filesLoading} /> : null}
        {listing.phase === 'error' ? <div className="dsh-channels-cfg__rowError dsh-channels-rec__filesError">{listing.message}</div> : null}
        {listing.phase === 'ready' && listing.listing.entries.length === 0 ? <EmptyRow text={RECORDS_COPY.filesEmpty} /> : null}
        {listing.phase === 'ready'
          ? listing.listing.entries.map((entry) => {
              const entryPath = joinPath(currentDir, entry.name)
              return (
                <button
                  key={entry.name}
                  type="button"
                  className={`dsh-channels-rec__entry${selected === entryPath ? ' dsh-channels-rec__entry--selected' : ''}`}
                  onClick={() => onEntry(entry)}
                >
                  <EntryIcon kind={entry.kind} />
                  <span className="dsh-channels-rec__entryName">{entry.name}</span>
                  <span className="dsh-channels-rec__entryMeta">
                    {entry.kind === 'symlink' ? RECORDS_COPY.symlink : null}
                    {entry.size === undefined ? null : formatBytes(entry.size)}
                    {entry.mtimeMs === undefined ? null : ` · ${formatTime(entry.mtimeMs)}`}
                  </span>
                </button>
              )
            })
          : null}
      </div>
      {listing.phase === 'ready' && listing.listing.truncated
        ? <p className="dsh-channels-cfg__secFoot">{fillCopy(RECORDS_COPY.filesTruncated, { count: String(listing.listing.entries.length) })}</p>
        : null}
      {preview === null
        ? null
        : (
            <FilePreview
              state={preview}
              downloading={downloading}
              downloadError={downloadError}
              onDownload={path => { void download(path) }}
            />
          )}
    </div>
  )
}

function EntryIcon(props: { kind: WorkspaceEntryWire['kind'] }): JSX.Element {
  if (props.kind === 'dir') {
    return (
      <svg className="dsh-channels-rec__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="currentColor" opacity=".22" stroke="currentColor" strokeWidth="1" />
      </svg>
    )
  }
  return (
    <svg className="dsh-channels-rec__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function FilePreview(props: {
  state: PreviewState
  downloading: boolean
  downloadError: string | null
  onDownload: (path: string) => void
}): JSX.Element {
  const { state, downloading, downloadError, onDownload } = props
  const path = state.phase === 'ready' ? state.preview.path : state.path
  const name = path.split('/').pop() ?? path
  return (
    <section className="dsh-channels-rec__preview" aria-label={name}>
      <div className="dsh-channels-rec__previewHead">
        <div className="dsh-channels-cfg__rowText">
          <strong className="dsh-channels-rec__previewName">{name}</strong>
          {state.phase === 'ready'
            ? <span className="dsh-channels-cfg__rowSummary">{`${formatBytes(state.preview.size)} · ${formatTime(state.preview.mtimeMs)}`}</span>
            : null}
        </div>
        <button type="button" className="dsh-channels-cfg__btn" disabled={downloading || state.phase !== 'ready'} onClick={() => onDownload(path)}>
          {downloading ? RECORDS_COPY.downloading : RECORDS_COPY.download}
        </button>
      </div>
      {downloadError === null ? null : <NoticeBar kind="error" text={downloadError} />}
      {state.phase === 'loading' ? <div className="dsh-channels-cfg__loading">{RECORDS_COPY.previewLoading}</div> : null}
      {state.phase === 'error' ? <NoticeBar kind="error" text={state.message} /> : null}
      {state.phase === 'ready' ? <PreviewBody preview={state.preview} /> : null}
    </section>
  )
}

function PreviewBody(props: { preview: WorkspacePreviewWire }): JSX.Element {
  const { preview } = props
  switch (preview.kind) {
    case 'text':
      return (
        <>
          {preview.truncated ? <p className="dsh-channels-cfg__secFoot">{RECORDS_COPY.previewTruncated}</p> : null}
          <pre className="dsh-channels-rec__text">{preview.content}</pre>
        </>
      )
    case 'image':
      return <img className="dsh-channels-rec__image" src={`data:${preview.mime};base64,${preview.dataBase64}`} alt={preview.path} />
    case 'binary':
      return <p className="dsh-channels-cfg__secFoot">{RECORDS_COPY.previewBinary}</p>
  }
}
