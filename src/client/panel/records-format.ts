/**
 * Pure display helpers for the 「会话记录」 tab: times, sizes, search and
 * file-type classification.
 *
 * @module dsh-channels/client/panel/records-format
 */

import type { SessionRecordsWire, SessionRecordUserWire, SessionRecordWire } from '../../settings/contract.ts'

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * Full local timestamp, for tooltips.
 * @param ms - epoch ms.
 * @returns `YYYY-MM-DD HH:mm`.
 */
export function formatTime(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Compact time relative to `now`: 刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm /
 * M月D日 / YYYY-MM-DD.
 * @param ms - epoch ms.
 * @param now - reference epoch ms.
 * @returns the label.
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(ms)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ms >= startOfToday) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (ms >= startOfToday - 86_400_000) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

/** Latest activity of one Session. */
export function activityOf(record: SessionRecordWire): number {
  return record.lastActivityAt ?? record.createdAt
}

/** Latest activity of one user entry (sessions arrive most recent first). */
export function latestOf(user: SessionRecordUserWire): number {
  return user.sessions.length === 0 ? 0 : activityOf(user.sessions[0]!)
}

/** Totals shown above the lists. */
export interface RecordTotals {
  groups: number
  users: number
  sessions: number
}

/** Count groups, distinct users and Sessions across both lists. */
export function recordTotals(records: SessionRecordsWire): RecordTotals {
  const users = new Set<string>()
  let sessions = 0
  for (const group of records.groups) {
    for (const user of group.users) {
      users.add(user.userId)
      sessions += user.sessions.length
    }
  }
  for (const user of records.directs) {
    users.add(user.userId)
    sessions += user.sessions.length
  }
  return { groups: records.groups.length, users: users.size, sessions }
}

const matches = (query: string, ...values: Array<string | undefined>): boolean =>
  values.some(value => value !== undefined && value.toLowerCase().includes(query))

/**
 * Keep the entries matching a case-insensitive query. A matching group or
 * user keeps all its children; otherwise only matching Sessions remain, and
 * empty users and groups are dropped.
 * @param records - the full records.
 * @param rawQuery - user input; blank returns `records` unchanged.
 * @returns the filtered records.
 */
export function filterRecords(records: SessionRecordsWire, rawQuery: string): SessionRecordsWire {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return records
  const filterUser = (user: SessionRecordUserWire): SessionRecordUserWire | undefined => {
    if (matches(query, user.name, user.userId)) return user
    const sessions = user.sessions.filter(record => matches(query, record.title, record.sessionId))
    return sessions.length === 0 ? undefined : { ...user, sessions }
  }
  const groups = records.groups.flatMap((group) => {
    if (matches(query, group.chatName, group.chatId)) return [group]
    const users = group.users.flatMap(user => filterUser(user) ?? [])
    return users.length === 0 ? [] : [{ ...group, users }]
  })
  const directs = records.directs.flatMap(user => filterUser(user) ?? [])
  return { ...records, groups, directs }
}

/** Icon family of one directory entry. */
export type FileKind = 'dir' | 'image' | 'code' | 'text' | 'archive' | 'file'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'])
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'rb', 'php',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'sql', 'swift', 'vue',
])
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'rst', 'ini', 'conf', 'env'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'])

/**
 * Icon family for one entry name.
 * @param name - entry name.
 * @param isDir - whether the entry is a directory.
 * @returns the family.
 */
export function fileKindOf(name: string, isDir: boolean): FileKind {
  if (isDir) return 'dir'
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
  return 'file'
}
