import { describe, expect, it } from 'vitest'
import {
  appendSessionHistory, normalizeRouteRecord, normalizeSessionHistory, routeRecordSchema,
} from '../src/domain.ts'
import type { RouteRecord } from '../src/domain.ts'

function route(partial: Partial<RouteRecord> = {}): RouteRecord {
  return {
    key: 'omt_1',
    kind: 'thread',
    sessionId: 'session-current',
    chatId: 'oc_chat',
    chatType: 'group',
    senderOpenId: 'ou_owner',
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

  it('rejects invalid history rows through the durable schema', () => {
    expect(() => routeRecordSchema.parse(route({
      sessionHistory: [{ sessionId: '', createdAt: -1 }],
    }))).toThrow()
  })
})
