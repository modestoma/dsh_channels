/**
 * Inbound attachment archival: Feishu image/file resources and merged-forward
 * chat records are written verbatim below `<workspace>/attachments/`.
 *
 * Nothing is forwarded to the model. The Agent's own filesystem tools read
 * whichever attachment the conversation needs, so an attachment message costs
 * no model request at all and unreferenced files never enter the context.
 * Files are streamed straight to disk: there is no plugin-side size cap, so a
 * large upload must not be collected in memory.
 *
 * @module dsh-channels/feishu/inbound-attachments
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FeishuChannel, NormalizedMessage } from '../feishu-channel.ts'
import { sniffImageMediaType } from '../feishu-channel.ts'

/** Workspace subdirectory that holds every archived attachment. */
export const ATTACHMENTS_DIR = 'attachments'

/** Placeholders the SDK leaves in normalized content for attachment payloads. */
const IMAGE_PLACEHOLDER = /!\[image\]\([^)]*\)/gu
const FILE_PLACEHOLDER = /<file[^>]*\/>/gu
const FORWARDED_PLACEHOLDER = /<forwarded_messages(?:\/>|>[\s\S]*?<\/forwarded_messages>)/gu
/** An expanded record always starts with this wrapper; a bare empty one means the fetch failed. */
const EMPTY_FORWARDED = '<forwarded_messages/>'

export interface AttachmentIntakeDeps {
  /** Whether this deployment archives inbound attachments at all. */
  enabled(): boolean
  /** Live channel; undefined after shutdown. */
  channel(): FeishuChannel | undefined
  /** Structured warning sink (never throws). */
  warn(message: string, ...args: unknown[]): void
  /** Deterministic clock seam for file-name prefixes. */
  now?(): number
}

export interface AttachmentArchiveResult {
  /** Resources durably written to the workspace. */
  saved: number
  /** Resources that failed to download or write. */
  failed: number
  /** True when the message carried no prompt text after removing placeholders. */
  attachmentOnly: boolean
  /** Remaining text after attachment placeholders are removed. */
  text: string
}

/** One resource this module knows how to archive. */
type ArchivableResource = NonNullable<NormalizedMessage['resources']>[number]

export class AttachmentIntake {
  constructor(private readonly deps: AttachmentIntakeDeps) {}

  /**
   * Archive every image/file resource and merged-forward record of one
   * inbound message. Failures are contained per attachment; the method never
   * throws and always reports the remaining prompt text.
   */
  async archive(msg: NormalizedMessage, workspacePath: string): Promise<AttachmentArchiveResult> {
    const resources = (msg.resources ?? []).filter(
      resource => resource.type === 'image' || resource.type === 'file',
    )
    const forwarded = msg.rawContentType === 'merge_forward'
    if (resources.length === 0 && !forwarded) {
      return { saved: 0, failed: 0, attachmentOnly: false, text: msg.content ?? '' }
    }

    const remainingText = stripAttachmentPlaceholders(msg.content ?? '', forwarded)
    if (!this.deps.enabled()) {
      return {
        saved: 0,
        failed: 0,
        attachmentOnly: remainingText === '' && forwarded,
        text: remainingText,
      }
    }

    const channel = this.deps.channel()
    if (channel === undefined) {
      return {
        saved: 0,
        failed: resources.length + (forwarded ? 1 : 0),
        attachmentOnly: remainingText === '',
        text: remainingText,
      }
    }

    const dir = path.join(workspacePath, ATTACHMENTS_DIR)
    let saved = 0
    let failed = 0
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      this.deps.warn('dsh-channels: creating attachments directory %s failed: %s', dir, String(error))
      return {
        saved: 0,
        failed: resources.length + (forwarded ? 1 : 0),
        attachmentOnly: remainingText === '',
        text: remainingText,
      }
    }

    for (const [index, resource] of resources.entries()) {
      try {
        await this.saveResource(msg, resource, dir, index)
        saved += 1
      } catch (error) {
        failed += 1
        this.deps.warn(
          'dsh-channels: archiving resource %s of message %s failed: %s',
          resource.fileKey, msg.messageId, String(error),
        )
      }
    }

    if (forwarded) {
      try {
        await this.saveForwardedRecord(msg, dir)
        saved += 1
      } catch (error) {
        failed += 1
        this.deps.warn(
          'dsh-channels: archiving forwarded record of message %s failed: %s',
          msg.messageId, String(error),
        )
      }
    }

    if (saved > 0) {
      await channel.addReaction(msg.messageId, 'DONE').catch(() => undefined)
    } else if (failed > 0) {
      await channel.addReaction(msg.messageId, 'No').catch(() => undefined)
    }

    return { saved, failed, attachmentOnly: remainingText === '', text: remainingText }
  }

  /** Stream one image/file resource to disk, then publish it under a stable name. */
  private async saveResource(
    msg: NormalizedMessage,
    resource: ArchivableResource,
    dir: string,
    index: number,
  ): Promise<void> {
    const channel = this.deps.channel()
    if (channel === undefined) throw new Error('channel is not running')
    const stream = await channel.downloadResource(
      msg.messageId,
      resource.fileKey,
      resource.type === 'file' ? 'file' : 'image',
    )
    const temporary = path.join(dir, `.tmp-${randomUUID()}`)
    try {
      await pipeline(Readable.from(stream), createWriteStream(temporary, { mode: 0o600 }))
      const original = sanitizeFileName(resource.fileName)
      const base = original ?? (resource.type === 'image'
        ? `image-${index + 1}${await sniffExtension(temporary)}`
        : `file-${index + 1}.bin`)
      const finalName = await uniqueName(dir, `${this.stamp()}-${base}`)
      await rename(temporary, path.join(dir, finalName))
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Persist one expanded merged-forward record as UTF-8 text. The content is
   * already plain text (`<forwarded_messages>…`), so no parsing or conversion
   * happens here — the Agent reads the file when the conversation needs it.
   */
  private async saveForwardedRecord(msg: NormalizedMessage, dir: string): Promise<void> {
    const content = msg.content ?? ''
    if (content.trim() === '' || content.trim() === EMPTY_FORWARDED) {
      throw new Error('forwarded record is empty (the bot may lack read permission on the source messages)')
    }
    const name = await uniqueName(dir, `${this.stamp()}-forwarded-record.txt`)
    await writeFile(path.join(dir, name), `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  private stamp(): string {
    return compactTimestamp(this.deps.now?.() ?? Date.now())
  }
}

/** Remove attachment placeholders while keeping ordinary prompt text. */
export function stripAttachmentPlaceholders(content: string, forwarded: boolean): string {
  let text = content.replace(IMAGE_PLACEHOLDER, ' ').replace(FILE_PLACEHOLDER, ' ')
  if (forwarded) text = text.replace(FORWARDED_PLACEHOLDER, ' ')
  return text.replace(/[ \t]+/gu, ' ').replace(/\s*\n\s*/gu, '\n').trim()
}

/** `YYYYMMDD-HHmmss`, UTC, filesystem- and sort-friendly. */
export function compactTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '').replace('T', '-')
}

/** Strip directories, control characters, and reserved path characters from a display name. */
export function sanitizeFileName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const base = raw.split(/[\\/]/u).pop() ?? raw
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"\\|?*]/gu, '_')
    .replace(/^[.\s]+/u, '')
    .replace(/[.\s]+$/u, '')
  if (cleaned === '') return undefined
  return truncateUtf8(cleaned, 120)
}

/** True when the given text already names a filesystem-safe basename. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let out = ''
  for (const char of value) {
    if (Buffer.byteLength(out + char) > maxBytes) break
    out += char
  }
  return out
}

/** Pick a non-colliding destination name inside one directory. */
async function uniqueName(dir: string, candidate: string): Promise<string> {
  const parsed = path.parse(candidate)
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? candidate : `${parsed.name}-${attempt}${parsed.ext}`
    try {
      await stat(path.join(dir, name))
    } catch {
      return name
    }
  }
  throw new Error('no free attachment file name after 100 attempts')
}

/** Detect an image extension from the first bytes of a staged file. */
async function sniffExtension(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const type = sniffImageMediaType(new Uint8Array(buffer.subarray(0, bytesRead)))
    switch (type) {
      case 'image/png': return '.png'
      case 'image/jpeg': return '.jpg'
      case 'image/webp': return '.webp'
      case 'image/gif': return '.gif'
      default: return '.bin'
    }
  } catch {
    return '.bin'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
