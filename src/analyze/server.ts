/**
 * The analyze API's HTTP route on the DSH Web server.
 *
 * Registers the exact route `POST /api/dsh-channels.logalyze` (see
 * `./contract.ts`) on the host `webServer`; hosts without one (headless) have
 * no analyze API. This module owns the transport-level checks, in order:
 * path, the `analyzeEnabled` switch, method, bearer token, `Idempotency-Key`,
 * media type, body size, and JSON validation; everything after validation
 * belongs to the {@link AnalyzeHandler}. Bodies, tokens, and prompts are never
 * logged.
 *
 * @module dsh-channels/analyze/server
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext } from '../dsh-types.ts'
import type { HostWebServer } from '../settings/routes.ts'
import {
  ANALYZE_MAX_BODY_BYTES, ANALYZE_ROUTE, IDEMPOTENCY_KEY_PATTERN, parseAnalyzeRequest,
} from './contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from './contract.ts'

/** The business side of the route. */
export interface AnalyzeHandler {
  /**
   * Whether the API is switched on (`analyzeEnabled`), read per request.
   * @returns false to answer every request with 404.
   */
  enabled(): boolean
  /**
   * Resolve the expected bearer token for this request.
   * @returns the token, or undefined when it is not configured.
   */
  token(): Promise<string | undefined>
  /**
   * Accept one validated request.
   * @param request - the validated body.
   * @param idempotencyKey - the request's `Idempotency-Key`.
   * @returns the HTTP answer.
   */
  analyze(request: AnalyzeRequest, idempotencyKey: string): Promise<AnalyzeResponse>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function send(res: ServerResponse, response: AnalyzeResponse): void {
  const body = JSON.stringify(response.body)
  res.writeHead(response.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function refuse(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  send(res, { status, body: { ok: false, error } })
}

/** Constant-time token comparison over fixed-length digests. */
function tokenMatches(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

/** The bearer credential of one request, or undefined. */
function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (header === undefined) return undefined
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/iu.exec(header)
  return match?.[1]
}

/** Read the body up to {@link ANALYZE_MAX_BODY_BYTES}; larger bodies fail with 413. */
async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > ANALYZE_MAX_BODY_BYTES) {
    throw new HttpError(413, `请求体超过 ${ANALYZE_MAX_BODY_BYTES} 字节`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > ANALYZE_MAX_BODY_BYTES) throw new HttpError(413, `请求体超过 ${ANALYZE_MAX_BODY_BYTES} 字节`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Handle one HTTP request against the analyze contract.
 * @param req - the incoming request.
 * @param res - its response.
 * @param handler - the business side.
 */
export async function handleAnalyzeHttp(
  req: IncomingMessage,
  res: ServerResponse,
  handler: AnalyzeHandler,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://analyze.invalid').pathname
  if (pathname !== ANALYZE_ROUTE) {
    refuse(res, 404, '未知路径')
    return
  }
  if (!handler.enabled()) {
    refuse(res, 404, '日志分析接口未开启，请在设置面板「高级 → 日志分析接口」打开开关')
    return
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    refuse(res, 405, '只接受 POST', { allow: 'POST' })
    return
  }
  const expected = await handler.token()
  if (expected === undefined || expected === '') {
    refuse(res, 503, '分析接口未配置访问令牌，请联系部署者配置 analyzeToken 引用的凭据')
    return
  }
  const presented = bearerOf(req)
  if (presented === undefined || !tokenMatches(presented, expected)) {
    refuse(res, 401, '访问令牌无效', { 'www-authenticate': 'Bearer' })
    return
  }
  const idempotencyKey = req.headers['idempotency-key']
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    refuse(res, 400, '缺少或不合法的 Idempotency-Key 请求头（1-200 个可见 ASCII 字符）')
    return
  }
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    refuse(res, 415, 'Content-Type 必须是 application/json')
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readBody(req))
  } catch (error) {
    if (error instanceof HttpError) {
      refuse(res, error.status, error.message)
      return
    }
    refuse(res, 400, '请求体不是合法的 JSON')
    return
  }
  const parsed = parseAnalyzeRequest(raw)
  if (!parsed.ok) {
    refuse(res, 400, parsed.error)
    return
  }
  send(res, await handler.analyze(parsed.value, idempotencyKey))
}

/**
 * Register the analyze route on the host Web server once it is available.
 * Requests skip the DSH login gate on purpose: the bearer token is this API's
 * only credential.
 * @param ctx - the plugin context.
 * @param handler - the business side.
 * @param warn - diagnostics sink for unexpected handler failures.
 */
export function mountAnalyzeRoute(
  ctx: HostContext,
  handler: AnalyzeHandler,
  warn: (message: string, ...args: unknown[]) => void,
): void {
  const attach = (webCtx: HostContext): void => {
    const server = webCtx.get?.('webServer') as HostWebServer | undefined
    if (server === undefined) return
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: ANALYZE_ROUTE,
      handler: async (req, res) => {
        try {
          await handleAnalyzeHttp(req, res, handler)
        } catch (error) {
          warn('dsh-channels: analyze request failed: %s', String(error))
          if (!res.headersSent) refuse(res, 500, `分析请求处理失败：${String(error)}`)
          else res.destroy()
        }
      },
    }), 'dsh-channels: analyze route')
  }
  const inject = (ctx as {
    inject?: (dependencies: string[], callback: (child: HostContext) => void) => unknown
  }).inject
  if (typeof inject === 'function') {
    inject.call(ctx, ['webServer'], attach)
    return
  }
  attach(ctx)
}
