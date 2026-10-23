/**
 * 白名单列表：群白名单、用户白名单与知识库白名单共用的条目行、添加表单
 * （点「＋ 添加」才展开）与待处理申请行。
 *
 * @module dsh-channels/client/panel/whitelist
 */

import { useState } from 'react'
import { fillCopy, PANEL_COPY } from '../../settings/contract.ts'
import type { AccessGroupWire, AccessRequestWire } from '../../settings/contract.ts'
import { EmptyRow, Row, Section } from './shared.tsx'

/** Local `MM-DD HH:mm` rendering for authorization timestamps. */
export function formatAccessDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return PANEL_COPY.unknownValue
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Which authorization entry produced one grant. */
function sourceLabel(source: AccessGroupWire['source']): string {
  switch (source) {
    case 'command': return PANEL_COPY.accessSourceCommand
    case 'card': return PANEL_COPY.accessSourceCard
    default: return PANEL_COPY.accessSourcePanel
  }
}

/** Round initial badge in front of a whitelist entry. */
function Avatar(props: { text: string }): JSX.Element {
  return <span className="dsh-channels-cfg__avatar" aria-hidden="true">{Array.from(props.text)[0] ?? '?'}</span>
}

/** One whitelist entry: a group `chat_id` or a user `user_id`. */
export interface WhitelistEntry {
  id: string
  name?: string
  source: AccessGroupWire['source']
}

/**
 * One titled whitelist with remove buttons and a collapsed add form.
 * `onAdd` resolves true when the entry was added (the form then closes).
 */
export function Whitelist(props: {
  title: string
  /** Shown after the title once loaded; defaults to the entry count. */
  countLabel?: string
  entries: readonly WhitelistEntry[]
  avatar?: string
  empty: string
  loaded: boolean
  addLabel: string
  idPlaceholder: string
  namePlaceholder: string
  footnote?: string
  disabled: boolean
  working: boolean
  onAdd: (id: string, name: string) => Promise<boolean>
  onRemove: (id: string) => void
}): JSX.Element {
  const { title, countLabel, entries, avatar, empty, loaded, addLabel, idPlaceholder, namePlaceholder, footnote, disabled, working, onAdd, onRemove } = props
  const [adding, setAdding] = useState(false)
  const [id, setId] = useState('')
  const [name, setName] = useState('')

  const submit = async (): Promise<void> => {
    if (id.trim() === '') return
    if (await onAdd(id, name)) {
      setId('')
      setName('')
      setAdding(false)
    }
  }

  return (
    <Section title={loaded ? `${title} · ${countLabel ?? entries.length}` : title} footnote={footnote}>
      {!loaded ? <EmptyRow text={PANEL_COPY.accessNotLoaded} /> : null}
      {loaded && entries.length === 0 ? <EmptyRow text={empty} /> : null}
      {entries.map(entry => (
        <Row
          key={entry.id}
          leading={<Avatar text={avatar ?? entry.name ?? entry.id} />}
          label={entry.name ?? entry.id}
          summary={<><span className="dsh-channels-cfg__mono">{entry.id}</span> · {sourceLabel(entry.source)}</>}
          control={(
            <button
              type="button"
              className="dsh-channels-cfg__btn dsh-channels-cfg__btn--remove"
              disabled={disabled}
              onClick={() => onRemove(entry.id)}
            >
              {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
            </button>
          )}
        />
      ))}
      {!loaded
        ? null
        : adding
          ? (
              <div className="dsh-channels-cfg__addRow">
                <input
                  type="text"
                  className="dsh-channels-cfg__input"
                  value={id}
                  placeholder={idPlaceholder}
                  aria-label={idPlaceholder}
                  disabled={disabled}
                  onChange={event => setId(event.target.value)}
                />
                <input
                  type="text"
                  className="dsh-channels-cfg__input"
                  value={name}
                  placeholder={namePlaceholder}
                  aria-label={namePlaceholder}
                  disabled={disabled}
                  onChange={event => setName(event.target.value)}
                />
                <button
                  type="button"
                  className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                  disabled={disabled || id.trim() === ''}
                  onClick={() => { void submit() }}
                >
                  {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAdd}
                </button>
                <button type="button" className="dsh-channels-cfg__btn dsh-channels-cfg__btn--ghost" onClick={() => setAdding(false)}>
                  {PANEL_COPY.cancel}
                </button>
              </div>
            )
          : (
              <div className="dsh-channels-cfg__addRow">
                <button type="button" className="dsh-channels-cfg__link" disabled={disabled} onClick={() => setAdding(true)}>
                  ＋ {addLabel}
                </button>
              </div>
            )}
    </Section>
  )
}

/** Pending authorization requests, settled with the same resolver as the DM card. */
export function RequestList(props: {
  requests: readonly AccessRequestWire[]
  disabled: boolean
  working: boolean
  onResolve: (token: string, decision: 'allow' | 'deny') => void
}): JSX.Element {
  const { requests, disabled, working, onResolve } = props
  return (
    <Section title={`${PANEL_COPY.accessRequestsTitle} · ${requests.length}`} tone="warn">
      {requests.map((request) => {
        const target = request.name ?? request.targetId
        const where = request.kind === 'user' && (request.groupName ?? request.chatId) !== undefined
          ? fillCopy(PANEL_COPY.accessRequestIn, { group: request.groupName ?? request.chatId ?? '' })
          : ''
        return (
          <Row
            key={request.token}
            leading={<Avatar text={target} />}
            label={`${target} ${where}${request.kind === 'group' ? PANEL_COPY.accessRequestGroup : PANEL_COPY.accessRequestUser}`}
            summary={(
              <>
                <span className="dsh-channels-cfg__mono">{request.targetId}</span>
                {` · ${formatAccessDate(request.createdAt)} · ${fillCopy(PANEL_COPY.accessRequestExpires, { date: formatAccessDate(request.expiresAt) })}`}
              </>
            )}
            control={(
              <div className="dsh-channels-cfg__inputRow">
                <button
                  type="button"
                  className="dsh-channels-cfg__btn dsh-channels-cfg__btn--ghost"
                  disabled={disabled}
                  onClick={() => onResolve(request.token, 'deny')}
                >
                  {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessDeny}
                </button>
                <button
                  type="button"
                  className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                  disabled={disabled}
                  onClick={() => onResolve(request.token, 'allow')}
                >
                  {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAllow}
                </button>
              </div>
            )}
          />
        )
      })}
    </Section>
  )
}
