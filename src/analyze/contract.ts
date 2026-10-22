/**
 * Wire contract of the log-platform analyze API.
 *
 * `POST /dsh-channels/analyze` on the dedicated `analyzeListen` port, with
 * `Authorization: Bearer <token>`, an `Idempotency-Key` header, and a JSON
 * body naming the requester, the subject (application + error code), the
 * target group, and the prompt. A valid request posts a placeholder card into
 * the group and answers `202`; the analysis then runs in the background and
 * patches the card into its result. Log packages are the prompt's business:
 * the analysis skill fetches whatever the prompt names.
 *
 * @module dsh-channels/analyze/contract
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEISHU_USER_ID_PATTERN } from '../domain.ts'

/** The only path the analyze listener serves. */
export const ANALYZE_ROUTE = '/dsh-channels/analyze'

/** Largest accepted request body (the prompt dominates it). */
export const ANALYZE_MAX_BODY_BYTES = 1024 * 1024

/** Largest accepted prompt, in characters. */
export const ANALYZE_MAX_PROMPT_CHARS = 100_000

/**
 * `Idempotency-Key` format: 1–200 visible ASCII characters without spaces, so
 * a platform can use a UUID or its own `type:id` token.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,200}$/u

/**
 * Application / error-code segment: it names a workspace directory
 * (`<baseDir>/analyze/<app>/<errorCode>`), so only path-safe characters pass.
 */
const SUBJECT_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/u

/** Feishu group chat id (`oc_…`). */
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/u

/** JSON body of one analyze request. */
export const analyzeRequestSchema = z.object({
  /** Feishu user_id of the person who started the analysis on the platform. */
  requesterUserId: z.string().regex(FEISHU_USER_ID_PATTERN, 'must be a Feishu user_id').max(128),
  /** Application the logs belong to (workspace directory segment). */
  app: z.string().regex(SUBJECT_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -'),
  /** Error code of the logs (workspace directory segment). */
  errorCode: z.string().regex(SUBJECT_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -'),
  /** Target group chat (`oc_…`); must be an authorized group. */
  chatId: z.string().regex(CHAT_ID, 'must be a Feishu group chat_id (oc_...)'),
  /** Prompt forwarded verbatim as the analysis Session's first user message. */
  prompt: z.string().min(1).max(ANALYZE_MAX_PROMPT_CHARS)
    .refine(value => value.trim() !== '', 'must not be blank'),
}).strict()

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>

/** Body of an accepted (or replayed) request. */
export interface AnalyzeAccepted {
  readonly ok: true
  /** Target group chat id. */
  readonly chatId: string
  /** Placeholder card message id; the analysis topic hangs below it. */
  readonly messageId: string
  /**
   * Feishu applink opening the target group, positioned at the placeholder
   * when Feishu reported its `message_position`.
   */
  readonly link: string
}

/** Body of a refused request. */
export interface AnalyzeRefused {
  readonly ok: false
  /** Readable reason (Chinese, shown to platform operators). */
  readonly error: string
}

/** One HTTP answer of the analyze handler. */
export interface AnalyzeResponse {
  readonly status: number
  readonly body: AnalyzeAccepted | AnalyzeRefused
}

/**
 * Applink that opens one group chat in the Feishu client, optionally at one
 * message position.
 * @param chatId - group chat id.
 * @param position - the message's `message_position`, when known.
 * @returns the `applink.feishu.cn` chat link.
 */
export function chatApplink(chatId: string, position?: string): string {
  const base = `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
  return position === undefined ? base : `${base}&position=${encodeURIComponent(position)}`
}

/**
 * Fingerprint of one validated request, used to tell a retry of the same
 * request from a reused `Idempotency-Key`. Field order is fixed.
 * @param request - the validated request.
 * @returns SHA-256 hex digest.
 */
export function analyzeRequestHash(request: AnalyzeRequest): string {
  const canonical = JSON.stringify([
    request.requesterUserId, request.app, request.errorCode, request.chatId, request.prompt,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Validate one decoded JSON body.
 * @param raw - the decoded body.
 * @returns the request, or a readable list of field errors.
 */
export function parseAnalyzeRequest(raw: unknown): { ok: true; value: AnalyzeRequest } | { ok: false; error: string } {
  const parsed = analyzeRequestSchema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const details = parsed.error.issues
    .map(issue => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ')
  return { ok: false, error: `请求参数不合法：${details}` }
}
