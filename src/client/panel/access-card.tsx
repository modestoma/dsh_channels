/**
 * 访问与授权卡：fail-closed 警告、群/用户白名单增删、待处理申请处理。
 *
 * `access.loaded === false`（飞书未连接、插件 storage 域未打开）时白名单与
 * 申请列表是「未知」而不是「空」，因此只渲染连接提示并禁用全部写操作。
 * 管理员与准入模式由同 tab 上方「准入与授权」字段表单编辑，这里不再重复。
 *
 * @module dsh-channels/client/panel/access-card
 */

import { useState } from 'react'
import { PANEL_COPY } from '../../settings/contract.ts'
import type {
  AccessGroupWire,
  AccessRequestWire,
  AccessUserWire,
  PanelWire,
} from '../../settings/contract.ts'
import { accessModeLabel, EmptyState } from './shared.tsx'
import type { BusyAction } from './shared.tsx'

/** Local `YYYY-MM-DD HH:mm` rendering for authorization timestamps. */
function formatAccessDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return PANEL_COPY.unknownValue
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Which authorization entry produced one grant. */
function accessSourceLabel(source: AccessGroupWire['source']): string {
  switch (source) {
    case 'command': return PANEL_COPY.accessSourceCommand
    case 'card': return PANEL_COPY.accessSourceCard
    default: return PANEL_COPY.accessSourcePanel
  }
}

export interface AccessCardProps {
  panel: PanelWire
  busy: BusyAction | null
  locked: boolean
  notice: string | null
  error: string | null
  onAddGroup: (chatId: string, name: string) => Promise<boolean>
  onRemoveGroup: (chatId: string) => void
  onAddUser: (openId: string, name: string) => Promise<boolean>
  onRemoveUser: (openId: string) => void
  onResolveRequest: (token: string, decision: 'allow' | 'deny') => void
}

export function AccessCard(props: AccessCardProps): JSX.Element {
  const { panel, busy, locked, notice, error, onAddGroup, onRemoveGroup, onAddUser, onRemoveUser, onResolveRequest } = props
  const { access } = panel
  const [groupChatId, setGroupChatId] = useState('')
  const [groupName, setGroupName] = useState('')
  const [userOpenId, setUserOpenId] = useState('')
  const [userName, setUserName] = useState('')
  const groups: readonly AccessGroupWire[] = access.groups
  const users: readonly AccessUserWire[] = access.users
  const requests: readonly AccessRequestWire[] = access.requests
  const working = busy === 'access'
  const disabled = busy !== null || locked || !access.loaded

  const submitGroup = async (): Promise<void> => {
    if (groupChatId.trim() === '') return
    if (await onAddGroup(groupChatId, groupName)) {
      setGroupChatId('')
      setGroupName('')
    }
  }

  const submitUser = async (): Promise<void> => {
    if (userOpenId.trim() === '') return
    if (await onAddUser(userOpenId, userName)) {
      setUserOpenId('')
      setUserName('')
    }
  }

  return (
    <section className="dsh-channels-cfg__card">
      <div className="dsh-channels-cfg__cardHead">
        <span className="dsh-channels-cfg__cardTitle">{PANEL_COPY.accessCard}</span>
        <span className="dsh-channels-cfg__cardMeta">{accessModeLabel(panel, access.mode)}</span>
      </div>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.accessCardHelp}</span>

      {access.mode === 'open'
        ? <div className="dsh-channels-cfg__banner">{PANEL_COPY.accessModeOpenWarning}</div>
        : null}
      {access.loaded && access.mode === 'guarded' && !access.admin.configured
        ? (
            <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--error">
              <strong>{PANEL_COPY.accessAdminMissingWarning}</strong>
            </div>
          )
        : null}

      {!access.loaded
        ? <EmptyState text={PANEL_COPY.accessNotLoaded} />
        : (
            <>
              <div className="dsh-channels-cfg__accessSection">
                <div className="dsh-channels-cfg__labelRow">
                  <span className="dsh-channels-cfg__label">{PANEL_COPY.accessGroupsTitle}</span>
                  <span className="dsh-channels-cfg__cardMeta">{groups.length} 个</span>
                </div>
                {groups.length === 0
                  ? <span className="dsh-channels-cfg__help">{PANEL_COPY.accessGroupsEmpty}</span>
                  : (
                      <ul className="dsh-channels-cfg__accessList">
                        {groups.map(group => (
                          <li className="dsh-channels-cfg__accessRow" key={group.chatId}>
                            <span className="dsh-channels-cfg__accessMain">
                              <span>{group.name ?? group.chatId}</span>
                              <span className="dsh-channels-cfg__accessMeta">
                                <span className="dsh-channels-cfg__mono">{group.chatId}</span>
                                {` · ${accessSourceLabel(group.source)} · ${formatAccessDate(group.addedAt)}`}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="dsh-channels-cfg__btn"
                              disabled={disabled}
                              onClick={() => onRemoveGroup(group.chatId)}
                            >
                              {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                <div className="dsh-channels-cfg__accessAdd">
                  <input
                    type="text"
                    className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
                    value={groupChatId}
                    placeholder={PANEL_COPY.accessGroupChatIdPlaceholder}
                    aria-label={PANEL_COPY.accessGroupChatIdPlaceholder}
                    disabled={disabled}
                    onChange={event => setGroupChatId(event.target.value)}
                  />
                  <input
                    type="text"
                    className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
                    value={groupName}
                    placeholder={PANEL_COPY.accessGroupNamePlaceholder}
                    aria-label={PANEL_COPY.accessGroupNamePlaceholder}
                    disabled={disabled}
                    onChange={event => setGroupName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                    disabled={disabled || groupChatId.trim() === ''}
                    onClick={() => { void submitGroup() }}
                  >
                    {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAddGroup}
                  </button>
                </div>
              </div>

              <div className="dsh-channels-cfg__accessSection">
                <div className="dsh-channels-cfg__labelRow">
                  <span className="dsh-channels-cfg__label">{PANEL_COPY.accessUsersTitle}</span>
                  <span className="dsh-channels-cfg__cardMeta">{users.length} 个</span>
                </div>
                {users.length === 0
                  ? <span className="dsh-channels-cfg__help">{PANEL_COPY.accessUsersEmpty}</span>
                  : (
                      <ul className="dsh-channels-cfg__accessList">
                        {users.map(user => (
                          <li className="dsh-channels-cfg__accessRow" key={user.openId}>
                            <span className="dsh-channels-cfg__accessMain">
                              <span>{user.name ?? user.openId}</span>
                              <span className="dsh-channels-cfg__accessMeta">
                                <span className="dsh-channels-cfg__mono">{user.openId}</span>
                                {` · ${accessSourceLabel(user.source)} · ${formatAccessDate(user.addedAt)}`}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="dsh-channels-cfg__btn"
                              disabled={disabled}
                              onClick={() => onRemoveUser(user.openId)}
                            >
                              {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                <div className="dsh-channels-cfg__accessAdd">
                  <input
                    type="text"
                    className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
                    value={userOpenId}
                    placeholder={PANEL_COPY.accessUserOpenIdPlaceholder}
                    aria-label={PANEL_COPY.accessUserOpenIdPlaceholder}
                    disabled={disabled}
                    onChange={event => setUserOpenId(event.target.value)}
                  />
                  <input
                    type="text"
                    className="dsh-channels-cfg__input dsh-channels-cfg__accessInput"
                    value={userName}
                    placeholder={PANEL_COPY.accessUserNamePlaceholder}
                    aria-label={PANEL_COPY.accessUserNamePlaceholder}
                    disabled={disabled}
                    onChange={event => setUserName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                    disabled={disabled || userOpenId.trim() === ''}
                    onClick={() => { void submitUser() }}
                  >
                    {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAddUser}
                  </button>
                </div>
              </div>

              <div className="dsh-channels-cfg__accessSection">
                <div className="dsh-channels-cfg__labelRow">
                  <span className="dsh-channels-cfg__label">{PANEL_COPY.accessRequestsTitle}</span>
                  <span className="dsh-channels-cfg__cardMeta">{requests.length} 条</span>
                </div>
                {requests.length === 0
                  ? <span className="dsh-channels-cfg__help">{PANEL_COPY.accessRequestsEmpty}</span>
                  : (
                      <ul className="dsh-channels-cfg__accessList">
                        {requests.map(request => (
                          <li className="dsh-channels-cfg__accessRow" key={request.token}>
                            <span className="dsh-channels-cfg__accessMain">
                              <span>
                                {request.kind === 'group' ? PANEL_COPY.accessRequestGroup : PANEL_COPY.accessRequestUser}
                                {'：'}
                                {request.name ?? request.targetId}
                              </span>
                              <span className="dsh-channels-cfg__accessMeta">
                                <span className="dsh-channels-cfg__mono">{request.targetId}</span>
                                {` · ${formatAccessDate(request.createdAt)} · ${PANEL_COPY.accessRequestExpires} ${formatAccessDate(request.expiresAt)}`}
                                {request.kind === 'user' && request.requester !== undefined
                                  ? ` · ${PANEL_COPY.accessRequestRequester} ${request.requester}`
                                  : ''}
                                {request.kind === 'user' && request.groupName !== undefined
                                  ? ` · ${request.groupName}`
                                  : request.kind === 'user' && request.chatId !== undefined
                                    ? ` · ${request.chatId}`
                                    : ''}
                              </span>
                            </span>
                            <span className="dsh-channels-cfg__accessActions">
                              <button
                                type="button"
                                className="dsh-channels-cfg__btn dsh-channels-cfg__btn--primary"
                                disabled={disabled}
                                onClick={() => onResolveRequest(request.token, 'allow')}
                              >
                                {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessAllow}
                              </button>
                              <button
                                type="button"
                                className="dsh-channels-cfg__btn"
                                disabled={disabled}
                                onClick={() => onResolveRequest(request.token, 'deny')}
                              >
                                {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessDeny}
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
            </>
          )}

      {notice === null
        ? null
        : (
            <div className="dsh-channels-cfg__notice dsh-channels-cfg__notice--ok" role="status" aria-live="polite">
              <span>{notice}</span>
            </div>
          )}
      {error === null
        ? null
        : <span className="dsh-channels-cfg__fieldError" role="alert">{error}</span>}
      <span className="dsh-channels-cfg__help">{PANEL_COPY.accessHints}</span>
      <span className="dsh-channels-cfg__help">{PANEL_COPY.accessChatIdHint}</span>
    </section>
  )
}
