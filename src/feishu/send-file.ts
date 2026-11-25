/**
 * Model-facing `feishu_send_file`: sends one image or file the Agent produced
 * back to the conversation the Session is bound to.
 *
 * Path policy: the model names a path; only a regular file inside the topic's
 * working directory (a projects-mode Session's own directory or the person's
 * `shared/` directory) is sent. Both the roots and the target
 * are resolved with `realpath`, so `..` segments and symlinks cannot reach
 * another topic's directory or the rest of the filesystem. The bytes are read
 * through one file handle whose device/inode must match the contained path
 * re-resolved after opening, so swapping a directory for a symlink between the
 * check and the read is detected.
 *
 * Delivery: the message replies to the route's latest card. A topic route
 * replies inside its topic; a chat route replies on the main timeline. The
 * tool never creates a topic and never targets another chat: a recalled or
 * deleted reply target fails the call instead of falling back to a fresh
 * chat message.
 *
 * Markdown files: a `.md`/`.markdown` file of at most
 * `feishuTools.inlineMarkdownChars` characters of UTF-8 text is first shown
 * as document cards (its content, split like a long reply), then sent as the
 * file. A failed card is logged and the file is still sent.
 *
 * The same delivery serves the turn-end automatic sending
 * (`deliverables/auto-send.ts`) through {@link SendFileToolRuntime.send}.
 *
 * Feishu limits (`im.v1.image.create` / `im.v1.file.create`): images up to
 * 10 MB in JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO, files up to 30 MB, zero-byte
 * uploads rejected. Both uploads need the `im:resource` (or
 * `im:resource:upload`) scope.
 *
 * @module dsh-channels/feishu/send-file
 */

import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { FeishuConfig } from '../config.ts'
import type {
  AgentContext, ToolContentBlock, ToolDefinition, ToolExecution,
} from '../host/agent.ts'
import type { FeishuChannel, OutboundMedia } from '../feishu-channel.ts'
import { FeishuApiError, sniffImageMediaType } from '../feishu-channel.ts'
import { buildDocumentCards } from '../cards/streaming.ts'
import { AgentToolMount } from './tool-mount.ts'

/** Model-facing tool name; stable across releases (session history references it). */
export const SEND_FILE_TOOL_NAME = 'feishu_send_file'

/** Feishu `im.v1.image.create` size limit. */
export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** Feishu `im.v1.file.create` size limit. */
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024

/** Longest file name passed to Feishu (characters). */
const MAX_FILE_NAME_CHARS = 200

const SEND_FILE_DESCRIPTION =
  '把当前话题工作目录中的一个图片或文件发送给飞书里的用户（回复在当前话题/会话中）。'
  + '当你生成了用户需要直接查看或下载的图片、报告、表格、压缩包等文件时使用。'
  + 'path 可以是绝对路径，或相对当前话题工作目录的路径；只能发送该目录内的普通文件（不能发送目录，也不能通过 .. 或符号链接访问目录外的文件），'
  + '目录外的文件请先复制到工作目录。'
  + 'kind 默认 auto：可识别的图片（JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO，≤10 MB）以图片消息发送，其余以文件消息发送；'
  + '文件上限 30 MB，空文件会被拒绝。一次调用发送一个文件；需要发送多个时逐个调用。'
  + 'Markdown 报告（.md）在长度上限内会先以卡片显示正文，再附上文件。'

/** Tool argument validation (the model may send anything). */
export const sendFileArgsSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  kind: z.enum(['auto', 'image', 'file']).optional(),
  file_name: z.string().trim().min(1).max(MAX_FILE_NAME_CHARS).optional(),
}).strict()

export type SendFileArgs = z.infer<typeof sendFileArgsSchema>

/** JSON Schema advertised to the model. */
export const SEND_FILE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '要发送的文件路径：绝对路径，或相对当前话题工作目录的路径。',
    },
    kind: {
      type: 'string',
      enum: ['auto', 'image', 'file'],
      description: 'auto（默认）按内容判断；image 强制以图片发送（非图片或超过 10 MB 会失败）；file 一律以文件附件发送。',
    },
    file_name: {
      type: 'string',
      description: '文件消息展示给用户的文件名，默认取路径的文件名；图片消息忽略此项。',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

/** Stable failure codes; the readable `reason` carries the details. */
export type SendFileFailureCode =
  | 'TOOL_DISABLED'
  | 'ROUTE_NOT_FOUND'
  | 'CHANNEL_UNAVAILABLE'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'NOT_AN_IMAGE'
  | 'PERMISSION_DENIED'
  | 'REPLY_TARGET_GONE'
  | 'SEND_FAILED'
  | 'ABORTED'

const FAILURE_REASONS: Readonly<Record<SendFileFailureCode, string>> = {
  TOOL_DISABLED: 'feishu_send_file 已在插件配置中关闭',
  ROUTE_NOT_FOUND: '当前会话没有绑定飞书话题或会话，无法确定发送目标',
  CHANNEL_UNAVAILABLE: '飞书连接当前不可用，请稍后重试',
  PATH_OUTSIDE_WORKSPACE: '只能发送当前话题工作目录（projects 模式还包括共享目录 shared/）内的文件；请先把文件复制到工作目录再发送',
  FILE_NOT_FOUND: '文件不存在或不可读',
  NOT_A_FILE: '该路径不是普通文件（目录等不能发送）',
  EMPTY_FILE: '文件为空，飞书不接受 0 字节的上传',
  FILE_TOO_LARGE: '文件超过飞书上传上限',
  NOT_AN_IMAGE: '文件内容不是飞书支持的图片格式（JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO）；可用 kind=file 以文件发送',
  PERMISSION_DENIED: '飞书拒绝上传：应用缺少 im:resource（获取与上传图片或文件资源）权限，请管理员在开发者后台开通并发布版本',
  REPLY_TARGET_GONE: '当前话题用于回复的卡片已被撤回或删除；为避免把文件发到群主时间线，已取消发送。请用户在话题里再发一条消息后重试',
  SEND_FAILED: '飞书上传或发送失败',
  ABORTED: '已取消；如果上传已经开始，消息仍可能送达',
}

/** Successful or failed tool value (lossless JSON). */
export type SendFileValue =
  | {
    readonly ok: true
    readonly summary: string
    readonly kind: 'image' | 'file'
    readonly file_name: string
    readonly bytes: number
    readonly message_id: string
  }
  | {
    readonly ok: false
    readonly code: SendFileFailureCode
    readonly reason: string
  }

/** Output schema of {@link SendFileValue}. */
export const SEND_FILE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    kind: { type: 'string', enum: ['image', 'file'] },
    file_name: { type: 'string' },
    bytes: { type: 'integer' },
    message_id: { type: 'string' },
    code: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['ok'],
}

/** Where one Session's outbound files go and where they may come from. */
export interface SendFileTarget {
  /** Message the upload replies to (the route's latest card). */
  readonly replyTo: string
  /** Whether the reply stays inside a topic (`kind: 'thread'` route). */
  readonly inThread: boolean
  /** Topic working directory: relative paths resolve against it, and files may be sent from it. */
  readonly rootDir: string
  /** Further directories files may be sent from (a projects-mode Session's `shared/`). */
  readonly otherRoots?: readonly string[]
}

/** The file one successful send delivered, identified as it was on disk. */
export interface SentFile {
  /** Resolved path (`realpath`) of the sent file. */
  readonly realPath: string
  /** Modification time when the file was read (epoch ms). */
  readonly mtimeMs: number
  /** Bytes sent. */
  readonly bytes: number
}

export interface SendFileRuntimeDeps {
  /** Live plugin configuration (switch). */
  config(): FeishuConfig
  /** Live Feishu channel; undefined while disconnected/shut down. */
  channel(): FeishuChannel | undefined
  /** Resolve the delivery target bound to one session, re-read per call. */
  targetOfSession(sessionId: string): SendFileTarget | undefined
  /** Called after each successful send, by the tool or by {@link SendFileToolRuntime.send}. */
  onSent?(sessionId: string, file: SentFile): void
  /** Structured warning sink (mount degradation, unexpected failures). */
  warn(message: string, ...args: unknown[]): void
}

/**
 * The `feishu_send_file` runtime: mounts the tool into Agent scopes and sends
 * one workspace file per call to the session's current route.
 */
export class SendFileToolRuntime {
  /** Registers the tool in each Agent scope. */
  private readonly toolMount = new AgentToolMount({
    label: SEND_FILE_TOOL_NAME,
    enabled: () => this.enabled(),
    definitions: sessionId => [this.definitionFor(sessionId)],
    describeError: error => describeError(error),
    warn: (message, ...args) => this.deps.warn(message, ...args),
  })

  constructor(private readonly deps: SendFileRuntimeDeps) {}

  /** Whether the feature switch currently allows tool registration/execution. */
  enabled(): boolean {
    return this.deps.config().feishuTools.sendFile
  }

  /**
   * Register the tool inside one Agent scope. Same mount policy as the other
   * channel tools: missing `tools` service is a no-op with one warning, and a
   * slow host never blocks session creation.
   *
   * @param agentCtx Agent scope to register in.
   * @param sessionId Session the tool sends for.
   */
  async mount(agentCtx: AgentContext, sessionId: string): Promise<void> {
    await this.toolMount.mount(agentCtx, sessionId)
  }

  private definitionFor(sessionId: string): ToolDefinition {
    return {
      name: SEND_FILE_TOOL_NAME,
      description: SEND_FILE_DESCRIPTION,
      parameters: SEND_FILE_PARAMETERS,
      output: {
        schema: SEND_FILE_OUTPUT_SCHEMA,
        render: (_args, value) => renderSendFileResult(value),
      },
      execute: async (rawArgs, exec) => await this.execute(sessionId, rawArgs, exec),
      presentCall: args => presentSendFileCall(args),
      presentResult: (_args, value) => presentSendFileResult(value),
      // Two sends race for message order in the chat.
      isConcurrencySafe: () => false,
    }
  }

  private async execute(
    sessionId: string,
    rawArgs: Record<string, unknown>,
    exec: ToolExecution,
  ): Promise<SendFileValue> {
    const parsed = sendFileArgsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.')
      throw new Error(`${SEND_FILE_TOOL_NAME}: invalid ${where}: ${issue?.message ?? 'invalid arguments'}`)
    }
    return await this.send(sessionId, parsed.data, exec.signal)
  }

  /**
   * Send one file of a Session's directories to its conversation: the
   * Markdown cards first when the file qualifies, then the file itself.
   * Reports a successful send to `onSent`.
   * @param sessionId - the Session whose route receives the file.
   * @param args - the file and how to send it.
   * @param signal - cancels the wait; an upload already started may still arrive.
   * @returns the result, a failure value when the file cannot be sent.
   */
  async send(sessionId: string, args: SendFileArgs, signal: AbortSignal): Promise<SendFileValue> {
    if (!this.enabled()) return failure('TOOL_DISABLED')
    const target = this.deps.targetOfSession(sessionId)
    if (target === undefined) return failure('ROUTE_NOT_FOUND')

    const loaded = await loadWorkspaceFile(target.rootDir, args, target.otherRoots)
    if (!loaded.ok) return loaded
    if (signal.aborted) return failure('ABORTED')
    const channel = this.deps.channel()
    if (channel === undefined) return failure('CHANNEL_UNAVAILABLE')

    const { kind, fileName, data } = loaded
    const media: OutboundMedia = kind === 'image' ? { kind, data } : { kind, data, fileName }
    let sent: Promise<{ messageId: string }> | undefined
    try {
      await this.sendDocumentCards(channel, target, loaded, signal)
      sent = channel.replyMedia(target.replyTo, media, { replyInThread: target.inThread })
      const result = await abortable(sent, signal)
      this.deps.onSent?.(sessionId, { realPath: loaded.realPath, mtimeMs: loaded.mtimeMs, bytes: data.length })
      const label = kind === 'image' ? '图片' : '文件'
      return {
        ok: true,
        summary: `已发送${label} ${displayText(fileName)}（${formatBytes(data.length)}）`,
        kind,
        file_name: fileName,
        bytes: data.length,
        message_id: result.messageId,
      }
    } catch (error) {
      if (signal.aborted) {
        // The send keeps running; only its late failure is still worth a log line.
        sent?.catch(late => this.deps.warn('dsh-channels: %s failed after abort: %s', SEND_FILE_TOOL_NAME, describeError(late)))
        return failure('ABORTED')
      }
      const detail = describeError(error)
      if (isPermissionError(error)) return failure('PERMISSION_DENIED', `${FAILURE_REASONS.PERMISSION_DENIED}（${detail}）`)
      if (error instanceof FeishuApiError && error.code !== undefined && REPLY_TARGET_GONE_CODES.has(error.code)) {
        return failure('REPLY_TARGET_GONE')
      }
      this.deps.warn('dsh-channels: %s failed: %s', SEND_FILE_TOOL_NAME, detail)
      return failure('SEND_FAILED', `${FAILURE_REASONS.SEND_FAILED}：${detail}`)
    }
  }

  /**
   * Show a qualifying Markdown file as document cards before the file. A
   * card Feishu refuses is logged and the remaining cards are skipped; the
   * file is sent either way. Cancellation propagates to the caller.
   */
  private async sendDocumentCards(channel: FeishuChannel, target: SendFileTarget, loaded: LoadedFileOk, signal: AbortSignal): Promise<void> {
    const text = inlineMarkdownOf(loaded, this.deps.config().feishuTools.inlineMarkdownChars)
    if (text === undefined) return
    for (const card of buildDocumentCards(loaded.fileName, text)) {
      try {
        await abortable(channel.replyMedia(target.replyTo, { kind: 'card', card }, { replyInThread: target.inThread }), signal)
      } catch (error) {
        if (signal.aborted) throw error
        this.deps.warn('dsh-channels: %s document card for %s failed: %s', SEND_FILE_TOOL_NAME, loaded.fileName, describeError(error))
        return
      }
    }
  }
}

/** File-name endings shown as document cards. */
const MARKDOWN_FILE = /\.(?:md|markdown)$/iu

/**
 * The text of a file shown as document cards: a Markdown file sent as a file
 * message, valid UTF-8, of at most `maxChars` characters (0 turns cards off).
 * @param loaded - the loaded file.
 * @param maxChars - `feishuTools.inlineMarkdownChars`.
 * @returns the text, or undefined when the file is sent without cards.
 */
export function inlineMarkdownOf(loaded: Pick<LoadedFileOk, 'kind' | 'fileName' | 'data'>, maxChars: number): string | undefined {
  if (maxChars === 0 || loaded.kind !== 'file' || !MARKDOWN_FILE.test(loaded.fileName)) return undefined
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.data)
  } catch {
    // Not UTF-8 text: the file goes out as an attachment only.
    return undefined
  }
  text = text.replace(/^\uFEFF/u, '')
  return text.trim() === '' || text.length > maxChars ? undefined : text
}

// ---- File loading -------------------------------------------------------

/** A file read for sending. */
interface LoadedFileOk {
  readonly ok: true
  readonly kind: 'image' | 'file'
  readonly fileName: string
  readonly data: Buffer
  /** Resolved path (`realpath`) the bytes were read from. */
  readonly realPath: string
  /** Modification time at open (epoch ms). */
  readonly mtimeMs: number
}

type LoadedFile = LoadedFileOk | Extract<SendFileValue, { ok: false }>

/**
 * Resolve, contain, size-check and read one file under `rootDir` or one of
 * `otherRoots`.
 *
 * @param rootDir Topic working directory; relative paths resolve against it.
 * @param args Validated tool arguments.
 * @param otherRoots Further directories files may come from; a missing one is skipped.
 * @returns The bytes and the message kind, or a failure value.
 */
export async function loadWorkspaceFile(rootDir: string, args: SendFileArgs, otherRoots: readonly string[] = []): Promise<LoadedFile> {
  let root: string
  try {
    root = await realpath(rootDir)
  } catch (error) {
    return failure('FILE_NOT_FOUND', `当前话题工作目录不可用：${describeError(error)}`)
  }
  const others = await Promise.all(otherRoots.map(async dir => await realpath(dir).catch(() => undefined)))
  const roots = [root, ...others.filter((dir): dir is string => dir !== undefined)]
  const contained = (target: string): boolean => roots.some(allowed => isInside(allowed, target))
  let real: string
  try {
    real = await realpath(path.resolve(root, args.path))
  } catch {
    // A missing path outside the roots must not reveal anything beyond "not allowed".
    return contained(path.resolve(root, args.path))
      ? failure('FILE_NOT_FOUND')
      : failure('PATH_OUTSIDE_WORKSPACE')
  }
  if (!contained(real)) return failure('PATH_OUTSIDE_WORKSPACE')

  const requested = args.kind ?? 'auto'
  const ceiling = requested === 'image' ? FEISHU_IMAGE_MAX_BYTES : FEISHU_FILE_MAX_BYTES
  let handle
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    return failure('FILE_NOT_FOUND', `${FAILURE_REASONS.FILE_NOT_FOUND}：${describeError(error)}`)
  }
  let data: Buffer
  let mtimeMs: number
  try {
    const info = await handle.stat()
    mtimeMs = info.mtimeMs
    if (!info.isFile()) return failure('NOT_A_FILE')
    // A directory swapped for a symlink after the realpath check would open a
    // different inode than the contained path resolves to now.
    const recheck = await realpath(real).then(again => (contained(again) ? stat(again) : undefined), () => undefined)
    if (recheck === undefined || recheck.dev !== info.dev || recheck.ino !== info.ino) {
      return failure('PATH_OUTSIDE_WORKSPACE')
    }
    if (info.size === 0) return failure('EMPTY_FILE')
    if (info.size > ceiling) return tooLarge(requested === 'image' ? 'image' : 'file', info.size)
    data = await handle.readFile()
  } catch (error) {
    return failure('FILE_NOT_FOUND', `${FAILURE_REASONS.FILE_NOT_FOUND}：${describeError(error)}`)
  } finally {
    await handle.close().catch(() => undefined)
  }
  // The file may have grown or shrunk between stat and read.
  if (data.length === 0) return failure('EMPTY_FILE')
  if (data.length > ceiling) return tooLarge(requested === 'image' ? 'image' : 'file', data.length)

  const isImage = isFeishuImage(data)
  if (requested === 'image' && !isImage) return failure('NOT_AN_IMAGE')
  const kind = requested === 'file' ? 'file'
    : requested === 'image' ? 'image'
      : isImage && data.length <= FEISHU_IMAGE_MAX_BYTES ? 'image' : 'file'
  const fileName = sanitizeFileName(args.file_name ?? path.basename(real))
  return { ok: true, kind, fileName, data, realPath: real, mtimeMs }
}

/** Whether `candidate` is `root` itself or below it. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Image formats Feishu accepts for `image_type: message`, by magic bytes. */
function isFeishuImage(data: Uint8Array): boolean {
  if (sniffImageMediaType(data) !== undefined) return true
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4D) return true // BMP
  if (data.length >= 4 && data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2A && data[3] === 0x00) return true // TIFF LE
  if (data.length >= 4 && data[0] === 0x4D && data[1] === 0x4D && data[2] === 0x00 && data[3] === 0x2A) return true // TIFF BE
  return data.length >= 4 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00 // ICO
}

/** File name shown in Feishu: no separators or control characters, bounded. */
function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f/\\]+/gu, '_').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file'
  return cleaned.length <= MAX_FILE_NAME_CHARS ? cleaned : cleaned.slice(cleaned.length - MAX_FILE_NAME_CHARS)
}

function tooLarge(kind: 'image' | 'file', bytes: number): Extract<SendFileValue, { ok: false }> {
  const limit = kind === 'image' ? FEISHU_IMAGE_MAX_BYTES : FEISHU_FILE_MAX_BYTES
  const hint = kind === 'image' ? '；可用 kind=file 以文件发送（上限 30 MB）' : '；请压缩或拆分后再发送'
  return failure('FILE_TOO_LARGE', `${FAILURE_REASONS.FILE_TOO_LARGE}：${formatBytes(bytes)} > ${kind === 'image' ? '图片' : '文件'}上限 ${formatBytes(limit)}${hint}`)
}

function failure(code: SendFileFailureCode, reason?: string): Extract<SendFileValue, { ok: false }> {
  return { ok: false, code, reason: reason ?? FAILURE_REASONS[code] }
}

// ---- Errors -------------------------------------------------------------

/** Feishu codes for a recalled/deleted reply target (the SDK's `target_revoked`). */
const REPLY_TARGET_GONE_CODES: ReadonlySet<number> = new Set([230020, 230017])

/** Feishu codes for a missing app scope. */
const PERMISSION_CODES: ReadonlySet<number> = new Set([99991672, 99991679, 230027])

/** The thrown value followed by its `cause` chain (bounded). */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  while (current !== undefined && current !== null && chain.length < 4) {
    chain.push(current)
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return chain
}

/** Feishu `{ code, msg }` of an SDK/axios error, when present. */
function feishuBody(error: unknown): { code?: number; msg?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (error instanceof FeishuApiError) return { ...(error.code === undefined ? {} : { code: error.code }), msg: error.detail }
  const record = error as { code?: unknown; msg?: unknown; response?: { data?: unknown } }
  const data = record.response?.data
  const source = typeof data === 'object' && data !== null ? data as { code?: unknown; msg?: unknown } : record
  const code = typeof source.code === 'number' ? source.code : undefined
  const msg = typeof source.msg === 'string' ? source.msg : undefined
  return code === undefined && msg === undefined ? undefined : {
    ...(code === undefined ? {} : { code }),
    ...(msg === undefined ? {} : { msg }),
  }
}

function isPermissionError(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const body = feishuBody(item)
    if (body?.code !== undefined && PERMISSION_CODES.has(body.code)) return true
    const text = `${body?.msg ?? ''} ${item instanceof Error ? item.message : ''}`
    return /status code 403|access denied|scope|permission/iu.test(text)
  })
}

/** Readable, bounded text for a thrown value and its Feishu cause. */
function describeError(error: unknown): string {
  const parts: string[] = []
  for (const item of errorChain(error)) {
    const body = feishuBody(item)
    if (body !== undefined) parts.push([body.code, body.msg].filter(part => part !== undefined).join(' '))
    else if (item instanceof Error && item.message !== '') parts.push(item.message)
    else if (typeof item === 'string' && item !== '') parts.push(item)
  }
  const text = parts.length === 0 ? '未知错误' : [...new Set(parts)].join('：')
  return displayText(text)
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

// ---- Rendering / presentation -------------------------------------------

function displayText(value: string, max = 300): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isSendFileValue(value: unknown): value is SendFileValue {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}

/**
 * Model-visible content of one call.
 *
 * @param value The tool value.
 * @returns One text block.
 */
export function renderSendFileResult(value: unknown): readonly ToolContentBlock[] {
  return [{ type: 'text', text: presentSendFileResult(value) }]
}

/**
 * One-line call presentation.
 *
 * @param args Raw tool arguments.
 * @returns Display text.
 */
export function presentSendFileCall(args: Record<string, unknown>): string {
  const target = typeof args.path === 'string' ? displayText(args.path, 120) : '?'
  return `发送到飞书：${target}`
}

/**
 * One-line result presentation.
 *
 * @param value The tool value.
 * @returns Display text.
 */
export function presentSendFileResult(value: unknown): string {
  if (!isSendFileValue(value)) return '发送结果不可用'
  if (value.ok) return value.summary
  return `发送失败（${value.code}）：${value.reason}`
}
