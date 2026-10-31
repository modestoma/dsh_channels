/**
 * Web 设置面板的 HTTP 路由：DSH `/api` 下的精确 Fetch 路由
 * `/api/dsh-channels.<方法>`（读用 GET，写一律 POST）。
 *
 * 路由注册进宿主 `connection.fetch`（headless profile 没有它时面板自然不存在，
 * 飞书通道不受影响）。DSH 的 `/api` 路由先做 Host/Origin 校验和浏览器登录
 * cookie 鉴权，只有通过的 owner 请求才会到达这里，未通过时由 DSH 直接返回
 * 401 / 403。凭据值只走写路径，响应永远不包含它们。`catalog` 只读宿主
 * LLM / preset roster 的枚举结果，用于面板的 provider → model → 推理档位
 * 级联选择。`access` 提供准入快照与白名单/授权申请的写入口（与飞书卡片共用
 * 同一结算函数）。
 *
 * @module dsh-channels/settings/routes
 */

import type { HostContext } from '../dsh-types.ts'
import {
  ACCESS_ROUTE,
  ADD_ACCESS_GROUP_ROUTE,
  ADD_ACCESS_USER_ROUTE,
  ADD_WIKI_USER_ROUTE,
  CATALOG_ROUTE,
  CLEAR_CONFIG_ROUTE,
  CLEAR_CREDENTIAL_ROUTE,
  PANEL_ROUTE,
  PICK_DIRECTORY_ROUTE,
  PROFILES_MAX_IDS,
  PROFILES_ROUTE,
  RECONNECT_ROUTE,
  TAKEOVER_ROUTE,
  REMOVE_ACCESS_GROUP_ROUTE,
  REMOVE_ACCESS_USER_ROUTE,
  REMOVE_WIKI_USER_ROUTE,
  RESOLVE_ACCESS_REQUEST_ROUTE,
  SAVE_CONFIG_ROUTE,
  SAVE_CREDENTIALS_ROUTE,
  SESSION_ORIGIN_ROUTE,
  STATUS_ROUTE,
} from './contract.ts'
import type {
  CredentialField,
  EditableValues,
  PickDirectoryResponse,
  SaveCredentialsRequest,
} from './contract.ts'
import type { SettingsSurface } from './surface.ts'

/** One exact route on DSH's authenticated `/api` channel. */
export interface HostFetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * The narrow `ctx.connection` surface this module registers into. DSH applies
 * its Host/Origin fence and login-cookie authentication before `fetch` runs.
 */
export interface HostConnection {
  readonly fetch: {
    /**
     * @param route - exact path, methods, and handler.
     * @returns asynchronous disposer removing the route.
     */
    register(route: HostFetchRoute): () => Promise<void>
  }
}

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

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Parse a JSON-object body; malformed bodies throw {@link HttpError} (415/413/400). */
async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, '请求体必须是 application/json')
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
  if (text === '') throw new HttpError(400, '请求体为空')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

/** Distinct non-empty entries of one comma-separated id query parameter. */
function idList(raw: string | null): string[] {
  if (raw === null) return []
  return [...new Set(raw.split(',').map(id => id.trim()).filter(id => id !== ''))]
}

/** A write's answer: 200 on success, 400 for a refusal the body explains. */
function result(outcome: { ok: boolean }): Response {
  return json(outcome.ok ? 200 : 400, outcome)
}

/** Turn thrown errors into JSON answers instead of a dropped request. */
function answered(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { ok: false, error: error.message })
      return json(500, { ok: false, error: `内部错误：${messageOf(error)}` })
    }
  }
}

/**
 * Register the panel routes.
 * @param connection - the host `connection` service.
 * @param surface - the panel's business side.
 * @returns disposer removing every route.
 */
export function registerSettingsRoutes(connection: HostConnection, surface: SettingsSurface): () => void {
  const get = (path: string, handler: (url: URL) => Promise<Response>): HostFetchRoute => ({
    path, methods: ['GET'], requestBody: 'buffered', fetch: answered(request => handler(new URL(request.url))),
  })
  const post = (path: string, handler: (request: Request) => Promise<Response>): HostFetchRoute => ({
    path, methods: ['POST'], requestBody: 'buffered', fetch: answered(handler),
  })
  const routes: HostFetchRoute[] = [
    get(STATUS_ROUTE, async () => json(200, await surface.status())),
    get(PANEL_ROUTE, async () => json(200, await surface.panel())),
    get(CATALOG_ROUTE, async url => json(200, await surface.catalogFor(
      url.searchParams.get('provider') ?? undefined,
      url.searchParams.get('model') ?? undefined,
    ))),
    get(SESSION_ORIGIN_ROUTE, async (url) => {
      const sessionId = url.searchParams.get('sessionId')?.trim()
      if (sessionId === undefined || sessionId === '') return json(400, { ok: false, error: '缺少 sessionId 参数' })
      return json(200, await surface.sessionOrigin(sessionId))
    }),
    get(PROFILES_ROUTE, async (url) => {
      const userIds = idList(url.searchParams.get('users'))
      const chatIds = idList(url.searchParams.get('chats'))
      if (userIds.length > PROFILES_MAX_IDS || chatIds.length > PROFILES_MAX_IDS) {
        return json(400, { ok: false, error: `每次最多查询 ${PROFILES_MAX_IDS} 个用户和 ${PROFILES_MAX_IDS} 个群` })
      }
      return json(200, await surface.feishuProfiles(userIds, chatIds))
    }),
    get(ACCESS_ROUTE, async () => json(200, await surface.access())),
    post(SAVE_CONFIG_ROUTE, async (request) => {
      const values = (await readJsonObject(request)).values
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        return json(400, { ok: false, error: '请求体缺少 values 对象' })
      }
      return result(await surface.save(values as EditableValues))
    }),
    post(CLEAR_CONFIG_ROUTE, async () => result(await surface.clear())),
    post(SAVE_CREDENTIALS_ROUTE, async (request) => {
      const payload = await readJsonObject(request)
      const values: SaveCredentialsRequest = {}
      if (payload.appId !== undefined) values.appId = payload.appId as string
      if (payload.appSecret !== undefined) values.appSecret = payload.appSecret as string
      return result(await surface.saveCredentials(values))
    }),
    post(CLEAR_CREDENTIAL_ROUTE, async (request) => {
      const field = (await readJsonObject(request)).field
      if (field !== 'appId' && field !== 'appSecret') {
        return json(400, { ok: false, error: 'field 必须是 appId 或 appSecret' })
      }
      return result(await surface.clearCredential(field as CredentialField))
    }),
    post(RECONNECT_ROUTE, async () => {
      const outcome = await surface.reconnect()
      // An incomplete configuration is a client-side state (the panel routes
      // the user to the credentials form), not a server failure.
      return json(outcome.ok ? 200 : (outcome.unconfigured === true ? 400 : 500), outcome)
    }),
    post(TAKEOVER_ROUTE, async () => {
      const outcome = await surface.takeover()
      return json(outcome.ok ? 200 : (outcome.unconfigured === true ? 400 : 500), outcome)
    }),
    post(PICK_DIRECTORY_ROUTE, async (request) => {
      // The chooser is a local desktop modal that can stay open far longer
      // than a normal request; DSH aborts `request.signal` when the browser
      // drops the request, which closes the host picker with it.
      const path = await surface.pickDirectory(request.signal)
      const payload: PickDirectoryResponse = path === null ? { ok: true, canceled: true } : { ok: true, path }
      return json(200, payload)
    }),
    post(ADD_ACCESS_GROUP_ROUTE, async (request) => {
      const payload = await readJsonObject(request)
      return result(await surface.saveAccessGroup(payload.chatId, payload.name))
    }),
    post(REMOVE_ACCESS_GROUP_ROUTE, async request => result(await surface.removeAccessGroup((await readJsonObject(request)).chatId))),
    post(ADD_ACCESS_USER_ROUTE, async (request) => {
      const payload = await readJsonObject(request)
      return result(await surface.saveAccessUser(payload.userId, payload.name))
    }),
    post(REMOVE_ACCESS_USER_ROUTE, async request => result(await surface.removeAccessUser((await readJsonObject(request)).userId))),
    post(ADD_WIKI_USER_ROUTE, async (request) => {
      const payload = await readJsonObject(request)
      return result(await surface.saveWikiUser(payload.userId, payload.name))
    }),
    post(REMOVE_WIKI_USER_ROUTE, async request => result(await surface.removeWikiUser((await readJsonObject(request)).userId))),
    post(RESOLVE_ACCESS_REQUEST_ROUTE, async (request) => {
      const payload = await readJsonObject(request)
      return result(await surface.resolveAccessRequest(payload.token, payload.decision))
    }),
  ]
  const disposers = routes.map(route => connection.fetch.register(route))
  return () => {
    for (const dispose of disposers) {
      void dispose().catch(() => {
        // The route is already gone when the host connection was disposed first.
      })
    }
  }
}

/**
 * Mount the routes once the host carries the `connection` service. The
 * optional `ctx.inject` keeps headless profiles from waiting on a service
 * they will never have; embedded/test hosts that resolve services
 * synchronously fall back to the direct attach path.
 * @param ctx - the plugin context.
 * @param surface - the panel's business side.
 */
export function mountSettingsRoutes(ctx: HostContext, surface: SettingsSurface): void {
  const attach = (connectionCtx: HostContext): void => {
    const connection = connectionCtx.get?.('connection') as HostConnection | undefined
    if (connection?.fetch === undefined) return
    connectionCtx.effect(
      () => registerSettingsRoutes(connection, surface),
      'dsh-channels: settings panel routes',
    )
  }
  const inject = (ctx as {
    inject?: (dependencies: string[], callback: (child: HostContext) => void) => unknown
  }).inject
  if (typeof inject === 'function') {
    inject.call(ctx, ['connection'], attach)
    return
  }
  attach(ctx)
}
