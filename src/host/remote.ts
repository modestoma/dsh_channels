/**
 * Host bridge, Remote surface: the in-process Peer, Typert Gateway,
 * method-level access control, and staged file uploads this plugin uses to
 * submit prompts through `session/prompt` as the Feishu user who sent them.
 *
 * Everything is declared locally and structurally (no DSH package import):
 * only the members this plugin calls are modeled, mirroring
 * `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-api-gateway`,
 * `@deepseek-ai/dsh-api-remote-access`, `@deepseek-ai/dsh-client-file-upload`
 * and `@deepseek-ai/dsh-api-session-controller` by convention. The four
 * services ship with the DSH Web composition (`web-app` bundle) and are read
 * through `ctx.get` when the channel starts; a composition without them
 * cannot run this plugin (see {@link requireRemoteServices}).
 *
 * @module dsh-channels/host/remote
 */

import type { ChannelPrincipal } from '../access/principal.ts'
import type { Agent } from './agent.ts'
import type { SessionId } from './core.ts'
import type { FileAttachmentRef, ImageAttachmentRef } from './attachments.ts'
import type { HostContext } from './services.ts'

// ---- Peer ----------------------------------------------------------------

/**
 * One in-process Peer: the caller identity every Remote call through it
 * speaks for, fixed at creation (`PeerScope` in `@deepseek-ai/dsh-typert-protocol`).
 */
export interface PeerScope {
  readonly id: string
  readonly principal: ChannelPrincipal
  /** Aborted once the Peer is disposed. */
  readonly signal: AbortSignal
  /** Tear down the Peer; racing calls share one completion. */
  dispose(): Promise<void>
}

/** The `ctx.connection` members this plugin calls. */
export interface HostConnection {
  /**
   * Create one in-process Peer owned by the plugin's Context (disposed with it).
   * `interactions: 'none'` refuses forwarded-event streams, which this plugin never opens.
   */
  createPeer(options: { readonly principal: ChannelPrincipal; readonly interactions?: 'answer' | 'none' }): PeerScope
}

// ---- Gateway --------------------------------------------------------------

/** One in-process Remote call (`InvokeRemoteRequest` in `@deepseek-ai/dsh-api-gateway`). */
export interface InvokeRemoteRequest {
  readonly namespace: string
  readonly method: string
  /** Named wire arguments; fields must match the method's declared parameters exactly. */
  readonly args: Readonly<Record<string, unknown>>
  /** The Peer the call speaks for; the Gateway records its principal on the prompt. */
  readonly peer: PeerScope
  readonly signal?: AbortSignal
}

/** The `ctx.typertGateway` members this plugin calls. */
export interface TypertGateway {
  /**
   * Invoke one unary Remote method after the access decision for the Peer's principal.
   * @throws a Remote failure (`code`, see {@link remoteFailureOf}) for a refused or failed call.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>
}

// ---- Remote access ---------------------------------------------------------

/** A named action set over Sessions (`RemoteAccessRole<'session'>`). */
export interface RemoteAccessRole {
  readonly name: string
  readonly resource: 'session'
  /** Canonical `<namespace>/<method>` endpoints. */
  readonly actions: readonly string[]
}

/** One role on one Session. */
export interface RemoteAccessBinding {
  readonly role: RemoteAccessRole
  readonly resource: { readonly kind: 'session'; readonly id: string }
}

/** A refused request, as `explain()` sees it. */
export interface RemoteAccessRequest<P> {
  readonly principal: P
  readonly action: string
  readonly resources: readonly { readonly kind: string; readonly id?: string }[]
}

/** Business rules for one non-owner principal kind, answered synchronously from memory. */
export interface RemoteAccessPolicy<P> {
  /** Every binding the principal holds now; called once per decision, never cached. */
  bindings(principal: P): readonly RemoteAccessBinding[]
  /** The reason a refused call reports, or undefined for `no-allow`. */
  explain?(request: RemoteAccessRequest<P>): string | undefined
}

/** The `ctx.remoteAccess` members this plugin calls. */
export interface RemoteAccess {
  /**
   * Register the one policy of a principal kind; a second registration of the
   * same kind throws.
   * @returns the disposer removing the policy.
   */
  registerPolicy<P extends ChannelPrincipal>(kind: P['kind'], policy: RemoteAccessPolicy<P>): () => void
  /** Report that bindings may have changed (snapshot readers are woken; decisions always read fresh). */
  invalidate(principal?: ChannelPrincipal): void
}

// ---- File uploads -----------------------------------------------------------

/** Opaque receipt of one staged upload, valid only for the Session it was staged under. */
export type FileUploadReceiptId = string

/** The `ctx.fileUploads` members this plugin calls (all in-process; no Fetch route). */
export interface FileUploads {
  /**
   * Validate, normalize and store one prompt image for a live Session and
   * stage it under a receipt the next `session/prompt` may cite.
   * @throws a Remote failure (`session/attachment-invalid`, `session/not-found`).
   */
  uploadImageStream(request: {
    readonly sessionId: SessionId
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<{ readonly receiptId: FileUploadReceiptId; readonly image: ImageAttachmentRef }>
  /**
   * Store one verbatim file (canonical base64) for a live Agent and stage it under a receipt.
   * @throws a Remote failure (`session/attachment-invalid`, `session/not-found`).
   */
  upload(agent: Agent, request: { readonly data: string; readonly name?: string }, signal: AbortSignal): Promise<{ readonly receiptId: FileUploadReceiptId; readonly file: FileAttachmentRef }>
  /** The staged attachment of a receipt, or undefined for an unknown or foreign receipt. */
  resolve(agent: Agent, receiptId: FileUploadReceiptId): { readonly type: 'file' | 'image' } | undefined
}

// ---- session/prompt -----------------------------------------------------------

/** One part of a `session/prompt` content (`PromptContentPart` in the session controller). */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly receiptId: FileUploadReceiptId }

/** The `session/prompt` request (`SessionPromptRequest`); `requestId` is the prompt's `source.rpcId`. */
export interface SessionPromptRequest {
  readonly requestId: string
  readonly sessionId: SessionId
  /** `queue` opens its own turn (`followup`); `steer` joins the running turn's next step. */
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
}

// ---- Failures -----------------------------------------------------------------

/** A Remote failure as thrown by the Gateway or a Host service (`RemoteError`). */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/**
 * Structurally identify a Remote failure (the marker DSH sets on `RemoteError`).
 * @param value - a caught value.
 * @returns the failure, or undefined for any other error.
 */
export function remoteFailureOf(value: unknown): RemoteFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { isDSHRemoteError?: unknown; code?: unknown; message?: unknown; details?: unknown }
  if (candidate.isDSHRemoteError !== true || typeof candidate.code !== 'string') return undefined
  return {
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : String(value),
    details: candidate.details,
  }
}

// ---- Resolution -----------------------------------------------------------------

/** The four Remote-side services the prompt path needs. */
export interface RemoteServices {
  readonly connection: HostConnection
  readonly gateway: TypertGateway
  readonly remoteAccess: RemoteAccess
  readonly fileUploads: FileUploads
}

/** Host service names behind {@link RemoteServices}. */
export const REMOTE_SERVICE_NAMES = {
  connection: 'connection',
  gateway: 'typertGateway',
  remoteAccess: 'remoteAccess',
  fileUploads: 'fileUploads',
} as const

/**
 * Read the Remote-side services from the host context.
 * @param ctx - the plugin context.
 * @returns the services.
 * @throws when any is absent: this composition lacks the DSH Web services the
 *   prompt path needs, which is a deployment error, never a degraded mode.
 */
export function requireRemoteServices(ctx: Pick<HostContext, 'get'>): RemoteServices {
  const missing: string[] = []
  const read = (name: string): unknown => {
    const service = ctx.get?.(name)
    if (service === undefined || service === null) missing.push(name)
    return service
  }
  const connection = read(REMOTE_SERVICE_NAMES.connection) as HostConnection
  const gateway = read(REMOTE_SERVICE_NAMES.gateway) as TypertGateway
  const remoteAccess = read(REMOTE_SERVICE_NAMES.remoteAccess) as RemoteAccess
  const fileUploads = read(REMOTE_SERVICE_NAMES.fileUploads) as FileUploads
  if (missing.length > 0) {
    throw new Error(
      `dsh-channels: 宿主缺少 ${missing.join('、')} 服务，无法以飞书用户身份提交提示；本插件需要 DSH Web 配置（web-app bundle）提供的 Connection、Gateway、远程访问控制和文件上传服务`,
    )
  }
  return { connection, gateway, remoteAccess, fileUploads }
}
