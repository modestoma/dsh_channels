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
 * Two payload shapes need care because the SDK normalizer drops them:
 * rich-text (`post`) messages keep their attached files in a top-level
 * `files` array that `convertPost` ignores, and merged-forward records are
 * plain text rather than resources. Both are recovered here; the post files
 * come from the raw event, which the channel adapter asks the SDK to attach.
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

/** The SDK placeholder for a rich-text message that carried no visible text. */
const EMPTY_POST_PLACEHOLDER = '[rich text message]'

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

/** One decoded attachment recovered from the normalized message or its raw post payload. */
export interface AttachmentResource {
  readonly type: 'image' | 'file'
  readonly fileKey: string
  readonly fileName?: string
  /** Feishu folder messages cannot be downloaded through the resource API. */
  readonly folder?: boolean
}

/** One attachment that could not be archived, with a user-facing reason. */
export interface AttachmentFailure {
  readonly name: string
  readonly reason: string
}

export interface AttachmentArchiveResult {
  /** Resources durably written to the workspace. */
  saved: number
  /** Resources that failed to download, write, or are unsupported. */
  failed: number
  /** User-facing per-attachment failure notes (only when `failed > 0`). */
  failures: readonly AttachmentFailure[]
  /** True when the message carried no prompt text after removing placeholders. */
  attachmentOnly: boolean
  /** Remaining text after attachment placeholders are removed. */
  text: string
}

/** One file attached to a rich-text (`post`) message. */
export interface PostAttachedFile {
  readonly fileKey: string
  readonly fileName?: string
  readonly folder?: boolean
}

/**
 * Every attachment payload of one message, merging SDK-normalized resources
 * with files the `post` converter dropped.
 */
export function attachmentResources(msg: NormalizedMessage): AttachmentResource[] {
  const resources: AttachmentResource[] = (msg.resources ?? [])
    .filter(resource => resource.type === 'image' || resource.type === 'file')
    .map(resource => ({
      type: resource.type === 'file' ? 'file' : 'image',
      fileKey: resource.fileKey,
      ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
    }))
  const seen = new Set(resources.map(resource => resource.fileKey))
  for (const file of postAttachedFiles(msg.rawContentType, msg.raw)) {
    if (seen.has(file.fileKey)) continue
    seen.add(file.fileKey)
    resources.push({ type: 'file', ...file })
  }
  return resources
}

/** Whether one message may carry an attachment payload worth archiving. */
export function hasAttachmentPayload(msg: NormalizedMessage): boolean {
  if (msg.rawContentType === 'merge_forward') return true
  if (msg.rawContentType === 'post') return true
  return attachmentResources(msg).length > 0
}

/**
 * Recover the files a rich-text message attached.
 *
 * Feishu serializes a post with text and files as `{ title, content, files }`.
 * The SDK's `convertPost` walks `content` elements only, so every entry of
 * `files` is lost from `NormalizedMessage.resources`; the raw event (enabled by
 * `includeRawEvent`) still carries it. Locale-wrapped bodies are searched one
 * level deep for the same shape.
 */
export function postAttachedFiles(rawContentType: string, raw: unknown): PostAttachedFile[] {
  if (rawContentType !== 'post' || raw === null || raw === undefined) return []
  const message = (raw as { message?: { content?: unknown } }).message
  if (message === undefined) return []
  const content = typeof message.content === 'string' ? safeJson(message.content) : message.content
  if (content === undefined) return []
  const entries = collectFileEntries(content, 0)
  const files: PostAttachedFile[] = []
  for (const entry of entries) {
    const fileKey = typeof entry.file_key === 'string' && entry.file_key !== '' ? entry.file_key : undefined
    if (fileKey === undefined) continue
    files.push({
      fileKey,
      ...(typeof entry.file_name === 'string' && entry.file_name !== '' ? { fileName: entry.file_name } : {}),
      ...(entry.is_folder === true ? { folder: true } : {}),
    })
  }
  return files
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Find every `files` array in a post body (flat or locale-wrapped), depth-bounded. */
function collectFileEntries(node: unknown, depth: number): Array<Record<string, unknown>> {
  if (depth > 3 || node === null || typeof node !== 'object' || Array.isArray(node)) return []
  const record = node as Record<string, unknown>
  const files = record.files
  if (Array.isArray(files)) {
    return files.filter(
      (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    )
  }
  const out: Array<Record<string, unknown>> = []
  for (const value of Object.values(record)) out.push(...collectFileEntries(value, depth + 1))
  return out
}

export class AttachmentIntake {
  constructor(private readonly deps: AttachmentIntakeDeps) {}

  /**
   * Archive every image/file resource and merged-forward record of one
   * inbound message. Failures are contained per attachment; the method never
   * throws and always reports the remaining prompt text.
   */
  async archive(msg: NormalizedMessage, workspacePath: string): Promise<AttachmentArchiveResult> {
    const resources = attachmentResources(msg)
    const forwarded = msg.rawContentType === 'merge_forward'
    if (resources.length === 0 && !forwarded) {
      return { saved: 0, failed: 0, failures: [], attachmentOnly: false, text: msg.content ?? '' }
    }

    const stripped = stripAttachmentPlaceholders(msg.content ?? '', forwarded)
    const remainingText = stripped === EMPTY_POST_PLACEHOLDER ? '' : stripped
    const result = (
      saved: number,
      failures: readonly AttachmentFailure[],
    ): AttachmentArchiveResult => ({
      saved,
      failed: failures.length,
      failures,
      attachmentOnly: remainingText === '',
      text: remainingText,
    })

    if (!this.deps.enabled()) return result(0, [])

    const channel = this.deps.channel()
    if (channel === undefined) {
      return result(0, resources.map(resource => ({
        name: resourceName(resource),
        reason: '飞书连接未运行，附件未保存',
      })))
    }

    const dir = path.join(workspacePath, ATTACHMENTS_DIR)
    let saved = 0
    const failures: AttachmentFailure[] = []
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      this.deps.warn('dsh-channels: creating attachments directory %s failed: %s', dir, String(error))
      return result(0, resources.map(resource => ({
        name: resourceName(resource),
        reason: `无法创建工作区附件目录：${describeFailure(error)}`,
      })))
    }

    for (const resource of resources) {
      const name = resourceName(resource)
      if (resource.folder === true) {
        failures.push({ name, reason: '飞书文件夹消息暂不支持下载' })
        continue
      }
      try {
        await this.saveResource(msg, resource, dir)
        saved += 1
      } catch (error) {
        failures.push({ name, reason: describeFailure(error) })
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
        failures.push({ name: '会话记录', reason: describeFailure(error) })
        this.deps.warn(
          'dsh-channels: archiving forwarded record of message %s failed: %s',
          msg.messageId, String(error),
        )
      }
    }

    if (saved > 0) {
      await channel.addReaction(msg.messageId, 'DONE').catch(() => undefined)
    } else if (failures.length > 0) {
      await channel.addReaction(msg.messageId, 'No').catch(() => undefined)
    }

    return result(saved, failures)
  }

  /** Stream one image/file resource to disk, then publish it under a stable name. */
  private async saveResource(
    msg: NormalizedMessage,
    resource: AttachmentResource,
    dir: string,
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
        ? `image${await sniffExtension(temporary)}`
        : 'file.bin')
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
      throw new Error('会话记录为空（机器人可能缺少源消息的读取权限）')
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

/** User-facing name for one attachment. */
function resourceName(resource: AttachmentResource): string {
  if (resource.fileName !== undefined && resource.fileName !== '') return resource.fileName
  return resource.type === 'image' ? '图片' : '文件'
}

/**
 * Turn a download/write failure into a short user-facing reason. Feishu's
 * message-resource API refuses files above 100 MB, which is the common case
 * for a 400 on an otherwise valid file.
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/status code 400|bad request/iu.test(message)) {
    return '飞书下载接口拒绝请求（常见原因：文件超过 100 MB 下载上限）'
  }
  if (/status code 403|forbidden/iu.test(message)) return '飞书下载接口无权限'
  return message
}

/** Truncate a UTF-8 string on a character boundary. */
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
