/**
 * 「会话记录」 display helpers: relative times, byte sizes, totals, search
 * filtering and file-type classification.
 */

import { describe, expect, it } from 'vitest'
import {
  fileKindOf,
  filterRecords,
  formatBytes,
  formatRelativeTime,
  latestOf,
  recordTotals,
} from '../src/client/panel/records-format.ts'
import type { SessionRecordsWire, SessionRecordUserWire, SessionRecordWire } from '../src/settings/contract.ts'

function session(sessionId: string, title: string | undefined, at: number): SessionRecordWire {
  return { sessionId, title, kind: 'chat', shared: false, createdAt: at, bound: false, live: false }
}

function user(userId: string, name: string | undefined, sessions: SessionRecordWire[]): SessionRecordUserWire {
  return { userId, name, workspaces: [], sessions }
}

const records: SessionRecordsWire = {
  groups: [
    {
      chatId: 'oc_1',
      chatName: '研发效能群',
      users: [
        user('u_zhang', '张三', [session('s1', '排查 CI 构建超时', 300), session('s2', '整理周报', 200)]),
        user('u_li', '李四', [session('s3', 'Deploy script', 100)]),
      ],
    },
    { chatId: 'oc_2', chatName: '产品讨论', users: [user('u_zhang', '张三', [session('s4', '需求评审', 50)])] },
  ],
  directs: [user('u_modesto', 'Modesto', [session('s5', '帮我写部署脚本', 400)])],
}

describe('formatRelativeTime', () => {
  const now = new Date(2026, 9, 31, 15, 30).getTime()

  it('labels recent, same-day, yesterday, same-year and older times', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatRelativeTime(new Date(2026, 9, 30, 9, 5).getTime(), now)).toBe('昨天 09:05')
    expect(formatRelativeTime(new Date(2026, 9, 28, 12, 0).getTime(), now)).toBe('10月28日')
    expect(formatRelativeTime(new Date(2025, 0, 2, 12, 0).getTime(), now)).toBe('2025-01-02')
  })
})

describe('formatBytes', () => {
  it('uses B below 1 KB and one decimal above', () => {
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(3482)).toBe('3.4 KB')
    expect(formatBytes(12 * 1024 * 1024)).toBe('12.0 MB')
  })
})

describe('recordTotals and latestOf', () => {
  it('counts groups, distinct users and every Session', () => {
    expect(recordTotals(records)).toEqual({ groups: 2, users: 3, sessions: 5 })
  })

  it('takes a user’s latest activity from the first Session', () => {
    expect(latestOf(records.groups[0]!.users[0]!)).toBe(300)
    expect(latestOf(user('u_empty', undefined, []))).toBe(0)
  })
})

describe('filterRecords', () => {
  it('returns the records unchanged for a blank query', () => {
    expect(filterRecords(records, '  ')).toBe(records)
  })

  it('keeps every child of a matching group', () => {
    const filtered = filterRecords(records, '研发')
    expect(filtered.groups.map(group => group.chatId)).toEqual(['oc_1'])
    expect(filtered.groups[0]!.users).toHaveLength(2)
    expect(filtered.directs).toEqual([])
  })

  it('keeps every Session of a matching user across groups', () => {
    const filtered = filterRecords(records, '张三')
    expect(filtered.groups.map(group => group.users.map(entry => entry.userId))).toEqual([['u_zhang'], ['u_zhang']])
    expect(filtered.groups[0]!.users[0]!.sessions).toHaveLength(2)
  })

  it('keeps only matching Sessions otherwise, case-insensitively', () => {
    const filtered = filterRecords(records, 'deploy')
    expect(filtered.groups).toEqual([{ ...records.groups[0]!, users: [records.groups[0]!.users[1]!] }])
    expect(filtered.directs).toEqual([])
    expect(filterRecords(records, 's5').directs[0]!.sessions.map(record => record.sessionId)).toEqual(['s5'])
  })
})

describe('fileKindOf', () => {
  it('classifies directories and file extensions', () => {
    expect(fileKindOf('src', true)).toBe('dir')
    expect(fileKindOf('logo.PNG', false)).toBe('image')
    expect(fileKindOf('deploy.ts', false)).toBe('code')
    expect(fileKindOf('notes.md', false)).toBe('text')
    expect(fileKindOf('bundle.tar.gz', false)).toBe('archive')
    expect(fileKindOf('.env', false)).toBe('file')
    expect(fileKindOf('Makefile', false)).toBe('file')
  })
})
