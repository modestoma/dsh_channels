/**
 * Web 设置面板的 HTTP 路由：status / panel / catalog / config(PUT,DELETE) /
 * credentials(PUT,DELETE) / reconnect / cleanup / access。
 *
 * 路由注册进宿主可选的 `webServer` 服务（headless profile 没有它时面板自然
 * 不存在，飞书通道不受影响）。写操作额外做同源校验 —— 本机非回环绑定下
 * 防止跨站页面改写插件配置或授权白名单；读取不敏感，保持只读 GET。凭据值
 * 只走写路径，响应永远不包含它们。`catalog` 只读宿主 LLM / preset roster 的
 * 枚举结果，用于面板的 provider → model → 推理档位级联选择。`access` 提供
 * 准入快照与白名单/授权申请的写入口（与飞书卡片共用同一结算函数）。
 *
 * @module dsh-channels/settings/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext } from '../dsh-types.ts'
import {
  ACCESS_GROUPS_ROUTE,
  ACCESS_REQUESTS_ROUTE,
  ACCESS_ROUTE,
  ACCESS_USERS_ROUTE,
  CATALOG_ROUTE,
  CLEANUP_ROUTE,
  CONFIG_ROUTE,
  CREDENTIALS_ROUTE,
  PANEL_ROUTE,
  RECONNECT_ROUTE,
  STATUS_ROUTE,
} from './contract.ts'
import type { CredentialField, EditableValues, SaveCredentialsRequest } from './contract.ts'
import type { SettingsSurface } from './surface.ts'

/** The narrow `ctx.webServer` surface this module registers into. */
export interface HostWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

type WebHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Request body cap: the panel payload is a handful of primitives. */
const MAX_BODY_BYTES = 64 * 1024

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function methodOf(req: IncomingMessage): string {
  return (req.method ?? 'GET').toUpperCase()
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Reject non-allowed methods with 405 + Allow, returning false. */
function allowOnly(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean {
  const method = methodOf(req)
  if (allowed.includes(method)) return true
  const body = JSON.stringify({ ok: false, error: `方法 ${method} 不受支持` })
  res.writeHead(405, {
    allow: allowed.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
  return false
}

/**
 * Mutating requests must come from this same origin. Missing Origin is allowed
 * (non-browser local clients, e.g. curl); a present-but-mismatched Origin is
 * a cross-site write and is refused.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new HttpError(415, '请求体必须是 application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, '请求体为空')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

/**
 * Parse one JSON-object body for an access write. HttpErrors are answered
 * here (415/413/400); `undefined` means "already responded, stop".
 */
async function readAccessBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: error.message })
      return undefined
    }
    throw error
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
    return undefined
  }
  return body as Record<string, unknown>
}

/** Wrap a handler so thrown errors become JSON instead of a dropped socket. */
function guarded(handler: WebHandler): WebHandler {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      const status = error instanceof HttpError ? error.status : 500
      sendJson(res, status, {
        ok: false,
        error: error instanceof HttpError ? error.message : `内部错误：${messageOf(error)}`,
      })
    }
  }
}

function forbiddenWrite(res: ServerResponse): void {
  sendJson(res, 403, { ok: false, error: '跨站写入被拒绝（Origin 与 Host 不一致）' })
}

/** Register the panel routes; the returned disposer removes all of them. */
export function registerSettingsRoutes(server: HostWebServer, surface: SettingsSurface): () => void {
  const disposers = [
    server.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['GET', 'HEAD'])) return
        if (methodOf(req) === 'HEAD') {
          res.writeHead(200, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, await surface.status())
      }),
    }),
    server.register({
      kind: 'exact',
      path: PANEL_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['GET', 'HEAD'])) return
        if (methodOf(req) === 'HEAD') {
          res.writeHead(200, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, await surface.panel())
      }),
    }),
    server.register({
      kind: 'exact',
      path: CATALOG_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['GET', 'HEAD'])) return
        if (methodOf(req) === 'HEAD') {
          res.writeHead(200, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        sendJson(res, 200, await surface.catalogFor(
          url.searchParams.get('provider') ?? undefined,
          url.searchParams.get('model') ?? undefined,
        ))
      }),
    }),
    server.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['PUT', 'DELETE'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        if (methodOf(req) === 'DELETE') {
          const result = await surface.clear()
          sendJson(res, result.ok ? 200 : 400, result)
          return
        }
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch (error) {
          if (error instanceof HttpError) {
            sendJson(res, error.status, { ok: false, error: error.message })
            return
          }
          throw error
        }
        const values = (body as { values?: unknown } | null)?.values
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
          sendJson(res, 400, { ok: false, error: '请求体缺少 values 对象' })
          return
        }
        const result = await surface.save(values as EditableValues)
        sendJson(res, result.ok ? 200 : 400, result)
      }),
    }),
    server.register({
      kind: 'exact',
      path: CREDENTIALS_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['PUT', 'DELETE'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch (error) {
          if (error instanceof HttpError) {
            sendJson(res, error.status, { ok: false, error: error.message })
            return
          }
          throw error
        }
        const payload = body as { appId?: unknown; appSecret?: unknown; field?: unknown } | null
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
          return
        }
        if (methodOf(req) === 'DELETE') {
          const field = payload.field
          if (field !== 'appId' && field !== 'appSecret') {
            sendJson(res, 400, { ok: false, error: 'field 必须是 appId 或 appSecret' })
            return
          }
          const result = await surface.clearCredential(field as CredentialField)
          sendJson(res, result.ok ? 200 : 400, result)
          return
        }
        const values: SaveCredentialsRequest = {}
        if (payload.appId !== undefined) values.appId = payload.appId as string
        if (payload.appSecret !== undefined) values.appSecret = payload.appSecret as string
        const result = await surface.saveCredentials(values)
        sendJson(res, result.ok ? 200 : 400, result)
      }),
    }),
    server.register({
      kind: 'exact',
      path: RECONNECT_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['POST'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        const result = await surface.reconnect()
        sendJson(res, result.ok ? 200 : 500, result)
      }),
    }),
    server.register({
      kind: 'exact',
      path: CLEANUP_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['POST'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        const result = await surface.runCleanup()
        sendJson(res, result.ok ? 200 : 500, result)
      }),
    }),
    server.register({
      kind: 'exact',
      path: ACCESS_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['GET', 'HEAD'])) return
        if (methodOf(req) === 'HEAD') {
          res.writeHead(200, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, await surface.access())
      }),
    }),
    server.register({
      kind: 'exact',
      path: ACCESS_GROUPS_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['POST', 'DELETE'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        const payload = await readAccessBody(req, res)
        if (payload === undefined) return
        const result = methodOf(req) === 'DELETE'
          ? await surface.removeAccessGroup(payload.chatId)
          : await surface.saveAccessGroup(payload.chatId, payload.name)
        sendJson(res, result.ok ? 200 : 400, result)
      }),
    }),
    server.register({
      kind: 'exact',
      path: ACCESS_USERS_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['POST', 'DELETE'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        const payload = await readAccessBody(req, res)
        if (payload === undefined) return
        const result = methodOf(req) === 'DELETE'
          ? await surface.removeAccessUser(payload.openId)
          : await surface.saveAccessUser(payload.openId, payload.name)
        sendJson(res, result.ok ? 200 : 400, result)
      }),
    }),
    server.register({
      kind: 'exact',
      path: ACCESS_REQUESTS_ROUTE,
      handler: guarded(async (req, res) => {
        if (!allowOnly(req, res, ['POST'])) return
        if (!isSameOriginRequest(req)) {
          forbiddenWrite(res)
          return
        }
        const payload = await readAccessBody(req, res)
        if (payload === undefined) return
        const result = await surface.resolveAccessRequest(payload.token, payload.decision)
        sendJson(res, result.ok ? 200 : 400, result)
      }),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Mount the routes once the host carries a Web server. The optional
 * `ctx.inject` keeps headless profiles from waiting on a service they will
 * never have; embedded/test hosts that resolve services synchronously fall
 * back to the direct attach path.
 */
export function mountSettingsRoutes(ctx: HostContext, surface: SettingsSurface): void {
  const attach = (webCtx: HostContext): void => {
    const server = webCtx.get?.('webServer') as HostWebServer | undefined
    if (server === undefined) return
    webCtx.effect(
      () => registerSettingsRoutes(server, surface),
      'dsh-channels: settings panel routes',
    )
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
