/**
 * DSH native attachment storage layer for inbound Feishu resources.
 *
 * Inbound Feishu images and files are stored only in the host attachment
 * library (`ctx.attachments`, `@deepseek-ai/dsh-attachment-local`): images are
 * validated and durably committed through `saveImage`, files are streamed into
 * `saveFileStream` without ever being collected in memory. Images come back as
 * an {@link ImageBlock}, files as a {@link FileBlock} plus the deterministic
 * handle text and read-only host path that keeps the resource readable when a
 * tool result cannot carry a `FileBlock`.
 *
 * Every operation returns a structured result instead of throwing: P0 showed
 * that an exception reaching a tool result becomes an unreadable
 * `[object Object]` in session history, and inbound attachments must degrade
 * per resource without aborting the rest of the message.
 *
 * @module dsh-channels/feishu/native-attachments
 */

import { sniffImageMediaType } from '../feishu-channel.ts'
import type {
  AttachmentErrorCode,
  AttachmentStore,
  FileAttachmentRef,
  FileBlock,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageBlock,
  ImageMediaType,
} from '../host/attachments.ts'
import { sanitizeFileName } from './inbound-attachments.ts'
import { isAbortError } from './abort.ts'

/** File name used when a source resource carries no usable display name. */
export const DEFAULT_FILE_NAME = 'file.bin'

/**
 * In-memory image cap used when the host publishes no image limits. Feishu
 * caps inbound images well below this, so the value only guards against a
 * misbehaving host/stream, never against a legitimate upload.
 */
export const FALLBACK_MAX_IMAGE_BYTES = 20 * 1024 * 1024

// ---- Structured failures ------------------------------------------------

/** Stable failure codes surfaced by this storage layer. */
export type AttachmentFailureCode =
  | AttachmentErrorCode
  | 'ABORTED'
  | 'DOWNLOAD_FAILED'
  | 'FOLDER_UNSUPPORTED'
  | 'ATTACHMENT_STORE_ERROR'

/** One structured, model-safe failure (no raw bytes, no internal stack). */
export interface AttachmentFailureResult {
  readonly ok: false
  readonly code: AttachmentFailureCode
  /** User/model-facing reason; stable wording, safe to place in a prompt. */
  readonly reason: string
}

/** Result of one attachment operation; failures are values, never throws. */
export type AttachmentResult<T> = { readonly ok: true; readonly value: T } | AttachmentFailureResult

const FAILURE_REASONS: Record<AttachmentFailureCode, string> = {
  // Host attachment codes, mapped to user-facing Chinese wording.
  TOO_MANY_IMAGES: '图片数量超过单条消息上限',
  IMAGES_TOO_LARGE: '图片总字节超过单条消息上限',
  UNSUPPORTED_IMAGE_TYPE: '不支持的图片格式（仅支持 PNG/JPEG/WebP/GIF）',
  INVALID_IMAGE_BASE64: '图片数据编码无效',
  INVALID_IMAGE: '图片内容损坏或无法解码',
  IMAGE_TYPE_MISMATCH: '图片内容与声明的类型不一致',
  IMAGE_TOO_LARGE: '图片超过大小上限',
  IMAGE_TOO_MANY_PIXELS: '图片像素总数超过上限',
  IMAGE_DIMENSION_TOO_LARGE: '图片宽高超过上限',
  INVALID_FILE_BASE64: '文件数据编码无效',
  INVALID_ATTACHMENT_REF: '附件引用无效',
  ATTACHMENT_CORRUPT: '附件内容校验失败（文件可能损坏或被替换）',
  ATTACHMENT_WRITE_FAILED: '附件写入失败',
  ATTACHMENT_NOT_FOUND: '附件不存在（可能已被删除）',
  ATTACHMENT_READ_FAILED: '附件读取失败',
  ATTACHMENT_PROJECTION_UNSUPPORTED: '当前部署不支持该附件投影',
  ATTACHMENT_FILES_UNSUPPORTED: '当前部署不支持文件附件',
  // Storage-layer codes.
  ABORTED: '操作已取消',
  DOWNLOAD_FAILED: '飞书附件下载失败',
  FOLDER_UNSUPPORTED: '飞书文件夹消息暂不支持下载',
  ATTACHMENT_STORE_ERROR: '原生附件库操作失败',
}

const ATTACHMENT_ERROR_CODES: ReadonlySet<string> = new Set<AttachmentErrorCode>([
  'TOO_MANY_IMAGES', 'IMAGES_TOO_LARGE', 'UNSUPPORTED_IMAGE_TYPE', 'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE', 'IMAGE_TYPE_MISMATCH', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE', 'INVALID_FILE_BASE64', 'INVALID_ATTACHMENT_REF',
  'ATTACHMENT_CORRUPT', 'ATTACHMENT_WRITE_FAILED', 'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_READ_FAILED', 'ATTACHMENT_PROJECTION_UNSUPPORTED', 'ATTACHMENT_FILES_UNSUPPORTED',
])

function isAttachmentErrorCode(code: string): code is AttachmentErrorCode {
  return ATTACHMENT_ERROR_CODES.has(code)
}

/** User/model-facing wording for one stable failure code. */
export function attachmentFailureReason(code: AttachmentFailureCode): string {
  return FAILURE_REASONS[code]
}

/**
 * Extract a host attachment failure code from an arbitrary thrown value.
 * Prefers the service classifier when the host exposes one (it survives
 * duplicate package installations), then falls back to the structural
 * `error.code` contract.
 */
export function attachmentErrorCodeOf(error: unknown, service?: AttachmentStore): AttachmentErrorCode | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || !isAttachmentErrorCode(code)) return undefined
  if (service?.isAttachmentError !== undefined) {
    // Prefer the host classifier so an unrelated error that happens to carry a
    // colliding `code` field is not misreported as an attachment failure.
    let classified = false
    try {
      classified = service.isAttachmentError(error) === true
    } catch {
      classified = false
    }
    if (!classified) return undefined
  }
  return code
}

/** Cap for one error description placed into a model-safe reason. */
const MAX_ERROR_TEXT = 500

function errorMessage(error: unknown): string {
  return truncateErrorText(rawErrorMessage(error))
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error !== '') return error
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'object') {
    // Never surface `[object Object]` (the P0 unreadable-failure lesson); a
    // circular or unserializable value falls back to a fixed description.
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

/** Keep one untrusted error description short enough for prompt/tool output. */
function truncateErrorText(text: string): string {
  return text.length <= MAX_ERROR_TEXT ? text : `${text.slice(0, MAX_ERROR_TEXT)}…（已截断）`
}

/** Build the cancellation error passed through a cancelled byte source. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

// ---- File handle text ---------------------------------------------------

/**
 * Deterministic model-facing handle for one stored file: the name, byte size,
 * digest prefix, and the read-only host path to read on demand.
 *
 * Mirrors the host's `FileBlock` projection (`fileHandleText` in
 * `@deepseek-ai/dsh-llm`) so the fallback used when a tool result cannot
 * carry a `FileBlock` is byte-identical to what the host would have produced.
 */
export function formatFileHandle(ref: FileAttachmentRef, hostPath?: string): string {
  const identity = `File ${JSON.stringify(ref.name)} (${ref.bytes} bytes, sha256:${digestPrefix(ref)})`
  if (hostPath === undefined || hostPath === '') {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(hostPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** First 8 hex characters of a content-addressed attachment id. */
function digestPrefix(ref: FileAttachmentRef): string {
  const raw = String(ref.attachmentId)
  const hex = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
  return hex.slice(0, 8)
}

// ---- Native attachment store -------------------------------------------

/** Input of one image admission (bytes already downloaded). */
export interface SaveImageInput {
  /** Complete encoded image bytes; callers must bound the download size. */
  bytes: Uint8Array
  /** Caller-declared media type (facade detectors leave it undefined). */
  mediaType?: ImageMediaType
  /** Optional display name; sanitized before reaching the host. */
  name?: string
}

/** One durably stored image and the content block built from it. */
export interface StoredImage {
  readonly block: ImageBlock
  readonly ref: ImageAttachmentRef
}

/** Input of one file streaming admission. */
export interface SaveFileInput {
  /** Ordered byte chunks; the source is consumed exactly once, never buffered. */
  source: AsyncIterable<Uint8Array>
  /** Optional display name; sanitized before reaching the host. */
  name?: string
  /** Cooperative cancellation honored between chunks and forwarded to the host. */
  signal?: AbortSignal
}

/** One durably stored file, its content block, and the readable fallback. */
export interface StoredFile {
  readonly block: FileBlock
  readonly ref: FileAttachmentRef
  /** Deterministic handle text for tool results that cannot carry a `FileBlock`. */
  readonly handleText: string
  /** Read-only host path, when the backend maps one. */
  readonly hostPath?: string
  /** Why the read-only path could not be resolved; absent when `hostPath` exists. */
  readonly readPathError?: AttachmentFailureResult
}

export interface NativeAttachmentStoreDeps {
  /**
   * Live lookup of the host attachment service (the plugin's injected
   * `ctx.attachments`). Called per operation so a reloaded service is never
   * held as a stale reference.
   */
  service(): AttachmentStore
}

/**
 * Thin wrapper over the host `ctx.attachments` service that turns every
 * failure into a structured value.
 *
 * The wrapper owns no state and never imports the host package.
 */
export class NativeAttachmentStore {
  constructor(private readonly deps: NativeAttachmentStoreDeps) {}

  /**
   * Validate and durably store one image.
   *
   * The declared media type is verified against the bytes when both are
   * available; an unknown raster is refused before touching the store. Limits
   * published by the host are enforced here as a fast pre-check, and the store
   * still re-validates decode, dimensions, and pixels.
   */
  async saveImage(input: SaveImageInput): Promise<AttachmentResult<StoredImage>> {
    const service = this.deps.service()

    const detected = sniffImageMediaType(input.bytes)
    if (input.mediaType !== undefined && detected !== undefined && detected !== input.mediaType) {
      return {
        ok: false,
        code: 'IMAGE_TYPE_MISMATCH',
        reason: `图片内容与声明的类型不一致（声明 ${input.mediaType}，实际 ${detected}）`,
      }
    }
    const mediaType = input.mediaType ?? detected
    if (mediaType === undefined) {
      return { ok: false, code: 'UNSUPPORTED_IMAGE_TYPE', reason: FAILURE_REASONS.UNSUPPORTED_IMAGE_TYPE }
    }
    const limits: ImageAttachmentLimits | undefined = service.imageLimits
    if (limits !== undefined) {
      // The host owns authoritative validation; a malformed limits object must
      // not throw here (every operation in this module returns a value).
      try {
        const maxBytes = limits.maxImageBytes
        if (Number.isFinite(maxBytes) && maxBytes > 0 && input.bytes.byteLength > maxBytes) {
          return {
            ok: false,
            code: 'IMAGE_TOO_LARGE',
            reason: `图片超过大小上限（${input.bytes.byteLength} > ${maxBytes} 字节）`,
          }
        }
        const mediaTypes: readonly string[] | undefined = Array.isArray(limits.mediaTypes)
          ? limits.mediaTypes
          : undefined
        if (mediaTypes !== undefined && mediaTypes.length > 0 && !mediaTypes.includes(mediaType)) {
          return { ok: false, code: 'UNSUPPORTED_IMAGE_TYPE', reason: FAILURE_REASONS.UNSUPPORTED_IMAGE_TYPE }
        }
      } catch {
        // Fall through: the store re-validates the image authoritatively.
      }
    }

    const name = sanitizeFileName(input.name)
    try {
      const ref = await service.saveImage({
        data: input.bytes,
        mediaType,
        ...(name === undefined ? {} : { name }),
      })
      return { ok: true, value: { block: { type: 'image', attachment: ref }, ref } }
    } catch (error) {
      return this.failure(error, service)
    }
  }

  /**
   * Durably store one streamed file.
   *
   * The source is forwarded chunk by chunk (with a cancellation guard between
   * yields); nothing is collected here or held after the host returns its
   * reference. Cancellation is reported as `ABORTED`, never as a raw error.
   */
  async saveFile(input: SaveFileInput): Promise<AttachmentResult<StoredFile>> {
    if (input.signal?.aborted === true) {
      return { ok: false, code: 'ABORTED', reason: FAILURE_REASONS.ABORTED }
    }

    const service = this.deps.service()
    const name = sanitizeFileName(input.name) ?? DEFAULT_FILE_NAME
    try {
      const ref = await service.saveFileStream({
        data: cancelableBytes(input.source, input.signal),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        name,
      })
      return { ok: true, value: this.storedFile(service, ref) }
    } catch (error) {
      return this.failure(error, service, input.signal)
    }
  }

  /** Resolve the read-only host path of one stored file (structured failure when not). */
  fileReadPath(ref: FileAttachmentRef): AttachmentResult<string> {
    return readPathOf(ref, 'file', this.deps.service())
  }

  /** Resolve the read-only host path of one stored image (structured failure when not). */
  imageReadPath(ref: ImageAttachmentRef): AttachmentResult<string> {
    return readPathOf(ref, 'image', this.deps.service())
  }

  /** Build the model-facing value of one stored file (block, handle text, path). */
  private storedFile(service: AttachmentStore, ref: FileAttachmentRef): StoredFile {
    const read = readPathOf(ref, 'file', service)
    const hostPath = read.ok ? read.value : undefined
    return {
      block: { type: 'file', attachment: ref },
      ref,
      handleText: formatFileHandle(ref, hostPath),
      ...(hostPath === undefined ? {} : { hostPath }),
      ...(read.ok ? {} : { readPathError: read }),
    }
  }

  /** Classify one thrown value into a structured, model-safe failure. */
  private failure(error: unknown, service: AttachmentStore, signal?: AbortSignal): AttachmentFailureResult {
    if (signal?.aborted === true || isAbortError(error)) {
      return { ok: false, code: 'ABORTED', reason: FAILURE_REASONS.ABORTED }
    }
    const code = attachmentErrorCodeOf(error, service)
    if (code !== undefined) return { ok: false, code, reason: FAILURE_REASONS[code] }
    return {
      ok: false,
      code: 'ATTACHMENT_STORE_ERROR',
      reason: `${FAILURE_REASONS.ATTACHMENT_STORE_ERROR}：${errorMessage(error)}`,
    }
  }
}

function readPathOf(
  ref: FileAttachmentRef | ImageAttachmentRef,
  kind: 'file' | 'image',
  service: AttachmentStore,
): AttachmentResult<string> {
  try {
    const path = kind === 'file'
      ? service.fileHostPath(ref as FileAttachmentRef)
      : service.imageHostPath(ref as ImageAttachmentRef)
    if (path === undefined || path === '') {
      return {
        ok: false,
        code: 'ATTACHMENT_PROJECTION_UNSUPPORTED',
        reason: '当前附件后端不提供主机只读路径（无法映射到执行环境路径）',
      }
    }
    return { ok: true, value: path }
  } catch (error) {
    const code = attachmentErrorCodeOf(error, service)
    if (code !== undefined) return { ok: false, code, reason: FAILURE_REASONS[code] }
    return {
      ok: false,
      code: 'ATTACHMENT_READ_FAILED',
      reason: `读取附件只读路径失败：${errorMessage(error)}`,
    }
  }
}

/**
 * Wrap one byte source so an aborted signal stops the pull loop between
 * chunks. The host still receives the signal and owns its own aborts.
 */
async function* cancelableBytes(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (signal === undefined) {
    yield* source
    return
  }
  for await (const chunk of source) {
    if (signal.aborted) throw abortReason(signal)
    yield chunk
  }
  if (signal.aborted) throw abortReason(signal)
}
