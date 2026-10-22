/**
 * Wiki spreadsheet (电子表格) tools: `feishu_wiki_sheet_read` (switch
 * `feishuTools.wikiRead`) and `feishu_wiki_sheet_edit` (switch
 * `feishuTools.wikiWrite`).
 *
 * Both run through the same gates as the docx tools (whitelist, `wikiRoots`
 * containment, consent cards). Reading shares the docx read grant per Session
 * and document. Editing writes cell values and formulas only (no styles,
 * charts, or row/column structure), only on spreadsheets the app owns, and
 * only when the workbook revision still equals the one the model read, checked
 * before and after the consent card; Feishu offers no revision precondition on
 * the write itself.
 *
 * @module dsh-channels/feishu/wiki/sheet-tools
 */

import { z } from 'zod'
import { columnLetters, isA1Range, parseCell, rangeEndRow, rectangle } from './a1.ts'
import type { A1Cell } from './a1.ts'
import type { WikiNode } from './api.ts'
import { parseWikiRef } from './links.ts'
import type { SheetApi, SheetCellValue, SheetInfo, SheetWorkbook } from './sheet-api.ts'
import { describeError, display, failure, failureOf, guarded, nodeUrl, ownedByApp, parseArgs, preview } from './shared.ts'
import type { WikiCallContext, WikiFailure, WikiToolKit, WikiToolSpec } from './shared.ts'

/** Model-facing tool names; stable across releases (session history references them). */
export const WIKI_SHEET_READ_TOOL_NAME = 'feishu_wiki_sheet_read'
export const WIKI_SHEET_EDIT_TOOL_NAME = 'feishu_wiki_sheet_edit'

/** Most operations one `feishu_wiki_sheet_edit` call may apply. */
export const WIKI_SHEET_EDIT_MAX_OPERATIONS = 20

/** Most cells one `feishu_wiki_sheet_edit` call may write in total. */
export const WIKI_SHEET_EDIT_MAX_CELLS = 50_000

/** Read size bounds (characters of CSV returned to the model). */
const READ_DEFAULT_CHARS = 20_000
const READ_MAX_CHARS = 100_000

/** CSV characters requested when only the data extent of a sheet is needed. */
const EXTENT_PROBE_CHARS = 2_000

/** Rows of each written block shown on a consent card. */
const CARD_PREVIEW_ROWS = 3

// ---- Arguments ----------------------------------------------------------

const refSchema = z.string().trim().min(1).max(2048)
const sheetSchema = z.string().trim().min(1).max(200)
const cellValueSchema = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()])
const valuesSchema = z.array(z.array(cellValueSchema).min(1).max(1_000)).min(1).max(10_000)

export const wikiSheetReadArgsSchema = z.object({
  doc: refSchema,
  sheet: sheetSchema.optional(),
  range: z.string().trim().min(1).max(40).refine(isA1Range, '需要不带子表前缀的 A1 范围，例如 A1:F30').optional(),
  max_chars: z.number().int().min(1_000).max(READ_MAX_CHARS).optional(),
}).strict()

const sheetOperationSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('write'), sheet: sheetSchema.optional(), start_cell: z.string().trim().min(2).max(12), values: valuesSchema }).strict(),
  z.object({ command: z.literal('append'), sheet: sheetSchema.optional(), start_column: z.string().trim().min(1).max(3).optional(), values: valuesSchema }).strict(),
])

export type WikiSheetOperation = z.infer<typeof sheetOperationSchema>

export const wikiSheetEditArgsSchema = z.object({
  doc: refSchema,
  revision_id: z.number().int().min(0),
  operations: z.array(sheetOperationSchema).min(1).max(WIKI_SHEET_EDIT_MAX_OPERATIONS),
}).strict()

// ---- Results ------------------------------------------------------------

/** One sub-sheet as the tools report it. */
export interface WikiSheetView {
  readonly sheet_id: string
  readonly title: string
  readonly index: number
  readonly resource_type: string
  readonly hidden: boolean
  readonly row_count?: number
  readonly column_count?: number
}

/** Successful `feishu_wiki_sheet_read`. */
export interface WikiSheetReadValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  /** Workbook revision; pass it to `feishu_wiki_sheet_edit`. */
  readonly revision_id?: number
  readonly sheets: readonly WikiSheetView[]
  /** The sub-sheet read; absent when the call only listed the sheets. */
  readonly sheet_id?: string
  readonly actual_range?: string
  readonly current_region?: string
  readonly has_more?: boolean
  readonly warning?: string
  readonly editable: boolean
  /** CSV with `[row=N] ` record prefixes; empty when only listing. */
  readonly content: string
}

/** Successful `feishu_wiki_sheet_edit`. */
export interface WikiSheetEditValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  readonly applied: number
  /** Written rectangles, in operation order. */
  readonly written: ReadonlyArray<{ readonly sheet_id: string; readonly range: string }>
  readonly revision_id?: number
}

// ---- Descriptions -------------------------------------------------------

const READ_DESCRIPTION =
  '读取知识库中的飞书电子表格（sheet）。doc 传知识库节点链接或 node_token。'
  + '第一次读取某个表格会在话题里弹出授权卡，由话题发起人确认，确认后本话题内再次读取不再询问；等待期间不要重复调用。'
  + '返回 sheets（子表列表）；sheet 传子表 sheet_id 或标题选择子表，只有一个可见子表时可省略，有多个而未指定时只返回子表列表。'
  + 'range 为不带子表前缀的 A1 范围（如 A1:F30、A:C），省略时读整张子表。内容为 CSV（显示值），每行前缀 [row=N] 是真实行号，引用行号时以它为准，不要自己数行。'
  + `max_chars 默认 ${READ_DEFAULT_CHARS}；has_more 为 true 时表示被截断，从 actual_range 末行之后接着读。`
  + '返回的 revision_id 用于 feishu_wiki_sheet_edit；editable 表示能否修改（只有本应用创建的表格可以修改）。'

const EDIT_DESCRIPTION =
  '修改知识库中由本应用创建的飞书电子表格（sheet）的单元格值。先用 feishu_wiki_sheet_read 读取，把读到的 revision_id 原样传入；表格在此之后被改过会被拒绝，需要重新读取。'
  + `operations 按顺序执行（最多 ${WIKI_SHEET_EDIT_MAX_OPERATIONS} 个，合计不超过 ${WIKI_SHEET_EDIT_MAX_CELLS} 个单元格）：`
  + 'write（从 start_cell 如 B3 开始写入二维数组 values）、append（在子表现有数据的最后一行之后追加 values，start_column 默认 A）。'
  + 'values 每个元素是一行；单元格可以是字符串、数字、布尔或 null（null 表示保持原值不变）；以 = 开头的字符串作为公式写入。'
  + '数字、金额、百分比（0.4 表示 40%）写成数字；编号、前导零、身份证号写成字符串。不会修改样式、图表、行列结构。'
  + 'sheet 传子表 sheet_id 或标题，只有一个可见子表时可省略。每次修改都会在话题里弹出授权卡，由话题发起人确认后才执行；等待期间不要重复调用。'

// ---- Parameters ---------------------------------------------------------

const REF_DESCRIPTION = '知识库节点链接 https://<租户>.feishu.cn/wiki/<node_token> 或 node_token'
const SHEET_PROPERTY = { type: 'string', description: '子表 sheet_id 或标题；只有一个可见子表时可省略' }
const VALUES_PROPERTY = {
  type: 'array',
  description: '二维数组，每个元素是一行；单元格为字符串、数字、布尔或 null（保持原值），以 = 开头的字符串是公式',
  items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
}

const READ_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: REF_DESCRIPTION },
    sheet: SHEET_PROPERTY,
    range: { type: 'string', description: '不带子表前缀的 A1 范围，如 A1:F30；省略读整张子表' },
    max_chars: { type: 'integer', minimum: 1_000, maximum: READ_MAX_CHARS, description: `返回 CSV 的字符上限，默认 ${READ_DEFAULT_CHARS}` },
  },
  required: ['doc'],
  additionalProperties: false,
}

const EDIT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: REF_DESCRIPTION },
    revision_id: { type: 'integer', description: 'feishu_wiki_sheet_read 返回的 revision_id' },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: WIKI_SHEET_EDIT_MAX_OPERATIONS,
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['write', 'append'] },
          sheet: SHEET_PROPERTY,
          start_cell: { type: 'string', description: 'write 的起始单元格，如 B3' },
          start_column: { type: 'string', description: 'append 的起始列，默认 A' },
          values: VALUES_PROPERTY,
        },
        required: ['command', 'values'],
        additionalProperties: false,
      },
    },
  },
  required: ['doc', 'revision_id', 'operations'],
  additionalProperties: false,
}

// ---- Shared steps -------------------------------------------------------

interface SheetTarget {
  readonly context: WikiCallContext
  readonly sheets: SheetApi
  readonly node: WikiNode
  readonly url: string
}

async function sheetTarget(kit: WikiToolKit, context: WikiCallContext, doc: string): Promise<SheetTarget | WikiFailure> {
  const sheets = context.sheets
  if (sheets === undefined) return failure('CHANNEL_UNAVAILABLE')
  const ref = parseWikiRef(doc)
  if (ref === undefined) return failure('INVALID_REFERENCE')
  const node = await kit.containedNode(context, ref)
  if ('ok' in node) return node
  if (node.objType !== 'sheet') return failure('UNSUPPORTED_TYPE', `${failure('UNSUPPORTED_TYPE').reason}（该节点类型：${node.objType}）`)
  return { context, sheets, node, url: nodeUrl(context.roots, node) }
}

function sheetView(sheet: SheetInfo): WikiSheetView {
  return {
    sheet_id: sheet.sheetId,
    title: sheet.title,
    index: sheet.index,
    resource_type: sheet.resourceType,
    hidden: sheet.hidden,
    ...(sheet.rowCount === undefined ? {} : { row_count: sheet.rowCount }),
    ...(sheet.columnCount === undefined ? {} : { column_count: sheet.columnCount }),
  }
}

/** The named grid sheet, the only visible grid sheet, or why neither applies. */
function pickSheet(workbook: SheetWorkbook, wanted: string | undefined): SheetInfo | string {
  const grids = workbook.sheets.filter(sheet => sheet.resourceType === 'sheet')
  if (wanted !== undefined) {
    const match = workbook.sheets.find(sheet => sheet.sheetId === wanted)
      ?? workbook.sheets.find(sheet => sheet.title === wanted)
    if (match === undefined) return `找不到子表「${wanted}」；可用子表：${sheetList(workbook)}`
    if (match.resourceType !== 'sheet') return `子表「${match.title}」是 ${match.resourceType}，不是单元格表格，不能按单元格读写`
    return match
  }
  const visible = grids.filter(sheet => !sheet.hidden)
  if (visible.length === 1 && visible[0] !== undefined) return visible[0]
  return `表格有多个子表，请用 sheet 指定：${sheetList(workbook)}`
}

function sheetList(workbook: SheetWorkbook): string {
  return workbook.sheets.map(sheet => `${sheet.title}（${sheet.sheetId}）`).join('、') || '无'
}

function wholeSheetRange(sheet: SheetInfo): string {
  return sheet.rowCount !== undefined && sheet.columnCount !== undefined && sheet.rowCount > 0 && sheet.columnCount > 0
    ? `A1:${columnLetters(sheet.columnCount)}${sheet.rowCount}`
    : 'A:ZZZ'
}

// ---- feishu_wiki_sheet_read --------------------------------------------

async function read(kit: WikiToolKit, sessionId: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<object> {
  const args = parseArgs(WIKI_SHEET_READ_TOOL_NAME, wikiSheetReadArgsSchema, rawArgs)
  const gate = kit.gate(sessionId, WIKI_SHEET_READ_TOOL_NAME)
  if (!gate.ok) return gate
  return await guarded<WikiSheetReadValue>(kit, WIKI_SHEET_READ_TOOL_NAME, async () => {
    const target = await sheetTarget(kit, gate.context, args.doc)
    if ('ok' in target) return target
    const denied = await kit.readConsent(sessionId, target.context, target.node, signal)
    if (denied !== undefined) return denied
    if (signal.aborted) return failure('ABORTED')
    const workbook = await target.sheets.workbook(target.node.objToken)
    const base = {
      ok: true as const,
      title: target.node.title,
      node_token: target.node.nodeToken,
      url: target.url,
      ...(workbook.revision === undefined ? {} : { revision_id: workbook.revision }),
      sheets: workbook.sheets.map(sheetView),
      editable: kit.writeEnabled() && ownedByApp(target.node, target.context.botOpenId),
    }
    const sheet = pickSheet(workbook, args.sheet)
    if (typeof sheet === 'string') {
      if (args.sheet !== undefined) return failure('INVALID_OPERATION', sheet)
      return { ...base, warning: sheet, content: '' }
    }
    const csv = await target.sheets.readCsv(target.node.objToken, {
      sheetId: sheet.sheetId,
      range: args.range ?? wholeSheetRange(sheet),
      maxChars: args.max_chars ?? READ_DEFAULT_CHARS,
    })
    return {
      ...base,
      sheet_id: sheet.sheetId,
      ...(csv.actualRange === undefined ? {} : { actual_range: csv.actualRange }),
      ...(csv.currentRegion === undefined ? {} : { current_region: csv.currentRegion }),
      has_more: csv.hasMore,
      ...(csv.warning === undefined ? {} : { warning: csv.warning }),
      content: csv.csv,
    }
  })
}

// ---- feishu_wiki_sheet_edit --------------------------------------------

interface PlannedWrite {
  readonly operation: WikiSheetOperation
  readonly sheet: SheetInfo
  /** Fixed top-left for `write`; for `append` only the column is fixed. */
  readonly start: A1Cell
  readonly rows: SheetCellValue[][]
  readonly columns: number
}

/** Rows padded with `null` (unchanged) to one rectangle. */
function rectangular(values: readonly (readonly SheetCellValue[])[]): { rows: SheetCellValue[][]; columns: number } {
  const columns = Math.max(...values.map(row => row.length))
  return { rows: values.map(row => [...row, ...Array<SheetCellValue>(columns - row.length).fill(null)]), columns }
}

function plan(workbook: SheetWorkbook, operations: readonly WikiSheetOperation[]): PlannedWrite[] | WikiFailure {
  const planned: PlannedWrite[] = []
  let cells = 0
  for (const [index, operation] of operations.entries()) {
    const where = `第 ${index + 1} 个操作（${operation.command}）`
    const sheet = pickSheet(workbook, operation.sheet)
    if (typeof sheet === 'string') return failure('INVALID_OPERATION', `${where}：${sheet}`)
    let start: A1Cell | undefined
    if (operation.command === 'write') {
      start = parseCell(operation.start_cell)
      if (start === undefined) return failure('INVALID_OPERATION', `${where}：start_cell 需要单个单元格，例如 B3`)
    } else {
      const column = parseCell(`${operation.start_column ?? 'A'}1`)
      if (column === undefined) return failure('INVALID_OPERATION', `${where}：start_column 需要列字母，例如 A`)
      start = column
    }
    const { rows, columns } = rectangular(operation.values)
    cells += rows.length * columns
    if (cells > WIKI_SHEET_EDIT_MAX_CELLS) {
      return failure('INVALID_OPERATION', `一次最多写入 ${WIKI_SHEET_EDIT_MAX_CELLS} 个单元格，请拆成多次调用`)
    }
    planned.push({ operation, sheet, start, rows, columns })
  }
  return planned
}

function cardLines(planned: readonly PlannedWrite[]): string[] {
  const lines = planned.map((write, index) => {
    const size = `${write.rows.length} 行 × ${write.columns} 列`
    const where = write.operation.command === 'write'
      ? `写入子表「${preview(write.sheet.title, 40)}」的 ${rectangle(write.start, write.rows.length, write.columns)}（${size}）`
      : `在子表「${preview(write.sheet.title, 40)}」末尾追加 ${size}（从 ${columnLetters(write.start.column)} 列开始）`
    const sample = write.rows.slice(0, CARD_PREVIEW_ROWS)
      .map(row => `　${preview(row.map(cell => cell === null ? '' : String(cell)).join(' | '), 80)}`)
    const more = write.rows.length > CARD_PREVIEW_ROWS ? [`　…（共 ${write.rows.length} 行）`] : []
    return [`${index + 1}. ${where}`, ...sample, ...more].join('\n')
  })
  return [`**将执行 ${planned.length} 个操作**`, ...lines]
}

/** First empty row after the sheet's data (1 for an empty sheet). */
async function appendRow(sheets: SheetApi, token: string, sheet: SheetInfo): Promise<number | undefined> {
  const probe = await sheets.readCsv(token, { sheetId: sheet.sheetId, range: wholeSheetRange(sheet), maxChars: EXTENT_PROBE_CHARS })
  const region = probe.currentRegion ?? (probe.hasMore ? undefined : probe.actualRange)
  if (region === undefined) return probe.csv.trim() === '' && !probe.hasMore ? 1 : undefined
  const last = rangeEndRow(region)
  return last === undefined ? undefined : last + 1
}

async function edit(kit: WikiToolKit, sessionId: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<object> {
  const args = parseArgs(WIKI_SHEET_EDIT_TOOL_NAME, wikiSheetEditArgsSchema, rawArgs)
  const gate = kit.gate(sessionId, WIKI_SHEET_EDIT_TOOL_NAME)
  if (!gate.ok) return gate
  return await guarded<WikiSheetEditValue>(kit, WIKI_SHEET_EDIT_TOOL_NAME, async () => {
    const target = await sheetTarget(kit, gate.context, args.doc)
    if ('ok' in target) return target
    const { node, sheets } = target
    if (!ownedByApp(node, target.context.botOpenId)) {
      return failure('NOT_OWNED', `${failure('NOT_OWNED').reason}（该表格所有者：${node.owner ?? '未知'}）`)
    }
    const workbook = await sheets.workbook(node.objToken)
    if (workbook.revision !== undefined && workbook.revision !== args.revision_id) {
      return { ...failure('REVISION_CONFLICT', `${failure('REVISION_CONFLICT').reason}（读取时 ${args.revision_id}，当前 ${workbook.revision}）`), revision_id: workbook.revision }
    }
    const planned = plan(workbook, args.operations)
    if (!Array.isArray(planned)) return planned
    const denied = await kit.consent(sessionId, target.context, 'edit', {
      title: node.title,
      url: target.url,
      location: await kit.locationOf(target.context.api, node),
      details: cardLines(planned),
    }, signal)
    if (denied !== undefined) return denied
    // The workbook may have changed while the card was open.
    const after = await sheets.workbook(node.objToken)
    if (after.revision !== undefined && after.revision !== args.revision_id) {
      return { ...failure('REVISION_CONFLICT', `${failure('REVISION_CONFLICT').reason}（等待授权期间表格被修改）`), revision_id: after.revision }
    }
    const written: Array<{ sheet_id: string; range: string }> = []
    for (const [index, write] of planned.entries()) {
      if (signal.aborted) return { ...failure('ABORTED', `已取消；前 ${index} 个操作已执行`), applied: index }
      try {
        let start = write.start
        if (write.operation.command === 'append') {
          const row = await appendRow(sheets, node.objToken, write.sheet)
          if (row === undefined) {
            return { ...failure('EDIT_FAILED', `第 ${index + 1} 个操作失败：无法确定子表「${write.sheet.title}」的数据末行，请改用 write 指定 start_cell；前 ${index} 个操作已执行`), applied: index }
          }
          start = { column: write.start.column, row }
        }
        const range = rectangle(start, write.rows.length, write.columns)
        await sheets.writeCells(node.objToken, { sheetId: write.sheet.sheetId, range, rows: write.rows })
        written.push({ sheet_id: write.sheet.sheetId, range })
      } catch (error) {
        const reason = failureOf(error).reason
        return { ...failure('EDIT_FAILED', `第 ${index + 1} 个操作失败：${reason}；前 ${index} 个操作已执行`), applied: index }
      }
    }
    const revision = await sheets.workbook(node.objToken).then(final => final.revision, (error: unknown) => {
      kit.warn('dsh-channels: reading the revision after %s failed: %s', WIKI_SHEET_EDIT_TOOL_NAME, describeError(error))
      return undefined
    })
    return {
      ok: true,
      title: node.title,
      node_token: node.nodeToken,
      url: target.url,
      applied: planned.length,
      written,
      ...(revision === undefined ? {} : { revision_id: revision }),
    }
  })
}

// ---- Specs --------------------------------------------------------------

/** The spreadsheet tool family. */
export const SHEET_TOOL_SPECS: readonly WikiToolSpec[] = [
  {
    name: WIKI_SHEET_READ_TOOL_NAME,
    access: 'read',
    description: READ_DESCRIPTION,
    parameters: READ_PARAMETERS,
    execute: read,
    presentCall: args => `读取知识库表格：${display(args.doc)}`,
  },
  {
    name: WIKI_SHEET_EDIT_TOOL_NAME,
    access: 'write',
    description: EDIT_DESCRIPTION,
    parameters: EDIT_PARAMETERS,
    execute: edit,
    presentCall: args => `修改知识库表格：${display(args.doc)}`,
  },
]
