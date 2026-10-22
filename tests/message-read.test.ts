/**
 * `message-read` tests: raw response parsing, unified text/resource rendering,
 * quote/history prompt blocks, route membership, and the thin read wrappers
 * (structured failures, pagination bounds, cancellation, mget fallback).
 */

import { describe, expect, it, vi } from 'vitest'
import type { RawMessageListParams } from '../src/feishu-channel.ts'
import {
  HISTORY_CONTEXT_TAG,
  MAX_EXCERPT_CHARS,
  MessageReader,
  QUOTE_CONTEXT_TAG,
  TOPIC_MESSAGES_MAX_LIMIT,
  buildHistoryContextBlock,
  buildQuoteContextBlock,
  clampInt,
  classifyReadError,
  describeReadError,
  formatMessageTime,
  knownMessageOfItems,
  knownMessagesOfHistory,
  messageBelongsToRoute,
  messageTextOf,
  parseMessageItems,
  parseMessagePage,
  readQuoteItems,
  renderMessageLine,
  resourcesOfItem,
  sanitizeExcerpt,
  topicMessageViewOf,
  type RawMessageItem,
} from '../src/feishu/message-read.ts'
import {
  makeChannel, makeMessageGetResponse, makeMessageListResponse, makeRawMessage,
} from './helpers.ts'

const ROUTE = {
  key: 'omt_topic',
  kind: 'thread',
  chatId: 'oc_chat',
  chatType: 'group',
  senderUserId: 'u_user',
} as const

const CHAT_ROUTE = {
  key: 'chat:oc_chat:u_user',
  kind: 'chat',
  chatId: 'oc_chat',
  chatType: 'p2p',
  senderUserId: 'u_user',
} as const

function item(partial: Parameters<typeof makeRawMessage>[0] = {}): RawMessageItem {
  const parsed = parseMessageItems(makeMessageGetResponse([makeRawMessage(partial)]))
  const first = parsed?.[0]
  if (first === undefined) throw new Error('test fixture did not parse')
  return first
}

function pageItem(partial: Parameters<typeof makeRawMessage>[0] = {}): RawMessageItem {
  const parsed = parseMessagePage(makeMessageListResponse([makeRawMessage(partial)]))
  const first = parsed?.items[0]
  if (first === undefined) throw new Error('test fixture did not parse')
  return first
}

describe('raw response parsing', () => {
  it('unwraps the SDK envelope and parses get/mget item shapes', () => {
    const raw = makeRawMessage({
      message_id: 'om_1',
      msg_type: 'text',
      create_time: 1792508690777,
      chat_id: 'oc_chat',
      thread_id: 'omt_topic',
      parent_id: 'om_parent',
      sender_type: 'user',
      sender_id: 'u_user',
      content: { text: '你好' },
    })
    const parsed = parseMessageItems({ data: { items: [raw] } })
    expect(parsed).toHaveLength(1)
    expect(parsed?.[0]).toMatchObject({
      messageId: 'om_1',
      msgType: 'text',
      createTime: 1792508690777,
      chatId: 'oc_chat',
      threadId: 'omt_topic',
      parentId: 'om_parent',
      senderUserId: 'u_user',
      senderType: 'user',
      deleted: false,
    })
    expect(parsed?.[0]?.content).toEqual({ text: '你好' })
    // Only a `user_id`-typed sender id is a user identity.
    const openIdSender = { ...raw, sender: { id: 'ou_x', id_type: 'open_id', sender_type: 'user' } }
    expect(parseMessageItems({ data: { items: [openIdSender] } })?.[0]?.senderUserId).toBeUndefined()
    // mget answers with the same `data.items` shape.
    expect(parseMessageItems({ data: { items: [raw] } })).toEqual(parsed)
    // Tolerate a direct `{ items }` body used by stubs.
    expect(parseMessageItems({ items: [raw] })).toEqual(parsed)
    expect(parseMessageItems({ data: {} })).toBeUndefined()
    expect(parseMessageItems(null)).toBeUndefined()
  })

  it('parses a list page including has_more/page_token', () => {
    const page = parseMessagePage(makeMessageListResponse(
      [makeRawMessage({ message_id: 'om_1', content: { text: 'a' } })],
      { hasMore: true, pageToken: 'cursor-1' },
    ))
    expect(page?.items).toHaveLength(1)
    expect(page?.hasMore).toBe(true)
    expect(page?.pageToken).toBe('cursor-1')
    const noToken = parseMessagePage(makeMessageListResponse([]))
    expect(noToken).toEqual({ items: [], hasMore: false })
  })

  it('extracts resources from image/file/folder/post messages', () => {
    expect(resourcesOfItem('image', { image_key: 'img_1' })).toEqual([{ type: 'image', fileKey: 'img_1' }])
    expect(resourcesOfItem('file', { file_key: 'file_1', file_name: 'a.pdf' }))
      .toEqual([{ type: 'file', fileKey: 'file_1', fileName: 'a.pdf' }])
    expect(resourcesOfItem('folder', { file_key: 'file_folder', file_name: 'assets' }))
      .toEqual([{ type: 'file', fileKey: 'file_folder', folder: true, fileName: 'assets' }])
    const post = resourcesOfItem('post', {
      title: 't',
      content: [[
        { tag: 'text', text: 'hi' },
        { tag: 'img', image_key: 'img_inline' },
        { tag: 'file', file_key: 'file_inline', file_name: 'b.pdf' },
      ]],
      files: [{ file_key: 'file_attached', file_name: 'c.pdf' }, { file_key: 'img_inline' }],
    })
    expect(post).toEqual([
      { type: 'image', fileKey: 'img_inline' },
      { type: 'file', fileKey: 'file_inline', fileName: 'b.pdf' },
      { type: 'file', fileKey: 'file_attached', fileName: 'c.pdf' },
    ])
    // Merge-forward containers carry no direct resources.
    expect(resourcesOfItem('merge_forward', {})).toEqual([])
    expect(resourcesOfItem('text', undefined)).toEqual([])
  })
})

describe('unified rendering', () => {
  it('renders text, post, media placeholders and deleted messages', () => {
    expect(messageTextOf(item({ msg_type: 'text', content: { text: '  你好\n世界  ' } })))
      .toBe('  你好\n世界  ')
    const post = item({
      msg_type: 'post',
      content: {
        title: '标题',
        content: [[
          { tag: 'text', text: '正文' },
          { tag: 'img', image_key: 'img_1' },
          { tag: 'at', user_name: '小王' },
        ]],
        files: [{ file_key: 'file_1', file_name: 'a.pdf' }],
      },
    })
    expect(messageTextOf(post)).toBe('标题 正文[图片]@小王')
    // Inline attachments are positional placeholders; their names are listed
    // once by the line's attachment suffix.
    const inlineFiles = item({
      msg_type: 'post',
      content: { content: [[{ tag: 'file', file_key: 'f1', file_name: 'a.pdf' }, { tag: 'media', file_key: 'f2' }]] },
    })
    expect(messageTextOf(inlineFiles)).toBe('[文件][视频]')
    // Localized post bodies (`{ zh_cn: { content } }`) are flattened too.
    const localized = item({
      msg_type: 'post',
      content: { zh_cn: { title: '本地化标题', content: [[{ tag: 'text', text: '本地化正文' }]] } },
    })
    expect(messageTextOf(localized)).toBe('本地化标题 本地化正文')
    expect(messageTextOf(item({ msg_type: 'image', content: { image_key: 'img_1' } }))).toBe('[图片]')
    expect(messageTextOf(item({ msg_type: 'file', content: { file_key: 'f', file_name: 'a.zip' } })))
      .toBe('[文件 a.zip]')
    expect(messageTextOf(item({ msg_type: 'folder', content: { file_key: 'f', file_name: 'assets' } })))
      .toBe('[文件夹 assets]')
    expect(messageTextOf(item({ msg_type: 'merge_forward', content: {} }))).toBe('[合并转发]')
    expect(messageTextOf(item({ msg_type: 'interactive', content: {} }))).toBe('[卡片消息]')
    expect(messageTextOf(item({ msg_type: 'audio', content: {} }))).toBe('[语音]')
    expect(messageTextOf(item({ msg_type: 'system', content: {} }))).toBe('[系统消息]')
    expect(messageTextOf(item({ msg_type: 'text', deleted: true, content: '{}' }))).toBe('[已撤回]')
  })

  it('flattens card messages into text', () => {
    // Default read-API structure: title plus rows of elements.
    const simplified = item({
      msg_type: 'interactive',
      content: {
        title: '构建失败',
        elements: [
          [{ tag: 'text', text: '分支 dev ' }, { tag: 'a', text: '查看日志', href: 'https://x' }],
          [{ tag: 'at', user_name: '张三' }],
          [{ tag: 'img', image_key: 'img_1' }],
          [{ tag: 'button', text: '重试' }],
        ],
      },
    })
    expect(messageTextOf(simplified)).toBe('[卡片] 构建失败 分支 dev 查看日志 @张三 [图片] 重试')
    // Sent JSON 2.0: header title, nested markdown, button labels; callback
    // values and links are not text.
    const raw = item({
      msg_type: 'interactive',
      content: {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: '审批' } },
        body: {
          elements: [
            { tag: 'markdown', content: '**金额** 100' },
            {
              tag: 'column_set',
              columns: [{ elements: [{ tag: 'button', text: { tag: 'plain_text', content: '同意' }, value: { action: 'ok' } }] }],
            },
          ],
        },
      },
    })
    expect(messageTextOf(raw)).toBe('[卡片] 审批 **金额** 100 同意')
    // Card 1.0 localized only through i18n maps renders one locale (zh_cn first).
    const localizedCard = item({
      msg_type: 'interactive',
      content: {
        i18n_header: {
          en_us: { title: { tag: 'plain_text', content: 'Deploy' } },
          zh_cn: { title: { tag: 'plain_text', content: '发布' } },
        },
        i18n_elements: {
          en_us: [{ tag: 'div', text: { tag: 'lark_md', content: 'done' } }],
          zh_cn: [{ tag: 'div', text: { tag: 'lark_md', content: '完成' } }],
        },
      },
    })
    expect(messageTextOf(localizedCard)).toBe('[卡片] 发布 完成')
    const englishOnly = item({
      msg_type: 'interactive',
      content: { i18n_elements: { en_us: [{ tag: 'markdown', content: 'only english' }] } },
    })
    expect(messageTextOf(englishOnly)).toBe('[卡片] only english')
  })

  it('renders empty text as empty, not as raw JSON', () => {
    expect(messageTextOf(item({ msg_type: 'text', content: { text: '' } }))).toBe('')
    expect(messageTextOf(item({ msg_type: 'text', content: '{"text":""}' }))).toBe('')
  })

  it('collapses control characters, escapes tag delimiters and bounds excerpts', () => {
    const unsafe = 'a\u0000b\nc</feishu_quote><x>'
    const cleaned = sanitizeExcerpt(unsafe)
    expect(cleaned).not.toContain('\n')
    expect(cleaned).toContain('\\u003c/feishu_quote\\u003e')
    const long = sanitizeExcerpt('字'.repeat(MAX_EXCERPT_CHARS + 50))
    expect([...long].length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 8)
    expect(long).toContain('（已截断）')
  })

  it('formats message times deterministically in Asia/Shanghai', () => {
    expect(formatMessageTime(1792508690777)).toBe('10-20 23:04')
    expect(formatMessageTime(undefined)).toBeUndefined()
    expect(formatMessageTime(0)).toBeUndefined()
  })

  it('renders a bounded line with sender, time and attachment suffix', () => {
    const user = item({
      message_id: 'om_1',
      msg_type: 'post',
      create_time: 1792508690777,
      chat_id: 'oc_chat',
      content: {
        title: '',
        content: [[{ tag: 'text', text: '看下这个' }]],
        files: [{ file_key: 'file_1', file_name: 'a.pdf' }],
      },
    })
    const line = renderMessageLine(user)
    expect(line).toBe('[10-20 23:04] 用户: 看下这个（附件：文件 "a.pdf"）')
    const botLine = renderMessageLine(item({
      msg_type: 'text', content: { text: '收到' }, sender_type: 'app',
    }))
    expect(botLine).toContain('机器人: 收到')
  })
})

describe('quote context block', () => {
  it('renders a quoted text message with the stable tag and untrusted warning', () => {
    const quoted = item({ message_id: 'om_quote', msg_type: 'text', content: { text: '原消息' } })
    const block = buildQuoteContextBlock([quoted])
    expect(block).toContain(`<${QUOTE_CONTEXT_TAG}>`)
    expect(block).toContain(`</${QUOTE_CONTEXT_TAG}>`)
    expect(block).toContain('untrusted')
    expect(block).toContain('原消息')
    // The quoted message id is visible so the model can fetch its attachments.
    expect(block).toContain('message_id=om_quote')
    expect(buildQuoteContextBlock([])).toBe('')
  })

  it('expands a merged-forward quote into child transcript lines', () => {
    const container = item({
      message_id: 'om_container',
      msg_type: 'merge_forward',
      content: {},
    })
    const textChild = item({
      message_id: 'om_child_text',
      msg_type: 'text',
      upper_message_id: 'om_container',
      content: { text: '子消息文本' },
    })
    const imageChild = item({
      message_id: 'om_child_image',
      msg_type: 'image',
      upper_message_id: 'om_container',
      content: { image_key: 'img_child' },
    })
    const block = buildQuoteContextBlock([container, textChild, imageChild])
    expect(block).toContain('合并转发，共 2 条子消息')
    expect(block).toContain('子消息文本')
    expect(block).toContain('[图片]')
    // Child resources are not claimed as direct resources of the container.
    expect(knownMessageOfItems([container, textChild, imageChild])).toEqual({
      messageId: 'om_container',
      kind: 'merge_forward',
      resources: [],
    })
  })

  it('does not advertise the fetch tool when the deployment has none', () => {
    const quoted = item({ message_id: 'om_quote', msg_type: 'file', content: { file_key: 'f1', file_name: 'a.pdf' } })
    const block = buildQuoteContextBlock([quoted], { attachmentFetchAvailable: false })
    expect(block).toContain('message_id=om_quote')
    expect(block).not.toContain('feishu_attachment_fetch')
  })

  it('bounds an oversized merged-forward transcript', () => {
    const container = item({ message_id: 'om_container', msg_type: 'merge_forward', content: {} })
    const children = Array.from({ length: 40 }, (_, index) => item({
      message_id: `om_child_${index}`,
      msg_type: 'text',
      upper_message_id: 'om_container',
      content: { text: `子消息 ${index} `.repeat(20) },
    }))
    const block = buildQuoteContextBlock([container, ...children], { maxChars: 80, maxBlockChars: 1600 })
    expect(block.length).toBeLessThanOrEqual(1600)
    expect(block).toContain('未展示')
  })
})

describe('history context block', () => {
  it('renders oldest-first lines and keeps the newest under the cap', () => {
    const messages = Array.from({ length: 4 }, (_, index) => item({
      message_id: `om_${index}`,
      msg_type: 'text',
      create_time: 1792508600000 + index * 1000,
      content: { text: `消息 ${index}` },
    }))
    const block = buildHistoryContextBlock(messages, { maxMessages: 3 })
    expect(block).toContain(`<${HISTORY_CONTEXT_TAG}>`)
    expect(block).toContain('untrusted')
    // Every line carries its message id so history attachments are fetchable.
    expect(block).toContain('message_id=om_1')
    expect(block).not.toContain('消息 0')
    expect(block.indexOf('消息 1')).toBeLessThan(block.indexOf('消息 3'))
    expect(buildHistoryContextBlock([])).toBe('')
  })

  it('does not advertise the fetch tool in history when the deployment has none', () => {
    const message = item({ message_id: 'om_h', msg_type: 'file', content: { file_key: 'f1' } })
    const block = buildHistoryContextBlock([message], { attachmentFetchAvailable: false })
    expect(block).toContain('message_id=om_h')
    expect(block).not.toContain('feishu_attachment_fetch')
  })

  it('registers every history message as known (including resource-less ones)', () => {
    const text = item({ message_id: 'om_text', msg_type: 'text', content: { text: 'hi' } })
    const image = item({ message_id: 'om_image', msg_type: 'image', content: { image_key: 'img_1' } })
    const deleted = item({ message_id: 'om_deleted', msg_type: 'text', deleted: true })
    const forward = item({ message_id: 'om_forward', msg_type: 'merge_forward', content: {} })
    expect(knownMessagesOfHistory([text, image, deleted, forward])).toEqual([
      { messageId: 'om_text', kind: 'message', resources: [] },
      { messageId: 'om_image', kind: 'message', resources: [{ type: 'image', fileKey: 'img_1' }] },
      { messageId: 'om_forward', kind: 'merge_forward', resources: [] },
    ])
  })
})

describe('topic message view', () => {
  it('produces lossless JSON without undefined keys', () => {
    const view = topicMessageViewOf(item({
      message_id: 'om_1',
      msg_type: 'image',
      create_time: 1792508690777,
      parent_id: 'om_parent',
      content: { image_key: 'img_1' },
    }))
    expect(view).toEqual({
      message_id: 'om_1',
      type: 'image',
      sender: 'user',
      time: '10-20 23:04',
      text: '[图片]',
      parent_message_id: 'om_parent',
      resources: [{ type: 'image', file_key: 'img_1' }],
    })
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
    const plain = topicMessageViewOf(item({ msg_type: 'text', content: { text: 'hi' } }))
    expect('resources' in plain).toBe(false)
  })
})

describe('route membership', () => {
  const inThread = item({ message_id: 'om_in', chat_id: 'oc_chat', thread_id: 'omt_topic' })
  const mainLine = item({ message_id: 'om_main', chat_id: 'oc_chat' })
  const otherThread = item({ message_id: 'om_other', chat_id: 'oc_chat', thread_id: 'omt_other' })
  const otherChat = item({ message_id: 'om_chat2', chat_id: 'oc_other', thread_id: 'omt_topic' })
  const missingChat = item({ message_id: 'om_missing_chat', thread_id: 'omt_topic' })

  it('accepts only the route container plus explicitly known main-line messages', () => {
    expect(messageBelongsToRoute(ROUTE, inThread)).toBe(true)
    expect(messageBelongsToRoute(ROUTE, mainLine)).toBe(false)
    expect(messageBelongsToRoute(ROUTE, mainLine, ['om_main'])).toBe(true)
    expect(messageBelongsToRoute(ROUTE, otherThread)).toBe(false)
    expect(messageBelongsToRoute(ROUTE, otherChat)).toBe(false)
    // A response without a chat id fails closed instead of being trusted.
    expect(messageBelongsToRoute(ROUTE, missingChat)).toBe(false)
  })

  it('never accepts unregistered main-line messages of the route owner in a thread route', () => {
    const ownerMain = item({ message_id: 'om_owner', chat_id: 'oc_chat', sender_id: 'u_user' })
    const ownerOtherThread = item({
      message_id: 'om_owner_other', chat_id: 'oc_chat', thread_id: 'omt_other', sender_id: 'u_user',
    })
    const ownerOtherChat = item({ message_id: 'om_owner_chat2', chat_id: 'oc_other', sender_id: 'u_user' })
    expect(messageBelongsToRoute(ROUTE, ownerMain)).toBe(false)
    expect(messageBelongsToRoute(ROUTE, ownerMain, ['om_owner'])).toBe(true)
    expect(messageBelongsToRoute(ROUTE, ownerOtherThread)).toBe(false)
    expect(messageBelongsToRoute(ROUTE, ownerOtherChat)).toBe(false)
  })

  it('filters topic messages out of a degraded chat route', () => {
    expect(messageBelongsToRoute(CHAT_ROUTE, mainLine)).toBe(true)
    expect(messageBelongsToRoute(CHAT_ROUTE, inThread)).toBe(false)
    // A topic message stays rejected even when its id was somehow registered.
    expect(messageBelongsToRoute(CHAT_ROUTE, inThread, ['om_in'])).toBe(false)
    expect(messageBelongsToRoute(CHAT_ROUTE, otherChat)).toBe(false)
  })
})

describe('MessageReader wrappers', () => {
  it('reports a structured failure without a channel', async () => {
    const reader = new MessageReader({ channel: () => undefined })
    expect(await reader.readMessage('om_1')).toEqual({
      ok: false, code: 'CHANNEL_UNAVAILABLE', reason: '飞书连接未运行，无法读取消息',
    })
    expect(await reader.listThread('omt_1')).toMatchObject({ ok: false, code: 'CHANNEL_UNAVAILABLE' })
  })

  it('reads one message and tolerates an unrecognized response', async () => {
    const channel = makeChannel({
      messageGet: async () => makeMessageGetResponse([makeRawMessage({ message_id: 'om_1', content: { text: 'hi' } })]),
    })
    const reader = new MessageReader({ channel: () => channel })
    const result = await reader.readMessage('om_1')
    expect(result.ok && result.value[0]?.messageId).toBe('om_1')

    const broken = new MessageReader({ channel: () => makeChannel({ messageGet: async () => ({ data: {} }) }) })
    expect(await broken.readMessage('om_1')).toMatchObject({ ok: false, code: 'MESSAGE_READ_FAILED' })
  })

  it('maps Feishu permission errors to PERMISSION_DENIED with a readable reason', async () => {
    const channel = makeChannel({
      messageGet: async () => {
        throw Object.assign(new Error('request failed'), {
          response: { status: 403, data: { code: 99991672, msg: 'No permission to read messages' } },
        })
      },
    })
    const reader = new MessageReader({ channel: () => channel })
    const result = await reader.readMessage('om_1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('PERMISSION_DENIED')
    expect(result.reason).toContain('im:message:readonly')
    expect(describeReadError({ code: 123, msg: 'boom' })).toBe('code=123 msg=boom')
  })

  it('maps a resolved API error body and keeps its code/msg readable', async () => {
    const resolved = new MessageReader({
      channel: () => makeChannel({ messageGet: async () => ({ code: 99991672, msg: 'No permission' }) }),
    })
    const permission = await resolved.readMessage('om_1')
    expect(permission).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(permission.ok ? '' : permission.reason).toContain('99991672')

    const notFound = new MessageReader({
      channel: () => makeChannel({ messageGet: async () => ({ code: 234003, msg: 'message not found' }) }),
    })
    const missing = await notFound.readMessage('om_1')
    expect(missing).toMatchObject({ ok: false, code: 'MESSAGE_READ_FAILED' })
    expect(missing.ok ? '' : missing.reason).toContain('message not found')

    // An Axios-style throw prefers the Feishu code/msg over the generic
    // "Request failed with status code 400" message.
    const axiosLike = new MessageReader({
      channel: () => makeChannel({
        messageGet: async () => {
          throw Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400, data: { code: 234003, msg: 'message not found' } },
          })
        },
      }),
    })
    const thrown = await axiosLike.readMessage('om_1')
    expect(thrown).toMatchObject({ ok: false, code: 'MESSAGE_READ_FAILED' })
    expect(thrown.ok ? '' : thrown.reason).toContain('234003')
    expect(thrown.ok ? '' : thrown.reason).toContain('message not found')
  })

  it('returns ABORTED/TIMEOUT as readable failures', async () => {
    const controller = new AbortController()
    controller.abort()
    const reader = new MessageReader({
      channel: () => makeChannel({ messageGet: async () => new Promise(() => {}) }),
    })
    const aborted = await reader.readMessage('om_1', { signal: controller.signal })
    expect(aborted).toMatchObject({ ok: false, code: 'ABORTED' })

    const slow = new MessageReader({
      channel: () => makeChannel({ messageGet: async () => new Promise(() => {}) }),
    })
    const timedOut = await slow.readMessage('om_1', { timeoutMs: 10 })
    expect(timedOut).toMatchObject({ ok: false, code: 'TIMEOUT' })
  })

  it('bounds mget to 50 ids and falls back to sequential gets', async () => {
    const reader = new MessageReader({ channel: () => makeChannel({}) })
    expect(await reader.readMessages([])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect(await reader.readMessages(Array.from({ length: TOPIC_MESSAGES_MAX_LIMIT + 1 }, (_, i) => `om_${i}`)))
      .toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })

    const ids: string[] = []
    const sequential = new MessageReader({
      channel: () => makeChannel({
        messageGet: async (messageId: string) => {
          ids.push(messageId)
          return makeMessageGetResponse([makeRawMessage({ message_id: messageId, content: { text: messageId } })])
        },
      }),
    })
    const fallback = await sequential.readMessages(['om_a', 'om_b'])
    expect(fallback.ok && fallback.value.map(value => value.messageId)).toEqual(['om_a', 'om_b'])
    expect(ids).toEqual(['om_a', 'om_b'])

    const batchCalls: string[][] = []
    const batched = new MessageReader({
      channel: () => makeChannel({
        messageMget: async (messageIds) => {
          batchCalls.push([...messageIds])
          return makeMessageGetResponse(messageIds.map(messageId =>
            makeRawMessage({ message_id: messageId, content: { text: 'x' } })))
        },
      }),
    })
    expect((await batched.readMessages(['om_a', 'om_b'])).ok).toBe(true)
    expect(batchCalls).toEqual([['om_a', 'om_b']])
  })

  it('resolves one quote through message.get and keeps its merged-forward children', async () => {
    const container = makeRawMessage({ message_id: 'om_container', msg_type: 'merge_forward', content: {} })
    const child = makeRawMessage({
      message_id: 'om_child',
      msg_type: 'text',
      upper_message_id: 'om_container',
      content: { text: '子消息' },
    })
    const getCalls: string[] = []
    let mgetCalls = 0
    const reader = new MessageReader({
      channel: () => makeChannel({
        messageMget: async () => {
          mgetCalls += 1
          return makeMessageGetResponse([container])
        },
        messageGet: async (messageId: string) => {
          getCalls.push(messageId)
          return makeMessageGetResponse([container, child])
        },
      }),
    })
    const expanded = await readQuoteItems(reader, 'om_container')
    expect(expanded.ok && expanded.value.map(value => value.messageId)).toEqual(['om_container', 'om_child'])
    expect(getCalls).toEqual(['om_container'])
    // A single quote has no batch benefit: mget is not called.
    expect(mgetCalls).toBe(0)
  })

  it('lists a thread/chat page with clamped bounds and cursor', async () => {
    const params: RawMessageListParams[] = []
    const reader = new MessageReader({
      channel: () => makeChannel({
        messageList: async (input) => {
          params.push(input)
          return makeMessageListResponse([], { hasMore: true, pageToken: 'next' })
        },
      }),
    })
    await reader.listThread('omt_1', { pageSize: 999, cursor: 'cursor', order: 'oldest-first' })
    expect(params[0]).toEqual({
      container_id_type: 'thread',
      container_id: 'omt_1',
      page_size: TOPIC_MESSAGES_MAX_LIMIT,
      sort_type: 'ByCreateTimeAsc',
      page_token: 'cursor',
    })
    await reader.listChat('oc_1', { pageSize: 0 })
    expect(params[1]).toMatchObject({
      container_id_type: 'chat', container_id: 'oc_1', page_size: 1, sort_type: 'ByCreateTimeDesc',
    })
    const page = await reader.listChat('oc_1')
    expect(page.ok && page.value.pageToken).toBe('next')

    const missing = new MessageReader({ channel: () => makeChannel({}) })
    const failed = await missing.listChat('oc_1')
    expect(failed).toMatchObject({ ok: false, code: 'MESSAGE_READ_FAILED' })
  })

  it('filters route listings so another topic never leaks into a chat route', async () => {
    const threadPage = makeMessageListResponse([
      makeRawMessage({ message_id: 'om_a', chat_id: 'oc_chat', thread_id: 'omt_1', content: { text: 'a' } }),
      makeRawMessage({ message_id: 'om_b', chat_id: 'oc_chat', content: { text: 'b' } }),
      makeRawMessage({ message_id: 'om_c', chat_id: 'oc_other', thread_id: 'omt_1', content: { text: 'c' } }),
      makeRawMessage({ message_id: 'om_d', thread_id: 'omt_1', content: { text: 'd' } }),
    ])
    const channel = makeChannel({ messageList: async () => threadPage })
    const threadReader = new MessageReader({ channel: () => channel })
    const threadResult = await threadReader.listRoute({
      key: 'omt_1', kind: 'thread', chatId: 'oc_chat', chatType: 'group', senderUserId: 'u_user',
    })
    // A list read is container-scoped: foreign chat rows are dropped, while a
    // missing chat id (stub/older payload) is tolerated; the topic row stays.
    expect(threadResult.ok && threadResult.value.items.map(value => value.messageId))
      .toEqual(['om_a', 'om_b', 'om_d'])

    const chatResult = await threadReader.listRoute({
      key: 'chat:oc_chat:u_user', kind: 'chat', chatId: 'oc_chat', chatType: 'p2p', senderUserId: 'u_user',
    })
    expect(chatResult.ok && chatResult.value.items.map(value => value.messageId)).toEqual(['om_b'])
  })
})

describe('classifyReadError helpers', () => {
  it('keeps unknown errors readable and bounded', () => {
    const failure = classifyReadError(new Error('x'.repeat(500)))
    expect(failure.ok).toBe(false)
    if (!failure.ok) {
      expect(failure.code).toBe('MESSAGE_READ_FAILED')
      expect(failure.reason.length).toBeLessThan(400)
    }
    expect(classifyReadError({})).toMatchObject({ code: 'MESSAGE_READ_FAILED' })
    expect(classifyReadError(new Error('aborted'), true)).toMatchObject({ code: 'TIMEOUT' })
  })

  it('clamps integers safely', () => {
    expect(clampInt(0, 1, 50)).toBe(1)
    expect(clampInt(999, 1, 50)).toBe(50)
    expect(clampInt(Number.NaN, 2, 50)).toBe(2)
    expect(clampInt(5.9, 1, 50)).toBe(5)
  })
})

describe('no unhandled rejections on aborted reader calls', () => {
  it('swallows a late resolution after cancellation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reader = new MessageReader({
      channel: () => makeChannel({
        messageGet: async () => {
          await gate
          return makeMessageGetResponse([])
        },
      }),
    })
    const controller = new AbortController()
    const pending = reader.readMessage('om_1', { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'ABORTED' })
    release()
  })

  it('never calls the channel when already cancelled', async () => {
    const messageGet = vi.fn(async () => makeMessageGetResponse([]))
    const reader = new MessageReader({ channel: () => makeChannel({ messageGet }) })
    const controller = new AbortController()
    controller.abort()
    const result = await reader.readMessage('om_1', { signal: controller.signal })
    expect(result).toMatchObject({ ok: false, code: 'ABORTED' })
    expect(messageGet).not.toHaveBeenCalled()
  })
})
