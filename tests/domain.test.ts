import { describe, expect, it } from 'vitest'
import {
  appendSessionHistory, expiredRouteRecordSchema, feishuDomain, normalizeRouteRecord, normalizeSessionHistory,
  routeRecordSchema, sessionDirOf,
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
    ...partial,
  }
}

describe('route Session history', () => {
  it('accepts a legacy record and materializes its current Session in memory', () => {
    const legacy = routeRecordSchema.parse(route())
    expect(legacy.sessionHistory).toBeUndefined()
    expect(normalizeRouteRecord(legacy).sessionHistory).toEqual([
      { sessionId: 'session-current', createdAt: 100 },
    ])
  })

  it('deduplicates by Session id, keeps the earliest timestamp, and sorts oldest first', () => {
    const record = route({
      sessionHistory: [
        { sessionId: 'session-current', createdAt: 300 },
        { sessionId: 'session-old', createdAt: 90 },
        { sessionId: 'session-old', createdAt: 80 },
      ],
    })
    expect(normalizeSessionHistory(record)).toEqual([
      { sessionId: 'session-old', createdAt: 80 },
      { sessionId: 'session-current', createdAt: 300 },
    ])
  })

  it('appends a renewed Session without duplicating existing entries', () => {
    const record = route({
      sessionHistory: [{ sessionId: 'session-current', createdAt: 100 }],
    })
    expect(appendSessionHistory(record, 'session-new', 300)).toEqual([
      { sessionId: 'session-current', createdAt: 100 },
      { sessionId: 'session-new', createdAt: 300 },
    ])
  })

  it('reads the effective session directory with a legacy fallback', () => {
    expect(sessionDirOf(route())).toBe('/workspace/owner')
    expect(sessionDirOf(route({
      workspacePath: '/workspace/owner',
      sessionDir: '/workspace/owner/topics/omt_1',
      worktreeBranch: 'feishu-omt_1',
    }))).toBe('/workspace/owner/topics/omt_1')
  })

  it('accepts per-topic placement fields on a route record and rejects empty ones', () => {
    const parsed = routeRecordSchema.parse(route({
      sessionDir: '/workspace/owner/topics/omt_1',
      worktreeBranch: 'feishu-omt_1',
    }))
    expect(parsed.sessionDir).toBe('/workspace/owner/topics/omt_1')
    expect(parsed.worktreeBranch).toBe('feishu-omt_1')
    expect(() => routeRecordSchema.parse(route({ sessionDir: '' }))).toThrow()
    expect(() => routeRecordSchema.parse(route({ worktreeBranch: '' }))).toThrow()
  })

  it('rejects invalid history rows through the durable schema', () => {
    expect(() => routeRecordSchema.parse(route({
      sessionHistory: [{ sessionId: '', createdAt: -1 }],
    }))).toThrow()
  })
})

describe('expired route tombstone', () => {
  it('keeps only the identity needed to reject a retired topic', () => {
    expect(expiredRouteRecordSchema.parse({
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_owner',
      expiredAt: 300,
    })).toEqual({
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_owner',
      expiredAt: 300,
    })
  })

  it('accepts the workspace metadata of a tombstone', () => {
    expect(expiredRouteRecordSchema.parse({
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_owner',
      expiredAt: 300,
      workspacePath: '/workspace/owner',
      lastActivityAt: 250,
    })).toEqual({
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_owner',
      expiredAt: 300,
      workspacePath: '/workspace/owner',
      lastActivityAt: 250,
    })
  })

  it('still parses legacy tombstones without the workspace metadata', () => {
    const legacy = expiredRouteRecordSchema.parse({
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderUserId: 'u_owner',
      expiredAt: 300,
    })
    expect(legacy.workspacePath).toBeUndefined()
    expect(legacy.lastActivityAt).toBeUndefined()
  })

  it('rejects malformed workspace metadata in a tombstone', () => {
    const base = {
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_owner',
      expiredAt: 300,
    }
    expect(() => expiredRouteRecordSchema.parse({ ...base, workspacePath: '' })).toThrow()
    expect(() => expiredRouteRecordSchema.parse({ ...base, lastActivityAt: -1 })).toThrow()
    expect(() => expiredRouteRecordSchema.parse({ ...base, lastActivityAt: 1.5 })).toThrow()
  })

  it('carries the per-topic directory and worktree branch', () => {
    expect(expiredRouteRecordSchema.parse({
      key: 'omt_expired',
      chatId: 'oc_chat',
      chatType: 'group',
      senderUserId: 'u_owner',
      expiredAt: 300,
      workspacePath: '/workspace/owner',
      sessionDir: '/workspace/owner/topics/omt_expired',
      worktreeBranch: 'feishu-omt_expired',
      lastActivityAt: 250,
    })).toMatchObject({
      sessionDir: '/workspace/owner/topics/omt_expired',
      worktreeBranch: 'feishu-omt_expired',
    })
  })
})

describe('storage domain descriptor', () => {
  it('uses backend-safe table names', () => {
    for (const tableName of Object.keys(feishuDomain.tables)) {
      expect(tableName).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
