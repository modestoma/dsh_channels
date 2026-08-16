/**
 * Durable routing domain: thread/chat keys → bound DSH session records.
 *
 * Opened through the host's `ctx.storageDomain` facility; the spec is plain
 * data (no runtime import of DSH packages), so the plugin carries zero
 * runtime dependency on host internals — everything flows through `ctx`.
 *
 * @module dsh-channels/domain
 */

import { z } from 'zod'

/** Route key kinds. `thread` = real Feishu topic; `chat` = degraded chat-scoped fallback. */
export const ROUTE_RECORD_VERSION = 1

export const routeRecordSchema = z.object({
  /** Route key the record is stored under (thread_id or chat:<chatId>). */
  key: z.string().min(1),
  /** Kind of the key. */
  kind: z.enum(['thread', 'chat']),
  /** Bound DSH session id. */
  sessionId: z.string().min(1),
  /** Feishu chat the session lives in. */
  chatId: z.string().min(1),
  /** `p2p` or `group`. */
  chatType: z.enum(['p2p', 'group']),
  /** Workspace owner (sender open_id). */
  senderOpenId: z.string().min(1),
  /** Workspace directory for this (chat, user) pair. */
  workspacePath: z.string().min(1),
  /** Message id of the latest streaming card (updated per turn). */
  cardMessageId: z.string().min(1),
  /** Epoch ms when the record was created. */
  createdAt: z.number().int().nonnegative(),
  /** Epoch ms of the last activity routed through this record. */
  lastActivityAt: z.number().int().nonnegative(),
})

export type RouteRecord = z.infer<typeof routeRecordSchema>

export interface FeishuDomainSpecShape {
  name: 'channels_routes'
  version: 1
  global: {
    schema: z.ZodType<FeishuDomainGlobal>
    initial: FeishuDomainGlobal
  }
  tables: {
    routes: {
      valueSchema: typeof routeRecordSchema
      __key?: string
    }
  }
}

export const feishuDomainGlobalSchema = z.object({
  /** img_key of the uploaded chevron icon used by the fold-panel header. */
  chevronImgKey: z.string().optional(),
})

export type FeishuDomainGlobal = z.infer<typeof feishuDomainGlobalSchema>

/**
 * Domain declaration for the host's storage facility. Plain data plus zod
 * schemas — deliberately not built with `defineDomain` so this module has no
 * runtime import of `@deepseek-ai/dsh-storage-domain`.
 */
export const feishuDomain: FeishuDomainSpecShape = {
  name: 'channels_routes',
  version: 1,
  global: {
    schema: feishuDomainGlobalSchema,
    initial: {} satisfies FeishuDomainGlobal,
  },
  tables: {
    routes: { valueSchema: routeRecordSchema },
  },
}

export type FeishuDomainSpec = typeof feishuDomain

/** Normalized table handle for the routes table. */
export interface RoutesTable {
  get(key: string): RouteRecord | undefined
  put(key: string, value: RouteRecord): Promise<unknown> | void
  delete(key: string): Promise<unknown> | void
  entries(): IterableIterator<[string, RouteRecord]>
}

/** Normalized domain handle. */
export interface FeishuDomainHandle {
  routes: RoutesTable
  getGlobal(): FeishuDomainGlobal
  setGlobal(value: FeishuDomainGlobal): Promise<unknown> | void
  close(): Promise<void>
}

/** The raw shape `ctx.storageDomain.open()` resolves to (cast at the seam).
 *  Mirrors `KvTable` from `@deepseek-ai/dsh-storage-domain`: reads are sync,
 *  writes go through `put`/`delete` (NOT `set`). */
export interface RawDomainHandle {
  table(name: string): {
    get(key: string): unknown
    put(key: string, value: unknown): Promise<unknown>
    delete(key: string): Promise<unknown>
    entries(): IterableIterator<[string, unknown]>
  }
  global: {
    get(): unknown
    set(value: unknown): Promise<unknown>
  }
  close(): Promise<void>
}

/** Build a chat-scoped fallback key for degraded (topic-less) routing. */
export function chatRouteKey(chatType: 'p2p' | 'group', chatId: string, senderOpenId: string): string {
  return chatType === 'p2p'
    ? `chat:p2p:${chatId}:${senderOpenId}`
    : `chat:group:${chatId}:${senderOpenId}`
}
