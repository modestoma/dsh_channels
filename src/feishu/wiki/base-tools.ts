/**
 * Wiki Base (多维表格) tools: `feishu_wiki_base_read` (switch
 * `feishuTools.wikiRead`) and `feishu_wiki_base_edit` (switch
 * `feishuTools.wikiWrite`).
 *
 * Both run through the same gates as the docx tools (whitelist, `wikiRoots`
 * containment, consent cards). Reading shares the docx read grant per Session
 * and document. Editing changes records only (no table or field structure):
 * on a base the app owns it may create, update, and delete records; on any
 * other base it may only create records, so existing data written by people
 * is never changed. Every edit asks on a consent card. Feishu offers no
 * revision precondition for record writes, and applies them asynchronously.
 *
 * @module dsh-channels/feishu/wiki/base-tools
 */

import { z } from 'zod'
import type { WikiNode } from './api.ts'
import { BASE_BATCH_MAX_RECORDS } from './base-api.ts'
import type { BaseApi, BaseField, BaseRecordFields, BaseTable } from './base-api.ts'
import { parseWikiRef } from './links.ts'
import { display, failure, failureOf, guarded, nodeUrl, ownedByApp, parseArgs, preview } from './shared.ts'
import type { WikiCallContext, WikiFailure, WikiToolKit, WikiToolSpec } from './shared.ts'

/** Model-facing tool names; stable across releases (session history references them). */
export const WIKI_BASE_READ_TOOL_NAME = 'feishu_wiki_base_read'
export const WIKI_BASE_EDIT_TOOL_NAME = 'feishu_wiki_base_edit'

/** Most operations one `feishu_wiki_base_edit` call may apply. */
export const WIKI_BASE_EDIT_MAX_OPERATIONS = 10

/** Record page size bounds of `feishu_wiki_base_read`. */
const READ_DEFAULT_LIMIT = 50
const READ_MAX_LIMIT = 200

/** Records of each operation shown on a consent card. */
const CARD_PREVIEW_RECORDS = 3

// ---- Arguments ----------------------------------------------------------

const refSchema = z.string().trim().min(1).max(2048)
const nameSchema = z.string().trim().min(1).max(200)
const recordIdSchema = z.string().trim().min(1).max(64)
const fieldMapSchema = z.record(z.string().min(1).max(200), z.unknown())
  .refine(map => Object.keys(map).length > 0, '至少包含一个字段')

export const wikiBaseReadArgsSchema = z.object({
  doc: refSchema,
  table: nameSchema.optional(),
  filter: z.object({
    logic: z.enum(['and', 'or']).optional(),
    conditions: z.array(z.array(z.unknown()).min(2).max(3)).min(1).max(50),
  }).strict().optional(),
  sort: z.array(z.object({ field: nameSchema, desc: z.boolean().optional() }).strict()).min(1).max(10).optional(),
  keyword: z.string().trim().min(1).max(200).optional(),
  search_fields: z.array(nameSchema).min(1).max(20).optional(),
  fields: z.array(nameSchema).min(1).max(100).optional(),
  view_id: nameSchema.optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(READ_MAX_LIMIT).optional(),
}).strict()

const baseOperationSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('create'), records: z.array(fieldMapSchema).min(1).max(BASE_BATCH_MAX_RECORDS) }).strict(),
  z.object({
    command: z.literal('update'),
    records: z.array(z.object({ record_id: recordIdSchema, fields: fieldMapSchema }).strict()).min(1).max(BASE_BATCH_MAX_RECORDS),
  }).strict(),
  z.object({ command: z.literal('delete'), record_ids: z.array(recordIdSchema).min(1).max(BASE_BATCH_MAX_RECORDS) }).strict(),
])

export type WikiBaseOperation = z.infer<typeof baseOperationSchema>

export const wikiBaseEditArgsSchema = z.object({
  doc: refSchema,
  table: nameSchema,
  operations: z.array(baseOperationSchema).min(1).max(WIKI_BASE_EDIT_MAX_OPERATIONS),
}).strict()

// ---- Results ------------------------------------------------------------

/** One field as the tools report it: id, name, type, and Feishu's remaining properties. */
export type WikiBaseFieldView = Readonly<Record<string, unknown>> & {
  readonly field_id: string
  readonly name: string
  readonly type: string
}

/** Successful `feishu_wiki_base_read`. */
export interface WikiBaseReadValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  readonly tables: ReadonlyArray<{ readonly table_id: string; readonly name: string }>
  /** The table read; absent when the call only listed the tables. */
  readonly table_id?: string
  readonly fields?: readonly WikiBaseFieldView[]
  readonly records?: ReadonlyArray<{ readonly record_id: string; readonly fields: Readonly<Record<string, unknown>> }>
  readonly has_more?: boolean
  /** Offset of the next page when `has_more`. */
  readonly next_offset?: number
  readonly timezone?: string
  readonly ignored_fields?: readonly string[]
  /** What `feishu_wiki_base_edit` may do here: `all` (owned by the app), `create` (add records only), or `none`. */
  readonly writable: 'all' | 'create' | 'none'
  readonly warning?: string
}

/** Successful `feishu_wiki_base_edit`. */
export interface WikiBaseEditValue {
  readonly ok: true
  readonly title: string
  readonly node_token: string
  readonly url: string
  readonly table_id: string
  readonly applied: number
  readonly created_record_ids: readonly string[]
  readonly updated: number
  readonly deleted: number
  readonly ignored_fields: readonly string[]
}

// ---- Descriptions -------------------------------------------------------

const VALUE_NOTE = '单元格取值：文本为字符串；数字为数字；单选/多选为选项名数组（如 ["进行中"]，单选也是数组）；日期为 "2026-03-24 10:00" 或毫秒时间戳；'
  + '复选框为布尔；人员为 [{"id":"ou_xxx"}]；关联为 [{"id":"rec_xxx"}]；null 清空。公式、查找引用、创建时间等字段只读。'

const READ_DESCRIPTION =
  '读取知识库中的飞书多维表格（bitable）。doc 传知识库节点链接或 node_token。'
  + '第一次读取某个多维表格会在话题里弹出授权卡，由话题发起人确认，确认后本话题内再次读取不再询问；等待期间不要重复调用。'
  + '不传 table 时只返回数据表列表；传 table（table_id 或表名）时返回字段列表和记录。'
  + 'filter 形如 {"logic":"and","conditions":[["状态","intersects",["进行中"]],["金额",">=",100],["备注","non_empty"]]}，'
  + '运算符有 == != > >= < <= intersects（包含）disjoint（不包含）empty non_empty；日期条件用 "ExactDate(2026-08-07)"，日期不支持 >=。'
  + 'sort 形如 [{"field":"更新时间","desc":true}]；keyword 为关键词搜索，search_fields 指定搜索的字段（默认主字段）；fields 只返回指定字段。'
  + `分页用 offset/limit（limit 默认 ${READ_DEFAULT_LIMIT}，最多 ${READ_MAX_LIMIT}），has_more 为 true 时用 next_offset 继续。`
  + 'writable 说明能做哪些修改：all 表示可增改删记录（本应用创建的表），create 表示只能新增记录，none 表示不能修改。'

const EDIT_DESCRIPTION =
  '修改知识库中飞书多维表格（bitable）某个数据表的记录。先用 feishu_wiki_base_read 读取字段列表，按字段名写入。'
  + `operations 按顺序执行（最多 ${WIKI_BASE_EDIT_MAX_OPERATIONS} 个，每个最多 ${BASE_BATCH_MAX_RECORDS} 条记录）：`
  + 'create（records 为字段名→值的对象数组）、update（records 为 {record_id, fields} 数组，只改给出的字段）、delete（record_ids）。'
  + '本应用创建的多维表格可以增改删；其他多维表格只能新增记录，不能修改或删除已有记录。不会修改数据表和字段结构。'
  + VALUE_NOTE
  + '写入是异步生效的，立刻读取可能还看不到。每次修改都会在话题里弹出授权卡，由话题发起人确认后才执行；等待期间不要重复调用。'

// ---- Parameters ---------------------------------------------------------

const REF_DESCRIPTION = '知识库节点链接 https://<租户>.feishu.cn/wiki/<node_token> 或 node_token'
const TABLE_PROPERTY = { type: 'string', description: '数据表 table_id 或表名' }
const FIELD_MAP_PROPERTY = { type: 'object', description: '字段名（或字段 id）→ 值', additionalProperties: true }

const READ_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: REF_DESCRIPTION },
    table: { ...TABLE_PROPERTY, description: '数据表 table_id 或表名；不传只列出数据表' },
    filter: {
      type: 'object',
      properties: {
        logic: { type: 'string', enum: ['and', 'or'] },
        conditions: { type: 'array', items: { type: 'array', description: '[字段, 运算符, 值]；empty / non_empty 不带值' } },
      },
      required: ['conditions'],
      additionalProperties: false,
    },
    sort: {
      type: 'array',
      items: { type: 'object', properties: { field: { type: 'string' }, desc: { type: 'boolean' } }, required: ['field'], additionalProperties: false },
    },
    keyword: { type: 'string', description: '关键词搜索' },
    search_fields: { type: 'array', items: { type: 'string' }, description: 'keyword 搜索的字段，默认主字段' },
    fields: { type: 'array', items: { type: 'string' }, description: '只返回这些字段' },
    view_id: { type: 'string', description: '按视图读取（应用视图的筛选与排序）' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: READ_MAX_LIMIT },
  },
  required: ['doc'],
  additionalProperties: false,
}

const EDIT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    doc: { type: 'string', description: REF_DESCRIPTION },
    table: TABLE_PROPERTY,
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: WIKI_BASE_EDIT_MAX_OPERATIONS,
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['create', 'update', 'delete'] },
          records: {
            type: 'array',
            maxItems: BASE_BATCH_MAX_RECORDS,
            description: 'create：字段映射数组；update：{record_id, fields} 数组',
            items: {
              type: 'object',
              properties: { record_id: { type: 'string' }, fields: FIELD_MAP_PROPERTY },
              additionalProperties: true,
            },
          },
          record_ids: { type: 'array', maxItems: BASE_BATCH_MAX_RECORDS, items: { type: 'string' }, description: 'delete 的记录 id' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  required: ['doc', 'table', 'operations'],
  additionalProperties: false,
}

// ---- Shared steps -------------------------------------------------------

interface BaseTarget {
  readonly context: WikiCallContext
  readonly bases: BaseApi
  readonly node: WikiNode
  readonly url: string
}

async function baseTarget(kit: WikiToolKit, context: WikiCallContext, doc: string): Promise<BaseTarget | WikiFailure> {
  const bases = context.bases
  if (bases === undefined) return failure('CHANNEL_UNAVAILABLE')
  const ref = parseWikiRef(doc)
  if (ref === undefined) return failure('INVALID_REFERENCE')
  const node = await kit.containedNode(context, ref)
  if ('ok' in node) return node
  if (node.objType !== 'bitable') return failure('UNSUPPORTED_TYPE', `${failure('UNSUPPORTED_TYPE').reason}（该节点类型：${node.objType}）`)
  return { context, bases, node, url: nodeUrl(context.roots, node) }
}

function writableOf(kit: WikiToolKit, target: BaseTarget): 'all' | 'create' | 'none' {
  if (!kit.writeEnabled()) return 'none'
  return ownedByApp(target.node, target.context.botOpenId) ? 'all' : 'create'
}

function pickTable(tables: readonly BaseTable[], wanted: string): BaseTable | string {
  const match = tables.find(table => table.tableId === wanted) ?? tables.find(table => table.name === wanted)
  if (match !== undefined) return match
  const list = tables.map(table => `${table.name}（${table.tableId}）`).join('、') || '无'
  return `找不到数据表「${wanted}」；可用数据表：${list}`
}

function fieldView(field: BaseField): WikiBaseFieldView {
  return { ...field.properties, field_id: field.fieldId, name: field.name, type: field.type }
}

// ---- feishu_wiki_base_read ---------------------------------------------

async function read(kit: WikiToolKit, sessionId: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<object> {
  const args = parseArgs(WIKI_BASE_READ_TOOL_NAME, wikiBaseReadArgsSchema, rawArgs)
  const gate = kit.gate(sessionId, WIKI_BASE_READ_TOOL_NAME)
  if (!gate.ok) return gate
  return await guarded<WikiBaseReadValue>(kit, WIKI_BASE_READ_TOOL_NAME, async () => {
    const target = await baseTarget(kit, gate.context, args.doc)
    if ('ok' in target) return target
    const denied = await kit.readConsent(sessionId, target.context, target.node, signal)
    if (denied !== undefined) return denied
    if (signal.aborted) return failure('ABORTED')
    const token = target.node.objToken
    const tables = await target.bases.listTables(token)
    const base = {
      ok: true as const,
      title: target.node.title,
      node_token: target.node.nodeToken,
      url: target.url,
      tables: tables.map(table => ({ table_id: table.tableId, name: table.name })),
      writable: writableOf(kit, target),
    }
    if (args.table === undefined) return base
    const table = pickTable(tables, args.table)
    if (typeof table === 'string') return failure('INVALID_OPERATION', table)
    const fields = await target.bases.listFields(token, table.tableId)
    const offset = args.offset ?? 0
    const query = {
      ...(args.filter === undefined ? {} : { filter: args.filter }),
      ...(args.sort === undefined ? {} : { sort: args.sort }),
      ...(args.fields === undefined ? {} : { fields: args.fields }),
      ...(args.view_id === undefined ? {} : { viewId: args.view_id }),
      offset,
      limit: args.limit ?? READ_DEFAULT_LIMIT,
    }
    let page
    if (args.keyword === undefined) {
      page = await target.bases.listRecords(token, table.tableId, query)
    } else {
      const primary = fields[0]?.name
      const searchFields = args.search_fields ?? (primary === undefined ? [] : [primary])
      if (searchFields.length === 0) return failure('INVALID_OPERATION', 'keyword 搜索需要 search_fields')
      page = await target.bases.searchRecords(token, table.tableId, { ...query, keyword: args.keyword, searchFields })
    }
    return {
      ...base,
      table_id: table.tableId,
      fields: fields.map(fieldView),
      records: page.records.map(record => ({ record_id: record.recordId, fields: record.fields })),
      has_more: page.hasMore,
      ...(page.hasMore ? { next_offset: offset + page.records.length } : {}),
      ...(page.timezone === undefined ? {} : { timezone: page.timezone }),
      ...(page.ignoredFields.length === 0 ? {} : { ignored_fields: page.ignoredFields }),
    }
  })
}

// ---- feishu_wiki_base_edit ---------------------------------------------

function json(value: unknown): string {
  return preview(JSON.stringify(value) ?? 'null', 120)
}

function cardLines(operations: readonly WikiBaseOperation[], tableName: string): string[] {
  const lines = operations.map((operation, index) => {
    const n = `${index + 1}.`
    switch (operation.command) {
      case 'create': {
        const sample = operation.records.slice(0, CARD_PREVIEW_RECORDS).map(record => `　${json(record)}`)
        const more = operation.records.length > CARD_PREVIEW_RECORDS ? [`　…（共 ${operation.records.length} 条）`] : []
        return [`${n} 新增 ${operation.records.length} 条记录`, ...sample, ...more].join('\n')
      }
      case 'update': {
        const sample = operation.records.slice(0, CARD_PREVIEW_RECORDS).map(record => `　${preview(record.record_id, 40)}：${json(record.fields)}`)
        const more = operation.records.length > CARD_PREVIEW_RECORDS ? [`　…（共 ${operation.records.length} 条）`] : []
        return [`${n} 修改 ${operation.records.length} 条记录`, ...sample, ...more].join('\n')
      }
      case 'delete':
        return `${n} ⚠️ 删除 ${operation.record_ids.length} 条记录：${preview(operation.record_ids.join('、'), 160)}`
    }
  })
  return [`**数据表**：${preview(tableName, 60)}`, `**将执行 ${operations.length} 个操作**`, ...lines]
}

async function edit(kit: WikiToolKit, sessionId: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<object> {
  const args = parseArgs(WIKI_BASE_EDIT_TOOL_NAME, wikiBaseEditArgsSchema, rawArgs)
  const gate = kit.gate(sessionId, WIKI_BASE_EDIT_TOOL_NAME)
  if (!gate.ok) return gate
  return await guarded<WikiBaseEditValue>(kit, WIKI_BASE_EDIT_TOOL_NAME, async () => {
    const target = await baseTarget(kit, gate.context, args.doc)
    if ('ok' in target) return target
    const { node, bases } = target
    if (writableOf(kit, target) !== 'all') {
      const changing = args.operations.find(operation => operation.command !== 'create')
      if (changing !== undefined) {
        return failure('NOT_OWNED', `这个多维表格不是本应用创建的，只能新增记录，不能${changing.command === 'update' ? '修改' : '删除'}已有记录（所有者：${node.owner ?? '未知'}）`)
      }
    }
    const table = pickTable(await bases.listTables(node.objToken), args.table)
    if (typeof table === 'string') return failure('INVALID_OPERATION', table)
    const denied = await kit.consent(sessionId, target.context, 'edit', {
      title: node.title,
      url: target.url,
      location: await kit.locationOf(target.context.api, node),
      details: cardLines(args.operations, table.name),
    }, signal)
    if (denied !== undefined) return denied
    const created: string[] = []
    const ignored: string[] = []
    let updated = 0
    let deleted = 0
    for (const [index, operation] of args.operations.entries()) {
      if (signal.aborted) return { ...failure('ABORTED', `已取消；前 ${index} 个操作已执行`), applied: index }
      try {
        switch (operation.command) {
          case 'create':
            created.push(...await bases.createRecords(node.objToken, table.tableId, operation.records as BaseRecordFields[]))
            break
          case 'update':
            ignored.push(...await bases.updateRecords(
              node.objToken,
              table.tableId,
              Object.fromEntries(operation.records.map(record => [record.record_id, record.fields as BaseRecordFields])),
            ))
            updated += operation.records.length
            break
          case 'delete':
            await bases.deleteRecords(node.objToken, table.tableId, operation.record_ids)
            deleted += operation.record_ids.length
            break
        }
      } catch (error) {
        const reason = failureOf(error).reason
        return { ...failure('EDIT_FAILED', `第 ${index + 1} 个操作失败：${reason}；前 ${index} 个操作已执行`), applied: index }
      }
    }
    return {
      ok: true,
      title: node.title,
      node_token: node.nodeToken,
      url: target.url,
      table_id: table.tableId,
      applied: args.operations.length,
      created_record_ids: created,
      updated,
      deleted,
      ignored_fields: [...new Set(ignored)],
    }
  })
}

// ---- Specs --------------------------------------------------------------

/** The Base tool family. */
export const BASE_TOOL_SPECS: readonly WikiToolSpec[] = [
  {
    name: WIKI_BASE_READ_TOOL_NAME,
    access: 'read',
    description: READ_DESCRIPTION,
    parameters: READ_PARAMETERS,
    execute: read,
    presentCall: args => `读取知识库多维表格：${display(args.doc)}`,
  },
  {
    name: WIKI_BASE_EDIT_TOOL_NAME,
    access: 'write',
    description: EDIT_DESCRIPTION,
    parameters: EDIT_PARAMETERS,
    execute: edit,
    presentCall: args => `修改知识库多维表格：${display(args.doc)}`,
  },
]
