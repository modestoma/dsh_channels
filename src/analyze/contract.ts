/**
 * Wire contract of the log-platform analyze API.
 *
 * `POST /dsh-channels/analyze` on the dedicated `analyzeListen` port, with
 * `Authorization: Bearer <token>`, an `Idempotency-Key` header, and a JSON
 * body naming the requester, the trigger time, the subject (application +
 * error code), the log-platform detail pages, the target group, and the
 * prompt. A valid request posts the analysis root card into the group and
 * answers `202`; the analysis then streams in a topic below that card. Log
 * packages are the prompt's business: the analysis skill fetches whatever the
 * prompt names, and the detail pages are only listed on the card.
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

/** Most detail pages one request may list on its root card. */
export const ANALYZE_MAX_LOG_DETAILS = 50

/** Feishu group chat id (`oc_…`). */
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/u

/** JSON body of one analyze request. */
export const analyzeRequestSchema = z.object({
  /** Feishu user_id of the person who started the analysis on the platform. */
  requesterUserId: z.string().regex(FEISHU_USER_ID_PATTERN, 'must be a Feishu user_id').max(128),
  /** When the analysis was started on the platform, shown verbatim on the root card. */
  triggeredAt: z.string().min(1).max(64).refine(value => value.trim() !== '', 'must not be blank'),
  /** Application the logs belong to (workspace directory segment). */
  app: z.string().regex(SUBJECT_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -'),
  /** Error code of the logs (workspace directory segment). */
  errorCode: z.string().regex(SUBJECT_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -'),
  /** Log-platform detail pages of the logs that triggered the analysis (listed on the root card). */
  logDetails: z.array(z.object({
    /** Row label. */
    name: z.string().min(1).max(200).refine(value => value.trim() !== '', 'must not be blank'),
    /** Detail page address. */
    url: z.url({ protocol: /^https?$/u, error: 'must be an http(s) URL' }).max(2048),
  }).strict()).min(1).max(ANALYZE_MAX_LOG_DETAILS),
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
  /** Root card message id; the analysis topic hangs below it. */
  readonly messageId: string
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
 * Fingerprint of one validated request, used to tell a retry of the same
 * request from a reused `Idempotency-Key`. Field order is fixed.
 * @param request - the validated request.
 * @returns SHA-256 hex digest.
 */
export function analyzeRequestHash(request: AnalyzeRequest): string {
  const canonical = JSON.stringify([
    request.requesterUserId, request.triggeredAt, request.app, request.errorCode,
    request.logDetails.map(detail => [detail.name, detail.url]), request.chatId, request.prompt,
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
