/**
 * Feishu spreadsheet (电子表格) calls used by the wiki sheet tools, made with
 * the app identity (tenant access token).
 *
 * Everything goes through the `sheet_ai/v2` tool endpoints: `POST
 * spreadsheets/:token/tools/invoke_read` (or `invoke_write`) with body
 * `{tool_name, input}`, where `input` is a JSON string that also carries
 * `excel_id`, and the result is the JSON string `data.output`. Read tools sent
 * to `invoke_write` (or the reverse) are rejected by the gateway. Writes carry
 * no base revision and no idempotency key; callers check the workbook
 * revision before writing.
 *
 * @module dsh-channels/feishu/wiki/sheet-api
 */

import { FeishuApiError } from '../../feishu-channel.ts'
import { call, segment } from './api.ts'
import type { WikiRawRequest } from './api.ts'

/** One sub-sheet of a workbook. */
export interface SheetInfo {
  readonly sheetId: string
  readonly title: string
  readonly index: number
  /** `sheet` for a cell grid; other kinds (an embedded `bitable`) cannot be read as cells. */
  readonly resourceType: string
  readonly hidden: boolean
  /** Physical grid size (not the data extent); absent for non-grid sheets. */
  readonly rowCount?: number
  readonly columnCount?: number
}

/** Workbook structure and its current revision. */
export interface SheetWorkbook {
  /** Monotonic workbook revision; absent when Feishu omits it. */
  readonly revision?: number
  readonly sheets: readonly SheetInfo[]
}

/** One `get_range_as_csv` request. */
export interface SheetCsvRequest {
  readonly sheetId: string
  /** Bare A1 range (`A1:F30`, `A:C`), no sheet prefix. */
  readonly range: string
  readonly maxChars: number
}

/** One range read as CSV. */
export interface SheetCsv {
  /** RFC 4180 CSV; every record starts with `[row=N] ` (N = sheet row). */
  readonly csv: string
  /** What was actually read (clipped to the grid or by `maxChars`). */
  readonly actualRange?: string
  /** Contiguous non-empty block around the request; stops at a fully empty row or column. */
  readonly currentRegion?: string
  /** True when `maxChars` cut the range; continue after `actualRange`. */
  readonly hasMore: boolean
  readonly warning?: string
}

/**
 * One cell value to write: a string starting with `=` is a formula, `null`
 * leaves the cell unchanged.
 */
export type SheetCellValue = string | number | boolean | null

/** One `set_cell_range` request. */
export interface SheetWriteRequest {
  readonly sheetId: string
  /** Rectangle whose size equals `rows` exactly. */
  readonly range: string
  readonly rows: readonly (readonly SheetCellValue[])[]
  /** False makes the write fail when any target cell is non-empty; the server default is true. */
  readonly allowOverwrite?: boolean
}

/** The `sheet_ai` spreadsheet tools the wiki sheet tools consume. */
export interface SheetApi {
  /**
   * Sub-sheets and revision of one workbook.
   * @param token Spreadsheet token (the wiki node's `objToken`).
   * @returns The workbook structure.
   */
  workbook(token: string): Promise<SheetWorkbook>
  /**
   * Read one range as CSV (formatted display values).
   * @param token Spreadsheet token.
   * @param request Sheet, range, and size cap.
   * @returns The CSV and range metadata.
   */
  readCsv(token: string, request: SheetCsvRequest): Promise<SheetCsv>
  /**
   * Write one rectangle of values and formulas.
   * @param token Spreadsheet token.
   * @param request Sheet, rectangle, and values.
   */
  writeCells(token: string, request: SheetWriteRequest): Promise<void>
}

interface RawSheet {
  sheet_id?: unknown
  title?: unknown
  sheet_name?: unknown
  index?: unknown
  resource_type?: unknown
  hidden?: unknown
  is_hidden?: unknown
  row_count?: unknown
  column_count?: unknown
}

function invokePath(token: string, kind: 'read' | 'write'): string {
  return `/open-apis/sheet_ai/v2/spreadsheets/${segment(token)}/tools/invoke_${kind}`
}

async function invoke(
  request: WikiRawRequest,
  token: string,
  kind: 'read' | 'write',
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = invokePath(token, kind)
  const data = await call<{ output?: unknown }>(request, {
    method: 'POST',
    url,
    data: { tool_name: toolName, input: JSON.stringify({ excel_id: token, ...input }) },
  })
  if (typeof data.output !== 'string' || data.output === '') return {}
  let output: unknown
  try {
    output = JSON.parse(data.output)
  } catch (error) {
    throw new FeishuApiError(`${toolName}: output is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (Array.isArray(output)) return { sheets: output }
  if (typeof output !== 'object' || output === null) throw new FeishuApiError(`${toolName}: output is not an object`)
  return output as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sheetInfo(raw: RawSheet, position: number): SheetInfo | undefined {
  const sheetId = optionalString(raw.sheet_id)
  if (sheetId === undefined) return undefined
  const rowCount = optionalNumber(raw.row_count)
  const columnCount = optionalNumber(raw.column_count)
  return {
    sheetId,
    title: optionalString(raw.title) ?? optionalString(raw.sheet_name) ?? '',
    index: optionalNumber(raw.index) ?? position,
    resourceType: optionalString(raw.resource_type) ?? 'sheet',
    hidden: raw.hidden === true || raw.is_hidden === true,
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(columnCount === undefined ? {} : { columnCount }),
  }
}

function cellOf(value: SheetCellValue): object {
  if (value === null) return {}
  if (typeof value === 'string' && value.startsWith('=')) return { formula: value }
  return { value }
}

/**
 * {@link SheetApi} over the SDK's generic authenticated request.
 *
 * @param request `Client.request` of the connected SDK client.
 * @returns The API.
 */
export function createSheetApi(request: WikiRawRequest): SheetApi {
  return {
    async workbook(token) {
      const output = await invoke(request, token, 'read', 'get_workbook_structure', {})
      const rawSheets = Array.isArray(output.sheets) ? output.sheets as RawSheet[] : []
      const sheets = rawSheets.flatMap((raw, position) => {
        const info = typeof raw === 'object' && raw !== null ? sheetInfo(raw, position) : undefined
        return info === undefined ? [] : [info]
      })
      const revision = optionalNumber(output.revision)
      return { ...(revision === undefined ? {} : { revision }), sheets }
    },
    async readCsv(token, read) {
      const output = await invoke(request, token, 'read', 'get_range_as_csv', {
        sheet_id: read.sheetId,
        range: read.range,
        max_chars: read.maxChars,
        max_rows: 1_000_000_000,
        skip_hidden: false,
      })
      const actualRange = optionalString(output.actual_range)
      const currentRegion = optionalString(output.current_region)
      const warning = optionalString(output.warning_message)
      return {
        csv: typeof output.annotated_csv === 'string' ? output.annotated_csv : '',
        ...(actualRange === undefined ? {} : { actualRange }),
        ...(currentRegion === undefined ? {} : { currentRegion }),
        hasMore: output.has_more === true,
        ...(warning === undefined ? {} : { warning }),
      }
    },
    async writeCells(token, write) {
      await invoke(request, token, 'write', 'set_cell_range', {
        sheet_id: write.sheetId,
        range: write.range,
        cells: write.rows.map(row => row.map(cellOf)),
        ...(write.allowOverwrite === false ? { allow_overwrite: false } : {}),
      })
    },
  }
}
