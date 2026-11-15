/**
 * Unit & contract tests for the domain-agnostic `feishuBitable` v1 service
 * (`src/bitable/contract.ts`, `src/bitable/service.ts`) and `FeishuService.bitable()`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FEISHU_BITABLE_SERVICE,
  FEISHU_BITABLE_VERSION,
  parseBitableUrl,
} from '../src/bitable/contract.ts'
import type { FeishuBitableService } from '../src/bitable/contract.ts'
import { FeishuBitable } from '../src/bitable/service.ts'
import { resolveConfig } from '../src/config.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { ChannelFactory, FeishuChannel } from '../src/feishu-channel.ts'
import type { WikiApi, WikiNode } from '../src/feishu/wiki/api.ts'
import type { BaseApi, BaseField, BaseRecord, BaseRecordPage, BaseTable } from '../src/feishu/wiki/base-api.ts'
import { makeChannel, makeHostContext, TestFeishuService as FeishuService } from './helpers.ts'

function makeFakeBitableChannel() {
  const tablesByBase = new Map<string, BaseTable[]>([
    ['appBaseSingle', [{ tableId: 'tblSingle', name: '主表' }]],
    ['appBaseMulti', [{ tableId: 'tblOne', name: '问题库' }, { tableId: 'tblTwo', name: '归档' }]],
    ['appWikiResolved', [{ tableId: 'tblWiki1', name: '已知问题' }]],
    ['appEmpty', []],
  ])
  const fieldsByTable = new Map<string, BaseField[]>([
    ['appBaseSingle:tblSingle', [
      { fieldId: 'fld1', name: '问题ID', type: 'text', properties: {} },
      { fieldId: 'fld2', name: '人工状态', type: 'select', properties: { options: [{ name: '已确认' }] } },
    ]],
    ['appBaseMulti:tblOne', [
      { fieldId: 'fldA', name: '问题ID', type: 'text', properties: {} },
    ]],
    ['appWikiResolved:tblWiki1', [
      { fieldId: 'fldW1', name: '问题ID', type: 'text', properties: {} },
      { fieldId: 'fldW2', name: '人工确认结论', type: 'text', properties: {} },
    ]],
  ])
  const recordsByTable = new Map<string, BaseRecord[]>([
    ['appBaseSingle:tblSingle', [
      { recordId: 'rec1', fields: { 问题ID: 'ISS-order-0001', 人工状态: ['已确认'] } },
      { recordId: 'rec2', fields: { 问题ID: 'ISS-order-0002', 人工状态: [] } },
      { recordId: 'rec3', fields: { 问题ID: 'ISS-order-0003', 人工状态: ['待验证'] } },
    ]],
    ['appWikiResolved:tblWiki1', [
      { recordId: 'recW1', fields: { 问题ID: 'ISS-pay-0001', 人工确认结论: '已根治' } },
    ]],
  ])
  const nodes = new Map<string, WikiNode>([
    ['wikcnBase0001', {
      spaceId: '1001',
      nodeToken: 'wikcnBase0001',
      objToken: 'appWikiResolved',
      objType: 'bitable',
      nodeType: 'origin',
      title: '线上问题台账',
      hasChild: false,
    }],
    ['wikcnDocx0001', {
      spaceId: '1001',
      nodeToken: 'wikcnDocx0001',
      objToken: 'doxcn0001',
      objType: 'docx',
      nodeType: 'origin',
      title: '说明文档',
      hasChild: false,
    }],
  ])

  let seq = 0
  let inFlightWrites = 0
  let maxConcurrentWrites = 0

  const wiki: Pick<WikiApi, 'getNode'> = {
    getNode: vi.fn(async (token: string) => {
      const node = nodes.get(token)
      if (node === undefined) throw new FeishuApiError('code=131005 node not found', 131005)
      return node
    }),
  }

  const bases: BaseApi = {
    listTables: vi.fn(async (baseToken: string) => {
      return tablesByBase.get(baseToken) ?? []
    }),
    listFields: vi.fn(async (baseToken: string, tableId: string) => {
      return fieldsByTable.get(`${baseToken}:${tableId}`) ?? []
    }),
    listRecords: vi.fn(async (baseToken: string, tableId: string, query): Promise<BaseRecordPage> => {
      const all = recordsByTable.get(`${baseToken}:${tableId}`) ?? []
      const slice = all.slice(query.offset, query.offset + query.limit)
      return {
        records: slice,
        hasMore: query.offset + slice.length < all.length,
        rev: 1,
        ignoredFields: [],
      }
    }),
    searchRecords: vi.fn(async () => ({ records: [], hasMore: false, ignoredFields: [] })),
    createRecords: vi.fn(async (baseToken: string, tableId: string, rows) => {
      inFlightWrites += 1
      maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites)
      await new Promise(resolve => setTimeout(resolve, 15))
      inFlightWrites -= 1
      const list = recordsByTable.get(`${baseToken}:${tableId}`) ?? []
      const ids: string[] = []
      for (const row of rows) {
        seq += 1
        const recordId = `rec_new_${seq}`
        list.push({ recordId, fields: row })
        ids.push(recordId)
      }
      recordsByTable.set(`${baseToken}:${tableId}`, list)
      return ids
    }),
    updateRecords: vi.fn(async (baseToken: string, tableId: string, updates) => {
      inFlightWrites += 1
      maxConcurrentWrites = Math.max(maxConcurrentWrites, inFlightWrites)
      await new Promise(resolve => setTimeout(resolve, 15))
      inFlightWrites -= 1
      const list = recordsByTable.get(`${baseToken}:${tableId}`) ?? []
      for (const [recordId, patch] of Object.entries(updates)) {
        const idx = list.findIndex(item => item.recordId === recordId)
        if (idx < 0) throw new FeishuApiError(`code=1254043 record ${recordId} not found`, 1254043)
        list[idx] = { recordId, fields: { ...list[idx]!.fields, ...(patch as Record<string, unknown>) } }
      }
      return []
    }),
    deleteRecords: vi.fn(async () => {}),
  }

  const base = makeChannel()
  const channel = Object.assign(base, {
    wiki: wiki as unknown as WikiApi,
    bases,
  }) as unknown as FeishuChannel

  return {
    channel,
    wiki,
    bases,
    recordsByTable,
    getMaxConcurrentWrites: () => maxConcurrentWrites,
  }
}

describe('feishuBitable URL parser & contract', () => {
  it('parses base, bitable, and wiki URLs with query/explicit table overrides', () => {
    expect(FEISHU_BITABLE_SERVICE).toBe('feishuBitable')
    expect(FEISHU_BITABLE_VERSION).toBe(1)

    expect(parseBitableUrl('https://mi.feishu.cn/base/appBase123?table=tblOne&view=vew1')).toEqual({
      kind: 'base',
      token: 'appBase123',
      table: 'tblOne',
    })
    expect(parseBitableUrl('https://mi.feishu.cn/bitable/appBase123')).toEqual({
      kind: 'base',
      token: 'appBase123',
    })
    expect(parseBitableUrl('https://mi.feishu.cn/wiki/wikcnBase0001?table=tblOld', 'tblExplicit')).toEqual({
      kind: 'wiki',
      token: 'wikcnBase0001',
      table: 'tblExplicit',
    })

    expect(parseBitableUrl('http://mi.feishu.cn/base/appBase123')).toBeUndefined()
    expect(parseBitableUrl('https://mi.feishu.cn/wiki/space/7160145948')).toBeUndefined()
    expect(parseBitableUrl('https://mi.feishu.cn/docx/doxcn123456')).toBeUndefined()
    expect(parseBitableUrl('not-a-url')).toBeUndefined()
  })
})

describe('FeishuBitable service', () => {
  it('inspects schema, auto-selects single table, resolves wiki node, and caches wiki token', async () => {
    const fake = makeFakeBitableChannel()
    let started = true
    const service = new FeishuBitable({
      started: () => started,
      channel: () => fake.channel,
      warn: vi.fn(),
    })

    const disconnected = await service.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseSingle' })
    expect(disconnected).toMatchObject({ ok: false, code: 'not-connected' })

    const changes = vi.fn()
    const unlisten = service.onChange(changes)
    service.open()
    expect(changes).toHaveBeenCalledTimes(1)

    const single = await service.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseSingle' })
    expect(single).toMatchObject({
      ok: true,
      baseToken: 'appBaseSingle',
      tableId: 'tblSingle',
      tableName: '主表',
      fields: [
        { name: '问题ID', type: 'text' },
        { name: '人工状态', type: 'select' },
      ],
    })

    const multiNoTable = await service.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseMulti' })
    expect(multiNoTable).toMatchObject({ ok: false, code: 'ambiguous-table' })

    const multiByName = await service.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseMulti', table: '问题库' })
    expect(multiByName).toMatchObject({ ok: true, baseToken: 'appBaseMulti', tableId: 'tblOne' })

    const nonBitableWiki = await service.inspectTable({ url: 'https://mi.feishu.cn/wiki/wikcnDocx0001' })
    expect(nonBitableWiki).toMatchObject({ ok: false, code: 'invalid-target' })

    const wikiFirst = await service.inspectTable({ url: 'https://mi.feishu.cn/wiki/wikcnBase0001' })
    const wikiSecond = await service.listRecords({ url: 'https://mi.feishu.cn/wiki/wikcnBase0001' })
    expect(wikiFirst).toMatchObject({ ok: true, baseToken: 'appWikiResolved', tableId: 'tblWiki1' })
    expect(wikiSecond).toMatchObject({ ok: true, baseToken: 'appWikiResolved', tableId: 'tblWiki1' })
    expect(vi.mocked(fake.wiki.getNode).mock.calls.filter(args => args[0] === 'wikcnBase0001')).toHaveLength(1)

    started = false
    service.close()
    expect(changes).toHaveBeenCalledTimes(2)
    unlisten()
  })

  it('paginates listRecords with nextOffset and serializes concurrent writes per table', async () => {
    const fake = makeFakeBitableChannel()
    const service = new FeishuBitable({
      started: () => true,
      channel: () => fake.channel,
      warn: vi.fn(),
    })
    service.open()

    const page1 = await service.listRecords({
      url: 'https://mi.feishu.cn/base/appBaseSingle',
      offset: 0,
      limit: 2,
    })
    expect(page1).toMatchObject({
      ok: true,
      hasMore: true,
      nextOffset: 2,
      records: [{ recordId: 'rec1' }, { recordId: 'rec2' }],
    })
    if (!page1.ok) throw new Error('expected ok')
    const page2 = await service.listRecords({
      url: 'https://mi.feishu.cn/base/appBaseSingle',
      offset: page1.nextOffset,
      limit: 2,
    })
    expect(page2).toMatchObject({
      ok: true,
      hasMore: false,
      records: [{ recordId: 'rec3' }],
    })

    const [c1, c2, u1] = await Promise.all([
      service.createRecords({
        url: 'https://mi.feishu.cn/base/appBaseSingle',
        records: [{ 问题ID: 'ISS-order-0004' }],
      }),
      service.createRecords({
        url: 'https://mi.feishu.cn/base/appBaseSingle',
        records: [{ 问题ID: 'ISS-order-0005' }],
      }),
      service.updateRecords({
        url: 'https://mi.feishu.cn/base/appBaseSingle',
        updates: { rec1: { 问题ID: 'ISS-order-0001-updated' } },
      }),
    ])
    expect(c1).toMatchObject({ ok: true, recordIds: ['rec_new_1'] })
    expect(c2).toMatchObject({ ok: true, recordIds: ['rec_new_2'] })
    expect(u1).toMatchObject({ ok: true })
    expect(fake.getMaxConcurrentWrites()).toBe(1)

    service.close()
    await service.drain()
  })

  it('classifies permission-denied, not-found, and rate-limited API errors', async () => {
    const fake = makeFakeBitableChannel()
    const service = new FeishuBitable({
      started: () => true,
      channel: () => fake.channel,
      warn: vi.fn(),
    })
    service.open()

    vi.spyOn(fake.bases, 'listFields').mockRejectedValueOnce(new FeishuApiError('code=1254302 permission denied', 1254302))
    expect(await service.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseSingle' })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    })

    const missingRec = await service.updateRecords({
      url: 'https://mi.feishu.cn/base/appBaseSingle',
      updates: { rec_missing: { 问题ID: 'x' } },
    })
    expect(missingRec).toMatchObject({ ok: false, code: 'not-found' })

    vi.spyOn(fake.bases, 'listRecords').mockRejectedValueOnce(new FeishuApiError('code=99991400 rate limit exceeded', 99991400))
    expect(await service.listRecords({ url: 'https://mi.feishu.cn/base/appBaseSingle' })).toMatchObject({
      ok: false,
      code: 'rate-limited',
    })
  })

  it('wires feishuBitable through FeishuService lifecycle and Cordis context', async () => {
    const fake = makeFakeBitableChannel()
    const config = resolveConfig({
      baseDir: mkdtempSync(path.join(tmpdir(), 'dsh-bitable-ws-')),
      statusRefreshMs: 60_000,
    })
    const ctxState = makeHostContext()
    const factory: ChannelFactory = () => fake.channel

    const service = new FeishuService(ctxState.ctx, config, factory)
    const bitable: FeishuBitableService = service.bitable()
    expect(bitable.version).toBe(1)
    expect(await bitable.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseSingle' })).toMatchObject({
      ok: false,
      code: 'not-connected',
    })

    await service.start()
    expect(await bitable.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseSingle' })).toMatchObject({
      ok: true,
      baseToken: 'appBaseSingle',
      tableId: 'tblSingle',
    })

    await service.shutdown()
    expect(await bitable.inspectTable({ url: 'https://mi.feishu.cn/base/appBaseSingle' })).toMatchObject({
      ok: false,
      code: 'not-connected',
    })
  })
})
