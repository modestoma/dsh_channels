/**
 * Thin wrapper over the official SDK's `createLarkChannel` high-level module.
 *
 * The wrapper exists for two reasons:
 *  1. It pins the exact surface the plugin uses behind one interface so the
 *     unit tests can stub the official SDK wholesale (no network, no creds).
 *  2. It owns the one-shot chevron icon upload used by the fold-panel header.
 *
 * @module dsh-channels/feishu-channel
 */

import { createLarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, NormalizedMessage, SendResult } from '@larksuiteoapi/node-sdk'
import { CHEVRON_DOWN_PNG_BASE64 } from './cards.ts'

export type { NormalizedMessage, SendResult } from '@larksuiteoapi/node-sdk'

/** The minimal channel surface the plugin consumes. */
export interface FeishuChannel {
  /** Bound handler for normalized inbound messages. */
  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): () => void
  /** Bot open_id, available after `connect()` resolves. */
  botOpenId(): string | undefined
  /** Start the WebSocket long connection (resolves after the handshake). */
  connect(): Promise<void>
  /** Stop the connection. */
  disconnect(): Promise<void>
  /** Send one message (text or card) with optional reply targeting. */
  send(
    chatId: string,
    input: { card: object } | { text: string },
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
  /** Upload one image (message-type) and return its image key. */
  uploadImage(buffer: Buffer): Promise<{ imageKey: string }>
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

  botOpenId(): string | undefined {
    return this.channel.botIdentity?.openId
  }

  async connect(): Promise<void> {
    await this.channel.connect()
  }

  async disconnect(): Promise<void> {
    await this.channel.disconnect()
  }

  async send(
    chatId: string,
    input: { card: object } | { text: string },
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

  async uploadImage(buffer: Buffer): Promise<{ imageKey: string }> {
    const res = await this.channel.rawClient.im.v1.image.create({
      data: { image_type: 'message', image: buffer },
    })
    const imageKey = res?.image_key
    if (imageKey === undefined || imageKey === null) {
      throw new Error('feishu image upload returned no image_key')
    }
    return { imageKey }
  }
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

export { CHEVRON_DOWN_PNG_BASE64 }
