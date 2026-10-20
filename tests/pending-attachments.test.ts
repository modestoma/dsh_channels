/**
 * Pending attachment registry: silent registration, scoped queries, consumption,
 * TTL/per-scope cap pruning, and the storage-domain degradation fallback.
 *
 * The registry never touches Feishu, the filesystem, or the native attachment
 * library — its only dependency is the injected `pending_attachments` table —
 * so these tests can drive a fake table and a fake clock directly. One service
 * test at the end proves the record GC (startup sweep) actually runs.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { feishuDomain, pendingAttachmentRecordSchema } from '../src/domain.ts'
import type { PendingAttachmentRecord, PendingAttachmentsTable } from '../src/domain.ts'
import { FeishuService } from '../src/service.ts'
import type { NormalizedMessage } from '../src/feishu-channel.ts'
import {
  PENDING_ATTACHMENT_MANIFEST_LIMIT,
  PENDING_ATTACHMENT_TEXT_EXCERPT_MAX,
  PendingAttachmentStore,
  pendingAttachmentCandidate,
  pendingAttachmentScopeKey,
} from '../src/feishu/pending-attachments.ts'
import { makeChannel, makeHostContext, makeMessage } from './helpers.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>

// ---- fixtures ------------------------------------------------------------

interface FakePendingTable {
  table: PendingAttachmentsTable
  records: Map<string, PendingAttachmentRecord>
}

function makeFakeTable(): FakePendingTable {
  const records = new Map<string, PendingAttachmentRecord>()
  const table: PendingAttachmentsTable = {
    get: (key: string) => records.get(key),
    put: vi.fn(async (key: string, value: PendingAttachmentRecord) => {
      records.set(key, value)
      return true
    }),
    update: vi.fn(async (key: string, fn: (current: PendingAttachmentRecord) => PendingAttachmentRecord) => {
      const current = records.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      records.set(key, next)
      return next
    }),
    delete: vi.fn(async (key: string) => records.delete(key)),
    entries: () => records.entries(),
  }
  return { table, records }
}

interface StoreHarness {
  store: PendingAttachmentStore
  table: PendingAttachmentsTable
  records: Map<string, PendingAttachmentRecord>
  clock: { now: number }
  warnings: string[]
}

function makeStore(options: {
  durable?: boolean
  enabled?: boolean
  ttlMs?: number
  limit?: number
} = {}): StoreHarness {
  const { table, records } = makeFakeTable()
  const clock = { now: 1_000_000 }
  const warnings: string[] = []
  const store = new PendingAttachmentStore({
    table: () => (options.durable === false ? undefined : table),
    enabled: () => options.enabled ?? true,
    ttlMs: () => options.ttlMs ?? 7 * DAY_MS,
    maxPerScope: () => options.limit ?? 10,
    now: () => clock.now,
    warn: message => warnings.push(message),
  })
  return { store, table, records, clock, warnings }
}

function record(partial: Partial<PendingAttachmentRecord> = {}): PendingAttachmentRecord {
  const messageId = partial.messageId ?? partial.key ?? 'om_record'
  return {
    key: messageId,
    scopeKey: pendingAttachmentScopeKey({ chatId: 'oc_chat', senderOpenId: 'ou_alice' }),
    messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderOpenId: 'ou_alice',
    receivedAt: 500,
    kind: 'image',
    resources: [{ type: 'image', fileKey: 'img_v3_1' }],
    ...partial,
  }
}

function imageMessage(partial: Partial<NormalizedMessage> = {}): NormalizedMessage {
  const { content = '![image](img_v3_1)', ...rest } = partial
  return makeMessage({
    messageId: 'om_img_1',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_alice',
    rawContentType: 'image',
    resources: [{ type: 'image', fileKey: 'img_v3_1' }],
    ...rest,
    content,
  })
}

async function register(
  harness: StoreHarness,
  msg: ReturnType<typeof imageMessage>,
  admitted = true,
): Promise<Awaited<ReturnType<PendingAttachmentStore['registerMessage']>>> {
  return harness.store.registerMessage(msg, admitted ? { admitted: true } : { admitted: false })
}

// ---- extraction / scope key ---------------------------------------------

describe('pending attachment candidate extraction', () => {
  it('classifies image, file, rich-text and merged-forward messages', () => {
    const image = pendingAttachmentCandidate(imageMessage())
    expect(image).toMatchObject({
      kind: 'image',
      messageId: 'om_img_1',
      chatId: 'oc_chat',
      chatType: 'group',
      senderOpenId: 'ou_alice',
    })
    expect(image?.resources).toEqual([{ type: 'image', fileKey: 'img_v3_1' }])
    expect(image?.threadId).toBeUndefined()

    const file = pendingAttachmentCandidate(makeMessage({
      rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'file_v3_1', fileName: '报告.pdf' }],
      content: '<file key="file_v3_1"/>',
    }))
    expect(file).toMatchObject({ kind: 'file' })
    expect(file?.resources).toEqual([
      { type: 'file', fileKey: 'file_v3_1', fileName: '报告.pdf' },
    ])

    const post = pendingAttachmentCandidate(makeMessage({
      rawContentType: 'post',
      resources: [{ type: 'image', fileKey: 'img_v3_post' }],
      content: '![image](img_v3_post) 帮我看看这个',
    }))
    expect(post).toMatchObject({ kind: 'post' })
    // Placeholders are stripped from the caption excerpt.
    expect(post?.textExcerpt).toBe('帮我看看这个')

    // A merged-forward record lists no child resources: the record's own
    // message id is the container to fetch through (P0 container rule); its
    // expanded transcript is not a caption, so no excerpt is stored.
    const forwarded = pendingAttachmentCandidate(makeMessage({
      rawContentType: 'merge_forward',
      content: '<forwarded_messages>...</forwarded_messages>',
    }))
    expect(forwarded).toMatchObject({ kind: 'merge_forward', resources: [] })
    expect(forwarded?.textExcerpt).toBeUndefined()
  })

  it('marks folder entries and ignores the rich-text placeholder as a caption', () => {
    // Folder entries only ride the raw `post.files` payload (the SDK converter
    // drops them), so the fixture mirrors a real rich-text message.
    const post = pendingAttachmentCandidate(makeMessage({
      rawContentType: 'post',
      resources: [],
      raw: {
        message: {
          content: JSON.stringify({
            title: '',
            content: [],
            files: [{ file_key: 'folder_v3_1', file_name: '资料', is_folder: true }],
          }),
        },
      },
      content: '[rich text message]',
    }))
    expect(post?.resources).toEqual([
      { type: 'file', fileKey: 'folder_v3_1', fileName: '资料', folder: true },
    ])
    // File-only rich-text messages carry the SDK placeholder, not a caption.
    expect(post?.textExcerpt).toBeUndefined()
  })

  it('ignores text, media, and attachment messages without downloadable resources', () => {
    expect(pendingAttachmentCandidate(makeMessage({ content: '普通文本' }))).toBeUndefined()
    expect(pendingAttachmentCandidate(makeMessage({
      rawContentType: 'audio',
      resources: [{ type: 'audio', fileKey: 'audio_v3_1' }],
      content: '',
    }))).toBeUndefined()
    expect(pendingAttachmentCandidate(makeMessage({
      rawContentType: 'image',
      resources: [],
      content: '![image](img_v3_missing)',
    }))).toBeUndefined()
    expect(pendingAttachmentCandidate(makeMessage({
      rawContentType: 'post',
      resources: [],
      content: '只有文字',
    }))).toBeUndefined()
  })

  it('keeps the thread id and truncates a long caption excerpt', () => {
    const caption = '附'.repeat(PENDING_ATTACHMENT_TEXT_EXCERPT_MAX + 50)
    const candidate = pendingAttachmentCandidate(makeMessage({
      threadId: 'omt_topic',
      rawContentType: 'post',
      resources: [{ type: 'image', fileKey: 'img_v3_long' }],
      content: `![image](img_v3_long)${caption}`,
    }))
    expect(candidate?.threadId).toBe('omt_topic')
    expect([...(candidate?.textExcerpt ?? '')]).toHaveLength(PENDING_ATTACHMENT_TEXT_EXCERPT_MAX)
    expect(candidate?.textExcerpt).toBe('附'.repeat(PENDING_ATTACHMENT_TEXT_EXCERPT_MAX))
  })

  it('builds a scope key that separates chat vs thread and sender', () => {
    const chat = pendingAttachmentScopeKey({ chatId: 'oc_1', senderOpenId: 'ou_a' })
    const thread = pendingAttachmentScopeKey({ chatId: 'oc_1', threadId: 'omt_1', senderOpenId: 'ou_a' })
    const otherSender = pendingAttachmentScopeKey({ chatId: 'oc_1', threadId: 'omt_1', senderOpenId: 'ou_b' })
    expect(chat).not.toBe(thread)
    expect(thread).not.toBe(otherSender)
    expect(new Set([chat, thread, otherSender]).size).toBe(3)
  })
})

// ---- AC1: register / query / consume / TTL -------------------------------

describe('pending attachment registry core (AC1)', () => {
  it('registers an admitted attachment message as metadata', async () => {
    const harness = makeStore()
    const result = await register(harness, imageMessage())
    expect(result.stored).toBe(true)
    if (!result.stored) return
    expect(result.evicted).toBe(0)
    expect(result.record).toMatchObject({
      key: 'om_img_1',
      messageId: 'om_img_1',
      scopeKey: pendingAttachmentScopeKey({ chatId: 'oc_chat', senderOpenId: 'ou_alice' }),
      chatId: 'oc_chat',
      chatType: 'group',
      senderOpenId: 'ou_alice',
      receivedAt: harness.clock.now,
      kind: 'image',
      resources: [{ type: 'image', fileKey: 'img_v3_1' }],
    })
    expect(harness.records.get('om_img_1')).toEqual(result.record)
    expect(pendingAttachmentRecordSchema.parse(result.record)).toEqual(result.record)
  })

  it('drops a redelivered message id without writing again', async () => {
    const harness = makeStore()
    expect((await register(harness, imageMessage())).stored).toBe(true)
    const second = await register(harness, imageMessage())
    expect(second).toEqual({ stored: false, reason: 'duplicate' })
    expect(mock(harness.table.put)).toHaveBeenCalledTimes(1)
  })

  it('lists the most recent unconsumed rows newest first, capped at 5', async () => {
    const harness = makeStore({ limit: 10 })
    for (let index = 0; index < 6; index += 1) {
      harness.clock.now += 1_000
      const registered = await register(harness, imageMessage({
        messageId: `om_recent_${index}`,
        resources: [{ type: 'image', fileKey: `img_${index}` }],
        content: `![image](img_${index})`,
      }))
      expect(registered.stored).toBe(true)
    }
    const scope = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }
    const listed = harness.store.list(scope)
    expect(listed).toHaveLength(PENDING_ATTACHMENT_MANIFEST_LIMIT)
    expect(listed.map(row => row.messageId)).toEqual([
      'om_recent_5', 'om_recent_4', 'om_recent_3', 'om_recent_2', 'om_recent_1',
    ])
    expect(harness.store.list(scope, { limit: 6 })).toHaveLength(6)
  })

  it('keeps consumed rows out of the manifest but queryable by message id', async () => {
    const harness = makeStore()
    await register(harness, imageMessage({ messageId: 'om_consumed' }))
    await register(harness, imageMessage({
      messageId: 'om_pending',
      resources: [{ type: 'image', fileKey: 'img_2' }],
      content: '![image](img_2)',
    }))
    const scope = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }

    const consumed = await harness.store.consume(scope, 'om_consumed')
    expect(consumed?.messageId).toBe('om_consumed')
    expect(consumed?.consumed).toBe(true)
    expect(harness.records.get('om_consumed')?.consumed).toBe(true)
    expect(harness.store.list(scope).map(row => row.messageId)).toEqual(['om_pending'])
    expect(harness.store.get(scope, 'om_consumed')).toMatchObject({ consumed: true })

    // Consuming twice is idempotent and does not rewrite the row.
    expect(mock(harness.table.update)).toHaveBeenCalledTimes(1)
    expect(await harness.store.consume(scope, 'om_consumed')).toMatchObject({ consumed: true })
    expect(mock(harness.table.update)).toHaveBeenCalledTimes(1)
    expect(await harness.store.consume(scope, 'om_unknown')).toBeUndefined()
  })

  it('hides rows exactly at the TTL boundary and re-registers after expiry', async () => {
    const harness = makeStore({ ttlMs: DAY_MS })
    const registered = await register(harness, imageMessage())
    expect(registered.stored).toBe(true)
    const scope = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }

    harness.clock.now += DAY_MS - 1
    expect(harness.store.list(scope)).toHaveLength(1)
    expect(harness.store.get(scope, 'om_img_1')).toBeDefined()

    harness.clock.now += 1 // receivedAt + ttl === now → expired
    expect(harness.store.list(scope)).toHaveLength(0)
    expect(harness.store.get(scope, 'om_img_1')).toBeUndefined()
    expect(await harness.store.consume(scope, 'om_img_1')).toBeUndefined()
    // Expiry is query-level until the sweep removes the row.
    expect(harness.records.has('om_img_1')).toBe(true)

    // The same message id may be registered again once its old row expired.
    const again = await register(harness, imageMessage())
    expect(again.stored).toBe(true)
    expect(harness.records.get('om_img_1')?.receivedAt).toBe(harness.clock.now)
  })

  it('disables age expiry when the TTL is 0', async () => {
    const harness = makeStore({ ttlMs: 0 })
    await register(harness, imageMessage())
    harness.clock.now += 365 * DAY_MS
    const scope = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }
    expect(harness.store.list(scope)).toHaveLength(1)
    expect(harness.store.get(scope, 'om_img_1')).toBeDefined()
  })
})

// ---- AC2: isolation / admission ------------------------------------------

describe('pending attachment isolation (AC2)', () => {
  it('isolates the same chat by sender', async () => {
    const harness = makeStore()
    await register(harness, imageMessage({ messageId: 'om_alice', senderId: 'ou_alice' }))
    await register(harness, imageMessage({
      messageId: 'om_bob',
      senderId: 'ou_bob',
      resources: [{ type: 'image', fileKey: 'img_bob' }],
      content: '![image](img_bob)',
    }))
    expect(harness.store.list({ chatId: 'oc_chat', senderOpenId: 'ou_alice' }).map(row => row.messageId))
      .toEqual(['om_alice'])
    expect(harness.store.list({ chatId: 'oc_chat', senderOpenId: 'ou_bob' }).map(row => row.messageId))
      .toEqual(['om_bob'])
  })

  it('isolates topics from each other while a topic sees its own chat timeline', async () => {
    const harness = makeStore()
    for (const message of [
      imageMessage({ messageId: 'om_thread_a', threadId: 'omt_a' }),
      imageMessage({
        messageId: 'om_thread_b',
        threadId: 'omt_b',
        resources: [{ type: 'image', fileKey: 'img_b' }],
        content: '![image](img_b)',
      }),
      imageMessage({
        messageId: 'om_main',
        resources: [{ type: 'image', fileKey: 'img_main' }],
        content: '![image](img_main)',
      }),
    ]) {
      harness.clock.now += 1_000
      expect((await register(harness, message)).stored).toBe(true)
    }
    const base = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }
    // A topic lists its own rows plus the same sender's chat-main rows (the
    // pre-topic group file must stay reachable), never another topic's rows.
    expect(harness.store.list({ ...base, threadId: 'omt_a' }).map(row => row.messageId))
      .toEqual(['om_main', 'om_thread_a'])
    expect(harness.store.list({ ...base, threadId: 'omt_b' }).map(row => row.messageId))
      .toEqual(['om_main', 'om_thread_b'])
    // The main timeline never sees topic-scoped rows.
    expect(harness.store.list(base).map(row => row.messageId)).toEqual(['om_main'])
  })

  it('rejects a cross-sender or cross-topic message id (authorization whitelist)', async () => {
    const harness = makeStore()
    const messages = [
      imageMessage({ messageId: 'om_a_thread', threadId: 'omt_a' }),
      imageMessage({
        messageId: 'om_b_thread',
        threadId: 'omt_b',
        resources: [{ type: 'image', fileKey: 'img_b' }],
        content: '![image](img_b)',
      }),
      imageMessage({
        messageId: 'om_main',
        resources: [{ type: 'image', fileKey: 'img_main' }],
        content: '![image](img_main)',
      }),
      imageMessage({
        messageId: 'om_bob_thread',
        senderId: 'ou_bob',
        threadId: 'omt_b',
        resources: [{ type: 'image', fileKey: 'img_bob' }],
        content: '![image](img_bob)',
      }),
    ]
    for (const message of messages) {
      harness.clock.now += 1_000
      expect((await register(harness, message)).stored).toBe(true)
    }
    const aliceA = { chatId: 'oc_chat', threadId: 'omt_a', senderOpenId: 'ou_alice' }
    const bobB = { chatId: 'oc_chat', threadId: 'omt_b', senderOpenId: 'ou_bob' }
    const aliceChat = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }

    // Same sender + chat + topic, and the same sender's chat-main fallback, pass.
    expect(harness.store.get(aliceA, 'om_a_thread')).toBeDefined()
    expect(harness.store.get(aliceA, 'om_main')).toBeDefined()
    expect(harness.store.get(aliceChat, 'om_main')).toBeDefined()
    // Another topic of the same sender, the chat timeline viewing a topic row,
    // and another sender's topic all fail closed — even with a known id.
    expect(harness.store.get(aliceA, 'om_b_thread')).toBeUndefined()
    expect(harness.store.get(aliceChat, 'om_a_thread')).toBeUndefined()
    expect(harness.store.get(bobB, 'om_bob_thread')).toBeDefined()
    expect(harness.store.get(bobB, 'om_b_thread')).toBeUndefined()
    expect(harness.store.get(bobB, 'om_main')).toBeUndefined()
    // Another chat with the same sender never matches either.
    const aliceOtherChat = { chatId: 'oc_other', senderOpenId: 'ou_alice' }
    expect(harness.store.get(aliceOtherChat, 'om_main')).toBeUndefined()
    expect(await harness.store.consume(aliceOtherChat, 'om_main')).toBeUndefined()
    // Consuming a foreign id must not touch the row.
    expect(await harness.store.consume(aliceA, 'om_b_thread')).toBeUndefined()
    expect(harness.records.get('om_b_thread')?.consumed).toBeUndefined()
    expect(mock(harness.table.update)).not.toHaveBeenCalled()
    // A topic may consume the same sender's chat-main row (AC-4 path).
    expect(await harness.store.consume(aliceA, 'om_main')).toMatchObject({
      messageId: 'om_main',
      consumed: true,
    })
    expect(mock(harness.table.update)).toHaveBeenCalledTimes(1)
  })

  it('isolates the same topic id across different chats', async () => {
    const harness = makeStore()
    await register(harness, imageMessage({ messageId: 'om_chat_a', chatId: 'oc_a', threadId: 'omt_shared' }))
    await register(harness, imageMessage({
      messageId: 'om_chat_b',
      chatId: 'oc_b',
      threadId: 'omt_shared',
      resources: [{ type: 'image', fileKey: 'img_chat_b' }],
      content: '![image](img_chat_b)',
    }))
    expect(harness.store.list({ chatId: 'oc_a', threadId: 'omt_shared', senderOpenId: 'ou_alice' })
      .map(row => row.messageId)).toEqual(['om_chat_a'])
    expect(harness.store.list({ chatId: 'oc_b', threadId: 'omt_shared', senderOpenId: 'ou_alice' })
      .map(row => row.messageId)).toEqual(['om_chat_b'])
  })

  it('does not register a message that failed admission', async () => {
    const harness = makeStore()
    const result = await register(harness, imageMessage(), false)
    expect(result).toEqual({ stored: false, reason: 'not-admitted' })
    expect(harness.records.size).toBe(0)
    expect(mock(harness.table.put)).not.toHaveBeenCalled()
  })

  it('does not register non-attachment messages', async () => {
    const harness = makeStore()
    const result = await register(harness, makeMessage({ content: '只是文字' }))
    expect(result).toEqual({ stored: false, reason: 'not-attachment-message' })
    expect(harness.records.size).toBe(0)
  })

  it('rejects malformed metadata instead of poisoning the stored domain', async () => {
    const harness = makeStore()
    // A normalized message without a sender id would fail the durable schema;
    // writing it would make the next domain open reject the whole table.
    const result = await register(harness, imageMessage({ senderId: '' }))
    expect(result).toEqual({ stored: false, reason: 'invalid-message' })
    expect(mock(harness.table.put)).not.toHaveBeenCalled()
    expect(harness.warnings.some(message => message.includes('malformed pending attachment'))).toBe(true)
  })
})

// ---- AC3: cap and periodic pruning ---------------------------------------

describe('pending attachment cap and pruning (AC3)', () => {
  it('evicts the oldest row of a scope when registering beyond the cap', async () => {
    const harness = makeStore({ limit: 2 })
    for (const messageId of ['om_1', 'om_2', 'om_3']) {
      harness.clock.now += 1_000
      const result = await register(harness, imageMessage({
        messageId,
        resources: [{ type: 'image', fileKey: `img_${messageId}` }],
        content: `![image](img_${messageId})`,
      }))
      expect(result.stored).toBe(true)
    }
    expect(harness.records.size).toBe(2)
    expect(harness.store.list({ chatId: 'oc_chat', senderOpenId: 'ou_alice' }).map(row => row.messageId))
      .toEqual(['om_3', 'om_2'])
  })

  it('never evicts the row it just wrote when receivedAt ties', async () => {
    const harness = makeStore({ limit: 1 })
    // Fixed clock: both rows share receivedAt, so the message-id tiebreak would
    // pick 'om_a' as the oldest if the new row were not protected.
    expect((await register(harness, imageMessage({
      messageId: 'om_b',
      resources: [{ type: 'image', fileKey: 'img_b' }],
      content: '![image](img_b)',
    }))).stored).toBe(true)
    const second = await register(harness, imageMessage({
      messageId: 'om_a',
      resources: [{ type: 'image', fileKey: 'img_a' }],
      content: '![image](img_a)',
    }))
    expect(second).toMatchObject({ stored: true, evicted: 1 })
    expect([...harness.records.keys()]).toEqual(['om_a'])
    expect(harness.store.list({ chatId: 'oc_chat', senderOpenId: 'ou_alice' }).map(row => row.messageId))
      .toEqual(['om_a'])
  })

  it('prunes expired rows and is idempotent', async () => {
    const harness = makeStore({ ttlMs: 10 * DAY_MS })
    harness.records.set('om_old', record({
      key: 'om_old',
      messageId: 'om_old',
      receivedAt: harness.clock.now - 11 * DAY_MS,
    }))
    harness.records.set('om_fresh', record({
      key: 'om_fresh',
      messageId: 'om_fresh',
      receivedAt: harness.clock.now,
    }))

    expect(await harness.store.prune()).toEqual({ removedExpired: 1, removedOverLimit: 0 })
    expect([...harness.records.keys()]).toEqual(['om_fresh'])
    expect(await harness.store.prune()).toEqual({ removedExpired: 0, removedOverLimit: 0 })
  })

  it('enforces the per-scope cap during the sweep even without registration', async () => {
    const harness = makeStore({ ttlMs: 0, limit: 2 })
    for (const [index, messageId] of ['om_1', 'om_2', 'om_3', 'om_4'].entries()) {
      harness.records.set(messageId, record({
        key: messageId,
        messageId,
        receivedAt: 1_000 + index,
      }))
    }
    expect(await harness.store.prune()).toEqual({ removedExpired: 0, removedOverLimit: 2 })
    expect([...harness.records.keys()]).toEqual(['om_3', 'om_4'])
    expect(await harness.store.prune()).toEqual({ removedExpired: 0, removedOverLimit: 0 })
  })

  it('keeps sweeping when one row cannot be deleted', async () => {
    const harness = makeStore({ ttlMs: DAY_MS })
    harness.records.set('om_a', record({
      key: 'om_a',
      messageId: 'om_a',
      receivedAt: harness.clock.now - 2 * DAY_MS,
    }))
    harness.records.set('om_b', record({
      key: 'om_b',
      messageId: 'om_b',
      receivedAt: harness.clock.now - DAY_MS - 1,
    }))
    mock(harness.table.delete).mockRejectedValueOnce(new Error('write failed'))

    expect(await harness.store.prune()).toEqual({ removedExpired: 1, removedOverLimit: 0 })
    expect(harness.warnings.some(message => message.includes('pruning pending attachment'))).toBe(true)
    // The failing row stays for the next sweep; the other expired row is gone.
    expect([...harness.records.keys()]).toEqual(['om_a'])
  })
})

// ---- AC4: registration has no Feishu/attachment side effects -------------

describe('pending attachment registration side effects (AC4)', () => {
  it('only writes metadata: no download, send, reaction, or other table access', async () => {
    const harness = makeStore()
    const result = await register(harness, imageMessage())
    expect(result.stored).toBe(true)
    // The only effects of a registration are metadata table reads/writes.
    expect(mock(harness.table.put)).toHaveBeenCalledTimes(1)
    expect(mock(harness.table.update)).not.toHaveBeenCalled()
    expect(mock(harness.table.delete)).not.toHaveBeenCalled()
    expect(harness.warnings).toEqual([])
    // The stored record references Feishu resource keys only — never bytes.
    const stored = harness.records.get('om_img_1')
    expect(stored?.resources).toEqual([{ type: 'image', fileKey: 'img_v3_1' }])
    expect(JSON.stringify(stored)).not.toMatch(/base64|data:/u)
  })
})

// ---- AC5: degradation ----------------------------------------------------

describe('pending attachment degradation (AC5)', () => {
  it('falls back to a process-memory TTL store when the domain table is absent', async () => {
    const harness = makeStore({ durable: false, ttlMs: DAY_MS, limit: 2 })
    expect(harness.store.mode()).toBe('memory')

    const scope = { chatId: 'oc_chat', senderOpenId: 'ou_alice' }
    const registered = await register(harness, imageMessage())
    expect(registered.stored).toBe(true)
    expect(mock(harness.table.put)).not.toHaveBeenCalled()
    expect(harness.store.get(scope, 'om_img_1')).toBeDefined()

    // The fallback keeps the full TTL/cap/consume semantics (the fresh
    // registration evicts the oldest row even though no durable table exists).
    for (const index of [1, 2, 3]) {
      harness.clock.now += 1_000
      await register(harness, imageMessage({
        messageId: `om_mem_${index}`,
        resources: [{ type: 'image', fileKey: `img_m${index}` }],
        content: `![image](img_m${index})`,
      }))
    }
    expect(harness.store.list(scope).map(row => row.messageId))
      .toEqual(['om_mem_3', 'om_mem_2'])
    expect(await harness.store.consume(scope, 'om_mem_3')).toMatchObject({ consumed: true })
    harness.clock.now += DAY_MS
    expect(await harness.store.prune()).toEqual({ removedExpired: 2, removedOverLimit: 0 })

    // The durability limitation is logged once, not per call.
    const fallbackWarnings = harness.warnings.filter(message => message.includes('process-memory'))
    expect(fallbackWarnings).toHaveLength(1)
  })

  it('skips registration entirely when acceptAttachments is false', async () => {
    const harness = makeStore({ enabled: false })
    const result = await register(harness, imageMessage())
    expect(result).toEqual({ stored: false, reason: 'disabled' })
    expect(mock(harness.table.put)).not.toHaveBeenCalled()
    expect(harness.records.size).toBe(0)
  })

  it('reports a storage write failure instead of throwing', async () => {
    const harness = makeStore()
    mock(harness.table.put).mockRejectedValueOnce(new Error('disk full'))
    const result = await register(harness, imageMessage())
    expect(result).toEqual({ stored: false, reason: 'storage-error' })
    expect(harness.warnings.some(message => message.includes('registration failed'))).toBe(true)
    expect(harness.records.size).toBe(0)
  })

  it('does not evict an old row when the new write fails', async () => {
    const harness = makeStore({ limit: 1 })
    expect((await register(harness, imageMessage())).stored).toBe(true)
    mock(harness.table.put).mockRejectedValueOnce(new Error('disk full'))
    const failed = await register(harness, imageMessage({
      messageId: 'om_second',
      resources: [{ type: 'image', fileKey: 'img_second' }],
      content: '![image](img_second)',
    }))
    expect(failed).toEqual({ stored: false, reason: 'storage-error' })
    // The old row is still present: a failed write must not cost data.
    expect([...harness.records.keys()]).toEqual(['om_img_1'])
    expect(harness.store.list({ chatId: 'oc_chat', senderOpenId: 'ou_alice' }))
      .toHaveLength(1)
  })
})

// ---- storage-domain table addition --------------------------------------

describe('storage domain compatibility', () => {
  it('adds pending_attachments without bumping the domain version or dropping tables', () => {
    expect(feishuDomain.version).toBe(1)
    expect(Object.keys(feishuDomain.tables)).toEqual(expect.arrayContaining([
      'routes',
      'inflight',
      'processed',
      'expired_routes',
      'access_groups',
      'access_users',
      'access_requests',
      'pending_attachments',
    ]))
    expect(feishuDomain.tables.pending_attachments.valueSchema).toBe(pendingAttachmentRecordSchema)
  })

  it('validates stored pending records strictly', () => {
    expect(pendingAttachmentRecordSchema.parse(record())).toEqual(record())
    expect(pendingAttachmentRecordSchema.parse(record({
      threadId: 'omt_1',
      textExcerpt: '看下这个',
      consumed: true,
    }))).toMatchObject({ threadId: 'omt_1', textExcerpt: '看下这个', consumed: true })
    expect(() => pendingAttachmentRecordSchema.parse({ ...record(), kind: 'audio' })).toThrow()
    expect(() => pendingAttachmentRecordSchema.parse(record({ receivedAt: -1 }))).toThrow()
    expect(() => pendingAttachmentRecordSchema.parse({ ...record(), chatType: 'other' })).toThrow()
    expect(() => pendingAttachmentRecordSchema.parse(record({
      resources: [{ type: 'image', fileKey: '' }],
    }))).toThrow()
  })
})

// ---- configuration -------------------------------------------------------

describe('pending attachment configuration', () => {
  it('defaults to a 7-day TTL and 10 rows per scope', () => {
    const config = resolveConfig({})
    expect(config.acceptAttachments).toBe(true)
    expect(config.pendingAttachmentTtlMs).toBe(7 * DAY_MS)
    expect(config.pendingAttachmentLimit).toBe(10)
  })

  it('accepts a disabled TTL and the limit bounds; rejects out-of-range values', () => {
    expect(resolveConfig({ pendingAttachmentTtlMs: 0 }).pendingAttachmentTtlMs).toBe(0)
    expect(resolveConfig({ pendingAttachmentLimit: 1 }).pendingAttachmentLimit).toBe(1)
    expect(resolveConfig({ pendingAttachmentLimit: 100 }).pendingAttachmentLimit).toBe(100)
    expect(() => resolveConfig({ pendingAttachmentTtlMs: -1 })).toThrow(/invalid configuration/u)
    expect(() => resolveConfig({ pendingAttachmentLimit: 0 })).toThrow(/invalid configuration/u)
    expect(() => resolveConfig({ pendingAttachmentLimit: 101 })).toThrow(/invalid configuration/u)
    expect(() => resolveConfig({ pendingAttachmentLimit: 2.5 })).toThrow(/invalid configuration/u)
  })
})

// ---- record GC wiring ----------------------------------------------------

const waitUntil = async (assert: () => void) => {
  await vi.waitFor(assert, { timeout: 2000, interval: 5 })
}

describe('pending attachment record GC wiring (startup sweep)', () => {
  it('prunes expired pending rows at startup even when route GC is disabled', async () => {
    const ctxState = makeHostContext()
    const pendingTable = ctxState.domain.raw.table('pending_attachments')
    await pendingTable.put('om_expired', record({
      key: 'om_expired',
      messageId: 'om_expired',
      receivedAt: Date.now() - 8 * DAY_MS,
    }))
    await pendingTable.put('om_fresh', record({
      key: 'om_fresh',
      messageId: 'om_fresh',
      receivedAt: Date.now(),
    }))

    const channel = makeChannel()
    const config = resolveConfig({
      baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-channels-pending-')),
      routeTtlMs: 0,
    })
    const service = new FeishuService(ctxState.ctx, config, () => channel)
    await service.start()
    try {
      await waitUntil(() => {
        const keys = [...pendingTable.entries()].map(([key]) => key)
        expect(keys).toEqual(['om_fresh'])
      })
      // This task deliberately does not wire registration into inbound.
      expect(ctxState.agents.created).toHaveLength(0)
    } finally {
      await service.shutdown()
    }
  })
})
