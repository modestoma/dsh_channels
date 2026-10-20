/**
 * Host bridge, attachment surface: the minimal `ctx.attachments` face this
 * plugin consumes (durable image/file storage) plus the content-block and
 * prompt-part shapes it produces.
 *
 * Everything here is declared locally and structurally. The DSH attachment
 * packages are never imported at runtime and are not runtime dependencies of
 * this plugin, so these types mirror their published shapes by convention:
 * only the members this plugin actually reads or calls are modeled, and every
 * service lookup tolerates a deployment without the service. The exact
 * upstream package (`@deepseek-ai/dsh-attachment`, DSH 0.2.1-rc.2) has more
 * operations (batches, request projection, encoded uploads); add them here
 * only when a task needs them.
 *
 * @module dsh-channels/host/attachments
 */

// ---- Durable attachment vocabulary --------------------------------------

/** Opaque content-addressed attachment identifier (never a filesystem path). */
export type AttachmentId = string

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable reference to one immutable normalized image. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number
    height: number
  }
}

/**
 * Durable, serializable reference to one verbatim stored file. Files are
 * stored byte-for-byte with no normalization; `attachmentId` is the sha256
 * digest of exactly those bytes.
 */
export interface FileAttachmentRef {
  /** Opaque content-addressed storage identifier; never a filesystem path. */
  attachmentId: AttachmentId
  /** Sanitized display filename, also the stored object's leaf name. */
  name: string
  /** Exact byte length. */
  bytes: number
}

/** Deployment-resolved image limits used by upload admission. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  /** Encoded bytes, checked against the declared media type by the service. */
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional display name; never interpreted as a path. */
  name?: string
}

/** Request to durably commit one file from bounded byte chunks. */
export interface SaveFileStreamAttachment {
  /** Exact file bytes in order; providers must not retain the whole sequence. */
  data: AsyncIterable<Uint8Array>
  /** Optional cancellation for source reads and storage writes. */
  signal?: AbortSignal
  /** Optional display name; never interpreted as a path. */
  name?: string
}

/** One text/image part of host prompt content whose images still need admission. */
export type PromptContentPart = {
  readonly type: 'text'
  readonly text: string
} | {
  readonly type: 'image'
  readonly mediaType: ImageMediaType
  readonly data: string
  readonly name?: string
}

/** Host prompt content whose file receipts are resolved and whose image bytes await admission. */
export type AttachmentAdmissionPart = PromptContentPart | {
  readonly type: 'file'
  readonly attachment: FileAttachmentRef
}

/** Host-admitted prompt content with every attachment represented by its durable reference. */
export type AdmittedPromptContentPart = {
  readonly type: 'text'
  readonly text: string
} | {
  readonly type: 'image'
  readonly attachment: ImageAttachmentRef
} | {
  readonly type: 'file'
  readonly attachment: FileAttachmentRef
}

// ---- Content blocks -----------------------------------------------------

/**
 * A durable raster image reference as it appears in model content
 * (`ImageBlock` in `@deepseek-ai/dsh-llm`). The block is role-neutral; this
 * plugin only produces it for user content.
 */
export interface ImageBlock {
  type: 'image'
  /** Immutable bytes and intrinsic display metadata owned by the service. */
  attachment: ImageAttachmentRef
}

/**
 * A durable verbatim file reference as it appears in model content
 * (`FileBlock` in `@deepseek-ai/dsh-llm`). Files never reach a provider as
 * bytes: request assembly projects them to handle text, so a channel tool that
 * cannot deliver this block must fall back to {@link formatFileHandle}-style
 * text instead.
 */
export interface FileBlock {
  type: 'file'
  /** Immutable verbatim bytes and display metadata owned by the service. */
  attachment: FileAttachmentRef
}

// ---- Failure vocabulary -------------------------------------------------

/**
 * Stable attachment failure codes the host routes on
 * (`AttachmentErrorCode` in `@deepseek-ai/dsh-attachment`). Kept as a
 * type-only union; the runtime classifier lives in the Feishu storage module.
 */
export type AttachmentErrorCode =
  | 'TOO_MANY_IMAGES'
  | 'IMAGES_TOO_LARGE'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'INVALID_IMAGE_BASE64'
  | 'INVALID_IMAGE'
  | 'IMAGE_TYPE_MISMATCH'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TOO_MANY_PIXELS'
  | 'IMAGE_DIMENSION_TOO_LARGE'
  | 'INVALID_FILE_BASE64'
  | 'INVALID_ATTACHMENT_REF'
  | 'ATTACHMENT_CORRUPT'
  | 'ATTACHMENT_WRITE_FAILED'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_READ_FAILED'
  | 'ATTACHMENT_PROJECTION_UNSUPPORTED'
  | 'ATTACHMENT_FILES_UNSUPPORTED'

// ---- Service surface ----------------------------------------------------

/**
 * The narrow `ctx.attachments` service face. Every method mirrors the
 * upstream contract; callers must go through a module that tolerates absence
 * (for example `src/feishu/native-attachments.ts`) rather than branching on
 * this type themselves, so the degradation path exists in exactly one place.
 */
export interface AttachmentStore {
  /** Deployment-resolved image policy; absent on minimal embedding hosts. */
  readonly imageLimits?: ImageAttachmentLimits
  /** Validate, normalize, and durably commit one image. */
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  /** Durably commit one verbatim file from bounded chunks (backpressure, no full buffering). */
  saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>
  /**
   * Locate the verbatim stored file object in the harness host filesystem.
   * @returns an absolute host path, or undefined when this backend is not
   *   host-file-backed.
   * @throws an attachment error when the durable reference is invalid.
   */
  fileHostPath(ref: FileAttachmentRef): string | undefined
  /**
   * Locate the provider-owned normalized image object in the harness host
   * filesystem.
   * @returns an absolute host path, or undefined when this backend is not
   *   host-file-backed.
   * @throws an attachment error when the durable reference is invalid.
   */
  imageHostPath(ref: ImageAttachmentRef): string | undefined
  /** Replace every uploaded image in one host prompt with its durable reference. */
  admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>
  /** Optional host-provided classifier for attachment failures (cross-install safe). */
  isAttachmentError?(error: unknown): boolean
}
