/**
 * 「群权限」tab：群权限表。机器人在群里第一次开话题时自动登记该群，每群一行
 * （头像、群名、chat_id、登记时间、三个权限开关、移除）。开关与移除是独立
 * 即时 mutation；群不能在这里手动添加。
 *
 * `access.loaded === false` 时群表是「未知」而不是「空」，只渲染连接提示并
 * 禁用全部写操作。
 *
 * @module dsh-channels/client/panel/groups-tab
 */

import { fillCopy, PANEL_COPY } from '../../settings/contract.ts'
import type { AccessGroupWire, GroupPermissionWire } from '../../settings/contract.ts'
import { Avatar } from '../avatar.tsx'
import type { ProfileView } from './profiles.ts'
import { EmptyRow, NoticeBar, Row, Section } from './shared.tsx'
import type { FormView } from './shared.tsx'
import { formatAccessDate } from './whitelist.tsx'

/** The three group switches in display order with their chip labels. */
const GROUP_CHIPS: ReadonlyArray<{ permission: GroupPermissionWire; label: string }> = [
  { permission: 'wikiRead', label: PANEL_COPY.accessPermWikiRead },
  { permission: 'wikiWrite', label: PANEL_COPY.accessPermWikiWrite },
  { permission: 'codeWrite', label: PANEL_COPY.accessPermCodeWrite },
]

export interface GroupsTabProps {
  form: FormView
  profiles: ProfileView
  accessNotice: string | null
  accessError: string | null
  onRemoveGroup: (chatId: string) => void
  onTogglePermission: (chatId: string, permission: GroupPermissionWire, enabled: boolean) => void
}

export function GroupsTab(props: GroupsTabProps): JSX.Element {
  const { form, profiles, accessNotice, accessError, onRemoveGroup, onTogglePermission } = props
  const { access } = form.panel
  const working = form.busy === 'access'
  const disabled = form.busy !== null || form.locked || !access.loaded
  return (
    <div className="dsh-channels-cfg__tabBody">
      {accessNotice === null ? null : <NoticeBar kind="ok" text={accessNotice} />}
      {accessError === null ? null : <NoticeBar kind="error" text={accessError} />}
      {profiles.warning === undefined ? null : <p className="dsh-channels-cfg__secFoot">{fillCopy(PANEL_COPY.profilesWarning, { reason: profiles.warning })}</p>}
      <GroupTable
        entries={access.groups.map(group => ({
          group,
          name: profiles.chat(group.chatId)?.name ?? group.name,
          avatarUrl: profiles.chat(group.chatId)?.avatarUrl,
        }))}
        loaded={access.loaded}
        disabled={disabled}
        working={working}
        onRemove={onRemoveGroup}
        onToggle={onTogglePermission}
      />
    </div>
  )
}

/** One group row as the table renders it. */
export interface GroupTableEntry {
  group: AccessGroupWire
  /** Live Feishu group name, else the name captured at registration time. */
  name?: string
  /** Live Feishu group avatar. */
  avatarUrl?: string
}

/**
 * The group permission table: one dense row per registered group with three
 * switch chips and a remove button. Groups register themselves when their
 * first topic opens, so there is no add form.
 */
export function GroupTable(props: {
  entries: readonly GroupTableEntry[]
  loaded: boolean
  disabled: boolean
  working: boolean
  onRemove: (chatId: string) => void
  onToggle: (chatId: string, permission: GroupPermissionWire, enabled: boolean) => void
}): JSX.Element {
  const { entries, loaded, disabled, working, onRemove, onToggle } = props
  return (
    <Section
      title={loaded ? `${PANEL_COPY.groupsTitle} · ${entries.length}` : PANEL_COPY.groupsTitle}
      footnote={PANEL_COPY.groupsHint}
    >
      {!loaded ? <EmptyRow text={PANEL_COPY.groupsNotLoaded} /> : null}
      {loaded && entries.length === 0 ? <EmptyRow text={PANEL_COPY.groupsEmpty} /> : null}
      {entries.map(({ group, name, avatarUrl }) => (
        <Row
          key={group.chatId}
          leading={<Avatar text={name ?? group.chatId} url={avatarUrl} />}
          label={name ?? group.chatId}
          summary={(
            <>
              <span className="dsh-channels-cfg__mono">{group.chatId}</span>
              {` · ${formatAccessDate(group.addedAt)}`}
            </>
          )}
          control={(
            <div className="dsh-channels-cfg__inputRow">
              {GROUP_CHIPS.map(({ permission, label }) => (
                <button
                  key={permission}
                  type="button"
                  className="dsh-channels-cfg__perm"
                  aria-pressed={group[permission]}
                  disabled={disabled}
                  onClick={() => onToggle(group.chatId, permission, !group[permission])}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="dsh-channels-cfg__btn dsh-channels-cfg__btn--remove"
                disabled={disabled}
                onClick={() => onRemove(group.chatId)}
              >
                {working ? PANEL_COPY.accessWorking : PANEL_COPY.accessRemove}
              </button>
            </div>
          )}
        />
      ))}
    </Section>
  )
}
