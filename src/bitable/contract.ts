/**
 * Public contract of the `feishuBitable` service (version 1): domain-agnostic
 * server-side read/write bridge over Feishu Base (`base/v3`) using the bot app
 * identity.
 *
 * Supports both standalone Base URLs (`https://<tenant>.feishu.cn/base/<token>`)
 * and Wiki-embedded Base URLs (`https://<tenant>.feishu.cn/wiki/<node_token>`),
 * with optional `?table=<tableId>` query or explicit `table` parameter.
 *
 * @module dsh-channels/bitable/contract
 */

import { z } from 'zod'

/** Service name registered on the Cordis context (`ctx.provide('feishuBitable', ...)`). */
export const FEISHU_BITABLE_SERVICE = 'feishuBitable' as const

export type FeishuBitableServiceName = typeof FEISHU_BITABLE_SERVICE

/** Contract version implemented by this package. */
export const FEISHU_BITABLE_VERSION = 1 as const

export type FeishuBitableVersion = typeof FEISHU_BITABLE_VERSION

/** Maximum records one batch create/update call may carry (Feishu limit). */
export const BITABLE_BATCH_MAX_RECORDS = 200

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,64}$/u

/** Parsed Feishu Bitable target reference. */
export type ParsedBitableTarget =
  | { readonly kind: 'base'; readonly token: string; readonly table?: string }
  | { readonly kind: 'wiki'; readonly token: string; readonly table?: string }

/** Parse a Feishu Base or Wiki-embedded Base URL and optional table override. */
export function parseBitableUrl(rawUrl: string, explicitTable?: string): ParsedBitableTarget | undefined {
  if (typeof rawUrl !== 'string') return undefined
  const trimmed = rawUrl.trim()
  if (trimmed === '' || trimmed.length > 2048) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  const segments = parsed.pathname.split('/').filter(segment => segment !== '')
  const explicit = explicitTable?.trim()
  const queryTable = parsed.searchParams.get('table')?.trim()
  const table = explicit !== undefined && explicit !== ''
    ? explicit
    : (queryTable !== undefined && queryTable !== '' ? queryTable : undefined)
  if (table !== undefined && table.length > 200) return undefined

  if (segments.length === 2 && (segments[0] === 'base' || segments[0] === 'bitable') && TOKEN_PATTERN.test(segments[1]!)) {
    return {
      kind: 'base',
      token: segments[1]!,
      ...(table === undefined ? {} : { table }),
    }
  }
  if (segments.length === 2 && segments[0] === 'wiki' && segments[1] !== 'space' && TOKEN_PATTERN.test(segments[1]!)) {
    return {
      kind: 'wiki',
      token: segments[1]!,
      ...(table === undefined ? {} : { table }),
    }
  }
  return undefined
}

/** Identifies one Feishu Base table by URL and optional table id/name override. */
export interface BitableTargetInput {
  readonly url: string
  readonly table?: string
}

/** Failure codes returned by {@link FeishuBitableService}. */
export type BitableFailureCode =
  | 'invalid-target'
  | 'not-connected'
  | 'ambiguous-table'
  | 'table-not-found'
  | 'permission-denied'
  | 'not-found'
  | 'rate-limited'
  | 'api-error'

/** Standard outcome envelope returned by every {@link FeishuBitableService} call. */
export type BitableResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: BitableFailureCode; readonly message: string }

/** Metadata describing one column/field in a Feishu Base table. */
export interface BitableFieldInfo {
  readonly fieldId: string
  readonly name: string
  readonly type: string
  readonly properties: Readonly<Record<string, unknown>>
}

/** Resolved Base table identity and field schema. */
export interface BitableTableSchema {
  readonly baseToken: string
  readonly tableId: string
  readonly tableName: string
  readonly fields: readonly BitableFieldInfo[]
}

/** One record row read from a Feishu Base table. */
export interface BitableRecord {
  readonly recordId: string
  readonly fields: Readonly<Record<string, unknown>>
}

/** Query parameters for {@link FeishuBitableService.listRecords}. */
export interface BitableListRecordsInput extends BitableTargetInput {
  readonly fields?: readonly string[]
  readonly filter?: object
  readonly sort?: readonly object[]
  readonly viewId?: string
  readonly offset?: number
  readonly limit?: number
}

/** One page of records returned by {@link FeishuBitableService.listRecords}. */
export interface BitableRecordPage {
  readonly baseToken: string
  readonly tableId: string
  readonly records: readonly BitableRecord[]
  readonly hasMore: boolean
  readonly nextOffset?: number
  readonly rev?: number
  readonly ignoredFields: readonly string[]
}

/** Batch create input for {@link FeishuBitableService.createRecords}. */
export interface BitableCreateRecordsInput extends BitableTargetInput {
  readonly records: ReadonlyArray<Readonly<Record<string, unknown>>>
}

/** Batch update input for {@link FeishuBitableService.updateRecords}. */
export interface BitableUpdateRecordsInput extends BitableTargetInput {
  readonly updates: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/** Host service contract exposed as `ctx.get('feishuBitable')`. */
export interface FeishuBitableService {
  readonly version: FeishuBitableVersion
  /** Resolve URL/table and inspect the table's field definitions. */
  inspectTable(target: BitableTargetInput): Promise<BitableResult<BitableTableSchema>>
  /** List one page of records from the target table. */
  listRecords(input: BitableListRecordsInput): Promise<BitableResult<BitableRecordPage>>
  /** Batch create records (up to 200 per call), serialized per table. */
  createRecords(input: BitableCreateRecordsInput): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly recordIds: readonly string[] }>>
  /** Batch update existing records by recordId (up to 200 per call), serialized per table. */
  updateRecords(input: BitableUpdateRecordsInput): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly ignoredFields: readonly string[] }>>
  /** Notify subscribers when the underlying Feishu channel becomes available or closes. */
  onChange?(listener: () => void): () => void
}

// ---- Runtime validation schemas -----------------------------------------

const urlSchema = z.string().trim().min(1).max(2048)
const tableSchema = z.string().trim().min(1).max(200)
const nameSchema = z.string().trim().min(1).max(200)
const recordIdSchema = z.string().trim().min(1).max(64)
const fieldMapSchema = z.record(z.string().min(1).max(200), z.unknown())
  .refine(map => Object.keys(map).length > 0, '每条记录至少包含一个字段')

export const bitableTargetInputSchema = z.object({
  url: urlSchema,
  table: tableSchema.optional(),
}).strict()

export const bitableListRecordsInputSchema = bitableTargetInputSchema.extend({
  fields: z.array(nameSchema).min(1).max(200).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  sort: z.array(z.record(z.string(), z.unknown())).min(1).max(20).optional(),
  viewId: nameSchema.optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(BITABLE_BATCH_MAX_RECORDS).optional(),
}).strict()

export const bitableCreateRecordsInputSchema = bitableTargetInputSchema.extend({
  records: z.array(fieldMapSchema).min(1).max(BITABLE_BATCH_MAX_RECORDS),
}).strict()

export const bitableUpdateRecordsInputSchema = bitableTargetInputSchema.extend({
  updates: z.record(recordIdSchema, fieldMapSchema).refine(
    updates => {
      const size = Object.keys(updates).length
      return size >= 1 && size <= BITABLE_BATCH_MAX_RECORDS
    },
    `updates 必须包含 1-${BITABLE_BATCH_MAX_RECORDS} 条记录`,
  ),
}).strict()
