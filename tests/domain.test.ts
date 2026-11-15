import { describe, expect, it } from 'vitest'
import {
  GROUP_PERMISSIONS, appendSessionHistory, expiredRouteRecordSchema, feishuDomain, groupPermissionRecordSchema,
  isGroupRoute, routeRecordSchema,
} from '../src/domain.ts'
import type { RouteRecord } from '../src/domain.ts'

function route(partial: Partial<RouteRecord> = {}): RouteRecord {
  return {
    key: 'omt_1',
    kind: 'thread',
    sessionId: 'session-current',
    chatId: 'oc_chat',
    chatType: 'group',
    senderUserId: 'u_owner',
    workspacePath: '/workspace/owner',
    cardMessageId: 'om_card',
    createdAt: 100,
    lastActivityAt: 200,
    sessionHistory: [{ sessionId: 'session-current', createdAt: 100 }],
    ...partial,
  }
}

describe('route Session history', () => {
  it('requires the history on a route record', () => {
    const { sessionHistory: _history, ...withoutHistory } = route()
    expect(() => routeRecordSchema.parse(withoutHistory)).toThrow()
  })

  it('appends a renewed Session without duplicating existing entries', () => {
    expect(appendSessionHistory(route(), 'session-new', 300)).toEqual([
      { sessionId: 'session-current', createdAt: 100 },
      { sessionId: 'session-new', createdAt: 300 },
    ])
  })

  it('keeps the earliest timestamp of a repeated Session and sorts oldest first', () => {
    const record = route({ sessionHistory: [{ sessionId: 'session-current', createdAt: 300 }, { sessionId: 'session-old', createdAt: 90 }] })
    expect(appendSessionHistory(record, 'session-old', 80)).toEqual([
      { sessionId: 'session-old', createdAt: 80 },
      { sessionId: 'session-current', createdAt: 300 },
    ])
  })

  it('rejects invalid history rows through the durable schema', () => {
    expect(() => routeRecordSchema.parse(route({
      sessionHistory: [{ sessionId: '', createdAt: -1 }],
    }))).toThrow()
  })

  it('drops fields the record does not declare', () => {
    expect(routeRecordSchema.parse({ ...route(), sessionDir: '/x', mode: 'group' })).toEqual(route())
  })
})

describe('expired route tombstone', () => {
  const tombstone = {
    key: 'omt_expired',
    chatId: 'oc_chat',
    chatType: 'group',
    senderUserId: 'u_owner',
    expiredAt: 300,
    workspacePath: '/workspace/owner',
    lastActivityAt: 250,
  }

  it('keeps only the identity needed to reject a retired topic', () => {
    expect(expiredRouteRecordSchema.parse(tombstone)).toEqual(tombstone)
  })

  it('rejects a tombstone without workspace metadata or with malformed metadata', () => {
    const { workspacePath: _workspace, lastActivityAt: _last, ...bare } = tombstone
    expect(() => expiredRouteRecordSchema.parse(bare)).toThrow()
    expect(() => expiredRouteRecordSchema.parse({ ...tombstone, workspacePath: '' })).toThrow()
    expect(() => expiredRouteRecordSchema.parse({ ...tombstone, lastActivityAt: -1 })).toThrow()
    expect(() => expiredRouteRecordSchema.parse({ ...tombstone, lastActivityAt: 1.5 })).toThrow()
  })
})

describe('group routes', () => {
  it('treats every route in a group chat as a group route', () => {
    expect(isGroupRoute(route())).toBe(true)
    expect(isGroupRoute(route({ kind: 'chat', key: 'chat:group:oc_chat:u_owner' }))).toBe(true)
    expect(isGroupRoute(route({ chatType: 'p2p' }))).toBe(false)
  })

  it('accepts lastSpeakerUserId on a route record and rejects an empty one', () => {
    expect(routeRecordSchema.parse(route({ lastSpeakerUserId: 'u_bob' })).lastSpeakerUserId).toBe('u_bob')
    expect(() => routeRecordSchema.parse(route({ lastSpeakerUserId: '' }))).toThrow()
  })
})

describe('group permission records', () => {
  it('lists the three switches a group can hold', () => {
    expect(GROUP_PERMISSIONS).toEqual(['wikiRead', 'wikiWrite', 'codeWrite'])
  })

  it('requires a chat id, defaults a missing switch to off, and keeps the name optional', () => {
    const record = { chatId: 'oc_a', addedAt: 1, wikiRead: false, wikiWrite: true, codeWrite: false }
    expect(groupPermissionRecordSchema.parse(record)).toEqual(record)
    expect(groupPermissionRecordSchema.parse({ ...record, name: '研发群' }).name).toBe('研发群')
    expect(() => groupPermissionRecordSchema.parse({ ...record, chatId: '' })).toThrow()
    expect(() => groupPermissionRecordSchema.parse({ ...record, addedAt: -1 })).toThrow()
    const { codeWrite: _codeWrite, ...missing } = record
    expect(groupPermissionRecordSchema.parse(missing).codeWrite).toBe(false)
  })

  it('is stored in its own table', () => {
    expect(Object.keys(feishuDomain.tables)).toContain('group_permissions')
  })
})

describe('action proposal records', () => {
  it('registers action_proposals in the domain and validates stored items', () => {
    expect(Object.keys(feishuDomain.tables)).toContain('action_proposals')
    const schema = feishuDomain.tables.action_proposals.valueSchema
    const parsed = schema.parse({
      proposalId: '0123456789abcdef0123456789abcdef',
      key: 'act-1',
      fingerprint: 'fp-1',
      sessionId: 'session-1',
      routeKey: 'omt_1',
      chatId: 'oc_chat',
      cardMessageId: 'om_card_1',
      prompt: '可选择后续处理动作：',
      actions: [
        {
          id: 'apply_patch',
          label: '应用改动',
          followUpPrompt: '请应用改动并运行检查',
          status: 'pending',
        },
      ],
      createdAt: 1_000,
    })
    expect(parsed.actions[0]).toMatchObject({
      id: 'apply_patch',
      style: 'default',
      requiredAccess: 'chat',
      independent: false,
      status: 'pending',
    })
    expect(() => schema.parse({ ...parsed, actions: [] })).toThrow()
    expect(() => schema.parse({ ...parsed, createdAt: -1 })).toThrow()
  })
})

describe('storage domain descriptor', () => {
  it('uses backend-safe table names', () => {
    for (const tableName of Object.keys(feishuDomain.tables)) {
      expect(tableName).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
