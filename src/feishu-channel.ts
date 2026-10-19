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

export interface ChannelConnectOptions {
  appId: string
  appSecret: string
  loggerLevel: 'debug' | 'info' | 'warn' | 'error'
  requireMention: boolean
  dmMode: 'open' | 'disabled'
}

class LarkChannelAdapter implements FeishuChannel {
  private readonly channel: LarkChannel
  private readonly requireMention: boolean
  private readonly dmMode: 'open' | 'disabled'

  constructor(options: ChannelConnectOptions) {
    this.channel = createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: LOGGER_LEVELS[options.loggerLevel],
      // Keep the raw event body: rich-text messages attach files in a
      // top-level `files` array the SDK normalizer drops, so the attachment
      // intake recovers them from `msg.raw` instead.
      includeRawEvent: true,
      policy: {
        // The plugin routes mentions itself (thread routing must work without
        // mention), so the SDK policy layer stays permissive.
        requireMention: false,
        dmMode: options.dmMode === 'open' ? 'open' : 'disabled',
        respondToMentionAll: false,
      },
    })
    this.requireMention = options.requireMention
    this.dmMode = options.dmMode
  }

  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): () => void {
    return this.channel.on('message', handler)
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

const LOGGER_LEVELS: Record<ChannelConnectOptions['loggerLevel'], LoggerLevel> = {
  debug: LoggerLevel.debug,
  info: LoggerLevel.info,
  warn: LoggerLevel.warn,
  error: LoggerLevel.error,
}

/** Factory seam: tests substitute a stub adapter. */
export type ChannelFactory = (options: ChannelConnectOptions) => FeishuChannel

export const defaultChannelFactory: ChannelFactory = options => new LarkChannelAdapter(options)
