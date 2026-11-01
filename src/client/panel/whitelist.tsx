/**
 * 用户表：每个用户一行（头像、名字、user_id、个人模型偏好、四个权限开关、移除），添加
 * 表单点「＋ 添加用户」才展开；以及待处理申请行。
 *
 * @module dsh-channels/client/panel/whitelist
 */

import { useState } from 'react'
import { fillCopy, PANEL_COPY } from '../../settings/contract.ts'
import type { AccessPermissionWire, AccessRequestWire, AccessUserWire } from '../../settings/contract.ts'
import { Avatar } from '../avatar.tsx'
import type { ProfileView } from './profiles.ts'
import { EmptyRow, Row, Section } from './shared.tsx'

/** Local `MM-DD HH:mm` rendering for authorization timestamps. */
export function formatAccessDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return PANEL_COPY.unknownValue
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Which authorization entry produced one grant. */
function sourceLabel(source: AccessUserWire['source']): string {
  switch (source) {
    case 'command': return PANEL_COPY.accessSourceCommand
    case 'card': return PANEL_COPY.accessSourceCard
    default: return PANEL_COPY.accessSourcePanel
  }
}

/** The four switches in display order with their chip labels. */
const PERMISSION_CHIPS: ReadonlyArray<{ permission: AccessPermissionWire; label: string }> = [
  { permission: 'chat', label: PANEL_COPY.accessPermChat },
  { permission: 'wikiRead', label: PANEL_COPY.accessPermWikiRead },
  { permission: 'wikiWrite', label: PANEL_COPY.accessPermWikiWrite },
  { permission: 'codeWrite', label: PANEL_COPY.accessPermCodeWrite },
]

/** One user row as the table renders it. */
export interface UserTableEntry {
  user: AccessUserWire
  /** Live Feishu name, else the name captured at authorization time. */
  name?: string
  /** Live Feishu avatar. */
  avatarUrl?: string
}

/**
 * The flat user table: one dense row per user with four toggle chips (a
 * suspended user's other chips are dimmed), remove buttons, and a collapsed
 * add form. `onAdd` resolves true when the user was added (the form then
 * closes).
 */
export function UserTable(props: {
  entries: readonly UserTableEntry[]
  loaded: boolean
  disabled: boolean
  working: boolean
  onAdd: (id: string, name: string) => Promise<boolean>
  onRemove: (id: string) => void
  onToggle: (id: string, permission: AccessPermissionWire, enabled: boolean) => void
}): JSX.Element {
  const { entries, loaded, disabled, working, onAdd, onRemove, onToggle } = props
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
    <Section title={loaded ? `${PANEL_COPY.accessUsersTitle} · ${entries.length}` : PANEL_COPY.accessUsersTitle} footnote={PANEL_COPY.accessUsersHint}>
      {!loaded ? <EmptyRow text={PANEL_COPY.accessNotLoaded} /> : null}
      {loaded && entries.length === 0 ? <EmptyRow text={PANEL_COPY.accessUsersEmpty} /> : null}
      {entries.map(({ user, name: display, avatarUrl }) => (
        <Row
          key={user.userId}
          leading={<Avatar text={display ?? user.userId} url={avatarUrl} />}
          label={display ?? user.userId}
          summary={(
            <>
              <span className="dsh-channels-cfg__mono">{user.userId}</span> · {sourceLabel(user.source)}
              {user.llm === undefined ? null : ` · ${PANEL_COPY.accessUserModel}：${user.llm}`}
            </>
          )}
          control={(
            <div className="dsh-channels-cfg__inputRow">
              {PERMISSION_CHIPS.map(({ permission, label }) => (
                <button
                  key={permission}
                  type="button"
                  className={`dsh-channels-cfg__perm${permission !== 'chat' && !user.chat ? ' dsh-channels-cfg__perm--muted' : ''}`}
                  aria-pressed={user[permission]}
                  disabled={disabled}
                  onClick={() => onToggle(user.userId, permission, !user[permission])}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="dsh-channels-cfg__btn dsh-channels-cfg__btn--remove"
                disabled={disabled}
                onClick={() => onRemove(user.userId)}
              >
                {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
              </button>
            </div>
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
                  placeholder={PANEL_COPY.accessUserIdPlaceholder}
                  aria-label={PANEL_COPY.accessUserIdPlaceholder}
                  disabled={disabled}
                  onChange={event => setId(event.target.value)}
                />
                <input
                  type="text"
                  className="dsh-channels-cfg__input"
                  value={name}
                  placeholder={PANEL_COPY.accessUserNamePlaceholder}
                  aria-label={PANEL_COPY.accessUserNamePlaceholder}
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
                  ＋ {PANEL_COPY.accessAddUser}
                </button>
              </div>
            )}
    </Section>
  )
}

/** Pending authorization requests, settled with the same resolver as the DM card. */
export function RequestList(props: {
  requests: readonly AccessRequestWire[]
  profiles: ProfileView
  disabled: boolean
  working: boolean
  onResolve: (token: string, decision: 'allow' | 'deny') => void
}): JSX.Element {
  const { requests, profiles, disabled, working, onResolve } = props
  return (
    <Section title={`${PANEL_COPY.accessRequestsTitle} · ${requests.length}`} tone="warn">
      {requests.map((request) => {
        const profile = profiles.user(request.targetId)
        const target = profile?.name ?? request.name ?? request.targetId
        const group = request.chatId === undefined
          ? request.groupName
          : profiles.chat(request.chatId)?.name ?? request.groupName ?? request.chatId
        const where = group === undefined ? '' : fillCopy(PANEL_COPY.accessRequestIn, { group })
        return (
          <Row
            key={request.token}
            leading={<Avatar text={target} url={profile?.avatarUrl} />}
            label={`${target} ${where}${PANEL_COPY.accessRequestUser}`}
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
