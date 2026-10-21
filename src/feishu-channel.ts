/**
 * Thin wrapper over the official SDK's `createLarkChannel` high-level module.
 *
 * The wrapper exists to pin the exact surface the plugin uses behind one
 * interface so the unit tests can stub the official SDK wholesale (no
 * network, no creds).
 *
 * @module dsh-channels/feishu-channel
 */

import { createLarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { SCOPE_GRANTED_STATUS } from './feishu/scopes.ts'
import type { ScopeGrant } from './feishu/scopes.ts'
import type {
  BotAddedEvent,
  ChatInfo,
  LarkChannel,
  NormalizedMessage,
  SendResult,
  WSConnectionStatus,
} from '@larksuiteoapi/node-sdk'

export type { BotAddedEvent, ChatInfo, NormalizedMessage, SendResult } from '@larksuiteoapi/node-sdk'
export type FeishuConnectionStatus = WSConnectionStatus

/** Outbound payloads used by this plugin, including Buffer-backed file upload. */
export type FeishuSendInput =
  | { card: object }
  | { text: string }
  | { file: { source: string | Buffer; fileName: string } }

/**
 * One normalized card action (button click) event, as delivered by the
 * official SDK's `card.action.trigger` handler (card JSON 2.0 callback
 * behaviors). `messageId` is the card's own message id; `action.value` is the
 * callback value object the button carried (SDK contract: object values).
 */
export interface CardActionEvent {
  /** Message id of the card the action belongs to. */
  messageId: string
  chatId: string
  operator: { openId: string; userId?: string; name?: string }
  action: { value: unknown; tag: string; name?: string; option?: string }
  raw?: unknown
}

/** The minimal channel surface the plugin consumes. */
export interface FeishuChannel {
  /** Bound handler for normalized inbound messages. */
  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): () => void
  /** Bound handler for card button-callback events. */
  onCardAction(handler: (event: CardActionEvent) => void | Promise<void>): () => void
  /**
   * Bound handler for bot-added-to-chat events (`im.chat.member.bot.added_v1`).
   * Requires the app to subscribe that event; without it the plugin falls
   * back to the first denied @-mention for group information cards.
   */
  onBotAdded(handler: (event: BotAddedEvent) => void | Promise<void>): () => void
  /** Chat name/owner/member count (needs chat-info read permission). */
  getChatInfo(chatId: string): Promise<ChatInfo>
  /** Bot open_id, available after `connect()` resolves. */
  botOpenId(): string | undefined
  /**
   * The app owner's `user_id` (`application.v6.application.get`), used as the
   * administrator when none is configured. Resolves `undefined` when the owner
   * is not a tenant member; rejects with an {@link AppOwnerLookupError} when
   * the API call fails (typically a missing app-info scope). Optional so stubs
   * and older channels can omit it; absence means no owner fallback.
   */
  appOwnerUserId?(): Promise<string | undefined>
  /**
   * Scopes the app requested from the tenant and their grant state
   * (`application.v6.scope.list`). Rejects with a {@link FeishuApiError} when
   * the call fails. Optional so stubs can omit it; absence skips the check.
   */
  grantedScopes?(): Promise<readonly ScopeGrant[]>
  /** Current official-SDK WebSocket lifecycle snapshot, when initialized. */
  getConnectionStatus(): FeishuConnectionStatus | undefined
  /** Start the WebSocket long connection (resolves after the handshake). */
  connect(): Promise<void>
  /** Stop the connection. */
  disconnect(): Promise<void>
  /** Send one message (text or card) with optional reply targeting. */
  send(
    chatId: string,
    input: FeishuSendInput,
    options?: { replyTo?: string; replyInThread?: boolean },
  ): Promise<SendResult>
  /** Full-card replacement of a previously sent card message. */
  updateCard(messageId: string, card: object): Promise<void>
  /** Add an emoji reaction; resolves with the reaction id needed for removal. */
  addReaction(messageId: string, emojiType: string): Promise<string>
  /** Remove a reaction previously added by the bot. */
  removeReaction(messageId: string, reactionId: string): Promise<void>
  /** Fetch the thread id of a sent message (undefined when not a topic message). */
  threadIdOfMessage(messageId: string): Promise<string | undefined>
  /**
   * Stream one inbound message resource. Files and images share the same
   * download endpoint; only the `type` query differs. The stream is bounded
   * chunk-by-chunk so arbitrarily large files never have to fit in memory.
   */
  downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<ResourceChunkStream>
  /** P0 probe surface: raw `im.v1.message.get` (quoted / merged-forward container). */
  messageGet?(messageId: string): Promise<unknown>
  /**
   * Batch read surface: raw `im.v1.message.mget` (≤50 message ids). The SDK
   * 1.76 client does not expose this endpoint as a typed method, so the
   * adapter calls it through `Client.request`; every caller must tolerate the
   * method being absent (older channels / stubs) and fall back to `message.get`.
   */
  messageMget?(messageIds: readonly string[]): Promise<unknown>
  /** P0 probe surface: raw `im.v1.message.list` (thread / chat history). */
  messageList?(params: RawMessageListParams): Promise<unknown>
}

/** Query for the raw `im.v1.message.list` endpoint. */
export interface RawMessageListParams {
  container_id_type: 'chat' | 'thread'
  container_id: string
  page_size?: number
  page_token?: string
  sort_type?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc'
}

/** Ordered byte chunks of one inbound resource. */
export type ResourceChunkStream = AsyncIterable<Uint8Array>

/**
 * Chunk size for ranged file downloads. Feishu's message-resource endpoint
 * rejects a single response larger than 100 MB (error 234037), but honors
 * bounded Range requests, so large files are fetched in independent chunks.
 */
export const RANGE_DOWNLOAD_CHUNK_BYTES = 32 * 1024 * 1024

/** Total object size from a `Content-Range: bytes start-end/total` header. */
export function contentRangeTotal(headers: unknown): number | undefined {
  const value = headerValue(headers, 'content-range')
  if (value === undefined) return undefined
  const match = /\/(\d+)\s*$/u.exec(value)
  if (match === null) return undefined
  const total = Number(match[1])
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined
}

/** Case-insensitive header lookup over a plain object or an AxiosHeaders-like getter. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined
  const record = headers as Record<string, unknown>
  const lower = name.toLowerCase()
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== lower) continue
    const value = record[key]
    if (typeof value === 'string') return value
  }
  const get = (headers as { get?: (key: string) => unknown }).get
  if (typeof get === 'function') {
    const value = get.call(headers, name)
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** One bounded range request returning the response headers and byte stream. */
export type ResourceRangeFetcher = (range: string) => Promise<{
  headers?: unknown
  stream: AsyncIterable<Uint8Array>
}>

/**
 * Download one object through sequential bounded Range requests. The caller
 * supplies the first response's total size and a fetcher for the remaining
 * ranges; bytes are yielded as they arrive so the archive writes them
 * straight to disk.
 */
export async function* downloadResourceInRanges(
  fetchRange: ResourceRangeFetcher,
  totalBytes: number,
  chunkBytes = RANGE_DOWNLOAD_CHUNK_BYTES,
): AsyncGenerator<Uint8Array> {
  let offset = 0
  while (offset < totalBytes) {
    const end = Math.min(offset + chunkBytes, totalBytes) - 1
    const response = await fetchRange(`bytes=${offset}-${end}`)
    let received = 0
    for await (const chunk of response.stream) {
      received += chunk.length
      yield chunk
    }
    if (received === 0) {
      throw new Error(`dsh-channels: ranged download stalled at byte ${offset}/${totalBytes}`)
    }
    offset += received
  }
}

/** Owner type `2` = tenant member; `0`/`1` are Feishu itself or an ISV partner. */
const APP_OWNER_TYPE_TENANT_MEMBER = 2

/** Failed Feishu OpenAPI call, carrying the Feishu `code`/`msg` when present. */
export class FeishuApiError extends Error {
  /**
   * @param detail Feishu `code=<n> <msg>` or the transport error text.
   * @param code Feishu API error code, when the response carried one.
   */
  constructor(readonly detail: string, readonly code?: number) {
    super(`feishu api call failed: ${detail}`)
    this.name = 'FeishuApiError'
  }
}

/** Failed app-owner lookup, carrying the Feishu `code`/`msg` when present. */
export class AppOwnerLookupError extends FeishuApiError {
  /**
   * @param detail Feishu `code=<n> <msg>` or the transport error text.
   * @param code Feishu API error code, when the response carried one.
   */
  constructor(detail: string, code?: number) {
    super(detail, code)
    this.message = `app owner lookup failed: ${detail}`
    this.name = 'AppOwnerLookupError'
  }
}

/** `detail`/`code` of a thrown SDK/Axios error, preferring the Feishu error body. */
function thrownErrorFields(error: unknown): { detail: string; code?: number } {
  const data = (error as { response?: { data?: { code?: unknown; msg?: unknown } } } | undefined)?.response?.data
  const code = typeof data?.code === 'number' ? data.code : undefined
  const msg = typeof data?.msg === 'string' ? data.msg : undefined
  if (code === undefined && msg === undefined) return { detail: error instanceof Error ? error.message : String(error) }
  return { detail: [code === undefined ? undefined : `code=${code}`, msg].filter(Boolean).join(' '), code }
}

/** Normalize a thrown SDK/Axios error into an {@link AppOwnerLookupError}. */
function appOwnerLookupError(error: unknown): AppOwnerLookupError {
  if (error instanceof AppOwnerLookupError) return error
  const { detail, code } = thrownErrorFields(error)
  return new AppOwnerLookupError(detail, code)
}

export interface ChannelConnectOptions {
  appId: string
  appSecret: string
  loggerLevel: 'debug' | 'info' | 'warn' | 'error'
  requireMention: boolean
  dmMode: 'open' | 'disabled'
}

class LarkChannelAdapter implements FeishuChannel {
  private readonly channel: LarkChannel
  private readonly appId: string
  private readonly requireMention: boolean
  private readonly dmMode: 'open' | 'disabled'

  constructor(options: ChannelConnectOptions) {
    this.channel = createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: LOGGER_LEVELS[options.loggerLevel],
      // Keep the raw event body: the sender `user_id` and the top-level
      // rich-text `files` array are only recoverable from `msg.raw`.
      includeRawEvent: true,
      policy: {
        // The plugin routes mentions itself (thread routing must work without
        // mention), so the SDK policy layer stays permissive.
        requireMention: false,
        dmMode: options.dmMode === 'open' ? 'open' : 'disabled',
        respondToMentionAll: false,
      },
      safety: {
        // The SDK debounces messages per chatId and merges a burst into one
        // message carrying the LAST sender/thread/message id. In a group that
        // attributes one user's text and files to another, bypassing admission
        // and topic ownership. Flush every message on its own; per-chat
        // serialization and dedup stay in place.
        batch: { text: { delayMs: 0 } },
      },
    })
    this.appId = options.appId
    this.requireMention = options.requireMention
    this.dmMode = options.dmMode
  }

  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): () => void {
    return this.channel.on('message', message => {
      const userId = senderUserIdOf(message.raw)
      if (userId === undefined) {
        // Bots and other apps never carry a user_id; neither do external
        // users or a tenant app without the user ID scope. None of them can
        // be identified, so none of them may reach admission or routing.
        console.warn(
          '[dsh-channels] dropped message %s: sender has no user_id '
          + '(bot/app sender, external user, or the app lacks contact:user.employee_id:readonly)',
          message.messageId,
        )
        return
      }
      return handler({ ...message, senderId: userId })
    })
  }

  onCardAction(handler: (event: CardActionEvent) => void | Promise<void>): () => void {
    return this.channel.on('cardAction', handler)
  }

  onBotAdded(handler: (event: BotAddedEvent) => void | Promise<void>): () => void {
    // The SDK event handler is synchronous; the plugin's handler is
    // fire-and-forget (the service wraps it with its own catch/log).
    return this.channel.on('botAdded', event => {
      void handler(event)
    })
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    return this.channel.getChatInfo(chatId)
  }

  botOpenId(): string | undefined {
    return this.channel.botIdentity?.openId
  }

  getConnectionStatus(): FeishuConnectionStatus | undefined {
    return this.channel.getConnectionStatus()
  }

  async appOwnerUserId(): Promise<string | undefined> {
    let response
    try {
      response = await this.channel.rawClient.application.v6.application.get({
        path: { app_id: this.appId },
        params: { lang: 'zh_cn', user_id_type: 'user_id' },
      })
    } catch (error) {
      throw appOwnerLookupError(error)
    }
    if (response.code !== undefined && response.code !== 0) {
      throw new AppOwnerLookupError(`code=${response.code}${response.msg === undefined ? '' : ` ${response.msg}`}`, response.code)
    }
    const owner = response.data?.app?.owner
    if (owner?.type !== APP_OWNER_TYPE_TENANT_MEMBER) return undefined
    const userId = owner.owner_id?.trim()
    return userId === undefined || userId === '' ? undefined : userId
  }

  async grantedScopes(): Promise<readonly ScopeGrant[]> {
    let response
    try {
      response = await this.channel.rawClient.application.v6.scope.list()
    } catch (error) {
      const { detail, code } = thrownErrorFields(error)
      throw new FeishuApiError(detail, code)
    }
    if (response.code !== undefined && response.code !== 0) {
      throw new FeishuApiError(`code=${response.code}${response.msg === undefined ? '' : ` ${response.msg}`}`, response.code)
    }
    return (response.data?.scopes ?? []).map(scope => ({
      name: scope.scope_name,
      granted: scope.grant_status === SCOPE_GRANTED_STATUS,
      ...(scope.scope_type === undefined ? {} : { type: scope.scope_type }),
    }))
  }

  async connect(): Promise<void> {
    await this.channel.connect()
  }

  async disconnect(): Promise<void> {
    await this.channel.disconnect()
  }

  async send(
    chatId: string,
    input: FeishuSendInput,
    options?: { replyTo?: string; replyInThread?: boolean },
  ): Promise<SendResult> {
    return this.channel.send(chatId, input, options)
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.channel.updateCard(messageId, card)
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    return this.channel.addReaction(messageId, emojiType)
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.channel.removeReaction(messageId, reactionId)
  }

  async threadIdOfMessage(messageId: string): Promise<string | undefined> {
    const res = await this.channel.rawClient.im.v1.message.get({ path: { message_id: messageId } })
    return res?.data?.items?.[0]?.thread_id
  }

  async messageGet(messageId: string): Promise<unknown> {
    const message = this.channel.rawClient.im.v1.message as unknown as {
      get(input: { path: { message_id: string }; params: { user_id_type: 'user_id' } }): Promise<unknown>
    }
    return await message.get({ path: { message_id: messageId }, params: { user_id_type: 'user_id' } })
  }

  async messageMget(messageIds: readonly string[]): Promise<unknown> {
    // SDK 1.76 has no typed `im.v1.message.mget`; the endpoint is
    // `GET /open-apis/im/v1/messages/mget` with *repeated* `message_ids`
    // query params (comma-separated ids are rejected by Feishu with 99992354).
    // Axios would serialize an array with brackets, so the query string is
    // built explicitly inside the URL.
    if (messageIds.length === 0 || messageIds.length > 50) {
      throw new Error(`message.mget accepts 1-50 message ids (got ${messageIds.length})`)
    }
    const query = messageIds
      .map(messageId => `message_ids=${encodeURIComponent(messageId)}`)
      .join('&')
    const client = this.channel.rawClient as unknown as {
      request(input: { method: string; url: string }): Promise<unknown>
    }
    return await client.request({
      method: 'GET',
      url: `/open-apis/im/v1/messages/mget?${query}&card_msg_content_type=raw_card_content&user_id_type=user_id`,
    })
  }

  async messageList(params: RawMessageListParams): Promise<unknown> {
    const message = this.channel.rawClient.im.v1.message as unknown as {
      list(input: { params: RawMessageListParams }): Promise<unknown>
    }
    return await message.list({ params })
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<ResourceChunkStream> {
    if (type === 'image') {
      // Images are platform-capped far below the download limit; one request.
      const response = await this.rawResource(messageId, fileKey, type)
      return chunkStream(response.stream)
    }
    // Probe one byte to learn the total size without triggering the whole-file
    // size check. Feishu honors a bounded Range request even when the object
    // is larger than the API's single-response limit.
    const probe = await this.rawResource(messageId, fileKey, type, 'bytes=0-0')
    const total = contentRangeTotal(probe.headers)
    if (total === undefined) {
      // The server ignored Range and returned the whole object; use it as is.
      return chunkStream(probe.stream)
    }
    ;(probe.stream as { destroy?: () => void }).destroy?.()
    if (total === 0) {
      return {
        async *[Symbol.asyncIterator]() { /* empty resource */ },
      }
    }
    return downloadResourceInRanges(async range => {
      const response = await this.rawResource(messageId, fileKey, type, range)
      return { headers: response.headers, stream: chunkStream(response.stream) }
    }, total)
  }

  /** One message-resource GET, with an optional Range header. */
  private async rawResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    range?: string,
  ): Promise<{ headers: unknown; stream: AsyncIterable<Uint8Array | Buffer> }> {
    const response = await this.channel.rawClient.im.v1.messageResource.get(
      { params: { type }, path: { message_id: messageId, file_key: fileKey } },
      range === undefined ? undefined : { headers: { Range: range } },
    ) as unknown as { getReadableStream(): AsyncIterable<Uint8Array | Buffer>; headers?: unknown }
    return { headers: response.headers, stream: response.getReadableStream() }
  }
}

/** Wrap one Node stream as a plain byte-chunk iterable. */
function chunkStream(source: AsyncIterable<Uint8Array | Buffer>): ResourceChunkStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        yield Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : chunk
      }
    },
  }
}

/**
 * Detect the raster format from magic bytes. Feishu's resource download does
 * not hand back a media type, and DSH validates the declared type against the
 * decoded bytes, so the plugin sniffs instead of trusting the file name.
 */
export function sniffImageMediaType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg'
  if (data.length >= 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  return undefined
}

/**
 * The sender `user_id` of one raw `im.message.receive_v1` event body. The SDK
 * normalizer fills `senderId` with the open_id; the plugin identifies users by
 * the tenant-wide `user_id`, which Feishu only sends to tenant-internal apps
 * granted `contact:user.employee_id:readonly`.
 *
 * @param raw - `NormalizedMessage.raw` (requires `includeRawEvent`).
 * @returns the non-empty `user_id`, or `undefined` when the event has none.
 */
export function senderUserIdOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const sender = (raw as { sender?: { sender_id?: { user_id?: unknown } } }).sender
  const userId = sender?.sender_id?.user_id
  return typeof userId === 'string' && userId !== '' ? userId : undefined
}

const LOGGER_LEVELS: Record<ChannelConnectOptions['loggerLevel'], LoggerLevel> = {
  debug: LoggerLevel.debug,
  info: LoggerLevel.info,
  warn: LoggerLevel.warn,
  error: LoggerLevel.error,
}

/** Factory seam: tests substitute a stub adapter. */
export type ChannelFactory = (options: ChannelConnectOptions) => FeishuChannel

export const defaultChannelFactory: ChannelFactory = options => new LarkChannelAdapter(options)
