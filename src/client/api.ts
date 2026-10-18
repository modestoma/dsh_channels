/**
 * Same-origin HTTP client for the settings panel. No typert contract: the
 * Host half registers plain exact routes and this module fetches them.
 *
 * @module dsh-channels/client/api
 */

import { CONFIG_ROUTE, PANEL_ROUTE, RECONNECT_ROUTE, STATUS_ROUTE } from '../settings/contract.ts'
import type {
  ChannelStatusWire,
  ClearConfigResponse,
  EditableValues,
  PanelWire,
  ReconnectResponse,
  SaveConfigResponse,
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

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
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
