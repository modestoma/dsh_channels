/**
 * Domain-agnostic implementation of the `feishuBitable` v1 service
 * (`ctx.get('feishuBitable')`).
 *
 * Wraps the active {@link FeishuChannel}'s `bases` (`base/v3`) and `wiki`
 * (`wiki/v2`) APIs behind structured {@link BitableResult} outcomes, resolving
 * both `/base/<token>` and `/wiki/<node_token>` targets, serializing writes per
 * `<baseToken>:<tableId>` (as required by `base/v3`), and notifying listeners on
 * channel availability transitions.
 *
 * @module dsh-channels/bitable/service
 */

import type { z } from 'zod'
import { FeishuApiError } from '../feishu-channel.ts'
import type { FeishuChannel } from '../feishu-channel.ts'
import type { BaseRecordFields } from '../feishu/wiki/base-api.ts'
import {
  BITABLE_BATCH_MAX_RECORDS,
  bitableCreateRecordsInputSchema,
  bitableListRecordsInputSchema,
  bitableTargetInputSchema,
  bitableUpdateRecordsInputSchema,
  FEISHU_BITABLE_VERSION,
  parseBitableUrl,
} from './contract.ts'
import type {
  BitableCreateRecordsInput,
  BitableFailureCode,
  BitableListRecordsInput,
  BitableRecordPage,
  BitableResult,
  BitableTargetInput,
  BitableTableSchema,
  BitableUpdateRecordsInput,
  FeishuBitableService,
  ParsedBitableTarget,
} from './contract.ts'

export interface FeishuBitableDeps {
  started(): boolean
  channel(): FeishuChannel | undefined
  warn(message: string, ...args: unknown[]): void
}

const MAX_WIKI_TOKEN_CACHE = 64

const PERMISSION_ERROR_CODES = new Set([403, 91403, 1254302, 1254607])
const NOT_FOUND_ERROR_CODES = new Set([404, 91404, 131005, 1254004, 1254040, 1254041, 1254042, 1254043])
const RATE_LIMIT_ERROR_CODES = new Set([429, 99991400])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length === 0 ? 'input' : issue.path.join('.')}: ${issue.message}`)
    .join('; ')
}

function failure(code: BitableFailureCode, message: string): { readonly ok: false; readonly code: BitableFailureCode; readonly message: string } {
  return { ok: false, code, message }
}

function classifyApiError(error: unknown): { readonly code: BitableFailureCode; readonly message: string } {
  const detail = error instanceof FeishuApiError ? error.detail : messageOf(error)
  const apiCode = error instanceof FeishuApiError ? error.code : undefined

  if ((apiCode !== undefined && PERMISSION_ERROR_CODES.has(apiCode))
    || /forbidden|permission|no\s*permission|无权限|access\s*denied/iu.test(detail)) {
    return { code: 'permission-denied', message: `飞书多维表格权限不足：${detail}` }
  }
  if ((apiCode !== undefined && NOT_FOUND_ERROR_CODES.has(apiCode))
    || /not\s*found|record.*not\s*exist|table.*not\s*exist|field.*not\s*exist|node.*not\s*exist/iu.test(detail)) {
    return { code: 'not-found', message: `飞书多维表格目标不存在或已被删除：${detail}` }
  }
  if ((apiCode !== undefined && RATE_LIMIT_ERROR_CODES.has(apiCode))
    || /rate\s*limit|too\s*many\s*requests|frequency/iu.test(detail)) {
    return { code: 'rate-limited', message: `飞书多维表格接口触发限流：${detail}` }
  }
  return { code: 'api-error', message: `飞书多维表格接口调用失败：${detail}` }
}

interface ResolvedTable {
  readonly channel: FeishuChannel
  readonly baseToken: string
  readonly tableId: string
  readonly tableName: string
}

export class FeishuBitable implements FeishuBitableService {
  readonly version = FEISHU_BITABLE_VERSION
  /** `<baseToken>:<tableId>` -> tail write queue so `base/v3` writes never overlap on one table. */
  private readonly tableQueues = new Map<string, Promise<unknown>>()
  /** Every active service call, awaited by `drain()`. */
  private readonly inFlight = new Set<Promise<unknown>>()
  /** Cached wiki `nodeToken` -> Bitable `baseToken` (`objToken`), bounded to 64 entries. */
  private readonly wikiNodeToBaseToken = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private admitting = false

  constructor(private readonly deps: FeishuBitableDeps) {}

  /** Mark service ready once the Feishu channel is connected. */
  open(): void {
    this.admitting = true
    this.notifyListeners()
  }

  /** Stop admitting new calls ahead of channel shutdown and notify subscribers. */
  close(): void {
    this.admitting = false
    this.wikiNodeToBaseToken.clear()
    this.notifyListeners()
  }

  /** Wait for all active read/write operations to finish. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0 || this.tableQueues.size > 0) {
      await Promise.allSettled([...this.inFlight, ...this.tableQueues.values()])
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.deps.warn('dsh-channels: feishuBitable listener threw: %s', messageOf(error))
      }
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const done = promise.finally(() => {
      this.inFlight.delete(done)
    })
    this.inFlight.add(done)
    return done
  }

  private serializeTable<T>(tableKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tableQueues.get(tableKey) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.tableQueues.get(tableKey) === tracked) {
        this.tableQueues.delete(tableKey)
      }
    })
    this.tableQueues.set(tableKey, tracked)
    return next
  }

  private currentChannel(): FeishuChannel | undefined {
    if (!this.admitting || !this.deps.started()) return undefined
    const channel = this.deps.channel()
    if (channel === undefined || channel.bases === undefined) return undefined
    return channel
  }

  private rememberWikiToken(nodeToken: string, baseToken: string): void {
    if (this.wikiNodeToBaseToken.has(nodeToken)) {
      this.wikiNodeToBaseToken.delete(nodeToken)
    }
    this.wikiNodeToBaseToken.set(nodeToken, baseToken)
    if (this.wikiNodeToBaseToken.size > MAX_WIKI_TOKEN_CACHE) {
      const oldest = this.wikiNodeToBaseToken.keys().next().value
      if (oldest !== undefined) this.wikiNodeToBaseToken.delete(oldest)
    }
  }

  private parseTarget(input: BitableTargetInput): { ok: true; parsed: ParsedBitableTarget } | { ok: false; error: BitableResult<never> } {
    const parsed = parseBitableUrl(input.url, input.table)
    if (parsed === undefined) {
      return {
        ok: false,
        error: failure(
          'invalid-target',
          '多维表格链接不合法：请传入 https://.../base/<token>?table=<tableId> 或 https://.../wiki/<node_token>?table=<tableId>',
        ),
      }
    }
    return { ok: true, parsed }
  }

  private async resolveTable(target: ParsedBitableTarget): Promise<{ ok: true; resolved: ResolvedTable } | { ok: false; error: BitableResult<never> }> {
    const channel = this.currentChannel()
    if (channel === undefined || channel.bases === undefined) {
      return { ok: false, error: failure('not-connected', '飞书渠道尚未连接或未提供多维表格能力') }
    }

    let baseToken: string
    if (target.kind === 'base') {
      baseToken = target.token
    } else {
      const cached = this.wikiNodeToBaseToken.get(target.token)
      if (cached !== undefined) {
        baseToken = cached
      } else {
        if (channel.wiki === undefined) {
          return { ok: false, error: failure('not-connected', '飞书渠道尚未连接知识库接口，无法解析 wiki 多维表格链接') }
        }
        try {
          const node = await channel.wiki.getNode(target.token, 'wiki')
          if (node.objType !== 'bitable') {
            return {
              ok: false,
              error: failure('invalid-target', `知识库节点 "${target.token}" 类型为 "${node.objType}"，不是多维表格（bitable）`),
            }
          }
          baseToken = node.objToken
          this.rememberWikiToken(target.token, baseToken)
        } catch (error) {
          const classified = classifyApiError(error)
          return { ok: false, error: failure(classified.code, classified.message) }
        }
      }
    }

    try {
      const tables = await channel.bases.listTables(baseToken)
      if (tables.length === 0) {
        return { ok: false, error: failure('table-not-found', `多维表格 "${baseToken}" 中没有任何数据表`) }
      }
      if (target.table !== undefined) {
        const match = tables.find(item => item.tableId === target.table) ?? tables.find(item => item.name === target.table)
        if (match === undefined) {
          const available = tables.map(item => `${item.name}（${item.tableId}）`).join('、')
          return {
            ok: false,
            error: failure('table-not-found', `找不到数据表「${target.table}」；可用数据表：${available}`),
          }
        }
        return { ok: true, resolved: { channel, baseToken, tableId: match.tableId, tableName: match.name } }
      }
      if (tables.length > 1) {
        const available = tables.map(item => `${item.name}（${item.tableId}）`).join('、')
        return {
          ok: false,
          error: failure(
            'ambiguous-table',
            `该多维表格包含 ${tables.length} 张数据表（${available}），请在链接中添加 ?table=<tableId> 或指定 table`,
          ),
        }
      }
      return { ok: true, resolved: { channel, baseToken, tableId: tables[0]!.tableId, tableName: tables[0]!.name } }
    } catch (error) {
      const classified = classifyApiError(error)
      if (classified.code === 'not-found' && target.kind === 'wiki') {
        this.wikiNodeToBaseToken.delete(target.token)
      }
      return { ok: false, error: failure(classified.code, classified.message) }
    }
  }

  inspectTable(target: BitableTargetInput): Promise<BitableResult<BitableTableSchema>> {
    return this.track(this.doInspectTable(target))
  }

  private async doInspectTable(target: BitableTargetInput): Promise<BitableResult<BitableTableSchema>> {
    const validated = bitableTargetInputSchema.safeParse(target)
    if (!validated.success) return failure('invalid-target', `参数不合法：${issuesText(validated.error)}`)
    const parsedTarget = this.parseTarget(validated.data)
    if (!parsedTarget.ok) return parsedTarget.error
    const table = await this.resolveTable(parsedTarget.parsed)
    if (!table.ok) return table.error
    const { channel, baseToken, tableId, tableName } = table.resolved
    try {
      const fields = await channel.bases!.listFields(baseToken, tableId)
      return {
        ok: true,
        baseToken,
        tableId,
        tableName,
        fields: fields.map(field => ({
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          properties: field.properties,
        })),
      }
    } catch (error) {
      const classified = classifyApiError(error)
      if (classified.code === 'not-found' && parsedTarget.parsed.kind === 'wiki') {
        this.wikiNodeToBaseToken.delete(parsedTarget.parsed.token)
      }
      return failure(classified.code, classified.message)
    }
  }

  listRecords(input: BitableListRecordsInput): Promise<BitableResult<BitableRecordPage>> {
    return this.track(this.doListRecords(input))
  }

  private async doListRecords(input: BitableListRecordsInput): Promise<BitableResult<BitableRecordPage>> {
    const validated = bitableListRecordsInputSchema.safeParse(input)
    if (!validated.success) return failure('invalid-target', `参数不合法：${issuesText(validated.error)}`)
    const parsedTarget = this.parseTarget(validated.data)
    if (!parsedTarget.ok) return parsedTarget.error
    const table = await this.resolveTable(parsedTarget.parsed)
    if (!table.ok) return table.error
    const { channel, baseToken, tableId } = table.resolved
    const offset = validated.data.offset ?? 0
    const limit = validated.data.limit ?? BITABLE_BATCH_MAX_RECORDS
    try {
      const page = await channel.bases!.listRecords(baseToken, tableId, {
        ...(validated.data.fields === undefined ? {} : { fields: validated.data.fields }),
        ...(validated.data.filter === undefined ? {} : { filter: validated.data.filter }),
        ...(validated.data.sort === undefined ? {} : { sort: validated.data.sort }),
        ...(validated.data.viewId === undefined ? {} : { viewId: validated.data.viewId }),
        offset,
        limit,
      })
      return {
        ok: true,
        baseToken,
        tableId,
        records: page.records,
        hasMore: page.hasMore,
        ...(page.hasMore ? { nextOffset: offset + page.records.length } : {}),
        ...(page.rev === undefined ? {} : { rev: page.rev }),
        ignoredFields: page.ignoredFields,
      }
    } catch (error) {
      const classified = classifyApiError(error)
      if (classified.code === 'not-found' && parsedTarget.parsed.kind === 'wiki') {
        this.wikiNodeToBaseToken.delete(parsedTarget.parsed.token)
      }
      return failure(classified.code, classified.message)
    }
  }

  createRecords(
    input: BitableCreateRecordsInput,
  ): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly recordIds: readonly string[] }>> {
    return this.track(this.doCreateRecords(input))
  }

  private async doCreateRecords(
    input: BitableCreateRecordsInput,
  ): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly recordIds: readonly string[] }>> {
    const validated = bitableCreateRecordsInputSchema.safeParse(input)
    if (!validated.success) return failure('invalid-target', `参数不合法：${issuesText(validated.error)}`)
    const parsedTarget = this.parseTarget(validated.data)
    if (!parsedTarget.ok) return parsedTarget.error
    const table = await this.resolveTable(parsedTarget.parsed)
    if (!table.ok) return table.error
    const { channel, baseToken, tableId } = table.resolved
    return await this.serializeTable(`${baseToken}:${tableId}`, async () => {
      if (this.currentChannel() !== channel) {
        return failure('not-connected', '飞书渠道已断开，无法写入多维表格')
      }
      try {
        const recordIds = await channel.bases!.createRecords(
          baseToken,
          tableId,
          validated.data.records as BaseRecordFields[],
        )
        return { ok: true, baseToken, tableId, recordIds }
      } catch (error) {
        const classified = classifyApiError(error)
        if (classified.code === 'not-found' && parsedTarget.parsed.kind === 'wiki') {
          this.wikiNodeToBaseToken.delete(parsedTarget.parsed.token)
        }
        return failure(classified.code, classified.message)
      }
    })
  }

  updateRecords(
    input: BitableUpdateRecordsInput,
  ): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly ignoredFields: readonly string[] }>> {
    return this.track(this.doUpdateRecords(input))
  }

  private async doUpdateRecords(
    input: BitableUpdateRecordsInput,
  ): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly ignoredFields: readonly string[] }>> {
    const validated = bitableUpdateRecordsInputSchema.safeParse(input)
    if (!validated.success) return failure('invalid-target', `参数不合法：${issuesText(validated.error)}`)
    const parsedTarget = this.parseTarget(validated.data)
    if (!parsedTarget.ok) return parsedTarget.error
    const table = await this.resolveTable(parsedTarget.parsed)
    if (!table.ok) return table.error
    const { channel, baseToken, tableId } = table.resolved
    return await this.serializeTable(`${baseToken}:${tableId}`, async () => {
      if (this.currentChannel() !== channel) {
        return failure('not-connected', '飞书渠道已断开，无法更新多维表格')
      }
      try {
        const ignoredFields = await channel.bases!.updateRecords(
          baseToken,
          tableId,
          validated.data.updates as Readonly<Record<string, BaseRecordFields>>,
        )
        return { ok: true, baseToken, tableId, ignoredFields }
      } catch (error) {
        const classified = classifyApiError(error)
        if (classified.code === 'not-found' && parsedTarget.parsed.kind === 'wiki') {
          this.wikiNodeToBaseToken.delete(parsedTarget.parsed.token)
        }
        return failure(classified.code, classified.message)
      }
    })
  }
}
