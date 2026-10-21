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
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FeishuChannel, NormalizedMessage, ResourceChunkStream } from '../feishu-channel.ts'
import { sniffImageMediaType } from '../feishu-channel.ts'
import type { ImageBlock } from '../host/attachments.ts'

/** Workspace subdirectory that holds every archived attachment. */
export const ATTACHMENTS_DIR = 'attachments'

/** `<workspace>/attachments` directory of one topic workspace. */
export function attachmentsDir(workspacePath: string): string {
  return path.join(workspacePath, ATTACHMENTS_DIR)
}

/**
 * Move every staged attachment into one topic workspace. Staging holds files
 * received before their topic (and therefore its workspace) existed; they
 * belong to the first Session created for that topic. Best-effort per file.
 *
 * @returns how many files were adopted.
 */
export async function adoptStagedAttachments(stagingDir: string, workspacePath: string): Promise<number> {
  let entries: Array<{ name: string; isFile(): boolean }>
  try {
    entries = await readdir(stagingDir, { withFileTypes: true })
  } catch {
    return 0
  }
  const files = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.'))
  if (files.length === 0) return 0
  const target = attachmentsDir(workspacePath)
  try {
    await mkdir(target, { recursive: true })
  } catch {
    return 0
  }
  let adopted = 0
  for (const entry of files) {
    const destination = await uniqueName(target, entry.name)
    try {
      await rename(path.join(stagingDir, entry.name), path.join(target, destination))
      adopted += 1
    } catch {
      // Leave the staged file for the next attempt; never block the turn.
    }
  }
  return adopted
}

/**
 * The SDK placeholder for a rich-text message that carried no visible text.
 * Exported so the native storage layer classifies attachment-only messages
 * with exactly the same rule as the workspace archive.
 */
export const EMPTY_POST_PLACEHOLDER = '[rich text message]'

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

/** One inbound attachment payload classified without downloading a byte. */
export interface InboundAttachmentState {
  /** Whether the message carries an attachment payload (resources or a merged-forward record). */
  readonly hasPayload: boolean
  /** Decoded image/file resources, including `post` `files[]`, in message order. */
  readonly resources: readonly AttachmentResource[]
  /** Whether this is a `merge_forward` message (its record is plain text, not a resource). */
  readonly forwarded: boolean
  /** Prompt text left after removing attachment placeholders. */
  readonly text: string
  /** No prompt text remains once the placeholders are stripped (attachment-only message). */
  readonly attachmentOnly: boolean
}

/**
 * Classify one inbound message's attachment payload without downloading
 * anything or touching state outside the message itself.
 *
 * The rules are exactly the ones the archive intake and the native storage
 * layer already use, so admission can decide "silent register" versus "start a
 * turn" before any Session exists: no resources and no merged-forward record
 * means "no payload" and the raw content is the prompt; otherwise placeholders
 * are stripped and an empty remainder marks an attachment-only message.
 */
export function inboundAttachmentState(msg: NormalizedMessage): InboundAttachmentState {
  const resources = attachmentResources(msg)
  const forwarded = msg.rawContentType === 'merge_forward'
  if (resources.length === 0 && !forwarded) {
    return {
      hasPayload: false,
      resources: [],
      forwarded: false,
      text: msg.content ?? '',
      attachmentOnly: false,
    }
  }
  const stripped = stripAttachmentPlaceholders(msg.content ?? '', forwarded)
  const text = stripped === EMPTY_POST_PLACEHOLDER ? '' : stripped
  return { hasPayload: true, resources, forwarded, text, attachmentOnly: text === '' }
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
  async archive(msg: NormalizedMessage, directory: string): Promise<AttachmentArchiveResult> {
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

    const dir = directory
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
    return '飞书下载接口拒绝请求（文件可能已过期、已被删除或暂不可下载）'
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

// ---- Trigger-message image prefetch -------------------------------------

/** Outcome of storing one prefetched image in the DSH native attachment library. */
export type ImagePrefetchSaveResult =
  | { readonly ok: true; readonly block: ImageBlock }
  | { readonly ok: false; readonly reason: string }

/** Dependency-injected input of one trigger-message image prefetch. */
export interface ImagePrefetchInput {
  /** Triggering message; its id addresses every resource download. */
  readonly msg: NormalizedMessage
  /** Candidate resources in prompt order (non-image and folder entries are skipped). */
  readonly resources: readonly AttachmentResource[]
  /** Live Feishu channel; undefined means the connection is not running. */
  readonly channel: FeishuChannel | undefined
  /**
   * Persist one downloaded image in the native attachment library. Failures
   * are returned as values; a thrown error is contained per image as well.
   */
  saveImage(bytes: Uint8Array, name?: string): Promise<ImagePrefetchSaveResult>
  /** Per-image byte cap. */
  readonly maxImageBytes: number
  /** Total byte budget of this whole prefetch. */
  readonly maxTotalBytes: number
  /** Short whole-prefetch deadline in milliseconds (non-positive = already expired). */
  readonly timeoutMs: number
  /** Structured warning sink (optional; never allowed to break the prefetch). */
  warn?(message: string, ...args: unknown[]): void
}

/** Result of one trigger-message image prefetch; failures are values. */
export interface PrefetchedImages {
  /** Successfully stored image blocks, in input order (skipped entries excluded). */
  readonly blocks: readonly ImageBlock[]
  /** `file_key`s whose images were stored (the manifest must omit these). */
  readonly loadedFileKeys: ReadonlySet<string>
  /** One readable reason per image that was not stored, in processing order. */
  readonly failures: readonly AttachmentFailure[]
}

/** Fixed reason for prefetch failures caused by a disconnected channel. */
const PREFETCH_CHANNEL_UNAVAILABLE_REASON = '飞书连接未运行'
/** Whole-prefetch timeout reason used when an in-flight image was interrupted. */
const PREFETCH_TIMEOUT_REASON = '图片预取超时'
/** Timeout reason for images that were never attempted after the deadline. */
const PREFETCH_TIMEOUT_UNPROCESSED_REASON = '图片预取超时，未处理'
/** Reason recorded for images after the total byte budget was exhausted. */
const PREFETCH_TOTAL_LIMIT_SKIP_REASON = '超过预取总字节上限，已跳过预取'
/** Cap for one readable prefetch failure reason (prompt/tool-safe). */
const PREFETCH_MAX_REASON_TEXT = 500

function prefetchTimeoutReason(timeoutMs: number): string {
  return `${PREFETCH_TIMEOUT_REASON}（超过 ${timeoutMs} 毫秒）`
}

function imageLimitReason(readBytes: number, cap: number): string {
  return `图片超过预取大小上限（已读取 ${readBytes} 字节，上限 ${cap} 字节）`
}

function totalLimitReason(readBytes: number, cap: number): string {
  return `超过预取总字节上限（已读取 ${readBytes} 字节，上限 ${cap} 字节）`
}

/**
 * Prefetch the images of one triggering message into the native attachment
 * library before the first model turn.
 *
 * Images are downloaded strictly in order, so the returned blocks keep the
 * message order. Every failure (channel unavailable, size cap, total budget,
 * timeout, download, storage) is contained per image and reported as a value;
 * this function never throws and never mutates its input. The whole prefetch
 * shares one short deadline: on expiry the already-stored blocks are kept and
 * the current plus all unprocessed images are reported as timeouts, so a slow
 * download can never block the turn for long.
 *
 * Known limitation: the channel byte stream cannot be cancelled, so a stalled
 * download is abandoned rather than aborted at the transport layer. The
 * deadline aborts the collection loop between chunks, which keeps an
 * abandoned download from buffering further bytes in this process. Likewise a
 * `saveImage` call that is already in flight cannot be recalled; the deadline
 * only guarantees that the prefetch returns without waiting for it.
 */
export async function prefetchImageAttachments(input: ImagePrefetchInput): Promise<PrefetchedImages> {
  const images = input.resources.filter(resource => resource.type === 'image' && resource.folder !== true)
  const blocks: ImageBlock[] = []
  const loadedFileKeys = new Set<string>()
  const failures: AttachmentFailure[] = []
  const result = (): PrefetchedImages => ({ blocks, loadedFileKeys, failures })
  if (images.length === 0) return result()

  const channel = input.channel
  if (channel === undefined) {
    for (const resource of images) {
      failures.push({ name: resourceName(resource), reason: PREFETCH_CHANNEL_UNAVAILABLE_REASON })
    }
    return result()
  }

  const deadline = createPrefetchDeadline(input.timeoutMs)
  try {
    await prefetchImagesSequentially(input, channel, images, deadline, blocks, loadedFileKeys, failures)
  } catch (error) {
    // Defensive containment: the loop classifies every expected failure, but
    // this function must never throw into the admission path.
    const detail = thrownValueText(error)
    failures.push({ name: '图片', reason: boundedPrefetchReason(`图片预取异常：${detail}`) })
    safeWarn(input, 'dsh-channels: prefetching images of message %s failed unexpectedly: %s', input.msg.messageId, detail)
  } finally {
    deadline.dispose()
  }
  return result()
}

/** Sequential image loop: order, stop-on-cap, and the shared deadline live here. */
async function prefetchImagesSequentially(
  input: ImagePrefetchInput,
  channel: FeishuChannel,
  images: readonly AttachmentResource[],
  deadline: PrefetchDeadline,
  blocks: ImageBlock[],
  loadedFileKeys: Set<string>,
  failures: AttachmentFailure[],
): Promise<void> {
  let loadedBytes = 0
  let stoppedReason: string | undefined
  for (const resource of images) {
    const name = resourceName(resource)
    if (stoppedReason !== undefined) {
      failures.push({ name, reason: stoppedReason })
      continue
    }
    if (deadline.expired) {
      failures.push({ name, reason: PREFETCH_TIMEOUT_UNPROCESSED_REASON })
      continue
    }
    if (loadedBytes >= input.maxTotalBytes) {
      stoppedReason = PREFETCH_TOTAL_LIMIT_SKIP_REASON
      failures.push({ name, reason: totalLimitReason(loadedBytes, input.maxTotalBytes) })
      continue
    }

    const outcome = await deadline.race(
      prefetchOneImage(input, channel, resource, deadline.signal, loadedBytes),
    )
    if (outcome === PREFETCH_TIMEOUT) {
      failures.push({ name, reason: prefetchTimeoutReason(input.timeoutMs) })
      continue
    }
    if (outcome.kind === 'stopped') {
      stoppedReason = outcome.skipReason
      failures.push({ name, reason: outcome.reason })
      continue
    }
    // Downloaded bytes count against the budget even when the native store
    // refuses the image: the budget bounds what this prefetch transferred.
    loadedBytes += outcome.bytes
    if (outcome.kind === 'failed') {
      failures.push({ name, reason: outcome.reason })
      continue
    }
    blocks.push(outcome.block)
    loadedFileKeys.add(resource.fileKey)
  }
}

/** One image's download + bounded collection + storage; never rejects. */
async function prefetchOneImage(
  input: ImagePrefetchInput,
  channel: FeishuChannel,
  resource: AttachmentResource,
  signal: AbortSignal,
  usedBytes: number,
): Promise<PrefetchOutcome> {
  let stream: ResourceChunkStream
  try {
    stream = await channel.downloadResource(input.msg.messageId, resource.fileKey, 'image')
  } catch (error) {
    const reason = downloadFailureReason(error)
    safeWarn(
      input, 'dsh-channels: prefetching image %s of message %s failed: %s',
      resource.fileKey, input.msg.messageId, reason,
    )
    return { kind: 'failed', reason, bytes: 0 }
  }

  const collected = await collectPrefetchBytes(stream, signal, {
    maxImageBytes: input.maxImageBytes,
    maxTotalBytes: input.maxTotalBytes,
    usedBytes,
  })
  if (collected.kind !== 'ok') {
    if (collected.kind === 'failed') {
      safeWarn(
        input, 'dsh-channels: prefetching image %s of message %s failed: %s',
        resource.fileKey, input.msg.messageId, collected.reason,
      )
    }
    return collected
  }
  // The deadline may have expired while the last chunk arrived: do not store
  // an image the caller already reported as timed out.
  if (signal.aborted) {
    return { kind: 'failed', reason: prefetchTimeoutReason(input.timeoutMs), bytes: collected.bytes }
  }

  let saved: ImagePrefetchSaveResult
  try {
    saved = await input.saveImage(collected.data, resource.fileName)
  } catch (error) {
    const detail = thrownValueText(error)
    const reason = boundedPrefetchReason(`图片入库失败：${detail}`)
    safeWarn(
      input, 'dsh-channels: storing prefetched image %s of message %s failed: %s',
      resource.fileKey, input.msg.messageId, detail,
    )
    return { kind: 'failed', reason, bytes: collected.bytes }
  }
  if (!saved.ok) {
    safeWarn(
      input, 'dsh-channels: storing prefetched image %s of message %s failed: %s',
      resource.fileKey, input.msg.messageId, saved.reason,
    )
    return { kind: 'failed', reason: saved.reason, bytes: collected.bytes }
  }
  return { kind: 'saved', block: saved.block, bytes: collected.bytes }
}

/** Result of reading one image stream under both byte caps. */
type PrefetchOutcome =
  | { readonly kind: 'saved'; readonly block: ImageBlock; readonly bytes: number }
  | { readonly kind: 'failed'; readonly reason: string; readonly bytes: number }
  | { readonly kind: 'stopped'; readonly reason: string; readonly skipReason: string }

/** Byte caps applied while one image is collected. */
interface PrefetchByteCaps {
  readonly maxImageBytes: number
  readonly maxTotalBytes: number
  /** Bytes already counted against the total budget. */
  readonly usedBytes: number
}

/**
 * Read one image stream completely under the single-image cap and the total
 * budget. A single-image violation only refuses that image (later images may
 * be small enough and are still tried); exhausting the total budget stops the
 * whole prefetch and carries the reason for the remaining images.
 */
async function collectPrefetchBytes(
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  caps: PrefetchByteCaps,
): Promise<
  | { readonly kind: 'ok'; readonly data: Uint8Array; readonly bytes: number }
  | { readonly kind: 'failed'; readonly reason: string; readonly bytes: number }
  | { readonly kind: 'stopped'; readonly reason: string; readonly skipReason: string }
> {
  const chunks: Uint8Array[] = []
  let ownBytes = 0
  try {
    for await (const chunk of stream) {
      if (signal.aborted) {
        return { kind: 'failed', reason: PREFETCH_TIMEOUT_REASON, bytes: ownBytes }
      }
      ownBytes += chunk.byteLength
      if (ownBytes > caps.maxImageBytes) {
        return { kind: 'failed', reason: imageLimitReason(ownBytes, caps.maxImageBytes), bytes: ownBytes }
      }
      if (caps.usedBytes + ownBytes > caps.maxTotalBytes) {
        return {
          kind: 'stopped',
          reason: totalLimitReason(caps.usedBytes + ownBytes, caps.maxTotalBytes),
          skipReason: PREFETCH_TOTAL_LIMIT_SKIP_REASON,
        }
      }
      chunks.push(chunk)
    }
  } catch (error) {
    return { kind: 'failed', reason: downloadFailureReason(error), bytes: ownBytes }
  }
  const data = new Uint8Array(ownBytes)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { kind: 'ok', data, bytes: ownBytes }
}

/** Marker resolved by the deadline promise; never surfaces to callers. */
const PREFETCH_TIMEOUT = Symbol('dsh-channels-prefetch-timeout')

/** One shared deadline for a whole prefetch (see {@link createPrefetchDeadline}). */
interface PrefetchDeadline {
  readonly expired: boolean
  /** Aborted when the deadline expires; the collection loop checks it per chunk. */
  readonly signal: AbortSignal
  /** Resolve with the work value, or the timeout marker once the deadline expires. */
  race<T>(work: Promise<T>): Promise<T | typeof PREFETCH_TIMEOUT>
  /** Clear the underlying timer; safe to call more than once. */
  dispose(): void
}

/**
 * One shared deadline for a whole prefetch. A non-positive (or non-finite)
 * `timeoutMs` means "already expired": no timer is armed and every race
 * resolves immediately. The timer is always cleared by `dispose()`, so a
 * completed prefetch leaves no dangling timer behind.
 */
function createPrefetchDeadline(timeoutMs: number): PrefetchDeadline {
  const alreadyExpired = !Number.isFinite(timeoutMs) || timeoutMs <= 0
  let expired = alreadyExpired
  const controller = new AbortController()
  let resolveTimeout: ((marker: typeof PREFETCH_TIMEOUT) => void) | undefined
  const timedOut = new Promise<typeof PREFETCH_TIMEOUT>(resolve => { resolveTimeout = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined
  if (alreadyExpired) {
    controller.abort()
    resolveTimeout?.(PREFETCH_TIMEOUT)
  } else {
    timer = setTimeout(() => {
      expired = true
      controller.abort()
      resolveTimeout?.(PREFETCH_TIMEOUT)
    }, timeoutMs)
  }
  return {
    get expired(): boolean { return expired },
    signal: controller.signal,
    race<T>(work: Promise<T>): Promise<T | typeof PREFETCH_TIMEOUT> {
      // A timed-out image may still settle later; observe its rejection so it
      // never becomes an unhandled rejection after the prefetch returned.
      void work.catch(() => undefined)
      if (expired) return Promise.resolve(PREFETCH_TIMEOUT)
      return Promise.race([work, timedOut])
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}

/** Best-effort structured warning; a broken sink must never fail the prefetch. */
function safeWarn(input: ImagePrefetchInput, message: string, ...args: unknown[]): void {
  try {
    input.warn?.(message, ...args)
  } catch {
    // Warnings are diagnostics only.
  }
}

/** Readable text for an arbitrary thrown value (never `[object Object]`). */
function thrownValueText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const parts: string[] = []
    for (const key of ['code', 'status', 'statusCode', 'name', 'msg', 'message']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) parts.push(`${key}=${value}`)
      else if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key}=${value}`)
    }
    if (parts.length > 0) return parts.join(' ')
    try {
      const text = JSON.stringify(error)
      if (text !== undefined && text !== '{}') return text
    } catch {
      // Circular structure: fall through to the fixed description.
    }
    return '未知错误（不可序列化的对象）'
  }
  return String(error)
}

/** Readable, bounded download failure reason (Feishu 400/403 mapped). */
function downloadFailureReason(error: unknown): string {
  return boundedPrefetchReason(describeFailure(new Error(thrownValueText(error))))
}

/** Strip control characters and bound one prompt-safe failure reason. */
function boundedPrefetchReason(text: string): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  const value = cleaned === '' ? '图片预取失败' : cleaned
  if (value.length <= PREFETCH_MAX_REASON_TEXT) return value
  return `${value.slice(0, PREFETCH_MAX_REASON_TEXT - 1)}…`
}
