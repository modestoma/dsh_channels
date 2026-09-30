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
import type { LarkChannel, NormalizedMessage, SendResult, WSConnectionStatus } from '@larksuiteoapi/node-sdk'

export type { NormalizedMessage, SendResult } from '@larksuiteoapi/node-sdk'
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
  /** Download one inbound message resource (image bytes + sniffed media type). */
  downloadResource(messageId: string, fileKey: string, type: 'image'): Promise<DownloadedResource>
}

/** Bytes of one inbound Feishu resource plus their detected media type. */
export interface DownloadedResource {
  data: Uint8Array
  /** `image/png`-style type; undefined when the bytes match no known format. */
  mediaType?: string
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

  async downloadResource(messageId: string, fileKey: string, type: 'image'): Promise<DownloadedResource> {
    const response = await this.channel.rawClient.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    }) as unknown as { getReadableStream(): AsyncIterable<Uint8Array | Buffer> }
    const chunks: Buffer[] = []
    for await (const chunk of response.getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const data = new Uint8Array(Buffer.concat(chunks))
    return { data, mediaType: sniffImageMediaType(data) }
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
