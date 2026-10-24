/**
 * Same-origin HTTP client for the settings panel. No typert contract: the
 * Host half registers plain exact routes and this module fetches them.
 *
 * @module dsh-channels/client/api
 */

import {
  ACCESS_GROUPS_ROUTE,
  ACCESS_REQUESTS_ROUTE,
  ACCESS_ROUTE,
  ACCESS_USERS_ROUTE,
  ACCESS_WIKI_USERS_ROUTE,
  CATALOG_ROUTE,
  CONFIG_ROUTE,
  CREDENTIALS_ROUTE,
  PANEL_ROUTE,
  PICK_DIRECTORY_ROUTE,
  PROFILES_ROUTE,
  RECONNECT_ROUTE,
  SESSION_ORIGIN_ROUTE,
  STATUS_ROUTE,
} from '../settings/contract.ts'
import type {
  AccessMutationResponse,
  AccessWire,
  CatalogWire,
  ChannelStatusWire,
  ClearConfigResponse,
  ClearCredentialResponse,
  CredentialField,
  EditableValues,
  FeishuProfilesWire,
  PanelWire,
  PickDirectoryResponse,
  ReconnectResponse,
  SaveConfigResponse,
  SaveCredentialsRequest,
  SaveCredentialsResponse,
  SessionOriginResponse,
} from '../settings/contract.ts'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Pull the JSON `error` field out of a failed response body. */
function errorFromBody(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error
  } catch {
    // Not JSON — fall through to the HTTP status.
  }
  return `HTTP ${status}`
}

/**
 * Fetch one Host route. Routes are registered as absolute pathnames, but the
 * browser addresses them relative to the DSH document (`<base href="./">`), so
 * a reverse proxy that mounts DSH under a prefix such as `/dsh/` still routes
 * them to DSH with the login cookie it scoped to that prefix.
 */
async function request(route: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(route.slice(1), {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (error) {
    throw new Error(`无法连接设置接口：${messageOf(error)}`)
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw new Error(errorFromBody(response.status, text))
  return JSON.parse(text) as T
}

/** Full panel payload (status + editable config + read-only facts). */
export async function fetchPanel(): Promise<PanelWire> {
  return readJson<PanelWire>(await request(PANEL_ROUTE))
}

/** Status-only payload polled while the page is open. */
export async function fetchStatus(): Promise<ChannelStatusWire> {
  return readJson<ChannelStatusWire>(await request(STATUS_ROUTE))
}

/** Feishu origin of one Session (`origin: null` when Feishu never routed it). */
export async function fetchSessionOrigin(sessionId: string): Promise<SessionOriginResponse> {
  const query = new URLSearchParams({ sessionId }).toString()
  return readJson<SessionOriginResponse>(await request(`${SESSION_ORIGIN_ROUTE}?${query}`))
}

/**
 * Live Feishu names and avatars of the given users and chats.
 * @param userIds - user `user_id`s.
 * @param chatIds - chat `chat_id`s.
 * @returns the profiles Feishu resolved, by id.
 */
export async function fetchFeishuProfiles(userIds: readonly string[], chatIds: readonly string[]): Promise<FeishuProfilesWire> {
  const query = new URLSearchParams({ users: userIds.join(','), chats: chatIds.join(',') }).toString()
  return readJson<FeishuProfilesWire>(await request(`${PROFILES_ROUTE}?${query}`))
}

/**
 * Model-selector catalog for one route: providers, the provider's models, the
 * model's reasoning efforts, and the preset roster. The client re-queries it
 * whenever the draft provider/model changes.
 */
export async function fetchCatalog(provider?: string, model?: string): Promise<CatalogWire> {
  const params = new URLSearchParams()
  if (provider !== undefined && provider !== '') params.set('provider', provider)
  if (model !== undefined && model !== '') params.set('model', model)
  const query = params.toString()
  return readJson<CatalogWire>(await request(query === '' ? CATALOG_ROUTE : `${CATALOG_ROUTE}?${query}`))
}

/** Persist a partial edit. Validation failures come back as `{ok:false}`. */
export async function saveConfig(values: EditableValues): Promise<SaveConfigResponse> {
  const response = await request(CONFIG_ROUTE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  const text = await response.text()
  if (response.status === 400) {
    // Validation/IO refusal: the body is already the SaveConfigResponse.
    try {
      return JSON.parse(text) as SaveConfigResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  if (!response.ok) throw new Error(errorFromBody(response.status, text))
  return JSON.parse(text) as SaveConfigResponse
}

/** Drop every Web override and return the refreshed panel. */
export async function clearConfig(): Promise<ClearConfigResponse> {
  const response = await request(CONFIG_ROUTE, { method: 'DELETE' })
  const text = await response.text()
  if (response.status === 400) {
    try {
      return JSON.parse(text) as ClearConfigResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  if (!response.ok) throw new Error(errorFromBody(response.status, text))
  return JSON.parse(text) as ClearConfigResponse
}

/** Reopen the Feishu long connection (interrupts in-flight replies). */
export async function reconnect(): Promise<ReconnectResponse> {
  const response = await request(RECONNECT_ROUTE, { method: 'POST' })
  const text = await response.text()
  if (!response.ok) {
    try {
      return JSON.parse(text) as ReconnectResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  return JSON.parse(text) as ReconnectResponse
}

/**
 * Ask the Host to open its native directory chooser (the panel's「选择目录…」
 * button). The request stays open while the OS dialog does; a cancel comes back
 * as `{ ok: true, canceled: true }`, not as an error.
 */
export async function pickDirectory(): Promise<PickDirectoryResponse> {
  const response = await request(PICK_DIRECTORY_ROUTE, { method: 'POST' })
  const text = await response.text()
  if (!response.ok) {
    try {
      return JSON.parse(text) as PickDirectoryResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  return JSON.parse(text) as PickDirectoryResponse
}

/** Store provided credential values (the request/response never carry stored values). */
export async function saveCredentials(values: SaveCredentialsRequest): Promise<SaveCredentialsResponse> {
  const response = await request(CREDENTIALS_ROUTE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  })
  const text = await response.text()
  if (response.status === 400) {
    try {
      return JSON.parse(text) as SaveCredentialsResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  if (!response.ok) throw new Error(errorFromBody(response.status, text))
  return JSON.parse(text) as SaveCredentialsResponse
}

/** Remove the stored value behind one credential reference. */
export async function clearCredential(field: CredentialField): Promise<ClearCredentialResponse> {
  const response = await request(CREDENTIALS_ROUTE, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ field }),
  })
  const text = await response.text()
  if (response.status === 400) {
    try {
      return JSON.parse(text) as ClearCredentialResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  if (!response.ok) throw new Error(errorFromBody(response.status, text))
  return JSON.parse(text) as ClearCredentialResponse
}

/** Admission snapshot: mode, administrator, whitelists, pending requests. */
export async function fetchAccess(): Promise<AccessWire> {
  return readJson<AccessWire>(await request(ACCESS_ROUTE))
}

/** One access write: a 400 body already is the wire union; others throw. */
async function mutateAccess(
  path: string,
  method: 'POST' | 'DELETE',
  body: unknown,
): Promise<AccessMutationResponse> {
  const response = await request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.status === 400) {
    try {
      return JSON.parse(text) as AccessMutationResponse
    } catch {
      return { ok: false, error: errorFromBody(response.status, text) }
    }
  }
  if (!response.ok) throw new Error(errorFromBody(response.status, text))
  return JSON.parse(text) as AccessMutationResponse
}

/** Authorize one group; resolves with the refreshed access snapshot. */
export async function addAccessGroup(chatId: string, name?: string): Promise<AccessMutationResponse> {
  return mutateAccess(
    ACCESS_GROUPS_ROUTE,
    'POST',
    name === undefined || name === '' ? { chatId } : { chatId, name },
  )
}

/** Revoke one group authorization (takes effect on the next message). */
export async function removeAccessGroup(chatId: string): Promise<AccessMutationResponse> {
  return mutateAccess(ACCESS_GROUPS_ROUTE, 'DELETE', { chatId })
}

/** Authorize one user `user_id` (global across authorized groups). */
export async function addAccessUser(userId: string, name?: string): Promise<AccessMutationResponse> {
  return mutateAccess(
    ACCESS_USERS_ROUTE,
    'POST',
    name === undefined || name === '' ? { userId } : { userId, name },
  )
}

/** Revoke one user authorization (takes effect on the next message). */
export async function removeAccessUser(userId: string): Promise<AccessMutationResponse> {
  return mutateAccess(ACCESS_USERS_ROUTE, 'DELETE', { userId })
}

/** Add one user `user_id` to the wiki whitelist. */
export async function addWikiUser(userId: string, name?: string): Promise<AccessMutationResponse> {
  return mutateAccess(
    ACCESS_WIKI_USERS_ROUTE,
    'POST',
    name === undefined || name === '' ? { userId } : { userId, name },
  )
}

/** Remove one user from the wiki whitelist (takes effect on the next wiki tool call). */
export async function removeWikiUser(userId: string): Promise<AccessMutationResponse> {
  return mutateAccess(ACCESS_WIKI_USERS_ROUTE, 'DELETE', { userId })
}

/** Settle one pending authorization request (same resolver as the Feishu card). */
export async function resolveAccessRequest(
  token: string,
  decision: 'allow' | 'deny',
): Promise<AccessMutationResponse> {
  return mutateAccess(ACCESS_REQUESTS_ROUTE, 'POST', { token, decision })
}
