/**
 * Wiki tools: root containment, the wiki whitelist gate, topic-owner consent
 * cards, app ownership and revision checks, and the OpenAPI request bodies.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ToolDefinition, ToolRuntime } from '../src/host/agent.ts'
import { FeishuApiError } from '../src/feishu-channel.ts'
import type { CardActionEvent } from '../src/feishu-channel.ts'
import { createWikiApi } from '../src/feishu/wiki/api.ts'
import type { WikiApi, WikiNode, WikiRawRequest, WikiUpdateRequest, WikiUpdateResult } from '../src/feishu/wiki/api.ts'
import { createBaseApi } from '../src/feishu/wiki/base-api.ts'
import type { BaseApi, BaseField, BaseRecordFields, BaseRecordPage, BaseTable } from '../src/feishu/wiki/base-api.ts'
import { WikiConsent } from '../src/feishu/wiki/consent.ts'
import { createSheetApi } from '../src/feishu/wiki/sheet-api.ts'
import type { SheetApi, SheetCsv, SheetWorkbook, SheetWriteRequest } from '../src/feishu/wiki/sheet-api.ts'
import { parseWikiRef, parseWikiRootLink } from '../src/feishu/wiki/links.ts'
import {
  WIKI_CREATE_TOOL_NAME, WIKI_EDIT_TOOL_NAME, WIKI_LIST_TOOL_NAME, WIKI_READ_TOOL_NAME, WikiToolRuntime,
  renderWikiResult,
} from '../src/feishu/wiki/tools.ts'
import { makeAgentContext, makeChannel } from './helpers.ts'

const SPACE_LINK = 'https://mi.feishu.cn/wiki/space/7160145948494381236'
const NODE_LINK = 'https://mi.feishu.cn/wiki/wikcnRootNode0001'

function node(partial: Partial<WikiNode> & Pick<WikiNode, 'nodeToken'>): WikiNode {
  return {
    spaceId: '7160145948494381236',
    objToken: `doc_${partial.nodeToken}`,
    objType: 'docx',
    nodeType: 'origin',
    title: partial.nodeToken,
    hasChild: false,
    ...partial,
  }
}

/** A small tree: space A holds root → child → grandchild; space B holds other. */
function fakeApi() {
  const nodes = new Map<string, WikiNode>([
    ['wikcnRootNode0001', node({ nodeToken: 'wikcnRootNode0001', title: '团队空间根', hasChild: true })],
    ['wikcnChildNode001', node({ nodeToken: 'wikcnChildNode001', parentNodeToken: 'wikcnRootNode0001', title: '子页面', owner: 'bot-open-id' })],
    ['wikcnHumanDoc0001', node({ nodeToken: 'wikcnHumanDoc0001', parentNodeToken: 'wikcnRootNode0001', title: '人写的', owner: 'ou_human' })],
    ['wikcnSheetNode001', node({ nodeToken: 'wikcnSheetNode001', parentNodeToken: 'wikcnRootNode0001', objType: 'sheet' })],
    ['wikcnSheetOwned01', node({ nodeToken: 'wikcnSheetOwned01', parentNodeToken: 'wikcnRootNode0001', objType: 'sheet', title: '预算表', owner: 'bot-open-id' })],
    ['wikcnBaseOwned001', node({ nodeToken: 'wikcnBaseOwned001', parentNodeToken: 'wikcnRootNode0001', objType: 'bitable', title: '机器人台账', owner: 'bot-open-id' })],
    ['wikcnBaseHuman001', node({ nodeToken: 'wikcnBaseHuman001', parentNodeToken: 'wikcnRootNode0001', objType: 'bitable', title: '需求池', owner: 'ou_human' })],
    ['wikcnOtherSpace01', node({ nodeToken: 'wikcnOtherSpace01', spaceId: '999', title: '别的空间' })],
  ])
  const api = {
    updates: [] as Array<{ documentId: string; request: WikiUpdateRequest }>,
    revision: 7,
    getNode: vi.fn(async (token: string) => {
      const found = nodes.get(token)
      if (found === undefined) throw new FeishuApiError('code=131005 not found', 131005)
      return found
    }),
    spaceName: vi.fn(async () => '研发知识库'),
    listChildren: vi.fn(async (_spaceId: string, parent: string | undefined) => ({
      items: [...nodes.values()].filter(item => item.parentNodeToken === parent && item.spaceId === '7160145948494381236'),
    })),
    createNode: vi.fn(async (spaceId: string, parent: string | undefined, title: string, objType: 'docx' | 'sheet' | 'bitable') => {
      const created = node({ nodeToken: 'wikcnCreated00001', spaceId, ...(parent === undefined ? {} : { parentNodeToken: parent }), title, objType, owner: 'bot-open-id' })
      nodes.set(created.nodeToken, created)
      return created
    }),
    documentRevision: vi.fn(async () => api.revision),
    fetchDocument: vi.fn(async () => ({ revisionId: api.revision, content: '# 标题\n正文' })),
    updateDocument: vi.fn(async (documentId: string, request: WikiUpdateRequest): Promise<WikiUpdateResult> => {
      api.updates.push({ documentId, request })
      api.revision += 1
      return { result: 'success', revisionId: api.revision, warnings: [] }
    }),
  }
  return api satisfies WikiApi
}

function fakeSheets() {
  const sheets = {
    revision: 30,
    writes: [] as Array<{ token: string; request: SheetWriteRequest }>,
    workbook: vi.fn(async (): Promise<SheetWorkbook> => ({
      revision: sheets.revision,
      sheets: [
        { sheetId: 'sh1', title: '数据', index: 0, resourceType: 'sheet', hidden: false, rowCount: 200, columnCount: 6 },
        { sheetId: 'sh2', title: '草稿', index: 1, resourceType: 'sheet', hidden: true, rowCount: 100, columnCount: 26 },
        { sheetId: 'bt1', title: '嵌入表', index: 2, resourceType: 'bitable', hidden: false },
      ],
    })),
    readCsv: vi.fn(async (): Promise<SheetCsv> => ({
      csv: '[row=1] 项目,金额\n[row=2] 差旅,1200',
      actualRange: 'A1:B2',
      currentRegion: 'A1:B2',
      hasMore: false,
    })),
    writeCells: vi.fn(async (token: string, request: SheetWriteRequest) => {
      sheets.writes.push({ token, request })
      sheets.revision += 1
    }),
  }
  return sheets satisfies SheetApi
}

function fakeBases() {
  const bases = {
    listTables: vi.fn(async (): Promise<readonly BaseTable[]> => [{ tableId: 'tbl1', name: '需求' }, { tableId: 'tbl2', name: '归档' }]),
    listFields: vi.fn(async (): Promise<readonly BaseField[]> => [
      { fieldId: 'fld1', name: '标题', type: 'text', properties: { style: { type: 'plain' } } },
      { fieldId: 'fld2', name: '状态', type: 'select', properties: { options: [{ name: '进行中' }] } },
    ]),
    listRecords: vi.fn(async (): Promise<BaseRecordPage> => ({
      records: [{ recordId: 'rec1', fields: { 标题: '登录优化', 状态: ['进行中'] } }],
      hasMore: true,
      timezone: 'Asia/Shanghai',
      ignoredFields: [],
    })),
    searchRecords: vi.fn(async (): Promise<BaseRecordPage> => ({ records: [], hasMore: false, ignoredFields: [] })),
    createRecords: vi.fn(async (_token: string, _table: string, records: readonly BaseRecordFields[]) => records.map((_, index) => `rec_new${index}`)),
    updateRecords: vi.fn(async (): Promise<readonly string[]> => ['创建时间: READONLY']),
    deleteRecords: vi.fn(async () => {}),
  }
  return bases satisfies BaseApi
}

interface Harness {
  channel: ReturnType<typeof makeChannel>
  api: ReturnType<typeof fakeApi>
  sheets: ReturnType<typeof fakeSheets>
  bases: ReturnType<typeof fakeBases>
  consent: WikiConsent
  definitions: Map<string, ToolDefinition>
  run(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  /** Wait for the newest consent card and click it. */
  click(decision: 'allow' | 'deny', userId?: string): Promise<void>
}

async function setup(options: {
  roots?: string[]
  read?: boolean
  write?: boolean
  allowed?: boolean
} = {}): Promise<Harness> {
  const config = resolveConfig({
    wikiRoots: options.roots ?? [NODE_LINK],
    feishuTools: { wikiRead: options.read ?? true, wikiWrite: options.write ?? true },
  })
  const api = fakeApi()
  const sheets = fakeSheets()
  const bases = fakeBases()
  const base = makeChannel()
  const channel = Object.assign(base, { wiki: api, sheets, bases })
  const consent = new WikiConsent({ channel: () => channel, timeoutMs: () => 60_000, onError: () => {} })
  const runtime = new WikiToolRuntime({
    config: () => config,
    channel: () => channel,
    routeOfSession: id => (id === 's1' ? { chatId: 'oc_1', cardMessageId: 'om_card', inThread: true, senderUserId: 'u_owner' } : undefined),
    mayUseWiki: () => options.allowed ?? true,
    consent,
    warn: vi.fn(),
  })
  const definitions = new Map<string, ToolDefinition>()
  const ctx = makeAgentContext()
  ctx.tools = { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition) } } as unknown as ToolRuntime
  await runtime.mount(ctx, 's1')
  return {
    channel, api, sheets, bases, consent, definitions,
    async run(tool, args, signal) {
      const definition = definitions.get(tool)
      if (definition === undefined) throw new Error(`${tool} not mounted`)
      return await definition.execute(args, { signal: signal ?? new AbortController().signal }) as Record<string, unknown>
    },
    async click(decision, userId = 'u_owner') {
      await vi.waitFor(() => expect(consent.pendingCount()).toBeGreaterThan(0))
      await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0))
      const event: CardActionEvent = {
        messageId: `om_${channel.sent.length}`,
        chatId: 'oc_1',
        operator: { openId: 'ou_x', userId },
        action: { value: { decision }, tag: 'button' },
      }
      consent.onCardAction(event)
    },
  }
}

describe('wiki links', () => {
  it('accepts space and node links and rejects everything else', () => {
    expect(parseWikiRootLink(SPACE_LINK)).toEqual({ ok: true, root: { kind: 'space', spaceId: '7160145948494381236', link: SPACE_LINK } })
    expect(parseWikiRootLink(` ${NODE_LINK} `)).toEqual({ ok: true, root: { kind: 'node', nodeToken: 'wikcnRootNode0001', link: NODE_LINK } })
    expect(parseWikiRootLink('http://mi.feishu.cn/wiki/space/1')).toEqual({ ok: false, error: 'not-https' })
    expect(parseWikiRootLink('https://mi.feishu.cn/docx/abcdefgh123')).toEqual({ ok: false, error: 'not-a-wiki-link' })
    expect(parseWikiRootLink('not a url')).toEqual({ ok: false, error: 'not-a-url' })
    expect(() => resolveConfig({ wikiRoots: ['https://mi.feishu.cn/drive/folder/x'] })).toThrow(/wikiRoots/)
  })

  it('parses tool references', () => {
    expect(parseWikiRef('wikcnChildNode001')).toEqual({ kind: 'node', token: 'wikcnChildNode001' })
    expect(parseWikiRef('https://mi.feishu.cn/docx/doxcnAbcdefgh12?from=x')).toEqual({ kind: 'docx', token: 'doxcnAbcdefgh12' })
    expect(parseWikiRef(SPACE_LINK)).toEqual({ kind: 'space', spaceId: '7160145948494381236' })
    expect(parseWikiRef('../etc')).toBeUndefined()
  })
})

describe('wiki tool mounting and gates', () => {
  it('mounts nothing without roots and only the enabled tool sets otherwise', async () => {
    expect([...(await setup({ roots: [] })).definitions.keys()]).toEqual([])
    expect([...(await setup({ write: false })).definitions.keys()])
      .toEqual([WIKI_LIST_TOOL_NAME, WIKI_READ_TOOL_NAME, 'feishu_wiki_sheet_read', 'feishu_wiki_base_read'])
    expect([...(await setup({ read: false })).definitions.keys()])
      .toEqual([WIKI_CREATE_TOOL_NAME, WIKI_EDIT_TOOL_NAME, 'feishu_wiki_sheet_edit', 'feishu_wiki_base_edit'])
  })

  it('refuses topic owners outside the wiki whitelist', async () => {
    const h = await setup({ allowed: false })
    expect(await h.run(WIKI_LIST_TOOL_NAME, {})).toMatchObject({ ok: false, code: 'NOT_AUTHORIZED' })
  })

  it('lists roots and children without a card, and rejects nodes outside the roots', async () => {
    const h = await setup()
    expect(await h.run(WIKI_LIST_TOOL_NAME, {})).toMatchObject({
      ok: true, kind: 'roots', items: [{ root: 'node', title: '团队空间根', node_token: 'wikcnRootNode0001' }],
    })
    const children = await h.run(WIKI_LIST_TOOL_NAME, { parent: NODE_LINK })
    expect(children).toMatchObject({ ok: true, kind: 'children' })
    expect((children.items as Array<{ node_token: string; owned_by_app: boolean }>).map(item => [item.node_token, item.owned_by_app]))
      .toEqual([
        ['wikcnChildNode001', true], ['wikcnHumanDoc0001', false], ['wikcnSheetNode001', false],
        ['wikcnSheetOwned01', true], ['wikcnBaseOwned001', true], ['wikcnBaseHuman001', false],
      ])
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: 'wikcnOtherSpace01' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: SPACE_LINK })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: 'wikcnMissing00001' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(h.channel.sent).toEqual([])
  })

  it('treats a space root as covering the whole space', async () => {
    const h = await setup({ roots: [SPACE_LINK] })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: SPACE_LINK })).toMatchObject({ ok: true, kind: 'children' })
    expect(await h.run(WIKI_LIST_TOOL_NAME, { parent: 'wikcnOtherSpace01' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
  })
})

describe('feishu_wiki_read', () => {
  it('asks the topic owner once per document, ignores other clickers, then reads without a card', async () => {
    const h = await setup()
    const pending = h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnChildNode001', format: 'xml', scope: 'outline' })
    await h.click('allow', 'u_stranger')
    expect(h.consent.pendingCount()).toBe(1)
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, title: '子页面', revision_id: 7, format: 'xml', editable: true, content: '# 标题\n正文' })
    expect(h.api.fetchDocument).toHaveBeenCalledWith('doc_wikcnChildNode001', { format: 'xml', withBlockIds: true, scope: 'outline' })
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('读取文档')
    expect(card).toContain('研发知识库 / 团队空间根')
    expect(h.channel.sent[0]?.options).toEqual({ replyTo: 'om_card', replyInThread: true })
    expect(JSON.stringify(h.channel.updated.map(update => update.card))).toContain('仅发起该话题的用户可操作此卡片')

    expect(await h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnChildNode001' })).toMatchObject({ ok: true })
    expect(h.channel.sent).toHaveLength(1)
  })

  it('reports a denial and rejects non-docx nodes before asking', async () => {
    const h = await setup()
    const pending = h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnHumanDoc0001' })
    await h.click('deny')
    expect(await pending).toMatchObject({ ok: false, code: 'CONSENT_DENIED' })
    expect(h.api.fetchDocument).not.toHaveBeenCalled()
    expect(await h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnSheetNode001' })).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' })
  })

  it('withdraws the card when the call is aborted', async () => {
    const h = await setup()
    const controller = new AbortController()
    const pending = h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnChildNode001' }, controller.signal)
    await vi.waitFor(() => expect(h.consent.pendingCount()).toBe(1))
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'ABORTED' })
  })

  it('renders the document content after a JSON header', () => {
    const [block] = renderWikiResult({ ok: true, title: 't', node_token: 'n', url: 'u', revision_id: 1, format: 'markdown', editable: false, content: 'body' })
    expect(block).toEqual({ type: 'text', text: '{"ok":true,"title":"t","node_token":"n","url":"u","revision_id":1,"format":"markdown","editable":false}\n\nbody' })
  })
})

describe('feishu_wiki_create', () => {
  it('creates under a contained parent after consent and writes the content at the end', async () => {
    const h = await setup()
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: NODE_LINK, title: '周报', content: '## 本周\n- 完成' })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, title: '周报', node_token: 'wikcnCreated00001', revision_id: 8 })
    expect(h.api.createNode).toHaveBeenCalledWith('7160145948494381236', 'wikcnRootNode0001', '周报', 'docx')
    expect(h.api.updates).toEqual([{
      documentId: 'doc_wikcnCreated00001',
      request: { command: 'block_insert_after', format: 'markdown', content: '## 本周\n- 完成', blockId: '-1' },
    }])
    expect(JSON.stringify(h.channel.sent[0]?.input)).toContain('新建文档')
    // The approved document reads back without another card.
    expect(await h.run(WIKI_READ_TOOL_NAME, { doc: 'wikcnCreated00001' })).toMatchObject({ ok: true })
    expect(h.channel.sent).toHaveLength(1)
  })

  it('asks every time and keeps the space top level to space roots', async () => {
    const h = await setup()
    expect(await h.run(WIKI_CREATE_TOOL_NAME, { parent: SPACE_LINK, title: 'x' })).toMatchObject({ ok: false, code: 'OUTSIDE_ROOTS' })
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: 'wikcnChildNode001', title: '空文档' })
    await h.click('deny')
    expect(await pending).toMatchObject({ ok: false, code: 'CONSENT_DENIED' })
    expect(h.api.createNode).not.toHaveBeenCalled()
  })

  it('reports the created document when writing its content fails', async () => {
    const h = await setup()
    h.api.updateDocument.mockRejectedValueOnce(new FeishuApiError('code=1 bad markdown', 1))
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: NODE_LINK, title: '坏内容', content: 'x' })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'CONTENT_FAILED', node_token: 'wikcnCreated00001' })
  })
})

describe('feishu_wiki_edit', () => {
  it('edits an app-owned document at the read revision after consent', async () => {
    const h = await setup()
    const pending = h.run(WIKI_EDIT_TOOL_NAME, {
      doc: 'wikcnChildNode001',
      revision_id: 7,
      format: 'xml',
      operations: [
        { command: 'append', content: '<p>尾部</p>' },
        { command: 'replace', start_block_id: 'blkA', end_block_id: 'blkB', content: '<p>新</p>' },
        { command: 'delete', block_id: 'blkC' },
        { command: 'str_replace', pattern: '旧词', content: '' },
      ],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, applied: 4, revision_id: 11 })
    expect(h.api.updates.map(update => update.request)).toEqual([
      { command: 'block_insert_after', format: 'xml', content: '<p>尾部</p>', blockId: '-1', revisionId: 7 },
      { command: 'block_replace', format: 'xml', content: '<p>新</p>', startBlockId: 'blkA', endBlockId: 'blkB', revisionId: 8 },
      { command: 'block_delete', format: 'xml', blockId: 'blkC', revisionId: 9 },
      { command: 'str_replace', format: 'xml', pattern: '旧词', content: '', revisionId: 10 },
    ])
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('将执行 4 个操作')
  })

  it('keeps every operation on the consent card', async () => {
    const h = await setup()
    const long = 'x'.repeat(500)
    const operations = [
      ...Array.from({ length: 19 }, () => ({ command: 'append', content: long })),
      { command: 'overwrite', content: '全新内容' },
    ]
    const pending = h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnChildNode001', revision_id: 7, operations })
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(1))
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('20. ⚠️ 清空整篇并重写')
    expect(card).not.toContain('已截断')
    await h.click('deny')
    expect(await pending).toMatchObject({ ok: false, code: 'CONSENT_DENIED' })
  })

  it('refuses documents the app does not own and stale revisions without a card', async () => {
    const h = await setup()
    expect(await h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnHumanDoc0001', revision_id: 7, operations: [{ command: 'append', content: 'x' }] }))
      .toMatchObject({ ok: false, code: 'NOT_OWNED' })
    expect(await h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnChildNode001', revision_id: 3, operations: [{ command: 'append', content: 'x' }] }))
      .toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision_id: 7 })
    expect(await h.run(WIKI_EDIT_TOOL_NAME, { doc: 'wikcnChildNode001', revision_id: 7, operations: [{ command: 'delete' }] }))
      .toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    expect(h.channel.sent).toEqual([])
  })

  it('stops at the first failed operation and reports how many were applied', async () => {
    const h = await setup()
    h.api.updateDocument
      .mockImplementationOnce(async () => ({ result: 'success', revisionId: 8, warnings: [] }))
      .mockImplementationOnce(async () => ({ result: 'failed', warnings: ['block not found'] }))
    const pending = h.run(WIKI_EDIT_TOOL_NAME, {
      doc: 'wikcnChildNode001', revision_id: 7,
      operations: [{ command: 'append', content: 'a' }, { command: 'insert_after', block_id: 'blkX', content: 'b' }, { command: 'append', content: 'c' }],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'EDIT_FAILED', applied: 1 })
    expect(h.api.updateDocument).toHaveBeenCalledTimes(2)
  })

  it('stops at a partially applied operation and asks for verification', async () => {
    const h = await setup()
    h.api.updateDocument.mockImplementationOnce(async () => ({ result: 'partial_success', revisionId: 8, warnings: ['some blocks skipped'] }))
    const pending = h.run(WIKI_EDIT_TOOL_NAME, {
      doc: 'wikcnChildNode001', revision_id: 7,
      operations: [{ command: 'overwrite', content: 'a' }, { command: 'append', content: 'b' }],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'EDIT_PARTIAL', applied: 0, revision_id: 8 })
    expect(h.api.updateDocument).toHaveBeenCalledTimes(1)
  })
})

describe('feishu_wiki_create types', () => {
  it('creates an empty spreadsheet and refuses content for non-docx types', async () => {
    const h = await setup()
    expect(await h.run(WIKI_CREATE_TOOL_NAME, { parent: NODE_LINK, title: '表', type: 'bitable', content: 'x' }))
      .toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    const pending = h.run(WIKI_CREATE_TOOL_NAME, { parent: NODE_LINK, title: '预算', type: 'sheet' })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, title: '预算', node_token: 'wikcnCreated00001' })
    expect(h.api.createNode).toHaveBeenCalledWith('7160145948494381236', 'wikcnRootNode0001', '预算', 'sheet')
    expect(JSON.stringify(h.channel.sent[0]?.input)).toContain('电子表格（空白）')
    expect(h.api.updates).toEqual([])
  })
})

describe('feishu_wiki_sheet_read', () => {
  it('reads the only visible grid sheet as CSV after consent, then reuses the grant', async () => {
    const h = await setup()
    const pending = h.run('feishu_wiki_sheet_read', { doc: 'wikcnSheetNode001' })
    await h.click('allow')
    const value = await pending
    expect(value).toMatchObject({
      ok: true, revision_id: 30, sheet_id: 'sh1', actual_range: 'A1:B2', has_more: false, editable: false,
      content: '[row=1] 项目,金额\n[row=2] 差旅,1200',
    })
    expect(h.sheets.readCsv).toHaveBeenCalledWith('doc_wikcnSheetNode001', { sheetId: 'sh1', range: 'A1:F200', maxChars: 20_000 })
    const rendered = renderWikiResult(value)[0]
    expect(rendered?.type === 'text' ? rendered.text : '').toMatch(/"sheet_id":"sh1".*\n\n\[row=1\] 项目,金额/su)
    expect(await h.run('feishu_wiki_sheet_read', { doc: 'wikcnSheetNode001', sheet: '草稿', range: 'B2:C9', max_chars: 5_000 }))
      .toMatchObject({ ok: true, sheet_id: 'sh2' })
    expect(h.sheets.readCsv).toHaveBeenLastCalledWith('doc_wikcnSheetNode001', { sheetId: 'sh2', range: 'B2:C9', maxChars: 5_000 })
    expect(h.channel.sent).toHaveLength(1)
  })

  it('rejects other node types and non-grid or unknown sheets', async () => {
    const h = await setup()
    expect(await h.run('feishu_wiki_sheet_read', { doc: 'wikcnChildNode001' })).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' })
    const pending = h.run('feishu_wiki_sheet_read', { doc: 'wikcnSheetNode001', sheet: '嵌入表' })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    expect(await h.run('feishu_wiki_sheet_read', { doc: 'wikcnSheetNode001', sheet: '不存在' }))
      .toMatchObject({ ok: false, code: 'INVALID_OPERATION', reason: expect.stringContaining('数据（sh1）') })
  })
})

describe('feishu_wiki_sheet_edit', () => {
  it('writes and appends on an app-owned spreadsheet at the read revision after consent', async () => {
    const h = await setup()
    const pending = h.run('feishu_wiki_sheet_edit', {
      doc: 'wikcnSheetOwned01',
      revision_id: 30,
      operations: [
        { command: 'write', start_cell: 'B3', values: [['a', 1], ['=SUM(C3:C4)']] },
        { command: 'append', values: [['差旅', 300, true]] },
      ],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({
      ok: true, applied: 2, revision_id: 32,
      written: [{ sheet_id: 'sh1', range: 'B3:C4' }, { sheet_id: 'sh1', range: 'A3:C3' }],
    })
    expect(h.sheets.writes.map(write => write.request)).toEqual([
      { sheetId: 'sh1', range: 'B3:C4', rows: [['a', 1], ['=SUM(C3:C4)', null]] },
      { sheetId: 'sh1', range: 'A3:C3', rows: [['差旅', 300, true]] },
    ])
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('B3:C4（2 行 × 2 列）')
    expect(card).toContain('末尾追加 1 行 × 3 列')
  })

  it('refuses spreadsheets the app does not own, stale revisions, and too many cells without a card', async () => {
    const h = await setup()
    const operations = [{ command: 'write', start_cell: 'A1', values: [['x']] }]
    expect(await h.run('feishu_wiki_sheet_edit', { doc: 'wikcnSheetNode001', revision_id: 30, operations }))
      .toMatchObject({ ok: false, code: 'NOT_OWNED' })
    expect(await h.run('feishu_wiki_sheet_edit', { doc: 'wikcnSheetOwned01', revision_id: 29, operations }))
      .toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision_id: 30 })
    expect(await h.run('feishu_wiki_sheet_edit', { doc: 'wikcnSheetOwned01', revision_id: 30, operations: [{ command: 'write', start_cell: 'B0', values: [['x']] }] }))
      .toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    const big = Array.from({ length: 6_000 }, () => Array.from({ length: 9 }, () => 1))
    expect(await h.run('feishu_wiki_sheet_edit', { doc: 'wikcnSheetOwned01', revision_id: 30, operations: [{ command: 'append', values: big }] }))
      .toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    expect(h.channel.sent).toEqual([])
  })

  it('rejects a change made while the card was open and stops at a failed write', async () => {
    const h = await setup()
    const operations = [{ command: 'write', start_cell: 'A1', values: [['x']] }, { command: 'write', start_cell: 'A2', values: [['y']] }]
    const stale = h.run('feishu_wiki_sheet_edit', { doc: 'wikcnSheetOwned01', revision_id: 30, operations })
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(1))
    h.sheets.revision = 31
    await h.click('allow')
    expect(await stale).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', revision_id: 31 })
    h.sheets.writeCells.mockRejectedValueOnce(new FeishuApiError('code=900015206 merged region conflict', 900015206))
    const failing = h.run('feishu_wiki_sheet_edit', { doc: 'wikcnSheetOwned01', revision_id: 31, operations })
    await vi.waitFor(() => expect(h.channel.sent).toHaveLength(2))
    await h.click('allow')
    expect(await failing).toMatchObject({ ok: false, code: 'EDIT_FAILED', applied: 0 })
  })
})

describe('feishu_wiki_base_read', () => {
  it('lists tables, then reads fields and a record page of one table', async () => {
    const h = await setup()
    const pending = h.run('feishu_wiki_base_read', { doc: 'wikcnBaseHuman001' })
    await h.click('allow')
    expect(await pending).toEqual({
      ok: true, title: '需求池', node_token: 'wikcnBaseHuman001', url: 'https://mi.feishu.cn/wiki/wikcnBaseHuman001',
      tables: [{ table_id: 'tbl1', name: '需求' }, { table_id: 'tbl2', name: '归档' }], writable: 'create',
    })
    const filter = { logic: 'and', conditions: [['状态', 'intersects', ['进行中']]] }
    expect(await h.run('feishu_wiki_base_read', { doc: 'wikcnBaseHuman001', table: '需求', filter, offset: 50, limit: 10 })).toMatchObject({
      ok: true,
      table_id: 'tbl1',
      fields: [{ field_id: 'fld1', name: '标题', type: 'text', style: { type: 'plain' } }, { field_id: 'fld2', name: '状态', type: 'select' }],
      records: [{ record_id: 'rec1', fields: { 标题: '登录优化', 状态: ['进行中'] } }],
      has_more: true,
      next_offset: 51,
    })
    expect(h.bases.listRecords).toHaveBeenCalledWith('doc_wikcnBaseHuman001', 'tbl1', { filter, offset: 50, limit: 10 })
    await h.run('feishu_wiki_base_read', { doc: 'wikcnBaseHuman001', table: 'tbl2', keyword: '登录' })
    expect(h.bases.searchRecords).toHaveBeenCalledWith('doc_wikcnBaseHuman001', 'tbl2', { offset: 0, limit: 50, keyword: '登录', searchFields: ['标题'] })
    expect(await h.run('feishu_wiki_base_read', { doc: 'wikcnBaseHuman001', table: '不存在' })).toMatchObject({ ok: false, code: 'INVALID_OPERATION' })
    expect(h.channel.sent).toHaveLength(1)
  })
})

describe('feishu_wiki_base_edit', () => {
  it('only adds records to a base the app does not own', async () => {
    const h = await setup()
    expect(await h.run('feishu_wiki_base_edit', {
      doc: 'wikcnBaseHuman001', table: '需求', operations: [{ command: 'update', records: [{ record_id: 'rec1', fields: { 标题: 'x' } }] }],
    })).toMatchObject({ ok: false, code: 'NOT_OWNED' })
    expect(h.channel.sent).toEqual([])
    const pending = h.run('feishu_wiki_base_edit', {
      doc: 'wikcnBaseHuman001', table: '需求', operations: [{ command: 'create', records: [{ 标题: '新需求', 状态: ['进行中'] }] }],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, table_id: 'tbl1', applied: 1, created_record_ids: ['rec_new0'], updated: 0, deleted: 0 })
    expect(h.bases.createRecords).toHaveBeenCalledWith('doc_wikcnBaseHuman001', 'tbl1', [{ 标题: '新需求', 状态: ['进行中'] }])
    const card = JSON.stringify(h.channel.sent[0]?.input)
    expect(card).toContain('新增 1 条记录')
  })

  it('updates and deletes records on an app-owned base after consent', async () => {
    const h = await setup()
    const pending = h.run('feishu_wiki_base_edit', {
      doc: 'wikcnBaseOwned001',
      table: 'tbl1',
      operations: [
        { command: 'update', records: [{ record_id: 'rec1', fields: { 状态: ['完成'] } }] },
        { command: 'delete', record_ids: ['rec2', 'rec3'] },
      ],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: true, applied: 2, updated: 1, deleted: 2, ignored_fields: ['创建时间: READONLY'] })
    expect(h.bases.updateRecords).toHaveBeenCalledWith('doc_wikcnBaseOwned001', 'tbl1', { rec1: { 状态: ['完成'] } })
    expect(h.bases.deleteRecords).toHaveBeenCalledWith('doc_wikcnBaseOwned001', 'tbl1', ['rec2', 'rec3'])
    expect(JSON.stringify(h.channel.sent[0]?.input)).toContain('删除 2 条记录')
  })

  it('reports how many operations ran before a failure', async () => {
    const h = await setup()
    h.bases.deleteRecords.mockRejectedValueOnce(new FeishuApiError('code=1254291 write conflict', 1254291))
    const pending = h.run('feishu_wiki_base_edit', {
      doc: 'wikcnBaseOwned001',
      table: 'tbl1',
      operations: [{ command: 'create', records: [{ 标题: 'a' }] }, { command: 'delete', record_ids: ['rec1'] }],
    })
    await h.click('allow')
    expect(await pending).toMatchObject({ ok: false, code: 'EDIT_FAILED', applied: 1 })
  })
})

describe('createSheetApi', () => {
  it('invokes the sheet_ai tools with a JSON-string input and parses the output', async () => {
    const calls: Array<Parameters<WikiRawRequest>[0]> = []
    const responses: unknown[] = [
      { code: 0, data: { output: JSON.stringify({ revision: 60, sheets: [{ sheet_id: 'sh1', title: 'S', row_count: 10, column_count: 3, is_hidden: true }, { sheet_id: '' }] }) } },
      { code: 0, data: { output: JSON.stringify({ annotated_csv: '[row=1] a', actual_range: 'A1', has_more: true, warning_message: 'w' }) } },
      { code: 0, data: { output: '' } },
      { code: 0, data: { output: 'not json' } },
    ]
    const request = (async (input: Parameters<WikiRawRequest>[0]) => {
      calls.push(input)
      return responses.shift()
    }) as WikiRawRequest
    const api = createSheetApi(request)
    expect(await api.workbook('sht/1')).toEqual({
      revision: 60,
      sheets: [{ sheetId: 'sh1', title: 'S', index: 0, resourceType: 'sheet', hidden: true, rowCount: 10, columnCount: 3 }],
    })
    expect(await api.readCsv('sht1', { sheetId: 'sh1', range: 'A1:C10', maxChars: 1000 }))
      .toEqual({ csv: '[row=1] a', actualRange: 'A1', hasMore: true, warning: 'w' })
    await api.writeCells('sht1', { sheetId: 'sh1', range: 'A1:C1', rows: [['=A2', null, 3]] })
    await expect(api.workbook('sht1')).rejects.toThrow(/not JSON/u)
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/open-apis/sheet_ai/v2/spreadsheets/sht%2F1/tools/invoke_read',
      data: { tool_name: 'get_workbook_structure', input: JSON.stringify({ excel_id: 'sht/1' }) },
    })
    expect(JSON.parse((calls[1]?.data as { input: string }).input)).toEqual({
      excel_id: 'sht1', sheet_id: 'sh1', range: 'A1:C10', max_chars: 1000, max_rows: 1_000_000_000, skip_hidden: false,
    })
    expect(calls[2]?.url).toBe('/open-apis/sheet_ai/v2/spreadsheets/sht1/tools/invoke_write')
    expect(JSON.parse((calls[2]?.data as { input: string }).input)).toEqual({
      excel_id: 'sht1', sheet_id: 'sh1', range: 'A1:C1', cells: [[{ formula: '=A2' }, {}, { value: 3 }]],
    })
  })
})

describe('createBaseApi', () => {
  it('sends the base/v3 requests and turns the record matrix into field maps', async () => {
    const calls: Array<Parameters<WikiRawRequest>[0]> = []
    const responses: unknown[] = [
      { code: 0, data: { tables: [{ id: 'tbl1', name: 'T' }, { table_id: 'tbl2', table_name: 'U' }, {}] } },
      { code: 0, data: { fields: [{ id: 'fld1', name: 'A', type: 'text', style: { type: 'plain' } }] } },
      { code: 0, data: { fields: ['A', 'B'], record_id_list: ['rec1'], data: [['x', null]], has_more: true, rev: 4, timezone: 'Asia/Shanghai' } },
      { code: 0, data: { fields: ['A'], record_id_list: ['rec1', 'rec2'], data: [['x']] } },
      { code: 0, data: { record_id_list: ['rec9'] } },
      { code: 0, data: { ignored_fields: [{ id: 'fld9', name: 'F', reason: 'READONLY' }] } },
      { code: 0, data: {} },
    ]
    const request = (async (input: Parameters<WikiRawRequest>[0]) => {
      calls.push(input)
      return responses.shift()
    }) as WikiRawRequest
    const api = createBaseApi(request)
    expect(await api.listTables('app1')).toEqual([{ tableId: 'tbl1', name: 'T' }, { tableId: 'tbl2', name: 'U' }])
    expect(await api.listFields('app1', 'tbl1')).toEqual([{ fieldId: 'fld1', name: 'A', type: 'text', properties: { style: { type: 'plain' } } }])
    expect(await api.listRecords('app1', 'tbl1', { fields: ['A', 'B'], filter: { logic: 'and', conditions: [['A', 'empty']] }, offset: 0, limit: 5 }))
      .toEqual({ records: [{ recordId: 'rec1', fields: { A: 'x', B: null } }], hasMore: true, rev: 4, timezone: 'Asia/Shanghai', ignoredFields: [] })
    await expect(api.searchRecords('app1', 'tbl1', { keyword: 'k', searchFields: ['A'], offset: 0, limit: 5 })).rejects.toThrow(/differ in length/u)
    expect(await api.createRecords('app1', 'tbl1', [{ A: 'y' }])).toEqual(['rec9'])
    expect(await api.updateRecords('app1', 'tbl1', { rec1: { A: 'z' } })).toEqual(['F: READONLY'])
    await api.deleteRecords('app1', 'tbl1', ['rec1'])
    expect(calls.map(call => [call.method, call.url, call.data])).toEqual([
      ['GET', '/open-apis/base/v3/bases/app1/tables', undefined],
      ['GET', '/open-apis/base/v3/bases/app1/tables/tbl1/fields', undefined],
      ['GET', '/open-apis/base/v3/bases/app1/tables/tbl1/records?offset=0&limit=5&field_id=A&field_id=B&filter=%7B%22logic%22%3A%22and%22%2C%22conditions%22%3A%5B%5B%22A%22%2C%22empty%22%5D%5D%7D', undefined],
      ['POST', '/open-apis/base/v3/bases/app1/tables/tbl1/records/search', { keyword: 'k', search_fields: ['A'], offset: 0, limit: 5 }],
      ['POST', '/open-apis/base/v3/bases/app1/tables/tbl1/records/batch_create', { create_records: [{ A: 'y' }] }],
      ['POST', '/open-apis/base/v3/bases/app1/tables/tbl1/records/batch_update', { update_records: { rec1: { A: 'z' } } }],
      ['POST', '/open-apis/base/v3/bases/app1/tables/tbl1/records/batch_delete', { record_id_list: ['rec1'] }],
    ])
  })
})

describe('createWikiApi', () => {
  it('sends the wiki and docs_ai requests and maps Feishu errors', async () => {
    const calls: Array<Parameters<WikiRawRequest>[0]> = []
    const responses: unknown[] = [
      { code: 0, data: { node: { space_id: '1', node_token: 'n', obj_token: 'd', obj_type: 'docx', node_type: 'origin', title: 'T', owner: 'ou_b', parent_node_token: '' } } },
      { code: 0, data: { document: { revision_id: 3, content: '<p id="b1">x</p>' } } },
      { code: 0, data: { result: 'partial_success', warnings: ['w', 1], document: { revision_id: 4 } } },
      { code: 131006, msg: 'no permission' },
    ]
    const request = (async (input: Parameters<WikiRawRequest>[0]) => {
      calls.push(input)
      return responses.shift()
    }) as WikiRawRequest
    const api = createWikiApi(request)
    expect(await api.getNode('n', 'wiki')).toEqual({
      spaceId: '1', nodeToken: 'n', objToken: 'd', objType: 'docx', nodeType: 'origin', title: 'T', hasChild: false, owner: 'ou_b',
    })
    expect(await api.fetchDocument('d', { format: 'xml', withBlockIds: true, scope: 'keyword', keyword: 'a|b' }))
      .toEqual({ revisionId: 3, content: '<p id="b1">x</p>' })
    expect(await api.updateDocument('d', { command: 'block_delete', format: 'markdown', blockId: 'b1', revisionId: 3 }))
      .toEqual({ result: 'partial_success', revisionId: 4, warnings: ['w'] })
    await expect(api.spaceName('1')).rejects.toMatchObject({ code: 131006 })
    expect(calls).toEqual([
      { method: 'GET', url: '/open-apis/wiki/v2/spaces/get_node', params: { token: 'n', obj_type: 'wiki' } },
      {
        method: 'POST',
        url: '/open-apis/docs_ai/v1/documents/d/fetch',
        data: {
          format: 'xml',
          export_option: { export_block_id: true, export_style_attrs: false, export_cite_extra_data: false },
          read_option: { read_mode: 'keyword', keyword: 'a|b' },
        },
      },
      { method: 'PUT', url: '/open-apis/docs_ai/v1/documents/d', data: { format: 'markdown', command: 'block_delete', block_id: 'b1', revision_id: 3 } },
      { method: 'GET', url: '/open-apis/wiki/v2/spaces/1' },
    ])
  })
})
