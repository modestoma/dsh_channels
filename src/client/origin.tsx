/**
 * 对话里的「飞书来源」：会话头部的入口按钮（只在飞书发起的会话里出现）与
 * 右侧栏的来源标签页。两者共用一份按会话缓存的来源查询。
 *
 * @module dsh-channels/client/origin
 */

import { useCallback, useEffect, useState } from 'react'
import type { SessionOriginWire } from '../settings/contract.ts'
import { loadSessionOrigin } from './origin-cache.ts'
import { FeishuChannelsIcon } from './icon.tsx'

/** Right-sidebar tab kind opened by the header button. */
export const ORIGIN_TAB_KIND = 'feishu-origin'
/** Tab-type implementation id and keyed body/title slot key. */
export const ORIGIN_TAB_ID = '@modesto_ma/dsh-channels/origin'
/** Tab chip text. */
export const ORIGIN_TAB_TITLE = '飞书来源'

type OriginState =
  | { phase: 'loading' }
  | { phase: 'ready'; origin: SessionOriginWire | null }
  | { phase: 'error'; message: string }

/** Load one Session's origin; `reload` asks the Host again. */
function useSessionOrigin(sessionId: string): [OriginState, () => void] {
  const [state, setState] = useState<OriginState>({ phase: 'loading' })
  const [ticket, setTicket] = useState(0)
  useEffect(() => {
    let live = true
    setState(current => (current.phase === 'ready' && ticket > 0 ? current : { phase: 'loading' }))
    loadSessionOrigin(sessionId, ticket > 0).then(
      origin => { if (live) setState({ phase: 'ready', origin }) },
      (error: unknown) => {
        if (live) setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { live = false }
  }, [sessionId, ticket])
  const reload = useCallback(() => { setTicket(value => value + 1) }, [])
  return [state, reload]
}

/** Short source label: group name, or 私聊. */
function sourceLabel(origin: SessionOriginWire): string {
  if (origin.chatType === 'p2p') return '飞书私聊'
  return origin.chatName === undefined ? '飞书群聊' : origin.chatName
}

/** Props of the header entry: the session standard kit's `sessionId`. */
export interface OriginHeaderActionProps {
  sessionId: string
  /** Open the origin tab in this Session's right sidebar. */
  openOrigin: () => void
}

/**
 * Header button shown only for Sessions Feishu routed; renders nothing for
 * every other Session and while the lookup is pending or failed.
 * @param props - session id and the tab opener.
 * @returns the button or null.
 */
export function OriginHeaderAction({ sessionId, openOrigin }: OriginHeaderActionProps): JSX.Element | null {
  const [state] = useSessionOrigin(sessionId)
  if (state.phase !== 'ready' || state.origin === null) return null
  const label = sourceLabel(state.origin)
  return (
    <button
      type="button"
      className="dsh-channels-origin-chip"
      title={`来自${label}，点击查看飞书来源`}
      aria-label={`飞书来源：${label}`}
      onClick={openOrigin}
    >
      <FeishuChannelsIcon size={13} active={false} />
      <span className="dsh-channels-origin-chip__text">{label}</span>
    </button>
  )
}

/** Props of the tab body: the session standard kit's `sessionId`. */
export interface OriginTabProps {
  sessionId: string
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Right-sidebar body: where this Session came from in Feishu.
 * @param props - the tab's Session.
 * @returns the origin page.
 */
export function OriginTab({ sessionId }: OriginTabProps): JSX.Element {
  const [state, reload] = useSessionOrigin(sessionId)
  return (
    <div className="dsh-channels-origin">
      {state.phase === 'loading' ? <div className="dsh-channels-origin__muted">正在读取飞书来源…</div> : null}
      {state.phase === 'error'
        ? (
            <div className="dsh-channels-origin__error">
              <span>读取飞书来源失败：{state.message}</span>
              <button type="button" className="dsh-channels-origin__link" onClick={reload}>重试</button>
            </div>
          )
        : null}
      {state.phase === 'ready' && state.origin === null
        ? <div className="dsh-channels-origin__muted">这个会话不是从飞书发起的。</div>
        : null}
      {state.phase === 'ready' && state.origin !== null ? <OriginDetails origin={state.origin} onRefresh={reload} /> : null}
    </div>
  )
}

function OriginDetails({ origin, onRefresh }: { origin: SessionOriginWire; onRefresh: () => void }): JSX.Element {
  const p2p = origin.chatType === 'p2p'
  const rows: Array<[string, JSX.Element | string]> = [
    ['来源', p2p ? '私聊' : (origin.kind === 'thread' ? '群聊 · 话题' : '群聊')],
  ]
  // The heading already names a resolved group; an unnamed one shows its id.
  if (!p2p && origin.chatName === undefined) {
    rows.push(['群 ID', <span className="dsh-channels-origin__mono">{origin.chatId}</span>])
  }
  rows.push([origin.shared ? '请求人' : '发起人', (
    <span>
      {origin.senderName ?? null}
      {origin.senderName === undefined ? null : ' '}
      <span className="dsh-channels-origin__mono dsh-channels-origin__muted">{origin.senderUserId}</span>
    </span>
  )])
  if (origin.shared) rows.push(['说明', '日志平台分析话题，群内成员都可以继续'])
  rows.push(['开始于', formatTime(origin.createdAt)])
  rows.push(origin.bound && origin.lastActivityAt !== undefined
    ? ['最近活跃', formatTime(origin.lastActivityAt)]
    : ['状态', '飞书侧已切换到新会话或已过期'])
  return (
    <>
      <div className="dsh-channels-origin__head">
        <FeishuChannelsIcon size={16} active={false} />
        <span className="dsh-channels-origin__title">{sourceLabel(origin)}</span>
      </div>
      <dl className="dsh-channels-origin__list">
        {rows.map(([label, value]) => (
          <div key={label} className="dsh-channels-origin__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="dsh-channels-origin__actions">
        <a className="dsh-channels-origin__button" href={origin.chatLink} target="_blank" rel="noreferrer">在飞书中打开</a>
        <button type="button" className="dsh-channels-origin__link" onClick={onRefresh}>刷新</button>
      </div>
    </>
  )
}
