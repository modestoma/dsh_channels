/**
 * Inbound image intake: Feishu resources → durable DSH image blocks.
 *
 * A message's `resources` carry `file_key`s, not bytes. Each image is
 * downloaded through the channel, committed through the host attachment
 * service, and turned into a model-visible `ImageBlock`. Every failure path
 * degrades to text-only rather than dropping the user's message: the caption
 * still reaches the model.
 *
 * @module dsh-channels/feishu/inbound-image
 */

import type { AttachmentService, ImageMediaType } from '../host/services.ts'
import type { FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'

/** One model-visible image part (structurally a DSH `ImageBlock`). */
export interface ImageContentPart {
  type: 'image'
  attachment: unknown
  [key: string]: unknown
}

export interface ImageIntakeDeps {
  /** Whether this deployment forwards images at all. */
  enabled(): boolean
  /** Maximum images forwarded from one message. */
  maxImages(): number
  /** The live channel, or undefined before `start()` / after shutdown. */
  channel(): FeishuChannel | undefined
  /** The host attachment service, when mounted. */
  attachments(): AttachmentService | undefined
  warn(message: string, ...args: unknown[]): void
}

const KNOWN_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export class ImageIntake {
  /** Warn only once per process: a deployment without attachments is static. */
  private attachmentWarningSent = false

  constructor(private readonly deps: ImageIntakeDeps) {}

  /**
   * Resolve every image resource of one inbound message into durable blocks.
   * Returns an empty list when images are disabled, unmounted, or unavailable.
   */
  async blocksFor(msg: NormalizedMessage): Promise<ImageContentPart[]> {
    if (!this.deps.enabled()) return []
    const resources = (msg.resources ?? []).filter(resource => resource.type === 'image')
    if (resources.length === 0) return []
    const attachments = this.deps.attachments()
    if (attachments === undefined) {
      if (!this.attachmentWarningSent) {
        this.attachmentWarningSent = true
        this.deps.warn('dsh-channels: 主机未挂载 attachments 服务，飞书图片将只读取文字说明')
      }
      return []
    }
    const channel = this.deps.channel()
    if (channel === undefined) return []

    const blocks: ImageContentPart[] = []
    for (const resource of resources.slice(0, Math.max(0, this.deps.maxImages()))) {
      try {
        const downloaded = await channel.downloadResource(msg.messageId, resource.fileKey, 'image')
        const mediaType = mediaTypeOf(downloaded.mediaType)
        if (mediaType === undefined) {
          this.deps.warn(
            'dsh-channels: skipping inbound image %s of message %s: unsupported media type %s',
            resource.fileKey, msg.messageId, String(downloaded.mediaType),
          )
          continue
        }
        const [ref] = await attachments.saveImages([{
          data: downloaded.data,
          mediaType,
          ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
        }])
        if (ref === undefined) continue
        blocks.push({ type: 'image', attachment: ref })
      } catch (error) {
        // Best effort: keep the caption, drop this image.
        this.deps.warn(
          'dsh-channels: inbound image %s of message %s failed: %s',
          resource.fileKey, msg.messageId, String(error),
        )
      }
    }
    return blocks
  }
}

/** Narrow one detected type to the attachment service's accepted vocabulary. */
function mediaTypeOf(value: string | undefined): ImageMediaType | undefined {
  return value !== undefined && KNOWN_MEDIA_TYPES.includes(value) ? value as ImageMediaType : undefined
}
