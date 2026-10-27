/**
 * Failure values and helpers shared by the wiki tool families (docx, sheet,
 * base): stable failure codes with readable reasons, argument parsing,
 * Feishu error mapping, ownership, links, and consent-card previews.
 *
 * @module dsh-channels/feishu/wiki/shared
 */

import type { z } from 'zod'
import { FeishuApiError } from '../../feishu-channel.ts'
import type { WikiConsentAction } from '../../cards/wiki.ts'
import type { InteractionRoute } from '../../interactions/pending.ts'
import type { WikiApi, WikiNode } from './api.ts'
import type { BaseApi } from './base-api.ts'
import type { WikiConsentOutcome } from './consent.ts'
import type { WikiRef, WikiRoot } from './links.ts'
import type { SheetApi } from './sheet-api.ts'

/** What every gated call works with. */
export interface WikiCallContext {
  /** Topic and owner the consent cards go to. */
  readonly route: InteractionRoute
  readonly api: WikiApi
  /** Absent on channel stubs without spreadsheet support. */
  readonly sheets?: SheetApi
  /** Absent on channel stubs without base support. */
  readonly bases?: BaseApi
  readonly roots: readonly WikiRoot[]
  readonly botOpenId: string | undefined
}

/** Outcome of the per-call gates. */
export type WikiGate = { ok: true; context: WikiCallContext } | WikiFailure

/** Consent card summary fields. */
export interface WikiConsentFields {
  readonly title: string
  readonly url?: string
  readonly location: string
  readonly details: readonly string[]
}

/** The gates and consent steps every wiki tool family runs through (implemented by the wiki tool runtime). */
export interface WikiToolKit {
  /**
   * Switch, route, whitelist, and channel gates of one call.
   * @param sessionId The calling Session.
   * @param tool Tool name (its switch decides).
   * @returns The call context, or the failure.
   */
  gate(sessionId: string, tool: string): WikiGate
  /**
   * Resolve a node reference and check `wikiRoots` containment.
   * @param context The call context.
   * @param ref Parsed reference (a space is rejected).
   * @returns The node, or the failure.
   */
  containedNode(context: WikiCallContext, ref: WikiRef): Promise<WikiNode | WikiFailure>
  /**
   * Ask the topic owner on a consent card and wait.
   * @param sessionId The calling Session.
   * @param context The call context.
   * @param action What is asked for.
   * @param fields Card summary.
   * @param signal The tool call's abort signal.
   * @returns Undefined when allowed, else the failure.
   */
  consent(
    sessionId: string,
    context: WikiCallContext,
    action: WikiConsentAction,
    fields: WikiConsentFields,
    signal: AbortSignal,
  ): Promise<WikiFailure | undefined>
  /**
   * Read consent for one node: reuses the Session's standing grant, otherwise asks and records it.
   * @param sessionId The calling Session.
   * @param context The call context.
   * @param node The node to open.
   * @param signal The tool call's abort signal.
   * @returns Undefined when reading may proceed, else the failure.
   */
  readConsent(sessionId: string, context: WikiCallContext, node: WikiNode, signal: AbortSignal): Promise<WikiFailure | undefined>
  /**
   * Record a standing read grant (for a document the owner just approved creating).
   * @param sessionId The calling Session.
   * @param documentId The node's `objToken`.
   */
  grantRead(sessionId: string, documentId: string): void
  /**
   * `空间 / 父节点` label of a node.
   * @param api Wiki endpoints.
   * @param node The node.
   * @returns The label.
   */
  locationOf(api: WikiApi, node: WikiNode): Promise<string>
  /** Whether writes are switched on (`feishuTools.wikiWrite`). */
  writeEnabled(): boolean
  /**
   * Structured warning sink.
   * @param message Format string.
   * @param args Format arguments.
   */
  warn(message: string, ...args: unknown[]): void
}

/** One model-facing tool of a wiki tool family (the runtime adds output rendering and mounting). */
export interface WikiToolSpec {
  readonly name: string
  /** Switch that mounts it: `wikiRead` or `wikiWrite`. */
  readonly access: 'read' | 'write'
  readonly description: string
  readonly parameters: Record<string, unknown>
  /**
   * Run one call; never rejects for Feishu failures (they become failure values).
   * @param kit Gates and consent.
   * @param sessionId The calling Session.
   * @param rawArgs Model arguments (validated here).
   * @param signal The tool call's abort signal.
   * @returns The tool value.
   */
  execute(kit: WikiToolKit, sessionId: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<object>
  /**
   * One-line call presentation.
   * @param args Model arguments.
   * @returns Display text.
   */
  presentCall(args: Record<string, unknown>): string
}

/** Characters of each content shown on a consent card. */
export const PREVIEW_CHARS = 300

// ---- Results ------------------------------------------------------------

/** Stable failure codes; the readable `reason` carries the details. */
export type WikiFailureCode =
  | 'TOOL_DISABLED'
  | 'ROUTE_NOT_FOUND'
  | 'NOT_AUTHORIZED'
  | 'CHANNEL_UNAVAILABLE'
  | 'INVALID_REFERENCE'
  | 'INVALID_OPERATION'
  | 'OUTSIDE_ROOTS'
  | 'NOT_FOUND'
  | 'NO_ACCESS'
  | 'UNSUPPORTED_TYPE'
  | 'NOT_OWNED'
  | 'REVISION_CONFLICT'
  | 'CONSENT_DENIED'
  | 'CONSENT_EXPIRED'
  | 'CONSENT_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'CONTENT_FAILED'
  | 'EDIT_FAILED'
  | 'EDIT_PARTIAL'
  | 'API_FAILED'
  | 'ABORTED'

export const FAILURE_REASONS: Readonly<Record<WikiFailureCode, string>> = {
  TOOL_DISABLED: '知识库工具已在插件配置中关闭',
  ROUTE_NOT_FOUND: '当前会话没有绑定飞书话题，无法确定授权人',
  NOT_AUTHORIZED: '当前话题的发起人不在知识库白名单中；请管理员发送 /auth wiki add @该用户 后重试',
  CHANNEL_UNAVAILABLE: '飞书连接当前不可用，请稍后重试',
  INVALID_REFERENCE: '无法识别的知识库引用：请传知识库节点链接 https://<租户>.feishu.cn/wiki/<node_token>、node_token，或知识空间链接 https://<租户>.feishu.cn/wiki/space/<space_id>',
  INVALID_OPERATION: '操作参数不正确',
  OUTSIDE_ROOTS: '该位置不在插件配置的知识库范围（wikiRoots）内，不能访问',
  NOT_FOUND: '知识库节点不存在或已被删除',
  NO_ACCESS: '机器人对该知识库节点没有访问权限；请知识库管理员把应用（或包含机器人的群）加为该空间成员',
  UNSUPPORTED_TYPE: '这个工具不支持该类型的节点：飞书文档（docx）用 feishu_wiki_read / feishu_wiki_edit，电子表格（sheet）用 feishu_wiki_sheet_read / feishu_wiki_sheet_edit，多维表格（bitable）用 feishu_wiki_base_read / feishu_wiki_base_edit；其他类型暂不支持',
  NOT_OWNED: '只能修改由本应用创建（所有者是本应用）的文档',
  REVISION_CONFLICT: '文档在你读取之后被修改过；请重新用 feishu_wiki_read 读取最新内容，基于新的 revision_id 再修改',
  CONSENT_DENIED: '话题发起人拒绝了这次知识库操作',
  CONSENT_EXPIRED: '话题发起人没有在授权卡有效期内确认，已自动拒绝',
  CONSENT_UNAVAILABLE: '授权卡发送失败，无法征得话题发起人同意，已取消操作',
  PERMISSION_DENIED: '飞书拒绝调用：应用缺少知识库或文档权限（wiki:wiki、docx:document），请管理员在开发者后台开通并发布版本',
  CONTENT_FAILED: '文档已创建，但写入内容失败',
  EDIT_FAILED: '修改失败',
  EDIT_PARTIAL: '飞书报告操作只部分生效；已停止后续操作，请用 feishu_wiki_read 读取最新内容核验后再继续',
  API_FAILED: '飞书接口调用失败',
  ABORTED: '已取消',
}

/** One failed call. */
export interface WikiFailure {
  readonly ok: false
  readonly code: WikiFailureCode
  readonly reason: string
  /** Set by `CONTENT_FAILED`: the document that was created anyway. */
  readonly node_token?: string
  readonly url?: string
  /** Set by `EDIT_FAILED`/`EDIT_PARTIAL`: operations fully applied before the stop. */
  readonly applied?: number
  /** Set by `REVISION_CONFLICT`: the current revision. */
  readonly revision_id?: number
}

export function failure(code: WikiFailureCode, reason?: string): WikiFailure {
  return { ok: false, code, reason: reason ?? FAILURE_REASONS[code] }
}

export function parseArgs<T>(tool: string, schema: z.ZodType<T>, rawArgs: Record<string, unknown>): T {
  const parsed = schema.safeParse(rawArgs)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.')
  throw new Error(`${tool}: invalid ${where}: ${issue?.message ?? 'invalid arguments'}`)
}

/** Run one gated call body, mapping thrown Feishu errors to failures. */
export async function guarded<T>(
  deps: { warn(message: string, ...args: unknown[]): void },
  tool: string,
  body: () => Promise<T | WikiFailure>,
): Promise<T | WikiFailure> {
  try {
    return await body()
  } catch (error) {
    const mapped = failureOf(error)
    if (mapped.code === 'API_FAILED') deps.warn('dsh-channels: %s failed: %s', tool, mapped.reason)
    return mapped
  }
}

/** Feishu codes: node missing/deleted, no resource access, missing app scope. */
const NOT_FOUND_CODES: ReadonlySet<number> = new Set([131005, 131012, 131013, 131014, 131016])
const NO_ACCESS_CODES: ReadonlySet<number> = new Set([131006, 1770032, 1770002])
const PERMISSION_CODES: ReadonlySet<number> = new Set([99991672, 99991679])

export function failureOf(error: unknown): WikiFailure {
  const detail = describeError(error)
  if (error instanceof FeishuApiError && error.code !== undefined) {
    if (NOT_FOUND_CODES.has(error.code)) return failure('NOT_FOUND', `${FAILURE_REASONS.NOT_FOUND}（${detail}）`)
    if (NO_ACCESS_CODES.has(error.code)) return failure('NO_ACCESS', `${FAILURE_REASONS.NO_ACCESS}（${detail}）`)
    if (PERMISSION_CODES.has(error.code)) return failure('PERMISSION_DENIED', `${FAILURE_REASONS.PERMISSION_DENIED}（${detail}）`)
  }
  return failure('API_FAILED', `${FAILURE_REASONS.API_FAILED}：${detail}`)
}

export function consentFailure(outcome: WikiConsentOutcome): WikiFailure | undefined {
  switch (outcome) {
    case 'allowed': return undefined
    case 'denied': return failure('CONSENT_DENIED')
    case 'expired': return failure('CONSENT_EXPIRED')
    case 'cancelled': return failure('ABORTED')
    case 'unavailable': return failure('CONSENT_UNAVAILABLE')
  }
}

/** Whether the app owns a node: Feishu reports the bot open_id as the owner. */
export function ownedByApp(node: WikiNode, botOpenId: string | undefined): boolean {
  return botOpenId !== undefined && botOpenId !== '' && node.owner === botOpenId
}

/** A node's web link; falls back to the first root's origin. */
export function nodeUrl(roots: readonly WikiRoot[], node: WikiNode): string {
  if (node.url !== undefined) return node.url
  const first = roots[0]
  const origin = first === undefined ? 'https://feishu.cn' : new URL(first.link).origin
  return `${origin}/wiki/${node.nodeToken}`
}

/** One-line clipped preview with Markdown control characters neutralized. */
export function preview(value: string, max = 80): string {
  const flat = value.replace(/\s+/gu, ' ').trim().replace(/([[\]()*_`~<>])/gu, '\\$1')
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** A fenced preview of the first characters of a content. */
export function previewBlock(content: string): string {
  const head = content.length <= PREVIEW_CHARS ? content : `${content.slice(0, PREVIEW_CHARS)}\n…`
  return `\`\`\`\n${head.replace(/```/gu, '`​``')}\n\`\`\``
}

export function display(value: unknown): string {
  return typeof value === 'string' ? preview(value, 120) : '?'
}

/** Readable, bounded text for a thrown value. */
export function describeError(error: unknown): string {
  const text = error instanceof FeishuApiError ? error.detail : error instanceof Error ? error.message : String(error)
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return cleaned.length <= 300 ? cleaned : `${cleaned.slice(0, 300)}…`
}
