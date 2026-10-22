/**
 * Feishu Base (多维表格) calls used by the wiki base tools, made with the app
 * identity (tenant access token).
 *
 * Everything goes through `base/v3/bases/:base_token/...` (the legacy
 * `bitable/v1` API is not used). Record reads return a column matrix that
 * this module turns into one field map per record; record writes take flat
 * maps keyed by field name or field id. Writes carry no precondition, are
 * applied asynchronously (a read straight after a write may not show it), and
 * must not run in parallel on one table.
 *
 * @module dsh-channels/feishu/wiki/base-api
 */

import { FeishuApiError } from '../../feishu-channel.ts'
import { call, segment } from './api.ts'
import type { WikiRawRequest } from './api.ts'

/** Most records one batch write may carry (Feishu limit). */
export const BASE_BATCH_MAX_RECORDS = 200

/** One table of a base. */
export interface BaseTable {
  readonly tableId: string
  readonly name: string
}

/** One field (column) of a table, as Feishu describes it. */
export interface BaseField {
  readonly fieldId: string
  readonly name: string
  /** `text`, `number`, `select`, `datetime`, `user`, `link`, `checkbox`, … */
  readonly type: string
  /** Remaining Feishu field properties (style, options, multiple, …), passed through. */
  readonly properties: Readonly<Record<string, unknown>>
}

/** One cell value as Feishu reads or writes it (JSON). */
export type BaseCellValue = unknown

/** One record: its id and a map from field name to value. */
export interface BaseRecord {
  readonly recordId: string
  readonly fields: Readonly<Record<string, BaseCellValue>>
}

/** Filter, sort, projection, and paging of a record query. */
export interface BaseRecordQuery {
  /** `{logic, conditions: [[field, operator, value?], …]}`. */
  readonly filter?: object
  /** `[{field, desc}]`. */
  readonly sort?: readonly object[]
  /** Field names or ids to return; all view-visible fields when absent. */
  readonly fields?: readonly string[]
  readonly viewId?: string
  readonly offset: number
  readonly limit: number
}

/** A keyword search over some fields. */
export interface BaseRecordSearch extends BaseRecordQuery {
  readonly keyword: string
  readonly searchFields: readonly string[]
}

/** One page of records. */
export interface BaseRecordPage {
  readonly records: readonly BaseRecord[]
  readonly hasMore: boolean
  /** Table data snapshot version; changes when the data changes. */
  readonly rev?: number
  readonly timezone?: string
  /** Fields Feishu skipped, with its reason. */
  readonly ignoredFields: readonly string[]
}

/** Field values of one record write, keyed by field name or id. */
export type BaseRecordFields = Readonly<Record<string, BaseCellValue>>

/** The `base/v3` endpoints the wiki base tools consume. */
export interface BaseApi {
  /**
   * Tables of one base.
   * @param baseToken Base token (the wiki node's `objToken`).
   * @returns The tables.
   */
  listTables(baseToken: string): Promise<readonly BaseTable[]>
  /**
   * Fields of one table.
   * @param baseToken Base token.
   * @param tableId Table id.
   * @returns The fields.
   */
  listFields(baseToken: string, tableId: string): Promise<readonly BaseField[]>
  /**
   * One page of records, filtered and sorted.
   * @param baseToken Base token.
   * @param tableId Table id.
   * @param query Filter, sort, projection, paging.
   * @returns The page.
   */
  listRecords(baseToken: string, tableId: string, query: BaseRecordQuery): Promise<BaseRecordPage>
  /**
   * One page of records matching a keyword.
   * @param baseToken Base token.
   * @param tableId Table id.
   * @param search Keyword, searched fields, and query options.
   * @returns The page.
   */
  searchRecords(baseToken: string, tableId: string, search: BaseRecordSearch): Promise<BaseRecordPage>
  /**
   * Create records (at most {@link BASE_BATCH_MAX_RECORDS}).
   * @param baseToken Base token.
   * @param tableId Table id.
   * @param records Field maps.
   * @returns The new record ids, in input order.
   */
  createRecords(baseToken: string, tableId: string, records: readonly BaseRecordFields[]): Promise<readonly string[]>
  /**
   * Update records (at most {@link BASE_BATCH_MAX_RECORDS}); only the given fields change.
   * @param baseToken Base token.
   * @param tableId Table id.
   * @param updates Record id → changed fields.
   * @returns Fields Feishu ignored (read-only fields), with its reason.
   */
  updateRecords(baseToken: string, tableId: string, updates: Readonly<Record<string, BaseRecordFields>>): Promise<readonly string[]>
  /**
   * Delete records (at most {@link BASE_BATCH_MAX_RECORDS}).
   * @param baseToken Base token.
   * @param tableId Table id.
   * @param recordIds Records to delete.
   */
  deleteRecords(baseToken: string, tableId: string, recordIds: readonly string[]): Promise<void>
}

interface RawMatrix {
  fields?: unknown
  record_id_list?: unknown
  data?: unknown
  has_more?: unknown
  rev?: unknown
  timezone?: unknown
  ignored_fields?: unknown
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined
}

function ignoredFieldsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const { name, id, reason } = item as { name?: unknown; id?: unknown; reason?: unknown }
    const label = typeof name === 'string' && name !== '' ? name : typeof id === 'string' ? id : '?'
    return [typeof reason === 'string' && reason !== '' ? `${label}: ${reason}` : label]
  })
}

function recordPage(raw: RawMatrix, where: string): BaseRecordPage {
  const names = stringArray(raw.fields) ?? []
  const ids = stringArray(raw.record_id_list) ?? []
  const rows = Array.isArray(raw.data) ? raw.data : []
  if (rows.length !== ids.length) throw new FeishuApiError(`${where}: record ids and rows differ in length`)
  const records = ids.map((recordId, index) => {
    const row: unknown = rows[index]
    if (!Array.isArray(row) || row.length !== names.length) throw new FeishuApiError(`${where}: row ${index} does not match the field list`)
    return { recordId, fields: Object.fromEntries(names.map((name, column) => [name, row[column] ?? null])) }
  })
  return {
    records,
    hasMore: raw.has_more === true,
    ...(typeof raw.rev === 'number' ? { rev: raw.rev } : {}),
    ...(typeof raw.timezone === 'string' && raw.timezone !== '' ? { timezone: raw.timezone } : {}),
    ignoredFields: ignoredFieldsOf(raw.ignored_fields),
  }
}

/**
 * {@link BaseApi} over the SDK's generic authenticated request.
 *
 * @param request `Client.request` of the connected SDK client.
 * @returns The API.
 */
export function createBaseApi(request: WikiRawRequest): BaseApi {
  const tablePath = (baseToken: string, tableId: string): string =>
    `/open-apis/base/v3/bases/${segment(baseToken)}/tables/${segment(tableId)}`
  return {
    async listTables(baseToken) {
      const data = await call<{ tables?: unknown; items?: unknown }>(request, {
        method: 'GET',
        url: `/open-apis/base/v3/bases/${segment(baseToken)}/tables`,
        params: { offset: 0, limit: 300 },
      })
      const raw = Array.isArray(data.tables) ? data.tables : Array.isArray(data.items) ? data.items : []
      return raw.flatMap((item: unknown) => {
        if (typeof item !== 'object' || item === null) return []
        const { id, table_id, name, table_name } = item as Record<string, unknown>
        const tableId = typeof id === 'string' ? id : typeof table_id === 'string' ? table_id : undefined
        if (tableId === undefined) return []
        return [{ tableId, name: typeof name === 'string' ? name : typeof table_name === 'string' ? table_name : '' }]
      })
    },
    async listFields(baseToken, tableId) {
      const data = await call<{ fields?: unknown; items?: unknown }>(request, {
        method: 'GET',
        url: `${tablePath(baseToken, tableId)}/fields`,
        params: { offset: 0, limit: 300 },
      })
      const raw = Array.isArray(data.fields) ? data.fields : Array.isArray(data.items) ? data.items : []
      return raw.flatMap((item: unknown) => {
        if (typeof item !== 'object' || item === null) return []
        const { id, field_id, name, field_name, type, ...properties } = item as Record<string, unknown>
        const fieldId = typeof id === 'string' ? id : typeof field_id === 'string' ? field_id : undefined
        if (fieldId === undefined) return []
        return [{
          fieldId,
          name: typeof name === 'string' ? name : typeof field_name === 'string' ? field_name : '',
          type: typeof type === 'string' ? type : 'not_support',
          properties,
        }]
      })
    },
    async listRecords(baseToken, tableId, query) {
      const url = `${tablePath(baseToken, tableId)}/records`
      const params = new URLSearchParams({ offset: String(query.offset), limit: String(query.limit) })
      for (const field of query.fields ?? []) params.append('field_id', field)
      if (query.viewId !== undefined) params.set('view_id', query.viewId)
      if (query.filter !== undefined) params.set('filter', JSON.stringify(query.filter))
      if (query.sort !== undefined) params.set('sort', JSON.stringify(query.sort))
      const data = await call<RawMatrix>(request, { method: 'GET', url: `${url}?${params.toString()}` })
      return recordPage(data, url)
    },
    async searchRecords(baseToken, tableId, search) {
      const url = `${tablePath(baseToken, tableId)}/records/search`
      const data = await call<RawMatrix>(request, {
        method: 'POST',
        url,
        data: {
          keyword: search.keyword,
          search_fields: search.searchFields,
          ...(search.fields === undefined ? {} : { select_fields: search.fields }),
          ...(search.viewId === undefined ? {} : { view_id: search.viewId }),
          ...(search.filter === undefined ? {} : { filter: search.filter }),
          ...(search.sort === undefined ? {} : { sort: search.sort }),
          offset: search.offset,
          limit: search.limit,
        },
      })
      return recordPage(data, url)
    },
    async createRecords(baseToken, tableId, records) {
      const url = `${tablePath(baseToken, tableId)}/records/batch_create`
      const data = await call<{ record_id_list?: unknown }>(request, { method: 'POST', url, data: { create_records: records } })
      return stringArray(data.record_id_list) ?? []
    },
    async updateRecords(baseToken, tableId, updates) {
      const url = `${tablePath(baseToken, tableId)}/records/batch_update`
      const data = await call<{ ignored_fields?: unknown }>(request, { method: 'POST', url, data: { update_records: updates } })
      return ignoredFieldsOf(data.ignored_fields)
    },
    async deleteRecords(baseToken, tableId, recordIds) {
      const url = `${tablePath(baseToken, tableId)}/records/batch_delete`
      await call<unknown>(request, { method: 'POST', url, data: { record_id_list: recordIds } })
    },
  }
}
