/**
 * Read-only browser over one user's Feishu workspace for the 「会话记录」
 * tab: a directory pane with breadcrumbs and a preview pane (text with line
 * numbers, inline images, or download only). Wide containers lay the panes
 * side by side; narrow ones stack them.
 *
 * Responses that arrive after a later navigation are dropped, so a slow
 * answer for another directory or workspace never replaces the current view.
 *
 * @module dsh-channels/client/panel/workspace-browser
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fillCopy } from '../../settings/contract.ts'
import type { WorkspaceEntryWire, WorkspaceListingWire, WorkspacePreviewWire } from '../../settings/contract.ts'
import { fetchWorkspaceFileBlob, fetchWorkspaceFilePreview, fetchWorkspaceFiles } from '../api.ts'
import { Avatar } from '../avatar.tsx'
import { fileKindOf, formatBytes, formatRelativeTime, formatTime } from './records-format.ts'
import { BackIcon, DownloadIcon, FileKindIcon } from './records-icons.tsx'
import { messageOf } from './shared.tsx'

/** Browser copy. */
export const BROWSER_COPY = {
  back: '返回会话记录',
  workspaceLabel: '工作区',
  rootCrumb: '工作区',
  parentDir: '上一级',
  filesLoading: '正在读取目录…',
  filesEmpty: '这个目录是空的',
  filesTruncated: '目录内容过多，只显示前 {count} 项',
  previewEmpty: '选择左侧的文件查看内容',
  previewLoading: '正在读取文件…',
  previewBinary: '这个文件无法在面板中预览',
  previewTruncated: '文件较大（共 {size}），只显示开头部分',
  download: '下载',
  downloading: '下载中…',
  symlink: '符号链接',
  lines: '{count} 行',
} as const

/** The owner whose workspace the browser shows. */
export interface BrowserTarget {
  title: string
  /** Group name when the owner is a group member. */
  subtitle?: string
  avatarUrl?: string
  /** Workspace roots, most recently active first; never empty. */
  workspaces: string[]
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

function baseName(file: string): string {
  return file.split('/').pop() ?? file
}

/** Hand one fetched file to the browser as a saved download. */
async function saveWorkspaceFile(workspace: string, path: string): Promise<void> {
  const url = URL.createObjectURL(await fetchWorkspaceFileBlob(workspace, path))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = baseName(path)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Kept briefly so the download manager can still read the blob after the click.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/**
 * The workspace browser.
 * @param props - whose workspace to show and how to leave.
 * @returns the browser.
 */
export function WorkspaceBrowser(props: { target: BrowserTarget; onBack: () => void }): JSX.Element {
  const { target, onBack } = props
  const [workspace, setWorkspace] = useState(target.workspaces[0]!)
  const [listing, setListing] = useState<ListingState>({ phase: 'loading', path: '' })
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  /** Latest navigation (workspace or directory change); older listing answers are dropped. */
  const listingRequest = useRef(0)
  /** Latest preview request; navigation also bumps it so a pending preview never reappears. */
  const previewRequest = useRef(0)

  const openDir = useCallback(async (dir: string): Promise<void> => {
    const request = ++listingRequest.current
    previewRequest.current += 1
    setListing({ phase: 'loading', path: dir })
    setPreview(null)
    setDownloadError(null)
    try {
      const result = await fetchWorkspaceFiles(workspace, dir)
      if (request === listingRequest.current) setListing({ phase: 'ready', listing: result })
    } catch (error) {
      if (request === listingRequest.current) setListing({ phase: 'error', path: dir, message: messageOf(error) })
    }
  }, [workspace])

  useEffect(() => { void openDir('') }, [openDir])

  const openFile = async (file: string): Promise<void> => {
    const request = ++previewRequest.current
    setPreview({ phase: 'loading', path: file })
    setDownloadError(null)
    try {
      const result = await fetchWorkspaceFilePreview(workspace, file)
      if (request === previewRequest.current) setPreview({ phase: 'ready', preview: result })
    } catch (error) {
      if (request === previewRequest.current) setPreview({ phase: 'error', path: file, message: messageOf(error) })
    }
  }

  const download = async (file: string): Promise<void> => {
    setDownloading(true)
    setDownloadError(null)
    try {
      await saveWorkspaceFile(workspace, file)
    } catch (error) {
      setDownloadError(messageOf(error))
    } finally {
      setDownloading(false)
    }
  }

  const currentDir = listing.phase === 'ready' ? listing.listing.path : listing.path
  const segments = currentDir === '' ? [] : currentDir.split('/')
  const selected = preview === null ? undefined : (preview.phase === 'ready' ? preview.preview.path : preview.path)

  return (
    <div className="dsh-channels-cfg__tabBody dsh-channels-rec">
      <div className="dsh-channels-fb__header">
        <button type="button" className="dsh-channels-rec__iconBtn" aria-label={BROWSER_COPY.back} title={BROWSER_COPY.back} onClick={onBack}>
          <BackIcon />
        </button>
        <Avatar text={target.title} url={target.avatarUrl} size={34} />
        <div className="dsh-channels-fb__owner">
          <span className="dsh-channels-fb__ownerName">
            {target.subtitle === undefined ? null : <span className="dsh-channels-fb__ownerGroup">{`${target.subtitle} / `}</span>}
            {target.title}
          </span>
          {target.workspaces.length > 1
            ? (
                <select
                  className="dsh-channels-fb__workspaceSelect"
                  aria-label={BROWSER_COPY.workspaceLabel}
                  value={workspace}
                  onChange={event => setWorkspace(event.target.value)}
                >
                  {target.workspaces.map(dir => <option key={dir} value={dir}>{dir}</option>)}
                </select>
              )
            : <span className="dsh-channels-fb__path" title={workspace}>{workspace}</span>}
        </div>
      </div>
      <div className="dsh-channels-fb">
        <div className="dsh-channels-fb__pane dsh-channels-fb__pane--list">
          <nav className="dsh-channels-fb__crumbs" aria-label={BROWSER_COPY.workspaceLabel}>
            {segments.length === 0
              ? <span className="dsh-channels-fb__crumbCurrent" aria-current="page">{BROWSER_COPY.rootCrumb}</span>
              : <button type="button" className="dsh-channels-fb__crumb" onClick={() => { void openDir('') }}>{BROWSER_COPY.rootCrumb}</button>}
            {segments.map((segment, index) => {
              const dir = segments.slice(0, index + 1).join('/')
              const last = index === segments.length - 1
              return (
                <span key={dir} className="dsh-channels-fb__crumbItem">
                  <span className="dsh-channels-fb__crumbSep" aria-hidden="true">/</span>
                  {last
                    ? <span className="dsh-channels-fb__crumbCurrent" aria-current="page">{segment}</span>
                    : <button type="button" className="dsh-channels-fb__crumb" onClick={() => { void openDir(dir) }}>{segment}</button>}
                </span>
              )
            })}
          </nav>
          <div className="dsh-channels-fb__entries">
            {segments.length > 0
              ? (
                  <button
                    type="button"
                    className="dsh-channels-fb__entry dsh-channels-fb__entry--parent"
                    onClick={() => { void openDir(segments.slice(0, -1).join('/')) }}
                  >
                    <span className="dsh-channels-fb__parentGlyph" aria-hidden="true">..</span>
                    <span className="dsh-channels-fb__entryName">{BROWSER_COPY.parentDir}</span>
                  </button>
                )
              : null}
            {listing.phase === 'loading' ? <div className="dsh-channels-fb__placeholder">{BROWSER_COPY.filesLoading}</div> : null}
            {listing.phase === 'error' ? <div className="dsh-channels-fb__placeholder dsh-channels-fb__placeholder--error">{listing.message}</div> : null}
            {listing.phase === 'ready' && listing.listing.entries.length === 0
              ? <div className="dsh-channels-fb__placeholder">{BROWSER_COPY.filesEmpty}</div>
              : null}
            {listing.phase === 'ready'
              ? listing.listing.entries.map(entry => (
                  <EntryRow
                    key={entry.name}
                    entry={entry}
                    selected={selected === joinPath(currentDir, entry.name)}
                    onOpen={() => {
                      const entryPath = joinPath(currentDir, entry.name)
                      if (entry.kind === 'dir') void openDir(entryPath)
                      else void openFile(entryPath)
                    }}
                  />
                ))
              : null}
            {listing.phase === 'ready' && listing.listing.truncated
              ? <div className="dsh-channels-fb__placeholder">{fillCopy(BROWSER_COPY.filesTruncated, { count: String(listing.listing.entries.length) })}</div>
              : null}
          </div>
        </div>
        <div className="dsh-channels-fb__pane dsh-channels-fb__pane--preview">
          {preview === null
            ? <div className="dsh-channels-fb__blank">{BROWSER_COPY.previewEmpty}</div>
            : (
                <FilePreview
                  state={preview}
                  downloading={downloading}
                  downloadError={downloadError}
                  onDownload={path => { void download(path) }}
                />
              )}
        </div>
      </div>
    </div>
  )
}

function EntryRow(props: { entry: WorkspaceEntryWire; selected: boolean; onOpen: () => void }): JSX.Element {
  const { entry, selected, onOpen } = props
  const kind = fileKindOf(entry.name, entry.kind === 'dir')
  const meta = entry.kind === 'symlink'
    ? BROWSER_COPY.symlink
    : (entry.size === undefined ? '' : formatBytes(entry.size))
  return (
    <button
      type="button"
      className={`dsh-channels-fb__entry${selected ? ' dsh-channels-fb__entry--selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      title={entry.mtimeMs === undefined ? entry.name : `${entry.name}\n${formatTime(entry.mtimeMs)}`}
      onClick={onOpen}
    >
      <FileKindIcon kind={kind} />
      <span className="dsh-channels-fb__entryName">{entry.name}</span>
      {meta === '' ? null : <span className="dsh-channels-fb__entryMeta">{meta}</span>}
    </button>
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
  const name = baseName(path)
  const facts: string[] = []
  if (state.phase === 'ready') {
    facts.push(formatBytes(state.preview.size), formatRelativeTime(state.preview.mtimeMs))
    if (state.preview.kind === 'text') facts.push(fillCopy(BROWSER_COPY.lines, { count: String(lineCount(state.preview.content)) }))
  }
  return (
    <section className="dsh-channels-fb__preview" aria-label={name}>
      <header className="dsh-channels-fb__previewHead">
        <FileKindIcon kind={fileKindOf(name, false)} />
        <div className="dsh-channels-fb__previewTitle">
          <span className="dsh-channels-fb__previewName" title={path}>{name}</span>
          {facts.length === 0
            ? null
            : <span className="dsh-channels-fb__previewFacts" title={state.phase === 'ready' ? formatTime(state.preview.mtimeMs) : undefined}>{facts.join(' · ')}</span>}
        </div>
        <button
          type="button"
          className="dsh-channels-rec__iconBtn dsh-channels-rec__iconBtn--labelled"
          disabled={downloading || state.phase !== 'ready'}
          onClick={() => onDownload(path)}
        >
          <DownloadIcon />
          {downloading ? BROWSER_COPY.downloading : BROWSER_COPY.download}
        </button>
      </header>
      {downloadError === null ? null : <div className="dsh-channels-fb__alert" role="alert">{downloadError}</div>}
      {state.phase === 'loading' ? <div className="dsh-channels-fb__blank">{BROWSER_COPY.previewLoading}</div> : null}
      {state.phase === 'error' ? <div className="dsh-channels-fb__alert" role="alert">{state.message}</div> : null}
      {state.phase === 'ready'
        ? <PreviewBody preview={state.preview} onDownload={() => onDownload(path)} downloading={downloading} />
        : null}
    </section>
  )
}

/** Number of lines, ignoring a single trailing newline. */
function lineCount(content: string): number {
  if (content === '') return 0
  const lines = content.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

function PreviewBody(props: { preview: WorkspacePreviewWire; onDownload: () => void; downloading: boolean }): JSX.Element {
  const { preview, onDownload, downloading } = props
  switch (preview.kind) {
    case 'text': {
      const lines = preview.content.split('\n')
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      return (
        <div className="dsh-channels-fb__textWrap">
          {preview.truncated
            ? <div className="dsh-channels-fb__note">{fillCopy(BROWSER_COPY.previewTruncated, { size: formatBytes(preview.size) })}</div>
            : null}
          <pre className="dsh-channels-fb__text">
            <code>
              {lines.map((line, index) => (
                // Lines have no identity beyond their position in this immutable preview.
                <span key={index} className="dsh-channels-fb__line">{line === '' ? '​' : line}</span>
              ))}
            </code>
          </pre>
        </div>
      )
    }
    case 'image':
      return (
        <div className="dsh-channels-fb__imageWrap">
          <img className="dsh-channels-fb__image" src={`data:${preview.mime};base64,${preview.dataBase64}`} alt={preview.path} />
        </div>
      )
    case 'binary':
      return (
        <div className="dsh-channels-fb__blank dsh-channels-fb__blank--binary">
          <FileKindIcon kind={fileKindOf(preview.path, false)} />
          <span>{BROWSER_COPY.previewBinary}</span>
          <button type="button" className="dsh-channels-cfg__btn" disabled={downloading} onClick={onDownload}>
            {downloading ? BROWSER_COPY.downloading : BROWSER_COPY.download}
          </button>
        </div>
      )
  }
}
