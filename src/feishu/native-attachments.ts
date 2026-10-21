/**
 * DSH native attachment storage layer for inbound Feishu resources.
 *
 * Two backends exist and one switch selects them (`attachmentStore`):
 *
 * - `native` (default): images are validated and durably committed through
 *   `ctx.attachments.saveImage`, files are streamed into
 *   `ctx.attachments.saveFileStream` without ever being collected in memory.
 *   Images come back as an {@link ImageBlock}, files as a {@link FileBlock}
 *   plus the deterministic handle text and read-only host path that keeps the
 *   resource readable when a tool result cannot carry a `FileBlock`.
 * - `archive`: the legacy behavior — resources are written into the topic
 *   workspace `attachments/` directory by the existing `AttachmentIntake`.
 *
 * Native is downgraded to `archive` when the host does not mount
 * `ctx.attachments`; the downgrade is reported (plan + warning) instead of
 * failing the turn, so headless and older deployments keep working.
 *
 * Every operation returns a structured result instead of throwing: P0 showed
 * that an exception reaching a tool result becomes an unreadable
 * `[object Object]` in session history, and inbound attachments must degrade
 * per resource without aborting the rest of the message.
 *
 * @module dsh-channels/feishu/native-attachments
 */

import type { FeishuChannel, NormalizedMessage, ResourceChunkStream } from '../feishu-channel.ts'
import { sniffImageMediaType } from '../feishu-channel.ts'
import type { AttachmentStoreMode } from '../config.ts'
import type { AgentContext } from '../host/agent.ts'
import type {
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  AttachmentErrorCode,
  AttachmentStore,
  FileAttachmentRef,
  FileBlock,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageBlock,
  ImageMediaType,
} from '../host/attachments.ts'
import type { AttachmentFailure, AttachmentIntake, AttachmentResource } from './inbound-attachments.ts'
import {
  attachmentResources,
  describeFailure,
  EMPTY_POST_PLACEHOLDER,
  hasAttachmentPayload,
  sanitizeFileName,
  stripAttachmentPlaceholders,
} from './inbound-attachments.ts'

/** Cordis service name of the DSH native attachment store. */
export const ATTACHMENT_SERVICE_NAME = 'attachments'

/** Fixed reason reported whenever the host attachment service is absent. */
export const ATTACHMENT_SERVICE_UNMOUNTED_REASON = '宿主未挂载原生附件库（ctx.attachments 不可用）'

/** File name used when a source resource carries no usable display name. */
export const DEFAULT_FILE_NAME = 'file.bin'

/**
 * In-memory image cap used when the host publishes no image limits. Feishu
 * caps inbound images well below this, so the value only guards against a
 * misbehaving host/stream, never against a legitimate upload.
 */
export const FALLBACK_MAX_IMAGE_BYTES = 20 * 1024 * 1024

// ---- Service discovery --------------------------------------------------

/**
 * Minimal context surface that can resolve the host attachment service.
 *
 * Both the plugin's host context and an Agent-scoped context satisfy it: the
 * direct property is attempted first (it throws in cordis scopes that did not
 * inject the service) and the safe `get()` lookup resolves host-wide services
 * (including from the plugin's own context, which is a sibling of the
 * attachment plugin in the loader composition).
 */
export interface AttachmentServiceContext {
  attachments?: unknown
  get?(name: string): unknown
}

/** The host attachment store is mounted and usable. */
export interface AttachmentServiceMounted {
  readonly mounted: true
  readonly service: AttachmentStore
  /** Deployment-resolved image limits, when the host publishes them. */
  readonly limits?: ImageAttachmentLimits
}

/** The host has no attachment store in this Agent scope (degrade to archive). */
export interface AttachmentServiceUnmounted {
  readonly mounted: false
  readonly code: 'ATTACHMENT_SERVICE_UNMOUNTED'
  readonly reason: string
}

/** Whether the native attachment service can be used for this Agent scope. */
export type AttachmentServiceState = AttachmentServiceMounted | AttachmentServiceUnmounted

/**
 * Structural guard for the narrow service surface. All operations listed in
 * {@link AttachmentStore} are required: a partially matching object is not a
 * usable attachment store and must degrade to `archive` instead of failing
 * later inside a turn.
 */
export function isAttachmentStore(value: unknown): value is AttachmentStore {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<AttachmentStore>
  return typeof candidate.saveImage === 'function'
    && typeof candidate.saveFileStream === 'function'
    && typeof candidate.fileHostPath === 'function'
    && typeof candidate.imageHostPath === 'function'
    && typeof candidate.admitPromptContent === 'function'
}

/** Mount state for one already-resolved service value. */
export function attachmentServiceStateOf(service: AttachmentStore | undefined): AttachmentServiceState {
  if (service === undefined || !isAttachmentStore(service)) {
    return { mounted: false, code: 'ATTACHMENT_SERVICE_UNMOUNTED', reason: ATTACHMENT_SERVICE_UNMOUNTED_REASON }
  }
  const limits = service.imageLimits
  return { mounted: true, service, ...(limits === undefined ? {} : { limits }) }
}

/**
 * Resolve the native attachment service from one context.
 *
 * Cordis throws when an un-injected service property is read, so both the
 * direct property and the safe `ctx.get` lookup are attempted inside guards:
 * a missing service must read as "not mounted", never as a thrown error.
 */
export function resolveAttachmentService(
  ctx: AttachmentServiceContext | undefined,
): AttachmentStore | undefined {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const direct = ctx.attachments
    if (isAttachmentStore(direct)) return direct
  } catch {
    // Not injected into this scope: fall through to the safe lookup.
  }
  try {
    const viaGet = ctx.get?.(ATTACHMENT_SERVICE_NAME)
    if (isAttachmentStore(viaGet)) return viaGet
  } catch {
    // Exotic host: treat the lookup itself as "not mounted".
  }
  return undefined
}

/** Mount state for one Agent scope (never throws). */
export function attachmentServiceState(ctx: AgentContext | undefined): AttachmentServiceState {
  return attachmentServiceStateOf(resolveAttachmentService(ctx))
}

// ---- Structured failures ------------------------------------------------

/** Stable failure codes surfaced by this storage layer. */
export type AttachmentFailureCode =
  | AttachmentErrorCode
  | 'ATTACHMENT_SERVICE_UNMOUNTED'
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
  ATTACHMENT_SERVICE_UNMOUNTED: ATTACHMENT_SERVICE_UNMOUNTED_REASON,
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

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { name?: unknown }).name === 'AbortError'
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
   * Live lookup of the host attachment service. Called per operation so a
   * service that unmounts (Agent disposal) reads as unmounted instead of
   * handing out a stale reference.
   */
  service(): AttachmentStore | undefined
}

/**
 * Thin, degradation-aware wrapper over one host `ctx.attachments` service.
 *
 * The wrapper owns no state and never imports the host package; construct it
 * inside an Agent scope that injected `attachments`, or resolve it lazily with
 * {@link nativeAttachmentStoreOf}.
 */
export class NativeAttachmentStore {
  constructor(private readonly deps: NativeAttachmentStoreDeps) {}

  /** Current mount state of the underlying service. */
  state(): AttachmentServiceState {
    return attachmentServiceStateOf(this.deps.service())
  }

  /**
   * Validate and durably store one image.
   *
   * The declared media type is verified against the bytes when both are
   * available; an unknown raster is refused before touching the store. Limits
   * published by the host are enforced here as a fast pre-check, and the store
   * still re-validates decode, dimensions, and pixels.
   */
  async saveImage(input: SaveImageInput): Promise<AttachmentResult<StoredImage>> {
    const mounted = this.state()
    if (!mounted.mounted) return { ok: false, code: mounted.code, reason: mounted.reason }

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
    const limits = mounted.limits
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
      const ref = await mounted.service.saveImage({
        data: input.bytes,
        mediaType,
        ...(name === undefined ? {} : { name }),
      })
      return { ok: true, value: { block: { type: 'image', attachment: ref }, ref } }
    } catch (error) {
      return this.failure(error, mounted.service)
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
    const mounted = this.state()
    if (!mounted.mounted) return { ok: false, code: mounted.code, reason: mounted.reason }
    if (input.signal?.aborted === true) {
      return { ok: false, code: 'ABORTED', reason: FAILURE_REASONS.ABORTED }
    }

    const name = sanitizeFileName(input.name) ?? DEFAULT_FILE_NAME
    try {
      const ref = await mounted.service.saveFileStream({
        data: cancelableBytes(input.source, input.signal),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        name,
      })
      return { ok: true, value: this.storedFile(mounted.service, ref) }
    } catch (error) {
      return this.failure(error, mounted.service, input.signal)
    }
  }

  /** Resolve the read-only host path of one stored file (structured failure when not). */
  fileReadPath(ref: FileAttachmentRef): AttachmentResult<string> {
    const mounted = this.state()
    if (!mounted.mounted) return { ok: false, code: mounted.code, reason: mounted.reason }
    return readPathOf(ref, 'file', mounted.service)
  }

  /** Resolve the read-only host path of one stored image (structured failure when not). */
  imageReadPath(ref: ImageAttachmentRef): AttachmentResult<string> {
    const mounted = this.state()
    if (!mounted.mounted) return { ok: false, code: mounted.code, reason: mounted.reason }
    return readPathOf(ref, 'image', mounted.service)
  }

  /**
   * Admit one host prompt: uploaded images become durable references, text and
   * resolved file references pass through. Wrapped so a prefetch failure stays
   * a readable value instead of aborting the turn.
   */
  async admitPromptContent(
    content: readonly AttachmentAdmissionPart[],
  ): Promise<AttachmentResult<AdmittedPromptContentPart[]>> {
    const mounted = this.state()
    if (!mounted.mounted) return { ok: false, code: mounted.code, reason: mounted.reason }
    try {
      return { ok: true, value: await mounted.service.admitPromptContent(content) }
    } catch (error) {
      return this.failure(error, mounted.service)
    }
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

/** Lazy store bound to one Agent scope; unmounted scopes degrade per call. */
export function nativeAttachmentStoreOf(ctx: AgentContext | undefined): NativeAttachmentStore {
  return new NativeAttachmentStore({ service: () => resolveAttachmentService(ctx) })
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

/**
 * Read one image resource completely (bounded by `cap` bytes). Images are
 * platform-capped far below the file path, so one bounded in-memory read is
 * the correct shape here; files never take this path.
 */
async function collectImageBytes(
  source: AsyncIterable<Uint8Array>,
  cap: number,
): Promise<AttachmentResult<Uint8Array>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    total += chunk.byteLength
    if (total > cap) {
      return {
        ok: false,
        code: 'IMAGE_TOO_LARGE',
        reason: `图片超过大小上限（已读取 ${total} 字节，上限 ${cap} 字节）`,
      }
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, value: bytes }
}

// ---- Backend selection / archive fallback ------------------------------

/** Why an inbound message could not use its configured backend. */
export type AttachmentStorageFallback = 'attachment-service-unmounted' | 'forwarded-record'

/** Resolved backend choice for the current deployment. */
export interface AttachmentStoragePlan {
  readonly configured: AttachmentStoreMode
  /** Backend actually used for new inbound bytes. */
  readonly effective: AttachmentStoreMode
  /** Present when `effective` differs from `configured` or the message path is limited. */
  readonly fallback?: AttachmentStorageFallback
  /** One-shot operator warning for a degraded deployment. */
  readonly warning?: string
}

/**
 * Choose the storage backend. A configured `archive` is always honored; a
 * configured `native` without a mounted service downgrades to `archive` with
 * an explicit fallback and warning (never a failed turn).
 */
export function planAttachmentStorage(input: {
  configured: AttachmentStoreMode
  service: AttachmentStore | undefined
}): AttachmentStoragePlan {
  if (input.configured === 'archive') {
    return { configured: 'archive', effective: 'archive' }
  }
  if (input.service !== undefined) {
    return { configured: 'native', effective: 'native' }
  }
  return {
    configured: 'native',
    effective: 'archive',
    fallback: 'attachment-service-unmounted',
    warning: 'dsh-channels: attachmentStore=native 但宿主未挂载 ctx.attachments，回退话题 attachments/ 工作区落盘',
  }
}

/**
 * Effective backend for new inbound bytes.
 *
 * An explicit `archive` configuration always wins (legacy behavior, including
 * synchronous workspace downloads). A `native` configuration degrades to
 * `archive` when:
 *
 * - the host does not mount the attachment service (headless/older hosts must
 *   keep the pre-v2 pipeline instead of losing their attachments); or
 * - the model-facing fetch tool is disabled: files in the native pipeline are
 *   only obtainable through `feishu_attachment_fetch`, so a manifest without
 *   that tool would promise an operation the model cannot perform. Falling
 *   back keeps their bytes readable from the workspace archive instead.
 *
 * With `acceptAttachments: false` the backend is `archive` too: the legacy
 * disabled path is the known-inert behavior (no downloads, no turn for
 * attachment-only messages), and the archive guidance never advertises a tool
 * that is not mounted.
 */
export function effectiveAttachmentMode(
  configured: AttachmentStoreMode,
  service: AttachmentStore | undefined,
  attachmentFetchToolEnabled = true,
  attachmentsEnabled = true,
): AttachmentStoreMode {
  if (configured === 'archive' || service === undefined) return 'archive'
  if (!attachmentsEnabled || !attachmentFetchToolEnabled) return 'archive'
  return 'native'
}

/** One image stored natively for an inbound message. */
export interface StoredNativeImage {
  readonly kind: 'image'
  readonly resource: AttachmentResource
  readonly ref: ImageAttachmentRef
  readonly block: ImageBlock
}

/** One file stored natively for an inbound message. */
export interface StoredNativeFile {
  readonly kind: 'file'
  readonly resource: AttachmentResource
  readonly ref: FileAttachmentRef
  readonly block: FileBlock
  readonly handleText: string
  readonly hostPath?: string
  readonly readPathError?: AttachmentFailureResult
}

/** One inbound resource stored by the native backend. */
export type StoredAttachment = StoredNativeImage | StoredNativeFile

/** Result of storing one message's attachment payload. */
export interface InboundAttachmentStoreResult {
  /** Backend that actually handled this message. */
  readonly mode: AttachmentStoreMode
  /** Present when the configured backend could not be used for this message. */
  readonly fallback?: AttachmentStorageFallback
  /** Resources durably stored (native mode only). */
  readonly saved: number
  /** Resources that failed to download/store. */
  readonly failed: number
  /** Per-resource failure notes (user-facing), mirroring the archive intake. */
  readonly failures: readonly AttachmentFailure[]
  /** Native content blocks, ready for prompt assembly or tool results. */
  readonly stored: readonly StoredAttachment[]
  /** True when the message carried no prompt text after removing resource placeholders. */
  readonly attachmentOnly: boolean
  /** Remaining prompt text after attachment placeholders are removed. */
  readonly text: string
}

export interface InboundAttachmentStoreDeps {
  /** Live `acceptAttachments` gate (disabled keeps attachment messages inert). */
  enabled(): boolean
  /** Live configured backend (`attachmentStore`). */
  mode(): AttachmentStoreMode
  /** Live native service lookup (undefined = unmounted). */
  service(): AttachmentStore | undefined
  /** Live Feishu channel; undefined after shutdown. */
  channel(): FeishuChannel | undefined
  /** Existing workspace archive, used by archive mode and every fallback. */
  archive: AttachmentIntake
  /** Structured warning sink (never throws). */
  warn(message: string, ...args: unknown[]): void
}

/**
 * Inbound attachment storage entry point shared by every backend.
 *
 * This is the layer the admission task wires in place of the direct
 * `AttachmentIntake.archive()` call: it resolves the backend once per message,
 * stores trigger-message resources natively, and preserves the legacy
 * workspace archive whenever native is unavailable or configured off.
 */
export class InboundAttachmentStore {
  private warnedUnmounted = false

  constructor(private readonly deps: InboundAttachmentStoreDeps) {}

  /** Current backend decision for a new inbound message. */
  plan(): AttachmentStoragePlan {
    return planAttachmentStorage({ configured: this.deps.mode(), service: this.deps.service() })
  }

  /**
   * Store every image/file resource (and, for forwarded records, the legacy
   * text archive) of one inbound message.
   *
   * The v2 native admission pipeline does NOT call this for triggering
   * messages: it prefetches images and leaves files lazy behind the prompt
   * manifest. This facade is used by the `archive` / missing-host fallback
   * (synchronous workspace download) and by the storage-layer tests. Its
   * `forwarded-record` text fallback therefore only runs for archive
   * deployments; reading merged-forward transcripts in native deployments is
   * owned by `quote_history_tools`.
   *
   * @returns `undefined` when the message carries no attachment payload;
   *   otherwise a structured result whose `text` is the remaining prompt.
   */
  async store(msg: NormalizedMessage, directory: string): Promise<InboundAttachmentStoreResult | undefined> {
    if (!hasAttachmentPayload(msg)) return undefined

    // Snapshot the live config/service once per message: the backend decision,
    // the one-shot warning and the storage call all describe the same moment
    // (a later service unmount surfaces as a per-resource structured failure).
    const configured = this.deps.mode()
    const service = this.deps.service()
    const plan = planAttachmentStorage({ configured, service })
    const prompt = remainingPromptText(msg, msg.rawContentType === 'merge_forward')

    if (!this.deps.enabled()) {
      // Disabled means inert for attachment-only messages too: strip the
      // resource placeholders and keep the same attachment-only classification
      // as the enabled paths, so the caller starts no turn when no prompt text
      // is left (config: "Disabled keeps attachment messages inert").
      return {
        mode: plan.effective,
        saved: 0,
        failed: 0,
        failures: [],
        stored: [],
        attachmentOnly: prompt.attachmentOnly,
        text: prompt.text,
      }
    }
    if (plan.warning !== undefined && !this.warnedUnmounted) {
      this.warnedUnmounted = true
      this.deps.warn(plan.warning)
    }

    // Forwarded records are plain text, not DSH attachments: keep the legacy
    // text archive for them until the quote/history task owns that resource.
    if (plan.effective === 'native' && service !== undefined && msg.rawContentType !== 'merge_forward') {
      return await this.storeNative(msg, service)
    }
    return await this.storeArchive(msg, directory, plan)
  }

  /** Legacy backend: workspace `attachments/` through the existing intake. */
  private async storeArchive(
    msg: NormalizedMessage,
    directory: string,
    plan: AttachmentStoragePlan,
  ): Promise<InboundAttachmentStoreResult> {
    const archived = await this.deps.archive.archive(msg, directory)
    const fallback: AttachmentStorageFallback | undefined = msg.rawContentType === 'merge_forward'
      && plan.effective === 'native'
      ? 'forwarded-record'
      : plan.fallback
    return {
      mode: 'archive',
      ...(fallback === undefined ? {} : { fallback }),
      saved: archived.saved,
      failed: archived.failed,
      failures: archived.failures,
      stored: [],
      attachmentOnly: archived.attachmentOnly,
      text: archived.text,
    }
  }

  /** Native backend: images/files through `ctx.attachments`. */
  private async storeNative(
    msg: NormalizedMessage,
    service: AttachmentStore,
  ): Promise<InboundAttachmentStoreResult> {
    const resources = attachmentResources(msg)
    const { text: remainingText, attachmentOnly } = remainingPromptText(msg, false)

    const channel = this.deps.channel()
    if (channel === undefined) {
      return {
        mode: 'native',
        saved: 0,
        failed: resources.length,
        failures: resources.map(resource => ({
          name: displayName(resource),
          reason: '飞书连接未运行，附件未保存',
        })),
        stored: [],
        attachmentOnly,
        text: remainingText,
      }
    }

    // Live lookup inside the store: if the host unmounts mid-message, the
    // remaining resources fail as "unmounted" instead of reusing a stale handle.
    const native = new NativeAttachmentStore({ service: () => this.deps.service() })
    const imageCap = imageByteCap(service)
    const stored: StoredAttachment[] = []
    const failures: AttachmentFailure[] = []

    for (const resource of resources) {
      const name = displayName(resource)
      if (resource.folder === true) {
        failures.push({ name, reason: FAILURE_REASONS.FOLDER_UNSUPPORTED })
        continue
      }
      try {
        const result = resource.type === 'image'
          ? await storeImageResource(native, channel, msg, resource, imageCap)
          : await storeFileResource(native, channel, msg, resource)
        if (result.ok) {
          stored.push(result.value)
        } else {
          failures.push({ name, reason: result.reason })
          this.deps.warn(
            'dsh-channels: storing attachment %s of message %s failed (%s): %s',
            resource.fileKey, msg.messageId, result.code, result.reason,
          )
        }
      } catch (error) {
        failures.push({ name, reason: describeFailure(error) })
        this.deps.warn(
          'dsh-channels: storing attachment %s of message %s failed: %s',
          resource.fileKey, msg.messageId, String(error),
        )
      }
    }

    return {
      mode: 'native',
      saved: stored.length,
      failed: failures.length,
      failures,
      stored,
      attachmentOnly,
      text: remainingText,
    }
  }
}

/** Largest image the native path will buffer before refusing it. */
function imageByteCap(service: AttachmentStore): number {
  const max = service.imageLimits?.maxImageBytes
  if (max !== undefined && Number.isFinite(max) && max > 0) return max
  return FALLBACK_MAX_IMAGE_BYTES
}

/**
 * Strip attachment placeholders and classify what prompt text is left. Shared
 * by the enabled native path and the disabled (inert) branch so both agree on
 * the attachment-only decision.
 */
function remainingPromptText(
  msg: NormalizedMessage,
  forwarded: boolean,
): { text: string; attachmentOnly: boolean } {
  const stripped = stripAttachmentPlaceholders(msg.content ?? '', forwarded)
  const text = stripped === EMPTY_POST_PLACEHOLDER ? '' : stripped
  return { text, attachmentOnly: text === '' }
}

/** User-facing name for one attachment (mirrors the archive intake). */
function displayName(resource: AttachmentResource): string {
  if (resource.fileName !== undefined && resource.fileName !== '') return resource.fileName
  return resource.type === 'image' ? '图片' : '文件'
}

async function storeImageResource(
  native: NativeAttachmentStore,
  channel: FeishuChannel,
  msg: NormalizedMessage,
  resource: AttachmentResource,
  cap: number,
): Promise<AttachmentResult<StoredNativeImage>> {
  let stream: ResourceChunkStream
  try {
    stream = await channel.downloadResource(msg.messageId, resource.fileKey, 'image')
  } catch (error) {
    return { ok: false, code: 'DOWNLOAD_FAILED', reason: describeFailure(error) }
  }
  const bytes = await collectImageBytes(stream, cap)
  if (!bytes.ok) return bytes
  const saved = await native.saveImage({
    bytes: bytes.value,
    ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
  })
  if (!saved.ok) return saved
  return {
    ok: true,
    value: { kind: 'image', resource, ref: saved.value.ref, block: saved.value.block },
  }
}

async function storeFileResource(
  native: NativeAttachmentStore,
  channel: FeishuChannel,
  msg: NormalizedMessage,
  resource: AttachmentResource,
): Promise<AttachmentResult<StoredNativeFile>> {
  let stream: ResourceChunkStream
  try {
    stream = await channel.downloadResource(msg.messageId, resource.fileKey, 'file')
  } catch (error) {
    return { ok: false, code: 'DOWNLOAD_FAILED', reason: describeFailure(error) }
  }
  const saved = await native.saveFile({
    source: stream,
    ...(resource.fileName === undefined ? {} : { name: resource.fileName }),
  })
  if (!saved.ok) {
    // A stream error surfaces from inside the host write. Only a failure whose
    // text matches the known Feishu download refusals (400/403) is re-labeled
    // as a download failure; a real storage fault (ENOSPC, ...) keeps its
    // ATTACHMENT_STORE_ERROR code and its wording.
    if (saved.code === 'ATTACHMENT_STORE_ERROR') {
      const friendly = describeFailure(new Error(saved.reason))
      if (friendly !== saved.reason) {
        return { ok: false, code: 'DOWNLOAD_FAILED', reason: friendly }
      }
    }
    return saved
  }
  return {
    ok: true,
    value: {
      kind: 'file',
      resource,
      ref: saved.value.ref,
      block: saved.value.block,
      handleText: saved.value.handleText,
      ...(saved.value.hostPath === undefined ? {} : { hostPath: saved.value.hostPath }),
      ...(saved.value.readPathError === undefined ? {} : { readPathError: saved.value.readPathError }),
    },
  }
}
